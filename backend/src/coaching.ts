import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { defaultPosition, LIMITS, SNAPSHOT_FORMAT_VERSION, type DocumentInput, type TaskInput } from './authoring'
import type { Database } from './db/client'
import { coachWorkspaces, learningPaths, learningPathVersions, skills, tasks, versionPrerequisites, versionSkillCards, versionSkills, versionTasks } from './db/schema'
import type { Tx } from './personal'

/**
 * Coach Workspaces and Learning Path Drafts (ADR 0005, 0010, 0011). A Workspace has
 * exactly one owning Coach, whose authority covers the Paths inside it and nothing
 * else: every other Account, the Path's future learners included, sees no Workspace,
 * Path or Draft at all. A Draft is the Path's one unpublished Version; its document
 * has the same editor/application split as a personal Path (ADR 0016), and its
 * application payload also carries the Draft's rules: Required or Enrichment Tasks
 * with rewards, Optional Skills and XP Thresholds.
 */

type Parsed<T> = { ok: true; value: T } | { ok: false; detail: string }

/** A Workspace name names it; it must not be blank. */
export function parseWorkspaceInput(body: unknown): Parsed<{ name: string }> {
  const name = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).name : undefined
  if (typeof name !== 'string' || name.trim() === '' || name.length > LIMITS.title) return { ok: false, detail: `name must be 1–${LIMITS.title} characters` }
  return { ok: true, value: { name } }
}

const workspaceSummary = (workspace: typeof coachWorkspaces.$inferSelect) => ({ id: workspace.id, name: workspace.name, createdAt: workspace.createdAt })

/** Creates a Coach Workspace owned by the Account; the owner is its one Coach. */
export async function createCoachWorkspace(db: Database, accountId: string, input: { name: string }) {
  const [workspace] = await db.insert(coachWorkspaces).values({ ownerAccountId: accountId, name: input.name }).returning()
  return workspaceSummary(workspace)
}

/** The Coach Workspaces the Account owns; Workspaces of other Coaches are never listed. */
export async function listCoachWorkspaces(db: Database, accountId: string) {
  const owned = await db.select().from(coachWorkspaces).where(eq(coachWorkspaces.ownerAccountId, accountId)).orderBy(asc(coachWorkspaces.createdAt), asc(coachWorkspaces.id))
  return owned.map(workspaceSummary)
}

async function ownedWorkspace(tx: Pick<Database, 'select'>, workspaceId: string, accountId: string) {
  const [workspace] = await tx.select().from(coachWorkspaces).where(and(eq(coachWorkspaces.id, workspaceId), eq(coachWorkspaces.ownerAccountId, accountId)))
  return workspace ?? null
}

/** A Workspace and its Paths, for its owner only. */
export async function readCoachWorkspace(db: Database, workspaceId: string, accountId: string) {
  const workspace = await ownedWorkspace(db, workspaceId, accountId)
  if (!workspace) return null
  const paths = await db.select({ id: learningPaths.id, title: learningPaths.title, goal: learningPaths.goal }).from(learningPaths)
    .where(eq(learningPaths.coachWorkspaceId, workspace.id)).orderBy(asc(learningPaths.createdAt), asc(learningPaths.id))
  return { workspace: workspaceSummary(workspace), learningPaths: paths }
}

/** Locks a coach-mode Path for the owner of its Workspace; for anyone else there is no Path. */
async function lockOwnedCoachPath(tx: Tx, learningPathId: string, accountId: string) {
  const [path] = await tx.select({ path: learningPaths }).from(learningPaths)
    .innerJoin(coachWorkspaces, eq(coachWorkspaces.id, learningPaths.coachWorkspaceId))
    .where(and(eq(learningPaths.id, learningPathId), eq(coachWorkspaces.ownerAccountId, accountId)))
    .for('update', { of: learningPaths })
  return path?.path ?? null
}

async function openDraft(tx: Pick<Database, 'select'>, learningPathId: string) {
  const [draft] = await tx.select().from(learningPathVersions).where(and(eq(learningPathVersions.learningPathId, learningPathId), isNull(learningPathVersions.publishedAt)))
  return draft ?? null
}

