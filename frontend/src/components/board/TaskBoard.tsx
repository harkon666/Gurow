import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { TemporaryPanel } from '../editor/TemporaryPanel'
import { applyOp, columnNameProblem, completionEffects, COLUMN_NAME_MAX, MAX_COLUMNS, removalChoices, type BoardColumn, type BoardOp } from './boardModel'
import type { BoardStatus, BoardView } from './boardSync'

/**
 * A spacious Task Board for one Skill (ADR 0027): ordered columns of Task cards,
 * moved by dragging a card or through each card's Move menu, and columns added,
 * renamed, reordered and removed from their own menu. Everything is HTML, so it works
 * without WebGPU. What a column's membership means comes from the context through
 * `columnNote` and `effectText`; the board itself only arranges.
 */

export interface BoardTask { id: string; title: string; description: string }

export interface TaskBoardProps {
  skillTitle: string
  /** What this context calls the board (e.g. "Preparation board"); "Task Board" by default. */
  boardName?: string
  /** What the board's placement means here, shown under its header. */
  boardNote?: string
  view: BoardView
  /** This tab's active Tasks of the Skill. */
  tasks: BoardTask[]
  /** Backend-confirmed completion of a Task, shown on its card; undefined until it is saved. Absent where boards have no completion. */
  completed?: (taskId: string) => boolean | undefined
  /** Context facts shown on a card (e.g. Required or Enrichment, reward). */
  cardBadges?: (taskId: string) => ReactNode
  /** What removing a column changes beyond the Tasks' column, where the board has no Completion Column. */
  removalNote?: string
  /** What a column's role means here, shown under its name (e.g. "Moving a Task here completes it"). */
  columnNote?: (column: BoardColumn) => string | null
  /** The learning consequence of a Task entering (true) or leaving (false) the Completion Column. */
  effectText?: (taskId: string, completed: boolean) => string
  /** Why entering the Completion Column will be refused now, or null. */
  completionBlocked?: string | null
  onOp: (op: BoardOp) => void
  onRetry: () => void
  onDiscard: () => void
  onReapply: () => void
  /** Gives an intent whose destination column was removed elsewhere a new destination. */
  onRedirect: (op: BoardOp, columnId: string, columnName: string) => void
  /** Drops the intents that no longer apply. */
  onDiscardUnapplied: () => void
  onReload: () => void
  onClose: () => void
  onAddTask: (columnId: string, title: string, description: string) => void
  onEditTask: (taskId: string, change: { title: string; description: string }) => void
  /** Removal of one Task: deletion with undo when eligible, otherwise the context's archival. */
  removal: (taskId: string) => { kind: 'delete'; onDelete: () => void } | { kind: 'archive'; control: ReactNode } | { kind: 'unknown' }
  /** The last deletion, offered for undo. */
  deletion: { title: string; onUndo: () => void } | null
  /** Context controls inside a Task's details (reward, completion). */
  taskExtra?: (taskId: string) => ReactNode
  /** Extra status beside the board's save status (e.g. Path XP). */
  statusExtra?: ReactNode
}

const STATUS_TEXT: Record<BoardStatus['kind'], string> = {
  saved: 'All board changes saved',
  waiting: 'Waiting for your Task changes to save…',
  saving: 'Saving…',
  refused: 'Not saved: the change was refused',
  failed: 'Not saved: the save failed',
  conflict: 'Not saved: this board was changed elsewhere',
  unapplied: 'Not saved: a change no longer applies',
}

/** The board's full-screen modal surface; closing returns focus to the control that opened it. */
function BoardSurface({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const dialog = ref.current!
    const previous = document.activeElement as HTMLElement | null
    dialog.showModal()
    dialog.querySelector<HTMLElement>('#board-close-btn')?.focus()
    return () => {
      dialog.close()
      if (previous?.isConnected && previous !== document.body && previous.getClientRects().length) previous.focus()
      else document.getElementById('btn-skill-list')?.focus()
    }
  }, [])
  return createPortal(
    <dialog ref={ref} id="task-board" aria-label={title} onCancel={(event) => { event.preventDefault(); event.stopPropagation(); close.current() }}
      className="fixed inset-0 m-0 w-full h-dvh max-w-none max-h-none p-0 bg-slate-950 text-slate-200 backdrop:bg-black/60">
      {children}
    </dialog>, document.body,
  )
}

