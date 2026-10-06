import { useEffect, useRef, useState } from 'react'
import { readTaskSubmission, revokeRevisionApproval, type ApiResult, type SubmissionRevisionView } from '../../lib/api'
import { isRefusal } from './submissionWork'
import { findRecordedRevocation, revocationOutlook, revocationProblem, revocationRefusalMessage, type RevocationTask } from './revocationWork'

/**
 * The owning Coach's revocation of the Approval of one revision (ADR 0003): a mandatory
 * reason, recorded with the original decision, which stays in the history. Like a
 * decision, it counts as recorded only once the backend confirms it; the history and
 * the records are then read again, and the corrected XP, Mastery and Access are said to
 * follow it only once that read is on show. A refusal recorded nothing and keeps the
 * reason; a lost answer is reconciled with the history.
 */

/** The read of the history and records after the backend answered: only `read` shows the outcome. */
type Refresh = 'reading' | 'read' | 'failed'

type Status =
  | { kind: 'idle' }
  | { kind: 'recording' | 'checking' }
  | { kind: 'recorded'; fromHistory: boolean; refresh: Refresh }
  | { kind: 'refused'; reason: string; refresh: Refresh }
  /** The answer was lost; `checkedAt` is when the history last showed no such revocation, null while unread. */
  | { kind: 'unconfirmed'; reason: string; checkedAt: Date | null }

async function attempt<T>(request: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
  try {
    return await request()
  } catch {
    return { ok: false, status: 0, error: 'unreachable', body: null }
  }
}

