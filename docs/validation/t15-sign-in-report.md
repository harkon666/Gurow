# T15 sign-in and Personal Workspace: local evidence

Ticket [#16](https://github.com/harkon666/Gurow/issues/16) (T15). Recorded on 2026-10-05 from the harness full check of branch `feat/t15-sign-in-personal-workspace`, based on `2ad0771`, with the T15 changes in the working tree. Counts come from `.harness/runs/20261004T191258941351Z/`; that evidence stays local. This report was written after that run, so the final full check covers it.

The integration is Better Auth email/password sessions ([ADR 0022](../adr/0022-sign-in-with-better-auth-email-and-password.md)). Everything below is **local evidence**: real Hono requests, a real browser and real PostgreSQL on one machine. It does **not** verify a production integration (see [What is not verified](#what-is-not-verified)).

## Environment

| Item | Value |
|---|---|
| Database | PostgreSQL 18.6 (Debian 18.6-1.pgdg13+2), `postgres:18` from `compose.yaml` on 127.0.0.1:5433 |
| Backend tests | `gurow_test`, migrated (`backend/drizzle` 0000–0009) and truncated before each test |
| Browser check database | `gurow_browser_test`, migrated and emptied by `backend/test/support/prepare-browser-database.ts` before the run |
| Runtime | Bun 1.4.2, Hono, Drizzle over `bun:sql`, better-auth 1.7.7 |
| Browser | Headless Chromium 152.0.7977.82 via puppeteer-core 25.10.0 |
| Served backend | `backend/src/index.ts` (the production entry point) with `BETTER_AUTH_URL=http://127.0.0.1:3481`, a test-only secret, `NODE_ENV=test` |
| Served frontend | Nitro production build `.output/server/index.mjs`, `/api/*` forwarded to the backend through `GUROW_API_ORIGIN` |

## Provider and configuration prerequisites

| Setting | Local check | Production requirement |
|---|---|---|
| `BETTER_AUTH_SECRET` | Fixed test value | At least 32 random characters, kept secret; the backend refuses to start with less |
| `BETTER_AUTH_URL` | Frontend origin `http://127.0.0.1:3481` | The public HTTPS origin; the frontend and `/api` must share it (cookies are first-party) |
| `GUROW_API_ORIGIN` | `http://127.0.0.1:3482` | Internal backend address reachable from the frontend server |
| `DATABASE_URL` | `gurow_browser_test` | Production database with migration `0009_sign_in` applied |
| Email delivery | Verification links are logged and read from the backend log | An email provider behind `VerificationMailer`; **not integrated** |
| HTTPS | Not used (http on 127.0.0.1) | Required so the session cookie is marked secure |

## Commands and outcomes

| Command | Coverage | Result |
|---|---|---|
| `bun test test/sign-in.test.ts` (backend) | AC1–AC5 at the served `/api` boundary | 8 pass, 0 fail, 79 assertions |
| `bun test` (backend) | All backend suites, including the T07 production-resolver test now run against `createServer` | 141 pass, 0 fail, 2,154 assertions |
| `bun run typecheck` (backend, frontend) | Types | pass |
| `bun run scripts/t15-sign-in-check.ts` (frontend) | Browser flow below, on a fresh build | 8 of 8 steps passed |
| `bun test` (frontend) | Existing frontend unit tests | 249 pass, 0 fail |
| t04, t05, editor-lifecycle, t06-functional, t44 label-scroll | P1 regressions after moving the local-fixture editor from `/` to `/editor` | all passed |

Browser steps (one browser context unless noted):

1. **Entry requires sign-in**: `/` shows the sign-in form; a wrong credential shows an error and stays on `/`.
2. **Sign-up enters a Personal Workspace**: the page names the context "Personal Workspace" (`data-context="personal"`), the Account email and "Email not verified"; the header names no Coach/Learner type.
3. **Reload and re-entry**: reload and a second visit to `/` keep the same Workspace ID.
4. **Verified-email state**: a client `update-user` claim of `emailVerified` answers 400 and changes nothing; following the logged link shows "Email verified".
5. **Sign-out**: the Workspace URL returns to sign-in; the API answers 401, also with the P2 fixture header.
6. **Rejection of another Account**: after signing up as a second Account in the same browser, the first Account's Workspace URL shows "Personal Workspace not available" without the owner's email, and a direct API read answers 404.
7. **Switch back**: the first Account signs in again to its own, still verified Workspace.
8. **Switch in another tab** (two tabs sharing the session, the first never reloaded): when the second tab signs out and signs in as the other Account, the background first tab drops the Workspace (it shows sign-in). After a switch made outside the UI, which sends no cross-tab signal, the first tab shows the other Account's refusal as soon as it is resumed.

The backend suite adds what the browser does not reach: 16 racing first entries from four sessions produce one 201, fifteen 200s and one stored Workspace; forged and signed-out session cookies are refused; the other Account's Task completion and reward writes return 404 and leave the owner's state unchanged; an invitation is refused with `email_not_verified` until the emailed link verifies the address, then accepted; signing up with an existing verified address is refused without creating an Account.

Three full runs failed and were not counted:

- `20261004T184516475734Z`: t06-functional timed out after 10 s waiting for the first new Skill label (`frontend/scripts/t06-functional-check.ts:175`), the same intermittent failure recorded in T11, T12 and T14. Nothing was changed; three standalone reruns and the next full run passed it. Its cause is still not confirmed.
- `20261004T191549446943Z` (after the review fix and the report sync): the same t06-functional timeout at line 175 again, with no source change since the passing run `20261004T191258941351Z`; the next unchanged full run is the final one.
- `20261004T184740181815Z`: the AC3 backend test expected the two fixture Paths in insertion order, but both share one creation time and the tie is broken by random UUID. The assertion now compares membership only; five consecutive reruns of `test/sign-in.test.ts` passed.

The edited `scripts/benchmark/fixture-check.ts` (now opening `/editor`) ran once outside the T15 checks with contract `protocol-v5.json`: exit 0, AC3–AC6 PASS.

Step 8 answers an independent review finding (P1, AC3): an open tab kept showing the previous Account's Workspace after another tab switched Accounts. It failed first against the unfixed page ("the first tab still shows Ada's Workspace"). With the fix, disabling only the cross-tab signal failed the background-tab part, and disabling only resume revalidation failed the resumed-tab part; with both, the step passes.

A red run preceded the race fix: with select-then-insert instead of `ON CONFLICT DO NOTHING`, the race test failed (1 pass, 1 fail in the AC2 group); with the committed code it passes.

## What is not verified

- **Email delivery**: no provider is integrated; links are only logged. Whether real mail arrives, and its deliverability, is untested.
- **Deployed origin**: no HTTPS, reverse proxy, secure cookies or production secret handling were exercised.
- **Better Auth defaults in production**: rate limiting and other `NODE_ENV=production` behavior were not exercised.
- **Account lifecycle policies** (outside T15): password reset, email change, Account deletion, social sign-in, and claiming an address that someone else signed up with but never verified.
- **Editor data**: `/editor` is still the P1 local-fixture editor with a fixed local storage owner; Workspace-owned Paths in the editor arrive with T16, and cross-Account local recovery with T28.
