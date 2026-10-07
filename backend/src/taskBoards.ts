/**
 * The Task Board contract shared by every board context (ADR 0027): one Skill's
 * active Tasks arranged in ordered, identifiable columns. A board is saved whole,
 * based on the revision its author saw (ADR 0016), so the server can check the
 * complete result of an edit at once: every active Task of the Skill exactly once,
 * no other Task, and columns that keep the board usable. What membership means
 * (personal completion, Coach readiness, learner working state) belongs to each
 * context; this module knows only an optional Completion Column role.
 */

export interface BoardColumn {
  id: string
  name: string
  /** The Completion Column of a personal board; other contexts have none. */
  completion: boolean
  /** The column's cards, in order. */
  taskIds: string[]
}

export interface Board { skillId: string; revision: number; columns: BoardColumn[] }

/** An author's whole board, based on `expectedRevision`. */
export interface BoardInput { expectedRevision: number; columns: BoardColumn[] }

export const BOARD_LIMITS = { columns: 30, name: 60 }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The columns a new board starts with, in order; `completion` marks the personal Completion Column. */
export const PERSONAL_INITIAL_COLUMNS = [
  { name: 'Backlog', completion: false },
  { name: 'To Do', completion: false },
  { name: 'In Progress', completion: false },
  { name: 'Done', completion: true },
] as const

type Parsed<T> = { ok: true; value: T } | { ok: false; detail: string }

/**
 * Checks a board's shape: column IDs and names, and each Task on at most one card.
 * With `completionColumn`, exactly one column has the completion role, and at
 * least one other column remains for incomplete Tasks; without it, no column has
 * the role. Which Tasks may be on the board is checked against the store.
 */
export function parseBoardInput(body: unknown, { completionColumn }: { completionColumn: boolean }): Parsed<BoardInput> {
  const fail = (detail: string) => ({ ok: false as const, detail })
  if (!isObject(body) || !Array.isArray(body.columns)) return fail('expected expectedRevision and columns')
  const { expectedRevision, columns } = body
  if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return fail('expectedRevision must be a non-negative integer')
  if (columns.length === 0 || columns.length > BOARD_LIMITS.columns) return fail(`a board has 1–${BOARD_LIMITS.columns} columns`)
  const columnIds = new Set<string>()
  const taskIds = new Set<string>()
  const parsed: BoardColumn[] = []
  for (const column of columns) {
    if (!isObject(column) || typeof column.id !== 'string' || !UUID.test(column.id)) return fail('every column needs a UUID id')
    const id = column.id.toLowerCase()
    if (columnIds.has(id)) return fail(`column ${column.id} is listed twice`)
    columnIds.add(id)
    if (typeof column.name !== 'string' || column.name.trim() === '' || column.name.length > BOARD_LIMITS.name) return fail(`every column needs a name of 1–${BOARD_LIMITS.name} characters`)
    if (typeof column.completion !== 'boolean') return fail(`column ${column.id} needs completion (true or false)`)
    if (!Array.isArray(column.taskIds)) return fail(`column ${column.id} needs a taskIds array`)
    const cards: string[] = []
    for (const taskId of column.taskIds) {
      if (typeof taskId !== 'string' || !UUID.test(taskId)) return fail(`column ${column.id} lists a Task without a UUID id`)
      if (taskIds.has(taskId.toLowerCase())) return fail(`Task ${taskId} is on more than one card`)
      taskIds.add(taskId.toLowerCase())
      cards.push(taskId.toLowerCase())
    }
    parsed.push({ id, name: column.name, completion: column.completion, taskIds: cards })
  }
  const completions = parsed.filter((column) => column.completion).length
  if (completionColumn && completions !== 1) return fail('a personal board has exactly one Completion Column')
  if (!completionColumn && completions !== 0) return fail('this board has no Completion Column')
  if (completionColumn && parsed.length < 2) return fail('a board keeps at least one column besides the Completion Column')
  return { ok: true, value: { expectedRevision, columns: parsed } }
}

/**
 * Compares a board's cards with the Skill's active Tasks: a missing Task would be
 * lost from the board, and any other Task is not this board's (wrong Skill or
 * Path, archived, or unknown). Returns why the membership is wrong, or null.
 */
export function membershipProblem(columns: BoardColumn[], activeTaskIds: Iterable<string>): { refusal: 'board_task_missing' | 'board_task_unknown'; detail: string } | null {
  const active = new Set(activeTaskIds)
  const listed = new Set(columns.flatMap((column) => column.taskIds))
  const unknown = [...listed].find((id) => !active.has(id))
  if (unknown) return { refusal: 'board_task_unknown', detail: `Task ${unknown} is not an active Task of this Skill` }
  const missing = [...active].find((id) => !listed.has(id))
  if (missing) return { refusal: 'board_task_missing', detail: `Task ${missing} of this Skill is missing from the board; removing a column needs a destination for its Tasks` }
  return null
}

/** Whether two boards arrange the same columns and cards, whatever their revisions. */
export function sameArrangement(a: BoardColumn[], b: BoardColumn[]) {
  return a.length === b.length && a.every((column, i) => {
    const other = b[i]
    return column.id === other.id && column.name === other.name && column.completion === other.completion &&
      column.taskIds.length === other.taskIds.length && column.taskIds.every((id, j) => id === other.taskIds[j])
  })
}

/**
 * Where an existing Task is first placed when its board is created: completed Tasks
 * in the Completion Column, all others in the first column, each keeping the given
 * (existing) order. Placement replays nothing: it only reads completion.
 */
export function initialPlacement<T extends { id: string; completed: boolean }>(tasks: T[], columnIds: { first: string; completion: string | null }) {
  return tasks.map((task) => ({ taskId: task.id, columnId: task.completed && columnIds.completion ? columnIds.completion : columnIds.first }))
}
