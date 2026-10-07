import { afterAll, beforeAll, beforeEach, expect, it } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'
import { createApp } from '../src/app'
import type { Database } from '../src/db/client'
import { personalBoardCards, personalBoardColumns, personalTasks } from '../src/db/schema'
import { FIXTURE_IDENTITY_HEADER, fixtureIdentity } from '../src/identity'
import { prepareTestDatabase, resetTestDatabase } from './support/database'
import { seedEnrollmentFixture, seedPersonalFixture, type EnrollmentFixture, type PersonalFixture } from './support/fixtures'

/**
 * UX03 (#49): a personal Skill's Task Board through the request boundary on PostgreSQL.
 * Membership of the Completion Column is the Task's completion (ADR 0027): board saves
 * complete and uncomplete Tasks atomically under the existing Access and XP rules, and
 * the other entry points (completion action, document save, archival) keep the board
 * coherent. Stored learning state is read back independently of any board answer.
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
async function request(path: string, actor: Actor = 'learner', method = 'GET', body?: unknown) {
  return app.request(path, { method, headers: { ...(actor ? { [FIXTURE_IDENTITY_HEADER]: actor } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
}
async function json(response: Response | Promise<Response>, status: number) {
  const r = await response
  const body = await r.json() as any
  expect({ status: r.status, body }).toMatchObject({ status })
  return body
}

interface Column { id: string; name: string; completion: boolean; taskIds: string[] }
interface Board { skillId: string; revision: number; columns: Column[] }

/** A Path authored through the document API: Skill A with four Tasks in order, Skill B (after A) with one. */
async function authoredPath(title = 'Systems Rust', actor: Actor = 'learner') {
  const created = await json(request('/personal/learning-paths', actor, 'POST', { title, goal: '' }), 201)
  const [a, b] = [crypto.randomUUID(), crypto.randomUUID()]
  const tasks = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
  const taskB = crypto.randomUUID()
  const doc = await json(request(`/personal/learning-paths/${created.learningPath.id}/document`, actor, 'PUT', {
    expectedRevision: 0, title, goal: '',
    editor: { format_version: 1, cards: [{ id: a, title: 'Ownership', position: { x: 80, y: 100 } }, { id: b, title: 'Lifetimes', position: { x: 360, y: 100 } }], connections: [{ from_id: a, to_id: b }] },
    application: { skills: [
      { id: a, title: 'Ownership', outcome: 'Explain moves', tasks: tasks.map((id, i) => ({ id, title: `Task ${i + 1}`, description: '' })) },
      { id: b, title: 'Lifetimes', outcome: 'Annotate signatures', tasks: [{ id: taskB, title: 'Annotate a parser', description: '' }] },
    ] },
  }), 200)
  return { pathId: created.learningPath.id as string, a, b, tasks, taskB, doc }
}
type Authored = Awaited<ReturnType<typeof authoredPath>>

const at = (p: { pathId: string }) => `/personal/learning-paths/${p.pathId}`
const boardOf = async (p: { pathId: string }, skillId: string, actor: Actor = 'learner') => (await json(request(`${at(p)}/skills/${skillId}/board`, actor), 200)).board as Board
const saveBoard = (p: { pathId: string }, skillId: string, expectedRevision: number, columns: Column[], actor: Actor = 'learner') =>
  request(`${at(p)}/skills/${skillId}/board`, actor, 'PUT', { expectedRevision, columns })
const learningState = async (p: { pathId: string }) => (await json(request(`${at(p)}/learning-state`), 200)).learningState
const task = (s: any, id: string) => s.tasks.find((t: any) => t.taskId === id)
const skill = (s: any, id: string) => s.skills.find((x: any) => x.skillId === id)
const act = (p: Authored, path: string, method: string, body?: unknown) => json(request(`${at(p)}${path}`, 'learner', method, body), 200)
const document = async (p: { pathId: string }) => json(request(at(p)), 200)

