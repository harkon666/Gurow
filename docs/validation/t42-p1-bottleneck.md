# T06-L3-08 / GitHub #42 — P1 pan, zoom and drag bottleneck

Issue: https://github.com/harkon666/Gurow/issues/42. Base: `abc4a2f82c52ac4980011d3c27d8bddfb2ac4bf8`. Date: 2026-10-02. Gate workload per [ADR 0020](../adr/0020-right-size-the-p1-gate-for-the-mvp.md): contract `gurow-p1-v5`, 300 cards / 600 connections, about 200 visible. The 1,000-card run uses the historical `gurow-p1-v4` primary and is informational only.

The latency proxy ends at the first animation-frame callback after canvas submission and label commit, plus one refresh interval. It does not observe compositor output, scanout or physical pixels.

## Environment

Reference laptop (Hyprland, NVIDIA GeForce RTX 4050 Laptop GPU, Chromium 152, display 165 Hz), headed Chromium through XWayland with ANGLE-on-Vulkan, on AC power, in an empty workspace. Exact values are in each capture's `environment.json`. Captures in a workspace shared with another window are rejected by the runner (canvas below 960×540).

## Before: acceptance captures on the base source

Pooled over three 30-second runs per scenario after a 10-second warm-up. "Input reaching page" lists the page-delivered count of runs 1 / 2 / 3, out of 3,600 scheduled; it includes no-op inputs (wheel events that request no change), whose per-run counts follow in parentheses.

| Workload | Scenario | Frame p50 / p95 (ms) | Proxy p50 / p95 (ms) | Input reaching page | Verdict |
|---|---|---|---|---|---|
| 300 (v5 gate) | pan | 18.1 / 18.3 | 65 / 76 | 1,988 / 2,019 / 2,037 (no-op 10 / 15 / 14) | FAIL |
| 300 (v5 gate) | zoom | 24.3 / 30.4 | 4,208 / 8,156 | 1,392 / 1,407 / 1,413 (no-op 0 / 23 / 23) | FAIL |
| 300 (v5 gate) | drag | 6.1 / 6.2 | 18 / 22 | 3,600 / 3,600 / 3,600 | PASS |
| 1,000 (v4) | pan | 42.5 / 48.6 | 9,606 / 17,906 | 859 / 871 / 871 (no-op 0 / 14 / 0) | FAIL |
| 1,000 (v4) | zoom | 78.9 / 97.0 | 11,250 / 21,566 | 620 / 626 / 636 (no-op 10 / 0 / 0) | FAIL |
| 1,000 (v4) | drag | 78.8 / 127.4 | 100 / 176 | 3,600 / 3,600 / 3,600 | FAIL |

## Profile

`bun run trace:p1` (and the same command with `--contract ../docs/benchmarks/p1/protocol-v4.json` for 1,000 cards) records a Chromium performance trace per scenario: 3-second warm-up, then 5 seconds of the same 120 Hz scheduled input, with opt-in `gurow:*` stage measures (`traceStage`, active only when the driver sets `trace_stages`) and the V8 sampling profiler. The stage measures and the profiler add overhead, so trace numbers are attribution, not acceptance timings. The stage measures are needed because the trace alone is ambiguous here: Wasm dispatch, JSON/Zod parsing and the React label commit run inside the same `FunctionCall`, and the release Wasm has no function names. `traceStage` is a no-op unless the trace driver sets `trace_stages`; acceptance captures never set it. Values are renderer main-thread milliseconds per second (out of 1,000); browser rows are inclusive.

| Workload / scenario | Wasm dispatch | JSON + Zod parse | React label render→commit | Recalc style | Layout | Paint | PrePaint |
|---|---:|---:|---:|---:|---:|---:|---:|
| 300 pan | 130 | 10 | 57 | **247** | 28 | **376** | **144** |
| 300 zoom | 88 | 7 | 43 | **160** | **304** | **233** | **135** |
| 300 drag | 263 | 19 | 75 | 36 | 54 | 30 | 70 |
| 1,000 pan | 257 | 12 | 64 | **285** | 33 | 147 | **159** |
| 1,000 zoom | 147 | 5 | 45 | **163** | **350** | 86 | **153** |
| 1,000 drag | **789** | 36 | 31 | 6 | 21 | 8 | 29 |

### Named bottlenecks

1. **Pan and zoom (gate): browser rendering of every HTML label on every camera change.** The engine re-sent screen-space rectangles for all cards on each camera command, and React rewrote `left/top/width/height` of every label. Pan then spent most of the main thread on style recalculation and painting about 190 label paint items per frame; zoom additionally re-laid-out every label's text (8.3 ms mean per layout at 300 cards). Wasm dispatch and React rendering together were under a quarter of the cost.
2. **Drag at 300 cards (passing): Wasm dispatch per pointer event.** Its largest cost is `wasm-dispatch` (263 ms/s, one full command and render per `pointermove`), with label rendering below 80 ms/s; it already met both limits.
3. **Drag at 1,000 cards (informational): one full command and render per pointer event.** Each `PointerMove` ran a complete dispatch (about 13 ms at 1,000 cards) and pointer events were not merged per frame, unlike wheel input, so dispatch alone used about 79% of the main thread.

### Rejected hypotheses

- **JSON parsing and Zod validation of label events dominate.** Rejected: 5–36 ms/s in every scenario.
- **React reconciliation of the label list dominates.** Rejected: 31–75 ms/s.
- **GPU or renderer submission dominates pan/zoom.** Rejected for the gate: drag submits the same canvas and passes at 300 cards; pan/zoom differ only in how many labels change.

## Fix

Within ADR 0015 and ADR 0017 (labels remain HTML overlays positioned from engine data):

