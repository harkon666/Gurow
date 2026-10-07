# Ticket implementation harness

Use this workflow for ticket implementation, review fixes, and review handoff. The commands run from the repo root. User authorization already given remains valid; routine steps do not require another planning approval.

## Start or resume

1. Read `AGENTS.md`, the canonical GitHub ticket, and its relevant domain/validation documents. Check the ticket's native blockers before starting new feature work. A harness session does not close tickets or certify dependency readiness.
2. Resume `.harness/task.json` when it matches the requested ticket. For a different ticket, archive that directory outside the repo before starting the new session. Run `python3 scripts/harness.py start Txx --base <agreed-base>` to start. Use the branch/commit before the ticket's work; retain that baseline throughout review fixes. The command snapshots the issue and resolves the merge-base to a SHA.
3. Fill each criterion's `test` with a repository test-file path and `assertion` with the user action, observable result, and failure case. Preserve the captured requirements. Split composite criteria into scenarios within the assertion field. State proof gaps explicitly in `notes`.
4. Check `harness.json`: the ticket must have its own acceptance check in `tickets`. Existing browser coverage is regression coverage for later tickets, not proof of their new behavior. Full checks run the curated `regression` profile (`"full": ["@regression"]`); a ticket entry lists only its own checks plus `"@regression"`, never a copy of earlier tickets' lists. A new browser check that guards an invariant joins the `regression` profile and gets a row in [the regression audit](../validation/regression-audit.md); `harness-tests` keeps both in agreement. Add required commands with argument arrays and repository-relative working directories. A browser check serves the build the run made: give it `--skip-build` and `"requires": ["build"]` (plus `"db-up"` when it uses PostgreSQL); a backend check requires `db-up`. Mark a check `"parallel": true` only when it uses its own ports, database and files, as the browser checks (distinct `PORT`/`gurow_tXX_browser_test`) and frontend unit tests do; checks sharing `gurow_test` stay serial.

Backend checks (`db-up`, `backend-types`, `backend-tests`) need Docker access: `db-up` starts the PostgreSQL container from `compose.yaml` (127.0.0.1:5433) and the tests use the separate `gurow_test` database.

## Implement one behavior at a time

1. Use the agreed browser/application or public Rust-core seam in `docs/SPEC.md`. For a bug, make a regression test fail on that bug first; record the failure and subsequent passing command in `notes`. Run focused tests while editing, and `python3 scripts/harness.py check --quick` at integration points. To run chosen harness checks, use `python3 scripts/harness.py check --only <check>…`: it adds what they require (the build, the database) and records `.harness/focused.json`, which never counts as full evidence.
2. Use these concrete failure patterns when the change touches the corresponding behavior:
   - **Initialization:** interact before Wasm/async loading finishes. Keep application and engine creation coherent.
   - **Dynamic identities:** create at least two new Skills, use them as connection endpoints, and restore them. Read active data rather than falling back to a fixed fixture list.
   - **Persistence:** edit, save, reload, and inspect the newly loaded UI/engine. Comparing the same storage bytes before and after reload proves storage retention only.
   - **Rejected writes:** exercise wrong Path/owner or mismatched payloads, then edit a Task and complete a canvas operation. Assert the rejected draft is preserved.
   - **Recovery controls:** activate the actual UI button; assert its visible result and context isolation. Direct storage mutation is appropriate for fault injection, not proof that a reset button works.
3. Keep assertions capable of failing when the behavior is broken. Preserve existing meaningful tests; explain changed expectations against the spec. Document untested cases instead of marking them passed.

## Opt-in headed P1 capture

Routine `python3 scripts/harness.py check` does not launch the headed T06 capture, because it takes over a visible desktop window for several minutes. The full profile and the ticket's appended checks run the capture's unit and reducer tests instead.

Run `cd frontend && bun run capture:p1` for a primary capture under contract `gurow-p1-v5` (300 cards, ADR 0020); `bun run capture:p1:v4-1000` re-runs the historical 1,000-card v4 primary for comparison. It builds the current source, runs the preflight (hardware adapter, focused on-screen window, AC power, idle rAF matching the display refresh), the delay sanity captures, and the pan/zoom/drag runs, then reduces the evidence. Keep the browser window focused and visible until it exits. Evidence goes to `.harness/t06/primary/`; `--size 100 --headless` gives a diagnostic run that can never qualify P1.

For the parent #7 gate, run `cd frontend && bun run capture:p1:gate`. It runs the 300-card v5 capture and the 1,000-card informational run (one run per scenario, no threshold), then writes `.harness/t06/gate/gate-report.md`: a PASS/FAIL table per scenario, the 1,000-card numbers, the environment and the proxy limitation. The verdict is the reducer's 300-card metrics verdict; functional coverage comes from the `t06-functional` check instead of the capture. Exit 0 means PASS, 1 FAIL and 2 NOT_MEASURED. `--report-only` re-summarizes existing captures.

`t06-functional` (`bun run check:t06`) is the P1 functional flow in one headless browser session. It builds current sources first and covers create/select, Task edits, a valid connection, cycle rejection, pan/zoom/drag, one-step undo/redo, reload, a renderer failure with retry, and the no-WebGPU list on the same document. It runs in the full profile.

A routine full pass is code/regression evidence only; it does not establish P1 performance acceptance. Report a skipped headed capture separately in review handoffs and task notes. The v1 collector qualification (`bun run qualify:native:v1`) is historical and is not part of T06 acceptance.

## Finish and hand off

1. Finish the AC mapping, then run `python3 scripts/harness.py check`. Serial checks run first, then the parallel ones `jobs` at a time (`harness.json`, default 3; `--jobs 1` runs them one by one when diagnosing a flaky check). A nonzero exit, missing ticket checks, a timeout, or modified inputs leaves verification incomplete. Fix and rerun the relevant check with `--only`.
2. Run `python3 scripts/harness.py status` and `python3 scripts/harness.py review`. The packet includes the fixed baseline, source fingerprint, actual command logs, diff, and untracked file list. A command pass and a filled mapping do not certify test quality or complete acceptance coverage.
3. Request an independent review in a fresh context using `.harness/review.md`, the actual code/tests, and the canonical issue. Use `$code-review` where available: Standards and Spec remain separate. Review test/config changes as carefully as implementation. Do not present an author-written checklist as an independent review.
4. Fix actionable findings and retain the baseline. During review-fix cycles run focused checks only: `check --only` with the ticket's acceptance checks and the regression checks of the areas the fix touches (for example the browser checks of the editors it changes). The re-review reads the fix diff and those logs. Run full verification once more after the last fix, before commit or merge, and regenerate the review packet from it. After two unsuccessful correction cycles or an unresolved architectural question, request a focused review from a stronger model or the user with the repro/logs; preserve independent work that can continue.
5. Report what changed, test results, remaining gaps, and review outcomes separately. Commit when authorized. Merge/push/closing issues follow the user's scope; harness commands perform none of those actions.

Local evidence is in ignored `.harness/`. On context handoff preserve the directory and update `notes`. For sharing, copy the relevant logs/mapping into a reviewed report with source identity. Legacy `smoke-check:t04` separately produces committed validation artifacts from a clean source commit; harness full checks instead build the current working tree and run its browser checks without publishing those reports.
