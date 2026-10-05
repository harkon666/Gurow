import { afterAll, beforeAll, beforeEach, expect, it } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'
import { createApp } from '../src/app'
import { createDatabase, type Database } from '../src/db/client'
import { enrollments, learningPaths, learningPathVersions, skills, tasks, versionPrerequisites, versionSkillCards, versionSkills, versionTasks } from '../src/db/schema'
import { FIXTURE_IDENTITY_HEADER, fixtureIdentity } from '../src/identity'
import { checkRequiredRoute } from '../src/publication'
import { waitForBlockedBy } from './support/blocking'
import { prepareTestDatabase, resetTestDatabase, TEST_DATABASE_URL } from './support/database'
import { seedEnrollmentFixture, type EnrollmentFixture } from './support/fixtures'

/**
 * T19 (#20): publishing a Coach's Draft as an immutable Learning Path Version through
 * the request boundary on PostgreSQL. Publication checks the required route
 * (ADR 0008); published content is frozen (ADR 0005) in the application and the
 * database; updates go into a new Draft with the same logical IDs (ADR 0004).
 */
let db: Database, close: () => Promise<void>, fx: EnrollmentFixture, app: ReturnType<typeof createApp>
beforeAll(async () => { ({ db, close } = await prepareTestDatabase()) })
afterAll(async () => { await close() })
beforeEach(async () => {
  await resetTestDatabase(db)
  fx = await seedEnrollmentFixture(db)
  app = createApp({ db, identity: fixtureIdentity(fx.identities) })
})

