import { describe, expect, it } from 'bun:test'
import type { EnrollmentLearningState, EnrollmentSkillState, LifecycleRecord, OverrideRecord } from '../../lib/api'
import {
  deactivateOutlook, dueAction, findRecordedLifecycle, lastLifecycleSequence, lifecycleProblem, lifecycleRecordText,
  lifecycleRefusalMessage, mayChange, reactivateOutlook, reasonToSend,
} from './lifecycleWork'

const skill = (skillId: string, over: Partial<EnrollmentSkillState> = {}): EnrollmentSkillState => ({
  skillId, title: skillId, learningOutcome: '', optional: false, xpThreshold: 0, mastery: false, access: false, accessOverride: null,
  unmetPrerequisiteSkillIds: [], xpShortfall: 0, ...over,
})
const records = (over: Partial<EnrollmentLearningState> = {}): EnrollmentLearningState => ({
  enrollmentId: 'e', learningPathVersionId: 'v', enrollmentStatus: 'inactive', xp: 20,
  skills: [skill('vectors', { mastery: true }), skill('matrices', { unmetPrerequisiteSkillIds: ['vectors'], xpThreshold: 40, xpShortfall: 20 })], tasks: [],
  xpHistory: [], masteryHistory: [], taskStarts: [], awaitingReview: [], overrideHistory: [], lifecycleHistory: [], ...over,
})
const record = (sequence: number, action: LifecycleRecord['action'], actorAccountId: string, reason: string | null): LifecycleRecord => ({
  id: `l${sequence}`, sequence, enrollmentId: 'e', learningPathVersionId: 'v', actorAccountId, learnerAccountId: 'lena', action, reason,
  occurredAt: new Date(Date.UTC(2026, 9, 6, 12, sequence)).toISOString(),
})
const titles = new Map([['vectors', 'Vectors'], ['matrices', 'Matrices']])
const names = (viewerAccountId: string) => ({ viewerAccountId, coach: { id: 'carla', name: 'carla' }, learner: { name: 'lena', email: 'lena@gurow.test' }, skillTitles: titles })

describe('who may stop and resume participation', () => {
  it('lets either participant deactivate but only the Coach reactivate', () => {
    expect(mayChange('learner', 'deactivate')).toBe(true)
    expect(mayChange('coach', 'deactivate')).toBe(true)
    expect(mayChange('coach', 'reactivate')).toBe(true)
    expect(mayChange('learner', 'reactivate')).toBe(false)
    expect(dueAction(records({ enrollmentStatus: 'active' }))).toBe('deactivate')
    expect(dueAction(records())).toBe('reactivate')
  })

  it('needs no reason from the learner and a reason from the Coach, within the recorded limit', () => {
    expect(lifecycleProblem('learner', '')).toBeNull()
    expect(lifecycleProblem('learner', '  ')).toBeNull()
    expect(reasonToSend('  ')).toBeNull()
    expect(reasonToSend('Moving abroad')).toBe('Moving abroad')
    expect(lifecycleProblem('coach', '')).toContain('needs to give a reason')
    expect(lifecycleProblem('coach', ' \n')).toContain('needs to give a reason')
    expect(lifecycleProblem('coach', 'Paused for exams')).toBeNull()
    expect(lifecycleProblem('learner', 'x'.repeat(501))).toContain('longer than 500')
    expect(lifecycleProblem('coach', 'x'.repeat(500))).toBeNull()
  })

  it('explains refusals without suggesting anything was recorded', () => {
    expect(lifecycleRefusalMessage('coach_only')).toContain('only the Coach of this Workspace can reactivate')
    expect(lifecycleRefusalMessage('enrollment_already_inactive')).toContain('already inactive')
    expect(lifecycleRefusalMessage('enrollment_already_active')).toContain('already active')
    expect(lifecycleRefusalMessage('enrollment_not_found')).toContain('not available to the signed-in Account')
  })
})

