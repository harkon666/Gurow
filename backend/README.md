# Gurow backend

Bun + Hono learning-domain service backed by PostgreSQL through Drizzle ([ADR 0021](../docs/adr/0021-persist-the-backend-with-drizzle-over-bun-sql.md)).

## Setup

```sh
docker compose up -d --wait   # from the repo root: PostgreSQL 18 on 127.0.0.1:5433
cp .env.example .env          # database URLs, BETTER_AUTH_SECRET, BETTER_AUTH_URL, PORT, optional Resend
bun install
bun run db:migrate            # apply drizzle/ migrations to DATABASE_URL
```

## Commands

| Command | Purpose |
| --- | --- |
| `bun run dev` | Serve on http://localhost:3001 (`PORT`); the frontend forwards `/api/*` here |
| `bun test` | Request-level integration tests; creates, migrates and empties `gurow_test` |
| `bun run typecheck` | TypeScript check |
| `bun run db:generate` | Generate a SQL migration from `src/db/schema.ts` changes; review and commit it |
| `bun run db:migrate` | Apply committed migrations |

## Identity and sign-in (T15)

Sign-in uses Better Auth email/password sessions ([ADR 0022](../docs/adr/0022-sign-in-with-better-auth-email-and-password.md)). Its user model is the `accounts` table, so a session names a domain Account directly. Sessions, credentials (password hashes) and verification tokens live in `auth_sessions`, `auth_credentials` and `auth_verifications`.

`src/index.ts` serves `createServer`: every route under `/api`, Better Auth under `/api/auth/*`, and learning routes acting for the Account of a valid session cookie (`sessionIdentity`). Requests without one answer 401. The browser reaches it through the frontend's same-origin `/api` forwarder (`frontend/src/routes/api/$.ts`, backend origin from `GUROW_API_ORIGIN`, default `http://127.0.0.1:3001`).

Integration tests of P2 rules use `createApp` with `fixtureIdentity`, which maps the `x-gurow-fixture-identity` header to fixture Accounts. The served backend never wires it, and `test/sign-in.test.ts` proves the header is refused there.

| Route | Effect |
| --- | --- |
| `POST /api/auth/sign-up/email` `{ email, password, name, callbackURL? }` | Creates an Account (password at least 8 characters), signs it in and sends a verification link |
| `POST /api/auth/sign-in/email` `{ email, password }` | Sets the session cookie; wrong credentials answer 401 |
| `POST /api/auth/sign-out` | Ends the session server-side |
| `GET /api/auth/verify-email?token=…` | Redeems the emailed link; the only way `emailVerified` becomes true |
| `GET /api/account` | `{ account: { id, email, name, emailVerified } }`; no Coach/Learner type exists |
| `PUT /api/personal/workspace` | Enters the Account's one Personal Workspace: 201 on creation, 200 afterwards, `{ workspace, learningPaths }` |
| `GET /api/personal/workspaces/:workspaceId` | The same body for its owner; 404 `workspace_not_found` for every other Account |

- `email_verified` is not a sign-up or update input; Better Auth ignores client claims, and only the verification token sets it. Invitation acceptance (T07) reads the same column.
- `personal_workspaces_owner_key` decides concurrent first entries: `INSERT … ON CONFLICT DO NOTHING` then a read, so racing entries all return the one Workspace.
- Email leaves through Resend when `RESEND_API_KEY` and `MAIL_FROM` are set ([ADR 0023](../docs/adr/0023-deliver-email-through-resend.md)); otherwise the served backend logs each link (`[gurow] email verification for …`). Password reset, email change, Account deletion and social sign-in are Account lifecycle policies outside T15.

`bun test test/sign-in.test.ts` covers sign-up/sign-in/sign-out, hashed credentials, refusal of anonymous, fixture-header, raw-ID, forged and signed-out sessions, one Workspace across sign-ins and 16 racing first entries, owner-only reads and writes across Account switching, client-claimed versus link-verified email with the invitation flow, sign-up over an existing address, and the absence of an Account type. `frontend/scripts/t15-sign-in-check.ts` runs the browser flow; results are in [the T15 report](../docs/validation/t15-sign-in-report.md).

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

Current XP/Mastery remain derived from durable revision decisions. T10 additionally records XP Award/Correction and Mastery award/revocation transitions in the same transaction as each Review mutation. T11 persists scoped Access Overrides; T12 adds explicit Enrollment lifecycle and durable Task starts. T15 adds sign-in (see Identity and sign-in). There is no generic Review overwrite endpoint.

