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

/**
 * Archives one Task of the owner's Path (ADR 0018): it leaves the document, so the
 * revision advances, while its completion, contribution and history stay. Based on
 * `expectedRevision`; a stale archive answers 409 with the accepted document in `body.current`.
 */
export const archivePersonalTask = (pathId: string, taskId: string, expectedRevision: number) =>
  call<{ changed: boolean; learningState: LearningState; document: PathDocument }>(`/personal/learning-paths/${encodeURIComponent(pathId)}/tasks/${encodeURIComponent(taskId)}/archive`, { method: 'POST', body: { expectedRevision } })

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
  /** Skills with learning history (ADR 0018): a save cannot delete them. */
  historySkillIds: string[]
  /** Tasks with learning history: a save cannot delete them; they are archived instead. */
  historyTaskIds: string[]
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

/** One Task Board Column: its identity and role (never its name) decide what membership means (ADR 0027). */
export interface TaskBoardColumn { id: string; name: string; completion: boolean; taskIds: string[] }
/** One Skill's Task Board, saved whole against its own `revision`. */
export interface TaskBoard { skillId: string; revision: number; columns: TaskBoardColumn[] }

const boardRoute = (pathId: string, skillId: string) => `${learningRoute(pathId)}/skills/${encodeURIComponent(skillId)}/board`

/** Opens a personal Skill's Task Board; its first opening creates it from the existing Tasks. */
export const readPersonalBoard = (pathId: string, skillId: string) => call<{ board: TaskBoard }>(boardRoute(pathId, skillId))

/**
 * Saves the whole board based on `expectedRevision`. Cards crossing the Completion
 * Column complete or uncomplete their Tasks in the same change. A stale save answers
 * 409 with the accepted board in `body.current`; repeating the accepted arrangement
 * answers `changed: false`.
 */
export const savePersonalBoard = (pathId: string, skillId: string, expectedRevision: number, columns: TaskBoardColumn[]) =>
  call<{ changed: boolean; board: TaskBoard; learningState: LearningState }>(boardRoute(pathId, skillId), { method: 'PUT', body: { expectedRevision, columns } })

const draftBoardRoute = (pathId: string, draftId: string, skillId: string) => `/coach/learning-paths/${pathId}/drafts/${draftId}/skills/${skillId}/board`

/**
 * A Draft Skill's preparation board (ADR 0029), opened (and created once) by reading it.
 * Its columns have no role: a save writes the arrangement and nothing else. A board of a
 * Draft published meanwhile answers 409 `draft_published`.
 */
export const readDraftBoard = (pathId: string, draftId: string, skillId: string) => call<{ board: TaskBoard }>(draftBoardRoute(pathId, draftId, skillId))

/** Saves the whole preparation board based on `expectedRevision`; stale and repeated saves answer as for a personal board. */
export const saveDraftBoard = (pathId: string, draftId: string, skillId: string, expectedRevision: number, columns: TaskBoardColumn[]) =>
  call<{ changed: boolean; board: TaskBoard }>(draftBoardRoute(pathId, draftId, skillId), { method: 'PUT', body: { expectedRevision, columns } })

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
  /** `layoutRevision`: the expected revision of the Version's next layout save, apart from the Path's content `revision`. */
  version: { id: string; versionNumber: number; publishedAt: string | null; layoutRevision: number } | null
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
 * Archives a published Task from the open Draft (ADR 0018): the next Version leaves it
 * out, while earlier Versions and their Enrollments keep it. A Task only the Draft holds
 * answers 409 `task_not_published`; a stale archive 409 `stale_revision` with `body.current`.
 */
export const archiveDraftTask = (pathId: string, taskId: string, expectedRevision: number) =>
  call<CoachPathDocument>(`/coach/learning-paths/${encodeURIComponent(pathId)}/draft/tasks/${encodeURIComponent(taskId)}/archive`, { method: 'POST', body: { expectedRevision } })

/**
 * Publishes the open Draft as it stood at `expectedRevision`. A blocked required route
 * answers 422 `publication_blocked` with `blockedSkills` and `reachableXp` in the body.
 */
