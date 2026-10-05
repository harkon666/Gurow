import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { SQL } from 'bun'
import { eq } from 'drizzle-orm'
import { createServer } from '../src/app'
import { createAuth } from '../src/auth'
import type { Database } from '../src/db/client'
import { accounts, enrollmentInvitations, enrollments, learningPathVersions } from '../src/db/schema'
import { invitationEmail, loggingMailer, resendMailer, verificationEmail, type Mailer } from '../src/mail'
import { waitForBlockedBy } from './support/blocking'
import { CookieBrowser } from './support/browser'
import { prepareTestDatabase, resetTestDatabase, TEST_DATABASE_URL } from './support/database'
import { startResendStandIn } from './support/resend-stand-in'

/**
 * T20 (#21): a Coach invites one email to one published Version and controls new
 * Enrollments, through the served backend (Better Auth sessions, ADR 0022) on
 * PostgreSQL. Verification and invitation emails leave through the Resend HTTP mailer
 * (ADR 0023) to a local stand-in of Resend's API; every link a test follows is read
 * from an email the stand-in received.
 */
const ORIGIN = 'http://localhost:3000'
const PASSWORD = 'correct horse battery staple'

let db: Database, close: () => Promise<void>, server: ReturnType<typeof createServer>
let resend: ReturnType<typeof startResendStandIn>
beforeAll(async () => { ({ db, close } = await prepareTestDatabase()) })
afterAll(async () => { await close() })
/** The served backend as `src/index.ts` builds it, sending all email through `mailer`. */
function serve(mailer: Mailer) {
  const auth = createAuth({ db, baseURL: ORIGIN, secret: 'test-secret-with-at-least-32-characters!', sendVerificationEmail: async ({ to, url }) => { await mailer(verificationEmail(to, url)) } })
  return createServer({ db, auth, delivery: { send: (message) => mailer(invitationEmail(message)), link: (id) => `${ORIGIN}/invitations/${id}` } })
}
beforeEach(async () => {
  await resetTestDatabase(db)
  resend = startResendStandIn()
  server = serve(resendMailer({ apiKey: resend.apiKey, from: 'Gurow <invitations@gurow.test>', apiUrl: resend.url }))
})
afterEach(() => resend.stop())

/** A browser for one Account's address, with the invitation actions. */
class Browser extends CookieBrowser {
  constructor(readonly email: string) { super(() => server, ORIGIN) }
  async json(path: string, method = 'GET', body?: unknown) {
    const response = await this.request(`/api${path}`, { method, body })
    return { status: response.status, body: await response.json().catch(() => null) as any }
  }
  /** Follows the verification link the stand-in received for this Account's address. */
  async verify() {
    const link = resend.linkTo(this.email, 'Verify')
    expect(link).not.toBeNull()
    const url = new URL(link!)
    await this.request(url.pathname + url.search)
    expect((await this.json('/account')).body.account.emailVerified).toBe(true)
  }
  accept(invitationId: string) { return this.json(`/invitations/${invitationId}/accept`, 'POST') }
}

async function signUp(email: string, { verified = true } = {}) {
  const browser = new Browser(email)
  expect((await browser.request('/api/auth/sign-up/email', { method: 'POST', body: { email, password: PASSWORD, name: email.split('@')[0] } })).status).toBe(200)
  if (verified) await browser.verify()
  return browser
}

/** A published Version: one required Skill with one Required Task worth 10 XP. */
async function publishedPath(coach: Browser, workspaceId: string, title: string) {
  const created = (await coach.json(`/coach/workspaces/${workspaceId}/learning-paths`, 'POST', { title, goal: `${title} goal` })).body
  const skillId = crypto.randomUUID(), taskId = crypto.randomUUID()
  const saved = await coach.json(`/coach/learning-paths/${created.learningPath.id}/draft`, 'PUT', {
    expectedRevision: created.learningPath.revision, title, goal: `${title} goal`,
    editor: { format_version: 1, cards: [{ id: skillId, title: 'Vectors', position: { x: 0, y: 0 } }], connections: [] },
    application: { skills: [{ id: skillId, title: 'Vectors', outcome: 'Add vectors', optional: false, xpThreshold: 0, tasks: [{ id: taskId, title: 'Drills', description: '', required: true, xpReward: 10 }] }] },
  })
  expect(saved.status).toBe(200)
  const published = await coach.json(`/coach/learning-paths/${created.learningPath.id}/publication`, 'POST', { expectedRevision: saved.body.learningPath.revision })
  expect(published.status).toBe(200)
  return { pathId: created.learningPath.id as string, versionId: published.body.version.id as string, revision: published.body.learningPath.revision as number, skillId, taskId }
}

