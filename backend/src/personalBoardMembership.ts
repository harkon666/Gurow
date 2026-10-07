import { and, asc, eq, inArray, max, sql } from 'drizzle-orm'
import { personalBoardCards, personalBoardColumns, personalTaskBoards } from './db/schema'
import type { Tx } from './personal'

/**
 * Keeps personal Task Boards coherent when a Task changes through another permitted
 * entry point (ADR 0027): a document save that adds or deletes Tasks or Skills, an
 * archival, or the retained completion action. Each change also advances the board's
 * revision, so a board save based on the earlier arrangement is stale. A Skill whose
 * board was never opened has nothing to keep: its first opening places its Tasks.
 */

async function bump(tx: Tx, learningPathId: string, skillIds: string[]) {
  if (skillIds.length === 0) return
  await tx.update(personalTaskBoards).set({ revision: sql`${personalTaskBoards.revision} + 1` })
    .where(and(eq(personalTaskBoards.learningPathId, learningPathId), inArray(personalTaskBoards.skillId, [...new Set(skillIds)])))
}

/** The board's columns in order; empty when the Skill has no board. */
async function columnsOf(tx: Tx, learningPathId: string, skillId: string) {
  return tx.select().from(personalBoardColumns)
    .where(and(eq(personalBoardColumns.learningPathId, learningPathId), eq(personalBoardColumns.skillId, skillId)))
    .orderBy(asc(personalBoardColumns.position))
}

async function appendCard(tx: Tx, learningPathId: string, skillId: string, taskId: string, columnId: string) {
  const [last] = await tx.select({ position: max(personalBoardCards.position) }).from(personalBoardCards).where(eq(personalBoardCards.columnId, columnId))
  const position = (last?.position ?? -1) + 1
  await tx.insert(personalBoardCards).values({ learningPathId, skillId, taskId, columnId, position })
    .onConflictDoUpdate({ target: [personalBoardCards.learningPathId, personalBoardCards.taskId], set: { columnId, position } })
}

/**
 * After the retained completion action: a completed Task's card joins the end of the
 * Completion Column, an uncompleted one the end of the first other column. A card
 * already on the right side of the boundary stays where it is.
 */
export async function placeForCompletion(tx: Tx, learningPathId: string, skillId: string, taskId: string, completed: boolean) {
  const columns = await columnsOf(tx, learningPathId, skillId)
  if (columns.length === 0) return
  const [card] = await tx.select().from(personalBoardCards).where(and(eq(personalBoardCards.learningPathId, learningPathId), eq(personalBoardCards.taskId, taskId)))
  const current = columns.find((column) => column.id === card?.columnId)
  if (current && current.completion === completed) return
  const target = columns.find((column) => column.completion === completed)!
  await appendCard(tx, learningPathId, skillId, taskId, target.id)
  await bump(tx, learningPathId, [skillId])
}

/** New active Tasks join the end of their opened board's first column that is not the Completion Column. */
export async function addCards(tx: Tx, learningPathId: string, newTasks: { taskId: string; skillId: string }[]) {
  const touched: string[] = []
  for (const task of newTasks) {
    const target = (await columnsOf(tx, learningPathId, task.skillId)).find((column) => !column.completion)
    if (!target) continue
    await appendCard(tx, learningPathId, task.skillId, task.taskId, target.id)
    touched.push(task.skillId)
  }
  await bump(tx, learningPathId, touched)
}

/** Tasks leaving active use (deleted or archived) leave their boards; their records are untouched. */
export async function removeCards(tx: Tx, learningPathId: string, taskIds: string[]) {
  if (taskIds.length === 0) return
  const removed = await tx.delete(personalBoardCards)
    .where(and(eq(personalBoardCards.learningPathId, learningPathId), inArray(personalBoardCards.taskId, taskIds)))
    .returning({ skillId: personalBoardCards.skillId })
  await bump(tx, learningPathId, removed.map((row) => row.skillId))
}

/** A deleted Skill's board goes with it; its Tasks' cards were removed first. */
export async function deleteBoards(tx: Tx, learningPathId: string, skillIds: string[]) {
  if (skillIds.length === 0) return
  const inPath = (table: typeof personalBoardCards | typeof personalBoardColumns | typeof personalTaskBoards) =>
    and(eq(table.learningPathId, learningPathId), inArray(table.skillId, skillIds))
  await tx.delete(personalBoardCards).where(inPath(personalBoardCards))
  await tx.delete(personalBoardColumns).where(inPath(personalBoardColumns))
  await tx.delete(personalTaskBoards).where(inPath(personalTaskBoards))
}
