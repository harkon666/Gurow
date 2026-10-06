/**
 * Approval Revocation as the owning Coach makes it and both the Coach and the learner
 * read it (ADR 0003, 0001; US27, US51–US53, US55): the Approval of one revision is
 * withdrawn with a mandatory reason while the original decision stays in the history.
 * Whether the Task's reward and Mastery survive depends on the Approvals still counting;
 * what actually changed is the outcome the backend reads together with the history,
 * never predicted here nor pieced together from records read at another moment.
 */
import type { EnrollmentLearningState, EnrollmentMasteryEvent, EnrollmentXpEvent, SubmissionRevisionView } from '../../lib/api'
import { MAX_TEXT_LENGTH } from './submissionWork'
import { countingApprovals } from './reviewWork'

/** Why the revocation cannot be recorded with this reason; null when it can. */
export function revocationProblem(reason: string): string | null {
  if (reason.length > MAX_TEXT_LENGTH) return `The reason is longer than ${MAX_TEXT_LENGTH.toLocaleString('en')} characters.`
  if (reason.trim() === '') return 'A revocation needs a reason; it is recorded with it and shown to the learner.'
  return null
}

/** What a refused revocation means; the backend recorded nothing. */
export function revocationRefusalMessage(error: string, revisionNumber: number): string {
  switch (error) {
    case 'approval_already_revoked': return `the Approval of Revision ${revisionNumber} was already revoked (perhaps from another tab); a revocation is recorded once`
    case 'approval_not_found': return `Revision ${revisionNumber} has no Approval of yours to revoke`
    case 'invalid_revocation': return 'a revocation needs a reason'
    case 'coach_only': return 'only the Coach of this Workspace can revoke an Approval; a learner cannot correct their own assessment'
    case 'enrollment_not_found':
    case 'task_not_found': return 'this revision is not available to the signed-in Account'
    case 'unreachable': return 'the backend could not be reached'
    default: return error
  }
}

/** Whether the history shows the revocation a request whose answer was lost tried to record. */
export function findRecordedRevocation(revisions: SubmissionRevisionView[], revisionId: string, reason: string): boolean {
  return revisions.some((r) => r.id === revisionId && r.review?.revokedAt != null && r.review.revocationReason === reason)
}

/** The Task as the records describe it: its reward and whether it is evidence for its Skill's Mastery. */
export interface RevocationTask { xpReward: number; required: boolean; skillTitle: string }

const list = (numbers: number[]) => numbers.join(', ')

/**
 * What revoking this Approval would do, by the rules, for the Coach deciding to: the
 * other Approvals counting now keep the Task's contribution, or this is the last one.
 */
export function revocationOutlook(revision: SubmissionRevisionView, revisions: SubmissionRevisionView[], task: RevocationTask): string {
  const others = countingApprovals(revisions).filter((n) => n !== revision.revisionNumber)
  if (others.length > 0) {
    return `The Approval of Revision ${list(others)} also counts, so this Task keeps its ${task.xpReward} XP contribution${task.required ? ` and its evidence for Mastery of “${task.skillTitle}”` : ''}.`
  }
  const removes = [task.xpReward > 0 && `its ${task.xpReward} XP`, task.required && `its evidence for Mastery of “${task.skillTitle}”`].filter(Boolean)
  return removes.length
    ? `This is the Task's only valid Approval: revoking it removes ${removes.join(' and ')} until another revision is approved.`
    : 'This is the Task\'s only valid Approval, but the Task has no XP reward and is not evidence for Mastery.'
}

/**
 * What a confirmed revocation changed, from the outcome the backend read with the
 * history (never inferred from separately read records): kept by the Approvals still
 * counting then, or the last valid Approval's loss corrected the reward and Mastery.
 * Only the Skills now locked for want of that Mastery come from the current records,
 * and are said to be so now. Null when not revoked or the outcome is not read.
 */
export function revocationEffect(revision: SubmissionRevisionView, taskId: string, records: EnrollmentLearningState, skillTitles: Map<string, string>): string[] | null {
  const outcome = revision.revocation
  const task = records.tasks.find((t) => t.taskId === taskId)
  if (!revision.review?.revokedAt || !outcome || !task) return null
  const title = (id: string) => `“${skillTitles.get(id) ?? 'an unknown Skill'}”`
  const others = outcome.stillCountingRevisionNumbers
  if (others.length > 0) {
    return [`The Approval of Revision ${list(others)} still counted, so this Task kept its ${task.xpReward} XP contribution${task.required ? ` and its evidence for Mastery of ${title(task.skillId)}` : ''}; nothing was corrected.`]
  }
  const lines = [
    outcome.xpCorrection !== null ? `It was this Task's last valid Approval: its ${-outcome.xpCorrection} XP were removed by an XP Correction.`
      : task.xpReward === 0 ? 'It was this Task\'s last valid Approval; the Task has no XP reward, so no XP changed.'
        : 'It was this Task\'s last valid Approval; it changed no XP.',
  ]
  if (outcome.masteryRevokedSkillIds.includes(task.skillId)) {
    lines.push(`Mastery of ${title(task.skillId)} was revoked; its award stays in the Mastery history.`)
    for (const skill of records.skills.filter((s) => s.unmetPrerequisiteSkillIds.includes(task.skillId))) {
      const access = skill.access ? 'stays open by an Access Override' : 'is locked now'
      lines.push(`${title(skill.skillId)} requires Mastery of ${title(task.skillId)}, so it ${access}${skill.mastery ? '; its own Mastery, supported by its own Approvals, stays' : ''}.`)
    }
  } else if (!task.required) {
    lines.push(`As an Enrichment Task it was not evidence for Mastery of ${title(task.skillId)}, which did not change.`)
  } else {
    lines.push(`${title(task.skillId)} was not mastered then, so no Mastery changed.`)
  }
  return lines
}

/** One XP event of a Task, named by the decision or revocation that caused it. */
export function xpEventText(event: EnrollmentXpEvent): string {
  const amount = `${event.amount > 0 ? '+' : '−'}${Math.abs(event.amount)} XP`
  if (event.amount < 0) return `Corrected ${amount}: the Approval of Revision ${event.revisionNumber} was revoked`
  return `${event.kind === 'award' ? 'Awarded' : 'Restored'} ${amount}: Approval of Revision ${event.revisionNumber}`
}

/** One Mastery event of a Skill, named by the Task revision whose Approval or revocation caused it. */
export function masteryEventText(event: EnrollmentMasteryEvent, taskTitle: string): string {
  return event.action === 'award'
    ? `Mastered: Approval of “${taskTitle}” Revision ${event.revisionNumber}`
    : `Mastery revoked: the Approval of “${taskTitle}” Revision ${event.revisionNumber} was revoked`
}
