import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { WebGpuEditor, type WebGpuEditorActions } from '../editor/WebGpuEditor'
import { SkillDetailPanel, type PanelTask } from '../editor/SkillDetailPanel'
import { SkillPrerequisiteList } from '../editor/SkillPrerequisiteList'
import { loadCameraState, saveCameraState } from '../editor/checkpoint'
import type { CameraState, PrerequisiteConnection } from '../editor/protocol'
import type { GpuStatus, SelectedSkillInfo } from '../editor/types'
import { performLearningAction, readCoachPath, readLearningPath, readLearningState, saveCoachDraft, saveLearningPath, type ApiResult, type EditablePathDocument, type LearningAction, type LearningState, type PathSave, type PathSkill, type PathTask } from '../../lib/api'
import { Autosave, type SaveOutcome, type SaveState } from './autosave'
import { LearningRecords, type LearningOutcome } from './learning'
import { describeAction, LearningStatus, SkillLearning, SkillStatusChips, TaskLearning, type PersonalLearningView } from './LearningPanel'
import { draftRuleProblem, optionalPrerequisiteProblem, optionalToggleProblem, SkillDraftRules, TaskDraftRules } from './DraftRules'

const AUTOSAVE_DELAY_MS = 500

type LocalDocument = Omit<PathSave, 'expectedRevision'>

/** Where a new Skill's card is first placed; the owner then arranges it on the canvas. */
const newCardPosition = (index: number) => ({ x: 80 + (index % 4) * 240, y: 100 + Math.floor(index / 4) * 160 })

const REFUSALS: Record<string, string> = {
  skill_locked: 'this Skill is locked',
  task_not_found: 'this Task is not saved yet',
  skill_not_found: 'this Skill is not saved yet',
  task_archived: 'this Task is archived',
  learning_path_not_found: 'this Path is not available to the signed-in Account',
  unauthenticated: 'you are signed out',
}

/** Only a backend answer carrying the records counts; anything else changes nothing shown. */
async function learningOutcome(request: Promise<ApiResult<{ learningState: LearningState }>>): Promise<LearningOutcome<LearningState>> {
  try {
    const result = await request
    return result.ok ? { kind: 'ok', state: result.value.learningState } : { kind: 'failed', detail: REFUSALS[result.error] ?? result.error }
  } catch {
    return { kind: 'failed', detail: 'the backend could not be reached' }
  }
}

/**
 * What differs between authoring a personal Path and a Coach's Draft: where the
 * document is read and saved, and the rules a new Skill or Task starts with.
 */
export interface PathMode {
  kind: 'personal' | 'coach'
  read: (pathId: string) => Promise<ApiResult<EditablePathDocument>>
  save: (pathId: string, save: PathSave) => Promise<ApiResult<EditablePathDocument>>
  newSkill: (id: string, title: string, outcome: string) => PathSkill
  newTask: (id: string) => PathTask
}

/** Personal Paths (ADR 0012): rewards and thresholds are learning records, not document content. */
export const PERSONAL_MODE: PathMode = {
  kind: 'personal',
  read: readLearningPath,
  save: saveLearningPath,
  newSkill: (id, title, outcome) => ({ id, title, outcome, tasks: [] }),
  newTask: (id) => ({ id, title: 'New Task', description: '' }),
}

/** A Coach's Draft: a new Skill is required with no threshold, a new Task Required with no reward. */
export const COACH_MODE: PathMode = {
  kind: 'coach',
  read: readCoachPath,
  save: saveCoachDraft,
  newSkill: (id, title, outcome) => ({ id, title, outcome, optional: false, xpThreshold: 0, tasks: [] }),
  newTask: (id) => ({ id, title: 'New Task', description: '', required: true, xpReward: 0 }),
}

const editorInput = (document: EditablePathDocument) => ({
  cards: document.editor.cards.map((card) => ({ id: card.id, title: card.title, position: card.position })),
  connections: document.editor.connections,
})

/**
 * Authors one Learning Path (ADR 0015, 0016): a personal Path, or a Coach's Draft.
 * Rust owns cards, positions, connections, selection, undo and camera; React owns
 * the Path's goal, Skill outcomes and Tasks, and in a Draft its rules. Completed
 * edits autosave the whole document against the accepted revision. Camera is stored
 * only locally, per Account and Path. A personal Path's learning records
 * (completion, rewards, Mastery, thresholds, overrides) are separate backend actions
 * that never touch the document or its revision; a Draft has none.
 */