async function coachWithPaths() {
  const coach = await signUp('carla@gurow.test')
  const workspace = (await coach.json('/coach/workspaces', 'POST', { name: 'Linear Algebra Studio' })).body.workspace
  const algebra = await publishedPath(coach, workspace.id, 'Linear Algebra')
  const calculus = await publishedPath(coach, workspace.id, 'Calculus')
  return { coach, workspace, algebra, calculus }
}

const invite = (coach: Browser, versionId: string, email: string) => coach.json(`/coach/learning-path-versions/${versionId}/invitations`, 'POST', { email })
const enrollmentRows = () => db.select().from(enrollments)
const invitationRow = async (id: string) => (await db.select().from(enrollmentInvitations).where(eq(enrollmentInvitations.id, id)))[0]
const invitationIdFromEmail = (to: string) => new URL(resend.linkTo(to, 'You are invited')!).pathname.split('/').at(-1)!

describe('AC1: a Coach invites one email to one published Version, delivered through Resend', () => {
  it('stores the Invitation, delivers its link through the Resend API, and lists it for the Coach', async () => {
    const { coach, algebra } = await coachWithPaths()
    const created = await invite(coach, algebra.versionId, '  Lena@Gurow.test ')
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ delivered: true, invitation: { learningPathVersionId: algebra.versionId, email: 'Lena@Gurow.test', acceptedAt: null, delivery: { status: 'sent', attempts: 1 } } })
    const invitationId = created.body.invitation.id

    const email = resend.sent.at(-1)!
    expect(email).toMatchObject({ from: 'Gurow <invitations@gurow.test>', to: ['Lena@Gurow.test'], subject: 'You are invited to Linear Algebra on Gurow', idempotencyKey: `enrollment-invitation/${invitationId}/1` })
    expect(email.text).toContain('Linear Algebra (Version 1) in Linear Algebra Studio')
    expect(resend.linkTo('lena@gurow.test', 'You are invited')).toBe(`${ORIGIN}/invitations/${invitationId}`)
    expect(email.html).toContain(`href="${ORIGIN}/invitations/${invitationId}"`)

    const stored = await invitationRow(invitationId)
    expect(stored).toMatchObject({ learningPathVersionId: algebra.versionId, deliveryStatus: 'sent', deliveryAttempts: 1, acceptedAt: null })
    expect(stored.deliveredAt).not.toBeNull()
    const listed = await coach.json(`/coach/learning-path-versions/${algebra.versionId}/invitations`)
    expect(listed).toMatchObject({ status: 200, body: { enrollmentClosed: false, invitations: [{ id: invitationId, email: 'Lena@Gurow.test' }] } })
  })

  it('refuses an invalid address, an unpublished Draft, and anyone but the owning Coach without storing or sending anything', async () => {
    const { coach, algebra } = await coachWithPaths()
    const other = await signUp('otto@gurow.test')
    const sentBefore = resend.sent.length
    for (const email of ['', 'not an email', 'two@a.test, three@b.test', 42, `${'x'.repeat(250)}@a.test`]) {
      expect(await invite(coach, algebra.versionId, email as string)).toMatchObject({ status: 422, body: { error: 'invalid_invitation' } })
    }
    const draft = await coach.json(`/coach/learning-paths/${algebra.pathId}/drafts`, 'POST', { expectedRevision: algebra.revision })
    expect(await invite(coach, draft.body.draft.id, 'lena@gurow.test')).toMatchObject({ status: 409, body: { error: 'version_not_published' } })
    for (const body of ['lena@gurow.test', 'not an email']) expect((await invite(other, algebra.versionId, body)).status).toBe(404)
    expect((await other.json(`/coach/learning-path-versions/${algebra.versionId}/invitations`)).status).toBe(404)
    expect((await new Browser('anonymous').json(`/coach/learning-path-versions/${algebra.versionId}/invitations`, 'POST', { email: 'lena@gurow.test' })).status).toBe(401)
    expect(await db.select().from(enrollmentInvitations)).toEqual([])
    expect(resend.sent.length).toBe(sentBefore)
  })
})

