import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { defaultPosition, LIMITS, SNAPSHOT_FORMAT_VERSION, type DocumentInput, type TaskInput } from './authoring'
import type { Database } from './db/client'
import { coachWorkspaces, learningPaths, learningPathVersions, versionPrerequisites, versionSkillCards, versionSkills, versionTasks } from './db/schema'
import type { Tx } from './personal'
import { checkRequiredRoute, type BlockedSkill } from './publication'
import { claimLogicalIds } from './logicalIds'
import { addDraftCards, deleteDraftBoards, removeDraftCards } from './draftBoardMembership'
import { publishedContent } from './retention'

/**
 * Coach Workspaces and Learning Path Drafts (ADR 0005, 0010, 0011). A Workspace has
 * exactly one owning Coach, whose authority covers the Paths inside it and nothing
 * else: every other Account, the Path's future learners included, sees no Workspace,
 * Path or Draft at all. A Draft is the Path's one unpublished Version; its document
 * has the same editor/application split as a personal Path (ADR 0016), and its
 * application payload also carries the Draft's rules: Required or Enrichment Tasks
 * with rewards, Optional Skills and XP Thresholds. Publishing a Draft whose required
 * route can be completed (ADR 0008) freezes it as a Version; later changes go into a
 * new Draft copied from the latest Version.
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
  const paths = await db.select({ id: learningPaths.id }).from(learningPaths)
    .where(eq(learningPaths.coachWorkspaceId, workspace.id)).orderBy(asc(learningPaths.createdAt), asc(learningPaths.id))
  // Each Path is listed under its newest Version's title and goal: the open Draft's, or else the latest published one's.
  const versions = paths.length === 0 ? [] : await db.select().from(learningPathVersions)
    .where(inArray(learningPathVersions.learningPathId, paths.map((path) => path.id))).orderBy(asc(learningPathVersions.versionNumber))
  const newest = new Map(versions.map((version) => [version.learningPathId, version]))
  return { workspace: workspaceSummary(workspace), learningPaths: paths.map(({ id }) => ({ id, title: newest.get(id)!.title, goal: newest.get(id)!.goal })) }
}

/** Locks a coach-mode Path for the owner of its Workspace; for anyone else there is no Path. */
export async function lockOwnedCoachPath(tx: Tx, learningPathId: string, accountId: string) {
  const [path] = await tx.select({ path: learningPaths }).from(learningPaths)
    .innerJoin(coachWorkspaces, eq(coachWorkspaces.id, learningPaths.coachWorkspaceId))
    .where(and(eq(learningPaths.id, learningPathId), eq(coachWorkspaces.ownerAccountId, accountId)))
    .for('update', { of: learningPaths })
  return path?.path ?? null
}

export async function openDraft(tx: Pick<Database, 'select'>, learningPathId: string) {
  const [draft] = await tx.select().from(learningPathVersions).where(and(eq(learningPathVersions.learningPathId, learningPathId), isNull(learningPathVersions.publishedAt)))
  return draft ?? null
}

type VersionRow = typeof learningPathVersions.$inferSelect

/** One Version's learning content: its Skills with their Tasks, and its Prerequisites. */
async function readContent(tx: Pick<Database, 'select'>, versionId: string) {
  const skillRows = await tx.select().from(versionSkills).where(eq(versionSkills.learningPathVersionId, versionId)).orderBy(asc(versionSkills.ordinal), asc(versionSkills.skillId))
  const taskRows = await tx.select().from(versionTasks).where(eq(versionTasks.learningPathVersionId, versionId)).orderBy(asc(versionTasks.ordinal), asc(versionTasks.taskId))
  const edges = await tx.select().from(versionPrerequisites).where(eq(versionPrerequisites.learningPathVersionId, versionId))
    .orderBy(asc(versionPrerequisites.prerequisiteSkillId), asc(versionPrerequisites.skillId))
  const skills = skillRows.map((skill) => ({
    id: skill.skillId, title: skill.title, outcome: skill.learningOutcome, optional: skill.optional, xpThreshold: skill.xpThreshold,
    tasks: taskRows.filter((task) => task.skillId === skill.skillId)
      .map((task) => ({ id: task.taskId, title: task.title, description: task.description, required: task.required, xpReward: task.xpReward })),
  }))
  return { skills, edges }
}

