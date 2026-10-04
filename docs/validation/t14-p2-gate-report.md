# P2 gate: PASS

Ticket [#15](https://github.com/harkon666/Gurow/issues/15) (T14). Recorded on 2026-10-05 from the harness full check of branch `feat/t14-p2-concurrency-gate`, based on `07f98d4`, with the T14 changes in the working tree. Counts come from `.harness/runs/20261004T182126815369Z/`, the full check run after the review fixes; that evidence stays local. This report was written after that run, so the final full check covers it.

These are request-level results from real Hono requests against a migrated PostgreSQL database. Calculation-only tests, mock persistence and unexecuted checks are not counted.

## Environment

| Item | Value |
|---|---|
| Database | PostgreSQL 18.6 (Debian 18.6-1.pgdg13+2), `postgres:18` from `compose.yaml` on 127.0.0.1:5433 |
| Test database | `gurow_test`, created and migrated (`backend/drizzle` 0000–0008) by `test/support/database.ts`, then truncated before each test |
| Isolation / time zone | `read committed` (default) / `Etc/UTC` |
| Runtime | Bun 1.4.2, Hono, Drizzle over `bun:sql` (ADR 0021) |
| Identity | Test-only `fixtureIdentity` header resolver; not production authentication |

## Fixtures

- `seedEnrollmentFixture`: owning Coach, learner (mixed-case verified email), peer, unrelated Account, another Workspace's Coach and an unverified Account. Version 1 of the Coach's Path holds Skill A (Required and Enrichment Tasks) and Skill B (Required Task); Version 2 redefines them. It also seeds a closed sibling Version and invitations to exactly one Version each.
- P2 reference Path (SPEC testing decision 8, set in `p2-gate.test.ts`): A's Required Task is worth 20 XP. B needs Mastery of A and 20 Enrollment XP, and B's Task is worth 5 XP.
- `seedPersonalFixture`: the learner's Personal Workspace with a main Path (A: 20- and 10-XP Tasks; B behind A and a 20-XP Threshold) and a second Path with 100 XP, plus a peer-owned Path.

## Commands and outcomes

All commands run from `backend/` after `docker compose up -d --wait`.

| Command | Coverage | Result |
|---|---|---|
| `bun test test/p2-gate.test.ts` | T14 cross-boundary races and gate flow | 9 pass, 0 fail, 403 assertions |
| `bun test test/review.test.ts` | T09 reference flow, stale/duplicate decisions, observed send/review orders | 17 pass, 0 fail, 197 assertions |
| `bun test test/revocation.test.ts` | T10 revocation, restoration, history, competing revocations | 17 pass, 0 fail, 249 assertions |
| `bun test test/override.test.ts` | T11 scoped overrides, competing grant/revoke, observed send orders | 14 pass, 0 fail, 208 assertions |
| `bun test test/lifecycle.test.ts` | T12 deactivation/reactivation, observed send/start orders | 20 pass, 0 fail, 289 assertions |
| `bun test test/personal.test.ts` | T13 personal rewards, 20→50 correction, archival | 9 pass, 0 fail, 459 assertions |
| `bun test test/enrollment.test.ts` | T07 invitations, 24 competing acceptances | 14 pass, 0 fail, 64 assertions |
| `bun test test/submission.test.ts` | T08 drafts, immutable revisions, competing sends | 33 pass, 0 fail, 205 assertions |
| `bun test` | Whole backend (8 files) | 133 pass, 0 fail, 2,071 assertions |
| `bun run typecheck` | Backend types | pass |

`python3 scripts/harness.py check` (full profile plus the T14 ticket checks) also passed the frontend, Rust, build and browser regression checks. Those checks are not P2 evidence.

### Failed runs

Before this report was written, seven full checks had run on this ticket, one of them during independent review. Two failed, both only on the frontend P1 regression `t06-functional` (`bun run scripts/t06-functional-check.ts`):

| Run | Failed check | Failure |
|---|---|---|
| `20261004T175222860868Z` | `t06-functional` | Create/select step timed out after 10 s waiting for the new Skill label (`frontend/scripts/t06-functional-check.ts:175`) |
| `20261004T175352024882Z` | `t06-functional` | Same step and timeout |

All backend and P2 checks in those runs passed. T14 changes no frontend file, and the same intermittent failure is recorded for T11 and T12. A standalone run of the script then passed all 8 steps, and every later unchanged full check passed. No source, assertion or timeout was changed for it, and its cause is not confirmed. It is not a P2 domain failure.

## Gate criteria

| Criterion | Evidence in `p2-gate.test.ts` | Outcome |
|---|---|---|
| Competing acceptance keeps one Enrollment; competing sends keep one Submission with immutable, coherently ordered revisions | 16 concurrent acceptances; 8 acceptances racing self-deactivation; 12+4 concurrent sends across two Tasks | PASS |
| A Review made stale by a newer revision is rejected without effects; the accepted order holds when the Review wins first | Forced send-first and Review-first orders (held row lock, observed `pg_blocking_pids`); five unforced rounds | PASS after repair |
| Repeated or competing Approvals and revocations give single contributions and correction history; rejected writes leave no partial progress | Racing approvals and revocations; triple final revocation; late `mastery_events` failure then retry | PASS |
| Races with deactivation or override changes enforce Access at the authoritative operation and keep earlier eligible work | Sends racing deactivation; grant, revocation and regrant+deactivation racing sends; eligible pending approvals afterwards | PASS |
| Reference flow, privacy/authority matrix, lifecycle and personal 20→50 pass against real persistence | One end-to-end request flow, plus the T07–T13 suites above | PASS |

Each of the nine gate tests runs an SQL coherence check (`expectCoherentHistory`) at full timestamp precision after its last write to Enrollment history. The personal part of the AC5 flow is checked by its own assertions instead. It requires contiguous revision numbers, and that supersession equals the successor's `sentAt`. Superseded work may have no Review, and no successor may be sent while a reviewed revision was pending. XP and Mastery events must sit at their causal decision or revocation time, each Task has one Submission, and no revision may be sent while the Enrollment was inactive. Each Task's contribution must move only between zero and its reward and explain current XP.

## Repaired integration race

Before T14, `sentAt` and `supersededAt` used `now()`, which is the transaction start time and can precede a lock wait. `decidedAt` and `revokedAt` used the application clock. As a result, recorded order could contradict the accepted lock order: a send that queued behind a winning Review was stamped before that decision, and concurrent sends gave higher revision numbers earlier `sentAt` values.

`backend/src/db/clock.ts` now reads one `clock_timestamp()` after a transition's locks and reuses it for every record of that transition (send, Review, revocation, XP/Mastery events and personal actions). Existing timestamps are kept in SQL rather than read into JavaScript and written back, because JavaScript would truncate them to milliseconds. For example, personal completion keeps the first `startedAt` through `coalesce` (`personal.test.ts` compares the stored PostgreSQL text before and after).

Red evidence before the repair:

- First gate test alone: 0 pass, 1 fail (`a successor was sent while the reviewed revision was pending`).
- Full gate file with the `src/` changes reverted: 4 pass, 5 fail. The failures were the forced Review-first order, plain concurrent sends (`a later revision was sent earlier`), the unordered storm and both AC4 race tests.
- With the repair reapplied, the gate file passed 9/9 in five consecutive runs.

## Limits

- Unforced storms vary their interleaving between runs; they assert order-independent invariants rather than one fixed order. Specific orders are forced only where named.
- Fixture identity replaces production authentication and email delivery, and fixtures seed content in place of authoring routes. Each is a later slice (SPEC decision 29).
- Rows changed directly in the database outside the request interface can bypass audit histories; that is not a supported mutation path.
- This gate covers the P2 learning-domain backend only. It does not establish P1 editor performance or later product slices.
