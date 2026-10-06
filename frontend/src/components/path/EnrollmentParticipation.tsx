import { useEffect, useRef, useState } from 'react'
import { changeEnrollmentStatus, readEnrollmentLearningState, type ApiResult, type EnrollmentLearningState, type LifecycleRecord } from '../../lib/api'
import { isRefusal } from './submissionWork'
import type { OverrideNames } from './overrideWork'
import {
  deactivateOutlook, dueAction, findRecordedLifecycle, lastLifecycleSequence, lifecycleProblem, lifecycleRecordText,
  lifecycleRefusalMessage, mayChange, reactivateOutlook, reasonRequired, reasonToSend, type LifecycleActor, type LifecycleIntent,
} from './lifecycleWork'

/**
 * Stopping and resuming participation in one Enrollment (US60–US64, ADR 0014): the learner
 * deactivates it without a reason; the owning Coach deactivates or reactivates it with a
 * reason, and only the Coach reactivates. Like a Review, a change counts as recorded only
 * once the backend confirms it, and the record shown is the one it returned; the records
 * are then read again, and the status is said to follow it only once that read is on show.
 * A refusal recorded nothing and keeps the reason; a lost answer is reconciled with the
 * lifecycle records. Both read every record.
 */

type Refresh = 'reading' | 'read' | 'failed'

type Status =
  | { kind: 'idle' }
  | { kind: 'recording' | 'checking'; intent: LifecycleIntent }
  | { kind: 'recorded'; record: LifecycleRecord; fromHistory: boolean; refresh: Refresh }
  | { kind: 'refused'; reason: string; refresh: Refresh }
  /** The answer was lost; `checkedAt` is when the records last showed no such change, null while unread. */
  | { kind: 'unconfirmed'; intent: LifecycleIntent; checkedAt: Date | null }

async function attempt<T>(request: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
  try {
    return await request()
  } catch {
    return { ok: false, status: 0, error: 'unreachable', body: null }
  }
}

const VERB: Record<LifecycleRecord['action'], string> = { deactivate: 'Deactivate', reactivate: 'Reactivate' }