/**
 * Reads the Path as one document showing one Version's content: `shown` if given,
 * otherwise the open Draft, otherwise the latest published Version. `draft` is the
 * open Draft (the only editable Version) and `versions` the published ones.
 */
async function readDocument(tx: Tx, path: typeof learningPaths.$inferSelect, shown?: VersionRow) {
  const all = await tx.select().from(learningPathVersions).where(eq(learningPathVersions.learningPathId, path.id)).orderBy(asc(learningPathVersions.versionNumber))
  const draft = all.find((version) => version.publishedAt === null) ?? null
  const published = all.filter((version) => version.publishedAt !== null)
  const source = shown ?? draft ?? published.at(-1) ?? null
  return {
    // A coach-mode Path's title and goal are those of the Version shown.
    learningPath: { id: path.id, coachWorkspaceId: path.coachWorkspaceId!, title: source!.title, goal: source!.goal, revision: path.revision },
    draft: draft ? { id: draft.id, versionNumber: draft.versionNumber } : null,
    version: source ? { id: source.id, versionNumber: source.versionNumber, publishedAt: source.publishedAt, layoutRevision: source.layoutRevision } : null,
    versions: published.map((version) => ({ id: version.id, versionNumber: version.versionNumber, publishedAt: version.publishedAt!, enrollmentClosed: version.enrollmentClosedAt !== null })),
    ...(source ? await readVersionContent(tx, source.id) : { editor: { format_version: SNAPSHOT_FORMAT_VERSION, cards: [], connections: [] }, application: { skills: [] } }),
  }
}

/**
 * One Version as a document: its Canvas Layout as it stands now (the editor snapshot)
 * beside its learning content and rules (the application payload).
 */
export async function readVersionContent(tx: Pick<Database, 'select'>, versionId: string) {
  const { skills: skillList, edges } = await readContent(tx, versionId)
  const cards = new Map((await tx.select().from(versionSkillCards).where(eq(versionSkillCards.learningPathVersionId, versionId))).map((card) => [card.skillId, card]))
  return {
    editor: {
      format_version: SNAPSHOT_FORMAT_VERSION,
      cards: skillList.map((skill, index) => {
        const card = cards.get(skill.id)
        return { id: skill.id, title: skill.title, position: card ? { x: card.x, y: card.y } : defaultPosition(index) }
      }),
      connections: edges.map((edge) => ({ from_id: edge.prerequisiteSkillId, to_id: edge.skillId })),
    },
    application: { skills: skillList },
  }
}

export type CoachPathDocument = Awaited<ReturnType<typeof readDocument>>

/** Creates a Path in the owner's Workspace together with its first Draft (Version 1, unpublished). */
export async function createCoachPath(db: Database, workspaceId: string, accountId: string, input: { title: string; goal: string }) {
  return db.transaction(async (tx) => {
    const workspace = await ownedWorkspace(tx, workspaceId, accountId)
    if (!workspace) return null
    const [path] = await tx.insert(learningPaths).values({ coachWorkspaceId: workspace.id, title: input.title, goal: input.goal }).returning()
    await tx.insert(learningPathVersions).values({ learningPathId: path.id, versionNumber: 1, title: input.title, goal: input.goal })
    return readDocument(tx, path)
  })
}

export async function readCoachPath(db: Database, learningPathId: string, accountId: string) {
  return db.transaction(async (tx) => {
    const path = await lockOwnedCoachPath(tx, learningPathId, accountId)
    return path ? readDocument(tx, path) : null
  })
}

/** A published Version of a Path in the Account's Workspace, read-only; for anyone else there is none. */
export async function readCoachVersion(db: Database, versionId: string, accountId: string) {
  return db.transaction(async (tx) => {
    const [version] = await tx.select().from(learningPathVersions).where(eq(learningPathVersions.id, versionId))
    if (!version?.publishedAt) return null
    const path = await lockOwnedCoachPath(tx, version.learningPathId, accountId)
    return path ? readDocument(tx, path, version) : null
  })
}

/** A layout save: card positions only, based on the Version's `layoutRevision`. */
export interface LayoutInput {
  expectedRevision: number
  cards: { id: string; position: { x: number; y: number } }[]
}

const LAYOUT_KEYS = new Set(['expectedRevision', 'cards'])
const CARD_KEYS = new Set(['id', 'position'])

