import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm'
import { deriveLearningState } from './access'
import type { Database } from './db/client'
import { coachWorkspaces, enrollmentBoardCards, enrollmentBoardColumns, enrollments, enrollmentTaskBoards, learningPaths, learningPathVersions, versionSkills, versionTasks } from './db/schema'
import type { Tx } from './personal'
import { initialPlacement, LEARNER_INITIAL_COLUMNS, membershipProblem, sameArrangement, type Board, type BoardColumn, type BoardInput } from './taskBoards'

/**
 * A Learner's own Task Board for one Skill of their Enrollment (ADR 0027, 0030). Its
 * columns express the learner's working organization only: no column has a role, Done
 * included, and a save writes nothing but the board. It never sends, approves, awards,
 * corrects or revokes anything, never starts a Task, and never reads or exposes a
 * Submission Draft. Only the Enrollment's learner reaches it; the owning Coach is told
 * it is the learner's, and anyone else that the Enrollment does not exist (ADR 0013).
 * Every read and save holds the Enrollment lock, like the Enrollment's evidence mutators,
 * so a first opening places Tasks on one consistent reading of their Approvals.
 */

export type EnrollmentBoardRefusal =
  | 'enrollment_not_found' | 'learner_only' | 'skill_not_found' | 'stale_revision'
  | 'board_task_missing' | 'board_task_unknown' | 'column_owned_elsewhere'

type Located =
  | { ok: true; versionId: string; ownerId: string; active: boolean }
  | { ok: false; refusal: 'enrollment_not_found' | 'learner_only' | 'skill_not_found'; detail: string }

/** Locks the Enrollment of the acting learner and checks that `skillId` is a Skill of its own Version. */
async function locate(tx: Tx, enrollmentId: string, skillId: string, accountId: string): Promise<Located> {
  const [row] = await tx.select({ enrollment: enrollments, ownerId: coachWorkspaces.ownerAccountId }).from(enrollments)
    .innerJoin(learningPathVersions, eq(learningPathVersions.id, enrollments.learningPathVersionId))
    .innerJoin(learningPaths, eq(learningPaths.id, learningPathVersions.learningPathId))
    .innerJoin(coachWorkspaces, eq(coachWorkspaces.id, learningPaths.coachWorkspaceId))
    .where(eq(enrollments.id, enrollmentId))
  if (row?.ownerId === accountId) return { ok: false, refusal: 'learner_only', detail: 'a learner\'s board belongs to the learner; Review works from Submissions' }
  if (!row || row.enrollment.accountId !== accountId) return { ok: false, refusal: 'enrollment_not_found', detail: 'no such Enrollment' }
  const [enrollment] = await tx.select().from(enrollments).where(eq(enrollments.id, enrollmentId)).for('update')
  const [skill] = await tx.select({ id: versionSkills.skillId }).from(versionSkills)
    .where(and(eq(versionSkills.learningPathVersionId, enrollment.learningPathVersionId), eq(versionSkills.skillId, skillId)))
  if (!skill) return { ok: false, refusal: 'skill_not_found', detail: 'no such Skill in this Enrollment\'s Version' }
  return { ok: true, versionId: enrollment.learningPathVersionId, ownerId: row.ownerId, active: enrollment.status === 'active' }
}

/** The Skill's official Tasks in the Enrollment's Version, in the Coach's saved order; a published Version never changes them. */
const tasksOf = (tx: Tx, versionId: string, skillId: string) => tx.select({ taskId: versionTasks.taskId }).from(versionTasks)
  .where(and(eq(versionTasks.learningPathVersionId, versionId), eq(versionTasks.skillId, skillId)))
  .orderBy(asc(versionTasks.ordinal), asc(versionTasks.taskId))

