import { useEffect, useRef, useState } from 'react'
import { grantAccessOverride, readEnrollmentLearningState, revokeAccessOverride, type ApiResult, type EnrollmentLearningState, type EnrollmentSkillState, type OverrideRecord } from '../../lib/api'
import { isRefusal } from './submissionWork'
import { findRecordedOverride, grantOutlook, lastSequence, overrideProblem, overrideRecordText, overrideRefusalMessage, revokeOutlook, type OverrideIntent, type OverrideNames } from './overrideWork'

/**
 * The owning Coach's grant or revocation of an Access Override for one Skill of the
 * learner's Enrollment, with a mandatory brief reason (US57, US58). Like a Review, it
 * counts as recorded only once the backend confirms it, and the record shown is the
 * one it returned; the records are then read again, and Access is said to follow it
 * only once that read is on show. A refusal recorded nothing and keeps the reason; a
 * lost answer is reconciled with the Override Records.
 */

/** The read of the records after the backend answered: only `read` says Access follows it. */
type Refresh = 'reading' | 'read' | 'failed'

type Status =
  | { kind: 'idle' }
  | { kind: 'recording' | 'checking'; intent: OverrideIntent }
  | { kind: 'recorded'; record: OverrideRecord; fromHistory: boolean; refresh: Refresh }
  | { kind: 'refused'; reason: string; refresh: Refresh }
  /** The answer was lost; `checkedAt` is when the records last showed no such change, null while unread. */
  | { kind: 'unconfirmed'; intent: OverrideIntent; checkedAt: Date | null }

async function attempt<T>(request: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
  try {
    return await request()
  } catch {
    return { ok: false, status: 0, error: 'unreachable', body: null }
  }
}

