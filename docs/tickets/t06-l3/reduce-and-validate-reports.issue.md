## Parent

https://github.com/harkon666/Gurow/issues/7

## What to build

A report command consumes the contracted evidence records, validates provenance and completeness, computes reproducible statistics, and writes JSON plus a readable report that cannot pass on missing or invalid input.

Implement report-v1 types/validation, reducer, CLI and synthetic evidence tests using the normative report sections and numeric protocol. Tests and generated example reports are explicitly synthetic, not P1 evidence. No browser timing acquisition or made-up hardware values.

Stage: P1/T06 L3. Spec coverage: US84. Parent criteria: AC2, AC3, AC4, AC5.

Contract: gurow-p1-v1. Primary workload remains 1,000 cards, approximately 200 visible cards, 2,000 connections, HTML labels enabled; p95 frame interval ≤20 ms and p95 input-to-visible response ≤50 ms. Use three 30-second active windows per pan/zoom/drag after fixed 10-second warm-up, reference headed hardware browser and qualified presentation evidence. CPU/rAF/queue-completion timings cannot substitute for visible response. Missing/invalid measurement is NOT_MEASURED. Comparison workloads do not carry primary pass thresholds. The reviewed contract and local execution packet provide exact numeric settings, source pointers and planned commands.

## Acceptance criteria

- [ ] Implement nearest-rank p95 and report n/duration/p50/p95/max per scenario/run; compare unrounded values to 20/50 ms. Boundary tests prove equality passes and values above fail.
- [ ] Every primary run/scenario is required. A slow drag cannot be hidden by pooled pan/zoom data, average percentiles, or counting one large slow coalesced group as one latency sample; zero/insufficient samples cannot pass.
- [ ] Reject missing/unqualified/fabricated presentation provenance, mismatched contract/profile/source identities, broken artifact hashes, mixed clocks, invalid visibility, unclassified input and censored unresolved observations.
- [ ] For bounded optical measurements, p95 upper bound <= threshold passes, lower bound > threshold fails, overlap stays NOT_MEASURED. Physical and injected origins stay separate.
- [ ] Missing comparisons/required AC evidence leave AC4/overall incomplete; slow completed comparisons do not apply primary thresholds. Optional counters use null plus reason, with AC4 limitations visible.
- [ ] Emit reproducible JSON and readable Markdown with raw-artifact references and separate functional/metric/gate verdicts. Synthetic reports have an explicit synthetic marker and cannot satisfy a real gate.
- [ ] Tests include all-PASS, valid FAIL, NOT_MEASURED, mixed outcomes, malformed counts, missing artifact, censored terminal interval, a large slow coalesced group among fast singleton groups, exact threshold and no-default-to-zero cases. Exit codes are 0 only for complete real PASS in gate mode, 1 for proven failure and 2 for missing/invalid evidence.

## Blocked by

Task A contract pinned; no other L3 blocker.

## Execution and handoff

Recommended executor: Flash candidate.

Typed report contract/CLI, deterministic reducer tests and clearly marked synthetic examples for other workers. Source constants and timestamp meaning remain governed by contract v1.

An input record cannot establish causality, units or source identity. Return validation error/NOT_MEASURED instead of inferring omitted facts.

## Approved measurement contract (self-contained snapshot)

<details>
<summary>gurow-p1-v1 — full contract</summary>

# P1 benchmark contract — T06 / issue #7

Contract ID: `gurow-p1-v1`. Prepared 2026-09-28 against source commit `0a3b9be96a8ef89ce74a22d011ce7e9ba49e996d`. Task A is complete as a measurement-design deliverable. No collector has been qualified and no benchmark has run under this contract; P1 remains unproven. The user approved this contract and the L3 breakdown for publication on 2026-09-28.