export const publishCoachDraft = (pathId: string, expectedRevision: number) =>
  call<CoachPathDocument>(`/coach/learning-paths/${encodeURIComponent(pathId)}/publication`, { method: 'POST', body: { expectedRevision } })

/** Prepares the next Version as a Draft copied from the latest published one. */
export const prepareCoachDraft = (pathId: string, expectedRevision: number) =>
  call<CoachPathDocument>(`/coach/learning-paths/${encodeURIComponent(pathId)}/drafts`, { method: 'POST', body: { expectedRevision } })

/**
 * Where the signed-in Account may copy Skills and Tasks from (ADR 0004): its own
 * personal Paths and, in the Coach Workspaces it owns, each Path's open Draft and
 * published Versions. Another Account's content is never listed.
 */
export interface ReuseSources {
  personal: { learningPathId: string; title: string }[]
  coach: {
    workspace: { id: string; name: string }
    learningPaths: { learningPathId: string; title: string; draft: { id: string; versionNumber: number } | null; versions: { id: string; versionNumber: number }[] }[]
  }[]
}

export const listReuseSources = () => call<ReuseSources>('/reuse/sources')

/** One published Version of a Path in the signed-in Coach's Workspace, read-only. */
export const readCoachVersion = (versionId: string) => call<CoachPathDocument>(`/coach/learning-path-versions/${encodeURIComponent(versionId)}`)

/** A layout save: card positions only, based on the Version's `layoutRevision` (ADR 0016). */
export interface LayoutSave { expectedRevision: number; cards: { id: string; position: { x: number; y: number } }[] }

/**
 * Saves new card positions of a published Version's shared Canvas Layout. Its learning
 * content stays as published and no Version is created; a stale save answers 409 with
 * the accepted document in `body.current`.
 */
export const saveVersionLayout = (versionId: string, save: LayoutSave) =>
  call<CoachPathDocument>(`/coach/learning-path-versions/${encodeURIComponent(versionId)}/layout`, { method: 'PUT', body: save })

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

/** One Enrollment of a Version as its Coach sees it: the learner as invited and the work awaiting Review. */
export interface CoachEnrollment {
  id: string
  status: 'active' | 'inactive'
  createdAt: string
  learner: { name: string; email: string }
  awaitingReview: AwaitingRevision[]
}

/** The Version's Enrollments, for the owner of its Coach Workspace only; anyone else gets 404 `version_not_found`. */
export const listVersionEnrollments = (versionId: string) => call<{ enrollments: CoachEnrollment[] }>(`${versionRoute(versionId)}/enrollments`)

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
  /** The Enrollment's learner, as invited. */
  learner: { name: string; email: string }
  learningPath: { id: string; title: string; goal: string }
  version: { id: string; versionNumber: number; publishedAt: string }
  coachWorkspace: { id: string; name: string }
  /** The Workspace's Coach, by name only: who acts in this Enrollment's records. */
  coach: { id: string; name: string }
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
  /** The grant of the Access Override in force for this Skill, if any. */
  accessOverride: OverrideRecord | null
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
  xpHistory: EnrollmentXpEvent[]
  masteryHistory: EnrollmentMasteryEvent[]
  taskStarts: { taskId: string; startedAt: string }[]
  /** Revisions sent, not superseded and not yet decided: at most one per Task, oldest first. */
  awaitingReview: AwaitingRevision[]
  /** Every grant and revocation of an Access Override in this Enrollment, oldest first. */
  overrideHistory: OverrideRecord[]
  /** Every deactivation and reactivation of this Enrollment, oldest first. */
  lifecycleHistory: LifecycleRecord[]
}

/**
 * One deactivation or reactivation of an Enrollment (ADR 0014). The action, Actor, learner
 * and time are recorded by the backend; the reason is the Actor's, and is null only for
 * a learner's own deactivation, which needs none.
 */
export interface LifecycleRecord {
  id: string
  sequence: number
  enrollmentId: string
  learningPathVersionId: string
  actorAccountId: string
  learnerAccountId: string
  action: 'deactivate' | 'reactivate'
  reason: string | null
  occurredAt: string
}

