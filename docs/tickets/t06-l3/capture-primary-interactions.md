# T06-L3-03 — Capture the primary pan, zoom and drag workload with in-app timing

Status: approved execution packet, published as [#37](https://github.com/harkon666/Gurow/issues/37); implementation pending. Revised 2026-09-30 for contract `gurow-p1-v2`. Parent: [#7](https://github.com/harkon666/Gurow/issues/7). Contract: [gurow-p1-v2](../../benchmarks/p1/contract.md).

Executor recommendation: **Flash candidate with independent review**. Blocked by: **T06-L3-02, T06-L3-04** (both closed). Parent coverage: AC2, AC3, AC5. User stories: US80, US84.

## Observable outcome

One command loads the primary fixture and records three 30-second runs each of pan, zoom and drag through real browser input, producing in-app frame-interval and input-to-frame proxy samples plus a v2 report with per-scenario verdicts, without declaring a final P1 pass.

## Scope

Add opt-in in-page instrumentation (input timestamps/revisions, canvas and label commit revisions, rAF frame loop), scenario scheduling and capture orchestration on top of the L3-02 loader, and migrate the L3-04 reducer and fixture code to `protocol-v2.json` / `gurow-p1-report-v2`. No changes to renderer strategy, product behavior or the 20/50 ms limits. No trace-level presentation join or optical capture is required.

## Required inputs

- Contract `gurow-p1-v2` §§3–7, `protocol-v2.json`, ADR 0019.
- Validated fixture loader from L3-02; reducer and record types from L3-04; existing benchmark hooks for delay injection.

## Source pointers and file ownership

Verify current source before editing. New paths are proposed locations, not claims they exist.

- `frontend/src/components/editor/benchmarkHooks.ts` (extend: input/commit/frame recording, opt-in only)
- `frontend/src/components/editor/useWasmEditor.ts` (record canvas and label commit revisions through the hooks)
- `frontend/scripts/benchmark/run.ts (new)`
- `frontend/scripts/benchmark/scenarios.ts (new)`
- `frontend/scripts/benchmark/scenarios.test.ts (new)`
- `frontend/scripts/benchmark/fixture.ts`, `fixture-check.ts` (read `protocol-v2.json`)
- `frontend/scripts/benchmark/report.ts`, `report-cli.ts`, `report.test.ts` (v2 schema and statistics)
- `frontend/scripts/benchmark/collector.ts`, `qualify.ts`, `harness.json` entry `t06-l3-01-qualify` (retire or clearly mark as v1-only; do not delete their historical evidence)

## Acceptance criteria

- [ ] Run pan, zoom and drag after a 10s warm-up with three 30s runs each and up to 2s drain, restoring state between runs, with labels/list/sidebar/persistence active in a headed hardware browser.
- [ ] Emit the nominal 120 Hz absolute schedule through CDP/Puppeteer (never engine shortcuts or synthetic DOM dispatch) without awaiting rendering; record scheduled and delivered counts, and mark a run invalid below 80% delivery, on visibility/focus loss, device loss or page error.
- [ ] Compute `frame_interval_ms` from consecutive rAF timestamps and `input_to_frame_proxy_ms` per delivered input (including coalesced pointer events) exactly as contract §6 defines, keeping the raw value without the refresh-interval estimate; unresolved inputs are charged to the drain deadline, never dropped.
- [ ] Record environment (§3), fixture identity and 2 Hz visibility samples; a run whose median visible card count is outside 150–250 is invalid.
- [ ] The sanity check passes: an 80 ms injected application delay and, separately, an 80 ms injected label-commit delay each raise the proxy's p50 by at least 60 ms; acceptance runs record that injection was off.
- [ ] The reducer emits `gurow-p1-report-v2` with pooled per-scenario and per-run n/p50/p95/max and PASS/FAIL/NOT_MEASURED per contract §7; v1 capture manifests are rejected rather than reinterpreted. Tests cover nearest-rank p95, insufficient samples and invalid runs; existing benchmark tests stay green.

## Planned verification commands

These commands for new scripts are an implementation contract; they are not available until this task creates them. Run from the repository root unless `cd frontend` is shown.

```bash
cd frontend && bun test scripts/benchmark
cd frontend && bun run scripts/benchmark/run.ts --size 1000 --contract ../docs/benchmarks/p1/protocol-v2.json --out ../.harness/t06/primary
```

## Handoff and escalation

Raw per-run input/frame logs, sanity-check results, manifest hashes and a v2 report for the primary workload; no automatic parent closure.

Stop/escalate: The proxy cannot observe label commit revisions without changing product behavior, the sanity check fails, or the specified load cannot be delivered. Do not redefine the metric.

Keep one parent T06 harness baseline once implementation starts. Focused worker checks do not replace parent full verification and independent review. Preserve original criteria and source identity.
