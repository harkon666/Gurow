import { afterAll, beforeAll, beforeEach, expect, it } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'
import { createApp } from '../src/app'
import { createDatabase, type Database } from '../src/db/client'
import { versionTasks } from '../src/db/schema'
import { FIXTURE_IDENTITY_HEADER, fixtureIdentity } from '../src/identity'
import { waitForBlockedBy } from './support/blocking'
import { prepareTestDatabase, resetTestDatabase, TEST_DATABASE_URL } from './support/database'
import { seedEnrollmentFixture, seedPersonalFixture, type EnrollmentFixture, type PersonalFixture } from './support/fixtures'

let db: Database, close: () => Promise<void>, fx: EnrollmentFixture, px: PersonalFixture, app: ReturnType<typeof createApp>
beforeAll(async () => { ({ db, close } = await prepareTestDatabase()) })
afterAll(async () => { await close() })
beforeEach(async () => {
  await resetTestDatabase(db)
  fx = await seedEnrollmentFixture(db)
  px = await seedPersonalFixture(db, fx)
  app = createApp({ db, identity: fixtureIdentity(fx.identities) })
})

type Actor = keyof EnrollmentFixture['identities'] | null
async function request(path: string, actor: Actor = 'learner', method = 'GET', body?: unknown) {
  return app.request(path, { method, headers: { ...(actor ? { [FIXTURE_IDENTITY_HEADER]: actor } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
}
const base = (path = px.paths.main.id) => `/personal/learning-paths/${path}`
const taskUrl = (task: string, action: string, path?: string) => `${base(path)}/tasks/${task}/${action}`
const skillUrl = (skill: string, action: string, path?: string) => `${base(path)}/skills/${skill}/${action}`
const complete = (task = px.tasks.taskA.id, actor: Actor = 'learner', path?: string) => request(taskUrl(task, 'completion', path), actor, 'PUT')
const undo = (task = px.tasks.taskA.id, actor: Actor = 'learner', path?: string) => request(taskUrl(task, 'completion', path), actor, 'DELETE')
const reward = (xpReward: unknown, task = px.tasks.taskA.id, actor: Actor = 'learner', path?: string) => request(taskUrl(task, 'reward', path), actor, 'PUT', { xpReward })
const start = (task = px.tasks.taskB.id, actor: Actor = 'learner', path?: string) => request(taskUrl(task, 'start', path), actor, 'POST')
const archive = (task = px.tasks.taskA.id, actor: Actor = 'learner', path?: string) => request(taskUrl(task, 'archive', path), actor, 'POST')
const mastery = (declared: boolean, skill = px.skills.skillA.id, actor: Actor = 'learner', path?: string) => request(skillUrl(skill, 'mastery', path), actor, declared ? 'PUT' : 'DELETE')
const override = (granted: boolean, skill = px.skills.skillB.id, actor: Actor = 'learner', path?: string) => request(skillUrl(skill, 'access-override', path), actor, granted ? 'PUT' : 'DELETE')

async function state(path = px.paths.main.id, actor: Actor = 'learner') {
  const response = await request(`${base(path)}/learning-state`, actor)
  expect(response.status).toBe(200)
  const learningState = (await response.json() as any).learningState
  // The recorded history always explains the current total.
  expect(learningState.xpHistory.reduce((total: number, event: any) => total + event.amount, 0)).toBe(learningState.xp)
  return learningState
}
async function ok(response: Promise<Response>, changed = true) {
  const r = await response
  expect(r.status).toBe(200)
  const body = await r.json() as any
  expect(body.changed).toBe(changed)
  return body.learningState
}
const task = (s: any, id = px.tasks.taskA.id) => s.tasks.find((t: any) => t.taskId === id)
const skill = (s: any, id = px.skills.skillB.id) => s.skills.find((x: any) => x.skillId === id)
const xpEvents = (s: any) => s.xpHistory.map((e: any) => [e.taskId, e.kind, e.cause, e.amount])

it('AC1/6: only the personal owner can read or act; every other actor sees no Path and changes nothing', async () => {
  await ok(complete())
  await ok(mastery(true))
  const before = await state()
  const attempts = (actor: Actor, path = px.paths.main.id) => [
    request(`${base(path)}/learning-state`, actor), complete(px.tasks.taskA2.id, actor, path), undo(px.tasks.taskA.id, actor, path),
    reward(50, px.tasks.taskA.id, actor, path), start(px.tasks.taskB.id, actor, path), archive(px.tasks.taskA.id, actor, path),
    mastery(false, px.skills.skillA.id, actor, path), mastery(true, px.skills.skillB.id, actor, path),
    override(true, px.skills.skillB.id, actor, path), override(false, px.skills.skillB.id, actor, path),
  ]
  // The learner's Coach and the other Workspace's Coach get no Personal Workspace access either (ADR 0012).
  for (const actor of ['peer', 'coach', 'otherCoach', 'unrelated', 'unverified'] as const) {
    for (const response of await Promise.all(attempts(actor))) {
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'learning_path_not_found' })
    }
  }
  for (const response of await Promise.all(attempts(null))) expect(response.status).toBe(401)
  // Unknown, malformed and coach-mode Path IDs are equally absent; the learner cannot act on the peer's Path.
  for (const path of [crypto.randomUUID(), 'not-a-uuid', fx.paths.path.id, px.paths.peers.id]) {
    for (const response of await Promise.all(attempts('learner', path))) expect(response.status).toBe(404)
  }
  // Targets from another Path, malformed targets and Skill/Task ID swaps are not found inside an owned Path.
  for (const [response, error] of [
    [await complete(px.tasks.otherTask.id), 'task_not_found'], [await complete('not-a-uuid'), 'task_not_found'],
    [await reward(1, px.skills.skillA.id), 'task_not_found'], [await mastery(true, px.tasks.taskA.id), 'skill_not_found'],
    [await override(true, px.skills.otherSkill.id), 'skill_not_found'], [await start(fx.content.taskA.id), 'task_not_found'],
  ] as const) {
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: error })
  }
  expect(await state()).toEqual(before)
  expect(await state(px.paths.peers.id, 'peer')).toMatchObject({ xp: 0, xpHistory: [], masteryHistory: [], overrideHistory: [] })
  // The owner of the other Path still acts normally there.
  expect((await ok(complete(px.tasks.peerTask.id, 'peer', px.paths.peers.id))).xp).toBe(30)
  expect(await state()).toEqual(before)
})

