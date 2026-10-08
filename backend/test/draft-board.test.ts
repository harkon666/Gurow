import { afterAll, beforeAll, beforeEach, expect, it } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'
import { createApp } from '../src/app'
import type { Database } from '../src/db/client'
import { draftBoardCards, draftBoardColumns, draftTaskBoards, enrollments, learningPaths, learningPathVersions, submissionReviews, submissionRevisions, versionPrerequisites, versionSkillCards, versionSkills, versionTasks } from '../src/db/schema'
import { FIXTURE_IDENTITY_HEADER, fixtureIdentity } from '../src/identity'
import { prepareTestDatabase, resetTestDatabase } from './support/database'
import { amendPublished, seedEnrollmentFixture, seedPersonalFixture, type EnrollmentFixture, type PersonalFixture } from './support/fixtures'

/**
 * UX04 (#50): a Coach's preparation board for one Skill of a Learning Path Draft,
 * through the request boundary on PostgreSQL (ADR 0027, 0029). Its columns express
 * material readiness only: board saves write nothing but the board, never the Draft's
 * content, a published Version, publication eligibility or any learner record. Stored
 * records are read back independently of every board answer.
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
  const body = await r.json().catch(() => null) as any
  expect({ status: r.status, body }).toMatchObject({ status })
  return body
}

interface Column { id: string; name: string; completion: boolean; taskIds: string[] }
interface Board { skillId: string; revision: number; columns: Column[] }
interface Task { id: string; title: string; description: string; required: boolean; xpReward: number }
interface Skill { id: string; title: string; outcome: string; optional: boolean; xpThreshold: number; tasks: Task[] }
interface Doc {
  learningPath: { id: string; coachWorkspaceId: string; title: string; goal: string; revision: number }
  draft: { id: string; versionNumber: number } | null
  versions: { id: string; versionNumber: number }[]
  editor: { format_version: 1; cards: { id: string; title: string; position: { x: number; y: number } }[]; connections: { from_id: string; to_id: string }[] }
  application: { skills: Skill[] }
}

const coachPath = (pathId: string) => `/coach/learning-paths/${pathId}`
const boardRoute = (pathId: string, draftId: string, skillId: string) => `${coachPath(pathId)}/drafts/${draftId}/skills/${skillId}/board`
const readDoc = async (pathId: string): Promise<Doc> => json(request(coachPath(pathId)), 200)
const saveDoc = (doc: Doc, change: (d: Doc) => void = () => {}, actor: Actor = 'coach') => {
  const next = structuredClone(doc)
  change(next)
  return request(`${coachPath(doc.learningPath.id)}/draft`, actor, 'PUT', { expectedRevision: doc.learningPath.revision, title: next.learningPath.title, goal: next.learningPath.goal, editor: next.editor, application: next.application })
}
const boardOf = async (doc: Doc, skillId: string, actor: Actor = 'coach') => (await json(request(boardRoute(doc.learningPath.id, doc.draft!.id, skillId), actor), 200)).board as Board
const saveBoard = (doc: Doc, skillId: string, expectedRevision: number, columns: unknown, actor: Actor = 'coach', draftId = doc.draft!.id) =>
  request(boardRoute(doc.learningPath.id, draftId, skillId), actor, 'PUT', { expectedRevision, columns })
const task = (title: string, required = true, xpReward = 10): Task => ({ id: crypto.randomUUID(), title, description: `${title} notes`, required, xpReward })
const addSkill = (d: Doc, title: string, tasks: Task[], rules: { optional?: boolean; xpThreshold?: number } = {}) => {
  const id = crypto.randomUUID()
  d.editor.cards.push({ id, title, position: { x: 80 + d.editor.cards.length * 240, y: 100 } })
  d.application.skills.push({ id, title, outcome: `${title} outcome`, optional: rules.optional ?? false, xpThreshold: rules.xpThreshold ?? 0, tasks })
  return id
}
const edit = (board: Board, change: (columns: Column[]) => void) => {
  const columns = structuredClone(board.columns)
  change(columns)
  return columns
}
const named = (columns: Column[], name: string) => columns.find((c) => c.name === name)!
const moveTo = (columns: Column[], taskId: string, name: string, index?: number) => {
  for (const column of columns) column.taskIds = column.taskIds.filter((id) => id !== taskId)
  const target = named(columns, name).taskIds
  target.splice(index ?? target.length, 0, taskId)
}
const arrangement = (board: Board) => board.columns.map((c) => `${c.name}:${c.taskIds.join(',')}`)

/** A new Path in the fixture Workspace: Skill A with three Tasks in order, Skill B (after A) with one. */
async function draftPath(title = 'Linear Maps') {
  const created: Doc = await json(request(`/coach/workspaces/${fx.workspaces.workspace.id}/learning-paths`, 'coach', 'POST', { title, goal: '' }), 201)
  const tasks = [task('Read the chapter'), task('Solve exercises', true, 20), task('Watch a lecture', false, 5)]
  const taskB = task('Compose maps')
  let a = '', b = ''
  const doc: Doc = await json(saveDoc(created, (d) => {
    a = addSkill(d, 'Kernels', tasks)
    b = addSkill(d, 'Composition', [taskB])
    d.editor.connections.push({ from_id: a, to_id: b })
  }), 200)
  return { doc, a, b, tasks: tasks.map((t) => t.id), taskB: taskB.id }
}