export function PathEditor({ accountId, initial, mode = PERSONAL_MODE }: { accountId: string; initial: EditablePathDocument; mode?: PathMode }) {
  const personal = mode.kind === 'personal'
  const pathId = initial.learningPath.id
  const [loaded, setLoaded] = useState(() => editorInput(initial))
  const [camera] = useState<CameraState | null>(() => (typeof window === 'undefined' ? null : loadCameraState(window.localStorage, accountId, pathId)))
  const [skills, setSkills] = useState<PathSkill[]>(initial.application.skills)
  const [title, setTitle] = useState(initial.learningPath.title)
  const [goal, setGoal] = useState(initial.learningPath.goal)
  const [selectedSkill, setSelectedSkill] = useState<SelectedSkillInfo | null>(null)
  const [connections, setConnections] = useState<PrerequisiteConnection[]>(initial.editor.connections)
  const [connectionRejection, setConnectionRejection] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'saved', revision: initial.learningPath.revision })
  const [newSkill, setNewSkill] = useState({ title: '', outcome: '' })
  // The engine loads asynchronously; until then there is no document to add a card to.
  const [gpuStatus, setGpuStatus] = useState<GpuStatus>('initializing')
  const editorReady = gpuStatus !== 'initializing'
  const [learning, setLearning] = useState<PersonalLearningView>({ records: null, pending: null, failed: null, loadError: null })
  const learningRef = useRef<LearningRecords<LearningState, LearningAction> | null>(null)

  // Read by the autosave when it builds a save, so they follow every edit at once.
  const local = useRef({ skills, title, goal })
  const actionsRef = useRef<WebGpuEditorActions | null>(null)
  const autosaveRef = useRef<Autosave<LocalDocument> | null>(null)

  // Learning records are the Path's own (ADR 0009), read and changed apart from its document.
  useEffect(() => {
    if (!personal) return
    const records = new LearningRecords<LearningState, LearningAction>({
      read: () => learningOutcome(readLearningState(pathId)),
      send: (action) => learningOutcome(performLearningAction(pathId, action)),
      onView: setLearning,
    })
    learningRef.current = records
    void records.refresh()
    return () => records.close()
  }, [pathId, personal])

  useEffect(() => {
    const build = (): LocalDocument | null => {
      const snapshot = actionsRef.current?.exportSnapshot()
      if (!snapshot) return null
      return {
        title: local.current.title,
        goal: local.current.goal,
        editor: { format_version: 1, cards: snapshot.cards.map((card) => ({ id: card.id, title: card.title, position: card.position })), connections: snapshot.connections },
        application: { skills: local.current.skills },
      }
    }
    const send = async (document: LocalDocument, expectedRevision: number): Promise<SaveOutcome> => {
      // Always sent: only the backend can say whether this tab is still on the accepted revision.
      const result = await mode.save(pathId, { expectedRevision, ...document })
      if (result.ok) {
        // Skills and Tasks the save added can now be tracked.
        void learningRef.current?.refresh()
        return { kind: 'accepted', revision: result.value.learningPath.revision }
      }
      const detail = typeof result.body?.detail === 'string' ? result.body.detail : result.error
      if (result.error === 'stale_revision') {
        const current = result.body?.current as EditablePathDocument | undefined
        return { kind: 'stale', acceptedRevision: current?.learningPath.revision ?? expectedRevision }
      }
      if (result.status === 422 || result.status === 409) return { kind: 'rejected', detail }
      if (result.status === 401 || result.status === 404) return { kind: 'rejected', detail: 'this Path is not available to the signed-in Account' }
      return { kind: 'failed', detail }
    }
    const autosave = new Autosave<LocalDocument>({ revision: initial.learningPath.revision, delayMs: AUTOSAVE_DELAY_MS, build, send, onState: setSaveState })
    autosaveRef.current = autosave
    return () => autosave.close()
  }, [pathId, initial.learningPath.revision, mode])

  // A layout cleanup runs before the engine is freed, so an edit still waiting for its delay can be built and sent.
  useLayoutEffect(() => () => autosaveRef.current?.close(), [])

  // Closing or reloading the page with work the backend has not accepted asks first.
  const unsaved = saveState.kind !== 'saved'
  useEffect(() => {
    if (!unsaved) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [unsaved])

  const edited = useCallback(() => autosaveRef.current?.edit(), [])

  const changeSkills = useCallback((change: (skills: PathSkill[]) => PathSkill[]) => {
    local.current.skills = change(local.current.skills)
    setSkills(local.current.skills)
    edited()
  }, [edited])

  const handleActionsReady = useCallback((actions: WebGpuEditorActions) => { actionsRef.current = actions }, [])
  const handleCameraChanged = useCallback((next: CameraState) => {
    if (typeof window !== 'undefined') saveCameraState(window.localStorage, accountId, pathId, next)
  }, [accountId, pathId])

  const addSkill = (event: FormEvent) => {
    event.preventDefault()
    const skillTitle = newSkill.title.trim()
    if (skillTitle === '' || !editorReady || actionsRef.current?.exportSnapshot() == null) return
    const id = crypto.randomUUID()
    const position = newCardPosition(local.current.skills.length)
    // The Skill exists in the application before its card, so the save its card triggers includes it.
    local.current.skills = [...local.current.skills, mode.newSkill(id, skillTitle, newSkill.outcome)]
    setSkills(local.current.skills)
    actionsRef.current!.createCard(id, skillTitle, position)
    actionsRef.current!.selectCard(id)
    setNewSkill({ title: '', outcome: '' })
  }

  const selectedId = selectedSkill?.id ?? null
  const updateSelected = (change: (skill: PathSkill) => PathSkill) => {
    if (!selectedId) return
    changeSkills((all) => all.map((skill) => (skill.id === selectedId ? change(skill) : skill)))
  }
  const handleUpdateTask = (taskId: string, updates: Partial<PanelTask>) => updateSelected((skill) => ({
    ...skill,
    tasks: skill.tasks.map((task) => task.id === taskId
      ? {
        ...task,
        ...(updates.title !== undefined && { title: updates.title }),
        ...(updates.description !== undefined && { description: updates.description }),
        ...(updates.required !== undefined && task.required !== undefined && { required: updates.required }),
      }
      : task),
  }))
  const handleAddTask = () => updateSelected((skill) => ({ ...skill, tasks: [...skill.tasks, mode.newTask(crypto.randomUUID())] }))
  const handleTaskReward = (taskId: string, xpReward: number) => updateSelected((skill) => ({
    ...skill, tasks: skill.tasks.map((task) => (task.id === taskId ? { ...task, xpReward } : task)),
  }))
  const handleThreshold = (xpThreshold: number) => updateSelected((skill) => ({ ...skill, xpThreshold }))
  // A Draft refuses, at once and with a reason, edits that would make an Optional Skill a Prerequisite of a required one.
  const handleOptional = (optional: boolean) => {
    if (!selectedId) return
    const problem = optionalToggleProblem(local.current.skills, connections, selectedId, optional)
    if (problem) return setConnectionRejection(`${problem} ${optional ? 'Remove that connection or make the dependent Skill optional first.' : 'Remove that connection or make the Prerequisite required first.'}`)
    setConnectionRejection(null)
    updateSelected((skill) => ({ ...skill, optional }))
  }
  const handleConnect = (from: string, to: string) => {
    const problem = personal ? null : optionalPrerequisiteProblem(local.current.skills, from, to)
    if (problem) return setConnectionRejection(`${problem} Make the dependent Skill optional, or the Prerequisite required, first.`)
    actionsRef.current?.connectSkills(from, to)
  }
  const handleUpdateOutcome = (outcome: string) => updateSelected((skill) => ({ ...skill, outcome }))

  const changeHeader = (field: 'title' | 'goal', value: string) => {
    local.current[field] = value
    if (field === 'title') setTitle(value)
    else setGoal(value)
    edited()
  }

  /** Drops unsaved local work and shows the accepted document (rich conflict resolution follows in T28). */
  const loadAccepted = async () => {
    const result = await mode.read(pathId)
    if (!result.ok) {
      setSaveState({ kind: 'failed', revision: saveState.revision, detail: `could not load the saved version (${result.error})` })
      return
    }
    const document = result.value
    local.current = { skills: document.application.skills, title: document.learningPath.title, goal: document.learningPath.goal }
    setSkills(local.current.skills)
    setTitle(local.current.title)
    setGoal(local.current.goal)
    // Selection is engine state: clear it there too, or the next click would not report a change.
    actionsRef.current?.selectCard(null)
    setSelectedSkill(null)
    setConnectionRejection(null)
    setLoaded(editorInput(document))
    autosaveRef.current?.reset(document.learningPath.revision)
    void learningRef.current?.refresh()
  }

  const handleSelectListSkill = useCallback((skill: SelectedSkillInfo | null) => {
    setSelectedSkill(skill)
    actionsRef.current?.selectCard(skill?.id ?? null)
  }, [])

  const selected = skills.find((skill) => skill.id === selectedId)

  const records = learning.records
  const skillTitles = useMemo(() => new Map(skills.map((skill) => [skill.id, skill.title])), [skills])
  const taskTitles = useMemo(() => new Map([
    ...(records?.tasks ?? []).map((task) => [task.taskId, task.title] as const),
    ...skills.flatMap((skill) => skill.tasks.map((task) => [task.id, task.title] as const)),
  ]), [skills, records])
  const labelStatus = useMemo(() => records
    ? Object.fromEntries(records.skills.map((skill) => [skill.skillId, { locked: !skill.access, mastered: skill.mastery }]))
    : undefined, [records])
  const learningSkill = (id: string) => records?.skills.find((skill) => skill.skillId === id)
  const act = (action: LearningAction) => void learningRef.current?.perform(action)
  // Undo or redo can bring back a connection the Draft rules forbid; it is shown here and refused by the backend.
  const ruleProblem = useMemo(() => (personal ? null : draftRuleProblem(skills, connections)), [personal, skills, connections])

  return (
    <div id="path-editor" data-path-id={pathId} data-gpu-status={gpuStatus} className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 border-b border-slate-800/80 bg-slate-900/60 px-4 py-2 flex flex-wrap items-center gap-3">
        <input
          id="path-title-input"
          aria-label="Learning Path title"
          value={title}
          onChange={(e) => changeHeader('title', e.target.value)}
          className="text-sm font-semibold text-slate-100 bg-transparent border border-transparent hover:border-slate-700 focus:border-blue-500 rounded px-2 py-1 min-w-[12rem]"
        />
        <label className="flex-1 min-w-[16rem] flex items-center gap-2 text-xs text-slate-400">
          Goal
          <input
            id="path-goal-input"
            value={goal}
            onChange={(e) => changeHeader('goal', e.target.value)}
            placeholder="What this Path works toward"
            className="flex-1 text-xs text-slate-200 bg-slate-950 border border-slate-800 focus:border-blue-500 rounded px-2 py-1"
          />
        </label>
        {personal ? (
          <LearningStatus
            view={learning}
            describe={(action) => describeAction(action, taskTitles, skillTitles)}
            onRetry={() => void learningRef.current?.retry()}
            onDismiss={() => learningRef.current?.dismiss()}
            onReload={() => void learningRef.current?.refresh()}
          />
        ) : (
          <span id="draft-badge" title="Learners cannot enroll in a Draft, so nothing in it awards XP or Mastery yet" className="text-xs px-2 py-1 rounded-lg border border-amber-800/60 text-amber-200 bg-slate-950/80">
            Draft · not published
          </span>
        )}
        <SaveStatus state={saveState} onRetry={() => autosaveRef.current?.retry()} onLoadAccepted={loadAccepted} />
      </div>
      {ruleProblem && (
        <p id="draft-rule-problem" role="alert" className="shrink-0 px-4 py-1.5 text-xs text-amber-200 bg-amber-950/50 border-b border-amber-900/60">
          {ruleProblem} This Draft cannot be saved until it is fixed.
        </p>
      )}
      <section className="w-full flex-1 min-h-0 flex flex-col md:flex-row overflow-y-auto md:overflow-hidden relative">
        <div className="w-full md:w-64 lg:w-72 shrink-0 md:h-full flex flex-col border-b md:border-b-0 md:border-r border-slate-800/80 min-h-0">
          <form id="new-skill-form" onSubmit={addSkill} className="shrink-0 p-3 border-b border-slate-800/80 flex flex-col gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">New Skill</h2>
            <input
              id="new-skill-title"
              aria-label="Skill title"
              value={newSkill.title}
              onChange={(e) => setNewSkill({ ...newSkill, title: e.target.value })}
              placeholder="Skill title"
              maxLength={200}
              className="text-xs text-slate-100 bg-slate-950 border border-slate-800 focus:border-blue-500 rounded px-2 py-1.5"
            />
            <textarea
              id="new-skill-outcome"
              aria-label="Learning outcome"
              value={newSkill.outcome}
              onChange={(e) => setNewSkill({ ...newSkill, outcome: e.target.value })}
              placeholder="Learning outcome: what you can do once mastered"
              rows={2}
              className="text-xs text-slate-200 bg-slate-950 border border-slate-800 focus:border-blue-500 rounded px-2 py-1.5 resize-none"
            />
            <button
              id="add-skill-btn"
              type="submit"
              disabled={newSkill.title.trim() === '' || !editorReady}
              className="text-xs font-medium bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg py-1.5 cursor-pointer"
            >
              Add Skill
            </button>
          </form>
          <SkillPrerequisiteList
            skills={skills}
            connections={connections}
            selectedSkillId={selectedId}
            onSelectSkill={handleSelectListSkill}
            renderStatus={personal ? (id) => <SkillStatusChips skill={learningSkill(id)} /> : (id) => <DraftStatusChip skill={skills.find((skill) => skill.id === id)} />}
            className="flex-1 min-h-0"
          />
        </div>
        <WebGpuEditor
          onSelectSkill={setSelectedSkill}
          onConnectionsChange={setConnections}
          onRejection={setConnectionRejection}
          onActionsReady={handleActionsReady}
          initialCards={loaded.cards}
          initialConnections={loaded.connections}
          initialCamera={camera}
          onOperationCompleted={edited}
          onCameraChanged={handleCameraChanged}
          onGpuStatusChange={setGpuStatus}
          labelStatus={labelStatus}
        />
        <SkillDetailPanel
          selectedSkill={selectedSkill}
          allSkills={skills}
          connections={connections}
          connectionRejection={connectionRejection}
          onClearRejection={() => setConnectionRejection(null)}
          onConnect={handleConnect}
          onDisconnect={(from, to) => actionsRef.current?.disconnectSkills(from, to)}
          tasks={selected?.tasks}
          outcome={selected?.outcome ?? ''}
          onUpdateTask={handleUpdateTask}
          onUpdateOutcome={handleUpdateOutcome}
          onAddTask={handleAddTask}
          learning={!selectedId ? null : personal
            ? <SkillLearning view={learning} skillId={selectedId} skillTitles={skillTitles} taskTitles={taskTitles} onAction={act} />
            : selected && <SkillDraftRules skill={selected} onOptional={handleOptional} onThreshold={handleThreshold} />}
          renderTaskExtra={personal
            ? (taskId) => <TaskLearning view={learning} taskId={taskId} onAction={act} />
            : (taskId) => {
              const task = selected?.tasks.find((t) => t.id === taskId)
              return task && <TaskDraftRules task={task} onReward={(xpReward) => handleTaskReward(taskId, xpReward)} />
            }}
        />
      </section>
    </div>
  )
}

