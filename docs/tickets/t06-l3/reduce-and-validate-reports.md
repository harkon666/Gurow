# T06-L3-04 — Turn raw benchmark evidence into reproducible verdicts and reports

Status: approved execution packet, published as [#36](https://github.com/harkon666/Gurow/issues/36); implementation pending. Parent: [#7](https://github.com/harkon666/Gurow/issues/7). Contract: [gurow-p1-v1](../../benchmarks/p1/contract.md).

Executor recommendation: **Flash candidate**. Blocked by: **Task A contract pinned; no execution-task blocker**. Parent coverage: AC2, AC3, AC4, AC5. User stories: US84.

## Observable outcome

A report command consumes the contracted evidence records, validates provenance and completeness, computes reproducible statistics, and writes JSON plus a readable report that cannot pass on missing or invalid input.

## Scope

Implement report-v1 types/validation, reducer, CLI and synthetic evidence tests using the normative report sections and numeric protocol. Tests and generated example reports are explicitly synthetic, not P1 evidence. No browser timing acquisition or made-up hardware values.

## Required inputs

- Contract sections 6–8 and protocol.json.
- Synthetic examples for exact thresholds, invalid evidence, uncertainty bounds and mixed run outcomes. Coordinate record names with L3-01/L3-03; this worker owns report types.

## Source pointers and file ownership

Pointers were inspected at `0a3b9be96a8ef89ce74a22d011ce7e9ba49e996d`; verify current source before editing. New paths below are proposed implementation locations, not claims they exist.

- `frontend/scripts/benchmark/report.ts (new; owns report record types)`
- `frontend/scripts/benchmark/report.test.ts (new)`
- `frontend/scripts/benchmark/report-cli.ts (new)`
- `docs/benchmarks/p1/protocol.json (read; do not relax)`

## Acceptance criteria

- [ ] Implement nearest-rank p95 and report n/duration/p50/p95/max per scenario/run; compare unrounded values to 20/50 ms. Boundary tests prove equality passes and values above fail.
- [ ] Every primary run/scenario is required. A slow drag cannot be hidden by pooled pan/zoom data, average percentiles, or counting one large slow coalesced group as one latency sample; zero/insufficient samples cannot pass.
- [ ] Reject missing/unqualified/fabricated presentation provenance, mismatched contract/profile/source identities, broken artifact hashes, mixed clocks, invalid visibility, unclassified input and censored unresolved observations.
- [ ] For bounded optical measurements, p95 upper bound <= threshold passes, lower bound > threshold fails, overlap stays NOT_MEASURED. Physical and injected origins stay separate.
- [ ] Missing comparisons/required AC evidence leave AC4/overall incomplete; slow completed comparisons do not apply primary thresholds. Optional counters use null plus reason, with AC4 limitations visible.
- [ ] Emit reproducible JSON and readable Markdown with raw-artifact references and separate functional/metric/gate verdicts. Synthetic reports have an explicit synthetic marker and cannot satisfy a real gate.
- [ ] Tests include all-PASS, valid FAIL, NOT_MEASURED, mixed outcomes, malformed counts, missing artifact, censored terminal interval, a large slow coalesced group among fast singleton groups, exact threshold and no-default-to-zero cases. Exit codes are 0 only for complete real PASS in gate mode, 1 for proven failure and 2 for missing/invalid evidence.

## Planned verification commands

These commands for new scripts are an implementation contract; they are not available until the owning task creates them. Run from the repository root unless `cd frontend` is shown.

```bash
cd frontend && bun test scripts/benchmark/report.test.ts
cd frontend && bun run scripts/benchmark/report-cli.ts --input ../.harness/t06/capture-manifest.json --contract ../docs/benchmarks/p1/protocol.json --out ../.harness/t06/report
```

## Handoff and escalation

Typed report contract/CLI, deterministic reducer tests and clearly marked synthetic examples for other workers. Source constants and timestamp meaning remain governed by contract v1.

Stop/escalate: An input record cannot establish causality, units or source identity. Return validation error/NOT_MEASURED instead of inferring omitted facts.

Keep one parent T06 harness baseline once implementation starts. Focused worker checks do not replace parent full verification and independent review. Preserve original criteria and source identity.
