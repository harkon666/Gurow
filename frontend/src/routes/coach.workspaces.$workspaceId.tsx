import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useCallback, useState, type FormEvent } from 'react'
import { ContextHeader } from '../components/workspace/ContextHeader'
import { createCoachPath, readCoachWorkspace, signOut } from '../lib/api'
import { useOwnedView } from '../lib/useOwnedView'

/**
 * One Coach Workspace, shown only to its owning Coach (ADR 0011). Every other
 * Account sees "not available", without the Workspace's content.
 */
export const Route = createFileRoute('/coach/workspaces/$workspaceId')({ component: CoachWorkspacePage })

function CoachWorkspacePage() {
  const { workspaceId } = Route.useParams()
  const navigate = useNavigate()
  const [view] = useOwnedView(`coach-workspace:${workspaceId}`, useCallback(() => readCoachWorkspace(workspaceId), [workspaceId]))
  const [newPath, setNewPath] = useState({ title: '', goal: '' })
  const [createError, setCreateError] = useState<string | null>(null)

  const createPath = async (event: FormEvent) => {
    event.preventDefault()
    setCreateError(null)
    const created = await createCoachPath(workspaceId, newPath.title.trim(), newPath.goal)
    if (!created.ok) {
      if (created.status === 401) return navigate({ to: '/', replace: true })
      return setCreateError(`Could not create the Learning Path (${typeof created.body?.detail === 'string' ? created.body.detail : created.error}).`)
    }
    await navigate({ to: '/coach/paths/$pathId', params: { pathId: created.value.learningPath.id } })
  }
  const handleSignOut = async () => {
    await signOut()
    await navigate({ to: '/', replace: true })
  }

  const account = view.state === 'loading' ? null : view.account
  const workspace = view.state === 'ready' ? view.value : null
  return (
    <main className="w-full h-full flex flex-col bg-slate-950" data-account-id={account?.id ?? ''} data-coach-workspace-id={workspace?.workspace.id ?? ''}>
      <ContextHeader account={account} onSignOut={handleSignOut} context={{ kind: 'coach', workspaceName: workspace?.workspace.name }} />
      <section className="flex-1 overflow-y-auto p-6">
        {view.state === 'loading' && <p className="text-sm text-slate-500">Loading Coach Workspace…</p>}
        {workspace && (
          <div id="coach-workspace" className="max-w-2xl flex flex-col gap-4">
            <div>
              <Link id="back-to-coaching" to="/coach" className="text-xs text-sky-300 hover:text-sky-200">← Coaching</Link>
              <h1 id="coach-workspace-name" className="text-xl font-semibold text-slate-100 mt-1">{workspace.workspace.name}</h1>
              <p className="text-xs text-slate-400 mt-1">You are this Workspace's one Coach. Each Learning Path defines its own outcomes, Tasks and rules.</p>
            </div>
            <div id="coach-paths" className="bg-slate-900/70 border border-slate-800 rounded-xl p-4">
              <h2 className="text-sm font-medium text-slate-200 mb-2">Learning Paths</h2>
              {workspace.learningPaths.length === 0 ? (
                <p id="coach-paths-empty" className="text-xs text-slate-500">No Learning Paths yet.</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {workspace.learningPaths.map((path) => (
                    <li key={path.id} data-learning-path-id={path.id} className="text-sm">
                      <Link to="/coach/paths/$pathId" params={{ pathId: path.id }} className="text-slate-200 hover:text-sky-300">{path.title}</Link>
                      {path.goal && <span className="block text-xs text-slate-500">{path.goal}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <form id="new-coach-path-form" onSubmit={createPath} className="bg-slate-900/70 border border-slate-800 rounded-xl p-4 flex flex-col gap-2">
              <h2 className="text-sm font-medium text-slate-200">New Learning Path</h2>
              <input
                id="new-coach-path-title"
                aria-label="Learning Path title"
                required
                maxLength={200}
                value={newPath.title}
                onChange={(e) => setNewPath({ ...newPath, title: e.target.value })}
                placeholder="Title"
                className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-100"
              />
              <textarea
                id="new-coach-path-goal"
                aria-label="Learning Path goal"
                maxLength={2000}
                value={newPath.goal}
                onChange={(e) => setNewPath({ ...newPath, goal: e.target.value })}
                placeholder="Goal: what learners work toward"
                rows={2}
                className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-100 resize-none"
              />
              {createError && <p id="create-coach-path-error" role="alert" className="text-xs text-red-300">{createError}</p>}
              <button
                id="create-coach-path-btn"
                type="submit"
                disabled={newPath.title.trim() === ''}
                className="self-start bg-sky-600 hover:bg-sky-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded-lg px-3 py-1.5 cursor-pointer"
              >
                Create Learning Path Draft
              </button>
            </form>
          </div>
        )}
        {view.state === 'unavailable' && (
          <div id="coach-workspace-unavailable" role="alert" className="max-w-md bg-slate-900/70 border border-slate-800 rounded-xl p-4 flex flex-col gap-2">
            <h1 className="text-base font-semibold text-slate-100">Coach Workspace not available</h1>
            <p className="text-xs text-slate-400">This Workspace does not exist or belongs to another Coach. A Coach Workspace is managed only by its owner.</p>
            <Link to="/coach" className="self-start text-xs text-sky-300 hover:text-sky-200">Open your Coach Workspaces</Link>
          </div>
        )}
        {view.state === 'failed' && <p id="coach-workspace-error" role="alert" className="text-sm text-red-300">Could not load the Coach Workspace ({view.error}).</p>}
      </section>
    </main>
  )
}
