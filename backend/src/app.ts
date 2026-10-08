import { Hono, type Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { sessionIdentity, type Auth } from './auth'
import * as authoring from './authoring'
import * as coaching from './coaching'
import type { Database } from './db/client'
import { readDraftBoard, saveDraftBoard, type DraftBoardRefusal } from './draftBoard'
import { readEnrollmentBoard, saveEnrollmentBoard, type EnrollmentBoardRefusal } from './enrollmentBoard'
import { acceptInvitation, listLearnerEnrollments, readEnrolledVersion, readEnrollment, readInvitation, type EnrollmentRefusal } from './enrollments'
import type { IdentityResolver } from './identity'
import * as invitations from './invitations'
import { changeAccessOverride } from './overrides'
import { changeEnrollmentStatus } from './lifecycle'
import * as personal from './personal'
import { readPersonalBoard, savePersonalBoard, type BoardRefusal } from './personalBoard'
import { parseBoardInput } from './taskBoards'
import { listVersionEnrollments, readLearningState, recordReview, revokeApproval, type ReviewContents } from './reviews'
import { listReuseSources } from './reuse'
import { readDraft, readSubmission, saveDraft, sendRevision, startTask, type SubmissionContents, type SubmissionRefusal } from './submissions'
import { enterPersonalWorkspace, readAccount, readPersonalWorkspace } from './workspace'

const REFUSAL_STATUS: Record<EnrollmentRefusal, ContentfulStatusCode> = {
  invitation_not_found: 404,
  enrollment_not_found: 404,
  email_not_verified: 403,
  email_mismatch: 403,
  owner_cannot_enroll: 403,
  version_not_published: 409,
  enrollment_closed: 409,
}

const SUBMISSION_REFUSAL_STATUS: Record<SubmissionRefusal, ContentfulStatusCode> = {
  enrollment_not_found: 404,
  task_not_found: 404,
  submission_not_found: 404,
  draft_private: 403,
  learner_only: 403,
  enrollment_inactive: 403,
  skill_locked: 403,
}

const PERSONAL_REFUSAL_STATUS: Record<personal.PersonalRefusal, ContentfulStatusCode> = {
  learning_path_not_found: 404,
  task_not_found: 404,
  skill_not_found: 404,
  task_archived: 409,
  skill_archived: 409,
  skill_locked: 403,
}

const BOARD_REFUSAL_STATUS: Record<BoardRefusal, ContentfulStatusCode> = {
  learning_path_not_found: 404,
  skill_not_found: 404,
  stale_revision: 409,
  board_task_missing: 422,
  board_task_unknown: 422,
  column_owned_elsewhere: 422,
  skill_locked: 403,
}

const DRAFT_BOARD_REFUSAL_STATUS: Record<DraftBoardRefusal, ContentfulStatusCode> = {
  learning_path_not_found: 404,
  draft_not_found: 404,
  skill_not_found: 404,
  draft_published: 409,
  stale_revision: 409,
  board_task_missing: 422,
  board_task_unknown: 422,
  column_owned_elsewhere: 422,
}

const ENROLLMENT_BOARD_REFUSAL_STATUS: Record<EnrollmentBoardRefusal, ContentfulStatusCode> = {
  enrollment_not_found: 404,
  skill_not_found: 404,
  learner_only: 403,
  stale_revision: 409,
  board_task_missing: 422,
  board_task_unknown: 422,
  column_owned_elsewhere: 422,
}

const SAVE_REFUSAL_STATUS: Record<authoring.SaveRefusal, ContentfulStatusCode> = {
  learning_path_not_found: 404,
  stale_revision: 409,
  skill_owned_elsewhere: 409,
  task_owned_elsewhere: 409,
  task_skill_mismatch: 409,
  task_archived: 409,
  skill_archived: 409,
  skill_has_history: 409,
  task_has_history: 409,
}

const DRAFT_REFUSAL_STATUS: Record<coaching.DraftRefusal, ContentfulStatusCode> = {
  learning_path_not_found: 404,
  no_open_draft: 409,
  stale_revision: 409,
  skill_owned_elsewhere: 409,
  task_owned_elsewhere: 409,
  task_skill_mismatch: 409,
  skill_archived: 409,
  skill_has_history: 409,
  task_has_history: 409,
}

const ARCHIVE_DRAFT_REFUSAL_STATUS: Record<coaching.ArchiveDraftRefusal, ContentfulStatusCode> = {
  learning_path_not_found: 404,
  task_not_found: 404,
  stale_revision: 409,
  no_open_draft: 409,
  task_not_published: 409,
}

const PUBLICATION_REFUSAL_STATUS: Record<coaching.PublicationRefusal, ContentfulStatusCode> = {
  learning_path_not_found: 404,
  stale_revision: 409,
  no_open_draft: 409,
  draft_already_open: 409,
  publication_blocked: 422,
}

const LAYOUT_REFUSAL_STATUS: Record<coaching.LayoutRefusal, ContentfulStatusCode> = {
  version_not_found: 404,
  stale_revision: 409,
  skill_not_in_version: 422,
}

const INVITATION_REFUSAL_STATUS: Record<invitations.InvitationRefusal, ContentfulStatusCode> = {
  version_not_found: 404,
  invitation_not_found: 404,
  version_not_published: 409,
}

/**
 * How Enrollment Invitations reach their addressee (ADR 0023): the email sender and
 * the acceptance link an Invitation ID becomes in the application.
 */
export interface InvitationDelivery {
  send: invitations.InvitationSender
  link: (invitationId: string) => string
}

const MAX_TEXT_LENGTH = 50_000
const MAX_URLS = 20
const MAX_URL_LENGTH = 2_048
const MAX_XP_REWARD = 1_000_000
const MAX_XP_THRESHOLD = 1_000_000_000

/**
 * Validates text and URL evidence without rewriting it: valid values are kept
 * exactly as sent. URLs must be absolute http(s) links; their destinations are
 * never fetched.
 */
function parseContents(body: unknown): SubmissionContents | null {
  if (typeof body !== 'object' || body === null) return null
  const { text = '', urls = [] } = body as Record<string, unknown>
  if (typeof text !== 'string' || text.length > MAX_TEXT_LENGTH) return null
  if (!Array.isArray(urls) || urls.length > MAX_URLS) return null
  for (const url of urls) {
    if (typeof url !== 'string' || url.length > MAX_URL_LENGTH || !URL.canParse(url)) return null
    if (!['http:', 'https:'].includes(new URL(url).protocol)) return null
  }
  return { text, urls }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NIL_UUID = '00000000-0000-0000-0000-000000000000'

/**
 * The backend request interface; identity comes only from the injected resolver.
 * With `auth`, it also serves Better Auth's sign-in endpoints under `/auth`; with
 * `delivery`, Coaches can send Enrollment Invitations.
 */
export function createApp({ db, identity, auth, delivery }: { db: Database; identity: IdentityResolver; auth?: Auth; delivery?: InvitationDelivery }) {
  type Env = { Variables: { accountId: string } }
  const app = new Hono<Env>()

  // Every learning route acts for a trusted Account; there is no anonymous access.
  const authenticate = createMiddleware<Env>(async (c, next) => {
    const accountId = await identity(c)
    if (!accountId) return c.json({ error: 'unauthenticated' }, 401)
    c.set('accountId', accountId)
    await next()
  })

  app.get('/', (c) => c.text('Hello Hono!'))
  if (auth) app.on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw))

  app.use('/account', authenticate)
  app.get('/account', async (c) => {
    const account = await readAccount(db, c.get('accountId'))
    if (!account) return c.json({ error: 'unauthenticated' }, 401)
    return c.json({ account })
  })

  app.use('/invitations/*', authenticate)
  app.use('/enrollments', authenticate)
  app.use('/enrollments/*', authenticate)

  // The addressee's view of an Invitation: what it offers, and any Enrollment they already hold in that Version.
  app.get('/invitations/:invitationId', async (c) => {
    const invitationId = c.req.param('invitationId')
    if (!UUID.test(invitationId)) return c.json({ error: 'invitation_not_found' }, 404)
    const result = await readInvitation(db, invitationId, c.get('accountId'))
    if (!result.ok) return c.json({ error: result.refusal }, REFUSAL_STATUS[result.refusal])
    return c.json({ offer: result.offer, enrollment: result.enrollment })
  })

  app.post('/invitations/:invitationId/accept', async (c) => {
    const invitationId = c.req.param('invitationId')
    if (!UUID.test(invitationId)) return c.json({ error: 'invitation_not_found' }, 404)
    const result = await acceptInvitation(db, invitationId, c.get('accountId'))
    if (!result.ok) return c.json({ error: result.refusal }, REFUSAL_STATUS[result.refusal])
    return c.json({ enrollment: result.enrollment, created: result.created, offer: result.offer }, result.created ? 201 : 200)
  })

  app.get('/enrollments', async (c) => c.json({ enrollments: await listLearnerEnrollments(db, c.get('accountId')) }))

  // The pinned Version an Enrollment joined, read-only (ADR 0005); its learning records are under /learning-state.
  app.get('/enrollments/:enrollmentId/version', async (c) => {
    const enrollmentId = c.req.param('enrollmentId')
    const enrolled = UUID.test(enrollmentId) ? await readEnrolledVersion(db, enrollmentId, c.get('accountId')) : null
    if (!enrolled) return c.json({ error: 'enrollment_not_found' }, 404)
    return c.json(enrolled)
  })

  app.get('/enrollments/:enrollmentId', async (c) => {
    const enrollmentId = c.req.param('enrollmentId')
    const enrollment = UUID.test(enrollmentId) ? await readEnrollment(db, enrollmentId, c.get('accountId')) : null
    if (!enrollment) return c.json({ error: 'enrollment_not_found' }, 404)
    return c.json({ enrollment })
  })

  for (const action of ['deactivate', 'reactivate'] as const) {
    app.post(`/enrollments/:enrollmentId/${action}`, async (c) => {
      const enrollmentId = c.req.param('enrollmentId')
      if (!UUID.test(enrollmentId)) return c.json({ error: 'enrollment_not_found' }, 404)
      const raw = await c.req.text()
      let body: unknown = {}
      try { if (raw !== '') body = JSON.parse(raw) } catch { body = null }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return c.json({ error: 'invalid_lifecycle_reason' }, 422)
      const { reason = null } = body as Record<string, unknown>
      if ((reason !== null && (typeof reason !== 'string' || reason.trim() === '' || reason.length > 500)) || (action === 'reactivate' && reason === null)) return c.json({ error: 'invalid_lifecycle_reason' }, 422)
      const result = await changeEnrollmentStatus(db, enrollmentId, c.get('accountId'), action, reason as string | null)
      if (!result.ok) return c.json({ error: result.refusal }, result.refusal === 'enrollment_not_found' ? 404 : result.refusal === 'coach_only' ? 403 : result.refusal === 'invalid_lifecycle_reason' ? 422 : 409)
      return c.json({ enrollment: result.enrollment, lifecycleRecord: result.lifecycleRecord })
    })
  }

  // Drafts and Submissions of one Task in one Enrollment (ADR 0002).
  const taskRoute = '/enrollments/:enrollmentId/tasks/:taskId'
  const taskParams = ({ enrollmentId, taskId }: { enrollmentId: string; taskId: string }) =>
    UUID.test(enrollmentId) && UUID.test(taskId) ? { enrollmentId, taskId } : null
  const contents = async (c: { req: { json: () => Promise<unknown> } }) => parseContents(await c.req.json().catch(() => null))

  app.post(`${taskRoute}/start`, async (c) => {
    const params = taskParams(c.req.param())
    if (!params) return c.json({ error: 'enrollment_not_found' }, 404)
    const result = await startTask(db, params.enrollmentId, params.taskId, c.get('accountId'))
    if (!result.ok) return c.json({ error: result.refusal }, SUBMISSION_REFUSAL_STATUS[result.refusal])
    return c.json({ taskStart: result.value, created: result.created }, result.created ? 201 : 200)
  })

  app.get(`${taskRoute}/draft`, async (c) => {
    const params = taskParams(c.req.param())
    if (!params) return c.json({ error: 'enrollment_not_found' }, 404)
    const result = await readDraft(db, params.enrollmentId, params.taskId, c.get('accountId'))
    if (!result.ok) return c.json({ error: result.refusal }, SUBMISSION_REFUSAL_STATUS[result.refusal])
    return c.json({ draft: result.value })
  })

  app.put(`${taskRoute}/draft`, async (c) => {
    const params = taskParams(c.req.param())
    if (!params) return c.json({ error: 'enrollment_not_found' }, 404)
    const draft = await contents(c)
    if (!draft) return c.json({ error: 'invalid_contents' }, 422)
    const result = await saveDraft(db, params.enrollmentId, params.taskId, c.get('accountId'), draft)
    if (!result.ok) return c.json({ error: result.refusal }, SUBMISSION_REFUSAL_STATUS[result.refusal])
    return c.json({ draft: result.value })
  })

  app.get(`${taskRoute}/submission`, async (c) => {
    const params = taskParams(c.req.param())
    if (!params) return c.json({ error: 'enrollment_not_found' }, 404)
    const result = await readSubmission(db, params.enrollmentId, params.taskId, c.get('accountId'))
    if (!result.ok) return c.json({ error: result.refusal }, SUBMISSION_REFUSAL_STATUS[result.refusal])
    return c.json({ submission: result.value })
  })

  // Sending always appends a revision; there is no route that edits a sent one.
  app.post(`${taskRoute}/submission/revisions`, async (c) => {
    const params = taskParams(c.req.param())
    if (!params) return c.json({ error: 'enrollment_not_found' }, 404)
    const sent = await contents(c)
    if (!sent) return c.json({ error: 'invalid_contents' }, 422)
    if (sent.text.trim() === '' && sent.urls.length === 0) return c.json({ error: 'empty_submission' }, 422)
    const result = await sendRevision(db, params.enrollmentId, params.taskId, c.get('accountId'), sent)
    if (!result.ok) return c.json({ error: result.refusal }, SUBMISSION_REFUSAL_STATUS[result.refusal])
    return c.json(result.value, 201)
  })

  app.post(`${taskRoute}/submission/revisions/:revisionId/review`, async (c) => {
    const params = taskParams(c.req.param())
    const revisionId = c.req.param('revisionId')
    if (!params || !UUID.test(revisionId)) return c.json({ error: 'revision_not_found' }, 404)
    const body: unknown = await c.req.json().catch(() => null)
    if (typeof body !== 'object' || body === null) return c.json({ error: 'invalid_review' }, 422)
    const { decision, feedback = null } = body as Record<string, unknown>
    if ((decision !== 'approval' && decision !== 'changes_requested') ||
      (feedback !== null && (typeof feedback !== 'string' || feedback.length > MAX_TEXT_LENGTH)) ||
      (decision === 'changes_requested' && (typeof feedback !== 'string' || feedback.trim() === ''))) {
      return c.json({ error: 'invalid_review' }, 422)
    }
    const result = await recordReview(db, params.enrollmentId, params.taskId, revisionId, c.get('accountId'), { decision, feedback } as ReviewContents)
    if (!result.ok) {
      const status = result.refusal === 'coach_only' ? 403 :
        result.refusal === 'revision_superseded' || result.refusal === 'revision_already_reviewed' ? 409 : 404
      return c.json({ error: result.refusal }, status)
    }
    return c.json({ review: result.value }, 201)
  })

  app.post(`${taskRoute}/submission/revisions/:revisionId/review/revoke`, async (c) => {
    const params = taskParams(c.req.param())
    const revisionId = c.req.param('revisionId')
    if (!params || !UUID.test(revisionId)) return c.json({ error: 'approval_not_found' }, 404)
    const body: unknown = await c.req.json().catch(() => null)
    const reason = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).reason : null
    if (typeof reason !== 'string' || reason.trim() === '' || reason.length > MAX_TEXT_LENGTH) return c.json({ error: 'invalid_revocation' }, 422)
    const result = await revokeApproval(db, params.enrollmentId, params.taskId, revisionId, c.get('accountId'), reason)
    if (!result.ok) return c.json({ error: result.refusal }, result.refusal === 'coach_only' ? 403 : result.refusal === 'approval_already_revoked' ? 409 : 404)
    return c.json({ review: result.value })
  })

  // A learner's own Task Board for one Skill of the Enrollment (ADR 0027, 0030): saved whole against
  // its own revision like the other boards, but its columns have no role, so a save writes nothing
  // but the board: never a Submission, Review, XP, Mastery or Task start. Only the learner reaches it.
  const enrollmentBoardRoute = '/enrollments/:enrollmentId/skills/:skillId/board'
  const enrollmentBoardTarget = (enrollmentId: string, skillId: string) =>
    UUID.test(enrollmentId) ? { enrollmentId: enrollmentId.toLowerCase(), skillId: UUID.test(skillId) ? skillId.toLowerCase() : NIL_UUID } : null
  app.get(enrollmentBoardRoute, async (c) => {
    const target = enrollmentBoardTarget(c.req.param('enrollmentId'), c.req.param('skillId'))
    if (!target) return c.json({ error: 'enrollment_not_found' }, 404)
    const result = await readEnrollmentBoard(db, target.enrollmentId, target.skillId, c.get('accountId'))
    if (!result.ok) return c.json({ error: result.refusal, detail: result.detail }, ENROLLMENT_BOARD_REFUSAL_STATUS[result.refusal])
    return c.json({ board: result.board })
  })

  app.put(enrollmentBoardRoute, async (c) => {
    const target = enrollmentBoardTarget(c.req.param('enrollmentId'), c.req.param('skillId'))
    if (!target) return c.json({ error: 'enrollment_not_found' }, 404)
    const input = parseBoardInput(await c.req.json().catch(() => null), { completionColumn: false })
    if (!input.ok) {
      // An invalid board for someone else's Enrollment or Skill is still refused as such.
      const owned = await readEnrollmentBoard(db, target.enrollmentId, target.skillId, c.get('accountId'))
      if (!owned.ok) return c.json({ error: owned.refusal, detail: owned.detail }, ENROLLMENT_BOARD_REFUSAL_STATUS[owned.refusal])
      return c.json({ error: 'invalid_board', detail: input.detail }, 422)
    }
    const result = await saveEnrollmentBoard(db, target.enrollmentId, target.skillId, c.get('accountId'), input.value)
    if (!result.ok) return c.json({ error: result.refusal, detail: result.detail, ...(result.current ? { current: result.current } : {}) }, ENROLLMENT_BOARD_REFUSAL_STATUS[result.refusal])
    return c.json({ changed: result.changed, board: result.board })
  })

  const overrideRoute = '/enrollments/:enrollmentId/skills/:skillId/access-overrides'
  for (const action of ['grant', 'revoke'] as const) {
    app.post(action === 'grant' ? overrideRoute : `${overrideRoute}/:grantRecordId/revoke`, async (c) => {
      const enrollmentId = c.req.param('enrollmentId')
      const skillId = c.req.param('skillId')
      const grantRecordId = action === 'revoke' ? c.req.param('grantRecordId') : null
      if (!UUID.test(enrollmentId) || !UUID.test(skillId) || (grantRecordId !== null && !UUID.test(grantRecordId))) return c.json({ error: 'override_not_found' }, 404)
      const body: unknown = await c.req.json().catch(() => null)
      const reason = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).reason : null
      if (typeof reason !== 'string' || reason.trim() === '' || reason.length > 500) return c.json({ error: 'invalid_override_reason' }, 422)
      const result = await changeAccessOverride(db, enrollmentId, skillId, c.get('accountId'), reason, grantRecordId)
      if (!result.ok) return c.json({ error: result.refusal }, result.refusal === 'coach_only' ? 403 : result.refusal === 'override_already_active' || result.refusal === 'override_not_active' ? 409 : 404)
      return c.json({ overrideRecord: result.value }, action === 'grant' ? 201 : 200)
    })
  }

  // Personal mode (ADR 0009, 0012): owner-only, without reasons, evidence or Review.
  // Toggles are idempotent: a repeat answers 200 with `changed: false` and records nothing.
  app.use('/personal/*', authenticate)
  const personalPath = '/personal/learning-paths/:pathId'
  // A malformed Path is unknown; a malformed Task/Skill is unknown only after ownership is checked.
  const personalTarget = (pathId: string, targetId: string) => UUID.test(pathId) ? { pathId, targetId: UUID.test(targetId) ? targetId : NIL_UUID } : null
  type PersonalResult = Awaited<ReturnType<typeof personal.completeTask>>
  const personalResult = (c: Context<Env>, result: PersonalResult) => result.ok
    ? c.json({ changed: result.changed, learningState: result.learningState })
    : c.json({ error: result.refusal }, PERSONAL_REFUSAL_STATUS[result.refusal])

  // Entering is idempotent: the first entry creates the one Personal Workspace (201), later ones read it (200).
  app.put('/personal/workspace', async (c) => {
    const { created, ...entered } = await enterPersonalWorkspace(db, c.get('accountId'))
    return c.json(entered, created ? 201 : 200)
  })

  app.get('/personal/workspaces/:workspaceId', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const workspace = UUID.test(workspaceId) ? await readPersonalWorkspace(db, workspaceId, c.get('accountId')) : null
    if (!workspace) return c.json({ error: 'workspace_not_found' }, 404)
    return c.json(workspace)
  })

  // Authoring (ADR 0016): create a Path, read its document, and save a whole document
  // against the revision it was based on. A stale save answers 409 with the accepted one.
  app.post('/personal/learning-paths', async (c) => {
    const input = authoring.parsePathInput(await c.req.json().catch(() => null))
    if (!input.ok) return c.json({ error: 'invalid_learning_path', detail: input.detail }, 422)
    return c.json(await authoring.createPersonalPath(db, c.get('accountId'), input.value), 201)
  })

  app.get(personalPath, async (c) => {
    const pathId = c.req.param('pathId')
    const document = UUID.test(pathId) ? await authoring.readPersonalPath(db, pathId, c.get('accountId')) : null
    if (!document) return c.json({ error: 'learning_path_not_found' }, 404)
    return c.json(document)
  })

  app.put(`${personalPath}/document`, async (c) => {
    const pathId = c.req.param('pathId')
    if (!UUID.test(pathId)) return c.json({ error: 'learning_path_not_found' }, 404)
    const input = authoring.parseDocumentInput(await c.req.json().catch(() => null))
    if (!input.ok) {
      // An invalid edit to someone else's Path is still reported as no Path at all.
      if (!await authoring.readPersonalPath(db, pathId, c.get('accountId'))) return c.json({ error: 'learning_path_not_found' }, 404)
      return c.json({ error: 'refusal' in input ? input.refusal : 'invalid_document', detail: input.detail }, 422)
    }
    const result = await authoring.savePersonalPath(db, pathId, c.get('accountId'), input.value)
    if (!result.ok && result.refusal === 'learning_path_not_found') return c.json({ error: result.refusal }, 404)
    if (!result.ok) return c.json({ error: result.refusal, detail: result.detail, ...(result.current ? { current: result.current } : {}) }, SAVE_REFUSAL_STATUS[result.refusal])
    return c.json(result.document)
  })

  app.get(`${personalPath}/learning-state`, async (c) => {
    const pathId = c.req.param('pathId')
    const learningState = UUID.test(pathId) ? await personal.readPersonalLearningState(db, pathId, c.get('accountId')) : null
    if (!learningState) return c.json({ error: 'learning_path_not_found' }, 404)
    return c.json({ learningState })
  })

  const taskActions = [
    ['PUT', 'completion', personal.completeTask],
    ['DELETE', 'completion', personal.undoTaskCompletion],
    ['POST', 'start', personal.startTask],
  ] as const
  for (const [method, action, perform] of taskActions) {
    app.on(method, `${personalPath}/tasks/:taskId/${action}`, async (c) => {
      const target = personalTarget(c.req.param('pathId'), c.req.param('taskId'))
      if (!target) return c.json({ error: 'learning_path_not_found' }, 404)
      return personalResult(c, await perform(db, target.pathId, target.targetId, c.get('accountId')))
    })
  }

  // Archival (ADR 0018): the Task leaves the document, so the revision advances; its records stay.
  // An optional expectedRevision makes it a revision-checked change like a document save.
  app.post(`${personalPath}/tasks/:taskId/archive`, async (c) => {
    const target = personalTarget(c.req.param('pathId'), c.req.param('taskId'))
    if (!target) return c.json({ error: 'learning_path_not_found' }, 404)
    const raw = await c.req.text()
    let body: unknown = {}
    try { if (raw !== '') body = JSON.parse(raw) } catch { body = null }
    const expectedRevision = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>).expectedRevision ?? null : undefined
    if (expectedRevision === undefined || (expectedRevision !== null && (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0))) {
      if (!await authoring.readPersonalPath(db, target.pathId, c.get('accountId'))) return c.json({ error: 'learning_path_not_found' }, 404)
      return c.json({ error: 'invalid_request', detail: 'expectedRevision must be a non-negative integer when given' }, 422)
    }
    const result = await authoring.archivePersonalTask(db, target.pathId, target.targetId, c.get('accountId'), expectedRevision as number | null)
    if (!result.ok) return c.json({ error: result.refusal, ...(result.refusal === 'stale_revision' ? { detail: result.detail, current: result.current } : {}) }, result.refusal === 'stale_revision' ? 409 : 404)
    return c.json({ changed: result.changed, learningState: result.learningState, document: result.document })
  })

  app.post(`${personalPath}/skills/:skillId/archive`, async (c) => {
    const target = personalTarget(c.req.param('pathId'), c.req.param('skillId'))
    if (!target) return c.json({ error: 'learning_path_not_found' }, 404)
    const body: unknown = await c.req.json().catch(() => null)
    const expectedRevision = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>).expectedRevision : undefined
    if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      if (!await authoring.readPersonalPath(db, target.pathId, c.get('accountId'))) return c.json({ error: 'learning_path_not_found' }, 404)
      return c.json({ error: 'invalid_request', detail: 'expectedRevision must be a non-negative integer' }, 422)
    }
    const result = await authoring.archivePersonalSkill(db, target.pathId, target.targetId, c.get('accountId'), expectedRevision)
    if (!result.ok) return c.json({ error: result.refusal, detail: result.detail, ...(result.current ? { current: result.current } : {}) }, result.refusal === 'stale_revision' || result.refusal === 'skill_has_prerequisites' ? 409 : 404)
    return c.json({ changed: result.changed, learningState: result.learningState, document: result.document })
  })

  app.put(`${personalPath}/tasks/:taskId/reward`, async (c) => {
    const target = personalTarget(c.req.param('pathId'), c.req.param('taskId'))
    if (!target) return c.json({ error: 'learning_path_not_found' }, 404)
    const body: unknown = await c.req.json().catch(() => null)
    const xpReward = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).xpReward : null
    if (typeof xpReward !== 'number' || !Number.isSafeInteger(xpReward) || xpReward < 0 || xpReward > MAX_XP_REWARD) return c.json({ error: 'invalid_reward' }, 422)
    return personalResult(c, await personal.changeTaskReward(db, target.pathId, target.targetId, c.get('accountId'), xpReward))
  })

  app.put(`${personalPath}/skills/:skillId/xp-threshold`, async (c) => {
    const target = personalTarget(c.req.param('pathId'), c.req.param('skillId'))
    if (!target) return c.json({ error: 'learning_path_not_found' }, 404)
    const body: unknown = await c.req.json().catch(() => null)
    const xpThreshold = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).xpThreshold : null
    if (typeof xpThreshold !== 'number' || !Number.isSafeInteger(xpThreshold) || xpThreshold < 0 || xpThreshold > MAX_XP_THRESHOLD) return c.json({ error: 'invalid_threshold' }, 422)
    return personalResult(c, await personal.setXpThreshold(db, target.pathId, target.targetId, c.get('accountId'), xpThreshold))
  })

  for (const [segment, change] of [['mastery', personal.setMastery], ['access-override', personal.setAccessOverride]] as const) {
    for (const method of ['PUT', 'DELETE'] as const) {
      app.on(method, `${personalPath}/skills/:skillId/${segment}`, async (c) => {
        const target = personalTarget(c.req.param('pathId'), c.req.param('skillId'))
        if (!target) return c.json({ error: 'learning_path_not_found' }, 404)
        return personalResult(c, await change(db, target.pathId, target.targetId, c.get('accountId'), method === 'PUT'))
      })
    }
  }

  // A Skill's Task Board (ADR 0027): opened (and created once) by reading it, saved whole against
  // its own revision. A stale save answers 409 with the accepted board; a repeat of the accepted
  // arrangement answers 200 with `changed: false`, so a retry after a lost answer changes nothing again.
  const boardRoute = `${personalPath}/skills/:skillId/board`
  app.get(boardRoute, async (c) => {
    const target = personalTarget(c.req.param('pathId'), c.req.param('skillId'))
    if (!target) return c.json({ error: 'learning_path_not_found' }, 404)
    const result = await readPersonalBoard(db, target.pathId, target.targetId, c.get('accountId'))
    if (!result.ok) return c.json({ error: result.refusal }, 404)
    return c.json({ board: result.board })
  })

  app.put(boardRoute, async (c) => {
    const target = personalTarget(c.req.param('pathId'), c.req.param('skillId'))
    if (!target) return c.json({ error: 'learning_path_not_found' }, 404)
    const input = parseBoardInput(await c.req.json().catch(() => null), { completionColumn: true })
    if (!input.ok) {
      // An invalid board for someone else's Path or Skill is still reported as not found.
      const owned = await readPersonalBoard(db, target.pathId, target.targetId, c.get('accountId'))
      if (!owned.ok) return c.json({ error: owned.refusal }, 404)
      return c.json({ error: 'invalid_board', detail: input.detail }, 422)
    }
    const result = await savePersonalBoard(db, target.pathId, target.targetId, c.get('accountId'), input.value)
    if (!result.ok) return c.json({ error: result.refusal, detail: result.detail, ...(result.current ? { current: result.current } : {}) }, BOARD_REFUSAL_STATUS[result.refusal])
    return c.json({ changed: result.changed, board: result.board, learningState: result.learningState })
  })

  // Reuse (ADR 0004): the Paths and Versions the Account may copy Skills and Tasks from, its own only.
  app.use('/reuse/*', authenticate)
  app.get('/reuse/sources', async (c) => c.json(await listReuseSources(db, c.get('accountId'))))

  // Coach mode (ADR 0010, 0011): a Coach Workspace and its Paths answer only to the
  // Workspace's owner; every other Account, learners included, finds nothing.
  app.use('/coach/*', authenticate)
  const coachPath = '/coach/learning-paths/:pathId'

  app.get('/coach/workspaces', async (c) => c.json({ workspaces: await coaching.listCoachWorkspaces(db, c.get('accountId')) }))

  app.post('/coach/workspaces', async (c) => {
    const input = coaching.parseWorkspaceInput(await c.req.json().catch(() => null))
    if (!input.ok) return c.json({ error: 'invalid_workspace', detail: input.detail }, 422)
    return c.json({ workspace: await coaching.createCoachWorkspace(db, c.get('accountId'), input.value) }, 201)
  })

  app.get('/coach/workspaces/:workspaceId', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const workspace = UUID.test(workspaceId) ? await coaching.readCoachWorkspace(db, workspaceId, c.get('accountId')) : null
    if (!workspace) return c.json({ error: 'workspace_not_found' }, 404)
    return c.json(workspace)
  })

  app.post('/coach/workspaces/:workspaceId/learning-paths', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    if (!UUID.test(workspaceId)) return c.json({ error: 'workspace_not_found' }, 404)
    const input = authoring.parsePathInput(await c.req.json().catch(() => null))
    // Without ownership there is no Workspace, whatever the body.
    if (!input.ok) {
      if (!await coaching.readCoachWorkspace(db, workspaceId, c.get('accountId'))) return c.json({ error: 'workspace_not_found' }, 404)
      return c.json({ error: 'invalid_learning_path', detail: input.detail }, 422)
    }
    const document = await coaching.createCoachPath(db, workspaceId, c.get('accountId'), input.value)
    if (!document) return c.json({ error: 'workspace_not_found' }, 404)
    return c.json(document, 201)
  })

  app.get(coachPath, async (c) => {
    const pathId = c.req.param('pathId')
    const document = UUID.test(pathId) ? await coaching.readCoachPath(db, pathId, c.get('accountId')) : null
    if (!document) return c.json({ error: 'learning_path_not_found' }, 404)
    return c.json(document)
  })

  app.put(`${coachPath}/draft`, async (c) => {
    const pathId = c.req.param('pathId')
    if (!UUID.test(pathId)) return c.json({ error: 'learning_path_not_found' }, 404)
    const input = authoring.parseDocumentInput(await c.req.json().catch(() => null), 'coach')
    if (!input.ok) {
      if (!await coaching.readCoachPath(db, pathId, c.get('accountId'))) return c.json({ error: 'learning_path_not_found' }, 404)
      return c.json({ error: 'refusal' in input ? input.refusal : 'invalid_document', detail: input.detail }, 422)
    }
    const result = await coaching.saveCoachDraft(db, pathId, c.get('accountId'), input.value)
    if (!result.ok) return c.json({ error: result.refusal, detail: result.detail, ...(result.current ? { current: result.current } : {}) }, DRAFT_REFUSAL_STATUS[result.refusal])
    return c.json(result.document)
  })

  // Archival from the open Draft (ADR 0018): a published Task is not carried into the next Version.
  app.post(`${coachPath}/draft/tasks/:taskId/archive`, async (c) => {
    const pathId = c.req.param('pathId')
    if (!UUID.test(pathId)) return c.json({ error: 'learning_path_not_found' }, 404)
    const taskId = UUID.test(c.req.param('taskId')) ? c.req.param('taskId') : NIL_UUID
    const body: unknown = await c.req.json().catch(() => null)
    const expectedRevision = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).expectedRevision : undefined
    if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      if (!await coaching.readCoachPath(db, pathId, c.get('accountId'))) return c.json({ error: 'learning_path_not_found' }, 404)
      return c.json({ error: 'invalid_request', detail: 'expectedRevision must be a non-negative integer' }, 422)
    }
    const result = await coaching.archiveDraftTask(db, pathId, taskId, c.get('accountId'), expectedRevision)
    if (!result.ok) return c.json({ error: result.refusal, detail: result.detail, ...(result.current ? { current: result.current } : {}) }, ARCHIVE_DRAFT_REFUSAL_STATUS[result.refusal])
    return c.json(result.document)
  })

  app.post(`${coachPath}/draft/skills/:skillId/archive`, async (c) => {
    const pathId = c.req.param('pathId')
    if (!UUID.test(pathId)) return c.json({ error: 'learning_path_not_found' }, 404)
    const skillId = UUID.test(c.req.param('skillId')) ? c.req.param('skillId').toLowerCase() : NIL_UUID
    const body: unknown = await c.req.json().catch(() => null)
    const expectedRevision = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>).expectedRevision : undefined
    if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      if (!await coaching.readCoachPath(db, pathId, c.get('accountId'))) return c.json({ error: 'learning_path_not_found' }, 404)
      return c.json({ error: 'invalid_request', detail: 'expectedRevision must be a non-negative integer' }, 422)
    }
    const result = await coaching.archiveDraftSkill(db, pathId, skillId, c.get('accountId'), expectedRevision)
    if (!result.ok) return c.json({ error: result.refusal, detail: result.detail, ...(result.current ? { current: result.current } : {}) }, result.refusal === 'learning_path_not_found' || result.refusal === 'skill_not_found' ? 404 : 409)
    return c.json(result.document)
  })

  // A Draft Skill's preparation board (ADR 0029): saved whole against its own revision, like a
  // personal board, but its columns have no role and a save writes nothing but the board. The
  // route names the Draft, so a board of a Draft published meanwhile is refused, not redirected.
  const draftBoardRoute = `${coachPath}/drafts/:draftId/skills/:skillId/board`
  const draftBoardTarget = (pathId: string, draftId: string, skillId: string) =>
    UUID.test(pathId) ? { learningPathId: pathId, draftId: UUID.test(draftId) ? draftId.toLowerCase() : NIL_UUID, skillId: UUID.test(skillId) ? skillId.toLowerCase() : NIL_UUID } : null
  app.get(draftBoardRoute, async (c) => {
    const target = draftBoardTarget(c.req.param('pathId'), c.req.param('draftId'), c.req.param('skillId'))
    if (!target) return c.json({ error: 'learning_path_not_found' }, 404)
    const result = await readDraftBoard(db, target, c.get('accountId'))
    if (!result.ok) return c.json({ error: result.refusal, detail: result.detail }, DRAFT_BOARD_REFUSAL_STATUS[result.refusal])
    return c.json({ board: result.board })
  })

  app.put(draftBoardRoute, async (c) => {
    const target = draftBoardTarget(c.req.param('pathId'), c.req.param('draftId'), c.req.param('skillId'))
    if (!target) return c.json({ error: 'learning_path_not_found' }, 404)
    const input = parseBoardInput(await c.req.json().catch(() => null), { completionColumn: false })
    if (!input.ok) {
      // An invalid board for someone else's Path, Draft or Skill is still reported as not found.
      const owned = await readDraftBoard(db, target, c.get('accountId'))
      if (!owned.ok) return c.json({ error: owned.refusal, detail: owned.detail }, DRAFT_BOARD_REFUSAL_STATUS[owned.refusal])
      return c.json({ error: 'invalid_board', detail: input.detail }, 422)
    }
    const result = await saveDraftBoard(db, target, c.get('accountId'), input.value)
    if (!result.ok) return c.json({ error: result.refusal, detail: result.detail, ...(result.current ? { current: result.current } : {}) }, DRAFT_BOARD_REFUSAL_STATUS[result.refusal])
    return c.json({ changed: result.changed, board: result.board })
  })

  // Publication (ADR 0005, 0008): both changes are based on the revision the Coach saw.
  for (const [segment, change, created] of [['publication', coaching.publishDraft, 200], ['drafts', coaching.prepareDraft, 201]] as const) {
    app.post(`${coachPath}/${segment}`, async (c) => {
      const pathId = c.req.param('pathId')
      if (!UUID.test(pathId)) return c.json({ error: 'learning_path_not_found' }, 404)
      const body: unknown = await c.req.json().catch(() => null)
      const expectedRevision = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).expectedRevision : undefined
      if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        if (!await coaching.readCoachPath(db, pathId, c.get('accountId'))) return c.json({ error: 'learning_path_not_found' }, 404)
        return c.json({ error: 'invalid_request', detail: 'expectedRevision must be a non-negative integer' }, 422)
      }
      const result = await change(db, pathId, c.get('accountId'), expectedRevision)
      if (!result.ok) {
        const { ok: _, refusal, ...rest } = result
        return c.json({ error: refusal, ...rest }, PUBLICATION_REFUSAL_STATUS[refusal])
      }
      return c.json(result.document, created)
    })
  }

  app.get('/coach/learning-path-versions/:versionId', async (c) => {
    const versionId = c.req.param('versionId')
    const document = UUID.test(versionId) ? await coaching.readCoachVersion(db, versionId, c.get('accountId')) : null
    if (!document) return c.json({ error: 'version_not_found' }, 404)
    return c.json(document)
  })

  // Admission to one published Version (CONTEXT.md: Enrollment Invitation, Enrollment Closure).
  const versionRoute = '/coach/learning-path-versions/:versionId'

  // A published Version's shared Canvas Layout (ADR 0005, 0016): positions only, for the owning Coach.
  app.put(`${versionRoute}/layout`, async (c) => {
    const versionId = c.req.param('versionId')
    if (!UUID.test(versionId)) return c.json({ error: 'version_not_found' }, 404)
    const input = coaching.parseLayoutInput(await c.req.json().catch(() => null))
    // Without ownership there is no Version, whatever the body.
    if (!input.ok) {
      if (!await coaching.readCoachVersion(db, versionId, c.get('accountId'))) return c.json({ error: 'version_not_found' }, 404)
      return c.json({ error: 'invalid_layout', detail: input.detail }, 422)
    }
    const result = await coaching.saveVersionLayout(db, versionId, c.get('accountId'), input.value)
    if (!result.ok) return c.json({ error: result.refusal, detail: result.detail, ...(result.current ? { current: result.current } : {}) }, LAYOUT_REFUSAL_STATUS[result.refusal])
    return c.json(result.document)
  })

  app.get(`${versionRoute}/invitations`, async (c) => {
    const versionId = c.req.param('versionId')
    const admission = UUID.test(versionId) ? await invitations.listInvitations(db, versionId, c.get('accountId')) : null
    if (!admission) return c.json({ error: 'version_not_found' }, 404)
    return c.json(admission)
  })

  // The Version's learners and the work awaiting the Coach's Review (T23).
  app.get(`${versionRoute}/enrollments`, async (c) => {
    const versionId = c.req.param('versionId')
    const listed = UUID.test(versionId) ? await listVersionEnrollments(db, versionId, c.get('accountId')) : null
    if (!listed) return c.json({ error: 'version_not_found' }, 404)
    return c.json({ enrollments: listed })
  })

  for (const [method, closed] of [['PUT', true], ['DELETE', false]] as const) {
    app.on(method, `${versionRoute}/enrollment-closure`, async (c) => {
      const versionId = c.req.param('versionId')
      if (!UUID.test(versionId)) return c.json({ error: 'version_not_found' }, 404)
      const result = await invitations.setEnrollmentClosure(db, versionId, c.get('accountId'), closed)
      if (!result.ok) return c.json({ error: result.refusal }, INVITATION_REFUSAL_STATUS[result.refusal])
      return c.json({ enrollmentClosed: result.enrollmentClosed, changed: result.changed })
    })
  }

  // The Invitation is stored first and delivered after; a failed or merely logged delivery keeps it for a retry.
  if (delivery) {
    const deliver = async (c: Context<Env>, invitationId: string, created: boolean) => {
      const outcome = await invitations.deliverInvitation(db, invitationId, delivery.send, delivery.link)
      const body = { invitation: outcome.invitation, delivered: outcome.delivered, ...(outcome.error ? { deliveryError: outcome.error } : {}) }
      if (created) return c.json(body, 201)
      if (outcome.delivered) return c.json(body)
      return outcome.notConfigured ? c.json({ error: 'email_not_configured', ...body }, 503) : c.json({ error: 'invitation_delivery_failed', ...body }, 502)
    }

    app.post(`${versionRoute}/invitations`, async (c) => {
      const versionId = c.req.param('versionId')
      if (!UUID.test(versionId)) return c.json({ error: 'version_not_found' }, 404)
      const input = invitations.parseInvitationInput(await c.req.json().catch(() => null))
      if (!input.ok) {
        if (!await invitations.listInvitations(db, versionId, c.get('accountId'))) return c.json({ error: 'version_not_found' }, 404)
        return c.json({ error: 'invalid_invitation', detail: input.detail }, 422)
      }
      const result = await invitations.createInvitation(db, versionId, c.get('accountId'), input.email)
      if (!result.ok) return c.json({ error: result.refusal }, INVITATION_REFUSAL_STATUS[result.refusal])
      return deliver(c, result.invitation.id, true)
    })

    app.post('/coach/invitations/:invitationId/delivery', async (c) => {
      const invitationId = c.req.param('invitationId')
      const owned = UUID.test(invitationId) ? await invitations.ownedInvitation(db, invitationId, c.get('accountId')) : null
      if (!owned) return c.json({ error: 'invitation_not_found' }, 404)
      return deliver(c, invitationId, false)
    })
  }

  app.get('/enrollments/:enrollmentId/learning-state', async (c) => {
    const enrollmentId = c.req.param('enrollmentId')
    const learningState = UUID.test(enrollmentId) ? await readLearningState(db, enrollmentId, c.get('accountId')) : null
    if (!learningState) return c.json({ error: 'enrollment_not_found' }, 404)
    return c.json({ learningState })
  })

  return app
}

/**
 * The served backend: every route under `/api`, behind the same origin as the
 * application, with identity taken only from Better Auth sessions (ADR 0022).
 * The P2 fixture identity is never accepted here.
 */
export function createServer({ db, auth, delivery }: { db: Database; auth: Auth; delivery: InvitationDelivery }) {
  return new Hono().route('/api', createApp({ db, identity: sessionIdentity(auth), auth, delivery }))
}
