import { useEffect, useMemo, useState } from 'react'
import { listReuseSources, readCoachPath, readCoachVersion, readLearningPath, type ApiResult, type EditablePathDocument, type PathSkill, type PathTask, type ReuseSources } from '../../lib/api'
import { prerequisitesOf, type ContentKind, type ReuseContent } from './reuse'

/** One source the panel can read: a personal Path, a Coach's open Draft, or a published Version. */
type SourceRef =
  | { kind: 'personal'; pathId: string; label: string }
  | { kind: 'draft'; pathId: string; draftId: string; label: string }
  | { kind: 'version'; versionId: string; label: string }

const keyOf = (source: SourceRef) => source.kind === 'version' ? `version:${source.versionId}` : source.kind === 'draft' ? `draft:${source.draftId}` : `personal:${source.pathId}`

type Loaded<T> = { state: 'loading' } | { state: 'failed'; detail: string } | { state: 'ready'; value: T }

const describeError = (result: Extract<ApiResult<unknown>, { ok: false }>) =>
  result.status === 404 ? 'it is not available to the signed-in Account' : result.status === 401 ? 'you are signed out' : result.error

/** Reads a source as it is saved now; a Draft published meanwhile is no longer a Draft to copy from. */
async function readSource(source: SourceRef): Promise<{ ok: true; content: ReuseContent } | { ok: false; detail: string }> {
  const content = (kind: ContentKind, document: EditablePathDocument): ReuseContent =>
    ({ kind, skills: document.application.skills, cards: document.editor.cards, connections: document.editor.connections })
  try {
    if (source.kind === 'personal') {
      const result = await readLearningPath(source.pathId)
      return result.ok ? { ok: true, content: content('personal', result.value) } : { ok: false, detail: describeError(result) }
    }
    if (source.kind === 'version') {
      const result = await readCoachVersion(source.versionId)
      return result.ok ? { ok: true, content: content('coach', result.value) } : { ok: false, detail: describeError(result) }
    }
    const result = await readCoachPath(source.pathId)
    if (!result.ok) return { ok: false, detail: describeError(result) }
    if (result.value.draft?.id !== source.draftId) return { ok: false, detail: 'this Draft has been published since; choose its Version instead' }
    return { ok: true, content: content('coach', result.value) }
  } catch {
    return { ok: false, detail: 'the backend could not be reached' }
  }
}