export function TaskBoard(props: TaskBoardProps) {
  const { view, tasks, onOp } = props
  const columns = view.columns
  const titles = new Map(tasks.map((task) => [task.id, task]))
  const [menu, setMenu] = useState<{ kind: 'card' | 'column'; id: string } | null>(null)
  const [adding, setAdding] = useState<string | null>(null)
  const [addingColumn, setAddingColumn] = useState(false)
  const [details, setDetails] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [drag, setDrag] = useState<{ taskId: string; dx: number; dy: number; target: { columnId: string; index: number } | null } | null>(null)
  /** The element to focus once the board re-renders after a keyboard action, and the one to use if it became unusable. */
  const focusNext = useRef<string | null>(null)
  const focusFallback = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!focusNext.current) return
    const target = document.getElementById(focusNext.current) as HTMLButtonElement | null
    const usable = target && !target.disabled ? target : focusFallback.current ? document.getElementById(focusFallback.current) : null
    usable?.focus()
    focusNext.current = null
    focusFallback.current = null
  })

  const perform = (op: BoardOp, focus?: string, fallback?: string) => {
    if (focus) focusNext.current = focus
    focusFallback.current = fallback ?? null
    onOp(op)
  }
  const columnOf = (taskId: string) => columns.find((column) => column.taskIds.includes(taskId))

  // Pointer dragging: a card follows the pointer, the column and slot under it are the destination.
  const pointer = useRef<{ taskId: string; id: number; x: number; y: number; dragging: boolean } | null>(null)
  const dropTarget = (x: number, y: number, taskId: string) => {
    // The dragged card itself follows the pointer; the column under it is what counts.
    const element = document.elementsFromPoint(x, y).filter((el) => !el.closest(`[data-card-id="${taskId}"]`))
      .map((el) => el.closest<HTMLElement>('[data-drop-column]')).find(Boolean)
    if (!element) return null
    const cards = [...element.querySelectorAll<HTMLElement>('[data-card-id]')].filter((card) => card.dataset.cardId !== taskId)
    const index = cards.filter((card) => { const r = card.getBoundingClientRect(); return r.top + r.height / 2 < y }).length
    return { columnId: element.dataset.dropColumn!, index }
  }
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>, taskId: string) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button, input, textarea, select, a, label')) return
    pointer.current = { taskId, id: event.pointerId, x: event.clientX, y: event.clientY, dragging: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const p = pointer.current
    if (!p || p.id !== event.pointerId) return
    const dx = event.clientX - p.x, dy = event.clientY - p.y
    if (!p.dragging && Math.hypot(dx, dy) < 6) return
    p.dragging = true
    setDrag({ taskId: p.taskId, dx, dy, target: dropTarget(event.clientX, event.clientY, p.taskId) })
  }
  const endDrag = (event: ReactPointerEvent<HTMLElement>, drop: boolean) => {
    const p = pointer.current
    if (!p || p.id !== event.pointerId) return
    pointer.current = null
    const target = p.dragging && drop ? dropTarget(event.clientX, event.clientY, p.taskId) : null
    setDrag(null)
    if (target) onOp({ kind: 'move', taskId: p.taskId, columnId: target.columnId, index: target.index, columnName: columns.find((c) => c.id === target.columnId)?.name })
  }
  useEffect(() => {
    if (!drag) return
    // Escape cancels a drag without closing the board.
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      pointer.current = null
      setDrag(null)
    }
    window.addEventListener('keydown', cancel, true)
    return () => window.removeEventListener('keydown', cancel, true)
  }, [drag])

  const jumpTo = (columnId: string) => {
    const heading = document.getElementById(`board-column-heading-${columnId}`)
    heading?.scrollIntoView({ inline: 'start', block: 'nearest' })
    heading?.focus()
  }

  return (
    <BoardSurface title={`${props.boardName ?? 'Task Board'} · ${props.skillTitle}`} onClose={() => { if (!drag) props.onClose() }}>
      <div className="h-full flex flex-col">
        <header className="shrink-0 flex flex-wrap items-center gap-3 px-4 py-3 border-b border-slate-800 bg-slate-900/70">
          <button id="board-close-btn" onClick={props.onClose} className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800">← Back to canvas</button>
          <h2 id="board-title" className="text-base font-semibold text-slate-100">{props.boardName ?? 'Task Board'} · {props.skillTitle}</h2>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {props.statusExtra}
            <BoardStatusBadge status={view.status} />
            <button
              id="board-add-column-btn"
              onClick={() => setAddingColumn(true)}
              disabled={!view.accepted || columns.length >= MAX_COLUMNS}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"
            >
              Add column
            </button>
          </div>
        </header>
        {props.boardNote && <p id="board-note" className="shrink-0 px-4 py-1.5 text-xs text-slate-400 border-b border-slate-800">{props.boardNote}</p>}
        <BoardAlerts {...props} titleOf={(id) => titles.get(id)?.title ?? null} />
        {view.goneTaskIds.length > 0 && (
          <p id="board-stale-tasks" role="status" data-task-ids={view.goneTaskIds.join(',')} className="shrink-0 px-4 py-2 text-xs text-amber-100 bg-amber-950/30 border-b border-amber-900/60">
            {view.goneTaskIds.length === 1 ? `“${titles.get(view.goneTaskIds[0])?.title ?? 'A Task'}” was` : `${view.goneTaskIds.length} Tasks were`} deleted or archived elsewhere, so the board no longer shows {view.goneTaskIds.length === 1 ? 'it' : 'them'}. Reload the page to see the latest Tasks.
          </p>
        )}
        {props.deletion && (
          <p id="board-deletion" role="status" className="shrink-0 flex items-center gap-3 px-4 py-2 text-xs text-slate-200 bg-slate-900 border-b border-slate-800">
            Deleted “{props.deletion.title}”.
            <button id="board-undo-delete-btn" onClick={props.deletion.onUndo} className="rounded border border-slate-600 px-2 py-0.5 hover:bg-slate-800">Undo</button>
          </p>
        )}
        {addingColumn && (
          <NewColumnForm
            onCancel={() => { focusNext.current = 'board-add-column-btn'; setAddingColumn(false) }}
            onAdd={(name) => {
              const columnId = crypto.randomUUID()
              setAddingColumn(false)
              const completion = columns.findIndex((column) => column.completion)
              // A new column goes before the Completion Column, where work usually continues.
              perform({ kind: 'add-column', columnId, name, index: completion < 0 ? columns.length : completion }, `board-column-heading-${columnId}`)
            }}
          />
        )}
        {columns.length > 1 && (
          <label className="md:hidden shrink-0 flex items-center gap-2 px-4 py-2 text-xs text-slate-300 border-b border-slate-800">
            Column
            <select id="board-column-select" defaultValue="" onChange={(e) => { if (e.target.value) jumpTo(e.target.value); e.target.value = '' }}
              className="flex-1 bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-100">
              <option value="" disabled>Go to a column…</option>
              {columns.map((column) => <option key={column.id} value={column.id}>{column.name} ({column.taskIds.length})</option>)}
            </select>
          </label>
        )}
        {!view.accepted && !view.loadError && <p id="board-loading" className="p-6 text-sm text-slate-400">Opening the board…</p>}
        <div id="board-columns" data-dragging={drag !== null} className="flex-1 min-h-0 flex gap-3 overflow-x-auto snap-x snap-mandatory md:snap-none p-4">
          {columns.map((column, columnIndex) => {
            const note = props.columnNote?.(column)
            return (
              <section
                key={column.id}
                id={`board-column-${column.id}`}
                data-drop-column={column.id}
                data-completion={column.completion}
                data-name={column.name}
                aria-labelledby={`board-column-heading-${column.id}`}
                className={`snap-start shrink-0 w-[85vw] max-w-[22rem] md:w-72 flex flex-col rounded-xl border ${column.completion ? 'border-emerald-800/70 bg-emerald-950/20' : 'border-slate-800 bg-slate-900/50'} ${drag?.target?.columnId === column.id ? 'ring-2 ring-blue-500' : ''}`}
              >
                <div className="px-3 pt-3 pb-2 border-b border-slate-800/80">
                  <div className="flex items-center justify-between gap-2">
                    <h3 id={`board-column-heading-${column.id}`} tabIndex={-1} className="text-sm font-semibold text-slate-100 truncate">
                      {column.name} <span className="text-slate-500 font-normal">· {column.taskIds.length}</span>
                    </h3>
                    <button
                      id={`column-menu-${column.id}`}
                      aria-expanded={menu?.kind === 'column' && menu.id === column.id}
                      aria-label={`Actions for column ${column.name}`}
                      onClick={() => setMenu(menu?.kind === 'column' && menu.id === column.id ? null : { kind: 'column', id: column.id })}
                      className="shrink-0 rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-300 hover:bg-slate-800"
                    >
                      ⋯
                    </button>
                  </div>
                  {column.completion && <p className="mt-1 text-[10px] uppercase tracking-wider text-emerald-300">Completion Column</p>}
                  {note && <p className="mt-1 text-[11px] text-slate-400">{note}</p>}
                  {menu?.kind === 'column' && menu.id === column.id && (
                    <ColumnMenu
                      column={column}
                      first={columnIndex === 0}
                      last={columnIndex === columns.length - 1}
                      onRename={(name) => { setMenu(null); perform({ kind: 'rename-column', columnId: column.id, name }, `column-menu-${column.id}`) }}
                      onMove={(delta) => perform({ kind: 'move-column', columnId: column.id, index: columnIndex + delta }, `column-move-${delta < 0 ? 'left' : 'right'}-${column.id}`, `column-menu-${column.id}`)}
                      onRemove={() => { setMenu(null); setRemoving(column.id) }}
                      onClose={() => { focusNext.current = `column-menu-${column.id}`; setMenu(null) }}
                    />
                  )}
                </div>
                <ol className="flex-1 min-h-[4rem] overflow-y-auto p-2 flex flex-col gap-2" aria-label={`Tasks in ${column.name}`}>
                  {column.taskIds.length === 0 && <li className="text-[11px] italic text-slate-500 px-1 py-2">No Tasks here yet.</li>}
                  {column.taskIds.map((taskId, index) => {
                    const task = titles.get(taskId)
                    if (!task) return null
                    const dragged = drag?.taskId === taskId
                    const completed = props.completed?.(taskId)
                    return (
                      <li key={taskId} className="relative">
                        {drag?.target?.columnId === column.id && drag.target.index === index && !dragged && <div data-drop-indicator className="absolute -top-1.5 inset-x-1 h-0.5 rounded bg-blue-400" />}
                        <article
                          id={`board-card-${taskId}`}
                          data-card-id={taskId}
                          data-column-id={column.id}
                          data-completed={!props.completed ? undefined : completed === undefined ? 'unknown' : String(completed)}
                          aria-label={task.title}
                          onPointerDown={(e) => onPointerDown(e, taskId)}
                          onPointerMove={onPointerMove}
                          onPointerUp={(e) => endDrag(e, true)}
                          onPointerCancel={(e) => endDrag(e, false)}
                          style={dragged ? { transform: `translate(${drag.dx}px, ${drag.dy}px)`, zIndex: 20 } : undefined}
                          className={`rounded-lg border bg-slate-950 p-2.5 select-none cursor-grab ${dragged ? 'opacity-80 shadow-2xl border-blue-500 cursor-grabbing' : 'border-slate-700 hover:border-slate-500'}`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <h4 id={`board-card-title-${taskId}`} className="text-sm text-slate-100 break-words">{task.title}</h4>
                            {completed && <span className="shrink-0 text-[10px] text-emerald-300 border border-emerald-800/70 rounded px-1">Complete</span>}
                          </div>
                          {task.description && <p className="mt-1 text-xs text-slate-400 line-clamp-2 whitespace-pre-wrap">{task.description}</p>}
                          {props.cardBadges && <div className="mt-1.5 flex flex-wrap gap-1">{props.cardBadges(taskId)}</div>}
                          <div className="mt-2 flex gap-1.5">
                            <button id={`card-move-${taskId}`} aria-expanded={menu?.kind === 'card' && menu.id === taskId}
                              onClick={() => setMenu(menu?.kind === 'card' && menu.id === taskId ? null : { kind: 'card', id: taskId })}
                              className="text-[11px] rounded border border-slate-700 px-2 py-0.5 text-slate-300 hover:bg-slate-800">Move</button>
                            <button id={`card-details-${taskId}`} onClick={() => setDetails(taskId)} className="text-[11px] rounded border border-slate-700 px-2 py-0.5 text-slate-300 hover:bg-slate-800">Details</button>
                          </div>
                          {menu?.kind === 'card' && menu.id === taskId && (
                            <CardMoveMenu
                              taskId={taskId}
                              columns={columns}
                              columnId={column.id}
                              index={index}
                              effect={(to) => {
                                const result = applyOp(columns, { kind: 'move', taskId, columnId: to, index: 0 })
                                const change = result.status === 'applied' ? completionEffects(columns, result.columns)[0] : undefined
                                return change && props.effectText ? props.effectText(taskId, change.completed) : null
                              }}
                              onMove={(columnId, to, focus) => perform({ kind: 'move', taskId, columnId, index: to, columnName: columns.find((c) => c.id === columnId)?.name }, focus, `card-move-${taskId}`)}
                              onClose={() => { focusNext.current = `card-move-${taskId}`; setMenu(null) }}
                            />
                          )}
                        </article>
                      </li>
                    )
                  })}
                  {drag?.target?.columnId === column.id && drag.target.index >= column.taskIds.filter((id) => id !== drag.taskId).length && <li data-drop-indicator className="h-0.5 rounded bg-blue-400 mx-1" />}
                </ol>
                <div className="p-2 border-t border-slate-800/80">
                  {adding === column.id ? (
                    <NewTaskForm
                      onCancel={() => { focusNext.current = `add-card-${column.id}`; setAdding(null) }}
                      onAdd={(title, description) => { focusNext.current = `add-card-${column.id}`; setAdding(null); props.onAddTask(column.id, title, description) }}
                    />
                  ) : (
                    <button id={`add-card-${column.id}`} onClick={() => setAdding(column.id)} disabled={!view.accepted}
                      className="w-full text-xs rounded-lg border border-dashed border-slate-700 py-1.5 text-slate-300 hover:bg-slate-800 disabled:opacity-50">
                      + Add Task
                    </button>
                  )}
                </div>
              </section>
            )
          })}
        </div>
      </div>
      {details && titles.get(details) && (
        <CardDetails
          task={titles.get(details)!}
          columnName={columnOf(details)?.name ?? ''}
          removal={props.removal(details)}
          extra={props.taskExtra?.(details)}
          onSave={(change) => props.onEditTask(details, change)}
          onClose={() => setDetails(null)}
        />
      )}
      {removing && (
        <RemoveColumnDialog
          columns={view.boardColumns}
          columnId={removing}
          titleOf={(id) => titles.get(id)?.title ?? null}
          effectText={props.effectText}
          removalNote={props.removalNote}
          completionBlocked={props.completionBlocked ?? null}
          onConfirm={(op) => { setRemoving(null); perform(op, 'board-add-column-btn') }}
          onClose={() => setRemoving(null)}
        />
      )}
    </BoardSurface>
  )
}

