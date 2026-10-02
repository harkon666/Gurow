# T06-L3-08 — Profile the primary pan, zoom and drag path and fix the measured bottleneck

> **Superseded in part by [ADR 0020](../../adr/0020-right-size-the-p1-gate-for-the-mvp.md) (2026-10-02).** The published issue body (`profile-and-fix-primary-bottleneck.issue.md`) is authoritative where this packet conflicts with it.

Status: approved execution packet, published as [#42](https://github.com/harkon666/Gurow/issues/42); implementation pending. Parent: [#7](https://github.com/harkon666/Gurow/issues/7). Contract: [gurow-p1-v4](../../benchmarks/p1/contract.md).

Executor recommendation: **Strong model for profiling, then bounded fixes with independent review**. Blocked by: **T06-L3-03**. Parent coverage: AC2, AC5. User stories: US80, US84.

## Observable outcome

The first complete v4 capture (T06-L3-03, 2026-09-30) FAILS every primary scenario on the reference host: pooled frame p50/p95 of 42.5/48.6 ms (pan), 72.8/84.9 ms (zoom) and 60.7/121.2 ms (drag) against a 20 ms p95 limit; drag latency proxy p95 167 ms against 50 ms, and pan/zoom held wheel input back for seconds (about 900 and 640 of 3,600 inputs reached the page). This task profiles that path, names the dominant cost with evidence, fixes it, and records a before/after v4 capture.

## Scope

Profile the existing Rust/Wasm/wgpu/React path on the primary workload before changing it. Fix only the bottleneck the profile names, within the existing architecture (ADR 0015, 0017). No speculative culling, binary protocol or new state owner unless the profile shows it is the dominant cost (contract §8). Do not hide or reduce labels, the Skill list or the Task sidebar, and do not change the contract, thresholds or workload.

## Required inputs

- Baseline evidence: `.harness/t06/primary/report-reduced.md` and raw logs from the T06-L3-03 v4 capture, or a fresh `bun run capture:p1` on the same environment series.
- Contract `gurow-p1-v4` §2 (current path), §6 (metrics) and §8 (failure handling); ADRs 0015 and 0017.

## Source pointers and file ownership

Verify current source before editing. Candidate costs visible in the baseline, to confirm or reject with a profile rather than assume:

- `frontend/src/components/editor/useWasmEditor.ts` — about 2,000 engine dispatches per 30 s drag run, JSON command/event parsing per dispatch, `LabelsUpdated` for every card.
- `frontend/src/components/editor/SkillCardOverlay.tsx` — about 450 label commits per drag run over 1,000 label DOM nodes.
- `editor/crates/editor-wasm/src/lib.rs` — `render_and_serialize_events` renders and serializes on every command.
- `editor/crates/renderer-wgpu/src/pipeline.rs` — per-render buffer writes and connection geometry for 2,000 connections.

## Acceptance criteria

- [ ] Record a profile of each primary scenario on the reference host (Chromium performance trace plus opt-in timers) that attributes frame time to engine dispatch/Wasm, JSON boundary, React label commit and layout, renderer submission and GPU, with the instrumentation's own cost stated.
- [ ] Name the dominant bottleneck per scenario with that evidence before changing code; a hypothesis the profile does not support is recorded as rejected.
- [ ] Fix the named bottleneck(s) within the existing architecture, with a focused test or benchmark assertion that fails on the old behavior where practical, and keep labels aligned with cards (US80) and the list/sidebar unchanged.
- [ ] Re-run `bun run capture:p1` on the same environment series and report before/after pooled p50/p95 frame interval and latency proxy per scenario plus page-delivery counts; reaching PASS is not required by this task.
- [ ] If a scenario still FAILS, write a follow-up naming the next measured bottleneck; never report a partial improvement as P1 acceptance.
- [ ] Full harness checks pass on the final source and an independent Standards/Spec review is requested before handoff.

## Planned verification commands

```bash
python3 scripts/harness.py check
cd frontend && bun run capture:p1
```

## Handoff and escalation

Profile artifacts with stage attribution, the named bottleneck and its evidence, the fix with its focused test, and before/after v4 reports on one environment series.

Stop/escalate: The profile shows the cost is inherent to an ADR decision (for example HTML labels at this scale, ADR 0017, or the JSON boundary, ADR 0015). Report the evidence and request a design reassessment instead of working around the decision.

Keep one parent T06 harness baseline once implementation starts. Focused worker checks do not replace parent full verification and independent review. Preserve original criteria and source identity.
