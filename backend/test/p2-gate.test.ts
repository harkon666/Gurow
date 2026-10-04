import { afterAll, beforeAll, beforeEach, expect, it } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'
import { createApp } from '../src/app'
import { createDatabase, type Database } from '../src/db/client'
import { versionPrerequisites, versionSkills, versionTasks } from '../src/db/schema'
import { FIXTURE_IDENTITY_HEADER, fixtureIdentity } from '../src/identity'
import { waitForBlockedBy } from './support/blocking'
import { prepareTestDatabase, resetTestDatabase, TEST_DATABASE_URL } from './support/database'
import { seedEnrollmentFixture, seedPersonalFixture, type EnrollmentFixture } from './support/fixtures'

/**
 * P2 gate (T14): competing learning requests across Enrollment, Submission,
 * Review, revocation and lifecycle boundaries, over real Hono requests and the
 * migrated gurow_test PostgreSQL. Uses the SPEC testing decision 8 reference
 * Path: A's Required Task is worth 20 XP; B needs Mastery of A and 20 XP.
 */
let db: Database, close: () => Promise<void>, fx: EnrollmentFixture, app: ReturnType<typeof createApp>, enrollmentId: string
beforeAll(async () => { ({ db, close } = await prepareTestDatabase()) })
afterAll(async () => { await close() })
beforeEach(async () => {
  await resetTestDatabase(db)
  fx = await seedEnrollmentFixture(db)
  app = createApp({ db, identity: fixtureIdentity(fx.identities) })
  const v1 = fx.versions.version1.id
  await db.update(versionTasks).set({ xpReward: 20 }).where(and(eq(versionTasks.learningPathVersionId, v1), eq(versionTasks.taskId, fx.content.taskA.id)))
  await db.update(versionTasks).set({ xpReward: 5 }).where(and(eq(versionTasks.learningPathVersionId, v1), eq(versionTasks.taskId, fx.content.taskB.id)))
  await db.update(versionSkills).set({ xpThreshold: 20 }).where(and(eq(versionSkills.learningPathVersionId, v1), eq(versionSkills.skillId, fx.content.skillB.id)))
  await db.insert(versionPrerequisites).values({ learningPathVersionId: v1, prerequisiteSkillId: fx.content.skillA.id, skillId: fx.content.skillB.id })
  enrollmentId = (await (await accept()).json() as any).enrollment.id
})