function BoardStatusBadge({ status }: { status: BoardStatus }) {
  const tone = status.kind === 'saved' ? 'text-emerald-300 border-emerald-800/60' : status.kind === 'saving' || status.kind === 'waiting' ? 'text-slate-300 border-slate-700' : 'text-red-300 border-red-800/70'
  return <span id="board-save-status" role="status" data-state={status.kind} className={`text-xs px-2 py-1 rounded-lg border bg-slate-950/80 ${tone}`}>{STATUS_TEXT[status.kind]}</span>
}

/** Refusals, failures and conflicts, in user language, each with the choices that keep or drop the local change. */
/** Says what an intent that no longer applies was meant to do. */
function describeUnapplied(op: BoardOp, titleOf: (taskId: string) => string | null) {
  switch (op.kind) {
    case 'move': {
      const title = titleOf(op.taskId)
      return title === null
        ? 'Moving a Task that was deleted or archived'
        : `Moving “${title}” to ${op.columnName ? `“${op.columnName}”` : 'a column'}, which was removed elsewhere`
    }
    case 'add-column': return `Adding the column “${op.name}”, which can no longer be added`
    case 'rename-column': return `Renaming a column to “${op.name}”, but that column was removed elsewhere`
    case 'move-column': return 'Moving a column that was removed elsewhere'
    case 'remove-column': return 'Removing a column, but it or its chosen destination or replacement changed elsewhere'
  }
}

