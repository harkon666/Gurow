import { afterAll, beforeAll, beforeEach, expect, it } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'
import { createApp } from '../src/app'
import type { Database } from '../src/db/client'
import {
  enrollmentBoardCards, enrollmentBoardColumns, enrollmentInvitations, enrollmentLifecycleRecords, enrollments, enrollmentTaskBoards, masteryEvents,
  submissionDrafts, submissionReviews, submissionRevisions, submissions, taskStarts, versionPrerequisites, versionSkills, versionTasks, xpEvents,
} from '../src/db/schema'
import { FIXTURE_IDENTITY_HEADER, fixtureIdentity } from '../src/identity'
import { prepareTestDatabase, resetTestDatabase } from './support/database'
import { amendPublished, seedEnrollmentFixture, type EnrollmentFixture } from './support/fixtures'

/**
 * UX05 (#51): a Learner's own Task Board for one Skill of their Enrollment, through the
 * request boundary on PostgreSQL (ADR 0027, 0030). Columns express working organization
 * only: a board save writes nothing but the board, never a Submission, Review, XP, Mastery
 * or Task start, and Review changes never move cards. Stored records are read back
 * independently of every board answer.
 *
 * Fixture Version 1: Vectors (A) with a 20-XP Required Task and a 5-XP Enrichment reading
 * (saved before it); Matrices (B), with one Required Task, requires Mastery of A.
 */
