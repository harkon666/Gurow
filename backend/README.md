# Gurow backend

Bun + Hono learning-domain service backed by PostgreSQL through Drizzle ([ADR 0021](../docs/adr/0021-persist-the-backend-with-drizzle-over-bun-sql.md)).

## Setup

```sh
docker compose up -d --wait   # from the repo root: PostgreSQL 18 on 127.0.0.1:5433
cp .env.example .env          # DATABASE_URL and TEST_DATABASE_URL
bun install
bun run db:migrate            # apply drizzle/ migrations to DATABASE_URL
```

## Commands

| Command | Purpose |
| --- | --- |
| `bun run dev` | Serve on http://localhost:3000 |
| `bun test` | Request-level integration tests; creates, migrates and empties `gurow_test` |
| `bun run typecheck` | TypeScript check |
| `bun run db:generate` | Generate a SQL migration from `src/db/schema.ts` changes; review and commit it |
| `bun run db:migrate` | Apply committed migrations |

## Identity

Learning routes act for the Account returned by the injected `IdentityResolver`. Production has no sign-in yet, so `src/index.ts` uses `noTrustedIdentity` and those routes answer 401. Integration tests use `fixtureIdentity`, which maps the `x-gurow-fixture-identity` header to fixture Accounts; it is never wired into the production entry point.

## Review and learning-state interface (T09)

All IDs are UUIDs and all routes require trusted identity. The actor is never taken from the JSON body.

### Decide an exact Revision

`POST /enrollments/:enrollmentId/tasks/:taskId/submission/revisions/:revisionId/review`

```json
{ "decision": "changes_requested", "feedback": "Explain your calculation." }
```

- Decision is `approval` or `changes_requested`. Feedback is optional/null for Approval and mandatory, non-whitespace text for Changes Requested. Maximum feedback length is 50,000 characters. Valid feedback is stored verbatim.
- Only the owning Coach can decide. The learner receives 403 `coach_only`; foreign actors/Enrollments receive 404 `enrollment_not_found`. Unknown/mismatched revisions receive 404 `revision_not_found`; Tasks outside the pinned Version receive 404 `task_not_found`.
- Invalid bodies return 422 `invalid_review`. Anonymous requests return 401 `unauthenticated`.
- Superseded pending targets return 409 `revision_superseded`. Any already-decided target, including an identical retry, returns 409 `revision_already_reviewed`; decisions are not overwritten.
- Success is **201 after transaction commit**, with `{ "review": { "revisionId", "coachAccountId", "decision", "feedback", "decidedAt", "revokedAt": null, "revocationReason": null } }` (keys shown schematically).
- Review does not require current Access or active Enrollment: prior eligible, unsuperseded work remains reviewable. New revisions neither inherit nor revoke an earlier Approval.

`GET /enrollments/:enrollmentId/tasks/:taskId/submission` retains the existing `{ submission }` payload: ordered `revisions` include their immutable evidence, `status` and, when decided, the complete `review` record. Both learner and owning Coach may read it, even after deactivation; unsent drafts are excluded.

### Read current learning state

`GET /enrollments/:enrollmentId/learning-state`

Returns 200 `{ "learningState": { "enrollmentId", "learningPathVersionId", "enrollmentStatus", "xp", "tasks": [], "skills": [] } }` (keys shown schematically).

- Each Task includes its pinned definition (`taskId`, `skillId`, `title`, `required`, `xpReward`, `learningPathVersionId`), `approved`, and `xpContribution`.
- Each Skill includes its pinned definition (`skillId`, `title`, `learningOutcome`, `xpThreshold`, `learningPathVersionId`), independent booleans `mastery` and `access`, `accessOverride` (active grant record or null), `unmetPrerequisiteSkillIds`, and nonnegative `xpShortfall`. `enrollmentStatus: "inactive"` disables all Access even when no rule shortfall remains.
- XP sums one configured reward per Task with any valid owning-Coach Approval in this Enrollment. Mastery requires a nonempty set of Required Tasks, all approved; Enrichment does not block it. Access uses ALL prerequisite Mastery and Enrollment-local XP without spending XP. Matching logical IDs in other Versions never transfer progress.
- Only learner and owning Coach may read state, including inactive history. Foreign/unknown Enrollments return 404 `enrollment_not_found`; anonymous requests return 401.

