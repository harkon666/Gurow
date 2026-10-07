/**
 * The Task Board model shared by every board context (ADR 0027): ordered,
 * identifiable columns holding ordered cards of one Skill's active Tasks. Edits are
 * kept as intents (move this Task there, remove that column into this one) so a
 * change refused as stale can be reapplied to the newer board instead of replacing
 * it. A column's role, never its name, decides what membership means.
 */

export interface BoardColumn {
  id: string
  name: string
  /** The personal Completion Column; other contexts have none. */
  completion: boolean
  taskIds: string[]
}

export interface Board { skillId: string; revision: number; columns: BoardColumn[] }

export const COLUMN_NAME_MAX = 60
export const MAX_COLUMNS = 30

export type BoardOp =
  /** `columnName` names the destination for an explanation if that column is removed elsewhere. */
  | { kind: 'move'; taskId: string; columnId: string; index: number; columnName?: string }
  | { kind: 'add-column'; columnId: string; name: string; index: number }
  | { kind: 'rename-column'; columnId: string; name: string }
  | { kind: 'move-column'; columnId: string; index: number }
  /** Removes a column after moving its Tasks to `destinationId`; a removed Completion Column hands its role to `replacementId`. */
  | { kind: 'remove-column'; columnId: string; destinationId: string; replacementId?: string }

/**
 * What applying an intent to a board gives: the new columns, `waiting` when it names
 * a Task this tab created whose save is still on the way (one of `pendingTaskIds`), or
 * `obsolete` when it no longer applies: a column is gone, or the Task was deleted or
 * archived.
 */
export type OpResult = { status: 'applied'; columns: BoardColumn[] } | { status: 'waiting' | 'obsolete' }

const clamp = (index: number, length: number) => Math.max(0, Math.min(index, length))
const usable = (columns: BoardColumn[]) => columns.some((column) => !column.completion)

/** Why a column name cannot be used, or null. */
export function columnNameProblem(name: string): string | null {
  if (name.trim() === '') return 'Enter a column name.'
  if (name.length > COLUMN_NAME_MAX) return `A column name has at most ${COLUMN_NAME_MAX} characters.`
  return null
}

export function applyOp(columns: BoardColumn[], op: BoardOp, pendingTaskIds: ReadonlySet<string> = new Set()): OpResult {
  const next = columns.map((column) => ({ ...column, taskIds: [...column.taskIds] }))
  const find = (id: string) => next.find((column) => column.id === id)
  switch (op.kind) {
    case 'move': {
      const target = find(op.columnId)
      if (!target) return { status: 'obsolete' }
      const source = next.find((column) => column.taskIds.includes(op.taskId))
      if (!source) return { status: pendingTaskIds.has(op.taskId) ? 'waiting' : 'obsolete' }
      source.taskIds.splice(source.taskIds.indexOf(op.taskId), 1)
      target.taskIds.splice(clamp(op.index, target.taskIds.length), 0, op.taskId)
      return { status: 'applied', columns: next }
    }
    case 'add-column': {
      if (find(op.columnId) || next.length >= MAX_COLUMNS || columnNameProblem(op.name)) return { status: 'obsolete' }
      next.splice(clamp(op.index, next.length), 0, { id: op.columnId, name: op.name, completion: false, taskIds: [] })
      return { status: 'applied', columns: next }
    }
    case 'rename-column': {
      const column = find(op.columnId)
      if (!column || columnNameProblem(op.name)) return { status: 'obsolete' }
      column.name = op.name
      return { status: 'applied', columns: next }
    }
    case 'move-column': {
      const column = find(op.columnId)
      if (!column) return { status: 'obsolete' }
      next.splice(next.indexOf(column), 1)
      next.splice(clamp(op.index, next.length), 0, column)
      return { status: 'applied', columns: next }
    }
    case 'remove-column': {
      const column = find(op.columnId)
      const destination = find(op.destinationId)
      if (!column || !destination || destination === column) return { status: 'obsolete' }
      if (column.completion) {
        const replacement = op.replacementId ? find(op.replacementId) : undefined
        if (!replacement || replacement === column) return { status: 'obsolete' }
        replacement.completion = true
      }
      destination.taskIds.push(...column.taskIds)
      next.splice(next.indexOf(column), 1)
      if (!usable(next)) return { status: 'obsolete' }
      return { status: 'applied', columns: next }
    }
  }
}

