import { afterAll, beforeAll, beforeEach, expect, it } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { createApp } from '../src/app'
import type { Database } from '../src/db/client'
import { learningPaths, learningPathVersions, versionPrerequisites, versionSkillCards, versionSkills, versionTasks } from '../src/db/schema'
import { FIXTURE_IDENTITY_HEADER, fixtureIdentity } from '../src/identity'
import { prepareTestDatabase, resetTestDatabase } from './support/database'
import { amendPublished, seedEnrollmentFixture, type EnrollmentFixture } from './support/fixtures'

/**
 * T21 (#22): an enrolled learner reads the Version their Enrollment joined, with its
 * latest shared Canvas Layout, beside the server-derived Access, Mastery and
 * Enrollment XP (ADR 0001, 0005, 0013). Only the learner and the owning Coach see an
 * Enrollment; learners cannot change the layout or the published content.
 *
 * Fixture Version 1 (amended as published content): Vectors (A) with a 20-XP Required
 * Task and an Enrichment reading; Matrices (B) requires Mastery of A and 20 XP, with a
 * 15-XP Required Task. Version 2 redefines the same logical Skills as "… (revised)".
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
    await tx.update(versionTasks).set({ xpReward: 20, description: 'Exercises 1–10' }).where(and(eq(versionTasks.learningPathVersionId, v1), eq(versionTasks.taskId, fx.content.taskA.id)))
    await tx.update(versionTasks).set({ xpReward: 15 }).where(and(eq(versionTasks.learningPathVersionId, v1), eq(versionTasks.taskId, fx.content.taskB.id)))
    await tx.update(versionSkills).set({ xpThreshold: 20 }).where(and(eq(versionSkills.learningPathVersionId, v1), eq(versionSkills.skillId, fx.content.skillB.id)))
    await tx.insert(versionPrerequisites).values({ learningPathVersionId: v1, prerequisiteSkillId: fx.content.skillA.id, skillId: fx.content.skillB.id })
  })
  await db.insert(versionSkillCards).values([
    { learningPathVersionId: v1, skillId: fx.content.skillA.id, x: 100, y: 120 },
    { learningPathVersionId: v1, skillId: fx.content.skillB.id, x: 420, y: 120 },
  ])
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
const enrolled = (actor: Actor = 'learner', id = enrollmentId) => request(`/enrollments/${id}/version`, actor)
const learningState = async (actor: Actor = 'learner', id = enrollmentId) => (await json(request(`/enrollments/${id}/learning-state`, actor), 200)).learningState
const taskPath = (task: string, id = enrollmentId) => `/enrollments/${id}/tasks/${task}/submission`
async function send(task: string, actor: Actor = 'learner', id = enrollmentId) {
  return (await json(request(`${taskPath(task, id)}/revisions`, actor, 'POST', { text: 'My evidence', urls: ['https://example.com/work'] }), 201)).revision.id as string
}
const approve = (task: string, revision: string, id = enrollmentId) => json(request(`${taskPath(task, id)}/revisions/${revision}/review`, 'coach', 'POST', { decision: 'approval' }), 201)
const skillOf = (state: any, id: string) => state.skills.find((s: any) => s.skillId === id)
/** Every stored row of the Path's Versions, including the shared layout, for "nothing changed" checks. */
async function stored() {
  const [path] = await db.select().from(learningPaths).where(eq(learningPaths.id, fx.paths.path.id))
  const versions = (await db.select().from(learningPathVersions).where(eq(learningPathVersions.learningPathId, path.id))).map((v) => v.id)
  const of = async (table: any) => (await db.select().from(table)).filter((row: any) => versions.includes(row.learningPathVersionId)).map((row: any) => JSON.stringify(row)).sort()
  return { path, versions, skills: await of(versionSkills), tasks: await of(versionTasks), edges: await of(versionPrerequisites), cards: await of(versionSkillCards) }
}

