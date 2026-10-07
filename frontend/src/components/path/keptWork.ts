/**
 * Local work the backend has not accepted, kept in this browser so that a stale save,
 * a failed save or an interruption does not discard it (ADR 0016; US77, US78, US83).
 * Each piece of kept work names the Account and editing context it belongs to, the
 * revision it was based on, that accepted base and the owner's local version. It is
 * never sent on its own: the owner inspects it and either discards it or reapplies its
 * changes onto the currently accepted document as a new save, which the backend
 * validates like any other and refuses when stale.
 *
 * Three numbers stay distinct here: `format` is this record's serialization,
 * `editor.format_version` the canvas snapshot's, `baseRevision` the concurrency
 * revision a save is checked against, and `context.versionId` the Learning Path
 * Version (Draft or published) the work edits.
 */
import type { PathSave, PathSkill, PathTask } from '../../lib/api'

export const KEPT_WORK_FORMAT = 1
export const CANVAS_FORMAT_VERSION = 1

/** A personal Path or Draft document as the editor saves it. */
export type PathWork = Omit<PathSave, 'expectedRevision'>
/** A published Version's Canvas Layout: card positions only. */
export type LayoutWork = { id: string; position: { x: number; y: number } }[]

/**
 * Whose work it is and what it edits. Another Account, another Path, or another
 * Version of the same Path (a new Draft after publication) never reads it.
 */
export interface WorkContext {
  accountId: string
  kind: 'personal' | 'draft' | 'layout'
  pathId: string
  /** The Learning Path Version edited: the Draft's or the published Version's id; null for a personal Path. */
  versionId: string | null
}

export interface KeptWork<D> {
  format: typeof KEPT_WORK_FORMAT
  id: string
  context: WorkContext
  /** The accepted revision `base` had: the Path's save revision, or a Version's layout revision. */
  baseRevision: number
  base: D
  mine: D
  editedAt: string
}

const PREFIX = 'gurow:kept-work'

const contextKey = (context: WorkContext) =>
  `${PREFIX}:${context.accountId}:${context.kind}:${context.pathId}:${context.versionId ?? '-'}:`

export const keptWorkKey = (context: WorkContext, id: string) => `${contextKey(context)}${id}`

const sameContext = (a: WorkContext, b: WorkContext) =>
  a.accountId === b.accountId && a.kind === b.kind && a.pathId === b.pathId && a.versionId === b.versionId

/** Keeps (or replaces) one piece of work; false when storage is unavailable or full. */
export function writeKeptWork<D>(storage: Storage, work: KeptWork<D>): boolean {
  try {
    storage.setItem(keptWorkKey(work.context, work.id), JSON.stringify(work))
    return true
  } catch {
    return false
  }
}

export function removeKeptWork(storage: Storage, context: WorkContext, id: string) {
  try {
    storage.removeItem(keptWorkKey(context, id))
  } catch {
    // Unavailable storage holds nothing to remove.
  }
}

export function hasKeptWork(storage: Storage, context: WorkContext, id: string) {
  try {
    return storage.getItem(keptWorkKey(context, id)) !== null
  } catch {
    return false
  }
}

/**
 * Reads the work kept for exactly this context, oldest first. A record that cannot be
 * used as it stands (another format, a mismatched context, an incoherent document) is
 * removed and reported, so it is never restored in part.
 */
