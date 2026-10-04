import { and, eq, sql } from 'drizzle-orm'
import type { Database } from './db/client'
import { accounts, coachWorkspaces, enrollmentInvitations, enrollments, learningPaths, learningPathVersions } from './db/schema'

export type EnrollmentRecord = typeof enrollments.$inferSelect

/** Why an acceptance or read is refused; each maps to one HTTP status at the route. */
export type EnrollmentRefusal =
  | 'invitation_not_found'
  | 'email_not_verified'
  | 'email_mismatch'
  | 'owner_cannot_enroll'
  | 'version_not_published'
  | 'enrollment_closed'
  | 'enrollment_not_found'

export type AcceptResult =
  | { ok: true; enrollment: EnrollmentRecord; created: boolean }
  | { ok: false; refusal: EnrollmentRefusal }

const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * Accepts an Enrollment Invitation for the acting Account (ADR 0005, 0011).
 *
 * The Account's verified email must match the invitation, and the owner of the
 * Version's Coach Workspace cannot enroll there. An existing Enrollment for the
 * Account and Version is returned unchanged (no reset, no reactivation); only a
 * new Enrollment requires a published Version open to Enrollments. Competing
 * acceptances converge on the unique (Account, Version) constraint, and a
 * refusal leaves no Enrollment and no recorded acceptance.
 */
export async function acceptInvitation(db: Database, invitationId: string, accountId: string): Promise<AcceptResult> {
  return db.transaction(async (tx) => {
    const [invitation] = await tx
      .select({
        id: enrollmentInvitations.id,
        email: enrollmentInvitations.email,
        versionId: learningPathVersions.id,
        publishedAt: learningPathVersions.publishedAt,
        enrollmentClosedAt: learningPathVersions.enrollmentClosedAt,
        workspaceOwnerId: coachWorkspaces.ownerAccountId,
      })
      .from(enrollmentInvitations)
      .innerJoin(learningPathVersions, eq(learningPathVersions.id, enrollmentInvitations.learningPathVersionId))
      .innerJoin(learningPaths, eq(learningPaths.id, learningPathVersions.learningPathId))
      .innerJoin(coachWorkspaces, eq(coachWorkspaces.id, learningPaths.coachWorkspaceId))
      .where(eq(enrollmentInvitations.id, invitationId))
    if (!invitation) return { ok: false, refusal: 'invitation_not_found' }

    const [account] = await tx.select().from(accounts).where(eq(accounts.id, accountId))
    if (!account?.emailVerifiedAt) return { ok: false, refusal: 'email_not_verified' }
    if (!sameEmail(account.email, invitation.email)) return { ok: false, refusal: 'email_mismatch' }
    if (invitation.workspaceOwnerId === accountId) return { ok: false, refusal: 'owner_cannot_enroll' }

    const markAccepted = () => tx
      .update(enrollmentInvitations)
      .set({ acceptedAt: sql`coalesce(${enrollmentInvitations.acceptedAt}, now())` })
      .where(eq(enrollmentInvitations.id, invitationId))
    const existing = () => tx.select().from(enrollments)
      .where(and(eq(enrollments.accountId, accountId), eq(enrollments.learningPathVersionId, invitation.versionId)))

    const [current] = await existing()
    if (current) {
      await markAccepted()
      return { ok: true, enrollment: current, created: false }
    }
    if (!invitation.publishedAt) return { ok: false, refusal: 'version_not_published' }
    if (invitation.enrollmentClosedAt) return { ok: false, refusal: 'enrollment_closed' }

    const [inserted] = await tx.insert(enrollments)
      .values({ accountId, learningPathVersionId: invitation.versionId })
      .onConflictDoNothing({ target: [enrollments.accountId, enrollments.learningPathVersionId] })
      .returning()
    // A competing acceptance committed first: reuse its Enrollment.
    const enrollment = inserted ?? (await existing())[0]
    await markAccepted()
    return { ok: true, enrollment, created: Boolean(inserted) }
  })
}

export interface EnrollmentView extends EnrollmentRecord {
  learningPathId: string
  coachWorkspaceId: string
}

/**
 * Reads an Enrollment for its learner or the owning Coach only (ADR 0013).
 * Anyone else, and an unknown ID, gets the same refusal so existence is not disclosed.
 */
export async function readEnrollment(db: Database, enrollmentId: string, accountId: string): Promise<EnrollmentView | null> {
  const [row] = await db
    .select({ enrollment: enrollments, learningPathId: learningPaths.id, coachWorkspaceId: coachWorkspaces.id, ownerId: coachWorkspaces.ownerAccountId })
    .from(enrollments)
    .innerJoin(learningPathVersions, eq(learningPathVersions.id, enrollments.learningPathVersionId))
    .innerJoin(learningPaths, eq(learningPaths.id, learningPathVersions.learningPathId))
    .innerJoin(coachWorkspaces, eq(coachWorkspaces.id, learningPaths.coachWorkspaceId))
    .where(eq(enrollments.id, enrollmentId))
  if (!row || (row.enrollment.accountId !== accountId && row.ownerId !== accountId)) return null
  return { ...row.enrollment, learningPathId: row.learningPathId, coachWorkspaceId: row.coachWorkspaceId }
}