describe('AC2: only the verified matching Account accepts, into the offered Version only', () => {
  it('follows the emailed link from sign-up through verification to an Enrollment in that Version alone', async () => {
    const { coach, algebra, calculus } = await coachWithPaths()
    await invite(coach, algebra.versionId, 'Lena@Gurow.test')
    const invitationId = invitationIdFromEmail('lena@gurow.test')

    // Signed up with the invited address in another case, not yet verified: refused, nothing disclosed.
    const lena = await signUp('lena@gurow.test', { verified: false })
    expect(await lena.json(`/invitations/${invitationId}`)).toEqual({ status: 403, body: { error: 'email_not_verified' } })
    expect(await lena.accept(invitationId)).toEqual({ status: 403, body: { error: 'email_not_verified' } })
    expect(await enrollmentRows()).toEqual([])
    expect((await invitationRow(invitationId)).acceptedAt).toBeNull()

    await lena.verify()
    const read = await lena.json(`/invitations/${invitationId}`)
    expect(read).toEqual({ status: 200, body: { offer: { invitationId, learningPathVersionId: algebra.versionId, learningPathTitle: 'Linear Algebra', versionNumber: 1, coachWorkspaceName: 'Linear Algebra Studio' }, enrollment: null } })
    const accepted = await lena.accept(invitationId)
    expect(accepted).toMatchObject({ status: 201, body: { created: true, enrollment: { learningPathVersionId: algebra.versionId, status: 'active' }, offer: { versionNumber: 1 } } })
    const [account] = await db.select().from(accounts).where(eq(accounts.email, 'lena@gurow.test'))
    expect((await enrollmentRows()).map((e) => [e.accountId, e.learningPathVersionId])).toEqual([[account.id, algebra.versionId]])
    expect((await enrollmentRows()).some((e) => e.learningPathVersionId === calculus.versionId)).toBe(false)
    expect((await invitationRow(invitationId)).acceptedAt).not.toBeNull()
    expect((await lena.json(`/invitations/${invitationId}`)).body.enrollment).toEqual({ id: accepted.body.enrollment.id, status: 'active' })

    // A later Version of the same Path is not joined either.
    const prepared = await coach.json(`/coach/learning-paths/${algebra.pathId}/drafts`, 'POST', { expectedRevision: algebra.revision })
    expect((await coach.json(`/coach/learning-paths/${algebra.pathId}/publication`, 'POST', { expectedRevision: prepared.body.learningPath.revision })).status).toBe(200)
    expect((await enrollmentRows()).map((e) => e.learningPathVersionId)).toEqual([algebra.versionId])
  })

  it('refuses an unrelated verified Account, an anonymous request and an unknown Invitation without enrolling or disclosing the offer', async () => {
    const { coach, algebra } = await coachWithPaths()
    const { body } = await invite(coach, algebra.versionId, 'lena@gurow.test')
    const unrelated = await signUp('mallory@gurow.test')
    expect(await unrelated.json(`/invitations/${body.invitation.id}`)).toEqual({ status: 403, body: { error: 'email_mismatch' } })
    expect(await unrelated.accept(body.invitation.id)).toEqual({ status: 403, body: { error: 'email_mismatch' } })
    expect((await new Browser('anonymous').accept(body.invitation.id)).status).toBe(401)
    expect(await unrelated.accept(crypto.randomUUID())).toEqual({ status: 404, body: { error: 'invitation_not_found' } })
    expect(await unrelated.accept('not-a-uuid')).toEqual({ status: 404, body: { error: 'invitation_not_found' } })
    expect(await enrollmentRows()).toEqual([])
    expect((await invitationRow(body.invitation.id)).acceptedAt).toBeNull()
  })

  it('has no expiry: an Invitation created long ago is still accepted', async () => {
    const { coach, algebra } = await coachWithPaths()
    const { body } = await invite(coach, algebra.versionId, 'lena@gurow.test')
    await db.update(enrollmentInvitations).set({ createdAt: new Date('2000-01-01T00:00:00Z'), deliveredAt: new Date('2000-01-01T00:00:00Z') }).where(eq(enrollmentInvitations.id, body.invitation.id))
    const lena = await signUp('lena@gurow.test')
    expect((await lena.accept(body.invitation.id)).status).toBe(201)
  })
})