describe('what a change of participation does', () => {
  it('tells the learner what stops, what stays private or readable, and who resumes it', () => {
    const lines = deactivateOutlook('learner', records({ enrollmentStatus: 'active', awaitingReview: [{ taskId: 't', revisionId: 'r', revisionNumber: 1, sentAt: '' }] }))
    expect(lines).toContain('You stop participating: no new Task can be started and no work sent in this Enrollment while it is inactive.')
    expect(lines.join(' ')).toContain('your unsent drafts stay private to you')
    expect(lines.join(' ')).toContain('Your Coach can still decide the 1 revision you sent awaiting Review')
    expect(lines.join(' ')).toContain('Only your Coach can reactivate this Enrollment; accepting an invitation again does not.')
  })

  it('tells the Coach that pending work stays decidable and only they resume it', () => {
    const lines = deactivateOutlook('coach', records({ enrollmentStatus: 'active', awaitingReview: [{ taskId: 't', revisionId: 'r', revisionNumber: 1, sentAt: '' }, { taskId: 'u', revisionId: 's', revisionNumber: 2, sentAt: '' }] })).join(' ')
    expect(lines).toContain('You can still decide the 2 revisions awaiting your Review; an Approval still adds XP and Mastery without reactivating it.')
    expect(lines).toContain('invitations and Access Overrides do not')
  })

  it('names the retained Version and progress and each Skill\'s Access under the current rules', () => {
    const grant: OverrideRecord = { id: 'o1', sequence: 1, enrollmentId: 'e', learningPathVersionId: 'v', skillId: 'matrices', coachAccountId: 'carla', learnerAccountId: 'lena', action: 'grant', grantRecordId: null, reason: 'Prior coursework', occurredAt: '' }
    const plain = reactivateOutlook(records(), 1, titles)
    expect(plain[0]).toBe('The same Enrollment resumes on Version 1, with its 20 XP, 1 Skill mastered and all its work and history.')
    expect(plain[1]).toBe('Access is evaluated under the current rules: “Vectors”: open, “Matrices”: locked (Requires Mastery of “Vectors”; Needs 20 more XP: the threshold is 40 XP and this Enrollment has 20 XP).')
    const overridden = records()
    overridden.skills[1] = { ...overridden.skills[1], accessOverride: grant }
    expect(reactivateOutlook(overridden, 1, titles)[1]).toContain('“Matrices”: open by Coach override')
  })
})

describe('the participation records', () => {
  it('reconciles a lost answer only with a later record of the same action, Actor and reason', () => {
    const history = [record(1, 'deactivate', 'lena', null), record(2, 'reactivate', 'carla', 'Back after exams'), record(3, 'deactivate', 'carla', 'Paused')]
    const intent = { action: 'deactivate' as const, actorAccountId: 'carla', reason: 'Paused', afterSequence: 2 }
    expect(findRecordedLifecycle(history, intent)?.id).toBe('l3')
    expect(findRecordedLifecycle(history, { ...intent, afterSequence: 3 })).toBeNull()
    expect(findRecordedLifecycle(history, { ...intent, reason: 'Other' })).toBeNull()
    // The learner's own deactivation is not the Coach's, even without reasons to tell them apart.
    expect(findRecordedLifecycle(history, { action: 'deactivate', actorAccountId: 'carla', reason: null, afterSequence: 0 })).toBeNull()
    expect(findRecordedLifecycle(history, { action: 'deactivate', actorAccountId: 'lena', reason: null, afterSequence: 0 })?.id).toBe('l1')
    expect(lastLifecycleSequence(history)).toBe(3)
    expect(lastLifecycleSequence([])).toBe(0)
  })

  it('names the action, Actor and reason for each reader', () => {
    const own = record(1, 'deactivate', 'lena', null)
    expect(lifecycleRecordText(own, names('lena'))).toEqual({ action: 'Enrollment deactivated', actor: 'by you (lena)', reason: 'No reason given (none is needed when the learner stops)' })
    expect(lifecycleRecordText(own, names('carla')).actor).toBe('by lena, the learner')
    const resumed = record(2, 'reactivate', 'carla', 'Back after exams')
    expect(lifecycleRecordText(resumed, names('carla'))).toEqual({ action: 'Enrollment reactivated', actor: 'by you (carla)', reason: 'Reason: Back after exams' })
    expect(lifecycleRecordText(resumed, names('lena')).actor).toBe('by carla, Coach of this Workspace')
  })
})
