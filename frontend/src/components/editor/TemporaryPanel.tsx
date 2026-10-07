import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** A temporary, keyboard-contained view; closing returns to its invoking control. */
export function TemporaryPanel({ title, closeId, onClose, children, initialFocus }: {
  title: string
  closeId: string
  onClose: () => void
  children: ReactNode
  initialFocus?: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const dialog = ref.current!
    const previous = document.activeElement as HTMLElement | null
    dialog.showModal()
    const target = initialFocus ? dialog.querySelector<HTMLElement>(initialFocus) : null
    ;(target ?? dialog.querySelector<HTMLElement>('button'))?.focus()
    return () => {
      dialog.close()
      if (previous?.isConnected && previous !== document.body && previous.getClientRects().length) previous.focus()
      else document.getElementById('btn-skill-list')?.focus()
    }
  }, [initialFocus])
  return createPortal(
    <dialog ref={ref} aria-label={title} onCancel={(event) => { event.preventDefault(); close.current() }}
      // Scroll padding keeps content scrolled into view (focus, find) clear of the sticky header.
      className="fixed inset-0 m-auto scroll-pt-16 w-full h-dvh max-w-none max-h-none md:w-[36rem] md:h-auto md:max-h-[88dvh] md:rounded-2xl border border-slate-700 bg-slate-950 text-slate-200 p-0 shadow-2xl backdrop:bg-black/50">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-800 bg-slate-950">
        <h2 className="font-semibold">{title}</h2>
        <button id={closeId} onClick={onClose} className="rounded-lg border border-slate-700 px-3 py-1 text-sm hover:bg-slate-800">Close</button>
      </div>
      {children}
    </dialog>, document.body,
  )
}