function BoardAlerts({ view, onRetry, onDiscard, onReapply, onReload, onRedirect, onDiscardUnapplied, titleOf }: TaskBoardProps & { titleOf: (taskId: string) => string | null }) {
  const status = view.status
  const button = 'rounded border border-slate-600 px-2 py-0.5 hover:bg-slate-800'
  if (view.loadError) {
    return (
      <div id="board-load-error" role="alert" className="shrink-0 flex flex-wrap items-center gap-2 px-4 py-2 text-xs text-red-200 bg-red-950/40 border-b border-red-900/60">
        The board could not be loaded ({view.loadError}).
        <button id="board-reload-btn" onClick={onReload} className={button}>Reload</button>
      </div>
    )
  }
  if (status.kind === 'refused' || status.kind === 'failed') {
    return (
      <div id="board-error" role="alert" data-kind={status.kind} className="shrink-0 flex flex-wrap items-center gap-2 px-4 py-2 text-xs text-red-200 bg-red-950/40 border-b border-red-900/60">
        <span>Your board change is kept here, not saved: {status.detail}.</span>
        <button id="board-retry-btn" onClick={onRetry} className={button}>Retry</button>
        <button id="board-discard-btn" onClick={onDiscard} className={button}>Discard my change</button>
      </div>
    )
  }
  if (status.kind === 'unapplied') {
    return (
      <div id="board-unapplied" role="alert" className="shrink-0 flex flex-col gap-2 px-4 py-2 text-xs text-amber-100 bg-amber-950/40 border-b border-amber-900/60">
        <span>Some of your board changes are kept here, not saved, because the board changed elsewhere:</span>
        <ul className="flex flex-col gap-1.5">
          {status.ops.map((op, i) => (
            <li key={i} data-kind={op.kind} data-task-id={op.kind === 'move' ? op.taskId : undefined} className="flex flex-wrap items-center gap-2">
              {describeUnapplied(op, titleOf)}.
              {op.kind === 'move' && titleOf(op.taskId) !== null && <RedirectControl index={i} columns={view.accepted?.columns ?? []} onRedirect={(columnId, name) => onRedirect(op, columnId, name)} />}
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <button id="board-discard-unapplied-btn" onClick={onDiscardUnapplied} className={button}>Discard {status.ops.length === 1 ? 'this change' : 'these changes'}</button>
          <button id="board-discard-btn" onClick={onDiscard} className={button}>Discard all my changes</button>
        </div>
      </div>
    )
  }
  if (status.kind === 'conflict') {
    return (
      <div id="board-conflict" role="alert" className="shrink-0 flex flex-wrap items-center gap-2 px-4 py-2 text-xs text-amber-100 bg-amber-950/40 border-b border-amber-900/60">
        <span>This board was changed elsewhere. Your change is kept here, not saved.</span>
        <button id="board-reapply-btn" onClick={onReapply} className={button}>Apply my change to the latest board</button>
        <button id="board-discard-btn" onClick={onDiscard} className={button}>Use the latest board</button>
      </div>
    )
  }
  return null
}

function RedirectControl({ index, columns, onRedirect }: { index: number; columns: BoardColumn[]; onRedirect: (columnId: string, name: string) => void }) {
  const [target, setTarget] = useState(columns.find((c) => !c.completion)?.id ?? columns[0]?.id ?? '')
  const column = columns.find((c) => c.id === target)
  return (
    <span className="flex items-center gap-1.5">
      <label htmlFor={`board-redirect-select-${index}`} className="sr-only">New destination</label>
      <select id={`board-redirect-select-${index}`} value={target} onChange={(e) => setTarget(e.target.value)} className="bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-slate-100">
        {columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <button id={`board-redirect-btn-${index}`} disabled={!column} onClick={() => column && onRedirect(column.id, column.name)} className="rounded border border-slate-600 px-2 py-0.5 hover:bg-slate-800">Move it there instead</button>
    </span>
  )
}

function NewColumnForm({ onAdd, onCancel }: { onAdd: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const problem = columnNameProblem(name)
    if (problem) return setError(problem)
    onAdd(name.trim())
  }
  return (
    <form id="new-column-form" onSubmit={submit} className="shrink-0 flex flex-wrap items-center gap-2 px-4 py-2 border-b border-slate-800 bg-slate-900/60">
      <label htmlFor="new-column-name" className="text-xs text-slate-300">New column</label>
      <input id="new-column-name" autoFocus value={name} maxLength={COLUMN_NAME_MAX} onChange={(e) => { setName(e.target.value); setError(null) }}
        aria-invalid={error !== null} aria-describedby={error ? 'new-column-error' : undefined}
        className="text-sm bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-100" />
      <button id="new-column-submit" type="submit" className="text-xs rounded bg-emerald-700 hover:bg-emerald-600 px-3 py-1 text-white">Add column</button>
      <button type="button" onClick={onCancel} className="text-xs rounded border border-slate-700 px-3 py-1">Cancel</button>
      {error && <p id="new-column-error" role="alert" className="w-full text-xs text-red-300">{error}</p>}
    </form>
  )
}

function NewTaskForm({ onAdd, onCancel }: { onAdd: (title: string, description: string) => void; onCancel: () => void }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (title.trim() === '') {
      setError('Enter a title for the Task.')
      titleRef.current?.focus()
      return
    }
    onAdd(title.trim(), description)
  }
  return (
    <form id="new-card-form" onSubmit={submit} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel() } }} className="flex flex-col gap-1.5">
      <input id="new-card-title" ref={titleRef} autoFocus aria-label="Task title (required)" placeholder="Task title (required)" value={title} maxLength={200}
        onChange={(e) => { setTitle(e.target.value); setError(null) }} aria-invalid={error !== null} aria-describedby={error ? 'new-card-error' : undefined}
        className="text-sm bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-100" />
      <textarea id="new-card-description" aria-label="Description (optional)" placeholder="Description (optional)" value={description} rows={2}
        onChange={(e) => setDescription(e.target.value)} className="text-xs bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200 resize-none" />
      {error && <p id="new-card-error" role="alert" className="text-xs text-red-300">{error}</p>}
      <div className="flex gap-2">
        <button id="new-card-submit" type="submit" className="text-xs rounded bg-emerald-700 hover:bg-emerald-600 px-3 py-1 text-white">Add Task</button>
        <button type="button" onClick={onCancel} className="text-xs rounded border border-slate-700 px-3 py-1">Cancel</button>
      </div>
    </form>
  )
}

