import { useCallback, useEffect, useRef, useState } from 'react'
import { readTaskDraft, readTaskSubmission, saveTaskDraft, sendTaskRevision, type ApiResult, type EnrollmentLearningState, type SubmissionContents } from '../../lib/api'
import { contentsOf, contentsProblem, draftRecoveryKey, findSentRevision, isEmpty, isRefusal, loadRecoveredDraft, refusalMessage, rememberEdits, sameContents, sendBlockedReason } from './submissionWork'

/**
 * The learner's private working space for one Task (ADR 0002): a draft of text and
 * links that only they can read, saved to the backend on request and kept in this
 * browser (under their Account) while it has unsaved edits. Sending saves the draft,
 * then asks the backend for a new immutable revision; only its confirmation counts as
 * sent, and a refusal leaves the work editable and unsent. When the answer is lost,
 * whether it was sent is unknown until the Submission history shows it either way.
 */

type Status =
  | { kind: 'idle' }
  | { kind: 'saving' | 'sending' | 'checking' }
  | { kind: 'saved'; at: Date }
  | { kind: 'sent'; revisionNumber: number; at: Date; fromHistory: boolean }
  | { kind: 'not-saved'; reason: string }
  | { kind: 'not-sent'; reason: string; draftSaved: boolean }
  /**
   * The send's answer was lost. `checkedAt` is when the history last showed no such
   * revision; null while the history could not be read, so nothing is claimed yet.
   */
  | { kind: 'unconfirmed'; sent: SubmissionContents; notBefore: string; checkedAt: Date | null }

type DraftLoad = { state: 'loading' } | { state: 'ready' } | { state: 'failed'; error: string }

const EMPTY: SubmissionContents = { text: '', urls: [] }

/** Runs a request, turning a network failure into the same shape as a refusal. */
async function attempt<T>(request: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
  try {
    return await request()
  } catch {
    return { ok: false, status: 0, error: 'unreachable', body: null }
  }
}

