/**
 * A learner's Task Board in one Enrollment (ADR 0027, 0030) shows each Task's review state
 * apart from its column: Done means finished working, never sent or approved. Review state
 * is two separate facts the backend derived from sent revisions only: the newest revision
 * and its own status, and the revisions whose Approval still counts. A newer pending
 * revision does not inherit an earlier Approval and does not hide it either.
 */
import type { EnrollmentLearningState } from '../../lib/api'

export type LatestReview =
  | { kind: 'not-sent' }
  | { kind: 'pending' | 'changes_requested' | 'approval' | 'approval_revoked' | 'superseded'; revisionNumber: number }

export interface TaskReviewState {
  latest: LatestReview
  /** Revisions whose Approval still counts as evidence, oldest first. */
  countingApprovals: number[]
  /** Whether a counting Approval belongs to another revision than the newest one. */
  earlierApprovalCounts: boolean
}

/** The Task's review state as the learning records last read it; null until they are read. */
export function taskReviewState(records: EnrollmentLearningState | null, taskId: string): TaskReviewState | null {
  if (!records) return null
  const summary = records.taskReviews.find((review) => review.taskId === taskId)
  if (!summary) return { latest: { kind: 'not-sent' }, countingApprovals: [], earlierApprovalCounts: false }
  const counting = summary.approvedRevisionNumbers
  return {
    latest: { kind: summary.latestStatus, revisionNumber: summary.latestRevisionNumber },
    countingApprovals: counting,
    earlierApprovalCounts: counting.some((number) => number !== summary.latestRevisionNumber),
  }
}

/** The newest revision's status in the learner's words. */
export function latestReviewText(latest: LatestReview): string {
  switch (latest.kind) {
    case 'not-sent': return 'Not sent for Review'
    case 'pending': return `Revision ${latest.revisionNumber} awaiting Review`
    case 'changes_requested': return `Changes Requested on Revision ${latest.revisionNumber}`
    case 'approval': return `Revision ${latest.revisionNumber} approved`
    case 'approval_revoked': return `Approval of Revision ${latest.revisionNumber} revoked`
    case 'superseded': return `Revision ${latest.revisionNumber} superseded`
  }
}

/** The evidence fact, when an Approval other than the newest revision's still counts; null otherwise. */
export function countingApprovalText(state: TaskReviewState): string | null {
  if (!state.earlierApprovalCounts) return null
  const earlier = state.countingApprovals.filter((number) => state.latest.kind === 'not-sent' || number !== state.latest.revisionNumber)
  return `Approval of Revision ${earlier.join(', ')} still counts`
}