function ColumnMenu({ column, first, last, onRename, onMove, onRemove, onClose }: {
  column: BoardColumn
  first: boolean
  last: boolean
  onRename: (name: string) => void
  onMove: (delta: -1 | 1) => void
  onRemove: () => void
  onClose: () => void
}) {
  const [name, setName] = useState(column.name)
  const [error, setError] = useState<string | null>(null)
  const rename = (event: FormEvent) => {
    event.preventDefault()
    const problem = columnNameProblem(name)
    if (problem) return setError(problem)
    onRename(name.trim())
  }
  const button = 'text-[11px] rounded border border-slate-700 px-2 py-0.5 text-slate-300 hover:bg-slate-800 disabled:opacity-40'
  return (
    <div id={`column-actions-${column.id}`} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() } }} className="mt-2 flex flex-col gap-2 rounded border border-slate-700 bg-slate-950 p-2">
      <form onSubmit={rename} className="flex flex-col gap-1">
        <label htmlFor={`column-rename-${column.id}`} className="text-[11px] text-slate-400">Name</label>
        <div className="flex gap-1.5">
          <input id={`column-rename-${column.id}`} value={name} maxLength={COLUMN_NAME_MAX} onChange={(e) => { setName(e.target.value); setError(null) }}
            aria-invalid={error !== null} className="flex-1 min-w-0 text-xs bg-slate-900 border border-slate-700 rounded px-2 py-1 text-slate-100" />
          <button id={`column-rename-save-${column.id}`} type="submit" className={button}>Rename</button>
        </div>
        {error && <p id={`column-rename-error-${column.id}`} role="alert" className="text-[11px] text-red-300">{error}</p>}
      </form>
      <div className="flex flex-wrap gap-1.5">
        <button id={`column-move-left-${column.id}`} disabled={first} onClick={() => onMove(-1)} className={button}>Move left</button>
        <button id={`column-move-right-${column.id}`} disabled={last} onClick={() => onMove(1)} className={button}>Move right</button>
        <button id={`column-remove-${column.id}`} onClick={onRemove} className={`${button} text-red-300`}>Remove column…</button>
      </div>
    </div>
  )
}