- **Labels in world space, camera as one transform.** `LabelLayout` now carries `world_rect`; camera-only commands (`PanCamera`, `ZoomAt`, `SetCamera`, panning `PointerMove`, `ResizeViewport`) emit `CameraChanged` but no `LabelsUpdated`. The overlay places labels at world bounds inside `#labels-camera`, whose CSS transform `translate(offset) scale(zoom)` is the engine camera. Pan and zoom therefore change one style property, and label text scales with zoom like the card geometry. Labels and camera commit together under one benchmark label revision, so the latency proxy still waits for both.
- **Drag pointer moves merged per frame.** `PointerMoveCoalescer` (like `WheelCoalescer`) dispatches only the latest `PointerMove` per animation frame; press and release flush a pending move first, so one completed drag is still one undo step.

Labels, the Skill list and the Task sidebar are unchanged otherwise. Regression tests (harness ticket checks `t06-l3-08-*`): `editor/crates/engine-core/src/tests.rs` (`test_camera_only_commands_move_labels_through_camera_changed` fails on the old engine, which re-sent labels on every camera command), `frontend/src/components/editor/pointerMoveCoalescer.test.ts` (latest move per frame, flush before release, dispose), the protocol schema test rejecting `screen_rect`, the camera-transform test in `selection.test.ts`, and fixture-check under contract v5.

Checks that read label geometry were updated for world-space labels: the runner's `visible_cards`, fixture-check's card rectangles and its wait for a moved card map each label's world rect through the computed transform of `#labels-camera`, and `editor-lifecycle-check.ts` compares rendered positions instead of `style.left/top`; the other scripts only changed the label selector to include the camera container.

Browser checks run on the fixed source: T02 and T03 smoke checks (label alignment while panning, zooming, dragging and connecting), T04, T05, editor-lifecycle, `check-canvas.ts`, and fixture-check under v4 and v5 (all PASS). The T01 `smoke-check.ts` fails its Task-panel glossary assertion ("Enrichment Task" badge) on the base commit `abc4a2f` as well; that failure predates #42 and is unrelated to labels.

### Label sharpness under zoom

The camera container uses `will-change: transform`. A Chromium 152 probe, headless and headed on the reference GPU (XWayland, ANGLE-on-Vulkan), zoomed a label to 400% (`matrix(4, 0, 0, 4, …)`) and screenshotted it through CDP with `will-change: transform` and with `will-change: auto`: in both browsers the two 420×220 crops were pixel-identical, so Chromium re-rasterizes the layer at the settled scale and the text stays sharp. Text may be briefly soft during a zoom gesture before that re-raster.

## After: acceptance captures on the fixed source

Same host, workspace setup and settings as the before series, on AC power, on the final source including the review fixes. Columns as in the before table.

| Workload | Scenario | Frame p50 / p95 (ms) | Proxy p50 / p95 (ms) | Input reaching page | Verdict |
|---|---|---|---|---|---|
| 300 (v5 gate) | pan | 6.1 / 6.2 | 29 / 36 | 3,593 / 3,592 / 3,588 | PASS |
| 300 (v5 gate) | zoom | 6.1 / 6.2 | 29 / 35 | 3,591 / 3,592 / 3,591 | PASS |
| 300 (v5 gate) | drag | 6.1 / 6.2 | 17 / 23 | 3,600 / 3,600 / 3,600 | PASS |
| 1,000 (v4) | pan | 18.3 / 24.3 | 2,145 / 4,817 | 1,573 / 1,700 / 1,682 (no-op 0 / 28 / 28) | FAIL |
| 1,000 (v4) | zoom | 18.3 / 24.3 | 2,364 / 4,505 | 1,609 / 1,643 / 1,653 (no-op 27 / 0 / 0) | FAIL |
| 1,000 (v4) | drag | 24.3 / 30.4 | 47 / 61 | 3,600 / 3,600 / 3,599 | FAIL |

The 300-card report's metric verdict is PASS (criteria AC2, AC3 and AC5 pass). Its overall gate verdict is NOT_MEASURED only because the capture carries no functional assertions or comparison runs; #39 adds the functional evidence and must align the reducer with ADR 0020 (see the contract note). This task does not claim P1 acceptance.

**Observed outlier.** Run `300-drag-2` contains one 1,303.9 ms animation-frame gap ending 29.8 s into the 30 s window (proxy max 2,312 ms). During it the page stayed responsive to the runner (`max_raf_age_while_responsive_ms` 2,008), dispatch CPU around it stayed at 2.7–5.4 ms and no page, focus or device event was recorded, so frames were held back outside the main thread's JavaScript work, presumably in the compositor or GPU path. It did not recur in the other eight runs or in an earlier after series on nearly the same source (drag frame max 30.4 ms). Its cause is not determined because this run was not traced. It does not change the pooled p95.

## Next measured bottleneck (1,000 cards, informational)

At 1,000 cards a camera-only command still costs about 12 ms of dispatch CPU (`cpu_work_ms` p50 12.1–13.5 ms; 1,457 pan dispatches used 17.7 s of a 30 s run), although it no longer serializes any labels. The remaining cost is therefore inside the Wasm engine and renderer on every camera change, most likely rebuilding and uploading card and connection geometry (2,000 connections) on each render; the 300-card dispatch costs about 2.3 ms. A follow-up should split that time with Rust-side timers before changing the renderer, for example keeping world-space geometry on the GPU and updating only the camera uniform on pan and zoom. Viewport culling of labels and geometry is the path beyond 1,000 cards.

## Limitations

Captures and traces come from one reference host. Trace numbers include profiler and stage-measure overhead. The latency proxy does not observe compositor output or scanout.
