import { announceSessionChange } from './session'

/**
 * Same-origin calls to the backend through /api (ADR 0022). The session lives in
 * an httpOnly cookie, so the browser never handles a token or names an Account.
 */

export interface Account {
  id: string
  email: string
  name: string
  emailVerified: boolean
}

export interface PersonalWorkspace {
  workspace: { id: string; createdAt: string }
  learningPaths: { id: string; title: string; goal: string }[]
}

/**
 * `required`/`xpReward` (Task) and `optional`/`xpThreshold` (Skill) are a Coach's
 * Draft rules; personal Paths have none of them in their document.
 */
export interface PathTask { id: string; title: string; description: string; required?: boolean; xpReward?: number }
export interface PathSkill { id: string; title: string; outcome: string; optional?: boolean; xpThreshold?: number; tasks: PathTask[] }

/**
 * A personal Learning Path as the backend stores it (ADR 0016): the editor snapshot
 * (cards and connections, no Tasks) beside the application payload. `revision` is
 * the concurrency revision every save must be based on.
 */
export interface PathDocument {
  learningPath: { id: string; personalWorkspaceId: string; title: string; goal: string; revision: number }
  editor: { format_version: 1; cards: { id: string; title: string; position: { x: number; y: number } }[]; connections: { from_id: string; to_id: string }[] }
  application: { skills: PathSkill[] }
}

/** What both modes' documents share: the editor snapshot, the application payload and the revision. */
export interface EditablePathDocument {
  learningPath: { id: string; title: string; goal: string; revision: number }
  editor: PathDocument['editor']
  application: { skills: PathSkill[] }
}

/** A save: the local document and the revision it was based on. */
export interface PathSave {
  expectedRevision: number
  title: string
  goal: string
  editor: PathDocument['editor']
  application: PathDocument['application']
}

export type ApiResult<T> =
  | { ok: true; status: number; value: T }
  | { ok: false; status: number; error: string; body: Record<string, unknown> | null }

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
  const response = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const body = await response.json().catch(() => null) as Record<string, unknown> | null
  if (response.ok) return { ok: true, status: response.status, value: body as T }
  const error = body?.error ?? body?.message ?? body?.code
  return { ok: false, status: response.status, error: typeof error === 'string' ? error : `HTTP ${response.status}`, body }
}

export const readAccount = () => call<{ account: Account }>('/account')

/** Runs a session-changing call and tells the other tabs, whose shown Account it replaces. */
async function changeSession(path: string, body: unknown) {
  const result = await call(path, { method: 'POST', body })
  if (result.ok) announceSessionChange()
  return result
}

export const signIn = (email: string, password: string) => changeSession('/auth/sign-in/email', { email, password })

/** Creates the Account; the verification link sent to `email` returns the browser to the entry page. */
export const signUp = (email: string, password: string) =>
  changeSession('/auth/sign-up/email', { email, password, name: email.split('@')[0], callbackURL: '/' })

export const signOut = () => changeSession('/auth/sign-out', {})

/** Enters the signed-in Account's one Personal Workspace, creating it on first entry. */
export const enterPersonalWorkspace = () => call<PersonalWorkspace>('/personal/workspace', { method: 'PUT' })

export const readPersonalWorkspace = (workspaceId: string) =>
  call<PersonalWorkspace>(`/personal/workspaces/${encodeURIComponent(workspaceId)}`)

export const createLearningPath = (title: string, goal: string) => call<PathDocument>('/personal/learning-paths', { method: 'POST', body: { title, goal } })

export const readLearningPath = (pathId: string) => call<PathDocument>(`/personal/learning-paths/${encodeURIComponent(pathId)}`)

/** Saves the whole document; a stale save answers 409 with the accepted document in `body.current`. */
export const saveLearningPath = (pathId: string, save: PathSave) =>
  call<PathDocument>(`/personal/learning-paths/${encodeURIComponent(pathId)}/document`, { method: 'PUT', body: save })

/** A Skill's current Access, Mastery and rule as the backend derives them for the owner. */
export interface LearningSkill {
  skillId: string
  title: string
  learningOutcome: string
  xpThreshold: number
  mastery: boolean
  access: boolean
  accessOverride: { action: 'grant' } | null
  unmetPrerequisiteSkillIds: string[]
  xpShortfall: number
}

export interface LearningTask {
  taskId: string
  skillId: string
  title: string
  xpReward: number
  completed: boolean
  xpContribution: number
  archivedAt: string | null
}

/** One recorded change in a Task's contribution: its first completion is the award, later ones corrections. */
export interface XpEvent {
  id: number
  taskId: string
  occurredAt: string
  kind: 'award' | 'correction'
  cause: 'completion' | 'completion_undone' | 'reward_change'
  amount: number
}

/**
 * A personal Path's learning records (ADR 0001, 0009): XP from this Path only, the
 * owner's Mastery declarations and overrides, and the XP history explaining the total.
 * They live outside the Path document and never change its revision.
 */
export interface LearningState {
  learningPathId: string
  xp: number
  skills: LearningSkill[]
  tasks: LearningTask[]
  xpHistory: XpEvent[]
  masteryHistory: { id: number; skillId: string; occurredAt: string; action: 'declare' | 'withdraw' }[]
  overrideHistory: { skillId: string; occurredAt: string; action: 'grant' | 'revoke' }[]
}

