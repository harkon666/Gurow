import type { KeptEntry, ReapplyStatus } from './useKeptWork'

/**
 * What the owner is told about local work the backend has not accepted (ADR 0016): a
 * stale save's conflict, with the local work still on the canvas, and work kept aside
 * or found in this browser on opening. Each lists its changes for inspection and offers
 * reapplying them as a new save or discarding them; nothing here overwrites the
 * accepted version. `prefix` keeps the element ids of the Path and layout editors apart.
 */

const buttonClass = 'px-2 py-1 rounded-lg border cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed'

function ChangeList({ id, changes }: { id: string; changes: string[] }) {
  if (changes.length === 0) return <p id={id} className="text-slate-400">No changes to the saved version.</p>
  return (
    <ul id={id} className="list-disc pl-5 max-h-28 overflow-y-auto text-slate-200">
      {changes.map((change, i) => <li key={i}>{change}</li>)}
    </ul>
  )
}

function ReapplyNote({ id, status, noun }: { id: string; status: ReapplyStatus; noun: string }) {
  switch (status.kind) {
    case 'idle': return null
    case 'working': return <p id={id} role="status" data-outcome="working" className="text-slate-300">Reapplying your changes to the saved {noun}…</p>
    case 'refused': return <p id={id} role="alert" data-outcome="refused" className="text-red-300">Gurow refused the reapplied changes: {status.detail}. Nothing was saved; your changes are still kept here.</p>
    case 'stale': return <p id={id} role="alert" data-outcome="stale" className="text-red-300">A newer version was saved elsewhere meanwhile, so nothing was saved; your changes are still kept here. Reapply them again to build on it.</p>
    case 'failed': return <p id={id} role="alert" data-outcome="failed" className="text-red-300">Not reapplied: {status.detail}. Nothing was saved; your changes are still kept here.</p>
  }
}

export function SaveConflict({ prefix, noun, revisionLabel, acceptedRevision, changes, status, busy, loadError, onReapply, onKeepAside, onDiscard }: {
  prefix: string
  noun: string
  /** How the revision is named: a Path's save revision, or a Version's layout revision. */
  revisionLabel: string
  acceptedRevision: number
  changes: string[]
  status: ReapplyStatus
  /** Reapplying or loading is running: one operation at a time. */
  busy: boolean
  loadError: string | null
  onReapply: () => void
  onKeepAside: () => void
  onDiscard: () => void
}) {
  return (
    <section id={`${prefix}save-conflict`} role="alert" data-revision-label={revisionLabel} data-accepted-revision={acceptedRevision} data-reapply={status.kind} className="shrink-0 px-4 py-2 text-xs text-amber-100 bg-amber-950/40 border-b border-amber-900/60 space-y-1.5">
      <p>
        This {noun} was changed elsewhere (another tab or window). Your changes here are kept but not saved, and nothing was overwritten:
        they stay on screen and in this browser until you choose what to do with them.
      </p>
      <details id={`${prefix}conflict-changes-details`} open>
        <summary className="cursor-pointer text-amber-200">Your unsaved changes ({changes.length})</summary>
        <ChangeList id={`${prefix}conflict-changes`} changes={changes} />
      </details>
      <div className="flex flex-wrap gap-2">
        <button id={`${prefix}reapply-mine-btn`} disabled={busy} onClick={onReapply} className={`${buttonClass} text-emerald-100 bg-emerald-900/50 hover:bg-emerald-800/60 border-emerald-700`}>
          Reapply my changes to the saved version and save
        </button>
        <button id={`${prefix}keep-aside-btn`} disabled={busy} onClick={onKeepAside} className={`${buttonClass} text-amber-100 bg-slate-900 hover:bg-slate-800 border-amber-800`}>
          Show the saved version, keep mine aside
        </button>
        <button id={`${prefix}load-accepted-btn`} disabled={busy} onClick={onDiscard} className={`${buttonClass} text-amber-100 bg-amber-900/60 hover:bg-amber-800/60 border-amber-700`}>
          {loadError ? 'Try loading the saved version again' : 'Discard mine and load the saved version'}
        </button>
      </div>
      {loadError && <p id={`${prefix}load-error`} className="text-red-300">{loadError}</p>}
      <ReapplyNote id={`${prefix}reapply-outcome`} status={status} noun={noun} />
    </section>
  )
}

export function KeptWorkList<D>({ prefix, noun, entries, refused, busy, currentRevision, canReapply, onReapply, onDiscard, onDismissRefused }: {
  prefix: string
  noun: string
  entries: KeptEntry<D>[]
  /** A reapplication is running: one at a time, so every entry waits. */
  busy: boolean
  refused: string[]
  currentRevision: number
  /** False while the editor holds unaccepted work of its own, which reapplying would replace. */
  canReapply: boolean
  onReapply: (id: string) => void
  onDiscard: (id: string) => void
  onDismissRefused: () => void
}) {
  if (entries.length === 0 && refused.length === 0) return null
  return (
    <section id={`${prefix}kept-work`} aria-label="Unsaved work kept in this browser" className="shrink-0 px-4 py-2 text-xs bg-sky-950/30 border-b border-sky-900/60 space-y-2">
      {refused.length > 0 && (
        <div id={`${prefix}kept-work-refused`} role="alert" className="text-amber-200 flex flex-wrap items-center gap-2">
          <span>Unsaved work kept in this browser could not be restored and was removed: {refused.join('; ')}.</span>
          <button onClick={onDismissRefused} className="underline cursor-pointer">Dismiss</button>
        </div>
      )}
      {entries.map((entry) => {
        return (
          <article key={entry.work.id} data-kept-entry={entry.work.id} data-base-revision={entry.work.baseRevision} data-base-changed={entry.work.baseRevision !== currentRevision} data-reapply={entry.status.kind} className="rounded-lg border border-sky-900/70 bg-slate-950/60 p-2 space-y-1.5">
            <p className="text-sky-100">
              Unsaved changes kept in this browser (edited {new Date(entry.work.editedAt).toLocaleString()}).
              {entry.work.baseRevision === currentRevision ? '' : ' The saved version has changed since.'} The saved {noun} shown does not include them.
            </p>
            <ChangeList id={`${prefix}kept-changes-${entry.work.id}`} changes={entry.changes} />
            <div className="flex flex-wrap items-center gap-2">
              <button data-action="reapply" disabled={busy || !canReapply} onClick={() => onReapply(entry.work.id)} className={`${buttonClass} text-emerald-100 bg-emerald-900/50 hover:bg-emerald-800/60 border-emerald-700`}>
                Reapply them to the saved version and save
              </button>
              <button data-action="discard" disabled={busy} onClick={() => onDiscard(entry.work.id)} className={`${buttonClass} text-slate-200 bg-slate-800 hover:bg-slate-700 border-slate-700`}>
                Discard them
              </button>
              {!canReapply && entry.status.kind !== 'working' && <span className="text-slate-400">Wait until your edits here are saved to reapply them.</span>}
            </div>
            <ReapplyNote id={`${prefix}kept-outcome-${entry.work.id}`} status={entry.status} noun={noun} />
          </article>
        )
      })}
    </section>
  )
}
