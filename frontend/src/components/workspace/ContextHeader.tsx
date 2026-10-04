import type { Account } from '../../lib/api'

/**
 * Names the active learning context and the signed-in Account (US05, ADR 0010).
 * Personal mode is a context of the Account, not an Account type.
 */
export function ContextHeader({ account, onSignOut }: { account: Account | null; onSignOut?: () => void }) {
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
            <span id="active-context" data-context="personal" className="text-xs text-emerald-300 font-medium">
              Personal Workspace
            </span>
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
