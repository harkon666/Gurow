import type { Context } from 'hono'

/**
 * Derives the acting Account from a trusted request identity (SPEC decision 20).
 * Returns null when the request carries no identity this resolver trusts.
 */
export type IdentityResolver = (c: Context) => string | null | Promise<string | null>

/** Production has no sign-in yet (a later slice), so it trusts no request identity. */
export const noTrustedIdentity: IdentityResolver = () => null

/** Header read only by the test fixture resolver; production never trusts it. */
export const FIXTURE_IDENTITY_HEADER = 'x-gurow-fixture-identity'

/**
 * Controlled P2 fixture identity: a fixture name in {@link FIXTURE_IDENTITY_HEADER}
 * maps to an Account. Integration tests pass it to `createApp`; the production
 * entry point does not, so this is not production authentication.
 */
export function fixtureIdentity(accountsByFixtureName: Record<string, string>): IdentityResolver {
  return (c) => accountsByFixtureName[c.req.header(FIXTURE_IDENTITY_HEADER) ?? ''] ?? null
}