export function AccessOverrideControl({ enrollmentId, skill, records, names, onChanged }: {
  enrollmentId: string
  skill: EnrollmentSkillState
  /** The records as last confirmed by the backend. */
  records: EnrollmentLearningState
  names: OverrideNames
  /** The backend answered: read the records again; true once they are on show. */
  onChanged: () => Promise<boolean>
}) {
  /** The action the form was opened for: once the records show the other one is due, the form closes. */
  const [openFor, setOpenFor] = useState<OverrideRecord['action'] | null>(null)
  const [reason, setReason] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const reasonRef = useRef<HTMLTextAreaElement>(null)
  const grant = skill.accessOverride
  const action: OverrideRecord['action'] = grant ? 'revoke' : 'grant'
  const open = openFor === action
  const skillId = skill.skillId
  const openForm = () => {
    // A reason written for the other action does not carry over.
    if (openFor !== null && openFor !== action) setReason('')
    setOpenFor(action)
  }

  useEffect(() => { if (open) reasonRef.current?.focus() }, [open])

  const record = async () => {
    const intent: OverrideIntent = { skillId, action, grantRecordId: grant?.id ?? null, reason, afterSequence: lastSequence(records.overrideHistory) }
    setStatus({ kind: 'recording', intent })
    const result = await attempt(() => grant
      ? revokeAccessOverride(enrollmentId, skillId, grant.id, intent.reason)
      : grantAccessOverride(enrollmentId, skillId, intent.reason))
    if (result.ok) return confirmed(result.value.overrideRecord, false)
    if (isRefusal(result.status)) return refresh({ kind: 'refused', reason: overrideRefusalMessage(result.error), refresh: 'reading' })
    return reconcile({ kind: 'unconfirmed', intent, checkedAt: null })
  }

  const confirmed = (recorded: OverrideRecord, fromHistory: boolean) => {
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

  /** Looks for a change whose answer was lost: a later record of this action and reason means recorded. */
  const reconcile = async (unconfirmed: Extract<Status, { kind: 'unconfirmed' }>) => {
    setStatus({ kind: 'checking', intent: unconfirmed.intent })
    const read = await attempt(() => readEnrollmentLearningState(enrollmentId))
    const found = read.ok ? findRecordedOverride(read.value.learningState.overrideHistory, unconfirmed.intent) : null
    if (found) return confirmed(found, true)
    setStatus({ ...unconfirmed, checkedAt: read.ok ? new Date() : null })
    if (read.ok) void onChanged()
  }

  const busy = status.kind === 'recording' || status.kind === 'checking' || ((status.kind === 'recorded' || status.kind === 'refused') && status.refresh === 'reading')
  const problem = overrideProblem(reason)
  const canRecord = !busy && !problem
  const verb = grant ? 'Revoke' : 'Grant'
  const outlook = grant ? revokeOutlook(skill, records, names.skillTitles) : grantOutlook(skill, records, names.skillTitles)

  return (
    <div
      id={`override-control-${skillId}`}
      data-access-override-control
      data-action={action}
      data-status={status.kind}
      data-open={open}
      data-can-record={canRecord}
      data-confirmed-by={status.kind === 'recorded' ? (status.fromHistory ? 'history' : 'answer') : ''}
      data-checked={status.kind === 'unconfirmed' ? String(status.checkedAt !== null) : ''}
      data-refresh={status.kind === 'recorded' || status.kind === 'refused' ? status.refresh : ''}
      className="mt-2 space-y-1.5 text-[10px]"
    >
      {!open && (
        <button id={`override-open-${skillId}`} onClick={openForm} disabled={busy} className="px-2 py-0.5 rounded-lg border border-sky-800/70 text-sky-200 hover:bg-sky-900/30 disabled:opacity-50 cursor-pointer">
          {verb} Access Override…
        </button>
      )}
      {open && (
        <section aria-label={`${verb} the Access Override for this Skill`} className="rounded-lg border border-sky-900/60 bg-sky-950/15 p-2 space-y-1.5">
          <p className="text-slate-300">
            {grant ? 'Revoke' : 'Grant'} an Access Override for {names.skillTitles.get(skillId) ? `“${names.skillTitles.get(skillId)}”` : 'this Skill'} for {names.learner.name || names.learner.email} in this Enrollment.
          </p>
          <ul id={`override-outlook-${skillId}`} className="text-slate-400 space-y-0.5 list-disc pl-4">
            {outlook.map((line) => <li key={line}>{line}</li>)}
          </ul>
          <label className="block">
            <span className="block text-slate-400 mb-0.5">Brief reason (required; recorded with the action, you, the learner, the Skill and the time, and shown to the learner)</span>
            <textarea
              ref={reasonRef}
              id={`override-reason-${skillId}`}
              value={reason}
              disabled={busy}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              className="w-full text-xs text-slate-100 bg-slate-950 border border-slate-700/80 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-sky-500 disabled:opacity-60 resize-y"
              placeholder={grant ? 'Why the ordinary rules apply again…' : 'Why this learner may work on this Skill now…'}
            />
          </label>
          {problem && <p id={`override-hint-${skillId}`} className="text-slate-400">{problem}</p>}
          <div className="flex flex-wrap gap-2">
            <button id={`override-confirm-${skillId}`} onClick={() => void record()} disabled={!canRecord} className="px-2 py-1 rounded-lg border border-sky-700 bg-sky-800/30 hover:bg-sky-800/50 text-sky-100 disabled:opacity-50 cursor-pointer">
              {verb} Access Override
            </button>
            <button id={`override-cancel-${skillId}`} onClick={() => setOpenFor(null)} disabled={busy} className="px-2 py-1 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-50 cursor-pointer">
              Cancel
            </button>
          </div>
        </section>
      )}
      <OverrideStatus skillId={skillId} status={status} names={names} reasonKept={open && reason.trim() !== ''} onCheck={(s) => void reconcile(s)} onReread={(s) => void refresh(s)} />
    </div>
  )
}

function OverrideStatus({ skillId, status, names, reasonKept, onCheck, onReread }: {
  skillId: string
  status: Status
  names: OverrideNames
  reasonKept: boolean
  onCheck: (status: Extract<Status, { kind: 'unconfirmed' }>) => void
  onReread: (status: Extract<Status, { kind: 'recorded' | 'refused' }>) => void
}) {
  const id = `override-status-${skillId}`
  const reread = (answered: Extract<Status, { kind: 'recorded' | 'refused' }>) => (
    <button id={`override-reread-${skillId}`} onClick={() => onReread(answered)} className="underline cursor-pointer">Read them again</button>
  )
  switch (status.kind) {
    case 'idle': return null
    case 'recording': return <p id={id} role="status" className="text-slate-400">{status.intent.action === 'grant' ? 'Granting' : 'Revoking'} the Access Override…</p>
    case 'checking': return <p id={id} role="status" className="text-slate-400">Checking the Override Records…</p>
    case 'recorded': {
      const text = overrideRecordText(status.record, names)
      return (
        <div id={id} role="status" data-record-id={status.record.id} className="space-y-1">
          <p className="text-sky-200">
            Recorded by Gurow{status.fromHistory ? ' (the answer was lost, but the Override Records show it)' : ''}: {text.action} {text.actor} · {text.target} · {new Date(status.record.occurredAt).toLocaleString()} · {text.reason}
          </p>
          {status.refresh === 'reading' && <p className="text-slate-400">Reading Access again…</p>}
          {status.refresh === 'read' && <p className="text-emerald-300">Access is shown as Gurow derived it after this change.</p>}
          {status.refresh === 'failed' && (
            <p className="text-amber-200">Access could not be read again, so what is shown may be out of date. {reread(status)}</p>
          )}
        </div>
      )
    }
    case 'refused': return (
      <div id={id} role="alert" className="space-y-1">
        <p className="text-red-300">Not recorded: {status.reason}. Nothing changed.{reasonKept ? ' Your reason is kept here.' : ''}</p>
        {status.refresh === 'reading' && <p className="text-slate-400">Reading Access and the Override Records again…</p>}
        {status.refresh === 'read' && <p className="text-slate-300">Access and the Override Records shown were read again.</p>}
        {status.refresh === 'failed' && (
          <p className="text-amber-200">Access and the Override Records could not be read again, so what is shown may be out of date. {reread(status)}</p>
        )}
      </div>
    )
    case 'unconfirmed': return (
      <div id={id} role="alert" className="text-amber-200 space-y-1">
        <p>
          Not confirmed: Gurow did not answer, so the Access Override may or may not have been {status.intent.action === 'grant' ? 'granted' : 'revoked'}.{' '}
          {status.checkedAt
            ? `As of ${status.checkedAt.toLocaleTimeString()} the Override Records show no such change. `
            : 'The Override Records could not be read to check. '}
          It is recorded at most once, so trying again is safe.
        </p>
        <button id={`override-check-${skillId}`} onClick={() => onCheck(status)} className="underline cursor-pointer">Check again</button>
      </div>
    )
  }
}
