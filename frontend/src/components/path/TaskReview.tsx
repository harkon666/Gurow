import { useEffect, useRef, useState } from 'react'
import { readTaskSubmission, reviewRevision, type ApiResult, type ReviewDecision, type SubmissionRevisionView } from '../../lib/api'
import { isRefusal } from './submissionWork'
import { awaitingRevision, countingApprovals, DECISION_TEXT, feedbackOf, findRecordedDecision, reviewProblem, reviewRefusalMessage } from './reviewWork'

/**
 * The owning Coach's Review of a Task's one revision awaiting a decision (ADR 0002):
 * Approval, or Changes Requested with feedback. The decision names the revision the
 * Coach was shown; it is never moved to a newer one. It counts as recorded only once
 * the backend confirms it, and XP, Mastery and Access are then read again from the
 * backend rather than predicted here; they are said to follow the decision only once
 * that read is on show, and to be possibly out of date when it failed. A refused
 * decision recorded nothing: the page reads the history and records again and keeps
 * the Coach's feedback for another try. When the answer is lost, the history tells
 * whether the decision was recorded.
 */

/** The read of the history and records after the backend answered: only `read` shows the outcome. */
type Refresh = 'reading' | 'read' | 'failed'

type Status =
  | { kind: 'idle' }
  | { kind: 'recording' | 'checking'; decision: ReviewDecision; revisionNumber: number }
  | { kind: 'recorded'; decision: ReviewDecision; revisionNumber: number; fromHistory: boolean; refresh: Refresh }
  | { kind: 'refused'; decision: ReviewDecision; revisionNumber: number; reason: string; refresh: Refresh }
  /** The answer was lost; `checkedAt` is when the history last showed no such decision, null while unread. */
  | { kind: 'unconfirmed'; decision: ReviewDecision; revisionId: string; revisionNumber: number; checkedAt: Date | null }

async function attempt<T>(request: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
  try {
    return await request()
  } catch {
    return { ok: false, status: 0, error: 'unreachable', body: null }
  }
}

export function TaskReview({ enrollmentId, taskId, revisions, focusRequested, onFocused, onChanged }: {
  enrollmentId: string
  taskId: string
  /** The Task's Submission history as last read; null while it is not readable. */
  revisions: SubmissionRevisionView[] | null
  /** Moves focus here once a revision to decide is shown (keyboard entry from the review queue). */
  focusRequested: boolean
  onFocused: () => void
  /** The backend answered (a decision, a refusal or a check): read the history and the records again; true once both are on show. */
  onChanged: () => Promise<boolean>
}) {
  const [feedback, setFeedback] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const feedbackRef = useRef<HTMLTextAreaElement>(null)
  const target = revisions ? awaitingRevision(revisions) : null

  useEffect(() => {
    if (!focusRequested || !revisions) return
    if (target) feedbackRef.current?.focus()
    onFocused()
  }, [focusRequested, revisions, target, onFocused])

  const decide = async (decision: ReviewDecision) => {
    if (!target) return
    const revisionNumber = target.revisionNumber
    setStatus({ kind: 'recording', decision, revisionNumber })
    const result = await attempt(() => reviewRevision(enrollmentId, taskId, target.id, decision, feedbackOf(feedback)))
    if (result.ok) {
      setFeedback('')
      return refresh({ kind: 'recorded', decision, revisionNumber, fromHistory: false, refresh: 'reading' })
    }
    if (isRefusal(result.status)) return refresh({ kind: 'refused', decision, revisionNumber, reason: reviewRefusalMessage(result.error, revisionNumber), refresh: 'reading' })
    return reconcile({ kind: 'unconfirmed', decision, revisionId: target.id, revisionNumber, checkedAt: null })
  }

  /** Shows the backend's answer, then reads the history and records and says whether what is shown follows it. */
  const refresh = async (answered: Extract<Status, { kind: 'recorded' | 'refused' }>) => {
    const reading = { ...answered, refresh: 'reading' as const }
    setStatus(reading)
    const read = await onChanged()
    // A later decision or check replaces this status; its own read reports then.
    setStatus((current) => (current === reading ? { ...reading, refresh: read ? 'read' : 'failed' } : current))
  }

  /** Looks for a decision whose answer was lost: shown in the history means recorded. */
  const reconcile = async (unconfirmed: Extract<Status, { kind: 'unconfirmed' }>) => {
    setStatus({ kind: 'checking', decision: unconfirmed.decision, revisionNumber: unconfirmed.revisionNumber })
    const read = await attempt(() => readTaskSubmission(enrollmentId, taskId))
    if (read.ok && findRecordedDecision(read.value.submission.revisions, unconfirmed.revisionId, unconfirmed.decision)) {
      setFeedback('')
      return refresh({ kind: 'recorded', decision: unconfirmed.decision, revisionNumber: unconfirmed.revisionNumber, fromHistory: true, refresh: 'reading' })
    }
    setStatus({ ...unconfirmed, checkedAt: read.ok ? new Date() : null })
    if (read.ok) void onChanged()
  }

  if (!revisions) return null
  const busy = status.kind === 'recording' || status.kind === 'checking' || ((status.kind === 'recorded' || status.kind === 'refused') && status.refresh === 'reading')
  const problem = (decision: ReviewDecision) => reviewProblem(decision, feedback)
  const canApprove = Boolean(target) && !busy && !problem('approval')
  const canRequestChanges = Boolean(target) && !busy && !problem('changes_requested')
  const approvals = countingApprovals(revisions)

  return (
    <section
      id={`task-review-${taskId}`}
      data-task-review
      data-status={status.kind}
      data-target-revision={target?.revisionNumber ?? ''}
      data-can-approve={canApprove}
      data-can-request-changes={canRequestChanges}
      data-decided-revision={status.kind === 'recorded' ? status.revisionNumber : ''}
      data-confirmed-by={status.kind === 'recorded' ? (status.fromHistory ? 'history' : 'answer') : ''}
      data-checked={status.kind === 'unconfirmed' ? String(status.checkedAt !== null) : ''}
      data-refresh={status.kind === 'recorded' || status.kind === 'refused' ? status.refresh : ''}
      aria-label="Your Review"
      className="rounded-lg border border-sky-900/60 bg-sky-950/15 p-2 space-y-2"
    >
      <h6 className="text-[10px] font-semibold uppercase tracking-wider text-sky-300">Your Review</h6>
      {target ? (
        <>
          <p id={`task-review-target-${taskId}`} className="text-[10px] text-slate-400">
            Deciding Revision {target.revisionNumber}, sent {new Date(target.sentAt).toLocaleString()}, exactly as shown above. A decision applies to this revision only and cannot be replaced.
            {approvals.length > 0 && ` The Approval of Revision ${approvals.join(', ')} keeps counting whatever you decide.`}
          </p>
          <label className="block">
            <span className="block text-[10px] text-slate-400 mb-0.5">Feedback (required to request changes; optional with an Approval)</span>
            <textarea
              ref={feedbackRef}
              id={`task-review-feedback-${taskId}`}
              value={feedback}
              disabled={busy}
              onChange={(e) => setFeedback(e.target.value)}
              rows={3}
              className="w-full text-xs text-slate-100 bg-slate-950 border border-slate-700/80 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-sky-500 disabled:opacity-60 resize-y"
              placeholder="What is good, and what the learner should correct…"
            />
          </label>
          {problem('changes_requested') && <p id={`task-review-hint-${taskId}`} className="text-[10px] text-slate-400">{problem('changes_requested')}</p>}
          <div className="flex flex-wrap gap-2">
            <button id={`task-review-approve-${taskId}`} onClick={() => void decide('approval')} disabled={!canApprove} className="px-2 py-1 rounded-lg border border-emerald-700 bg-emerald-800/40 hover:bg-emerald-800/60 text-emerald-100 disabled:opacity-50 cursor-pointer">
              Approve Revision {target.revisionNumber}
            </button>
            <button id={`task-review-request-changes-${taskId}`} onClick={() => void decide('changes_requested')} disabled={!canRequestChanges} className="px-2 py-1 rounded-lg border border-amber-700 bg-amber-800/30 hover:bg-amber-800/50 text-amber-100 disabled:opacity-50 cursor-pointer">
              Request changes to Revision {target.revisionNumber}
            </button>
          </div>
        </>
      ) : (
        <p id={`task-review-none-${taskId}`} className="text-[10px] text-slate-500">No revision of this Task is awaiting your Review.</p>
      )}
      <TaskReviewStatus taskId={taskId} status={status} feedbackKept={feedback.trim() !== ''} onCheck={(s) => void reconcile(s)} onReread={(s) => void refresh(s)} />
    </section>
  )
}

