import { describe, expect, it } from 'bun:test'
import type { EnrollmentLearningState, EnrollmentSkillState, SubmissionRevisionView } from '../../lib/api'
import { findRecordedRevocation, masteryEventText, revocationEffect, revocationOutlook, revocationProblem, revocationRefusalMessage, xpEventText } from './revocationWork'

const at = (minute: number) => new Date(Date.UTC(2026, 9, 6, 12, minute)).toISOString()
/** Revision n sent at minute n; an Approval decided at `decided`, revoked at `revoked`. */
const approved = (n: number, decided: number, revoked: number | null = null, reason = 'Wrong key'): SubmissionRevisionView => ({
  id: `r${n}`, revisionNumber: n, text: '', urls: [], sentAt: at(n), status: revoked === null ? 'approval' : 'approval_revoked',
  review: { decision: 'approval', feedback: null, decidedAt: at(decided), revokedAt: revoked === null ? null : at(revoked), revocationReason: revoked === null ? null : reason },
})
const changes = (n: number): SubmissionRevisionView => ({
  id: `r${n}`, revisionNumber: n, text: '', urls: [], sentAt: at(n), status: 'changes_requested',
  review: { decision: 'changes_requested', feedback: 'Fix it', decidedAt: at(n + 1), revokedAt: null, revocationReason: null },
})
const skill = (skillId: string, over: Partial<EnrollmentSkillState> = {}): EnrollmentSkillState => ({
  skillId, title: skillId, learningOutcome: '', optional: false, xpThreshold: 0, mastery: false, access: true, accessOverride: null, unmetPrerequisiteSkillIds: [], xpShortfall: 0, ...over,
})
const titles = new Map([['vectors', 'Vectors'], ['matrices', 'Matrices']])
const records = (over: Partial<EnrollmentLearningState> = {}, required = true, xpReward = 20): EnrollmentLearningState => ({
  enrollmentId: 'e', learningPathVersionId: 'v', enrollmentStatus: 'active', xp: 0,
  skills: [skill('vectors'), skill('matrices')],
  tasks: [{ taskId: 'drills', skillId: 'vectors', title: 'Drills', required, xpReward, approved: false, xpContribution: 0 }],
  xpHistory: [], masteryHistory: [], taskStarts: [], awaitingReview: [], overrideHistory: [], lifecycleHistory: [], taskReviews: [], ...over,
})
const xp = (id: number, revisionNumber: number, kind: 'award' | 'correction', amount: number) => ({ id, taskId: 'drills', revisionId: `r${revisionNumber}`, revisionNumber, occurredAt: at(id), kind, amount })
const mastery = (id: number, revisionNumber: number, action: 'award' | 'revocation') => ({ id, skillId: 'vectors', taskId: 'drills', revisionId: `r${revisionNumber}`, revisionNumber, occurredAt: at(id), action })

describe('the revocation a Coach can record', () => {
  it('requires a reason', () => {
    expect(revocationProblem('')).toContain('needs a reason')
    expect(revocationProblem(' \n\t')).toContain('needs a reason')
    expect(revocationProblem('x'.repeat(50_001))).toContain('longer than')
    expect(revocationProblem('Graded against the wrong key.')).toBeNull()
  })

  it('explains refusals without suggesting anything was recorded', () => {
    expect(revocationRefusalMessage('approval_already_revoked', 3)).toContain('already revoked (perhaps from another tab)')
    expect(revocationRefusalMessage('approval_not_found', 3)).toContain('Revision 3 has no Approval of yours')
    expect(revocationRefusalMessage('coach_only', 3)).toContain('cannot correct their own assessment')
  })

  it('finds a revocation whose answer was lost only on the same revision with the same reason', () => {
    const history = [approved(1, 2, 10, 'Wrong key'), approved(3, 4)]
    expect(findRecordedRevocation(history, 'r1', 'Wrong key')).toBe(true)
    expect(findRecordedRevocation(history, 'r1', 'Another reason')).toBe(false)
    expect(findRecordedRevocation(history, 'r3', 'Wrong key')).toBe(false)
  })
})

describe('what revoking would do, for the Coach deciding to', () => {
  const task = { xpReward: 20, required: true, skillTitle: 'Vectors' }
  it('names the other Approvals that keep the contribution', () => {
    const history = [approved(1, 2), changes(3), approved(5, 6)]
    expect(revocationOutlook(history[0], history, task)).toBe('The Approval of Revision 5 also counts, so this Task keeps its 20 XP contribution and its evidence for Mastery of “Vectors”.')
  })
  it('says when it is the last valid Approval, ignoring revoked ones', () => {
    const history = [approved(1, 2, 4), approved(5, 6)]
    expect(revocationOutlook(history[1], history, task)).toBe('This is the Task\'s only valid Approval: revoking it removes its 20 XP and its evidence for Mastery of “Vectors” until another revision is approved.')
    expect(revocationOutlook(history[1], history, { ...task, required: false })).toContain('removes its 20 XP until')
    expect(revocationOutlook(history[1], history, { ...task, required: false, xpReward: 0 })).toContain('no XP reward and is not evidence for Mastery')
  })
})

