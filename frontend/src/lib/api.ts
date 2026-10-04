import { announceSessionChange } from './session'

/**
 * Same-origin calls to the backend through /api (ADR 0022). The session lives in
 * an httpOnly cookie, so the browser never handles a token or names an Account.
 */

export interface Account {
  id: string
  email: string
  name: string
  emailVerified: boolean
}

export interface PersonalWorkspace {
  workspace: { id: string; createdAt: string }
  learningPaths: { id: string; title: string }[]
}

export type ApiResult<T> = { ok: true; status: number; value: T } | { ok: false; status: number; error: string }

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
  const response = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const body = await response.json().catch(() => null) as Record<string, unknown> | null
  if (response.ok) return { ok: true, status: response.status, value: body as T }
  const error = body?.error ?? body?.message ?? body?.code
  return { ok: false, status: response.status, error: typeof error === 'string' ? error : `HTTP ${response.status}` }
}

export const readAccount = () => call<{ account: Account }>('/account')

/** Runs a session-changing call and tells the other tabs, whose shown Account it replaces. */
async function changeSession(path: string, body: unknown) {
  const result = await call(path, { method: 'POST', body })
  if (result.ok) announceSessionChange()
  return result
}

export const signIn = (email: string, password: string) => changeSession('/auth/sign-in/email', { email, password })

/** Creates the Account; the verification link sent to `email` returns the browser to the entry page. */
export const signUp = (email: string, password: string) =>
  changeSession('/auth/sign-up/email', { email, password, name: email.split('@')[0], callbackURL: '/' })

export const signOut = () => changeSession('/auth/sign-out', {})

/** Enters the signed-in Account's one Personal Workspace, creating it on first entry. */
export const enterPersonalWorkspace = () => call<PersonalWorkspace>('/personal/workspace', { method: 'PUT' })

export const readPersonalWorkspace = (workspaceId: string) =>
  call<PersonalWorkspace>(`/personal/workspaces/${encodeURIComponent(workspaceId)}`)
