import { and, asc, eq, type SQL } from 'drizzle-orm'
import type { Database } from './db/client'
import { masteryEvents, xpEvents } from './db/schema'
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
export async function readHistory(db: Pick<Database, 'select'>, enrollmentId: string) {
  return {
    xpHistory: await db.select().from(xpEvents).where(eq(xpEvents.enrollmentId, enrollmentId)).orderBy(asc(xpEvents.occurredAt), asc(xpEvents.id)),
    masteryHistory: await db.select().from(masteryEvents).where(eq(masteryEvents.enrollmentId, enrollmentId)).orderBy(asc(masteryEvents.occurredAt), asc(masteryEvents.id)),
  }
}
