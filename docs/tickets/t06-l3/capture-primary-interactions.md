# T06-L3-03 — Capture the primary pan, zoom and drag workload with qualified timing

Status: approved execution packet, published as [#37](https://github.com/harkon666/Gurow/issues/37); implementation pending. Parent: [#7](https://github.com/harkon666/Gurow/issues/7). Contract: [gurow-p1-v1](../../benchmarks/p1/contract.md).

Executor recommendation: **Flash candidate after a QUALIFIED collector handoff**. Blocked by: **T06-L3-01, T06-L3-02, T06-L3-04**. Parent coverage: AC2, AC3, AC5. User stories: US80, US84.

## Observable outcome

One command loads the primary fixture and records all nine prescribed active windows through actual browser input, producing traceable raw input/frame evidence without declaring a final P1 pass.

## Scope

Implement deterministic scenario scheduling and capture orchestration against the collector API from L3-01 and loader from L3-02. Add runner validity checks. No changes to timestamp semantics, renderer strategy, grouping rules or product performance limits.

## Required inputs

- QUALIFIED collector profile from L3-01 for all three interaction types; UNSUPPORTED does not meet this dependency.
- Validated fixture metadata/loader from L3-02.
- Contract sections 5–7 and protocol.json; output record types shared with L3-04.

## Source pointers and file ownership

Pointers were inspected at `0a3b9be96a8ef89ce74a22d011ce7e9ba49e996d`; verify current source before editing. New paths below are proposed implementation locations, not claims they exist.

- `frontend/scripts/benchmark/run.ts (new)`
- `frontend/scripts/benchmark/scenarios.ts (new)`
- `frontend/scripts/benchmark/scenarios.test.ts (new)`
- `frontend/scripts/benchmark/collector.ts (consume)`
- `frontend/scripts/benchmark/fixture.ts (consume)`
- `frontend/scripts/benchmark/report.ts (consume record types from completed L3-04)`

## Acceptance criteria

- [ ] Run pan, zoom and drag with three independent repetitions each, fixed 10s warm-up, 30s active duration and up to 2s drain, with fresh setup per repetition and labels/list/sidebar/persistence active.
- [ ] Emit the 120 Hz absolute input schedule through CDP/Puppeteer, never engine shortcuts or DOM dispatch; record intended and actual timing, delayed requests, coalescing and every attempt.
- [ ] Record at least the declared pacing and sample counts; a renderer hang, slowed sender, invisible tab, changed adapter/DPR, trace loss or out-of-band primary visibility prevents PASS eligibility.
- [ ] Preserve all group members and compute acceptance latency per original input (or conservatively repeat oldest-group latency for every member); include slow frames, queue delays and unresolved/censored tails. Do not trim outliers or pool away a failing scenario.
- [ ] Raw output contains hashes, complete environment/fixture identity, real presentation/canvas/label correlation and visibility records sufficient for independent reduction.
- [ ] Controlled invalid-profile, missing-sample and background-tab scenarios produce explicit invalid evidence and non-successful acceptance status instead of empty/zero latency. Scheduler tests cover late deadlines and avoid rendering-dependent pacing.

## Planned verification commands

These commands for new scripts are an implementation contract; they are not available until the owning task creates them. Run from the repository root unless `cd frontend` is shown.

```bash
cd frontend && bun test scripts/benchmark/scenarios.test.ts
cd frontend && bun run scripts/benchmark/run.ts --size 1000 --contract ../docs/benchmarks/p1/protocol.json --collector-profile ../.harness/t06/qualification/profile.json --out ../.harness/t06/primary
```

## Handoff and escalation

All attempted primary-run raw logs/traces, manifest hashes, sampler tests and an explicit capture-validity report; no automatic parent closure.

Stop/escalate: Any collector API/clock/grouping decision not settled in L3-01, unsupported presentation on one scenario, or inability to supply the specified load. Do not redefine the metric.

Keep one parent T06 harness baseline once implementation starts. Focused worker checks do not replace parent full verification and independent review. Preserve original criteria and source identity.
