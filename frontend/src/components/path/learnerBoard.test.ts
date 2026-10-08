import { describe, expect, it } from 'bun:test'
import type { EnrollmentLearningState, TaskReviewSummary } from '../../lib/api'
import { countingApprovalText, latestReviewText, taskReviewState } from './learnerBoard'

const records = (taskReviews: TaskReviewSummary[]): EnrollmentLearningState => ({
  enrollmentId: 'e', learningPathVersionId: 'v', enrollmentStatus: 'active', xp: 0, skills: [], tasks: [],
  xpHistory: [], masteryHistory: [], taskStarts: [], awaitingReview: [], overrideHistory: [], lifecycleHistory: [], taskReviews,
})
const summary = (latestRevisionNumber: number, latestStatus: TaskReviewSummary['latestStatus'], approvedRevisionNumbers: number[] = []): TaskReviewSummary =>
  ({ taskId: 't', sentRevisions: latestRevisionNumber, latestRevisionNumber, latestStatus, approvedRevisionNumbers })
const describeState = (reviews: TaskReviewSummary[]) => {
  const state = taskReviewState(records(reviews), 't')!
  return [latestReviewText(state.latest), countingApprovalText(state)]
}

describe('UX05 learner card review state (AC5)', () => {
  it('is unknown until the records are read, and "not sent" for a Task without a sent revision', () => {
    expect(taskReviewState(null, 't')).toBeNull()
    expect(describeState([])).toEqual(['Not sent for Review', null])
    // Another Task's review never shows here.
    expect(describeState([{ ...summary(1, 'approval', [1]), taskId: 'other' }])).toEqual(['Not sent for Review', null])
  })

  it('names the newest revision\'s own status', () => {
    expect(describeState([summary(1, 'pending')])).toEqual(['Revision 1 awaiting Review', null])
    expect(describeState([summary(1, 'changes_requested')])).toEqual(['Changes Requested on Revision 1', null])
    expect(describeState([summary(2, 'approval', [2])])).toEqual(['Revision 2 approved', null])
    expect(describeState([summary(1, 'approval_revoked')])).toEqual(['Approval of Revision 1 revoked', null])
  })

  it('keeps an earlier still-valid Approval apart from a newer revision that has not inherited it', () => {
    // A newer pending revision: it awaits its own Review, and the earlier Approval still counts.
    const pending = taskReviewState(records([summary(3, 'pending', [2])]), 't')!
    expect(pending).toEqual({ latest: { kind: 'pending', revisionNumber: 3 }, countingApprovals: [2], earlierApprovalCounts: true })
    expect(describeState([summary(3, 'pending', [2])])).toEqual(['Revision 3 awaiting Review', 'Approval of Revision 2 still counts'])
    // Changes Requested on a newer revision does not remove the earlier evidence.
    expect(describeState([summary(3, 'changes_requested', [1, 2])])).toEqual(['Changes Requested on Revision 3', 'Approval of Revision 1, 2 still counts'])
    // The newest Approval revoked while an earlier one still counts.
    expect(describeState([summary(2, 'approval_revoked', [1])])).toEqual(['Approval of Revision 2 revoked', 'Approval of Revision 1 still counts'])
    // Two counting Approvals including the newest: only the earlier one is the extra fact.
    expect(describeState([summary(2, 'approval', [1, 2])])).toEqual(['Revision 2 approved', 'Approval of Revision 1 still counts'])
    // After the last valid Approval is revoked, nothing counts any more.
    expect(describeState([summary(3, 'pending', [])])).toEqual(['Revision 3 awaiting Review', null])
  })
})