it('AC1: the learner opens the Version their Enrollment joined, with outcomes, Tasks and the shared layout, not a newer Version', async () => {
  const { skillA, skillB, taskA, taskAReading, taskB } = fx.content
  const body = await json(enrolled(), 200)
  expect(body).toMatchObject({
    enrollment: { id: enrollmentId, status: 'active', learningPathVersionId: fx.versions.version1.id },
    viewer: 'learner',
    learningPath: { id: fx.paths.path.id, title: 'Linear Algebra', goal: '' },
    version: { id: fx.versions.version1.id, versionNumber: 1 },
    coachWorkspace: { id: fx.workspaces.workspace.id, name: 'Linear Algebra with Coach' },
  })
  expect(body.version.publishedAt).not.toBeNull()
  // Version 1's own definitions: Version 2 is published, and its "(revised)" content never appears.
  expect(JSON.stringify(body)).not.toContain('revised')
  // Fixture rows share one ordinal, so the stored order is by ID: compare by ID.
  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)
  const shown = body.application.skills.map((s: any) => ({ ...s, tasks: [...s.tasks].sort(byId) })).sort(byId)
  expect(shown).toEqual([
    { id: skillA.id, title: 'Vectors', outcome: 'Add and scale vectors in R^n', optional: false, xpThreshold: 0, tasks: [
      { id: taskA.id, title: 'Vector exercises', description: 'Exercises 1–10', required: true, xpReward: 20 },
      { id: taskAReading.id, title: 'Read chapter 1', description: '', required: false, xpReward: 0 },
    ].sort(byId) },
    { id: skillB.id, title: 'Matrices', outcome: 'Multiply matrices and interpret them as linear maps', optional: false, xpThreshold: 20, tasks: [
      { id: taskB.id, title: 'Matrix exercises', description: '', required: true, xpReward: 15 },
    ] },
  ].sort(byId))
  expect(body.editor).toEqual({
    format_version: 1,
    cards: expect.arrayContaining([
      { id: skillA.id, title: 'Vectors', position: { x: 100, y: 120 } },
      { id: skillB.id, title: 'Matrices', position: { x: 420, y: 120 } },
    ]),
    connections: [{ from_id: skillA.id, to_id: skillB.id }],
  })
  expect(body.editor.cards).toHaveLength(2)
  // Nothing about the Coach's other Versions, Drafts or revision reaches the learner.
  for (const key of ['draft', 'versions', 'revision']) expect(JSON.stringify(body)).not.toContain(`"${key}"`)

  // The Coach moves a card of the shared layout (ADR 0005: positions are not learning content); reopening shows it.
  await db.update(versionSkillCards).set({ x: 640, y: 300 }).where(and(eq(versionSkillCards.learningPathVersionId, fx.versions.version1.id), eq(versionSkillCards.skillId, skillB.id)))
  const reopened = await json(enrolled(), 200)
  expect(reopened.editor.cards.find((c: any) => c.id === skillB.id).position).toEqual({ x: 640, y: 300 })
  expect(reopened.application).toEqual(body.application)

  // The learner's Enrollments list names the joined Version only.
  expect((await json(request('/enrollments'), 200)).enrollments).toEqual([{
    id: enrollmentId, status: 'active', learningPathVersionId: fx.versions.version1.id, versionNumber: 1,
    learningPathId: fx.paths.path.id, learningPathTitle: 'Linear Algebra', coachWorkspaceName: 'Linear Algebra with Coach',
    createdAt: expect.any(String),
  }])
})

it('AC2: Access, Mastery and Enrollment XP are separate; a Locked Skill keeps its reasons and its learning history stays readable', async () => {
  const { skillA, skillB, taskA, taskB } = fx.content
  const initial = await learningState()
  expect(initial).toMatchObject({ enrollmentId, enrollmentStatus: 'active', xp: 0 })
  expect(skillOf(initial, skillA.id)).toMatchObject({ access: true, mastery: false, unmetPrerequisiteSkillIds: [], xpShortfall: 0 })
  // Locked: the Skill's title and outcome stay readable beside both reasons.
  expect(skillOf(initial, skillB.id)).toMatchObject({ title: 'Matrices', learningOutcome: 'Multiply matrices and interpret them as linear maps', access: false, mastery: false, unmetPrerequisiteSkillIds: [skillA.id], xpShortfall: 20, xpThreshold: 20 })

  // An Approval of A's Required Task: 20 XP and Mastery of A, which together open B without spending XP.
  await approve(taskA.id, await send(taskA.id))
  const opened = await learningState()
  expect(opened.xp).toBe(20)
  expect(skillOf(opened, skillA.id)).toMatchObject({ access: true, mastery: true })
  expect(skillOf(opened, skillB.id)).toMatchObject({ access: true, mastery: false, unmetPrerequisiteSkillIds: [], xpShortfall: 0 })

  // Work on B while open, then the Coach revokes A's Approval: B is locked again, its work remains readable.
  await json(request(`/enrollments/${enrollmentId}/tasks/${taskB.id}/start`, 'learner', 'POST'), 201)
  const bRevision = await send(taskB.id)
  const aRevision = (await json(request(taskPath(taskA.id)), 200)).submission.revisions[0].id
  await json(request(`${taskPath(taskA.id)}/revisions/${aRevision}/review/revoke`, 'coach', 'POST', { reason: 'Wrong exercise set' }), 200)
  const relocked = await learningState()
  expect(relocked.xp).toBe(0)
  expect(skillOf(relocked, skillA.id)).toMatchObject({ access: true, mastery: false })
  expect(skillOf(relocked, skillB.id)).toMatchObject({ access: false, unmetPrerequisiteSkillIds: [skillA.id], xpShortfall: 20 })
  expect(relocked.taskStarts.map((s: any) => s.taskId)).toEqual([taskB.id])
  expect(relocked.xpHistory.map((e: any) => [e.taskId, e.amount])).toEqual([[taskA.id, 20], [taskA.id, -20]])
  const bHistory = (await json(request(taskPath(taskB.id)), 200)).submission
  expect(bHistory.revisions.map((r: any) => [r.id, r.status, r.text, r.urls])).toEqual([[bRevision, 'pending', 'My evidence', ['https://example.com/work']]])
  const aHistory = (await json(request(taskPath(taskA.id)), 200)).submission
  expect(aHistory.revisions[0]).toMatchObject({ status: 'approval_revoked', review: { decision: 'approval', revocationReason: 'Wrong exercise set' } })
  // Sending new work to the Locked Skill is refused; reading it is not.
  expect((await json(request(`${taskPath(taskB.id)}/revisions`, 'learner', 'POST', { text: 'More' }), 403)).error).toBe('skill_locked')

  // An inactive Enrollment has no Access anywhere, yet its Version and history stay readable.
  await json(request(`/enrollments/${enrollmentId}/deactivate`, 'learner', 'POST', {}), 200)
  const inactive = await learningState()
  expect(inactive.enrollmentStatus).toBe('inactive')
  expect(inactive.skills.every((s: any) => s.access === false)).toBe(true)
  expect((await json(enrolled(), 200)).enrollment.status).toBe('inactive')
  expect((await json(request(taskPath(taskB.id)), 200)).submission.revisions).toHaveLength(1)
})

