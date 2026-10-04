import { and, asc, eq, isNull, max, notExists, sql } from 'drizzle-orm'
import type { Database } from './db/client'
import { hasSkillAccess } from './access'
import { coachWorkspaces, enrollments, learningPaths, learningPathVersions, submissionDrafts, submissionReviews, submissionRevisions, submissions, versionTasks } from './db/schema'

/** Why a draft or Submission operation is refused; each maps to one HTTP status at the route. */
export type SubmissionRefusal =
  | 'enrollment_not_found'
  | 'task_not_found'
  | 'submission_not_found'
  | 'draft_private'
  | 'learner_only'
  | 'enrollment_inactive'
  | 'skill_locked'

export type SubmissionResult<T> = { ok: true; value: T } | { ok: false; refusal: SubmissionRefusal }

/** Text and URLs, the MVP evidence a draft or revision holds (ADR 0002). */
export interface SubmissionContents {
  text: string
  urls: string[]
}

export type DraftRecord = typeof submissionDrafts.$inferSelect
export type SubmissionRecord = typeof submissions.$inferSelect
export type RevisionRecord = typeof submissionRevisions.$inferSelect

/** Decisions remain attached to their assessed revision; newer sends do not inherit them. */
export interface RevisionView extends RevisionRecord {
  status: 'pending' | 'superseded' | 'approval' | 'approval_revoked' | 'changes_requested'
  /** Omitted for unreviewed revisions, preserving their existing payload. */
  review?: typeof submissionReviews.$inferSelect
}

export interface SubmissionView extends SubmissionRecord {
  revisions: RevisionView[]
}

type Executor = Pick<Database, 'select'>

/**
 * Resolves the acting Account's role for one Task of an Enrollment. Only the
 * learner and the owning Coach see the Enrollment (ADR 0013); anyone else, and
 * an unknown ID, gets the same refusal. The Task must be defined in the
 * Enrollment's own Version.
 */
export async function taskContext(db: Executor, enrollmentId: string, taskId: string, accountId: string) {
  const [row] = await db
    .select({ enrollment: enrollments, ownerId: coachWorkspaces.ownerAccountId, taskId: versionTasks.taskId })
    .from(enrollments)
    .innerJoin(learningPathVersions, eq(learningPathVersions.id, enrollments.learningPathVersionId))
    .innerJoin(learningPaths, eq(learningPaths.id, learningPathVersions.learningPathId))
    .innerJoin(coachWorkspaces, eq(coachWorkspaces.id, learningPaths.coachWorkspaceId))
    .leftJoin(versionTasks, and(eq(versionTasks.learningPathVersionId, enrollments.learningPathVersionId), eq(versionTasks.taskId, taskId)))
    .where(eq(enrollments.id, enrollmentId))
  if (!row) return { ok: false, refusal: 'enrollment_not_found' } as const
  const role = row.enrollment.accountId === accountId ? 'learner' : row.ownerId === accountId ? 'coach' : null
  if (!role) return { ok: false, refusal: 'enrollment_not_found' } as const
  if (!row.taskId) return { ok: false, refusal: 'task_not_found' } as const
  return { ok: true, role, enrollment: row.enrollment, ownerId: row.ownerId } as const
}

/** Reads the learner's own draft for a Task; the Coach never sees unsent contents (ADR 0002). */
export async function readDraft(db: Database, enrollmentId: string, taskId: string, accountId: string): Promise<SubmissionResult<DraftRecord | null>> {
  const context = await taskContext(db, enrollmentId, taskId, accountId)
  if (!context.ok) return context
  if (context.role !== 'learner') return { ok: false, refusal: 'draft_private' }
  const [draft] = await db.select().from(submissionDrafts)
    .where(and(eq(submissionDrafts.enrollmentId, enrollmentId), eq(submissionDrafts.taskId, taskId)))
  return { ok: true, value: draft ?? null }
}

/** Saves the learner's draft for a Task, replacing its previous contents. */
export async function saveDraft(db: Database, enrollmentId: string, taskId: string, accountId: string, contents: SubmissionContents): Promise<SubmissionResult<DraftRecord>> {
  const context = await taskContext(db, enrollmentId, taskId, accountId)
  if (!context.ok) return context
  if (context.role !== 'learner') return { ok: false, refusal: 'draft_private' }
  const [draft] = await db.insert(submissionDrafts)
    .values({ enrollmentId, learningPathVersionId: context.enrollment.learningPathVersionId, taskId, ...contents })
    .onConflictDoUpdate({
      target: [submissionDrafts.enrollmentId, submissionDrafts.taskId],
      set: { text: contents.text, urls: contents.urls, updatedAt: sql`now()` },
    })
    .returning()
  return { ok: true, value: draft }
}

