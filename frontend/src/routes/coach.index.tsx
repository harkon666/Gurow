import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { ContextHeader } from '../components/workspace/ContextHeader'
import { createCoachWorkspace, listCoachWorkspaces, signOut } from '../lib/api'
import { useOwnedView } from '../lib/useOwnedView'

/**
 * The owning-Coach context of the signed-in Account (ADR 0010, 0011): the Coach
 * Workspaces it owns and a way to create one. Nothing from the Personal Workspace is
 * read or shown here.
 */
export const Route = createFileRoute('/coach/')({ component: CoachHomePage })

function CoachHomePage() {
  const navigate = useNavigate()
  const [view] = useOwnedView('coach-home', listCoachWorkspaces)
  const [name, setName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)

  const create = async (event: FormEvent) => {
    event.preventDefault()
    setCreateError(null)
    const created = await createCoachWorkspace(name.trim())
    if (!created.ok) {
      if (created.status === 401) return navigate({ to: '/', replace: true })
      return setCreateError(`Could not create the Coach Workspace (${typeof created.body?.detail === 'string' ? created.body.detail : created.error}).`)
    }
    await navigate({ to: '/coach/workspaces/$workspaceId', params: { workspaceId: created.value.workspace.id } })
  }
  const handleSignOut = async () => {
    await signOut()
    await navigate({ to: '/', replace: true })
  }

  const account = view.state === 'loading' ? null : view.account
  return (
    <main className="w-full h-full flex flex-col bg-slate-950" data-account-id={account?.id ?? ''}>
      <ContextHeader account={account} onSignOut={handleSignOut} context={{ kind: 'coach' }} />
      <section className="flex-1 overflow-y-auto p-6">
        {view.state === 'loading' && <p className="text-sm text-slate-500">Loading your Coach Workspaces…</p>}
        {view.state === 'ready' && (
          <div id="coach-home" className="max-w-2xl flex flex-col gap-4">
            <div>
              <h1 className="text-xl font-semibold text-slate-100">Coaching</h1>
              <p className="text-xs text-slate-400 mt-1">
                You are the one Coach of each Workspace you own. Its Learning Paths are prepared as Drafts; your Personal Workspace stays private and is not shown here.
              </p>
            </div>
            <div id="coach-workspaces" className="bg-slate-900/70 border border-slate-800 rounded-xl p-4">
              <h2 className="text-sm font-medium text-slate-200 mb-2">Your Coach Workspaces</h2>
              {view.value.workspaces.length === 0 ? (
                <p id="coach-workspaces-empty" className="text-xs text-slate-500">You do not own a Coach Workspace yet.</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {view.value.workspaces.map((workspace) => (
                    <li key={workspace.id} data-coach-workspace-id={workspace.id} className="text-sm">
                      <Link to="/coach/workspaces/$workspaceId" params={{ workspaceId: workspace.id }} className="text-slate-200 hover:text-sky-300">{workspace.name}</Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <form id="new-coach-workspace-form" onSubmit={create} className="bg-slate-900/70 border border-slate-800 rounded-xl p-4 flex flex-col gap-2">
              <h2 className="text-sm font-medium text-slate-200">New Coach Workspace</h2>
              <input
                id="new-coach-workspace-name"
                aria-label="Coach Workspace name"
                required
                maxLength={200}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name, e.g. Linear Algebra Studio"
                className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-100"
              />
              {createError && <p id="create-coach-workspace-error" role="alert" className="text-xs text-red-300">{createError}</p>}
              <button
                id="create-coach-workspace-btn"
                type="submit"
                disabled={name.trim() === ''}
                className="self-start bg-sky-600 hover:bg-sky-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded-lg px-3 py-1.5 cursor-pointer"
              >
                Create Coach Workspace
              </button>
            </form>
          </div>
        )}
        {view.state === 'failed' && <p id="coach-error" role="alert" className="text-sm text-red-300">Could not load your Coach Workspaces ({view.error}).</p>}
      </section>
    </main>
  )
}
