import { afterAll, beforeAll, beforeEach, expect, it } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'
import { createApp } from '../src/app'
import { createDatabase, type Database } from '../src/db/client'
import { enrollments, versionPrerequisites, versionSkills, versionTasks } from '../src/db/schema'
import { FIXTURE_IDENTITY_HEADER, fixtureIdentity } from '../src/identity'
import { prepareTestDatabase, resetTestDatabase, TEST_DATABASE_URL } from './support/database'
import { seedEnrollmentFixture, type EnrollmentFixture } from './support/fixtures'

let db: Database, close: () => Promise<void>, fx: EnrollmentFixture, app: ReturnType<typeof createApp>, enrollmentId: string
beforeAll(async () => { ({ db, close } = await prepareTestDatabase()) })
afterAll(async () => { await close() })
beforeEach(async () => {
  await resetTestDatabase(db)
  fx = await seedEnrollmentFixture(db)
  app = createApp({ db, identity: fixtureIdentity(fx.identities) })
  enrollmentId = (await (await request(`/invitations/${fx.invitations.toLearner.id}/accept`, 'learner', 'POST')).json() as any).enrollment.id
  await db.update(versionSkills).set({ xpThreshold: 20 }).where(and(eq(versionSkills.learningPathVersionId, fx.versions.version1.id), eq(versionSkills.skillId, fx.content.skillB.id)))
  await db.insert(versionPrerequisites).values({ learningPathVersionId: fx.versions.version1.id, prerequisiteSkillId: fx.content.skillA.id, skillId: fx.content.skillB.id })
})
type Actor = keyof EnrollmentFixture['identities'] | null
async function request(path: string, actor: Actor = 'learner', method = 'GET', body?: unknown) {
  return app.request(path, { method, headers: { ...(actor ? { [FIXTURE_IDENTITY_HEADER]: actor } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
}
const overridePath = (skill = fx.content.skillB.id, enrollment = enrollmentId) => `/enrollments/${enrollment}/skills/${skill}/access-overrides`
const grant = (body: unknown = { reason: 'Prior experience supports direct practice.' }, actor: Actor = 'coach', skill = fx.content.skillB.id, enrollment = enrollmentId) => request(overridePath(skill, enrollment), actor, 'POST', body)
const revoke = (id: string, body: unknown = { reason: 'Return to the ordinary progression route.' }, actor: Actor = 'coach', skill = fx.content.skillB.id, enrollment = enrollmentId) => request(`${overridePath(skill, enrollment)}/${id}/revoke`, actor, 'POST', body)
async function state(actor: Actor = 'learner', enrollment = enrollmentId) {
  const response = await request(`/enrollments/${enrollment}/learning-state`, actor)
  expect(response.status).toBe(200)
  return (await response.json() as any).learningState
}
const skill = (s: any, id = fx.content.skillB.id) => s.skills.find((x: any) => x.skillId === id)
const submissionPath = (task = fx.content.taskB.id, enrollment = enrollmentId) => `/enrollments/${enrollment}/tasks/${task}/submission`
const send = (task = fx.content.taskB.id) => request(`${submissionPath(task)}/revisions`, 'learner', 'POST', { text: 'Evidence supplied with valid Access.' })
const approve = (id: string) => request(`${submissionPath()}/revisions/${id}/review`, 'coach', 'POST', { decision: 'approval' })

it('AC1/2/5: one owning-Coach grant waives both unmet gates only in the target Enrollment/Skill', async () => {
  // Keep a different Skill locked too, so a blanket Enrollment bypass cannot pass.
  await db.update(versionSkills).set({ xpThreshold: 20 }).where(and(eq(versionSkills.learningPathVersionId, fx.versions.version1.id), eq(versionSkills.skillId, fx.content.skillA.id)))
  const peer = (await (await request(`/invitations/${fx.invitations.toPeer.id}/accept`, 'peer', 'POST')).json() as any).enrollment.id
  const [other] = await db.insert(enrollments).values({ accountId: fx.accounts.learner.id, learningPathVersionId: fx.versions.version2.id }).returning()
  const peerBefore = await state('peer', peer), otherBefore = await state('learner', other.id), before = await state()
  expect(skill(before)).toMatchObject({ access: false, mastery: false, xpShortfall: 20, unmetPrerequisiteSkillIds: [fx.content.skillA.id] })
  expect((await send()).status).toBe(403)
  const response = await grant()
  expect(response.status).toBe(201)
  const record = (await response.json() as any).overrideRecord
  expect(record).toMatchObject({ action: 'grant', coachAccountId: fx.accounts.coach.id, learnerAccountId: fx.accounts.learner.id, enrollmentId, learningPathVersionId: fx.versions.version1.id, skillId: fx.content.skillB.id, reason: 'Prior experience supports direct practice.', grantRecordId: null })
  expect(Number.isFinite(Date.parse(record.occurredAt))).toBe(true)
  const after = await state()
  expect(after.xp).toBe(0)
  expect(skill(after)).toMatchObject({ access: true, mastery: false, accessOverride: record, xpShortfall: 20, unmetPrerequisiteSkillIds: [fx.content.skillA.id] })
  expect(skill(after, fx.content.skillA.id)).toEqual(skill(before, fx.content.skillA.id))
  expect(skill(after, fx.content.skillA.id).access).toBe(false)
  expect((await send(fx.content.taskA.id)).status).toBe(403)
  expect(after.overrideHistory).toEqual([record])
  expect(after.xpHistory).toEqual(before.xpHistory)
  expect(after.masteryHistory).toEqual(before.masteryHistory)
  expect(await state('coach')).toEqual(after)
  expect(await state('peer', peer)).toEqual(peerBefore)
  expect(await state('learner', other.id)).toEqual(otherBefore)
  expect((await send()).status).toBe(201)
})

async function granted() {
  const response = await grant()
  expect(response.status).toBe(201)
  return (await response.json() as any).overrideRecord
}

it('AC2/3/5: revocation preserves achievements, sent work and private draft; pending eligible work remains reviewable', async () => {
  await db.update(versionTasks).set({ xpReward: 7 }).where(and(eq(versionTasks.learningPathVersionId, fx.versions.version1.id), eq(versionTasks.taskId, fx.content.taskB.id)))
  const record = await granted()
  const sent = await send()
  expect(sent.status).toBe(201)
  const first = (await sent.json() as any).revision.id
  expect((await approve(first)).status).toBe(201)
  const superseded = (await (await send()).json() as any).revision.id
  const pending = (await (await send()).json() as any).revision.id
  const draftPath = `/enrollments/${enrollmentId}/tasks/${fx.content.taskB.id}/draft`
  expect((await request(draftPath, 'learner', 'PUT', { text: 'Unsent private draft', urls: [] })).status).toBe(200)
  const before = await state(), history = await (await request(submissionPath())).json(), draft = await (await request(draftPath)).json()
  expect(before.xp).toBe(7)
  expect(skill(before).mastery).toBe(true)
  const response = await revoke(record.id, { reason: '  Return to prerequisites.  ', coachAccountId: fx.accounts.otherCoach.id, learnerAccountId: fx.accounts.peer.id, occurredAt: '2000-01-01' })
  expect(response.status).toBe(200)
  const withdrawal = (await response.json() as any).overrideRecord
  expect(withdrawal).toMatchObject({ action: 'revoke', grantRecordId: record.id, coachAccountId: fx.accounts.coach.id, learnerAccountId: fx.accounts.learner.id, enrollmentId, learningPathVersionId: fx.versions.version1.id, skillId: fx.content.skillB.id, reason: '  Return to prerequisites.  ' })
  expect(Date.parse(withdrawal.occurredAt)).toBeGreaterThanOrEqual(Date.parse(record.occurredAt))
  const after = await state()
  expect(skill(after)).toMatchObject({ access: false, accessOverride: null, mastery: true, xpShortfall: 13, unmetPrerequisiteSkillIds: [fx.content.skillA.id] })
  expect(after.xp).toBe(before.xp)
  expect(after.tasks).toEqual(before.tasks)
  expect(after.xpHistory).toEqual(before.xpHistory)
  expect(after.masteryHistory).toEqual(before.masteryHistory)
  expect(after.overrideHistory).toEqual([record, withdrawal])
  expect(await (await request(submissionPath())).json()).toEqual(history)
  expect(await (await request(draftPath)).json()).toEqual(draft)
  expect((await request(draftPath, 'coach')).status).toBe(403)
  expect((await send()).status).toBe(403)
  expect((await approve(superseded)).status).toBe(409)
  expect((await approve(pending)).status).toBe(201)
  const reviewed = await state()
  expect(reviewed.xp).toBe(7)
  expect(skill(reviewed)).toMatchObject({ access: false, mastery: true })
  expect(reviewed.xpHistory).toEqual(before.xpHistory)
  expect(reviewed.masteryHistory).toEqual(before.masteryHistory)
})

it('AC2/4: invalid reasons, untrusted actors and malformed/foreign Skill targets have no effects', async () => {
  const before = await state()
  for (const actor of ['learner', 'peer', 'unrelated', 'otherCoach', null] as const) {
    expect((await grant(undefined, actor)).status).toBe(actor === 'learner' ? 403 : actor === null ? 401 : 404)
    if (actor !== 'learner') expect((await request(`/enrollments/${enrollmentId}/learning-state`, actor)).status).toBe(actor === null ? 401 : 404)
  }
  for (const body of [null, {}, { reason: 2 }, { reason: '' }, { reason: ' \n\t' }, { reason: 'x'.repeat(501) }]) expect((await grant(body)).status).toBe(422)
  for (const bad of ['invalid', crypto.randomUUID()]) expect((await grant(undefined, 'coach', bad)).status).toBe(404)
  expect((await grant(undefined, 'coach', fx.content.taskB.id)).status).toBe(404)
  expect((await grant(undefined, 'coach', fx.content.skillB.id, crypto.randomUUID())).status).toBe(404)
  // A real Skill that exists only in another Version is not a pinned target.
  const [versionOnly] = await db.execute<{ id: string }>(sql`insert into skills (learning_path_id) values (${fx.paths.path.id}) returning id`)
  await db.insert(versionSkills).values({ learningPathVersionId: fx.versions.version2.id, skillId: versionOnly.id, title: 'New Version Skill', learningOutcome: 'Not in Enrollment Version' })
  expect((await grant(undefined, 'coach', versionOnly.id)).status).toBe(404)
  expect(await state()).toEqual(before)
  const record = await granted(), active = await state()
  for (const actor of ['learner', 'peer', 'unrelated', 'otherCoach', null] as const) expect((await revoke(record.id, undefined, actor)).status).toBe(actor === 'learner' ? 403 : actor === null ? 401 : 404)
  for (const body of [null, {}, { reason: false }, { reason: '' }, { reason: ' \n\t' }, { reason: 'x'.repeat(501) }]) expect((await revoke(record.id, body)).status).toBe(422)
  expect(await state()).toEqual(active)
})

it('AC4: exact grant cannot be revoked through a peer Enrollment, another Version, Skill or Workspace', async () => {
  const record = await granted()
  const peer = (await (await request(`/invitations/${fx.invitations.toPeer.id}/accept`, 'peer', 'POST')).json() as any).enrollment.id
  const [other] = await db.insert(enrollments).values({ accountId: fx.accounts.learner.id, learningPathVersionId: fx.versions.version2.id }).returning()
  const [foreignPath] = await db.execute<{ id: string }>(sql`insert into learning_paths (coach_workspace_id, title) values (${fx.workspaces.otherWorkspace.id}, 'Foreign Path') returning id`)
  const [foreignVersion] = await db.execute<{ id: string }>(sql`insert into learning_path_versions (learning_path_id, version_number, published_at) values (${foreignPath.id}, 1, now()) returning id`)
  const [foreignSkill] = await db.execute<{ id: string }>(sql`insert into skills (learning_path_id) values (${foreignPath.id}) returning id`)
  await db.insert(versionSkills).values({ learningPathVersionId: foreignVersion.id, skillId: foreignSkill.id, title: 'Foreign Skill', learningOutcome: 'Outside authority' })
  const [foreign] = await db.insert(enrollments).values({ accountId: fx.accounts.learner.id, learningPathVersionId: foreignVersion.id }).returning()
  const localBefore = await state(), peerBefore = await state('peer', peer), otherBefore = await state('learner', other.id), foreignBefore = await state('learner', foreign.id)
  for (const target of [peer, other.id]) expect((await revoke(record.id, undefined, 'coach', fx.content.skillB.id, target)).status).toBe(404)
  expect((await revoke(record.id, undefined, 'coach', fx.content.skillA.id)).status).toBe(404)
  expect((await grant(undefined, 'coach', foreignSkill.id)).status).toBe(404)
  expect((await grant(undefined, 'coach', foreignSkill.id, foreign.id)).status).toBe(404)
  expect((await revoke(record.id, undefined, 'otherCoach', foreignSkill.id, foreign.id)).status).toBe(404)
  expect((await revoke(record.id, undefined, 'otherCoach')).status).toBe(404)
  expect(await state()).toEqual(localBefore)
  expect(await state('peer', peer)).toEqual(peerBefore)
  expect(await state('learner', other.id)).toEqual(otherBefore)
  expect(await state('learner', foreign.id)).toEqual(foreignBefore)
})

it('AC2/4: repeated and competing grant/revoke serialize once; stale revoke cannot withdraw regrant', async () => {
  expect((await revoke(crypto.randomUUID())).status).toBe(404)
  const grants = await Promise.all([grant(), grant()])
  expect(grants.map((r) => r.status).sort()).toEqual([201, 409])
  const first = (await grants.find((r) => r.status === 201)!.json() as any).overrideRecord
  expect((await grant()).status).toBe(409)
  const withdrawals = await Promise.all([revoke(first.id), revoke(first.id)])
  expect(withdrawals.map((r) => r.status).sort()).toEqual([200, 409])
  const withdrawal = (await withdrawals.find((r) => r.status === 200)!.json() as any).overrideRecord
  expect((await revoke(withdrawal.id)).status).toBe(404)
  const next = await granted()
  expect(next.id).not.toBe(first.id)
  const before = await state()
  expect((await revoke(first.id)).status).toBe(409)
  expect(await state()).toEqual(before)
  expect(skill(before).accessOverride.id).toBe(next.id)
  expect(before.overrideHistory.map((e: any) => e.action)).toEqual(['grant', 'revoke', 'grant'])
  expect((await revoke(next.id)).status).toBe(200)
  expect((await state()).overrideHistory.map((e: any) => e.action)).toEqual(['grant', 'revoke', 'grant', 'revoke'])
})

it('AC2/3/4: uppercase UUID spelling revokes the same active grant without weakening stale-regrant protection', async () => {
  const first = await granted()
  expect((await revoke(first.id.toUpperCase())).status).toBe(200)
  const after = await state()
  expect(skill(after)).toMatchObject({ access: false, accessOverride: null })
  expect(after.overrideHistory.map((e: any) => e.action)).toEqual(['grant', 'revoke'])
  const next = await granted()
  expect((await revoke(first.id.toUpperCase())).status).toBe(409)
  expect(skill(await state()).accessOverride.id).toBe(next.id)
  expect((await revoke(next.id.toUpperCase())).status).toBe(200)
})

it('AC1/3: revocation reevaluates current ordinary rules instead of blindly locking', async () => {
  const record = await granted()
  // Ordinary prerequisites and threshold become satisfied through real requests.
  await db.update(versionTasks).set({ xpReward: 20 }).where(and(eq(versionTasks.learningPathVersionId, fx.versions.version1.id), eq(versionTasks.taskId, fx.content.taskA.id)))
  const sent = await send(fx.content.taskA.id)
  expect(sent.status).toBe(201)
  const id = (await sent.json() as any).revision.id
  expect((await request(`${submissionPath(fx.content.taskA.id)}/revisions/${id}/review`, 'coach', 'POST', { decision: 'approval' })).status).toBe(201)
  const before = await state()
  expect((await revoke(record.id)).status).toBe(200)
  const after = await state()
  expect(skill(after)).toMatchObject({ access: true, accessOverride: null, xpShortfall: 0, unmetPrerequisiteSkillIds: [] })
  expect(after.xp).toBe(20)
  expect(after.xpHistory).toEqual(before.xpHistory)
  expect(after.masteryHistory).toEqual(before.masteryHistory)
  expect((await send()).status).toBe(201)
})

it('AC1: Override never bypasses inactive Enrollment (lifecycle API deferred)', async () => {
  const record = await granted()
  await db.update(enrollments).set({ status: 'inactive' }).where(eq(enrollments.id, enrollmentId))
  expect(skill(await state())).toMatchObject({ access: false, accessOverride: record })
  expect((await send()).status).toBe(403)
  expect((await revoke(record.id)).status).toBe(200)
  const next = await granted()
  expect((await state()).enrollmentStatus).toBe('inactive')
  expect(skill(await state())).toMatchObject({ access: false, accessOverride: next })
  expect((await send()).status).toBe(403)
})

it('AC2/5: records survive fresh connection and database rejects audit rewrite/delete', async () => {
  const record = await granted()
  expect((await revoke(record.id)).status).toBe(200)
  const before = await state()
  await expect(Promise.resolve(db.execute(sql`update override_records set reason = 'Rewritten' where id = ${record.id}`))).rejects.toThrow()
  await expect(Promise.resolve(db.execute(sql`delete from override_records where id = ${record.id}`))).rejects.toThrow()
  expect(await state()).toEqual(before)
  const other = createDatabase(TEST_DATABASE_URL)
  try {
    const fresh = createApp({ db: other.db, identity: fixtureIdentity(fx.identities) })
    const response = await fresh.request(`/enrollments/${enrollmentId}/learning-state`, { headers: { [FIXTURE_IDENTITY_HEADER]: 'learner' } })
    expect(response.status).toBe(200)
    expect((await response.json() as any).learningState).toEqual(before)
  } finally { await other.close() }
})

it('AC2/4/5: late record storage failure rolls back grant and revoke with no state or audit effect', async () => {
  const before = await state()
  await db.execute(sql`create function test_fail_override() returns trigger language plpgsql as $$ begin raise exception 'late override storage failure'; end $$`)
  await db.execute(sql`create trigger test_fail_override after insert on override_records for each row execute function test_fail_override()`)
  try {
    expect((await grant()).status).toBe(500)
    expect(await state()).toEqual(before)
  } finally { await db.execute(sql`drop trigger test_fail_override on override_records`) }
  const record = await granted(), active = await state()
  await db.execute(sql`create trigger test_fail_override after insert on override_records for each row execute function test_fail_override()`)
  try {
    expect((await revoke(record.id)).status).toBe(500)
    expect(await state()).toEqual(active)
    expect((await send()).status).toBe(201)
  } finally {
    await db.execute(sql`drop trigger test_fail_override on override_records`)
    await db.execute(sql`drop function test_fail_override()`)
  }
  expect((await revoke(record.id)).status).toBe(200)
  expect(skill(await state()).access).toBe(false)
})

async function waitForBlockedBy(blocker: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const rows = await db.execute<{ pid: number }>(sql`select pid from pg_stat_activity where ${blocker} = any(pg_blocking_pids(pid))`)
    if (rows.length) return rows[0].pid
    await Bun.sleep(5)
  }
  throw new Error(`No PostgreSQL-observed wait on backend ${blocker}`)
}
/** Pause the first request inside its Enrollment lock and observe the second waiting. */
async function orderedRequests(table: 'override_records' | 'submission_revisions', first: () => Promise<Response>, second: () => Promise<Response>) {
  const other = createDatabase(TEST_DATABASE_URL, 1)
  let release!: () => void, ready!: (pid: number) => void
  const barrier = new Promise<void>((resolve) => { release = resolve })
  const locked = new Promise<number>((resolve) => { ready = resolve })
  await db.execute(sql`create function test_pause_override() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(91012); return NEW; end $$`)
  await db.execute(sql`create trigger test_pause_override before insert on ${sql.raw(table)} for each row execute function test_pause_override()`)
  const locker = other.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(91012)`)
    const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
    ready(row.pid)
    await barrier
  })
  let pendingFirst: Promise<Response> | undefined, pendingSecond: Promise<Response> | undefined
  try {
    const pid = await locked
    pendingFirst = first()
    const firstPid = await waitForBlockedBy(pid)
    pendingSecond = second()
    await waitForBlockedBy(firstPid)
    release()
    await locker
    return await Promise.all([pendingFirst, pendingSecond])
  } finally {
    release()
    await locker
    await Promise.allSettled([pendingFirst, pendingSecond].filter((p) => p !== undefined))
    await db.execute(sql`drop trigger test_pause_override on ${sql.raw(table)}`)
    await db.execute(sql`drop function test_pause_override()`)
    await other.close()
  }
}

it('AC1/5: observed grant-before-send lock order opens both gates only after committed grant', async () => {
  const [granted, sent] = await orderedRequests('override_records', () => grant(), () => send())
  expect([granted.status, sent.status]).toEqual([201, 201])
  const record = (await granted.json() as any).overrideRecord
  expect(skill(await state()).accessOverride).toEqual(record)
  expect((await (await request(submissionPath())).json() as any).submission.revisions).toHaveLength(1)
})

for (const order of ['revoke-first', 'send-first'] as const) it(`AC1/3/5: observed ${order} lock order preserves eligible work and blocks later sends`, async () => {
  const record = await granted()
  const responses = order === 'revoke-first'
    ? await orderedRequests('override_records', () => revoke(record.id), () => send())
    : await orderedRequests('submission_revisions', () => send(), () => revoke(record.id))
  expect(responses.map((r) => r.status)).toEqual(order === 'revoke-first' ? [200, 403] : [201, 200])
  const after = await state()
  expect(skill(after).access).toBe(false)
  expect(after.overrideHistory.map((e: any) => e.action)).toEqual(['grant', 'revoke'])
  expect(after.xp).toBe(0)
  if (order === 'send-first') {
    const id = (await responses[0].json() as any).revision.id
    expect((await approve(id)).status).toBe(201)
    expect(skill(await state())).toMatchObject({ access: false, mastery: true })
  } else {
    const missing = await request(submissionPath())
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'submission_not_found' })
  }
  expect((await send()).status).toBe(403)
})

it('AC2/5: learning-state read waits for revocation commit and returns coherent current exception/history', async () => {
  const record = await granted()
  const [revoked, read] = await orderedRequests('override_records', () => revoke(record.id), () => request(`/enrollments/${enrollmentId}/learning-state`))
  expect([revoked.status, read.status]).toEqual([200, 200])
  const after = (await read.json() as any).learningState
  expect(skill(after)).toMatchObject({ access: false, accessOverride: null, xpShortfall: 20, unmetPrerequisiteSkillIds: [fx.content.skillA.id] })
  expect(after.overrideHistory.map((e: any) => e.action)).toEqual(['grant', 'revoke'])
  expect(after.xp).toBe(0)
})
