## Parent

https://github.com/harkon666/Gurow/issues/7

## What to build

The first complete v4 capture (T06-L3-03, 2026-09-30) FAILS every primary scenario on the reference host: pooled frame p50/p95 of 42.5/48.6 ms (pan), 72.8/84.9 ms (zoom) and 60.7/121.2 ms (drag) against a 20 ms p95 limit; drag latency proxy p95 167 ms against 50 ms, and pan/zoom held wheel input back for seconds (about 900 and 640 of 3,600 inputs reached the page). This task profiles that path, names the dominant cost with evidence, fixes it, and records a before/after v4 capture.

Profile the existing Rust/Wasm/wgpu/React path on the primary workload before changing it. Fix only the bottleneck the profile names, within the existing architecture (ADR 0015, 0017). No speculative culling, binary protocol or new state owner unless the profile shows it is the dominant cost (contract §8). Do not hide or reduce labels, the Skill list or the Task sidebar, and do not change the contract, thresholds or workload.

Stage: P1/T06 L3. Spec coverage: US80, US84. Parent criteria: AC2, AC5.

Contract: gurow-p1-v4 (ADR 0019, supersedes gurow-p1-v1 to v3). Primary workload remains 1,000 cards, approximately 200 visible cards, 2,000 connections, HTML labels enabled; p95 frame interval ≤20 ms and p95 input-to-frame latency proxy ≤50 ms, measured in-page (rAF frame intervals; input timeStamp to when the first rAF callback after canvas and label commit runs, plus one refresh interval) in a headed hardware browser. Three 30-second runs per pan/zoom/drag after a 10-second warm-up, pooled per scenario. The proxy does not observe compositor or scanout time and every report says so. Missing/invalid measurement is NOT_MEASURED. Comparison workloads do not carry primary pass thresholds. The contract snapshot below and the local execution packet provide exact settings, source pointers and planned commands.

## Acceptance criteria

- [ ] Record a profile of each primary scenario on the reference host (Chromium performance trace plus opt-in timers) that attributes frame time to engine dispatch/Wasm, JSON boundary, React label commit and layout, renderer submission and GPU, with the instrumentation's own cost stated.
- [ ] Name the dominant bottleneck per scenario with that evidence before changing code; a hypothesis the profile does not support is recorded as rejected.
- [ ] Fix the named bottleneck(s) within the existing architecture, with a focused test or benchmark assertion that fails on the old behavior where practical, and keep labels aligned with cards (US80) and the list/sidebar unchanged.
- [ ] Re-run `bun run capture:p1` on the same environment series and report before/after pooled p50/p95 frame interval and latency proxy per scenario plus page-delivery counts; reaching PASS is not required by this task.
- [ ] If a scenario still FAILS, write a follow-up naming the next measured bottleneck; never report a partial improvement as P1 acceptance.
- [ ] Full harness checks pass on the final source and an independent Standards/Spec review is requested before handoff.

## Blocked by

