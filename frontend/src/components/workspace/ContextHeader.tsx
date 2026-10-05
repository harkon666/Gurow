import { Link } from '@tanstack/react-router'
import type { Account } from '../../lib/api'

/**
 * The learning context a page acts in; a coach context may name its Workspace. The
 * learner context is learning with a Coach through an Enrollment (or joining one).
 */
export type LearningContext = { kind: 'personal' } | { kind: 'coach'; workspaceName?: string } | { kind: 'learner' }

/**
 * Names the active learning context and the signed-in Account (US05, ADR 0010), and
 * switches between them. Personal and Coach are contexts of one Account, not Account
 * types; each page shows only its own context's data.
 */
export function ContextHeader({ account, onSignOut, context = { kind: 'personal' } }: { account: Account | null; onSignOut?: () => void; context?: LearningContext }) {
  const contextName = context.kind === 'personal' ? 'Personal Workspace'
    : context.kind === 'learner' ? 'Learning with a Coach'
    : `Coaching${context.workspaceName ? ` · ${context.workspaceName}` : ''}`
  const switchClass = (active: boolean) => `px-2 py-0.5 rounded-md border ${active ? 'text-slate-100 border-slate-600 bg-slate-800' : 'text-slate-400 border-transparent hover:text-slate-200'}`
  return (
    <header className="h-11 shrink-0 bg-slate-900/90 border-b border-slate-800/80 px-4 flex items-center justify-between">
      <div className="flex items-center gap-2.5">
        <div className="w-5 h-5 rounded bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 font-bold text-[10px]">
          G
        </div>
        <span className="font-semibold text-xs text-slate-200">Gurow</span>
        {account && (
          <>
            <span className="text-slate-600 text-xs">/</span>
            <span id="active-context" data-context={context.kind} className={`text-xs font-medium ${context.kind === 'personal' ? 'text-emerald-300' : context.kind === 'learner' ? 'text-violet-300' : 'text-sky-300'}`}>
              {contextName}
            </span>
            <nav id="context-switch" aria-label="Learning context" className="ml-3 flex items-center gap-1 text-[11px]">
              <Link id="switch-to-personal" to="/" aria-current={context.kind === 'personal' ? 'page' : undefined} className={switchClass(context.kind === 'personal')}>Personal</Link>
              <Link id="switch-to-learning" to="/learning" aria-current={context.kind === 'learner' ? 'page' : undefined} className={switchClass(context.kind === 'learner')}>Learning</Link>
              <Link id="switch-to-coach" to="/coach" aria-current={context.kind === 'coach' ? 'page' : undefined} className={switchClass(context.kind === 'coach')}>Coaching</Link>
            </nav>
          </>
        )}
      </div>
      {account && (
        <div className="flex items-center gap-2.5 text-xs">
          <span id="account-email" className="text-slate-300">{account.email}</span>
          <span
            id="email-verification-status"
            data-verified={account.emailVerified}
            className={`px-2 py-0.5 rounded-md border ${account.emailVerified
              ? 'text-emerald-300 border-emerald-700/60 bg-emerald-950/40'
              : 'text-amber-300 border-amber-700/60 bg-amber-950/40'}`}
          >
            {account.emailVerified ? 'Email verified' : 'Email not verified'}
          </span>
          {onSignOut && (
            <button
              id="sign-out-btn"
              onClick={onSignOut}
              className="text-slate-400 hover:text-slate-200 bg-slate-800/80 hover:bg-slate-700/80 border border-slate-700/60 px-2.5 py-1 rounded-lg cursor-pointer"
            >
              Sign out
            </button>
          )}
        </div>
      )}
    </header>
  )
}