/**
 * Validates a layout save. It carries card positions and nothing else: a body that
 * also names titles, Tasks, connections or anything other than positions is refused
 * as a whole, so no request through this route can be read as a content change.
 */
export function parseLayoutInput(body: unknown): Parsed<LayoutInput> {
  const fail = (detail: string) => ({ ok: false as const, detail })
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return fail('expected expectedRevision and cards')
  const record = body as Record<string, unknown>
  const extra = Object.keys(record).filter((key) => !LAYOUT_KEYS.has(key))
  if (extra.length > 0) return fail(`a layout save carries only expectedRevision and card positions, not ${extra.join(', ')}`)
  const { expectedRevision, cards } = record
  if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return fail('expectedRevision must be a non-negative integer')
  if (!Array.isArray(cards) || cards.length > LIMITS.skills) return fail(`cards must be a list of at most ${LIMITS.skills} positions`)
  const parsed: LayoutInput['cards'] = []
  const seen = new Set<string>()
  for (const card of cards) {
    if (typeof card !== 'object' || card === null || Array.isArray(card)) return fail('every card needs an id and a position')
    const { id, position } = card as Record<string, unknown>
    const cardExtra = Object.keys(card).filter((key) => !CARD_KEYS.has(key))
    if (cardExtra.length > 0) return fail(`a card in a layout save has only an id and a position, not ${cardExtra.join(', ')}`)
    if (typeof id !== 'string' || typeof position !== 'object' || position === null) return fail('every card needs an id and a position')
    const { x, y } = position as Record<string, unknown>
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) ||
      Math.abs(x) > LIMITS.coordinate || Math.abs(y) > LIMITS.coordinate) return fail(`card ${id} is outside the canvas bounds`)
    const key = id.toLowerCase()
    if (seen.has(key)) return fail(`Skill ${id} has more than one card`)
    seen.add(key)
    parsed.push({ id: key, position: { x, y } })
  }
  return { ok: true, value: { expectedRevision, cards: parsed } }
}

export type LayoutRefusal = 'version_not_found' | 'stale_revision' | 'skill_not_in_version'
type LayoutResult = { ok: true; document: CoachPathDocument } | { ok: false; refusal: LayoutRefusal; detail: string; current?: CoachPathDocument }

/**
 * Saves new card positions for a published Version's shared Canvas Layout, for the
 * owning Coach only (ADR 0005, 0016), if the save was based on the Version's current
 * `layoutRevision`. Only the moved cards are written and the layout revision advances;
 * the Version's learning content, the Path's content revision, its other Versions and
 * every Enrollment's records are untouched, and no Version is created. A stale save
 * writes nothing and returns the accepted layout. A Draft is not a published Version:
 * its layout is saved with the Draft.
 */
export async function saveVersionLayout(db: Database, versionId: string, accountId: string, input: LayoutInput): Promise<LayoutResult> {
  return db.transaction(async (tx) => {
    // Locking the Version row serializes layout saves of this Version.
    const [owned] = await tx.select({ version: learningPathVersions, path: learningPaths }).from(learningPathVersions)
      .innerJoin(learningPaths, eq(learningPaths.id, learningPathVersions.learningPathId))
      .innerJoin(coachWorkspaces, eq(coachWorkspaces.id, learningPaths.coachWorkspaceId))
      .where(and(eq(learningPathVersions.id, versionId), eq(coachWorkspaces.ownerAccountId, accountId)))
      .for('update', { of: learningPathVersions })
    if (!owned?.version.publishedAt) return { ok: false, refusal: 'version_not_found', detail: 'no such published Version' } as const
    const { version, path } = owned
    if (version.layoutRevision !== input.expectedRevision) {
      return { ok: false, refusal: 'stale_revision', detail: `the save was based on layout revision ${input.expectedRevision}, but layout revision ${version.layoutRevision} is accepted`, current: await readDocument(tx, path, version) } as const
    }
    const skillIds = new Set((await tx.select({ id: versionSkills.skillId }).from(versionSkills).where(eq(versionSkills.learningPathVersionId, version.id))).map((row) => row.id))
    const foreign = input.cards.find((card) => !skillIds.has(card.id))
    if (foreign) return { ok: false, refusal: 'skill_not_in_version', detail: `Skill ${foreign.id} is not in Version ${version.versionNumber}` } as const
    const stored = new Map((await tx.select().from(versionSkillCards).where(eq(versionSkillCards.learningPathVersionId, version.id))).map((card) => [card.skillId, card]))
    const moved = input.cards.filter((card) => stored.get(card.id)?.x !== card.position.x || stored.get(card.id)?.y !== card.position.y)
    if (moved.length === 0) return { ok: true, document: await readDocument(tx, path, version) } as const
    await tx.insert(versionSkillCards).values(moved.map((card) => ({ learningPathVersionId: version.id, skillId: card.id, x: card.position.x, y: card.position.y })))
      .onConflictDoUpdate({ target: [versionSkillCards.learningPathVersionId, versionSkillCards.skillId], set: { x: sql`excluded.x`, y: sql`excluded.y` } })
    const [saved] = await tx.update(learningPathVersions).set({ layoutRevision: sql`${learningPathVersions.layoutRevision} + 1` })
      .where(eq(learningPathVersions.id, version.id)).returning()
    return { ok: true, document: await readDocument(tx, path, saved) } as const
  })
}

