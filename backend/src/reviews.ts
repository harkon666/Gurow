import { and, asc, eq, inArray, isNull, notExists } from 'drizzle-orm'
import { deriveLearningState } from './access'
import type { Database } from './db/client'
import { accounts, coachWorkspaces, enrollmentLifecycleRecords, enrollments, learningPaths, learningPathVersions, submissionReviews, submissionRevisions, submissions, taskStarts } from './db/schema'
import { taskContext } from './submissions'
import { lockedTimestamp } from './db/clock'
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
    const [enrollment] = await tx.select().from(enrollments).where(eq(enrollments.id, enrollmentId)).for('update')
    const [submission] = await tx.select().from(submissions)
      .where(and(eq(submissions.enrollmentId, enrollmentId), eq(submissions.taskId, taskId))).for('update')
    if (!submission) return { ok: false, refusal: 'revision_not_found' } as const
    const [revision] = await tx.select().from(submissionRevisions)
      .where(and(eq(submissionRevisions.id, revisionId), eq(submissionRevisions.submissionId, submission.id)))
    if (!revision) return { ok: false, refusal: 'revision_not_found' } as const
    if (revision.supersededAt) return { ok: false, refusal: 'revision_superseded' } as const
    const [existing] = await tx.select().from(submissionReviews).where(eq(submissionReviews.revisionId, revisionId))
    if (existing) return { ok: false, refusal: 'revision_already_reviewed' } as const
    const before = await deriveLearningState(tx, enrollmentId, enrollment.learningPathVersionId, accountId, enrollment.status === 'active')
    const decidedAt = await lockedTimestamp(tx)
    const [review] = await tx.insert(submissionReviews).values({ revisionId, coachAccountId: accountId, ...contents, decidedAt }).returning()
    const after = await deriveLearningState(tx, enrollmentId, enrollment.learningPathVersionId, accountId, enrollment.status === 'active')
    await recordTransitions(tx, before, after, revisionId, accountId, decidedAt)
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
    const occurredAt = await lockedTimestamp(tx)
    const [revoked] = await tx.update(submissionReviews).set({ revokedAt: occurredAt, revocationReason: reason, revokedByAccountId: accountId }).where(eq(submissionReviews.revisionId, revisionId)).returning()
    const after = await deriveLearningState(tx, enrollmentId, enrollment.learningPathVersionId, accountId, enrollment.status === 'active')
    await recordTransitions(tx, before, after, revisionId, accountId, occurredAt)
    return { ok: true, value: revoked } as const
  })
}

type Reader = Pick<Database, 'select'>

/**
 * Revisions awaiting a decision in the given Enrollments: sent, not superseded and
 * without a Review, so at most one per Submission. They stay reviewable after the
 * Skill's Access or the Enrollment's activity is lost (ADR 0007, CONTEXT.md: Submission).
 */
async function awaitingReview(db: Reader, enrollmentIds: string[]) {
  if (enrollmentIds.length === 0) return []
  return db.select({
    enrollmentId: submissions.enrollmentId, taskId: submissions.taskId, revisionId: submissionRevisions.id,
    revisionNumber: submissionRevisions.revisionNumber, sentAt: submissionRevisions.sentAt,
  }).from(submissionRevisions)
    .innerJoin(submissions, eq(submissions.id, submissionRevisions.submissionId))
    .where(and(
      inArray(submissions.enrollmentId, enrollmentIds), isNull(submissionRevisions.supersededAt),
      notExists(db.select().from(submissionReviews).where(eq(submissionReviews.revisionId, submissionRevisions.id))),
    ))
    .orderBy(asc(submissionRevisions.sentAt), asc(submissionRevisions.id))
}

/**
 * The Enrollments of one published Version, for the owner of its Coach Workspace only
 * (ADR 0013): each learner as invited, the Enrollment's status, and the revisions
 * awaiting Review, oldest first. Anyone else, and an unpublished Version, gets null.
 */