describe('AC3: repeated acceptance reuses the Enrollment; inactive stays inactive; the owner cannot enroll', () => {
  it('keeps one Enrollment and its progress across repeated acceptance and further Invitations, and never reactivates it', async () => {
    const { coach, algebra } = await coachWithPaths()
    const lena = await signUp('lena@gurow.test')
    const first = (await invite(coach, algebra.versionId, 'lena@gurow.test')).body.invitation.id
    const { body: { enrollment } } = await lena.accept(first)

    // Progress: an approved revision awards the Task's 10 XP and Mastery.
    const taskRoute = `/enrollments/${enrollment.id}/tasks/${algebra.taskId}`
    expect((await lena.json(`${taskRoute}/start`, 'POST')).status).toBe(201)
    const sent = await lena.json(`${taskRoute}/submission/revisions`, 'POST', { text: 'My drills', urls: [] })
    expect(sent.status).toBe(201)
    expect((await coach.json(`${taskRoute}/submission/revisions/${sent.body.revision.id}/review`, 'POST', { decision: 'approval' })).status).toBe(201)
    const progress = (await lena.json(`/enrollments/${enrollment.id}/learning-state`)).body.learningState
    expect(progress.xp).toBe(10)

    expect(await lena.accept(first)).toMatchObject({ status: 200, body: { created: false, enrollment: { id: enrollment.id, status: 'active' } } })
    const second = (await invite(coach, algebra.versionId, 'LENA@gurow.test')).body.invitation.id
    expect(await lena.accept(second)).toMatchObject({ status: 200, body: { created: false, enrollment: { id: enrollment.id } } })
    expect((await lena.json(`/enrollments/${enrollment.id}/learning-state`)).body.learningState).toEqual(progress)

    expect((await lena.json(`/enrollments/${enrollment.id}/deactivate`, 'POST', {})).status).toBe(200)
    const third = (await invite(coach, algebra.versionId, 'lena@gurow.test')).body.invitation.id
    for (const id of [first, third]) {
      expect(await lena.accept(id)).toMatchObject({ status: 200, body: { created: false, enrollment: { id: enrollment.id, status: 'inactive' } } })
    }
    expect((await enrollmentRows()).map((e) => [e.id, e.status])).toEqual([[enrollment.id, 'inactive']])
    expect((await lena.json(`/enrollments/${enrollment.id}/learning-state`)).body.learningState.xp).toBe(10)
  })

  it('converges competing acceptances on one Enrollment', async () => {
    const { coach, algebra } = await coachWithPaths()
    const lena = await signUp('lena@gurow.test')
    const id = (await invite(coach, algebra.versionId, 'lena@gurow.test')).body.invitation.id
    const results = await Promise.all(Array.from({ length: 5 }, () => lena.accept(id)))
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201])
    expect(new Set(results.map((r) => r.body.enrollment.id)).size).toBe(1)
    expect(await enrollmentRows()).toHaveLength(1)
  })

  it('refuses the Coach Workspace owner an Enrollment even with an Invitation to their own verified email', async () => {
    const { coach, algebra } = await coachWithPaths()
    const { body } = await invite(coach, algebra.versionId, 'carla@gurow.test')
    expect(body.delivered).toBe(true)
    expect(await coach.accept(invitationIdFromEmail('carla@gurow.test'))).toEqual({ status: 403, body: { error: 'owner_cannot_enroll' } })
    expect(await enrollmentRows()).toEqual([])
    expect((await invitationRow(body.invitation.id)).acceptedAt).toBeNull()
  })
})

