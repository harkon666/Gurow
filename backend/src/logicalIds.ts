import { eq, inArray } from 'drizzle-orm'
import { skills, tasks } from './db/schema'
import type { Tx } from './personal'

export type ClaimRefusal = 'skill_owned_elsewhere' | 'task_owned_elsewhere' | 'task_skill_mismatch'

/**
 * Claims logical Skill and Task IDs for a Path (ADR 0004). An ID already known is
 * accepted only when it is this Path's own Skill, or a Task of the same Skill: from an
 * earlier Version, or content deleted and brought back by an editor undo. Any other
 * known ID refuses the save. The primary key decides concurrent claims.
 */
export async function claimLogicalIds(tx: Tx, pathId: string, skillIds: string[], newTasks: { id: string; skillId: string }[]): Promise<{ refusal: ClaimRefusal; detail: string } | null> {
  if (skillIds.length > 0) {
    await tx.insert(skills).values(skillIds.map((id) => ({ id, learningPathId: pathId }))).onConflictDoNothing()
    const known = await tx.select().from(skills).where(inArray(skills.id, skillIds))
    const foreign = known.find((row) => row.learningPathId !== pathId)
    if (foreign) return { refusal: 'skill_owned_elsewhere', detail: `Skill ${foreign.id} belongs to another Learning Path` }
  }
  if (newTasks.length > 0) {
    await tx.insert(tasks).values(newTasks.map((task) => ({ id: task.id, skillId: task.skillId }))).onConflictDoNothing()
    const known = new Map((await tx.select({ id: tasks.id, skillId: tasks.skillId, pathId: skills.learningPathId }).from(tasks)
      .innerJoin(skills, eq(skills.id, tasks.skillId)).where(inArray(tasks.id, newTasks.map((task) => task.id)))).map((row) => [row.id, row]))
    for (const task of newTasks) {
      const row = known.get(task.id)!
      if (row.pathId !== pathId) return { refusal: 'task_owned_elsewhere', detail: `Task ${task.id} belongs to another Skill` }
      if (row.skillId !== task.skillId) return { refusal: 'task_skill_mismatch', detail: `Task ${task.id} belongs to another Skill` }
    }
  }
  return null
}
