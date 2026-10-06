/**
 * The owning Coach's Review of one sent revision (ADR 0002, 0003, 0007; US46, US50,
 * US54, US59, US79): Approval or Changes Requested (with mandatory feedback) on exactly
 * the revision the Coach read. A decision counts only once the backend confirms it;
 * XP, Mastery and Access then follow from the backend's derivation, never from here.
 */
import type { ReviewDecision, SubmissionRevisionView } from '../../lib/api'
import { MAX_TEXT_LENGTH } from './submissionWork'

export const DECISION_TEXT: Record<ReviewDecision, string> = { approval: 'Approval', changes_requested: 'Changes Requested' }

/** The revision awaiting a decision: newer sends supersede undecided ones, so there is at most one. */
export const awaitingRevision = (revisions: SubmissionRevisionView[]) => revisions.find((r) => r.status === 'pending') ?? null

/** Revisions whose Approval still counts for the Task (not revoked). */
export const countingApprovals = (revisions: SubmissionRevisionView[]) => revisions.filter((r) => r.status === 'approval').map((r) => r.revisionNumber)

/** Why the decision cannot be recorded as written, in the Coach's terms; null when it can. */
export function reviewProblem(decision: ReviewDecision, feedback: string): string | null {
  if (feedback.length > MAX_TEXT_LENGTH) return `Feedback is longer than ${MAX_TEXT_LENGTH.toLocaleString('en')} characters.`
  if (decision === 'changes_requested' && feedback.trim() === '') return 'Changes Requested needs feedback telling the learner what to correct.'
  return null
}

/** The feedback as sent: blank feedback with an Approval is no feedback. */
export const feedbackOf = (feedback: string) => (feedback.trim() === '' ? null : feedback)

/** What a refused decision means; the backend recorded nothing. */
export function reviewRefusalMessage(error: string, revisionNumber: number): string {
  switch (error) {
    case 'revision_superseded': return `the learner sent a newer revision, which replaced Revision ${revisionNumber} before your decision; a replaced revision can no longer be reviewed`
    case 'revision_already_reviewed': return `Revision ${revisionNumber} already has a decision (perhaps from another tab); a decision is never replaced`
    case 'invalid_review': return 'Changes Requested needs feedback'
    case 'coach_only': return 'only the Coach of this Workspace can review; a learner cannot review their own work'
    case 'revision_not_found':
    case 'enrollment_not_found':
    case 'task_not_found': return 'this revision is not available to the signed-in Account'
    case 'unreachable': return 'the backend could not be reached'
    default: return error
  }
}

/**
 * Whether the history shows the decision a request whose answer was lost tried to
 * record: that revision now has a Review with the same decision.
 */
export function findRecordedDecision(revisions: SubmissionRevisionView[], revisionId: string, decision: ReviewDecision): boolean {
  return revisions.some((r) => r.id === revisionId && r.review?.decision === decision)
}

/** How one revision stands for the Coach deciding on it, so no decision seems to carry over to another revision. */
export function coachRevisionNote(revision: SubmissionRevisionView, revisions: SubmissionRevisionView[]): string {
  const later = revisions.find((r) => r.revisionNumber > revision.revisionNumber)
  const earlier = countingApprovals(revisions).filter((n) => n < revision.revisionNumber)
  switch (revision.status) {
    case 'approval': return 'Approved: counts for the Task, whatever later revisions receive.'
    case 'approval_revoked': return 'Its Approval was revoked and no longer counts.'
    case 'changes_requested': return earlier.length
      ? `Changes requested; the Approval of Revision ${earlier.join(', ')} still counts.`
      : 'Changes requested: the learner can correct it in a new revision.'
    case 'superseded': return `Replaced by Revision ${later?.revisionNumber ?? 'a later one'} before a decision; it can no longer be reviewed.`
    case 'pending': return earlier.length
      ? `Awaiting your Review. It does not inherit the Approval of Revision ${earlier.join(', ')}, which counts whatever you decide here.`
      : 'Awaiting your Review.'
  }
}