export function ApprovalRevocation({ enrollmentId, taskId, revision, revisions, task, onChanged }: {
  enrollmentId: string
  taskId: string
  revision: SubmissionRevisionView
  /** The Task's Submission history as last read. */
  revisions: SubmissionRevisionView[]
  /** The Task as the records last described it; null while they are not loaded. */
  task: RevocationTask | null
  /** The backend answered: read the history and the records again; true once both are on show. */
  onChanged: () => Promise<boolean>
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const reasonRef = useRef<HTMLTextAreaElement>(null)
  const number = revision.revisionNumber
  const revocable = revision.status === 'approval'

  useEffect(() => { if (open) reasonRef.current?.focus() }, [open])

  const revoke = async () => {
    const sent = reason
    setStatus({ kind: 'recording' })
    const result = await attempt(() => revokeRevisionApproval(enrollmentId, taskId, revision.id, sent))
    if (result.ok) return confirmed(false)
    if (isRefusal(result.status)) return refresh({ kind: 'refused', reason: revocationRefusalMessage(result.error, number), refresh: 'reading' })
    return reconcile({ kind: 'unconfirmed', reason: sent, checkedAt: null })
  }

  const confirmed = (fromHistory: boolean) => {
    setReason('')
    setOpen(false)
    return refresh({ kind: 'recorded', fromHistory, refresh: 'reading' })
  }

  /** Shows the backend's answer, then reads the history and records and says whether what is shown follows it. */
  const refresh = async (answered: Extract<Status, { kind: 'recorded' | 'refused' }>) => {
    const reading = { ...answered, refresh: 'reading' as const }
    setStatus(reading)
    const read = await onChanged()
    setStatus((current) => (current === reading ? { ...reading, refresh: read ? 'read' : 'failed' } : current))
  }

  /** Looks for a revocation whose answer was lost: shown in the history with this reason means recorded. */
  const reconcile = async (unconfirmed: Extract<Status, { kind: 'unconfirmed' }>) => {
    setStatus({ kind: 'checking' })
    const read = await attempt(() => readTaskSubmission(enrollmentId, taskId))
    if (read.ok && findRecordedRevocation(read.value.submission.revisions, revision.id, unconfirmed.reason)) return confirmed(true)
    setStatus({ ...unconfirmed, checkedAt: read.ok ? new Date() : null })
    if (read.ok) void onChanged()
  }

  const busy = status.kind === 'recording' || status.kind === 'checking' || ((status.kind === 'recorded' || status.kind === 'refused') && status.refresh === 'reading')
  const problem = revocationProblem(reason)
  const canRevoke = revocable && !busy && !problem
  if (!revocable && status.kind === 'idle') return null

  return (
    <div
      id={`revocation-${revision.id}`}
      data-approval-revocation
      data-status={status.kind}
      data-open={open}
      data-can-revoke={canRevoke}
      data-confirmed-by={status.kind === 'recorded' ? (status.fromHistory ? 'history' : 'answer') : ''}
      data-checked={status.kind === 'unconfirmed' ? String(status.checkedAt !== null) : ''}
      data-refresh={status.kind === 'recorded' || status.kind === 'refused' ? status.refresh : ''}
      className="space-y-1.5 text-[10px]"
    >
      {revocable && !open && (
        <button id={`revoke-open-${revision.id}`} onClick={() => setOpen(true)} disabled={busy} className="px-2 py-0.5 rounded-lg border border-amber-800/70 text-amber-200 hover:bg-amber-900/30 disabled:opacity-50 cursor-pointer">
          Revoke Approval of Revision {number}…
        </button>
      )}
      {revocable && open && (
        <section aria-label={`Revoke the Approval of Revision ${number}`} className="rounded-lg border border-amber-900/60 bg-amber-950/15 p-2 space-y-1.5">
          <p id={`revoke-outlook-${revision.id}`} className="text-slate-400">
            Revoking keeps Revision {number} and its Approval in the history, marked revoked with your reason; the Approval no longer counts.
            {task && ` ${revocationOutlook(revision, revisions, task)}`}
          </p>
          <label className="block">
            <span className="block text-slate-400 mb-0.5">Reason (required; the learner sees it)</span>
            <textarea
              ref={reasonRef}
              id={`revoke-reason-${revision.id}`}
              value={reason}
              disabled={busy}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              className="w-full text-xs text-slate-100 bg-slate-950 border border-slate-700/80 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-amber-500 disabled:opacity-60 resize-y"
              placeholder="Why this Approval no longer stands…"
            />
          </label>
          {problem && <p id={`revoke-hint-${revision.id}`} className="text-slate-400">{problem}</p>}
          <div className="flex flex-wrap gap-2">
            <button id={`revoke-confirm-${revision.id}`} onClick={() => void revoke()} disabled={!canRevoke} className="px-2 py-1 rounded-lg border border-amber-700 bg-amber-800/30 hover:bg-amber-800/50 text-amber-100 disabled:opacity-50 cursor-pointer">
              Revoke Approval of Revision {number}
            </button>
            <button id={`revoke-cancel-${revision.id}`} onClick={() => setOpen(false)} disabled={busy} className="px-2 py-1 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-50 cursor-pointer">
              Cancel
            </button>
          </div>
        </section>
      )}
      <RevocationStatus revisionId={revision.id} number={number} status={status} reasonKept={reason.trim() !== ''} onCheck={(s) => void reconcile(s)} onReread={(s) => void refresh(s)} />
    </div>
  )
}

function RevocationStatus({ revisionId, number, status, reasonKept, onCheck, onReread }: {
  revisionId: string
  number: number
  status: Status
  reasonKept: boolean
  onCheck: (status: Extract<Status, { kind: 'unconfirmed' }>) => void
  onReread: (status: Extract<Status, { kind: 'recorded' | 'refused' }>) => void
}) {
  const id = `revoke-status-${revisionId}`
  const reread = (answered: Extract<Status, { kind: 'recorded' | 'refused' }>) => (
    <button id={`revoke-reread-${revisionId}`} onClick={() => onReread(answered)} className="underline cursor-pointer">Read them again</button>
  )
  switch (status.kind) {
    case 'idle': return null
    case 'recording': return <p id={id} role="status" className="text-slate-400">Revoking the Approval of Revision {number}…</p>
    case 'checking': return <p id={id} role="status" className="text-slate-400">Checking the submitted work…</p>
    case 'recorded': return (
      <div id={id} role="status" className="space-y-1">
        <p className="text-amber-200">
          Revocation of the Approval of Revision {number} recorded, confirmed by Gurow{status.fromHistory ? ' (the answer was lost, but the history shows it)' : ''}. The original Approval stays in the history.
        </p>
        {status.refresh === 'reading' && <p className="text-slate-400">Reading the corrected XP, Mastery and Access…</p>}
        {status.refresh === 'read' && <p className="text-emerald-300">XP, Mastery and Access are as Gurow derived them after it; what changed is explained above.</p>}
        {status.refresh === 'failed' && (
          <p className="text-amber-200">
            The corrected XP, Mastery and Access could not be read, so what is shown may be out of date. {reread(status)}
          </p>
        )}
      </div>
    )
    case 'refused': return (
      <div id={id} role="alert" className="space-y-1">
        <p className="text-red-300">Not revoked: {status.reason}. Nothing changed.{reasonKept ? ' Your reason is kept here.' : ''}</p>
        {status.refresh === 'reading' && <p className="text-slate-400">Reading the history and progress again…</p>}
        {status.refresh === 'read' && <p className="text-slate-300">The history and progress shown were read again.</p>}
        {status.refresh === 'failed' && (
          <p className="text-amber-200">
            The history and progress could not be read again, so what is shown may be out of date. {reread(status)}
          </p>
        )}
      </div>
    )
    case 'unconfirmed': return (
      <div id={id} role="alert" className="text-amber-200 space-y-1">
        <p>
          Not confirmed: Gurow did not answer, so the revocation of the Approval of Revision {number} may or may not have been recorded.{' '}
          {status.checkedAt
            ? `As of ${status.checkedAt.toLocaleTimeString()} the history shows no such revocation. `
            : 'The history could not be read to check. '}
          A revocation is recorded once, so revoking again is safe.
        </p>
        <button id={`revoke-check-${revisionId}`} onClick={() => onCheck(status)} className="underline cursor-pointer">Check again</button>
      </div>
    )
  }
}