/** Every row a board operation must not touch: the Path, its Versions and their content. */
async function storedContent(pathId: string) {
  const [path] = await db.select().from(learningPaths).where(eq(learningPaths.id, pathId))
  const versions = await db.select().from(learningPathVersions).where(eq(learningPathVersions.learningPathId, pathId))
  const ids = versions.map((v) => v.id)
  const of = async (table: any) => (await db.select().from(table)).filter((row: any) => ids.includes(row.learningPathVersionId)).map((row: any) => JSON.stringify(row)).sort()
  return { path, versions, skills: await of(versionSkills), tasks: await of(versionTasks), cards: await of(versionSkillCards), edges: await of(versionPrerequisites) }
}
/** A board's stored rows, read directly from the database. */
async function storedBoardRows(versionId: string) {
  const where = (table: typeof draftBoardCards | typeof draftBoardColumns | typeof draftTaskBoards) => eq(table.learningPathVersionId, versionId)
  return {
    boards: await db.select().from(draftTaskBoards).where(where(draftTaskBoards)),
    columns: await db.select().from(draftBoardColumns).where(where(draftBoardColumns)),
    cards: await db.select().from(draftBoardCards).where(where(draftBoardCards)),
  }
}

it('AC1/AC6: opening a Draft Skill\'s board creates Ideas, In preparation and Ready once, with its own Tasks in Ideas in saved order', async () => {
  const { doc, a, b, tasks, taskB } = await draftPath()
  const before = await storedContent(doc.learningPath.id)
  const board = await boardOf(doc, a)
  expect(board.columns.map((c) => [c.name, c.completion])).toEqual([['Ideas', false], ['In preparation', false], ['Ready', false]])
  expect(arrangement(board)).toEqual([`Ideas:${tasks.join(',')}`, 'In preparation:', 'Ready:'])
  expect(board.revision).toBe(0)
  // Each Skill has its own board holding only its own Tasks.
  expect(arrangement(await boardOf(doc, b))).toEqual([`Ideas:${taskB}`, 'In preparation:', 'Ready:'])
  // Opening wrote nothing but the boards: the Draft's content and the Path's revision are unchanged.
  expect(await storedContent(doc.learningPath.id)).toEqual(before)
  expect(await boardOf(doc, a)).toEqual(board)

  // Repeated and concurrent first openings of another Skill give one coherent board.
  const fresh = await draftPath('Eigenvalues')
  const answers = await Promise.all(Array.from({ length: 6 }, () => boardOf(fresh.doc, fresh.a)))
  for (const answer of answers) expect(answer).toEqual(answers[0])
  const rows = await storedBoardRows(fresh.doc.draft!.id)
  expect(rows.boards).toHaveLength(1)
  expect(rows.columns).toHaveLength(3)
  expect(rows.cards.map((c) => c.taskId).sort()).toEqual([...fresh.tasks].sort())

  // Customization survives reopening; reopening never reinitializes.
  const columns = edit(board, (c) => { c[0].name = 'Backlog of ideas'; moveTo(c, tasks[1], 'Ready') })
  const saved = (await json(saveBoard(doc, a, 0, columns), 200)).board as Board
  expect(saved.revision).toBe(1)
  expect(await boardOf(doc, a)).toEqual(saved)
  expect(arrangement(saved)).toEqual([`Backlog of ideas:${tasks[0]},${tasks[2]}`, 'In preparation:', `Ready:${tasks[1]}`])
  expect(await storedContent(doc.learningPath.id)).toEqual(before)
})

