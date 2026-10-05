import { afterAll, beforeAll, beforeEach, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createApp } from '../src/app'
import type { Database } from '../src/db/client'
import { enrollmentInvitations, enrollments, learningPaths, learningPathVersions, versionPrerequisites, versionSkillCards, versionSkills, versionTasks } from '../src/db/schema'
import { FIXTURE_IDENTITY_HEADER, fixtureIdentity } from '../src/identity'
import { prepareTestDatabase, resetTestDatabase } from './support/database'
import { seedEnrollmentFixture, seedPersonalFixture, type EnrollmentFixture, type PersonalFixture } from './support/fixtures'

/**
 * T18 (#19): Coach Workspaces and Learning Path Drafts through the request
 * boundary on PostgreSQL. A Draft document is the personal document plus the
 * Draft's rules (Required/Enrichment Tasks with rewards, Optional Skills, XP
 * Thresholds), saved against the Path revision.
 */
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
  editor: { format_version: 1; cards: { id: string; title: string; position: { x: number; y: number } }[]; connections: { from_id: string; to_id: string }[] }
  application: { skills: Skill[] }
}
const createWorkspace = (name: unknown, actor: Actor = 'coach') => request('/coach/workspaces', actor, 'POST', { name })
const createPath = (workspaceId: string, title: unknown, goal = '', actor: Actor = 'coach') => request(`/coach/workspaces/${workspaceId}/learning-paths`, actor, 'POST', { title, goal })
const read = (pathId: string, actor: Actor = 'coach') => request(`/coach/learning-paths/${pathId}`, actor)
const save = (pathId: string, body: unknown, actor: Actor = 'coach') => request(`/coach/learning-paths/${pathId}/draft`, actor, 'PUT', body)
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
async function workspace(name = 'Linear Algebra Studio', actor: Actor = 'coach') {
  return (await json(createWorkspace(name, actor), 201)).workspace as { id: string; name: string }
}
async function newPath(workspaceId: string, title = 'Linear Algebra', actor: Actor = 'coach'): Promise<Doc> {
  return json(createPath(workspaceId, title, `${title} goal`, actor), 201)
}
/** Everything a Draft write could touch, for "nothing changed" checks. */
async function storedDraft(pathId: string) {
  const [path] = await db.select().from(learningPaths).where(eq(learningPaths.id, pathId))
  const versions = await db.select().from(learningPathVersions).where(eq(learningPathVersions.learningPathId, pathId))
  const ids = versions.map((v) => v.id)
  const of = async (table: any) => (await db.select().from(table)).filter((row: any) => ids.includes(row.learningPathVersionId)).map((row: any) => JSON.stringify(row)).sort()
  return { path, versions, skills: await of(versionSkills), tasks: await of(versionTasks), cards: await of(versionSkillCards), edges: await of(versionPrerequisites) }
}

