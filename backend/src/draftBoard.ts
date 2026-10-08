import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm'
import { lockOwnedCoachPath, openDraft } from './coaching'
import type { Database } from './db/client'
import { draftBoardCards, draftBoardColumns, draftTaskBoards, learningPathVersions, versionSkills, versionTasks } from './db/schema'
import type { Tx } from './personal'
import { DRAFT_INITIAL_COLUMNS, initialPlacement, membershipProblem, sameArrangement, type Board, type BoardColumn, type BoardInput } from './taskBoards'

/**
 * A Coach's preparation board for one Skill of the open Learning Path Draft (ADR 0027,
 * 0029). Its columns express material readiness only: no column has a role, and a save
 * changes nothing but the arrangement. It never writes the Draft's content, any
 * published Version, or any learner's records. Every read and save holds the Path lock,
 * like the Draft's other mutators, and names the Draft it was made for: a board of a
 * Draft that was published since is no longer editable.
 */

export type DraftBoardRefusal =
  | 'learning_path_not_found' | 'draft_not_found' | 'draft_published' | 'skill_not_found' | 'stale_revision'
  | 'board_task_missing' | 'board_task_unknown' | 'column_owned_elsewhere'

type Target = { learningPathId: string; draftId: string; skillId: string }
type Located = { ok: true } | { ok: false; refusal: 'learning_path_not_found' | 'draft_not_found' | 'draft_published' | 'skill_not_found'; detail: string }

/** Locks the owner's Path and checks that `draftId` is its open Draft and `skillId` one of the Draft's Skills. */
async function locate(tx: Tx, { learningPathId, draftId, skillId }: Target, accountId: string): Promise<Located> {
  if (!await lockOwnedCoachPath(tx, learningPathId, accountId)) return { ok: false, refusal: 'learning_path_not_found', detail: 'no such Path' }
  const draft = await openDraft(tx, learningPathId)
  if (draft?.id !== draftId) {
    const [version] = await tx.select({ id: learningPathVersions.id }).from(learningPathVersions)
      .where(and(eq(learningPathVersions.id, draftId), eq(learningPathVersions.learningPathId, learningPathId)))
    return version
      ? { ok: false, refusal: 'draft_published', detail: 'this Draft was published; its board is kept with the Version and can no longer change' }
      : { ok: false, refusal: 'draft_not_found', detail: 'no such Draft in this Path' }
  }
  const [skill] = await tx.select({ id: versionSkills.skillId }).from(versionSkills)
    .where(and(eq(versionSkills.learningPathVersionId, draftId), eq(versionSkills.skillId, skillId)))
  if (!skill) return { ok: false, refusal: 'skill_not_found', detail: 'no such Skill in this Draft' }
  return { ok: true }
}

const tasksOf = (tx: Tx, draftId: string, skillId: string) => tx.select({ taskId: versionTasks.taskId }).from(versionTasks)
  .where(and(eq(versionTasks.learningPathVersionId, draftId), eq(versionTasks.skillId, skillId)))
  .orderBy(asc(versionTasks.ordinal), asc(versionTasks.taskId))

async function readBoardIn(tx: Tx, draftId: string, skillId: string): Promise<Board | null> {
  const [board] = await tx.select().from(draftTaskBoards).where(and(eq(draftTaskBoards.learningPathVersionId, draftId), eq(draftTaskBoards.skillId, skillId)))
  if (!board) return null
  const columns = await tx.select().from(draftBoardColumns)
    .where(and(eq(draftBoardColumns.learningPathVersionId, draftId), eq(draftBoardColumns.skillId, skillId))).orderBy(asc(draftBoardColumns.position))
  const cards = await tx.select().from(draftBoardCards)
    .where(and(eq(draftBoardCards.learningPathVersionId, draftId), eq(draftBoardCards.skillId, skillId))).orderBy(asc(draftBoardCards.position))
  return {
    skillId, revision: board.revision,
    columns: columns.map((column) => ({ id: column.id, name: column.name, completion: false, taskIds: cards.filter((card) => card.columnId === column.id).map((card) => card.taskId) })),
  }
}

/**
 * Creates the Skill's board on its first opening: Ideas, In preparation and Ready, with
 * the Draft's Tasks in Ideas in their saved order. Only the board is written; under the
 * Path lock a second, concurrent opening finds the board already there.
 */
async function ensureBoard(tx: Tx, draftId: string, skillId: string): Promise<Board> {
  const existing = await readBoardIn(tx, draftId, skillId)
  if (existing) return existing
  await tx.insert(draftTaskBoards).values({ learningPathVersionId: draftId, skillId })
  const columns = DRAFT_INITIAL_COLUMNS.map((column, position) => ({ id: crypto.randomUUID(), learningPathVersionId: draftId, skillId, name: column.name, position }))
  await tx.insert(draftBoardColumns).values(columns)
  const placed = initialPlacement((await tasksOf(tx, draftId, skillId)).map((task) => ({ id: task.taskId, completed: false })), { first: columns[0].id, completion: null })
  if (placed.length > 0) {
    await tx.insert(draftBoardCards).values(placed.map((card, index) => ({ learningPathVersionId: draftId, skillId, taskId: card.taskId, columnId: card.columnId, position: index })))
  }
  return (await readBoardIn(tx, draftId, skillId))!
}

