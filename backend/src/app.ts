import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Database } from './db/client'
import { acceptInvitation, readEnrollment, type EnrollmentRefusal } from './enrollments'
import type { IdentityResolver } from './identity'
import { readDraft, readSubmission, saveDraft, sendRevision, type SubmissionContents, type SubmissionRefusal } from './submissions'

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

const MAX_TEXT_LENGTH = 50_000
const MAX_URLS = 20
const MAX_URL_LENGTH = 2_048

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

/** The backend request interface; identity comes only from the injected resolver. */
export function createApp({ db, identity }: { db: Database; identity: IdentityResolver }) {
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
  app.use('/invitations/*', authenticate)
  app.use('/enrollments/*', authenticate)

  app.post('/invitations/:invitationId/accept', async (c) => {
    const invitationId = c.req.param('invitationId')
    if (!UUID.test(invitationId)) return c.json({ error: 'invitation_not_found' }, 404)
    const result = await acceptInvitation(db, invitationId, c.get('accountId'))
    if (!result.ok) return c.json({ error: result.refusal }, REFUSAL_STATUS[result.refusal])
    return c.json({ enrollment: result.enrollment, created: result.created }, result.created ? 201 : 200)
  })

  app.get('/enrollments/:enrollmentId', async (c) => {
    const enrollmentId = c.req.param('enrollmentId')
    const enrollment = UUID.test(enrollmentId) ? await readEnrollment(db, enrollmentId, c.get('accountId')) : null
    if (!enrollment) return c.json({ error: 'enrollment_not_found' }, 404)
    return c.json({ enrollment })
  })

  // Drafts and Submissions of one Task in one Enrollment (ADR 0002).
  const taskRoute = '/enrollments/:enrollmentId/tasks/:taskId'
  const taskParams = ({ enrollmentId, taskId }: { enrollmentId: string; taskId: string }) =>
    UUID.test(enrollmentId) && UUID.test(taskId) ? { enrollmentId, taskId } : null
  const contents = async (c: { req: { json: () => Promise<unknown> } }) => parseContents(await c.req.json().catch(() => null))

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

  return app
}