/**
 * One grant or revocation of an Access Override, recorded with its reason; the action,
 * acting Coach, learner, Enrollment, Skill and time are recorded by the backend, never
 * supplied by the client. A revocation names the grant it withdraws.
 */
export interface OverrideRecord {
  id: string
  sequence: number
  enrollmentId: string
  learningPathVersionId: string
  skillId: string
  coachAccountId: string
  learnerAccountId: string
  action: 'grant' | 'revoke'
  grantRecordId: string | null
  reason: string
  occurredAt: string
}

/**
 * A change of one Task's XP contribution, caused by the decision on (or revocation of
 * the Approval of) one revision: an award, a correction removing it when the last
 * valid Approval was revoked, or a correction restoring it with a later Approval.
 */
export interface EnrollmentXpEvent { id: number; taskId: string; revisionId: string; revisionNumber: number; occurredAt: string; kind: 'award' | 'correction'; amount: number }

/** A Mastery award or revocation, caused by the decision on (or revocation of) one revision of `taskId`. */
export interface EnrollmentMasteryEvent { id: number; skillId: string; taskId: string; revisionId: string; revisionNumber: number; occurredAt: string; action: 'award' | 'revocation' }

/** A sent revision still waiting for the Coach's decision (ADR 0002). */
export interface AwaitingRevision { taskId: string; revisionId: string; revisionNumber: number; sentAt: string }

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
  /** Only on a revoked Approval: what its revocation changed, read with this history. */
  revocation?: RevocationOutcome
}

/**
 * What revoking one Approval changed, as the backend read it together with the history
 * (ADR 0003): the Approvals still counting at that moment, the XP Correction it caused
 * (negative, or null), and the Skills whose Mastery it revoked.
 */
export interface RevocationOutcome { stillCountingRevisionNumbers: number[]; xpCorrection: number | null; masteryRevokedSkillIds: string[] }

/** A Task's Submission history in one Enrollment; a Task without one answers 404 `submission_not_found`. */
export const readTaskSubmission = (enrollmentId: string, taskId: string) =>
  call<{ submission: { id: string; revisions: SubmissionRevisionView[] } }>(`/enrollments/${encodeURIComponent(enrollmentId)}/tasks/${encodeURIComponent(taskId)}/submission`)

/** Text and URLs: the MVP evidence a private draft or a sent revision holds (ADR 0002). */
export interface SubmissionContents { text: string; urls: string[] }

/** The learner's saved, private draft for one Task; only its learner can read or write it. */
export interface SubmissionDraft extends SubmissionContents { enrollmentId: string; taskId: string; updatedAt: string }

const taskRoute = (enrollmentId: string, taskId: string) => `/enrollments/${encodeURIComponent(enrollmentId)}/tasks/${encodeURIComponent(taskId)}`

/** The learner's own draft, or null when none is saved; the Coach is refused 403 `draft_private`. */
export const readTaskDraft = (enrollmentId: string, taskId: string) => call<{ draft: SubmissionDraft | null }>(`${taskRoute(enrollmentId, taskId)}/draft`)

/** Saves the draft, replacing its previous contents. Invalid evidence answers 422 `invalid_contents`. */
export const saveTaskDraft = (enrollmentId: string, taskId: string, contents: SubmissionContents) =>
  call<{ draft: SubmissionDraft }>(`${taskRoute(enrollmentId, taskId)}/draft`, { method: 'PUT', body: contents })

/**
 * Sends contents as a new immutable revision of the Task's one Submission; 201 is the
 * backend's confirmation. Refusals: `skill_locked`, `enrollment_inactive` (403),
 * `empty_submission`, `invalid_contents` (422).
 */
export const sendTaskRevision = (enrollmentId: string, taskId: string, contents: SubmissionContents) =>
  call<{ submission: { id: string }; revision: { id: string; revisionNumber: number; sentAt: string }; createdSubmission: boolean }>(`${taskRoute(enrollmentId, taskId)}/submission/revisions`, { method: 'POST', body: contents })