### Persistence, concurrency, and limits

Review and send transactions lock **Enrollment FOR UPDATE before Submission**, retaining locks until commit. Learning-state and submitted-history reads use the same Enrollment lock, so their multiple queries cannot mix evidence across concurrent sends/reviews. Future revocation/lifecycle/evidence mutators must retain this contract. Published definitions and ownership are assumed stable; there are no content-edit or ownership-transfer APIs here.

Current XP/Mastery remain derived from durable revision decisions. T10 additionally records XP Award/Correction and Mastery award/revocation transitions in the same transaction as each Review mutation. T11 persists scoped Access Overrides; Enrollment lifecycle APIs remain T12. Personal XP persistence and authentication-provider integration are not implemented. There is no generic Review overwrite endpoint.

### Grant or withdraw one scoped Access Override (T11)

`POST /enrollments/:enrollmentId/skills/:skillId/access-overrides`

```json
{ "reason": "Prior experience supports direct practice." }
```

- Only the owning Coach may grant or revoke. Reason is mandatory non-whitespace text, at most **500 characters**, stored verbatim. Other JSON fields cannot select the actor, learner, action, target or time.
- Success is **201 after commit**, returning `{ "overrideRecord": ... }`. The record has `id`, monotonic `sequence`, `action: "grant"`, `coachAccountId`, `learnerAccountId`, `enrollmentId`, pinned `learningPathVersionId`, `skillId`, database-generated `occurredAt`, `reason`, and `grantRecordId: null`.
- The exception waives both prerequisites and XP only for this Skill/Enrollment. It does not change XP, Mastery, ordinary diagnostics or any other Enrollment. An inactive Enrollment remains inaccessible. Coaches may manage exceptions while inactive without reactivating participation.

`POST /enrollments/:enrollmentId/skills/:skillId/access-overrides/:grantRecordId/revoke`

```json
{ "reason": "Return to the ordinary progression route." }
```

- Revocation names the **exact active grant ID**, with the same reason rules. Success is **200 after commit**, returning a new `overrideRecord` with `action: "revoke"` and `grantRecordId` identifying the withdrawn grant. The original grant is not changed.
- Ordinary current Access is restored, not blindly locked: met requirements still permit work. Existing work, private drafts, XP, Mastery and their histories remain unchanged. Eligible unsuperseded pending revisions remain reviewable; new sends use current Access.
- Invalid reasons return 422 `invalid_override_reason`. Anonymous requests return 401; learners receive 403 `coach_only`; foreign/unknown Enrollments return 404 `enrollment_not_found`. Skills outside the pinned Version return 404 `skill_not_found`; malformed IDs or unknown/context-mismatched/non-grant revocation targets return 404 `override_not_found`.
- Repeated grants return 409 `override_already_active`. Revoking an already withdrawn or superseded grant returns 409 `override_not_active`. Regrant creates a new ID, so retrying an old revoke cannot withdraw it. Rejected operations append no records.
- Learning-state includes ordered `overrideHistory` plus each Skill's active `accessOverride` (grant record or null). Ordinary `xpShortfall` and `unmetPrerequisiteSkillIds` remain visible even while waived. These records are visible only to the learner and owning Coach; drafts are never included.
- `override_records` is the single authority for exception state and audit. Migration `0005` adds pinned Enrollment/Version/Skill constraints and an update/delete-rejecting immutability trigger. Grants/revokes, sends, reviews and coherent reads share Enrollment `FOR UPDATE` through commit; failed record storage leaves no exception or audit effect. Sequence orders records; `clock_timestamp()` records action time after the lock is obtained. Published content and Workspace ownership are assumed stable, as for the existing learning routes.