it('AC2/AC3: columns are added, renamed, reordered and removed with a surviving destination; no column has a completion role', async () => {
  const { doc, a, tasks } = await draftPath()
  let board = await boardOf(doc, a)
  const review = crypto.randomUUID()
  board = (await json(saveBoard(doc, a, board.revision, edit(board, (c) => {
    c.splice(2, 0, { id: review, name: 'Needs review', completion: false, taskIds: [] })
    moveTo(c, tasks[2], 'Needs review')
    moveTo(c, tasks[1], 'Ideas', 0)
    named(c, 'Ready').name = 'Ready to publish'
    c.reverse()
  })), 200)).board
  expect(arrangement(board)).toEqual(['Ready to publish:', `Needs review:${tasks[2]}`, 'In preparation:', `Ideas:${tasks[1]},${tasks[0]}`])
  expect(arrangement(await boardOf(doc, a))).toEqual(arrangement(board))

  const before = await storedBoardRows(doc.draft!.id)
  // Removing a populated column without moving its Tasks would lose them: refused whole.
  expect(await json(saveBoard(doc, a, board.revision, edit(board, (c) => { c.splice(1, 1) })), 422)).toMatchObject({ error: 'board_task_missing' })
  // A personal Completion Column role, an empty board or a malformed one is not a Draft board.
  for (const columns of [
    edit(board, (c) => { c[0].completion = true }),
    [],
    edit(board, (c) => { c[0].name = ' ' }),
    edit(board, (c) => { c[0].id = 'not-a-uuid' }),
    edit(board, (c) => { c[1].taskIds.push(c[3].taskIds[0]) }),
  ]) expect(await json(saveBoard(doc, a, board.revision, columns), 422)).toMatchObject({ error: 'invalid_board' })
  expect(await storedBoardRows(doc.draft!.id)).toEqual(before)

  // With a destination, the Tasks survive the removal.
  board = (await json(saveBoard(doc, a, board.revision, edit(board, (c) => {
    named(c, 'Ideas').taskIds.push(...named(c, 'Needs review').taskIds)
    c.splice(1, 1)
  })), 200)).board
  expect(arrangement(board)).toEqual(['Ready to publish:', 'In preparation:', `Ideas:${tasks[1]},${tasks[0]},${tasks[2]}`])
  // Down to one column, which then cannot be removed: a board keeps a place for its Tasks.
  board = (await json(saveBoard(doc, a, board.revision, [{ ...board.columns[2] }]), 200)).board
  expect(board.columns).toHaveLength(1)
  expect(await json(saveBoard(doc, a, board.revision, []), 422)).toMatchObject({ error: 'invalid_board' })
  // The database itself keeps a column on every board.
  await expect(db.transaction(async (tx) => {
    await tx.delete(draftBoardCards).where(eq(draftBoardCards.learningPathVersionId, doc.draft!.id))
    await tx.delete(draftBoardColumns).where(eq(draftBoardColumns.id, board.columns[0].id))
  })).rejects.toThrow()
  expect(arrangement(await boardOf(doc, a))).toEqual(arrangement(board))
})