export interface SentRevision {
  submission: SubmissionRecord
  revision: RevisionRecord
  /** True when this sending created the Task's Submission. */
  createdSubmission: boolean
}

/**
 * Sends contents as a new immutable Submission Revision of the Task's one
 * Submission in the Enrollment (ADR 0002). Only the learner may send, and only
 * with current Access: active Enrollment and either ordinary ALL prerequisite
 * Mastery/pinned Enrollment-local XP gates or an active Skill Access Override.
 *
 * Integration lock contract: sends and future Review/Approval Revocation or
 * lifecycle mutators lock the Enrollment FOR UPDATE before reading/changing
 * progression, retaining it through commit. Lock Enrollment before Submission.
 * Competing sends converge on one Submission and supersede only undecided
 * revisions. The result is returned only after the transaction commits.
 */
export async function sendRevision(db: Database, enrollmentId: string, taskId: string, accountId: string, contents: SubmissionContents): Promise<SubmissionResult<SentRevision>> {
  return db.transaction(async (tx) => {
    const context = await taskContext(tx, enrollmentId, taskId, accountId)
    if (!context.ok) return context
    if (context.role !== 'learner') return { ok: false, refusal: 'learner_only' }

    // Serialize progression evidence with sends, including sends to different Tasks.
    const [enrollment] = await tx.select().from(enrollments)
      .where(eq(enrollments.id, enrollmentId)).for('update')
    if (enrollment.status !== 'active') return { ok: false, refusal: 'enrollment_inactive' }
    if (!await hasSkillAccess(tx, enrollmentId, enrollment.learningPathVersionId, taskId, context.ownerId)) {
      return { ok: false, refusal: 'skill_locked' }
    }

    const [inserted] = await tx.insert(submissions)
      .values({ enrollmentId, learningPathVersionId: context.enrollment.learningPathVersionId, taskId })
      .onConflictDoNothing({ target: [submissions.enrollmentId, submissions.taskId] })
      .returning()
    // Lock the Submission so revision numbers and supersession follow one order.
    const [submission] = await tx.select().from(submissions)
      .where(and(eq(submissions.enrollmentId, enrollmentId), eq(submissions.taskId, taskId))).for('update')

    const [{ latest }] = await tx.select({ latest: max(submissionRevisions.revisionNumber) }).from(submissionRevisions)
      .where(eq(submissionRevisions.submissionId, submission.id))
    await tx.update(submissionRevisions).set({ supersededAt: sql`now()` })
      .where(and(eq(submissionRevisions.submissionId, submission.id), isNull(submissionRevisions.supersededAt),
        notExists(tx.select({ id: submissionReviews.revisionId }).from(submissionReviews)
          .where(eq(submissionReviews.revisionId, submissionRevisions.id)))))
    const [revision] = await tx.insert(submissionRevisions)
      .values({ submissionId: submission.id, revisionNumber: (latest ?? 0) + 1, ...contents })
      .returning()
    return { ok: true, value: { submission, revision, createdSubmission: Boolean(inserted) } }
  })
}

/**
 * Reads the Task's Submission with every sent revision, for the learner and the
 * owning Coach only (ADR 0013). Draft contents are never part of it. The shared
 * Enrollment lock keeps history coherent with concurrent sends and decisions.
 */
export async function readSubmission(db: Database, enrollmentId: string, taskId: string, accountId: string): Promise<SubmissionResult<SubmissionView>> {
  return db.transaction(async (tx) => {
    const context = await taskContext(tx, enrollmentId, taskId, accountId)
    if (!context.ok) return context
    await tx.select().from(enrollments).where(eq(enrollments.id, enrollmentId)).for('update')
    const [submission] = await tx.select().from(submissions)
      .where(and(eq(submissions.enrollmentId, enrollmentId), eq(submissions.taskId, taskId)))
    if (!submission) return { ok: false, refusal: 'submission_not_found' }
    const revisions = await tx.select({ revision: submissionRevisions, review: submissionReviews }).from(submissionRevisions)
      .leftJoin(submissionReviews, eq(submissionReviews.revisionId, submissionRevisions.id))
      .where(eq(submissionRevisions.submissionId, submission.id)).orderBy(asc(submissionRevisions.revisionNumber))
    return {
      ok: true,
      value: { ...submission, revisions: revisions.map(({ revision, review }): RevisionView => ({
        ...revision,
        status: review ? (review.revokedAt ? 'approval_revoked' : review.decision) : revision.supersededAt ? 'superseded' : 'pending',
        ...(review ? { review } : {}),
      })) },
    }
  })
}
