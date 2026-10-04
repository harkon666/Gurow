import { and, desc, eq, sql } from 'drizzle-orm'
import type { Database } from './db/client'
import { coachWorkspaces, enrollments, learningPaths, learningPathVersions, overrideRecords, versionSkills } from './db/schema'

/** Override state and its immutable audit are the same durable record stream.
 * Enrollment serialization makes the latest-record check and append atomic with
 * sends, reviews and coherent reads. No XP, Mastery or learner work is mutated.
 */
export async function changeAccessOverride(db: Database, enrollmentId: string, skillId: string, accountId: string, reason: string, grantRecordId: string | null) {
  return db.transaction(async (tx) => {
    const [context] = await tx.select({ enrollment: enrollments, ownerId: coachWorkspaces.ownerAccountId }).from(enrollments)
      .innerJoin(learningPathVersions, eq(learningPathVersions.id, enrollments.learningPathVersionId))
      .innerJoin(learningPaths, eq(learningPaths.id, learningPathVersions.learningPathId))
      .innerJoin(coachWorkspaces, eq(coachWorkspaces.id, learningPaths.coachWorkspaceId))
      .where(eq(enrollments.id, enrollmentId))
    if (!context || (context.ownerId !== accountId && context.enrollment.accountId !== accountId)) return { ok: false, refusal: 'enrollment_not_found' } as const
    if (context.ownerId !== accountId) return { ok: false, refusal: 'coach_only' } as const
    const [enrollment] = await tx.select().from(enrollments).where(eq(enrollments.id, enrollmentId)).for('update')
    const [skill] = await tx.select().from(versionSkills).where(and(eq(versionSkills.learningPathVersionId, enrollment.learningPathVersionId), eq(versionSkills.skillId, skillId)))
    if (!skill) return { ok: false, refusal: 'skill_not_found' } as const
    const [latest] = await tx.select().from(overrideRecords).where(and(eq(overrideRecords.enrollmentId, enrollmentId), eq(overrideRecords.skillId, skillId))).orderBy(desc(overrideRecords.sequence)).limit(1)
    if (grantRecordId === null) {
      if (latest?.action === 'grant') return { ok: false, refusal: 'override_already_active' } as const
    } else {
      // Validate the exact target in this context before revealing its state.
      const [grant] = await tx.select().from(overrideRecords).where(and(eq(overrideRecords.id, grantRecordId), eq(overrideRecords.enrollmentId, enrollmentId), eq(overrideRecords.skillId, skillId), eq(overrideRecords.action, 'grant')))
      if (!grant) return { ok: false, refusal: 'override_not_found' } as const
      if (latest?.id !== grant.id) return { ok: false, refusal: 'override_not_active' } as const
    }
    const [record] = await tx.insert(overrideRecords).values({ enrollmentId, learningPathVersionId: enrollment.learningPathVersionId, skillId, coachAccountId: accountId, learnerAccountId: enrollment.accountId, action: grantRecordId === null ? 'grant' : 'revoke', grantRecordId, reason, occurredAt: sql`clock_timestamp()` }).returning()
    return { ok: true, value: record } as const
  })
}
