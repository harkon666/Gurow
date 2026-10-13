import { Link } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'
import { EnrollmentAdmission } from './Admission'
import { VersionEnrollments } from './VersionEnrollments'
import { VersionLayoutEditor } from './VersionLayout'
import { KeptPanel } from '../editor/TemporaryPanel'
import { CanvasSidebar, SidebarToggle, useCanvasSidebar } from '../workspace/CanvasChrome'
import { FLOATING } from '../workspace/ContextHeader'
import { prepareCoachDraft, publishCoachDraft, type Account, type BlockedSkill, type CoachPathDocument } from '../../lib/api'

/**
 * Publishing a Coach's Draft (ADR 0005, 0008). Publication freezes the Draft as a
 * Version once its required route can be completed; a blocked route is explained
 * by Skill and unmet requirement. Published content is only read here: any change,
 * a typo correction included, starts a new Draft.
 */

type Refusal = { revision: number; detail: string; blockedSkills: BlockedSkill[] }

/**
 * Publishes the open Draft as saved at `save.revision`. Only a saved Draft can be
 * published, so what is published is what the Coach sees; a refusal stays shown
 * until the Draft changes.
 */
export function PublishControl({ pathId, versionNumber, save, onPublished }: {
  pathId: string
  versionNumber: number
  save: { saved: boolean; revision: number }
  onPublished: () => void
}) {
  const [pending, setPending] = useState(false)
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const shown = refusal && refusal.revision === save.revision ? refusal : null

  const publish = async () => {
    setPending(true)
    const result = await publishCoachDraft(pathId, save.revision).catch(() => null)
    setPending(false)
    if (result?.ok) return onPublished()
    const body = result?.body
    const detail = typeof body?.detail === 'string' ? body.detail : result ? result.error : 'the backend could not be reached'
    const blockedSkills = Array.isArray(body?.blockedSkills) ? body.blockedSkills as BlockedSkill[] : []
    setRefusal({ revision: save.revision, detail: result?.error === 'stale_revision' ? 'This Draft was changed elsewhere; reload it before publishing.' : detail, blockedSkills })
  }

  return (
    <div className="relative">
      <button
        id="publish-version-btn"
        onClick={() => void publish()}
        disabled={!save.saved || pending}
        title={save.saved ? `Check the required route and publish Version ${versionNumber}` : 'Wait until the Draft is saved'}
        className="text-xs font-medium bg-sky-700 hover:bg-sky-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg px-2.5 py-1 cursor-pointer"
      >
        {pending ? 'Publishing…' : `Publish Version ${versionNumber}`}
      </button>
      {shown && (
        <div id="publication-problems" role="alert" className="absolute right-0 top-full mt-2 z-30 w-[26rem] max-w-[90vw] bg-slate-900 border border-red-800/70 rounded-xl p-3 shadow-xl flex flex-col gap-2 text-xs">
          <div className="flex items-start justify-between gap-2">
            <h2 className="font-semibold text-red-200">Version {versionNumber} was not published</h2>
            <button id="dismiss-publication-problems" onClick={() => setRefusal(null)} aria-label="Dismiss" className="text-slate-400 hover:text-slate-200 cursor-pointer p-0.5 rounded hover:bg-slate-800 transition-colors inline-flex items-center justify-center">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          {shown.blockedSkills.length === 0 ? (
            <p id="publication-problem-detail" className="text-slate-300">{shown.detail}</p>
          ) : (
            <>
              <p className="text-slate-400">Learners could not complete these required Skills using Required Tasks on required Skills alone:</p>
              <ul className="flex flex-col gap-1.5">
                {shown.blockedSkills.map((skill) => (
                  <li key={skill.skillId} data-blocked-skill-id={skill.skillId} className="border border-slate-800 rounded-lg px-2 py-1.5">
                    <span className="font-medium text-slate-100">{skill.title}</span>
                    <ul className="list-disc ml-4 text-slate-300">
                      {skill.unmet.map((unmet, index) => <li key={index} data-unmet={unmet.kind}>{unmet.message}</li>)}
                    </ul>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Starts the next Version as a Draft copied from the latest published one. */
export function PrepareDraftControl({ pathId, revision, nextVersion, onPrepared }: { pathId: string; revision: number; nextVersion: number; onPrepared: () => void }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const prepare = async () => {
    setPending(true)
    const result = await prepareCoachDraft(pathId, revision).catch(() => null)
    setPending(false)
    if (result?.ok) return onPrepared()
    setError(result?.error === 'stale_revision' || result?.error === 'draft_already_open' ? 'This Path was changed elsewhere; reload it.' : result?.error ?? 'the backend could not be reached')
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <button
        id="prepare-draft-btn"
        onClick={() => void prepare()}
        disabled={pending}
        className="font-medium bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white rounded-lg px-2.5 py-2 cursor-pointer"
      >
        {pending ? 'Preparing…' : `Prepare Version ${nextVersion} as a Draft`}
      </button>
      {error && <span id="prepare-draft-error" role="alert" className="text-red-300">{error}</span>}
    </div>
  )
}

/** The Path's published Versions, oldest first, each readable on its own page. */
export function VersionHistory({ versions, currentVersionId }: { versions: CoachPathDocument['versions']; currentVersionId?: string }) {
  if (versions.length === 0) return <span id="version-history" className="text-slate-500">Not published yet</span>
  return (
    <span id="version-history" className="flex items-center gap-1.5 text-slate-400 whitespace-nowrap">
      Published:
      {versions.map((version) => (
        <Link
          key={version.id}
          id={`version-link-${version.versionNumber}`}
          to="/coach/versions/$versionId"
          params={{ versionId: version.id }}
          aria-current={version.id === currentVersionId ? 'page' : undefined}
          className={`px-1.5 rounded border ${version.id === currentVersionId ? 'text-slate-100 border-slate-600' : 'text-sky-300 border-transparent hover:text-sky-200'}`}
        >
          Version {version.versionNumber}
        </Link>
      ))}
    </span>
  )
}

/**
 * A published Version for its Coach: the Version's shared Canvas Layout fills the whole
 * page, where the Coach arranges cards, positions only, and everything else floats over
 * it. The way back to the Coach Workspace, the Version and the context switch stay in
 * view; a menu sidebar on the right opens and closes over the canvas, holding the Version's
 * panels, the context switch and the Account. The Version's learning content and
 * rules are read-only (own title and goal, Skills with outcomes, Required or Optional
 * designation, XP Thresholds and Prerequisites, and their Tasks with Required or
 * Enrichment designation and rewards) and open as a panel; inviting learners, admission
 * and the enrolled learners open as another, outside the read-only content.
 */
export function PublishedVersionView({ account, onSignOut, document, actions, currentVersionId }: {
  account: Account
  onSignOut: () => void
  document: CoachPathDocument
  actions?: ReactNode
  /** Set on a Version's own page: its link is marked current and the title leads back to the Path. */
  currentVersionId?: string
}) {
  const accountId = account.id
  const version = document.version!
  const [panel, setPanel] = useState<'content' | 'learners' | null>(null)
  const [learners, setLearners] = useState<{ count: number; awaiting: number } | null>(null)
  const [sidebar, toggleSidebar] = useCanvasSidebar()
  const titles = new Map(document.application.skills.map((skill) => [skill.id, skill.title]))
  const prerequisites = (id: string) => document.editor.connections.filter((edge) => edge.to_id === id).map((edge) => titles.get(edge.from_id) ?? edge.from_id)
  const panelButton = 'w-full text-xs text-slate-200 bg-slate-800/70 hover:bg-slate-700 border border-slate-700 rounded-lg px-2.5 py-2 cursor-pointer flex items-center justify-between gap-2'
  const title = <h1 id="published-path-title" className="text-sm font-semibold text-slate-100 truncate max-w-[16rem]">{document.learningPath.title}</h1>
  return (
    <div className="relative w-full flex-1 min-h-0 flex flex-col">
      <section id="published-version" data-version-id={version.id} data-version-number={version.versionNumber} className="flex-1 min-h-0 flex flex-col">
        <VersionLayoutEditor
          key={`${accountId}:${version.id}`}
          accountId={accountId}
          document={document}
          lead={<>
            <div className={`${FLOATING} min-h-9 px-3 py-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs`}>
              <Link id="back-to-coach-workspace" to="/coach/workspaces/$workspaceId" params={{ workspaceId: document.learningPath.coachWorkspaceId }} className="text-sky-300 hover:text-sky-200 inline-flex items-center gap-1.5 whitespace-nowrap">
                <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                </svg>
                <span>Coach Workspace</span>
              </Link>
              <span className="h-4 w-px bg-slate-700" aria-hidden="true" />
              {currentVersionId
                ? <Link id="back-to-path" to="/coach/paths/$pathId" params={{ pathId: document.learningPath.id }} title="Open this Learning Path" className="hover:underline decoration-slate-500">{title}</Link>
                : title}
              <span id="published-version-badge" title={`Published ${version.publishedAt ? new Date(version.publishedAt).toLocaleString() : ''}. Published content and rules cannot be edited; changes are prepared in a new Draft.`} className="px-1.5 py-0.5 rounded-md border border-sky-800/60 text-sky-200 whitespace-nowrap">
                Version {version.versionNumber} · published
              </span>
              <VersionHistory versions={document.versions} currentVersionId={currentVersionId} />
            </div>
          </>}
          actions={
            <SidebarToggle open={sidebar} onToggle={toggleSidebar} badge={learners && learners.awaiting > 0 && <span className="px-1.5 rounded-md bg-sky-700 text-white">{learners.awaiting} to review</span>} />
          }
        />
        <KeptPanel id="version-content-panel" title={`Version ${version.versionNumber} · Skills & Tasks`} closeId="close-version-content-btn" open={panel === 'content'} onClose={() => setPanel(null)}>
          <div className="p-4 flex flex-col gap-3">
            {document.learningPath.goal && <p id="published-path-goal" className="text-xs text-slate-400">Goal: {document.learningPath.goal}</p>}
            <p id="published-version-immutable" className="text-xs text-slate-400">
              A published Version's learning content and rules cannot be edited, not even to correct a typo. Learners enrolled in it keep it as published; changes are prepared in a new Draft and published as a new Version.
            </p>
            <p id="version-layout-note" className="text-xs text-slate-400">
              On the canvas, drag cards to make this Version easier to read. Its learners see the new arrangement when they next open it, each with their own view. Only positions change: Skills, Tasks, Prerequisites and learning records stay as they are, and no new Version is published.
            </p>
            <ol id="published-skills" className="flex flex-col gap-3">
              {document.application.skills.map((skill) => (
                <li key={skill.id} id={`published-skill-${skill.id}`} data-optional={skill.optional === true} className="border border-slate-800 rounded-xl p-3 bg-slate-900/50 flex flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 data-field="title" className="text-sm font-semibold text-slate-100">{skill.title}</h2>
                    <span className={`text-[10px] px-1.5 rounded border ${skill.optional ? 'text-sky-300 border-sky-900/70' : 'text-slate-300 border-slate-700'}`}>{skill.optional ? 'Optional' : 'Required'}</span>
                    {(skill.xpThreshold ?? 0) > 0 && <span data-field="threshold" className="text-[10px] px-1.5 rounded border text-amber-300 border-amber-900/70">needs {skill.xpThreshold} XP</span>}
                  </div>
                  <p data-field="outcome" className="text-xs text-slate-300">{skill.outcome}</p>
                  {prerequisites(skill.id).length > 0 && <p data-field="prerequisites" className="text-xs text-slate-400">Requires Mastery of: {prerequisites(skill.id).join(', ')}</p>}
                  {skill.tasks.length === 0 ? <p className="text-xs text-slate-500">No Tasks</p> : (
                    <ul className="flex flex-col gap-1">
                      {skill.tasks.map((task) => (
                        <li key={task.id} id={`published-task-${task.id}`} data-required={task.required === true} className="text-xs text-slate-300 border-l-2 border-slate-700 pl-2">
                          <span data-field="title" className="text-slate-100">{task.title}</span>
                          <span className="text-slate-500"> · {task.required ? 'Required' : 'Enrichment'} · {task.xpReward ?? 0} XP</span>
                          {task.description && <p className="text-slate-400">{task.description}</p>}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          </div>
        </KeptPanel>
      </section>
      <KeptPanel id="learners-panel" title={`Version ${version.versionNumber} · Learners`} closeId="close-learners-btn" open={panel === 'learners'} onClose={() => setPanel(null)}>
        <div className="p-4 flex flex-col gap-4">
          <EnrollmentAdmission key={version.id} versionId={version.id} versionNumber={version.versionNumber} />
          <VersionEnrollments key={`enrollments:${version.id}`} versionId={version.id} onSummary={setLearners} />
        </div>
      </KeptPanel>
      <CanvasSidebar open={sidebar} onClose={() => toggleSidebar(false)} heading="This Version" account={account} onSignOut={onSignOut} context={{ kind: 'coach' }}>
          <p className="text-slate-100">{document.learningPath.title} · Version {version.versionNumber}</p>
          {document.learningPath.goal && <p className="text-slate-400">Goal: {document.learningPath.goal}</p>}
          <button id="open-version-content-btn" aria-haspopup="dialog" aria-expanded={panel === 'content'} onClick={() => setPanel('content')} className={panelButton}>
            <span>Skills & Tasks</span>
            <span className="text-slate-400">{document.application.skills.length}</span>
          </button>
          <button id="open-learners-btn" aria-haspopup="dialog" aria-expanded={panel === 'learners'} onClick={() => setPanel('learners')} className={panelButton}>
            <span>Learners</span>
            <span className="flex items-center gap-1.5">
              {learners && learners.awaiting > 0 && <span id="learners-awaiting-badge" className="px-1.5 rounded-md bg-sky-700 text-white">{learners.awaiting} to review</span>}
              {learners && <span className="text-slate-400">{learners.count}</span>}
            </span>
          </button>
          <p className="text-slate-500">Published content and rules cannot be edited. Dragging cards on the canvas only rearranges them for everyone enrolled.</p>
        {actions}
      </CanvasSidebar>
    </div>
  )
}
