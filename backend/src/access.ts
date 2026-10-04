import { and, eq, isNull } from 'drizzle-orm'
import type { Database } from './db/client'
import { submissionReviews, submissionRevisions, submissions, versionPrerequisites, versionSkills, versionTasks } from './db/schema'

/**
 * Current ordinary Access under the Enrollment's pinned rules. Caller must hold
 * the Enrollment FOR UPDATE through commit; every future Review/revocation
 * mutator must take that same lock before changing its progression evidence.
 * Overrides are not modeled here; their API and persistence belong to T11.
 */
export async function hasSkillAccess(db: Pick<Database, 'select'>, enrollmentId: string, versionId: string, taskId: string, ownerId: string): Promise<boolean> {
  const definitions = await db.select().from(versionTasks).where(eq(versionTasks.learningPathVersionId, versionId))
  const target = definitions.find((task) => task.taskId === taskId)
  if (!target) return false
  const [skill] = await db.select().from(versionSkills)
    .where(and(eq(versionSkills.learningPathVersionId, versionId), eq(versionSkills.skillId, target.skillId)))
  if (!skill) return false

  const approvals = await db.select({ taskId: submissions.taskId }).from(submissions)
    .innerJoin(submissionRevisions, eq(submissionRevisions.submissionId, submissions.id))
    .innerJoin(submissionReviews, eq(submissionReviews.revisionId, submissionRevisions.id))
    .where(and(
      eq(submissions.enrollmentId, enrollmentId), eq(submissions.learningPathVersionId, versionId),
      eq(submissionReviews.coachAccountId, ownerId), eq(submissionReviews.decision, 'approval'),
      isNull(submissionReviews.revokedAt), isNull(submissionRevisions.supersededAt),
    ))
  const approvedTasks = new Set(approvals.map((approval) => approval.taskId))
  // Each Task contributes its pinned reward once, regardless of approved revision count.
  const xp = definitions.reduce((total, task) => total + (approvedTasks.has(task.taskId) ? task.xpReward : 0), 0)
  if (xp < skill.xpThreshold) return false

  const prerequisites = await db.select().from(versionPrerequisites)
    .where(and(eq(versionPrerequisites.learningPathVersionId, versionId), eq(versionPrerequisites.skillId, target.skillId)))
  return prerequisites.every((edge) => {
    const required = definitions.filter((task) => task.skillId === edge.prerequisiteSkillId && task.required)
    return required.length > 0 && required.every((task) => approvedTasks.has(task.taskId))
  })
}