/** One owner action on the Path's learning records; every one is idempotent, so a retry never multiplies it. */
export type LearningAction =
  | { kind: 'complete' | 'undo-completion'; taskId: string }
  | { kind: 'reward'; taskId: string; xpReward: number }
  | { kind: 'mastery' | 'override'; skillId: string; on: boolean }
  | { kind: 'threshold'; skillId: string; xpThreshold: number }

const learningRoute = (pathId: string) => `/personal/learning-paths/${encodeURIComponent(pathId)}`

export const readLearningState = (pathId: string) => call<{ learningState: LearningState }>(`${learningRoute(pathId)}/learning-state`)

export function performLearningAction(pathId: string, action: LearningAction) {
  const at = learningRoute(pathId)
  const target = (kind: 'tasks' | 'skills', id: string, segment: string) => `${at}/${kind}/${encodeURIComponent(id)}/${segment}`
  type Changed = { changed: boolean; learningState: LearningState }
  switch (action.kind) {
    case 'complete': return call<Changed>(target('tasks', action.taskId, 'completion'), { method: 'PUT' })
    case 'undo-completion': return call<Changed>(target('tasks', action.taskId, 'completion'), { method: 'DELETE' })
    case 'reward': return call<Changed>(target('tasks', action.taskId, 'reward'), { method: 'PUT', body: { xpReward: action.xpReward } })
    case 'mastery': return call<Changed>(target('skills', action.skillId, 'mastery'), { method: action.on ? 'PUT' : 'DELETE' })
    case 'override': return call<Changed>(target('skills', action.skillId, 'access-override'), { method: action.on ? 'PUT' : 'DELETE' })
    case 'threshold': return call<Changed>(target('skills', action.skillId, 'xp-threshold'), { method: 'PUT', body: { xpThreshold: action.xpThreshold } })
  }
}

/** A Coach Workspace the signed-in Account owns (ADR 0011). */
export interface CoachWorkspaceSummary { id: string; name: string; createdAt: string }
export interface CoachWorkspace { workspace: CoachWorkspaceSummary; learningPaths: { id: string; title: string; goal: string }[] }

/** A published Learning Path Version: immutable learning content and rules (ADR 0005). */
export interface PublishedVersionSummary { id: string; versionNumber: number; publishedAt: string; enrollmentClosed: boolean }

/**
 * A coach-mode Path showing one Version's content (`version`): the open Draft, the
 * Path's one editable Version, when there is one, otherwise the latest published
 * Version. `versions` lists the published ones.
 */
export interface CoachPathDocument extends EditablePathDocument {
  learningPath: { id: string; coachWorkspaceId: string; title: string; goal: string; revision: number }
  draft: { id: string; versionNumber: number } | null
  version: { id: string; versionNumber: number; publishedAt: string | null } | null
  versions: PublishedVersionSummary[]
}

/** Why a required Skill cannot be completed on the required route (ADR 0008). */
export interface UnmetRequirement { kind: 'required_task' | 'prerequisite' | 'xp_threshold'; message: string; skillId?: string; title?: string; xpThreshold?: number; reachableXp?: number }
export interface BlockedSkill { skillId: string; title: string; unmet: UnmetRequirement[] }

export const listCoachWorkspaces = () => call<{ workspaces: CoachWorkspaceSummary[] }>('/coach/workspaces')

export const createCoachWorkspace = (name: string) => call<{ workspace: CoachWorkspaceSummary }>('/coach/workspaces', { method: 'POST', body: { name } })

export const readCoachWorkspace = (workspaceId: string) => call<CoachWorkspace>(`/coach/workspaces/${encodeURIComponent(workspaceId)}`)

export const createCoachPath = (workspaceId: string, title: string, goal: string) =>
  call<CoachPathDocument>(`/coach/workspaces/${encodeURIComponent(workspaceId)}/learning-paths`, { method: 'POST', body: { title, goal } })

export const readCoachPath = (pathId: string) => call<CoachPathDocument>(`/coach/learning-paths/${encodeURIComponent(pathId)}`)

/** Saves the whole Draft; a stale save answers 409 with the accepted document in `body.current`. */
export const saveCoachDraft = (pathId: string, save: PathSave) =>
  call<CoachPathDocument>(`/coach/learning-paths/${encodeURIComponent(pathId)}/draft`, { method: 'PUT', body: save })

/**
 * Publishes the open Draft as it stood at `expectedRevision`. A blocked required route
 * answers 422 `publication_blocked` with `blockedSkills` and `reachableXp` in the body.
 */
export const publishCoachDraft = (pathId: string, expectedRevision: number) =>
  call<CoachPathDocument>(`/coach/learning-paths/${encodeURIComponent(pathId)}/publication`, { method: 'POST', body: { expectedRevision } })

/** Prepares the next Version as a Draft copied from the latest published one. */
export const prepareCoachDraft = (pathId: string, expectedRevision: number) =>
  call<CoachPathDocument>(`/coach/learning-paths/${encodeURIComponent(pathId)}/drafts`, { method: 'POST', body: { expectedRevision } })

/** One published Version of a Path in the signed-in Coach's Workspace, read-only. */
export const readCoachVersion = (versionId: string) => call<CoachPathDocument>(`/coach/learning-path-versions/${encodeURIComponent(versionId)}`)
