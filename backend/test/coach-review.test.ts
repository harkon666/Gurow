import { afterAll, beforeAll, beforeEach, expect, it } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { createApp } from '../src/app'
import type { Database } from '../src/db/client'
import { learningPathVersions, versionPrerequisites, versionSkills, versionTasks } from '../src/db/schema'
import { FIXTURE_IDENTITY_HEADER, fixtureIdentity } from '../src/identity'
import { prepareTestDatabase, resetTestDatabase } from './support/database'
import { amendPublished, seedEnrollmentFixture, type EnrollmentFixture } from './support/fixtures'

/**
 * T23 (#24): the owning Coach finds the work awaiting Review. A published Version lists
 * its Enrollments, each with its revisions awaiting a decision, and an Enrollment's
 * learning state lists its own. Awaiting means sent, not superseded and not decided;
 * work sent with valid Access stays listed after Access or activity is lost (ADR 0007).
 * Nobody but the owner of the Version's Coach Workspace sees the list (ADR 0013).
 *
 * Fixture Version 1: Vectors (A) with a 20-XP Required Task; Matrices (B) requires
 * Mastery of A and 20 XP.
 */
let db: Database, close: () => Promise<void>, fx: EnrollmentFixture, app: ReturnType<typeof createApp>, enrollmentId: string, peerEnrollmentId: string
beforeAll(async () => { ({ db, close } = await prepareTestDatabase()) })
afterAll(async () => { await close() })
beforeEach(async () => {
  await resetTestDatabase(db)
  fx = await seedEnrollmentFixture(db)
  app = createApp({ db, identity: fixtureIdentity(fx.identities) })
  const v1 = fx.versions.version1.id
  await amendPublished(db, async (tx) => {
    await tx.update(versionTasks).set({ xpReward: 20 }).where(and(eq(versionTasks.learningPathVersionId, v1), eq(versionTasks.taskId, fx.content.taskA.id)))
    await tx.update(versionSkills).set({ xpThreshold: 20 }).where(and(eq(versionSkills.learningPathVersionId, v1), eq(versionSkills.skillId, fx.content.skillB.id)))
    await tx.insert(versionPrerequisites).values({ learningPathVersionId: v1, prerequisiteSkillId: fx.content.skillA.id, skillId: fx.content.skillB.id })
  })
  enrollmentId = (await json(request(`/invitations/${fx.invitations.toLearner.id}/accept`, 'learner', 'POST'), 201)).enrollment.id
  peerEnrollmentId = (await json(request(`/invitations/${fx.invitations.toPeer.id}/accept`, 'peer', 'POST'), 201)).enrollment.id
})