describe('AC4: Enrollment Closure blocks new Enrollments only; reopening admits again', () => {
  const closure = (coach: Browser, versionId: string, closed: boolean) => coach.json(`/coach/learning-path-versions/${versionId}/enrollment-closure`, closed ? 'PUT' : 'DELETE')

  it('refuses pending Invitations while closed, keeps existing Enrollments as they are, and admits again after reopening', async () => {
    const { coach, algebra, calculus } = await coachWithPaths()
    const [active, inactive, pending] = await Promise.all(['ana@gurow.test', 'ian@gurow.test', 'pia@gurow.test'].map((email) => signUp(email)))
    const ids = Object.fromEntries(await Promise.all([['ana', 'ana@gurow.test'], ['ian', 'ian@gurow.test'], ['pia', 'pia@gurow.test']]
      .map(async ([name, email]) => [name, (await invite(coach, algebra.versionId, email)).body.invitation.id])))
    const anaEnrollment = (await active.accept(ids.ana)).body.enrollment
    const ianEnrollment = (await inactive.accept(ids.ian)).body.enrollment
    expect((await coach.json(`/enrollments/${ianEnrollment.id}/deactivate`, 'POST', { reason: 'Paused.' })).status).toBe(200)
    const versionBefore = (await coach.json(`/coach/learning-path-versions/${algebra.versionId}`)).body

    expect(await closure(coach, algebra.versionId, true)).toEqual({ status: 200, body: { enrollmentClosed: true, changed: true } })
    expect(await closure(coach, algebra.versionId, true)).toEqual({ status: 200, body: { enrollmentClosed: true, changed: false } })
    expect(await pending.accept(ids.pia)).toEqual({ status: 409, body: { error: 'enrollment_closed' } })
    expect((await invitationRow(ids.pia)).acceptedAt).toBeNull()
    // Invitations can still be sent while closed; they just cannot admit.
    const late = await invite(coach, algebra.versionId, 'pia@gurow.test')
    expect(late).toMatchObject({ status: 201, body: { delivered: true } })
    expect(await pending.accept(late.body.invitation.id)).toEqual({ status: 409, body: { error: 'enrollment_closed' } })
    expect(await active.accept(ids.ana)).toMatchObject({ status: 200, body: { created: false, enrollment: { id: anaEnrollment.id, status: 'active' } } })
    expect(await inactive.accept(ids.ian)).toMatchObject({ status: 200, body: { created: false, enrollment: { id: ianEnrollment.id, status: 'inactive' } } })
    const byId = async () => Object.fromEntries((await enrollmentRows()).map((e) => [e.id, e.status]))
    expect(await byId()).toEqual({ [anaEnrollment.id]: 'active', [ianEnrollment.id]: 'inactive' })
    // Active participation continues while closed.
    expect((await active.json(`/enrollments/${anaEnrollment.id}/tasks/${algebra.taskId}/start`, 'POST')).status).toBe(201)

    // Closure is per Version and does not touch its content.
    expect((await coach.json(`/coach/learning-path-versions/${algebra.versionId}/invitations`)).body.enrollmentClosed).toBe(true)
    expect((await coach.json(`/coach/learning-path-versions/${calculus.versionId}/invitations`)).body.enrollmentClosed).toBe(false)
    const versionClosed = (await coach.json(`/coach/learning-path-versions/${algebra.versionId}`)).body
    expect({ ...versionClosed, versions: undefined }).toEqual({ ...versionBefore, versions: undefined })
    expect(versionClosed.versions.find((v: any) => v.id === algebra.versionId).enrollmentClosed).toBe(true)

    expect(await closure(coach, algebra.versionId, false)).toEqual({ status: 200, body: { enrollmentClosed: false, changed: true } })
    expect(await pending.accept(ids.pia)).toMatchObject({ status: 201, body: { created: true } })
    expect(await byId()).toMatchObject({ [anaEnrollment.id]: 'active', [ianEnrollment.id]: 'inactive' })
    expect(await enrollmentRows()).toHaveLength(3)
  })

  it('answers only the owning Coach and only for a published Version', async () => {
    const { coach, algebra } = await coachWithPaths()
    const others = [await signUp('otto@gurow.test'), await signUp('lena@gurow.test')]
    for (const other of others) for (const closed of [true, false]) expect((await closure(other, algebra.versionId, closed)).status).toBe(404)
    expect((await closure(new Browser('anonymous'), algebra.versionId, true)).status).toBe(401)
    const draft = await coach.json(`/coach/learning-paths/${algebra.pathId}/drafts`, 'POST', { expectedRevision: algebra.revision })
    expect(await closure(coach, draft.body.draft.id, true)).toEqual({ status: 409, body: { error: 'version_not_published' } })
    expect((await db.select().from(learningPathVersions)).every((v) => v.enrollmentClosedAt === null)).toBe(true)
  })

  /**
   * Holds `hold` in a transaction on a separate connection, starts `request`, and
   * requires PostgreSQL to report it waiting on that transaction before committing.
   * A request that finishes without waiting fails at once; the connection is always closed.
   */
  async function whileHeld<T>(hold: (tx: Bun.ReservedSQL) => Promise<unknown>, request: () => Promise<T>) {
    const other = new SQL({ url: TEST_DATABASE_URL, max: 1 })
    const reserved = await other.reserve()
    let committed = false
    try {
      await reserved`begin`
      const [{ pid }] = await reserved`select pg_backend_pid() as pid`
      await hold(reserved)
      const pending = request()
      const first = await Promise.race([waitForBlockedBy(db, pid).then(() => 'waited'), pending.then(() => 'finished without waiting')])
      expect(first).toBe('waited')
      await reserved`commit`
      committed = true
      return await pending
    } finally {
      if (!committed) await reserved`rollback`.catch(() => {})
      reserved.release()
      await other.close()
    }
  }

  it('orders a closure and an acceptance by the Version row: an acceptance waiting on a closure is refused', async () => {
    const { coach, algebra } = await coachWithPaths()
    const lena = await signUp('lena@gurow.test')
    const id = (await invite(coach, algebra.versionId, 'lena@gurow.test')).body.invitation.id
    const accepted = await whileHeld((tx) => tx`update learning_path_versions set enrollment_closed_at = now() where id = ${algebra.versionId}`, () => lena.accept(id))
    expect(accepted).toEqual({ status: 409, body: { error: 'enrollment_closed' } })
    expect(await enrollmentRows()).toEqual([])
  })

  it('orders a closure after an acceptance in progress: the closure waits for the Version lock an acceptance holds', async () => {
    const { coach, algebra } = await coachWithPaths()
    // What an acceptance holds while it admits: the Version FOR SHARE.
    const closed = await whileHeld((tx) => tx`select id from learning_path_versions where id = ${algebra.versionId} for share`, () => closure(coach, algebra.versionId, true))
    expect(closed).toEqual({ status: 200, body: { enrollmentClosed: true, changed: true } })
  })
})

