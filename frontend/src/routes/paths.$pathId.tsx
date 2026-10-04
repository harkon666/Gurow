import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { PathEditor } from '../components/path/PathEditor'
import { ContextHeader } from '../components/workspace/ContextHeader'
import { readAccount, readLearningPath, signOut, type Account, type PathDocument } from '../lib/api'
import { onSessionChange } from '../lib/session'

/**
 * One personal Learning Path, opened only by its owner (ADR 0012). The backend
 * answers 404 for every other Account. Like the Workspace page, the page drops the
 * Path when the shared session moves to another Account.
 */
export const Route = createFileRoute('/paths/$pathId')({ component: PathPage })

type View =
  | { state: 'loading' }
  | { state: 'ready'; account: Account; document: PathDocument }
  | { state: 'unavailable'; account: Account }
  | { state: 'failed'; account: Account; error: string }

function PathPage() {
  const { pathId } = Route.useParams()
  const navigate = useNavigate()
  const [view, setView] = useState<View>({ state: 'loading' })
  const [load, setLoad] = useState(0)
  const shownAccountId = useRef<string | null>(null)
  shownAccountId.current = view.state === 'loading' ? null : view.account.id

  // The document is read once per Account and Path: a reload here would replace unsaved local edits.
  useEffect(() => {
    let current = true
    setView({ state: 'loading' })
    void (async () => {
      const account = await readAccount()
      if (!current) return
      if (!account.ok) return navigate({ to: '/', replace: true })
      const document = await readLearningPath(pathId)
      if (!current) return
      if (document.ok) setView({ state: 'ready', account: account.value.account, document: document.value })
      else if (document.status === 401) await navigate({ to: '/', replace: true })
      else if (document.status === 404) setView({ state: 'unavailable', account: account.value.account })
      else setView({ state: 'failed', account: account.value.account, error: document.error })
    })()
    return () => { current = false }
  }, [pathId, navigate, load])

  // Another tab's sign-in or sign-out: keep the Path only while the session is still its owner's.
  useEffect(() => onSessionChange(async (reason) => {
    if (reason === 'announced') setView({ state: 'loading' })
    const account = await readAccount()
    if (!account.ok) return navigate({ to: '/', replace: true })
    if (reason === 'announced' || account.value.account.id !== shownAccountId.current) setLoad((n) => n + 1)
  }), [navigate])

  const handleSignOut = async () => {
    await signOut()
    await navigate({ to: '/', replace: true })
  }

  const account = view.state === 'loading' ? null : view.account
  return (
    <main className="w-full h-full flex flex-col bg-slate-950" data-account-id={account?.id ?? ''}>
      <ContextHeader account={account} onSignOut={handleSignOut} />
      {view.state === 'ready' && (
        <nav className="shrink-0 px-4 py-1.5 text-xs border-b border-slate-800/80 bg-slate-950">
          <Link id="back-to-workspace" to="/workspaces/$workspaceId" params={{ workspaceId: view.document.learningPath.personalWorkspaceId }} className="text-emerald-300 hover:text-emerald-200">
            ← Personal Workspace
          </Link>
        </nav>
      )}
      {view.state === 'ready' && <PathEditor key={`${view.account.id}:${pathId}`} accountId={view.account.id} initial={view.document} />}
      {view.state === 'loading' && <p className="p-6 text-sm text-slate-500">Loading Learning Path…</p>}
      {view.state === 'unavailable' && (
        <div id="path-unavailable" role="alert" className="m-6 max-w-md bg-slate-900/70 border border-slate-800 rounded-xl p-4 flex flex-col gap-2">
          <h1 className="text-base font-semibold text-slate-100">Learning Path not available</h1>
          <p className="text-xs text-slate-400">This Path does not exist or belongs to another Account. Personal Learning Paths are visible only to their owner.</p>
          <button id="open-own-workspace-btn" onClick={() => navigate({ to: '/', replace: true })} className="self-start text-xs text-emerald-300 hover:text-emerald-200 cursor-pointer">
            Open your Personal Workspace
          </button>
        </div>
      )}
      {view.state === 'failed' && <p id="path-error" role="alert" className="p-6 text-sm text-red-300">Could not load the Learning Path ({view.error}).</p>}
    </main>
  )
}