type ReadResult = { ok: true; board: Board } | Extract<Located, { ok: false }>

/** Opens one Draft Skill's preparation board for the Path's Coach, creating it on first opening. */
export async function readDraftBoard(db: Database, target: Target, accountId: string): Promise<ReadResult> {
  return db.transaction(async (tx) => {
    const located = await locate(tx, target, accountId)
    if (!located.ok) return located
    return { ok: true, board: await ensureBoard(tx, target.draftId, target.skillId) } as const
  })
}

type SaveResult = { ok: true; changed: boolean; board: Board } | { ok: false; refusal: DraftBoardRefusal; detail: string; current?: Board }

class Refused extends Error {
  constructor(readonly refusal: DraftBoardRefusal, readonly detail: string) { super(detail) }
}

/**
 * Saves the Coach's whole preparation board if it was based on the current revision.
 * A save based on an older revision changes nothing and answers the current board,
 * unless it asks for exactly the current arrangement (a retry whose answer was lost).
 * The board must hold every Task of the Skill in this Draft exactly once. Nothing but
 * the board is written: no Task, rule, Version, publication state or learner record.
 */
export async function saveDraftBoard(db: Database, target: Target, accountId: string, input: BoardInput): Promise<SaveResult> {
  const { draftId, skillId } = target
  try {
    return await db.transaction(async (tx) => {
      const located = await locate(tx, target, accountId)
      if (!located.ok) return located
      const current = await ensureBoard(tx, draftId, skillId)
      if (sameArrangement(current.columns, input.columns)) return { ok: true, changed: false, board: current } as const
      if (current.revision !== input.expectedRevision) {
        return { ok: false, refusal: 'stale_revision', detail: `the board change was based on revision ${input.expectedRevision}, but revision ${current.revision} is accepted`, current } as const
      }
      const problem = membershipProblem(input.columns, (await tasksOf(tx, draftId, skillId)).map((task) => task.taskId))
      if (problem) throw new Refused(problem.refusal, problem.detail)
      await writeArrangement(tx, draftId, skillId, input.columns)
      await tx.update(draftTaskBoards).set({ revision: sql`${draftTaskBoards.revision} + 1` })
        .where(and(eq(draftTaskBoards.learningPathVersionId, draftId), eq(draftTaskBoards.skillId, skillId)))
      return { ok: true, changed: true, board: (await readBoardIn(tx, draftId, skillId))! } as const
    })
  } catch (error) {
    if (error instanceof Refused) return { ok: false, refusal: error.refusal, detail: error.detail }
    throw error
  }
}

/**
 * Replaces the board's columns and cards with the saved arrangement. Kept columns are
 * rewritten in place; a new column ID is inserted only if no other board holds it, so a
 * column of another Draft, Skill or Path can never be taken over: the whole save is refused.
 */
async function writeArrangement(tx: Tx, draftId: string, skillId: string, columns: BoardColumn[]) {
  const board = (table: typeof draftBoardCards | typeof draftBoardColumns) => and(eq(table.learningPathVersionId, draftId), eq(table.skillId, skillId))
  await tx.delete(draftBoardCards).where(board(draftBoardCards))
  await tx.update(draftBoardColumns).set({ position: sql`${draftBoardColumns.position} + 1000` }).where(board(draftBoardColumns))
  await tx.delete(draftBoardColumns).where(and(board(draftBoardColumns), notInArray(draftBoardColumns.id, columns.map((column) => column.id))))
  const [foreign] = await tx.select({ id: draftBoardColumns.id }).from(draftBoardColumns)
    .where(and(inArray(draftBoardColumns.id, columns.map((column) => column.id)), sql`(${draftBoardColumns.learningPathVersionId}, ${draftBoardColumns.skillId}) <> (${draftId}::uuid, ${skillId}::uuid)`)).limit(1)
  if (foreign) throw new Refused('column_owned_elsewhere', `column ${foreign.id} belongs to another board`)
  for (const [position, column] of columns.entries()) {
    const [kept] = await tx.update(draftBoardColumns).set({ name: column.name, position })
      .where(and(board(draftBoardColumns), eq(draftBoardColumns.id, column.id))).returning({ id: draftBoardColumns.id })
    if (kept) continue
    const [inserted] = await tx.insert(draftBoardColumns).values({ id: column.id, learningPathVersionId: draftId, skillId, name: column.name, position })
      .onConflictDoNothing({ target: draftBoardColumns.id }).returning({ id: draftBoardColumns.id })
    if (!inserted) throw new Refused('column_owned_elsewhere', `column ${column.id} belongs to another board`)
  }
  const cards = columns.flatMap((column) => column.taskIds.map((taskId, position) => ({ learningPathVersionId: draftId, skillId, taskId, columnId: column.id, position })))
  if (cards.length > 0) await tx.insert(draftBoardCards).values(cards)
}