- [T06-L3-03 / #37](https://github.com/harkon666/Gurow/issues/37)

## Execution and handoff

Recommended executor: Strong model for profiling, then bounded fixes with independent review.

Profile artifacts with stage attribution, the named bottleneck and its evidence, the fix with its focused test, and before/after v4 reports on one environment series.

The profile shows the cost is inherent to an ADR decision (for example HTML labels at this scale, ADR 0017, or the JSON boundary, ADR 0015). Report the evidence and request a design reassessment instead of working around the decision.

## Approved measurement contract (self-contained snapshot)

<details>
<summary>gurow-p1-v4 — full contract</summary>

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

</details>

<details>
<summary>Normative numeric protocol (protocol-v4.json)</summary>

```json
{
  "contract_id": "gurow-p1-v4",
  "supersedes": "gurow-p1-v3",
  "decision_record": "docs/adr/0019-measure-p1-responsiveness-with-frame-time-and-an-in-app-latency-proxy.md",
  "report_schema": "gurow-p1-report-v4",
  "parent_issue": 7,
  "revised_at": "2026-09-30",
  "design_status": "complete_approved",
  "benchmark_status": "not_run",
  "metrics": {
    "frame_interval_ms": "consecutive requestAnimationFrame timestamp deltas during the active window",
    "input_to_frame_proxy_ms": "performance.now() when the first rAF callback after canvas and label commit of the input's revision runs, minus event.timeStamp, plus 1000/refresh_hz"
  },
  "thresholds_ms": {
    "frame_p95": 20,
    "input_to_frame_proxy_p95": 50
  },
  "primary": {
    "cards": 1000,
    "connections": 2000,
    "grid_columns": 25,
    "grid_rows": 40,
    "initial_visible_cards": 200,
    "html_labels": true,
    "visible_cards_median_min": 150,
    "visible_cards_median_max": 250
  },
  "comparisons": [
    {
      "cards": 100,
      "connections": 200,
      "grid_columns": 10,
      "grid_rows": 10,
      "runs_per_scenario": 1
    },
    {
      "cards": 10000,
      "connections": 20000,
      "grid_columns": 100,
      "grid_rows": 100,
      "runs_per_scenario": 1
    }
  ],
  "card_size_world": {
    "width": 180,
    "height": 80
  },
  "minimum_canvas_css": {
    "width": 960,
    "height": 540
  },
  "browser_zoom_percent": 100,
  "sampling": {
    "warmup_seconds": 10,
    "active_seconds": 30,
    "drain_seconds": 2,
    "runs_per_scenario": 3,
    "pooling": "per_scenario",
    "input_hz": 120,
    "minimum_sent_fraction": 0.8,
    "minimum_delivered_fraction": 0.8,
    "minimum_pooled_latency_samples": 1000,
    "minimum_pooled_frame_intervals": 1000,
    "visibility_sample_hz": 2,
    "motion_period_seconds": 2,
    "pan_drag_amplitude_cell_fraction": 0.1,
    "zoom_min_factor": 0.99,
    "zoom_max_factor": 1.01
  },
  "scenarios": [
    "pan",
    "zoom",
    "drag"
  ],
  "percentile": "nearest_rank_ceil",
  "verdicts": [
    "PASS",
    "FAIL",
    "NOT_MEASURED"
  ],
  "sanity_check": {
    "injected_delay_ms": 80,
    "minimum_p50_shift_ms": 60,
    "targets": [
      "application_update",
      "label_commit"
    ]
  },
  "unresolved_input_policy": "charge_until_drain_deadline",
  "validity": {
    "invalid_run": "driver sent fewer than minimum_sent_fraction of scheduled requests, focus/visibility loss, device loss, page or WebGPU error",
    "backpressure": "page observed fewer than minimum_delivered_fraction of scheduled inputs: the run stays valid and can FAIL, but a scenario with such a run cannot PASS"
  }
}
```

</details>

<details>
<summary>Reference environment</summary>

```json
{
  "observed_at": "2026-09-28",
  "purpose": "reference host inventory for measurement design; not an executed browser benchmark",
  "host": {
    "cpu": "13th Gen Intel Core i5-13500HX",
    "logical_cpus": 20,
    "physical_memory_bytes": 16462508032,
    "os": "Omarchy 4.0.4 (Arch-derived)",
    "kernel": "7.2.5-3-omarchy x86_64",
    "cpu_governor": "powersave",
    "ac_power_online": true,
    "pci_gpus": ["Intel Alder Lake-S UHD Graphics 8086:468b", "NVIDIA AD107M GeForce RTX 4050 Mobile 10de:28e1"],
    "nvidia_module_version": "610.57.04",
    "gpu_inventory_limitation": "nvidia-smi could not communicate with its driver during inventory; kernel module presence does not establish the active Chromium adapter"
  },
  "display": {"output": "eDP-2", "width": 1920, "height": 1200, "refresh_hz": 165, "compositor_scale": 1.5, "vrr": false},
  "browser_observed": {"executable": "chromium", "version": "152.0.7977.82 Arch Linux"},
  "run_requirements": {
    "headed": true,
    "hardware_webgpu": true,
    "viewport_css": [1200, 720],
    "device_pixel_ratio": 1.5,
    "browser_zoom_percent": 100,
    "dedicated_profile": true,
    "production_build": true
  },
  "must_capture_during_qualification": ["actual WebGPU adapter and fallback status", "actual adapter driver", "compositor version", "headed browser backend and flags", "viewport and canvas geometry after selection", "trace categories and parser version", "presentation feedback provenance", "clock mapping", "collector profile hash"],
  "qualification_result": "NOT_RUN"
}
```

</details>

<details>
<summary>Measurement research and primary sources</summary>

# P1 benchmark measurement research

Researched 2026-09-28 for issue #7, contract task A. This is measurement research and a protocol recommendation, not an executed benchmark or evidence that P1 passes. The normative project thresholds remain in [ENGINE_VALIDATION_PLAN.md](../ENGINE_VALIDATION_PLAN.md): primary workload p95 frame time ≤20 ms and p95 input-to-visible-response ≤50 ms during pan, zoom, and drag. A subsequent contract can pin the concrete reference device and interaction sequence.

## Findings from primary sources

| Mechanism | What it establishes | Limitation for this gate |
| --- | --- | --- |
| `requestAnimationFrame` and callback timestamps | Browser scheduling/rendering opportunities | The HTML rendering algorithm runs animation callbacks before style/layout. Callback timing is not proof of displayed pixels; even two callbacks do not establish which content was presented. [HTML rendering algorithm](https://html.spec.whatwg.org/multipage/webappapis.html#update-the-rendering). |
| `GPUQueue.onSubmittedWorkDone()` | Previously submitted queue work completed | No guarantee that the resulting canvas and HTML labels have been composited and displayed. Waiting for completion inside every production frame can change the workload. [GPUWeb API definition](https://gpuweb.github.io/types/interfaces/GPUQueue.html#onSubmittedWorkDone). |
| Event Timing / INP | Selected discrete input events and subsequent rendering | Continuous `pointermove`, `mousemove`, `wheel`, `touchmove`, and `drag` events are excluded; exposed duration also has 8 ms granularity. It cannot establish continuous canvas interaction p95. [Event Timing specification](https://www.w3.org/TR/event-timing/#sec-events-exposed). |
| Chromium presentation tracing | Frame pipeline, sometimes presentation feedback | Chromium explicitly distinguishes submission, swap, and presentation. Presentation timing can be estimated depending on platform. An unrelated frame appearing after an input is not evidence that its visual effect appeared. [Life of a frame](https://raw.githubusercontent.com/chromium/chromium/main/docs/life_of_a_frame.md). |
| Perfetto `chrome.event_latency` | EventLatency data, coalescing relationships, selected input/frame links | Documented `surface_frame_trace_id` and `display_trace_id` links cover gesture scroll updates; they can be null for other input types. Custom canvas wheel zoom and pointer drag must not be assumed to use the browser's scrolling pipeline. [Perfetto standard library](https://perfetto.dev/docs/analysis/stdlib-docs#chrome.event_latency). |
| Wayland presentation feedback | Platform presentation information when available | Chromium's Wayland implementation handles discarded/failed feedback and contains a fabricated-feedback fallback when the presentation protocol is unavailable. A trace field named presentation alone does not prove physical timing accuracy. [Pinned Chromium implementation](https://chromium.googlesource.com/chromium/src/+/60bb9b99d24346f544904556c683434f47790e7b/ui/ozone/platform/wayland/host/wayland_frame_manager.cc). |

These sources establish mechanisms and limitations. They do **not** establish that the installed browser, compositor, driver, and Gurow rendering path expose a complete trustworthy measurement chain. Browser/trace versions and observed behavior must be qualified on the reference machine.

## Recommended measurement contract

The following are project protocol choices inferred from those limitations, not requirements imposed by the cited standards.

### Two metrics and a separate validity result

1. Measure **presented-content frame intervals** between consecutive distinct visible editor updates during an active interaction. Retain long gaps and repeated/stale frames as time until the next actual update; do not count background compositor refreshes or animated benchmark counters as useful editor frames. Record continuous stalls through the end of the observation window. Report rAF intervals, CPU work, and GPU completion separately as diagnostics.
2. Measure **input-to-visible-response** from a documented input origin to the first presentation containing its corresponding intended canvas geometry and HTML label state. For a response split across frames, use the later presentation when both agree. Do not substitute the first generic browser paint or cursor movement. Record whether the origin is physical action, OS input, or browser-injected input; these are different measurement boundaries.
3. Return `PASS`, `FAIL`, or `NOT_MEASURED`/invalid for each metric and scenario. Missing presentation attribution, missing samples, fallback/software rendering, or an unqualified environment cannot yield `PASS`. A correct empty report must not pass.

### Qualification before collecting acceptance evidence

Start with a small validation run on the real headed, hardware-accelerated browser. Pin its version, trace configuration, trace parser version, compositor, GPU driver, refresh rate, viewport, DPR, and source/build identity. A development trace may use candidate `input`, `latencyInfo`, `cc`, `viz`, `gpu`, and user-timing categories, but the delivered collector must document categories actually supported and demonstrated in the pinned browser; this list is not a guaranteed recipe.

Demonstrate an input ID → application state revision → canvas submission plus label revision → actual composited presentation relationship separately for pan, wheel zoom, and card drag. Time adjacency or a shared rAF number is insufficient. Provide a raw trace example and a reproducible extraction result. Inspect whether reported presentation time is genuine platform feedback, an estimate, or unknown. Preserve clock-origin conversions and their calibration; never subtract unrelated clocks directly.

Validate attribution with controlled delays in the application update and independently in the label path. The measured endpoint must move with the delayed component. Remove these controls from acceptance runs. This is a useful falsification check, not by itself proof of every frame association. If no complete reliable mapping exists, retain traces for diagnosis and use optical evidence, or mark visible latency unmeasured. Do not promise a software-only collector before this qualification succeeds.

### Optical fallback

An external high-speed camera can record the physical input onset and actual monitor response in one clock domain. Research has used simultaneous physical-object/display capture to estimate visual latency; it also documents the limited precision of camera frame counting. [Microsoft Research latency measurement example](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/Juggling_Knibbe_MSR_TR.pdf).

For Gurow, predefine observable mouse/wheel movement or an independently calibrated actuator signal; a page-generated indicator starts too late to represent physical input. Record the actual Skill card and its HTML label, not merely a marker updated in JavaScript. Include movement/reversal samples throughout continuous interactions, not only pointer-down or the first wheel tick. For frame intervals, identify distinct rendered content at the same fixed screen region to control display scanout effects.

Require calibrated capture cadence, no undocumented frame interpolation/dropping, short exposure, and a documented bound for rolling shutter/scanout effects. At 240 fps the nominal frame period is 4.17 ms, but that alone is not the complete uncertainty bound. Store input and response onset intervals; if input is in `[a,b]` and response in `[c,d]`, latency lies in `[max(0,c-b), d-a]`. Compute percentiles of lower and upper bounds separately. PASS only if the upper-bound p95 meets the threshold; FAIL if the lower-bound p95 exceeds it; otherwise the result is inconclusive. A phone labeled 240 fps without validated capture timing cannot establish the gate.

### Sampling and accounting

- Suggested default: one fixed warm-up of 10 seconds per scenario followed by three independent 30-second active windows. Predeclare warm-up and resets; retain warm-up records separately, and never trim slow samples after seeing the result. Optical sampling may require a separate predeclared acquisition plan with enough independently identified samples.
- Compute nearest-rank p95 as sorted sample `ceil(0.95*n)-1`. Report sample count, duration, p50, p95, maximum, and worst run per scenario. Require every primary scenario/run to meet its thresholds; pooled p95 is supplementary and must not hide a failing drag run.
- Give every emitted, dispatched, applied, and presented input an accounting status. For coalesced inputs, retain original timestamps and map to the first displayed state incorporating their effect where this is demonstrable. A state superseded before display must remain visible in the accounting. Unknown or genuinely lost inputs must not disappear from the denominator.
- Report known no-ops separately using a rule fixed before measurement. A fixture accidentally outside the viewport or movement clamped at a boundary is not useful responsiveness evidence. Verify actual visible card/label/connection counts over the sequence.
- Specify input generation rate and scheduled versus actual dispatch time. A driver that awaits application completion before issuing each next event can hide overload. Include delayed dispatch, coalescing, dropped trace records, errors, focus/visibility changes, and device loss in validity checks.
- Preserve all attempted runs and exclusion reasons. A measurement failure requires a corrected rerun, not silent replacement of a slower run. Missing evidence is distinct from a proven threshold failure, and neither permits the parent gate to pass.

## Delegation consequence

The fixture generator, raw-record schema, deterministic statistics, and report validator can become bounded tasks for a fast model after the final contract is pinned. Qualifying presentation attribution is a separate specialist task: its deliverable is either a demonstrated collector path or a documented unsupported result with the optical protocol. Do not assign a fast model an open instruction to “measure visible latency” and let it choose a convenient proxy. Only after baseline evidence exists should optimization tasks be scoped.

## Revision 2026-09-30: practical gate (contract `gurow-p1-v2`, amended to `gurow-p1-v3`)

The recommendation above assumed that either a Chromium presentation join or a calibrated optical rig could be acquired. On the reference host neither was available: the qualified-collector attempt found 0/18 attributable input→canvas/label→hardware-presentation chains (#34), and the only camera delivers 30 fps (#41). Under `gurow-p1-v1` the latency criterion therefore could only be `NOT_MEASURED`, independent of engine performance.

Comparable canvas editors do not gate on photon latency:

- Figma gates editor performance on frame time (average and maximum) and CPU profiles, running a headless Chromium in GPU-enabled VMs on every pull request with a 20% regression margin, plus a small set of real laptops. Its public write-up does not describe input-to-photon or optical measurement. [Keeping Figma Fast](https://www.figma.com/blog/keeping-figma-fast/); [Figma, faster](https://www.figma.com/blog/figma-faster/).
- tldraw reports per-interaction `fps` and `p95FrameTime`, with Long Animation Frame attribution where available. [tldraw performance](https://tldraw.dev/sdk-features/performance).
- Event Timing still excludes continuous `wheel`/`pointermove` input (see the table above), so no standard browser API measures continuous-interaction latency.

The project therefore adopted [ADR 0019](../adr/0019-measure-p1-responsiveness-with-frame-time-and-an-in-app-latency-proxy.md): rAF frame intervals and an in-app input-to-frame proxy with a documented presentation estimate, simplified sampling, and a delay-injection sanity check. The limitations recorded in the table above (rAF is not proof of displayed pixels) remain true; v2 reports them as limitations instead of treating them as disqualifying. The sections above describe the superseded `gurow-p1-v1` design.

The first v2 sanity capture then confirmed the rAF limitation in a sharper form: Chromium stamps a frame when it is issued, so a callback delayed by a blocked main thread carries a timestamp from before the delay. An 80 ms injected label-commit delay moved the timestamp-based proxy by only 9.6 ms. Contract `gurow-p1-v3` therefore ends the proxy at `performance.now()` when the resolving callback starts. The first valid headed v3 capture then showed Chromium holding wheel input back behind 42–79 ms frames; contract `gurow-p1-v4` keeps such backpressured runs valid (they can fail, never pass) instead of classifying them as unmeasured.

</details>
