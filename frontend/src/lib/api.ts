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

/** Creates the Account; the verification link sent to `email` returns the browser to `returnTo`. */
export const signUp = (email: string, password: string, returnTo = '/') =>
  changeSession('/auth/sign-up/email', { email, password, name: email.split('@')[0], callbackURL: returnTo })

/** Sends the signed-in Account a new verification link, which returns the browser to `returnTo`. */
export const sendVerificationEmail = (email: string, returnTo: string) =>
  call<{ status: boolean }>('/auth/send-verification-email', { method: 'POST', body: { email, callbackURL: returnTo } })

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

/** What an Enrollment Invitation offers: exactly one Version of one Path (CONTEXT.md). */
export interface InvitationOffer { invitationId: string; learningPathVersionId: string; learningPathTitle: string; versionNumber: number; coachWorkspaceName: string }
export interface EnrollmentSummary { id: string; status: 'active' | 'inactive' }

/**
 * The addressee's view of an Invitation. Anyone else is refused: 403
 * `email_not_verified` or `email_mismatch`, or 404 `invitation_not_found`.
 */
export const readInvitation = (invitationId: string) =>
  call<{ offer: InvitationOffer; enrollment: EnrollmentSummary | null }>(`/invitations/${encodeURIComponent(invitationId)}`)

/**
 * Accepts as the signed-in Account: 201 creates the Enrollment, 200 returns the one
 * already held (its status unchanged). Refusals: `email_not_verified`, `email_mismatch`,
 * `owner_cannot_enroll`, `enrollment_closed`, `version_not_published`, `invitation_not_found`.
 */
export const acceptInvitation = (invitationId: string) =>
  call<{ enrollment: EnrollmentSummary & { learningPathVersionId: string }; created: boolean; offer: InvitationOffer }>(`/invitations/${encodeURIComponent(invitationId)}/accept`, { method: 'POST' })

/**
 * An Invitation as its Coach sees it, with what became of its last email: `sent` only
 * when the provider accepted it, `logged` when no provider is configured on the server.
 */
export interface CoachInvitation {
  id: string
  email: string
  createdAt: string
  acceptedAt: string | null
  delivery: { status: 'pending' | 'sent' | 'logged' | 'failed'; attempts: number; deliveredAt: string | null }
}
export interface DeliveryOutcome { invitation: CoachInvitation; delivered: boolean; deliveryError?: string }

const versionRoute = (versionId: string) => `/coach/learning-path-versions/${encodeURIComponent(versionId)}`

export const readAdmission = (versionId: string) => call<{ enrollmentClosed: boolean; invitations: CoachInvitation[] }>(`${versionRoute(versionId)}/invitations`)

/** Stores an Invitation and delivers it; `delivered: false` (failed, or only logged) keeps it for another attempt. */
export const inviteToVersion = (versionId: string, email: string) => call<DeliveryOutcome>(`${versionRoute(versionId)}/invitations`, { method: 'POST', body: { email } })

/** Delivers a stored Invitation again; a failed attempt answers 502, a merely logged one 503, each with the Invitation. */
export const deliverInvitation = (invitationId: string) => call<DeliveryOutcome>(`/coach/invitations/${encodeURIComponent(invitationId)}/delivery`, { method: 'POST' })

/** Closes the Version to new Enrollments, or reopens it; existing Enrollments are unaffected. */
export const setEnrollmentClosure = (versionId: string, closed: boolean) =>
  call<{ enrollmentClosed: boolean; changed: boolean }>(`${versionRoute(versionId)}/enrollment-closure`, { method: closed ? 'PUT' : 'DELETE' })

/** One of the signed-in Account's Enrollments as a learner, naming the one Version it joined. */
export interface LearnerEnrollment {
  id: string
  status: 'active' | 'inactive'
  learningPathVersionId: string
  versionNumber: number
  learningPathId: string
  learningPathTitle: string
  coachWorkspaceName: string
  createdAt: string
}

export const listLearnerEnrollments = () => call<{ enrollments: LearnerEnrollment[] }>('/enrollments')

/**
 * The Version an Enrollment joined (ADR 0005), read-only, for its learner or the
 * owning Coach (`viewer`): its own content and rules, and its shared Canvas Layout as
 * the Coach last arranged it. Anyone else gets 404 `enrollment_not_found`.
 */
export interface EnrolledVersion {
  enrollment: { id: string; status: 'active' | 'inactive'; learningPathVersionId: string; createdAt: string }
  viewer: 'learner' | 'coach'
  learningPath: { id: string; title: string; goal: string }
  version: { id: string; versionNumber: number; publishedAt: string }
  coachWorkspace: { id: string; name: string }
  editor: PathDocument['editor']
  application: { skills: PathSkill[] }
}

export const readEnrolledVersion = (enrollmentId: string) => call<EnrolledVersion>(`/enrollments/${encodeURIComponent(enrollmentId)}/version`)

/** A Skill's current Access and Mastery within one Enrollment, as the backend derives them (ADR 0001, 0003). */
export interface EnrollmentSkillState {
  skillId: string
  title: string
  learningOutcome: string
  optional: boolean
  xpThreshold: number
  mastery: boolean
  access: boolean
  accessOverride: { id: string; reason: string; occurredAt: string } | null
  unmetPrerequisiteSkillIds: string[]
  xpShortfall: number
}

/** A Task's contribution within one Enrollment: its reward counts once while a valid Approval exists (ADR 0007). */
export interface EnrollmentTaskState {
  taskId: string
  skillId: string
  title: string
  required: boolean
  xpReward: number
  approved: boolean
  xpContribution: number
}

/** An Enrollment's learning records: Enrollment-local XP, Access and Mastery per Skill, and their history. */
export interface EnrollmentLearningState {
  enrollmentId: string
  learningPathVersionId: string
  enrollmentStatus: 'active' | 'inactive'
  xp: number
  skills: EnrollmentSkillState[]
  tasks: EnrollmentTaskState[]
  xpHistory: { id: number; taskId: string; occurredAt: string; kind: 'award' | 'correction'; amount: number }[]
  masteryHistory: { id: number; skillId: string; occurredAt: string; action: 'award' | 'revocation' }[]
  taskStarts: { taskId: string; startedAt: string }[]
}

export const readEnrollmentLearningState = (enrollmentId: string) =>
  call<{ learningState: EnrollmentLearningState }>(`/enrollments/${encodeURIComponent(enrollmentId)}/learning-state`)

/** One sent, immutable Submission Revision and the Review of exactly that revision, if any (ADR 0002). */
export interface SubmissionRevisionView {
  id: string
  revisionNumber: number
  text: string
  urls: string[]
  sentAt: string
  status: 'pending' | 'superseded' | 'approval' | 'approval_revoked' | 'changes_requested'
  review?: { decision: 'approval' | 'changes_requested'; feedback: string | null; decidedAt: string; revokedAt: string | null; revocationReason: string | null }
}

/** A Task's Submission history in one Enrollment; a Task without one answers 404 `submission_not_found`. */
export const readTaskSubmission = (enrollmentId: string, taskId: string) =>
  call<{ submission: { id: string; revisions: SubmissionRevisionView[] } }>(`/enrollments/${encodeURIComponent(enrollmentId)}/tasks/${encodeURIComponent(taskId)}/submission`)