/** Applies intents in order: obsolete ones are dropped, and the first waiting one holds back the rest. */
export function applyOps(columns: BoardColumn[], ops: BoardOp[], pendingTaskIds: ReadonlySet<string> = new Set()) {
  let current = columns
  const applied: BoardOp[] = []
  const dropped: BoardOp[] = []
  for (const [index, op] of ops.entries()) {
    const result = applyOp(current, op, pendingTaskIds)
    if (result.status === 'waiting') return { columns: current, applied, dropped, waiting: ops.slice(index) }
    if (result.status === 'applied') {
      current = result.columns
      applied.push(op)
    } else dropped.push(op)
  }
  return { columns: current, applied, dropped, waiting: [] as BoardOp[] }
}

/**
 * The board as this tab shows it: the accepted board without Tasks deleted here, with
 * Tasks on their way to the backend (`pendingTaskIds`) at the end of the first usable
 * column, then every pending intent. A waiting intent applies here because its Task is
 * shown locally. A Task this tab holds that was removed elsewhere is not shown.
 */
export function localColumns(accepted: BoardColumn[], ops: BoardOp[], localTaskIds: string[], pendingTaskIds: ReadonlySet<string>) {
  const local = new Set(localTaskIds)
  const columns = accepted.map((column) => ({ ...column, taskIds: column.taskIds.filter((id) => local.has(id)) }))
  const first = columns.find((column) => !column.completion)
  if (first) first.taskIds.push(...localTaskIds.filter((id) => pendingTaskIds.has(id)))
  return applyOps(columns, ops, pendingTaskIds).columns
}

/**
 * Whether `next` differs from `base` only by cards added or removed (a Task created or
 * deleted through the document): the same columns, and every Task both hold in the
 * same column and relative order. Anything else is someone's organization change.
 */
export function onlyMembershipChanged(base: BoardColumn[], next: BoardColumn[]) {
  if (base.length !== next.length) return false
  const inBase = new Set(base.flatMap((column) => column.taskIds))
  const inNext = new Set(next.flatMap((column) => column.taskIds))
  return base.every((column, i) => {
    const other = next[i]
    const kept = column.taskIds.filter((id) => inNext.has(id))
    const otherKept = other.taskIds.filter((id) => inBase.has(id))
    return column.id === other.id && column.name === other.name && column.completion === other.completion &&
      kept.length === otherKept.length && kept.every((id, j) => id === otherKept[j])
  })
}

export const sameArrangement = (a: BoardColumn[], b: BoardColumn[]) => a.length === b.length && a.every((column, i) =>
  column.id === b[i].id && column.name === b[i].name && column.completion === b[i].completion &&
  column.taskIds.length === b[i].taskIds.length && column.taskIds.every((id, j) => id === b[i].taskIds[j]))

export interface CompletionEffect { taskId: string; completed: boolean }

/**
 * The completion changes an arrangement would record on a personal board: each Task
 * whose card crosses the Completion Column's boundary between `from` and `to`.
 */
export function completionEffects(from: BoardColumn[], to: BoardColumn[]): CompletionEffect[] {
  const completedIn = (columns: BoardColumn[]) => new Set(columns.filter((column) => column.completion).flatMap((column) => column.taskIds))
  const before = completedIn(from), after = completedIn(to)
  const tasks = new Set([...from, ...to].flatMap((column) => column.taskIds))
  return [...tasks].filter((id) => before.has(id) !== after.has(id)).map((taskId) => ({ taskId, completed: after.has(taskId) }))
}

/** The columns a removed column's Tasks can go to, and (for the Completion Column) which can take its role. */
export function removalChoices(columns: BoardColumn[], columnId: string) {
  const column = columns.find((c) => c.id === columnId)
  const others = columns.filter((c) => c.id !== columnId)
  // Removing must leave a usable column, besides the Completion Column where the board has one.
  const minimum = columns.some((c) => c.completion) ? 2 : 1
  const blocked = !column ? 'This column no longer exists.'
    : others.length < minimum ? (minimum === 2 ? 'A board keeps at least two columns: the Completion Column and one more.' : 'A board keeps at least one column.')
    : null
  return { column, destinations: others, replacements: column?.completion ? others : [], blocked }
}
