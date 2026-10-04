import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Database } from './db/client'
import { acceptInvitation, readEnrollment, type EnrollmentRefusal } from './enrollments'
import type { IdentityResolver } from './identity'

const REFUSAL_STATUS: Record<EnrollmentRefusal, ContentfulStatusCode> = {
  invitation_not_found: 404,
  enrollment_not_found: 404,
  email_not_verified: 403,
  email_mismatch: 403,
  owner_cannot_enroll: 403,
  version_not_published: 409,
  enrollment_closed: 409,
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

  return app
}
