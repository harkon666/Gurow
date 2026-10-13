import { useEffect, useState, type ReactNode } from 'react'
import type { Account } from '../../lib/api'
import { FLOATING, SidebarAccount, type LearningContext } from './ContextHeader'

/**
 * What floats over a full-page canvas (Path editor, published Version): a row across
 * its top corners, a stack for notices under it, and a menu sidebar on the right that
 * opens and closes. The canvas keeps the whole page; none of these take room from it.
 */

/** The row over the canvas's top corners; only its controls take pointer input. */
export const FLOAT_ROW = 'absolute top-3 inset-x-3 z-40 flex flex-wrap items-start justify-between gap-2 pointer-events-none [&>*]:pointer-events-auto'
/** Notices that need an answer (conflicts, kept work, refusals), centered under the row; hidden while empty. */
export const FLOAT_STACK = 'absolute top-16 left-1/2 -translate-x-1/2 z-40 w-[min(60rem,calc(100%-1.5rem))] max-h-[60%] overflow-y-auto rounded-xl border border-slate-700/70 bg-slate-950 shadow-2xl empty:hidden'

const SIDEBAR_KEY = 'gurow:canvas-sidebar'

/** Whether the menu sidebar is open: at first on a wide screen, then as last left in this browser. */
export function useCanvasSidebar(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(true)
  useEffect(() => {
    const stored = window.localStorage.getItem(SIDEBAR_KEY)
    setOpen(stored ? stored === 'open' : window.matchMedia('(min-width: 768px)').matches)
  }, [])
  return [open, (next) => {
    setOpen(next)
    window.localStorage.setItem(SIDEBAR_KEY, next ? 'open' : 'closed')
  }]
}

export function SidebarToggle({ open, onToggle, badge }: { open: boolean; onToggle: (open: boolean) => void; badge?: ReactNode }) {
  return (
    <button id="toggle-sidebar-btn" aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open} aria-controls="canvas-sidebar" onClick={() => onToggle(!open)}
      className={`${FLOATING} h-9 px-2.5 flex items-center gap-1.5 text-xs text-slate-200 hover:bg-slate-800 cursor-pointer`}>
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
      </svg>
      <span>Menu</span>
      {!open && badge}
    </button>
  )
}

/** Kept in the page while closed, so the Account and context it names stay readable. */
export function CanvasSidebar({ open, onClose, heading, children, account, onSignOut, context }: {
  open: boolean
  onClose: () => void
  heading: string
  children: ReactNode
  account: Account
  onSignOut: () => void
  context: LearningContext
}) {
  return (
    <aside id="canvas-sidebar" aria-label="Menu" onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}
      className={`${FLOATING} ${open ? 'flex' : 'hidden'} absolute z-40 top-16 right-3 bottom-16 w-72 max-w-[calc(100%-1.5rem)] overflow-y-auto p-3 flex-col gap-4 text-xs text-slate-300`}>
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{heading}</h2>
          <button id="close-sidebar-btn" onClick={onClose} aria-label="Close menu" className="text-slate-400 hover:text-slate-200 p-1 rounded hover:bg-slate-800 cursor-pointer">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {children}
      </section>
      <section className="mt-auto flex flex-col gap-2 border-t border-slate-800 pt-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Account</h2>
        <SidebarAccount account={account} onSignOut={onSignOut} context={context} />
      </section>
    </aside>
  )
}