it('AC1: Mastery is declared or left unclaimed freely; completion needs no evidence and never declares Mastery', async () => {
  // Completing every Task of A with no body, evidence or Review earns XP but leaves Mastery unclaimed.
  await ok(complete(px.tasks.taskA.id))
  let s = await ok(complete(px.tasks.taskA2.id))
  expect(s.xp).toBe(30)
  expect(skill(s, px.skills.skillA.id)).toMatchObject({ mastery: false, masteryDeclaredAt: null })
  expect(s.masteryHistory).toEqual([])
  // A locked Skill can be declared mastered without evidence or Access; that grants no XP or Access.
  s = await ok(mastery(true, px.skills.skillB.id))
  expect(skill(s)).toMatchObject({ mastery: true, access: false, unmetPrerequisiteSkillIds: [px.skills.skillA.id] })
  expect(s.xp).toBe(30)
  expect(s.xpHistory).toHaveLength(2)
  await ok(mastery(true, px.skills.skillB.id), false)
  s = await ok(mastery(false, px.skills.skillB.id))
  await ok(mastery(false, px.skills.skillB.id), false)
  expect(skill(s)).toMatchObject({ mastery: false, masteryDeclaredAt: null })
  expect(s.masteryHistory.map((e: any) => [e.skillId, e.action, e.actorAccountId])).toEqual([
    [px.skills.skillB.id, 'declare', fx.accounts.learner.id], [px.skills.skillB.id, 'withdraw', fx.accounts.learner.id],
  ])
  // Declaring A's Mastery satisfies B's Prerequisite; B's XP Threshold is already met by Path XP.
  s = await ok(mastery(true, px.skills.skillA.id))
  expect(skill(s)).toMatchObject({ access: true, unmetPrerequisiteSkillIds: [], xpShortfall: 0 })
  expect(s.xp).toBe(30)
  expect(await state()).toEqual(s)
})

