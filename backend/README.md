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

Current XP/Mastery remain derived from durable revision decisions. T10 additionally records XP Award/Correction and Mastery award/revocation transitions in the same transaction as each Review mutation. T11 persists scoped Access Overrides; T12 adds explicit Enrollment lifecycle and durable Task starts. Personal XP persistence and authentication-provider integration are not implemented. There is no generic Review overwrite endpoint.

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

### Deactivate or reactivate participation (T12)

`POST /enrollments/:enrollmentId/deactivate`

```json
{ "reason": "Participation paused until next term." }
```

- The owning Coach must supply a non-whitespace reason of at most **500 characters**, stored verbatim. The learner may self-deactivate with no body, `{}`, or a null/omitted reason; an optional supplied reason follows the same text rules. JSON null, arrays, malformed JSON and invalid reasons return 422 `invalid_lifecycle_reason`.
- Only the learner concerned and owning Coach may deactivate. Anonymous requests return 401; foreign/unknown/malformed Enrollment targets return 404 `enrollment_not_found`. Neither body fields nor invitations select the actor or change authority.
- Success is **200 after commit**, returning `{ "enrollment": ..., "lifecycleRecord": ... }`. The record contains `id`, monotonic `sequence`, `enrollmentId`, pinned `learningPathVersionId`, `actorAccountId`, `learnerAccountId`, `action: "deactivate"`, `reason` (nullable for self-deactivation), and database-generated `occurredAt`.
- Inactivity blocks Task starts and all new Submissions/revisions, even with an active Skill Access Override. Invitations reuse the inactive Enrollment unchanged, including when its Version is closed to new Enrollments; closed Versions still reject new Enrollments.
- Deactivation changes no Approval, XP, Mastery, sent work, draft, override or progression history. Eligible unsuperseded work sent while active and with valid Access remains reviewable; inactive Approvals can award XP/Mastery without reactivation or reward duplication. Changes Requested remains available, but sending corrections requires active participation and current Access.
- Learner and owning Coach retain submitted/history access. Draft contents remain learner-only. Existing private work remains editable while inactive; a first draft for a Task with no prior draft, Submission or explicit start is rejected with 403 `enrollment_inactive`, so draft creation cannot begin new inactive activity.

`POST /enrollments/:enrollmentId/reactivate`

```json
{ "reason": "The learner is ready to resume." }
```

- Only the owning Coach may explicitly reactivate, even after learner self-deactivation. Reason is mandatory and follows the same 500-character rules. A learner with a valid reason receives 403 `coach_only`; foreign actors receive 404. The same Enrollment, Version, progress, work and overrides are retained.
- Success is **200 after commit** with the same response shape and a new `action: "reactivate"` audit record. Current ordinary gates and active scoped overrides are evaluated—not a blanket restoration of every Skill's Access.
- Repeating an already-applied status returns 409 `enrollment_already_inactive` or `enrollment_already_active`, without another record. Competing same transitions produce one success and one conflict. Ordered `lifecycleHistory` is exposed only in the learner/owning-Coach learning-state response.
- Migration `0006` creates pinned lifecycle audit records and an update/delete-rejecting trigger. The status update and audit append share Enrollment `FOR UPDATE` through commit; a late audit error rolls back both. Sequence orders records, while `clock_timestamp()` captures action time after acquiring the lock. Preexisting inactive rows have no fabricated lifecycle history.

### Explicit durable Task start (T12)

`POST /enrollments/:enrollmentId/tasks/:taskId/start`

- This is a state-changing operation, not a read or permission probe. Only the learner may start a Task defined in the Enrollment's pinned Version, with active participation and current Skill Access (ordinary rules or active scoped override).
- First success is **201 after commit** `{ "taskStart": { "enrollmentId", "learningPathVersionId", "taskId", "startedAt" }, "created": true }`. A permitted retry returns 200, the same record/time, and `created: false`. Current gates are checked even on retries; inactive requests return 403 `enrollment_inactive`, locked Skills 403 `skill_locked`, owning Coach 403 `learner_only`, foreign Enrollment actors 404, and out-of-Version Tasks 404 `task_not_found`.
- Migration `0007` stores at most one explicit start per Task/Enrollment with pinned-Version constraints. Starts and draft writes share the Enrollment lock with lifecycle, sends, reviews and overrides. Reads do not start Tasks. Existing draft/save/send clients need not call start first; existing work is preserved without inventing historical start times. Draft preparation remains separate from the explicit start marker and does not create one.
- Learning-state includes `taskStarts`, ordered by Task UUID and visible only to learner/owning Coach. Starts never grant XP or Mastery. No product UI or production authentication integration is added.

