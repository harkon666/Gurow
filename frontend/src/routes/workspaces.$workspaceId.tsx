import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ContextHeader } from '../components/workspace/ContextHeader'
import { createLearningPath, readAccount, readPersonalWorkspace, signOut, type Account, type PersonalWorkspace } from '../lib/api'
import { onSessionChange } from '../lib/session'

/**
 * A Personal Workspace, shown only to its owner (ADR 0012). The backend answers
 * 404 for every other Account, so the page never learns another owner's content.
 * Tabs share one session, so the page also revalidates its Account when another
 * tab signs in or out and when this tab is resumed, and never keeps one Account's
 * Workspace on screen under another Account's session.
 */
export const Route = createFileRoute('/workspaces/$workspaceId')({ component: WorkspacePage })

type View =
  | { state: 'loading' }
  | { state: 'ready'; account: Account; workspace: PersonalWorkspace }
  | { state: 'unavailable'; account: Account }
  | { state: 'failed'; account: Account; error: string }

function WorkspacePage() {
  const { workspaceId } = Route.useParams()
  const navigate = useNavigate()
  const [view, setView] = useState<View>({ state: 'loading' })
  const [revalidation, setRevalidation] = useState(0)
  const shownAccountId = useRef<string | null>(null)
  shownAccountId.current = view.state === 'loading' ? null : view.account.id
  const loadedWorkspaceId = useRef<string | null>(null)

  // Another tab's sign-in or sign-out replaced this tab's Account: drop the private view at once.
  useEffect(() => onSessionChange((reason) => {
    if (reason === 'announced') setView({ state: 'loading' })
    setRevalidation((n) => n + 1)
  }), [])

  // A newer load cancels an older one, so a response read for an earlier session never fills the view.
  useEffect(() => {
    let current = true
    if (loadedWorkspaceId.current !== workspaceId) {
      loadedWorkspaceId.current = workspaceId
      setView({ state: 'loading' })
    }
    void (async () => {
      const account = await readAccount()
      if (!current) return
      if (!account.ok) {
        setView({ state: 'loading' })
        return navigate({ to: '/', replace: true })
      }
      if (shownAccountId.current !== null && shownAccountId.current !== account.value.account.id) setView({ state: 'loading' })
      const workspace = await readPersonalWorkspace(workspaceId)
      if (!current) return
      if (workspace.ok) setView({ state: 'ready', account: account.value.account, workspace: workspace.value })
      else if (workspace.status === 401) await navigate({ to: '/', replace: true })
      else if (workspace.status === 404) setView({ state: 'unavailable', account: account.value.account })
      else setView({ state: 'failed', account: account.value.account, error: workspace.error })
    })()
    return () => { current = false }
  }, [workspaceId, navigate, revalidation])

  const [newPath, setNewPath] = useState({ title: '', goal: '' })
  const [createError, setCreateError] = useState<string | null>(null)
  const createPath = async (event: FormEvent) => {
    event.preventDefault()
    setCreateError(null)
    const created = await createLearningPath(newPath.title.trim(), newPath.goal)
    if (!created.ok) {
      if (created.status === 401) return navigate({ to: '/', replace: true })
      return setCreateError(`Could not create the Learning Path (${typeof created.body?.detail === 'string' ? created.body.detail : created.error}).`)
    }
    await navigate({ to: '/paths/$pathId', params: { pathId: created.value.learningPath.id } })
  }

  const handleSignOut = async () => {
    await signOut()
    await navigate({ to: '/', replace: true })
  }

  const account = view.state === 'loading' ? null : view.account
  return (
    <main
      className="w-full h-full flex flex-col bg-slate-950"
      data-account-id={account?.id ?? ''}
      data-workspace-id={view.state === 'ready' ? view.workspace.workspace.id : ''}
    >
      <ContextHeader account={account} onSignOut={handleSignOut} />
      <section className="flex-1 overflow-y-auto p-6">
        {view.state === 'loading' && <p className="text-sm text-slate-500">Loading Personal Workspace…</p>}
        {view.state === 'ready' && (
          <div id="personal-workspace" className="max-w-2xl flex flex-col gap-4">
            <div>
              <h1 className="text-xl font-semibold text-slate-100">Your Personal Workspace</h1>
              <p id="workspace-privacy" className="text-xs text-slate-400 mt-1">
                Private to {view.account.email}. In personal mode you set your own Task rewards and declare your own Mastery.
              </p>
            </div>
            <div id="workspace-paths" className="bg-slate-900/70 border border-slate-800 rounded-xl p-4">
              <h2 className="text-sm font-medium text-slate-200 mb-2">Learning Paths</h2>
              {view.workspace.learningPaths.length === 0 ? (
                <p id="workspace-empty" className="text-xs text-slate-500">No Learning Paths yet.</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {view.workspace.learningPaths.map((path) => (
                    <li key={path.id} data-learning-path-id={path.id} className="text-sm">
                      <Link to="/paths/$pathId" params={{ pathId: path.id }} className="text-slate-200 hover:text-emerald-300">{path.title}</Link>
                      {path.goal && <span className="block text-xs text-slate-500">{path.goal}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <form id="new-path-form" onSubmit={createPath} className="bg-slate-900/70 border border-slate-800 rounded-xl p-4 flex flex-col gap-2">
              <h2 className="text-sm font-medium text-slate-200">New Learning Path</h2>
              <input
                id="new-path-title"
                aria-label="Learning Path title"
                required
                maxLength={200}
                value={newPath.title}
                onChange={(e) => setNewPath({ ...newPath, title: e.target.value })}
                placeholder="Title"
                className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-100"
              />
              <textarea
                id="new-path-goal"
                aria-label="Learning Path goal"
                maxLength={2000}
                value={newPath.goal}
                onChange={(e) => setNewPath({ ...newPath, goal: e.target.value })}
                placeholder="Goal: what this Path works toward"
                rows={2}
                className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-100 resize-none"
              />
              {createError && <p id="create-path-error" role="alert" className="text-xs text-red-300">{createError}</p>}
              <button
                id="create-path-btn"
                type="submit"
                disabled={newPath.title.trim() === ''}
                className="self-start bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded-lg px-3 py-1.5 cursor-pointer"
              >
                Create Learning Path
              </button>
            </form>
          </div>
        )}
        {view.state === 'unavailable' && (
          <div id="workspace-unavailable" role="alert" className="max-w-md bg-slate-900/70 border border-slate-800 rounded-xl p-4 flex flex-col gap-2">
            <h1 className="text-base font-semibold text-slate-100">Personal Workspace not available</h1>
            <p className="text-xs text-slate-400">
              This Workspace does not exist or belongs to another Account. Personal Workspaces are visible only to their owner.
            </p>
            <button
              id="open-own-workspace-btn"
              onClick={() => navigate({ to: '/', replace: true })}
              className="self-start text-xs text-emerald-300 hover:text-emerald-200 cursor-pointer"
            >
              Open your Personal Workspace
            </button>
          </div>
        )}
        {view.state === 'failed' && <p id="workspace-error" role="alert" className="text-sm text-red-300">Could not load the Workspace ({view.error}).</p>}
      </section>
    </main>
  )
}
