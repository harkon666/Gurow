import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import type { Database } from './db/client'
import { learningPaths, personalPrerequisites, personalSkillCards, personalSkills, personalTasks, personalWorkspaces, skills, tasks } from './db/schema'
import { lockOwnedPath, type Tx } from './personal'

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
export interface TaskInput { id: string; title: string; description: string }
export interface SkillInput { id: string; title: string; outcome: string; tasks: TaskInput[] }

/** The owner's edit, based on `expectedRevision`. */
export interface DocumentInput {
  expectedRevision: number
  title: string
  goal: string
  editor: { format_version: typeof SNAPSHOT_FORMAT_VERSION; cards: CardInput[]; connections: ConnectionInput[] }
  application: { skills: SkillInput[] }
}

export const LIMITS = { title: 200, goal: 2_000, outcome: 2_000, description: 10_000, skills: 1_000, tasks: 5_000, connections: 5_000, coordinate: 1_000_000 }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Parsed<T> = { ok: true; value: T } | { ok: false; detail: string }
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max

/** Validates a new Path's title and goal; the title must name the Path. */
export function parsePathInput(body: unknown): Parsed<{ title: string; goal: string }> {
  if (!isObject(body)) return { ok: false, detail: 'expected an object with title and goal' }
  const { title, goal = '' } = body
  if (!isText(title, LIMITS.title) || title.trim() === '') return { ok: false, detail: `title must be 1–${LIMITS.title} characters` }
  if (!isText(goal, LIMITS.goal)) return { ok: false, detail: `goal must be at most ${LIMITS.goal} characters` }
  return { ok: true, value: { title, goal } }
}

/**
 * Checks a document's shape and its internal association: every card names
 * exactly one Skill of the payload with the same title, IDs are unique, and
 * connections join two distinct Skills of this document without forming a cycle.
 * Ownership of the IDs is checked later, against the database.
 */
