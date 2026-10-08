import { describe, expect, it } from 'bun:test'
import type { EnrollmentLearningState, EnrollmentSkillState, OverrideRecord } from '../../lib/api'
import { enrollmentLockReasons, findRecordedOverride, grantOutlook, lastSequence, overrideProblem, overrideRecordText, overrideRefusalMessage, revokeOutlook } from './overrideWork'

const skill = (over: Partial<EnrollmentSkillState> = {}): EnrollmentSkillState => ({
  skillId: 'matrices', title: 'Matrices', learningOutcome: '', optional: false, xpThreshold: 20, mastery: false, access: false, accessOverride: null,
  unmetPrerequisiteSkillIds: ['vectors'], xpShortfall: 20, ...over,
})
const records = (over: Partial<EnrollmentLearningState> = {}): EnrollmentLearningState => ({
  enrollmentId: 'e', learningPathVersionId: 'v', enrollmentStatus: 'active', xp: 0, skills: [], tasks: [],
  xpHistory: [], masteryHistory: [], taskStarts: [], awaitingReview: [], overrideHistory: [], lifecycleHistory: [], taskReviews: [], ...over,
})
const record = (sequence: number, action: 'grant' | 'revoke', reason = 'Prior coursework', over: Partial<OverrideRecord> = {}): OverrideRecord => ({
  id: `o${sequence}`, sequence, enrollmentId: 'e', learningPathVersionId: 'v', skillId: 'matrices', coachAccountId: 'carla', learnerAccountId: 'lena',
  action, grantRecordId: action === 'grant' ? null : 'o1', reason, occurredAt: new Date(Date.UTC(2026, 9, 6, 12, sequence)).toISOString(), ...over,
})
const titles = new Map([['vectors', 'Vectors'], ['matrices', 'Matrices']])
const names = (viewerAccountId: string) => ({ viewerAccountId, coach: { id: 'carla', name: 'carla' }, learner: { name: 'lena', email: 'lena@gurow.test' }, skillTitles: titles })

describe('the Access Override a Coach can record', () => {
  it('requires a brief reason within the recorded limit', () => {
    expect(overrideProblem('')).toContain('needs a brief reason')
    expect(overrideProblem(' \n\t')).toContain('needs a brief reason')
    expect(overrideProblem('x'.repeat(501))).toContain('longer than 500')
    expect(overrideProblem('x'.repeat(500))).toBeNull()
  })

  it('explains refusals without suggesting anything was recorded', () => {
    expect(overrideRefusalMessage('override_already_active')).toContain('already in force (perhaps granted from another tab)')
    expect(overrideRefusalMessage('override_not_active')).toContain('already revoked')
    expect(overrideRefusalMessage('coach_only')).toContain('cannot waive their own requirements')
    expect(overrideRefusalMessage('override_not_found')).toContain('not managed by the signed-in Account')
  })

  it('reconciles a lost answer only with a later record of the same Skill, action and reason', () => {
    const history = [record(1, 'grant'), record(2, 'revoke', 'Back to the route'), record(3, 'grant', 'Prior coursework')]
    const intent = { skillId: 'matrices', action: 'grant' as const, grantRecordId: null, reason: 'Prior coursework', afterSequence: 2 }
    expect(findRecordedOverride(history, intent)?.id).toBe('o3')
    expect(findRecordedOverride(history.slice(0, 2), intent)).toBeNull()
    expect(findRecordedOverride(history, { ...intent, reason: 'Other' })).toBeNull()
    expect(findRecordedOverride(history, { ...intent, skillId: 'vectors' })).toBeNull()
    expect(findRecordedOverride(history, { ...intent, action: 'revoke' })).toBeNull()
    expect(findRecordedOverride(history, { ...intent, grantRecordId: 'o1' })).toBeNull()
    expect(lastSequence(history)).toBe(3)
  })

  it('confirms a lost revocation only by the revocation of the grant it targeted', () => {
    // Grant A is revoked elsewhere for another reason; grant B is then granted and revoked with this request's reason.
    const history = [record(1, 'grant'), record(2, 'revoke', 'Elsewhere', { grantRecordId: 'o1' }), record(3, 'grant'), record(4, 'revoke', 'Back to the route', { grantRecordId: 'o3' })]
    const revokeA = { skillId: 'matrices', action: 'revoke' as const, grantRecordId: 'o1', reason: 'Back to the route', afterSequence: 1 }
    expect(findRecordedOverride(history, revokeA)).toBeNull()
    expect(findRecordedOverride(history, { ...revokeA, grantRecordId: 'o3' })?.id).toBe('o4')
    expect(lastSequence([])).toBe(0)
  })
})