describe('AC6: delivery failures and retries', () => {
  it('keeps an undelivered Invitation, retries it with a new attempt, and reports a failed retry', async () => {
    const { coach, algebra } = await coachWithPaths()
    resend.fail(500)
    const created = await invite(coach, algebra.versionId, 'lena@gurow.test')
    expect(created).toMatchObject({ status: 201, body: { delivered: false, invitation: { delivery: { status: 'failed', attempts: 1, deliveredAt: null } } } })
    expect(created.body.deliveryError).toContain('Resend refused the email (500)')
    const id = created.body.invitation.id
    expect(resend.linkTo('lena@gurow.test', 'You are invited')).toBeNull()

    const failedAgain = await coach.json(`/coach/invitations/${id}/delivery`, 'POST')
    expect(failedAgain).toMatchObject({ status: 502, body: { error: 'invitation_delivery_failed', delivered: false, invitation: { delivery: { status: 'failed', attempts: 2 } } } })

    resend.fail(null)
    const retried = await coach.json(`/coach/invitations/${id}/delivery`, 'POST')
    expect(retried).toMatchObject({ status: 200, body: { delivered: true, invitation: { id, delivery: { status: 'sent', attempts: 3 } } } })
    expect(resend.sent.filter((e) => e.subject.startsWith('You are invited')).map((e) => e.idempotencyKey)).toEqual([`enrollment-invitation/${id}/3`])
    expect(invitationIdFromEmail('lena@gurow.test')).toBe(id)
    expect((await db.select().from(enrollmentInvitations))).toHaveLength(1)

    const lena = await signUp('lena@gurow.test')
    expect((await lena.accept(id)).status).toBe(201)
    // Sending an accepted Invitation again is harmless: acceptance still reuses the Enrollment.
    expect((await coach.json(`/coach/invitations/${id}/delivery`, 'POST')).status).toBe(200)
    expect(await lena.accept(id)).toMatchObject({ status: 200, body: { created: false } })
  })

  it('lets only the owning Coach send an Invitation again', async () => {
    const { coach, algebra } = await coachWithPaths()
    const id = (await invite(coach, algebra.versionId, 'lena@gurow.test')).body.invitation.id
    const sentBefore = resend.sent.length
    for (const other of [await signUp('otto@gurow.test'), await signUp('lena@gurow.test')]) {
      expect(await other.json(`/coach/invitations/${id}/delivery`, 'POST')).toEqual({ status: 404, body: { error: 'invitation_not_found' } })
    }
    expect(resend.sent.length).toBe(sentBefore + 2) // only the two verification emails
    expect((await invitationRow(id)).deliveryAttempts).toBe(1)
  })

  it('never reports an email as sent when no provider is configured: the link is only logged', async () => {
    const { coach, algebra } = await coachWithPaths()
    // The served default without RESEND_API_KEY (src/index.ts): the logging mailer.
    server = serve(loggingMailer)
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const sentBefore = resend.sent.length
      const created = await invite(coach, algebra.versionId, 'lena@gurow.test')
      expect(created).toMatchObject({ status: 201, body: { delivered: false, invitation: { delivery: { status: 'logged', attempts: 1, deliveredAt: null } } } })
      expect(created.body.deliveryError).toContain('no email provider is configured')
      const id = created.body.invitation.id
      expect(log.mock.calls.map((call) => call[0])).toEqual([`[gurow] enrollment invitation for lena@gurow.test: ${ORIGIN}/invitations/${id}`])

      const again = await coach.json(`/coach/invitations/${id}/delivery`, 'POST')
      expect(again).toMatchObject({ status: 503, body: { error: 'email_not_configured', delivered: false, invitation: { delivery: { status: 'logged', attempts: 2, deliveredAt: null } } } })
      expect((await coach.json(`/coach/learning-path-versions/${algebra.versionId}/invitations`)).body.invitations[0].delivery).toEqual({ status: 'logged', attempts: 2, deliveredAt: null })
      expect(await invitationRow(id)).toMatchObject({ deliveryStatus: 'logged', deliveredAt: null })
      expect(resend.sent.length).toBe(sentBefore)
    } finally {
      log.mockRestore()
    }
  })

  it('reports an unreachable provider as a failed delivery', async () => {
    const { coach, algebra } = await coachWithPaths()
    resend.stop()
    const created = await invite(coach, algebra.versionId, 'lena@gurow.test')
    expect(created).toMatchObject({ status: 201, body: { delivered: false, invitation: { delivery: { status: 'failed' } } } })
    expect(created.body.deliveryError).toContain('Resend could not be reached')
  })
})