it('AC2: a completed Task contributes its current reward once; incomplete Tasks contribute zero', async () => {
  let s = await state()
  expect(s.xp).toBe(0)
  expect(s.tasks.map((t: any) => [t.completed, t.xpContribution])).toEqual(s.tasks.map(() => [false, 0]))
  s = await ok(complete())
  for (let i = 0; i < 3; i++) s = await ok(complete(), false)
  const concurrent = await Promise.all(Array.from({ length: 6 }, () => complete(px.tasks.taskA2.id)))
  const bodies = await Promise.all(concurrent.map(async (r) => { expect(r.status).toBe(200); return (await r.json() as any).changed }))
  expect(bodies.filter(Boolean)).toHaveLength(1)
  s = await state()
  expect(s.xp).toBe(30)
  expect(task(s)).toMatchObject({ completed: true, xpReward: 20, xpContribution: 20 })
  expect(task(s, px.tasks.taskA2.id)).toMatchObject({ completed: true, xpContribution: 10 })
  expect(task(s, px.tasks.taskB.id)).toMatchObject({ completed: false, xpContribution: 0 })
  expect(xpEvents(s)).toEqual([[px.tasks.taskA.id, 'award', 'completion', 20], [px.tasks.taskA2.id, 'award', 'completion', 10]])
  expect(s.xpHistory.every((e: any) => e.actorAccountId === fx.accounts.learner.id && e.learningPathId === px.paths.main.id)).toBe(true)
  // Repeated undo likewise removes the contribution only once.
  const undone = await Promise.all(Array.from({ length: 4 }, () => undo()))
  expect((await Promise.all(undone.map(async (r) => (await r.json() as any).changed))).filter(Boolean)).toHaveLength(1)
  s = await state()
  expect(s.xp).toBe(10)
  expect(xpEvents(s).at(-1)).toEqual([px.tasks.taskA.id, 'correction', 'completion_undone', -20])
})

it('AC3/5: 20→50 on a completed Task records +30; undo removes 50; completing restores 50; incomplete edits stay zero; Mastery untouched', async () => {
  await ok(mastery(true))
  const declared = (await state()).masteryHistory
  await ok(complete())
  let s = await ok(reward(50))
  expect(s.xp).toBe(50)
  expect(task(s)).toMatchObject({ xpReward: 50, xpContribution: 50 })
  await ok(reward(50), false)
  s = await ok(undo())
  expect(s.xp).toBe(0)
  s = await ok(complete())
  expect(s.xp).toBe(50)
  expect(xpEvents(s)).toEqual([
    [px.tasks.taskA.id, 'award', 'completion', 20], [px.tasks.taskA.id, 'correction', 'reward_change', 30],
    [px.tasks.taskA.id, 'correction', 'completion_undone', -50], [px.tasks.taskA.id, 'correction', 'completion', 50],
  ])
  // Lowering a completed reward corrects by the (negative) difference; zero reward contributes nothing.
  s = await ok(reward(0))
  expect(s.xp).toBe(0)
  s = await ok(undo())
  s = await ok(complete())
  expect(xpEvents(s).slice(4)).toEqual([[px.tasks.taskA.id, 'correction', 'reward_change', -50]])
  s = await ok(reward(50))
  expect(xpEvents(s).at(-1)).toEqual([px.tasks.taskA.id, 'correction', 'reward_change', 50])
  // An incomplete Task's reward edits record nothing and leave its contribution zero.
  for (const value of [40, 0, 70]) {
    s = await ok(reward(value, px.tasks.taskA2.id))
    expect(task(s, px.tasks.taskA2.id)).toMatchObject({ xpReward: value, completed: false, xpContribution: 0 })
  }
  expect(s.xp).toBe(50)
  s = await ok(complete(px.tasks.taskA2.id))
  expect(s.xp).toBe(120)
  expect(xpEvents(s).at(-1)).toEqual([px.tasks.taskA2.id, 'award', 'completion', 70])
  // None of these corrections changed declared Mastery.
  expect(skill(s, px.skills.skillA.id)).toMatchObject({ mastery: true })
  expect(s.masteryHistory).toEqual(declared)
  for (const body of [null, {}, { xpReward: -1 }, { xpReward: 1.5 }, { xpReward: '50' }, { xpReward: 1_000_001 }, { xpReward: null }]) {
    const r = await request(taskUrl(px.tasks.taskA.id, 'reward'), 'learner', 'PUT', body)
    expect(r.status).toBe(422)
    expect(await r.json()).toEqual({ error: 'invalid_reward' })
  }
  expect(await state()).toEqual(s)
})