Recorded times follow the accepted lock order (T14): sends, Reviews, revocations and personal actions read one `clock_timestamp()` after taking their locks (`src/db/clock.ts`) and reuse it for every record of that transition. A superseded revision's `supersededAt` equals its successor's `sentAt`, XP/Mastery events share their decision or revocation time, and a send that queued behind a Review is recorded after that decision. Transaction-start `now()` is not used for ordered history, because a request can begin before it waits for a lock.

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

Personal-mode Learning Paths share the `learning_paths`, `skills` and `tasks` identity tables with coach mode; a Path belongs to exactly one Coach Workspace or one Personal Workspace (`learning_paths_one_workspace`). Personal definitions are unversioned (`personal_skills`, `personal_tasks`, `personal_prerequisites`) and composite keys require their Path to be personal. P2 tests seed Paths through `seedPersonalFixture`; owners author them through the T16 routes below.

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
| `PUT …/skills/:skillId/xp-threshold` `{ "xpThreshold": 40 }` | Sets the Skill's XP Threshold (T17); integer 0–1,000,000,000, otherwise 422 `invalid_threshold` |

- Mutations answer 200 `{ "changed", "learningState" }` after commit. A repeat (already complete, same reward, already declared/granted, …) answers `changed: false` and records nothing. Completion or start on a locked Skill returns 403 `skill_locked`; any change to an archived Task returns 409 `task_archived`.
- `learningState` holds `xp`, `tasks` (definition, `startedAt`, `completed`, `completedAt`, `archivedAt`, `xpContribution`), `skills` (definition, `mastery`, `masteryDeclaredAt`, `access`, `accessOverride`, `unmetPrerequisiteSkillIds`, `xpShortfall`), and the ordered `xpHistory`, `masteryHistory` and `overrideHistory`.
- XP is the sum of current rewards of completed Tasks in this Path only, archived ones included; other personal Paths and Enrollments never count (ADR 0009). A Skill has Access when its latest override is a grant, or when every Prerequisite Skill has declared Mastery and Path XP meets its threshold. Lower XP relocks already started work; the start record stays.
- Each nonzero change in a Task's contribution appends an XP event with signed `amount`, `cause` (`completion`, `completion_undone`, `reward_change`) and `kind` (`award` for the Task's first completion event, otherwise `correction`). For a completed Task, a 20→50 edit records +30, undo −50 and completion again +50. Incomplete or zero-reward changes record nothing. Completion, rewards and archival never change Mastery; Mastery and overrides never change XP.
- Every request holds the Path row lock through commit, so checks, changes, history and reads are one state. XP, Mastery and override histories reject UPDATE/DELETE in SQL. A late history failure rolls back the whole action.

`bun test test/personal.test.ts` covers owner-only authority against the learner's Coach, peers and other Accounts; free Mastery; idempotent sequential and concurrent completion/undo; the 20→50 correction scenario; Path-local thresholds, relocking and the reasonless override; archival retention; separation from Enrollments in both directions; fresh-connection readback; immutable history; late rollback of each history kind; and a PostgreSQL-observed wait of a reward edit behind an in-flight completion. Intentional rollback tests log storage exceptions.

## Personal Path authoring (T16)

A personal Path is saved as one document (`src/authoring.ts`, ADR 0016), shaped like the P1 local checkpoint: the editor snapshot (`format_version`, one card per Skill with its position, connections) beside the application payload (Path title and goal, Skill titles and outcomes, Tasks). Tasks never enter the snapshot; connections are stored once, as `personal_prerequisites`; card positions are the Path's Canvas Layout in `personal_skill_cards`. Camera, selection and undo history are never stored.

| Route | Effect |
| --- | --- |
| `POST /personal/learning-paths` `{ title, goal }` | 201 with the new document at revision 0, in the caller's Personal Workspace (entered if needed); a blank title is 422 `invalid_learning_path` |
| `GET /personal/learning-paths/:pathId` | `{ learningPath: { id, personalWorkspaceId, title, goal, revision }, editor, application }` for the owner; 404 otherwise |
| `PUT /personal/learning-paths/:pathId/document` `{ expectedRevision, title, goal, editor, application }` | Saves the whole document and answers it with `revision + 1`; an unchanged document keeps the revision |