Parent: [GitHub #7](https://github.com/harkon666/Gurow/issues/7), under [MVP #1](https://github.com/harkon666/Gurow/issues/1). Authority: prototype scope, validation plan, ADRs 0015, 0016, 0017. No learning-domain rule, threshold, or P2 prerequisite is changed.

Normative numeric settings are in protocol.json. Reference environment separates observed host facts from run-time requirements. L3 execution packets map this contract to deliverables and original ACs. Method evidence and links are in measurement research.

## 1. Decisions fixed by A

- Use the existing application route and Rust/Wasm/wgpu path, including HTML labels, Skill list, Task sidebar, and normal local persistence callbacks. The benchmark must not replace the app with an isolated lightweight renderer.
- Use a dedicated Chromium profile and a production build from the recorded source. The acceptance run is headed, visible, hardware accelerated, on the local reference laptop and its current 165 Hz internal display. Headless/software runs are diagnostic or functional evidence only.
- Attempt a qualified Chromium presentation collector first. Qualification must demonstrate input → state → canvas and HTML label presentation for all three interactions. If that chain cannot be demonstrated, the primary latency remains `NOT_MEASURED`; optical evidence is the defined alternate acquisition path. There is no fallback to rAF, CPU duration, queue completion, or assumed next paint for a passing result.
- Use three separate 30-second windows for each of pan, zoom, and drag after a fixed 10-second warm-up. Every primary scenario/run must pass; averaging runs or pooling scenarios cannot hide a failure.
- Evaluate nearest-rank p95 against the original limits: frame interval ≤20 ms and input-to-visible response ≤50 ms. Report other statistics without adding product pass thresholds.
- Primary fixture: 1,000 cards, 2,000 unique directed connections, initially 200 geometrically visible cards, HTML labels enabled. The permitted 180–240 visibility band operationalizes “approximately 200” during motion. This is a workload-validity rule, not a new product-capacity claim.
- Comparison fixtures: 100 cards/200 connections and 10,000 cards/20,000 connections. Report them without applying the primary thresholds. A slow comparison is a result; missing comparison evidence leaves AC4 incomplete.

These sampling and reference-device choices are project-specific protocol decisions. Primary sources establish the API limitations, not these numeric choices. Changing this protocol requires a versioned explanation before the next acceptance series; old and new results must not be silently combined.

## 2. Current path and instrumentation boundaries

At the inspected commit, `useWasmEditor.ts` sends JSON commands synchronously to `WasmEditor.dispatch_command`. `render_and_serialize_events` applies the CPU document change, invokes the renderer, then returns events. `WgpuRenderer.render` writes buffers, builds connection geometry, submits work and calls `present()`. React handles `LabelsUpdated` later. Therefore, return from `dispatch_command` does not establish that canvas pixels and HTML labels reached the display together.

The route saves camera changes and completed operations through normal local persistence. Keep those costs enabled. Existing T05 browser checks launch headless Chromium at DPR 1; they remain functional regression checks and are not the reference performance environment. Existing `harness.json` registers T04/T05 only; T06 acceptance registration is a deliverable of L3-06.

Exact source pointers, allowed edits and planned test paths belong to the local execution packets, pinned to the inspected commit. A worker checks live files before relying on a pointer. Graphify can locate candidates; live source, issue requirements and actual logs decide acceptance.

## 3. Reference environment

Use the laptop described in `reference-environment.json`, AC power connected, CPU governor `powersave`, internal display eDP-2 at 1920×1200, 165 Hz, compositor scale 1.5, VRR off. Keep these settings; do not silently switch to 60 Hz, another display or a different governor for a faster result. Record deviations as a separate environment/series.

Browser viewport: 1200×720 CSS pixels, browser zoom 100%, actual `devicePixelRatio` 1.5. Record actual inner size, screen properties, canvas CSS bounds and backing size; device emulation cannot substitute for validating the actual headed window. Scroll the full canvas into view and keep it unobscured. Select the designated fixture Skill and open its Task panel before freezing the viewport/camera. Do not hide the list, Task panel or label nodes to improve timing. If that configuration cannot fit the visible desktop, qualification fails with a geometry report instead of measuring a clipped canvas.

Chromium observed at design time: 152.0.7977.82. Record executable/version, command line, browser backend, compositor version, kernel, GPU adapter actually selected by wgpu, its hardware/software status, driver, CPU, physical RAM, refresh rate and DPR at run start. The machine exposes both Intel UHD and NVIDIA RTX 4050; PCI presence and `HighPerformance` preference do not prove which adapter Chromium uses. The actual adapter must be captured and locked for a comparison series. A version/adapter/driver change starts a new series and requires qualification again.

Use a dedicated browser profile, foreground tab, no CPU/network throttling, no DevTools UI or unrelated GPU/CPU workloads. Log interruptions, focus/visibility changes, thermal/power observations and memory pressure. Do not kill unrelated user applications. Pause the attempt when contention prevents a controlled run. No OS/browser installation, GPU-driver repair or desktop reconfiguration is part of these packets.

## 4. Fixture contract

The fixture generator returns editor cards/connections, separate application Skill/Task payload, initial camera, and a manifest containing count/hash/geometry parameters. Stable IDs: `p1-skill-00000` etc.; one deterministic Task per Skill with nonempty title/description. Card size is 180×80 world units. Keep current HTML label style and text density. Set no progress/Review/XP data inside editor snapshots.

For 100/1,000/10,000 cards use grids 10×10, 25×40, 100×100 respectively, in row-major ID order. Add forward edges by enumerating increasing gap `g=1,2,...`, then source `i=0..N-g-1`, taking `(i,i+g)` until `2*N` edges exist. No duplicate, self, cross-Path or cyclic edge is possible; validate these properties through the normal loading boundary as well as fixture checks.

With settled canvas CSS dimensions W,H, target a 10-column ×20-row viewport for primary/large workloads. Set `z0 = min(1, W/(10*220), H/(20*120))`; fail geometry setup if z0 is outside 0.1–4. Let world cell pitch be `px=W/(10*z0)`, `py=H/(20*z0)`, and center each 180×80 card inside its cell. Center the viewport on a contiguous interior 10×20 block (start indices `floor((cols-10)/2)`, `floor((rows-20)/2)`). The 100-card comparison instead uses a centered 10×10 block and substitutes 10 for the row target. Persist exact W,H,z0,pitches,start indices and resulting camera offsets. Do not regenerate a different layout after seeing its speed.

For setup only, seed the normal checkpoint and camera storage in the dedicated profile using the current validated envelope/keys, then load `/` normally. Do not copy local user storage. Application path/account identity must match current route constants; benchmark isolation comes from the dedicated profile. Read-back on the live engine and UI must match the fixture hash/identities. Timed interactions go through browser input, never direct engine commands.

Visibility means positive-area intersection with the actual clipped canvas rectangle. Record card and HTML-label bounds separately, total DOM label count, submitted primitive count, and connection-mesh/viewport intersection count. For connections use the renderer's actual tessellated geometry or equivalent recorded segment geometry; label conservative bounding-box counts as estimates and do not call them exact intersections. Record min/max/median counts and counts across phase boundaries. Validate the complete scripted path and actual delivered camera/card states against geometric visibility outside timing; 10 Hz observations alone do not establish an uninterrupted visibility band. Unknown intervening geometry makes the visibility result incomplete. Avoid synchronous DOM reads/GPU readback on every hot-path event; qualify instrumentation cost and sample independently at 10 Hz, with full deterministic geometry validation outside the timed run. If visibility leaves the primary band, the whole attempt is invalid; do not discard only expensive samples.

## 5. Interaction sequence and sampling

For each N in order 100 → 1,000 → 10,000, run scenarios in order pan → zoom → drag. Each scenario has three separately initialized repetitions. Load the same fixture/camera, select/open the designated center Skill, settle readiness, warm up for 10 seconds using that scenario, restore initial state outside timing, settle, then capture 30 seconds. Reset before every repetition. Preserve all attempts and reasons for invalidation; never select the fastest three attempts.

Define an intended 120 Hz input schedule with an absolute monotonic clock: input k has deadline `start + k/120 seconds`. Drive a triangular motion with period 2 seconds. Pan uses ordinary wheel input (no Ctrl/Meta), deltas that move camera X between ±0.1 of one screen-space cell pitch. Zoom uses Ctrl+wheel at canvas center to move camera zoom between 0.99*z0 and 1.01*z0; derive wheel deltas from the existing `exp(-deltaY*0.005)` rule. Drag starts on the selected center card, preserves its grab offset, and moves horizontally between ±0.1 cell pitch while the button remains down; release after the active window and record the operation save separately. No teleporting via `SetCamera` during timing.

Use browser input injection via Puppeteer/CDP, with Ctrl explicitly pressed/released for zoom and actual pointer down/move/up for drag. Do not dispatch synthetic DOM events or call engine commands for the timed workload. Record scheduled time, injection-call time, browser input timestamp, actual delivery times, queueing and any coalescing. Do not await rendering before scheduling the next event. Do not replace missed deadlines with an unrecorded burst. Input dispatch latency and recorder lag remain visible in the raw log.

For an automated run, require at least 3,420 of the intended 3,600 input requests to enter the browser during the active 30-second window (95% pacing validity). Keep late/missing counts and all response tails. This checks load generation, not application speed. Failure to meet the pacing rule is `NOT_MEASURED`, unless an independent input driver establishes the required load. A hung or overloaded app cannot earn PASS by slowing down the sender. Retained coalesced groups can have fewer entries than requests; require at least 300 response groups and 300 presented intervals per run for a valid distribution. These are predeclared sampling-validity rules, not statistical confidence claims.

Keep all long intervals, GC pauses and stalls. Drain for up to 2 seconds after the active window to account for in-flight input; draining does not extend the emission window. Retain an unfinished stall as a right-censored interval and unresolved response as missing evidence, never silently drop it. Browser errors, device loss during timing, backgrounding, trace loss or changed environment invalidate the run. The separate functional recovery test intentionally injects device loss outside performance windows.

## 6. Metric definitions and acquisition qualification

### Frame interval

`presented_editor_frame_interval_ms` is elapsed time between consecutive distinct, coherent editor-content presentations during active motion. Include dropped/stale-frame time in the gap to the next update. Do not count unrelated compositor frames, cursor-only updates or animated measurement overlays. Record canvas-only/label-only transitional frames and their time until coherent presentation. CPU render duration, GPU queue duration and rAF cadence are separate diagnostic fields. This pins the user-visible frame-cadence interpretation of the parent target.

### Input-to-visible response

The primary automated input origin is the browser-recorded original injected input timestamp before main-thread dispatch, on a demonstrated trace clock. It includes browser queueing and application/render/compositor work; it does not claim physical mouse-switch/USB latency. Never begin at handler entry or after `dispatch_command`. Optical acquisition starts from observed physical input and reports that distinct, wider boundary; results from different boundaries are not pooled. It may support acceptance only under the equivalent-load rule below.

The endpoint is the first presented frame containing the intended camera/card state and matching HTML labels. If they appear at different times, use the later coherent presentation. Record causality through input ID, state revision, canvas and label revision, and presented-frame ID. Timestamp proximity, an rAF number or the next generic paint is insufficient.

The acceptance statistical unit is each original delivered input. An input response group provides attribution only: a singleton contains one input; a demonstrated browser/app coalescing group contains all superseded/combined updates incorporated into its final requested state. Map every original member to the first coherent presentation of the net state and calculate its own original-input-to-presentation latency. If only the oldest group timestamp is trustworthy, assign that conservative oldest-to-presentation latency to every member; never count a large group as one acceptance sample. Preserve every member, timestamps, event kind and reason; do not choose the newest timestamp to hide queueing. Unweighted group percentiles are diagnostic only, since they can hide many slow inputs in one large group. Coalescing rules must be fixed in the collector's qualification, not invented by the report reducer. Every emitted request must be classified as presented-group member, known predeclared no-op, late/not-delivered, or unresolved. Unknown/lost responses make the run ineligible for PASS. A frozen app producing one group for a whole run fails sampling validity. Report group-size distribution and max/p95 latency alongside dropped/late counts.

### Qualified collector requirements

L3-01 must demonstrate the mapping separately for ordinary wheel pan, Ctrl+wheel zoom and pointer drag in the actual application. Pin trace categories, browser build, parser version and timestamp units/clock conversions in a collector profile with a hash. Chromium/Perfetto APIs for native scrolling are only candidate tools: they do not guarantee mapping for this custom canvas. Inspect platform presentation-feedback flags; synthesized/estimated/unknown presentation times cannot satisfy this profile.

Keep raw traces and a hand-auditable example for each interaction. Validate the chain with controlled 80 ms application delay and independent 80 ms HTML-label delay; the affected latency and delayed component must appear in the trace-derived endpoint. Injection must be disabled in acceptance runs. Also reject fabricated, missing, negative, misordered, duplicate and mismatched clock/revision/frame records. Delaying tests is a falsification check, not a replacement for real presentation provenance.

If the installed stack cannot expose this chain, L3-01 delivers a documented `UNSUPPORTED` collector result. L3-02 and L3-04 may still progress. L3-03 cannot fabricate primary metrics. Use the optical path below or escalate measurement feasibility; #7 stays open. This is an explicit runtime qualification outcome, not an undecided metric definition.

### Optical acquisition alternative

Use a calibrated external high-speed camera or equivalent hardware observing physical input onset and the actual display in the same clock domain. A page-rendered marker is not input onset. Capture card geometry and corresponding HTML label at fixed screen regions, including reversals during continuous pan/zoom/drag. Preserve native video, frame timestamps, camera mode/exposure, frame-drop/interpolation checks, scanout/rolling-shutter treatment and calibration artefacts. Nominal 240 fps alone is insufficient.

Before capture, the qualified optical profile fixes the same workload/30-second windows/three runs, reproducible physical or actuator motion corresponding to the scenario path, and identifies at least 300 response groups plus 300 content intervals per run. Require a calibrated physical/actuator input-load profile equivalent to the 120 Hz injected protocol: 3,420–3,780 original input updates within each 30-second active window, matching movement amplitude and scenario path, with each original update accounted for in latency statistics. Use independent input evidence to establish cadence and causal grouping. Lower-rate or otherwise non-equivalent optical runs are diagnostic only and cannot replace acceptance evidence. Never pool physical and injected-input series. If the optical setup cannot support this acquisition or attribution, report `NOT_MEASURED` rather than relaxing the sample rule after seeing results.

For input onset `[a,b]` and response onset `[c,d]`, latency bounds are `[max(0,c-b), d-a]`, incorporating clock/capture/scanout uncertainty. For frame intervals use analogous onset bounds. If coalescing is only resolved at group granularity, conservatively repeat the oldest group latency bound for every member, as for automated acquisition. Compute lower- and upper-bound percentiles separately. PASS requires upper-bound p95 within the original threshold. FAIL requires lower-bound p95 beyond it. An interval straddling the threshold is `NOT_MEASURED` with reason `uncertainty_overlaps_limit`. Raw video must allow another reviewer to repeat the annotation. No optical equipment availability is assumed in this contract.

## 7. Statistics, verdict and report contract

Acceptance latency uses the per-original-input observations above, never an unweighted group distribution. Any unresolved terminal frame interval or input response makes the metric NOT_MEASURED, even when its record is retained in raw logs. Do not exclude censored tails to compute a passing verdict. Use nearest-rank p95: sort n complete observations ascending and select one-based rank `ceil(0.95*n)`. Never interpolate, average run percentiles or round before comparing to thresholds. Report units, n, duration, p50, p95, max, raw observations and worst run for each scenario. Keep pooled summaries supplementary. Exactly 20 ms/50 ms meets its respective limit.

Report schema version `gurow-p1-report-v1` has required sections:

- `identity`: contract ID/hash, parent #7, source commit/tree, dirty flag + diff/input fingerprint where applicable, production build hash, timestamp, runner/parser/collector profile versions and hashes.
- `environment`: all reference-device/run fields, adapter/driver evidence, hardware acceleration, visible headed state, viewport/canvas/backing geometry and power/display configuration.
- `fixture`: size, edge count, hash, seed/algorithm version, cell/camera parameters, Task association and visibility records.
- `runs`: attempts with scenario, warm-up/active/drain intervals, scheduled/delivered/classified input counts, group membership, presented frames, sample bounds, validity reasons, per-metric statistics and verdicts.
- `functional`: each AC1 subscenario's action, assertion, command/log, result and source identity; no inferred result from an older ticket's CLOSED state.
- `diagnostics`: initialization-to-first-coherent-render, browser process-tree RSS, JS heap when available, Wasm memory when available, GPU memory when supported, draw calls, upload bytes and JSON boundary calls/bytes/duration. Use null + reason for unavailable optional counters, never fabricated zero. Record actual driver/platform measurements separately from instrumented counters; GPU readback waits must not be inserted in the timed production path.
- `comparisons`: all 100/10,000 attempts and outcomes, including slow runs/resource limits and limitations; no product-capacity conclusion.
- `artifacts`: relative path, SHA-256 and role for each trace, raw input/frame log, profile, video if used, functional log and generated report.
- `gate`: each original AC verdict, overall verdict, reasons and required follow-up. Unknown fields/samples must not become PASS by default.

Verdicts are `PASS`, `FAIL`, `NOT_MEASURED`. Preserve metric-level distinctions: valid over-limit samples yield FAIL; missing, invalid or uncertain evidence yields NOT_MEASURED. Overall is FAIL if any required valid criterion fails, otherwise NOT_MEASURED if anything required is missing/invalid, otherwise PASS. Missing optional diagnostic counters must be explicitly explained and reviewed against AC4; they are not invented product thresholds. Missing comparison runs leave AC4 NOT_MEASURED; a completed slow comparison does not fail the primary performance gate.

All three primary scenarios and all three repetitions must satisfy both thresholds on the same source/environment series. Functional AC1, environment/method evidence AC3, comparison/diagnostic reporting AC4 and honest failure handling AC5 are also required. Neither three fast samples, passing fixture tests, nor a closed child issue closes #7.

## 8. Functional and harness acceptance

AC1 requires real browser actions covering create/select, pan/zoom/drag, a valid connection and unchanged graph on rejected cycle, Task edit, one-step drag undo/redo, semantic reload of IDs/positions/connections/Task contents, keyboard/list navigation without WebGPU, real GPU device loss and successful/failed recovery/retry. Run the functional scenario outside latency windows. Browser initialization errors and dynamic IDs must be exercised, not just the original four hardcoded Skills. Reuse useful T04/T05 assertions, then inspect freshly loaded UI and engine state.

Future T06 work resumes or starts one harness session pinned to the parent #7 and its implementation base. It must not replace `.harness/` merely to author this contract; current T05 evidence is retained. Subtasks identify their own source commits and artifacts under that parent session. Register T06 acceptance commands, build current source before browser checks, and keep all original ACs in the mapping. Full checks and independent Standards/Spec review remain required before implementation readiness.

Use isolated output under `.harness/` for working evidence. Publishing a final report requires a recorded source identity and reviewed artifacts. Do not use working notes or older test reports as current proof. After a measured failure, write a new bounded optimization task naming the observed bottleneck and regression proof; do not add speculative culling, binary protocols or new state owners before measurement. Parent #7 and downstream #8 remain gated until the actual required evidence passes.

</details>

<details>
<summary>Normative numeric protocol</summary>

```json
{
  "contract_id": "gurow-p1-v1",
  "report_schema": "gurow-p1-report-v1",
  "parent_issue": 7,
  "source_commit_at_design": "0a3b9be96a8ef89ce74a22d011ce7e9ba49e996d",
  "design_status": "complete_approved",
  "collector_status": "not_qualified",
  "benchmark_status": "not_run",
  "thresholds_ms": {
    "frame_p95": 20,
    "input_to_visible_p95": 50
  },
  "primary": {
    "cards": 1000,
    "connections": 2000,
    "grid_columns": 25,
    "grid_rows": 40,
    "initial_visible_cards": 200,
    "visible_cards_min": 180,
    "visible_cards_max": 240,
    "html_labels": true
  },
  "comparisons": [
    {
      "cards": 100,
      "connections": 200,
      "grid_columns": 10,
      "grid_rows": 10
    },
    {
      "cards": 10000,
      "connections": 20000,
      "grid_columns": 100,
      "grid_rows": 100
    }
  ],
  "card_size_world": {
    "width": 180,
    "height": 80
  },
  "viewport_css": {
    "width": 1200,
    "height": 720
  },
  "device_pixel_ratio": 1.5,
  "display_refresh_hz": 165,
  "sampling": {
    "warmup_seconds": 10,
    "active_seconds": 30,
    "drain_seconds": 2,
    "repetitions_per_scenario": 3,
    "input_hz": 120,
    "minimum_delivered_requests": 3420,
    "minimum_response_groups": 300,
    "minimum_presented_intervals": 300,
    "visibility_sample_hz": 10,
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
  "run_verdicts": [
    "PASS",
    "FAIL",
    "NOT_MEASURED"
  ],
  "qualification_delay_ms": 80,
  "latency_statistics_unit": "each_original_delivered_input",
  "coalesced_fallback": "repeat_oldest_group_latency_for_every_member",
  "censored_tail_policy": "NOT_MEASURED",
  "optical_equivalent_input_count_per_30s": {
    "min": 3420,
    "max": 3780
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

Researched 2026-09-28 for issue #7, contract task A. This is measurement research and a protocol recommendation, not an executed benchmark or evidence that P1 passes. The normative project thresholds remain in ENGINE_VALIDATION_PLAN.md: primary workload p95 frame time ≤20 ms and p95 input-to-visible-response ≤50 ms during pan, zoom, and drag. A subsequent contract can pin the concrete reference device and interaction sequence.

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

</details>