export function EnrollmentParticipation({ enrollmentId, actor, records, versionNumber, names, onChanged }: {
  enrollmentId: string
  actor: LifecycleActor
  /** The records as last confirmed by the backend; null until first read. */
  records: EnrollmentLearningState | null
  versionNumber: number
  names: OverrideNames
  /** The backend answered: read the records again; true once they are on show. */
  onChanged: () => Promise<boolean>
}) {
  /** The action the form was opened for: once the records show the other one is due, the form closes. */
  const [openFor, setOpenFor] = useState<LifecycleRecord['action'] | null>(null)
  const [reason, setReason] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [showHistory, setShowHistory] = useState(false)
  const reasonRef = useRef<HTMLTextAreaElement>(null)
  const action = records ? dueAction(records) : null
  const open = action !== null && openFor === action
  const history = records?.lifecycleHistory ?? []

  useEffect(() => { if (open) reasonRef.current?.focus() }, [open])

  const openForm = () => {
    if (openFor !== null && openFor !== action) setReason('')
    setOpenFor(action)
  }

  const record = async () => {
    if (!records || !action) return
    const intent: LifecycleIntent = { action, actorAccountId: names.viewerAccountId, reason: reasonToSend(reason), afterSequence: lastLifecycleSequence(records.lifecycleHistory) }
    setStatus({ kind: 'recording', intent })
    const result = await attempt(() => changeEnrollmentStatus(enrollmentId, action, intent.reason))
    if (result.ok) return confirmed(result.value.lifecycleRecord, false)
    if (isRefusal(result.status)) return refresh({ kind: 'refused', reason: lifecycleRefusalMessage(result.error), refresh: 'reading' })
    return reconcile({ kind: 'unconfirmed', intent, checkedAt: null })
  }

  const confirmed = (recorded: LifecycleRecord, fromHistory: boolean) => {
    setReason('')
    setOpenFor(null)
    return refresh({ kind: 'recorded', record: recorded, fromHistory, refresh: 'reading' })
  }

  /** Shows the backend's answer, then reads the records and says whether what is shown follows it. */
  const refresh = async (answered: Extract<Status, { kind: 'recorded' | 'refused' }>) => {
    const reading = { ...answered, refresh: 'reading' as const }
    setStatus(reading)
    const read = await onChanged()
    setStatus((current) => (current === reading ? { ...reading, refresh: read ? 'read' : 'failed' } : current))
  }

  /** Looks for a change whose answer was lost: a later record of this action, Actor and reason means recorded. */
  const reconcile = async (unconfirmed: Extract<Status, { kind: 'unconfirmed' }>) => {
    setStatus({ kind: 'checking', intent: unconfirmed.intent })
    const read = await attempt(() => readEnrollmentLearningState(enrollmentId))
    const found = read.ok ? findRecordedLifecycle(read.value.learningState.lifecycleHistory, unconfirmed.intent) : null
    if (found) return confirmed(found, true)
    setStatus({ ...unconfirmed, checkedAt: read.ok ? new Date() : null })
    if (read.ok) void onChanged()
  }

  const busy = status.kind === 'recording' || status.kind === 'checking' || ((status.kind === 'recorded' || status.kind === 'refused') && status.refresh === 'reading')
  const problem = lifecycleProblem(actor, reason)
  const canRecord = !busy && !problem && records !== null
  const allowed = action !== null && mayChange(actor, action)
  const outlook = records && action ? (action === 'deactivate' ? deactivateOutlook(actor, records) : reactivateOutlook(records, versionNumber, names.skillTitles)) : []
  const learnerName = names.learner.name || names.learner.email

  return (
    <section
      id="enrollment-participation"
      aria-label="Participation in this Enrollment"
      data-action={allowed ? action : ''}
      data-status={status.kind}
      data-open={open}
      data-can-record={canRecord}
      data-confirmed-by={status.kind === 'recorded' ? (status.fromHistory ? 'history' : 'answer') : ''}
      data-checked={status.kind === 'unconfirmed' ? String(status.checkedAt !== null) : ''}
      data-refresh={status.kind === 'recorded' || status.kind === 'refused' ? status.refresh : ''}
      data-records={history.length}
      // The page does not scroll: a long history or an open form scrolls here, leaving the learning panes their room.
      className="shrink-0 max-h-[35vh] overflow-y-auto px-4 py-1.5 text-[11px] border-b border-slate-800/80 bg-slate-950 space-y-1.5"
    >
      <div className="flex flex-wrap items-center gap-2">
        {records?.enrollmentStatus === 'inactive' && (
          <span id="participation-inactive" className="text-amber-200">
            {actor === 'learner'
              ? 'Participation is stopped: you can read your work and history, and your Coach can still review work you sent, but no Task can be started or work sent until your Coach reactivates this Enrollment.'
              : `Participation is stopped: ${learnerName} cannot start Tasks or send work. You can still review work sent while it was active; only you can reactivate it.`}
          </span>
        )}
        {allowed && !open && (
          <button id="participation-open" onClick={openForm} disabled={busy} className={`px-2 py-0.5 rounded-lg border disabled:opacity-50 cursor-pointer ${action === 'deactivate' ? 'border-amber-800/70 text-amber-200 hover:bg-amber-900/30' : 'border-emerald-800/70 text-emerald-200 hover:bg-emerald-900/30'}`}>
            {action === 'deactivate' ? (actor === 'learner' ? 'Stop participating…' : 'Deactivate Enrollment…') : 'Reactivate Enrollment…'}
          </button>
        )}
        {history.length > 0 && (
          <button id="participation-history-toggle" aria-expanded={showHistory} aria-controls="lifecycle-history" onClick={() => setShowHistory((shown) => !shown)} className="text-slate-400 hover:text-slate-200 underline cursor-pointer">
            {showHistory ? 'Hide' : 'Show'} participation records ({history.length})
          </button>
        )}
      </div>
      {open && action && (
        <div role="group" aria-label={`${VERB[action]} this Enrollment`} className="rounded-lg border border-slate-700 bg-slate-900/60 p-2 space-y-1.5 max-w-2xl">
          <p className="text-slate-300">
            {action === 'deactivate'
              ? (actor === 'learner' ? 'Stop participating in this Enrollment.' : `Deactivate ${learnerName}'s Enrollment.`)
              : `Reactivate ${learnerName}'s Enrollment.`}
          </p>
          <ul id="participation-outlook" className="text-slate-400 space-y-0.5 list-disc pl-4">
            {outlook.map((line) => <li key={line}>{line}</li>)}
          </ul>
          <label className="block">
            <span className="block text-slate-400 mb-0.5">
              {reasonRequired(actor)
                ? 'Reason (required; recorded with the action, you, the learner and the time, and shown to the learner)'
                : 'Reason (optional; none is needed, and your Coach sees it if you give one)'}
            </span>
            <textarea
              ref={reasonRef}
              id="participation-reason"
              value={reason}
              disabled={busy}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              className="w-full text-xs text-slate-100 bg-slate-950 border border-slate-700/80 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-sky-500 disabled:opacity-60 resize-y"
              placeholder={action === 'reactivate' ? 'Why participation resumes now…' : actor === 'coach' ? 'Why participation stops…' : 'Optional'}
            />
          </label>
          {problem && <p id="participation-hint" className="text-slate-400">{problem}</p>}
          <div className="flex flex-wrap gap-2">
            <button id="participation-confirm" onClick={() => void record()} disabled={!canRecord} className="px-2 py-1 rounded-lg border border-slate-600 bg-slate-800 hover:bg-slate-700 text-slate-100 disabled:opacity-50 cursor-pointer">
              {action === 'deactivate' && actor === 'learner' ? 'Stop participating' : `${VERB[action]} Enrollment`}
            </button>
            <button id="participation-cancel" onClick={() => setOpenFor(null)} disabled={busy} className="px-2 py-1 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-50 cursor-pointer">
              Cancel
            </button>
          </div>
        </div>
      )}
      <ParticipationStatus status={status} names={names} reasonKept={open && reason.trim() !== ''} onCheck={(s) => void reconcile(s)} onReread={(s) => void refresh(s)} />
      {showHistory && history.length > 0 && (
        <ol id="lifecycle-history" aria-label="Participation records of this Enrollment" className="text-[10px] text-slate-400 space-y-0.5">
          {history.map((entry) => {
            const text = lifecycleRecordText(entry, names)
            return (
              <li key={entry.id} id={`lifecycle-record-${entry.id}`} data-action={entry.action} data-sequence={entry.sequence}>
                <span className="text-slate-300">{text.action}</span> {text.actor} · {new Date(entry.occurredAt).toLocaleString()} · {text.reason}
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}

function ParticipationStatus({ status, names, reasonKept, onCheck, onReread }: {
  status: Status
  names: OverrideNames
  reasonKept: boolean
  onCheck: (status: Extract<Status, { kind: 'unconfirmed' }>) => void
  onReread: (status: Extract<Status, { kind: 'recorded' | 'refused' }>) => void
}) {
  const id = 'participation-status'
  const reread = (answered: Extract<Status, { kind: 'recorded' | 'refused' }>) => (
    <button id="participation-reread" onClick={() => onReread(answered)} className="underline cursor-pointer">Read them again</button>
  )
  switch (status.kind) {
    case 'idle': return null
    case 'recording': return <p id={id} role="status" className="text-slate-400">{status.intent.action === 'deactivate' ? 'Deactivating' : 'Reactivating'} the Enrollment…</p>
    case 'checking': return <p id={id} role="status" className="text-slate-400">Checking the participation records…</p>
    case 'recorded': {
      const text = lifecycleRecordText(status.record, names)
      return (
        <div id={id} role="status" data-record-id={status.record.id} className="space-y-0.5">
          <p className="text-sky-200">
            Recorded by Gurow{status.fromHistory ? ' (the answer was lost, but the participation records show it)' : ''}: {text.action} {text.actor} · {new Date(status.record.occurredAt).toLocaleString()} · {text.reason}
          </p>
          {status.refresh === 'reading' && <p className="text-slate-400">Reading the learning records again…</p>}
          {status.refresh === 'read' && <p className="text-emerald-300">Status and Access are shown as Gurow derived them after this change.</p>}
          {status.refresh === 'failed' && (
            <p className="text-amber-200">The learning records could not be read again, so what is shown may be out of date. {reread(status)}</p>
          )}
        </div>
      )
    }
    case 'refused': return (
      <div id={id} role="alert" className="space-y-0.5">
        <p className="text-red-300">Not recorded: {status.reason}. Nothing changed.{reasonKept ? ' Your reason is kept here.' : ''}</p>
        {status.refresh === 'reading' && <p className="text-slate-400">Reading the learning records again…</p>}
        {status.refresh === 'read' && <p className="text-slate-300">The status shown was read again.</p>}
        {status.refresh === 'failed' && (
          <p className="text-amber-200">The learning records could not be read again, so what is shown may be out of date. {reread(status)}</p>
        )}
      </div>
    )
    case 'unconfirmed': return (
      <div id={id} role="alert" className="text-amber-200 space-y-0.5">
        <p>
          Not confirmed: Gurow did not answer, so the Enrollment may or may not have been {status.intent.action === 'deactivate' ? 'deactivated' : 'reactivated'}.{' '}
          {status.checkedAt
            ? `As of ${status.checkedAt.toLocaleTimeString()} the participation records show no such change. `
            : 'The participation records could not be read to check. '}
          A change already made is refused rather than repeated, so trying again is safe.
        </p>
        <button id="participation-check" onClick={() => onCheck(status)} className="underline cursor-pointer">Check again</button>
      </div>
    )
  }
}
