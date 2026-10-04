import { afterAll, beforeAll, beforeEach, expect, it } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'
import { createApp } from '../src/app'
import { createDatabase, type Database } from '../src/db/client'
import { enrollments, skills, tasks, submissionReviews, versionPrerequisites, versionSkills, versionTasks } from '../src/db/schema'
import { FIXTURE_IDENTITY_HEADER, fixtureIdentity } from '../src/identity'
import { waitForBlockedBy } from './support/blocking'
import { prepareTestDatabase, resetTestDatabase, TEST_DATABASE_URL } from './support/database'
import { seedEnrollmentFixture, type EnrollmentFixture } from './support/fixtures'

let db: Database
let close: () => Promise<void>
let fx: EnrollmentFixture
let app: ReturnType<typeof createApp>
let enrollmentId: string
beforeAll(async () => { ({ db, close } = await prepareTestDatabase()) })
afterAll(async () => { await close() })
beforeEach(async () => {
  await resetTestDatabase(db)
  fx = await seedEnrollmentFixture(db)
  app = createApp({ db, identity: fixtureIdentity(fx.identities) })
  const accepted = await request(`/invitations/${fx.invitations.toLearner.id}/accept`, 'learner', 'POST')
  enrollmentId = (await accepted.json() as any).enrollment.id
  await db.update(versionTasks).set({ xpReward: 20 }).where(and(eq(versionTasks.learningPathVersionId, fx.versions.version1.id), eq(versionTasks.taskId, fx.content.taskA.id)))
  await db.update(versionSkills).set({ xpThreshold: 20 }).where(and(eq(versionSkills.learningPathVersionId, fx.versions.version1.id), eq(versionSkills.skillId, fx.content.skillB.id)))
  await db.insert(versionPrerequisites).values({ learningPathVersionId: fx.versions.version1.id, prerequisiteSkillId: fx.content.skillA.id, skillId: fx.content.skillB.id })
})
type Actor = keyof EnrollmentFixture['identities'] | null
async function request(path: string, actor: Actor = 'learner', method = 'GET', body?: unknown) {
  return app.request(path, { method, headers: { ...(actor ? { [FIXTURE_IDENTITY_HEADER]: actor } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
}
const path = (task = fx.content.taskA.id, enrollment = enrollmentId) => `/enrollments/${enrollment}/tasks/${task}/submission`
const send = (task = fx.content.taskA.id, enrollment = enrollmentId) => request(`${path(task, enrollment)}/revisions`, 'learner', 'POST', { text: 'Evidence', urls: [] })
async function revision(task = fx.content.taskA.id, enrollment = enrollmentId) {
  const res = await send(task, enrollment)
  expect(res.status).toBe(201)
  return (await res.json() as any).revision.id as string
}
const decide = (id: string, body: unknown = { decision: 'approval' }, actor: Actor = 'coach', task = fx.content.taskA.id, enrollment = enrollmentId) => request(`${path(task, enrollment)}/revisions/${id}/review`, actor, 'POST', body)
async function state(actor: Actor = 'learner', enrollment = enrollmentId) {
  const res = await request(`/enrollments/${enrollment}/learning-state`, actor)
  expect(res.status).toBe(200)
  return (await res.json() as any).learningState
}
const skill = (s: any, id: string) => s.skills.find((x: any) => x.skillId === id)

it('AC1/AC7: only owning Coach decides; scoped reads and foreign/mismatched IDs hide records', async () => {
  const id = await revision()
  for (const actor of ['learner', 'peer', 'unrelated', 'otherCoach', null] as const) {
    expect((await decide(id, { decision: 'approval' }, actor)).status).toBe(actor === 'learner' ? 403 : actor === null ? 401 : 404)
  }
  for (const actor of ['peer', 'unrelated', 'otherCoach', null] as const) {
    expect((await request(`/enrollments/${enrollmentId}/learning-state`, actor)).status).toBe(actor === null ? 401 : 404)
  }
  const peerResponse = await request(`/invitations/${fx.invitations.toPeer.id}/accept`, 'peer', 'POST')
  const peerId = (await peerResponse.json() as any).enrollment.id
  expect((await decide(id, { decision: 'approval' }, 'coach', fx.content.taskA.id, peerId)).status).toBe(404)
  expect((await decide(id, { decision: 'approval' }, 'coach', fx.content.taskAReading.id)).status).toBe(404)
  const [outside] = await db.insert(tasks).values({ skillId: fx.content.skillA.id }).returning()
  await db.insert(versionTasks).values({ learningPathVersionId: fx.versions.version2.id, taskId: outside.id, skillId: fx.content.skillA.id, title: 'Other Version', required: true })
  expect((await decide(id, { decision: 'approval' }, 'coach', outside.id)).status).toBe(404)
  expect((await decide(crypto.randomUUID())).status).toBe(404)
  expect((await decide('invalid')).status).toBe(404)
  expect((await request('/enrollments/invalid/learning-state')).status).toBe(404)
  expect(await db.select().from(submissionReviews)).toHaveLength(0)
  expect((await state('coach')).xp).toBe(0)
})

it('AC1/AC7: Changes Requested requires valid feedback and preserves readable exact history', async () => {
  const id = await revision()
  for (const body of [null, {}, { decision: 'reject' }, { decision: 'changes_requested' }, { decision: 'changes_requested', feedback: ' \n\t' }, { decision: 'approval', feedback: 2 }, { decision: 'approval', feedback: 'x'.repeat(50001) }]) {
    expect((await decide(id, body)).status).toBe(422)
  }
  expect(await db.select().from(submissionReviews)).toHaveLength(0)
  const feedback = '  Please explain the calculation.  '
  expect((await decide(id, { decision: 'changes_requested', feedback })).status).toBe(201)
  expect((await state()).xp).toBe(0)
  const next = await revision()
  for (const actor of ['learner', 'coach'] as const) {
    const history = (await (await request(path(), actor)).json() as any).submission.revisions
    expect(history.map((r: any) => [r.id, r.status, r.supersededAt])).toEqual([[id, 'changes_requested', null], [next, 'pending', null]])
    expect(history[0].review).toMatchObject({ revisionId: id, feedback, coachAccountId: fx.accounts.coach.id })
    expect(history[1]).not.toHaveProperty('review')
  }
  expect((await decide(id)).status).toBe(409)
})

it('AC1/AC7: superseded pending revisions reject without any progress effect', async () => {
  const old = await revision()
  const current = await revision()
  expect((await decide(old)).status).toBe(409)
  expect((await state()).xp).toBe(0)
  expect(await db.select().from(submissionReviews)).toHaveLength(0)
  expect((await decide(current)).status).toBe(201)
  expect((await state()).xp).toBe(20)
})

it('AC3/AC6: repeated decisions reject; additional approved revisions contribute once without inheritance', async () => {
  const first = await revision()
  expect((await decide(first)).status).toBe(201)
  for (const body of [{ decision: 'approval' }, { decision: 'changes_requested', feedback: 'Overwrite' }]) expect((await decide(first, body)).status).toBe(409)
  const next = await revision()
  const history = (await (await request(path())).json() as any).submission.revisions
  expect(history.map((r: any) => r.status)).toEqual(['approval', 'pending'])
  expect(history[1]).not.toHaveProperty('review')
  expect((await state()).xp).toBe(20)
  expect((await decide(next)).status).toBe(201)
  expect((await state()).xp).toBe(20)
  expect(await db.select().from(submissionReviews)).toHaveLength(2)
})

async function extraSkill(required: boolean | null) {
  const [s] = await db.insert(skills).values({ learningPathId: fx.paths.path.id }).returning()
  await db.insert(versionSkills).values({ learningPathVersionId: fx.versions.version1.id, skillId: s.id, title: 'Extra', learningOutcome: 'Extra outcome' })
  if (required === null) return { skillId: s.id, taskId: null }
  const [t] = await db.insert(tasks).values({ skillId: s.id }).returning()
  await db.insert(versionTasks).values({ learningPathVersionId: fx.versions.version1.id, taskId: t.id, skillId: s.id, title: 'Extra task', required, xpReward: 5 })
  return { skillId: s.id, taskId: t.id }
}

it('AC2: every Required Task qualifies, enrichment never blocks, empty/enrichment-only never master', async () => {
  const empty = await extraSkill(null)
  const enrichment = await extraSkill(false)
  const [second] = await db.insert(tasks).values({ skillId: fx.content.skillA.id }).returning()
  await db.insert(versionTasks).values({ learningPathVersionId: fx.versions.version1.id, taskId: second.id, skillId: fx.content.skillA.id, title: 'Second required', required: true, xpReward: 7 })
  expect((await decide(await revision())).status).toBe(201)
  expect(skill(await state(), fx.content.skillA.id).mastery).toBe(false)
  expect((await decide(await revision(enrichment.taskId!), { decision: 'approval' }, 'coach', enrichment.taskId!)).status).toBe(201)
  expect((await decide(await revision(second.id), { decision: 'approval' }, 'coach', second.id)).status).toBe(201)
  const s = await state()
  expect(skill(s, fx.content.skillA.id).mastery).toBe(true)
  expect(s.tasks.find((t: any) => t.taskId === fx.content.taskAReading.id).approved).toBe(false)
  expect(skill(s, empty.skillId).mastery).toBe(false)
  expect(skill(s, enrichment.skillId).mastery).toBe(false)
  expect(s.xp).toBe(32)
})

it('AC5: ALL multi-prerequisites and XP gates apply identically to progress and sends', async () => {
  const c = await extraSkill(true)
  await db.insert(versionPrerequisites).values({ learningPathVersionId: fx.versions.version1.id, prerequisiteSkillId: c.skillId, skillId: fx.content.skillB.id })
  expect((await decide(await revision())).status).toBe(201)
  expect(skill(await state(), fx.content.skillB.id)).toMatchObject({ access: false, unmetPrerequisiteSkillIds: [c.skillId], xpShortfall: 0 })
  expect((await send(fx.content.taskB.id)).status).toBe(403)
  expect((await decide(await revision(c.taskId!), { decision: 'approval' }, 'coach', c.taskId!)).status).toBe(201)
  expect(skill(await state(), fx.content.skillB.id).access).toBe(true)
  expect((await send(fx.content.taskB.id)).status).toBe(201)
})

it('AC5: XP-only threshold remains locked until distinct approved rewards reach it', async () => {
  await db.delete(versionPrerequisites).where(eq(versionPrerequisites.learningPathVersionId, fx.versions.version1.id))
  await db.update(versionSkills).set({ xpThreshold: 40 }).where(and(eq(versionSkills.learningPathVersionId, fx.versions.version1.id), eq(versionSkills.skillId, fx.content.skillB.id)))
  await db.update(versionTasks).set({ xpReward: 20 }).where(and(eq(versionTasks.learningPathVersionId, fx.versions.version1.id), eq(versionTasks.taskId, fx.content.taskAReading.id)))
  expect((await decide(await revision())).status).toBe(201)
  expect((await decide(await revision())).status).toBe(201)
  expect(skill(await state(), fx.content.skillB.id)).toMatchObject({ access: false, unmetPrerequisiteSkillIds: [], xpShortfall: 20 })
  expect((await send(fx.content.taskB.id)).status).toBe(403)
  const reading = await revision(fx.content.taskAReading.id)
  expect((await decide(reading, { decision: 'approval' }, 'coach', fx.content.taskAReading.id)).status).toBe(201)
  expect((await state()).xp).toBe(40)
  expect(skill(await state(), fx.content.skillB.id).access).toBe(true)
  expect((await send(fx.content.taskB.id)).status).toBe(201)
  expect((await state()).xp).toBe(40)
})

it('AC5: same Account other Version and peer XP never transfer; pinned rewards stay local', async () => {
  const [other] = await db.insert(enrollments).values({ accountId: fx.accounts.learner.id, learningPathVersionId: fx.versions.version2.id }).returning()
  await db.update(versionTasks).set({ xpReward: 200 }).where(eq(versionTasks.learningPathVersionId, fx.versions.version2.id))
  const id = await revision(fx.content.taskA.id, other.id)
  expect((await decide(id, { decision: 'approval' }, 'coach', fx.content.taskA.id, other.id)).status).toBe(201)
  expect((await state('learner', other.id)).xp).toBe(200)
  const peerAccepted = await request(`/invitations/${fx.invitations.toPeer.id}/accept`, 'peer', 'POST')
  const peerId = (await peerAccepted.json() as any).enrollment.id
  const peerSent = await request(`${path(fx.content.taskA.id, peerId)}/revisions`, 'peer', 'POST', { text: 'Peer evidence' })
  expect(peerSent.status).toBe(201)
  const peerRevision = (await peerSent.json() as any).revision.id
  expect((await decide(peerRevision, { decision: 'approval' }, 'coach', fx.content.taskA.id, peerId)).status).toBe(201)
  expect((await state('peer', peerId)).xp).toBe(20)
  const local = await state()
  expect(local.xp).toBe(0)
  expect(skill(local, fx.content.skillA.id).mastery).toBe(false)
  expect(skill(local, fx.content.skillB.id).access).toBe(false)
  expect((await send(fx.content.taskB.id)).status).toBe(403)
  expect((await decide(await revision())).status).toBe(201)
  expect((await state()).xp).toBe(20)
})

for (const loss of ['xp', 'mastery', 'inactive'] as const) it(`AC6: prior eligible work remains reviewable after ${loss} loss`, async () => {
  const a = await revision()
  expect((await decide(a)).status).toBe(201)
  const b = await revision(fx.content.taskB.id)
  // T10/T12 fault injection only; not a lifecycle/revocation API claim.
  await db.transaction(async (tx) => {
    await tx.select().from(enrollments).where(eq(enrollments.id, enrollmentId)).for('update')
    if (loss === 'inactive') await tx.update(enrollments).set({ status: 'inactive' }).where(eq(enrollments.id, enrollmentId))
    else {
      if (loss === 'mastery') await tx.update(versionSkills).set({ xpThreshold: 0 }).where(and(eq(versionSkills.learningPathVersionId, fx.versions.version1.id), eq(versionSkills.skillId, fx.content.skillB.id)))
      if (loss === 'xp') await tx.delete(versionPrerequisites).where(eq(versionPrerequisites.learningPathVersionId, fx.versions.version1.id))
      await tx.update(submissionReviews).set({ revokedAt: new Date(), revocationReason: 'Test correction' }).where(eq(submissionReviews.revisionId, a))
    }
  })
  expect(skill(await state(), fx.content.skillB.id).access).toBe(false)
  expect((await send(fx.content.taskB.id)).status).toBe(403)
  expect((await decide(b, { decision: 'approval' }, 'coach', fx.content.taskB.id)).status).toBe(201)
  for (const actor of ['learner', 'coach'] as const) expect(skill(await state(actor), fx.content.skillB.id)).toMatchObject({ access: false, mastery: true })
})

it('AC7: competing decisions commit exactly one terminal decision and one reward', async () => {
  const id = await revision()
  const responses = await Promise.all([decide(id), decide(id)])
  expect(responses.map((r) => r.status).sort()).toEqual([201, 409])
  expect(await db.select().from(submissionReviews)).toHaveLength(1)
  expect((await state()).xp).toBe(20)
})


/** Pause a real request inside its INSERT after it has locked the Enrollment.
 * Observe actual PostgreSQL wait edges before starting/releasing competing work.
 * This tests route ordering rather than relying on request-start timing.
 */
async function orderedRequests(table: 'submission_reviews' | 'submission_revisions', first: () => Promise<Response>, second: () => Promise<Response>) {
  const other = createDatabase(TEST_DATABASE_URL, 1)
  let release!: () => void
  let ready!: (pid: number) => void
  const barrier = new Promise<void>((resolve) => { release = resolve })
  const locked = new Promise<number>((resolve) => { ready = resolve })
  await db.execute(sql`create function test_pause_insert() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(91009); return NEW; end $$`)
  await db.execute(sql`create trigger test_pause_insert before insert on ${sql.raw(table)} for each row execute function test_pause_insert()`)
  const locker = other.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(91009)`)
    const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
    ready(row.pid)
    await barrier
  })
  let pendingFirst: Promise<Response> | undefined
  let pendingSecond: Promise<Response> | undefined
  try {
    const pid = await locked
    pendingFirst = first()
    const firstPid = await waitForBlockedBy(db, pid)
    pendingSecond = second()
    await waitForBlockedBy(db, firstPid)
    release()
    await locker
    return await Promise.all([pendingFirst, pendingSecond])
  } finally {
    release()
    await locker
    await Promise.allSettled([pendingFirst, pendingSecond].filter((p) => p !== undefined))
    await db.execute(sql`drop trigger test_pause_insert on ${sql.raw(table)}`)
    await db.execute(sql`drop function test_pause_insert()`)
    await other.close()
  }
}

it('AC7: review-before-send retains Approval and the new revision stays pending', async () => {
  const id = await revision()
  const [review, sent] = await orderedRequests('submission_reviews', () => decide(id), () => send())
  expect([review.status, sent.status]).toEqual([201, 201])
  const history = (await (await request(path())).json() as any).submission.revisions
  expect(history.map((r: any) => [r.status, r.supersededAt])).toEqual([['approval', null], ['pending', null]])
  expect((await state()).xp).toBe(20)
})

it('AC7: send-before-review rejects the superseded pending target', async () => {
  const id = await revision()
  const [sent, review] = await orderedRequests('submission_revisions', () => send(), () => decide(id))
  expect([sent.status, review.status]).toEqual([201, 409])
  expect(await db.select().from(submissionReviews)).toHaveLength(0)
  expect((await state()).xp).toBe(0)
})

it('AC7: progress read waits for review commit and returns a coherent derived snapshot', async () => {
  const id = await revision()
  const [review, read] = await orderedRequests('submission_reviews', () => decide(id), () => request(`/enrollments/${enrollmentId}/learning-state`))
  expect([review.status, read.status]).toEqual([201, 200])
  const s = (await read.json() as any).learningState
  expect(s.xp).toBe(20)
  expect(skill(s, fx.content.skillA.id).mastery).toBe(true)
  expect(skill(s, fx.content.skillB.id).access).toBe(true)
  expect(s.tasks.find((t: any) => t.taskId === fx.content.taskA.id).xpContribution).toBe(20)
})

it('AC7: failed review INSERT rolls back; a later successful request durably commits', async () => {
  const id = await revision()
  await db.execute(sql`create function test_fail_review() returns trigger language plpgsql as $$ begin raise exception 'test review storage failure'; end $$`)
  await db.execute(sql`create trigger test_fail_review after insert on submission_reviews for each row execute function test_fail_review()`)
  try {
    expect((await decide(id)).status).toBe(500)
    expect(await db.select().from(submissionReviews)).toHaveLength(0)
    expect((await state()).xp).toBe(0)
    expect((await (await request(path())).json() as any).submission.revisions[0].status).toBe('pending')
  } finally {
    await db.execute(sql`drop trigger test_fail_review on submission_reviews`)
    await db.execute(sql`drop function test_fail_review()`)
  }
  expect((await decide(id)).status).toBe(201)
  expect((await state()).xp).toBe(20)
})

it('AC4: reference Approval persists 20 XP, masters A and opens B without spending XP', async () => {
  const before = await state()
  expect(before.xp).toBe(0)
  expect(skill(before, fx.content.skillA.id)).toMatchObject({ mastery: false, access: true })
  expect(skill(before, fx.content.skillB.id)).toMatchObject({ mastery: false, access: false, unmetPrerequisiteSkillIds: [fx.content.skillA.id], xpShortfall: 20 })
  expect((await send(fx.content.taskB.id)).status).toBe(403)
  const id = await revision()
  expect((await decide(id)).status).toBe(201)
  const other = createDatabase(TEST_DATABASE_URL)
  try {
    const fresh = createApp({ db: other.db, identity: fixtureIdentity(fx.identities) })
    const s = (await (await fresh.request(`/enrollments/${enrollmentId}/learning-state`, { headers: { [FIXTURE_IDENTITY_HEADER]: 'learner' } })).json() as any).learningState
    expect(s.xp).toBe(20)
    expect(s.tasks.find((t: any) => t.taskId === fx.content.taskA.id)).toMatchObject({ approved: true, xpContribution: 20 })
    expect(skill(s, fx.content.skillA.id).mastery).toBe(true)
    expect(skill(s, fx.content.skillB.id).access).toBe(true)
    expect(await other.db.select().from(submissionReviews)).toEqual([expect.objectContaining({ revisionId: id, coachAccountId: fx.accounts.coach.id, decision: 'approval' })])
  } finally { await other.close() }
  expect((await send(fx.content.taskB.id)).status).toBe(201)
  expect((await send(fx.content.taskB.id)).status).toBe(201)
  expect((await state()).xp).toBe(20)
})
