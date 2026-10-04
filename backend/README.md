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
- Each Skill includes its pinned definition (`skillId`, `title`, `learningOutcome`, `xpThreshold`, `learningPathVersionId`), independent booleans `mastery` and `access`, `unmetPrerequisiteSkillIds`, and nonnegative `xpShortfall`. `enrollmentStatus: "inactive"` disables all Access even when no rule shortfall remains.
- XP sums one configured reward per Task with any valid owning-Coach Approval in this Enrollment. Mastery requires a nonempty set of Required Tasks, all approved; Enrichment does not block it. Access uses ALL prerequisite Mastery and Enrollment-local XP without spending XP. Matching logical IDs in other Versions never transfer progress.
- Only learner and owning Coach may read state, including inactive history. Foreign/unknown Enrollments return 404 `enrollment_not_found`; anonymous requests return 401.

### Persistence, concurrency, and limits

Review and send transactions lock **Enrollment FOR UPDATE before Submission**, retaining locks until commit. Learning-state and submitted-history reads use the same Enrollment lock, so their multiple queries cannot mix evidence across concurrent sends/reviews. Future revocation/lifecycle/evidence mutators must retain this contract. Published definitions and ownership are assumed stable; there are no content-edit or ownership-transfer APIs here.

T09 derives current XP/Mastery from durable revision decisions; it does not add a separate materialized award-event ledger or Mastery award/revocation timeline. T10 owns revocation, XP correction and associated audit/history behavior. Overrides and Enrollment lifecycle APIs remain T11/T12; personal XP persistence and authentication-provider integration are not implemented. There is no generic review overwrite or revocation endpoint.

`bun test test/review.test.ts` exercises the two-Skill 20-XP reference flow, privacy/authority, feedback/history, stale and repeated decisions, Required/Enrichment/nonempty Mastery, Enrollment/Version isolation, ALL and independent XP gates, prior work after Access loss, competing decisions, both send/review orders, coherent reads, and rollback/commit persistence against PostgreSQL. Concurrency tests pause actual request INSERTs with test-only triggers and observe `pg_blocking_pids` before releasing their barrier; these triggers/functions are removed in `finally`. Loss of Access/deactivation is test-only database fault injection, not evidence of a lifecycle API. The rollback test intentionally produces a logged storage exception and asserts HTTP 500 with no committed decision/progress.