/** A copy of the board's columns with one change applied. */
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
const arrangement = (board: Board) => board.columns.map((c) => [c.name, c.completion, c.taskIds])

it('AC1/AC7: a first opening creates Backlog, To Do, In Progress and Done, places existing Tasks once in order, and replays nothing', async () => {
  const p = await authoredPath()
  const [t1, t2, t3, t4] = p.tasks
  await act(p, `/tasks/${t2}/reward`, 'PUT', { xpReward: 20 })
  await act(p, `/tasks/${t2}/completion`, 'PUT')
  await act(p, `/tasks/${t4}/completion`, 'PUT')
  // An archived Task with history stays out of active columns.
  await act(p, `/tasks/${t3}/completion`, 'PUT')
  await json(request(`${at(p)}/tasks/${t3}/archive`, 'learner', 'POST', {}), 200)
  const before = await learningState(p)

  const board = await boardOf(p, p.a)
  expect(arrangement(board)).toEqual([['Backlog', false, [t1]], ['To Do', false, []], ['In Progress', false, []], ['Done', true, [t2, t4]]])
  expect(board.columns.filter((c) => c.completion)).toHaveLength(1)
  // Nothing was completed, awarded or declared by placing the Tasks.
  expect(await learningState(p)).toEqual(before)
  expect(skill(before, p.a).mastery).toBe(false)
  // Reopening reads the same board; it is not placed again.
  expect(await boardOf(p, p.a)).toEqual(board)
  // Another Skill's board holds only its own Task.
  expect(arrangement(await boardOf(p, p.b))).toEqual([['Backlog', false, [p.taskB]], ['To Do', false, []], ['In Progress', false, []], ['Done', true, []]])
})

it('AC7: concurrent first openings create one board; reopening keeps later customization', async () => {
  const p = await authoredPath()
  const boards = await Promise.all(Array.from({ length: 6 }, () => boardOf(p, p.a)))
  for (const board of boards) expect(board).toEqual(boards[0])
  const stored = await db.select().from(personalBoardColumns).where(and(eq(personalBoardColumns.learningPathId, p.pathId), eq(personalBoardColumns.skillId, p.a)))
  expect(stored).toHaveLength(4)
  expect(await db.select().from(personalBoardCards).where(eq(personalBoardCards.learningPathId, p.pathId))).toHaveLength(4)

  const customized = await json(saveBoard(p, p.a, boards[0].revision, edit(boards[0], (columns) => {
    named(columns, 'Backlog').name = 'Someday'
    columns.splice(1, 1)
  })), 200)
  expect(await boardOf(p, p.a)).toEqual(customized.board)
  expect(customized.board.columns.map((c: Column) => c.name)).toEqual(['Someday', 'In Progress', 'Done'])
})