export async function listVersionEnrollments(db: Database, versionId: string, accountId: string) {
  return db.transaction(async (tx) => {
    const [owned] = await tx.select({ publishedAt: learningPathVersions.publishedAt }).from(learningPathVersions)
      .innerJoin(learningPaths, eq(learningPaths.id, learningPathVersions.learningPathId))
      .innerJoin(coachWorkspaces, eq(coachWorkspaces.id, learningPaths.coachWorkspaceId))
      .where(and(eq(learningPathVersions.id, versionId), eq(coachWorkspaces.ownerAccountId, accountId)))
    if (!owned?.publishedAt) return null
    const rows = await tx.select({ id: enrollments.id, status: enrollments.status, createdAt: enrollments.createdAt, learnerName: accounts.name, learnerEmail: accounts.email })
      .from(enrollments).innerJoin(accounts, eq(accounts.id, enrollments.accountId))
      .where(eq(enrollments.learningPathVersionId, versionId))
      .orderBy(asc(enrollments.createdAt), asc(enrollments.id))
    const pending = await awaitingReview(tx, rows.map((row) => row.id))
    return rows.map(({ learnerName, learnerEmail, ...enrollment }) => ({
      ...enrollment,
      learner: { name: learnerName, email: learnerEmail },
      awaitingReview: pending.filter((revision) => revision.enrollmentId === enrollment.id).map(({ enrollmentId: _, ...revision }) => revision),
    }))
  })
}

/**
 * Each sent Task's review state in one Enrollment, as two separate facts (ADR 0002, 0030):
 * the newest revision and its own status, and the revisions whose Approval still counts.
 * A newer pending revision neither inherits an earlier Approval nor hides it, so a card or
 * summary can show both. Only sent revisions are read; Submission Drafts never are.
 */
async function taskReviews(db: Reader, enrollmentId: string, ownerId: string) {
  const rows = await db.select({ taskId: submissions.taskId, revision: submissionRevisions, review: submissionReviews }).from(submissionRevisions)
    .innerJoin(submissions, eq(submissions.id, submissionRevisions.submissionId))
    .leftJoin(submissionReviews, eq(submissionReviews.revisionId, submissionRevisions.id))
    .where(eq(submissions.enrollmentId, enrollmentId))
    .orderBy(asc(submissions.taskId), asc(submissionRevisions.revisionNumber))
  const byTask = new Map<string, typeof rows>()
  for (const row of rows) byTask.set(row.taskId, [...byTask.get(row.taskId) ?? [], row])
  return [...byTask].map(([taskId, revisions]) => {
    const latest = revisions[revisions.length - 1]
    const review = latest.review
    return {
      taskId,
      sentRevisions: revisions.length,
      latestRevisionNumber: latest.revision.revisionNumber,
      latestStatus: review ? (review.revokedAt ? 'approval_revoked' as const : review.decision) : latest.revision.supersededAt ? 'superseded' as const : 'pending' as const,
      // The same validity rule as the derivation (access.ts).
      approvedRevisionNumbers: revisions.filter(({ revision, review }) => review?.decision === 'approval' && !review.revokedAt && review.coachAccountId === ownerId && !revision.supersededAt)
        .map(({ revision }) => revision.revisionNumber),
    }
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
    const lifecycleHistory = await tx.select().from(enrollmentLifecycleRecords).where(eq(enrollmentLifecycleRecords.enrollmentId, enrollmentId)).orderBy(asc(enrollmentLifecycleRecords.sequence))
    const awaiting = (await awaitingReview(tx, [enrollmentId])).map(({ enrollmentId: _, ...revision }) => revision)
    return { ...await deriveLearningState(tx, enrollmentId, enrollment.learningPathVersionId, context.ownerId, enrollment.status === 'active'), ...await readHistory(tx, enrollmentId), lifecycleHistory, taskStarts: await tx.select().from(taskStarts).where(eq(taskStarts.enrollmentId, enrollmentId)).orderBy(asc(taskStarts.taskId)), awaitingReview: awaiting, taskReviews: await taskReviews(tx, enrollmentId, context.ownerId) }
  })
}
