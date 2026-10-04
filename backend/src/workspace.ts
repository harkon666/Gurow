import { and, asc, eq } from 'drizzle-orm'
import type { Database } from './db/client'
import { accounts, learningPaths, personalWorkspaces } from './db/schema'

/** What the trusted identity says about the acting Account; there is no Coach/Learner type (ADR 0010). */
export async function readAccount(db: Database, accountId: string) {
  const [account] = await db.select({ id: accounts.id, email: accounts.email, name: accounts.name, emailVerified: accounts.emailVerified })
    .from(accounts).where(eq(accounts.id, accountId))
  return account ?? null
}

async function readWorkspace(db: Database, workspace: typeof personalWorkspaces.$inferSelect) {
  const paths = await db.select({ id: learningPaths.id, title: learningPaths.title, goal: learningPaths.goal }).from(learningPaths)
    .where(eq(learningPaths.personalWorkspaceId, workspace.id)).orderBy(asc(learningPaths.createdAt), asc(learningPaths.id))
  return { workspace: { id: workspace.id, createdAt: workspace.createdAt }, learningPaths: paths }
}

/**
 * Enters the Account's one Personal Workspace (ADR 0012), creating it on first entry.
 * The owner's unique key decides concurrent first entries: a losing insert waits for
 * the winner's commit and then reads its row, so every caller gets the same Workspace.
 */
export async function enterPersonalWorkspace(db: Database, accountId: string) {
  const [created] = await db.insert(personalWorkspaces).values({ ownerAccountId: accountId })
    .onConflictDoNothing({ target: personalWorkspaces.ownerAccountId }).returning()
  const workspace = created ?? (await db.select().from(personalWorkspaces).where(eq(personalWorkspaces.ownerAccountId, accountId)))[0]
  return { ...await readWorkspace(db, workspace), created: created !== undefined }
}

/** Reads a Personal Workspace for its owner only; for every other Account it does not exist. */
export async function readPersonalWorkspace(db: Database, workspaceId: string, accountId: string) {
  const [workspace] = await db.select().from(personalWorkspaces)
    .where(and(eq(personalWorkspaces.id, workspaceId), eq(personalWorkspaces.ownerAccountId, accountId)))
  return workspace ? readWorkspace(db, workspace) : null
}
