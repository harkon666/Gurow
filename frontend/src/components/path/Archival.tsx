import { useState } from 'react'
import type { ArchivedSkill, LearningState } from '../../lib/api'

/**
 * Archiving a Task (ADR 0018, 0026): the one way content with learning history leaves
 * an editable Path. There is no restoration, so the action asks once more in place
 * and says what stays. It is offered only where the owner can edit, and only while
 * the document is saved, because archival is based on the accepted revision.
 */
export function ArchiveTaskControl({ taskId, title, consequence, blocked, busy, onArchive, prefix = '' }: {
  taskId: string
  /** Keeps IDs unique where the control is shown twice. */
  prefix?: string
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
        id={`${prefix}task-archive-${taskId}`}
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
    <div id={`${prefix}task-archive-confirm-${taskId}`} role="alertdialog" aria-label={`Archive “${title}”`} className="flex flex-col gap-1.5 rounded border border-amber-900/70 bg-amber-950/30 p-2 text-[11px] text-amber-100">
      <p>Archive “{title}”? {consequence} Archived Tasks cannot be restored.</p>
      <div className="flex gap-2">
        <button
          id={`${prefix}task-archive-confirm-btn-${taskId}`}
          onClick={() => { setConfirming(false); onArchive() }}
          disabled={blocked !== null || busy}
          className="text-[10px] font-medium text-white bg-amber-700 hover:bg-amber-600 disabled:opacity-50 px-2 py-0.5 rounded cursor-pointer"
        >
          Archive
        </button>
        <button id={`${prefix}task-archive-cancel-${taskId}`} onClick={() => setConfirming(false)} className="text-[10px] text-slate-300 bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-0.5 rounded cursor-pointer">
          Cancel
        </button>
      </div>
    </div>
  )
}

