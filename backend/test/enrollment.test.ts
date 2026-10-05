import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { asc, eq } from 'drizzle-orm'
import { createApp, createServer } from '../src/app'
import { createAuth } from '../src/auth'
import type { Database } from '../src/db/client'
import { enrollmentInvitations, enrollments, learningPathVersions, skills, versionSkills, versionTasks } from '../src/db/schema'
import { FIXTURE_IDENTITY_HEADER, fixtureIdentity } from '../src/identity'
import { prepareTestDatabase, resetTestDatabase } from './support/database'
import { seedEnrollmentFixture, type EnrollmentFixture } from './support/fixtures'

// Request-level tests against real PostgreSQL (SPEC testing decisions 1 and 10).
let db: Database
let close: () => Promise<void>
let fx: EnrollmentFixture
let app: ReturnType<typeof createApp>

beforeAll(async () => { ({ db, close } = await prepareTestDatabase()) })
afterAll(async () => { await close() })
beforeEach(async () => {
  await resetTestDatabase(db)
  fx = await seedEnrollmentFixture(db)
  app = createApp({ db, identity: fixtureIdentity(fx.identities) })
})

type Actor = keyof EnrollmentFixture['identities']
const as = (actor: Actor | null): Record<string, string> => (actor ? { [FIXTURE_IDENTITY_HEADER]: actor } : {})
const accept = (invitationId: string, actor: Actor | null) =>
  app.request(`/invitations/${invitationId}/accept`, { method: 'POST', headers: as(actor) })
const read = (enrollmentId: string, actor: Actor | null) =>
  app.request(`/enrollments/${enrollmentId}`, { headers: as(actor) })
const storedEnrollments = () => db.select().from(enrollments)
/** Published learning content of a Version, read back from the database. */
async function versionContent(versionId: string) {
  const skillRows = await db.select({ skillId: versionSkills.skillId, title: versionSkills.title, learningOutcome: versionSkills.learningOutcome, learningPathId: skills.learningPathId })
    .from(versionSkills).innerJoin(skills, eq(skills.id, versionSkills.skillId))
    .where(eq(versionSkills.learningPathVersionId, versionId)).orderBy(asc(versionSkills.title))
  const taskRows = await db.select({ taskId: versionTasks.taskId, skillId: versionTasks.skillId, title: versionTasks.title, required: versionTasks.required })
    .from(versionTasks).where(eq(versionTasks.learningPathVersionId, versionId)).orderBy(asc(versionTasks.title))
  return { skills: skillRows, tasks: taskRows }
}
const acceptedAt = async (invitationId: string) =>
  (await db.select().from(enrollmentInvitations).where(eq(enrollmentInvitations.id, invitationId)))[0].acceptedAt