type Actor = keyof EnrollmentFixture['identities'] | null
async function request(path: string, actor: Actor = 'learner', method = 'GET', body?: unknown) {
  return app.request(path, { method, headers: { ...(actor ? { [FIXTURE_IDENTITY_HEADER]: actor } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
}
const accept = (invitation = fx.invitations.toLearner.id, actor: Actor = 'learner') => request(`/invitations/${invitation}/accept`, actor, 'POST')
const submissionPath = (task = fx.content.taskA.id) => `/enrollments/${enrollmentId}/tasks/${task}/submission`
const send = (task = fx.content.taskA.id, text = 'Evidence') => request(`${submissionPath(task)}/revisions`, 'learner', 'POST', { text })
const approve = (id: string, task = fx.content.taskA.id) => request(`${submissionPath(task)}/revisions/${id}/review`, 'coach', 'POST', { decision: 'approval' })
const revoke = (id: string, task = fx.content.taskA.id) => request(`${submissionPath(task)}/revisions/${id}/review/revoke`, 'coach', 'POST', { reason: 'Evidence no longer supports the Task.' })
const lifecycle = (action: 'deactivate' | 'reactivate', actor: Actor = 'coach') => request(`/enrollments/${enrollmentId}/${action}`, actor, 'POST', { reason: `Gate ${action}.` })
const override = (body: unknown = { reason: 'Gate override.' }, suffix = '') => request(`/enrollments/${enrollmentId}/skills/${fx.content.skillB.id}/access-overrides${suffix}`, 'coach', 'POST', body)
async function sent(task = fx.content.taskA.id) {
  const response = await send(task)
  expect(response.status).toBe(201)
  return (await response.json() as any).revision.id as string
}
async function state(actor: Actor = 'learner') {
  const response = await request(`/enrollments/${enrollmentId}/learning-state`, actor)
  expect(response.status).toBe(200)
  return (await response.json() as any).learningState
}
const skill = (s: any, id: string) => s.skills.find((x: any) => x.skillId === id)

/**
 * Order-independent invariants of committed Enrollment history, checked in SQL at
 * full timestamp precision. Any accepted order must satisfy all of them.
 */
async function expectCoherentHistory(id = enrollmentId) {
  const violations = await db.execute<{ problem: string }>(sql`
    with revs as (
      select r.*, s.task_id, s.enrollment_id,
        lead(r.sent_at) over (partition by r.submission_id order by r.revision_number) as next_sent_at,
        lead(r.revision_number) over (partition by r.submission_id order by r.revision_number) as next_number,
        row_number() over (partition by r.submission_id order by r.revision_number) as position
      from submission_revisions r join submissions s on s.id = r.submission_id where s.enrollment_id = ${id})
    select 'revision numbers are not contiguous' as problem from revs where revision_number <> position
    union all select 'a later revision was sent earlier' from revs where next_sent_at < sent_at
    union all select 'the latest revision is superseded' from revs where next_number is null and superseded_at is not null
    union all select 'a pending revision was not superseded by its successor' from revs v where next_number is not null and superseded_at is null
      and not exists (select 1 from submission_reviews w where w.revision_id = v.id)
    union all select 'supersession is not the successor send' from revs where superseded_at is not null and superseded_at is distinct from next_sent_at
    union all select 'a superseded revision has a Review' from revs v join submission_reviews w on w.revision_id = v.id where v.superseded_at is not null
    union all select 'a Review precedes its revision' from revs v join submission_reviews w on w.revision_id = v.id where w.decided_at < v.sent_at
    union all select 'a successor was sent while the reviewed revision was pending' from revs v join submission_reviews w on w.revision_id = v.id where v.next_sent_at < w.decided_at
    union all select 'a revocation precedes its decision' from revs v join submission_reviews w on w.revision_id = v.id where w.revoked_at < w.decided_at
    union all select 'an XP event is not at its causal decision or revocation' from xp_events e join submission_reviews w on w.revision_id = e.revision_id
      where e.enrollment_id = ${id} and e.occurred_at is distinct from w.decided_at and e.occurred_at is distinct from w.revoked_at
    union all select 'a Mastery event is not at its causal decision or revocation' from mastery_events e join submission_reviews w on w.revision_id = e.revision_id
      where e.enrollment_id = ${id} and e.occurred_at is distinct from w.decided_at and e.occurred_at is distinct from w.revoked_at
    union all select 'more than one Submission per Task' from submissions where enrollment_id = ${id} group by task_id having count(*) > 1
    union all select 'a revision was sent while the Enrollment was inactive' from revs v where exists (
      select 1 from enrollment_lifecycle_records d where d.enrollment_id = v.enrollment_id and d.action = 'deactivate' and d.occurred_at < v.sent_at
        and not exists (select 1 from enrollment_lifecycle_records a where a.enrollment_id = d.enrollment_id and a.action = 'reactivate' and a.occurred_at between d.occurred_at and v.sent_at))
  `)
  expect(violations.map((v) => v.problem)).toEqual([])
  // Each Task's history moves its contribution between zero and its reward and explains current XP.
  const s = await state('coach')
  for (const task of s.tasks) {
    let running = 0
    for (const event of s.xpHistory.filter((e: any) => e.taskId === task.taskId)) {
      running += event.amount
      expect([0, task.xpReward]).toContain(running)
    }
    expect(running).toBe(task.xpContribution)
  }
  for (const item of s.skills) {
    const events = s.masteryHistory.filter((e: any) => e.skillId === item.skillId).map((e: any) => e.action)
    events.forEach((action: string, i: number) => expect(action).toBe(i % 2 === 0 ? 'award' : 'revocation'))
    expect(events.length % 2 === 1).toBe(item.mastery)
  }
  return s
}


/**
 * Holds one row lock from a separate connection, starts `first` and observes it
 * waiting on that row (after taking any earlier locks), then starts `second` and
 * observes it waiting on `first`. Releasing the hold fixes the accepted order.
 */
async function heldOrder(holdRow: ReturnType<typeof sql>, first: () => Promise<Response>, second: () => Promise<Response>) {
  const other = createDatabase(TEST_DATABASE_URL, 1)
  let release!: () => void, ready!: (pid: number) => void
  const barrier = new Promise<void>((resolve) => { release = resolve })
  const held = new Promise<number>((resolve) => { ready = resolve })
  const holder = other.db.transaction(async (tx) => {
    await tx.execute(holdRow)
    const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
    ready(row.pid)
    await barrier
  })
  const pending: Promise<Response>[] = []
  try {
    const pid = await held
    pending.push(first())
    const firstPid = await waitForBlockedBy(db, pid)
    pending.push(second())
    await waitForBlockedBy(db, firstPid)
    release()
    await holder
    return await Promise.all(pending)
  } finally {
    release()
    await holder
    await Promise.allSettled(pending)
    await other.close()
  }
}
const lockSubmission = (task = fx.content.taskA.id) => sql`select 1 from submissions where enrollment_id = ${enrollmentId} and task_id = ${task} for update`

it('AC2: when a Review wins first, the later send is recorded after the decision and the Approval stands', async () => {
  const first = await sent()
  // The Review takes the Enrollment lock and waits on the Submission row; the send then queues on the Enrollment.
  const [review, later] = await heldOrder(lockSubmission(), () => approve(first), () => send())
  expect([review.status, later.status]).toEqual([201, 201])
  const history = (await (await request(submissionPath())).json() as any).submission.revisions
  expect(history.map((r: any) => r.status)).toEqual(['approval', 'pending'])
  const s = await expectCoherentHistory()
  expect(s.xp).toBe(20)
  expect(skill(s, fx.content.skillA.id).mastery).toBe(true)
})

it('AC1: competing acceptances keep one Enrollment, and acceptances racing self-deactivation never reactivate it', async () => {
  const peers = await Promise.all(Array.from({ length: 16 }, () => accept(fx.invitations.toPeer.id, 'peer')))
  const peerBodies = await Promise.all(peers.map(async (r) => ({ status: r.status, body: await r.json() as any })))
  expect(peerBodies.filter((r) => r.status === 201)).toHaveLength(1)
  expect(peerBodies.every((r) => [200, 201].includes(r.status))).toBe(true)
  expect(new Set(peerBodies.map((r) => r.body.enrollment.id)).size).toBe(1)
  const [mixed, stop] = await Promise.all([
    Promise.all(Array.from({ length: 8 }, (_, i) => accept(i % 2 ? fx.invitations.toLearnerAgain.id : fx.invitations.toLearner.id))),
    request(`/enrollments/${enrollmentId}/deactivate`, 'learner', 'POST'),
  ])
  expect(stop.status).toBe(200)
  for (const response of mixed) {
    expect(response.status).toBe(200)
    expect((await response.json() as any).enrollment.id).toBe(enrollmentId)
  }
  const rows = await db.execute<{ account_id: string; status: string; n: number }>(sql`select account_id, status, count(*) over (partition by account_id)::int as n from enrollments`)
  expect(rows.map((r) => r.n)).toEqual([1, 1])
  const s = await state()
  expect(s.enrollmentStatus).toBe('inactive')
  expect(s.lifecycleHistory.map((r: any) => [r.action, r.actorAccountId, r.reason])).toEqual([['deactivate', fx.accounts.learner.id, null]])
  expect((await accept()).status).toBe(200)
  expect((await expectCoherentHistory()).enrollmentStatus).toBe('inactive')
})

it('AC1: competing sends keep one Submission per Task with immutable, coherently ordered revisions', async () => {
  const texts = Array.from({ length: 12 }, (_, i) => `Attempt ${i}`)
  const responses = await Promise.all([...texts.map((text) => send(fx.content.taskA.id, text)), ...texts.slice(0, 4).map((text) => send(fx.content.taskAReading.id, text))])
  const bodies = await Promise.all(responses.map(async (r) => { expect(r.status).toBe(201); return await r.json() as any }))
  for (const task of [fx.content.taskA.id, fx.content.taskAReading.id]) {
    const own = bodies.filter((b) => b.submission.taskId === task)
    expect(new Set(own.map((b) => b.submission.id)).size).toBe(1)
    expect(own.filter((b) => b.createdSubmission)).toHaveLength(1)
  }
  const history = (await (await request(submissionPath())).json() as any).submission.revisions
  expect(history.map((r: any) => r.revisionNumber)).toEqual(texts.map((_, i) => i + 1))
  expect(history.map((r: any) => r.text).sort()).toEqual([...texts].sort())
  expect(history.map((r: any) => r.status)).toEqual([...texts.slice(1).map(() => 'superseded'), 'pending'])
  await expect(Promise.resolve(db.execute(sql`update submission_revisions set text = 'Rewritten' where id = ${history[0].id}`))).rejects.toThrow()
  await expectCoherentHistory()
  expect((await (await request(submissionPath())).json() as any).submission.revisions).toEqual(history)
})

it('AC2: a Review made stale by a newer authoritative revision is rejected without XP or Mastery effects', async () => {
  const first = await sent()
  // The send takes the Enrollment lock first; the Review queues behind it.
  const [later, review] = await heldOrder(lockSubmission(), () => send(), () => approve(first))
  expect([later.status, review.status]).toEqual([201, 409])
  expect(await review.json()).toEqual({ error: 'revision_superseded' })
  const s = await expectCoherentHistory()
  expect([s.xp, s.xpHistory, s.masteryHistory, skill(s, fx.content.skillA.id).mastery]).toEqual([0, [], [], false])
  expect(await db.execute(sql`select 1 from submission_reviews`)).toHaveLength(0)
  for (const decision of [{ decision: 'approval' }, { decision: 'changes_requested', feedback: 'Too late' }]) {
    expect((await request(`${submissionPath()}/revisions/${first}/review`, 'coach', 'POST', decision)).status).toBe(409)
  }
})

it('AC2/3: unordered sends and duplicate Approvals of one revision settle on a single coherent outcome', async () => {
  for (let round = 0; round < 5; round++) {
    await resetTestDatabase(db)
    fx = await seedEnrollmentFixture(db)
    app = createApp({ db, identity: fixtureIdentity(fx.identities) })
    await db.update(versionTasks).set({ xpReward: 20 }).where(and(eq(versionTasks.learningPathVersionId, fx.versions.version1.id), eq(versionTasks.taskId, fx.content.taskA.id)))
    enrollmentId = (await (await accept()).json() as any).enrollment.id
    const first = await sent()
    const responses = await Promise.all([approve(first), send(), approve(first), send()])
    const [a1, s1, a2, s2] = responses.map((r) => r.status)
    expect([s1, s2]).toEqual([201, 201])
    expect([a1, a2].sort()).toContainEqual(409)
    const approved = [a1, a2].includes(201)
    const s = await expectCoherentHistory()
    expect(s.xp).toBe(approved ? 20 : 0)
    expect(s.xpHistory).toHaveLength(approved ? 1 : 0)
    expect(skill(s, fx.content.skillA.id).mastery).toBe(approved)
  }
})

it('AC3: repeated and competing Approvals and revocations keep one contribution and a coherent correction history', async () => {
  const first = await sent()
  expect((await approve(first)).status).toBe(201)
  const second = await sent()
  const responses = await Promise.all([approve(second), revoke(first), approve(second), revoke(first)])
  expect([responses[0].status, responses[2].status].sort()).toEqual([201, 409])
  expect([responses[1].status, responses[3].status].sort()).toEqual([200, 409])
  let s = await expectCoherentHistory()
  expect(s.xp).toBe(20)
  expect(skill(s, fx.content.skillA.id).mastery).toBe(true)
  expect(skill(s, fx.content.skillB.id).access).toBe(true)
  // Revoking the last valid Approval removes the contribution once, however often it is retried.
  const last = await Promise.all([revoke(second), revoke(second), revoke(second)])
  expect(last.map((r) => r.status).sort()).toEqual([200, 409, 409])
  s = await expectCoherentHistory()
  expect([s.xp, skill(s, fx.content.skillA.id).mastery, skill(s, fx.content.skillB.id).access]).toEqual([0, false, false])
  const settled = [s.xpHistory, s.masteryHistory]
  // A late storage failure on the Mastery record leaves no Review, XP event or other partial progress.
  const third = await sent()
  await db.execute(sql`create function test_fail_gate() returns trigger language plpgsql as $$ begin raise exception 'late gate failure'; end $$`)
  await db.execute(sql`create trigger test_fail_gate after insert on mastery_events for each row execute function test_fail_gate()`)
  try {
    expect((await approve(third)).status).toBe(500)
  } finally {
    await db.execute(sql`drop trigger test_fail_gate on mastery_events`)
    await db.execute(sql`drop function test_fail_gate()`)
  }
  s = await expectCoherentHistory()
  expect([s.xp, s.xpHistory, s.masteryHistory]).toEqual([0, ...settled])
  expect(await db.execute(sql`select 1 from submission_reviews where revision_id = ${third}`)).toHaveLength(0)
  expect((await approve(third)).status).toBe(201)
  s = await expectCoherentHistory()
  expect([s.xp, skill(s, fx.content.skillA.id).mastery]).toEqual([20, true])
})

it('AC4: sends racing deactivation are judged when they commit; earlier eligible work stays reviewable', async () => {
  const responses = await Promise.all([send(), send(), lifecycle('deactivate'), send(), send(), send()])
  const statuses = responses.map((r) => r.status)
  expect(statuses[2]).toBe(200)
  for (const status of [...statuses.slice(0, 2), ...statuses.slice(3)]) expect([201, 403]).toContain(status)
  for (const r of responses.filter((r) => r.status === 403)) expect(await r.json()).toEqual({ error: 'enrollment_inactive' })
  // Make sure at least one eligible revision exists in every interleaving.
  const history = (await (await request(submissionPath())).json() as any).submission?.revisions ?? []
  expect(history).toHaveLength(statuses.filter((s) => s === 201).length)
  expect((await send()).status).toBe(403)
  expect((await request(`/enrollments/${enrollmentId}/tasks/${fx.content.taskB.id}/start`, 'learner', 'POST')).status).toBe(403)
  if (history.length) {
    const latest = history.at(-1)
    for (const old of history.slice(0, -1)) expect((await approve(old.id)).status).toBe(409)
    expect((await approve(latest.id)).status).toBe(201)
    const s = await expectCoherentHistory()
    expect([s.enrollmentStatus, s.xp, skill(s, fx.content.skillA.id).mastery, skill(s, fx.content.skillA.id).access]).toEqual(['inactive', 20, true, false])
  }
  await expectCoherentHistory()
})

it('AC4: sends racing override grant, revocation and deactivation are judged at the authoritative operation', async () => {
  // Grant racing a send: a B revision exists only if it was sent after the grant.
  const [grantResponse, early] = await Promise.all([override(), send(fx.content.taskB.id)])
  expect(grantResponse.status).toBe(201)
  expect([201, 403]).toContain(early.status)
  const grant = (await grantResponse.json() as any).overrideRecord
  // Revocation racing more sends: every accepted B revision precedes the revocation.
  const raced = await Promise.all([send(fx.content.taskB.id), send(fx.content.taskB.id), override({ reason: 'Back to ordinary rules.' }, `/${grant.id}/revoke`), send(fx.content.taskB.id)])
  expect(raced[2].status).toBe(200)
  const withdrawal = (await raced[2].json() as any).overrideRecord
  for (const r of [raced[0], raced[1], raced[3]]) expect([201, 403]).toContain(r.status)
  const outside = await db.execute(sql`select r.revision_number from submission_revisions r join submissions s on s.id = r.submission_id
    where s.enrollment_id = ${enrollmentId} and s.task_id = ${fx.content.taskB.id}
      and (r.sent_at < (select occurred_at from override_records where id = ${grant.id}) or r.sent_at > (select occurred_at from override_records where id = ${withdrawal.id}))`)
  expect(outside).toEqual([])
  expect(await (await send(fx.content.taskB.id)).json()).toEqual({ error: 'skill_locked' })
  const history = (await (await request(submissionPath(fx.content.taskB.id))).json() as any).submission?.revisions ?? []
  if (history.length) {
    // The latest pending revision sent with overridden Access stays eligible after the override is gone.
    expect((await approve(history.at(-1).id, fx.content.taskB.id)).status).toBe(201)
    const s = await expectCoherentHistory()
    expect([s.xp, skill(s, fx.content.skillB.id).mastery, skill(s, fx.content.skillB.id).access]).toEqual([5, true, false])
  }
  // Grant, deactivation and a send racing together: an override never bypasses inactivity.
  const [regrant, stop, last] = await Promise.all([override(), lifecycle('deactivate'), send(fx.content.taskB.id)])
  expect([regrant.status, stop.status]).toEqual([201, 200])
  expect([201, 403]).toContain(last.status)
  expect((await send(fx.content.taskB.id)).status).toBe(403)
  const s = await expectCoherentHistory()
  expect(s.enrollmentStatus).toBe('inactive')
  expect(skill(s, fx.content.skillB.id)).toMatchObject({ access: false })
})

it('AC5: reference flow, privacy matrix, lifecycle and personal 20→50 corrections pass against real persistence', async () => {
  let s = await state()
  expect(skill(s, fx.content.skillB.id)).toMatchObject({ access: false, xpShortfall: 20, unmetPrerequisiteSkillIds: [fx.content.skillA.id] })
  expect((await send(fx.content.taskB.id)).status).toBe(403)
  const a = await sent()
  expect((await approve(a)).status).toBe(201)
  s = await state()
  expect([s.xp, skill(s, fx.content.skillA.id).mastery, skill(s, fx.content.skillB.id).access]).toEqual([20, true, true])
  const b = await sent(fx.content.taskB.id)
  expect((await approve(b, fx.content.taskB.id)).status).toBe(201)
  expect((await revoke(a)).status).toBe(200)
  s = await expectCoherentHistory()
  // Revocation removes A's 20 XP and Mastery and relocks B, whose own approved evidence keeps its Mastery.
  expect([s.xp, skill(s, fx.content.skillA.id).mastery]).toEqual([5, false])
  expect(skill(s, fx.content.skillB.id)).toMatchObject({ mastery: true, access: false, xpShortfall: 15, unmetPrerequisiteSkillIds: [fx.content.skillA.id] })
  expect(s.xpHistory.map((e: any) => [e.taskId, e.kind, e.amount])).toEqual([[fx.content.taskA.id, 'award', 20], [fx.content.taskB.id, 'award', 5], [fx.content.taskA.id, 'correction', -20]])
  expect(s.masteryHistory.map((e: any) => [e.skillId, e.action])).toEqual([[fx.content.skillA.id, 'award'], [fx.content.skillB.id, 'award'], [fx.content.skillA.id, 'revocation']])
  const revisions = (await (await request(submissionPath())).json() as any).submission.revisions
  expect(revisions.map((r: any) => r.status)).toEqual(['approval_revoked'])

  // Privacy and authority matrix.
  const draft = `/enrollments/${enrollmentId}/tasks/${fx.content.taskA.id}/draft`
  expect((await request(draft, 'learner', 'PUT', { text: 'Private notes', urls: [] })).status).toBe(200)
  for (const actor of ['peer', 'unrelated', 'otherCoach', 'unverified', null] as const) {
    const expected = actor === null ? 401 : 404
    for (const path of [`/enrollments/${enrollmentId}/learning-state`, submissionPath(), draft, `/enrollments/${enrollmentId}`]) expect((await request(path, actor)).status).toBe(expected)
    expect((await request(`${submissionPath()}/revisions/${a}/review`, actor, 'POST', { decision: 'approval' })).status).toBe(expected)
  }
  expect((await request(draft, 'coach')).status).toBe(403)
  expect((await request(`${submissionPath()}/revisions/${b}/review`, 'learner', 'POST', { decision: 'approval' })).status).toBe(403)
  expect((await accept(fx.invitations.toOwner.id, 'coach')).status).toBe(403)
  expect(await state('coach')).toEqual(await state())

  // Lifecycle: self-deactivation without a reason, Coach-only reactivation, retained progress.
  expect((await request(`/enrollments/${enrollmentId}/deactivate`, 'learner', 'POST')).status).toBe(200)
  expect((await send()).status).toBe(403)
  expect((await request(`/enrollments/${enrollmentId}/reactivate`, 'learner', 'POST', { reason: 'Let me back in.' })).status).toBe(403)
  expect((await lifecycle('reactivate')).status).toBe(200)
  const resumed = await expectCoherentHistory()
  expect([resumed.enrollmentStatus, resumed.xp, resumed.xpHistory, resumed.masteryHistory]).toEqual(['active', s.xp, s.xpHistory, s.masteryHistory])
  expect((await send()).status).toBe(201)
  await expectCoherentHistory()

  // Personal 20→50 correction behavior, independent of this Enrollment.
  const px = await seedPersonalFixture(db, fx)
  const personal = (method: string, action: string, body?: unknown) => request(`/personal/learning-paths/${px.paths.main.id}/tasks/${px.tasks.taskA.id}/${action}`, 'learner', method, body)
  for (const [method, action, body] of [['PUT', 'completion'], ['PUT', 'reward', { xpReward: 50 }], ['DELETE', 'completion'], ['PUT', 'completion'], ['PUT', 'completion']] as const) {
    expect((await personal(method, action, body)).status).toBe(200)
  }
  const mine = (await (await request(`/personal/learning-paths/${px.paths.main.id}/learning-state`)).json() as any).learningState
  expect(mine.xp).toBe(50)
  expect(mine.xpHistory.map((e: any) => [e.cause, e.amount])).toEqual([['completion', 20], ['reward_change', 30], ['completion_undone', -50], ['completion', 50]])
  expect((await request(`/personal/learning-paths/${px.paths.main.id}/learning-state`, 'coach')).status).toBe(404)
  expect((await expectCoherentHistory()).xp).toBe(5)
})
