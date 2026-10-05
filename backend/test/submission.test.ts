import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { and, asc, eq, sql } from 'drizzle-orm'
import { createApp } from '../src/app'
import { createDatabase, type Database } from '../src/db/client'
import { enrollments, skills, submissionDrafts, submissionReviews, submissionRevisions, submissions, tasks, versionPrerequisites, versionSkills, versionTasks } from '../src/db/schema'
import { FIXTURE_IDENTITY_HEADER, fixtureIdentity } from '../src/identity'
import { prepareTestDatabase, resetTestDatabase, TEST_DATABASE_URL } from './support/database'
import { amendPublished, seedEnrollmentFixture, type EnrollmentFixture } from './support/fixtures'

// Request-level tests against real PostgreSQL (SPEC testing decisions 1, 9, 10 and 12).
let db: Database
let close: () => Promise<void>
let fx: EnrollmentFixture
let app: ReturnType<typeof createApp>
let enrollmentId: string
let peerEnrollmentId: string

type Actor = keyof EnrollmentFixture['identities']
const as = (actor: Actor | null): Record<string, string> => (actor ? { [FIXTURE_IDENTITY_HEADER]: actor } : {})

beforeAll(async () => { ({ db, close } = await prepareTestDatabase()) })
afterAll(async () => { await close() })
beforeEach(async () => {
  await resetTestDatabase(db)
  fx = await seedEnrollmentFixture(db)
  app = createApp({ db, identity: fixtureIdentity(fx.identities) })
  // Enroll through the public acceptance route; the peer shares the learner's Version.
  const accept = async (invitationId: string, actor: Actor) =>
    ((await (await app.request(`/invitations/${invitationId}/accept`, { method: 'POST', headers: as(actor) })).json()) as any).enrollment.id as string
  enrollmentId = await accept(fx.invitations.toLearner.id, 'learner')
  peerEnrollmentId = await accept(fx.invitations.toPeer.id, 'peer')
})

