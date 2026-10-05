import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'
import { COACH_MODE, PathEditor } from '../components/path/PathEditor'
import { ContextHeader } from '../components/workspace/ContextHeader'
import { readCoachPath, signOut } from '../lib/api'
import { useOwnedView } from '../lib/useOwnedView'

/**
 * A coach-mode Learning Path's Draft, edited by the owning Coach only (ADR 0011).
 * The document is read once per Account and Path, so unsaved local edits are never
 * replaced by a reload of the page's own data.
 */
export const Route = createFileRoute('/coach/paths/$pathId')({ component: CoachPathPage })

function CoachPathPage() {
  const { pathId } = Route.useParams()
  const navigate = useNavigate()
  const [view] = useOwnedView(`coach-path:${pathId}`, useCallback(() => readCoachPath(pathId), [pathId]))
  const handleSignOut = async () => {
    await signOut()
    await navigate({ to: '/', replace: true })
  }

  const account = view.state === 'loading' ? null : view.account
  const document = view.state === 'ready' ? view.value : null
  return (
    <main className="w-full h-full flex flex-col bg-slate-950" data-account-id={account?.id ?? ''}>
      <ContextHeader account={account} onSignOut={handleSignOut} context={{ kind: 'coach' }} />
      {document && view.state === 'ready' && (
        <>
          <nav className="shrink-0 px-4 py-1.5 text-xs border-b border-slate-800/80 bg-slate-950">
            <Link id="back-to-coach-workspace" to="/coach/workspaces/$workspaceId" params={{ workspaceId: document.learningPath.coachWorkspaceId }} className="text-sky-300 hover:text-sky-200">
              ← Coach Workspace
            </Link>
          </nav>
          {document.draft ? (
            <PathEditor key={`${view.account.id}:${pathId}`} accountId={view.account.id} initial={document} mode={COACH_MODE} />
          ) : (
            <p id="no-open-draft" className="p-6 text-sm text-slate-400">This Learning Path has no open Draft.</p>
          )}
        </>
      )}
      {view.state === 'loading' && <p className="p-6 text-sm text-slate-500">Loading Learning Path Draft…</p>}
      {view.state === 'unavailable' && (
        <div id="path-unavailable" role="alert" className="m-6 max-w-md bg-slate-900/70 border border-slate-800 rounded-xl p-4 flex flex-col gap-2">
          <h1 className="text-base font-semibold text-slate-100">Learning Path not available</h1>
          <p className="text-xs text-slate-400">This Path does not exist or belongs to another Coach's Workspace. Drafts are visible only to their Workspace's Coach.</p>
          <Link to="/coach" className="self-start text-xs text-sky-300 hover:text-sky-200">Open your Coach Workspaces</Link>
        </div>
      )}
      {view.state === 'failed' && <p id="path-error" role="alert" className="p-6 text-sm text-red-300">Could not load the Learning Path ({view.error}).</p>}
    </main>
  )
}