it('AC2/AC4/AC8: columns are added, renamed, reordered and removed with a destination; order and membership persist per Skill and Path', async () => {
  const p = await authoredPath()
  const other = await authoredPath('Jazz Guitar')
  const [t1, t2, t3, t4] = p.tasks
  const otherBefore = await boardOf(other, other.a)
  const bBefore = await boardOf(p, p.b)
  let board = await boardOf(p, p.a)
  const review = crypto.randomUUID()
  // Reorder within Backlog, add a column, rename Done, move a column, move a card across columns.
  const result = await json(saveBoard(p, p.a, board.revision, edit(board, (columns) => {
    named(columns, 'Backlog').taskIds = [t3, t1, t4, t2]
    columns.splice(3, 0, { id: review, name: 'Review', completion: false, taskIds: [] })
    named(columns, 'Done').name = 'Finished'
    const [todo] = columns.splice(1, 1)
    columns.splice(2, 0, todo)
    moveTo(columns, t4, 'Review')
  })), 200)
  expect(result.changed).toBe(true)
  board = await boardOf(p, p.a)
  expect(board.revision).toBe(result.board.revision)
  expect(arrangement(board)).toEqual([['Backlog', false, [t3, t1, t2]], ['In Progress', false, []], ['To Do', false, []], ['Review', false, [t4]], ['Finished', true, []]])
  // Column movement never changes ownership: the Task stays under its Skill.
  expect(task(await learningState(p), t4)).toMatchObject({ skillId: p.a, completed: false })
  // Removing a populated column without a destination would lose its Task: refused, nothing changes.
  const lost = await json(saveBoard(p, p.a, board.revision, edit(board, (columns) => { columns.splice(3, 1) })), 422)
  expect(lost.error).toBe('board_task_missing')
  // With a destination, the column goes and its Task survives there.
  board = (await json(saveBoard(p, p.a, board.revision, edit(board, (columns) => { moveTo(columns, t4, 'To Do'); columns.splice(3, 1) })), 200)).board
  expect(arrangement(board)).toEqual([['Backlog', false, [t3, t1, t2]], ['In Progress', false, []], ['To Do', false, [t4]], ['Finished', true, []]])
  // The last usable column besides the Completion Column cannot be removed.
  const lastUsable = edit(board, (columns) => { columns.splice(0, 3); named(columns, 'Finished').taskIds = [] })
  expect((await json(saveBoard(p, p.a, board.revision, lastUsable), 422)).error).toBe('invalid_board')
  expect(await boardOf(p, p.a)).toEqual(board)
  // The other Skill and the other Path are untouched.
  expect(await boardOf(p, p.b)).toEqual(bBefore)
  expect(await boardOf(other, other.a)).toEqual(otherBefore)
})

it('AC3: entering the Completion Column completes, leaving uncompletes; repeats and lost answers never multiply XP; Mastery stays', async () => {
  const p = await authoredPath()
  const [t1] = p.tasks
  await act(p, `/tasks/${t1}/reward`, 'PUT', { xpReward: 20 })
  let board = await boardOf(p, p.a)
  // A column named "Done" without the role completes nothing; the role decides.
  const fake = edit(board, (columns) => { named(columns, 'Done').name = 'Finished'; named(columns, 'To Do').name = 'Done'; moveTo(columns, t1, 'Done') })
  board = (await json(saveBoard(p, p.a, board.revision, fake), 200)).board
  expect(task(await learningState(p), t1).completed).toBe(false)

  const into = edit(board, (columns) => moveTo(columns, t1, 'Finished'))
  const entered = await json(saveBoard(p, p.a, board.revision, into), 200)
  let s = await learningState(p)
  expect(task(s, t1)).toMatchObject({ completed: true, xpContribution: 20 })
  expect(s.xp).toBe(20)
  expect(entered.learningState.xp).toBe(20)
  // The answer was lost: the same save again, on the old revision, changes nothing.
  const retried = await json(saveBoard(p, p.a, board.revision, into), 200)
  expect(retried.changed).toBe(false)
  expect((await learningState(p)).xpHistory).toHaveLength(1)
  board = entered.board

  board = (await json(saveBoard(p, p.a, board.revision, edit(board, (columns) => moveTo(columns, t1, 'Backlog'))), 200)).board
  board = (await json(saveBoard(p, p.a, board.revision, edit(board, (columns) => moveTo(columns, t1, 'Finished'))), 200)).board
  s = await learningState(p)
  expect(s.xp).toBe(20)
  expect(s.xpHistory.map((e: any) => [e.kind, e.cause, e.amount])).toEqual([
    ['award', 'completion', 20], ['correction', 'completion_undone', -20], ['correction', 'completion', 20],
  ])
  // A completed Task in the Completion Column whose reward changes follows the existing correction rule and stays put.
  s = (await act(p, `/tasks/${t1}/reward`, 'PUT', { xpReward: 35 })).learningState
  expect(s.xp).toBe(35)
  expect(s.xpHistory.at(-1)).toMatchObject({ kind: 'correction', cause: 'reward_change', amount: 15 })
  expect(named((await boardOf(p, p.a)).columns, 'Finished').taskIds).toEqual([t1])
  expect(skill(s, p.a).mastery).toBe(false)
  expect(s.masteryHistory).toEqual([])
})

