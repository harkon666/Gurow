import { afterAll, beforeAll, beforeEach, expect, it } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { createApp } from '../src/app'
import type { Database } from '../src/db/client'
import { learningPaths, learningPathVersions, versionPrerequisites, versionSkillCards, versionSkills, versionTasks } from '../src/db/schema'
import { FIXTURE_IDENTITY_HEADER, fixtureIdentity } from '../src/identity'
import { prepareTestDatabase, resetTestDatabase } from './support/database'
import { amendPublished, seedEnrollmentFixture, type EnrollmentFixture } from './support/fixtures'

/**
 * T27 (#28): the owning Coach rearranges a published Version's shared Canvas Layout
 * without creating a Version or touching its learning content (ADR 0005, 0016).
 * Layout saves carry card positions only, are based on the Version's layout revision,
 * and answer only to the owning Coach; enrolled learners see the latest layout on
 * reopening, with their learning records unchanged.
 *
 * Fixture Version 1 (as in T21): Vectors (A) with a 20-XP Required Task, Matrices (B)
 * requiring Mastery of A and 20 XP; cards A (100, 120) and B (420, 120). Version 2
 * redefines the same logical Skills.
 */
let db: Database, close: () => Promise<void>, fx: EnrollmentFixture, app: ReturnType<typeof createApp>, enrollmentId: string, v1: string
beforeAll(async () => { ({ db, close } = await prepareTestDatabase()) })
afterAll(async () => { await close() })
beforeEach(async () => {
  await resetTestDatabase(db)
  fx = await seedEnrollmentFixture(db)
  app = createApp({ db, identity: fixtureIdentity(fx.identities) })
  v1 = fx.versions.version1.id
  await amendPublished(db, async (tx) => {
    await tx.update(versionTasks).set({ xpReward: 20 }).where(and(eq(versionTasks.learningPathVersionId, v1), eq(versionTasks.taskId, fx.content.taskA.id)))
    await tx.update(versionSkills).set({ xpThreshold: 20 }).where(and(eq(versionSkills.learningPathVersionId, v1), eq(versionSkills.skillId, fx.content.skillB.id)))
    await tx.insert(versionPrerequisites).values({ learningPathVersionId: v1, prerequisiteSkillId: fx.content.skillA.id, skillId: fx.content.skillB.id })
  })
  await db.insert(versionSkillCards).values([
    { learningPathVersionId: v1, skillId: fx.content.skillA.id, x: 100, y: 120 },
    { learningPathVersionId: v1, skillId: fx.content.skillB.id, x: 420, y: 120 },
    { learningPathVersionId: fx.versions.version2.id, skillId: fx.content.skillA.id, x: 0, y: 0 },
  ])
  enrollmentId = (await json(request(`/invitations/${fx.invitations.toLearner.id}/accept`, 'learner', 'POST'), 201)).enrollment.id
})

