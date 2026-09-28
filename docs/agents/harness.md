# Ticket implementation harness

Use this workflow for ticket implementation, review fixes, and review handoff. The commands run from the repo root. User authorization already given remains valid; routine steps do not require another planning approval.

## Start or resume

1. Read `AGENTS.md`, the canonical GitHub ticket, and its relevant domain/validation documents. Check the ticket's native blockers before starting new feature work. A harness session does not close tickets or certify dependency readiness.
2. Resume `.harness/task.json` when it matches the requested ticket. For a different ticket, archive that directory outside the repo before starting the new session. Run `python3 scripts/harness.py start Txx --base <agreed-base>` to start. Use the branch/commit before the ticket's work; retain that baseline throughout review fixes. The command snapshots the issue and resolves the merge-base to a SHA.
3. Fill each criterion's `test` with a repository test-file path and `assertion` with the user action, observable result, and failure case. Preserve the captured requirements. Split composite criteria into scenarios within the assertion field. State proof gaps explicitly in `notes`.
4. Check `harness.json`: the ticket must have its own acceptance check in `tickets`. Existing T04 browser coverage is regression coverage for later tickets, not proof of their new behavior. Add required commands with argument arrays and repository-relative working directories. Full checks must build the current source before testing the browser.

## Implement one behavior at a time

1. Use the agreed browser/application or public Rust-core seam in `docs/SPEC.md`. For a bug, make a regression test fail on that bug first; record the failure and subsequent passing command in `notes`. Run focused tests while editing, and `python3 scripts/harness.py check --quick` at integration points.
2. Use these concrete failure patterns when the change touches the corresponding behavior:
   - **Initialization:** interact before Wasm/async loading finishes. Keep application and engine creation coherent.
   - **Dynamic identities:** create at least two new Skills, use them as connection endpoints, and restore them. Read active data rather than falling back to a fixed fixture list.
   - **Persistence:** edit, save, reload, and inspect the newly loaded UI/engine. Comparing the same storage bytes before and after reload proves storage retention only.
   - **Rejected writes:** exercise wrong Path/owner or mismatched payloads, then edit a Task and complete a canvas operation. Assert the rejected draft is preserved.
   - **Recovery controls:** activate the actual UI button; assert its visible result and context isolation. Direct storage mutation is appropriate for fault injection, not proof that a reset button works.
3. Keep assertions capable of failing when the behavior is broken. Preserve existing meaningful tests; explain changed expectations against the spec. Document untested cases instead of marking them passed.

## Opt-in native qualification

Routine `python3 scripts/harness.py check` does not launch the headed T06 native qualification. T06 keeps collector and editor-lifecycle regression checks in the routine full run; native qualification is deliberately excluded from both the full profile and the ticket's automatically appended checks.

When the reference display/window layout is ready, run `cd frontend && bun run qualify:native`. This builds the current source and runs the existing qualification driver with all native geometry, hardware, presentation and delay gates unchanged. Evidence goes to `.harness/t06/qualification/`; previous evidence is not refreshed by routine checks.

A routine full pass is code/regression evidence only. It does not satisfy T06 native qualification or P1 performance acceptance, unblock L3-03, or replace missing presentation/delay evidence. Report deferred native qualification separately in review handoffs and task notes.

## Finish and hand off

1. Finish the AC mapping, then run `python3 scripts/harness.py check`. A nonzero exit, missing ticket checks, a timeout, or modified inputs leaves verification incomplete. Fix and rerun the relevant check; run full verification again after the final fix.
2. Run `python3 scripts/harness.py status` and `python3 scripts/harness.py review`. The packet includes the fixed baseline, source fingerprint, actual command logs, diff, and untracked file list. A command pass and a filled mapping do not certify test quality or complete acceptance coverage.
3. Request an independent review in a fresh context using `.harness/review.md`, the actual code/tests, and the canonical issue. Use `$code-review` where available: Standards and Spec remain separate. Review test/config changes as carefully as implementation. Do not present an author-written checklist as an independent review.
4. Fix actionable findings, retain the baseline, and repeat affected tests/full verification. After two unsuccessful correction cycles or an unresolved architectural question, request a focused review from a stronger model or the user with the repro/logs; preserve independent work that can continue.
5. Report what changed, test results, remaining gaps, and review outcomes separately. Commit when authorized. Merge/push/closing issues follow the user's scope; harness commands perform none of those actions.

Local evidence is in ignored `.harness/`. On context handoff preserve the directory and update `notes`. For sharing, copy the relevant logs/mapping into a reviewed report with source identity. Legacy `smoke-check:t04` separately produces committed validation artifacts from a clean source commit; harness full checks instead build the current working tree and run its browser checks without publishing those reports.