export function TaskWork({ accountId, enrollmentId, taskId, records, onSent, onRefused }: {
  accountId: string
  enrollmentId: string
  taskId: string
  records: EnrollmentLearningState | null
  /** The backend confirmed a new revision: read the history (and records) again. */
  onSent: () => void
  /** The backend refused for Access or Enrollment state: the records shown are out of date. */
  onRefused: () => void
}) {
  const key = draftRecoveryKey(accountId, enrollmentId, taskId)
  const [load, setLoad] = useState<DraftLoad>({ state: 'loading' })
  /** The draft as the backend last confirmed it; null when none is saved (or it could not be read). */
  const [saved, setSaved] = useState<SubmissionContents | null>(null)
  const [edits, setEdits] = useState<SubmissionContents>(EMPTY)
  const [recoveredAt, setRecoveredAt] = useState<string | null>(null)
  const [keptLocally, setKeptLocally] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const editsRef = useRef(edits)
  editsRef.current = edits
  const storage = () => (typeof window === 'undefined' ? null : window.localStorage)

  useEffect(() => {
    let current = true
    const recovered = storage() && loadRecoveredDraft(storage()!, key)
    void attempt(() => readTaskDraft(enrollmentId, taskId)).then((result) => {
      if (!current) return
      const confirmed = result.ok && result.value.draft ? { text: result.value.draft.text, urls: result.value.draft.urls } : null
      setSaved(confirmed)
      setLoad(result.ok ? { state: 'ready' } : { state: 'failed', error: refusalMessage(result.error) })
      // Unsaved edits from an interrupted session win over the saved draft until the learner discards them.
      const restore = recovered && !sameContents(recovered, confirmed) ? recovered : null
      setEdits(restore ? { text: restore.text, urls: restore.urls } : confirmed ?? EMPTY)
      setRecoveredAt(restore?.editedAt ?? null)
      setKeptLocally(Boolean(restore))
      if (recovered && !restore && result.ok) storage()?.removeItem(key)
    })
    return () => { current = false }
  }, [key, enrollmentId, taskId])

  const edit = (next: SubmissionContents) => {
    setEdits(next)
    // An unconfirmed send stays reported: editing does not tell whether it arrived.
    setStatus((s) => (s.kind === 'saving' || s.kind === 'sending' || s.kind === 'checking' || s.kind === 'unconfirmed' ? s : { kind: 'idle' }))
    const store = storage()
    setKeptLocally(store ? rememberEdits(store, key, next, saved) : false)
  }

  /** Saves the current edits as the private draft; ok once the backend confirmed them, with its save time. */
  const saveDraft = useCallback(async (): Promise<{ ok: true; savedAt: string } | { ok: false; error: string }> => {
    const sending = contentsOf(editsRef.current)
    const result = await attempt(() => saveTaskDraft(enrollmentId, taskId, sending))
    if (!result.ok) return { ok: false, error: result.error }
    const confirmed = { text: result.value.draft.text, urls: result.value.draft.urls }
    setSaved(confirmed)
    setRecoveredAt(null)
    const store = storage()
    setKeptLocally(store ? rememberEdits(store, key, editsRef.current, confirmed) : false)
    return { ok: true, savedAt: result.value.draft.updatedAt }
  }, [enrollmentId, taskId, key])

  const handleSave = async () => {
    setStatus({ kind: 'saving' })
    const result = await saveDraft()
    setStatus(result.ok ? { kind: 'saved', at: new Date() } : { kind: 'not-saved', reason: refusalMessage(result.error) })
  }

  const handleSend = async () => {
    setStatus({ kind: 'sending' })
    const refused = (error: string, draftSaved: boolean) => {
      setStatus({ kind: 'not-sent', reason: refusalMessage(error), draftSaved })
      if (error === 'skill_locked' || error === 'enrollment_inactive') onRefused()
    }
    // A failed draft save stops before sending, so nothing can have been submitted.
    const draft = await saveDraft()
    if (!draft.ok) return refused(draft.error, false)
    const sent = contentsOf(editsRef.current)
    const result = await attempt(() => sendTaskRevision(enrollmentId, taskId, sent))
    if (!result.ok && isRefusal(result.status)) return refused(result.error, true)
    if (!result.ok) return reconcile({ kind: 'unconfirmed', sent, notBefore: draft.savedAt, checkedAt: null })
    setStatus({ kind: 'sent', revisionNumber: result.value.revision.revisionNumber, at: new Date(result.value.revision.sentAt), fromHistory: false })
    onSent()
  }

  /** Looks for an unconfirmed send in the Submission history: found means sent; absent is reported as of now. */
  const reconcile = async (unconfirmed: Extract<Status, { kind: 'unconfirmed' }>) => {
    setStatus({ kind: 'checking' })
    const read = await attempt(() => readTaskSubmission(enrollmentId, taskId))
    const revisions = read.ok ? read.value.submission.revisions : read.error === 'submission_not_found' ? [] : null
    const found = revisions && findSentRevision(revisions, unconfirmed.sent, unconfirmed.notBefore)
    if (found) {
      setStatus({ kind: 'sent', revisionNumber: found.revisionNumber, at: new Date(found.sentAt), fromHistory: true })
      onSent()
      return
    }
    setStatus({ ...unconfirmed, checkedAt: revisions ? new Date() : null })
  }

  const handleDiscard = () => {
    storage()?.removeItem(key)
    setEdits(saved ?? EMPTY)
    setRecoveredAt(null)
    setKeptLocally(false)
    setStatus({ kind: 'idle' })
  }

  const busy = status.kind === 'saving' || status.kind === 'sending' || status.kind === 'checking'
  const editable = load.state !== 'loading' && !busy
  const problem = contentsProblem(edits)
  const blocked = sendBlockedReason(records, taskId)
  const unsaved = !sameContents(edits, saved)
  // Until the history has been read, sending again could duplicate a revision that did arrive.
  const awaitingCheck = status.kind === 'unconfirmed' && status.checkedAt === null
  const canSend = editable && !problem && !blocked && !isEmpty(edits) && !awaitingCheck
  const field = 'w-full text-xs text-slate-100 bg-slate-950 border border-slate-700/80 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-violet-500 disabled:opacity-60'

  return (
    <section
      id={`task-work-${taskId}`}
      data-task-work
      data-draft-state={load.state}
      data-status={status.kind}
      data-unsaved={unsaved}
      data-kept-locally={keptLocally}
      data-can-send={canSend}
      data-sent-revision={status.kind === 'sent' ? status.revisionNumber : ''}
      data-checked={status.kind === 'unconfirmed' ? String(status.checkedAt !== null) : ''}
      data-confirmed-by={status.kind === 'sent' ? (status.fromHistory ? 'history' : 'answer') : ''}
      aria-label="Your private draft"
      className="rounded-lg border border-violet-900/50 bg-violet-950/10 p-2 space-y-2"
    >
      <div>
        <h6 className="text-[10px] font-semibold uppercase tracking-wider text-violet-300">Your private draft</h6>
        <p className="text-[10px] text-slate-500">Only you can see it. Your Coach sees your work only once you send it as a revision.</p>
      </div>
      {load.state === 'loading' && <p className="text-slate-500">Loading your draft…</p>}
      {load.state === 'failed' && <p id={`task-work-load-error-${taskId}`} role="alert" className="text-amber-200">Could not read your saved draft ({load.error}).{keptLocally ? ' Your unsaved edits from this browser are shown.' : ''}</p>}
      {recoveredAt && (
        <div id={`task-work-recovered-${taskId}`} role="status" className="rounded border border-amber-800/60 bg-amber-950/30 p-1.5 text-amber-100 space-y-1">
          <p>Restored unsaved edits from this browser (edited {new Date(recoveredAt).toLocaleString()}). They are not saved to Gurow yet.</p>
          <button id={`task-work-discard-${taskId}`} onClick={handleDiscard} className="underline cursor-pointer">Discard them and show the saved draft</button>
        </div>
      )}
      <label className="block">
        <span className="block text-[10px] text-slate-400 mb-0.5">Text</span>
        <textarea
          id={`task-work-text-${taskId}`}
          value={edits.text}
          disabled={!editable}
          onChange={(e) => edit({ ...edits, text: e.target.value })}
          rows={4}
          className={`${field} resize-y leading-relaxed`}
          placeholder="Your answer, notes or explanation…"
        />
      </label>
      <fieldset className="space-y-1">
        <legend className="text-[10px] text-slate-400 mb-0.5">Links</legend>
        {edits.urls.map((url, index) => (
          <div key={index} className="flex gap-1">
            <input
              id={`task-work-url-${taskId}-${index}`}
              type="url"
              value={url}
              disabled={!editable}
              aria-label={`Link ${index + 1}`}
              onChange={(e) => edit({ ...edits, urls: edits.urls.map((u, i) => (i === index ? e.target.value : u)) })}
              className={field}
              placeholder="https://…"
            />
            <button id={`task-work-remove-url-${taskId}-${index}`} disabled={!editable} onClick={() => edit({ ...edits, urls: edits.urls.filter((_, i) => i !== index) })} aria-label={`Remove link ${index + 1}`} className="px-2 text-slate-400 hover:text-slate-200 cursor-pointer">×</button>
          </div>
        ))}
        <button id={`task-work-add-url-${taskId}`} disabled={!editable} onClick={() => edit({ ...edits, urls: [...edits.urls, ''] })} className="text-[10px] text-violet-300 hover:text-violet-200 cursor-pointer">+ Add a link</button>
        <p id={`task-work-url-note-${taskId}`} className="text-[10px] text-slate-500">
          Gurow keeps the links you send, not a copy of the pages they lead to: if a page changes or disappears later, your Coach sees it as it is then. Link to a fixed version (a commit, release or dated copy) or paste the important part into the text.
        </p>
      </fieldset>
      {problem && <p id={`task-work-problem-${taskId}`} className="text-amber-200">{problem}</p>}
      {blocked && <p id={`task-work-blocked-${taskId}`} className="text-slate-400">{blocked}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button id={`task-work-save-${taskId}`} onClick={() => void handleSave()} disabled={!editable || Boolean(problem) || !unsaved} className="px-2 py-1 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-50 cursor-pointer">Save draft</button>
        <button id={`task-work-send-${taskId}`} onClick={() => void handleSend()} disabled={!canSend} className="px-2 py-1 rounded-lg border border-violet-700 bg-violet-700/40 hover:bg-violet-700/60 text-violet-100 disabled:opacity-50 cursor-pointer">Send for Review</button>
        {unsaved && !busy && <span id={`task-work-unsaved-${taskId}`} className="text-[10px] text-slate-400">Unsaved changes{keptLocally ? ', kept in this browser' : ''}</span>}
      </div>
      <TaskWorkStatus taskId={taskId} status={status} keptLocally={keptLocally} onCheck={(s) => void reconcile(s)} />
      <p id={`task-work-reuse-note-${taskId}`} className="text-[10px] text-slate-500">
        Using the same project for another Task? Send it from that Task too: each Task has its own Submission and Review, and an Approval here does not count there.
      </p>
    </section>
  )
}

function TaskWorkStatus({ taskId, status, keptLocally, onCheck }: {
  taskId: string
  status: Status
  keptLocally: boolean
  onCheck: (status: Extract<Status, { kind: 'unconfirmed' }>) => void
}) {
  const id = `task-work-status-${taskId}`
  switch (status.kind) {
    case 'idle': return null
    case 'saving': return <p id={id} role="status" className="text-slate-400">Saving your draft…</p>
    case 'sending': return <p id={id} role="status" className="text-slate-400">Sending…</p>
    case 'checking': return <p id={id} role="status" className="text-slate-400">Checking your submitted work…</p>
    case 'saved': return <p id={id} role="status" className="text-emerald-300">Draft saved privately at {status.at.toLocaleTimeString()}.</p>
    case 'sent': return (
      <p id={id} role="status" className="text-emerald-300">
        Sent as Revision {status.revisionNumber} at {status.at.toLocaleTimeString()}, confirmed by Gurow{status.fromHistory ? ' (the answer was lost, but your submitted work shows it)' : ''}. It cannot be changed now; edit this draft to prepare a correction.
      </p>
    )
    case 'unconfirmed': return (
      <div id={id} role="alert" className="text-amber-200 space-y-1">
        <p>
          Not confirmed: Gurow did not answer, so this send may or may not have arrived.{' '}
          {status.checkedAt
            ? `As of ${status.checkedAt.toLocaleTimeString()} it is not in your submitted work below. `
            : 'Your submitted work could not be read to check, so sending again is paused until it can. '}
          Your work is still here and saved as your private draft.
        </p>
        <button id={`task-work-check-${taskId}`} onClick={() => onCheck(status)} className="underline cursor-pointer">Check again</button>
      </div>
    )
    case 'not-saved': return <p id={id} role="alert" className="text-red-300">Not saved: {status.reason}. Your edits are still here{keptLocally ? ' and kept in this browser' : ''}.</p>
    case 'not-sent': return (
      <p id={id} role="alert" className="text-red-300">
        Not sent: {status.reason}. Nothing was submitted; your work is still here{status.draftSaved ? ' and saved as your private draft' : keptLocally ? ' and kept in this browser' : ''}.
      </p>
    )
  }
}
