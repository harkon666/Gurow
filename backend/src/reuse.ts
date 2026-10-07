import { asc, eq, inArray } from 'drizzle-orm'
import type { Database } from './db/client'
import { coachWorkspaces, learningPaths, learningPathVersions, personalWorkspaces } from './db/schema'

/**
 * Where an author can copy Skills and Tasks from (ADR 0004, 0025; CONTEXT.md: Skill, Task):
 * the content the Account itself authors. That is every Path of its own Personal
 * Workspace (ADR 0012) and, in each Coach Workspace it owns (ADR 0011), every Path's
 * open Draft and published Versions. Nothing of another Account is listed, and an
 * Enrollment gives a learner no source: the Coach's content stays the Coach's.
 *
 * A source is read through the ordinary owner-only reads, and a copy reaches its
 * destination as an ordinary save with new logical IDs; no request copies by itself.
 */
export async function listReuseSources(db: Database, accountId: string) {
  const personal = await db.select({ id: learningPaths.id, title: learningPaths.title }).from(learningPaths)
    .innerJoin(personalWorkspaces, eq(personalWorkspaces.id, learningPaths.personalWorkspaceId))
    .where(eq(personalWorkspaces.ownerAccountId, accountId))
    .orderBy(asc(learningPaths.createdAt), asc(learningPaths.id))

  const workspaces = await db.select().from(coachWorkspaces).where(eq(coachWorkspaces.ownerAccountId, accountId))
    .orderBy(asc(coachWorkspaces.createdAt), asc(coachWorkspaces.id))
  const paths = workspaces.length === 0 ? [] : await db.select({ id: learningPaths.id, coachWorkspaceId: learningPaths.coachWorkspaceId }).from(learningPaths)
    .where(inArray(learningPaths.coachWorkspaceId, workspaces.map((workspace) => workspace.id)))
    .orderBy(asc(learningPaths.createdAt), asc(learningPaths.id))
  const versions = paths.length === 0 ? [] : await db.select().from(learningPathVersions)
    .where(inArray(learningPathVersions.learningPathId, paths.map((path) => path.id)))
    .orderBy(asc(learningPathVersions.versionNumber))

  return {
    personal: personal.map((path) => ({ learningPathId: path.id, title: path.title })),
    coach: workspaces.map((workspace) => ({
      workspace: { id: workspace.id, name: workspace.name },
      learningPaths: paths.filter((path) => path.coachWorkspaceId === workspace.id).map((path) => {
        const own = versions.filter((version) => version.learningPathId === path.id)
        const draft = own.find((version) => !version.publishedAt)
        // A Path is named by its newest Version, the open Draft or else the latest published one.
        return {
          learningPathId: path.id,
          title: own.at(-1)?.title ?? '',
          draft: draft ? { id: draft.id, versionNumber: draft.versionNumber } : null,
          versions: own.filter((version) => version.publishedAt).map((version) => ({ id: version.id, versionNumber: version.versionNumber })),
        }
      }),
    })),
  }
}

export type ReuseSources = Awaited<ReturnType<typeof listReuseSources>>