/** Reads the Path with its open Draft as one document. */
async function readDocument(tx: Tx, path: typeof learningPaths.$inferSelect) {
  const draft = await openDraft(tx, path.id)
  const skillRows = draft ? await tx.select().from(versionSkills).where(eq(versionSkills.learningPathVersionId, draft.id)).orderBy(asc(versionSkills.ordinal), asc(versionSkills.skillId)) : []
  const taskRows = draft ? await tx.select().from(versionTasks).where(eq(versionTasks.learningPathVersionId, draft.id)).orderBy(asc(versionTasks.ordinal), asc(versionTasks.taskId)) : []
  const cards = new Map(draft ? (await tx.select().from(versionSkillCards).where(eq(versionSkillCards.learningPathVersionId, draft.id))).map((card) => [card.skillId, card]) : [])
  const connections = draft ? await tx.select({ from_id: versionPrerequisites.prerequisiteSkillId, to_id: versionPrerequisites.skillId }).from(versionPrerequisites)
    .where(eq(versionPrerequisites.learningPathVersionId, draft.id)).orderBy(asc(versionPrerequisites.prerequisiteSkillId), asc(versionPrerequisites.skillId)) : []
  return {
    learningPath: { id: path.id, coachWorkspaceId: path.coachWorkspaceId!, title: path.title, goal: path.goal, revision: path.revision },
    draft: draft ? { id: draft.id, versionNumber: draft.versionNumber } : null,
    editor: {
      format_version: SNAPSHOT_FORMAT_VERSION,
      cards: skillRows.map((skill, index) => {
        const card = cards.get(skill.skillId)
        return { id: skill.skillId, title: skill.title, position: card ? { x: card.x, y: card.y } : defaultPosition(index) }
      }),
      connections,
    },
    application: {
      skills: skillRows.map((skill) => ({
        id: skill.skillId, title: skill.title, outcome: skill.learningOutcome, optional: skill.optional, xpThreshold: skill.xpThreshold,
        tasks: taskRows.filter((task) => task.skillId === skill.skillId)
          .map((task) => ({ id: task.taskId, title: task.title, description: task.description, required: task.required, xpReward: task.xpReward })),
      })),
    },
  }
}

export type CoachPathDocument = Awaited<ReturnType<typeof readDocument>>

/** Creates a Path in the owner's Workspace together with its first Draft (Version 1, unpublished). */
export async function createCoachPath(db: Database, workspaceId: string, accountId: string, input: { title: string; goal: string }) {
  return db.transaction(async (tx) => {
    const workspace = await ownedWorkspace(tx, workspaceId, accountId)
    if (!workspace) return null
    const [path] = await tx.insert(learningPaths).values({ coachWorkspaceId: workspace.id, title: input.title, goal: input.goal }).returning()
    await tx.insert(learningPathVersions).values({ learningPathId: path.id, versionNumber: 1 })
    return readDocument(tx, path)
  })
}

export async function readCoachPath(db: Database, learningPathId: string, accountId: string) {
  return db.transaction(async (tx) => {
    const path = await lockOwnedCoachPath(tx, learningPathId, accountId)
    return path ? readDocument(tx, path) : null
  })
}

export type DraftRefusal =
  | 'learning_path_not_found' | 'no_open_draft' | 'stale_revision' | 'skill_owned_elsewhere' | 'task_owned_elsewhere'
  | 'task_skill_mismatch' | 'skill_missing' | 'task_missing'
type SaveResult = { ok: true; document: CoachPathDocument } | { ok: false; refusal: DraftRefusal; detail: string; current?: CoachPathDocument }

class Refused extends Error {
  constructor(readonly refusal: DraftRefusal, readonly detail: string) { super(detail) }
}

/**
 * Saves the owner's whole Draft document if it was based on the current revision
 * (ADR 0016). Under the Path lock, a stale save writes nothing and returns the
 * accepted document. Skill and Task logical IDs are claimed for this Path only
 * (ADR 0004); an ID owned by another Path, or a Task under another Skill, refuses
 * the whole save. Only the open Draft is written: a published Version never is.
 */
