import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import type { Database } from './db/client'
import { accounts, authCredentials, authSessions, authVerifications } from './db/schema'
import type { IdentityResolver } from './identity'

/**
 * Delivers an email-verification link. Production delivery is not integrated yet
 * (ADR 0022): the served backend logs links, and tests capture them.
 */
export type VerificationMailer = (message: { to: string; url: string }) => Promise<void>

export interface AuthConfig {
  db: Database
  /** Public origin the browser signs in from; Better Auth serves under `/api/auth` there. */
  baseURL: string
  /** Signs session cookies; at least 32 random characters in production. */
  secret: string
  sendVerificationEmail: VerificationMailer
}

/**
 * Email/password sign-in with Better Auth (ADR 0022). Its user model is the domain
 * Account, so a session identifies an Account directly, and `emailVerified` is
 * set only by redeeming a verification link sent to that address.
 */
export function createAuth({ db, baseURL, secret, sendVerificationEmail }: AuthConfig) {
  return betterAuth({
    appName: 'Gurow',
    baseURL,
    basePath: '/api/auth',
    secret,
    trustedOrigins: [new URL(baseURL).origin],
    database: drizzleAdapter(db, { provider: 'pg', schema: { accounts, authSessions, authCredentials, authVerifications } }),
    user: { modelName: 'accounts' },
    session: { modelName: 'authSessions' },
    account: { modelName: 'authCredentials' },
    verification: { modelName: 'authVerifications' },
    advanced: { database: { generateId: 'uuid' } },
    emailAndPassword: { enabled: true },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: ({ user, url }) => sendVerificationEmail({ to: user.email, url }),
    },
  })
}

export type Auth = ReturnType<typeof createAuth>

/** The production identity: the Account of a valid Better Auth session cookie, never a client-named Actor. */
export function sessionIdentity(auth: Auth): IdentityResolver {
  return async (c) => (await auth.api.getSession({ headers: c.req.raw.headers }))?.user.id ?? null
}