function sourceGroups(sources: ReuseSources) {
  const groups: { label: string; options: SourceRef[] }[] = []
  if (sources.personal.length > 0) {
    groups.push({ label: 'Personal Workspace', options: sources.personal.map((path) => ({ kind: 'personal', pathId: path.learningPathId, label: path.title })) })
  }
  for (const { workspace, learningPaths } of sources.coach) {
    const options: SourceRef[] = learningPaths.flatMap((path) => [
      ...(path.draft ? [{ kind: 'draft' as const, pathId: path.learningPathId, draftId: path.draft.id, label: `${path.title} · Draft (Version ${path.draft.versionNumber})` }] : []),
      ...[...path.versions].reverse().map((version) => ({ kind: 'version' as const, versionId: version.id, label: `${path.title} · Version ${version.versionNumber}` })),
    ])
    if (options.length > 0) groups.push({ label: `Coach Workspace · ${workspace.name}`, options })
  }
  return groups
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

/**
 * Copies Skills with their Tasks, or single Tasks, from a Path the Account may read
 * into the Path being edited (ADR 0004). The panel only reads; the editor adds the
 * copies with new IDs, and they are saved like any other edit.
 */
export function ReusePanel({ destination, skills, selectedSkillId, canCopy, onCopySkills, onCopyTask, onClose }: {
  destination: ContentKind
  /** The destination's Skills, for a copied Task. */
  skills: PathSkill[]
  selectedSkillId: string | null
  canCopy: boolean
  onCopySkills: (content: ReuseContent, skillIds: string[], sourceLabel: string) => void
  onCopyTask: (from: ContentKind, task: PathTask, skillId: string) => void
  onClose: () => void
}) {
  const [sources, setSources] = useState<Loaded<ReturnType<typeof sourceGroups>>>({ state: 'loading' })
  const [sourceKey, setSourceKey] = useState('')
  const [content, setContent] = useState<Loaded<ReuseContent> | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [taskDestination, setTaskDestination] = useState(selectedSkillId ?? skills[0]?.id ?? '')
  const [result, setResult] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    void (async () => {
      try {
        const listed = await listReuseSources()
        if (current) setSources(listed.ok ? { state: 'ready', value: sourceGroups(listed.value) } : { state: 'failed', detail: describeError(listed) })
      } catch {
        if (current) setSources({ state: 'failed', detail: 'the backend could not be reached' })
      }
    })()
    return () => { current = false }
  }, [])

  const options = sources.state === 'ready' ? sources.value.flatMap((group) => group.options) : []
  const source = options.find((option) => keyOf(option) === sourceKey) ?? null

  useEffect(() => {
    setChosen(new Set())
    setResult(null)
    const chosenSource = sources.state === 'ready' ? sources.value.flatMap((group) => group.options).find((option) => keyOf(option) === sourceKey) : undefined
    if (!chosenSource) return setContent(null)
    let current = true
    setContent({ state: 'loading' })
    void readSource(chosenSource).then((read) => {
      if (current) setContent(read.ok ? { state: 'ready', value: read.content } : { state: 'failed', detail: read.detail })
    })
    return () => { current = false }
  }, [sources, sourceKey])

  // A Task goes into a Skill of the destination that still exists.
  const destinationSkill = skills.find((skill) => skill.id === taskDestination) ?? null
  const ready = content?.state === 'ready' ? content.value : null
  const prerequisites = useMemo(() => ready ? prerequisitesOf(ready, chosen) : null, [ready, chosen])
  const rulesNote = !ready ? null
    : ready.kind === 'coach' && destination === 'coach' ? 'Required and Enrichment Tasks, rewards, Optional Skills and XP Thresholds are copied as Draft rules.'
    : ready.kind === 'coach' ? 'Draft rules are not copied: in a personal Path, rewards and thresholds are your own learning records.'
    : destination === 'coach' ? 'Copies start as required Skills without a threshold and Required Tasks worth 0 XP; set their rules in this Draft.'
    : null

  const toggle = (id: string) => setChosen((previous) => {
    const next = new Set(previous)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const copyTask = (task: PathTask) => {
    if (!ready || !destinationSkill) return
    onCopyTask(ready.kind, task, destinationSkill.id)
    setResult(`Copied “${task.title}” into “${destinationSkill.title}” as a new Task.`)
  }

  return (
    <div className="absolute inset-0 z-30 bg-slate-950/75 flex items-start justify-center p-4 md:p-8 overflow-y-auto" onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}>
      <div id="reuse-panel" role="dialog" aria-modal="true" aria-labelledby="reuse-title" className="w-full max-w-2xl bg-slate-900 border border-slate-700 rounded-xl shadow-xl flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="reuse-title" className="text-sm font-semibold text-slate-100">Copy from a Path</h2>
            <p className="text-xs text-slate-400 mt-1">
              Copies are new content of this Path with their own IDs. Later edits to the copy or the source stay apart, and no completion, Submission, Review, XP or Mastery comes along.
            </p>
          </div>
          <button id="reuse-close-btn" onClick={onClose} autoFocus className="text-xs text-slate-300 bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 rounded-lg cursor-pointer">Close</button>
        </div>

        {sources.state === 'loading' && <p className="text-xs text-slate-500">Loading the Paths you can copy from…</p>}
        {sources.state === 'failed' && <p id="reuse-sources-error" role="alert" className="text-xs text-red-300">Could not list the Paths you can copy from: {sources.detail}.</p>}
        {sources.state === 'ready' && (
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            Source
            <select
              id="reuse-source"
              value={sourceKey}
              onChange={(event) => setSourceKey(event.target.value)}
              className="text-xs text-slate-100 bg-slate-950 border border-slate-800 focus:border-blue-500 rounded px-2 py-1.5"
            >
              <option value="">Choose a Path, Draft or Version…</option>
              {sources.value.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.options.map((option) => <option key={keyOf(option)} value={keyOf(option)}>{option.label}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
        )}

        {content?.state === 'loading' && <p className="text-xs text-slate-500">Reading the source…</p>}
        {content?.state === 'failed' && <p id="reuse-source-error" role="alert" className="text-xs text-red-300">Could not read this source: {content.detail}.</p>}
        {ready && (
          <>
            {rulesNote && <p id="reuse-rules-note" className="text-[11px] text-slate-400">{rulesNote}</p>}
            {ready.skills.length === 0 && <p className="text-xs text-slate-500">This source has no Skills yet.</p>}
            <ul id="reuse-skills" className="flex flex-col gap-2 max-h-[50vh] overflow-y-auto pr-1">
              {ready.skills.map((skill) => (
                <li key={skill.id} data-source-skill={skill.title} className="border border-slate-800 rounded-lg p-2 bg-slate-950/60">
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input id={`reuse-skill-${skill.id}`} type="checkbox" checked={chosen.has(skill.id)} onChange={() => toggle(skill.id)} className="mt-0.5" />
                    <span className="flex flex-col">
                      <span className="text-xs font-medium text-slate-100">
                        {skill.title}
                        {skill.optional && <span className="ml-2 text-[9px] font-mono px-1 rounded border text-sky-300 border-sky-900/70">Optional</span>}
                        {(skill.xpThreshold ?? 0) > 0 && <span className="ml-1 text-[9px] font-mono px-1 rounded border text-amber-300 border-amber-900/70">{skill.xpThreshold} XP</span>}
                      </span>
                      {skill.outcome && <span className="text-[11px] text-slate-400">{skill.outcome}</span>}
                    </span>
                  </label>
                  {skill.tasks.length > 0 && (
                    <ul className="mt-1.5 ml-6 flex flex-col gap-1">
                      {skill.tasks.map((task) => (
                        <li key={task.id} data-source-task={task.title} className="flex items-center justify-between gap-2 text-[11px] text-slate-300">
                          <span className="truncate">
                            {task.title}
                            {task.required !== undefined && <span className="ml-2 text-slate-500">{task.required ? 'Required' : 'Enrichment'} · {task.xpReward ?? 0} XP</span>}
                          </span>
                          <button
                            id={`reuse-task-${task.id}`}
                            onClick={() => copyTask(task)}
                            disabled={!canCopy || !destinationSkill}
                            title={destinationSkill ? `Copy into “${destinationSkill.title}”` : 'This Path has no Skill to copy a Task into yet'}
                            className="shrink-0 text-[10px] text-slate-200 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed border border-slate-700 px-1.5 py-0.5 rounded cursor-pointer"
                          >
                            Copy Task
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>

            <label className="flex items-center gap-2 text-xs text-slate-400">
              Copy Tasks into
              <select
                id="reuse-task-destination"
                value={destinationSkill?.id ?? ''}
                onChange={(event) => setTaskDestination(event.target.value)}
                disabled={skills.length === 0}
                className="flex-1 text-xs text-slate-100 bg-slate-950 border border-slate-800 focus:border-blue-500 rounded px-2 py-1"
              >
                {skills.length === 0 && <option value="">No Skill in this Path yet</option>}
                {skills.map((skill) => <option key={skill.id} value={skill.id}>{skill.title}</option>)}
              </select>
            </label>

            {prerequisites && chosen.size > 0 && (
              <p id="reuse-prerequisites" className="text-[11px] text-slate-400">
                {prerequisites.kept.length > 0 ? `Keeps ${plural(prerequisites.kept.length, 'Prerequisite')} between the chosen Skills.` : 'No Prerequisite between the chosen Skills.'}
                {prerequisites.left > 0 && ` ${plural(prerequisites.left, 'Prerequisite')} on Skills not chosen ${prerequisites.left === 1 ? 'is' : 'are'} not copied; connect the copies in this Path instead.`}
              </p>
            )}
            {result && <p id="reuse-result" role="status" className="text-xs text-emerald-300">{result}</p>}
            <div className="flex justify-end">
              <button
                id="reuse-copy-skills-btn"
                onClick={() => onCopySkills(ready, ready.skills.filter((skill) => chosen.has(skill.id)).map((skill) => skill.id), source?.label ?? '')}
                disabled={!canCopy || chosen.size === 0}
                className="text-xs font-medium bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg px-3 py-1.5 cursor-pointer"
              >
                {chosen.size === 0 ? 'Copy Skills' : `Copy ${plural(chosen.size, 'Skill')} with their Tasks`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
