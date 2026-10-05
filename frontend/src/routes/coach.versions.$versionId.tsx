import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'
import { PublishedVersionView, VersionHistory } from '../components/path/Publication'
import { ContextHeader } from '../components/workspace/ContextHeader'
import { readCoachVersion, signOut } from '../lib/api'
import { useOwnedView } from '../lib/useOwnedView'

/**
 * One published Learning Path Version, read-only, for the owning Coach only: an
 * earlier Version stays readable exactly as published after later ones (ADR 0005).
 */
export const Route = createFileRoute('/coach/versions/$versionId')({ component: CoachVersionPage })

function CoachVersionPage() {
  const { versionId } = Route.useParams()
  const navigate = useNavigate()
  const [view] = useOwnedView(`coach-version:${versionId}`, useCallback(() => readCoachVersion(versionId), [versionId]))
  const handleSignOut = async () => {
    await signOut()
    await navigate({ to: '/', replace: true })
  }

  const account = view.state === 'loading' ? null : view.account
  const document = view.state === 'ready' ? view.value : null
  return (
    <main className="w-full h-full flex flex-col bg-slate-950" data-account-id={account?.id ?? ''}>
      <ContextHeader account={account} onSignOut={handleSignOut} context={{ kind: 'coach' }} />
      {document && (
        <>
          <nav className="shrink-0 px-4 py-1.5 text-xs border-b border-slate-800/80 bg-slate-950 flex items-center gap-4">
            <Link id="back-to-path" to="/coach/paths/$pathId" params={{ pathId: document.learningPath.id }} className="text-sky-300 hover:text-sky-200">
              ← Learning Path
            </Link>
            <VersionHistory versions={document.versions} currentVersionId={document.version?.id} />
          </nav>
          <PublishedVersionView document={document} />
        </>
      )}
      {view.state === 'loading' && <p className="p-6 text-sm text-slate-500">Loading Learning Path Version…</p>}
      {view.state === 'unavailable' && (
        <div id="version-unavailable" role="alert" className="m-6 max-w-md bg-slate-900/70 border border-slate-800 rounded-xl p-4 flex flex-col gap-2">
          <h1 className="text-base font-semibold text-slate-100">Learning Path Version not available</h1>
          <p className="text-xs text-slate-400">This Version does not exist, is not published, or belongs to another Coach's Workspace.</p>
          <Link to="/coach" className="self-start text-xs text-sky-300 hover:text-sky-200">Open your Coach Workspaces</Link>
        </div>
      )}
      {view.state === 'failed' && <p id="version-error" role="alert" className="p-6 text-sm text-red-300">Could not load the Learning Path Version ({view.error}).</p>}
    </main>
  )
}
