import { and, asc, eq, type SQL } from 'drizzle-orm'
import type { Database } from './db/client'
import { masteryEvents, submissionRevisions, submissions, xpEvents } from './db/schema'
import { deriveLearningState } from './access'

type State = Awaited<ReturnType<typeof deriveLearningState>>
/** Called under the shared Enrollment lock, in the same transaction as the Review mutation. */
export async function recordTransitions(db: Pick<Database, 'insert' | 'select'>, before: State, after: State, revisionId: string, actorAccountId: string, occurredAt: SQL) {
  for (const task of after.tasks) {
    const previous = before.tasks.find((t) => t.taskId === task.taskId)!
    if (previous.approved !== task.approved) {
      const [prior] = await db.select().from(xpEvents).where(and(eq(xpEvents.enrollmentId, after.enrollmentId), eq(xpEvents.taskId, task.taskId)))
      // Zero-reward evidence changes Mastery but does not fabricate an XP adjustment.
      if (task.xpContribution !== previous.xpContribution) await db.insert(xpEvents).values({
        enrollmentId: after.enrollmentId, learningPathVersionId: after.learningPathVersionId, taskId: task.taskId,
        revisionId, actorAccountId, occurredAt, amount: task.xpContribution - previous.xpContribution,
        kind: task.approved && !prior ? 'award' : 'correction',
      })
    }
  }
  for (const skill of after.skills) {
    const previous = before.skills.find((s) => s.skillId === skill.skillId)!
    if (previous.mastery !== skill.mastery) await db.insert(masteryEvents).values({
      enrollmentId: after.enrollmentId, learningPathVersionId: after.learningPathVersionId, skillId: skill.skillId,
      revisionId, actorAccountId, occurredAt, action: skill.mastery ? 'award' : 'revocation',
    })
  }
}
/**
 * Each event names the revision whose decision or revocation caused it, by number and
 * (for Mastery) Task, so the history explains itself to the learner and the Coach.
 */
export async function readHistory(db: Pick<Database, 'select'>, enrollmentId: string) {
  const cause = { revisionNumber: submissionRevisions.revisionNumber, causeTaskId: submissions.taskId }
  const xpHistory = await db.select({ event: xpEvents, ...cause }).from(xpEvents)
    .innerJoin(submissionRevisions, eq(submissionRevisions.id, xpEvents.revisionId))
    .innerJoin(submissions, eq(submissions.id, submissionRevisions.submissionId))
    .where(eq(xpEvents.enrollmentId, enrollmentId)).orderBy(asc(xpEvents.occurredAt), asc(xpEvents.id))
  const masteryHistory = await db.select({ event: masteryEvents, ...cause }).from(masteryEvents)
    .innerJoin(submissionRevisions, eq(submissionRevisions.id, masteryEvents.revisionId))
    .innerJoin(submissions, eq(submissions.id, submissionRevisions.submissionId))
    .where(eq(masteryEvents.enrollmentId, enrollmentId)).orderBy(asc(masteryEvents.occurredAt), asc(masteryEvents.id))
  return {
    xpHistory: xpHistory.map(({ event, revisionNumber }) => ({ ...event, revisionNumber })),
    masteryHistory: masteryHistory.map(({ event, revisionNumber, causeTaskId }) => ({ ...event, revisionNumber, taskId: causeTaskId })),
  }
}