it('AC4/AC5: moving Tasks to Ready changes no Approval, XP, Mastery, learner record, published Version or publication rule', async () => {
  // The fixture Path: Version 1 has Enrollments with an approved Submission; Version 2 is the latest.
  const v1 = fx.versions.version1.id
  await amendPublished(db, (tx) => tx.update(versionTasks).set({ xpReward: 20 }).where(and(eq(versionTasks.learningPathVersionId, v1), eq(versionTasks.taskId, fx.content.taskA.id))))
  const enrollmentId = (await json(request(`/invitations/${fx.invitations.toLearner.id}/accept`, 'learner', 'POST'), 201)).enrollment.id
  const taskRoute = `/enrollments/${enrollmentId}/tasks/${fx.content.taskA.id}/submission`
  const revision = (await json(request(`${taskRoute}/revisions`, 'learner', 'POST', { text: 'Vectors added', urls: [] }), 201)).revision
  await json(request(`${taskRoute}/revisions/${revision.id}/review`, 'coach', 'POST', { decision: 'approval' }), 201)
  await json(request(`${taskRoute}/revisions`, 'learner', 'POST', { text: 'A newer attempt', urls: [] }), 201)
  const learnerState = async () => (await json(request(`/enrollments/${enrollmentId}/learning-state`, 'learner'), 200)).learningState
  const learnerBefore = await learnerState()
  expect(learnerBefore.xp).toBe(20)
  const reviewsBefore = (await db.select().from(submissionReviews)).length
  const revisionsBefore = (await db.select().from(submissionRevisions)).length
  const enrollmentsBefore = await db.select().from(enrollments)

  // The next Draft is prepared through the ordinary workflow; its board starts fresh.
  const latest = await readDoc(fx.paths.path.id)
  const prepared: Doc = await json(request(`${coachPath(fx.paths.path.id)}/drafts`, 'coach', 'POST', { expectedRevision: latest.learningPath.revision }), 201)
  const contentBefore = await storedContent(fx.paths.path.id)
  const skillA = fx.content.skillA.id
  let board = await boardOf(prepared, skillA)
  // Its Tasks start in Ideas in the Draft's saved order.
  const draftOrder = prepared.application.skills.find((s) => s.id === skillA)!.tasks.map((t) => t.id)
  expect(arrangement(board)).toEqual([`Ideas:${draftOrder.join(',')}`, 'In preparation:', 'Ready:'])
  board = (await json(saveBoard(prepared, skillA, board.revision, edit(board, (c) => { moveTo(c, fx.content.taskA.id, 'Ready'); moveTo(c, fx.content.taskAReading.id, 'Ready') })), 200)).board
  expect(named(board.columns, 'Ready').taskIds).toEqual([fx.content.taskA.id, fx.content.taskAReading.id])

  // Nothing but the board changed: content, Versions, the Path revision and every learner record are as they were.
  expect(await storedContent(fx.paths.path.id)).toEqual(contentBefore)
  expect(await learnerState()).toEqual(learnerBefore)
  expect((await json(request(`/enrollments/${enrollmentId}/learning-state`, 'coach'), 200)).learningState).toEqual(learnerBefore)
  expect((await db.select().from(submissionReviews)).length).toBe(reviewsBefore)
  expect((await db.select().from(submissionRevisions)).length).toBe(revisionsBefore)
  expect(await db.select().from(enrollments)).toEqual(enrollmentsBefore)
  // The learner's enrolled Version carries no preparation state.
  const enrolled = JSON.stringify(await json(request(`/enrollments/${enrollmentId}/version`, 'learner'), 200))
  expect(enrolled).not.toContain('In preparation')
  expect(enrolled).not.toContain(board.columns[0].id)

  // Publication follows the progression rules only: an empty Ready column does not block it...
  const { doc, a, b } = await draftPath('Spaces')
  const spaces = await boardOf(doc, a)
  expect(named(spaces.columns, 'Ready').taskIds).toEqual([])
  const published: Doc = await json(request(`${coachPath(doc.learningPath.id)}/publication`, 'coach', 'POST', { expectedRevision: doc.learningPath.revision }), 200)
  expect(published.draft).toBeNull()
  // ...and a full Ready column does not unblock a Draft whose required route cannot be completed.
  const blocked = await draftPath('Blocked')
  const noRequired: Doc = await json(saveDoc(blocked.doc, (d) => { for (const t of d.application.skills[1].tasks) t.required = false }), 200)
  let readyAll = await boardOf(noRequired, blocked.b)
  readyAll = (await json(saveBoard(noRequired, blocked.b, readyAll.revision, edit(readyAll, (c) => { moveTo(c, blocked.taskB, 'Ready') })), 200)).board
  expect(await json(request(`${coachPath(noRequired.learningPath.id)}/publication`, 'coach', 'POST', { expectedRevision: noRequired.learningPath.revision }), 422)).toMatchObject({ error: 'publication_blocked' })

  // A published Draft's board is frozen with its Version: no read or save through it, and no direct write.
  const frozen = await storedBoardRows(doc.draft!.id)
  expect(await json(request(boardRoute(doc.learningPath.id, doc.draft!.id, a)), 409)).toMatchObject({ error: 'draft_published' })
  expect(await json(saveBoard(doc, a, spaces.revision, edit(spaces, (c) => { c.reverse() })), 409)).toMatchObject({ error: 'draft_published' })
  await expect(db.update(draftBoardColumns).set({ name: 'Rewritten' }).where(eq(draftBoardColumns.learningPathVersionId, doc.draft!.id)).execute()).rejects.toThrow()
  await expect(db.delete(draftBoardCards).where(eq(draftBoardCards.learningPathVersionId, doc.draft!.id)).execute()).rejects.toThrow()
  expect(await storedBoardRows(doc.draft!.id)).toEqual(frozen)
  // The next Draft's board starts from its Tasks again; readiness is not carried as progress.
  const next: Doc = await json(request(`${coachPath(doc.learningPath.id)}/drafts`, 'coach', 'POST', { expectedRevision: published.learningPath.revision }), 201)
  expect((await boardOf(next, b)).columns.map((c) => c.name)).toEqual(['Ideas', 'In preparation', 'Ready'])
})