async function readBoardIn(tx: Tx, enrollmentId: string, skillId: string): Promise<Board | null> {
  const [board] = await tx.select().from(enrollmentTaskBoards).where(and(eq(enrollmentTaskBoards.enrollmentId, enrollmentId), eq(enrollmentTaskBoards.skillId, skillId)))
  if (!board) return null
  const columns = await tx.select().from(enrollmentBoardColumns)
    .where(and(eq(enrollmentBoardColumns.enrollmentId, enrollmentId), eq(enrollmentBoardColumns.skillId, skillId))).orderBy(asc(enrollmentBoardColumns.position))
  const cards = await tx.select().from(enrollmentBoardCards)
    .where(and(eq(enrollmentBoardCards.enrollmentId, enrollmentId), eq(enrollmentBoardCards.skillId, skillId))).orderBy(asc(enrollmentBoardCards.position))
  return {
    skillId, revision: board.revision,
    columns: columns.map((column) => ({ id: column.id, name: column.name, completion: false, taskIds: cards.filter((card) => card.columnId === column.id).map((card) => card.taskId) })),
  }
}

/**
 * Creates the Skill's board on its first opening: Backlog, To Do, In Progress and Done.
 * Tasks with at least one valid Approval start in Done, the others in Backlog, in the
 * Coach's saved order. The Approvals are only read: no Review, XP, Mastery or Task start
 * is replayed or recorded. Under the Enrollment lock a second, concurrent opening finds
 * the board already there.
 */
async function ensureBoard(tx: Tx, enrollmentId: string, skillId: string, located: Extract<Located, { ok: true }>): Promise<Board> {
  const existing = await readBoardIn(tx, enrollmentId, skillId)
  if (existing) return existing
  const { versionId } = located
  await tx.insert(enrollmentTaskBoards).values({ enrollmentId, learningPathVersionId: versionId, skillId })
  const columns = LEARNER_INITIAL_COLUMNS.map((column, position) => ({ id: crypto.randomUUID(), enrollmentId, skillId, name: column.name, position, approved: column.approved }))
  await tx.insert(enrollmentBoardColumns).values(columns.map(({ approved: _, ...column }) => column))
  const state = await deriveLearningState(tx, enrollmentId, versionId, located.ownerId, located.active)
  const approved = new Set(state.tasks.filter((task) => task.approved).map((task) => task.taskId))
  const tasks = (await tasksOf(tx, versionId, skillId)).map((task) => ({ id: task.taskId, completed: approved.has(task.taskId) }))
  const placed = initialPlacement(tasks, { first: columns[0].id, completion: columns.find((column) => column.approved)!.id })
  const positions = new Map<string, number>()
  if (placed.length > 0) {
    await tx.insert(enrollmentBoardCards).values(placed.map((card) => {
      const position = positions.get(card.columnId) ?? 0
      positions.set(card.columnId, position + 1)
      return { enrollmentId, learningPathVersionId: versionId, skillId, taskId: card.taskId, columnId: card.columnId, position }
    }))
  }
  return (await readBoardIn(tx, enrollmentId, skillId))!
}

type ReadResult = { ok: true; board: Board } | Extract<Located, { ok: false }>

/** Opens one Skill's board for the Enrollment's learner, creating it on first opening, also while the Enrollment is inactive. */
export async function readEnrollmentBoard(db: Database, enrollmentId: string, skillId: string, accountId: string): Promise<ReadResult> {
  return db.transaction(async (tx) => {
    const located = await locate(tx, enrollmentId, skillId, accountId)
    if (!located.ok) return located
    return { ok: true, board: await ensureBoard(tx, enrollmentId, skillId, located) } as const
  })
}

type SaveResult = { ok: true; changed: boolean; board: Board } | { ok: false; refusal: EnrollmentBoardRefusal; detail: string; current?: Board }

class Refused extends Error {
  constructor(readonly refusal: EnrollmentBoardRefusal, readonly detail: string) { super(detail) }
}

/**
 * Saves the learner's whole board if it was based on the current revision. A save based
 * on an older revision changes nothing and answers the current board, unless it asks for
 * exactly the current arrangement (a retry whose answer was lost). The board must hold
 * every official Task of the Skill in the Enrollment's Version exactly once and nothing
 * else, so no private Task can be added and no official one dropped. Nothing but the
 * board is written, whatever column a Task enters or leaves, and whatever the Skill's
 * Access or the Enrollment's status: placement is not Access, a Submission or evidence.
 */
