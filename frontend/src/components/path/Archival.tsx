import { useState } from 'react'

/**
 * Archiving a Task (ADR 0018, 0026): the one way content with learning history leaves
 * an editable Path. There is no restoration, so the action asks once more in place
 * and says what stays. It is offered only where the owner can edit, and only while
 * the document is saved, because archival is based on the accepted revision.
 */
export function ArchiveTaskControl({ taskId, title, consequence, blocked, busy, onArchive }: {
  taskId: string
  title: string
  /** What archiving keeps, in the context's terms. */
  consequence: string
  /** Why archiving is not possible right now, or null. */
  blocked: string | null
  busy: boolean
  onArchive: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  if (!confirming) {
    return (
      <button
        id={`task-archive-${taskId}`}
        onClick={() => setConfirming(true)}
        disabled={blocked !== null || busy}
        title={blocked ?? `Archive “${title}”`}
        className="self-start text-[10px] text-slate-300 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed border border-slate-700 px-1.5 py-0.5 rounded cursor-pointer"
      >
        Archive Task
      </button>
    )
  }
  return (
    <div id={`task-archive-confirm-${taskId}`} role="alertdialog" aria-label={`Archive “${title}”`} className="flex flex-col gap-1.5 rounded border border-amber-900/70 bg-amber-950/30 p-2 text-[11px] text-amber-100">
      <p>Archive “{title}”? {consequence} Archived Tasks cannot be restored.</p>
      <div className="flex gap-2">
        <button
          id={`task-archive-confirm-btn-${taskId}`}
          onClick={() => { setConfirming(false); onArchive() }}
          disabled={blocked !== null || busy}
          className="text-[10px] font-medium text-white bg-amber-700 hover:bg-amber-600 disabled:opacity-50 px-2 py-0.5 rounded cursor-pointer"
        >
          Archive
        </button>
        <button id={`task-archive-cancel-${taskId}`} onClick={() => setConfirming(false)} className="text-[10px] text-slate-300 bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-0.5 rounded cursor-pointer">
          Cancel
        </button>
      </div>
    </div>
  )
}

export interface RetainedTask {
  id: string
  title: string
  /** What its history holds, e.g. "Completed · 20 XP still counted". */
  detail: string
}

/** The archived Tasks of one Skill and the history they keep; read-only. */
export function RetainedTasks({ heading, tasks }: { heading: string; tasks: RetainedTask[] }) {
  if (tasks.length === 0) return null
  return (
    <section id="retained-tasks" aria-labelledby="retained-tasks-heading" className="rounded-xl p-3 border bg-slate-800/30 border-slate-700/40 flex flex-col gap-1.5">
      <h4 id="retained-tasks-heading" className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{heading}</h4>
      <ul className="flex flex-col gap-1">
        {tasks.map((task) => (
          <li key={task.id} id={`retained-task-${task.id}`} className="text-[11px] text-slate-300">
            <span className="text-slate-200">{task.title}</span>
            <span className="text-slate-500"> · {task.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
