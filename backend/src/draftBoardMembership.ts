import { and, asc, eq, inArray, max, sql } from 'drizzle-orm'
import { draftBoardCards, draftBoardColumns, draftTaskBoards } from './db/schema'
import type { Tx } from './personal'

/**
 * Keeps a Draft's preparation boards coherent when its Tasks change through the
 * Draft's other permitted entry points (ADR 0029): a document save that adds or
 * deletes Tasks or Skills, and an archival. Each change advances the board's revision,
 * so a board save based on the earlier arrangement is stale. A Skill whose board was
 * never opened has nothing to keep: its first opening places its Tasks.
 */

async function bump(tx: Tx, versionId: string, skillIds: string[]) {
  if (skillIds.length === 0) return
  await tx.update(draftTaskBoards).set({ revision: sql`${draftTaskBoards.revision} + 1` })
    .where(and(eq(draftTaskBoards.learningPathVersionId, versionId), inArray(draftTaskBoards.skillId, [...new Set(skillIds)])))
}

/** New Draft Tasks join the end of their opened board's first column. */
export async function addDraftCards(tx: Tx, versionId: string, newTasks: { taskId: string; skillId: string }[]) {
  const touched: string[] = []
  for (const task of newTasks) {
    const [first] = await tx.select().from(draftBoardColumns)
      .where(and(eq(draftBoardColumns.learningPathVersionId, versionId), eq(draftBoardColumns.skillId, task.skillId)))
      .orderBy(asc(draftBoardColumns.position)).limit(1)
    if (!first) continue
    const [last] = await tx.select({ position: max(draftBoardCards.position) }).from(draftBoardCards).where(eq(draftBoardCards.columnId, first.id))
    await tx.insert(draftBoardCards).values({ learningPathVersionId: versionId, skillId: task.skillId, taskId: task.taskId, columnId: first.id, position: (last?.position ?? -1) + 1 })
    touched.push(task.skillId)
  }
  await bump(tx, versionId, touched)
}

/** Tasks leaving the Draft (deleted or archived) leave its boards first; nothing else of theirs changes. */
export async function removeDraftCards(tx: Tx, versionId: string, taskIds: string[]) {
  if (taskIds.length === 0) return
  const removed = await tx.delete(draftBoardCards)
    .where(and(eq(draftBoardCards.learningPathVersionId, versionId), inArray(draftBoardCards.taskId, taskIds)))
    .returning({ skillId: draftBoardCards.skillId })
  await bump(tx, versionId, removed.map((row) => row.skillId))
}

/** A Skill deleted from the Draft takes its board with it; its Tasks' cards were removed first. */
export async function deleteDraftBoards(tx: Tx, versionId: string, skillIds: string[]) {
  if (skillIds.length === 0) return
  const inDraft = (table: typeof draftBoardCards | typeof draftBoardColumns | typeof draftTaskBoards) =>
    and(eq(table.learningPathVersionId, versionId), inArray(table.skillId, skillIds))
  await tx.delete(draftBoardCards).where(inDraft(draftBoardCards))
  await tx.delete(draftBoardColumns).where(inDraft(draftBoardColumns))
  await tx.delete(draftTaskBoards).where(inDraft(draftTaskBoards))
}