/** A Draft Skill's designation in the keyboard list. */
function DraftStatusChip({ skill }: { skill: PathSkill | undefined }) {
  if (!skill) return null
  return (
    <span id={`skill-draft-status-${skill.id}`} data-optional={skill.optional === true} className="flex gap-1 text-[9px] font-mono">
      <span className={`px-1 rounded border ${skill.optional ? 'text-sky-300 border-sky-900/70' : 'text-slate-300 border-slate-700'}`}>{skill.optional ? 'Optional' : 'Required'}</span>
      {(skill.xpThreshold ?? 0) > 0 && <span className="px-1 rounded border text-amber-300 border-amber-900/70">{skill.xpThreshold} XP</span>}
    </span>
  )
}

/** Tells the owner whether the local document is saved; nothing short of a backend acceptance says so. */
function SaveStatus({ state, onRetry, onLoadAccepted }: { state: SaveState; onRetry: () => void; onLoadAccepted: () => void }) {
  const text = {
    saved: `Saved · revision ${state.revision}`,
    dirty: 'Unsaved changes',
    saving: 'Saving…',
    conflict: 'Not saved: this Path was changed elsewhere',
    rejected: 'Not saved: the change was refused',
    failed: 'Not saved: the save failed',
  }[state.kind]
  const tone = state.kind === 'saved' ? 'text-emerald-300 border-emerald-800/60' : state.kind === 'dirty' || state.kind === 'saving' ? 'text-slate-300 border-slate-700' : 'text-red-300 border-red-800/70'
  return (
    <div className="flex items-center gap-2 text-xs">
      <span id="save-status" role="status" data-state={state.kind} data-revision={state.revision} className={`px-2 py-1 rounded-lg border bg-slate-950/80 ${tone}`}>
        {text}
      </span>
      {(state.kind === 'rejected' || state.kind === 'failed') && (
        <>
          <span id="save-error" role="alert" className="text-red-300 max-w-[20rem] truncate" title={state.detail}>{state.detail}</span>
          <button id="retry-save-btn" onClick={onRetry} className="text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 rounded-lg cursor-pointer">Retry</button>
        </>
      )}
      {state.kind === 'conflict' && (
        <div id="save-conflict" role="alert" className="flex items-center gap-2 text-amber-200">
          <span>Revision {state.acceptedRevision} was saved elsewhere. Your changes here are kept but not saved.</span>
          <button id="load-accepted-btn" onClick={onLoadAccepted} className="text-amber-100 bg-amber-900/60 hover:bg-amber-800/60 border border-amber-700 px-2 py-1 rounded-lg cursor-pointer">
            Discard mine and load the saved version
          </button>
        </div>
      )}
    </div>
  )
}
