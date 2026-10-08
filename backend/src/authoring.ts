import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import type { Database } from './db/client'
import { lockedTimestamp } from './db/clock'
import { learningPaths, personalPrerequisites, personalSkillCards, personalSkills, personalTasks, personalWorkspaces } from './db/schema'
import { lockOwnedPath, readPersonalLearningStateIn, type Tx } from './personal'
import { claimLogicalIds } from './logicalIds'
import { addCards, deleteBoards, removeCards } from './personalBoardMembership'
import { personalHistory } from './retention'

/**
 * Authoring a personal Learning Path (ADR 0015, 0016). A Path document joins the
 * editor snapshot (format version, Skill cards with positions, Prerequisite
 * connections) with the application payload (Path goal, Skill outcomes, Tasks),
 * the same split as the P1 local checkpoint. Tasks never enter the snapshot, and
 * connections are stored once, as the Path's Prerequisites. Camera, selection and
 * undo history are not part of a document.
 */

export const SNAPSHOT_FORMAT_VERSION = 1

export interface CardInput { id: string; title: string; position: { x: number; y: number } }
export interface ConnectionInput { from_id: string; to_id: string }
/**
 * `required` and `xpReward` (Task) and `optional` and `xpThreshold` (Skill) are
 * Draft content in coach mode; personal documents carry none of them, since
 * personal rewards and thresholds are the owner's learning records.
 */
export interface TaskInput { id: string; title: string; description: string; required?: boolean; xpReward?: number }
export interface SkillInput { id: string; title: string; outcome: string; optional?: boolean; xpThreshold?: number; tasks: TaskInput[] }
export type DocumentMode = 'personal' | 'coach'

/** The owner's edit, based on `expectedRevision`. */
export interface DocumentInput {
  expectedRevision: number
  title: string
  goal: string
  editor: { format_version: typeof SNAPSHOT_FORMAT_VERSION; cards: CardInput[]; connections: ConnectionInput[] }
  application: { skills: SkillInput[] }
}

export const LIMITS = { title: 200, goal: 2_000, outcome: 2_000, description: 10_000, skills: 1_000, tasks: 5_000, connections: 5_000, coordinate: 1_000_000, xpReward: 1_000_000, xpThreshold: 1_000_000_000 }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Parsed<T> = { ok: true; value: T } | { ok: false; detail: string }
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max
const isAmount = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max

/** Validates a new Path's title and goal; the title must name the Path. */
export function parsePathInput(body: unknown): Parsed<{ title: string; goal: string }> {
  if (!isObject(body)) return { ok: false, detail: 'expected an object with title and goal' }
  const { title, goal = '' } = body
  if (!isText(title, LIMITS.title) || title.trim() === '') return { ok: false, detail: `title must be 1–${LIMITS.title} characters` }
  if (!isText(goal, LIMITS.goal)) return { ok: false, detail: `goal must be at most ${LIMITS.goal} characters` }
  return { ok: true, value: { title, goal } }
}

export type DocumentRefusal = 'prerequisite_cycle' | 'connection_outside_path' | 'optional_prerequisite'

/**
 * Checks a document's shape and its internal association: every card names
 * exactly one Skill of the payload with the same title, IDs are unique, and
 * connections join two distinct Skills of this document without forming a cycle.
 * In coach mode it also checks the Draft's rules: every Task is Required or
 * Enrichment with a reward, every Skill has an XP Threshold and is required or
 * Optional, and no Optional Skill is a Prerequisite of a required Skill.
 * Ownership of the IDs is checked later, against the database.
 */