export function readKeptWork<D>(storage: Storage, context: WorkContext, problem: (document: unknown) => string | null): { kept: KeptWork<D>[]; refused: string[] } {
  const kept: KeptWork<D>[] = []
  const refused: string[] = []
  let keys: string[] = []
  try {
    const prefix = contextKey(context)
    keys = Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((key): key is string => key?.startsWith(prefix) === true)
  } catch {
    return { kept, refused }
  }
  for (const key of keys) {
    const reason = (() => {
      let value: Partial<KeptWork<unknown>>
      try {
        value = JSON.parse(storage.getItem(key) ?? 'null') as Partial<KeptWork<unknown>>
      } catch {
        return 'it is not readable'
      }
      if (typeof value !== 'object' || value === null) return 'it is not readable'
      if (value.format !== KEPT_WORK_FORMAT) return `its record format ${String(value.format)} is not supported`
      if (typeof value.id !== 'string' || key !== keptWorkKey(context, value.id)) return 'it is stored under another key'
      if (!value.context || !sameContext(value.context, context)) return 'it belongs to another Account, Path or Version'
      if (!Number.isSafeInteger(value.baseRevision) || value.baseRevision! < 0) return 'its base revision is not a revision'
      if (typeof value.editedAt !== 'string' || Number.isNaN(Date.parse(value.editedAt))) return 'its edit time is not readable'
      const documentProblem = problem(value.base) ?? problem(value.mine)
      if (documentProblem) return documentProblem
      kept.push(value as KeptWork<D>)
      return null
    })()
    if (reason) {
      refused.push(reason)
      try { storage.removeItem(key) } catch { /* nothing more to do */ }
    }
  }
  kept.sort((a, b) => Date.parse(a.editedAt) - Date.parse(b.editedAt))
  return { kept, refused }
}

// ---------------------------------------------------------------------------
// Path documents

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isPosition = (value: unknown) => isObject(value) && Number.isFinite(value.x) && Number.isFinite(value.y)
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value)
const isCount = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0

/**
 * Why a Path document cannot be restored or reapplied as it stands; null when its
 * Skill identities, cards, connections and Tasks are coherent: one card per Skill,
 * connections between two distinct cards, and every Task under exactly one Skill.
 */
export function pathWorkProblem(document: unknown): string | null {
  if (!isObject(document) || typeof document.title !== 'string' || typeof document.goal !== 'string') return 'its document is not a Path document'
  const editor = document.editor, application = document.application
  if (!isObject(editor) || !isObject(application)) return 'its document is not a Path document'
  if (editor.format_version !== CANVAS_FORMAT_VERSION) return `its canvas format version ${String(editor.format_version)} is not supported`
  if (!Array.isArray(editor.cards) || !Array.isArray(editor.connections) || !Array.isArray(application.skills)) return 'its document is not a Path document'
  const cardIds = new Set<string>()
  for (const card of editor.cards) {
    if (!isObject(card) || typeof card.id !== 'string' || card.id === '' || typeof card.title !== 'string' || !isPosition(card.position)) return 'a card is malformed'
    if (cardIds.has(card.id)) return `card ${card.id} appears twice`
    cardIds.add(card.id)
  }
  const skillIds = new Set<string>()
  const taskIds = new Set<string>()
  for (const skill of application.skills) {
    if (!isObject(skill) || typeof skill.id !== 'string' || typeof skill.title !== 'string' || typeof skill.outcome !== 'string' || !Array.isArray(skill.tasks)) return 'a Skill is malformed'
    if (!optional(skill.optional, (v) => typeof v === 'boolean') || !optional(skill.xpThreshold, isCount)) return 'a Skill is malformed'
    if (skillIds.has(skill.id)) return `Skill ${skill.id} appears twice`
    if (!cardIds.has(skill.id)) return `Skill ${skill.id} has no card`
    skillIds.add(skill.id)
    for (const task of skill.tasks) {
      if (!isObject(task) || typeof task.id !== 'string' || typeof task.title !== 'string' || typeof task.description !== 'string') return 'a Task is malformed'
      if (!optional(task.required, (v) => typeof v === 'boolean') || !optional(task.xpReward, isCount)) return 'a Task is malformed'
      if (taskIds.has(task.id)) return `Task ${task.id} belongs to more than one place`
      taskIds.add(task.id)
    }
  }
  for (const id of cardIds) if (!skillIds.has(id)) return `card ${id} has no Skill`
  const pairs = new Set<string>()
  for (const connection of editor.connections) {
    if (!isObject(connection) || typeof connection.from_id !== 'string' || typeof connection.to_id !== 'string') return 'a connection is malformed'
    if (!cardIds.has(connection.from_id) || !cardIds.has(connection.to_id)) return 'a connection joins a Skill that is not in the Path'
    if (connection.from_id === connection.to_id) return 'a Skill is connected to itself'
    const pair = `${connection.from_id}>${connection.to_id}`
    if (pairs.has(pair)) return 'a connection appears twice'
    pairs.add(pair)
  }
  return null
}