export type DraftRefusal =
  | 'learning_path_not_found' | 'no_open_draft' | 'stale_revision' | 'skill_owned_elsewhere' | 'task_owned_elsewhere'
  | 'task_skill_mismatch' | 'skill_has_history' | 'task_has_history'
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
      if (!changed && input.title === draft.title && input.goal === draft.goal) return { ok: true, document: await readDocument(tx, path) } as const
      // The title and goal are the Draft's own; published Versions keep theirs.
      await tx.update(learningPathVersions).set({ title: input.title, goal: input.goal }).where(eq(learningPathVersions.id, draft.id))
      return { ok: true, document: await readDocument(tx, await advanceRevision(tx, path)) } as const
    })
  } catch (error) {
    if (error instanceof Refused) return { ok: false, refusal: error.refusal, detail: error.detail }
    throw error
  }
}

/** Writes the difference between the stored and the sent Draft; returns whether there was any. */
async function writeDraft(tx: Tx, path: typeof learningPaths.$inferSelect, draftId: string, input: DocumentInput) {
  let changed = false
  const existingSkills = new Map((await tx.select().from(versionSkills).where(eq(versionSkills.learningPathVersionId, draftId))).map((row) => [row.skillId, row]))
  const existingTasks = new Map((await tx.select().from(versionTasks).where(eq(versionTasks.learningPathVersionId, draftId))).map((row) => [row.taskId, row]))
  const sentSkills = new Set(input.application.skills.map((skill) => skill.id))
  const sentTasks = new Set(input.application.skills.flatMap((skill) => skill.tasks.map((task) => task.id)))
  // Content a published Version holds is history (ADR 0018): it is never deleted, and a Task leaves the Draft only by archival.
  // Content only the Draft holds is unused and is deleted.
  const removedSkills = [...existingSkills.values()].filter((skill) => !sentSkills.has(skill.skillId))
  const removedTasks = [...existingTasks.values()].filter((task) => !sentTasks.has(task.taskId))
  if (removedSkills.length > 0 || removedTasks.length > 0) {
    const published = await publishedContent(tx, path.id)
    const kept = removedSkills.find((skill) => published.skills.has(skill.skillId))
    if (kept) throw new Refused('skill_has_history', `Skill "${kept.title}" is part of a published Version and cannot be deleted; its Tasks can be archived from this Draft`)
    const worked = removedTasks.find((task) => published.tasks.has(task.taskId))
    if (worked) throw new Refused('task_has_history', `Task "${worked.title}" is part of a published Version and cannot be deleted; archive it from this Draft instead`)
  }

  const newSkills = input.application.skills.filter((skill) => !existingSkills.has(skill.id))
  const newTasks: (TaskInput & { skillId: string; ordinal: number })[] = []
  for (const skill of input.application.skills) {
    for (const [ordinal, task] of skill.tasks.entries()) {
      const row = existingTasks.get(task.id)
      if (!row) newTasks.push({ ...task, skillId: skill.id, ordinal })
      else if (row.skillId !== skill.id) throw new Refused('task_skill_mismatch', `Task ${task.id} belongs to another Skill`)
    }
  }
  const claim = await claimLogicalIds(tx, path.id, newSkills.map((skill) => skill.id), newTasks)
  if (claim) throw new Refused(claim.refusal, claim.detail)

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
  // New Tasks join their Skill's preparation board, if it was opened (ADR 0029).
  await addDraftCards(tx, draftId, newTasks.map((task) => ({ taskId: task.id, skillId: task.skillId })))

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

  // Unused content leaves the Draft for good, after its connections went with the edges above.
  // Its logical IDs stay this Path's, so an editor undo can bring it back.
  if (removedTasks.length > 0) {
    changed = true
    await removeDraftCards(tx, draftId, removedTasks.map((task) => task.taskId))
    await tx.delete(versionTasks).where(and(eq(versionTasks.learningPathVersionId, draftId), inArray(versionTasks.taskId, removedTasks.map((task) => task.taskId))))
  }
  if (removedSkills.length > 0) {
    changed = true
    const ids = removedSkills.map((skill) => skill.skillId)
    await deleteDraftBoards(tx, draftId, ids)
    await tx.delete(versionSkillCards).where(and(eq(versionSkillCards.learningPathVersionId, draftId), inArray(versionSkillCards.skillId, ids)))
    await tx.delete(versionSkills).where(and(eq(versionSkills.learningPathVersionId, draftId), inArray(versionSkills.skillId, ids)))
  }
  return changed
}