export function parseDocumentInput(body: unknown, mode: DocumentMode = 'personal'): Parsed<DocumentInput> | { ok: false; refusal: DocumentRefusal; detail: string } {
  const fail = (detail: string) => ({ ok: false as const, detail })
  if (!isObject(body) || !isObject(body.editor) || !isObject(body.application)) return fail('expected expectedRevision, title, goal, editor and application')
  const { expectedRevision, title, goal, editor, application } = body
  if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return fail('expectedRevision must be a non-negative integer')
  if (!isText(title, LIMITS.title)) return fail(`title must be at most ${LIMITS.title} characters`)
  if (!isText(goal, LIMITS.goal)) return fail(`goal must be at most ${LIMITS.goal} characters`)
  if (editor.format_version !== SNAPSHOT_FORMAT_VERSION) return fail(`editor.format_version must be ${SNAPSHOT_FORMAT_VERSION}`)
  const { cards, connections } = editor
  const skillList = application.skills
  if (!Array.isArray(cards) || !Array.isArray(connections) || !Array.isArray(skillList)) return fail('cards, connections and skills must be arrays')
  if (skillList.length > LIMITS.skills || connections.length > LIMITS.connections) return fail('too many Skills or connections')

  const ids = new Set<string>()
  const parsedSkills: SkillInput[] = []
  let taskCount = 0
  for (const skill of skillList) {
    if (!isObject(skill) || typeof skill.id !== 'string' || !UUID.test(skill.id)) return fail('every Skill needs a UUID id')
    if (ids.has(skill.id.toLowerCase())) return fail(`ID ${skill.id} is used twice`)
    ids.add(skill.id.toLowerCase())
    if (!isText(skill.title, LIMITS.title) || !isText(skill.outcome, LIMITS.outcome)) return fail(`Skill ${skill.id} needs a title and learning outcome within the length limits`)
    if (!Array.isArray(skill.tasks)) return fail(`Skill ${skill.id} needs a tasks array`)
    if (mode === 'coach' && (typeof skill.optional !== 'boolean' || !isAmount(skill.xpThreshold, LIMITS.xpThreshold))) {
      return fail(`Skill ${skill.id} needs optional (true or false) and an xpThreshold of 0–${LIMITS.xpThreshold}`)
    }
    taskCount += skill.tasks.length
    if (taskCount > LIMITS.tasks) return fail('too many Tasks')
    const parsedTasks: TaskInput[] = []
    for (const task of skill.tasks) {
      if (!isObject(task) || typeof task.id !== 'string' || !UUID.test(task.id)) return fail(`every Task of Skill ${skill.id} needs a UUID id`)
      if (ids.has(task.id.toLowerCase())) return fail(`ID ${task.id} is used twice`)
      ids.add(task.id.toLowerCase())
      if (!isText(task.title, LIMITS.title) || !isText(task.description, LIMITS.description)) return fail(`Task ${task.id} needs a title and description within the length limits`)
      if (mode === 'coach') {
        if (typeof task.required !== 'boolean' || !isAmount(task.xpReward, LIMITS.xpReward)) return fail(`Task ${task.id} needs required (true or false) and an xpReward of 0–${LIMITS.xpReward}`)
        parsedTasks.push({ id: task.id.toLowerCase(), title: task.title, description: task.description, required: task.required, xpReward: task.xpReward })
      } else {
        parsedTasks.push({ id: task.id.toLowerCase(), title: task.title, description: task.description })
      }
    }
    parsedSkills.push(mode === 'coach'
      ? { id: skill.id.toLowerCase(), title: skill.title, outcome: skill.outcome, optional: skill.optional as boolean, xpThreshold: skill.xpThreshold as number, tasks: parsedTasks }
      : { id: skill.id.toLowerCase(), title: skill.title, outcome: skill.outcome, tasks: parsedTasks })
  }

  // One flat card per Skill: the snapshot and the payload name the same Skills.
  const skillTitles = new Map(parsedSkills.map((skill) => [skill.id, skill.title]))
  const parsedCards: CardInput[] = []
  const carded = new Set<string>()
  for (const card of cards) {
    if (!isObject(card) || typeof card.id !== 'string' || !isObject(card.position)) return fail('every card needs an id and a position')
    const id = card.id.toLowerCase()
    const { x, y } = card.position
    if (!skillTitles.has(id)) return fail(`card ${card.id} has no Skill in the application payload`)
    if (carded.has(id)) return fail(`Skill ${card.id} has more than one card`)
    if (card.title !== skillTitles.get(id)) return fail(`card ${card.id} is titled differently from its Skill`)
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) ||
      Math.abs(x) > LIMITS.coordinate || Math.abs(y) > LIMITS.coordinate) return fail(`card ${card.id} is outside the canvas bounds`)
    carded.add(id)
    parsedCards.push({ id, title: skillTitles.get(id)!, position: { x, y } })
  }
  if (carded.size !== skillTitles.size) return fail('every Skill needs exactly one card')

  const parsedConnections: ConnectionInput[] = []
  const edges = new Set<string>()
  for (const connection of connections) {
    if (!isObject(connection) || typeof connection.from_id !== 'string' || typeof connection.to_id !== 'string') return fail('every connection needs from_id and to_id')
    const from = connection.from_id.toLowerCase(), to = connection.to_id.toLowerCase()
    if (!skillTitles.has(from) || !skillTitles.has(to)) return { ok: false, refusal: 'connection_outside_path', detail: `connection ${connection.from_id} → ${connection.to_id} names a Skill outside this Path` }
    if (from === to) return { ok: false, refusal: 'prerequisite_cycle', detail: `Skill ${connection.from_id} cannot be its own Prerequisite` }
    if (edges.has(`${from}>${to}`)) continue
    edges.add(`${from}>${to}`)
    parsedConnections.push({ from_id: from, to_id: to })
  }
  const cycle = findCycle(parsedSkills.map((skill) => skill.id), parsedConnections)
  if (cycle) return { ok: false, refusal: 'prerequisite_cycle', detail: `the Prerequisites form a cycle through ${cycle.join(' → ')}` }
  // An Optional Skill may be skipped, so a required Skill cannot depend on it.
  const optional = new Set(parsedSkills.filter((skill) => skill.optional).map((skill) => skill.id))
  const blocking = parsedConnections.find((edge) => optional.has(edge.from_id) && !optional.has(edge.to_id))
  if (blocking) {
    return { ok: false, refusal: 'optional_prerequisite', detail: `Optional Skill "${skillTitles.get(blocking.from_id)}" cannot be a Prerequisite of required Skill "${skillTitles.get(blocking.to_id)}"` }
  }

  return { ok: true, value: { expectedRevision, title, goal, editor: { format_version: SNAPSHOT_FORMAT_VERSION, cards: parsedCards, connections: parsedConnections }, application: { skills: parsedSkills } } }
}