export async function saveEnrollmentBoard(db: Database, enrollmentId: string, skillId: string, accountId: string, input: BoardInput): Promise<SaveResult> {
  try {
    return await db.transaction(async (tx) => {
      const located = await locate(tx, enrollmentId, skillId, accountId)
      if (!located.ok) return located
      const current = await ensureBoard(tx, enrollmentId, skillId, located)
      if (sameArrangement(current.columns, input.columns)) return { ok: true, changed: false, board: current } as const
      if (current.revision !== input.expectedRevision) {
        return { ok: false, refusal: 'stale_revision', detail: `the board change was based on revision ${input.expectedRevision}, but revision ${current.revision} is accepted`, current } as const
      }
      const problem = membershipProblem(input.columns, (await tasksOf(tx, located.versionId, skillId)).map((task) => task.taskId))
      if (problem) throw new Refused(problem.refusal, problem.detail)
      await writeArrangement(tx, enrollmentId, located.versionId, skillId, input.columns)
      await tx.update(enrollmentTaskBoards).set({ revision: sql`${enrollmentTaskBoards.revision} + 1` })
        .where(and(eq(enrollmentTaskBoards.enrollmentId, enrollmentId), eq(enrollmentTaskBoards.skillId, skillId)))
      return { ok: true, changed: true, board: (await readBoardIn(tx, enrollmentId, skillId))! } as const
    })
  } catch (error) {
    if (error instanceof Refused) return { ok: false, refusal: error.refusal, detail: error.detail }
    throw error
  }
}

/**
 * Replaces the board's columns and cards with the saved arrangement. Kept columns are
 * rewritten in place; a new column ID is inserted only if no other board holds it, so a
 * column of another Skill, Enrollment or learner can never be taken over: the whole save is refused.
 */
async function writeArrangement(tx: Tx, enrollmentId: string, versionId: string, skillId: string, columns: BoardColumn[]) {
  const board = (table: typeof enrollmentBoardCards | typeof enrollmentBoardColumns) => and(eq(table.enrollmentId, enrollmentId), eq(table.skillId, skillId))
  await tx.delete(enrollmentBoardCards).where(board(enrollmentBoardCards))
  await tx.update(enrollmentBoardColumns).set({ position: sql`${enrollmentBoardColumns.position} + 1000` }).where(board(enrollmentBoardColumns))
  await tx.delete(enrollmentBoardColumns).where(and(board(enrollmentBoardColumns), notInArray(enrollmentBoardColumns.id, columns.map((column) => column.id))))
  const [foreign] = await tx.select({ id: enrollmentBoardColumns.id }).from(enrollmentBoardColumns)
    .where(and(inArray(enrollmentBoardColumns.id, columns.map((column) => column.id)), sql`(${enrollmentBoardColumns.enrollmentId}, ${enrollmentBoardColumns.skillId}) <> (${enrollmentId}::uuid, ${skillId}::uuid)`)).limit(1)
  if (foreign) throw new Refused('column_owned_elsewhere', `column ${foreign.id} belongs to another board`)
  for (const [position, column] of columns.entries()) {
    const [kept] = await tx.update(enrollmentBoardColumns).set({ name: column.name, position })
      .where(and(board(enrollmentBoardColumns), eq(enrollmentBoardColumns.id, column.id))).returning({ id: enrollmentBoardColumns.id })
    if (kept) continue
    const [inserted] = await tx.insert(enrollmentBoardColumns).values({ id: column.id, enrollmentId, skillId, name: column.name, position })
      .onConflictDoNothing({ target: enrollmentBoardColumns.id }).returning({ id: enrollmentBoardColumns.id })
    if (!inserted) throw new Refused('column_owned_elsewhere', `column ${column.id} belongs to another board`)
  }
  const cards = columns.flatMap((column) => column.taskIds.map((taskId, position) => ({ enrollmentId, learningPathVersionId: versionId, skillId, taskId, columnId: column.id, position })))
  if (cards.length > 0) await tx.insert(enrollmentBoardCards).values(cards)
}
