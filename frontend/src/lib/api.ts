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

export interface PathTask { id: string; title: string; description: string }
export interface PathSkill { id: string; title: string; outcome: string; tasks: PathTask[] }

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