it('AC4: Path-local XP Thresholds relock started work; an explicit override waives both gates without a reason or score change', async () => {
  // XP from another personal Path never counts toward this Path's thresholds.
  expect((await ok(complete(px.tasks.otherTask.id, 'learner', px.paths.other.id))).xp).toBe(100)
  await ok(mastery(true))
  let s = await state()
  expect(skill(s)).toMatchObject({ access: false, xpShortfall: 20, unmetPrerequisiteSkillIds: [] })
  expect((await start()).status).toBe(403)
  expect(await (await complete(px.tasks.taskB.id)).json()).toEqual({ error: 'skill_locked' })
  s = await ok(complete())
  expect(skill(s)).toMatchObject({ access: true, xpShortfall: 0 })
  s = await ok(start())
  const startedAt = task(s, px.tasks.taskB.id).startedAt
  expect(startedAt).not.toBeNull()
  // Undoing A's completion lowers current Path XP and relocks B although its work has started.
  s = await ok(undo())
  expect(skill(s)).toMatchObject({ access: false, xpShortfall: 20, mastery: false })
  expect(skill(s, px.skills.skillA.id)).toMatchObject({ mastery: true })
  expect(task(s, px.tasks.taskB.id)).toMatchObject({ startedAt, completed: false })
  expect((await complete(px.tasks.taskB.id)).status).toBe(403)
  await ok(start(), false)
  // Withdrawing A's Mastery leaves B behind both gates; the override waives both with no body or reason.
  await ok(mastery(false))
  const locked = await state()
  expect(skill(locked)).toMatchObject({ access: false, xpShortfall: 20, unmetPrerequisiteSkillIds: [px.skills.skillA.id] })
  s = await ok(override(true))
  const grant = skill(s).accessOverride
  expect(grant).toMatchObject({ action: 'grant', actorAccountId: fx.accounts.learner.id, learningPathId: px.paths.main.id, skillId: px.skills.skillB.id })
  expect(grant).not.toHaveProperty('reason')
  expect(skill(s)).toMatchObject({ access: true, mastery: false, xpShortfall: 20, unmetPrerequisiteSkillIds: [px.skills.skillA.id] })
  expect(skill(s, px.skills.skillA.id)).toEqual(skill(locked, px.skills.skillA.id))
  expect([s.xp, s.tasks, s.xpHistory, s.masteryHistory]).toEqual([locked.xp, locked.tasks, locked.xpHistory, locked.masteryHistory])
  await ok(override(true), false)
  const storedStart = () => db.execute<{ at: string }>(sql`select started_at::text as at from personal_tasks where task_id = ${px.tasks.taskB.id}`)
  const [retained] = await storedStart()
  s = await ok(complete(px.tasks.taskB.id))
  // Completing keeps the first start exactly, at PostgreSQL precision.
  expect(await storedStart()).toEqual([retained])
  expect(s.xp).toBe(5)
  expect(skill(s)).toMatchObject({ mastery: false })
  // Revoking returns B to the ordinary rules while its completed work and contribution stay.
  s = await ok(override(false))
  await ok(override(false), false)
  expect(skill(s)).toMatchObject({ access: false, accessOverride: null, xpShortfall: 15 })
  expect(task(s, px.tasks.taskB.id)).toMatchObject({ completed: true, xpContribution: 5 })
  expect(s.overrideHistory.map((r: any) => r.action)).toEqual(['grant', 'revoke'])
  expect(s.masteryHistory.map((e: any) => e.action)).toEqual(['declare', 'withdraw'])
  expect((await state(px.paths.other.id)).xp).toBe(100)
})