type Actor = keyof EnrollmentFixture['identities'] | null
async function request(path: string, actor: Actor = 'learner', method = 'GET', body?: unknown) {
  return app.request(path, { method, headers: { ...(actor ? { [FIXTURE_IDENTITY_HEADER]: actor } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
}
async function json(response: Response | Promise<Response>, status: number) {
  const r = await response
  const body = await r.json().catch(() => null) as any
  expect({ status: r.status, body }).toMatchObject({ status })
  return body
}
const listing = (actor: Actor = 'coach', versionId = fx.versions.version1.id) => request(`/coach/learning-path-versions/${versionId}/enrollments`, actor)
const listed = async (id = enrollmentId) => (await json(listing(), 200)).enrollments.find((e: any) => e.id === id)
const awaitingInState = async (actor: Actor = 'learner', id = enrollmentId) => (await json(request(`/enrollments/${id}/learning-state`, actor), 200)).learningState.awaitingReview
const taskPath = (task: string, id = enrollmentId) => `/enrollments/${id}/tasks/${task}/submission`
async function send(task = fx.content.taskA.id, actor: Actor = 'learner', id = enrollmentId) {
  return (await json(request(`${taskPath(task, id)}/revisions`, actor, 'POST', { text: 'My evidence', urls: [] }), 201)).revision as { id: string; revisionNumber: number; sentAt: string }
}
const decide = (revision: string, body: unknown = { decision: 'approval' }, task = fx.content.taskA.id, id = enrollmentId) =>
  request(`${taskPath(task, id)}/revisions/${revision}/review`, 'coach', 'POST', body)

it('lists the Version\'s Enrollments with their learners for the owning Coach only', async () => {
  const body = await json(listing(), 200)
  expect(body.enrollments).toEqual([
    { id: enrollmentId, status: 'active', createdAt: expect.any(String), learner: { name: '', email: 'Learner@Gurow.test' }, awaitingReview: [] },
    { id: peerEnrollmentId, status: 'active', createdAt: expect.any(String), learner: { name: '', email: 'peer@gurow.test' }, awaitingReview: [] },
  ])
  // The Enrollment's page names its learner, for the Coach and the learner alike.
  for (const actor of ['coach', 'learner'] as const) {
    expect((await json(request(`/enrollments/${enrollmentId}/version`, actor), 200)).learner).toEqual({ name: '', email: 'Learner@Gurow.test' })
  }
  await send()
  // Learners, peers, another Workspace's Coach and unrelated Accounts are told the Version does not exist.
  for (const actor of ['learner', 'peer', 'unrelated', 'otherCoach', null] as const) {
    const response = await listing(actor)
    expect({ actor, status: response.status }).toEqual({ actor, status: actor === null ? 401 : 404 })
    if (actor) expect(await response.json()).toEqual({ error: 'version_not_found' })
  }
  // Another Version lists only its own Enrollments; unknown, malformed and unpublished Versions are not found.
  expect((await json(listing('coach', fx.versions.version2.id), 200)).enrollments).toEqual([])
  const [draft] = await db.insert(learningPathVersions).values({ learningPathId: fx.paths.path.id, versionNumber: 3, title: 'Linear Algebra' }).returning()
  for (const versionId of [draft.id, crypto.randomUUID(), 'not-a-uuid']) expect((await listing('coach', versionId)).status).toBe(404)
})

it('lists exactly the revisions awaiting a decision, in the Version list and the Enrollment\'s learning state', async () => {
  const first = await send()
  const expected = (revision: typeof first) => [{ taskId: fx.content.taskA.id, revisionId: revision.id, revisionNumber: revision.revisionNumber, sentAt: revision.sentAt }]
  expect((await listed()).awaitingReview).toEqual(expected(first))
  expect(await awaitingInState('learner')).toEqual(expected(first))
  expect(await awaitingInState('coach')).toEqual(expected(first))
  expect((await listed(peerEnrollmentId)).awaitingReview).toEqual([])

  // A newer revision supersedes the undecided one: only the newer is awaiting.
  const second = await send()
  expect((await listed()).awaitingReview).toEqual(expected(second))
  expect((await decide(first.id)).status).toBe(409)
  expect((await listed()).awaitingReview).toEqual(expected(second))

  // Both decisions end the wait.
  expect((await decide(second.id, { decision: 'changes_requested', feedback: 'Show the steps.' })).status).toBe(201)
  expect((await listed()).awaitingReview).toEqual([])
  const third = await send()
  expect(await awaitingInState('coach')).toEqual(expected(third))
  expect((await decide(third.id)).status).toBe(201)
  expect((await listed()).awaitingReview).toEqual([])
  expect(await awaitingInState('learner')).toEqual([])

  // A revision sent after an Approval awaits its own Review.
  const fourth = await send()
  expect((await listed()).awaitingReview).toEqual(expected(fourth))
})

it('keeps work sent with valid Access awaiting Review after the Skill locks and the Enrollment is deactivated', async () => {
  const vectors = await send()
  expect((await decide(vectors.id)).status).toBe(201)
  const matrices = await send(fx.content.taskB.id)
  // Revoking the only Vectors Approval locks Matrices; its revision still awaits Review.
  expect((await request(`${taskPath(fx.content.taskA.id)}/revisions/${vectors.id}/review/revoke`, 'coach', 'POST', { reason: 'Graded the wrong file.' })).status).toBe(200)
  const state = (await json(request(`/enrollments/${enrollmentId}/learning-state`, 'coach'), 200)).learningState
  expect(state.skills.find((s: any) => s.skillId === fx.content.skillB.id).access).toBe(false)
  expect(state.awaitingReview.map((r: any) => r.revisionId)).toEqual([matrices.id])
  expect((await json(request(`/enrollments/${enrollmentId}/deactivate`, 'coach', 'POST', { reason: 'Paused.' }), 200)))
  const entry = await listed()
  expect(entry.status).toBe('inactive')
  expect(entry.awaitingReview.map((r: any) => r.revisionId)).toEqual([matrices.id])
  expect((await decide(matrices.id, { decision: 'approval' }, fx.content.taskB.id)).status).toBe(201)
  expect((await listed()).awaitingReview).toEqual([])
})
