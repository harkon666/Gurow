import { and, eq, isNotNull, or } from 'drizzle-orm'
import type { Database } from './db/client'
import { learningPathVersions, personalMasteryEvents, personalOverrideRecords, personalSkills, personalTasks, personalXpEvents, versionSkills, versionTasks } from './db/schema'

/**
 * The history-retention guard (ADR 0018, 0026): which learning content of a Path holds
 * progress history and so cannot be permanently deleted, only archived.
 *
 * In a personal Path, a Task has history once it was started or completed or its
 * contribution was ever recorded, and an archived Task is retained history in
 * itself. A Skill has history through declared or withdrawn Mastery, an Access
 * Override, or any of its Tasks with history. In coach mode, content is history
 * once a published Version holds it: that Version is the learning contract of its
 * Enrollments, whose Submissions, Reviews, XP and Mastery refer to it.
 */
export async function personalHistory(tx: Pick<Database, 'select'>, learningPathId: string) {
  const worked = await tx.select({ taskId: personalTasks.taskId, skillId: personalTasks.skillId }).from(personalTasks)
    .where(and(eq(personalTasks.learningPathId, learningPathId), or(isNotNull(personalTasks.startedAt), isNotNull(personalTasks.completedAt), isNotNull(personalTasks.archivedAt))))
  const scored = await tx.select({ taskId: personalXpEvents.taskId, skillId: personalTasks.skillId }).from(personalXpEvents)
    .innerJoin(personalTasks, eq(personalTasks.taskId, personalXpEvents.taskId)).where(eq(personalXpEvents.learningPathId, learningPathId))
  const mastery = await tx.select({ skillId: personalMasteryEvents.skillId }).from(personalMasteryEvents).where(eq(personalMasteryEvents.learningPathId, learningPathId))
  const declared = await tx.select({ skillId: personalSkills.skillId }).from(personalSkills).where(and(eq(personalSkills.learningPathId, learningPathId), or(isNotNull(personalSkills.masteryDeclaredAt), isNotNull(personalSkills.archivedAt))))
  const overrides = await tx.select({ skillId: personalOverrideRecords.skillId }).from(personalOverrideRecords).where(eq(personalOverrideRecords.learningPathId, learningPathId))
  const tasks = [...worked, ...scored]
  return {
    tasks: new Set(tasks.map((task) => task.taskId)),
    skills: new Set([...tasks, ...mastery, ...declared, ...overrides].map((row) => row.skillId)),
  }
}

/** The Skills and Tasks any published Version of a coach-mode Path holds. */
export async function publishedContent(tx: Pick<Database, 'select'>, learningPathId: string) {
  const published = and(eq(learningPathVersions.learningPathId, learningPathId), isNotNull(learningPathVersions.publishedAt))
  const skillRows = await tx.select({ id: versionSkills.skillId }).from(versionSkills)
    .innerJoin(learningPathVersions, eq(learningPathVersions.id, versionSkills.learningPathVersionId)).where(published)
  const taskRows = await tx.select({ id: versionTasks.taskId }).from(versionTasks)
    .innerJoin(learningPathVersions, eq(learningPathVersions.id, versionTasks.learningPathVersionId)).where(published)
  return { skills: new Set(skillRows.map((row) => row.id)), tasks: new Set(taskRows.map((row) => row.id)) }
}
