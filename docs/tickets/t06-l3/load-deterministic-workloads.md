# T06-L3-02 — Load deterministic benchmark workloads through the existing application

Status: delivered for [#35](https://github.com/harkon666/Gurow/issues/35); fixtures load through the route with every AC observed in the browser fixture check. This is setup evidence only, not a performance result. Parent: [#7](https://github.com/harkon666/Gurow/issues/7). Contract: [gurow-p1-v1](../../benchmarks/p1/contract.md).

Executor recommendation: **Flash candidate**. Blocked by: **Task A contract pinned; no execution-task blocker**. Parent coverage: AC1, AC2, AC3, AC4. User stories: US80, US83, US84.

## Observable outcome

Generate and load each prescribed workload through the real route and validated checkpoint boundary, then show correct Skill/Task association, DAG, camera and visible labels in the browser. This is a complete fixture-to-application path, not just a generator utility.

## Scope

Create deterministic fixture and setup helpers, generator tests and a browser fixture check. Use an isolated profile and existing storage schema/keys to seed setup. Do not change the product default fixture, checkpoint domain schema, runtime ownership or hide UI to reduce load. No timed runner or optimization.

## Required inputs

- Contract sections 3–5 and protocol.json: exact grid/edge/camera recipe and visibility band.
- Current LearningPathCheckpoint, camera storage keys, route account/path constants and public editor load/export behavior.

## Source pointers and file ownership

Pointers were inspected at `0a3b9be96a8ef89ce74a22d011ce7e9ba49e996d`; verify current source before editing. New paths below are proposed implementation locations, not claims they exist.

- `frontend/scripts/benchmark/fixture.ts (new)`
- `frontend/scripts/benchmark/fixture.test.ts (new)`
- `frontend/scripts/benchmark/fixture-check.ts (new)`
- `frontend/src/components/editor/checkpoint.ts (read)`
- `frontend/src/components/editor/protocol.ts (read)`
- `frontend/src/routes/index.tsx (read)`
- `frontend/src/fixtures/learningPath.ts (read)`
- `editor/crates/engine-core/src/document.rs (read)`

## Acceptance criteria

- [ ] The three fixtures have exactly 100/1000/10000 cards and 200/2000/20000 unique forward connections, stable IDs, one separate associated Task per Skill, and deterministic hashes.
- [ ] Validate no self/cyclic/dangling edges, duplicate IDs or broken Task associations. Same recipe/viewport produces the same semantic fixture; changed size produces a distinct identity.
- [ ] Load via the existing route and checkpoint restore using a dedicated browser profile. Live engine export, list and selected Task reflect new fixture IDs; original four-Skill fallback cannot satisfy the test.
- [ ] With selected Task panel open, initial primary/large visible card count is 200 and the planned path stays within 180–240. Browser clipping and actual DOM labels are checked; report submitted vs visible counts.
- [ ] Readiness includes real WebGPU drawing and actual HTML labels. Save/edit/reload a representative Task and inspect fresh UI/engine identity coherence outside timing.
- [ ] Malformed/mismatched fixture input is rejected without damaging another profile or silently substituting a smaller workload. Setup emits metadata consumed by L3-03.

## Planned verification commands

These commands for new scripts are an implementation contract; they are not available until the owning task creates them. Run from the repository root unless `cd frontend` is shown.

```bash
cd frontend && bun test scripts/benchmark/fixture.test.ts
cd frontend && bun run scripts/benchmark/fixture-check.ts --contract ../docs/benchmarks/p1/protocol.json --out ../.harness/t06/fixtures
```

## Handoff and escalation

Fixture generator/loader API, fixture manifests/hashes, browser evidence for all three counts and visibility, supported input dimensions, and source identity. No performance PASS is inferred.

Stop/escalate: Existing load path rejects the specified size, viewport geometry cannot fit, or normal loading needs a domain/protocol redesign. Preserve the failure rather than reducing the workload.

Keep one parent T06 harness baseline once implementation starts. Focused worker checks do not replace parent full verification and independent review. Preserve original criteria and source identity.

## Delivered handoff

- API: `frontend/scripts/benchmark/fixture.ts` reads the workloads from `protocol.json` (`loadBenchmarkContract`), generates them for a measured canvas (`generateBenchmarkFixture`), writes them (`writeFixtureFiles`) and accepts files back only when they reproduce the recipe exactly (`readFixtureFiles`); a malformed or smaller workload raises `FixtureRejectedError`.
- Supported input: sizes 100, 1,000 and 10,000 from contract `gurow-p1-v1`; any settled canvas whose z0 stays in 0.1–4. At the 1200×720 reference viewport with the list and Task panel open the canvas measures 592×628 CSS px (z0 ≈ 0.2617).
- `fixture-check.ts` builds the current source and writes, under its `--out` directory, the fixture files, `setup-metadata.json` (file SHA-256s, geometry, editor/application identity hashes, source and build identity, browser/adapter) for L3-03, and `fixture-report.json`/`.md` whose verdicts are derived from recorded observations.
- Visibility counts cards from the engine's delivered screen rects and HTML labels separately: a label box is 24 CSS px tall while a primary card is about 21, so at zoom 0.99 the check sees 200 cards but 210 labels.
- Limits: the routine check is headless Chromium with emulated DPR on the software WebGPU adapter, so it is functional evidence only; wheel deltas injected under DPR emulation arrive divided by the DPR, so the probe scales them; the planned path is probed in the browser at its extremes only, and connection counts are estimates. Chromium's Vulkan feature flag composites the WebGPU canvas as black here, so the check does not set it.