function CardMoveMenu({ taskId, columns, columnId, index, effect, onMove, onClose }: {
  taskId: string
  columns: BoardColumn[]
  columnId: string
  index: number
  effect: (columnId: string) => string | null
  onMove: (columnId: string, index: number, focus: string) => void
  onClose: () => void
}) {
  const others = columns.filter((column) => column.id !== columnId)
  const [target, setTarget] = useState(others[0]?.id ?? '')
  const count = columns.find((column) => column.id === columnId)?.taskIds.length ?? 0
  const consequence = target ? effect(target) : null
  const button = 'text-[11px] rounded border border-slate-700 px-2 py-0.5 text-slate-300 hover:bg-slate-800 disabled:opacity-40'
  return (
    <div id={`card-move-menu-${taskId}`} role="group" aria-label="Move this Task" onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() } }}
      className="mt-2 flex flex-col gap-1.5 rounded border border-slate-700 bg-slate-900 p-2">
      <div className="flex gap-1.5">
        <button id={`card-move-up-${taskId}`} disabled={index === 0} onClick={() => onMove(columnId, index - 1, `card-move-up-${taskId}`)} className={button}>Move up</button>
        <button id={`card-move-down-${taskId}`} disabled={index >= count - 1} onClick={() => onMove(columnId, index + 1, `card-move-down-${taskId}`)} className={button}>Move down</button>
      </div>
      {others.length > 0 && (
        <div className="flex gap-1.5">
          <label htmlFor={`card-move-column-${taskId}`} className="sr-only">Destination column</label>
          <select id={`card-move-column-${taskId}`} value={target} onChange={(e) => setTarget(e.target.value)}
            className="flex-1 min-w-0 text-xs bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-slate-100">
            {others.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}
          </select>
          <button id={`card-move-apply-${taskId}`} onClick={() => onMove(target, Number.MAX_SAFE_INTEGER, `card-move-${taskId}`)} className={button}>Move to column</button>
        </div>
      )}
      {consequence && <p id={`card-move-effect-${taskId}`} className="text-[11px] text-amber-200">{consequence}</p>}
    </div>
  )
}

