import { afterAll, beforeAll, beforeEach, expect, it } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'
import { createApp } from '../src/app'
import { createDatabase, type Database } from '../src/db/client'
import { enrollments, masteryEvents, submissionReviews, tasks, xpEvents, versionPrerequisites, versionSkills, versionTasks } from '../src/db/schema'
import { FIXTURE_IDENTITY_HEADER, fixtureIdentity } from '../src/identity'
import { waitForBlockedBy } from './support/blocking'
import { prepareTestDatabase, resetTestDatabase, TEST_DATABASE_URL } from './support/database'
import { amendPublished, seedEnrollmentFixture, type EnrollmentFixture } from './support/fixtures'
let db: Database, close: () => Promise<void>, fx: EnrollmentFixture, app: ReturnType<typeof createApp>, enrollmentId: string
beforeAll(async () => { ({ db, close } = await prepareTestDatabase()) })
afterAll(async () => { await close() })
beforeEach(async () => {
  await resetTestDatabase(db)
  fx = await seedEnrollmentFixture(db)
  app = createApp({ db, identity: fixtureIdentity(fx.identities) })
  enrollmentId = (await (await request(`/invitations/${fx.invitations.toLearner.id}/accept`, 'learner', 'POST')).json() as any).enrollment.id
  await amendPublished(db, (tx) => tx.update(versionTasks).set({ xpReward: 20 }).where(and(eq(versionTasks.learningPathVersionId, fx.versions.version1.id), eq(versionTasks.taskId, fx.content.taskA.id))))
  await amendPublished(db, (tx) => tx.update(versionSkills).set({ xpThreshold: 20 }).where(and(eq(versionSkills.learningPathVersionId, fx.versions.version1.id), eq(versionSkills.skillId, fx.content.skillB.id))))
  await amendPublished(db, (tx) => tx.insert(versionPrerequisites).values({ learningPathVersionId: fx.versions.version1.id, prerequisiteSkillId: fx.content.skillA.id, skillId: fx.content.skillB.id }))
})
type Actor = keyof EnrollmentFixture['identities'] | null
async function request(path: string, actor: Actor = 'learner', method = 'GET', body?: unknown) {
  return app.request(path, { method, headers: { ...(actor ? { [FIXTURE_IDENTITY_HEADER]: actor } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
}
const path = (task = fx.content.taskA.id, enrollment = enrollmentId) => `/enrollments/${enrollment}/tasks/${task}/submission`
async function send(task = fx.content.taskA.id, enrollment = enrollmentId, actor: Actor = 'learner') {
  const response = await request(`${path(task, enrollment)}/revisions`, actor, 'POST', { text: 'Evidence' })
  expect(response.status).toBe(201)
  return (await response.json() as any).revision.id as string
}
const approve = (id: string, task = fx.content.taskA.id, enrollment = enrollmentId) => request(`${path(task, enrollment)}/revisions/${id}/review`, 'coach', 'POST', { decision: 'approval' })
const revoke = (id: string, body: unknown = { reason: 'Assessment correction' }, actor: Actor = 'coach', task = fx.content.taskA.id, enrollment = enrollmentId) => request(`${path(task, enrollment)}/revisions/${id}/review/revoke`, actor, 'POST', body)
async function state(actor: Actor = 'learner', enrollment = enrollmentId) {
  const response = await request(`/enrollments/${enrollment}/learning-state`, actor)
  expect(response.status).toBe(200)
  return (await response.json() as any).learningState
}
const skill = (s: any, id: string) => s.skills.find((x: any) => x.skillId === id)
it('AC1/2/3: last Approval revocation preserves decision and records XP/Mastery history', async () => {
  const id = await send()
  expect((await request(`${path()}/revisions/${id}/review`, 'coach', 'POST', { decision: 'approval', feedback: 'Original assessment' })).status).toBe(201)
  const originalRevision = (await (await request(path())).json() as any).submission.revisions[0]
  const before = await state()
  expect(before.xp).toBe(20)
  expect(skill(before, fx.content.skillA.id).mastery).toBe(true)
  expect((await revoke(id)).status).toBe(200)
  const after = await state()
  expect(after.xp).toBe(0)
  expect(skill(after, fx.content.skillA.id).mastery).toBe(false)
  expect(after.xpHistory.map((e: any) => [e.kind, e.amount])).toEqual([['award', 20], ['correction', -20]])
  expect(after.masteryHistory.map((e: any) => e.action)).toEqual(['award', 'revocation'])
  const history = (await (await request(path())).json() as any).submission.revisions
  expect(history[0].review).toMatchObject({ decision: 'approval', revocationReason: 'Assessment correction', revokedByAccountId: fx.accounts.coach.id })
  expect(history[0].review.revokedAt).not.toBeNull()
  expect(history[0].review.feedback).toBe(originalRevision.review.feedback)
  expect(history[0].review.decidedAt).toBe(originalRevision.review.decidedAt)
  for (const field of ['text', 'urls', 'sentAt', 'revisionNumber']) expect(history[0][field]).toEqual(originalRevision[field])
  expect(await state('coach')).toEqual(after)
})

it('AC2/3/5: multiple Approvals retain contribution and Mastery; final removal and restoration occur once', async () => {
  const first = await send()
  expect((await approve(first)).status).toBe(201)
  const second = await send()
  expect((await approve(second)).status).toBe(201)
  const before = await state()
  expect((await revoke(first)).status).toBe(200)
  const retained = await state()
  expect(retained).toEqual(before)
  expect((await revoke(first)).status).toBe(409)
  const competing = await Promise.all([revoke(second), revoke(second)])
  expect(competing.map((r) => r.status).sort()).toEqual([200, 409])
  const removed = await state()
  expect(removed.xp).toBe(0)
  expect(removed.xpHistory.map((e: any) => e.amount)).toEqual([20, -20])
  const third = await send()
  expect((await approve(third)).status).toBe(201)
  const fourth = await send()
  expect((await approve(fourth)).status).toBe(201)
  const restored = await state()
  expect(restored.xp).toBe(20)
  expect(restored.xpHistory.map((e: any) => [e.kind, e.amount])).toEqual([['award', 20], ['correction', -20], ['correction', 20]])
  expect(restored.masteryHistory.map((e: any) => e.action)).toEqual(['award', 'revocation', 'award'])
})

it('AC4: A loss relocks B without cascading Mastery or invalidating pending work/private draft', async () => {
  const a = await send()
  expect((await approve(a)).status).toBe(201)
  const b = await send(fx.content.taskB.id)
  expect((await approve(b, fx.content.taskB.id)).status).toBe(201)
  const pending = await send(fx.content.taskB.id)
  const draftPath = `/enrollments/${enrollmentId}/tasks/${fx.content.taskB.id}/draft`
  expect((await request(draftPath, 'learner', 'PUT', { text: 'Private unfinished work', urls: [] })).status).toBe(200)
  const draft = await (await request(draftPath)).json()
  const beforeHistory = (await (await request(path(fx.content.taskB.id))).json() as any).submission
  expect((await revoke(a)).status).toBe(200)
  const after = await state()
  expect(skill(after, fx.content.skillA.id).mastery).toBe(false)
  expect(skill(after, fx.content.skillB.id)).toMatchObject({ mastery: true, access: false, xpShortfall: 20, unmetPrerequisiteSkillIds: [fx.content.skillA.id] })
  expect((await (await request(path(fx.content.taskB.id))).json() as any).submission).toEqual(beforeHistory)
  expect(await (await request(draftPath)).json()).toEqual(draft)
  expect((await request(draftPath, 'coach')).status).toBe(403)
  expect((await request(`${path(fx.content.taskB.id)}/revisions`, 'learner', 'POST', { text: 'Blocked new work' })).status).toBe(403)
  expect((await approve(pending, fx.content.taskB.id)).status).toBe(201)
  expect(skill(await state(), fx.content.skillB.id)).toMatchObject({ mastery: true, access: false })
  expect((await state()).masteryHistory.filter((e: any) => e.skillId === fx.content.skillB.id).map((e: any) => e.action)).toEqual(['award'])
})

it('AC1/5/6: authority, exact context, invalid reasons and non-Approvals reject with unchanged full state', async () => {
  const id = await send()
  expect((await approve(id)).status).toBe(201)
  const before = await state()
  const history = await (await request(path())).json()
  for (const actor of ['learner', 'peer', 'unrelated', 'otherCoach', null] as const) {
    expect((await revoke(id, { reason: 'No authority' }, actor)).status).toBe(actor === 'learner' ? 403 : actor === null ? 401 : 404)
    if (actor !== 'learner') expect((await request(`/enrollments/${enrollmentId}/learning-state`, actor)).status).toBe(actor === null ? 401 : 404)
  }
  for (const body of [null, {}, { reason: 2 }, { reason: '' }, { reason: ' \n\t' }, { reason: 'x'.repeat(50001) }]) expect((await revoke(id, body)).status).toBe(422)
  for (const bad of ['invalid', crypto.randomUUID()]) expect((await revoke(bad)).status).toBe(404)
  expect((await revoke(id, undefined, 'coach', fx.content.taskAReading.id)).status).toBe(404)
  expect((await revoke(id, undefined, 'coach', fx.content.taskA.id, crypto.randomUUID())).status).toBe(404)
  const changes = await send()
  expect((await request(`${path()}/revisions/${changes}/review`, 'coach', 'POST', { decision: 'changes_requested', feedback: 'Correct this' })).status).toBe(201)
  expect((await revoke(changes)).status).toBe(404)
  const pending = await send()
  expect((await revoke(pending)).status).toBe(404)
  await send()
  expect((await revoke(pending)).status).toBe(404)
  // The revisions sent above legitimately await Review now (T23); every progress record is unchanged.
  const progress = ({ awaitingReview: _, ...records }: any) => records
  expect(progress(await state())).toEqual(progress(before))
  expect((await (await request(path())).json() as any).submission.revisions[0]).toEqual((history as any).submission.revisions[0])
})

it('AC3: zero-XP Required Task records real Mastery history without fabricated XP', async () => {
  await amendPublished(db, (tx) => tx.update(versionTasks).set({ xpReward: 0 }).where(eq(versionTasks.taskId, fx.content.taskA.id)))
  const id = await send()
  expect((await approve(id)).status).toBe(201)
  expect(skill(await state(), fx.content.skillA.id).mastery).toBe(true)
  expect((await revoke(id)).status).toBe(200)
  const after = await state()
  expect(after.xpHistory).toEqual([])
  expect(after.masteryHistory.map((e: any) => e.action)).toEqual(['award', 'revocation'])
  expect(skill(after, fx.content.skillA.id).mastery).toBe(false)
})

it('AC2/3: Enrichment correction does not revoke independently supported Mastery', async () => {
  const a = await send()
  expect((await approve(a)).status).toBe(201)
  await amendPublished(db, (tx) => tx.update(versionTasks).set({ xpReward: 7 }).where(eq(versionTasks.taskId, fx.content.taskAReading.id)))
  const reading = await send(fx.content.taskAReading.id)
  expect((await approve(reading, fx.content.taskAReading.id)).status).toBe(201)
  expect((await revoke(reading, undefined, 'coach', fx.content.taskAReading.id)).status).toBe(200)
  const after = await state()
  expect(after.xp).toBe(20)
  expect(skill(after, fx.content.skillA.id).mastery).toBe(true)
  expect(after.masteryHistory.map((e: any) => e.action)).toEqual(['award'])
  expect(after.xpHistory.map((e: any) => [e.kind, e.amount])).toEqual([['award', 20], ['award', 7], ['correction', -7]])
})

it('AC6: late Mastery history storage failure rolls back Review change and already inserted XP Correction', async () => {
  const id = await send()
  expect((await approve(id)).status).toBe(201)
  const before = await state()
  const history = await (await request(path())).json()
  await db.execute(sql`create function test_fail_mastery() returns trigger language plpgsql as $$ begin raise exception 'late mastery storage failure'; end $$`)
  await db.execute(sql`create trigger test_fail_mastery after insert on mastery_events for each row execute function test_fail_mastery()`)
  try {
    expect((await revoke(id)).status).toBe(500)
    expect(await state()).toEqual(before)
    expect(await (await request(path())).json()).toEqual(history)
  } finally {
    await db.execute(sql`drop trigger test_fail_mastery on mastery_events`)
    await db.execute(sql`drop function test_fail_mastery()`)
  }
  expect((await revoke(id)).status).toBe(200)
  const after = await state()
  const other = createDatabase(TEST_DATABASE_URL)
  try {
    const fresh = createApp({ db: other.db, identity: fixtureIdentity(fx.identities) })
    const response = await fresh.request(`/enrollments/${enrollmentId}/learning-state`, { headers: { [FIXTURE_IDENTITY_HEADER]: 'learner' } })
    expect(response.status).toBe(200)
    expect((await response.json() as any).learningState).toEqual(after)
    const submitted = await fresh.request(path(), { headers: { [FIXTURE_IDENTITY_HEADER]: 'coach' } })
    expect((await submitted.json() as any).submission.revisions[0].review.revokedAt).not.toBeNull()
  } finally { await other.close() }
})

it('AC6: peer and other-Version progress/history remain isolated from local correction', async () => {
  const [other] = await db.insert(enrollments).values({ accountId: fx.accounts.learner.id, learningPathVersionId: fx.versions.version2.id }).returning()
  const peer = (await (await request(`/invitations/${fx.invitations.toPeer.id}/accept`, 'peer', 'POST')).json() as any).enrollment.id
  const local = await send()
  expect((await approve(local)).status).toBe(201)
  for (const [enrollment, actor] of [[other.id, 'learner'], [peer, 'peer']] as const) {
    const id = await send(fx.content.taskA.id, enrollment, actor)
    expect((await approve(id, fx.content.taskA.id, enrollment)).status).toBe(201)
    expect((await revoke(local, undefined, 'coach', fx.content.taskA.id, enrollment)).status).toBe(404)
  }
  const otherBefore = await state('learner', other.id), peerBefore = await state('peer', peer)
  expect((await revoke(local)).status).toBe(200)
  expect(await state('learner', other.id)).toEqual(otherBefore)
  expect(await state('peer', peer)).toEqual(peerBefore)
})

it('migration: historical awards and corrections replay recorded times, with unknown revocation actor left null', async () => {
  const first = await send()
  expect((await approve(first)).status).toBe(201)
  const second = await send()
  expect((await approve(second)).status).toBe(201)
  const times = [new Date('2026-10-01T01:00:00Z'), new Date('2026-10-01T02:00:00Z'), new Date('2026-10-01T03:00:00Z'), new Date('2026-10-01T04:00:00Z')]
  await db.update(submissionReviews).set({ decidedAt: times[0], revokedAt: times[2], revocationReason: 'Historical correction' }).where(eq(submissionReviews.revisionId, first))
  await db.update(submissionReviews).set({ decidedAt: times[1], revokedAt: times[3], revocationReason: 'Historical correction' }).where(eq(submissionReviews.revisionId, second))
  const migration = await Bun.file(new URL('../drizzle/0004_wakeful_bromley.sql', import.meta.url)).text()
  const replay = migration.slice(migration.indexOf('-- Replay known historical evidence.'))
  await db.transaction(async (tx) => {
    await tx.delete(xpEvents)
    await tx.delete(masteryEvents)
    for (const statement of replay.split('--> statement-breakpoint')) await tx.execute(sql.raw(statement))
  })
  const after = await state()
  expect(after.xp).toBe(0)
  expect(after.xpHistory.map((e: any) => [e.kind, e.amount, e.occurredAt, e.actorAccountId])).toEqual([
    ['award', 20, times[0].toISOString(), fx.accounts.coach.id], ['correction', -20, times[3].toISOString(), null],
  ])
  expect(after.masteryHistory.map((e: any) => [e.action, e.occurredAt, e.actorAccountId])).toEqual([
    ['award', times[0].toISOString(), fx.accounts.coach.id], ['revocation', times[3].toISOString(), null],
  ])
})

it('AC5/6: concurrent final revocation and later Approval serialize to coherent restoration', async () => {
  const first = await send()
  expect((await approve(first)).status).toBe(201)
  const next = await send()
  const responses = await Promise.all([revoke(first), approve(next)])
  expect(responses.map((r) => r.status)).toEqual([200, 201])
  const after = await state()
  expect(after.xp).toBe(20)
  expect(skill(after, fx.content.skillA.id).mastery).toBe(true)
  expect(after.xpHistory.reduce((sum: number, e: any) => sum + e.amount, 0)).toBe(20)
  expect(after.xpHistory.map((e: any) => e.amount)).toEqual(after.xpHistory.length === 1 ? [20] : [20, -20, 20])
  expect(after.masteryHistory.map((e: any) => e.action)).toEqual(after.masteryHistory.length === 1 ? ['award'] : ['award', 'revocation', 'award'])
})

/** Pause the first request after its Enrollment lock; prove the second really waits. */
async function orderedRequests(operation: 'insert' | 'update', first: () => Promise<Response>, second: () => Promise<Response>) {
  const other = createDatabase(TEST_DATABASE_URL, 1)
  let release!: () => void, ready!: (pid: number) => void
  const barrier = new Promise<void>((resolve) => { release = resolve })
  const locked = new Promise<number>((resolve) => { ready = resolve })
  await db.execute(sql`create function test_pause_correction() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(91011); return NEW; end $$`)
  await db.execute(sql`create trigger test_pause_correction before ${sql.raw(operation)} on submission_reviews for each row execute function test_pause_correction()`)
  const locker = other.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(91011)`)
    const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
    ready(row.pid)
    await barrier
  })
  let pendingFirst: Promise<Response> | undefined, pendingSecond: Promise<Response> | undefined
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
    await db.execute(sql`drop trigger test_pause_correction on submission_reviews`)
    await db.execute(sql`drop function test_pause_correction()`)
    await other.close()
  }
}

for (const order of ['revoke-first', 'approve-first'] as const) it(`AC5/6: observed Enrollment lock ${order} preserves exact transition history`, async () => {
  const first = await send()
  expect((await approve(first)).status).toBe(201)
  const next = await send()
  const responses = order === 'revoke-first'
    ? await orderedRequests('update', () => revoke(first), () => approve(next))
    : await orderedRequests('insert', () => approve(next), () => revoke(first))
  expect(responses.map((r) => r.status)).toEqual(order === 'revoke-first' ? [200, 201] : [201, 200])
  const after = await state()
  expect(after.xp).toBe(20)
  expect(after.xpHistory.map((e: any) => e.amount)).toEqual(order === 'revoke-first' ? [20, -20, 20] : [20])
  expect(after.masteryHistory.map((e: any) => e.action)).toEqual(order === 'revoke-first' ? ['award', 'revocation', 'award'] : ['award'])
})

it('AC6: learning-state read waits for correction commit and returns coherent history and progress', async () => {
  const id = await send()
  expect((await approve(id)).status).toBe(201)
  const [revoked, read] = await orderedRequests('update', () => revoke(id), () => request(`/enrollments/${enrollmentId}/learning-state`))
  expect([revoked.status, read.status]).toEqual([200, 200])
  const after = (await read.json() as any).learningState
  expect(after.xp).toBe(0)
  expect(skill(after, fx.content.skillA.id).mastery).toBe(false)
  expect(skill(after, fx.content.skillB.id).access).toBe(false)
  expect(after.xpHistory.map((e: any) => e.amount)).toEqual([20, -20])
  expect(after.masteryHistory.map((e: any) => e.action)).toEqual(['award', 'revocation'])
})

it('AC1/6: owning Coach can correct inactive history without reactivating Enrollment', async () => {
  const id = await send()
  expect((await approve(id)).status).toBe(201)
  await db.update(enrollments).set({ status: 'inactive' }).where(eq(enrollments.id, enrollmentId))
  const reason = '  Correction with verbatim reason.  '
  expect((await revoke(id, { reason })).status).toBe(200)
  const after = await state()
  expect(after.enrollmentStatus).toBe('inactive')
  expect(after.xp).toBe(0)
  expect(after.skills.every((s: any) => !s.access)).toBe(true)
  expect((await (await request(path(), 'coach')).json() as any).submission.revisions[0].review.revocationReason).toBe(reason)
})

it('migration: complete generated DDL and backfill upgrade pre-T10 tables atomically', async () => {
  const id = await send()
  expect((await approve(id)).status).toBe(201)
  expect((await revoke(id)).status).toBe(200)
  const before = await state()
  const migration = await Bun.file(new URL('../drizzle/0004_wakeful_bromley.sql', import.meta.url)).text()
  // Restore the old table shape inside a transaction, apply the complete real
  // migration, then roll it back so test fixtures/migration metadata stay intact.
  await expect(db.transaction(async (tx) => {
    await tx.execute(sql`drop table xp_events, mastery_events`)
    await tx.execute(sql`alter table submission_reviews drop column revoked_by_account_id`)
    for (const statement of migration.split('--> statement-breakpoint')) await tx.execute(sql.raw(statement))
    const xp = await tx.select().from(xpEvents)
    const mastery = await tx.select().from(masteryEvents)
    expect(xp.map((e) => [e.kind, e.amount])).toEqual([['award', 20], ['correction', -20]])
    expect(mastery.map((e) => e.action)).toEqual(['award', 'revocation'])
    expect(xp[0].occurredAt.toISOString()).toBe(before.xpHistory[0].occurredAt)
    expect(mastery[0].occurredAt.toISOString()).toBe(before.masteryHistory[0].occurredAt)
    expect(xp[1].actorAccountId).toBeNull()
    expect(mastery[1].actorAccountId).toBeNull()
    throw new Error('rollback migration verification')
  })).rejects.toThrow('rollback migration verification')
  expect(await state()).toEqual(before)
})

it('migration: equal-time different-Task events retain their own causal Review through full DDL upgrade', async () => {
  await amendPublished(db, (tx) => tx.delete(versionPrerequisites).where(eq(versionPrerequisites.learningPathVersionId, fx.versions.version1.id)))
  await amendPublished(db, (tx) => tx.update(versionSkills).set({ xpThreshold: 0 }).where(eq(versionSkills.learningPathVersionId, fx.versions.version1.id)))
  await amendPublished(db, (tx) => tx.update(versionTasks).set({ xpReward: 7 }).where(and(eq(versionTasks.learningPathVersionId, fx.versions.version1.id), eq(versionTasks.taskId, fx.content.taskB.id))))
  await amendPublished(db, (tx) => tx.update(versionTasks).set({ xpReward: 11 }).where(and(eq(versionTasks.learningPathVersionId, fx.versions.version1.id), eq(versionTasks.taskId, fx.content.taskAReading.id))))
  const awardedAt = new Date('2026-10-01T01:00:00Z'), revokedAt = new Date('2026-10-01T02:00:00Z'), restoredAt = new Date('2026-10-01T03:00:00Z')
  const evidence: { taskId: string; skillId: string; reward: number; required: boolean; original: string; restored: string | null; reason: string }[] = []
  for (const [taskId, skillId, reward, required] of [
    [fx.content.taskA.id, fx.content.skillA.id, 20, true],
    [fx.content.taskB.id, fx.content.skillB.id, 7, true],
    [fx.content.taskAReading.id, fx.content.skillA.id, 11, false],
  ] as const) {
    const original = await send(taskId)
    expect((await approve(original, taskId)).status).toBe(201)
    const reason = `Historical correction for ${taskId}`
    await db.update(submissionReviews).set({ decidedAt: awardedAt, revokedAt, revocationReason: reason }).where(eq(submissionReviews.revisionId, original))
    let restored: string | null = null
    if (required) {
      restored = await send(taskId)
      expect((await approve(restored, taskId)).status).toBe(201)
      await db.update(submissionReviews).set({ decidedAt: restoredAt }).where(eq(submissionReviews.revisionId, restored))
    }
    evidence.push({ taskId, skillId, reward, required, original, restored, reason })
  }
  const peer = (await (await request(`/invitations/${fx.invitations.toPeer.id}/accept`, 'peer', 'POST')).json() as any).enrollment.id as string
  const [other] = await db.insert(enrollments).values({ accountId: fx.accounts.learner.id, learningPathVersionId: fx.versions.version2.id }).returning()
  await amendPublished(db, (tx) => tx.update(versionTasks).set({ xpReward: 5 }).where(and(eq(versionTasks.learningPathVersionId, fx.versions.version2.id), eq(versionTasks.taskId, fx.content.taskA.id))))
  const isolated: { enrollment: string; version: string; revision: string; reward: number }[] = []
  for (const [enrollment, version, actor, reward] of [[peer, fx.versions.version1.id, 'peer', 20], [other.id, fx.versions.version2.id, 'learner', 5]] as const) {
    const revision = await send(fx.content.taskA.id, enrollment, actor)
    expect((await approve(revision, fx.content.taskA.id, enrollment)).status).toBe(201)
    await db.update(submissionReviews).set({ decidedAt: awardedAt, revokedAt, revocationReason: `Correction in ${enrollment}` }).where(eq(submissionReviews.revisionId, revision))
    isolated.push({ enrollment, version, revision, reward })
  }
  const migration = await Bun.file(new URL('../drizzle/0004_wakeful_bromley.sql', import.meta.url)).text()
  await expect(db.transaction(async (tx) => {
    await tx.execute(sql`drop table xp_events, mastery_events`)
    await tx.execute(sql`alter table submission_reviews drop column revoked_by_account_id`)
    for (const statement of migration.split('--> statement-breakpoint')) await tx.execute(sql.raw(statement))
    const xp = await tx.select().from(xpEvents).where(eq(xpEvents.enrollmentId, enrollmentId)), mastery = await tx.select().from(masteryEvents).where(eq(masteryEvents.enrollmentId, enrollmentId))
    for (const context of isolated) {
      const scopedXp = await tx.select().from(xpEvents).where(eq(xpEvents.enrollmentId, context.enrollment))
      expect(scopedXp.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()).map((e) => [e.learningPathVersionId, e.revisionId, e.amount, e.actorAccountId, e.occurredAt])).toEqual([
        [context.version, context.revision, context.reward, fx.accounts.coach.id, awardedAt],
        [context.version, context.revision, -context.reward, null, revokedAt],
      ])
      const scopedMastery = await tx.select().from(masteryEvents).where(eq(masteryEvents.enrollmentId, context.enrollment))
      expect(scopedMastery.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()).map((e) => [e.learningPathVersionId, e.skillId, e.revisionId, e.action])).toEqual([
        [context.version, fx.content.skillA.id, context.revision, 'award'], [context.version, fx.content.skillA.id, context.revision, 'revocation'],
      ])
    }
    expect(xp).toHaveLength(8)
    expect(mastery).toHaveLength(6)
    expect(xp.reduce((sum, e) => sum + e.amount, 0)).toBe(27)
    for (const item of evidence) {
      const events = xp.filter((e) => e.taskId === item.taskId).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
      expect(events.map((e) => [e.kind, e.amount, e.revisionId, e.actorAccountId, e.occurredAt])).toEqual([
        ['award', item.reward, item.original, fx.accounts.coach.id, awardedAt],
        ['correction', -item.reward, item.original, null, revokedAt],
        ...(item.restored ? [['correction', item.reward, item.restored, fx.accounts.coach.id, restoredAt]] : []),
      ])
      const [cause] = await tx.select().from(submissionReviews).where(eq(submissionReviews.revisionId, events[1].revisionId))
      expect(cause.revocationReason).toBe(item.reason)
      if (item.required) expect(mastery.filter((e) => e.skillId === item.skillId).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()).map((e) => [e.action, e.revisionId, e.actorAccountId, e.occurredAt])).toEqual([
        ['award', item.original, fx.accounts.coach.id, awardedAt],
        ['revocation', item.original, null, revokedAt],
        ['award', item.restored, fx.accounts.coach.id, restoredAt],
      ])
    }
    throw new Error('rollback equal-time migration verification')
  })).rejects.toThrow('rollback equal-time migration verification')
})

it('migration: multi-Required Mastery excludes simultaneous Enrichment and redundant Approval causes', async () => {
  const [extra] = await db.insert(tasks).values({ skillId: fx.content.skillA.id }).returning()
  await amendPublished(db, (tx) => tx.insert(versionTasks).values({ learningPathVersionId: fx.versions.version1.id, taskId: extra.id, skillId: fx.content.skillA.id, title: 'Second Required evidence', required: true, xpReward: 0 }))
  await amendPublished(db, (tx) => tx.update(versionTasks).set({ xpReward: 11 }).where(and(eq(versionTasks.learningPathVersionId, fx.versions.version1.id), eq(versionTasks.taskId, fx.content.taskAReading.id))))
  const moments = [1, 2, 3, 4].map((hour) => new Date(`2026-10-01T0${hour}:00:00Z`))
  const initial = await send()
  expect((await approve(initial)).status).toBe(201)
  const redundant = await send()
  expect((await approve(redundant)).status).toBe(201)
  const required = await send(extra.id)
  expect((await approve(required, extra.id)).status).toBe(201)
  const enrichment = await send(fx.content.taskAReading.id)
  expect((await approve(enrichment, fx.content.taskAReading.id)).status).toBe(201)
  await db.update(submissionReviews).set({ decidedAt: moments[0], revokedAt: moments[3], revocationReason: 'Redundant evidence withdrawn' }).where(eq(submissionReviews.revisionId, initial))
  await db.update(submissionReviews).set({ decidedAt: moments[1] }).where(eq(submissionReviews.revisionId, redundant))
  await db.update(submissionReviews).set({ decidedAt: moments[1], revokedAt: moments[2], revocationReason: 'Required evidence correction' }).where(eq(submissionReviews.revisionId, required))
  await db.update(submissionReviews).set({ decidedAt: moments[1], revokedAt: moments[2], revocationReason: 'Enrichment evidence correction' }).where(eq(submissionReviews.revisionId, enrichment))
  const restored = await send(extra.id)
  expect((await approve(restored, extra.id)).status).toBe(201)
  await db.update(submissionReviews).set({ decidedAt: moments[3] }).where(eq(submissionReviews.revisionId, restored))
  const migration = await Bun.file(new URL('../drizzle/0004_wakeful_bromley.sql', import.meta.url)).text()
  await db.transaction(async (tx) => {
    await tx.delete(xpEvents)
    await tx.delete(masteryEvents)
    for (const statement of migration.slice(migration.indexOf('-- Replay known historical evidence.')).split('--> statement-breakpoint')) await tx.execute(sql.raw(statement))
  })
  const after = await state()
  expect(after.xpHistory.filter((e: any) => e.taskId === fx.content.taskA.id).map((e: any) => [e.amount, e.revisionId, e.occurredAt])).toEqual([[20, initial, moments[0].toISOString()]])
  expect(after.xpHistory.filter((e: any) => e.taskId === extra.id)).toEqual([])
  expect(after.xpHistory.filter((e: any) => e.taskId === fx.content.taskAReading.id).map((e: any) => [e.amount, e.revisionId])).toEqual([[11, enrichment], [-11, enrichment]])
  expect(after.masteryHistory.map((e: any) => [e.skillId, e.action, e.revisionId, e.actorAccountId, e.occurredAt])).toEqual([
    [fx.content.skillA.id, 'award', required, fx.accounts.coach.id, moments[1].toISOString()],
    [fx.content.skillA.id, 'revocation', required, null, moments[2].toISOString()],
    [fx.content.skillA.id, 'award', restored, fx.accounts.coach.id, moments[3].toISOString()],
  ])
  expect(after.xp).toBe(20)
  expect(skill(after, fx.content.skillA.id).mastery).toBe(true)
})