- `learning_paths.revision` is the concurrency revision, distinct from a Learning Path Version and the snapshot format version. Under the Path row lock, a save whose `expectedRevision` is not the current revision answers 409 `stale_revision` with `current` (the accepted document) and writes nothing.
- The whole save is refused, writing nothing, when it breaks an identity rule: a Skill ID already owned by another Path (409 `skill_owned_elsewhere`; the `skills` primary key decides concurrent claims), a Task ID owned elsewhere (409 `task_owned_elsewhere`), a Task under a different Skill than its own (409 `task_skill_mismatch`), or an archived Task (409 `task_archived`). Removing a stored Skill or active Task is 422 `skill_missing` / `task_missing`: deletion and archival from the editor follow in T30/T32.
- Shape and association are checked before the database: every Skill has exactly one card with the same title, IDs are unique UUIDs, positions are finite within ±1,000,000, text is within its limits (422 `invalid_document`). Connections must join two Skills of the document (422 `connection_outside_path`) and keep the Prerequisite Graph acyclic, self-edges included (422 `prerequisite_cycle`). An invalid edit to a Path the caller does not own still answers 404.
- Saves never write Task rewards, completion, starts, archival, Mastery, XP Thresholds or overrides: those stay with the T13 learning routes and their histories. Those routes in turn never change the document revision, so tracking progress never makes an open editor stale.

A threshold is a progression rule rather than a learning record: it has no history, and changing it changes Access only (a higher one relocks started work while keeping completions, XP and declared Mastery). `bun test test/personal-tracking.test.ts` (T17) exercises it and the learning routes on Paths authored through these document routes, including Path-local XP across two authored Paths.

`bun test test/authoring.test.ts` covers several Paths per owner with their own goal, Skills, Tasks and cards; reopening; the snapshot/payload split; learning records untouched by saves; the owner-only matrix; identity and graph refusals with no partial writes; concurrent Skill ID claims; stale and competing saves.

## Coach Workspaces and Learning Path Drafts (T18)

`src/coaching.ts` serves the owning-Coach context (ADR 0010, 0011). A Coach Workspace has exactly one owner, its Coach, whose authority covers the Paths inside it and nothing else. Every other Account, including learners of those Paths and other Coaches, receives 404 for the Workspace, its Paths and their Drafts; anonymous requests receive 401. Coach routes never open personal Paths, and personal routes never open coach-mode Paths.

| Route | Effect |
| --- | --- |
| `GET /coach/workspaces` | The Coach Workspaces the caller owns |
| `POST /coach/workspaces` `{ name }` | 201 with a new Workspace owned by the caller; a blank name is 422 `invalid_workspace` |
| `GET /coach/workspaces/:workspaceId` | `{ workspace, learningPaths }` for the owner |
| `POST /coach/workspaces/:workspaceId/learning-paths` `{ title, goal }` | 201 with the new Path and its first Draft (Version 1, unpublished) |
| `GET /coach/learning-paths/:pathId` | `{ learningPath: { id, coachWorkspaceId, title, goal, revision }, draft: { id, versionNumber } \| null, version, versions, editor, application }`; `version` and `versions` are described under T19 |
| `PUT /coach/learning-paths/:pathId/draft` `{ expectedRevision, title, goal, editor, application }` | Saves the whole Draft against the Path revision, as in T16 |

- A Learning Path Draft is the Path's one unpublished `learning_path_versions` row (`learning_path_versions_one_draft_key`); its content lives in `version_skills`, `version_tasks`, `version_prerequisites` and its Canvas Layout in `version_skill_cards` (migration `0011_coach_drafts`). Nobody can enrol in it (409 `version_not_published`), so a Draft never awards XP or Mastery. Publication is described under T19.
- The document is the T16 document plus the Draft's rules. Each Skill has `optional` and `xpThreshold` (0–1,000,000,000), and each Task has `required` and `xpReward` (0–1,000,000). Missing or out-of-range values are 422 `invalid_document`. Incomplete Drafts are accepted, for example a required Skill with no Required Task.
- Besides the T16 checks (`prerequisite_cycle`, `connection_outside_path`), a connection from an Optional Skill to a required Skill is 422 `optional_prerequisite`, with both titles in `detail`.
- Skill and Task IDs are claimed for the Path: an ID of another Path (personal or coach) is 409 `skill_owned_elsewhere` / `task_owned_elsewhere`, and a Task under another Skill is 409 `task_skill_mismatch`. A stale `expectedRevision` is 409 `stale_revision` with `current`. Removing a Skill or Task is 422 `skill_missing` / `task_missing` until T32. In every case nothing is written.