export type ReviewDecision = 'approval' | 'changes_requested'

/**
 * The owning Coach's decision on exactly one revision; 201 is the backend's confirmation,
 * after which XP, Mastery and Access are derived again. Refusals: `revision_superseded`,
 * `revision_already_reviewed` (409), `coach_only` (403, the learner themselves),
 * `revision_not_found`, `enrollment_not_found` (404), `invalid_review` (422: Changes
 * Requested without feedback).
 */
export const reviewRevision = (enrollmentId: string, taskId: string, revisionId: string, decision: ReviewDecision, feedback: string | null) =>
  call<{ review: { revisionId: string; decision: ReviewDecision; feedback: string | null; decidedAt: string } }>(
    `${taskRoute(enrollmentId, taskId)}/submission/revisions/${encodeURIComponent(revisionId)}/review`, { method: 'POST', body: { decision, feedback } })

/**
 * The owning Coach's revocation of the Approval of exactly one revision, with a mandatory
 * reason (ADR 0003); the original decision stays in the history. 200 is the backend's
 * confirmation, after which XP, Mastery and Access are derived again. Refusals:
 * `approval_already_revoked` (409), `coach_only` (403, the learner themselves),
 * `approval_not_found`, `enrollment_not_found` (404: no such Approval, or not this Coach's),
 * `invalid_revocation` (422: no reason).
 */
export const revokeRevisionApproval = (enrollmentId: string, taskId: string, revisionId: string, reason: string) =>
  call<{ review: { revisionId: string; decision: 'approval'; revokedAt: string; revocationReason: string } }>(
    `${taskRoute(enrollmentId, taskId)}/submission/revisions/${encodeURIComponent(revisionId)}/review/revoke`, { method: 'POST', body: { reason } })

const overrideRoute = (enrollmentId: string, skillId: string) => `/enrollments/${encodeURIComponent(enrollmentId)}/skills/${encodeURIComponent(skillId)}/access-overrides`

/**
 * The owning Coach's grant of an Access Override for one Skill in one Enrollment, with a
 * mandatory reason. 201 is the backend's confirmation. Refusals: `override_already_active`
 * (409), `coach_only` (403, the learner themselves), `enrollment_not_found`,
 * `skill_not_found`, `override_not_found` (404: not this Coach's Enrollment or not its
 * Version's Skill), `invalid_override_reason` (422).
 */
export const grantAccessOverride = (enrollmentId: string, skillId: string, reason: string) =>
  call<{ overrideRecord: OverrideRecord }>(overrideRoute(enrollmentId, skillId), { method: 'POST', body: { reason } })

/**
 * The owning Coach's revocation of exactly the grant in force, with a mandatory reason.
 * 200 is the backend's confirmation. Refusals: `override_not_active` (409: already
 * revoked), `coach_only` (403), `override_not_found`, `enrollment_not_found`,
 * `skill_not_found` (404), `invalid_override_reason` (422).
 */
export const revokeAccessOverride = (enrollmentId: string, skillId: string, grantRecordId: string, reason: string) =>
  call<{ overrideRecord: OverrideRecord }>(`${overrideRoute(enrollmentId, skillId)}/${encodeURIComponent(grantRecordId)}/revoke`, { method: 'POST', body: { reason } })

/**
 * Deactivates an Enrollment as its learner (no reason needed: pass null) or its owning Coach
 * (a reason is required), or reactivates it as the owning Coach with a reason (ADR 0014).
 * 200 is the backend's confirmation, with the record it made. Refusals:
 * `enrollment_already_inactive`, `enrollment_already_active` (409), `coach_only` (403: a
 * learner reactivating), `enrollment_not_found` (404: not this Account's Enrollment),
 * `invalid_lifecycle_reason` (422).
 */
export const changeEnrollmentStatus = (enrollmentId: string, action: LifecycleRecord['action'], reason: string | null) =>
  call<{ enrollment: EnrollmentSummary; lifecycleRecord: LifecycleRecord }>(`/enrollments/${encodeURIComponent(enrollmentId)}/${action}`, { method: 'POST', body: reason === null ? {} : { reason } })