/** Skill archival is separate from deletion and requires disconnected prerequisites. */
export function ArchiveSkillControl({ skillId, title, taskCount, consequence, blocked, busy, onArchive }: {
  skillId: string
  title: string
  taskCount: number
  consequence: string
  blocked: string | null
  busy: boolean
  onArchive: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  return <div className="space-y-2">
    {!confirming ? <button id="archive-skill-btn" data-skill-id={skillId} onClick={() => setConfirming(true)} disabled={blocked !== null || busy}
      aria-describedby={blocked ? 'skill-archive-blocked' : undefined}
      className="text-xs text-amber-100 bg-amber-950/40 hover:bg-amber-900/50 border border-amber-900/60 rounded-lg px-2.5 py-1.5 disabled:opacity-50 disabled:cursor-not-allowed">
      Archive Skill
    </button> : <div id="skill-archive-confirm" role="group" aria-label={`Confirm archival of ${title}`} className="space-y-2 rounded-lg border border-amber-900/60 bg-amber-950/30 p-2 text-xs text-amber-100">
      <p className="break-words">Archive “{title}”{taskCount > 0 ? ` with its ${taskCount} active ${taskCount === 1 ? 'Task' : 'Tasks'}` : ''}? {consequence} Archived Skills cannot be restored or permanently deleted.</p>
      <div className="flex flex-wrap gap-2">
        <button id="confirm-archive-skill-btn" onClick={() => { setConfirming(false); onArchive() }} disabled={blocked !== null || busy} className="rounded bg-amber-700 hover:bg-amber-600 px-2 py-1 text-white disabled:opacity-50 disabled:cursor-not-allowed">Archive Skill</button>
        <button id="cancel-archive-skill-btn" onClick={() => { setConfirming(false); document.getElementById('archive-skill-btn')?.focus() }} className="rounded border border-slate-700 bg-slate-800 hover:bg-slate-700 px-2 py-1 text-slate-200">Cancel</button>
      </div>
    </div>}
    {blocked && <p id="skill-archive-blocked" className="text-[11px] text-slate-400">{blocked}</p>}
  </div>
}

/** Read-only retained Skills; never exposes live learning or board controls. */
export function ArchivedSkills({ skills, personal, records, loadError, onReload }: {
  skills: ArchivedSkill[]
  personal: boolean
  records: LearningState | null
  loadError: string | null
  onReload: () => void
}) {
  return <div id="archived-skills" className="space-y-4 p-4 text-xs text-slate-300">
    <p>{personal ? 'These Skills are no longer on the active canvas. Their XP, Mastery and history are retained.' : 'These Skills were removed from the Draft. Published Versions and their learners’ work remain unchanged.'} Archived Skills cannot be restored or permanently deleted.</p>
    {skills.length === 0 ? <p className="text-slate-400">No archived Skills.</p> : <ul className="space-y-3">
      {skills.map((skill) => {
        const tasks = records?.tasks.filter((task) => task.skillId === skill.id) ?? []
        const taskIds = new Set(tasks.map((task) => task.taskId))
        const xp = records?.xpHistory.filter((event) => taskIds.has(event.taskId)) ?? []
        const mastery = records?.masteryHistory.filter((event) => event.skillId === skill.id) ?? []
        const overrides = records?.overrideHistory.filter((event) => event.skillId === skill.id) ?? []
        const status = records?.skills.find((entry) => entry.skillId === skill.id)
        return <li key={skill.id} data-archived-skill-id={skill.id} className="rounded-xl border border-slate-700 bg-slate-800/30 p-3 space-y-2">
          <h3 className="break-words text-sm font-semibold text-slate-100">{skill.title}</h3>
          <p className="break-words whitespace-pre-wrap">{skill.outcome || 'No learning outcome recorded.'}</p>
          <p className="text-[11px] text-slate-400">Archived {new Date(skill.archivedAt).toLocaleString()} · {skill.taskCount} retained {skill.taskCount === 1 ? 'Task' : 'Tasks'}</p>
          {personal && <details className="border-t border-slate-700 pt-2">
            <summary className="cursor-pointer text-sky-200">View retained history</summary>
            {!records ? <p className="mt-2 text-slate-400">{loadError ? 'Learning history could not be loaded.' : 'Loading learning history…'} {loadError && <button onClick={onReload} className="underline text-sky-200">Retry</button>}</p> : <div className="mt-3 space-y-3">
              <p>Mastery: {status?.mastery ? 'Declared' : 'Unclaimed'} · {tasks.reduce((sum, task) => sum + task.xpContribution, 0)} XP retained</p>
              <section aria-label={`Retained Tasks of ${skill.title}`}>
                <h4 className="font-semibold text-slate-400">Tasks</h4>
                {tasks.length === 0 ? <p>No Tasks retained.</p> : <ul className="space-y-1 mt-1">{tasks.map((task) => <li key={task.taskId} className="break-words">{task.title} · {task.completed ? 'Completed' : 'Not completed'} · {task.xpContribution} XP</li>)}</ul>}
              </section>
              <section aria-label={`XP history of ${skill.title}`}>
                <h4 className="font-semibold text-slate-400">XP history</h4>
                {xp.length === 0 ? <p>No XP events recorded.</p> : <ol className="space-y-1 mt-1">{xp.map((event) => <li key={event.id} className="break-words">{tasks.find((task) => task.taskId === event.taskId)?.title ?? event.taskId} · {event.kind} · {event.amount > 0 ? '+' : ''}{event.amount} XP · {new Date(event.occurredAt).toLocaleString()}</li>)}</ol>}
              </section>
              <section aria-label={`Mastery history of ${skill.title}`}>
                <h4 className="font-semibold text-slate-400">Mastery history</h4>
                {mastery.length === 0 ? <p>No Mastery events recorded.</p> : <ol className="space-y-1 mt-1">{mastery.map((event) => <li key={event.id}>{event.action === 'declare' ? 'Mastery declared' : 'Mastery declaration withdrawn'} · {new Date(event.occurredAt).toLocaleString()}</li>)}</ol>}
              </section>
              <section aria-label={`Access Override history of ${skill.title}`}>
                <h4 className="font-semibold text-slate-400">Access Override history</h4>
                {overrides.length === 0 ? <p>No Access Override events recorded.</p> : <ol className="space-y-1 mt-1">{overrides.map((event, index) => <li key={`${event.occurredAt}:${index}`}>{event.action === 'grant' ? 'Access Override granted' : 'Access Override revoked'} · {new Date(event.occurredAt).toLocaleString()}</li>)}</ol>}
              </section>
            </div>}
          </details>}
        </li>
      })}
    </ul>}
  </div>
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