it('AC5/AC9: only the owning Coach reads or saves a Draft board, for its own Path, open Draft, Skill, Tasks and columns', async () => {
  const { doc, a, b, tasks, taskB } = await draftPath()
  const board = await boardOf(doc, a)
  const other = await boardOf(doc, b)
  const pathId = doc.learningPath.id
  const draftId = doc.draft!.id
  const columns = edit(board, (c) => { moveTo(c, tasks[0], 'Ready') })
  const before = { rows: await storedBoardRows(draftId), content: await storedContent(pathId) }

  // Learners, peers, strangers and the other Coach find nothing; without a session there is no access.
  for (const actor of ['otherCoach', 'learner', 'peer', 'unrelated', 'unverified'] as const) {
    expect((await request(boardRoute(pathId, draftId, a), actor)).status).toBe(404)
    expect((await saveBoard(doc, a, board.revision, columns, actor)).status).toBe(404)
    expect((await saveBoard(doc, a, board.revision, { not: 'a board' }, actor)).status).toBe(404)
  }
  expect((await request(boardRoute(pathId, draftId, a), null)).status).toBe(401)
  expect((await saveBoard(doc, a, board.revision, columns, null)).status).toBe(401)

  // Wrong references: another Path's Draft, a published Version, unknown or malformed IDs, a Task as a Skill.
  const elsewhere = await draftPath('Another Path')
  const v2 = fx.versions.version2.id
  const refusals: [string, number, string][] = [
    [boardRoute(pathId, elsewhere.doc.draft!.id, a), 404, 'draft_not_found'],
    [boardRoute(pathId, crypto.randomUUID(), a), 404, 'draft_not_found'],
    [boardRoute(pathId, 'not-a-uuid', a), 404, 'draft_not_found'],
    [boardRoute(fx.paths.path.id, v2, fx.content.skillA.id), 409, 'draft_published'],
    [boardRoute(pathId, draftId, elsewhere.a), 404, 'skill_not_found'],
    [boardRoute(pathId, draftId, tasks[0]), 404, 'skill_not_found'],
    [boardRoute(pathId, draftId, 'not-a-uuid'), 404, 'skill_not_found'],
    [boardRoute(px.paths.main.id, draftId, a), 404, 'learning_path_not_found'],
    [boardRoute('not-a-uuid', draftId, a), 404, 'learning_path_not_found'],
  ]
  for (const [route, status, error] of refusals) {
    expect(await json(request(route), status)).toMatchObject({ error })
    expect(await json(request(route, 'coach', 'PUT', { expectedRevision: 0, columns }), status)).toMatchObject({ error })
  }
  // The personal board route never opens a Draft Skill, nor the other way round.
  expect((await request(`/personal/learning-paths/${pathId}/skills/${a}/board`, 'coach')).status).toBe(404)

  // Another Skill's Task, another Path's Task, or a column of another board is refused whole.
  expect(await json(saveBoard(doc, a, board.revision, edit(board, (c) => { c[0].taskIds.push(taskB) })), 422)).toMatchObject({ error: 'board_task_unknown' })
  expect(await json(saveBoard(doc, a, board.revision, edit(board, (c) => { c[0].taskIds.push(elsewhere.tasks[0]) })), 422)).toMatchObject({ error: 'board_task_unknown' })
  expect(await json(saveBoard(doc, a, board.revision, edit(board, (c) => { c.push({ ...other.columns[2], taskIds: [] }) })), 422)).toMatchObject({ error: 'column_owned_elsewhere' })
  // Extra fields cannot carry content: a save naming titles, rewards or rules changes only the arrangement.
  const sneaky = edit(board, (c) => { moveTo(c, tasks[0], 'Ready') }).map((c) => ({ ...c, title: 'Renamed', tasks: [{ id: tasks[0], title: 'Hacked', xpReward: 999, required: false }] }))
  expect(await storedBoardRows(draftId)).toEqual(before.rows)
  const accepted = (await json(saveBoard(doc, a, board.revision, sneaky), 200)).board as Board
  expect(arrangement(accepted)).toEqual(arrangement({ ...board, columns }))
  expect(await storedContent(pathId)).toEqual(before.content)
  expect(await boardOf(doc, b)).toEqual(other)
  // Published content cannot be reached through any board: the fixture's Version 2 is unchanged by a Draft board save there.
  const fixtureBefore = await storedContent(fx.paths.path.id)
  expect((await saveBoard({ ...doc, learningPath: { ...doc.learningPath, id: fx.paths.path.id } }, fx.content.skillA.id, 0, columns, 'coach', v2)).status).toBe(409)
  expect(await storedContent(fx.paths.path.id)).toEqual(fixtureBefore)
})

