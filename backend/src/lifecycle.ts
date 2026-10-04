import { eq, sql } from 'drizzle-orm'
import type { Database } from './db/client'
import { coachWorkspaces, enrollmentLifecycleRecords, enrollments, learningPaths, learningPathVersions } from './db/schema'

/** Participation transitions share the progression lock through state and audit commit.
 * No learner work, Approval, XP, Mastery or override is changed by this operation.
 */
export async function changeEnrollmentStatus(db: Database, enrollmentId: string, accountId: string, action: 'deactivate' | 'reactivate', reason: string | null) {
  return db.transaction(async (tx) => {
    const [context] = await tx.select({ enrollment: enrollments, ownerId: coachWorkspaces.ownerAccountId }).from(enrollments)
      .innerJoin(learningPathVersions, eq(learningPathVersions.id, enrollments.learningPathVersionId))
      .innerJoin(learningPaths, eq(learningPaths.id, learningPathVersions.learningPathId))
      .innerJoin(coachWorkspaces, eq(coachWorkspaces.id, learningPaths.coachWorkspaceId))
      .where(eq(enrollments.id, enrollmentId))
    if (!context || (context.ownerId !== accountId && context.enrollment.accountId !== accountId)) return { ok: false, refusal: 'enrollment_not_found' } as const
    if (action === 'reactivate' && context.ownerId !== accountId) return { ok: false, refusal: 'coach_only' } as const
    if (reason === null && context.ownerId === accountId) return { ok: false, refusal: 'invalid_lifecycle_reason' } as const
    const [current] = await tx.select().from(enrollments).where(eq(enrollments.id, enrollmentId)).for('update')
    const status = action === 'deactivate' ? 'inactive' : 'active'
    if (current.status === status) return { ok: false, refusal: 'enrollment_already_' + status } as const
    const [enrollment] = await tx.update(enrollments).set({ status }).where(eq(enrollments.id, enrollmentId)).returning()
    const [lifecycleRecord] = await tx.insert(enrollmentLifecycleRecords).values({ enrollmentId, learningPathVersionId: enrollment.learningPathVersionId, learnerAccountId: enrollment.accountId, actorAccountId: accountId, action, reason, occurredAt: sql`clock_timestamp()` }).returning()
    return { ok: true, enrollment, lifecycleRecord } as const
  })
}