type Actor = keyof EnrollmentFixture['identities'] | null
async function request(path: string, actor: Actor = 'coach', method = 'GET', body?: unknown) {
  return app.request(path, { method, headers: { ...(actor ? { [FIXTURE_IDENTITY_HEADER]: actor } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
}
async function json(response: Response | Promise<Response>, status: number) {
  const r = await response
  const body = await r.json() as any
  expect({ status: r.status, body }).toMatchObject({ status })
  return body
}

interface Task { id: string; title: string; description: string; required: boolean; xpReward: number }
interface Skill { id: string; title: string; outcome: string; optional: boolean; xpThreshold: number; tasks: Task[] }
interface Doc {
  learningPath: { id: string; coachWorkspaceId: string; title: string; goal: string; revision: number }
  draft: { id: string; versionNumber: number } | null
  version: { id: string; versionNumber: number; publishedAt: string | null } | null
  versions: { id: string; versionNumber: number; publishedAt: string; enrollmentClosed: boolean }[]
  editor: { format_version: 1; cards: { id: string; title: string; position: { x: number; y: number } }[]; connections: { from_id: string; to_id: string }[] }
  application: { skills: Skill[] }
}
const coachPath = (pathId: string) => `/coach/learning-paths/${pathId}`
const read = (pathId: string, actor: Actor = 'coach') => request(coachPath(pathId), actor)
const save = (pathId: string, body: unknown, actor: Actor = 'coach') => request(`${coachPath(pathId)}/draft`, actor, 'PUT', body)
const publish = (pathId: string, expectedRevision: unknown, actor: Actor = 'coach') => request(`${coachPath(pathId)}/publication`, actor, 'POST', { expectedRevision })
const prepare = (pathId: string, expectedRevision: unknown, actor: Actor = 'coach') => request(`${coachPath(pathId)}/drafts`, actor, 'POST', { expectedRevision })
const readVersion = (versionId: string, actor: Actor = 'coach') => request(`/coach/learning-path-versions/${versionId}`, actor)
const edit = (doc: Doc, change: (d: Doc) => void = () => {}) => {
  const next = structuredClone(doc)
  change(next)
  return { expectedRevision: doc.learningPath.revision, title: next.learningPath.title, goal: next.learningPath.goal, editor: next.editor, application: next.application }
}
const task = (title: string, required: boolean, xpReward: number): Task => ({ id: crypto.randomUUID(), title, description: `${title} notes`, required, xpReward })
const addSkill = (d: Doc, title: string, rules: { optional?: boolean; xpThreshold?: number } = {}, tasks: Task[] = []) => {
  const id = crypto.randomUUID()
  d.editor.cards.push({ id, title, position: { x: 80 + d.editor.cards.length * 240, y: 100 } })
  d.application.skills.push({ id, title, outcome: `${title} outcome`, optional: rules.optional ?? false, xpThreshold: rules.xpThreshold ?? 0, tasks })
  return id
}
const connect = (d: Doc, from: string, to: string) => d.editor.connections.push({ from_id: from, to_id: to })
async function newPath(title = 'Linear Algebra'): Promise<Doc> {
  const { workspace } = await json(request('/coach/workspaces', 'coach', 'POST', { name: 'Studio' }), 201)
  return json(request(`/coach/workspaces/${workspace.id}/learning-paths`, 'coach', 'POST', { title, goal: `${title} goal` }), 201)
}
async function draftWith(change: (d: Doc) => void): Promise<Doc> {
  const created = await newPath()
  return json(save(created.learningPath.id, edit(created, change)), 200)
}
/** Every stored row of a Path's Versions, for "nothing changed" checks. */
async function stored(pathId: string) {
  const [path] = await db.select().from(learningPaths).where(eq(learningPaths.id, pathId))
  const versions = await db.select().from(learningPathVersions).where(eq(learningPathVersions.learningPathId, pathId))
  const ids = versions.map((v) => v.id)
  const of = async (table: any) => (await db.select().from(table)).filter((row: any) => ids.includes(row.learningPathVersionId)).map((row: any) => JSON.stringify(row)).sort()
  return { path, versions: versions.map((v) => JSON.stringify(v)).sort(), skills: await of(versionSkills), tasks: await of(versionTasks), cards: await of(versionSkillCards), edges: await of(versionPrerequisites) }
}
const blockedOf = (refusal: any) => Object.fromEntries(refusal.blockedSkills.map((s: any) => [s.title, s.unmet.map((u: any) => u.kind === 'prerequisite' ? `prerequisite:${u.title}` : u.kind === 'xp_threshold' ? `xp:${u.xpThreshold}/${u.reachableXp}` : u.kind)]))

it('AC1/AC2: only Required Tasks on reachable required Skills fund the route; 60 reachable XP cannot open a 100-XP Skill', async () => {
  let vectors = '', matrices = '', history = ''
  const draft = await draftWith((d) => {
    // Listed before its Prerequisite: the check does not depend on list order.
    matrices = addSkill(d, 'Matrices', { xpThreshold: 100 }, [task('Matrix exercises', true, 10)])
    vectors = addSkill(d, 'Vectors', {}, [task('Vector drills', true, 30), task('Vector proofs', true, 30), task('Read chapter 1', false, 50)])
    // Optional work offers the missing 40 XP and more; it must not count.
    history = addSkill(d, 'History of algebra', { optional: true }, [task('Essay', true, 50), task('Timeline', false, 50)])
    connect(d, vectors, matrices)
    connect(d, vectors, history)
  })
  const before = await stored(draft.learningPath.id)
  const refused = await json(publish(draft.learningPath.id, draft.learningPath.revision), 422)
  expect(refused).toMatchObject({ error: 'publication_blocked', reachableXp: 60 })
  expect(blockedOf(refused)).toEqual({ Matrices: ['xp:100/60'] })
  expect(refused.blockedSkills[0].skillId).toBe(matrices)
  expect(refused.detail).toBe('The required route is blocked: "Matrices" needs 100 XP, but Required Tasks on reachable required Skills award only 60 XP')
  // Nothing was published and the Draft is untouched.
  expect(await stored(draft.learningPath.id)).toEqual(before)
  expect((await json(read(draft.learningPath.id), 200)).draft).toEqual(draft.draft)

  // Turning the Enrichment Task into a Required one is enough: 110 XP from Vectors' Required Tasks.
  const fixed: Doc = await json(save(draft.learningPath.id, edit(draft, (d) => { d.application.skills[1].tasks[2].required = true })), 200)
  const published: Doc = await json(publish(fixed.learningPath.id, fixed.learningPath.revision), 200)
  expect(published.draft).toBeNull()
  expect(published.version).toMatchObject({ id: fixed.draft!.id, versionNumber: 1 })
  expect(published.versions.map((v) => v.versionNumber)).toEqual([1])
  expect(published.learningPath.revision).toBe(fixed.learningPath.revision + 1)
  const [row] = await db.select().from(learningPathVersions).where(eq(learningPathVersions.id, fixed.draft!.id))
  expect(row.publishedAt).not.toBeNull()
  expect(published.application).toEqual(fixed.application)
})

it('AC1: locked work never pays for its own unlock, and blocked Prerequisites block every Skill after them', async () => {
  const draft = await draftWith((d) => {
    // Its own 20-XP Task would satisfy its 20-XP threshold, but only once it is open.
    const selfFunded = addSkill(d, 'Determinants', { xpThreshold: 20 }, [task('Compute determinants', true, 20)])
    const later = addSkill(d, 'Eigenvalues', {}, [task('Find eigenvalues', true, 5)])
    connect(d, selfFunded, later)
    const start = addSkill(d, 'Vectors', {}, [task('Vector drills', true, 15)])
    // Reachable only through Vectors' Mastery and its 15 XP.
    const next = addSkill(d, 'Matrices', { xpThreshold: 15 }, [task('Matrix drills', true, 0)])
    connect(d, start, next)
  })
  const refused = await json(publish(draft.learningPath.id, draft.learningPath.revision), 422)
  expect(refused.reachableXp).toBe(15)
  expect(blockedOf(refused)).toEqual({ Determinants: ['xp:20/15'], Eigenvalues: ['prerequisite:Determinants'] })
})

it('AC3: every required Skill needs a nonempty Required Task set; Optional Skills and an empty route do not', async () => {
  const draft = await draftWith((d) => {
    const empty = addSkill(d, 'Eigenvalues')
    const enrichmentOnly = addSkill(d, 'Matrices', {}, [task('Optional reading', false, 40)])
    const dependent = addSkill(d, 'Linear maps', {}, [task('Map drills', true, 10)])
    connect(d, enrichmentOnly, dependent)
    addSkill(d, 'Puzzles', { optional: true })
    connect(d, empty, addSkill(d, 'Trivia', { optional: true }))
    addSkill(d, 'Vectors', {}, [task('Vector drills', true, 10)])
  })
  const refused = await json(publish(draft.learningPath.id, draft.learningPath.revision), 422)
  // Optional Skills without Tasks do not block; required Skills without Required Tasks do, and so does what depends on them.
  expect(blockedOf(refused)).toEqual({ Eigenvalues: ['required_task'], Matrices: ['required_task'], 'Linear maps': ['prerequisite:Matrices'] })
  expect(refused.detail).toContain('"Eigenvalues" has no Required Task, so its Mastery can never be earned')

  // A Draft with nothing required has no route to complete.
  const onlyOptional = await draftWith((d) => { addSkill(d, 'Puzzles', { optional: true }, [task('Riddle', true, 5)]) })
  expect(await json(publish(onlyOptional.learningPath.id, onlyOptional.learningPath.revision), 422)).toMatchObject({ error: 'publication_blocked', blockedSkills: [], detail: 'A Version needs at least one required Skill for learners to complete' })
  const blank = await newPath('Blank')
  expect((await json(publish(blank.learningPath.id, blank.learningPath.revision), 422)).error).toBe('publication_blocked')
})

it('AC1/AC3: the route check itself ignores optional and Enrichment rewards and needs Required Tasks', () => {
  const skill = (id: string, xpThreshold: number, tasks: [boolean, number][], optional = false) => ({ id, title: id, optional, xpThreshold, tasks: tasks.map(([required, xpReward]) => ({ required, xpReward })) })
  expect(checkRequiredRoute([skill('A', 0, [[true, 60], [false, 40]]), skill('O', 0, [[true, 40]], true), skill('B', 100, [[true, 1]])], [])).toMatchObject({ publishable: false, reachableXp: 60 })
  expect(checkRequiredRoute([skill('A', 0, [[true, 60], [true, 40]]), skill('B', 100, [[true, 1]])], [{ prerequisiteSkillId: 'A', skillId: 'B' }])).toEqual({ publishable: true, reachableXp: 101 })
  expect(checkRequiredRoute([skill('A', 0, [])], [])).toMatchObject({ publishable: false, blockedSkills: [{ skillId: 'A', unmet: [{ kind: 'required_task' }] }] })
})

it('AC4: published content and rules cannot be changed in place, through the API or directly in the database', async () => {
  let vectors = ''
  const draft = await draftWith((d) => {
    vectors = addSkill(d, 'Vectros', {}, [task('Vector drills', true, 20), task('Read chapter 1', false, 5)])
    const matrices = addSkill(d, 'Matrices', { xpThreshold: 20 }, [task('Matrix drills', true, 10)])
    connect(d, vectors, matrices)
  })
  const published: Doc = await json(publish(draft.learningPath.id, draft.learningPath.revision), 200)
  const versionId = published.version!.id
  const before = await stored(draft.learningPath.id)

  // No request edits the published Version, not even a typo fix: there is no open Draft to write.
  const typo = edit(published, (d) => { d.application.skills[0].title = d.editor.cards[0].title = 'Vectors' })
  expect(await json(save(draft.learningPath.id, typo), 409)).toMatchObject({ error: 'no_open_draft' })
  expect(await json(publish(draft.learningPath.id, published.learningPath.revision), 409)).toMatchObject({ error: 'no_open_draft' })
  // A save based on the revision before publication is stale.
  expect(await json(save(draft.learningPath.id, edit(draft, (d) => { d.application.skills[0].title = d.editor.cards[0].title = 'Vectors' })), 409)).toMatchObject({ error: 'stale_revision' })

  // The database refuses direct changes to the published content, rules and Version too.
  const [extraTask] = await db.insert(tasks).values({ skillId: vectors }).returning()
  const directWrites = [
    db.update(versionSkills).set({ title: 'Vectors' }).where(and(eq(versionSkills.learningPathVersionId, versionId), eq(versionSkills.skillId, vectors))),
    db.update(versionSkills).set({ xpThreshold: 0 }).where(eq(versionSkills.learningPathVersionId, versionId)),
    db.update(versionTasks).set({ required: false }).where(eq(versionTasks.learningPathVersionId, versionId)),
    db.update(versionTasks).set({ xpReward: 500 }).where(eq(versionTasks.learningPathVersionId, versionId)),
    db.insert(versionTasks).values({ learningPathVersionId: versionId, taskId: extraTask.id, skillId: vectors, title: 'Smuggled', required: true }),
    db.delete(versionPrerequisites).where(eq(versionPrerequisites.learningPathVersionId, versionId)),
    db.delete(versionTasks).where(eq(versionTasks.learningPathVersionId, versionId)),
    db.update(learningPathVersions).set({ publishedAt: null }).where(eq(learningPathVersions.id, versionId)),
    db.update(learningPathVersions).set({ versionNumber: 7 }).where(eq(learningPathVersions.id, versionId)),
    db.delete(learningPathVersions).where(eq(learningPathVersions.id, versionId)),
  ]
  for (const write of directWrites) {
    const error = await write.then(() => null, (e: any) => e)
    expect(String(error?.cause ?? error)).toMatch(/immutable|cannot be deleted/)
  }
  expect(await stored(draft.learningPath.id)).toEqual(before)
  // The Version's Canvas Layout and Enrollment Closure stay outside its learning contract (ADR 0005).
  await db.insert(versionSkillCards).values({ learningPathVersionId: versionId, skillId: vectors, x: 5, y: 6 })
    .onConflictDoUpdate({ target: [versionSkillCards.learningPathVersionId, versionSkillCards.skillId], set: { x: sql`excluded.x`, y: sql`excluded.y` } })
  await db.update(learningPathVersions).set({ enrollmentClosedAt: new Date() }).where(eq(learningPathVersions.id, versionId))
  expect((await json(read(draft.learningPath.id), 200)).versions[0].enrollmentClosed).toBe(true)
})

it('AC4/AC5: an update is prepared in a new Draft with the same logical IDs and published as a distinct Version', async () => {
  let vectors = '', drills = ''
  const draft = await draftWith((d) => {
    const t = task('Vector drils', true, 20)
    drills = t.id
    vectors = addSkill(d, 'Vectros', {}, [t])
  })
  const v1: Doc = await json(publish(draft.learningPath.id, draft.learningPath.revision), 200)
  const pathId = v1.learningPath.id

  const prepared: Doc = await json(prepare(pathId, v1.learningPath.revision), 201)
  expect(prepared.draft).toMatchObject({ versionNumber: 2 })
  expect(prepared.version).toMatchObject({ id: prepared.draft!.id, versionNumber: 2, publishedAt: null })
  expect(prepared.versions.map((v) => v.versionNumber)).toEqual([1])
  // The Draft starts as a copy of Version 1: same logical IDs, rules, Prerequisites and layout.
  expect(prepared.application).toEqual(v1.application)
  expect(prepared.editor).toEqual(v1.editor)
  // Only one Draft at a time, and preparation is revision-checked.
  expect(await json(prepare(pathId, prepared.learningPath.revision), 409)).toMatchObject({ error: 'draft_already_open' })
  expect(await json(prepare(pathId, v1.learningPath.revision), 409)).toMatchObject({ error: 'stale_revision' })

  // Typo corrections and a new Skill go into the Draft.
  let added = ''
  const corrected: Doc = await json(save(pathId, edit(prepared, (d) => {
    d.application.skills[0].title = d.editor.cards[0].title = 'Vectors'
    d.application.skills[0].tasks[0].title = 'Vector drills'
    added = addSkill(d, 'Matrices', {}, [task('Matrix drills', true, 10)])
    connect(d, vectors, added)
  })), 200)
  const v2: Doc = await json(publish(pathId, corrected.learningPath.revision), 200)
  expect(v2.version).toMatchObject({ versionNumber: 2 })
  expect(v2.versions.map((v) => v.versionNumber)).toEqual([1, 2])
  expect(v2.version!.id).not.toBe(v1.version!.id)

  // Version 1 still reads exactly as published; Version 2 has the corrections.
  const old: Doc = await json(readVersion(v1.version!.id), 200)
  expect(old.application).toEqual(v1.application)
  expect(old.version).toMatchObject({ id: v1.version!.id, versionNumber: 1 })
  expect(old.application.skills.map((s) => [s.id, s.title, s.tasks.map((t) => [t.id, t.title])])).toEqual([[vectors, 'Vectros', [[drills, 'Vector drils']]]])
  const current: Doc = await json(readVersion(v2.version!.id), 200)
  expect(current.application.skills.map((s) => [s.id, s.title, s.tasks.map((t) => [t.id, t.title])])).toEqual([[vectors, 'Vectors', [[drills, 'Vector drills']]], [added, 'Matrices', [[current.application.skills[1].tasks[0].id, 'Matrix drills']]]])
  // One logical identity, one definition per Version.
  expect(await db.select().from(skills).where(eq(skills.id, vectors))).toHaveLength(1)
  expect((await db.select().from(versionSkills).where(eq(versionSkills.skillId, vectors))).map((r) => [r.learningPathVersionId, r.title]).sort())
    .toEqual([[v1.version!.id, 'Vectros'], [v2.version!.id, 'Vectors']].sort())
  expect((await db.select().from(versionTasks).where(eq(versionTasks.taskId, drills))).map((r) => r.title).sort()).toEqual(['Vector drills', 'Vector drils'])
  // Drafts and other Paths cannot be read as published Versions.
  const next: Doc = await json(prepare(pathId, v2.learningPath.revision), 201)
  expect(await json(readVersion(next.draft!.id), 404)).toEqual({ error: 'version_not_found' })
})

it('AC5: old fixture Enrollments keep their Version and progress when a new Version is published', async () => {
  const accepted = await json(request(`/invitations/${fx.invitations.toLearner.id}/accept`, 'learner', 'POST'), 201)
  const enrollmentId = accepted.enrollment.id
  const taskRoute = `/enrollments/${enrollmentId}/tasks/${fx.content.taskA.id}/submission/revisions`
  const sent = await json(request(taskRoute, 'learner', 'POST', { text: 'My vectors', urls: [] }), 201)
  await json(request(`${taskRoute}/${sent.revision.id}/review`, 'coach', 'POST', { decision: 'approval' }), 201)
  await json(request(`/enrollments/${enrollmentId}/skills/${fx.content.skillB.id}/access-overrides`, 'coach', 'POST', { reason: 'Already knows matrices' }), 201)
  const progress = async () => (await json(request(`/enrollments/${enrollmentId}/learning-state`, 'learner'), 200)).learningState
  const before = await progress()
  expect(before.skills.find((s: any) => s.skillId === fx.content.skillA.id).mastery).toBe(true)

  // The fixture Path has Versions 1 and 2 and no Draft: the Coach reads the latest Version.
  const path: Doc = await json(read(fx.paths.path.id), 200)
  expect(path.draft).toBeNull()
  expect(path.version).toMatchObject({ id: fx.versions.version2.id, versionNumber: 2 })
  expect(path.application.skills.map((s) => s.title).sort()).toEqual(['Matrices (revised)', 'Vectors (revised)'])
  const at = (d: Doc, id: string) => d.application.skills.findIndex((s) => s.id === id)
  const a = at(path, fx.content.skillA.id), b = at(path, fx.content.skillB.id)
  const prepared: Doc = await json(prepare(fx.paths.path.id, path.learningPath.revision), 201)
  expect(prepared.draft!.versionNumber).toBe(3)
  // An unreachable threshold blocks Version 3; the learner's override in Version 1 does not count.
  const blocked: Doc = await json(save(fx.paths.path.id, edit(prepared, (d) => { d.application.skills[b].xpThreshold = 100 })), 200)
  expect(blockedOf(await json(publish(fx.paths.path.id, blocked.learningPath.revision), 422))).toEqual({ 'Matrices (revised)': ['xp:100/0'] })
  const corrected: Doc = await json(save(fx.paths.path.id, edit(blocked, (d) => {
    d.application.skills[b].xpThreshold = 0
    d.application.skills[a].title = d.editor.cards[a].title = 'Vectors (third edition)'
    d.application.skills[a].tasks[0].xpReward = 40
  })), 200)
  const v3: Doc = await json(publish(fx.paths.path.id, corrected.learningPath.revision), 200)
  expect(v3.versions.map((v) => v.versionNumber)).toEqual([1, 2, 3])

  // The Enrollment stays on Version 1 with the same progress, XP and override; nothing migrated.
  const [enrollment] = await db.select().from(enrollments).where(eq(enrollments.id, enrollmentId))
  expect(enrollment.learningPathVersionId).toBe(fx.versions.version1.id)
  expect(await progress()).toEqual(before)
  expect((await json(readVersion(fx.versions.version1.id), 200)).application.skills.map((s: Skill) => s.title).sort()).toEqual(['Matrices', 'Vectors'])
  expect((await json(readVersion(v3.version!.id), 200)).application.skills.map((s: Skill) => s.title).sort()).toEqual(['Matrices (revised)', 'Vectors (third edition)'])
  // Matching logical IDs carry no progress into Version 3: nobody is enrolled there.
  expect(await db.select().from(enrollments).where(eq(enrollments.learningPathVersionId, v3.version!.id))).toEqual([])
})

it('AC6: only the owning Coach publishes, prepares or reads Versions; competing requests publish once', async () => {
  const draft = await draftWith((d) => { addSkill(d, 'Vectors', {}, [task('Vector drills', true, 10)]) })
  const pathId = draft.learningPath.id
  const before = await stored(pathId)
  const attempts = (actor: Actor) => [
    publish(pathId, draft.learningPath.revision, actor), publish(pathId, 'x', actor), prepare(pathId, draft.learningPath.revision, actor), prepare(pathId, null, actor),
    readVersion(fx.versions.version1.id, actor), publish(fx.paths.path.id, 0, actor), prepare(fx.paths.path.id, 0, actor),
  ]
  for (const actor of ['otherCoach', 'learner', 'peer', 'unrelated', 'unverified'] as const) {
    for (const response of await Promise.all(attempts(actor))) expect(response.status).toBe(404)
  }
  for (const response of await Promise.all(attempts(null))) expect(response.status).toBe(401)
  // The owning Coach has no authority over another Coach's Paths or unknown IDs either.
  const theirs = await json(request(`/coach/workspaces/${fx.workspaces.otherWorkspace.id}/learning-paths`, 'otherCoach', 'POST', { title: 'Theirs' }), 201)
  for (const response of await Promise.all([
    publish(theirs.learningPath.id, 0), prepare(theirs.learningPath.id, 0), readVersion(crypto.randomUUID()), readVersion('nope'), publish('nope', 0),
  ])) expect(response.status).toBe(404)
  expect(await stored(pathId)).toEqual(before)
  expect(await json(publish(pathId, -1), 422)).toMatchObject({ error: 'invalid_request' })

  // Competing publications of one revision: exactly one Version is published.
  const results = await Promise.all(Array.from({ length: 5 }, () => publish(pathId, draft.learningPath.revision)))
  expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409])
  const published = (await db.select().from(learningPathVersions).where(eq(learningPathVersions.learningPathId, pathId))).filter((v) => v.publishedAt)
  expect(published).toHaveLength(1)
  // Competing preparations: exactly one new Draft.
  const revision = (await json(read(pathId), 200)).learningPath.revision
  const prepared = await Promise.all(Array.from({ length: 5 }, () => prepare(pathId, revision)))
  expect(prepared.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409])
  expect((await db.select().from(learningPathVersions).where(eq(learningPathVersions.learningPathId, pathId))).map((v) => v.versionNumber).sort()).toEqual([1, 2])
})

it('AC4: a Version keeps its own title and goal; editing the next Draft never changes an earlier Version', async () => {
  const draft = await draftWith((d) => { addSkill(d, 'Vectors', {}, [task('Vector drills', true, 10)]) })
  const pathId = draft.learningPath.id
  const v1: Doc = await json(publish(pathId, draft.learningPath.revision), 200)
  expect(v1.learningPath).toMatchObject({ title: 'Linear Algebra', goal: 'Linear Algebra goal' })
  const prepared: Doc = await json(prepare(pathId, v1.learningPath.revision), 201)
  expect(prepared.learningPath).toMatchObject({ title: 'Linear Algebra', goal: 'Linear Algebra goal' })

  // The next Draft's title and goal change; Version 1 keeps its own, before and after Version 2 is published.
  const renamed: Doc = await json(save(pathId, edit(prepared, (d) => { d.learningPath.title = 'Linear Algebra I'; d.learningPath.goal = 'Solve linear systems' })), 200)
  expect(renamed.learningPath).toMatchObject({ title: 'Linear Algebra I', goal: 'Solve linear systems', revision: prepared.learningPath.revision + 1 })
  const v1Read = async () => (await json(readVersion(v1.version!.id), 200)).learningPath
  expect(await v1Read()).toMatchObject({ title: 'Linear Algebra', goal: 'Linear Algebra goal' })
  // The owner's Workspace lists the Path under its newest Version's title.
  expect((await json(request(`/coach/workspaces/${draft.learningPath.coachWorkspaceId}`), 200)).learningPaths).toEqual([{ id: pathId, title: 'Linear Algebra I', goal: 'Solve linear systems' }])
  const v2: Doc = await json(publish(pathId, renamed.learningPath.revision), 200)
  expect(v2.learningPath).toMatchObject({ title: 'Linear Algebra I', goal: 'Solve linear systems' })
  expect(await v1Read()).toMatchObject({ title: 'Linear Algebra', goal: 'Linear Algebra goal' })
  expect((await json(read(pathId), 200)).learningPath).toMatchObject({ title: 'Linear Algebra I', goal: 'Solve linear systems' })

  // The database refuses changing a published Version's title or goal too.
  for (const change of [{ title: 'Linear Algebre' }, { goal: 'A typo-free goal' }]) {
    const error = await db.update(learningPathVersions).set(change).where(eq(learningPathVersions.id, v1.version!.id)).then(() => null, (e: any) => e)
    expect(String(error?.cause ?? error)).toMatch(/immutable/)
  }
  expect(await v1Read()).toMatchObject({ title: 'Linear Algebra', goal: 'Linear Algebra goal' })
})

/**
 * Holds `hold` in a transaction on a separate connection, starts `contender` and
 * observes it waiting on that connection, then commits the hold. The forced order
 * shows how direct content writes and publication serialize (migration 0013).
 */
async function heldThen<T>(hold: (tx: any) => Promise<unknown>, contender: () => Promise<T>) {
  const other = createDatabase(TEST_DATABASE_URL, 1)
  let release!: () => void, ready!: (pid: number) => void
  const barrier = new Promise<void>((resolve) => { release = resolve })
  const held = new Promise<number>((resolve) => { ready = resolve })
  const holder = other.db.transaction(async (tx) => {
    await hold(tx)
    const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
    ready(row.pid)
    await barrier
  })
  let pending: Promise<T> | null = null
  try {
    const pid = await held
    pending = contender()
    await waitForBlockedBy(db, pid)
    release()
    await holder
    return await pending
  } finally {
    release()
    await holder.catch(() => {})
    await pending?.catch(() => {})
    await other.close()
  }
}

it('AC1/AC4: a publication waits for a direct Draft write in progress and validates the committed content', async () => {
  let required = ''
  const draft = await draftWith((d) => {
    const t = task('Vector drills', true, 10)
    required = t.id
    addSkill(d, 'Vectors', {}, [t])
  })
  // A direct write turns the only Required Task into an Enrichment Task and holds its transaction open.
  const published = await heldThen(
    (tx) => tx.update(versionTasks).set({ required: false }).where(and(eq(versionTasks.learningPathVersionId, draft.draft!.id), eq(versionTasks.taskId, required))),
    () => publish(draft.learningPath.id, draft.learningPath.revision),
  )
  // The publication saw the committed write, so it refuses the route that write broke.
  expect(published.status).toBe(422)
  expect(blockedOf(await published.json())).toEqual({ Vectors: ['required_task'] })
  const [version] = await db.select().from(learningPathVersions).where(eq(learningPathVersions.id, draft.draft!.id))
  expect(version.publishedAt).toBeNull()
})

for (const target of ['Task rule', 'goal'] as const) it(`AC4: a direct ${target} write waiting for a publication in progress finds the Version published and is refused`, async () => {
  const draft = await draftWith((d) => { addSkill(d, 'Vectors', {}, [task('Vector drills', true, 10)]) })
  const draftId = draft.draft!.id
  const before = await stored(draft.learningPath.id)
  // A publication holds the Draft locked while it publishes, as publishDraft does.
  const outcome = await heldThen(
    async (tx) => {
      await tx.execute(sql`select id from learning_path_versions where id = ${draftId} for update`)
      await tx.execute(sql`update learning_path_versions set published_at = clock_timestamp() where id = ${draftId}`)
    },
    async () => {
      const write = target === 'Task rule'
        ? db.update(versionTasks).set({ required: false }).where(eq(versionTasks.learningPathVersionId, draftId))
        : db.update(learningPathVersions).set({ goal: 'changed while publishing' }).where(eq(learningPathVersions.id, draftId))
      return write.then(() => null, (e: any) => e)
    },
  )
  expect(String(outcome?.cause ?? outcome)).toMatch(/immutable/)
  const after = await stored(draft.learningPath.id)
  expect({ skills: after.skills, tasks: after.tasks, edges: after.edges }).toEqual({ skills: before.skills, tasks: before.tasks, edges: before.edges })
  expect((await json(readVersion(draftId), 200)).learningPath.goal).toBe('Linear Algebra goal')
})