export type PublicationRefusal = 'learning_path_not_found' | 'stale_revision' | 'no_open_draft' | 'publication_blocked' | 'draft_already_open'
type PublicationResult =
  | { ok: true; document: CoachPathDocument }
  | { ok: false; refusal: PublicationRefusal; detail: string; current?: CoachPathDocument; blockedSkills?: BlockedSkill[]; reachableXp?: number }

/** Locks the owner's Path and checks the revision the request was based on. */
async function lockForChange(tx: Tx, learningPathId: string, accountId: string, expectedRevision: number) {
  const path = await lockOwnedCoachPath(tx, learningPathId, accountId)
  if (!path) return { ok: false, refusal: 'learning_path_not_found', detail: 'no such Path' } as const
  if (path.revision !== expectedRevision) {
    return { ok: false, refusal: 'stale_revision', detail: `the request was based on revision ${expectedRevision}, but revision ${path.revision} is accepted`, current: await readDocument(tx, path) } as const
  }
  return { ok: true, path } as const
}

async function advanceRevision(tx: Tx, path: typeof learningPaths.$inferSelect) {
  const [saved] = await tx.update(learningPaths).set({ revision: sql`${learningPaths.revision} + 1` }).where(eq(learningPaths.id, path.id)).returning()
  return saved
}

/**
 * Publishes the open Draft as it stands at `expectedRevision`, once its required route
 * can be completed (ADR 0008); a blocked route publishes nothing and names the
 * affected Skills and their unmet requirements. From then on the Version's learning
 * content and rules are immutable (ADR 0005), and the Path has no open Draft.
 */
export async function publishDraft(db: Database, learningPathId: string, accountId: string, expectedRevision: number): Promise<PublicationResult> {
  return db.transaction(async (tx) => {
    const locked = await lockForChange(tx, learningPathId, accountId, expectedRevision)
    if (!locked.ok) return locked
    const draft = await openDraft(tx, locked.path.id)
    if (!draft) return { ok: false, refusal: 'no_open_draft', detail: 'this Path has no open Draft to publish' } as const
    // Content writes lock the Draft FOR SHARE (migration 0013): this waits for any in
    // progress, and later ones wait for this publication, so the Draft validated here
    // is exactly the content published.
    await tx.select({ id: learningPathVersions.id }).from(learningPathVersions).where(eq(learningPathVersions.id, draft.id)).for('update')
    const content = await readContent(tx, draft.id)
    const route = checkRequiredRoute(content.skills, content.edges)
    if (!route.publishable) return { ok: false, refusal: 'publication_blocked', detail: route.detail, blockedSkills: route.blockedSkills, reachableXp: route.reachableXp } as const
    await tx.update(learningPathVersions).set({ publishedAt: sql`clock_timestamp()` }).where(eq(learningPathVersions.id, draft.id))
    return { ok: true, document: await readDocument(tx, await advanceRevision(tx, locked.path)) } as const
  })
}