it('AC1: a Coach Workspace has one owning Coach, holds several Paths, and grants no authority elsewhere', async () => {
  const w = await workspace()
  expect(w.name).toBe('Linear Algebra Studio')
  const algebra = await newPath(w.id, 'Linear Algebra')
  const calculus = await newPath(w.id, 'Calculus')
  // Each Path belongs to this one Workspace and starts with an unpublished Draft, Version 1.
  for (const doc of [algebra, calculus]) {
    expect(doc.learningPath).toMatchObject({ coachWorkspaceId: w.id, revision: 0 })
    expect(doc.draft?.versionNumber).toBe(1)
    const [version] = await db.select().from(learningPathVersions).where(eq(learningPathVersions.learningPathId, doc.learningPath.id))
    expect(version.publishedAt).toBeNull()
  }
  expect((await json(request(`/coach/workspaces/${w.id}`), 200)).learningPaths.map((p: any) => p.title)).toEqual(['Linear Algebra', 'Calculus'])
  // The owner lists only Workspaces it owns: the fixture one and the new one, not the other Coach's.
  const listed = (await json(request('/coach/workspaces'), 200)).workspaces.map((x: any) => x.id)
  expect(listed.sort()).toEqual([fx.workspaces.workspace.id, w.id].sort())
  expect((await json(request('/coach/workspaces', 'otherCoach'), 200)).workspaces.map((x: any) => x.id)).toEqual([fx.workspaces.otherWorkspace.id])

  const before = await storedDraft(algebra.learningPath.id)
  const attempt = (actor: Actor) => [
    request(`/coach/workspaces/${w.id}`, actor), createPath(w.id, 'Intruder', '', actor), createPath(w.id, '', '', actor),
    read(algebra.learningPath.id, actor), save(algebra.learningPath.id, edit(algebra, (d) => { d.learningPath.goal = 'taken' }), actor),
    save(algebra.learningPath.id, { not: 'a document' }, actor),
  ]
  // The other Coach, the fixture Path's enrolled-to-be learner, peers and strangers find nothing.
  for (const actor of ['otherCoach', 'learner', 'peer', 'unrelated', 'unverified'] as const) {
    for (const response of await Promise.all(attempt(actor))) expect(response.status).toBe(404)
  }
  for (const response of await Promise.all(attempt(null))) expect(response.status).toBe(401)
  expect(await storedDraft(algebra.learningPath.id)).toEqual(before)
  expect((await json(request(`/coach/workspaces/${w.id}`), 200)).learningPaths).toHaveLength(2)

  // Owning this Workspace gives nothing in the other Coach's Workspace, nor in personal or unknown Paths.
  const theirs = await newPath(fx.workspaces.otherWorkspace.id, 'Their Algebra', 'otherCoach')
  for (const response of [
    await request(`/coach/workspaces/${fx.workspaces.otherWorkspace.id}`), await createPath(fx.workspaces.otherWorkspace.id, 'Mine now'),
    await read(theirs.learningPath.id), await save(theirs.learningPath.id, edit(theirs)),
    await read(px.paths.main.id), await read(crypto.randomUUID()), await read('not-a-uuid'),
  ]) expect(response.status).toBe(404)
  // And personal routes never open a coach-mode Path.
  expect((await request(`/personal/learning-paths/${algebra.learningPath.id}`)).status).toBe(404)
  // Names and titles are validated for the owner.
  expect(await json(createWorkspace('  '), 422)).toMatchObject({ error: 'invalid_workspace' })
  expect(await json(createPath(w.id, ''), 422)).toMatchObject({ error: 'invalid_learning_path' })
})

it('AC2: two Paths on the same subject keep their own outcomes and Tasks; IDs never cross Paths', async () => {
  const w = await workspace()
  const one = await newPath(w.id, 'Linear Algebra')
  const two = await newPath(w.id, 'Linear Algebra for Engineers')
  let vectorsOne = '', vectorsTwo = ''
  const savedOne: Doc = await json(save(one.learningPath.id, edit(one, (d) => {
    vectorsOne = addSkill(d, 'Vectors', {}, [task('Prove the axioms', true, 20)])
  })), 200)
  const savedTwo: Doc = await json(save(two.learningPath.id, edit(two, (d) => {
    vectorsTwo = addSkill(d, 'Vectors', {}, [task('Model forces with vectors', true, 30), task('Watch a lecture', false, 5)])
    d.application.skills[0].outcome = 'Resolve forces into components'
  })), 200)
  expect(vectorsOne).not.toBe(vectorsTwo)
  const reopenedOne: Doc = await json(read(one.learningPath.id), 200)
  const reopenedTwo: Doc = await json(read(two.learningPath.id), 200)
  expect(reopenedOne.application).toEqual(savedOne.application)
  expect(reopenedTwo.application).toEqual(savedTwo.application)
  expect(reopenedOne.application.skills[0].tasks.map((t) => t.title)).toEqual(['Prove the axioms'])
  expect(reopenedTwo.application.skills[0]).toMatchObject({ outcome: 'Resolve forces into components' })
  expect(reopenedTwo.application.skills[0].tasks.map((t) => t.title)).toEqual(['Model forces with vectors', 'Watch a lecture'])

  // Reusing another Path's Skill or Task ID, a personal Skill ID, or a published fixture Skill is refused whole.
  const before = await storedDraft(two.learningPath.id)
  const borrowedSkill = reopenedOne.application.skills[0]
  const attempts = [
    [edit(reopenedTwo, (d) => { d.editor.cards.push({ id: borrowedSkill.id, title: borrowedSkill.title, position: { x: 0, y: 0 } }); d.application.skills.push(structuredClone(borrowedSkill)) }), 'skill_owned_elsewhere'],
    [edit(reopenedTwo, (d) => { d.application.skills[0].tasks.push(structuredClone(borrowedSkill.tasks[0])) }), 'task_owned_elsewhere'],
    [edit(reopenedTwo, (d) => { addSkill(d, 'Borrowed'); const s = d.application.skills.at(-1)!; const c = d.editor.cards.at(-1)!; s.id = c.id = px.skills.skillA.id }), 'skill_owned_elsewhere'],
    [edit(reopenedTwo, (d) => { addSkill(d, 'Borrowed'); const s = d.application.skills.at(-1)!; const c = d.editor.cards.at(-1)!; s.id = c.id = fx.content.skillA.id }), 'skill_owned_elsewhere'],
  ] as const
  for (const [body, error] of attempts) expect(await json(save(two.learningPath.id, body), 409)).toMatchObject({ error })
  // Moving a Task to another Skill of the same Draft is refused too.
  const moved = await json(save(two.learningPath.id, edit(reopenedTwo, (d) => {
    addSkill(d, 'Matrices')
    d.application.skills[1].tasks.push(d.application.skills[0].tasks.pop()!)
  })), 409)
  expect(moved.error).toBe('task_skill_mismatch')
  expect(await storedDraft(two.learningPath.id)).toEqual(before)
})