export async function saveCoachDraft(db: Database, learningPathId: string, accountId: string, input: DocumentInput): Promise<SaveResult> {
  try {
    return await db.transaction(async (tx) => {
      const path = await lockOwnedCoachPath(tx, learningPathId, accountId)
      if (!path) return { ok: false, refusal: 'learning_path_not_found', detail: 'no such Path' } as const
      if (path.revision !== input.expectedRevision) {
        return { ok: false, refusal: 'stale_revision', detail: `the save was based on revision ${input.expectedRevision}, but revision ${path.revision} is accepted`, current: await readDocument(tx, path) } as const
      }
      const draft = await openDraft(tx, path.id)
      if (!draft) return { ok: false, refusal: 'no_open_draft', detail: 'this Path has no open Draft' } as const
      const changed = await writeDraft(tx, path, draft.id, input)
      if (!changed && input.title === path.title && input.goal === path.goal) return { ok: true, document: await readDocument(tx, path) } as const
      const [saved] = await tx.update(learningPaths).set({ title: input.title, goal: input.goal, revision: sql`${learningPaths.revision} + 1` })
        .where(eq(learningPaths.id, path.id)).returning()
      return { ok: true, document: await readDocument(tx, saved) } as const
    })
  } catch (error) {
    if (error instanceof Refused) return { ok: false, refusal: error.refusal, detail: error.detail }
    throw error
  }
}

/**
 * Claims new logical IDs for this Path. An ID already known is accepted only when
 * it is this Path's own Skill (or a Task of the same Skill), e.g. from an earlier
 * Version; otherwise the save is refused.
 */
async function claimIdentities(tx: Tx, pathId: string, newSkillIds: string[], newTasks: (TaskInput & { skillId: string })[]) {
  if (newSkillIds.length > 0) {
    await tx.insert(skills).values(newSkillIds.map((id) => ({ id, learningPathId: pathId }))).onConflictDoNothing()
    const known = await tx.select().from(skills).where(inArray(skills.id, newSkillIds))
    const foreign = known.find((row) => row.learningPathId !== pathId)
    if (foreign) throw new Refused('skill_owned_elsewhere', `Skill ${foreign.id} belongs to another Learning Path`)
  }
  if (newTasks.length > 0) {
    await tx.insert(tasks).values(newTasks.map((task) => ({ id: task.id, skillId: task.skillId }))).onConflictDoNothing()
    const known = new Map((await tx.select({ id: tasks.id, skillId: tasks.skillId, pathId: skills.learningPathId }).from(tasks)
      .innerJoin(skills, eq(skills.id, tasks.skillId)).where(inArray(tasks.id, newTasks.map((task) => task.id)))).map((row) => [row.id, row]))
    for (const task of newTasks) {
      const row = known.get(task.id)!
      if (row.pathId !== pathId) throw new Refused('task_owned_elsewhere', `Task ${task.id} belongs to another Skill`)
      if (row.skillId !== task.skillId) throw new Refused('task_skill_mismatch', `Task ${task.id} belongs to another Skill`)
    }
  }
}