describe('what an Access Override waives and what it leaves alone', () => {
  it('waived requirements are not lock reasons, but inactivity always is', () => {
    expect(enrollmentLockReasons(skill(), records(), titles)).toEqual(['Requires Mastery of “Vectors”', 'Needs 20 more XP: the threshold is 20 XP and this Enrollment has 0 XP'])
    const overridden = skill({ access: false, accessOverride: record(1, 'grant') })
    expect(enrollmentLockReasons(overridden, records({ enrollmentStatus: 'inactive' }), titles)).toEqual(['This Enrollment is inactive: no Skill can be worked on until the Coach reactivates it'])
    expect(enrollmentLockReasons(overridden, records(), titles)).toEqual([])
  })

  it('a grant names exactly what it waives, changes no XP or Mastery, and is not a reactivation', () => {
    const lines = grantOutlook(skill(), records(), titles)
    expect(lines[0]).toBe('For this learner and Skill only, it waives: Requires Mastery of “Vectors”; Needs 20 more XP: the threshold is 20 XP and this Enrollment has 0 XP.')
    expect(lines).toContain('XP and Mastery do not change, and no other Enrollment or learner is affected.')
    expect(lines.join(' ')).not.toContain('reactivate')
    const inactive = grantOutlook(skill(), records({ enrollmentStatus: 'inactive' }), titles)
    expect(inactive.at(-1)).toContain('does not reactivate it, so the learner still cannot start Tasks or send work')
    expect(grantOutlook(skill({ access: true, unmetPrerequisiteSkillIds: [], xpShortfall: 0 }), records(), titles)[0]).toContain('The ordinary rules give Access now')
  })

  it('a revocation returns Access to the ordinary rules and keeps work and progress', () => {
    const lines = revokeOutlook(skill({ access: true, accessOverride: record(1, 'grant') }), records(), titles)
    expect(lines[0]).toBe('Access returns to the ordinary rules, which lock “Matrices” now: Requires Mastery of “Vectors”; Needs 20 more XP: the threshold is 20 XP and this Enrollment has 0 XP.')
    expect(lines[1]).toContain('remains reviewable; drafts, XP and Mastery are kept')
    expect(revokeOutlook(skill({ access: true, unmetPrerequisiteSkillIds: [], xpShortfall: 0 }), records(), titles)[0]).toBe('Access returns to the ordinary rules, which give Access to “Matrices” now.')
  })
})

describe('an Override Record as its readers see it', () => {
  it('names the action, the acting Coach, the target and the reason for both viewers', () => {
    expect(overrideRecordText(record(1, 'grant'), names('carla'))).toEqual({
      action: 'Access Override granted', actor: 'by you (carla)', target: '“Matrices” for lena, in this Enrollment only', reason: 'Reason: Prior coursework',
    })
    expect(overrideRecordText(record(2, 'revoke', 'Back to the route'), names('lena'))).toEqual({
      action: 'Access Override revoked', actor: 'by carla, Coach of this Workspace', target: '“Matrices” for you, in this Enrollment only', reason: 'Reason: Back to the route',
    })
    expect(overrideRecordText(record(3, 'grant', 'x', { coachAccountId: 'someone' }), names('lena')).actor).toBe('by a Coach of this Workspace')
  })
})
