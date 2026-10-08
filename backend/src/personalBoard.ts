import { and, asc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm'
import type { Database } from './db/client'
import { lockedTimestamp } from './db/clock'
import { personalBoardCards, personalBoardColumns, personalSkills, personalTaskBoards, personalTasks } from './db/schema'
import { hasAccess, lockOwnedPath, readPersonalLearningStateIn, recordCompletion, type PersonalLearningState, type Tx } from './personal'
import { initialPlacement, membershipProblem, PERSONAL_INITIAL_COLUMNS, sameArrangement, type Board, type BoardColumn, type BoardInput } from './taskBoards'

/**
 * A personal Skill's Task Board (ADR 0027). Membership of its Completion Column is
 * the Task's completion: a save that moves a card across that boundary completes or
 * uncompletes the Task in the same transaction, under the existing Access and XP
 * Award/Correction rules, so the column and the learning update persist together or
 * not at all. Mastery is never touched. Every read and save holds the owner's Path
 * lock, like the other personal mutators.
 */

export type BoardRefusal =
  | 'learning_path_not_found' | 'skill_not_found' | 'stale_revision'
  | 'board_task_missing' | 'board_task_unknown' | 'column_owned_elsewhere' | 'skill_locked'

async function findSkill(tx: Tx, learningPathId: string, skillId: string) {
  const [skill] = await tx.select({ skillId: personalSkills.skillId }).from(personalSkills)
    .where(and(eq(personalSkills.learningPathId, learningPathId), eq(personalSkills.skillId, skillId), isNull(personalSkills.archivedAt)))
  return skill ?? null
}

const activeTasksOf = (tx: Tx, learningPathId: string, skillId: string) => tx.select().from(personalTasks)
  .where(and(eq(personalTasks.learningPathId, learningPathId), eq(personalTasks.skillId, skillId), isNull(personalTasks.archivedAt)))
  .orderBy(asc(personalTasks.ordinal), asc(personalTasks.taskId))

async function readBoardIn(tx: Tx, learningPathId: string, skillId: string): Promise<Board | null> {
  const [board] = await tx.select().from(personalTaskBoards).where(and(eq(personalTaskBoards.learningPathId, learningPathId), eq(personalTaskBoards.skillId, skillId)))
  if (!board) return null
  const columns = await tx.select().from(personalBoardColumns)
    .where(and(eq(personalBoardColumns.learningPathId, learningPathId), eq(personalBoardColumns.skillId, skillId))).orderBy(asc(personalBoardColumns.position))
  const cards = await tx.select().from(personalBoardCards)
    .where(and(eq(personalBoardCards.learningPathId, learningPathId), eq(personalBoardCards.skillId, skillId))).orderBy(asc(personalBoardCards.position))
  return {
    skillId, revision: board.revision,
    columns: columns.map((column) => ({ id: column.id, name: column.name, completion: column.completion, taskIds: cards.filter((card) => card.columnId === column.id).map((card) => card.taskId) })),
  }
}

/**
 * Creates the Skill's board on its first opening: Backlog, To Do, In Progress and Done,
 * with Done as the Completion Column. Existing active Tasks are placed once, completed
 * ones in Done and the others in Backlog, in their saved order; archived Tasks stay out.
 * Nothing is replayed, so XP and Mastery do not change. Under the Path lock a second,
 * concurrent opening finds the board already there.
 */
async function ensureBoard(tx: Tx, learningPathId: string, skillId: string): Promise<Board> {
  const existing = await readBoardIn(tx, learningPathId, skillId)
  if (existing) return existing
  await tx.insert(personalTaskBoards).values({ learningPathId, skillId })
  const columns = PERSONAL_INITIAL_COLUMNS.map((column, position) => ({ id: crypto.randomUUID(), learningPathId, skillId, name: column.name, completion: column.completion, position }))
  await tx.insert(personalBoardColumns).values(columns)
  const tasks = await activeTasksOf(tx, learningPathId, skillId)
  const placed = initialPlacement(tasks.map((task) => ({ id: task.taskId, completed: task.completedAt !== null })), { first: columns[0].id, completion: columns.find((column) => column.completion)!.id })
  if (placed.length > 0) {
    await tx.insert(personalBoardCards).values(placed.map((card, index) => ({ learningPathId, skillId, taskId: card.taskId, columnId: card.columnId, position: index })))
  }
  return (await readBoardIn(tx, learningPathId, skillId))!
}

type ReadResult = { ok: true; board: Board } | { ok: false; refusal: 'learning_path_not_found' | 'skill_not_found' }

/** Opens one Skill's board for the Path's owner, creating it on first opening. */
export async function readPersonalBoard(db: Database, learningPathId: string, skillId: string, accountId: string): Promise<ReadResult> {
  return db.transaction(async (tx) => {
    if (!await lockOwnedPath(tx, learningPathId, accountId)) return { ok: false, refusal: 'learning_path_not_found' } as const
    if (!await findSkill(tx, learningPathId, skillId)) return { ok: false, refusal: 'skill_not_found' } as const
    return { ok: true, board: await ensureBoard(tx, learningPathId, skillId) } as const
  })
}

type SaveResult =
  | { ok: true; changed: boolean; board: Board; learningState: PersonalLearningState }
  | { ok: false; refusal: BoardRefusal; detail: string; current?: Board }

class Refused extends Error {
  constructor(readonly refusal: BoardRefusal, readonly detail: string) { super(detail) }
}

/**
 * Saves the owner's whole board if it was based on the current revision. A save based
 * on an older revision changes nothing and answers the current board, unless it asks
 * for exactly the current arrangement: then it is a retry whose answer was lost, and
 * succeeds without changing anything again. The board must hold every active Task of
 * the Skill exactly once, so removing a column always names a destination for its Tasks.
 *
 * Cards that cross the Completion Column's boundary complete or uncomplete their Tasks
 * here, by the same rules as the completion action: completing needs the Skill's
 * current Access (checked once, before any change) and is refused for a locked Skill,
 * refusing the whole save; uncompleting is a correction and always allowed.
 */
export async function savePersonalBoard(db: Database, learningPathId: string, skillId: string, accountId: string, input: BoardInput): Promise<SaveResult> {
  try {
    return await db.transaction(async (tx) => {
      if (!await lockOwnedPath(tx, learningPathId, accountId)) return { ok: false, refusal: 'learning_path_not_found', detail: 'no such Path' } as const
      if (!await findSkill(tx, learningPathId, skillId)) return { ok: false, refusal: 'skill_not_found', detail: 'no such Skill in this Path' } as const
      const current = await ensureBoard(tx, learningPathId, skillId)
      if (sameArrangement(current.columns, input.columns)) {
        return { ok: true, changed: false, board: current, learningState: await readPersonalLearningStateIn(tx, learningPathId) } as const
      }
      if (current.revision !== input.expectedRevision) {
        return { ok: false, refusal: 'stale_revision', detail: `the board change was based on revision ${input.expectedRevision}, but revision ${current.revision} is accepted`, current } as const
      }
      const tasks = await activeTasksOf(tx, learningPathId, skillId)
      const problem = membershipProblem(input.columns, tasks.map((task) => task.taskId))
      if (problem) throw new Refused(problem.refusal, problem.detail)
      await checkColumnIds(tx, learningPathId, skillId, input.columns)

      const completing = input.columns.filter((column) => column.completion).flatMap((column) => column.taskIds)
      const changes = tasks.filter((task) => (task.completedAt !== null) !== completing.includes(task.taskId))
      if (changes.some((task) => task.completedAt === null) && !await hasAccess(tx, learningPathId, skillId)) {
        throw new Refused('skill_locked', 'this Skill is locked, so a Task cannot enter the Completion Column; leaving it is always possible')
      }

      await writeArrangement(tx, learningPathId, skillId, input.columns)
      const now = await lockedTimestamp(tx)
      for (const task of changes) await recordCompletion(tx, task, accountId, now, task.completedAt === null)
      await tx.update(personalTaskBoards).set({ revision: sql`${personalTaskBoards.revision} + 1` })
        .where(and(eq(personalTaskBoards.learningPathId, learningPathId), eq(personalTaskBoards.skillId, skillId)))
      return { ok: true, changed: true, board: (await readBoardIn(tx, learningPathId, skillId))!, learningState: await readPersonalLearningStateIn(tx, learningPathId) } as const
    })
  } catch (error) {
    if (error instanceof Refused) return { ok: false, refusal: error.refusal, detail: error.detail }
    throw error
  }
}

/** A column ID is this board's own or new; one that names another board's column is refused. */
async function checkColumnIds(tx: Tx, learningPathId: string, skillId: string, columns: BoardColumn[]) {
  const ids = columns.map((column) => column.id)
  const [foreign] = await tx.select({ id: personalBoardColumns.id }).from(personalBoardColumns)
    .where(and(inArray(personalBoardColumns.id, ids), sql`(${personalBoardColumns.learningPathId}, ${personalBoardColumns.skillId}) <> (${learningPathId}::uuid, ${skillId}::uuid)`)).limit(1)
  if (foreign) throw new Refused('column_owned_elsewhere', `column ${foreign.id} belongs to another board`)
}

/** Replaces the board's columns and cards with the saved arrangement; removed columns go once their cards moved. */
async function writeArrangement(tx: Tx, learningPathId: string, skillId: string, columns: BoardColumn[]) {
  const board = (table: typeof personalBoardCards | typeof personalBoardColumns) => and(eq(table.learningPathId, learningPathId), eq(table.skillId, skillId))
  await tx.delete(personalBoardCards).where(board(personalBoardCards))
  // Kept columns are rewritten in place (their IDs stay). Positions are offset and roles cleared first, so
  // neither the new order nor a moved Completion Column collides on the way; the triggers check the result at commit.
  await tx.update(personalBoardColumns).set({ position: sql`${personalBoardColumns.position} + 1000`, completion: false }).where(board(personalBoardColumns))
  await tx.delete(personalBoardColumns).where(and(board(personalBoardColumns), notInArray(personalBoardColumns.id, columns.map((column) => column.id))))
  for (const [position, column] of columns.entries()) {
    // A kept column is updated only on this board. A new ID is inserted only if no other board holds it,
    // also one committed by a concurrent save of another Path after checkColumnIds: the whole save is refused.
    const [kept] = await tx.update(personalBoardColumns).set({ name: column.name, completion: column.completion, position })
      .where(and(board(personalBoardColumns), eq(personalBoardColumns.id, column.id))).returning({ id: personalBoardColumns.id })
    if (kept) continue
    const [inserted] = await tx.insert(personalBoardColumns).values({ id: column.id, learningPathId, skillId, name: column.name, completion: column.completion, position })
      .onConflictDoNothing({ target: personalBoardColumns.id }).returning({ id: personalBoardColumns.id })
    if (!inserted) throw new Refused('column_owned_elsewhere', `column ${column.id} belongs to another board`)
  }
  const cards = columns.flatMap((column) => column.taskIds.map((taskId, position) => ({ learningPathId, skillId, taskId, columnId: column.id, position })))
  if (cards.length > 0) await tx.insert(personalBoardCards).values(cards)
}