type Actor = keyof EnrollmentFixture['identities'] | null
async function request(path: string, actor: Actor = 'coach', method = 'GET', body?: unknown) {
  return app.request(path, { method, headers: { ...(actor ? { [FIXTURE_IDENTITY_HEADER]: actor } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
}
async function json(response: Response | Promise<Response>, status: number) {
  const r = await response
  const body = await r.json().catch(() => null) as any
  expect({ status: r.status, body }).toMatchObject({ status })
  return body
}
const layoutRoute = (versionId = v1) => `/coach/learning-path-versions/${versionId}/layout`
const saveLayout = (body: unknown, actor: Actor = 'coach', versionId = v1) => request(layoutRoute(versionId), actor, 'PUT', body)
const moveB = (expectedRevision: number, x: number, y: number) => ({ expectedRevision, cards: [{ id: fx.content.skillB.id, position: { x, y } }] })
const enrolled = async () => json(request(`/enrollments/${enrollmentId}/version`, 'learner'), 200)
const positionOf = (document: any, skillId: string) => document.editor.cards.find((card: any) => card.id === skillId).position
const taskPath = (task: string) => `/enrollments/${enrollmentId}/tasks/${task}/submission`

/** Every stored row of the Path, its Versions and their content; the layout separately. */
async function stored() {
  const [path] = await db.select().from(learningPaths).where(eq(learningPaths.id, fx.paths.path.id))
  const versions = await db.select().from(learningPathVersions).where(eq(learningPathVersions.learningPathId, path.id))
  const ids = versions.map((v) => v.id)
  const of = async (table: any) => (await db.select().from(table)).filter((row: any) => ids.includes(row.learningPathVersionId)).map((row: any) => JSON.stringify(row)).sort()
  return {
    content: { path, versions: versions.map(({ layoutRevision: _, ...version }) => version), skills: await of(versionSkills), tasks: await of(versionTasks), edges: await of(versionPrerequisites) },
    layout: { revisions: Object.fromEntries(versions.map((v) => [v.id, v.layoutRevision])), cards: await of(versionSkillCards) },
  }
}

/** The learner's records and sent work as both readers see them. */
async function learning() {
  const records = await Promise.all((['learner', 'coach'] as const).map(async (actor) => (await json(request(`/enrollments/${enrollmentId}/learning-state`, actor), 200)).learningState))
  const work = await json(request(taskPath(fx.content.taskA.id), 'learner'), 200)
  return { records, work }
}

it('AC1: the owning Coach saves new card positions of a published Version without creating a Version or changing its content', async () => {
  const { skillA, skillB } = fx.content
  const before = await stored()
  const opened = await json(request(`/coach/learning-path-versions/${v1}`), 200)
  expect(opened.version).toMatchObject({ id: v1, versionNumber: 1, layoutRevision: 0 })

  const saved = await json(saveLayout({ expectedRevision: 0, cards: [{ id: skillA.id, position: { x: 100, y: 120 } }, { id: skillB.id, position: { x: 640, y: 300 } }] }), 200)
  expect(saved.version).toMatchObject({ id: v1, versionNumber: 1, layoutRevision: 1 })
  expect(positionOf(saved, skillB.id)).toEqual({ x: 640, y: 300 })
  expect(positionOf(saved, skillA.id)).toEqual({ x: 100, y: 120 })
  // Same Version, same content and rules, same Path revision; no Draft or Version appeared.
  expect(saved.application).toEqual(opened.application)
  expect(saved.editor.connections).toEqual(opened.editor.connections)
  expect(saved.learningPath).toEqual(opened.learningPath)
  expect(saved.versions).toEqual(opened.versions)
  expect(saved.draft).toBeNull()
  const after = await stored()
  expect(after.content).toEqual(before.content)
  expect(after.layout.revisions).toEqual({ ...before.layout.revisions, [v1]: 1 })
  // Only the moved card was written; Version 2's layout is its own.
  const [cardB] = await db.select().from(versionSkillCards).where(and(eq(versionSkillCards.learningPathVersionId, v1), eq(versionSkillCards.skillId, skillB.id)))
  expect(cardB).toMatchObject({ x: 640, y: 300 })
  expect(after.layout.cards.filter((row) => row.includes(fx.versions.version2.id))).toEqual(before.layout.cards.filter((row) => row.includes(fx.versions.version2.id)))

  // Reading the Version again shows the saved layout; a save that moves nothing keeps the revision.
  expect(positionOf(await json(request(`/coach/learning-path-versions/${v1}`), 200), skillB.id)).toEqual({ x: 640, y: 300 })
  expect((await json(saveLayout(moveB(1, 640, 300)), 200)).version.layoutRevision).toBe(1)
})

it('AC2: an enrolled learner sees the latest layout of their pinned Version on reopening, with its content unchanged', async () => {
  const { skillB } = fx.content
  const first = await enrolled()
  expect(positionOf(first, skillB.id)).toEqual({ x: 420, y: 120 })
  await json(saveLayout(moveB(0, -300, 480)), 200)
  const reopened = await enrolled()
  expect(positionOf(reopened, skillB.id)).toEqual({ x: -300, y: 480 })
  expect(reopened.version).toEqual(first.version)
  expect(reopened.application).toEqual(first.application)
  expect(reopened.editor.connections).toEqual(first.editor.connections)
  expect(reopened.enrollment).toEqual(first.enrollment)
})

it('AC3: a layout save cannot change Skills, Tasks, Prerequisites, progress, Reviews or XP, and answers only to the owning Coach', async () => {
  const { skillA, skillB, taskA } = fx.content
  // Learning history first: an approved Required Task (20 XP, Mastery of A) and pending work on B.
  const revision = (await json(request(`${taskPath(taskA.id)}/revisions`, 'learner', 'POST', { text: 'My evidence' }), 201)).revision.id
  await json(request(`${taskPath(taskA.id)}/revisions/${revision}/review`, 'coach', 'POST', { decision: 'approval', feedback: 'Good' }), 201)
  await json(request(`/enrollments/${enrollmentId}/tasks/${fx.content.taskB.id}/start`, 'learner', 'POST'), 201)
  const history = await learning()
  expect(history.records[0]).toMatchObject({ xp: 20 })

  const before = await stored()
  const shown = await enrolled()
  // Bodies that name anything besides positions are refused as a whole, even with a valid move.
  const content = {
    ...moveB(0, 900, 900),
    application: { skills: shown.application.skills.map((skill: any) => ({ ...skill, title: 'Renamed' })) },
  }
  const refused = [
    content,
    { ...moveB(0, 900, 900), connections: [] },
    { ...moveB(0, 900, 900), editor: { cards: [], connections: [] } },
    { ...moveB(0, 900, 900), title: 'Renamed', goal: '' },
    { expectedRevision: 0, cards: [{ id: skillB.id, title: 'Renamed', position: { x: 900, y: 900 } }] },
    { expectedRevision: 0, cards: [{ id: skillB.id, position: { x: 900, y: 900 }, xpThreshold: 0 }] },
    { expectedRevision: 0, cards: [{ id: skillB.id, position: { x: 2_000_000, y: 0 } }] },
    { expectedRevision: 0, cards: [{ id: skillB.id, position: { x: 1, y: 1 } }, { id: skillB.id, position: { x: 2, y: 2 } }] },
    { expectedRevision: -1, cards: [] },
    { cards: [] },
    [],
  ]
  for (const body of refused) expect((await json(saveLayout(body), 422)).error).toBe('invalid_layout')
  // A card of another Path's Skill, or of a Skill outside this Version, is refused too.
  const foreign = crypto.randomUUID()
  expect((await json(saveLayout({ expectedRevision: 0, cards: [{ id: skillA.id, position: { x: 5, y: 5 } }, { id: foreign, position: { x: 1, y: 1 } }] }), 422)).error).toBe('skill_not_in_version')

  // Nobody but the owning Coach finds the Version: learners, other Coaches, the unauthenticated, and invalid ids.
  const others: Actor[] = ['learner', 'peer', 'unrelated', 'otherCoach']
  for (const actor of others) {
    expect((await json(saveLayout(moveB(0, 900, 900), actor), 404)).error).toBe('version_not_found')
    // A malformed body does not tell them the Version exists either.
    expect((await json(saveLayout({ ...moveB(0, 900, 900), title: 'x' }, actor), 404)).error).toBe('version_not_found')
  }
  expect((await saveLayout(moveB(0, 900, 900), null)).status).toBe(401)
  expect((await json(saveLayout(moveB(0, 900, 900), 'coach', 'not-a-uuid'), 404)).error).toBe('version_not_found')
  // The learner's own Enrollment view has no layout route.
  for (const method of ['PUT', 'POST', 'PATCH']) expect((await request(`/enrollments/${enrollmentId}/version/layout`, 'learner', method, moveB(0, 900, 900))).status).toBe(404)

  expect(await stored()).toEqual(before)
  expect(await enrolled()).toEqual(shown)

  // A valid layout save changes the layout and nothing the learner did or was given.
  await json(saveLayout(moveB(0, 900, 900)), 200)
  const after = await stored()
  expect(after.content).toEqual(before.content)
  expect(await learning()).toEqual(history)
  const reopened = await enrolled()
  expect(positionOf(reopened, skillB.id)).toEqual({ x: 900, y: 900 })
  expect(reopened.application).toEqual(shown.application)
})

it('AC3: a Draft is not a published Version; its layout is saved with the Draft', async () => {
  const [path] = await db.select().from(learningPaths).where(eq(learningPaths.id, fx.paths.path.id))
  const draft = await json(request(`/coach/learning-paths/${fx.paths.path.id}/drafts`, 'coach', 'POST', { expectedRevision: path.revision }), 201)
  expect(draft.draft).toMatchObject({ versionNumber: 3 })
  const before = await stored()
  expect((await json(saveLayout(moveB(0, 900, 900), 'coach', draft.draft.id), 404)).error).toBe('version_not_found')
  expect(await stored()).toEqual(before)
})

it('AC4: a save based on a stale layout revision is refused and changes nothing; undoing a saved move is a new, validated save', async () => {
  const { skillB } = fx.content
  // Two tabs opened at layout revision 0: the first save wins, the second is refused with the accepted layout.
  await json(saveLayout(moveB(0, 640, 300)), 200)
  const stale = await json(saveLayout(moveB(0, -50, -50)), 409)
  expect(stale.error).toBe('stale_revision')
  expect(stale.current.version).toMatchObject({ id: v1, layoutRevision: 1 })
  expect(positionOf(stale.current, skillB.id)).toEqual({ x: 640, y: 300 })
  expect(positionOf(await enrolled(), skillB.id)).toEqual({ x: 640, y: 300 })

  // Undoing the saved move in the editor sends its earlier position as a new save on the accepted revision.
  const undone = await json(saveLayout(moveB(1, 420, 120)), 200)
  expect(undone.version.layoutRevision).toBe(2)
  expect(positionOf(undone, skillB.id)).toEqual({ x: 420, y: 120 })
  // History is not rewound: revision 1 is gone as a base, and the undo is now the accepted state.
  expect((await json(saveLayout(moveB(1, 640, 300)), 409)).error).toBe('stale_revision')
  expect(positionOf(await enrolled(), skillB.id)).toEqual({ x: 420, y: 120 })

  // Concurrent saves on the same revision: exactly one is accepted.
  const results = await Promise.all([saveLayout(moveB(2, 1, 1)), saveLayout(moveB(2, 2, 2))])
  expect(results.map((r) => r.status).sort()).toEqual([200, 409])
  const [winner] = await Promise.all(results.filter((r) => r.status === 200).map((r) => r.json() as Promise<any>))
  expect(positionOf(await enrolled(), skillB.id)).toEqual(positionOf(winner, skillB.id))
  expect((await stored()).layout.revisions[v1]).toBe(3)
})
