import { Link } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { listVersionEnrollments, type CoachEnrollment } from '../../lib/api'

/**
 * The learners enrolled in one published Version, for its Coach (ADR 0013): each
 * Enrollment's status and the revisions awaiting Review, as the backend lists them.
 * Each opens the Enrollment, and each revision awaiting Review opens it on that Task's
 * Review, where the Coach reads the work and decides. Learners
 * keep sending meanwhile, so the list is read again whenever the page becomes visible.
 */
export function VersionEnrollments({ versionId, onSummary, taskTitles }: {
  versionId: string
  onSummary?: (summary: { count: number; awaiting: number }) => void
  /** The Version's Task titles by Task, to name what awaits Review. */
  taskTitles?: Map<string, string>
}) {
  const [enrollments, setEnrollments] = useState<CoachEnrollment[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reading, setReading] = useState(true)

  const load = useCallback(async () => {
    setReading(true)
    try {
      const result = await listVersionEnrollments(versionId)
      if (result.ok) {
        setEnrollments(result.value.enrollments)
        setError(null)
      } else {
        setError(result.error)
      }
    } catch {
      setError('the backend could not be reached')
    }
    setReading(false)
  }, [versionId])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const revalidate = () => { if (window.document.visibilityState === 'visible') void load() }
    window.addEventListener('focus', revalidate)
    window.document.addEventListener('visibilitychange', revalidate)
    return () => {
      window.removeEventListener('focus', revalidate)
      window.document.removeEventListener('visibilitychange', revalidate)
    }
  }, [load])

  const awaiting = enrollments?.reduce((total, enrollment) => total + enrollment.awaitingReview.length, 0) ?? 0
  const count = enrollments?.length
  useEffect(() => { if (count !== undefined) onSummary?.({ count, awaiting }) }, [count, awaiting, onSummary])
  return (
    <section id="version-enrollments" data-count={enrollments?.length ?? ''} data-awaiting-review={enrollments ? awaiting : ''} aria-labelledby="version-enrollments-heading" className="border border-slate-800 rounded-xl p-3 bg-slate-900/50 flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="version-enrollments-heading" className="text-sm font-semibold text-slate-100">Enrolled learners</h2>
        {enrollments && <span className="text-xs text-slate-400">{awaiting === 0 ? 'No work awaiting your Review' : `${awaiting} revision${awaiting === 1 ? '' : 's'} awaiting your Review`}</span>}
        <button id="version-enrollments-refresh" onClick={() => void load()} disabled={reading} className="text-xs text-slate-200 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 border border-slate-700 px-2 py-0.5 rounded-lg cursor-pointer">
          {reading ? 'Reading…' : 'Refresh'}
        </button>
      </div>
      {error && <p id="version-enrollments-error" role="alert" className="text-xs text-red-300">Could not {enrollments ? 'refresh' : 'read'} the Enrollments ({error}).</p>}
      {enrollments?.length === 0 && <p className="text-xs text-slate-500">Nobody has accepted an Invitation to this Version yet.</p>}
      {enrollments && enrollments.length > 0 && (
        <ul className="flex flex-col gap-1">
          {enrollments.map((enrollment) => (
            <li key={enrollment.id} id={`version-enrollment-${enrollment.id}`} data-email={enrollment.learner.email} data-status={enrollment.status} data-awaiting-review={enrollment.awaitingReview.length}
              className="text-xs text-slate-300 flex flex-wrap items-center gap-2 border-l-2 border-slate-700 pl-2">
              <Link id={`open-enrollment-${enrollment.id}`} to="/enrollments/$enrollmentId" params={{ enrollmentId: enrollment.id }} className="text-sky-300 hover:text-sky-200">
                {enrollment.learner.name || enrollment.learner.email}
              </Link>
              <span className="text-slate-500">{enrollment.learner.email}</span>
              <span className={enrollment.status === 'active' ? 'text-emerald-300' : 'text-amber-200'}>Enrollment {enrollment.status}</span>
              {enrollment.awaitingReview.length === 0 && <span className="text-slate-500">nothing awaiting Review</span>}
              {enrollment.awaitingReview.length > 0 && (
                <ul id={`version-enrollment-awaiting-${enrollment.id}`} className="basis-full flex flex-col gap-1">
                  {enrollment.awaitingReview.map((revision) => (
                    <li key={revision.revisionId}>
                      <Link id={`review-${enrollment.id}-${revision.taskId}`} data-revision-number={revision.revisionNumber}
                        to="/enrollments/$enrollmentId" params={{ enrollmentId: enrollment.id }} search={{ review: revision.taskId }}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-sky-800/70 bg-sky-950/30 hover:bg-sky-900/40 px-2.5 py-1.5 text-slate-100">
                        <span className="min-w-0">
                          <span className="font-medium break-words">{taskTitles?.get(revision.taskId) ?? 'Task'}</span>
                          <span className="text-slate-400"> · Revision {revision.revisionNumber} · sent {new Date(revision.sentAt).toLocaleString()}</span>
                        </span>
                        <span className="shrink-0 text-sky-200">Review →</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
