import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { WebGpuEditor, type WebGpuEditorActions } from '../editor/WebGpuEditor'
import { SkillDetailPanel, type PanelTask } from '../editor/SkillDetailPanel'
import { SkillPrerequisiteList } from '../editor/SkillPrerequisiteList'
import { TemporaryPanel } from '../editor/TemporaryPanel'
import { loadCameraState, saveCameraState } from '../editor/checkpoint'
import type { CameraState, PrerequisiteConnection } from '../editor/protocol'
import type { GpuStatus, SelectedSkillInfo } from '../editor/types'
import { archiveDraftTask, archivePersonalTask, performLearningAction, readCoachPath, readCoachVersion, readLearningPath, readLearningState, saveCoachDraft, saveLearningPath, type ApiResult, type EditablePathDocument, type LearningAction, type LearningState, type PathSave, type PathSkill, type PathTask } from '../../lib/api'
import { Autosave, type SaveState } from './autosave'
import { CANVAS_FORMAT_VERSION, nameSkills, pathChanges, pathWorkProblem, reapplyPath, samePathWork, type PathWork, type WorkContext } from './keptWork'
import { KeptWorkList, SaveConflict } from './KeptWorkPanel'
import { useKeptWork, type SaveAnswer } from './useKeptWork'
import { LearningRecords, type LearningOutcome } from './learning'
import { describeAction, LearningStatus, SkillLearning, SkillStatusChips, TaskLearning, type PersonalLearningView } from './LearningPanel'
import { draftRuleProblem, optionalPrerequisiteProblem, optionalToggleProblem, SkillDraftRules, TaskDraftRules } from './DraftRules'
import { copySkills, copyTask, type ContentKind, type ReuseContent } from './reuse'
import { ReusePanel } from './ReusePanel'
import { ArchiveTaskControl, RetainedTasks, type RetainedTask } from './Archival'
import { DeleteSkillControl } from './Deletion'

const AUTOSAVE_DELAY_MS = 500

type LocalDocument = PathWork

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
  /** Archives a saved Task (ADR 0018), based on the accepted revision; answers the new document. */
  archiveTask: (pathId: string, taskId: string, expectedRevision: number) => Promise<ApiResult<EditablePathDocument>>
}

/** Personal Paths (ADR 0012): rewards and thresholds are learning records, not document content. */
export const PERSONAL_MODE: PathMode = {
  kind: 'personal',
  read: readLearningPath,
  save: saveLearningPath,
  newSkill: (id, title, outcome) => ({ id, title, outcome, tasks: [] }),
  newTask: (id) => ({ id, title: 'New Task', description: '' }),
  archiveTask: async (pathId, taskId, expectedRevision) => {
    const result = await archivePersonalTask(pathId, taskId, expectedRevision)
    return result.ok ? { ...result, value: result.value.document } : result
  },
}

/** A Coach's Draft: a new Skill is required with no threshold, a new Task Required with no reward. */
export const COACH_MODE: PathMode = {
  kind: 'coach',
  read: readCoachPath,
  save: saveCoachDraft,
  newSkill: (id, title, outcome) => ({ id, title, outcome, optional: false, xpThreshold: 0, tasks: [] }),
  newTask: (id) => ({ id, title: 'New Task', description: '', required: true, xpReward: 0 }),
  archiveTask: archiveDraftTask,
}

const editorInput = (document: EditablePathDocument) => ({
  cards: document.editor.cards.map((card) => ({ id: card.id, title: card.title, position: card.position })),
  connections: document.editor.connections,
})

