import { useEffect, useRef, useState } from 'react'
import { keptWorkKey } from './keptWork'
import { KeptWorkSession, type KeptWorkSessionOptions, type KeptWorkView } from './keptWorkSession'

export type { KeptEntry, ReapplyStatus, SaveAnswer } from './keptWorkSession'

export type KeptWorkOptions<D, A> = Omit<KeptWorkSessionOptions<D, A>, 'storage' | 'onView'>

const browserStorage = () => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/**
 * The editor's {@link KeptWorkSession}, one per editing context, with its view as React
 * state. The options are read when used, so their callbacks can follow each render.
 */
export function useKeptWork<D, A>(options: KeptWorkOptions<D, A>): { session: KeptWorkSession<D, A>; view: KeptWorkView<D> } {
  const optionsRef = useRef(options)
  optionsRef.current = options
  const contextId = keptWorkKey(options.context, '')
  const [view, setView] = useState<KeptWorkView<D>>({ entries: [], refused: [], liveChanges: [], live: { kind: 'idle' }, busy: false })
  const [session] = useState(() => new KeptWorkSession<D, A>({
    context: options.context,
    initial: options.initial,
    storage: browserStorage(),
    problem: (document) => optionsRef.current.problem(document),
    same: (a, b) => optionsRef.current.same(a, b),
    merge: (base, mine, current) => optionsRef.current.merge(base, mine, current),
    changes: (base, mine) => optionsRef.current.changes(base, mine),
    build: () => optionsRef.current.build(),
    read: () => optionsRef.current.read(),
    save: (work, expectedRevision) => optionsRef.current.save(work, expectedRevision),
    revisionOf: (accepted) => optionsRef.current.revisionOf(accepted),
    show: (accepted) => optionsRef.current.show(accepted),
    onAccepted: (accepted) => optionsRef.current.onAccepted?.(accepted),
    onView: setView,
  }))

  // The editor is keyed by its context, so one session serves it for its lifetime.
  useEffect(() => {
    session.open()
    return () => session.close()
  }, [session, contextId])

  return { session, view }
}