`bun test test/coach-authoring.test.ts` covers Workspace ownership and the full non-owner matrix, two Paths on one subject, ID claims across Paths and modes, every Draft rule and its validation, the Optional-Prerequisite rule, cycles and outside connections, no enrolment in a Draft, stale and competing saves.

## Publishing a Learning Path Version (T19)

`src/publication.ts` checks the required route (ADR 0008) and `src/coaching.ts` publishes Drafts and prepares new ones (ADR 0004, 0005). Every route below is for the Workspace's owning Coach only: other Accounts receive 404 and anonymous requests 401, whatever the body.

| Route | Effect |
| --- | --- |
| `POST /coach/learning-paths/:pathId/publication` `{ expectedRevision }` | Publishes the open Draft as it stood at that revision and advances the revision. 200 with the document, now showing the published Version and no Draft |
| `POST /coach/learning-paths/:pathId/drafts` `{ expectedRevision }` | 201 with a new Draft (next Version number) copied from the latest published Version: same logical Skill and Task IDs, with their own definitions, rules, Prerequisites and Canvas Layout |
| `GET /coach/learning-path-versions/:versionId` | One published Version, read-only, in the document shape; a Draft or another Coach's Version is 404 `version_not_found` |

- A Path document shows one Version's content: `version` is `{ id, versionNumber, publishedAt }` of the open Draft when there is one, otherwise of the latest published Version. `versions` lists the published Versions as `{ id, versionNumber, publishedAt, enrollmentClosed }`.
- Each Version holds its own title and goal (`learning_path_versions.title`/`goal`, migration `0013_version_title_goal`). A coach-mode document's `learningPath.title`/`goal` are those of the Version shown, a Draft save writes them to the Draft only, and the Workspace lists each Path under its newest Version's title. `learning_paths.title`/`goal` are not read for coach-mode Paths.
- **Required route.** Starting from no Mastery and 0 XP, a required Skill opens when all its Prerequisites are mastered and its XP Threshold is at most the XP already reachable. Once open, it can be mastered only if it has at least one Required Task, and only then do its Required Tasks' rewards become reachable. Optional Skills, Enrichment Tasks and Access Overrides never count, and a Skill's own rewards never pay for its own threshold. A Draft is publishable when every required Skill is reached. A Draft with no required Skill is refused, since it has no route to complete.
- **Refusals.** A blocked route is 422 `publication_blocked` with `detail`, `reachableXp` and `blockedSkills: [{ skillId, title, unmet }]`, where each `unmet` is `required_task`, `prerequisite` (`skillId`, `title`) or `xp_threshold` (`xpThreshold`, `reachableXp`), each with a `message`. A stale `expectedRevision` is 409 `stale_revision` with `current`. Publishing without an open Draft is 409 `no_open_draft`, and preparing while one is open is 409 `draft_already_open`. A missing or invalid `expectedRevision` is 422 `invalid_request`. Nothing is written in any of these cases.
- **Immutability.** The application writes only the open Draft. Migrations `0012_published_versions_immutable` and `0013_version_title_goal` also make the database refuse any insert, update or delete of `version_skills`, `version_tasks` and `version_prerequisites` rows of a published Version, as well as changing a published Version's title or goal, or unpublishing, renumbering or deleting it.
- **Serialization with publication.** Every content write locks its Version row `FOR SHARE`, published or not, and `publishDraft` locks the Draft row `FOR UPDATE` before reading it for validation. A write in progress therefore makes the publication wait and validate the committed content, and a write arriving during a publication waits and is then refused. The Version's Canvas Layout (`version_skill_cards`) and Enrollment Closure stay writable (ADR 0005). Test fixtures that configure published fixture content use `amendPublished` in `test/support/fixtures.ts`, which disables the guards inside its own transaction as the schema owner.
- Existing Enrollments keep their Version; nothing migrates them, and new Versions start with no Enrollment.

`bun test test/publication.test.ts` covers per-Version titles and goals, forced-order races between direct writes and publication, the 60-versus-100 XP example with optional work offering the difference, self-funded thresholds, cascading blocked Prerequisites, empty and Enrichment-only Required Task sets, immutability through the API and directly in the database, a typo correction published as Version 2 while Version 1 stays readable, stable logical IDs with version-specific definitions, a fixture Enrollment that keeps its Version, progress and override, the non-owner matrix, and competing publications and preparations.

## Invitations and Enrollment Closure (T20)

