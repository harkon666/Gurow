import { and, asc, eq, sql } from 'drizzle-orm'
import type { Database } from './db/client'
import { coachWorkspaces, enrollmentInvitations, learningPaths, learningPathVersions } from './db/schema'
import type { InvitationMessage, MailOutcome } from './mail'

/**
 * Enrollment Invitations and Enrollment Closure from the Coach's side (CONTEXT.md;
 * ADR 0005, 0011, 0023). Only the owner of the Version's Coach Workspace invites to,
 * lists invitations of, or closes and reopens a Version; for anyone else the Version
 * does not exist. An Invitation names one published Version and one email address and
 * has no expiry. Its email is delivered after the Invitation is stored, so a failed
 * delivery leaves a valid Invitation the Coach can send again.
 */

/** Delivers one Invitation email, or only logs it without a provider; rejects when the provider did not accept it. */
export type InvitationSender = (message: InvitationMessage) => Promise<MailOutcome>

export const MAX_EMAIL_LENGTH = 254
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The address an Invitation is for: one plausible email, kept as written apart from surrounding spaces. */
export function parseInvitationInput(body: unknown): { ok: true; email: string } | { ok: false; detail: string } {
  const raw = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).email : undefined
  const email = typeof raw === 'string' ? raw.trim() : ''
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || !EMAIL.test(email)) return { ok: false, detail: 'email must be one email address' }
  return { ok: true, email }
}

type Reader = Pick<Database, 'select'>

/** A Version of a Path in a Workspace the Account owns, published or not; otherwise none. */
async function ownedVersion(tx: Reader, versionId: string, accountId: string, lock?: 'update') {
  const query = tx
    .select({ version: learningPathVersions, workspaceName: coachWorkspaces.name })
    .from(learningPathVersions)
    .innerJoin(learningPaths, eq(learningPaths.id, learningPathVersions.learningPathId))
    .innerJoin(coachWorkspaces, eq(coachWorkspaces.id, learningPaths.coachWorkspaceId))
    .where(and(eq(learningPathVersions.id, versionId), eq(coachWorkspaces.ownerAccountId, accountId)))
  const [row] = lock ? await query.for(lock, { of: learningPathVersions }) : await query
  return row ?? null
}

export type InvitationRefusal = 'version_not_found' | 'version_not_published' | 'invitation_not_found'

const invitationView = (row: typeof enrollmentInvitations.$inferSelect) => ({
  id: row.id,
  learningPathVersionId: row.learningPathVersionId,
  email: row.email,
  createdAt: row.createdAt,
  acceptedAt: row.acceptedAt,
  delivery: { status: row.deliveryStatus, attempts: row.deliveryAttempts, deliveredAt: row.deliveredAt },
})
export type InvitationView = ReturnType<typeof invitationView>

/** A Version's admission state and Invitations, newest first, for its owning Coach. */
export async function listInvitations(db: Database, versionId: string, accountId: string) {
  const owned = await ownedVersion(db, versionId, accountId)
  if (!owned?.version.publishedAt) return null
  const rows = await db.select().from(enrollmentInvitations).where(eq(enrollmentInvitations.learningPathVersionId, versionId))
    .orderBy(sql`${enrollmentInvitations.createdAt} desc`, asc(enrollmentInvitations.id))
  return { enrollmentClosed: owned.version.enrollmentClosedAt !== null, invitations: rows.map(invitationView) }
}

/** Stores an Invitation to one published Version of the Coach's own Workspace, before any delivery. */
export async function createInvitation(db: Database, versionId: string, accountId: string, email: string) {
  return db.transaction(async (tx) => {
    const owned = await ownedVersion(tx, versionId, accountId)
    if (!owned) return { ok: false, refusal: 'version_not_found' } as const
    if (!owned.version.publishedAt) return { ok: false, refusal: 'version_not_published' } as const
    const [row] = await tx.insert(enrollmentInvitations).values({ learningPathVersionId: versionId, email, invitedByAccountId: accountId }).returning()
    return { ok: true, invitation: invitationView(row) } as const
  })
}