/** Returns one cycle of the Prerequisite Graph, or null when it is acyclic (ADR 0006). */
function findCycle(skillIds: string[], connections: ConnectionInput[]): string[] | null {
  const next = new Map(skillIds.map((id) => [id, [] as string[]]))
  for (const { from_id, to_id } of connections) next.get(from_id)!.push(to_id)
  const state = new Map<string, 'open' | 'done'>()
  const trail: string[] = []
  const visit = (id: string): string[] | null => {
    state.set(id, 'open')
    trail.push(id)
    for (const to of next.get(id)!) {
      if (state.get(to) === 'open') return [...trail.slice(trail.indexOf(to)), to]
      if (!state.has(to)) {
        const found = visit(to)
        if (found) return found
      }
    }
    trail.pop()
    state.set(id, 'done')
    return null
  }
  for (const id of skillIds) {
    if (!state.has(id)) {
      const found = visit(id)
      if (found) return found
    }
  }
  return null
}

/** Where a Skill without a stored card is first placed: a simple grid in list order. */
export const defaultPosition = (index: number) => ({ x: 80 + (index % 4) * 240, y: 100 + Math.floor(index / 4) * 160 })

/** Reads a Path document; archived Tasks are out of active use and not edited here. */
async function readDocument(tx: Tx, path: typeof learningPaths.$inferSelect) {
  const skillRows = await tx.select().from(personalSkills).where(eq(personalSkills.learningPathId, path.id)).orderBy(asc(personalSkills.ordinal), asc(personalSkills.skillId))
  const activeSkills = skillRows.filter((skill) => skill.archivedAt === null)
  const allTasks = await tx.select().from(personalTasks).where(eq(personalTasks.learningPathId, path.id))
  const taskRows = await tx.select().from(personalTasks).where(and(eq(personalTasks.learningPathId, path.id), isNull(personalTasks.archivedAt))).orderBy(asc(personalTasks.ordinal), asc(personalTasks.taskId))
  const cards = new Map((await tx.select().from(personalSkillCards).where(eq(personalSkillCards.learningPathId, path.id))).map((card) => [card.skillId, card]))
  const connections = await tx.select({ from_id: personalPrerequisites.prerequisiteSkillId, to_id: personalPrerequisites.skillId }).from(personalPrerequisites)
    .where(eq(personalPrerequisites.learningPathId, path.id)).orderBy(asc(personalPrerequisites.prerequisiteSkillId), asc(personalPrerequisites.skillId))
  return {
    learningPath: { id: path.id, personalWorkspaceId: path.personalWorkspaceId!, title: path.title, goal: path.goal, revision: path.revision },
    archivedSkills: skillRows.filter((skill) => skill.archivedAt !== null).map((skill) => ({
      id: skill.skillId, title: skill.title, outcome: skill.learningOutcome, archivedAt: skill.archivedAt!.toISOString(),
      taskCount: allTasks.filter((task) => task.skillId === skill.skillId).length,
    })),
    editor: {
      format_version: SNAPSHOT_FORMAT_VERSION,
      cards: activeSkills.map((skill, index) => {
        const card = cards.get(skill.skillId)
        return { id: skill.skillId, title: skill.title, position: card ? { x: card.x, y: card.y } : defaultPosition(index) }
      }),
      connections,
    },
    application: {
      skills: activeSkills.map((skill) => ({
        id: skill.skillId, title: skill.title, outcome: skill.learningOutcome,
        tasks: taskRows.filter((task) => task.skillId === skill.skillId).map((task) => ({ id: task.taskId, title: task.title, description: task.description })),
      })),
    },
  }
}