function TaskReviewStatus({ taskId, status, feedbackKept, onCheck, onReread }: {
  taskId: string
  status: Status
  feedbackKept: boolean
  onCheck: (status: Extract<Status, { kind: 'unconfirmed' }>) => void
  onReread: (status: Extract<Status, { kind: 'recorded' | 'refused' }>) => void
}) {
  const id = `task-review-status-${taskId}`
  const reread = (answered: Extract<Status, { kind: 'recorded' | 'refused' }>) => (
    <button id={`task-review-reread-${taskId}`} onClick={() => onReread(answered)} className="underline cursor-pointer">Read them again</button>
  )
  switch (status.kind) {
    case 'idle': return null
    case 'recording': return <p id={id} role="status" className="text-slate-400">Recording {DECISION_TEXT[status.decision]} of Revision {status.revisionNumber}…</p>
    case 'checking': return <p id={id} role="status" className="text-slate-400">Checking the submitted work…</p>
    case 'recorded': return (
      <div id={id} role="status" className="space-y-1">
        <p className="text-emerald-300">
          {DECISION_TEXT[status.decision]} of Revision {status.revisionNumber} recorded, confirmed by Gurow{status.fromHistory ? ' (the answer was lost, but the history shows it)' : ''}.
        </p>
        {status.refresh === 'reading' && <p className="text-slate-400">Reading the resulting XP, Mastery and Access…</p>}
        {status.refresh === 'read' && <p className="text-emerald-300">XP, Mastery and Access above are as Gurow derived them after it.</p>}
        {status.refresh === 'failed' && (
          <p className="text-amber-200">
            The resulting XP, Mastery and Access could not be read, so what is shown above may be out of date. {reread(status)}
          </p>
        )}
      </div>
    )
    case 'refused': return (
      <div id={id} role="alert" className="space-y-1">
        <p className="text-red-300">Not recorded: {status.reason}. Nothing changed.{feedbackKept ? ' Your feedback is kept here.' : ''}</p>
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
          Not confirmed: Gurow did not answer, so {DECISION_TEXT[status.decision]} of Revision {status.revisionNumber} may or may not have been recorded.{' '}
          {status.checkedAt
            ? `As of ${status.checkedAt.toLocaleTimeString()} the history shows no such decision. `
            : 'The history could not be read to check. '}
          A decision is never recorded twice, so deciding again is safe.
        </p>
        <button id={`task-review-check-${taskId}`} onClick={() => onCheck(status)} className="underline cursor-pointer">Check again</button>
      </div>
    )
  }
}