it('AC3: learners cannot change card positions or published content through backend requests', async () => {
  const before = await stored()
  const body = await json(enrolled(), 200)
  const moved = structuredClone(body)
  moved.editor.cards[0].position = { x: -999, y: -999 }
  moved.application.skills[0].title = 'Renamed by learner'
  const document = { expectedRevision: before.path.revision, title: 'Mine', goal: '', editor: moved.editor, application: moved.application }
  const pathRoute = `/coach/learning-paths/${fx.paths.path.id}`
  const attempts = [
    request(pathRoute, 'learner'),
    request(`${pathRoute}/draft`, 'learner', 'PUT', document),
    request(`${pathRoute}/publication`, 'learner', 'POST', { expectedRevision: before.path.revision }),
    request(`${pathRoute}/drafts`, 'learner', 'POST', { expectedRevision: before.path.revision }),
    request(`/coach/learning-path-versions/${fx.versions.version1.id}`, 'learner'),
    request(`/coach/learning-path-versions/${fx.versions.version1.id}/enrollment-closure`, 'learner', 'PUT'),
    // The Enrollment's view of its Version is read-only: there is no write method on it.
    ...['PUT', 'POST', 'PATCH', 'DELETE'].map((method) => request(`/enrollments/${enrollmentId}/version`, 'learner', method, document)),
    request(`/enrollments/${enrollmentId}/version/layout`, 'learner', 'PUT', { cards: moved.editor.cards }),
  ]
  for (const response of await Promise.all(attempts)) expect(response.status).toBe(404)
  expect(await stored()).toEqual(before)
  expect(await json(enrolled(), 200)).toEqual(body)
})

it('AC5: an Enrollment is visible only to its learner and the owning Coach; others learn nothing about it', async () => {
  const learnerView = await json(enrolled(), 200)
  // The owning Coach reads the same pinned Version and records.
  const coachView = await json(enrolled('coach'), 200)
  expect(coachView).toEqual({ ...learnerView, viewer: 'coach' })
  expect(await learningState('coach')).toEqual(await learningState())

  await approve(fx.content.taskA.id, await send(fx.content.taskA.id))
  const routes = [
    `/enrollments/${enrollmentId}/version`,
    `/enrollments/${enrollmentId}/learning-state`,
    `/enrollments/${enrollmentId}`,
    taskPath(fx.content.taskA.id),
  ]
  // A peer in the same Version, another Workspace's Coach and an unrelated Account all get the unknown-Enrollment answer.
  for (const actor of ['peer', 'otherCoach', 'unrelated', 'unverified'] as const) {
    for (const route of routes) {
      const response = await request(route, actor)
      const text = await response.text()
      expect({ actor, route, status: response.status }).toEqual({ actor, route, status: 404 })
      expect(text).not.toContain('Vectors')
      expect(text).not.toContain('My evidence')
    }
  }
  for (const route of routes) expect((await request(route, null)).status).toBe(401)
  // An unknown or malformed Enrollment looks the same as someone else's.
  expect(await json(enrolled('learner', crypto.randomUUID()), 404)).toEqual({ error: 'enrollment_not_found' })
  expect(await json(enrolled('learner', 'not-a-uuid'), 404)).toEqual({ error: 'enrollment_not_found' })
  expect(await json(enrolled('peer'), 404)).toEqual({ error: 'enrollment_not_found' })

  // Each learner lists only their own Enrollments; the Coach holds none as a learner; anonymous is refused.
  expect((await json(request('/enrollments', 'peer'), 200)).enrollments.map((e: any) => e.id)).toEqual([peerEnrollmentId])
  expect((await json(request('/enrollments', 'learner'), 200)).enrollments.map((e: any) => e.id)).toEqual([enrollmentId])
  expect((await json(request('/enrollments', 'coach'), 200)).enrollments).toEqual([])
  expect((await json(request('/enrollments', 'otherCoach'), 200)).enrollments).toEqual([])
  expect((await request('/enrollments', null)).status).toBe(401)
  // The peer's own Enrollment shows the peer's (empty) records, never the learner's XP.
  expect((await learningState('peer', peerEnrollmentId)).xp).toBe(0)
})