`bun test test/lifecycle.test.ts` exercises actual lifecycle/start Hono requests against PostgreSQL: all actors, input/target/context spoofing, immutable automatic audit, self-deactivation, invitations/admission and override interactions, pending Approval and Changes Requested, reward nonduplication, nonzero progress/work/privacy through resumption, current unmet/met gates, fresh-connection persistence, late audit rollback, competing transitions/starts, and PostgreSQL-observed lifecycle/send/start/read ordering. Test-only barrier triggers are removed in `finally`; intentional rollback errors are logged. Existing suites retain their earlier direct-database fault-injection cases as regressions, not substitutes for this request proof.

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

## Personal learning interface (T13)

Personal-mode Learning Paths share the `learning_paths`, `skills` and `tasks` identity tables with coach mode; a Path belongs to exactly one Coach Workspace or one Personal Workspace (`learning_paths_one_workspace`). Personal definitions are unversioned (`personal_skills`, `personal_tasks`, `personal_prerequisites`) and composite keys require their Path to be personal. No authoring route exists yet (T16); P2 tests seed Paths through `seedPersonalFixture`.

All routes require trusted identity and act only for the Personal Workspace owner. Any other Account, including the owner's Coach, and any unknown, malformed or coach-mode Path ID receives 404 `learning_path_not_found` (ADR 0012); anonymous requests receive 401. Inside an owned Path, unknown or foreign targets return 404 `task_not_found` / `skill_not_found`. No route takes a reason, evidence or Review, and the actor is never read from a body.

| Route | Effect |
| --- | --- |
| `GET /personal/learning-paths/:pathId/learning-state` | Current Path state and its histories |
| `PUT` / `DELETE …/tasks/:taskId/completion` | Mark complete (needs current Access) / undo (allowed while locked) |
| `PUT …/tasks/:taskId/reward` `{ "xpReward": 50 }` | Integer 0–1,000,000, otherwise 422 `invalid_reward` |
| `POST …/tasks/:taskId/start` | Records the first start (needs current Access) |
| `POST …/tasks/:taskId/archive` | One-way archival; no restoration policy is defined |
| `PUT` / `DELETE …/skills/:skillId/mastery` | Declare / withdraw Mastery freely |
| `PUT` / `DELETE …/skills/:skillId/access-override` | Grant / revoke a personal Access Override |

- Mutations answer 200 `{ "changed", "learningState" }` after commit. A repeat (already complete, same reward, already declared/granted, …) answers `changed: false` and records nothing. Completion or start on a locked Skill returns 403 `skill_locked`; any change to an archived Task returns 409 `task_archived`.
- `learningState` holds `xp`, `tasks` (definition, `startedAt`, `completed`, `completedAt`, `archivedAt`, `xpContribution`), `skills` (definition, `mastery`, `masteryDeclaredAt`, `access`, `accessOverride`, `unmetPrerequisiteSkillIds`, `xpShortfall`), and the ordered `xpHistory`, `masteryHistory` and `overrideHistory`.
- XP is the sum of current rewards of completed Tasks in this Path only, archived ones included; other personal Paths and Enrollments never count (ADR 0009). A Skill has Access when its latest override is a grant, or when every Prerequisite Skill has declared Mastery and Path XP meets its threshold. Lower XP relocks already started work; the start record stays.
- Each nonzero change in a Task's contribution appends an XP event with signed `amount`, `cause` (`completion`, `completion_undone`, `reward_change`) and `kind` (`award` for the Task's first completion event, otherwise `correction`). For a completed Task, a 20→50 edit records +30, undo −50 and completion again +50. Incomplete or zero-reward changes record nothing. Completion, rewards and archival never change Mastery; Mastery and overrides never change XP.
- Every request holds the Path row lock through commit, so checks, changes, history and reads are one state. XP, Mastery and override histories reject UPDATE/DELETE in SQL. A late history failure rolls back the whole action.

`bun test test/personal.test.ts` covers owner-only authority against the learner's Coach, peers and other Accounts; free Mastery; idempotent sequential and concurrent completion/undo; the 20→50 correction scenario; Path-local thresholds, relocking and the reasonless override; archival retention; separation from Enrollments in both directions; fresh-connection readback; immutable history; late rollback of each history kind; and a PostgreSQL-observed wait of a reward edit behind an in-flight completion. Intentional rollback tests log storage exceptions.