function CardDetails({ task, columnName, removal, extra, onSave, onClose }: {
  task: BoardTask
  columnName: string
  removal: ReturnType<TaskBoardProps['removal']>
  extra: ReactNode
  onSave: (change: { title: string; description: string }) => void
  onClose: () => void
}) {
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const save = (event: FormEvent) => {
    event.preventDefault()
    if (title.trim() === '') return setError('A Task needs a title.')
    // Submitting unchanged values (an Enter that opened these details, say) changes nothing.
    if (title.trim() === task.title && description === task.description) return
    onSave({ title: title.trim(), description })
    setSaved(true)
  }
  return (
    <TemporaryPanel title="Task details" closeId="btn-close-card-details" onClose={onClose} initialFocus="#card-edit-title">
      <div id="card-details" data-task-id={task.id} className="p-4 flex flex-col gap-4">
        <p className="text-xs text-slate-400">In column <span className="text-slate-200">{columnName}</span></p>
        <form onSubmit={save} className="flex flex-col gap-2">
          <label htmlFor="card-edit-title" className="text-xs text-slate-300">Title (required)</label>
          <input id="card-edit-title" value={title} maxLength={200} onChange={(e) => { setTitle(e.target.value); setError(null); setSaved(false) }}
            aria-invalid={error !== null} aria-describedby={error ? 'card-edit-error' : undefined}
            className="text-sm bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-100" />
          <label htmlFor="card-edit-description" className="text-xs text-slate-300">Description (optional)</label>
          <textarea id="card-edit-description" value={description} rows={4} onChange={(e) => { setDescription(e.target.value); setSaved(false) }}
            className="text-sm bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-200 resize-y" />
          {error && <p id="card-edit-error" role="alert" className="text-xs text-red-300">{error}</p>}
          {saved && <p id="card-edit-applied" role="status" className="text-xs text-slate-400">Changed here; the save status shows when it is saved.</p>}
          <button id="card-edit-save" type="submit" className="self-start text-xs rounded bg-blue-700 hover:bg-blue-600 px-3 py-1.5 text-white">Save changes</button>
        </form>
        {extra}
        <div className="border-t border-slate-800 pt-3 flex flex-col gap-2">
          {removal.kind === 'delete' && (
            <button id="card-delete-btn" onClick={() => { onClose(); removal.onDelete() }} className="self-start text-xs rounded border border-red-900 text-red-300 px-3 py-1.5 hover:bg-red-950/40">Delete Task</button>
          )}
          {removal.kind === 'archive' && (
            <>
              <p className="text-xs text-slate-400">This Task has learning history, so it is archived rather than deleted. Archived Tasks stay in the Skill's history, outside the board.</p>
              {removal.control}
            </>
          )}
          {removal.kind === 'unknown' && <p className="text-xs text-slate-500">Checking whether this Task can be deleted…</p>}
        </div>
      </div>
    </TemporaryPanel>
  )
}

