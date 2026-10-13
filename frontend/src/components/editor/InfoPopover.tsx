import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * An information icon whose explanation floats beside it once pressed, and closes on a
 * second press or a press elsewhere. The explanation stays in the page while closed.
 */
export function InfoPopover({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false) }
    window.document.addEventListener('pointerdown', closeOutside)
    return () => window.document.removeEventListener('pointerdown', closeOutside)
  }, [open])
  return (
    <div ref={ref} className="relative inline-flex">
      <button id={`${id}-btn`} type="button" aria-label={label} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}
        className="w-4 h-4 inline-flex items-center justify-center rounded-full text-slate-400 hover:text-slate-100 cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400">
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </button>
      <div id={id} role="note" className={`${open ? 'block' : 'hidden'} absolute left-0 top-full z-20 mt-2 w-72 max-w-[calc(100vw-4rem)] rounded-xl border border-slate-700 bg-slate-900 p-3 shadow-xl text-left text-[11px] font-normal normal-case tracking-normal leading-relaxed text-slate-300 space-y-2`}>
        {children}
      </div>
    </div>
  )
}