export function parseDocumentInput(body: unknown): Parsed<DocumentInput> | { ok: false; refusal: 'prerequisite_cycle' | 'connection_outside_path'; detail: string } {
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
    taskCount += skill.tasks.length
    if (taskCount > LIMITS.tasks) return fail('too many Tasks')
    const parsedTasks: TaskInput[] = []
    for (const task of skill.tasks) {
      if (!isObject(task) || typeof task.id !== 'string' || !UUID.test(task.id)) return fail(`every Task of Skill ${skill.id} needs a UUID id`)
      if (ids.has(task.id.toLowerCase())) return fail(`ID ${task.id} is used twice`)
      ids.add(task.id.toLowerCase())
      if (!isText(task.title, LIMITS.title) || !isText(task.description, LIMITS.description)) return fail(`Task ${task.id} needs a title and description within the length limits`)
      parsedTasks.push({ id: task.id.toLowerCase(), title: task.title, description: task.description })
    }
    parsedSkills.push({ id: skill.id.toLowerCase(), title: skill.title, outcome: skill.outcome, tasks: parsedTasks })
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
const defaultPosition = (index: number) => ({ x: 80 + (index % 4) * 240, y: 100 + Math.floor(index / 4) * 160 })

/** Reads a Path document; archived Tasks are out of active use and not edited here. */
async function readDocument(tx: Tx, path: typeof learningPaths.$inferSelect) {
  const skillRows = await tx.select().from(personalSkills).where(eq(personalSkills.learningPathId, path.id)).orderBy(asc(personalSkills.ordinal), asc(personalSkills.skillId))
  const taskRows = await tx.select().from(personalTasks).where(and(eq(personalTasks.learningPathId, path.id), isNull(personalTasks.archivedAt))).orderBy(asc(personalTasks.ordinal), asc(personalTasks.taskId))
  const cards = new Map((await tx.select().from(personalSkillCards).where(eq(personalSkillCards.learningPathId, path.id))).map((card) => [card.skillId, card]))
  const connections = await tx.select({ from_id: personalPrerequisites.prerequisiteSkillId, to_id: personalPrerequisites.skillId }).from(personalPrerequisites)
    .where(eq(personalPrerequisites.learningPathId, path.id)).orderBy(asc(personalPrerequisites.prerequisiteSkillId), asc(personalPrerequisites.skillId))
  return {
    learningPath: { id: path.id, personalWorkspaceId: path.personalWorkspaceId!, title: path.title, goal: path.goal, revision: path.revision },
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
  | 'task_skill_mismatch' | 'task_archived' | 'skill_missing' | 'task_missing'
type SaveResult = { ok: true; document: PathDocument } | { ok: false; refusal: SaveRefusal; detail: string; current?: PathDocument }

class Refused extends Error {
  constructor(readonly refusal: SaveRefusal, readonly detail: string) { super(detail) }
}

/**
 * Saves the owner's whole Path document if it was based on the current revision,
 * then advances the revision. Under the Path lock, a stale save changes nothing
 * and returns the accepted document instead (ADR 0016). Skill and Task IDs are
 * claimed for this Path only (ADR 0004): an ID already owned by another Path, or a
 * Task under another Skill, refuses the whole save. Removing Skills or Tasks is not
 * part of this slice. Task rewards, completion, Mastery, thresholds and overrides
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
  for (const id of existingSkills.keys()) if (!sentSkills.has(id)) throw new Refused('skill_missing', `Skill ${id} is missing; removing Skills is not supported yet`)
  for (const [id, task] of existingTasks) if (!task.archivedAt && !sentTasks.has(id)) throw new Refused('task_missing', `Task ${id} is missing; removing Tasks is not supported yet`)

  // New logical identities are claimed for this Path; the primary key decides concurrent claims.
  const newSkills = input.application.skills.filter((skill) => !existingSkills.has(skill.id))
  if (newSkills.length > 0) {
    const claimed = await tx.insert(skills).values(newSkills.map((skill) => ({ id: skill.id, learningPathId: path.id }))).onConflictDoNothing().returning({ id: skills.id })
    if (claimed.length !== newSkills.length) {
      const taken = newSkills.find((skill) => !claimed.some((row) => row.id === skill.id))!
      throw new Refused('skill_owned_elsewhere', `Skill ${taken.id} belongs to another Learning Path`)
    }
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

  const newTasks: (TaskInput & { skillId: string; ordinal: number })[] = []
  for (const skill of input.application.skills) {
    for (const [ordinal, task] of skill.tasks.entries()) {
      const row = existingTasks.get(task.id)
      if (!row) {
        newTasks.push({ ...task, skillId: skill.id, ordinal })
        continue
      }
      if (row.skillId !== skill.id) throw new Refused('task_skill_mismatch', `Task ${task.id} belongs to another Skill`)
      if (row.archivedAt) throw new Refused('task_archived', `Task ${task.id} is archived`)
      if (row.title !== task.title || row.description !== task.description || row.ordinal !== ordinal) {
        changed = true
        await tx.update(personalTasks).set({ title: task.title, description: task.description, ordinal }).where(eq(personalTasks.taskId, task.id))
      }
    }
  }
  if (newTasks.length > 0) {
    const claimed = await tx.insert(tasks).values(newTasks.map((task) => ({ id: task.id, skillId: task.skillId }))).onConflictDoNothing().returning({ id: tasks.id })
    if (claimed.length !== newTasks.length) {
      const taken = newTasks.find((task) => !claimed.some((row) => row.id === task.id))!
      throw new Refused('task_owned_elsewhere', `Task ${taken.id} belongs to another Skill`)
    }
    changed = true
    await tx.insert(personalTasks).values(newTasks.map((task) => ({ taskId: task.id, learningPathId: path.id, skillId: task.skillId, title: task.title, description: task.description, ordinal: task.ordinal })))
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
  return changed
}