const canonicalTask = (task: PathTask) => [task.id, task.title, task.description, task.required ?? null, task.xpReward ?? null]
const canonicalSkill = (skill: PathSkill) => [skill.id, skill.title, skill.outcome, skill.optional ?? null, skill.xpThreshold ?? null, skill.tasks.map(canonicalTask)]
const byId = <T extends { id: string }>(items: T[]) => new Map(items.map((item) => [item.id, item]))
const pairOf = (connection: { from_id: string; to_id: string }) => `${connection.from_id}>${connection.to_id}`

/** Whether two Path documents hold the same content, card positions and connections. */
export function samePathWork(a: PathWork, b: PathWork) {
  const canonical = (work: PathWork) => JSON.stringify([
    work.title, work.goal,
    [...work.editor.cards].sort((x, y) => x.id.localeCompare(y.id)).map((card) => [card.id, card.title, card.position.x, card.position.y]),
    work.editor.connections.map(pairOf).sort(),
    work.application.skills.map(canonicalSkill),
  ])
  return canonical(a) === canonical(b)
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
/** One field after a three-way merge: the owner's value where they changed it, the accepted one otherwise. */
const pick = <T>(base: T, mine: T, current: T): T => (same(mine, base) ? current : mine)

function mergeTask(base: PathTask | undefined, mine: PathTask, current: PathTask): PathTask {
  if (!base) return { ...current, ...mine }
  const merged: PathTask = {
    id: current.id,
    title: pick(base.title, mine.title, current.title),
    description: pick(base.description, mine.description, current.description),
  }
  const required = pick(base.required, mine.required, current.required)
  const xpReward = pick(base.xpReward, mine.xpReward, current.xpReward)
  if (required !== undefined) merged.required = required
  if (xpReward !== undefined) merged.xpReward = xpReward
  return merged
}

function mergeSkill(base: PathSkill | undefined, mine: PathSkill, current: PathSkill): PathSkill {
  const baseTasks = byId(base?.tasks ?? [])
  const mineTasks = byId(mine.tasks)
  const currentTasks = new Set(current.tasks.map((task) => task.id))
  const tasks = [
    // The owner's deletions apply (a deleted Task is in the base, not in theirs); Tasks added elsewhere stay.
    ...current.tasks.filter((task) => mineTasks.has(task.id) || !baseTasks.has(task.id))
      .map((task) => (mineTasks.has(task.id) ? mergeTask(baseTasks.get(task.id), mineTasks.get(task.id)!, task) : task)),
    // Tasks the owner added.
    ...mine.tasks.filter((task) => !currentTasks.has(task.id) && !baseTasks.has(task.id)),
  ]
  if (!base) return { ...current, ...mine, tasks }
  const merged: PathSkill = {
    id: current.id,
    title: pick(base.title, mine.title, current.title),
    outcome: pick(base.outcome, mine.outcome, current.outcome),
    tasks,
  }
  const optionalSkill = pick(base.optional, mine.optional, current.optional)
  const xpThreshold = pick(base.xpThreshold, mine.xpThreshold, current.xpThreshold)
  if (optionalSkill !== undefined) merged.optional = optionalSkill
  if (xpThreshold !== undefined) merged.xpThreshold = xpThreshold
  return merged
}

/**
 * The owner's changes (from `base` to `mine`) applied onto the accepted `current`
 * document: fields, Skills, Tasks, card moves and connections the owner changed take
 * their value; everything else, including what was saved elsewhere meanwhile, stays as
 * accepted. The result is a proposal only: the backend still validates it (a
 * connection added on each side can form a cycle) and checks its revision.
 */
export function reapplyPath(base: PathWork, mine: PathWork, current: PathWork): PathWork {
  const baseSkills = byId(base.application.skills)
  const mineSkills = byId(mine.application.skills)
  const currentSkills = new Set(current.application.skills.map((skill) => skill.id))
  // Skills the owner deleted leave with their cards and connections, even where they were edited elsewhere;
  // the backend still refuses the save if they gained learning history meanwhile.
  const deleted = new Set([...baseSkills.keys()].filter((id) => !mineSkills.has(id)))
  const skills = [
    ...current.application.skills.filter((skill) => !deleted.has(skill.id))
      .map((skill) => (mineSkills.has(skill.id) ? mergeSkill(baseSkills.get(skill.id), mineSkills.get(skill.id)!, skill) : skill)),
    ...mine.application.skills.filter((skill) => !currentSkills.has(skill.id) && !baseSkills.has(skill.id)),
  ]
  const titles = new Map(skills.map((skill) => [skill.id, skill.title]))

  const baseCards = byId(base.editor.cards)
  const mineCards = byId(mine.editor.cards)
  const currentCards = new Set(current.editor.cards.map((card) => card.id))
  const cards = [
    ...current.editor.cards.filter((card) => !deleted.has(card.id)).map((card) => {
      const own = mineCards.get(card.id), from = baseCards.get(card.id)
      return { id: card.id, title: titles.get(card.id) ?? card.title, position: own && from ? pick(from.position, own.position, card.position) : own?.position ?? card.position }
    }),
    ...mine.editor.cards.filter((card) => !currentCards.has(card.id) && !baseCards.has(card.id))
      .map((card) => ({ id: card.id, title: titles.get(card.id) ?? card.title, position: card.position })),
  ]

  const basePairs = new Set(base.editor.connections.map(pairOf))
  const minePairs = new Set(mine.editor.connections.map(pairOf))
  const connections = [
    // The owner's removals apply; connections added elsewhere stay.
    ...current.editor.connections.filter((c) => !(basePairs.has(pairOf(c)) && !minePairs.has(pairOf(c)))),
    ...mine.editor.connections.filter((c) => !basePairs.has(pairOf(c)) && !current.editor.connections.some((d) => pairOf(d) === pairOf(c))),
  ].filter((c) => !deleted.has(c.from_id) && !deleted.has(c.to_id)).map((c) => ({ from_id: c.from_id, to_id: c.to_id }))

  return {
    title: pick(base.title, mine.title, current.title),
    goal: pick(base.goal, mine.goal, current.goal),
    editor: { format_version: CANVAS_FORMAT_VERSION, cards, connections },
    application: { skills },
  }
}

const quoted = (text: string) => `“${text.length > 40 ? `${text.slice(0, 40)}…` : text}”`

/** The owner's changes from `base` to `mine`, in their terms, for inspecting kept work. */
export function pathChanges(base: PathWork, mine: PathWork): string[] {
  const changes: string[] = []
  const name = (id: string) => quoted(mine.application.skills.find((s) => s.id === id)?.title ?? base.application.skills.find((s) => s.id === id)?.title ?? id)
  if (mine.title !== base.title) changes.push(`Renamed the Path to ${quoted(mine.title)}`)
  if (mine.goal !== base.goal) changes.push(`Changed the goal to ${quoted(mine.goal)}`)
  const baseSkills = byId(base.application.skills)
  for (const skill of mine.application.skills) {
    const before = baseSkills.get(skill.id)
    if (!before) {
      changes.push(`Added the Skill ${quoted(skill.title)}${skill.tasks.length ? ` with ${skill.tasks.length} Task${skill.tasks.length === 1 ? '' : 's'}` : ''}`)
      continue
    }
    if (skill.outcome !== before.outcome) changes.push(`Edited the learning outcome of ${quoted(skill.title)}`)
    if ((skill.optional ?? false) !== (before.optional ?? false)) changes.push(`Made ${quoted(skill.title)} ${skill.optional ? 'optional' : 'required'}`)
    if ((skill.xpThreshold ?? 0) !== (before.xpThreshold ?? 0)) changes.push(`Set the XP Threshold of ${quoted(skill.title)} to ${skill.xpThreshold ?? 0}`)
    const beforeTasks = byId(before.tasks)
    for (const task of skill.tasks) {
      const was = beforeTasks.get(task.id)
      if (!was) changes.push(`Added the Task ${quoted(task.title)} to ${quoted(skill.title)}`)
      else {
        if (task.title !== was.title || task.description !== was.description) changes.push(`Edited the Task ${quoted(task.title)} of ${quoted(skill.title)}`)
        if ((task.required ?? true) !== (was.required ?? true)) changes.push(`Made the Task ${quoted(task.title)} ${task.required ? 'Required' : 'Enrichment'}`)
        if ((task.xpReward ?? 0) !== (was.xpReward ?? 0)) changes.push(`Set the reward of ${quoted(task.title)} to ${task.xpReward ?? 0} XP`)
      }
    }
  }
  const mineSkills = byId(mine.application.skills)
  const deleted = new Set(base.application.skills.filter((skill) => !mineSkills.has(skill.id)).map((skill) => skill.id))
  for (const skill of base.application.skills) {
    if (deleted.has(skill.id)) changes.push(`Deleted the Skill ${quoted(skill.title)}${skill.tasks.length ? ` with ${skill.tasks.length} Task${skill.tasks.length === 1 ? '' : 's'}` : ''}`)
    else {
      const kept = new Set(mineSkills.get(skill.id)!.tasks.map((task) => task.id))
      for (const task of skill.tasks) if (!kept.has(task.id)) changes.push(`Deleted the Task ${quoted(task.title)} of ${quoted(skill.title)}`)
    }
  }
  const baseCards = byId(base.editor.cards)
  for (const card of mine.editor.cards) {
    const before = baseCards.get(card.id)
    if (before && !same(before.position, card.position)) changes.push(`Moved the card ${name(card.id)}`)
  }
  const basePairs = new Set(base.editor.connections.map(pairOf))
  const minePairs = new Set(mine.editor.connections.map(pairOf))
  for (const c of mine.editor.connections) if (!basePairs.has(pairOf(c))) changes.push(`Connected ${name(c.from_id)} → ${name(c.to_id)}`)
  // A deleted Skill's connections went with it.
  for (const c of base.editor.connections) if (!minePairs.has(pairOf(c)) && !deleted.has(c.from_id) && !deleted.has(c.to_id)) changes.push(`Removed the connection ${name(c.from_id)} → ${name(c.to_id)}`)
  return changes
}

/** Names Skills by title instead of ID in a backend refusal, e.g. the Skills of a cycle. */
export function nameSkills(detail: string, skills: { id: string; title: string }[]) {
  return skills.reduce((text, skill) => text.split(skill.id).join(quoted(skill.title)), detail)
}

// ---------------------------------------------------------------------------
// Canvas Layouts of published Versions

export function layoutWorkProblem(document: unknown): string | null {
  if (!Array.isArray(document)) return 'its layout is not a list of cards'
  const ids = new Set<string>()
  for (const card of document) {
    if (!isObject(card) || typeof card.id !== 'string' || card.id === '' || !isPosition(card.position)) return 'a card is malformed'
    if (ids.has(card.id)) return `card ${card.id} appears twice`
    ids.add(card.id)
  }
  return null
}

export function sameLayoutWork(a: LayoutWork, b: LayoutWork) {
  const canonical = (work: LayoutWork) => JSON.stringify([...work].sort((x, y) => x.id.localeCompare(y.id)).map((card) => [card.id, card.position.x, card.position.y]))
  return canonical(a) === canonical(b)
}

/** The owner's card moves applied onto the accepted layout; cards the Version does not hold are left out. */
export function reapplyLayout(base: LayoutWork, mine: LayoutWork, current: LayoutWork): LayoutWork {
  const baseCards = byId(base), mineCards = byId(mine)
  return current.map((card) => {
    const own = mineCards.get(card.id), from = baseCards.get(card.id)
    return { id: card.id, position: own && from ? pick(from.position, own.position, card.position) : card.position }
  })
}

export function layoutChanges(base: LayoutWork, mine: LayoutWork, titles: Map<string, string>): string[] {
  const baseCards = byId(base)
  return mine.filter((card) => baseCards.has(card.id) && !same(baseCards.get(card.id)!.position, card.position))
    .map((card) => `Moved the card ${quoted(titles.get(card.id) ?? card.id)}`)
}
