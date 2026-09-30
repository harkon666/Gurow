# T06-L3-06 — Exercise the complete P1 flow and wire T06 acceptance into the harness

Status: approved execution packet, published as [#39](https://github.com/harkon666/Gurow/issues/39); implementation pending. Revised 2026-09-30 for contract `gurow-p1-v2`. Parent: [#7](https://github.com/harkon666/Gurow/issues/7). Contract: [gurow-p1-v2](../../benchmarks/p1/contract.md).

Executor recommendation: **Flash candidate with independent acceptance review**. Blocked by: **T06-L3-05**. Parent coverage: AC1, AC2, AC3, AC4, AC5. User stories: US80, US82, US83, US84.

## Observable outcome

The parent T06 harness builds current sources, exercises the entire functional P1 flow, runs the benchmark evidence pipeline and produces a source-matched gate report that fails closed on incomplete acceptance.

## Scope

Add a T06 browser functional scenario and harness commands, reusing meaningful T04/T05 assertions. Keep performance windows separate from fault-injection/recovery checks. No domain expansion into P2 and no relaxation of existing tests.

## Required inputs

- All prior worker handoffs; contract section 8 and current harness workflow.
- Current T04/T05 browser scripts and current harness.json/scripts/harness.py behavior.

## Source pointers and file ownership

Pointers were inspected at `0a3b9be96a8ef89ce74a22d011ce7e9ba49e996d`; verify current source before editing. New paths below are proposed implementation locations, not claims they exist.

- `frontend/scripts/t06-functional-check.ts (new)`
- `frontend/scripts/benchmark/acceptance.ts (new)`
- `frontend/package.json (command aliases)`
- `harness.json (T06 registrations)`
- `frontend/scripts/t04-smoke-check.ts (read/reuse assertions)`
- `frontend/scripts/t05-smoke-check.ts (read/reuse assertions)`
- `scripts/harness.py (read; changes require a separate justified task)`

## Acceptance criteria

- [ ] Real browser actions prove creation/selection, pan/zoom/drag, valid connection, cycle rejection with unchanged graph, Task edit, one-step drag undo/redo and semantic reload of dynamic IDs/data.
- [ ] Exercise no-WebGPU keyboard/list path plus actual GPU device loss, automatic success, controlled failed recovery and actual retry UI while preserving CPU document and Task data.
- [ ] Map all five parent ACs to observable assertions/logs, with explicit gaps; legacy T04/T05 success alone cannot assert new T06 requirements.
- [ ] Register T06-specific commands with argument arrays and realistic timeout for all warm-ups/windows; build current source before browser checks and keep source/profile/artifact hashes coherent.
- [ ] A stale build, failed sanity check, missing comparison, missing functional result or failed performance metric makes the acceptance command nonzero. Reporting-only success cannot make harness acceptance green.
- [ ] Resume one parent T06 session and preserve its baseline across subtasks/review fixes. Run full checks on the final source and produce actual harness status/review artifacts; no author checklist is called independent review.

## Planned verification commands

These commands for new scripts are an implementation contract; they are not available until the owning task creates them. Run from the repository root unless `cd frontend` is shown.

```bash
python3 scripts/harness.py check --quick
python3 scripts/harness.py check
python3 scripts/harness.py status
python3 scripts/harness.py review
```

## Handoff and escalation

Complete AC mapping, full-check logs, current-source gate report, fixed base/source fingerprint and review packet. A nonpassing gate is explicitly incomplete for parent #7.

Stop/escalate: No headed hardware-accelerated browser available, unresolved acceptance coverage, failures requiring architectural changes, or two unsuccessful correction cycles. Retain evidence and escalate.

Keep one parent T06 harness baseline once implementation starts. Focused worker checks do not replace parent full verification and independent review. Preserve original criteria and source identity.
