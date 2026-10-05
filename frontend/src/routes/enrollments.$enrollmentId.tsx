import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'
import { EnrolledVersionView } from '../components/path/EnrolledVersion'
import { ContextHeader } from '../components/workspace/ContextHeader'
import { readEnrolledVersion, signOut } from '../lib/api'
import { useOwnedView } from '../lib/useOwnedView'

/**
 * One Enrollment's Version, for its learner (or the owning Coach) only (ADR 0013):
 * the backend answers 404 to every other Account, shown without any of its content.
 */
export const Route = createFileRoute('/enrollments/$enrollmentId')({ component: EnrollmentPage })

function EnrollmentPage() {
  const { enrollmentId } = Route.useParams()
  const navigate = useNavigate()
  const [view] = useOwnedView(`enrollment:${enrollmentId}`, useCallback(() => readEnrolledVersion(enrollmentId), [enrollmentId]))
  const handleSignOut = async () => {
    await signOut()
    await navigate({ to: '/', replace: true })
  }

  const account = view.state === 'loading' ? null : view.account
  const document = view.state === 'ready' ? view.value : null
  return (
    <main className="w-full h-full flex flex-col bg-slate-950" data-account-id={account?.id ?? ''}>
      <ContextHeader account={account} onSignOut={handleSignOut} context={document?.viewer === 'coach' ? { kind: 'coach', workspaceName: document.coachWorkspace.name } : { kind: 'learner' }} />
      {document && view.state === 'ready' && (
        <>
          <nav className="shrink-0 px-4 py-1.5 text-xs border-b border-slate-800/80 bg-slate-950">
            {document.viewer === 'learner'
              ? <Link id="back-to-learning" to="/learning" className="text-violet-300 hover:text-violet-200">← Your Enrollments</Link>
              : <Link id="back-to-coach-workspace" to="/coach/workspaces/$workspaceId" params={{ workspaceId: document.coachWorkspace.id }} className="text-sky-300 hover:text-sky-200">← Coach Workspace</Link>}
          </nav>
          <EnrolledVersionView key={`${view.account.id}:${enrollmentId}`} accountId={view.account.id} document={document} />
        </>
      )}
      {view.state === 'loading' && <p className="p-6 text-sm text-slate-500">Loading your Enrollment…</p>}
      {view.state === 'unavailable' && (
        <div id="enrollment-unavailable" role="alert" className="m-6 max-w-md bg-slate-900/70 border border-slate-800 rounded-xl p-4 flex flex-col gap-2">
          <h1 className="text-base font-semibold text-slate-100">Enrollment not available</h1>
          <p className="text-xs text-slate-400">This Enrollment does not exist or is not yours. An Enrollment and its progress are visible only to its learner and the Coach of its Workspace.</p>
          <Link to="/learning" className="self-start text-xs text-violet-300 hover:text-violet-200">Open your Enrollments</Link>
        </div>
      )}
      {view.state === 'failed' && <p id="enrollment-error" role="alert" className="p-6 text-sm text-red-300">Could not load the Enrollment ({view.error}).</p>}
    </main>
  )
}