export type PathDocument = Awaited<ReturnType<typeof readDocument>>

/** Creates a Path in the Account's one Personal Workspace, entering the Workspace if needed. */
export async function createPersonalPath(db: Database, accountId: string, input: { title: string; goal: string }) {
  return db.transaction(async (tx) => {
    await tx.insert(personalWorkspaces).values({ ownerAccountId: accountId }).onConflictDoNothing({ target: personalWorkspaces.ownerAccountId })
    const [workspace] = await tx.select().from(personalWorkspaces).where(eq(personalWorkspaces.ownerAccountId, accountId))
    const [path] = await tx.insert(learningPaths).values({ personalWorkspaceId: workspace.id, title: input.title, goal: input.goal }).returning()
    return readDocument(tx, path)
  })
}

/** Reads a Path document for its owner; for every other Account there is no Path. */
export async function readPersonalPath(db: Database, learningPathId: string, accountId: string) {
  return db.transaction(async (tx) => {
    const path = await lockOwnedPath(tx, learningPathId, accountId)
    return path ? readDocument(tx, path) : null
  })
}

export type SaveRefusal =
  | 'learning_path_not_found' | 'stale_revision' | 'skill_owned_elsewhere' | 'task_owned_elsewhere'
  | 'task_skill_mismatch' | 'task_archived' | 'skill_archived' | 'skill_has_history' | 'task_has_history'
type SaveResult = { ok: true; document: PathDocument } | { ok: false; refusal: SaveRefusal; detail: string; current?: PathDocument }

class Refused extends Error {
  constructor(readonly refusal: SaveRefusal, readonly detail: string) { super(detail) }
}

/**
 * Saves the owner's whole Path document if it was based on the current revision,
 * then advances the revision. Under the Path lock, a stale save changes nothing
 * and returns the accepted document instead (ADR 0016). Skill and Task IDs are
 * claimed for this Path only (ADR 0004): an ID already owned by another Path, or a
 * Task under another Skill, refuses the whole save. Skills and Tasks the save leaves
 * out are deleted when they have no learning history, and refuse it otherwise. Task rewards, completion, Mastery, thresholds and overrides
 * are learning records outside the document and are never written here.
 */