A Coach invites one email address to one published Version and opens or closes that Version to new Enrollments; the addressee accepts through the emailed link ([ADR 0023](../docs/adr/0023-deliver-email-through-resend.md)). Coach routes answer 404 to every Account except the owner of the Version's Coach Workspace.

| Route | Effect |
| --- | --- |
| `POST /api/coach/learning-path-versions/:versionId/invitations` `{ email }` | Stores the Invitation, then emails `${BETTER_AUTH_URL}/invitations/:id`. 201 `{ invitation, delivered, deliveryError? }`; `delivered` is true only when Resend accepted the email. A refused or unreachable provider keeps the Invitation as `delivery.status: "failed"`; without a configured provider it is `"logged"`, since the link was only written to the server log. 422 `invalid_invitation`, 409 `version_not_published` for a Draft |
| `POST /api/coach/invitations/:invitationId/delivery` | Sends it again as a new attempt: 200 when delivered, 502 `invitation_delivery_failed` when the provider failed, 503 `email_not_configured` when no provider is configured; both with the Invitation |
| `GET /api/coach/learning-path-versions/:versionId/invitations` | `{ enrollmentClosed, invitations: [{ id, email, createdAt, acceptedAt, delivery: { status, attempts, deliveredAt } }] }`, newest first |
| `PUT` / `DELETE /api/coach/learning-path-versions/:versionId/enrollment-closure` | Closes or reopens the Version to new Enrollments: `{ enrollmentClosed, changed }`; repeating the current state changes nothing |
| `GET /api/invitations/:invitationId` | For the verified addressee only: `{ offer: { learningPathTitle, versionNumber, coachWorkspaceName, … }, enrollment: { id, status } \| null }`; 403 `email_not_verified` or `email_mismatch` before anything is disclosed |
| `POST /api/invitations/:invitationId/accept` | 201 creates the Enrollment in that Version only; 200 returns the one already held, status unchanged. 403 `owner_cannot_enroll`, 409 `enrollment_closed` |

- Acceptance reads the Version `FOR SHARE` and closure updates it, so a closure committed first refuses the acceptance and an acceptance in progress finishes before the closure applies.
- Closure only stops new Enrollments: existing ones, active or inactive, keep their status, and accepting again still answers with them. Invitations can be sent while closed, and admit once reopened. There is no expiry.
- Delivery happens after the Invitation is stored and outside its transaction; each attempt sends Resend the `Idempotency-Key` `enrollment-invitation/<id>/<attempt>`. A server without `RESEND_API_KEY` never reports an email as sent.

`bun test test/invitation.test.ts test/mail.test.ts` runs these flows through the served backend with Better Auth sessions and a local Resend stand-in. `frontend/scripts/t20-invitation-check.ts` runs the browser flow; results are in [the T20 report](../docs/validation/t20-invitation-report.md).

## Navigating an enrolled Version (T21)

A learner reads the Version their Enrollment joined, beside the learning state under `/learning-state` ([ADR 0005](../docs/adr/0005-keep-learners-on-their-learning-path-version.md), [ADR 0013](../docs/adr/0013-limit-enrollment-data-visibility.md)).

| Route | Effect |
| --- | --- |
| `GET /api/enrollments` | The caller's own Enrollments as a learner: `{ enrollments: [{ id, status, learningPathVersionId, versionNumber, learningPathId, learningPathTitle, coachWorkspaceName, createdAt }] }`. Other Accounts' Enrollments are never listed |
| `GET /api/enrollments/:enrollmentId/version` | For the learner or the owning Coach (`viewer`): `{ enrollment, viewer, learningPath: { id, title, goal }, version: { id, versionNumber, publishedAt }, coachWorkspace, editor, application }`, with that Version's own content and its shared Canvas Layout as it stands now. Nothing about the Path's other Versions or Draft is included. Anyone else, or an unknown ID, gets 404 `enrollment_not_found` |

- The view is read-only; there is no write method on it, and learners find no Coach route (404).
- Later Versions never change it: the title, goal, Skills and Tasks are those the Enrollment joined.

`bun test test/enrolled-version.test.ts` covers pinned content, the shared layout, lock state and history, learner writes and visibility. `frontend/scripts/t21-enrolled-navigation-check.ts` runs the browser flow; results are in [the T21 report](../docs/validation/t21-enrolled-navigation-report.md).

## Finding work to review (T23)