describe('what a confirmed revocation changed, as read with the history', () => {
  const revoked = (n: number, outcome: SubmissionRevisionView['revocation']) => ({ ...approved(n, n + 1, n + 5), revocation: outcome })
  const kept = { stillCountingRevisionNumbers: [3], xpCorrection: null, masteryRevokedSkillIds: [] }
  const final = { stillCountingRevisionNumbers: [], xpCorrection: -20, masteryRevokedSkillIds: ['vectors'] }

  it('says remaining valid Approvals preserved the contribution and Mastery', () => {
    expect(revocationEffect(revoked(1, kept), 'drills', records(), titles)).toEqual([
      'The Approval of Revision 3 still counted, so this Task kept its 20 XP contribution and its evidence for Mastery of “Vectors”; nothing was corrected.',
    ])
  })

  it('says the final Approval\'s loss corrected XP and Mastery and locked dependents, keeping their own Mastery', () => {
    const state = records({ skills: [skill('vectors'), skill('matrices', { access: false, mastery: true, unmetPrerequisiteSkillIds: ['vectors'], xpShortfall: 20 })] })
    expect(revocationEffect(revoked(1, final), 'drills', state, titles)).toEqual([
      'It was this Task\'s last valid Approval: its 20 XP were removed by an XP Correction.',
      'Mastery of “Vectors” was revoked; its award stays in the Mastery history.',
      '“Matrices” requires Mastery of “Vectors”, so it is locked now; its own Mastery, supported by its own Approvals, stays.',
    ])
  })

  it('trusts the outcome read with the history over records read before the revocation', () => {
    // Records from before the revocation: Vectors still mastered, no correction or Mastery revocation event yet.
    const stale = records({
      xpHistory: [xp(2, 1, 'award', 20)], masteryHistory: [mastery(2, 1, 'award')],
      skills: [skill('vectors', { mastery: true }), skill('matrices', { mastery: true })],
    })
    const lines = revocationEffect(revoked(1, final), 'drills', stale, titles)!
    expect(lines).toEqual([
      'It was this Task\'s last valid Approval: its 20 XP were removed by an XP Correction.',
      'Mastery of “Vectors” was revoked; its award stays in the Mastery history.',
    ])
    expect(lines.join(' ')).not.toContain('no Mastery changed')
  })

  it('does not claim Mastery or XP changes that did not happen', () => {
    expect(revocationEffect(revoked(1, { stillCountingRevisionNumbers: [], xpCorrection: -20, masteryRevokedSkillIds: [] }), 'drills', records({}, false), titles)?.[1])
      .toBe('As an Enrichment Task it was not evidence for Mastery of “Vectors”, which did not change.')
    expect(revocationEffect(revoked(1, { stillCountingRevisionNumbers: [], xpCorrection: null, masteryRevokedSkillIds: [] }), 'drills', records({}, true, 0), titles)).toEqual([
      'It was this Task\'s last valid Approval; the Task has no XP reward, so no XP changed.',
      '“Vectors” was not mastered then, so no Mastery changed.',
    ])
    expect(revocationEffect(approved(1, 2), 'drills', records(), titles)).toBeNull()
    expect(revocationEffect(approved(1, 2, 10), 'drills', records(), titles)).toBeNull()
  })
})

describe('the XP and Mastery history', () => {
  it('names the decision or revocation behind each event, restorations included', () => {
    expect(xpEventText(xp(1, 3, 'award', 20))).toBe('Awarded +20 XP: Approval of Revision 3')
    expect(xpEventText(xp(2, 3, 'correction', -20))).toBe('Corrected −20 XP: the Approval of Revision 3 was revoked')
    expect(xpEventText(xp(3, 7, 'correction', 20))).toBe('Restored +20 XP: Approval of Revision 7')
    expect(masteryEventText(mastery(1, 3, 'award'), 'Vector drills')).toBe('Mastered: Approval of “Vector drills” Revision 3')
    expect(masteryEventText(mastery(2, 3, 'revocation'), 'Vector drills')).toBe('Mastery revoked: the Approval of “Vector drills” Revision 3 was revoked')
  })
})
