# T06-L3-05 — Record comparison workloads and explain benchmark resource costs

Status: approved execution packet, published as [#38](https://github.com/harkon666/Gurow/issues/38); implementation pending. Revised 2026-09-30 for contract `gurow-p1-v4`. Parent: [#7](https://github.com/harkon666/Gurow/issues/7). Contract: [gurow-p1-v4](../../benchmarks/p1/contract.md).

Executor recommendation: **Flash candidate**. Blocked by: **T06-L3-03, T06-L3-04**. Parent coverage: AC3, AC4, AC5. User stories: US80, US84.

## Observable outcome

Run the same prescribed input protocol for 100 and 10,000 cards, capture supporting initialization/resource/boundary diagnostics, and assemble all workload records into one reproducible evidence manifest.

## Scope

Extend the runner through small diagnostic hooks and workload orchestration. Measure existing behavior; no speculative optimization, forced GPU synchronization, disabled labels or changed thresholds. Expensive diagnostics may run separately with the same source/fixture identity and must be labeled separately.

## Required inputs

- Working capture runner from L3-03 and reducer from L3-04.
- Contract AC4 diagnostics, comparison policy and environment consistency requirements.

## Source pointers and file ownership

Pointers were inspected at `0a3b9be96a8ef89ce74a22d011ce7e9ba49e996d`; verify current source before editing. New paths below are proposed implementation locations, not claims they exist.

- `frontend/scripts/benchmark/diagnostics.ts (new)`
- `frontend/scripts/benchmark/diagnostics.test.ts (new)`
- `frontend/scripts/benchmark/run.ts`
- `frontend/src/components/editor/useWasmEditor.ts (opt-in counters only)`
- `editor/crates/renderer-wgpu/src/pipeline.rs (opt-in counters only)`
- `editor/crates/editor-wasm/src/lib.rs (opt-in counters only)`

## Acceptance criteria

- [ ] 100/10,000 workloads retain exact graph counts and use the primary scenario settings with at least one run per scenario; report all attempts, timeouts/resource limits and source/environment identity.
- [ ] Report initialization to first coherent render, process-tree memory and available JS/Wasm/GPU memory counters with units, scope and collection method; unavailable optional counters are null with reasons.
- [ ] Report actual renderer draw calls, upload bytes and boundary call counts/JSON byte sizes/durations. Static estimates are labeled estimates and cannot masquerade as measured counters.
- [ ] Keep diagnostics and acceptance timing modes distinguishable; quantify instrumentation differences and never insert queue-wait/readback work into acceptance merely to obtain a counter.
- [ ] Produce a capture manifest consumable by the v2 reducer. Slow comparisons do not fail the primary target or advertise a 10,000-card capacity promise; missing runs remain visible.
- [ ] Counter/report tests cover zero activity versus unavailable measurement, correct units/byte counts, and resource failure. Browser evidence demonstrates comparison paths use real fixtures and labels.

## Planned verification commands

These commands for new scripts are an implementation contract; they are not available until the owning task creates them. Run from the repository root unless `cd frontend` is shown.

```bash
cd frontend && bun test scripts/benchmark/diagnostics.test.ts
cd frontend && bun run scripts/benchmark/run.ts --all-sizes --diagnostics --contract ../docs/benchmarks/p1/protocol-v4.json --out ../.harness/t06/series
```

## Handoff and escalation

Three-workload manifest, raw comparison artifacts, diagnostic methods/counters and measurement limitations ready for full T06 integration.

Stop/escalate: Measuring a diagnostic requires changing production semantics or unsupported low-level API assumptions. Report the gap and request scoped instrumentation review.

Keep one parent T06 harness baseline once implementation starts. Focused worker checks do not replace parent full verification and independent review. Preserve original criteria and source identity.