it('AC3: a Draft stores Required/Enrichment Tasks, rewards, Optional Skills, thresholds and Prerequisites; incomplete Drafts save but grant nothing', async () => {
  const w = await workspace()
  const created = await newPath(w.id)
  let vectors = '', matrices = '', history = '', empty = ''
  const saved: Doc = await json(save(created.learningPath.id, edit(created, (d) => {
    vectors = addSkill(d, 'Vectors', {}, [task('Vector exercises', true, 20), task('Read chapter 1', false, 5)])
    matrices = addSkill(d, 'Matrices', { xpThreshold: 20 }, [task('Matrix exercises', true, 30)])
    history = addSkill(d, 'History of algebra', { optional: true }, [task('Essay', false, 10)])
    // Incomplete: a required Skill without any Task.
    empty = addSkill(d, 'Eigenvalues', { xpThreshold: 50 })
    d.editor.connections.push({ from_id: vectors, to_id: matrices }, { from_id: matrices, to_id: empty }, { from_id: vectors, to_id: history })
  })), 200)
  expect(saved.learningPath.revision).toBe(1)
  const reopened: Doc = await json(read(created.learningPath.id), 200)
  expect(reopened).toEqual(saved)
  expect(reopened.application.skills.map((s) => [s.title, s.optional, s.xpThreshold, s.tasks.map((t) => [t.title, t.required, t.xpReward])])).toEqual([
    ['Vectors', false, 0, [['Vector exercises', true, 20], ['Read chapter 1', false, 5]]],
    ['Matrices', false, 20, [['Matrix exercises', true, 30]]],
    ['History of algebra', true, 0, [['Essay', false, 10]]],
    ['Eigenvalues', false, 50, []],
  ])
  expect(reopened.editor.connections.map((c) => `${c.from_id}>${c.to_id}`).sort()).toEqual([`${vectors}>${matrices}`, `${matrices}>${empty}`, `${vectors}>${history}`].sort())
  // Tasks and rules live in the payload only; the editor snapshot holds cards and connections.
  expect(Object.keys(reopened.editor.cards[0]).sort()).toEqual(['id', 'position', 'title'])
  // Changing a rule is a Draft edit: Enrichment → Required, reward, threshold.
  const ruled: Doc = await json(save(created.learningPath.id, edit(reopened, (d) => {
    d.application.skills[0].tasks[1].required = true
    d.application.skills[1].tasks[0].xpReward = 45
    d.application.skills[3].xpThreshold = 0
  })), 200)
  expect(ruled.learningPath.revision).toBe(2)
  expect(ruled.application.skills[0].tasks[1].required).toBe(true)

  // The Draft is unpublished: no one can enrol in it, so it never awards Mastery or XP.
  const [invitation] = await db.insert(enrollmentInvitations).values({ learningPathVersionId: saved.draft!.id, email: 'learner@gurow.test', invitedByAccountId: fx.accounts.coach.id }).returning()
  expect(await json(request(`/invitations/${invitation.id}/accept`, 'learner', 'POST'), 409)).toEqual({ error: 'version_not_published' })
  expect(await db.select().from(enrollments).where(eq(enrollments.learningPathVersionId, saved.draft!.id))).toEqual([])

  // Rules are validated: missing or out-of-range values are refused and change nothing.
  const before = await storedDraft(created.learningPath.id)
  for (const broken of [
    (d: Doc) => { delete (d.application.skills[0].tasks[0] as any).required },
    (d: Doc) => { d.application.skills[0].tasks[0].xpReward = 1_000_001 },
    (d: Doc) => { d.application.skills[1].xpThreshold = -1 },
    (d: Doc) => { (d.application.skills[2] as any).optional = 'yes' },
  ]) expect(await json(save(created.learningPath.id, edit(ruled, broken)), 422)).toMatchObject({ error: 'invalid_document' })
  expect(await storedDraft(created.learningPath.id)).toEqual(before)
})