function RemoveColumnDialog({ columns, columnId, titleOf, effectText, removalNote, completionBlocked, onConfirm, onClose }: {
  columns: BoardColumn[]
  columnId: string
  titleOf: (taskId: string) => string | null
  effectText?: (taskId: string, completed: boolean) => string
  removalNote?: string
  completionBlocked: string | null
  onConfirm: (op: BoardOp) => void
  onClose: () => void
}) {
  const { column, destinations, replacements, blocked } = removalChoices(columns, columnId)
  const [destination, setDestination] = useState(destinations.find((c) => !c.completion)?.id ?? destinations[0]?.id ?? '')
  const [replacement, setReplacement] = useState(replacements.find((c) => c.id !== destination)?.id ?? replacements[0]?.id ?? '')
  const op: BoardOp = { kind: 'remove-column', columnId, destinationId: destination, ...(column?.completion ? { replacementId: replacement } : {}) }
  const result = column && !blocked ? applyOp(columns, op) : null
  const effects = result?.status === 'applied' ? completionEffects(columns, result.columns) : []
  const blockedCompletion = completionBlocked && effects.some((effect) => effect.completed) ? completionBlocked : null
  const empty = (column?.taskIds.length ?? 0) === 0
  return (
    <TemporaryPanel title={`Remove column “${column?.name ?? ''}”`} closeId="btn-close-remove-column" onClose={onClose} initialFocus="#remove-destination-select">
      <div id="remove-column-dialog" className="p-4 flex flex-col gap-3 text-sm">
        {blocked ? <p id="remove-column-blocked" role="alert" className="text-amber-200">{blocked}</p> : (
          <>
            <p className="text-slate-300">{empty ? 'This column has no Tasks.' : `Its ${column!.taskIds.length === 1 ? 'Task moves' : `${column!.taskIds.length} Tasks move`} to the column you choose. No Task is deleted.`}</p>
            <label className="flex flex-col gap-1 text-xs text-slate-300">
              Move its Tasks to
              <select id="remove-destination-select" value={destination} onChange={(e) => setDestination(e.target.value)} className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm text-slate-100">
                {destinations.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            {column?.completion && (
              <label className="flex flex-col gap-1 text-xs text-slate-300">
                New Completion Column (Tasks in it count as complete)
                <select id="remove-replacement-select" value={replacement} onChange={(e) => setReplacement(e.target.value)} className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm text-slate-100">
                  {replacements.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            )}
            <div id="remove-consequences" className="rounded border border-slate-700 bg-slate-900 p-3 text-xs text-slate-300">
              <p className="font-semibold text-slate-200 mb-1">What happens</p>
              {effects.length === 0 ? <p id="remove-no-learning-change">{removalNote ?? 'No Task\'s completion or XP changes.'}</p> : (
                <ul className="list-disc pl-4 space-y-0.5">
                  {effects.map((effect) => {
                    const title = titleOf(effect.taskId)
                    const change = effect.completed ? 'becomes complete' : 'is no longer complete'
                    // A Task added in another tab is on the board this removal saves, though this tab cannot show it yet.
                    return (
                      <li key={effect.taskId} data-task-id={effect.taskId} data-completed={effect.completed} data-known={title !== null}>
                        {title === null
                          ? `A Task added in another tab ${change}, with its XP ${effect.completed ? 'Award' : 'Correction'}; reload the page to see it.`
                          : `“${title}” ${change}${effectText ? `: ${effectText(effect.taskId, effect.completed)}` : ''}.`}
                      </li>
                    )
                  })}
                </ul>
              )}
              {!removalNote && <p className="mt-1 text-slate-500">Mastery does not change.</p>}
            </div>
            {blockedCompletion && <p id="remove-column-refusal" role="alert" className="text-xs text-red-300">{blockedCompletion}</p>}
            <div className="flex gap-2">
              <button id="remove-column-confirm" disabled={result?.status !== 'applied' || blockedCompletion !== null} onClick={() => onConfirm(op)}
                className="text-xs rounded bg-red-700 hover:bg-red-600 disabled:opacity-50 px-3 py-1.5 text-white">Remove column</button>
              <button id="remove-column-cancel" onClick={onClose} className="text-xs rounded border border-slate-700 px-3 py-1.5">Cancel</button>
            </div>
          </>
        )}
      </div>
    </TemporaryPanel>
  )
}
