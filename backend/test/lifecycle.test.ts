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
})
type Actor = keyof EnrollmentFixture['identities'] | null
async function request(path: string, actor: Actor = 'learner', method = 'GET', body?: unknown) {
  return app.request(path, { method, headers: { ...(actor ? { [FIXTURE_IDENTITY_HEADER]: actor } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
}
const change = (action = 'deactivate', actor: Actor = 'coach', body: unknown = { reason: 'Participation paused.' }, id = enrollmentId) => request(`/enrollments/${id}/${action}`, actor, 'POST', body)
const taskPath = (task = fx.content.taskA.id) => `/enrollments/${enrollmentId}/tasks/${task}`
const start = (task = fx.content.taskA.id, actor: Actor = 'learner') => request(`${taskPath(task)}/start`, actor, 'POST')
const send = (task = fx.content.taskA.id) => request(`${taskPath(task)}/submission/revisions`, 'learner', 'POST', { text: 'Eligible evidence' })
const review = (id: string, decision = 'approval', task = fx.content.taskA.id) => request(`${taskPath(task)}/submission/revisions/${id}/review`, 'coach', 'POST', { decision, feedback: decision === 'changes_requested' ? 'Please explain.' : null })
async function state(actor: Actor = 'learner') {
  const response = await request(`/enrollments/${enrollmentId}/learning-state`, actor)
  expect(response.status).toBe(200)
  return (await response.json() as any).learningState
}

it('AC1: owning Coach deactivates with automatic immutable-context audit and mandatory reason', async () => {
  const before = await state()
  const response = await change('deactivate', 'coach', { reason: '  Taking a break.  ', actorAccountId: fx.accounts.otherCoach.id, learnerAccountId: fx.accounts.peer.id, enrollmentId: crypto.randomUUID(), learningPathVersionId: fx.versions.version2.id, action: 'reactivate', occurredAt: '2000-01-01' })
  expect(response.status).toBe(200)
  const { enrollment, lifecycleRecord } = await response.json() as any
  expect(enrollment).toMatchObject({ id: enrollmentId, status: 'inactive', learningPathVersionId: fx.versions.version1.id })
  expect(lifecycleRecord).toMatchObject({ enrollmentId, learningPathVersionId: fx.versions.version1.id, actorAccountId: fx.accounts.coach.id, learnerAccountId: fx.accounts.learner.id, action: 'deactivate', reason: '  Taking a break.  ' })
  expect(Date.parse(lifecycleRecord.occurredAt)).toBeGreaterThan(Date.parse('2026-01-01'))
  const after = await state()
  expect(after.lifecycleHistory).toEqual([lifecycleRecord])
  expect(after.xpHistory).toEqual(before.xpHistory)
  expect(after.masteryHistory).toEqual(before.masteryHistory)
  expect(await state('coach')).toEqual(after)
})

it('AC1/5: learner self-deactivates without reason; only owner explicitly resumes the same participation', async () => {
  const before = (await (await request(`/enrollments/${enrollmentId}`)).json() as any).enrollment
  expect((await change('deactivate', 'learner', {})).status).toBe(200)
  expect((await state()).lifecycleHistory[0]).toMatchObject({ actorAccountId: fx.accounts.learner.id, reason: null })
  for (const actor of ['learner', 'peer', 'otherCoach', 'unrelated', null] as const) expect((await change('reactivate', actor)).status).toBe(actor === 'learner' ? 403 : actor === null ? 401 : 404)
  expect((await change('reactivate', 'coach', { reason: 'Ready to resume.' })).status).toBe(200)
  const after = (await (await request(`/enrollments/${enrollmentId}`)).json() as any).enrollment
  expect(after).toEqual(before)
  expect((await state()).lifecycleHistory.map((r: any) => r.action)).toEqual(['deactivate', 'reactivate'])
})

it('AC2: explicit Task starts persist once and inactivity blocks starts and previously unstarted drafts', async () => {
  expect((await start()).status).toBe(201)
  const before = await state()
  expect(before.taskStarts).toEqual([expect.objectContaining({ enrollmentId, taskId: fx.content.taskA.id, learningPathVersionId: fx.versions.version1.id })])
  expect((await start()).status).toBe(200)
  expect((await change()).status).toBe(200)
  for (const task of [fx.content.taskA.id, fx.content.taskB.id]) {
    expect((await start(task)).status).toBe(403)
    expect((await send(task)).status).toBe(403)
  }
  expect((await request(`${taskPath(fx.content.taskB.id)}/draft`, 'learner', 'PUT', { text: 'New activity' })).status).toBe(403)
  expect((await request(`${taskPath()}/draft`, 'learner', 'PUT', { text: 'Private ongoing work' })).status).toBe(200)
  expect((await state()).taskStarts).toEqual(before.taskStarts)
})

it('AC3/4: inactive assessment retains old Approval and privacy; eligible pending work still awards XP/Mastery', async () => {
  await db.update(versionTasks).set({ xpReward: 20 }).where(and(eq(versionTasks.learningPathVersionId, fx.versions.version1.id), eq(versionTasks.taskId, fx.content.taskA.id)))
  await db.update(versionTasks).set({ xpReward: 7 }).where(and(eq(versionTasks.learningPathVersionId, fx.versions.version1.id), eq(versionTasks.taskId, fx.content.taskB.id)))
  const old = (await (await send()).json() as any).revision.id
  expect((await review(old)).status).toBe(201)
  const superseded = (await (await send(fx.content.taskB.id)).json() as any).revision.id
  const pending = (await (await send(fx.content.taskB.id)).json() as any).revision.id
  expect((await request(`${taskPath()}/draft`, 'learner', 'PUT', { text: 'Unsent learner secret' })).status).toBe(200)
  const before = await state(), history = await (await request(`${taskPath()}/submission`)).json(), draft = await (await request(`${taskPath()}/draft`)).json()
  expect(before.xp).toBe(20)
  expect((await change()).status).toBe(200)
  const after = await state()
  expect(after.tasks).toEqual(before.tasks)
  expect(after.xp).toBe(before.xp)
  expect(after.xpHistory).toEqual(before.xpHistory)
  expect(after.masteryHistory).toEqual(before.masteryHistory)
  for (const actor of ['learner', 'coach'] as const) {
    expect(await (await request(`${taskPath()}/submission`, actor)).json()).toEqual(history)
    expect((await request(`/enrollments/${enrollmentId}`, actor)).status).toBe(200)
  }
  expect(await (await request(`${taskPath()}/draft`)).json()).toEqual(draft)
  expect((await request(`${taskPath()}/draft`, 'coach')).status).toBe(403)
  expect((await send()).status).toBe(403)
  expect((await review(superseded, 'approval', fx.content.taskB.id)).status).toBe(409)
  expect((await review(pending, 'approval', fx.content.taskB.id)).status).toBe(201)
  expect((await state()).skills.every((s: any) => s.mastery && !s.access)).toBe(true)
  expect((await state()).enrollmentStatus).toBe('inactive')
  expect((await state()).xp).toBe(27)
  expect((await state()).xpHistory.map((e: any) => e.amount)).toEqual([20, 7])
  expect((await state()).masteryHistory).toHaveLength(2)
  const secret = await (await request(`/enrollments/${enrollmentId}/learning-state`, 'coach')).text()
  expect(secret).not.toContain('Unsent learner secret')
  for (const actor of ['peer', 'otherCoach', 'unrelated', null] as const) for (const path of [`/enrollments/${enrollmentId}`, `/enrollments/${enrollmentId}/learning-state`, `${taskPath()}/draft`, `${taskPath()}/submission`]) expect((await request(path, actor)).status).toBe(actor === null ? 401 : 404)
})

it('AC2/5: overrides and invitation admission never reactivate; resumption reevaluates current gates', async () => {
  await db.update(versionSkills).set({ xpThreshold: 20 }).where(and(eq(versionSkills.learningPathVersionId, fx.versions.version1.id), eq(versionSkills.skillId, fx.content.skillB.id)))
  await db.insert(versionPrerequisites).values({ learningPathVersionId: fx.versions.version1.id, prerequisiteSkillId: fx.content.skillA.id, skillId: fx.content.skillB.id })
  expect((await start(fx.content.taskB.id)).status).toBe(403)
  const overridePath = `/enrollments/${enrollmentId}/skills/${fx.content.skillB.id}/access-overrides`
  const grant = (await (await request(overridePath, 'coach', 'POST', { reason: 'Prior knowledge.' })).json() as any).overrideRecord
  expect((await send(fx.content.taskB.id)).status).toBe(201)
  expect((await change('deactivate', 'learner', {})).status).toBe(200)
  expect((await start(fx.content.taskB.id)).status).toBe(403)
  expect((await send(fx.content.taskB.id)).status).toBe(403)
  for (const invitation of [fx.invitations.toLearner, fx.invitations.toLearnerAgain]) {
    const accepted = await request(`/invitations/${invitation.id}/accept`, 'learner', 'POST')
    expect(accepted.status).toBe(200)
    expect((await accepted.json() as any).enrollment).toMatchObject({ id: enrollmentId, status: 'inactive' })
  }
  expect((await request(`/invitations/${fx.invitations.toLearnerClosed.id}/accept`, 'learner', 'POST')).status).toBe(409)
  expect((await request(`${overridePath}/${grant.id}/revoke`, 'coach', 'POST', { reason: 'Current rules apply.' })).status).toBe(200)
  expect((await change('reactivate')).status).toBe(200)
  expect((await state()).skills.find((s: any) => s.skillId === fx.content.skillB.id)).toMatchObject({ access: false, xpShortfall: 20, unmetPrerequisiteSkillIds: [fx.content.skillA.id] })
  expect((await start(fx.content.taskB.id)).status).toBe(403)
  expect((await send(fx.content.taskB.id)).status).toBe(403)
  expect((await start()).status).toBe(201)
})

it('AC1: learner can stop without any JSON body, but supplied invalid reasons never commit', async () => {
  expect((await request(`/enrollments/${enrollmentId}/deactivate`, 'learner', 'POST')).status).toBe(200)
  expect((await state()).lifecycleHistory[0].reason).toBeNull()
  expect((await change('reactivate')).status).toBe(200)
  const before = await state()
  for (const actor of ['coach', 'learner'] as const) {
    for (const body of [null, [], { reason: 2 }, { reason: '' }, { reason: ' \n\t' }, { reason: 'x'.repeat(501) }]) expect((await change('deactivate', actor, body)).status).toBe(422)
    expect((await app.request(`/enrollments/${enrollmentId}/deactivate`, { method: 'POST', headers: { [FIXTURE_IDENTITY_HEADER]: actor, 'content-type': 'application/json' }, body: '{broken' })).status).toBe(422)
  }
  expect((await change('deactivate', 'coach', {})).status).toBe(422)
  expect(await state()).toEqual(before)
  expect((await change('deactivate', 'learner', { reason: 'x'.repeat(500) })).status).toBe(200)
  const inactive = await state()
  for (const body of [null, {}, [], { reason: false }, { reason: '' }, { reason: ' \n\t' }, { reason: 'x'.repeat(501) }]) expect((await change('reactivate', 'coach', body)).status).toBe(422)
  expect(await state()).toEqual(inactive)
  expect((await change('reactivate', 'coach', { reason: 'x'.repeat(500) })).status).toBe(200)
})

it('AC1/5/6: scoped actors and malformed targets reject without changing other Enrollments', async () => {
  const peer = (await (await request(`/invitations/${fx.invitations.toPeer.id}/accept`, 'peer', 'POST')).json() as any).enrollment.id
  const [other] = await db.insert(enrollments).values({ accountId: fx.accounts.learner.id, learningPathVersionId: fx.versions.version2.id }).returning()
  const before = await state()
  for (const action of ['deactivate', 'reactivate']) {
    for (const actor of ['peer', 'otherCoach', 'unrelated', null] as const) expect((await change(action, actor)).status).toBe(actor === null ? 401 : 404)
    for (const id of ['invalid', crypto.randomUUID(), fx.versions.version1.id]) expect((await change(action, 'coach', undefined, id)).status).toBe(404)
  }
  expect((await change('deactivate', 'learner', {}, peer)).status).toBe(404)
  expect((await start(fx.content.taskA.id, 'coach')).status).toBe(403)
  for (const actor of ['peer', 'otherCoach', 'unrelated', null] as const) expect((await start(fx.content.taskA.id, actor)).status).toBe(actor === null ? 401 : 404)
  for (const id of ['invalid', crypto.randomUUID(), fx.content.skillA.id]) expect((await start(id)).status).toBe(404)
  expect(await state()).toEqual(before)
  expect((await change()).status).toBe(200)
  for (const [id, actor] of [[peer, 'peer'], [other.id, 'learner']] as const) {
    expect((await (await request(`/enrollments/${id}`, actor)).json() as any).enrollment.status).toBe('active')
    expect((await (await request(`/enrollments/${id}/learning-state`, actor)).json() as any).learningState.lifecycleHistory).toEqual([])
  }
})

it('AC1/5/6: duplicate and concurrent transitions produce one status change and one audit record', async () => {
  expect((await change('reactivate')).status).toBe(409)
  const stops = await Promise.all([change(), change('deactivate', 'learner', {})])
  expect(stops.map((r) => r.status).sort()).toEqual([200, 409])
  expect((await change()).status).toBe(409)
  const resumes = await Promise.all([change('reactivate'), change('reactivate')])
  expect(resumes.map((r) => r.status).sort()).toEqual([200, 409])
  expect((await change('reactivate')).status).toBe(409)
  const history = (await state()).lifecycleHistory
  expect(history.map((r: any) => r.action)).toEqual(['deactivate', 'reactivate'])
  expect(history[1].sequence).toBeGreaterThan(history[0].sequence)
  expect(Date.parse(history[1].occurredAt)).toBeGreaterThanOrEqual(Date.parse(history[0].occurredAt))
  const starts = await Promise.all([start(), start()])
  expect(starts.map((r) => r.status).sort()).toEqual([200, 201])
  expect((await state()).taskStarts).toHaveLength(1)
})

it('AC3/5: Changes Requested stays reviewable while inactive; corrections await explicit resumption', async () => {
  const sent = (await (await send()).json() as any).revision.id
  expect((await change()).status).toBe(200)
  expect((await review(sent, 'changes_requested')).status).toBe(201)
  expect((await send()).status).toBe(403)
  expect((await state()).xp).toBe(0)
  expect((await change('reactivate')).status).toBe(200)
  expect((await send()).status).toBe(201)
})

it('AC3/5: inactive Approval opens ordinary gates on reactivation without resetting progress', async () => {
  await db.update(versionTasks).set({ xpReward: 20 }).where(and(eq(versionTasks.learningPathVersionId, fx.versions.version1.id), eq(versionTasks.taskId, fx.content.taskA.id)))
  await db.update(versionSkills).set({ xpThreshold: 20 }).where(and(eq(versionSkills.learningPathVersionId, fx.versions.version1.id), eq(versionSkills.skillId, fx.content.skillB.id)))
  await db.insert(versionPrerequisites).values({ learningPathVersionId: fx.versions.version1.id, prerequisiteSkillId: fx.content.skillA.id, skillId: fx.content.skillB.id })
  const sent = (await (await send()).json() as any).revision.id
  expect((await change()).status).toBe(200)
  expect((await review(sent)).status).toBe(201)
  const inactive = await state()
  expect(inactive.xp).toBe(20)
  expect(inactive.skills.find((s: any) => s.skillId === fx.content.skillB.id)).toMatchObject({ access: false, xpShortfall: 0, unmetPrerequisiteSkillIds: [] })
  expect((await change('reactivate')).status).toBe(200)
  const active = await state()
  expect(active.xpHistory).toEqual(inactive.xpHistory)
  expect(active.masteryHistory).toEqual(inactive.masteryHistory)
  expect(active.tasks).toEqual(inactive.tasks)
  expect((await start(fx.content.taskB.id)).status).toBe(201)
  expect((await send(fx.content.taskB.id)).status).toBe(201)
})

it('AC4/5/6: lifecycle, starts and private work persist through a fresh connection; audit rejects rewrites', async () => {
  expect((await start()).status).toBe(201)
  expect((await request(`${taskPath()}/draft`, 'learner', 'PUT', { text: 'Retained private work' })).status).toBe(200)
  expect((await change()).status).toBe(200)
  const before = await state()
  const id = before.lifecycleHistory[0].id
  await expect(Promise.resolve(db.execute(sql`update enrollment_lifecycle_records set reason = 'Rewrite' where id = ${id}`))).rejects.toThrow()
  await expect(Promise.resolve(db.execute(sql`delete from enrollment_lifecycle_records where id = ${id}`))).rejects.toThrow()
  const other = createDatabase(TEST_DATABASE_URL)
  try {
    const fresh = createApp({ db: other.db, identity: fixtureIdentity(fx.identities) })
    const read = async (path: string, actor = 'learner') => fresh.request(path, { headers: { [FIXTURE_IDENTITY_HEADER]: actor } })
    expect((await (await read(`/enrollments/${enrollmentId}/learning-state`)).json() as any).learningState).toEqual(before)
    expect((await (await read(`${taskPath()}/draft`)).json() as any).draft.text).toBe('Retained private work')
    expect((await read(`${taskPath()}/draft`, 'coach')).status).toBe(403)
    expect((await fresh.request(`/enrollments/${enrollmentId}/reactivate`, { method: 'POST', headers: { [FIXTURE_IDENTITY_HEADER]: 'coach', 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'Resume after reconnect.' }) })).status).toBe(200)
    expect((await state()).taskStarts).toEqual(before.taskStarts)
    expect((await state()).lifecycleHistory.map((r: any) => r.action)).toEqual(['deactivate', 'reactivate'])
  } finally { await other.close() }
})

it('AC1/5/6: late lifecycle audit failure rolls back both transitions and all persisted effects', async () => {
  await db.execute(sql`create function test_fail_lifecycle() returns trigger language plpgsql as $$ begin raise exception 'late lifecycle audit failure'; end $$`)
  const install = () => db.execute(sql`create trigger test_fail_lifecycle after insert on enrollment_lifecycle_records for each row execute function test_fail_lifecycle()`)
  const remove = () => db.execute(sql`drop trigger test_fail_lifecycle on enrollment_lifecycle_records`)
  const active = await state()
  await install()
  try {
    expect((await change()).status).toBe(500)
    expect(await state()).toEqual(active)
  } finally { await remove() }
  expect((await change()).status).toBe(200)
  const inactive = await state()
  await install()
  try {
    expect((await change('reactivate')).status).toBe(500)
    expect(await state()).toEqual(inactive)
    expect((await send()).status).toBe(403)
    expect((await start()).status).toBe(403)
  } finally { await remove(); await db.execute(sql`drop function test_fail_lifecycle()`) }
  expect((await change('reactivate')).status).toBe(200)
})

it('AC2/3/4/5: override-eligible work stays reviewable inactive and explicit resumption retains achievements and active exception', async () => {
  await db.update(versionSkills).set({ xpThreshold: 50 }).where(and(eq(versionSkills.learningPathVersionId, fx.versions.version1.id), eq(versionSkills.skillId, fx.content.skillB.id)))
  await db.insert(versionPrerequisites).values({ learningPathVersionId: fx.versions.version1.id, prerequisiteSkillId: fx.content.skillA.id, skillId: fx.content.skillB.id })
  await db.update(versionTasks).set({ xpReward: 7 }).where(and(eq(versionTasks.learningPathVersionId, fx.versions.version1.id), eq(versionTasks.taskId, fx.content.taskB.id)))
  const grant = (await (await request(`/enrollments/${enrollmentId}/skills/${fx.content.skillB.id}/access-overrides`, 'coach', 'POST', { reason: 'Recognize prior experience.' })).json() as any).overrideRecord
  expect((await start(fx.content.taskB.id)).status).toBe(201)
  expect((await request(`${taskPath(fx.content.taskB.id)}/draft`, 'learner', 'PUT', { text: 'Private retained B notes' })).status).toBe(200)
  const pending = (await (await send(fx.content.taskB.id)).json() as any).revision.id
  expect((await change('deactivate', 'learner', {})).status).toBe(200)
  expect((await review(pending, 'approval', fx.content.taskB.id)).status).toBe(201)
  const inactive = await state()
  expect(inactive.xp).toBe(7)
  expect(inactive.skills.find((s: any) => s.skillId === fx.content.skillB.id)).toMatchObject({ mastery: true, access: false, accessOverride: grant, xpShortfall: 43, unmetPrerequisiteSkillIds: [fx.content.skillA.id] })
  expect((await review(pending, 'approval', fx.content.taskB.id)).status).toBe(409)
  expect(await state()).toEqual(inactive)
  const work = await (await request(`${taskPath(fx.content.taskB.id)}/submission`)).json()
  const draft = await (await request(`${taskPath(fx.content.taskB.id)}/draft`)).json()
  expect((await change('reactivate', 'coach', { reason: 'Return with the existing exception.' })).status).toBe(200)
  const active = await state()
  expect(active.enrollmentId).toBe(enrollmentId)
  expect(active.learningPathVersionId).toBe(fx.versions.version1.id)
  expect(active.xp).toBe(inactive.xp)
  expect(active.tasks).toEqual(inactive.tasks)
  expect(active.xpHistory).toEqual(inactive.xpHistory)
  expect(active.masteryHistory).toEqual(inactive.masteryHistory)
  expect(active.overrideHistory).toEqual(inactive.overrideHistory)
  expect(active.taskStarts).toEqual(inactive.taskStarts)
  expect(active.skills.find((s: any) => s.skillId === fx.content.skillB.id)).toMatchObject({ mastery: true, access: true, accessOverride: grant, xpShortfall: 43, unmetPrerequisiteSkillIds: [fx.content.skillA.id] })
  expect(await (await request(`${taskPath(fx.content.taskB.id)}/submission`)).json()).toEqual(work)
  expect(await (await request(`${taskPath(fx.content.taskB.id)}/draft`)).json()).toEqual(draft)
  expect((await request(`${taskPath(fx.content.taskB.id)}/draft`, 'coach')).status).toBe(403)
  expect((await start(fx.content.taskB.id)).status).toBe(200)
  expect((await send(fx.content.taskB.id)).status).toBe(201)
  expect((await state()).xp).toBe(7)
})

it('AC1/5/6: owning-Coach authority is bounded to the target Workspace', async () => {
  const [path] = await db.execute<{ id: string }>(sql`insert into learning_paths (coach_workspace_id, title) values (${fx.workspaces.otherWorkspace.id}, 'Foreign Path') returning id`)
  const [version] = await db.execute<{ id: string }>(sql`insert into learning_path_versions (learning_path_id, version_number, published_at) values (${path.id}, 1, now()) returning id`)
  const [foreign] = await db.insert(enrollments).values({ accountId: fx.accounts.learner.id, learningPathVersionId: version.id }).returning()
  const local = await state()
  for (const action of ['deactivate', 'reactivate']) expect((await change(action, 'coach', undefined, foreign.id)).status).toBe(404)
  expect((await change('deactivate', 'otherCoach', { reason: 'Foreign participation paused.' }, foreign.id)).status).toBe(200)
  expect((await change('reactivate', 'coach', undefined, foreign.id)).status).toBe(404)
  expect((await change('reactivate', 'otherCoach', { reason: 'Foreign participation resumed.' }, foreign.id)).status).toBe(200)
  expect(await state()).toEqual(local)
  expect((await request(`/enrollments/${foreign.id}/learning-state`, 'coach')).status).toBe(404)
  expect((await (await request(`/enrollments/${foreign.id}/learning-state`, 'learner')).json() as any).learningState.lifecycleHistory).toHaveLength(2)
})

async function waitForBlockedBy(blocker: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const rows = await db.execute<{ pid: number }>(sql`select pid from pg_stat_activity where ${blocker} = any(pg_blocking_pids(pid))`)
    if (rows.length) return rows[0].pid
    await Bun.sleep(5)
  }
  throw new Error(`No PostgreSQL-observed wait on backend ${blocker}`)
}
/** Pause a real request after its Enrollment lock and observe the next request waiting. */
async function orderedRequests(table: 'enrollment_lifecycle_records' | 'submission_revisions' | 'task_starts', first: () => Promise<Response>, second: () => Promise<Response>) {
  const other = createDatabase(TEST_DATABASE_URL, 1)
  let release!: () => void, ready!: (pid: number) => void
  const barrier = new Promise<void>((resolve) => { release = resolve })
  const locked = new Promise<number>((resolve) => { ready = resolve })
  await db.execute(sql`create function test_pause_lifecycle() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(91013); return NEW; end $$`)
  await db.execute(sql`create trigger test_pause_lifecycle before insert on ${sql.raw(table)} for each row execute function test_pause_lifecycle()`)
  const locker = other.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(91013)`)
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
    await db.execute(sql`drop trigger test_pause_lifecycle on ${sql.raw(table)}`)
    await db.execute(sql`drop function test_pause_lifecycle()`)
    await other.close()
  }
}

for (const order of ['deactivate-first', 'send-first'] as const) it(`AC2/3/6: observed ${order} serialization blocks later sends and retains earlier eligible work`, async () => {
  const responses = order === 'deactivate-first'
    ? await orderedRequests('enrollment_lifecycle_records', () => change(), () => send())
    : await orderedRequests('submission_revisions', () => send(), () => change())
  expect(responses.map((r) => r.status)).toEqual(order === 'deactivate-first' ? [200, 403] : [201, 200])
  expect((await state()).enrollmentStatus).toBe('inactive')
  if (order === 'send-first') {
    const id = (await responses[0].json() as any).revision.id
    expect((await review(id)).status).toBe(201)
    expect((await state()).skills.find((s: any) => s.skillId === fx.content.skillA.id)).toMatchObject({ mastery: true, access: false })
  } else expect((await request(`${taskPath()}/submission`)).status).toBe(404)
  expect((await send()).status).toBe(403)
})

for (const order of ['deactivate-first', 'start-first'] as const) it(`AC2/6: observed ${order} serialization gives no new persisted starts after inactivity`, async () => {
  const responses = order === 'deactivate-first'
    ? await orderedRequests('enrollment_lifecycle_records', () => change(), () => start())
    : await orderedRequests('task_starts', () => start(), () => change())
  expect(responses.map((r) => r.status)).toEqual(order === 'deactivate-first' ? [200, 403] : [201, 200])
  expect((await state()).taskStarts).toHaveLength(order === 'deactivate-first' ? 0 : 1)
  expect((await start(fx.content.taskB.id)).status).toBe(403)
})

it('AC5/6: waiting send resumes only after explicit reactivation commit', async () => {
  expect((await change()).status).toBe(200)
  const [resumed, sent] = await orderedRequests('enrollment_lifecycle_records', () => change('reactivate'), () => send())
  expect([resumed.status, sent.status]).toEqual([200, 201])
  expect((await state()).lifecycleHistory.map((r: any) => r.action)).toEqual(['deactivate', 'reactivate'])
})

it('AC4/6: coherent read waits for deactivation commit and returns matching status/access/audit', async () => {
  const [stopped, read] = await orderedRequests('enrollment_lifecycle_records', () => change(), () => request(`/enrollments/${enrollmentId}/learning-state`))
  expect([stopped.status, read.status]).toEqual([200, 200])
  const observed = (await read.json() as any).learningState
  expect(observed.enrollmentStatus).toBe('inactive')
  expect(observed.skills.every((s: any) => !s.access)).toBe(true)
  expect(observed.lifecycleHistory).toHaveLength(1)
  expect(observed).toEqual(await state())
})
