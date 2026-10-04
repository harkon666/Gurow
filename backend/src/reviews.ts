import { and, eq } from 'drizzle-orm'
import { deriveLearningState } from './access'
import type { Database } from './db/client'
import { coachWorkspaces, enrollments, learningPaths, learningPathVersions, submissionReviews, submissionRevisions, submissions } from './db/schema'
import { taskContext } from './submissions'
import { readHistory, recordTransitions } from './history'

export interface ReviewContents {
  decision: 'approval' | 'changes_requested'
  feedback: string | null
}

/** A decision targets one exact revision. Lock Enrollment before Submission,
 * recheck pending state after the lock, and return only after durable commit.
 * Current Access is deliberately not a review gate for previously eligible work.
 * Decisions are terminal here: retries/overwrites reject rather than replace history.
 */
export async function recordReview(db: Database, enrollmentId: string, taskId: string, revisionId: string, accountId: string, contents: ReviewContents) {
  return db.transaction(async (tx) => {
    const context = await taskContext(tx, enrollmentId, taskId, accountId)
    if (!context.ok) return context
    if (context.role !== 'coach') return { ok: false, refusal: 'coach_only' } as const
    await tx.select().from(enrollments).where(eq(enrollments.id, enrollmentId)).for('update')
    const [submission] = await tx.select().from(submissions)
      .where(and(eq(submissions.enrollmentId, enrollmentId), eq(submissions.taskId, taskId))).for('update')
    if (!submission) return { ok: false, refusal: 'revision_not_found' } as const
    const [revision] = await tx.select().from(submissionRevisions)
      .where(and(eq(submissionRevisions.id, revisionId), eq(submissionRevisions.submissionId, submission.id)))
    if (!revision) return { ok: false, refusal: 'revision_not_found' } as const
    if (revision.supersededAt) return { ok: false, refusal: 'revision_superseded' } as const
    const [existing] = await tx.select().from(submissionReviews).where(eq(submissionReviews.revisionId, revisionId))
    if (existing) return { ok: false, refusal: 'revision_already_reviewed' } as const
    const before = await deriveLearningState(tx, enrollmentId, context.enrollment.learningPathVersionId, accountId, context.enrollment.status === 'active')
    const [review] = await tx.insert(submissionReviews).values({ revisionId, coachAccountId: accountId, ...contents, decidedAt: new Date() }).returning()
    const after = await deriveLearningState(tx, enrollmentId, context.enrollment.learningPathVersionId, accountId, context.enrollment.status === 'active')
    await recordTransitions(tx, before, after, revisionId, accountId, review.decidedAt)
    return { ok: true, value: review } as const
  })
}

export async function revokeApproval(db: Database, enrollmentId: string, taskId: string, revisionId: string, accountId: string, reason: string) {
  return db.transaction(async (tx) => {
    const context = await taskContext(tx, enrollmentId, taskId, accountId)
    if (!context.ok) return context
    if (context.role !== 'coach') return { ok: false, refusal: 'coach_only' } as const
    const [enrollment] = await tx.select().from(enrollments).where(eq(enrollments.id, enrollmentId)).for('update')
    const [submission] = await tx.select().from(submissions).where(and(eq(submissions.enrollmentId, enrollmentId), eq(submissions.taskId, taskId))).for('update')
    if (!submission) return { ok: false, refusal: 'approval_not_found' } as const
    const [review] = await tx.select({ review: submissionReviews }).from(submissionReviews)
      .innerJoin(submissionRevisions, eq(submissionRevisions.id, submissionReviews.revisionId))
      .where(and(eq(submissionReviews.revisionId, revisionId), eq(submissionRevisions.submissionId, submission.id)))
    if (!review || review.review.decision !== 'approval' || review.review.coachAccountId !== accountId) return { ok: false, refusal: 'approval_not_found' } as const
    if (review.review.revokedAt) return { ok: false, refusal: 'approval_already_revoked' } as const
    const before = await deriveLearningState(tx, enrollmentId, enrollment.learningPathVersionId, accountId, enrollment.status === 'active')
    const occurredAt = new Date()
    const [revoked] = await tx.update(submissionReviews).set({ revokedAt: occurredAt, revocationReason: reason, revokedByAccountId: accountId }).where(eq(submissionReviews.revisionId, revisionId)).returning()
    const after = await deriveLearningState(tx, enrollmentId, enrollment.learningPathVersionId, accountId, enrollment.status === 'active')
    await recordTransitions(tx, before, after, revisionId, accountId, occurredAt)
    return { ok: true, value: revoked } as const
  })
}

/** Only the learner and owning Coach can read progress, even while inactive.
 * The shared Enrollment lock prevents multiple evidence queries mixing states.
 */
export async function readLearningState(db: Database, enrollmentId: string, accountId: string) {
  return db.transaction(async (tx) => {
    const [context] = await tx.select({ enrollment: enrollments, ownerId: coachWorkspaces.ownerAccountId }).from(enrollments)
      .innerJoin(learningPathVersions, eq(learningPathVersions.id, enrollments.learningPathVersionId))
      .innerJoin(learningPaths, eq(learningPaths.id, learningPathVersions.learningPathId))
      .innerJoin(coachWorkspaces, eq(coachWorkspaces.id, learningPaths.coachWorkspaceId))
      .where(eq(enrollments.id, enrollmentId))
    if (!context || (context.enrollment.accountId !== accountId && context.ownerId !== accountId)) return null
    const [enrollment] = await tx.select().from(enrollments).where(eq(enrollments.id, enrollmentId)).for('update')
    return { ...await deriveLearningState(tx, enrollmentId, enrollment.learningPathVersionId, context.ownerId, enrollment.status === 'active'), ...await readHistory(tx, enrollmentId) }
  })
}
