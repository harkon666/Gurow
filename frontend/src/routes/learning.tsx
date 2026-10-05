import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { ContextHeader } from '../components/workspace/ContextHeader'
import { listLearnerEnrollments, signOut } from '../lib/api'
import { useOwnedView } from '../lib/useOwnedView'

/**
 * The signed-in Account's Enrollments as a learner (ADR 0010): each joined one
 * published Version of a Coach's Learning Path, and opens on that Version.
 */
export const Route = createFileRoute('/learning')({ component: LearningPage })

function LearningPage() {
  const navigate = useNavigate()
  const [view] = useOwnedView('learning-home', listLearnerEnrollments)
  const handleSignOut = async () => {
    await signOut()
    await navigate({ to: '/', replace: true })
  }

  const account = view.state === 'loading' ? null : view.account
  return (
    <main className="w-full h-full flex flex-col bg-slate-950" data-account-id={account?.id ?? ''}>
      <ContextHeader account={account} onSignOut={handleSignOut} context={{ kind: 'learner' }} />
      <section className="flex-1 overflow-y-auto p-6">
        {view.state === 'loading' && <p className="text-sm text-slate-500">Loading your Enrollments…</p>}
        {view.state === 'ready' && (
          <div id="learner-enrollments" className="max-w-2xl flex flex-col gap-4">
            <div>
              <h1 className="text-xl font-semibold text-slate-100">Learning with a Coach</h1>
              <p className="text-xs text-slate-400 mt-1">Each Enrollment is your participation in one published Version of a Coach's Learning Path. Your Personal Workspace is not shown here.</p>
            </div>
            {view.value.enrollments.length === 0 ? (
              <p id="learner-enrollments-empty" className="text-xs text-slate-500">You are not enrolled in a Coach's Learning Path. Enrollments start from an emailed Invitation.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {view.value.enrollments.map((enrollment) => (
                  <li key={enrollment.id} data-enrollment-id={enrollment.id} data-status={enrollment.status} className="bg-slate-900/70 border border-slate-800 rounded-xl p-3 flex items-center justify-between gap-3">
                    <div>
                      <Link id={`open-enrollment-${enrollment.id}`} to="/enrollments/$enrollmentId" params={{ enrollmentId: enrollment.id }} className="text-sm text-slate-100 hover:text-violet-300">
                        {enrollment.learningPathTitle} · Version {enrollment.versionNumber}
                      </Link>
                      <p className="text-xs text-slate-400">with {enrollment.coachWorkspaceName}</p>
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded-md border ${enrollment.status === 'active' ? 'text-emerald-300 border-emerald-800/60' : 'text-amber-200 border-amber-800/60'}`}>{enrollment.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {view.state === 'failed' && <p id="learning-error" role="alert" className="text-sm text-red-300">Could not load your Enrollments ({view.error}).</p>}
      </section>
    </main>
  )
}
