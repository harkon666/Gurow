import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { ContextHeader } from '../components/workspace/ContextHeader'
import { enterPersonalWorkspace, readAccount, signIn, signUp } from '../lib/api'

/** Only a path within this application is followed after sign-in, never another origin. */
const internalPath = (value: unknown) => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : undefined

/**
 * The product entry: sign in, then enter the Account's own Personal Workspace (ADR 0012,
 * 0022), or return to `next`, such as an Invitation the browser came from.
 */
export const Route = createFileRoute('/')({
  component: EntryPage,
  validateSearch: (search: Record<string, unknown>): { next?: string } => ({ next: internalPath(search.next) }),
})

function EntryPage() {
  const navigate = useNavigate()
  const { next } = Route.useSearch()
  const [phase, setPhase] = useState<'checking' | 'signed-out' | 'entering'>('checking')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  const enter = useCallback(async () => {
    setPhase('entering')
    if (next) return navigate({ href: next, replace: true })
    const entered = await enterPersonalWorkspace()
    if (!entered.ok) {
      setPhase('signed-out')
      if (entered.status !== 401) setError(`Could not open your Personal Workspace (${entered.error})`)
      return
    }
    await navigate({ to: '/workspaces/$workspaceId', params: { workspaceId: entered.value.workspace.id }, replace: true })
  }, [navigate, next])

  useEffect(() => {
    void readAccount().then((result) => (result.ok ? enter() : setPhase('signed-out')))
  }, [enter])

  const submit = (mode: 'sign-in' | 'sign-up') => async (event?: FormEvent) => {
    event?.preventDefault()
    setError(null)
    const result = mode === 'sign-in' ? await signIn(email, password) : await signUp(email, password, next)
    if (!result.ok) {
      setError(mode === 'sign-in' ? 'Sign-in failed: check your email and password.' : `Could not create the Account (${result.error}).`)
      return
    }
    await enter()
  }

  return (
    <main className="w-full h-full flex flex-col bg-slate-950">
      <ContextHeader account={null} />
      <section className="flex-1 flex items-center justify-center p-4">
        {phase === 'signed-out' ? (
          <form
            id="sign-in-form"
            onSubmit={submit('sign-in')}
            className="w-full max-w-sm bg-slate-900/80 border border-slate-800 rounded-xl p-6 flex flex-col gap-3"
          >
            <h1 className="text-lg font-semibold text-slate-100">Sign in to Gurow</h1>
            <p className="text-xs text-slate-400">One Account for personal learning, coaching and learning with a Coach.</p>
            <label className="text-xs text-slate-300 flex flex-col gap-1">
              Email
              <input id="email-input" type="email" required autoComplete="email" value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100" />
            </label>
            <label className="text-xs text-slate-300 flex flex-col gap-1">
              Password
              <input id="password-input" type="password" required minLength={8} autoComplete="current-password" value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100" />
            </label>
            {error && <p id="auth-error" role="alert" className="text-xs text-red-300">{error}</p>}
            <div className="flex gap-2 pt-1">
              <button id="sign-in-btn" type="submit"
                className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white text-sm rounded-lg py-2 cursor-pointer">
                Sign in
              </button>
              <button id="sign-up-btn" type="button" onClick={(e) => e.currentTarget.form?.reportValidity() && void submit('sign-up')()}
                className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm rounded-lg py-2 border border-slate-700 cursor-pointer">
                Create account
              </button>
            </div>
          </form>
        ) : (
          <p id="entry-status" className="text-sm text-slate-500">
            {phase === 'checking' ? 'Checking sign-in…' : next ? 'Returning…' : 'Opening your Personal Workspace…'}
          </p>
        )}
      </section>
    </main>
  )
}
