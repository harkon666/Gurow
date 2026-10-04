/**
 * Session changes across tabs. All tabs of a browser share one session cookie, so a
 * sign-in or sign-out in one tab changes the Account of every other tab. Pages that
 * show private data listen here and must drop it before reading as the new Account.
 */
const CHANNEL = 'gurow:session'

/** Tells the other tabs this browser's session changed (sign-in, sign-up or sign-out). */
export function announceSessionChange() {
  if (typeof BroadcastChannel === 'undefined') return
  const channel = new BroadcastChannel(CHANNEL)
  channel.postMessage('changed')
  channel.close()
}

/**
 * Calls `listener('announced')` when another tab changed the session, and
 * `listener('resumed')` when this tab becomes visible or focused again, which also
 * catches changes made outside this application's UI. Returns the unsubscribe function.
 */
export function onSessionChange(listener: (reason: 'announced' | 'resumed') => void) {
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL)
  const announced = () => listener('announced')
  const resumed = () => { if (document.visibilityState === 'visible') listener('resumed') }
  channel?.addEventListener('message', announced)
  document.addEventListener('visibilitychange', resumed)
  window.addEventListener('focus', resumed)
  return () => {
    channel?.close()
    document.removeEventListener('visibilitychange', resumed)
    window.removeEventListener('focus', resumed)
  }
}