describe('AC1: controlled fixture identity', () => {
  it('identifies Accounts, one owning Workspace, published content and a single-Version invitation to a verified email', async () => {
    expect(fx.workspaces.workspace.ownerAccountId).toBe(fx.accounts.coach.id)
    expect(fx.versions.version1.publishedAt).not.toBeNull()
    expect(fx.invitations.toLearner.learningPathVersionId).toBe(fx.versions.version1.id)
    expect(fx.accounts.learner.emailVerified).toBe(true)

    // The offered Version holds learning content of its own Path.
    const { skillA, skillB, taskA, taskAReading, taskB } = fx.content
    const content = await versionContent(fx.versions.version1.id)
    expect(content.skills).toEqual([
      { skillId: skillB.id, title: 'Matrices', learningOutcome: 'Multiply matrices and interpret them as linear maps', learningPathId: fx.paths.path.id },
      { skillId: skillA.id, title: 'Vectors', learningOutcome: 'Add and scale vectors in R^n', learningPathId: fx.paths.path.id },
    ])
    expect(content.tasks).toEqual([
      { taskId: taskB.id, skillId: skillB.id, title: 'Matrix exercises', required: true },
      { taskId: taskAReading.id, skillId: skillA.id, title: 'Read chapter 1', required: false },
      { taskId: taskA.id, skillId: skillA.id, title: 'Vector exercises', required: true },
    ])
    // Version 2 redefines the same logical Skills; definitions stay version-specific.
    const revised = await versionContent(fx.versions.version2.id)
    expect(revised.skills.map((s) => [s.skillId, s.title])).toEqual([[skillB.id, 'Matrices (revised)'], [skillA.id, 'Vectors (revised)']])
  })

  it('rejects a Task definition under a Skill that does not own the Task', async () => {
    const { skillA, skillB, taskA } = fx.content
    const [draft] = await db.insert(learningPathVersions).values({ learningPathId: fx.paths.path.id, versionNumber: 3, title: 'Linear Algebra' }).returning()
    await db.insert(versionSkills).values([skillA, skillB].map((skill) => ({ learningPathVersionId: draft.id, skillId: skill.id, title: 'S', learningOutcome: 'O' })))
    const error = await db.insert(versionTasks)
      .values({ learningPathVersionId: draft.id, taskId: taskA.id, skillId: skillB.id, title: 'Wrong Skill', required: true })
      .then(() => null, (e: unknown) => e)
    expect(String((error as { cause?: unknown })?.cause ?? error)).toContain('version_tasks_task_id_skill_id_tasks_id_skill_id_fk')
  })

  it('is not production authentication: the production resolver ignores the fixture header', async () => {
    const auth = createAuth({ db, baseURL: 'http://localhost:3000', secret: 'test-secret-with-at-least-32-characters!', sendVerificationEmail: async () => {} })
    const production = createServer({ db, auth })
    const res = await production.request(`/api/invitations/${fx.invitations.toLearner.id}/accept`, { method: 'POST', headers: as('learner') })
    expect(res.status).toBe(401)
    expect(await storedEnrollments()).toHaveLength(0)
    expect((await accept(fx.invitations.toLearner.id, null)).status).toBe(401)
  })
})

describe('AC2: eligible acceptance', () => {
  it('persists one active Enrollment pinned to the offered Version and joins no other Path or Version', async () => {
    const res = await accept(fx.invitations.toLearner.id, 'learner')
    expect(res.status).toBe(201)
    const body = await res.json() as any
    expect(body.created).toBe(true)
    expect(body.enrollment).toMatchObject({ accountId: fx.accounts.learner.id, learningPathVersionId: fx.versions.version1.id, status: 'active' })

    const stored = await storedEnrollments()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ id: body.enrollment.id, accountId: fx.accounts.learner.id, learningPathVersionId: fx.versions.version1.id })
    // Pinned to the Version whose published content the learner will follow, not to Version 2's.
    const pinned = await versionContent(stored[0].learningPathVersionId)
    expect(pinned.skills.map((s) => s.title)).toEqual(['Matrices', 'Vectors'])
    expect(pinned.tasks.filter((t) => t.required).map((t) => t.title)).toEqual(['Matrix exercises', 'Vector exercises'])
    expect(await acceptedAt(fx.invitations.toLearner.id)).not.toBeNull()
  })
})