it('AC3/AC9: a completion-coupled move into a locked Skill\'s Completion Column persists neither the column nor the learning update', async () => {
  const p = await authoredPath()
  let board = await boardOf(p, p.b)
  const before = await learningState(p)
  expect(skill(before, p.b).access).toBe(false)
  const refused = await json(saveBoard(p, p.b, board.revision, edit(board, (columns) => {
    named(columns, 'Done').name = 'Finished'
    moveTo(columns, p.taskB, 'Finished')
  })), 403)
  expect(refused.error).toBe('skill_locked')
  expect(await boardOf(p, p.b)).toEqual(board)
  expect(await learningState(p)).toEqual(before)
  // Leaving is a correction and allowed while locked.
  await act(p, `/skills/${p.a}/mastery`, 'PUT')
  board = (await json(saveBoard(p, p.b, board.revision, edit(board, (columns) => moveTo(columns, p.taskB, 'Done'))), 200)).board
  await act(p, `/skills/${p.a}/mastery`, 'DELETE')
  expect(skill(await learningState(p), p.b).access).toBe(false)
  board = (await json(saveBoard(p, p.b, board.revision, edit(board, (columns) => moveTo(columns, p.taskB, 'Backlog'))), 200)).board
  expect(task(await learningState(p), p.taskB).completed).toBe(false)
})

it('AC9: a competing tab\'s stale save changes nothing and answers the newer board', async () => {
  const p = await authoredPath()
  const [t1, t2] = p.tasks
  const seen = await boardOf(p, p.a)
  const first = await json(saveBoard(p, p.a, seen.revision, edit(seen, (columns) => moveTo(columns, t1, 'In Progress'))), 200)
  const stale = await json(saveBoard(p, p.a, seen.revision, edit(seen, (columns) => { moveTo(columns, t2, 'Done'); columns.splice(1, 1) })), 409)
  expect(stale).toMatchObject({ error: 'stale_revision', current: first.board })
  expect(await boardOf(p, p.a)).toEqual(first.board)
  expect(task(await learningState(p), t2).completed).toBe(false)
  expect((await learningState(p)).xpHistory).toEqual([])
})

it('AC5: replacing a removed Completion Column reconciles every affected Task in one validated change under the same XP rules', async () => {
  const p = await authoredPath()
  const [t1, t2, t3] = p.tasks
  await act(p, `/tasks/${t2}/reward`, 'PUT', { xpReward: 20 })
  await act(p, `/tasks/${t3}/reward`, 'PUT', { xpReward: 5 })
  let board = await boardOf(p, p.a)
  board = (await json(saveBoard(p, p.a, board.revision, edit(board, (columns) => { moveTo(columns, t2, 'Done'); moveTo(columns, t3, 'In Progress') })), 200)).board
  expect((await learningState(p)).xp).toBe(20)
  // A Completion Column cannot simply disappear: a board needs exactly one.
  const without = edit(board, (columns) => { moveTo(columns, t2, 'Backlog'); columns.splice(3, 1) })
  expect((await json(saveBoard(p, p.a, board.revision, without), 422)).error).toBe('invalid_board')
  // Remove Done, make In Progress the Completion Column, send Done's Task to Backlog.
  const replaced = await json(saveBoard(p, p.a, board.revision, edit(board, (columns) => {
    moveTo(columns, t2, 'Backlog')
    columns.splice(3, 1)
    named(columns, 'In Progress').completion = true
  })), 200)
  const s = await learningState(p)
  expect(arrangement(replaced.board)).toEqual([['Backlog', false, [t1, p.tasks[3], t2]], ['To Do', false, []], ['In Progress', true, [t3]]])
  expect(task(s, t2)).toMatchObject({ completed: false, xpContribution: 0 })
  expect(task(s, t3)).toMatchObject({ completed: true, xpContribution: 5 })
  expect(s.xp).toBe(5)
  expect(s.xpHistory.slice(-2).map((e: any) => [e.taskId, e.kind, e.cause, e.amount]).sort()).toEqual([
    [t2, 'correction', 'completion_undone', -20], [t3, 'award', 'completion', 5],
  ].sort())
  // Sending the removed column's Task into the new Completion Column keeps it complete without a new XP event.
  board = replaced.board
  board = (await json(saveBoard(p, p.a, board.revision, edit(board, (columns) => moveTo(columns, t2, 'In Progress'))), 200)).board
  const events = (await learningState(p)).xpHistory.length
  const kept = await json(saveBoard(p, p.a, board.revision, edit(board, (columns) => {
    const backlog = named(columns, 'Backlog')
    columns.splice(columns.indexOf(backlog), 1)
    named(columns, 'To Do').taskIds.push(...backlog.taskIds)
    named(columns, 'To Do').completion = false
  })), 200)
  expect(arrangement(kept.board)).toEqual([['To Do', false, [t1, p.tasks[3]]], ['In Progress', true, [t3, t2]]])
  expect((await learningState(p)).xpHistory).toHaveLength(events)
})

