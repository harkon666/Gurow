import { and, eq, sql } from 'drizzle-orm'
import type { Database } from './db/client'
import type { Tx } from './personal'
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

/** What an Invitation offers: exactly one Version of one Path, as that Version states it. */
export interface InvitationOffer {
  invitationId: string
  learningPathVersionId: string
  learningPathTitle: string
  versionNumber: number
  coachWorkspaceName: string
}

export type AcceptResult =
  | { ok: true; enrollment: EnrollmentRecord; created: boolean; offer: InvitationOffer }
  | { ok: false; refusal: EnrollmentRefusal }

const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * The Invitation as its addressee sees it: an unknown Invitation, an unverified
 * Account and another address are refused in that order, before anything about the
 * offer is disclosed. `lock` reads the Version FOR SHARE, so an Enrollment Closure
 * either commits before this acceptance reads it or waits until the acceptance ends.
 */
async function addressedInvitation(tx: Tx, invitationId: string, accountId: string, lock: boolean) {
  const query = tx
    .select({
      id: enrollmentInvitations.id,
      email: enrollmentInvitations.email,
      versionId: learningPathVersions.id,
      versionNumber: learningPathVersions.versionNumber,
      title: learningPathVersions.title,
      publishedAt: learningPathVersions.publishedAt,
      enrollmentClosedAt: learningPathVersions.enrollmentClosedAt,
      workspaceName: coachWorkspaces.name,
      workspaceOwnerId: coachWorkspaces.ownerAccountId,
    })
    .from(enrollmentInvitations)
    .innerJoin(learningPathVersions, eq(learningPathVersions.id, enrollmentInvitations.learningPathVersionId))
    .innerJoin(learningPaths, eq(learningPaths.id, learningPathVersions.learningPathId))
    .innerJoin(coachWorkspaces, eq(coachWorkspaces.id, learningPaths.coachWorkspaceId))
    .where(eq(enrollmentInvitations.id, invitationId))
  const [invitation] = lock ? await query.for('share', { of: learningPathVersions }) : await query
  if (!invitation) return { ok: false, refusal: 'invitation_not_found' } as const

  const [account] = await tx.select().from(accounts).where(eq(accounts.id, accountId))
  if (!account?.emailVerified) return { ok: false, refusal: 'email_not_verified' } as const
  if (!sameEmail(account.email, invitation.email)) return { ok: false, refusal: 'email_mismatch' } as const
  const offer: InvitationOffer = {
    invitationId: invitation.id, learningPathVersionId: invitation.versionId, learningPathTitle: invitation.title,
    versionNumber: invitation.versionNumber, coachWorkspaceName: invitation.workspaceName,
  }
  return { ok: true, invitation, offer } as const
}

const existingEnrollment = async (tx: Pick<Database, 'select'>, accountId: string, versionId: string) =>
  (await tx.select().from(enrollments).where(and(eq(enrollments.accountId, accountId), eq(enrollments.learningPathVersionId, versionId))))[0] ?? null

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
    const addressed = await addressedInvitation(tx, invitationId, accountId, true)
    if (!addressed.ok) return addressed
    const { invitation, offer } = addressed
    if (invitation.workspaceOwnerId === accountId) return { ok: false, refusal: 'owner_cannot_enroll' }

    const markAccepted = () => tx
      .update(enrollmentInvitations)
      .set({ acceptedAt: sql`coalesce(${enrollmentInvitations.acceptedAt}, now())` })
      .where(eq(enrollmentInvitations.id, invitationId))

    const current = await existingEnrollment(tx, accountId, invitation.versionId)
    if (current) {
      await markAccepted()
      return { ok: true, enrollment: current, created: false, offer }
    }
    if (!invitation.publishedAt) return { ok: false, refusal: 'version_not_published' }
    if (invitation.enrollmentClosedAt) return { ok: false, refusal: 'enrollment_closed' }

    const [inserted] = await tx.insert(enrollments)
      .values({ accountId, learningPathVersionId: invitation.versionId })
      .onConflictDoNothing({ target: [enrollments.accountId, enrollments.learningPathVersionId] })
      .returning()
    // A competing acceptance committed first: reuse its Enrollment.
    const enrollment = inserted ?? (await existingEnrollment(tx, accountId, invitation.versionId))!
    await markAccepted()
    return { ok: true, enrollment, created: Boolean(inserted), offer }
  })
}

/**
 * Reads an Invitation for its addressee only (a verified Account with its email):
 * what it offers, and the Account's existing Enrollment in that Version, if any.
 * Whether a new Enrollment would be admitted is decided only by accepting.
 */
export async function readInvitation(db: Database, invitationId: string, accountId: string) {
  return db.transaction(async (tx) => {
    const addressed = await addressedInvitation(tx, invitationId, accountId, false)
    if (!addressed.ok) return addressed
    const enrollment = await existingEnrollment(tx, accountId, addressed.invitation.versionId)
    return { ok: true, offer: addressed.offer, enrollment: enrollment && { id: enrollment.id, status: enrollment.status } } as const
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