export async function savePersonalPath(db: Database, learningPathId: string, accountId: string, input: DocumentInput): Promise<SaveResult> {
  try {
    return await db.transaction(async (tx) => {
      const path = await lockOwnedPath(tx, learningPathId, accountId)
      if (!path) return { ok: false, refusal: 'learning_path_not_found', detail: 'no such Path' } as const
      if (path.revision !== input.expectedRevision) {
        return { ok: false, refusal: 'stale_revision', detail: `the save was based on revision ${input.expectedRevision}, but revision ${path.revision} is accepted`, current: await readDocument(tx, path) } as const
      }
      const changed = await writeDocument(tx, path, input)
      // A save that changes nothing keeps the revision, so it never makes another tab stale.
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

/** Writes the difference between the stored and the sent document; returns whether there was any. */
async function writeDocument(tx: Tx, path: typeof learningPaths.$inferSelect, input: DocumentInput) {
  let changed = false
  const existingSkills = new Map((await tx.select().from(personalSkills).where(eq(personalSkills.learningPathId, path.id))).map((row) => [row.skillId, row]))
  const existingTasks = new Map((await tx.select().from(personalTasks).where(eq(personalTasks.learningPathId, path.id))).map((row) => [row.taskId, row]))
  const sentSkills = new Set(input.application.skills.map((skill) => skill.id))
  const sentTasks = new Set(input.application.skills.flatMap((skill) => skill.tasks.map((task) => task.id)))
  // Content with progress history is never deleted (ADR 0018): a Task is archived instead, and a Skill is kept.
  // Content without history is deleted.
  const archived = input.application.skills.find((skill) => existingSkills.get(skill.id)?.archivedAt)
  if (archived) throw new Refused('skill_archived', `Skill ${archived.id} is archived and cannot be restored or edited`)
  const removedSkills = [...existingSkills.values()].filter((skill) => !skill.archivedAt && !sentSkills.has(skill.skillId))
  const removedTasks = [...existingTasks.values()].filter((task) => !task.archivedAt && !sentTasks.has(task.taskId))
  if (removedSkills.length > 0 || removedTasks.length > 0) {
    const history = await personalHistory(tx, path.id)
    const kept = removedSkills.find((skill) => history.skills.has(skill.skillId))
    if (kept) throw new Refused('skill_has_history', `Skill "${kept.title}" has learning history and cannot be deleted; archive the Skill instead`)
    const worked = removedTasks.find((task) => history.tasks.has(task.taskId))
    if (worked) throw new Refused('task_has_history', `Task "${worked.title}" has learning history and cannot be deleted; archive it instead`)
  }

  // New logical identities are claimed for this Path; one it already owns (deleted, then undone) is its own again.
  const newSkills = input.application.skills.filter((skill) => !existingSkills.has(skill.id))
  const newTasks: (TaskInput & { skillId: string; ordinal: number })[] = []
  for (const skill of input.application.skills) {
    for (const [ordinal, task] of skill.tasks.entries()) if (!existingTasks.has(task.id)) newTasks.push({ ...task, skillId: skill.id, ordinal })
  }
  const claim = await claimLogicalIds(tx, path.id, newSkills.map((skill) => skill.id), newTasks)
  if (claim) throw new Refused(claim.refusal, claim.detail)
  if (newSkills.length > 0) {
    changed = true
    await tx.insert(personalSkills).values(newSkills.map((skill) => ({
      skillId: skill.id, learningPathId: path.id, personalWorkspaceId: path.personalWorkspaceId!, title: skill.title, learningOutcome: skill.outcome,
      ordinal: input.application.skills.indexOf(skill),
    })))
  }
  for (const [ordinal, skill] of input.application.skills.entries()) {
    const row = existingSkills.get(skill.id)
    if (row && (row.title !== skill.title || row.learningOutcome !== skill.outcome || row.ordinal !== ordinal)) {
      changed = true
      await tx.update(personalSkills).set({ title: skill.title, learningOutcome: skill.outcome, ordinal }).where(and(eq(personalSkills.learningPathId, path.id), eq(personalSkills.skillId, skill.id)))
    }
  }

  for (const skill of input.application.skills) {
    for (const [ordinal, task] of skill.tasks.entries()) {
      const row = existingTasks.get(task.id)
      if (!row) continue
      if (row.skillId !== skill.id) throw new Refused('task_skill_mismatch', `Task ${task.id} belongs to another Skill`)
      if (row.archivedAt) throw new Refused('task_archived', `Task ${task.id} is archived`)
      if (row.title !== task.title || row.description !== task.description || row.ordinal !== ordinal) {
        changed = true
        await tx.update(personalTasks).set({ title: task.title, description: task.description, ordinal }).where(eq(personalTasks.taskId, task.id))
      }
    }
  }
  if (newTasks.length > 0) {
    changed = true
    await tx.insert(personalTasks).values(newTasks.map((task) => ({ taskId: task.id, learningPathId: path.id, skillId: task.skillId, title: task.title, description: task.description, ordinal: task.ordinal })))
    // A Task added by any entry point (the board, the Skill summary, a copy, an undone deletion) gets its card.
    await addCards(tx, path.id, newTasks.map((task) => ({ taskId: task.id, skillId: task.skillId })))
  }

  // Canvas Layout: one card per Skill, written only where it moved.
  const storedCards = new Map((await tx.select().from(personalSkillCards).where(eq(personalSkillCards.learningPathId, path.id))).map((card) => [card.skillId, card]))
  const movedCards = input.editor.cards.filter((card) => storedCards.get(card.id)?.x !== card.position.x || storedCards.get(card.id)?.y !== card.position.y)
  if (movedCards.length > 0) {
    changed = true
    await tx.insert(personalSkillCards).values(movedCards.map((card) => ({ learningPathId: path.id, skillId: card.id, x: card.position.x, y: card.position.y })))
      .onConflictDoUpdate({ target: [personalSkillCards.learningPathId, personalSkillCards.skillId], set: { x: sql`excluded.x`, y: sql`excluded.y` } })
  }

  // The connections are the Path's Prerequisites: one stored graph, replaced by difference.
  const storedEdges = await tx.select().from(personalPrerequisites).where(eq(personalPrerequisites.learningPathId, path.id))
  const key = (from: string, to: string) => `${from}>${to}`
  const sentEdges = new Set(input.editor.connections.map((edge) => key(edge.from_id, edge.to_id)))
  const storedKeys = new Set(storedEdges.map((edge) => key(edge.prerequisiteSkillId, edge.skillId)))
  for (const edge of storedEdges) {
    if (!sentEdges.has(key(edge.prerequisiteSkillId, edge.skillId))) {
      changed = true
      await tx.delete(personalPrerequisites).where(and(eq(personalPrerequisites.learningPathId, path.id), eq(personalPrerequisites.prerequisiteSkillId, edge.prerequisiteSkillId), eq(personalPrerequisites.skillId, edge.skillId)))
    }
  }
  const addedEdges = input.editor.connections.filter((edge) => !storedKeys.has(key(edge.from_id, edge.to_id)))
  if (addedEdges.length > 0) {
    changed = true
    await tx.insert(personalPrerequisites).values(addedEdges.map((edge) => ({ learningPathId: path.id, prerequisiteSkillId: edge.from_id, skillId: edge.to_id })))
  }

  // Unused content leaves the Path for good, after its connections went with the edges above.
  // Its logical IDs stay this Path's, so an editor undo can bring it back.
  if (removedTasks.length > 0) {
    changed = true
    await removeCards(tx, path.id, removedTasks.map((task) => task.taskId))
    await tx.delete(personalTasks).where(and(eq(personalTasks.learningPathId, path.id), inArray(personalTasks.taskId, removedTasks.map((task) => task.taskId))))
  }
  if (removedSkills.length > 0) {
    changed = true
    const ids = removedSkills.map((skill) => skill.skillId)
    await deleteBoards(tx, path.id, ids)
    await tx.delete(personalSkillCards).where(and(eq(personalSkillCards.learningPathId, path.id), inArray(personalSkillCards.skillId, ids)))
    await tx.delete(personalSkills).where(and(eq(personalSkills.learningPathId, path.id), inArray(personalSkills.skillId, ids)))
  }
  return changed
}

export type ArchiveRefusal = 'learning_path_not_found' | 'task_not_found' | 'stale_revision'
export type ArchiveSkillRefusal = 'learning_path_not_found' | 'skill_not_found' | 'stale_revision' | 'skill_has_prerequisites'
type ArchiveSkillResult =
  | Extract<ArchiveResult, { ok: true }>
  | { ok: false; refusal: ArchiveSkillRefusal; detail: string; current?: PathDocument }

/** Removes a disconnected Skill from active use without changing XP, Mastery or history. */
export async function archivePersonalSkill(db: Database, learningPathId: string, skillId: string, accountId: string, expectedRevision: number): Promise<ArchiveSkillResult> {
  return db.transaction(async (tx) => {
    const path = await lockOwnedPath(tx, learningPathId, accountId)
    if (!path) return { ok: false, refusal: 'learning_path_not_found', detail: 'no such Path' } as const
    if (path.revision !== expectedRevision) return {
      ok: false, refusal: 'stale_revision', detail: `the archive was based on revision ${expectedRevision}, but revision ${path.revision} is accepted`, current: await readDocument(tx, path),
    } as const
    const [skill] = await tx.select().from(personalSkills).where(and(eq(personalSkills.learningPathId, path.id), eq(personalSkills.skillId, skillId)))
    if (!skill) return { ok: false, refusal: 'skill_not_found', detail: 'no such Skill in this Path' } as const
    let current = path
    if (!skill.archivedAt) {
      const [edge] = await tx.select().from(personalPrerequisites).where(and(eq(personalPrerequisites.learningPathId, path.id), or(eq(personalPrerequisites.skillId, skillId), eq(personalPrerequisites.prerequisiteSkillId, skillId)))).limit(1)
      if (edge) return { ok: false, refusal: 'skill_has_prerequisites', detail: `Disconnect all incoming and outgoing Prerequisite connections for Skill "${skill.title}" before archiving it` } as const
      const now = await lockedTimestamp(tx)
      const activeTasks = await tx.select({ id: personalTasks.taskId }).from(personalTasks).where(and(eq(personalTasks.learningPathId, path.id), eq(personalTasks.skillId, skillId), isNull(personalTasks.archivedAt)))
      await tx.update(personalTasks).set({ archivedAt: now }).where(and(eq(personalTasks.learningPathId, path.id), eq(personalTasks.skillId, skillId), isNull(personalTasks.archivedAt)))
      await removeCards(tx, path.id, activeTasks.map((task) => task.id))
      await tx.delete(personalSkillCards).where(and(eq(personalSkillCards.learningPathId, path.id), eq(personalSkillCards.skillId, skillId)))
      await tx.update(personalSkills).set({ archivedAt: now }).where(eq(personalSkills.skillId, skillId))
      ;[current] = await tx.update(learningPaths).set({ revision: sql`${learningPaths.revision} + 1` }).where(eq(learningPaths.id, path.id)).returning()
    }
    return { ok: true, changed: !skill.archivedAt, document: await readDocument(tx, current), learningState: await readPersonalLearningStateIn(tx, path.id) } as const
  })
}
type ArchiveResult =
  | { ok: true; changed: boolean; document: PathDocument; learningState: Awaited<ReturnType<typeof readPersonalLearningStateIn>> }
  | { ok: false; refusal: ArchiveRefusal; detail: string; current?: PathDocument }

/**
 * Archives one Task of the owner's Path (ADR 0018): it leaves the editable document
 * and active use, while its completion, contribution, XP history and its Skill's
 * Mastery stay as they were. There is no restoration. Because the document changes,
 * the revision advances; when `expectedRevision` is given, an archive based on an
 * older revision changes nothing and returns the accepted document, like a stale save.
 */
export async function archivePersonalTask(db: Database, learningPathId: string, taskId: string, accountId: string, expectedRevision: number | null): Promise<ArchiveResult> {
  return db.transaction(async (tx) => {
    const path = await lockOwnedPath(tx, learningPathId, accountId)
    if (!path) return { ok: false, refusal: 'learning_path_not_found', detail: 'no such Path' } as const
    if (expectedRevision !== null && path.revision !== expectedRevision) {
      return { ok: false, refusal: 'stale_revision', detail: `the archive was based on revision ${expectedRevision}, but revision ${path.revision} is accepted`, current: await readDocument(tx, path) } as const
    }
    const [task] = await tx.select().from(personalTasks).where(and(eq(personalTasks.learningPathId, path.id), eq(personalTasks.taskId, taskId)))
    if (!task) return { ok: false, refusal: 'task_not_found', detail: 'no such Task in this Path' } as const
    let current = path
    if (!task.archivedAt) {
      await tx.update(personalTasks).set({ archivedAt: await lockedTimestamp(tx) }).where(eq(personalTasks.taskId, taskId))
      // Archived records stay reachable as history, never as an active card.
      await removeCards(tx, path.id, [taskId])
      ;[current] = await tx.update(learningPaths).set({ revision: sql`${learningPaths.revision} + 1` }).where(eq(learningPaths.id, path.id)).returning()
    }
    return { ok: true, changed: !task.archivedAt, document: await readDocument(tx, current), learningState: await readPersonalLearningStateIn(tx, path.id) } as const
  })
}