The owning Coach finds the revisions awaiting a decision and decides them through the T09 route above ([ADR 0002](../docs/adr/0002-review-immutable-submission-revisions.md), [ADR 0013](../docs/adr/0013-limit-enrollment-data-visibility.md)). A revision awaits Review while it is sent, not superseded and undecided, so a Submission has at most one; it stays listed after the Skill locks or the Enrollment is deactivated, because it was sent with valid Access ([ADR 0007](../docs/adr/0007-scope-coach-xp-to-enrollments.md)).

| Route | Effect |
| --- | --- |
| `GET /api/coach/learning-path-versions/:versionId/enrollments` | For the owner of the Version's Coach Workspace: `{ enrollments: [{ id, status, createdAt, learner: { name, email }, awaitingReview: [{ taskId, revisionId, revisionNumber, sentAt }] }] }`, in enrollment order, each queue oldest first. Anyone else, an unknown ID and an unpublished Version get 404 `version_not_found` |
| `GET /api/enrollments/:enrollmentId/learning-state` | Also returns `awaitingReview` for that Enrollment, in the same shape, to its learner and owning Coach |
| `GET /api/enrollments/:enrollmentId/version` | Also names the Enrollment's `learner: { name, email }` |

`bun test test/coach-review.test.ts` covers the listing, its visibility and what counts as awaiting. `frontend/scripts/t23-review-work-check.ts` runs the browser flow; results are in [the T23 report](../docs/validation/t23-coach-review-report.md).

## Correcting an Approval (T24)

The owning Coach revokes an Approval from the UI through the T10 route `POST /api/enrollments/:enrollmentId/tasks/:taskId/submission/revisions/:revisionId/review/revoke` with `{ "reason" }`, unchanged ([ADR 0003](../docs/adr/0003-derive-coach-mastery-from-required-task-approvals.md)). To let the learner and the Coach see what a revocation changed, the learning state names the cause of each history event:

| Field | Meaning |
| --- | --- |
| `xpHistory[].revisionNumber` | The number of the revision (`revisionId`) whose Approval awarded or restored the XP, or whose revoked Approval caused the correction |
| `masteryHistory[].taskId`, `masteryHistory[].revisionNumber` | The Task and revision whose Approval or revoked Approval awarded or revoked the Mastery |

`GET …/tasks/:taskId/submission` also gives each revoked Approval's revision a `revocation: { stillCountingRevisionNumbers, xpCorrection, masteryRevokedSkillIds }`, read in the same transaction as the history it explains, so the UI never pieces an outcome together from records read at another moment. The Approvals still counting are compared in PostgreSQL at full timestamp precision (the order transitions are recorded in under the Enrollment lock; JSON times keep only milliseconds), with the derivation's validity rule. An Approval decision only adds (award, restoring correction, Mastery award) and a revocation only removes (negative correction, Mastery revocation), so a revocation's XP and Mastery outcome is its revision's negative corrections and Mastery revocations. `bun test test/revocation.test.ts` covers the fields, including two revocations within one millisecond; `frontend/scripts/t24-correct-approval-check.ts` runs the browser flow; results are in [the T24 report](../docs/validation/t24-correct-approval-report.md).

## Access Overrides from the Coach UI (T25)

The owning Coach grants and revokes an Access Override from the Enrollment page through the T11 routes, unchanged. So that the learner and the Coach can read who acted in each Override Record, `GET /api/enrollments/:enrollmentId/version` adds `coach: { id, name }`: the Coach Workspace's owner, by name only (no email address). The UI names a record's Actor from `coachAccountId`. `bun test test/enrolled-version.test.ts` covers the field; `frontend/scripts/t25-access-override-check.ts` runs the browser flow; results are in [the T25 report](../docs/validation/t25-access-override-report.md).

## P2 gate (T14)

`bun test test/p2-gate.test.ts` runs competing requests across Enrollment, Submission, Review, revocation, override and lifecycle boundaries over the SPEC reference Path, plus the end-to-end reference flow, privacy matrix, lifecycle and personal 20→50 checks. Forced orders hold a row lock from a separate connection and observe `pg_blocking_pids` before starting the competing request. Unforced storms assert order-independent invariants in SQL at full timestamp precision. These invariants cover contiguous revision numbers, supersession at the successor's send, no Review on superseded work, no successor sent while a reviewed revision was pending, events at their causal time, one Submission per Task, and no revision sent while inactive. They also check that each Task's contribution moves only between zero and its reward. Results are recorded in [the P2 gate report](../docs/validation/t14-p2-gate-report.md).