it('AC5: archiving a completed Task keeps its contribution, Mastery, history and privacy; there is no restoration', async () => {
  await ok(mastery(true))
  await ok(complete())
  await ok(reward(50))
  const before = await state()
  let s = await ok(archive())
  const archived = task(s)
  expect(archived).toMatchObject({ completed: true, xpReward: 50, xpContribution: 50 })
  expect(archived.archivedAt).not.toBeNull()
  expect([s.xp, s.xpHistory, s.masteryHistory, s.overrideHistory, s.skills]).toEqual([before.xp, before.xpHistory, before.masteryHistory, before.overrideHistory, before.skills])
  // The retained contribution still opens B.
  expect(skill(s)).toMatchObject({ access: true, xpShortfall: 0 })
  await ok(archive(), false)
  for (const response of [await complete(), await undo(), await reward(20), await start(px.tasks.taskA.id)]) {
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'task_archived' })
  }
  expect((await request(taskUrl(px.tasks.taskA.id, 'archive'), 'learner', 'DELETE')).status).toBe(404)
  expect(await state()).toEqual(s)
  // An incomplete Task can be archived too and contributes zero.
  s = await ok(archive(px.tasks.taskA2.id))
  expect(task(s, px.tasks.taskA2.id)).toMatchObject({ completed: false, xpContribution: 0 })
  expect(s.xp).toBe(50)
  for (const actor of ['coach', 'peer', 'unrelated'] as const) {
    expect((await request(`${base()}/learning-state`, actor)).status).toBe(404)
    expect((await archive(px.tasks.taskB.id, actor)).status).toBe(404)
  }
  expect(await state()).toEqual(s)
})

it('AC6: personal progress and coach Enrollment progress stay separate in both directions', async () => {
  const enrollmentId = (await (await request(`/invitations/${fx.invitations.toLearner.id}/accept`, 'learner', 'POST')).json() as any).enrollment.id
  await db.update(versionTasks).set({ xpReward: 20 }).where(and(eq(versionTasks.learningPathVersionId, fx.versions.version1.id), eq(versionTasks.taskId, fx.content.taskA.id)))
  const sent = await request(`/enrollments/${enrollmentId}/tasks/${fx.content.taskA.id}/submission/revisions`, 'learner', 'POST', { text: 'Coach-mode evidence' })
  const revision = (await sent.json() as any).revision.id
  expect((await request(`/enrollments/${enrollmentId}/tasks/${fx.content.taskA.id}/submission/revisions/${revision}/review`, 'coach', 'POST', { decision: 'approval' })).status).toBe(201)
  const coached = async () => (await (await request(`/enrollments/${enrollmentId}/learning-state`)).json() as any).learningState
  const enrollment = await coached()
  expect(enrollment.xp).toBe(20)
  // 20 Enrollment XP does not satisfy the personal 20-XP Threshold.
  await ok(mastery(true))
  let s = await state()
  expect([s.xp, skill(s).access, skill(s).xpShortfall]).toEqual([0, false, 20])
  await ok(complete())
  await ok(reward(50))
  await ok(override(true, px.skills.skillA.id))
  await ok(archive(px.tasks.taskA2.id))
  s = await state()
  expect(s.xp).toBe(50)
  expect(await coached()).toEqual(enrollment)
  // Coach-mode identifiers are not personal targets, and personal IDs are not Enrollments.
  expect((await request(`/enrollments/${px.paths.main.id}/learning-state`)).status).toBe(404)
  expect((await request(`${base(enrollmentId)}/learning-state`)).status).toBe(404)
  expect((await request(`${base()}/learning-state`, 'coach')).status).toBe(404)
})

