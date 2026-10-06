/**
 * Enrollment participation as its learner and owning Coach stop and resume it (US60–US64,
 * ADR 0014): the learner may deactivate their own Enrollment without a reason; the Coach
 * deactivates or reactivates it with a recorded reason, and only the Coach reactivates.
 * Inactivity stops new Task starts and sends; it removes no work, Review, XP, Mastery or
 * Access Override, and sent work stays reviewable. Only the records the backend returned
 * are shown as recorded.
 */
import type { EnrollmentLearningState, EnrollmentSkillState, LifecycleRecord } from '../../lib/api'
import { ordinaryRequirements, type OverrideNames } from './overrideWork'

/** The longest reason the backend records. */
export const LIFECYCLE_REASON_LIMIT = 500

/** Who changes the Enrollment's status: its learner, or the Coach who owns its Workspace. */
export type LifecycleActor = 'learner' | 'coach'

/** The change due now: an active Enrollment can be deactivated, an inactive one reactivated. */
export const dueAction = (records: EnrollmentLearningState): LifecycleRecord['action'] => records.enrollmentStatus === 'active' ? 'deactivate' : 'reactivate'

/** Whether `actor` may record `action`: anyone of the two may deactivate, only the Coach reactivates. */
export const mayChange = (actor: LifecycleActor, action: LifecycleRecord['action']) => action === 'deactivate' || actor === 'coach'

/** A reason is required of the Coach, for both actions; the learner's own deactivation needs none. */
export const reasonRequired = (actor: LifecycleActor) => actor === 'coach'

/** Why the change cannot be recorded with this reason; null when it can. */
export function lifecycleProblem(actor: LifecycleActor, reason: string): string | null {
  if (reason.length > LIFECYCLE_REASON_LIMIT) return `The reason is longer than ${LIFECYCLE_REASON_LIMIT} characters.`
  if (reasonRequired(actor) && reason.trim() === '') return 'The Coach needs to give a reason; it is recorded with the action, you, the learner and the time, and shown to the learner.'
  return null
}

/** The reason sent: the learner's blank optional reason is no reason at all. */
export const reasonToSend = (reason: string): string | null => reason.trim() === '' ? null : reason

/** What a refused change means; the backend recorded nothing. */
export function lifecycleRefusalMessage(error: string): string {
  switch (error) {
    case 'enrollment_already_inactive': return 'this Enrollment is already inactive (perhaps changed from another tab, or by the other participant)'
    case 'enrollment_already_active': return 'this Enrollment is already active (perhaps reactivated from another tab)'
    case 'coach_only': return 'only the Coach of this Workspace can reactivate an Enrollment, even one its learner deactivated'
    case 'invalid_lifecycle_reason': return `the reason is missing or longer than ${LIFECYCLE_REASON_LIMIT} characters`
    case 'enrollment_not_found': return 'this Enrollment is not available to the signed-in Account'
    case 'unreachable': return 'the backend could not be reached'
    default: return error
  }
}

/**
 * What the Actor asked to record; `afterSequence` is the last record known when asking.
 * A lost answer is confirmed only by a later record of the same action, Actor and reason.
 */
export interface LifecycleIntent { action: LifecycleRecord['action']; actorAccountId: string; reason: string | null; afterSequence: number }

export function findRecordedLifecycle(history: LifecycleRecord[], intent: LifecycleIntent): LifecycleRecord | null {
  return history.find((record) => record.sequence > intent.afterSequence && record.action === intent.action
    && record.actorAccountId === intent.actorAccountId && record.reason === intent.reason) ?? null
}

/** The latest record known, so a later one can be told apart from it. */
export const lastLifecycleSequence = (history: LifecycleRecord[]) => history.reduce((max, record) => Math.max(max, record.sequence), 0)

const revisionsAwaiting = (count: number) => count === 1 ? '1 revision' : `${count} revisions`

/** What deactivating would do, by the rules, for the one deciding to. */
export function deactivateOutlook(actor: LifecycleActor, records: EnrollmentLearningState): string[] {
  const awaiting = records.awaitingReview.length
  if (actor === 'learner') {
    return [
      'You stop participating: no new Task can be started and no work sent in this Enrollment while it is inactive.',
      'Nothing is removed: your submitted work, Reviews, XP and Mastery stay readable by you and your Coach; your unsent drafts stay private to you.',
      awaiting > 0
        ? `Your Coach can still decide the ${revisionsAwaiting(awaiting)} you sent awaiting Review; an Approval still adds XP and Mastery.`
        : 'Work you already sent stays reviewable by your Coach.',
      'Only your Coach can reactivate this Enrollment; accepting an invitation again does not.',
    ]
  }
  return [
    'The learner can no longer start Tasks or send work in this Enrollment.',
    'Nothing is removed: submitted work, Reviews, XP, Mastery and Access Overrides stay; the learner\'s unsent drafts stay private to them.',
    awaiting > 0
      ? `You can still decide the ${revisionsAwaiting(awaiting)} awaiting your Review; an Approval still adds XP and Mastery without reactivating it.`
      : 'Work already sent stays reviewable.',
    'Only you can reactivate it, with a reason; invitations and Access Overrides do not.',
  ]
}

/** A Skill's Access once the Enrollment is active again, by the current rules (its override included). */
export function accessWhenActive(skill: EnrollmentSkillState, records: EnrollmentLearningState, skillTitles: Map<string, string>): string {
  const title = `“${skillTitles.get(skill.skillId) ?? skill.title}”`
  if (skill.accessOverride) return `${title}: open by Coach override`
  const unmet = ordinaryRequirements(skill, records, skillTitles)
  return unmet.length === 0 ? `${title}: open` : `${title}: locked (${unmet.join('; ')})`
}

/** What reactivating would do, by the rules: the same Enrollment and progress, with Access evaluated now. */
export function reactivateOutlook(records: EnrollmentLearningState, versionNumber: number, skillTitles: Map<string, string>): string[] {
  const mastered = records.skills.filter((skill) => skill.mastery).length
  return [
    `The same Enrollment resumes on Version ${versionNumber}, with its ${records.xp} XP, ${mastered} Skill${mastered === 1 ? '' : 's'} mastered and all its work and history.`,
    `Access is evaluated under the current rules: ${records.skills.map((skill) => accessWhenActive(skill, records, skillTitles)).join(', ')}.`,
  ]
}

/** One lifecycle record as the learner and the Coach read it: action, Actor and reason (the time is shown beside it). */
export function lifecycleRecordText(record: LifecycleRecord, names: OverrideNames) {
  const coachName = names.coach.name || 'the Coach'
  const learnerName = names.learner.name || names.learner.email
  const actor = record.actorAccountId === names.viewerAccountId
    ? `you (${record.actorAccountId === record.learnerAccountId ? learnerName : coachName})`
    : record.actorAccountId === record.learnerAccountId ? `${learnerName}, the learner`
      : record.actorAccountId === names.coach.id ? `${coachName}, Coach of this Workspace` : 'a Coach of this Workspace'
  return {
    action: record.action === 'deactivate' ? 'Enrollment deactivated' : 'Enrollment reactivated',
    actor: `by ${actor}`,
    reason: record.reason === null ? 'No reason given (none is needed when the learner stops)' : `Reason: ${record.reason}`,
  }
}
