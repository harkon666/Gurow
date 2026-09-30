# P1 benchmark contract — T06 / issue #7

Contract ID: `gurow-p1-v4`. Revised 2026-09-30. It supersedes `gurow-p1-v3`, which differed only in the §5 validity rule for page delivery; `gurow-p1-v2`, which differed also in the latency endpoint of §6; and `gurow-p1-v1` (prepared 2026-09-28 against source commit `0a3b9be96a8ef89ce74a22d011ce7e9ba49e996d`). All are retained in Git history, and no acceptance series completed under v2 or v3. The decision and its trade-offs are recorded in [ADR 0019](../../adr/0019-measure-p1-responsiveness-with-frame-time-and-an-in-app-latency-proxy.md). P1 remains unproven.

Parent: [GitHub #7](https://github.com/harkon666/Gurow/issues/7), under [MVP #1](https://github.com/harkon666/Gurow/issues/1). Authority: [prototype scope](../../PROTOTYPE_PLAN.md), [validation plan](../../ENGINE_VALIDATION_PLAN.md), ADRs [0015](../../adr/0015-own-live-editor-state-in-rust.md), [0016](../../adr/0016-save-editor-snapshots-with-revision-checks.md), [0017](../../adr/0017-use-webgpu-geometry-with-html-labels-and-list-navigation.md), [0019](../../adr/0019-measure-p1-responsiveness-with-frame-time-and-an-in-app-latency-proxy.md). No learning-domain rule, numeric threshold, or P2 prerequisite is changed.

Normative numeric settings are in [protocol-v4.json](protocol-v4.json). The older [protocol.json](protocol.json) is the frozen `gurow-p1-v1` protocol, read only by the historical v1 qualification driver. [Reference environment](reference-environment.json) records the observed host. [L3 execution packets](../../tickets/t06-l3/README.md) map this contract to deliverables and original ACs. Method evidence is in [measurement research](../../research/P1_BENCHMARK_MEASUREMENT.md).

## 1. Decisions

- Use the existing application route and Rust/Wasm/wgpu path, including HTML labels, Skill list, Task sidebar, and normal local persistence callbacks. The benchmark must not replace the app with an isolated lightweight renderer or hide labels, list or sidebar.
- Use a production build, a dedicated Chromium profile, and a headed, visible, hardware-accelerated browser on a real GPU. Headless or software-rendered runs are diagnostic only.
- Measure two metrics from in-page instrumentation (§6): `frame_interval_ms` from animation-frame timestamps, and `input_to_frame_proxy_ms` from input `timeStamp` to when the first rAF callback after canvas and labels committed that input's state runs, plus one nominal refresh interval. No trace-level presentation join, hardware presentation timestamp or optical rig is required.
- For each of pan, zoom and drag: fixed 10-second warm-up, then three 30-second runs. The three runs are pooled into one per-scenario distribution; each scenario must pass on its own. Per-run p95 is reported, not gated.
- Evaluate nearest-rank p95 against the original limits: frame interval ≤20 ms and input latency proxy ≤50 ms.
- Primary fixture: 1,000 cards, 2,000 unique directed connections, about 200 visible cards, HTML labels enabled. Comparison fixtures: 100 cards/200 connections and 10,000 cards/20,000 connections, reported without thresholds and without a capacity promise.

Changing this protocol again requires a new contract ID and a recorded reason before the next acceptance series; results from different contract IDs are never combined.

## 2. Current path and instrumentation boundaries

`useWasmEditor.ts` sends JSON commands synchronously to `WasmEditor.dispatch_command`. `render_and_serialize_events` applies the CPU document change, invokes the renderer, then returns events. `WgpuRenderer.render` writes buffers, builds connection geometry, submits work and calls `present()`. React commits `LabelsUpdated` afterwards. Therefore return from `dispatch_command` alone does not show that labels have caught up; the proxy endpoint in §6 waits for both.

Normal local persistence for camera changes and completed operations stays enabled. Existing T05 browser checks (headless, DPR 1) remain functional regression checks only. Instrumentation is opt-in through the existing benchmark hooks and must not add GPU readback or queue waits to the timed path.

## 3. Environment

Run on the reference laptop in `reference-environment.json`, on AC power, with the internal display at its native refresh rate. Record at run start: CPU, physical RAM, OS/kernel, compositor, CPU governor, browser executable/version and flags, the GPU adapter actually selected by WebGPU and its driver, whether it is hardware, display refresh rate, window inner size, `devicePixelRatio`, canvas CSS bounds and backing size. These are recorded facts, not locked settings; a changed adapter, browser major version or refresh rate starts a new series.

Use whatever headed window the desktop provides, provided the canvas is fully visible and unobscured and its CSS size is at least 960×540. Keep browser zoom at 100%. Select the designated fixture Skill and open its Task panel before the timed runs. Use a foreground tab, no DevTools UI, no throttling, and avoid unrelated heavy workloads; log focus/visibility changes and interruptions.

## 4. Fixture contract

The fixture generator (delivered by #35) returns editor cards/connections, separate application Skill/Task payload, initial camera, and a manifest with count/hash/geometry parameters. Stable IDs `p1-skill-00000` etc.; one deterministic Task per Skill with nonempty title/description. Card size is 180×80 world units. No progress/Review/XP data inside editor snapshots.

For 100/1,000/10,000 cards use grids 10×10, 25×40, 100×100 in row-major ID order. Add forward edges by increasing gap `g=1,2,...`, source `i=0..N-g-1`, taking `(i,i+g)` until `2*N` edges exist. No duplicate, self, cross-Path or cyclic edge is possible; validate through the normal loading boundary.

With settled canvas CSS size W,H, target a 10-column × 20-row viewport: `z0 = min(1, W/(10*220), H/(20*120))`, failing setup if z0 is outside 0.1–4. Cell pitch `px=W/(10*z0)`, `py=H/(20*z0)`, each card centered in its cell, viewport centered on the interior 10×20 block (the 100-card comparison uses a centered 10×10 block). Persist W, H, z0, pitches, start indices and camera offsets.

Seed the normal checkpoint and camera storage in the dedicated profile, then load `/` normally; read-back must match the fixture hash. Timed interactions go through browser input, never direct engine commands.

Visibility is a workload sanity check. Record visible card count, DOM label count and submitted primitive count at the start of each run and at 2 Hz during it (cheap bounding-box intersection with the canvas rectangle is sufficient). A primary run is invalid if the median visible card count lies outside 150–250.

## 5. Interaction sequence and sampling

For each N in order 100 → 1,000 → 10,000, run pan → zoom → drag. For each scenario: load the fixture, select/open the center Skill, settle, warm up for 10 seconds with that scenario, restore the initial camera/card state, then capture three 30-second runs, restoring state between runs. Comparison fixtures may use one run per scenario. Keep every attempt and its invalidation reason; do not pick the fastest attempts.

Drive input through Puppeteer/CDP at a nominal 120 Hz using an absolute schedule (`start + k/120 s`) without awaiting rendering, with a triangular 2-second motion. Pan: plain wheel moving camera X between ±0.1 cell pitch. Zoom: Ctrl+wheel at canvas center between 0.99·z0 and 1.01·z0, with deltas from the `exp(-deltaY*0.005)` rule. Drag: real pointer down on the selected center card, horizontal moves between ±0.1 cell pitch, pointer up after the run.

A run is valid when the driver sent at least 80% of the scheduled requests (2,880 of 3,600), the tab stayed visible and focused, and no device loss, page error or WebGPU validation failure occurred. Sending is a load check on the driver, not a speed result; an invalid run is rerun, not dropped silently. Separately record how many inputs the page observed, capped at the requests sent. When the page observed fewer than 80% of the schedule, the browser held input back behind a busy application (backpressure): the run stays valid, its latency counts the queued inputs it did observe, and it can FAIL but never PASS. Requests still unacknowledged at the end of the drain are recorded as backpressure, not as an error. A pooled scenario needs at least 1,000 latency samples and 1,000 frame intervals.

## 6. Metric definitions

### Frame interval

`frame_interval_ms` is the difference between consecutive `requestAnimationFrame` timestamps during the active window. Long tasks, GC pauses and stalls appear as long intervals and are kept. A stall still open at the end of the window is recorded as the time until the window ends. Report p50, p95, max and the count of intervals over 50 ms.

### Input latency proxy

For each input event delivered to the page (each `wheel` event; each `pointermove` including its coalesced events via `getCoalescedEvents()`), record `event.timeStamp` and the editor state revision that input produced; coalesced pointer events share the revision of the event that delivered them but keep their own timestamps. Record the revision committed to the canvas (after `dispatch_command` returns) and the revision committed to the HTML labels (after React commits `LabelsUpdated`). In the animation-frame loop, the first frame whose callback runs after both committed revisions are at least the input's revision is that input's endpoint, timed by `performance.now()` read at the start of that callback:

`input_to_frame_proxy_ms = callback_start − event.timeStamp + 1000 / refresh_hz`

The rAF timestamp is not the endpoint: Chromium stamps a frame when it is issued, so a frame whose callback was delayed by a busy main thread carries a timestamp from before the delay, and the v2 formula (`rAF_timestamp − event.timeStamp`) hid an injected 80 ms label-commit delay (+9.6 ms shift in the v2 sanity capture). The added refresh interval is a fixed, documented estimate of presentation; the report also keeps the raw value without it. Inputs that are superseded before any frame are charged against the first frame that includes a later revision. An input with no endpoint by 2 seconds after the window ends is charged the time until that drain deadline. Known no-op inputs (movement clamped at a limit) are counted and excluded by a rule fixed before the run.

Every report states the limitation: the proxy covers input queueing, application, renderer submission and label commit on the main thread; it does not observe compositor output, scanout or physical pixels.

### Sanity check

Before an acceptance series, run one short pan capture with an 80 ms delay injected into the application update, and another with an 80 ms delay injected into label commit, using the existing benchmark hooks. Each must raise the proxy's p50 by at least 60 ms relative to an undelayed capture. Delays are disabled during acceptance runs and the report records that they were off.

Chromium trace data (for example EventLatency) may be captured as optional diagnostics; it is never required and never substitutes for the proxy.

## 7. Statistics, verdict and report contract

Use nearest-rank p95: sort n observations ascending and take rank `ceil(0.95*n)`. Do not interpolate or round before comparing. Exactly 20 ms / 50 ms meets the limit. Report per scenario (pooled) and per run: n, duration, p50, p95, max.

Report schema `gurow-p1-report-v4` sections: `identity` (contract ID/hash, source commit, dirty flag, build hash, runner version), `environment` (§3 fields), `fixture` (size, hash, geometry, visibility records), `runs` (attempts, input counts, validity reasons, statistics), `functional` (AC1 results), `diagnostics` (initialization to first render, process RSS, JS heap and Wasm memory when available, draw calls, upload bytes, JSON boundary calls/bytes/duration; null plus reason when unavailable, never a fabricated zero), `comparisons`, `artifacts` (path, SHA-256, role), and `gate` (each original AC verdict and overall verdict).

Verdicts are `PASS`, `FAIL`, `NOT_MEASURED`. A valid pooled scenario over a limit is FAIL. A scenario without enough valid runs or samples is NOT_MEASURED, and so is a scenario within the limits that includes a backpressured run (§5). Overall is FAIL if any required criterion fails, otherwise NOT_MEASURED if anything required is missing, otherwise PASS. A missing comparison or diagnostic leaves AC4 incomplete but does not fail the primary performance criterion.

## 8. Functional and harness acceptance

AC1 requires real browser actions covering create/select, pan/zoom/drag, a valid connection and unchanged graph on a rejected cycle, Task edit, one-step drag undo/redo, semantic reload of IDs/positions/connections/Task contents, keyboard/list navigation without WebGPU, and real GPU device loss with recovery and retry. Run it outside the timed windows, reusing T04/T05 assertions where useful.

T06 work uses one harness session pinned to parent #7 and its implementation base, per [the harness workflow](../../agents/harness.md). Register T06 acceptance commands, build current source before browser checks, keep working evidence under `.harness/`, and require full checks plus independent review before claiming readiness. After a measured failure, open a bounded optimization task naming the observed bottleneck; do not add speculative optimizations first. Parent #7 and downstream #8 stay gated until the required evidence passes.