`bun test test/override.test.ts` covers both unmet gates together, complete automatic audit, grant/revoke/regrant and stale retries, concurrent exact operations, scoped authority/privacy, retained work and achievements, ordinary-rule restoration, inactive gating, fresh-connection persistence, immutable records, late rollback, and PostgreSQL-observed grant/send, revoke/send (both orders), and revoke/read serialization. Inactivity is direct test-only fault injection; lifecycle request proof remains T12. Intentional rollback tests log storage exceptions.

### Revoke one Approval (T10)

`POST /enrollments/:enrollmentId/tasks/:taskId/submission/revisions/:revisionId/review/revoke`

```json
{ "reason": "The assessed calculation used incorrect evidence." }
```

- Only the owning Coach may revoke. Reason is mandatory, non-whitespace text, at most 50,000 characters, stored verbatim. Identity is never read from the body.
- Success is 200 **after commit**, returning `{ "review": ... }`. Original decision, feedback, decision time and revision contents remain unchanged; `revokedAt`, `revocationReason` and `revokedByAccountId` identify the withdrawal.
- Invalid reasons return 422 `invalid_revocation`; malformed/unknown/context-mismatched IDs and non-Approvals return 404 `approval_not_found` (Enrollment/Task context refusals remain unchanged). Learners receive 403 `coach_only`, foreign actors 404, anonymous requests 401. Repeats return 409 `approval_already_revoked` and write nothing.
- Current Access and Enrollment activity do not gate correction. Each still-valid Approval counts; revoking the last supporting Approval removes the Task contribution once. Later Approval restores it once. Zero-reward Tasks generate no fictional XP event but still change Mastery when required.
- Learning-state responses now include ordered `xpHistory` and `masteryHistory` arrays for the same learner/owning-Coach visibility boundary. Events identify Enrollment, pinned Version, Task or Skill, causal Review revision, actor and time. XP events have `kind: "award" | "correction"` and signed `amount`; Mastery events have `action: "award" | "revocation"`. These are transition histories, not a second authority for current progress.
- Independent dependent Mastery, previously eligible pending revisions and private drafts survive relocking. New submissions remain blocked under current Access.
- Migration `0004` replays recorded decision/revocation timestamps for pre-T10 evidence, preserving historical awards even when their supporting Approval is now revoked. Unknown historical revocation actors remain null. Equal timestamps are evaluated as one snapshot because their original order is unknowable. Each changed Task's XP event still links its own causally contributing Review; Mastery events select changed Required evidence within the affected Skill, never Enrichment or redundant Approvals. Equivalent relevant causes use deterministic revision-ID order. It does not fabricate migration-time awards. No zero-XP events are backfilled.
- Direct database fault injection can change derived progress without updating audit histories; it is not a supported mutation interface. All supported Review/revocation requests hold the shared Enrollment lock through transition recording and commit. A late audit storage failure rolls back the Review change and all earlier transition inserts.

`bun test test/revocation.test.ts` covers the T10 request seam, including multiple Approvals, last removal/restoration, Mastery history, dependent Access and retained work, privacy/authority, invalid/repeated/competing requests, Enrollment/Version isolation, zero-XP and Enrichment evidence, historical backfill, late transaction rollback, and fresh-connection readback. Intentional rollback tests log a storage exception.

`bun test test/review.test.ts` exercises the two-Skill 20-XP reference flow, privacy/authority, feedback/history, stale and repeated decisions, Required/Enrichment/nonempty Mastery, Enrollment/Version isolation, ALL and independent XP gates, prior work after Access loss, competing decisions, both send/review orders, coherent reads, and rollback/commit persistence against PostgreSQL. Concurrency tests pause actual request INSERTs with test-only triggers and observe `pg_blocking_pids` before releasing their barrier; these triggers/functions are removed in `finally`. Loss of Access/deactivation is test-only database fault injection, not evidence of a lifecycle API. The rollback test intentionally produces a logged storage exception and asserts HTTP 500 with no committed decision/progress.