it('AC3: the retained completion action keeps the card on the matching side of the Completion Column', async () => {
  const p = await authoredPath()
  const [t1, t2] = p.tasks
  let board = await boardOf(p, p.a)
  // Move Done first: the uncompleted Task goes to the first column that is not the Completion Column.
  board = (await json(saveBoard(p, p.a, board.revision, edit(board, (columns) => { const [done] = columns.splice(3, 1); columns.unshift(done); moveTo(columns, t2, 'In Progress') })), 200)).board
  await act(p, `/tasks/${t2}/completion`, 'PUT')
  let after = await boardOf(p, p.a)
  expect(after.revision).toBe(board.revision + 1)
  expect(named(after.columns, 'Done').taskIds).toEqual([t2])
  await act(p, `/tasks/${t2}/completion`, 'DELETE')
  after = await boardOf(p, p.a)
  expect(arrangement(after)).toEqual([['Done', true, []], ['Backlog', false, [t1, p.tasks[2], p.tasks[3], t2]], ['To Do', false, []], ['In Progress', false, []]])
  // A save based on the board before the action is stale.
  expect((await json(saveBoard(p, p.a, board.revision, edit(board, (columns) => moveTo(columns, t1, 'To Do'))), 409)).error).toBe('stale_revision')
})

it('AC6: Tasks added, deleted, undone or archived through the document keep the board coherent and cannot be resurrected', async () => {
  const p = await authoredPath()
  const [t1, t2] = p.tasks
  let board = await boardOf(p, p.a)
  board = (await json(saveBoard(p, p.a, board.revision, edit(board, (columns) => moveTo(columns, t1, 'In Progress'))), 200)).board
  let doc = await document(p)
  const save = (change: (d: any) => void) => {
    const next = structuredClone(doc)
    change(next)
    return json(request(`${at(p)}/document`, 'learner', 'PUT', { expectedRevision: next.learningPath.revision, title: next.learningPath.title, goal: next.learningPath.goal, editor: next.editor, application: next.application }), 200)
  }
  // A new Task (from any entry point) joins the end of the first column that is not the Completion Column.
  const added = crypto.randomUUID()
  doc = await save((d) => d.application.skills[0].tasks.push({ id: added, title: 'New one', description: 'optional notes' }))
  expect(named((await boardOf(p, p.a)).columns, 'Backlog').taskIds.at(-1)).toBe(added)
  // Deleting an eligible Task removes its card; a stale board save still holding it is refused.
  const beforeDelete = await boardOf(p, p.a)
  doc = await save((d) => { d.application.skills[0].tasks = d.application.skills[0].tasks.filter((t: any) => t.id !== t1) })
  const deleted = await boardOf(p, p.a)
  expect(deleted.columns.flatMap((c) => c.taskIds)).not.toContain(t1)
  expect((await json(saveBoard(p, p.a, beforeDelete.revision, edit(beforeDelete, (columns) => moveTo(columns, t1, 'To Do'))), 409)).error).toBe('stale_revision')
  // Undo is a normal revalidated save bringing the same Task back; its card returns to Backlog, then a board save can place it.
  doc = await save((d) => d.application.skills[0].tasks.unshift({ id: t1, title: 'Task 1', description: '' }))
  board = await boardOf(p, p.a)
  expect(named(board.columns, 'Backlog').taskIds).toContain(t1)
  board = (await json(saveBoard(p, p.a, board.revision, edit(board, (columns) => moveTo(columns, t1, 'In Progress'))), 200)).board
  // A Task with history is archived, not deleted: its card goes, its XP stays, and nothing brings it back.
  board = (await json(saveBoard(p, p.a, board.revision, edit(board, (columns) => moveTo(columns, t2, 'Done'))), 200)).board
  const withHistory = await learningState(p)
  expect(withHistory.historyTaskIds).toContain(t2)
  const refused = await json(request(`${at(p)}/document`, 'learner', 'PUT', { expectedRevision: doc.learningPath.revision, title: doc.learningPath.title, goal: doc.learningPath.goal, editor: doc.editor, application: { skills: doc.application.skills.map((s: any) => ({ ...s, tasks: s.tasks.filter((t: any) => t.id !== t2) })) } }), 409)
  expect(refused.error).toBe('task_has_history')
  const archived = await json(request(`${at(p)}/tasks/${t2}/archive`, 'learner', 'POST', { expectedRevision: doc.learningPath.revision }), 200)
  const after = await boardOf(p, p.a)
  expect(after.columns.flatMap((c) => c.taskIds)).not.toContain(t2)
  expect(after.revision).toBe(board.revision + 1)
  expect(task(archived.learningState, t2)).toMatchObject({ completed: true, archivedAt: expect.any(String) })
  // Neither the board undo of a stale save nor a current save naming the archived Task resurrects it.
  expect((await json(saveBoard(p, p.a, board.revision, board.columns), 409)).error).toBe('stale_revision')
  expect((await json(saveBoard(p, p.a, after.revision, edit(after, (columns) => named(columns, 'Done').taskIds.push(t2))), 422)).error).toBe('board_task_unknown')
  expect(task(await learningState(p), t2)).toMatchObject({ completed: true, archivedAt: expect.any(String) })
  // An unused Skill with an opened board can still be deleted with it.
  await boardOf(p, p.b)
  const current = await document(p)
  doc = current
  await save((d) => {
    d.application.skills = d.application.skills.filter((s: any) => s.id !== p.b)
    d.editor.cards = d.editor.cards.filter((c: any) => c.id !== p.b)
    d.editor.connections = []
  })
  expect((await json(request(`${at(p)}/skills/${p.b}/board`), 404)).error).toBe('skill_not_found')
})