/** An accepted document in the form the editor saves. */
const workOf = (document: EditablePathDocument): PathWork => ({
  title: document.learningPath.title,
  goal: document.learningPath.goal,
  editor: { format_version: CANVAS_FORMAT_VERSION, cards: editorInput(document).cards, connections: document.editor.connections.map((c) => ({ from_id: c.from_id, to_id: c.to_id })) },
  application: { skills: document.application.skills },
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
export function PathEditor({ accountId, initial, mode = PERSONAL_MODE, draftId = null, publishedVersionIds = [], draftControls }: {
  accountId: string
  initial: EditablePathDocument
  mode?: PathMode
  /** The Draft's Learning Path Version id (coach mode): unsaved work is kept per Draft, not per Path. */
  draftId?: string | null
  /** A Draft's own controls (publication), given whether the Draft is saved and at which revision. */
  draftControls?: (save: { saved: boolean; revision: number }) => ReactNode
  /** A Draft's published Versions: the Tasks they hold are the ones the Draft can archive, and keep once archived. */
  publishedVersionIds?: string[]
}) {
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
  /** Why loading the saved version after a conflict failed; the conflict and its choices stay meanwhile. */
  const [loadError, setLoadError] = useState<string | null>(null)
  const [newSkill, setNewSkill] = useState({ title: '', outcome: '' })
  const [reuseOpen, setReuseOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  /** What the last copy added, until the next one. */
  const [reuseNotice, setReuseNotice] = useState<string | null>(null)
  /** What the last archival did or why it failed. */
  const [archival, setArchival] = useState<{ kind: 'done' | 'failed'; text: string } | null>(null)
  /** The Tasks a Draft's published Versions hold, each with the newest Version that holds it. */
  const [published, setPublished] = useState<Map<string, { title: string; skillId: string; versionNumber: number }> | null>(null)
  /** The Skills a Draft's published Versions hold: history, never deleted. */
  const [publishedSkills, setPublishedSkills] = useState<Set<string> | null>(null)
  /** What the last deletion did. */
  const [deletion, setDeletion] = useState<string | null>(null)
  /** The Skill to select again once an archival's document is shown. */
  const reselect = useRef<string | null>(null)
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

  // Every published Version, not only the latest: a Task archived from an earlier Draft is still held by the Version before it.
  const versionList = publishedVersionIds.join(',')
  useEffect(() => {
    if (personal || versionList === '') return
    let current = true
    void Promise.all(versionList.split(',').map((id) => readCoachVersion(id))).then((results) => {
      if (!current || !results.every((result) => result.ok)) return
      const tasks = new Map<string, { title: string; skillId: string; versionNumber: number }>()
      const versions = results.map((result) => (result as Extract<typeof result, { ok: true }>).value).sort((a, b) => (a.version?.versionNumber ?? 0) - (b.version?.versionNumber ?? 0))
      for (const version of versions) {
        for (const skill of version.application.skills) for (const task of skill.tasks) tasks.set(task.id, { title: task.title, skillId: skill.id, versionNumber: version.version?.versionNumber ?? 0 })
      }
      setPublished(tasks)
      setPublishedSkills(new Set(versions.flatMap((version) => version.application.skills.map((skill) => skill.id))))
    }).catch(() => {})
    return () => { current = false }
  }, [personal, versionList])
  /** Names the newest published Version holding a Task. */
  const retainedBy = (taskId: string) => `Version ${published?.get(taskId)?.versionNumber ?? ''}`

  /** The local document as a save would carry it; null until the engine can be read. */
  const build = useCallback((): LocalDocument | null => {
    const snapshot = actionsRef.current?.exportSnapshot()
    if (!snapshot) return null
    return {
      title: local.current.title,
      goal: local.current.goal,
      editor: { format_version: CANVAS_FORMAT_VERSION, cards: snapshot.cards.map((card) => ({ id: card.id, title: card.title, position: card.position })), connections: snapshot.connections },
      application: { skills: local.current.skills },
    }
  }, [])

  /** One save of a whole document against `expectedRevision`; only the backend says whether it is still current. */
  const saveDocument = useCallback(async (document: LocalDocument, expectedRevision: number): Promise<SaveAnswer<EditablePathDocument>> => {
    let result: ApiResult<EditablePathDocument>
    try {
      result = await mode.save(pathId, { expectedRevision, ...document })
    } catch {
      return { kind: 'failed', detail: 'the backend could not be reached' }
    }
    if (result.ok) return { kind: 'accepted', accepted: result.value }
    const detail = nameSkills(typeof result.body?.detail === 'string' ? result.body.detail : result.error, document.application.skills)
    if (result.error === 'stale_revision') {
      const current = result.body?.current as EditablePathDocument | undefined
      return { kind: 'stale', revision: current?.learningPath.revision ?? expectedRevision }
    }
    if (result.status === 422 || result.status === 409) return { kind: 'refused', detail }
    if (result.status === 401 || result.status === 404) return { kind: 'refused', detail: 'this Path is not available to the signed-in Account' }
    return { kind: 'failed', detail }
  }, [mode, pathId])

  const context = useMemo<WorkContext>(() => ({ accountId, kind: personal ? 'personal' : 'draft', pathId, versionId: personal ? null : draftId }), [accountId, personal, pathId, draftId])
  // Work the backend has not accepted stays in this browser, so a reload or a crash does not lose it.
  const { session: kept, view: keptView } = useKeptWork<PathWork, EditablePathDocument>({
    context,
    initial: { revision: initial.learningPath.revision, work: workOf(initial) },
    problem: pathWorkProblem,
    same: samePathWork,
    merge: reapplyPath,
    changes: pathChanges,
    build,
    read: async () => {
      const result = await mode.read(pathId)
      return result.ok ? { ok: true, revision: result.value.learningPath.revision, work: workOf(result.value), accepted: result.value } : { ok: false, detail: result.error }
    },
    save: saveDocument,
    revisionOf: (document) => document.learningPath.revision,
    show: (document) => showAccepted(document),
    // Skills and Tasks a save added can now be tracked.
    onAccepted: () => void learningRef.current?.refresh(),
  })

  useEffect(() => {
    // Always sent: only the backend can say whether this tab is still on the accepted revision.
    const send = (document: LocalDocument, expectedRevision: number) => kept.autosave(document, expectedRevision)
    const onState = (state: SaveState) => {
      setSaveState(state)
      kept.saveStateChanged(state)
    }
    const autosave = new Autosave<LocalDocument>({ revision: initial.learningPath.revision, delayMs: AUTOSAVE_DELAY_MS, build, send, onState })
    autosaveRef.current = autosave
    return () => autosave.close()
  }, [initial.learningPath.revision, build, kept])

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

  /** Whether an archival holds the editor, and whether an edit still reached it meanwhile. */
  const archivalHold = useRef({ active: false, edited: false })
  const edited = useCallback(() => {
    // While an archival is pending, an edit is not sent on the revision the archival replaces;
    // it is kept, and saved as usual if the archival fails.
    if (archivalHold.current.active) archivalHold.current.edited = true
    else autosaveRef.current?.edit()
    // After a conflict the edit is not sent, but it is kept with the rest of the local work.
    kept.remember()
  }, [kept])

  const changeSkills = useCallback((change: (skills: PathSkill[]) => PathSkill[]) => {
    local.current.skills = change(local.current.skills)
    setSkills(local.current.skills)
    edited()
  }, [edited])

  /**
   * The content of Skills whose cards were deleted, with their place in the list, so an
   * undo brings each back as it was. Rust owns the history: the engine reports the card
   * leaving or coming back, and the application follows with the Skill's content.
   */
  const deletedSkills = useRef(new Map<string, { skill: PathSkill; index: number }>())
  const handleCardDeleted = useCallback((id: string) => {
    const index = local.current.skills.findIndex((skill) => skill.id === id)
    if (index < 0) return
    deletedSkills.current.set(id, { skill: local.current.skills[index], index })
    local.current.skills = local.current.skills.filter((skill) => skill.id !== id)
    setSkills(local.current.skills)
  }, [])
  const handleCardRestored = useCallback((id: string) => {
    const stashed = deletedSkills.current.get(id)
    if (!stashed || local.current.skills.some((skill) => skill.id === id)) return
    deletedSkills.current.delete(id)
    const restored = [...local.current.skills]
    restored.splice(Math.min(stashed.index, restored.length), 0, stashed.skill)
    local.current.skills = restored
    setSkills(restored)
    setDeletion(null)
  }, [])

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
    setAddOpen(false)
    actionsRef.current!.selectCard(id)
    setNewSkill({ title: '', outcome: '' })
  }

  /**
   * Adds copies of a source's Skills with new IDs (ADR 0004): their Tasks, their
   * cards right of this Path's cards, and the Prerequisites among them. Like a new
   * Skill, each copy is in the application before its card, so the save includes it.
   */
  const handleCopySkills = (content: ReuseContent, skillIds: string[], sourceLabel: string) => {
    const snapshot = actionsRef.current?.exportSnapshot()
    if (!editorReady || !snapshot) return
    const copy = copySkills(content, skillIds, mode, snapshot.cards, () => crypto.randomUUID())
    if (copy.skills.length === 0) return
    local.current.skills = [...local.current.skills, ...copy.skills]
    setSkills(local.current.skills)
    for (const card of copy.cards) actionsRef.current!.createCard(card.id, card.title, card.position)
    for (const edge of copy.connections) actionsRef.current!.connectSkills(edge.from_id, edge.to_id)
    actionsRef.current!.selectCard(copy.cards[0].id)
    const tasks = copy.skills.reduce((count, skill) => count + skill.tasks.length, 0)
    setReuseNotice(`Copied ${copy.skills.length === 1 ? `“${copy.skills[0].title}”` : `${copy.skills.length} Skills`} with ${tasks === 1 ? '1 Task' : `${tasks} Tasks`} from ${sourceLabel} as new content of this ${personal ? 'Path' : 'Draft'}.`)
    setReuseOpen(false)
  }

  /** Adds a copy of one Task, with a new ID, to a Skill of this Path. */
  const handleCopyTask = (from: ContentKind, task: PathTask, skillId: string) => {
    const copy = copyTask(task, from, mode, () => crypto.randomUUID())
    changeSkills((all) => all.map((skill) => (skill.id === skillId ? { ...skill, tasks: [...skill.tasks, copy] } : skill)))
  }

  /**
   * Archives a saved Task (ADR 0018, 0026) from the accepted revision and shows the
   * document the backend answers. It starts only while the document is saved, and it
   * holds the kept-work session meanwhile: the editor is locked, and an edit that still
   * reaches it is kept for reapplying rather than replaced by the answered document.
   */
  const handleArchive = async (taskId: string, title: string) => {
    if (saveState.kind !== 'saved') return
    setArchival(null)
    reselect.current = selectedSkill?.id ?? null
    archivalHold.current = { active: true, edited: false }
    const outcome = await kept.accept(async () => {
      const result = await mode.archiveTask(pathId, taskId, saveState.revision)
      if (result.ok) return { ok: true, accepted: result.value }
      const detail = result.error === 'stale_revision'
        ? 'this Path was saved elsewhere since; reload the page to archive from the saved version'
        : typeof result.body?.detail === 'string' ? result.body.detail : result.status === 404 ? 'this Task is not available to the signed-in Account' : result.error
      return { ok: false, detail }
    }).finally(() => { archivalHold.current.active = false })
    // Shown, the answered document replaced the editor and kept any later edit for reapplying; otherwise the edit is saved now.
    if (outcome.kind !== 'shown' && archivalHold.current.edited) autosaveRef.current?.edit()
    if (outcome.kind !== 'shown') reselect.current = null
    if (outcome.kind === 'failed') return setArchival({ kind: 'failed', text: `Not archived: ${outcome.detail}.` })
    if (outcome.kind === 'shown') {
      setArchival({ kind: 'done', text: personal
        ? `Archived “${title}”. Its completion and XP stay in this Path's history.`
        : `Archived “${title}” from this Draft. ${retainedBy(taskId)} and its learners' work keep it.` })
    }
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

  /** Shows an accepted document, replacing whatever the editor showed, and autosaves from its revision. */
  const showAccepted = (document: EditablePathDocument) => {
    setLoadError(null)
    // The new document starts a new editing history: no deletion can be undone any more.
    deletedSkills.current.clear()
    setDeletion(null)
    local.current = { skills: document.application.skills, title: document.learningPath.title, goal: document.learningPath.goal }
    setSkills(local.current.skills)
    setTitle(local.current.title)
    setGoal(local.current.goal)
    // Selection is engine state: clear it there too, or the next click would not report a change.
    actionsRef.current?.selectCard(null)
    setSelectedSkill(null)
    setConnectionRejection(null)
    setLoaded(editorInput(document))
    kept.shown(document.learningPath.revision, workOf(document))
    autosaveRef.current?.reset(document.learningPath.revision)
    void learningRef.current?.refresh()
  }

  /**
   * After a conflict: shows the accepted document, with this tab's local work either
   * kept aside (offered for reapplying) or discarded. If the document cannot be read,
   * nothing changes: the conflict and its choices stay.
   */
  const loadAccepted = async (keepMine: boolean) => {
    const outcome = await kept.loadAccepted(keepMine)
    if (outcome.kind === 'failed') setLoadError(`could not load the saved version (${outcome.detail}); your changes are still here, unsaved`)
  }

  // After an archival the editor reloads its document; the Skill that was open is selected again.
  useEffect(() => {
    const id = reselect.current
    reselect.current = null
    if (id && local.current.skills.some((skill) => skill.id === id)) actionsRef.current?.selectCard(id)
  }, [loaded])

  const handleSelectListSkill = useCallback((skill: SelectedSkillInfo | null) => {
    setSelectedSkill(skill)
    actionsRef.current?.selectCard(skill?.id ?? null)
  }, [])

  const selected = skills.find((skill) => skill.id === selectedId)
  // While kept work is reapplied or the saved version loads, the editor is not edited: the accepted result replaces what it shows.
  const reapplying = keptView.busy

  const records = learning.records
  // Archived Tasks of the selected Skill and the history they keep: a personal Path's own records,
  // or a Draft's published Tasks it no longer carries.
  const retained: RetainedTask[] = !selectedId ? [] : personal
    ? (records?.tasks ?? []).filter((task) => task.skillId === selectedId && task.archivedAt).map((task) => ({
      id: task.taskId, title: task.title,
      detail: task.completed ? `Completed · ${task.xpContribution} XP still counted` : 'Not completed · no XP',
    }))
    : [...(published ?? [])].filter(([id, task]) => task.skillId === selectedId && !selected?.tasks.some((t) => t.id === id)).map(([id, task]) => ({
      id, title: task.title, detail: `Archived from a Draft · ${retainedBy(id)} keeps it with its learners' work`,
    }))
  const archiveBlocked = saveState.kind === 'saved' ? null : 'Archiving waits until your changes are saved'
  const archiveControl = (taskId: string) => {
    const task = selected?.tasks.find((t) => t.id === taskId)
    if (!task || (!personal && !published?.has(taskId))) return null
    return (
      <ArchiveTaskControl
        taskId={taskId}
        title={task.title}
        consequence={personal
          ? 'It leaves this Path\'s editing; its completion, XP and your Mastery stay as they are.'
          : `It will not be in the next Version; ${retainedBy(taskId)} and its learners' Submissions, Reviews and XP keep it.`}
        blocked={archiveBlocked}
        busy={keptView.busy}
        onArchive={() => void handleArchive(taskId, task.title)}
      />
    )
  }
  /** Why the selected Skill cannot be deleted because of its learning history; undefined while that is not known yet. */
  const deletionHistory = (skill: PathSkill): string | null | undefined => {
    if (personal) {
      if (!records) return undefined
      return records.historySkillIds.includes(skill.id) ? `“${skill.title}” has learning history, so it cannot be deleted. Archive its Tasks to take them out of active use.` : null
    }
    const held = publishedVersionIds.length === 0 ? new Set<string>() : publishedSkills
    if (!held) return undefined
    return held.has(skill.id) ? `“${skill.title}” is part of a published Version, so it cannot be deleted. Archive its Tasks from this Draft to leave them out of the next Version.` : null
  }
  /** Deletes the selected unused Skill through the engine: one undo step with its card and connections. */
  const handleDeleteSkill = (skill: PathSkill) => {
    actionsRef.current?.deleteCard(skill.id)
    // The engine reported the deletion synchronously; the Skill's content followed.
    if (local.current.skills.some((s) => s.id === skill.id)) return
    const recorded = personal && ((records?.skills.find((s) => s.skillId === skill.id)?.xpThreshold ?? 0) > 0 ||
      (records?.tasks ?? []).some((task) => task.skillId === skill.id && task.xpReward > 0))
    setDeletion(`Deleted “${skill.title}”${skill.tasks.length ? ` with ${skill.tasks.length === 1 ? 'its Task' : `its ${skill.tasks.length} Tasks`}` : ''} and its connections. Undo brings it back${recorded ? ', with its XP rewards and threshold back at 0' : ''}.`)
  }
  const deleteControl = (skill: PathSkill) => {
    const history = deletionHistory(skill)
    return (
      <DeleteSkillControl
        skillId={skill.id}
        title={skill.title}
        taskCount={skill.tasks.length}
        history={history ?? null}
        blocked={history === undefined ? 'Checking its learning history…' : !editorReady ? 'The editor is still loading' : keptView.busy ? 'Wait until the saved version is shown' : null}
        onDelete={() => handleDeleteSkill(skill)}
      />
    )
  }
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
    <div id="path-editor" data-path-id={pathId} data-gpu-status={gpuStatus} data-reapplying={reapplying} className="flex-1 min-h-0 flex flex-col">
      <div inert={reapplying} className="shrink-0 border-b border-slate-800/80 bg-slate-900/60 px-4 py-2 flex flex-wrap items-center gap-3">
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
        {!personal && draftControls?.({ saved: saveState.kind === 'saved', revision: saveState.revision })}
        <SaveStatus state={saveState} onRetry={() => autosaveRef.current?.retry()} />
      </div>
      {saveState.kind === 'conflict' && (
        <SaveConflict
          prefix=""
          noun="Path"
          revisionLabel="Revision"
          acceptedRevision={saveState.acceptedRevision}
          changes={keptView.liveChanges}
          status={keptView.live}
          busy={keptView.busy}
          loadError={loadError}
          onReapply={() => void kept.reapplyLive()}
          onKeepAside={() => void loadAccepted(true)}
          onDiscard={() => void loadAccepted(false)}
        />
      )}
      <KeptWorkList
        prefix=""
        noun="Path"
        entries={keptView.entries}
        refused={keptView.refused}
        busy={keptView.busy}
        currentRevision={saveState.revision}
        canReapply={saveState.kind === 'saved' && editorReady}
        onReapply={(id) => void kept.reapply(id)}
        onDiscard={(id) => kept.discard(id)}
        onDismissRefused={() => kept.dismissRefused()}
      />
      {reuseNotice && <p id="reuse-notice" role="status" className="px-4 py-2 text-xs text-emerald-300">{reuseNotice}</p>}
      {archival && (
        <p id="archive-status" role={archival.kind === 'failed' ? 'alert' : 'status'} data-outcome={archival.kind} className={`shrink-0 px-4 py-1.5 text-xs border-b ${archival.kind === 'failed' ? 'text-red-200 bg-red-950/40 border-red-900/60' : 'text-emerald-200 bg-emerald-950/30 border-emerald-900/50'}`}>
          {archival.text}
        </p>
      )}
      {deletion && (
        <p id="deletion-status" role="status" className="shrink-0 px-4 py-1.5 text-xs border-b text-slate-200 bg-slate-900/70 border-slate-800">
          {deletion}
        </p>
      )}
      {ruleProblem && (
        <p id="draft-rule-problem" role="alert" className="shrink-0 px-4 py-1.5 text-xs text-amber-200 bg-amber-950/50 border-b border-amber-900/60">
          {ruleProblem} This Draft cannot be saved until it is fixed.
        </p>
      )}
      <section inert={reapplying} aria-busy={reapplying} className={`w-full flex-1 min-h-0 flex flex-col md:flex-row overflow-y-auto md:overflow-hidden relative ${reapplying ? 'pointer-events-none opacity-60' : ''}`}>
        {addOpen && <TemporaryPanel title="Add Skill" closeId="btn-close-add-skill" onClose={() => setAddOpen(false)} initialFocus="#new-skill-title">
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
        </TemporaryPanel>}
        {moreOpen && <TemporaryPanel title="More actions" closeId="btn-close-more-actions" onClose={() => setMoreOpen(false)}>
          <div className="p-4 space-y-3">
            <button id="open-reuse-btn" onClick={() => { setMoreOpen(false); setReuseOpen(true) }} className="text-sm text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg p-3">Copy from a Path…</button>
            <p className="text-xs text-slate-400">Select a Skill to manage its Tasks, relationships, rules and deletion. Archived history stays with that Skill.</p>
          </div>
        </TemporaryPanel>}
        <WebGpuEditor
          onCreateSkill={() => setAddOpen(true)}
          navigation={<>
            <SkillPrerequisiteList
              skills={skills}
              connections={connections}
              selectedSkillId={selectedId}
              onSelectSkill={handleSelectListSkill}
              renderStatus={personal ? (id) => <SkillStatusChips skill={learningSkill(id)} /> : (id) => <DraftStatusChip skill={skills.find((skill) => skill.id === id)} />}
            />
            <button id="btn-more-actions" aria-haspopup="dialog" aria-expanded={moreOpen} onClick={() => setMoreOpen(true)} className="shrink-0 whitespace-nowrap rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800">More actions</button>
          </>}
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
          onCardDeleted={handleCardDeleted}
          onCardRestored={handleCardRestored}
        />
        <SkillDetailPanel
          selectedSkill={selectedSkill}
          onClose={() => handleSelectListSkill(null)}
          busy={reapplying}
          feedback={<>
            <SaveStatus prefix="detail-" state={saveState} onRetry={() => autosaveRef.current?.retry()} />
            {saveState.kind === 'conflict' && <p role="alert" className="text-xs text-amber-200">Your changes are kept in this browser, not saved. Close this summary to reapply them, keep them aside, or load the saved version.</p>}
            {ruleProblem && <p role="alert" className="text-xs text-amber-200">{ruleProblem} This Draft cannot be saved until it is fixed.</p>}
            {archival && <p role={archival.kind === 'failed' ? 'alert' : 'status'} className="text-xs text-amber-200">{archival.text}</p>}
            {personal && learning.failed && <p role="alert" className="text-xs text-red-300">A learning action failed. Close this summary to see the learning status and retry.</p>}
          </>}
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
          skillActions={selected ? deleteControl(selected) : null}
          learning={!selectedId ? null : (
            <>
              {personal
                ? <SkillLearning view={learning} skillId={selectedId} skillTitles={skillTitles} taskTitles={taskTitles} onAction={act} />
                : selected && <SkillDraftRules skill={selected} onOptional={handleOptional} onThreshold={handleThreshold} />}
              <RetainedTasks heading={personal ? 'Archived Tasks · history kept' : 'Archived · kept by published Versions'} tasks={retained} />
            </>
          )}
          renderTaskExtra={personal
            ? (taskId) => <><TaskLearning view={learning} taskId={taskId} onAction={act} />{archiveControl(taskId)}</>
            : (taskId) => {
              const task = selected?.tasks.find((t) => t.id === taskId)
              return task && <><TaskDraftRules task={task} onReward={(xpReward) => handleTaskReward(taskId, xpReward)} />{archiveControl(taskId)}</>
            }}
        />
        {reuseOpen && (
          <ReusePanel
            destination={mode.kind}
            skills={skills}
            selectedSkillId={selectedId}
            canCopy={editorReady}
            onCopySkills={handleCopySkills}
            onCopyTask={handleCopyTask}
            onClose={() => setReuseOpen(false)}
          />
        )}
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
function SaveStatus({ state, onRetry, prefix = '' }: { state: SaveState; onRetry: () => void; prefix?: string }) {
  const text = {
    saved: 'Saved',
    dirty: 'Unsaved changes',
    saving: 'Saving…',
    conflict: 'Not saved: this Path was changed elsewhere',
    rejected: 'Not saved: the change was refused',
    failed: 'Not saved: the save failed',
  }[state.kind]
  const tone = state.kind === 'saved' ? 'text-emerald-300 border-emerald-800/60' : state.kind === 'dirty' || state.kind === 'saving' ? 'text-slate-300 border-slate-700' : 'text-red-300 border-red-800/70'
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span id={`${prefix}save-status`} role="status" data-state={state.kind} data-revision={state.revision} className={`px-2 py-1 rounded-lg border bg-slate-950/80 ${tone}`}>
        {text}
      </span>
      {(state.kind === 'rejected' || state.kind === 'failed') && (
        <>
          <span id={`${prefix}save-error`} role="alert" className="text-red-300 break-words" title={state.detail}>{state.detail}</span>
          <button id={`${prefix}retry-save-btn`} onClick={onRetry} className="text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 rounded-lg cursor-pointer">Retry</button>
        </>
      )}
    </div>
  )
}