let db: Database, close: () => Promise<void>, fx: EnrollmentFixture, app: ReturnType<typeof createApp>, enrollmentId: string, peerEnrollmentId: string
let vectors: string, matrices: string, exercises: string, reading: string, matrixTask: string
beforeAll(async () => { ({ db, close } = await prepareTestDatabase()) })
afterAll(async () => { await close() })
beforeEach(async () => {
  await resetTestDatabase(db)
  fx = await seedEnrollmentFixture(db)
  app = createApp({ db, identity: fixtureIdentity(fx.identities) })
  ;({ skillA: { id: vectors }, skillB: { id: matrices }, taskA: { id: exercises }, taskAReading: { id: reading }, taskB: { id: matrixTask } } = fx.content)
  const v1 = fx.versions.version1.id
  await amendPublished(db, async (tx) => {
    await tx.update(versionTasks).set({ xpReward: 20, ordinal: 1 }).where(and(eq(versionTasks.learningPathVersionId, v1), eq(versionTasks.taskId, exercises)))
    await tx.update(versionTasks).set({ xpReward: 5, ordinal: 0 }).where(and(eq(versionTasks.learningPathVersionId, v1), eq(versionTasks.taskId, reading)))
    await tx.insert(versionPrerequisites).values({ learningPathVersionId: v1, prerequisiteSkillId: vectors, skillId: matrices })
  })
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

interface Column { id: string; name: string; completion: boolean; taskIds: string[] }
interface Board { skillId: string; revision: number; columns: Column[] }

const boardRoute = (skillId: string, id = enrollmentId) => `/enrollments/${id}/skills/${skillId}/board`
const boardOf = async (skillId: string, actor: Actor = 'learner', id = enrollmentId) => (await json(request(boardRoute(skillId, id), actor), 200)).board as Board
const saveBoard = (skillId: string, expectedRevision: number, columns: unknown, actor: Actor = 'learner', id = enrollmentId) =>
  request(boardRoute(skillId, id), actor, 'PUT', { expectedRevision, columns })
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
const move = async (skillId: string, taskId: string, to: string, id = enrollmentId) => {
  const board = await boardOf(skillId, 'learner', id)
  return (await json(saveBoard(skillId, board.revision, edit(board, (c) => moveTo(c, taskId, to)), 'learner', id), 200)).board as Board
}

const taskPath = (task: string, id = enrollmentId) => `/enrollments/${id}/tasks/${task}`
async function send(task = exercises, text = 'My evidence', id = enrollmentId) {
  return (await json(request(`${taskPath(task, id)}/submission/revisions`, 'learner', 'POST', { text, urls: [] }), 201)).revision as { id: string; revisionNumber: number }
}
const decide = async (revision: string, decision: 'approval' | 'changes_requested', task = exercises) =>
  json(request(`${taskPath(task)}/submission/revisions/${revision}/review`, 'coach', 'POST', decision === 'approval' ? { decision } : { decision, feedback: 'Show the working' }), 201)
const revoke = async (revision: string, task = exercises) => json(request(`${taskPath(task)}/submission/revisions/${revision}/review/revoke`, 'coach', 'POST', { reason: 'Copied answer' }), 200)
const state = async (actor: Actor = 'learner', id = enrollmentId) => (await json(request(`/enrollments/${id}/learning-state`, actor), 200)).learningState
const reviewOf = async (task = exercises) => (await state()).taskReviews.find((r: any) => r.taskId === task) ?? null

/** Every learning and evidence row of the fixture's Enrollments, read directly: what no board operation may change. */
async function storedLearning() {
  const rows = async (table: any) => (await db.select().from(table)).map((row: any) => JSON.stringify(row)).sort()
  return {
    enrollments: await rows(enrollments), lifecycle: await rows(enrollmentLifecycleRecords), starts: await rows(taskStarts),
    drafts: await rows(submissionDrafts), submissions: await rows(submissions), revisions: await rows(submissionRevisions),
    reviews: await rows(submissionReviews), xp: await rows(xpEvents), mastery: await rows(masteryEvents),
    skills: await rows(versionSkills), tasks: await rows(versionTasks), prerequisites: await rows(versionPrerequisites),
  }
}
/** The stored rows of the boards of one Enrollment. */
async function storedBoardRows(id = enrollmentId) {
  return {
    boards: await db.select().from(enrollmentTaskBoards).where(eq(enrollmentTaskBoards.enrollmentId, id)),
    columns: await db.select().from(enrollmentBoardColumns).where(eq(enrollmentBoardColumns.enrollmentId, id)),
    cards: await db.select().from(enrollmentBoardCards).where(eq(enrollmentBoardCards.enrollmentId, id)),
  }
}

it('AC1/AC8: opening a Skill\'s board creates Backlog, To Do, In Progress and Done once, with only that Skill\'s Tasks of the Version in saved order', async () => {
  const before = await storedLearning()
  const learningBefore = await state()
  const board = await boardOf(vectors)
  expect(board.columns.map((c) => [c.name, c.completion])).toEqual([['Backlog', false], ['To Do', false], ['In Progress', false], ['Done', false]])
  // The reading is saved before the exercises in the Coach's order.
  expect(arrangement(board)).toEqual([`Backlog:${reading},${exercises}`, 'To Do:', 'In Progress:', 'Done:'])
  expect(board.revision).toBe(0)
  expect(arrangement(await boardOf(matrices))).toEqual([`Backlog:${matrixTask}`, 'To Do:', 'In Progress:', 'Done:'])
  // Opening records nothing else: no Task start, Submission, Review, XP or Mastery; the learning state is identical.
  expect(await storedLearning()).toEqual(before)
  expect(await state()).toEqual(learningBefore)

  // Six concurrent openings of a new Skill's board give one board with one card per Task.
  const [vectorsAgain] = await Promise.all([boardOf(vectors), ...Array.from({ length: 5 }, () => boardOf(vectors))])
  expect(vectorsAgain).toEqual(board)
  await db.transaction(async (tx) => {
    await tx.delete(enrollmentBoardCards).where(eq(enrollmentBoardCards.skillId, matrices))
    await tx.delete(enrollmentBoardColumns).where(eq(enrollmentBoardColumns.skillId, matrices))
    await tx.delete(enrollmentTaskBoards).where(eq(enrollmentTaskBoards.skillId, matrices))
  })
  const opened = await Promise.all(Array.from({ length: 6 }, () => boardOf(matrices)))
  expect(new Set(opened.map((b) => JSON.stringify(b))).size).toBe(1)
  const rows = await storedBoardRows()
  expect(rows.boards).toHaveLength(2)
  expect(rows.columns.filter((c) => c.skillId === matrices)).toHaveLength(4)
  expect(rows.cards.filter((c) => c.skillId === matrices).map((c) => c.taskId)).toEqual([matrixTask])

  // Customization survives reopening; the peer's board for the same Skill is their own.
  const customized = (await json(saveBoard(vectors, 0, edit(board, (c) => { named(c, 'To Do').name = 'Next'; moveTo(c, exercises, 'Next') })), 200)).board as Board
  expect(await boardOf(vectors)).toEqual(customized)
  const peers = await boardOf(vectors, 'peer', peerEnrollmentId)
  expect(arrangement(peers)).toEqual([`Backlog:${reading},${exercises}`, 'To Do:', 'In Progress:', 'Done:'])
  expect(peers.columns.map((c) => c.id).some((id) => customized.columns.some((mine) => mine.id === id))).toBe(false)
})

it('AC8: first placement puts Tasks with a valid Approval in Done and keeps their newest revision\'s status, without replaying anything', async () => {
  // The exercises were approved, then a newer revision is pending; the reading had its only Approval revoked.
  const first = await send()
  await decide(first.id, 'approval')
  const newer = await send(exercises, 'Better evidence')
  const read = await send(reading, 'Read it')
  await decide(read.id, 'approval', reading)
  await revoke(read.id, reading)
  const before = await storedLearning()
  const learningBefore = await state()
  const board = await boardOf(vectors)
  expect(arrangement(board)).toEqual([`Backlog:${reading}`, 'To Do:', 'In Progress:', `Done:${exercises}`])
  expect(await storedLearning()).toEqual(before)
  expect(await state()).toEqual(learningBefore)
  // The newest revision stays pending and does not inherit the Approval, which still counts.
  expect(await reviewOf()).toEqual({ taskId: exercises, sentRevisions: 2, latestRevisionNumber: newer.revisionNumber, latestStatus: 'pending', approvedRevisionNumbers: [1] })
  expect(await reviewOf(reading)).toEqual({ taskId: reading, sentRevisions: 1, latestRevisionNumber: 1, latestStatus: 'approval_revoked', approvedRevisionNumbers: [] })
  expect((await state()).tasks.find((t: any) => t.taskId === exercises)).toMatchObject({ approved: true, xpContribution: 20 })
})

it('AC2/AC9: columns are added, renamed, reordered and removed with a destination, persist, and touch no other board', async () => {
  const peerBefore = await boardOf(vectors, 'peer', peerEnrollmentId)
  const matricesBefore = await boardOf(matrices)
  const board = await boardOf(vectors)
  const added = crypto.randomUUID()
  let saved = (await json(saveBoard(vectors, board.revision, edit(board, (c) => {
    c.splice(2, 0, { id: added, name: 'Blocked', completion: false, taskIds: [] })
    named(c, 'Done').name = 'Finished'
    c.push(c.splice(0, 1)[0])
    moveTo(c, exercises, 'Blocked')
  })), 200)).board as Board
  expect(saved.revision).toBe(1)
  expect(arrangement(saved)).toEqual(['To Do:', `Blocked:${exercises}`, 'In Progress:', 'Finished:', `Backlog:${reading}`])
  expect(await boardOf(vectors)).toEqual(saved)

  // Removing a populated column needs a destination: dropping its Tasks is refused and changes nothing.
  const rowsBefore = await storedBoardRows()
  const dropped = await json(saveBoard(vectors, saved.revision, edit(saved, (c) => { c.splice(c.findIndex((x) => x.name === 'Blocked'), 1) })), 422)
  expect(dropped.error).toBe('board_task_missing')
  expect(await storedBoardRows()).toEqual(rowsBefore)
  saved = (await json(saveBoard(vectors, saved.revision, edit(saved, (c) => {
    const blocked = c.findIndex((x) => x.name === 'Blocked')
    named(c, 'Backlog').taskIds.push(...c[blocked].taskIds)
    c.splice(blocked, 1)
  })), 200)).board
  expect(arrangement(saved)).toEqual(['To Do:', 'In Progress:', 'Finished:', `Backlog:${reading},${exercises}`])
  // Down to one usable column: everything in it, never fewer.
  saved = (await json(saveBoard(vectors, saved.revision, [{ ...saved.columns[3] }]), 200)).board
  expect(arrangement(saved)).toEqual([`Backlog:${reading},${exercises}`])
  for (const columns of [[], [{ ...saved.columns[0], completion: true }], [{ id: 'x', name: 'Bad', completion: false, taskIds: [] }], [{ ...saved.columns[0], name: ' ' }]]) {
    expect((await json(saveBoard(vectors, saved.revision, columns), 422)).error).toBe('invalid_board')
  }
  // A direct deletion of the last column is refused by the database at commit.
  const lastColumn = (await storedBoardRows()).columns.find((c) => c.skillId === vectors)!
  await expect(db.transaction(async (tx) => {
    await tx.delete(enrollmentBoardCards).where(eq(enrollmentBoardCards.columnId, lastColumn.id))
    await tx.delete(enrollmentBoardColumns).where(eq(enrollmentBoardColumns.id, lastColumn.id))
  })).rejects.toThrow()
  expect(await boardOf(vectors)).toEqual(saved)
  // The other Skill's board, the peer's board and every learning record are untouched.
  expect(await boardOf(matrices)).toEqual(matricesBefore)
  expect(await boardOf(vectors, 'peer', peerEnrollmentId)).toEqual(peerBefore)
})

it('AC3/AC6: moving cards into and out of Done is organizational only, and Reviews never move cards', async () => {
  const board = await boardOf(vectors)
  const before = await storedLearning()
  const learningBefore = await state()
  let moved = await move(vectors, exercises, 'Done')
  moved = await move(vectors, reading, 'Done')
  expect(arrangement(moved)).toEqual(['Backlog:', 'To Do:', 'In Progress:', `Done:${exercises},${reading}`])
  // No Submission, Task start, Approval, XP or Mastery: the learning state is exactly as before.
  expect(await storedLearning()).toEqual(before)
  expect(await state()).toEqual(learningBefore)
  expect(await reviewOf()).toBeNull()
  moved = await move(vectors, reading, 'Backlog')
  expect(await storedLearning()).toEqual(before)

  // Explicit send → Changes Requested → corrected send → Approval → newer pending → Approval Revocation.
  const settled = await boardOf(vectors)
  const unchanged = async () => expect(await boardOf(vectors)).toEqual(settled)
  const first = await send()
  await unchanged()
  expect(await reviewOf()).toMatchObject({ latestStatus: 'pending', approvedRevisionNumbers: [] })
  await decide(first.id, 'changes_requested')
  // A Changes Requested card stays in Done, and the review state says so.
  await unchanged()
  expect(named(settled.columns, 'Done').taskIds).toContain(exercises)
  expect(await reviewOf()).toMatchObject({ latestRevisionNumber: 1, latestStatus: 'changes_requested', approvedRevisionNumbers: [] })
  const corrected = await send(exercises, 'Corrected')
  await decide(corrected.id, 'approval')
  await unchanged()
  expect(await reviewOf()).toMatchObject({ latestRevisionNumber: 2, latestStatus: 'approval', approvedRevisionNumbers: [2] })
  expect((await state()).xp).toBe(20)
  const newer = await send(exercises, 'Even better')
  await unchanged()
  expect(await reviewOf()).toMatchObject({ latestRevisionNumber: newer.revisionNumber, latestStatus: 'pending', approvedRevisionNumbers: [2] })
  expect((await state()).xp).toBe(20)
  await revoke(corrected.id)
  await unchanged()
  expect(await reviewOf()).toMatchObject({ latestRevisionNumber: 3, latestStatus: 'pending', approvedRevisionNumbers: [] })
  expect((await state()).xp).toBe(0)
  // Moving the card out of Done afterwards changes no evidence either.
  const evidence = await storedLearning()
  await move(vectors, exercises, 'Backlog')
  expect(await storedLearning()).toEqual(evidence)
  expect(board.revision).toBe(0)
})

it('AC3/AC9: placement does not confer Access or bypass an inactive Enrollment, and keeps locked and older evidence intact', async () => {
  // Matrices is locked behind Vectors' Mastery: its card can go to Done, but nothing can be sent.
  expect((await state()).skills.find((s: any) => s.skillId === matrices).access).toBe(false)
  await move(matrices, matrixTask, 'Done')
  expect((await state()).skills.find((s: any) => s.skillId === matrices).access).toBe(false)
  expect((await json(request(`${taskPath(matrixTask)}/submission/revisions`, 'learner', 'POST', { text: 'x', urls: [] }), 403)).error).toBe('skill_locked')
  expect((await json(request(`${taskPath(matrixTask)}/start`, 'learner', 'POST'), 403)).error).toBe('skill_locked')

  // An approved Task keeps its evidence after the learner stops participating; the board stays theirs to arrange.
  const approved = await send()
  await decide(approved.id, 'approval')
  await json(request(`/enrollments/${enrollmentId}/deactivate`, 'learner', 'POST', {}), 200)
  const before = await storedLearning()
  const board = await move(vectors, exercises, 'Backlog')
  expect(named(board.columns, 'Backlog').taskIds).toContain(exercises)
  await move(vectors, reading, 'Done')
  expect(await storedLearning()).toEqual(before)
  expect((await state()).enrollmentStatus).toBe('inactive')
  expect((await state()).tasks.find((t: any) => t.taskId === exercises)).toMatchObject({ approved: true, xpContribution: 20 })
  expect((await json(request(`${taskPath(reading)}/submission/revisions`, 'learner', 'POST', { text: 'x', urls: [] }), 403)).error).toBe('enrollment_inactive')
  expect((await json(request(`${taskPath(reading)}/start`, 'learner', 'POST'), 403)).error).toBe('enrollment_inactive')
})

it('AC4/AC7: only the learner reaches the board; it never carries Task definitions or private Submission Draft contents', async () => {
  await json(request(`${taskPath(exercises)}/draft`, 'learner', 'PUT', { text: 'PRIVATE draft words', urls: ['https://example.com/private'] }), 200)
  const board = await boardOf(vectors)
  const before = await storedLearning()
  const rowsBefore = await storedBoardRows()
  const answer = JSON.stringify(await json(request(boardRoute(vectors)), 200))
  expect(answer).not.toContain('PRIVATE')
  expect(answer).not.toContain('example.com')
  // The Coach is told the board is the learner's; everyone else that the Enrollment does not exist.
  const cases: [Actor, number, string | null][] = [['coach', 403, 'learner_only'], ['peer', 404, 'enrollment_not_found'], ['unrelated', 404, 'enrollment_not_found'],
    ['otherCoach', 404, 'enrollment_not_found'], ['unverified', 404, 'enrollment_not_found'], [null, 401, 'unauthenticated']]
  for (const [actor, status, error] of cases) {
    for (const response of [request(boardRoute(vectors), actor), saveBoard(vectors, board.revision, board.columns, actor), request(boardRoute(vectors), actor, 'PUT', { nonsense: true })]) {
      const r = await response
      expect({ actor, status: r.status, error: (await r.json()).error }).toEqual({ actor, status, error })
    }
  }
  // The Coach cannot learn the learner's columns even with a valid board of their own making.
  expect(await storedBoardRows()).toEqual(rowsBefore)

  // A private Task, a Task of another Skill, or a dropped official Task are refused; definitions are never written.
  const privateTask = crypto.randomUUID()
  for (const [columns, error] of [
    [edit(board, (c) => c[0].taskIds.push(privateTask)), 'board_task_unknown'],
    [edit(board, (c) => c[1].taskIds.push(matrixTask)), 'board_task_unknown'],
    [edit(board, (c) => { c[0].taskIds = c[0].taskIds.filter((id) => id !== exercises) }), 'board_task_missing'],
  ] as const) expect((await json(saveBoard(vectors, board.revision, columns), 422)).error).toBe(error)
  // Extra fields that look like Task definitions or rewards change nothing but the arrangement.
  const sneaky = edit(board, (c) => moveTo(c, exercises, 'To Do')).map((c) => ({ ...c, title: 'Hacked', xpReward: 999, required: false, tasks: [{ id: exercises, title: 'Hacked' }] }))
  await json(saveBoard(vectors, board.revision, sneaky), 200)
  expect(await storedLearning()).toEqual(before)
  // Published Task definitions are unchanged, and no learner route edits them.
  const [definition] = await db.select().from(versionTasks).where(and(eq(versionTasks.learningPathVersionId, fx.versions.version1.id), eq(versionTasks.taskId, exercises)))
  expect(definition).toMatchObject({ title: 'Vector exercises', xpReward: 20, required: true })
  for (const path of [`/coach/learning-paths/${fx.paths.path.id}/draft`, `/coach/learning-path-versions/${fx.versions.version1.id}/layout`]) {
    expect((await request(path, 'learner', 'PUT', {})).status).toBe(404)
  }
  // The board survives as arranged; the Coach still reads the sent work but never the draft.
  expect((await json(request(`${taskPath(exercises)}/draft`, 'coach'), 403)).error).toBe('draft_private')
})

it('AC9: separate Enrollments with identical logical Skill and Task IDs keep separate boards; wrong references and stale saves are refused without cross-context changes', async () => {
  // The learner also joins Version 2, which redefines the same logical Skills and Tasks.
  const [invitation] = await db.insert(enrollmentInvitations).values({ learningPathVersionId: fx.versions.version2.id, email: 'learner@gurow.test', invitedByAccountId: fx.accounts.coach.id }).returning()
  const v2Enrollment = (await json(request(`/invitations/${invitation.id}/accept`, 'learner', 'POST'), 201)).enrollment.id
  const v1Board = await boardOf(vectors)
  const v2Board = await boardOf(vectors, 'learner', v2Enrollment)
  expect(v2Board.columns.flatMap((c) => c.taskIds).sort()).toEqual([exercises, reading].sort())
  expect(v2Board.columns.some((c) => v1Board.columns.some((o) => o.id === c.id))).toBe(false)
  const moved = await move(vectors, exercises, 'Done', v2Enrollment)
  expect(await boardOf(vectors)).toEqual(v1Board)
  // A column of the Version 1 board cannot be claimed by the Version 2 board, nor by the peer.
  const stolen = edit(moved, (c) => { c.push({ ...v1Board.columns[1], taskIds: [] }) })
  expect((await json(saveBoard(vectors, moved.revision, stolen, 'learner', v2Enrollment), 422)).error).toBe('column_owned_elsewhere')
  const peerBoard = await boardOf(vectors, 'peer', peerEnrollmentId)
  expect((await json(saveBoard(vectors, peerBoard.revision, edit(peerBoard, (c) => { c.push({ ...v1Board.columns[2], taskIds: [] }) }), 'peer', peerEnrollmentId), 422)).error).toBe('column_owned_elsewhere')
  // A column of another Skill's board in the same Enrollment is refused too.
  const matricesBoard = await boardOf(matrices)
  expect((await json(saveBoard(vectors, v1Board.revision, edit(v1Board, (c) => { c.push({ ...matricesBoard.columns[0], taskIds: [] }) })), 422)).error).toBe('column_owned_elsewhere')
  expect(await boardOf(vectors)).toEqual(v1Board)
  expect(await boardOf(matrices)).toEqual(matricesBoard)

  // Wrong references: another Path's Skill, a Task ID as a Skill, malformed IDs, another learner's Enrollment.
  const [siblingSkill] = await db.execute<{ id: string }>(sql`insert into skills (learning_path_id) values (${fx.paths.siblingPath.id}) returning id`)
  for (const skillId of [siblingSkill.id, exercises, 'not-a-uuid', crypto.randomUUID()]) {
    expect((await json(request(boardRoute(skillId)), 404)).error).toBe('skill_not_found')
    expect((await json(saveBoard(skillId, 0, v1Board.columns), 404)).error).toBe('skill_not_found')
  }
  for (const id of ['not-a-uuid', crypto.randomUUID(), peerEnrollmentId]) {
    expect((await json(request(boardRoute(vectors, id)), 404)).error).toBe('enrollment_not_found')
  }

  // Stale: a save on an older revision answers the current board and changes nothing; a lost answer's retry changes nothing again.
  const first = await json(saveBoard(vectors, v1Board.revision, edit(v1Board, (c) => moveTo(c, reading, 'In Progress'))), 200)
  expect(first.changed).toBe(true)
  const retry = await json(saveBoard(vectors, v1Board.revision, edit(v1Board, (c) => moveTo(c, reading, 'In Progress'))), 200)
  expect(retry).toEqual({ changed: false, board: first.board })
  const stale = await json(saveBoard(vectors, v1Board.revision, edit(v1Board, (c) => moveTo(c, exercises, 'To Do'))), 409)
  expect(stale).toMatchObject({ error: 'stale_revision', current: first.board })
  expect(await boardOf(vectors)).toEqual(first.board)
  expect(await boardOf(vectors, 'learner', v2Enrollment)).toEqual(moved)
})