/**
 * Prepares the next Version as a Draft copied from the latest published one: the same
 * logical Skill and Task IDs (ADR 0004) with their own, editable definitions, rules,
 * Prerequisites and Canvas Layout. The published Version and its Enrollments are not
 * touched. A Path has at most one open Draft.
 */
export async function prepareDraft(db: Database, learningPathId: string, accountId: string, expectedRevision: number): Promise<PublicationResult> {
  return db.transaction(async (tx) => {
    const locked = await lockForChange(tx, learningPathId, accountId, expectedRevision)
    if (!locked.ok) return locked
    if (await openDraft(tx, locked.path.id)) return { ok: false, refusal: 'draft_already_open', detail: 'this Path already has an open Draft' } as const
    const [latest] = await tx.select().from(learningPathVersions).where(eq(learningPathVersions.learningPathId, locked.path.id))
      .orderBy(desc(learningPathVersions.versionNumber)).limit(1)
    const [draft] = await tx.insert(learningPathVersions).values({ learningPathId: locked.path.id, versionNumber: latest.versionNumber + 1, title: latest.title, goal: latest.goal }).returning()
    const copy = <T extends { learningPathVersionId: string }>(rows: T[]) => rows.map((row) => ({ ...row, learningPathVersionId: draft.id }))
    const skillRows = await tx.select().from(versionSkills).where(eq(versionSkills.learningPathVersionId, latest.id))
    if (skillRows.length > 0) await tx.insert(versionSkills).values(copy(skillRows))
    const taskRows = await tx.select().from(versionTasks).where(eq(versionTasks.learningPathVersionId, latest.id))
    if (taskRows.length > 0) await tx.insert(versionTasks).values(copy(taskRows))
    const edgeRows = await tx.select().from(versionPrerequisites).where(eq(versionPrerequisites.learningPathVersionId, latest.id))
    if (edgeRows.length > 0) await tx.insert(versionPrerequisites).values(copy(edgeRows))
    const cardRows = await tx.select().from(versionSkillCards).where(eq(versionSkillCards.learningPathVersionId, latest.id))
    if (cardRows.length > 0) await tx.insert(versionSkillCards).values(copy(cardRows))
    return { ok: true, document: await readDocument(tx, await advanceRevision(tx, locked.path)) } as const
  })
}

export type ArchiveDraftRefusal = 'learning_path_not_found' | 'stale_revision' | 'no_open_draft' | 'task_not_found' | 'task_not_published'
type ArchiveDraftResult = { ok: true; document: CoachPathDocument } | { ok: false; refusal: ArchiveDraftRefusal; detail: string; current?: CoachPathDocument }

/**
 * Archives a published Task from the open Draft (ADR 0018): the Task is not carried
 * into the next Version, while every published Version that holds it, and the
 * Submissions, Reviews, XP and Mastery of their Enrollments, stay as they were. Its
 * logical ID stays with the Path. A Task only this Draft holds has no history to
 * keep and is not archived; removing unused content is a separate deletion.
 */
export async function archiveDraftTask(db: Database, learningPathId: string, taskId: string, accountId: string, expectedRevision: number): Promise<ArchiveDraftResult> {
  return db.transaction(async (tx) => {
    const locked = await lockForChange(tx, learningPathId, accountId, expectedRevision)
    if (!locked.ok) return locked
    const draft = await openDraft(tx, locked.path.id)
    if (!draft) return { ok: false, refusal: 'no_open_draft', detail: 'this Path has no open Draft' } as const
    const [task] = await tx.select().from(versionTasks).where(and(eq(versionTasks.learningPathVersionId, draft.id), eq(versionTasks.taskId, taskId)))
    if (!task) return { ok: false, refusal: 'task_not_found', detail: 'no such Task in this Draft' } as const
    if (!(await publishedContent(tx, locked.path.id)).tasks.has(taskId)) {
      return { ok: false, refusal: 'task_not_published', detail: `Task "${task.title}" was never published, so it has no history to archive` } as const
    }
    // It leaves its preparation board with it; the board's undo cannot bring it back (ADR 0029).
    await removeDraftCards(tx, draft.id, [taskId])
    await tx.delete(versionTasks).where(and(eq(versionTasks.learningPathVersionId, draft.id), eq(versionTasks.taskId, taskId)))
    return { ok: true, document: await readDocument(tx, await advanceRevision(tx, locked.path)) } as const
  })
}