describe('AC3: repeated and competing acceptance', () => {
  it('returns the same Enrollment for the same and a second invitation to that Version without resetting it', async () => {
    const first = await (await accept(fx.invitations.toLearner.id, 'learner')).json() as any
    const firstAcceptedAt = await acceptedAt(fx.invitations.toLearner.id)
    const again = await accept(fx.invitations.toLearner.id, 'learner')
    const viaSecond = await accept(fx.invitations.toLearnerAgain.id, 'learner')

    expect(again.status).toBe(200)
    expect(viaSecond.status).toBe(200)
    for (const res of [again, viaSecond]) {
      const body = await res.json() as any
      expect(body).toMatchObject({ created: false, enrollment: { id: first.enrollment.id, createdAt: first.enrollment.createdAt, status: 'active' } })
    }
    // One Enrollment is one XP context (ADR 0007): no second row, no new identity.
    expect(await storedEnrollments()).toHaveLength(1)
    expect(await acceptedAt(fx.invitations.toLearner.id)).toEqual(firstAcceptedAt)
  })

  it('does not reactivate an inactive Enrollment', async () => {
    const first = await (await accept(fx.invitations.toLearner.id, 'learner')).json() as any
    await db.update(enrollments).set({ status: 'inactive' }).where(eq(enrollments.id, first.enrollment.id))
    const res = await accept(fx.invitations.toLearnerAgain.id, 'learner')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ created: false, enrollment: { id: first.enrollment.id, status: 'inactive' } })
    expect((await storedEnrollments())[0].status).toBe('inactive')
  })

  it('returns an existing Enrollment after the Version closes to new Enrollments', async () => {
    const first = await (await accept(fx.invitations.toLearner.id, 'learner')).json() as any
    await db.update(learningPathVersions).set({ enrollmentClosedAt: new Date() }).where(eq(learningPathVersions.id, fx.versions.version1.id))
    const res = await accept(fx.invitations.toLearnerAgain.id, 'learner')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ created: false, enrollment: { id: first.enrollment.id, status: 'active' } })
  })

  it('converges competing acceptances on one Enrollment', async () => {
    const invitations = [fx.invitations.toLearner.id, fx.invitations.toLearnerAgain.id]
    const responses = await Promise.all(Array.from({ length: 24 }, (_, i) => accept(invitations[i % 2], 'learner')))
    const bodies = await Promise.all(responses.map((r) => r.json() as Promise<any>))
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1)
    expect(responses.every((r) => r.status === 201 || r.status === 200)).toBe(true)
    expect(new Set(bodies.map((b) => b.enrollment.id)).size).toBe(1)
    expect(await storedEnrollments()).toHaveLength(1)
  })
})

describe('AC4: eligibility enforced at the backend boundary', () => {
  const refused = async (invitationId: string, actor: Actor, status: number, error: string) => {
    const res = await accept(invitationId, actor)
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ error })
    // A refusal leaves no Enrollment and no recorded acceptance.
    expect(await storedEnrollments()).toHaveLength(0)
    expect(await acceptedAt(invitationId)).toBeNull()
  }

  it('requires a verified email', () => refused(fx.invitations.toUnverified.id, 'unverified', 403, 'email_not_verified'))
  it('requires the invited email', () => refused(fx.invitations.toLearner.id, 'peer', 403, 'email_mismatch'))
  it('forbids the Workspace owner from enrolling in their own Workspace', () => refused(fx.invitations.toOwner.id, 'coach', 403, 'owner_cannot_enroll'))
  it('creates no Enrollment while the Version is closed to new Enrollments', () => refused(fx.invitations.toLearnerClosed.id, 'learner', 409, 'enrollment_closed'))

  it('rejects an unknown or malformed invitation', async () => {
    expect((await accept('00000000-0000-4000-8000-000000000000', 'learner')).status).toBe(404)
    expect((await accept('not-a-uuid', 'learner')).status).toBe(404)
  })
})

describe('AC5: Enrollment visibility', () => {
  it('lets only the learner and the owning Coach read it', async () => {
    const { enrollment } = await (await accept(fx.invitations.toLearner.id, 'learner')).json() as any
    await accept(fx.invitations.toPeer.id, 'peer')

    for (const actor of ['learner', 'coach'] as const) {
      const res = await read(enrollment.id, actor)
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({
        enrollment: { id: enrollment.id, accountId: fx.accounts.learner.id, learningPathVersionId: fx.versions.version1.id, coachWorkspaceId: fx.workspaces.workspace.id },
      })
    }
    // Peer in the same Version, unrelated Account and another Workspace's Coach get the same answer as an unknown ID.
    for (const actor of ['peer', 'unrelated', 'otherCoach'] as const) {
      const res = await read(enrollment.id, actor)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'enrollment_not_found' })
    }
    expect((await read(enrollment.id, null)).status).toBe(401)
    expect((await read('00000000-0000-4000-8000-000000000000', 'coach')).status).toBe(404)
  })
})
