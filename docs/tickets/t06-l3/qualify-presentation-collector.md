# T06-L3-01 — Qualify input-to-presentation evidence on the reference browser

Status: delivered as an explicit **`UNSUPPORTED`** collector result on the reference host, published as [#34](https://github.com/harkon666/Gurow/issues/34). The collector is **not qualified** and L3-03 stays blocked on optical acquisition — see [the qualification status record](../../benchmarks/p1/qualification-status.md) for the captured evidence, the AC4 falsification results and the geometry decision. Parent: [#7](https://github.com/harkon666/Gurow/issues/7). Contract: [gurow-p1-v1](../../benchmarks/p1/contract.md).

Executor recommendation: **Strong model / measurement specialist**. Blocked by: **Task A contract pinned; no execution-task blocker**. Parent coverage: AC2, AC3, AC5. User stories: US80, US84.

## Observable outcome

On the real headed Gurow application, replay one controlled pan, zoom and drag and export a qualified input-to-coherent-presentation evidence chain, or an explicit UNSUPPORTED result. This delivers the measurement feasibility decision needed by the performance runner.

## Scope

Create the qualification driver and versioned collector profile. Add opt-in correlation/instrumentation at the existing command and label boundaries only when required. Preserve Rust ownership, JSON commands, normal rendering, persistence and existing visual styles. No renderer optimization, alternate scene implementation, per-frame blocking GPU waits or desktop/driver changes.

## Required inputs

- The complete benchmark contract, protocol and host inventory.
- Existing synchronous Wasm dispatch/render and asynchronous React label update paths.
- Installed Chromium/actual adapter details gathered during the run; generic Perfetto scroll joins are candidates, not proof.

## Source pointers and file ownership

Pointers were inspected at `0a3b9be96a8ef89ce74a22d011ce7e9ba49e996d`; verify current source before editing. New paths below are proposed implementation locations, not claims they exist.

- `frontend/scripts/benchmark/qualify.ts (new)`
- `frontend/scripts/benchmark/collector.ts (new)`
- `frontend/scripts/benchmark/collector.test.ts (new)`
- `frontend/src/components/editor/useWasmEditor.ts`
- `frontend/src/components/editor/SkillCardOverlay.tsx`
- `editor/crates/editor-wasm/src/lib.rs`
- `editor/crates/renderer-wgpu/src/pipeline.rs (only if necessary for attribution)`

## Acceptance criteria

- [ ] Record actual hardware adapter, driver, browser/backend, compositor, headed geometry, refresh/DPR, supported trace configuration, parser version and clock mapping; no fallback/software result is marked qualified.
- [ ] For each pan/zoom/drag, provide raw trace and a hand-auditable mapping from original pre-dispatch input timestamp through application/canvas/label revisions to a coherent presentation with demonstrated real feedback.
- [ ] Separate CPU/submit/GPU/rAF diagnostics from presentation. A missing frame link, fabricated/estimated timestamp or unrelated next paint returns UNSUPPORTED/NOT_MEASURED.
- [ ] Controlled 80 ms app delay and independent 80 ms label delay shift the attributed endpoint appropriately. Acceptance mode rejects profiles with fault injection still enabled.
- [ ] Parser checks reject empty traces, wrong clock units, negative/misordered timestamps, duplicate IDs and canvas/label revision mismatch. Retain failed examples and qualification limitations.
- [ ] Return a versioned callable collector and profile hash consumed by L3-03, or an explicit UNSUPPORTED report that blocks it and identifies the optical acquisition requirements. Do not manufacture support to complete this task.

## Planned verification commands

These commands for new scripts are an implementation contract; they are not available until the owning task creates them. Run from the repository root unless `cd frontend` is shown.

```bash
cd frontend && bun test scripts/benchmark/collector.test.ts
cd frontend && bun run scripts/benchmark/qualify.ts --contract ../docs/benchmarks/p1/protocol.json --out ../.harness/t06/qualification
```

## Handoff and escalation

Collector profile plus raw qualification artefacts, source/profile hashes, clock and grouping definitions, supported interactions and a clear QUALIFIED or UNSUPPORTED verdict. Unsupported is a valid investigation deliverable, not permission to run acceptance or unblock L3-03.

Stop/escalate: Any inability to prove presentation causality or real feedback; unknown actual GPU; inability to fit the headed viewport; clock ambiguity. Escalate to optical acquisition/measurement review with raw evidence.

Keep one parent T06 harness baseline once implementation starts. Focused worker checks do not replace parent full verification and independent review. Preserve original criteria and source identity.
