import { useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { readAccount, type Account, type ApiResult } from './api'
import { onSessionChange } from './session'

export type OwnedView<T> =
  | { state: 'loading' }
  | { state: 'ready'; account: Account; value: T }
  | { state: 'unavailable'; account: Account }
  | { state: 'failed'; account: Account; error: string }

/**
 * Loads something only its owner may see (a Coach Workspace or Draft) for the
 * signed-in Account. The backend answers 404 to everyone else, shown as
 * "unavailable" without any of the content. When another tab signs in or out, the
 * shown view is dropped and loaded again for the session's Account; a signed-out
 * session returns to the entry page.
 */
export function useOwnedView<T>(key: string, load: () => Promise<ApiResult<T>>) {
  const navigate = useNavigate()
  const [view, setView] = useState<OwnedView<T>>({ state: 'loading' })
  const [generation, setGeneration] = useState(0)
  const loadRef = useRef(load)
  loadRef.current = load
  const shownAccountId = useRef<string | null>(null)
  shownAccountId.current = view.state === 'loading' ? null : view.account.id

  useEffect(() => {
    let current = true
    setView({ state: 'loading' })
    void (async () => {
      const account = await readAccount()
      if (!current) return
      if (!account.ok) return navigate({ to: '/', replace: true })
      const result = await loadRef.current()
      if (!current) return
      if (result.ok) setView({ state: 'ready', account: account.value.account, value: result.value })
      else if (result.status === 401) await navigate({ to: '/', replace: true })
      else if (result.status === 404) setView({ state: 'unavailable', account: account.value.account })
      else setView({ state: 'failed', account: account.value.account, error: result.error })
    })()
    return () => { current = false }
  }, [key, generation, navigate])

  // Another tab's sign-in or sign-out: keep the view only while the session is still its Account's.
  useEffect(() => onSessionChange(async (reason) => {
    if (reason === 'announced') setView({ state: 'loading' })
    const account = await readAccount()
    if (!account.ok) return navigate({ to: '/', replace: true })
    if (reason === 'announced' || account.value.account.id !== shownAccountId.current) setGeneration((n) => n + 1)
  }), [navigate])

  return [view, () => setGeneration((n) => n + 1)] as const
}
