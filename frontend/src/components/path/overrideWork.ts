/**
 * Coach Access Overrides as the owning Coach grants and revokes them and both the Coach
 * and the learner read them (US57–US59, US64): an exception for one Skill in one
 * Enrollment that waives its Prerequisites and XP Threshold, never the Enrollment's
 * inactivity, and changes no XP, Mastery or other Enrollment. The Coach supplies only
 * the reason; the action, Coach, learner, Skill and time are recorded by the backend,
 * and only the Override Records it returned are shown as recorded.
 */
import type { EnrollmentLearningState, EnrollmentSkillState, OverrideRecord } from '../../lib/api'

/** The longest reason the backend records. */
export const OVERRIDE_REASON_LIMIT = 500

const quoted = (titles: Map<string, string>, id: string) => `“${titles.get(id) ?? 'an unknown Skill'}”`

/** The ordinary requirements of a Skill unmet now: its Prerequisites' Mastery and its XP Threshold. */
export function ordinaryRequirements(skill: EnrollmentSkillState, records: EnrollmentLearningState, skillTitles: Map<string, string>): string[] {
  const unmet = skill.unmetPrerequisiteSkillIds.map((id) => `Requires Mastery of ${quoted(skillTitles, id)}`)
  if (skill.xpShortfall > 0) unmet.push(`Needs ${skill.xpShortfall} more XP: the threshold is ${skill.xpThreshold} XP and this Enrollment has ${records.xp} XP`)
  return unmet
}

/**
 * Why a Skill is locked now. An inactive Enrollment locks every Skill whatever else
 * holds; requirements waived by an Access Override in force are not reasons.
 */
export function enrollmentLockReasons(skill: EnrollmentSkillState, records: EnrollmentLearningState, skillTitles: Map<string, string>): string[] {
  const reasons: string[] = []
  if (records.enrollmentStatus === 'inactive') reasons.push('This Enrollment is inactive: no Skill can be worked on until the Coach reactivates it')
  if (!skill.accessOverride) reasons.push(...ordinaryRequirements(skill, records, skillTitles))
  return reasons
}

/** Why the override cannot be recorded with this reason; null when it can. */
export function overrideProblem(reason: string): string | null {
  if (reason.length > OVERRIDE_REASON_LIMIT) return `The reason is longer than ${OVERRIDE_REASON_LIMIT} characters.`
  if (reason.trim() === '') return 'An Access Override needs a brief reason; it is recorded with the action, you, the learner, the Skill and the time.'
  return null
}

/** What a refused grant or revocation means; the backend recorded nothing. */
export function overrideRefusalMessage(error: string): string {
  switch (error) {
    case 'override_already_active': return 'an Access Override for this Skill is already in force (perhaps granted from another tab); it is granted once'
    case 'override_not_active': return 'this Access Override was already revoked (perhaps from another tab); it is revoked once'
    case 'invalid_override_reason': return `an Access Override needs a reason of at most ${OVERRIDE_REASON_LIMIT} characters`
    case 'coach_only': return 'only the Coach of this Workspace can grant or revoke an Access Override; a learner cannot waive their own requirements'
    case 'override_not_found':
    case 'skill_not_found':
    case 'enrollment_not_found': return 'this Enrollment or Skill is not managed by the signed-in Account'
    case 'unreachable': return 'the backend could not be reached'
    default: return error
  }
}

/**
 * What the Coach asked to record; `afterSequence` is the last record known when asking.
 * A revocation targets exactly one grant (`grantRecordId`); a grant targets none (null).
 */
export interface OverrideIntent { skillId: string; action: OverrideRecord['action']; grantRecordId: string | null; reason: string; afterSequence: number }

/**
 * The record of a request whose answer was lost, if the history shows it: newer, same
 * Skill, action, reason and, for a revocation, the same grant. Revoking another grant
 * with the same reason is a different operation, never this one's confirmation.
 */
export function findRecordedOverride(history: OverrideRecord[], intent: OverrideIntent): OverrideRecord | null {
  return history.find((record) => record.sequence > intent.afterSequence && record.skillId === intent.skillId && record.action === intent.action
    && record.grantRecordId === intent.grantRecordId && record.reason === intent.reason) ?? null
}

/** The latest record known, so a later one can be told apart from it. */
export const lastSequence = (history: OverrideRecord[]) => history.reduce((max, record) => Math.max(max, record.sequence), 0)

const UNCHANGED = 'XP and Mastery do not change, and no other Enrollment or learner is affected.'
const NOT_REACTIVATION = 'This Enrollment is inactive: an Access Override does not reactivate it, so the learner still cannot start Tasks or send work until the Coach reactivates the Enrollment.'

/** What granting would do, by the rules, for the Coach deciding to. */
export function grantOutlook(skill: EnrollmentSkillState, records: EnrollmentLearningState, skillTitles: Map<string, string>): string[] {
  const waived = ordinaryRequirements(skill, records, skillTitles)
  const lines = [waived.length > 0
    ? `For this learner and Skill only, it waives: ${waived.join('; ')}.`
    : 'The ordinary rules give Access now; the override keeps Access if its Prerequisites or XP Threshold stop being met.', UNCHANGED]
  if (records.enrollmentStatus === 'inactive') lines.push(NOT_REACTIVATION)
  return lines
}

/** What revoking would do, by the rules: Access returns to its ordinary evaluation; work and progress stay. */
export function revokeOutlook(skill: EnrollmentSkillState, records: EnrollmentLearningState, skillTitles: Map<string, string>): string[] {
  const unmet = ordinaryRequirements(skill, records, skillTitles)
  const lines = [unmet.length > 0
    ? `Access returns to the ordinary rules, which lock ${quoted(skillTitles, skill.skillId)} now: ${unmet.join('; ')}.`
    : `Access returns to the ordinary rules, which give Access to ${quoted(skillTitles, skill.skillId)} now.`,
  'Work already sent stays in the history and remains reviewable; drafts, XP and Mastery are kept.']
  if (records.enrollmentStatus === 'inactive') lines.push('The Enrollment stays inactive either way.')
  return lines
}

/** Who and what a record names, for its readers. */
export interface OverrideNames {
  /** The signed-in Account, which reads its own actions as "you". */
  viewerAccountId: string
  coach: { id: string; name: string }
  learner: { name: string; email: string }
  skillTitles: Map<string, string>
}

/** One Override Record as the Coach and the learner read it: action, Actor, target and reason (the time is shown beside it). */
export function overrideRecordText(record: OverrideRecord, names: OverrideNames) {
  const coachName = names.coach.name || 'the Coach'
  const actor = record.coachAccountId === names.viewerAccountId ? `you (${coachName})`
    : record.coachAccountId === names.coach.id ? `${coachName}, Coach of this Workspace` : 'a Coach of this Workspace'
  const learner = record.learnerAccountId === names.viewerAccountId ? 'you' : names.learner.name || names.learner.email
  return {
    action: record.action === 'grant' ? 'Access Override granted' : 'Access Override revoked',
    actor: `by ${actor}`,
    target: `${quoted(names.skillTitles, record.skillId)} for ${learner}, in this Enrollment only`,
    reason: `Reason: ${record.reason}`,
  }
}