it('AC9: a stale save changes nothing and answers the current board; a lost answer\'s retry records nothing twice', async () => {
  const { doc, a, tasks } = await draftPath()
  const board = await boardOf(doc, a)
  const mine = edit(board, (c) => { moveTo(c, tasks[0], 'In preparation') })
  const theirs = edit(board, (c) => { moveTo(c, tasks[2], 'Ready') })
  const accepted = (await json(saveBoard(doc, a, 0, theirs), 200)).board as Board
  const stale = await json(saveBoard(doc, a, 0, mine), 409)
  expect(stale).toMatchObject({ error: 'stale_revision', current: accepted })
  expect(await boardOf(doc, a)).toEqual(accepted)
  // The same arrangement sent again on the old revision (a retry after a lost answer) is accepted unchanged.
  expect(await json(saveBoard(doc, a, 0, theirs), 200)).toMatchObject({ changed: false, board: accepted })
  expect((await boardOf(doc, a)).revision).toBe(1)
})

it('AC6/AC7: Draft saves and archival keep an opened board coherent; deletion undo and archived material follow their own contracts', async () => {
  // The fixture Path's next Draft holds published Tasks (with learner history) next to new ones.
  const latest = await readDoc(fx.paths.path.id)
  let doc: Doc = await json(request(`${coachPath(fx.paths.path.id)}/drafts`, 'coach', 'POST', { expectedRevision: latest.learningPath.revision }), 201)
  const skillA = fx.content.skillA.id
  let board = await boardOf(doc, skillA)
  board = (await json(saveBoard(doc, skillA, board.revision, edit(board, (c) => { moveTo(c, fx.content.taskA.id, 'Ready') })), 200)).board

  // A Task created through the Draft joins the end of the first column, and the board's revision advances.
  const added = task('New worksheet')
  const copied = task('Copied practice')
  doc = await json(saveDoc(doc, (d) => { d.application.skills.find((s) => s.id === skillA)!.tasks.push(added, copied) }), 200)
  const grown = await boardOf(doc, skillA)
  expect(grown.revision).toBe(board.revision + 1)
  expect(arrangement(grown)).toEqual([`Ideas:${board.columns[0].taskIds.join(',')},${added.id},${copied.id}`, 'In preparation:', `Ready:${fx.content.taskA.id}`])
  // A board change based on the earlier arrangement is stale, and changes nothing.
  expect(await json(saveBoard(doc, skillA, board.revision, edit(board, (c) => { c.reverse() })), 409)).toMatchObject({ error: 'stale_revision', current: grown })
  board = (await json(saveBoard(doc, skillA, grown.revision, edit(grown, (c) => { moveTo(c, added.id, 'In preparation') })), 200)).board

  // An unpublished Task is deleted through the ordinary Draft save; undo is another ordinary save.
  const withAdded = doc
  doc = await json(saveDoc(doc, (d) => { const s = d.application.skills.find((x) => x.id === skillA)!; s.tasks = s.tasks.filter((t) => t.id !== added.id) }), 200)
  const shrunk = await boardOf(doc, skillA)
  expect(shrunk.columns.flatMap((c) => c.taskIds)).not.toContain(added.id)
  expect(await json(saveBoard(doc, skillA, shrunk.revision, edit(shrunk, (c) => { c[1].taskIds.push(added.id) })), 422)).toMatchObject({ error: 'board_task_unknown' })
  doc = await json(saveDoc({ ...withAdded, learningPath: doc.learningPath }), 200)
  const restored = await boardOf(doc, skillA)
  expect(named(restored.columns, 'Ideas').taskIds.at(-1)).toBe(added.id)
  board = (await json(saveBoard(doc, skillA, restored.revision, edit(restored, (c) => { moveTo(c, added.id, 'In preparation', 0) })), 200)).board

  // A published Task leaves the Draft only by archival; it leaves the board with it and cannot come back through it.
  const contentBefore = await storedContent(fx.paths.path.id)
  expect(await json(saveDoc(doc, (d) => { const s = d.application.skills.find((x) => x.id === skillA)!; s.tasks = s.tasks.filter((t) => t.id !== fx.content.taskA.id) }), 409)).toMatchObject({ error: 'task_has_history' })
  doc = await json(request(`${coachPath(fx.paths.path.id)}/draft/tasks/${fx.content.taskA.id}/archive`, 'coach', 'POST', { expectedRevision: doc.learningPath.revision }), 200)
  const archived = await boardOf(doc, skillA)
  expect(archived.revision).toBe(board.revision + 1)
  expect(archived.columns.flatMap((c) => c.taskIds)).not.toContain(fx.content.taskA.id)
  // Neither a stale board (the arrangement before archival, as a reapplied or retried save would send it) nor a current one may put it back.
  expect(await json(saveBoard(doc, skillA, board.revision, board.columns), 409)).toMatchObject({ error: 'stale_revision', current: archived })
  expect(await json(saveBoard(doc, skillA, board.revision, edit(board, (c) => { c.reverse() })), 409)).toMatchObject({ error: 'stale_revision', current: archived })
  expect((await boardOf(doc, skillA)).columns.flatMap((c) => c.taskIds)).not.toContain(fx.content.taskA.id)
  expect(await json(saveBoard(doc, skillA, archived.revision, edit(archived, (c) => { c[2].taskIds.push(fx.content.taskA.id) })), 422)).toMatchObject({ error: 'board_task_unknown' })
  // The published Versions still hold it, unchanged.
  const after = await storedContent(fx.paths.path.id)
  const published = (rows: string[]) => rows.filter((row) => !row.includes(doc.draft!.id))
  expect(published(after.tasks)).toEqual(published(contentBefore.tasks))
  expect(published(after.tasks).some((row) => row.includes(fx.content.taskA.id))).toBe(true)

  // Deleting an unpublished Skill whose board was opened takes the board with it.
  const extra = task('Scratch')
  let scratch = ''
  doc = await json(saveDoc(doc, (d) => { scratch = addSkill(d, 'Scratch Skill', [extra]) }), 200)
  await boardOf(doc, scratch)
  doc = await json(saveDoc(doc, (d) => {
    d.application.skills = d.application.skills.filter((s) => s.id !== scratch)
    d.editor.cards = d.editor.cards.filter((c) => c.id !== scratch)
  }), 200)
  expect((await storedBoardRows(doc.draft!.id)).boards.map((row) => row.skillId)).toEqual([skillA])
  expect(await json(request(boardRoute(doc.learningPath.id, doc.draft!.id, scratch)), 404)).toMatchObject({ error: 'skill_not_found' })
  // The database refuses a card for a Task that is not in the Draft.
  await expect(db.execute(sql`insert into draft_board_cards values (${doc.draft!.id}, ${skillA}, ${fx.content.taskA.id}, ${archived.columns[0].id}, 99)`).execute()).rejects.toThrow()
})