it('AC6: owner actions persist through a fresh connection; history rejects rewrites; a late failure rolls back the whole action', async () => {
  await ok(mastery(true))
  await ok(complete())
  await ok(reward(50))
  await ok(override(true))
  await ok(archive())
  const before = await state()
  for (const table of ['personal_xp_events', 'personal_mastery_events', 'personal_override_records']) {
    await expect(Promise.resolve(db.execute(sql`update ${sql.raw(table)} set occurred_at = now() - interval '1 day'`))).rejects.toThrow()
    await expect(Promise.resolve(db.execute(sql`delete from ${sql.raw(table)}`))).rejects.toThrow()
  }
  const other = createDatabase(TEST_DATABASE_URL)
  try {
    const fresh = createApp({ db: other.db, identity: fixtureIdentity(fx.identities) })
    const read = (actor: string) => fresh.request(`${base()}/learning-state`, { headers: { [FIXTURE_IDENTITY_HEADER]: actor } })
    expect((await (await read('learner')).json() as any).learningState).toEqual(before)
    expect((await read('peer')).status).toBe(404)
  } finally { await other.close() }

  await db.execute(sql`create function test_fail_personal() returns trigger language plpgsql as $$ begin raise exception 'late personal history failure'; end $$`)
  try {
    for (const table of ['personal_xp_events', 'personal_mastery_events', 'personal_override_records']) {
      await db.execute(sql`create trigger test_fail_personal after insert on ${sql.raw(table)} for each row execute function test_fail_personal()`)
      try {
        const attempt = table === 'personal_xp_events' ? complete(px.tasks.taskA2.id) : table === 'personal_mastery_events' ? mastery(false) : override(false)
        expect((await attempt).status).toBe(500)
        expect(await state()).toEqual(before)
      } finally { await db.execute(sql`drop trigger test_fail_personal on ${sql.raw(table)}`) }
    }
  } finally { await db.execute(sql`drop function test_fail_personal()`) }
  const retried = await ok(complete(px.tasks.taskA2.id))
  expect(retried.xp).toBe(60)
})


it('AC2/3/6: a reward edit waiting behind an in-flight completion applies the difference to the committed completion', async () => {
  const other = createDatabase(TEST_DATABASE_URL, 1)
  let release!: () => void, ready!: (pid: number) => void
  const barrier = new Promise<void>((resolve) => { release = resolve })
  const locked = new Promise<number>((resolve) => { ready = resolve })
  await db.execute(sql`create function test_pause_personal() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(91014); return NEW; end $$`)
  await db.execute(sql`create trigger test_pause_personal before insert on personal_xp_events for each row execute function test_pause_personal()`)
  const locker = other.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(91014)`)
    const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
    ready(row.pid)
    await barrier
  })
  let pending: Promise<Response>[] = []
  try {
    const pid = await locked
    pending = [complete()]
    const completionPid = await waitForBlockedBy(db, pid)
    pending.push(reward(50))
    // The edit waits on the completion's Path lock, not on the test barrier.
    await waitForBlockedBy(db, completionPid)
    release()
    await locker
    const responses = await Promise.all(pending)
    expect(responses.map((r) => r.status)).toEqual([200, 200])
  } finally {
    release()
    await locker
    await Promise.allSettled(pending)
    await db.execute(sql`drop trigger test_pause_personal on personal_xp_events`)
    await db.execute(sql`drop function test_pause_personal()`)
    await other.close()
  }
  const s = await state()
  expect(s.xp).toBe(50)
  expect(xpEvents(s)).toEqual([[px.tasks.taskA.id, 'award', 'completion', 20], [px.tasks.taskA.id, 'correction', 'reward_change', 30]])
})