it('AC8: only the owner reaches a board; wrong Path, Skill, column and Task operations are refused and change nothing', async () => {
  const p = await authoredPath()
  const peers = await authoredPath('Peer Path', 'peer')
  const board = await boardOf(p, p.a)
  const peerBoard = await boardOf(peers, peers.a, 'peer')
  const valid = edit(board, (columns) => moveTo(columns, p.tasks[0], 'To Do'))
  for (const actor of ['peer', 'coach', 'unrelated'] as const) {
    expect(await json(request(`${at(p)}/skills/${p.a}/board`, actor), 404)).toEqual({ error: 'learning_path_not_found' })
    expect((await json(saveBoard(p, p.a, board.revision, valid, actor), 404)).error).toBe('learning_path_not_found')
  }
  expect((await saveBoard(p, p.a, board.revision, valid, null)).status).toBe(401)
  // A Skill of another Path (even the owner's own), a Task ID and a malformed ID are no Skill here.
  for (const target of [px.skills.skillA.id, peers.a, p.tasks[0], 'not-a-uuid']) {
    expect((await json(request(`${at(p)}/skills/${target}/board`), 404)).error).toBe('skill_not_found')
  }
  // Another Skill's Task, another board's column, malformed shapes.
  expect((await json(saveBoard(p, p.a, board.revision, edit(board, (columns) => named(columns, 'To Do').taskIds.push(p.taskB))), 422)).error).toBe('board_task_unknown')
  expect((await json(saveBoard(p, p.a, board.revision, edit(board, (columns) => { columns[1].id = peerBoard.columns[1].id })), 422)).error).toBe('column_owned_elsewhere')
  for (const columns of [[], edit(board, (c) => { c[0].name = '  ' }), edit(board, (c) => { c[1].taskIds.push(c[0].taskIds[0]) }), edit(board, (c) => { c[0].completion = true })]) {
    expect((await json(saveBoard(p, p.a, board.revision, columns as Column[]), 422)).error).toBe('invalid_board')
  }
  expect(await boardOf(p, p.a)).toEqual(board)
  expect(await boardOf(peers, peers.a, 'peer')).toEqual(peerBoard)
})