/** The owner's Invitation, for sending it again; anyone else finds none. */
export async function ownedInvitation(db: Database, invitationId: string, accountId: string) {
  const [row] = await db.select({ invitation: enrollmentInvitations }).from(enrollmentInvitations)
    .innerJoin(learningPathVersions, eq(learningPathVersions.id, enrollmentInvitations.learningPathVersionId))
    .innerJoin(learningPaths, eq(learningPaths.id, learningPathVersions.learningPathId))
    .innerJoin(coachWorkspaces, eq(coachWorkspaces.id, learningPaths.coachWorkspaceId))
    .where(and(eq(enrollmentInvitations.id, invitationId), eq(coachWorkspaces.ownerAccountId, accountId)))
  return row ? invitationView(row.invitation) : null
}

/**
 * Starts one delivery attempt of a stored Invitation and records what became of it:
 * `sent` only when the provider accepted the email, `logged` when no provider is
 * configured, `failed` when it was refused or unreachable. Each attempt has its own
 * number, and so its own idempotency key. Delivery never changes who may accept.
 */
export async function deliverInvitation(db: Database, invitationId: string, send: InvitationSender, link: (invitationId: string) => string) {
  const [claimed] = await db.update(enrollmentInvitations)
    .set({ deliveryAttempts: sql`${enrollmentInvitations.deliveryAttempts} + 1` })
    .where(eq(enrollmentInvitations.id, invitationId)).returning()
  const [offer] = await db.select({ title: learningPathVersions.title, versionNumber: learningPathVersions.versionNumber, workspaceName: coachWorkspaces.name })
    .from(learningPathVersions)
    .innerJoin(learningPaths, eq(learningPaths.id, learningPathVersions.learningPathId))
    .innerJoin(coachWorkspaces, eq(coachWorkspaces.id, learningPaths.coachWorkspaceId))
    .where(eq(learningPathVersions.id, claimed.learningPathVersionId))
  let outcome: MailOutcome | null = null
  let error: string | null = null
  try {
    outcome = await send({
      invitationId, to: claimed.email, link: link(invitationId), attempt: claimed.deliveryAttempts,
      learningPathTitle: offer.title, versionNumber: offer.versionNumber, coachWorkspaceName: offer.workspaceName,
    })
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }
  if (outcome === 'logged') error = 'no email provider is configured, so the email was not sent; its link was only written to the server log'
  const delivered = outcome === 'delivered'
  // A later attempt that already finished owns the recorded outcome.
  const [recorded] = await db.update(enrollmentInvitations)
    .set(delivered ? { deliveryStatus: 'sent', deliveredAt: sql`now()` } : { deliveryStatus: outcome === 'logged' ? 'logged' : 'failed' })
    .where(and(eq(enrollmentInvitations.id, invitationId), eq(enrollmentInvitations.deliveryAttempts, claimed.deliveryAttempts))).returning()
  const [current] = recorded ? [recorded] : await db.select().from(enrollmentInvitations).where(eq(enrollmentInvitations.id, invitationId))
  return { delivered, notConfigured: outcome === 'logged', invitation: invitationView(current), error }
}

/**
 * Closes a published Version to new Enrollments, or reopens it. Existing Enrollments
 * keep their status either way. Repeating the current state changes nothing. The
 * row lock orders it with acceptances, which read the Version FOR SHARE.
 */
export async function setEnrollmentClosure(db: Database, versionId: string, accountId: string, closed: boolean) {
  return db.transaction(async (tx) => {
    const owned = await ownedVersion(tx, versionId, accountId, 'update')
    if (!owned) return { ok: false, refusal: 'version_not_found' } as const
    if (!owned.version.publishedAt) return { ok: false, refusal: 'version_not_published' } as const
    const changed = (owned.version.enrollmentClosedAt !== null) !== closed
    if (changed) {
      await tx.update(learningPathVersions).set({ enrollmentClosedAt: closed ? sql`now()` : null }).where(eq(learningPathVersions.id, versionId))
    }
    return { ok: true, changed, enrollmentClosed: closed } as const
  })
}
