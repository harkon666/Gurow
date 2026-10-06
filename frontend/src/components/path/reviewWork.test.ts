import { describe, expect, it } from 'bun:test'
import type { SubmissionRevisionView } from '../../lib/api'
import { awaitingRevision, coachRevisionNote, countingApprovals, feedbackOf, findRecordedDecision, reviewProblem, reviewRefusalMessage } from './reviewWork'

const revision = (revisionNumber: number, status: SubmissionRevisionView['status'], decision?: 'approval' | 'changes_requested'): SubmissionRevisionView => ({
  id: `r${revisionNumber}`, revisionNumber, text: '', urls: [], sentAt: '', status,
  ...(decision ? { review: { decision, feedback: null, decidedAt: '', revokedAt: null, revocationReason: null } } : {}),
})

describe('the decision a Coach can record', () => {
  it('requires feedback for Changes Requested only', () => {
    expect(reviewProblem('changes_requested', '')).toContain('needs feedback')
    expect(reviewProblem('changes_requested', '   \n')).toContain('needs feedback')
    expect(reviewProblem('changes_requested', 'Show the working.')).toBeNull()
    expect(reviewProblem('approval', '')).toBeNull()
    expect(reviewProblem('approval', 'x'.repeat(50_001))).toContain('longer than')
  })

  it('sends blank feedback as none', () => {
    expect(feedbackOf('  ')).toBeNull()
    expect(feedbackOf('Well argued.')).toBe('Well argued.')
  })

  it('targets the one revision awaiting a decision', () => {
    expect(awaitingRevision([revision(1, 'superseded'), revision(2, 'pending')])?.id).toBe('r2')
    expect(awaitingRevision([revision(1, 'approval', 'approval')])).toBeNull()
  })
})

describe('refused and unconfirmed decisions', () => {
  it('explains a stale decision without suggesting it was recorded', () => {
    expect(reviewRefusalMessage('revision_superseded', 2)).toContain('replaced Revision 2 before your decision')
    expect(reviewRefusalMessage('revision_already_reviewed', 2)).toContain('already has a decision')
    expect(reviewRefusalMessage('coach_only', 2)).toContain('cannot review their own work')
  })

  it('finds a decision whose answer was lost only on the same revision with the same decision', () => {
    const history = [revision(1, 'changes_requested', 'changes_requested'), revision(2, 'approval', 'approval')]
    expect(findRecordedDecision(history, 'r2', 'approval')).toBe(true)
    expect(findRecordedDecision(history, 'r2', 'changes_requested')).toBe(false)
    expect(findRecordedDecision(history, 'r1', 'approval')).toBe(false)
    expect(findRecordedDecision([revision(2, 'pending')], 'r2', 'approval')).toBe(false)
  })
})

describe('how revisions stand for the Coach', () => {
  it('keeps an earlier Approval without passing it to a newer revision', () => {
    const history = [revision(1, 'approval', 'approval'), revision(2, 'pending')]
    expect(countingApprovals(history)).toEqual([1])
    expect(coachRevisionNote(history[1], history)).toBe('Awaiting your Review. It does not inherit the Approval of Revision 1, which counts whatever you decide here.')
    const corrected = [revision(1, 'approval', 'approval'), revision(2, 'changes_requested', 'changes_requested')]
    expect(coachRevisionNote(corrected[1], corrected)).toBe('Changes requested; the Approval of Revision 1 still counts.')
  })

  it('does not count a revoked Approval and names the revision that superseded another', () => {
    const history = [revision(1, 'approval_revoked', 'approval'), revision(2, 'superseded'), revision(3, 'pending')]
    expect(countingApprovals(history)).toEqual([])
    expect(coachRevisionNote(history[2], history)).toBe('Awaiting your Review.')
    expect(coachRevisionNote(history[1], history)).toContain('Replaced by Revision 3')
  })
})