it('AC4: an Optional Skill cannot be a Prerequisite of a required Skill; cycles and outside connections are refused', async () => {
  const w = await workspace()
  const created = await newPath(w.id)
  let required = '', extra = '', alsoExtra = ''
  const saved: Doc = await json(save(created.learningPath.id, edit(created, (d) => {
    required = addSkill(d, 'Matrices', {}, [task('Exercises', true, 10)])
    extra = addSkill(d, 'History', { optional: true })
    alsoExtra = addSkill(d, 'Puzzles', { optional: true })
    // Required → Optional and Optional → Optional are allowed.
    d.editor.connections.push({ from_id: required, to_id: extra }, { from_id: extra, to_id: alsoExtra })
  })), 200)
  const before = await storedDraft(created.learningPath.id)
  const refusals = [
    [edit(saved, (d) => { const later = addSkill(d, 'Linear maps'); d.editor.connections.push({ from_id: alsoExtra, to_id: later }) }), 'optional_prerequisite'],
    // Making a Prerequisite of a required Skill optional breaks the same rule.
    [edit(saved, (d) => { const added = addSkill(d, 'Determinants'); d.editor.connections.push({ from_id: added, to_id: required }); d.application.skills.at(-1)!.optional = true }), 'optional_prerequisite'],
    [edit(saved, (d) => { d.editor.connections.push({ from_id: alsoExtra, to_id: extra }) }), 'prerequisite_cycle'],
    [edit(saved, (d) => { d.editor.connections.push({ from_id: required, to_id: required }) }), 'prerequisite_cycle'],
    [edit(saved, (d) => { d.editor.connections.push({ from_id: required, to_id: fx.content.skillB.id }) }), 'connection_outside_path'],
  ] as const
  for (const [body, error] of refusals) {
    const refused = await json(save(created.learningPath.id, body), 422)
    expect(refused.error).toBe(error)
  }
  expect((await json(save(created.learningPath.id, refusals[0][0]), 422)).detail).toBe('Optional Skill "Puzzles" cannot be a Prerequisite of required Skill "Linear maps"')
  expect(await storedDraft(created.learningPath.id)).toEqual(before)
})

it('AC3/AC6: Draft saves are revision-checked; a stale save writes nothing and returns the accepted Draft', async () => {
  const w = await workspace()
  const created = await newPath(w.id)
  const first: Doc = await json(save(created.learningPath.id, edit(created, (d) => { addSkill(d, 'Vectors', {}, [task('Exercises', true, 10)]) })), 200)
  const stale = await json(save(created.learningPath.id, edit(created, (d) => { d.learningPath.goal = 'stale goal' })), 409)
  expect(stale.error).toBe('stale_revision')
  expect(stale.current).toEqual(first)
  // Competing saves on one revision: exactly one is accepted.
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => save(created.learningPath.id, edit(first, (d) => { d.learningPath.goal = `goal ${i}` }))))
  expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409, 409])
  expect((await json(read(created.learningPath.id), 200)).learningPath.revision).toBe(2)
  // An unchanged save keeps the revision.
  const current: Doc = await json(read(created.learningPath.id), 200)
  expect((await json(save(created.learningPath.id, edit(current)), 200)).learningPath.revision).toBe(2)
})