/** Writes the difference between the stored and the sent Draft; returns whether there was any. */
async function writeDraft(tx: Tx, path: typeof learningPaths.$inferSelect, draftId: string, input: DocumentInput) {
  let changed = false
  const existingSkills = new Map((await tx.select().from(versionSkills).where(eq(versionSkills.learningPathVersionId, draftId))).map((row) => [row.skillId, row]))
  const existingTasks = new Map((await tx.select().from(versionTasks).where(eq(versionTasks.learningPathVersionId, draftId))).map((row) => [row.taskId, row]))
  const sentSkills = new Set(input.application.skills.map((skill) => skill.id))
  const sentTasks = new Set(input.application.skills.flatMap((skill) => skill.tasks.map((task) => task.id)))
  for (const id of existingSkills.keys()) if (!sentSkills.has(id)) throw new Refused('skill_missing', `Skill ${id} is missing; removing Skills is not supported yet`)
  for (const id of existingTasks.keys()) if (!sentTasks.has(id)) throw new Refused('task_missing', `Task ${id} is missing; removing Tasks is not supported yet`)

  const newSkills = input.application.skills.filter((skill) => !existingSkills.has(skill.id))
  const newTasks: (TaskInput & { skillId: string; ordinal: number })[] = []
  for (const skill of input.application.skills) {
    for (const [ordinal, task] of skill.tasks.entries()) {
      const row = existingTasks.get(task.id)
      if (!row) newTasks.push({ ...task, skillId: skill.id, ordinal })
      else if (row.skillId !== skill.id) throw new Refused('task_skill_mismatch', `Task ${task.id} belongs to another Skill`)
    }
  }
  await claimIdentities(tx, path.id, newSkills.map((skill) => skill.id), newTasks)

  for (const [ordinal, skill] of input.application.skills.entries()) {
    const values = { title: skill.title, learningOutcome: skill.outcome, optional: skill.optional!, xpThreshold: skill.xpThreshold!, ordinal }
    const row = existingSkills.get(skill.id)
    if (!row) {
      changed = true
      await tx.insert(versionSkills).values({ learningPathVersionId: draftId, skillId: skill.id, ...values })
    } else if (row.title !== values.title || row.learningOutcome !== values.learningOutcome || row.optional !== values.optional || row.xpThreshold !== values.xpThreshold || row.ordinal !== ordinal) {
      changed = true
      await tx.update(versionSkills).set(values).where(and(eq(versionSkills.learningPathVersionId, draftId), eq(versionSkills.skillId, skill.id)))
    }
  }
  for (const skill of input.application.skills) {
    for (const [ordinal, task] of skill.tasks.entries()) {
      const values = { title: task.title, description: task.description, required: task.required!, xpReward: task.xpReward!, ordinal }
      const row = existingTasks.get(task.id)
      if (!row) {
        changed = true
        await tx.insert(versionTasks).values({ learningPathVersionId: draftId, taskId: task.id, skillId: skill.id, ...values })
      } else if (row.title !== values.title || row.description !== values.description || row.required !== values.required || row.xpReward !== values.xpReward || row.ordinal !== ordinal) {
        changed = true
        await tx.update(versionTasks).set(values).where(and(eq(versionTasks.learningPathVersionId, draftId), eq(versionTasks.taskId, task.id)))
      }
    }
  }

  // This Version's Canvas Layout: one card per Skill, written only where it moved.
  const storedCards = new Map((await tx.select().from(versionSkillCards).where(eq(versionSkillCards.learningPathVersionId, draftId))).map((card) => [card.skillId, card]))
  const movedCards = input.editor.cards.filter((card) => storedCards.get(card.id)?.x !== card.position.x || storedCards.get(card.id)?.y !== card.position.y)
  if (movedCards.length > 0) {
    changed = true
    await tx.insert(versionSkillCards).values(movedCards.map((card) => ({ learningPathVersionId: draftId, skillId: card.id, x: card.position.x, y: card.position.y })))
      .onConflictDoUpdate({ target: [versionSkillCards.learningPathVersionId, versionSkillCards.skillId], set: { x: sql`excluded.x`, y: sql`excluded.y` } })
  }

  // The connections are this Version's Prerequisites, replaced by difference.
  const storedEdges = await tx.select().from(versionPrerequisites).where(eq(versionPrerequisites.learningPathVersionId, draftId))
  const key = (from: string, to: string) => `${from}>${to}`
  const sentEdges = new Set(input.editor.connections.map((edge) => key(edge.from_id, edge.to_id)))
  const storedKeys = new Set(storedEdges.map((edge) => key(edge.prerequisiteSkillId, edge.skillId)))
  for (const edge of storedEdges) {
    if (!sentEdges.has(key(edge.prerequisiteSkillId, edge.skillId))) {
      changed = true
      await tx.delete(versionPrerequisites).where(and(eq(versionPrerequisites.learningPathVersionId, draftId), eq(versionPrerequisites.prerequisiteSkillId, edge.prerequisiteSkillId), eq(versionPrerequisites.skillId, edge.skillId)))
    }
  }
  const addedEdges = input.editor.connections.filter((edge) => !storedKeys.has(key(edge.from_id, edge.to_id)))
  if (addedEdges.length > 0) {
    changed = true
    await tx.insert(versionPrerequisites).values(addedEdges.map((edge) => ({ learningPathVersionId: draftId, prerequisiteSkillId: edge.from_id, skillId: edge.to_id })))
  }
  return changed
}
