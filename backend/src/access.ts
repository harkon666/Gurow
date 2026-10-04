import { and, asc, eq, isNull } from 'drizzle-orm'
import type { Database } from './db/client'
import { submissionReviews, submissionRevisions, submissions, versionPrerequisites, versionSkills, versionTasks } from './db/schema'

/** Caller holds Enrollment FOR UPDATE through commit, including for coherent reads.
 * Published definitions are pinned; all evidence mutators use the same lock.
 * Overrides are deferred to T11. No personal or other Enrollment evidence is read.
 */
export async function deriveLearningState(db: Pick<Database, 'select'>, enrollmentId: string, versionId: string, ownerId: string, active: boolean) {
  const definitions = await db.select().from(versionTasks).where(eq(versionTasks.learningPathVersionId, versionId)).orderBy(asc(versionTasks.taskId))
  const skills = await db.select().from(versionSkills).where(eq(versionSkills.learningPathVersionId, versionId)).orderBy(asc(versionSkills.skillId))
  const prerequisites = await db.select().from(versionPrerequisites).where(eq(versionPrerequisites.learningPathVersionId, versionId)).orderBy(asc(versionPrerequisites.prerequisiteSkillId))
  const approvals = await db.select({ taskId: submissions.taskId }).from(submissions)
    .innerJoin(submissionRevisions, eq(submissionRevisions.submissionId, submissions.id))
    .innerJoin(submissionReviews, eq(submissionReviews.revisionId, submissionRevisions.id))
    .where(and(
      eq(submissions.enrollmentId, enrollmentId), eq(submissions.learningPathVersionId, versionId),
      eq(submissionReviews.coachAccountId, ownerId), eq(submissionReviews.decision, 'approval'),
      isNull(submissionReviews.revokedAt), isNull(submissionRevisions.supersededAt),
    ))
  const approvedTasks = new Set(approvals.map((approval) => approval.taskId))
  const tasks = definitions.map((task) => ({ ...task, approved: approvedTasks.has(task.taskId), xpContribution: approvedTasks.has(task.taskId) ? task.xpReward : 0 }))
  const xp = tasks.reduce((total, task) => total + task.xpContribution, 0)
  const mastered = new Set(skills.filter((skill) => {
    const required = tasks.filter((task) => task.skillId === skill.skillId && task.required)
    return required.length > 0 && required.every((task) => task.approved)
  }).map((skill) => skill.skillId))
  return {
    enrollmentId, learningPathVersionId: versionId, enrollmentStatus: active ? 'active' as const : 'inactive' as const, xp, tasks,
    skills: skills.map((skill) => {
      const unmetPrerequisiteSkillIds = prerequisites.filter((edge) => edge.skillId === skill.skillId && !mastered.has(edge.prerequisiteSkillId)).map((edge) => edge.prerequisiteSkillId)
      const xpShortfall = Math.max(0, skill.xpThreshold - xp)
      return { ...skill, mastery: mastered.has(skill.skillId), access: active && xpShortfall === 0 && unmetPrerequisiteSkillIds.length === 0, unmetPrerequisiteSkillIds, xpShortfall }
    }),
  }
}

/** The send gate uses exactly the same derivation as the readable progress view. */
export async function hasSkillAccess(db: Pick<Database, 'select'>, enrollmentId: string, versionId: string, taskId: string, ownerId: string): Promise<boolean> {
  const state = await deriveLearningState(db, enrollmentId, versionId, ownerId, true)
  const task = state.tasks.find((task) => task.taskId === taskId)
  return Boolean(task && state.skills.find((skill) => skill.skillId === task.skillId)?.access)
}