it('AC5/AC9: the database itself refuses membership that contradicts completion or holds an archived Task', async () => {
  const p = await authoredPath()
  const [t1] = p.tasks
  const board = await boardOf(p, p.a)
  const done = named(board.columns, 'Done').id
  const contradict = (write: () => PromiseLike<unknown>) => expect(Promise.resolve().then(write)).rejects.toThrow()
  await contradict(() => db.update(personalBoardCards).set({ columnId: done, position: 99 }).where(eq(personalBoardCards.taskId, t1)))
  await contradict(() => db.update(personalTasks).set({ completedAt: new Date() }).where(eq(personalTasks.taskId, t1)))
  await contradict(() => db.update(personalBoardColumns).set({ completion: false }).where(eq(personalBoardColumns.id, done)))
  await contradict(() => db.execute(sql`update personal_tasks set archived_at = now() where task_id = ${t1}`))
  expect(await boardOf(p, p.a)).toEqual(board)
})

it('AC8: two Paths saving the same new column ID at once never let one change the other\'s board', async () => {
  const first = await authoredPath('Systems Rust')
  const second = await authoredPath('Jazz Guitar')
  for (let round = 0; round < 5; round++) {
    const id = crypto.randomUUID()
    const [a, b] = await Promise.all([
      saveBoard(first, first.a, (await boardOf(first, first.a)).revision, edit(await boardOf(first, first.a), (c) => c.splice(1, 0, { id, name: 'Mine', completion: false, taskIds: [] }))),
      saveBoard(second, second.a, (await boardOf(second, second.a)).revision, edit(await boardOf(second, second.a), (c) => c.splice(1, 0, { id, name: 'Theirs', completion: false, taskIds: [] }))),
    ])
    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual([200, 422])
    const loser = a.status === 422 ? a : b
    expect((await loser.json() as any).error).toBe('column_owned_elsewhere')
    const owners = await db.select().from(personalBoardColumns).where(eq(personalBoardColumns.id, id))
    expect(owners).toHaveLength(1)
    // The winner's column keeps the winner's name; the loser's board did not change.
    const winnerPath = a.status === 200 ? first : second
    expect(owners[0]).toMatchObject({ learningPathId: winnerPath.pathId, name: a.status === 200 ? 'Mine' : 'Theirs' })
    const loserPath = a.status === 200 ? second : first
    expect((await boardOf(loserPath, loserPath.a)).columns.some((c) => c.id === id)).toBe(false)
  }
})
