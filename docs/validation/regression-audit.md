# Regression check audit (#52)

Audited on 2026-10-07 against `main` at `2cb404c`. Each check in `harness.json` has one decision:

- **Keep**: it guards an invariant no newer check covers, and it is in the `regression` profile.
- **Adapt**: it is kept, and its UI-coupled assertions now read behaviour or `data-*` state instead of wording.
- **Retire**: every assertion is covered elsewhere, named in the table. The check leaves the `regression` profile. It stays in `harness.json` for its ticket's own acceptance and history.
- **Support**: the build, database or type check that the other checks need. Not a behaviour check.
- **Out of profile**: performance or historical evidence and not a functional regression. The headed P1 gate stays separate (`docs/agents/harness.md`).

`python3 scripts/harness.py check` runs the `full` profile, which is `@regression`. A ticket entry lists its own acceptance checks and references `@regression` instead of copying earlier tickets' lists. `scripts/test_harness.py` checks that this table and `harness.json` agree.

## Browser checks

Every browser check is in the profile. No browser check is retired: each one guards at least one invariant that no newer check asserts. For example, T05's narrow-window labels, connection-curve pixels and second automatic recovery are not in `t06-functional`, even though T06 repeats much of T05's flow.

| Check | Decision | Invariant guarded | Notes |
| --- | --- | --- | --- |
| `t04-browser` | Adapt | Checkpoint integrity: a foreign-Path or orphan-card checkpoint is rejected, never reported as saved, and not overwritten by later edits (ADR-0016) | The badge assertion reads `#checkpoint-status-badge[data-state]` (`saved`/`rejected`), not its wording. |
| `t05-browser` | Adapt | Renderer recovery: device loss keeps the CPU document and edits, at most one recovery attempt at a time, failed recovery keeps Retry, later device loss recovers automatically, card and curve pixels redraw. Also usable labels in a narrow window and the no-WebGPU list | It waits for `#gpu-status-badge[data-status]` to leave `initializing` before it asserts `ready`. In the curated full run, parallel load made the old immediate read flaky. |
| `editor-lifecycle` | Keep | Initialization: input before Wasm or async loading finishes, load identity, camera, remount and drag/undo, with and without WebGPU | |
| `t06-functional` | Adapt | P1 flow on one document: new Skills as connection endpoints, cycle refusal, pan/zoom/drag, one-step undo/redo, reload in a new engine, renderer retry, no-WebGPU list | The cycle refusal reads `#cycle-rejection-alert[data-kind="cycle"]`. `connectionRejection.test.ts` (in `frontend-tests`) covers the message wording. |
| `t43-gpu-errors` | Adapt | Renderer recovery after real WebGPU validation errors: no recovery loop, stale devices never take over, CPU document and undo history survive | It was missing from the old `full` profile, so it had broken unnoticed since UX01: it focused the Skill list, which is now a temporary panel. It now opens the list with `#btn-skill-list` first. It joins `regression` as a parallel check that requires `build`. |
| `t44-label-scroll` | Keep | HTML labels stay aligned with the canvas after scrollIntoView, find and scrollTo. Clipping and pointer selection | |
| `t15-sign-in` | Keep | Sign-in is required. Workspace identity holds across reloads, sign-out and Account switches between tabs. Other Accounts are refused | |
| `t16-path-authoring` | Adapt | Personal authoring persistence, autosave, camera per Path, stale and failed saves, invalid API edits, other-Account refusal (permissions) | Waits for `#cycle-rejection-alert[data-kind="cycle"]`. The graph, revision and stored document must stay unchanged. |
| `t17-personal-learning` | Keep | Access, Mastery and XP rules, failed and retried learning writes, cross-Path XP isolation, no-WebGPU list, other-Account refusal | |
| `t18-coach-draft` | Adapt | Draft rules (Optional/Required, cycles, other-Path connections) refused in the UI and by the API, Coach/personal context isolation, other-Coach refusal | Refusals are matched by `data-kind` (`other` for the Draft rule, `cycle`). The rule refusal must still name both Skills: that assertion caught the generic-message bug fixed in `2cb404c`. |
| `t19-publication` | Keep | Publication gate, immutable Versions, new Versions keep their IDs, unauthorized writes refused | |
| `t20-invitation` | Keep | Invitation delivery and retry, verified identity, acceptance only through the backend, closed admission, owner and unrelated-Account refusal | |
| `t21-enrolled-navigation` | Keep | Read-only learner canvas, pinned Version content, camera isolation, learner privacy, no-WebGPU navigation | |
| `t22-learner-work` | Keep | Private drafts, local recovery, offline send, Submission revisions, Access loss while sending, privacy from the Coach, lost answers | |
| `t23-coach-review` | Keep | Review queue, stale decisions refused, confirmed progress only, independent assessment of revisions, self-approval refused | |
| `t24-correct-approval` | Keep | Approval revocation authority and reasons, XP correction and restoration history, stale and lost answers | |
| `t25-access-override` | Keep | Access Override authority, its use, interaction with an inactive Enrollment, revocation, later Review | |
| `t26-participation` | Keep | Enrollment deactivation and reactivation authority, pending Reviews while inactive, long-history layout | |
| `t27-shared-layout` | Adapt | Layout ownership: only the Coach saves the shared layout, learners' writes are refused, cameras are isolated, stale layout saves are refused while the learning data stays unchanged | The stale-save conflict reads `#layout-save-conflict[data-accepted-revision]`, not its wording. The check that no revision number appears in the text stays (UX01 AC4). |
| `t28-recovery` | Adapt | Recovery identity: kept work belongs to the Account, Path and Version that made it, survives interruption, is reapplied as a new save, incoherent records are refused, Draft and layout conflicts | The conflict reads `data-accepted-revision`, and a kept entry reads `data-base-revision` and `data-base-changed`. The "no revision number in text" check stays. |
| `t29-copy-content` | Keep | Copies get new IDs and are independent, no progress is inherited, the source stays private | |
| `t30-archive-content` | Keep | Retention and archival: archived Tasks keep their history and XP, deletion of Tasks with history is blocked, Version evidence is kept | |
| `t31-arrange-selection` | Keep | Box selection and multi-drag as one undo step, world limits, stale and out-of-range saves refused | |
| `t32-delete-content` | Keep | Deletion refused when history exists, undo/redo of deletions as new saves, stale and forbidden deletions | |
| `ux01-navigation` | Adapt | Canvas-first shell, keyboard navigation, truthful save language, no technical chrome, renderer-down learning and Review, forbidden cross-context writes | UX03 (#49): Open board is expected in the personal context. UX04 (#50): it is expected in the Coach Draft too; learner and Review views must still show no board action until UX05. |
| `ux02-connections` | Keep | Dragged Prerequisite connections: validation, persistence, one-gesture undo, stale reapply, read-only learner and published views | |
| `ux03-task-board` | Keep | Personal Task Board (#49): Completion Column membership equals completion under XP rules, failed/lost/stale/refused board writes keep local intent, column removal never loses Tasks, archived Tasks stay off the board, narrow keyboard use without WebGPU | Added by UX03; parallel on ports 3595/3596 with `gurow_ux03_browser_test`. |
| `ux04-coach-board` | Keep | Coach Draft preparation board (#50): columns grant no Approval, XP, Mastery or publication gate, only the owning Coach reads or saves it, a published Draft's board is frozen, deletion undo and archival keep published material and history, failed/stale writes keep local intent, identity switching leaks nothing, narrow keyboard use without WebGPU | Added by UX04; parallel on ports 3597/3598 with `gurow_ux04_browser_test`. |

## Suites and support checks

| Check | Decision | Invariant guarded | Notes |
| --- | --- | --- | --- |
| `harness-tests` | Keep | Harness runner behaviour, profile resolution and agreement between this table and `harness.json` | |
| `frontend-tests` | Keep | Every frontend unit test (`bun test` finds all `*.test.ts` under `src/` and `scripts/`) | |
| `rust-tests` | Keep | Every engine, renderer and Wasm test in the workspace, without a name filter | |
| `backend-tests` | Keep | Every backend integration test against migrated PostgreSQL (`bun test` finds all of `backend/test/*.test.ts`) | |
| `frontend-types` | Support | TypeScript types of the frontend and check scripts | |
| `backend-types` | Support | TypeScript types of the backend | |
| `build` | Support | Production build (Wasm and Vite) that the browser checks serve | |
| `db-up` | Support | PostgreSQL container for the backend and browser checks | |

## Retired from the profile

Each of these runs the same test files as a broader suite in the profile. The suite runs those files whole, with no name filter, so every assertion still runs. The checks stay in `harness.json` as their ticket's acceptance.

| Check | Decision | Invariant guarded | Covered by |
| --- | --- | --- | --- |
| `collector-tests` | Retire | T06 collector and benchmark helpers | `frontend-tests` runs every `scripts/benchmark/*.test.ts` |
| `report-tests` | Retire | P1 report reducer | `frontend-tests` runs `scripts/benchmark/report.test.ts` |
| `t06-l3-03-capture-tests` | Retire | Capture scenarios and wheel coalescing | `frontend-tests` runs `scenarios.test.ts`, `run.test.ts`, `report.test.ts`, `benchmarkHooks.test.ts`, `wheelCoalescer.test.ts` |
| `t06-l3-08-regressions` | Retire | Pointer coalescing, selection, protocol, fixture, trace summary | `frontend-tests` runs those six files |
| `t06-l3-06-gate-tests` | Retire | P1 gate reducer | `frontend-tests` runs `gate.test.ts`, `report.test.ts`, `fixture.test.ts`, `run.test.ts` |
| `ux01-connection-messages` | Retire | Connection refusal wording and `data-kind` classification | `frontend-tests` runs `src/components/editor/connectionRejection.test.ts` |
| `t16-autosave` | Retire | Autosave scheduling | `frontend-tests` runs `src/components/path/autosave.test.ts` |
| `t17-learning-records` | Retire | Learning record reducer | `frontend-tests` runs `src/components/path/learning.test.ts` |
| `t18-draft-rules` | Retire | Draft rules | `frontend-tests` runs `src/components/path/draftRules.test.ts` |
| `t21-protocol` | Retire | Editor protocol | `frontend-tests` runs `src/components/editor/protocol.test.ts` |
| `t22-submission-work` | Retire | Submission work model | `frontend-tests` runs `src/components/path/submissionWork.test.ts` |
| `t23-review-rules` | Retire | Review work model | `frontend-tests` runs `reviewWork.test.ts`, `submissionWork.test.ts` |
| `t24-revocation-rules` | Retire | Revocation work model | `frontend-tests` runs `src/components/path/revocationWork.test.ts` |
| `t25-override-rules` | Retire | Override work model | `frontend-tests` runs `src/components/path/overrideWork.test.ts` |
| `t26-lifecycle-rules` | Retire | Lifecycle work model | `frontend-tests` runs `lifecycleWork.test.ts`, `submissionWork.test.ts` |
| `t28-kept-work-rules` | Retire | Kept-work records and sessions | `frontend-tests` runs `keptWork.test.ts`, `keptWorkSession.test.ts` and the other four listed files |
| `ux03-backend-board` | Retire | Task Board ownership, initial placement, conflicts, atomic completion, retry-safe XP, retention and the database membership triggers | `backend-tests` runs `test/task-board.test.ts` |
| `ux03-board-rules` | Retire | Board intents, completion effects and the board save state machine | `frontend-tests` runs `src/components/board/board.test.ts` |
| `ux04-backend-board` | Retire | Draft preparation board ownership, open-Draft scope, initial placement, conflicts, coherence with Draft saves and archival, frozen published boards, no learner or content writes | `backend-tests` runs `test/draft-board.test.ts` |
| `t29-reuse-rules` | Retire | Copy/reuse rules | `frontend-tests` runs `reuse.test.ts`, `draftRules.test.ts` |
| `t31-protocol` | Retire | Multi-selection protocol | `frontend-tests` runs `protocol.test.ts`, `selection.test.ts`, `run.test.ts` |
| `t06-l3-08-engine-labels` | Retire | Engine label geometry | `rust-tests` runs every `engine-core` test (this check filters by `label`) |
| `t21-engine-read-only` | Retire | Engine read-only mode | `rust-tests` runs every `engine-core` test (filter `read_only`) |
| `t27-engine-layout-only` | Retire | Engine layout-only mode | `rust-tests` runs every `engine-core` test (filter `layout_only`) |
| `t31-engine-multiselect` | Retire | Engine multi-selection | `rust-tests` runs every `engine-core` test (filter `multiselect`) |
| `t32-engine-deletion` | Retire | Engine deletion and its undo | `rust-tests` runs every `engine-core` test (filter `deletion`) |
| `t09-review` | Retire | Review API | `backend-tests` runs `backend/test/review.test.ts` |
| `t10-revocation` | Retire | Revocation API | `backend-tests` runs `backend/test/revocation.test.ts` |
| `t11-override` | Retire | Override API | `backend-tests` runs `backend/test/override.test.ts` |
| `t12-lifecycle` | Retire | Lifecycle API | `backend-tests` runs `backend/test/lifecycle.test.ts` |
| `t13-personal` | Retire | Personal API | `backend-tests` runs `backend/test/personal.test.ts` |
| `t14-p2-gate` | Retire | P2 gate journey | `backend-tests` runs `backend/test/p2-gate.test.ts` |
| `t15-backend-sign-in` | Retire | Sign-in API | `backend-tests` runs `backend/test/sign-in.test.ts` |
| `t16-backend-authoring` | Retire | Authoring API | `backend-tests` runs `backend/test/authoring.test.ts` |
| `t17-backend-tracking` | Retire | Personal tracking API | `backend-tests` runs `backend/test/personal-tracking.test.ts` |
| `t18-backend-coach` | Retire | Coach authoring API | `backend-tests` runs `backend/test/coach-authoring.test.ts` |
| `t19-backend-publication` | Retire | Publication API | `backend-tests` runs `backend/test/publication.test.ts` |
| `t20-backend-invitation` | Retire | Invitation and mail API | `backend-tests` runs `invitation.test.ts`, `mail.test.ts` |
| `t21-backend-enrolled-version` | Retire | Enrolled Version API | `backend-tests` runs `backend/test/enrolled-version.test.ts` |
| `t23-backend-coach-review` | Retire | Coach Review API | `backend-tests` runs `backend/test/coach-review.test.ts` |
| `t25-backend-enrolled-version` | Retire | Enrolled Version and override API | `backend-tests` runs `enrolled-version.test.ts`, `override.test.ts` |
| `t27-backend-layout` | Retire | Version layout API | `backend-tests` runs `version-layout.test.ts`, `enrolled-version.test.ts` |
| `t29-backend-reuse` | Retire | Reuse API | `backend-tests` runs `backend/test/reuse.test.ts` |
| `t30-backend-archival` | Retire | Archival API | `backend-tests` runs `archival.test.ts`, `personal.test.ts` |
| `t32-backend-deletion` | Retire | Deletion API | `backend-tests` runs `backend/test/deletion.test.ts` |

## Performance and historical evidence

| Check | Decision | Invariant guarded | Notes |
| --- | --- | --- | --- |
| `t06-l3-01-qualify-v1` | Out of profile | v1 collector qualification | Historical and opt-in (ADR 0019). Not a regression. |
| `t06-l3-02-fixture-check` | Out of profile | v4 P1 fixture generation | Performance-fixture evidence for T06-L3-02 (900 s). Not a functional regression. |
| `t06-l3-08-fixture-check-v5` | Out of profile | v5 P1 fixture generation | Performance-fixture evidence for T06-L3-08/06. Not a functional regression. |

## Wording that stays

Kept checks still assert some user-facing text where that text is the behaviour under test. Examples: a refusal names the Skills involved, "Not recorded" is never shown as success, and an explanation states which locks remain. If a deliberate wording change breaks one of these checks, adapt it the same way: assert the state (`data-state`, `data-status`, `data-kind`, stored records) and keep the behaviour.

## Evidence that adapted checks still fail

Each break was applied to the working tree, run with `harness.py check --only` on a fresh build, then reverted:

| Deliberate break | Adapted check | Result |
| --- | --- | --- |
| Engine: `CanvasDocument::can_connect` never reports `CreatesCycle` (`engine-core/src/document.rs`), so cycles are accepted | `t16-path-authoring`, `t06-functional` | Both failed: no `#cycle-rejection-alert[data-kind="cycle"]` appeared (run `20261007T111907213337Z`). |
| Product: the editor badge reports a rejected checkpoint as `saved` (`src/routes/editor.tsx`) | `t04-browser` | Failed: `Expected the checkpoint badge in state "rejected", got "saved"` (run `20261007T111938752111Z`). |

The run logs are local harness evidence in `.harness/runs/`, which is not committed.