const taskPath = (taskId: string, enrollment = enrollmentId) => `/enrollments/${enrollment}/tasks/${taskId}`
const request = (path: string, actor: Actor | null, init: { method?: string; body?: unknown } = {}) =>
  app.request(path, {
    method: init.method ?? 'GET',
    headers: { ...as(actor), ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
const saveDraft = (taskId: string, actor: Actor | null, body: unknown, enrollment?: string) =>
  request(`${taskPath(taskId, enrollment)}/draft`, actor, { method: 'PUT', body })
const readDraft = (taskId: string, actor: Actor | null, enrollment?: string) => request(`${taskPath(taskId, enrollment)}/draft`, actor)
const send = (taskId: string, actor: Actor | null, body: unknown, enrollment?: string) =>
  request(`${taskPath(taskId, enrollment)}/submission/revisions`, actor, { method: 'POST', body })
const readSubmission = (taskId: string, actor: Actor | null, enrollment?: string) => request(`${taskPath(taskId, enrollment)}/submission`, actor)

const storedDrafts = () => db.select().from(submissionDrafts)
const storedSubmissions = () => db.select().from(submissions)
const storedRevisions = () => db.select().from(submissionRevisions).orderBy(asc(submissionRevisions.revisionNumber))
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error

describe('AC1: draft privacy', () => {
  const draft = { text: 'Work in progress: u + v = (3, 1)', urls: ['https://notes.example/vectors'] }

  it('saves a draft the learner can read back', async () => {
    expect(await (await readDraft(fx.content.taskA.id, 'learner')).json()).toEqual({ draft: null })
    const saved = await saveDraft(fx.content.taskA.id, 'learner', draft)
    expect(saved.status).toBe(200)

    const res = await readDraft(fx.content.taskA.id, 'learner')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ draft: { enrollmentId, taskId: fx.content.taskA.id, ...draft } })
    expect(await storedDrafts()).toEqual([expect.objectContaining({ enrollmentId, taskId: fx.content.taskA.id, ...draft })])

    // Saving again replaces the one draft for this Task.
    await saveDraft(fx.content.taskA.id, 'learner', { text: 'Second attempt', urls: [] })
    expect(await storedDrafts()).toEqual([expect.objectContaining({ text: 'Second attempt', urls: [] })])
  })

  it('rejects the owning Coach reading or writing the draft', async () => {
    await saveDraft(fx.content.taskA.id, 'learner', draft)
    const read = await readDraft(fx.content.taskA.id, 'coach')
    expect(read.status).toBe(403)
    const body = await read.text()
    expect(JSON.parse(body)).toEqual({ error: 'draft_private' })
    expect(body).not.toContain('Work in progress')

    const write = await saveDraft(fx.content.taskA.id, 'coach', { text: 'Coach edit', urls: [] })
    expect(write.status).toBe(403)
    expect(await storedDrafts()).toEqual([expect.objectContaining(draft)])
  })

  it('rejects peers, unrelated Accounts, another Workspace Coach and anonymous requests', async () => {
    await saveDraft(fx.content.taskA.id, 'learner', draft)
    for (const actor of ['peer', 'unrelated', 'otherCoach'] as const) {
      const read = await readDraft(fx.content.taskA.id, actor)
      expect(read.status).toBe(404)
      expect(await errorOf(read)).toBe('enrollment_not_found')
      const write = await saveDraft(fx.content.taskA.id, actor, { text: `${actor} edit`, urls: [] })
      expect(write.status).toBe(404)
    }
    expect((await readDraft(fx.content.taskA.id, null)).status).toBe(401)
    expect((await saveDraft(fx.content.taskA.id, null, { text: 'anon', urls: [] })).status).toBe(401)
    // The peer's own Enrollment holds no draft for the learner's work either.
    expect(await (await readDraft(fx.content.taskA.id, 'peer', peerEnrollmentId)).json()).toEqual({ draft: null })
    expect(await storedDrafts()).toEqual([expect.objectContaining({ enrollmentId, ...draft })])
  })

  it('keeps unsent draft contents out of the Coach-readable Submission', async () => {
    await send(fx.content.taskA.id, 'learner', { text: 'Sent answer', urls: [] })
    await saveDraft(fx.content.taskA.id, 'learner', { text: 'Unsent private correction', urls: ['https://private.example/next'] })
    const res = await readSubmission(fx.content.taskA.id, 'coach')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Sent answer')
    expect(body).not.toContain('Unsent private correction')
    expect(body).not.toContain('private.example')
  })

  it('accepts drafts only for Tasks of the Enrollment Version', async () => {
    const outside = await taskOutsideVersion1()
    const res = await saveDraft(outside, 'learner', draft)
    expect(res.status).toBe(404)
    expect(await errorOf(res)).toBe('task_not_found')
    expect(await storedDrafts()).toHaveLength(0)
  })
})

/** A Task defined only in Version 2, so it is not part of the learner's Version 1 Enrollment. */
async function taskOutsideVersion1() {
  const [task] = await db.insert(tasks).values({ skillId: fx.content.skillA.id }).returning()
  await amendPublished(db, (tx) => tx.insert(versionTasks).values({ learningPathVersionId: fx.versions.version2.id, taskId: task.id, skillId: fx.content.skillA.id, title: 'New in Version 2', required: false }))
  return task.id
}

describe('AC2/AC5: current Skill Access', () => {
  it('blocks an active learner sending to B requiring A mastery and 20 Enrollment XP', async () => {
    await amendPublished(db, (tx) => tx.update(versionSkills).set({ xpThreshold: 20 }).where(and(eq(versionSkills.learningPathVersionId, fx.versions.version1.id), eq(versionSkills.skillId, fx.content.skillB.id))))
    await amendPublished(db, (tx) => tx.insert(versionPrerequisites).values({ learningPathVersionId: fx.versions.version1.id, prerequisiteSkillId: fx.content.skillA.id, skillId: fx.content.skillB.id }))
    const res = await send(fx.content.taskB.id, 'learner', { text: 'Locked work', urls: [] })
    expect(res.status).toBe(403)
    expect(await storedSubmissions()).toHaveLength(0)
    expect(await storedRevisions()).toHaveLength(0)
  })

  it('checks unmet prerequisite independently of XP', async () => {
    await gateB(0)
    expect((await send(fx.content.taskB.id, 'learner', evidence)).status).toBe(403)
    await approveTask(fx.content.taskA.id)
    expect((await send(fx.content.taskB.id, 'learner', evidence)).status).toBe(201)
  })

  it('checks XP independently and counts each approved Task reward only once', async () => {
    await gateB(40, [])
    await rewardA(20)
    await approveTask(fx.content.taskA.id)
    await approveTask(fx.content.taskA.id)
    expect((await send(fx.content.taskB.id, 'learner', evidence)).status).toBe(403)
    // A second distinct approved Task adds its own contribution.
    await amendPublished(db, (tx) => tx.update(versionTasks).set({ xpReward: 20 }).where(and(eq(versionTasks.learningPathVersionId, fx.versions.version1.id), eq(versionTasks.taskId, fx.content.taskAReading.id))))
    await approveTask(fx.content.taskAReading.id)
    expect((await send(fx.content.taskB.id, 'learner', evidence)).status).toBe(201)
    expect((await send(fx.content.taskB.id, 'learner', evidence)).status).toBe(201) // XP is not spent.
  })

  it('requires ALL prerequisite Skills and all their Required Tasks, not enrichment evidence', async () => {
    const c = await extraSkill(true)
    const [secondRequired] = await db.insert(tasks).values({ skillId: fx.content.skillA.id }).returning()
    await amendPublished(db, (tx) => tx.insert(versionTasks).values({ learningPathVersionId: fx.versions.version1.id, taskId: secondRequired.id, skillId: fx.content.skillA.id, title: 'Second required evidence', required: true }))
    await gateB(0, [fx.content.skillA.id, c.skill.id])
    await approveTask(fx.content.taskA.id)
    await approveTask(fx.content.taskAReading.id)
    expect((await send(fx.content.taskB.id, 'learner', evidence)).status).toBe(403)
    await approveTask(secondRequired.id)
    expect((await send(fx.content.taskB.id, 'learner', evidence)).status).toBe(403)
    await approveTask(c.task.id)
    expect((await send(fx.content.taskB.id, 'learner', evidence)).status).toBe(201)
  })

  it('never masters a Skill with no Tasks', async () => {
    const [empty] = await db.insert(skills).values({ learningPathId: fx.paths.path.id }).returning()
    await amendPublished(db, (tx) => tx.insert(versionSkills).values({ learningPathVersionId: fx.versions.version1.id, skillId: empty.id, title: 'No tasks', learningOutcome: 'No evidence' }))
    await gateB(0, [empty.id])
    expect((await send(fx.content.taskB.id, 'learner', evidence)).status).toBe(403)
  })

  it('never masters an enrichment-only Skill', async () => {
    const c = await extraSkill(false)
    await gateB(0, [c.skill.id])
    expect((await send(fx.content.taskB.id, 'learner', evidence)).status).toBe(403)
    await approveTask(c.task.id)
    expect((await send(fx.content.taskB.id, 'learner', evidence)).status).toBe(403)
  })

  it('unlocks with owning-Coach Approval and retains it beside a new pending revision', async () => {
    await gateB(20)
    await rewardA(20)
    const approved = await approveTask(fx.content.taskA.id)
    const correction = await (await send(fx.content.taskA.id, 'learner', evidence)).json() as any
    expect((await send(fx.content.taskB.id, 'learner', evidence)).status).toBe(201)
    const history = await (await readSubmission(fx.content.taskA.id, 'coach')).json() as any
    expect(history.submission.revisions.map((r: any) => [r.id, r.status, r.supersededAt])).toEqual([
      [approved, 'approval', null], [correction.revision.id, 'pending', null],
    ])
    expect(history.submission.revisions[1]).not.toHaveProperty('review')
    // Revocation is DB fault injection until T10; the newer pending revision does not inherit Approval.
    await revoke(approved)
    expect((await send(fx.content.taskB.id, 'learner', evidence)).status).toBe(403)
  })

  it('preserves Changes Requested when a correction is sent', async () => {
    const { revision } = await (await send(fx.content.taskA.id, 'learner', evidence)).json() as any
    await reviewFixture(revision.id, 'changes_requested')
    expect((await send(fx.content.taskA.id, 'learner', { text: 'Correction', urls: [] })).status).toBe(201)
    const { submission } = await (await readSubmission(fx.content.taskA.id, 'learner')).json() as any
    expect(submission.revisions.map((r: any) => [r.status, r.supersededAt])).toEqual([['changes_requested', null], ['pending', null]])
    expect(submission.revisions[0].review.feedback).toBe('Please correct the evidence')
  })

  it('does not count Changes Requested, unrelated Coach decisions or self-approval', async () => {
    await gateB(20)
    await rewardA(20)
    for (const [decision, coachId] of [['changes_requested', fx.accounts.coach.id], ['approval', fx.accounts.otherCoach.id], ['approval', fx.accounts.learner.id]] as const) {
      const { revision } = await (await send(fx.content.taskA.id, 'learner', evidence)).json() as any
      await reviewFixture(revision.id, decision, coachId)
      expect((await send(fx.content.taskB.id, 'learner', evidence)).status).toBe(403)
    }
  })

  it('does not import approvals from a peer or the same Account in another Version', async () => {
    await gateB(20)
    await rewardA(20)
    await approveTask(fx.content.taskA.id, 'peer', peerEnrollmentId)
    const [other] = await db.insert(enrollments).values({ accountId: fx.accounts.learner.id, learningPathVersionId: fx.versions.version2.id }).returning()
    await amendPublished(db, (tx) => tx.update(versionTasks).set({ xpReward: 200 }).where(and(eq(versionTasks.learningPathVersionId, fx.versions.version2.id), eq(versionTasks.taskId, fx.content.taskA.id))))
    await approveTask(fx.content.taskA.id, 'learner', other.id)
    expect((await send(fx.content.taskB.id, 'learner', evidence)).status).toBe(403)
    await approveTask(fx.content.taskA.id)
    expect((await send(fx.content.taskB.id, 'learner', evidence)).status).toBe(201)
  })

  it('uses pinned prerequisites, thresholds and rewards rather than newer rules', async () => {
    await gateB(20)
    await rewardA(20)
    await amendPublished(db, (tx) => tx.update(versionSkills).set({ xpThreshold: 200 }).where(and(eq(versionSkills.learningPathVersionId, fx.versions.version2.id), eq(versionSkills.skillId, fx.content.skillB.id))))
    await amendPublished(db, (tx) => tx.update(versionTasks).set({ xpReward: 0, required: false }).where(eq(versionTasks.learningPathVersionId, fx.versions.version2.id)))
    await amendPublished(db, (tx) => tx.insert(versionPrerequisites).values({ learningPathVersionId: fx.versions.version2.id, prerequisiteSkillId: fx.content.skillB.id, skillId: fx.content.skillA.id }))
    await approveTask(fx.content.taskA.id)
    expect((await send(fx.content.taskB.id, 'learner', evidence)).status).toBe(201)
  })

  for (const loss of ['mastery', 'xp'] as const) it(`blocks corrections after ${loss} loss, preserving pending revisions and private editable drafts`, async () => {
    await gateB(loss === 'xp' ? 20 : 0, loss === 'xp' ? [] : [fx.content.skillA.id])
    await rewardA(20)
    const approved = await approveTask(fx.content.taskA.id)
    const { revision } = await (await send(fx.content.taskB.id, 'learner', evidence)).json() as any
    await saveDraft(fx.content.taskB.id, 'learner', { text: 'Private correction', urls: [] })
    await revoke(approved)
    const rejected = await send(fx.content.taskB.id, 'learner', { text: 'Blocked correction', urls: [] })
    expect(rejected.status).toBe(403)
    expect(await errorOf(rejected)).toBe('skill_locked')
    for (const actor of ['learner', 'coach'] as const) {
      const { submission } = await (await readSubmission(fx.content.taskB.id, actor)).json() as any
      expect(submission.revisions).toEqual([expect.objectContaining({ id: revision.id, status: 'pending', supersededAt: null, ...evidence })])
    }
    expect(await (await readDraft(fx.content.taskB.id, 'learner')).json()).toMatchObject({ draft: { text: 'Private correction' } })
    expect((await saveDraft(fx.content.taskB.id, 'learner', { text: 'Still editable while locked', urls: [] })).status).toBe(200)
    expect((await readDraft(fx.content.taskB.id, 'coach')).status).toBe(403)
    expect(await storedRevisions()).toHaveLength(2)
  })

  it('waits for an Enrollment-locked invalidation and evaluates the committed evidence', async () => {
    await gateB(20)
    await rewardA(20)
    const approved = await approveTask(fx.content.taskA.id)
    const other = createDatabase(TEST_DATABASE_URL, 1)
    let release!: () => void
    let ready!: (pid: number) => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const locked = new Promise<number>((resolve) => { ready = resolve })
    const invalidation = other.db.transaction(async (tx) => {
      await tx.select().from(enrollments).where(eq(enrollments.id, enrollmentId)).for('update')
      await tx.update(submissionReviews).set({ revokedAt: new Date(), revocationReason: 'Test invalidation' }).where(eq(submissionReviews.revisionId, approved))
      const [connection] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
      ready(connection.pid)
      await barrier
    })
    try {
      const pid = await locked
      const pendingSend = send(fx.content.taskB.id, 'learner', evidence)
      let blocked = false
      for (let attempt = 0; attempt < 200; attempt++) {
        const [state] = await db.execute<{ blocked: boolean }>(sql`select exists(select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))) as blocked`)
        if (state.blocked) { blocked = true; break }
        await Bun.sleep(5)
      }
      // Database-observed lock wait is the barrier, not elapsed time.
      expect(blocked).toBe(true)
      release()
      await invalidation
      expect((await pendingSend).status).toBe(403)
      expect((await storedSubmissions()).map((s) => s.taskId)).toEqual([fx.content.taskA.id])
    } finally {
      release()
      await invalidation
      await other.close()
    }
  })
})

const evidence = { text: 'Submitted evidence', urls: [] }
const versionTask = (taskId: string) => and(eq(versionTasks.learningPathVersionId, fx.versions.version1.id), eq(versionTasks.taskId, taskId))
async function rewardA(xpReward: number) {
  await amendPublished(db, (tx) => tx.update(versionTasks).set({ xpReward }).where(versionTask(fx.content.taskA.id)))
}
async function gateB(xpThreshold: number, prerequisites = [fx.content.skillA.id]) {
  await amendPublished(db, (tx) => tx.update(versionSkills).set({ xpThreshold }).where(and(eq(versionSkills.learningPathVersionId, fx.versions.version1.id), eq(versionSkills.skillId, fx.content.skillB.id))))
  if (prerequisites.length) await amendPublished(db, (tx) => tx.insert(versionPrerequisites).values(prerequisites.map((prerequisiteSkillId) => ({ learningPathVersionId: fx.versions.version1.id, prerequisiteSkillId, skillId: fx.content.skillB.id }))))
}
// Test-only Review/revocation fixtures: not end-to-end Coach Review or revocation API proof.
async function reviewFixture(revisionId: string, decision: 'approval' | 'changes_requested', coachAccountId = fx.accounts.coach.id, enrollment = enrollmentId) {
  await db.transaction(async (tx) => {
    await tx.select().from(enrollments).where(eq(enrollments.id, enrollment)).for('update')
    await tx.insert(submissionReviews).values({ revisionId, decision, coachAccountId, feedback: decision === 'changes_requested' ? 'Please correct the evidence' : null })
  })
}
async function approveTask(taskId: string, actor: Actor = 'learner', enrollment = enrollmentId) {
  const res = await send(taskId, actor, evidence, enrollment)
  expect(res.status).toBe(201)
  const { revision } = await res.json() as any
  await reviewFixture(revision.id, 'approval', fx.accounts.coach.id, enrollment)
  return revision.id as string
}
async function revoke(revisionId: string) {
  await db.transaction(async (tx) => {
    await tx.select().from(enrollments).where(eq(enrollments.id, enrollmentId)).for('update')
    await tx.update(submissionReviews).set({ revokedAt: new Date(), revocationReason: 'Test-only correction' }).where(eq(submissionReviews.revisionId, revisionId))
  })
}
async function extraSkill(required: boolean) {
  const [skill] = await db.insert(skills).values({ learningPathId: fx.paths.path.id }).returning()
  await amendPublished(db, (tx) => tx.insert(versionSkills).values({ learningPathVersionId: fx.versions.version1.id, skillId: skill.id, title: 'Additional prerequisite', learningOutcome: 'Additional evidence' }))
  const [task] = await db.insert(tasks).values({ skillId: skill.id }).returning()
  await amendPublished(db, (tx) => tx.insert(versionTasks).values({ learningPathVersionId: fx.versions.version1.id, taskId: task.id, skillId: skill.id, title: 'Additional Task', required }))
  return { skill, task }
}

describe('AC2: sending creates an immutable revision in one Submission per Task and Enrollment', () => {
  it('creates the Submission and its first revision for exactly one Task', async () => {
    const res = await send(fx.content.taskA.id, 'learner', { text: 'My answer', urls: ['https://example.com/work'] })
    expect(res.status).toBe(201)
    const body = await res.json() as any
    expect(body.createdSubmission).toBe(true)
    expect(body.submission).toMatchObject({ enrollmentId, taskId: fx.content.taskA.id, learningPathVersionId: fx.versions.version1.id })
    expect(body.revision).toMatchObject({ submissionId: body.submission.id, revisionNumber: 1, text: 'My answer', urls: ['https://example.com/work'], supersededAt: null })

    expect(await storedSubmissions()).toEqual([expect.objectContaining({ id: body.submission.id, enrollmentId, taskId: fx.content.taskA.id })])
    expect(await storedRevisions()).toEqual([expect.objectContaining({ id: body.revision.id, submissionId: body.submission.id, revisionNumber: 1 })])
  })

  it('reuses the one Submission for later revisions', async () => {
    const first = await (await send(fx.content.taskA.id, 'learner', { text: 'One', urls: [] })).json() as any
    const second = await (await send(fx.content.taskA.id, 'learner', { text: 'Two', urls: [] })).json() as any
    expect(second).toMatchObject({ createdSubmission: false, submission: { id: first.submission.id }, revision: { revisionNumber: 2 } })
    expect(await storedSubmissions()).toHaveLength(1)
  })

  it('keeps one Submission under competing sends, with distinct ordered revisions', async () => {
    const sends = 24
    const responses = await Promise.all(Array.from({ length: sends }, (_, i) => send(fx.content.taskA.id, 'learner', { text: `Attempt ${i}`, urls: [] })))
    expect(responses.map((r) => r.status)).toEqual(Array(sends).fill(201))
    const bodies = await Promise.all(responses.map((r) => r.json() as Promise<any>))
    expect(bodies.filter((b) => b.createdSubmission)).toHaveLength(1)
    expect(new Set(bodies.map((b) => b.submission.id)).size).toBe(1)

    expect(await storedSubmissions()).toHaveLength(1)
    const revisions = await storedRevisions()
    expect(revisions.map((r) => r.revisionNumber)).toEqual(Array.from({ length: sends }, (_, i) => i + 1))
    // Exactly the last revision in the authoritative order is pending.
    expect(revisions.filter((r) => r.supersededAt === null).map((r) => r.revisionNumber)).toEqual([sends])
    // Every response describes a revision that was stored with its own contents.
    for (const body of bodies) expect(revisions.find((r) => r.id === body.revision.id)?.text).toBe(body.revision.text)
  })

  it('lets only the learner send', async () => {
    const coach = await send(fx.content.taskA.id, 'coach', { text: 'Coach work', urls: [] })
    expect(coach.status).toBe(403)
    expect(await errorOf(coach)).toBe('learner_only')
    for (const actor of ['peer', 'unrelated', 'otherCoach'] as const) {
      expect((await send(fx.content.taskA.id, actor, { text: 'Not mine', urls: [] })).status).toBe(404)
    }
    expect((await send(fx.content.taskA.id, null, { text: 'Anonymous', urls: [] })).status).toBe(401)
    expect(await storedSubmissions()).toHaveLength(0)
    expect(await storedRevisions()).toHaveLength(0)
  })

  it('rejects empty or invalid contents and Tasks outside the Version without storing anything', async () => {
    const outside = await taskOutsideVersion1()
    const cases: Array<[string, unknown, number, string]> = [
      [fx.content.taskA.id, { text: '   ', urls: [] }, 422, 'empty_submission'],
      [fx.content.taskA.id, { text: 'x', urls: ['ftp://example.com/file'] }, 422, 'invalid_contents'],
      [fx.content.taskA.id, { text: 'x', urls: ['/relative/path'] }, 422, 'invalid_contents'],
      [fx.content.taskA.id, { text: 42, urls: [] }, 422, 'invalid_contents'],
      [outside, { text: 'x', urls: [] }, 404, 'task_not_found'],
    ]
    for (const [taskId, body, status, error] of cases) {
      const res = await send(taskId, 'learner', body)
      expect(res.status).toBe(status)
      expect(await errorOf(res)).toBe(error)
    }
    expect(await storedSubmissions()).toHaveLength(0)
  })
})

describe('AC3: evidence retained exactly as sent', () => {
  it('keeps text and URLs byte-for-byte without fetching or freezing their destinations', async () => {
    let destinationHits = 0
    const destination = Bun.serve({ port: 0, fetch: () => { destinationHits++; return new Response('external work v1') } })
    try {
      const evidence = {
        text: '  Proof:\n\t‖u + v‖ ≤ ‖u‖ + ‖v‖ — see ✓ notes  \n',
        // Unnormalized forms a URL parser would rewrite.
        urls: [`http://127.0.0.1:${destination.port}/work/../draft?b=2&a=1#Section`, 'HTTPS://Example.COM:443/Repo/blob/main/README.md'],
      }
      const sent = await send(fx.content.taskA.id, 'learner', evidence)
      expect(sent.status).toBe(201)
      const { revision } = await sent.json() as any
      expect({ text: revision.text, urls: revision.urls }).toEqual(evidence)

      for (const actor of ['learner', 'coach'] as const) {
        const read = await (await readSubmission(fx.content.taskA.id, actor)).json() as any
        expect({ text: read.submission.revisions[0].text, urls: read.submission.revisions[0].urls }).toEqual(evidence)
        // A revision carries the sent text and URLs only: no archived copy or claim about the destination.
        expect(Object.keys(read.submission.revisions[0]).sort()).toEqual(['id', 'revisionNumber', 'sentAt', 'status', 'submissionId', 'supersededAt', 'text', 'urls'])
      }
      const [stored] = await storedRevisions()
      expect({ text: stored.text, urls: stored.urls }).toEqual(evidence)
      expect(destinationHits).toBe(0)
    } finally {
      destination.stop(true)
    }
  })
})

describe('AC4: supersession and immutability', () => {
  it('supersedes earlier pending revisions and leaves their contents unchanged', async () => {
    for (const text of ['First', 'Second', 'Third']) await send(fx.content.taskA.id, 'learner', { text, urls: [] })
    const res = await readSubmission(fx.content.taskA.id, 'learner')
    expect(res.status).toBe(200)
    const { submission } = await res.json() as any
    expect(submission.revisions.map((r: any) => [r.revisionNumber, r.text, r.status])).toEqual([
      [1, 'First', 'superseded'],
      [2, 'Second', 'superseded'],
      [3, 'Third', 'pending'],
    ])
    const stored = await storedRevisions()
    expect(stored.map((r) => r.supersededAt === null)).toEqual([false, false, true])
    // Supersession keeps the moment it happened: the first revision's time is not rewritten by the third send.
    expect(stored[0].supersededAt!.getTime()).toBeLessThanOrEqual(stored[2].sentAt.getTime())
  })

  it('offers no request that edits sent contents in place', async () => {
    const { submission, revision } = await (await send(fx.content.taskA.id, 'learner', { text: 'Original', urls: ['https://example.com/v1'] })).json() as any
    const attempts = [
      request(`${taskPath(fx.content.taskA.id)}/submission/revisions/${revision.id}`, 'learner', { method: 'PUT', body: { text: 'Edited', urls: [] } }),
      request(`${taskPath(fx.content.taskA.id)}/submission/revisions/${revision.id}`, 'learner', { method: 'PATCH', body: { text: 'Edited' } }),
      request(`${taskPath(fx.content.taskA.id)}/submission/revisions/${revision.id}`, 'learner', { method: 'DELETE' }),
      request(`${taskPath(fx.content.taskA.id)}/submission`, 'learner', { method: 'PUT', body: { text: 'Edited', urls: [] } }),
    ]
    for (const res of await Promise.all(attempts)) expect(res.status).toBe(404)
    // Editing the private draft afterwards does not reach the sent revision.
    await saveDraft(fx.content.taskA.id, 'learner', { text: 'Edited draft', urls: [] })

    const read = await (await readSubmission(fx.content.taskA.id, 'coach')).json() as any
    expect(read.submission).toMatchObject({ id: submission.id, revisions: [{ id: revision.id, text: 'Original', urls: ['https://example.com/v1'], status: 'pending' }] })
  })

  it('rejects in-place edits at the database too', async () => {
    await send(fx.content.taskA.id, 'learner', { text: 'Original', urls: [] })
    await send(fx.content.taskA.id, 'learner', { text: 'Correction', urls: [] })
    const [first] = await storedRevisions()
    const attempt = (statement: ReturnType<typeof sql>) => db.execute(statement).then(() => null, (e: unknown) => String((e as { cause?: unknown })?.cause ?? e))
    expect(await attempt(sql`update submission_revisions set text = 'Rewritten' where id = ${first.id}`)).toContain('is immutable')
    expect(await attempt(sql`update submission_revisions set urls = '{https://example.com/new}' where id = ${first.id}`)).toContain('is immutable')
    expect(await attempt(sql`update submission_revisions set superseded_at = null where id = ${first.id}`)).toContain('is immutable')
    expect((await storedRevisions())[0]).toEqual(first)
  })
})

describe('AC5: separate Task histories and unavailable Access', () => {
  it('keeps reused evidence in a separate Submission per Task', async () => {
    const evidence = { text: 'Project covering vectors and matrices', urls: ['https://github.com/learner/linear-algebra'] }
    const a = await (await send(fx.content.taskA.id, 'learner', evidence)).json() as any
    const b = await (await send(fx.content.taskB.id, 'learner', evidence)).json() as any
    expect(a.submission.id).not.toBe(b.submission.id)
    expect([a.createdSubmission, b.createdSubmission]).toEqual([true, true])
    expect([a.revision.revisionNumber, b.revision.revisionNumber]).toEqual([1, 1])

    // A correction on Task A supersedes nothing in Task B's history.
    await send(fx.content.taskA.id, 'learner', { ...evidence, text: 'Corrected project' })
    const readA = await (await readSubmission(fx.content.taskA.id, 'learner')).json() as any
    const readB = await (await readSubmission(fx.content.taskB.id, 'learner')).json() as any
    expect(readA.submission.revisions.map((r: any) => r.status)).toEqual(['superseded', 'pending'])
    expect(readB.submission.revisions.map((r: any) => [r.text, r.status])).toEqual([[evidence.text, 'pending']])
    expect((await storedSubmissions()).map((s) => s.taskId).sort()).toEqual([fx.content.taskA.id, fx.content.taskB.id].sort())
  })

  it('blocks new sends without Access and keeps existing work readable', async () => {
    const sent = await (await send(fx.content.taskA.id, 'learner', { text: 'Sent while active', urls: [] })).json() as any
    await saveDraft(fx.content.taskA.id, 'learner', { text: 'Unsent draft', urls: [] })
    // Fault injection: Enrollment Deactivation has no route yet, so the stored status stands in for it.
    await db.update(enrollments).set({ status: 'inactive' }).where(eq(enrollments.id, enrollmentId))

    for (const taskId of [fx.content.taskA.id, fx.content.taskB.id]) {
      const res = await send(taskId, 'learner', { text: 'Sent while inactive', urls: [] })
      expect(res.status).toBe(403)
      expect(await errorOf(res)).toBe('enrollment_inactive')
    }
    expect(await storedSubmissions()).toHaveLength(1)
    expect(await storedRevisions()).toEqual([expect.objectContaining({ id: sent.revision.id, text: 'Sent while active', supersededAt: null })])

    for (const actor of ['learner', 'coach'] as const) {
      const read = await (await readSubmission(fx.content.taskA.id, actor)).json() as any
      expect(read.submission.revisions).toEqual([expect.objectContaining({ id: sent.revision.id, status: 'pending' })])
    }
    expect(await (await readDraft(fx.content.taskA.id, 'learner')).json()).toMatchObject({ draft: { text: 'Unsent draft' } })
    expect((await readDraft(fx.content.taskA.id, 'coach')).status).toBe(403)
  })
})

describe('AC6: Submission reads and persistence before success', () => {
  it('lets only the learner and the owning Coach read the Submission', async () => {
    await send(fx.content.taskA.id, 'learner', { text: 'Visible to two', urls: [] })
    for (const actor of ['learner', 'coach'] as const) expect((await readSubmission(fx.content.taskA.id, actor)).status).toBe(200)
    for (const actor of ['peer', 'unrelated', 'otherCoach'] as const) {
      const res = await readSubmission(fx.content.taskA.id, actor)
      expect(res.status).toBe(404)
      expect(await errorOf(res)).toBe('enrollment_not_found')
    }
    expect((await readSubmission(fx.content.taskA.id, null)).status).toBe(401)
    expect(await errorOf(await readSubmission(fx.content.taskB.id, 'learner'))).toBe('submission_not_found')
  })

  it('answers 201 only after the revision is committed', async () => {
    const res = await send(fx.content.taskA.id, 'learner', { text: 'Durable', urls: [] })
    expect(res.status).toBe(201)
    const { revision } = await res.json() as any
    // A separate connection sees the committed rows as soon as the response arrives.
    const other = createDatabase(TEST_DATABASE_URL, 1)
    try {
      const [stored] = await other.db.select().from(submissionRevisions).where(eq(submissionRevisions.id, revision.id))
      expect(stored).toMatchObject({ text: 'Durable', revisionNumber: 1 })
    } finally {
      await other.close()
    }
  })

  it('reports no success and leaves no partial Submission when persistence fails', async () => {
    await saveDraft(fx.content.taskA.id, 'learner', { text: 'Keep me', urls: [] })
    // Fault injection: the revision insert fails after the Submission row was written in the same transaction.
    await db.execute(sql`create function fail_revision_insert() returns trigger language plpgsql as $$ begin raise exception 'injected persistence failure'; end $$`)
    await db.execute(sql`create trigger fail_revision_insert before insert on submission_revisions for each row execute function fail_revision_insert()`)
    try {
      const res = await send(fx.content.taskA.id, 'learner', { text: 'Lost', urls: [] })
      expect(res.status).toBe(500)
      expect(await res.text()).not.toContain('Lost')
    } finally {
      await db.execute(sql`drop trigger fail_revision_insert on submission_revisions`)
      await db.execute(sql`drop function fail_revision_insert()`)
    }
    expect(await storedSubmissions()).toHaveLength(0)
    expect(await storedRevisions()).toHaveLength(0)
    expect(await (await readDraft(fx.content.taskA.id, 'learner')).json()).toMatchObject({ draft: { text: 'Keep me' } })
  })
})
