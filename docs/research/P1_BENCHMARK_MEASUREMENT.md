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

## Revision 2026-09-30: practical gate (contract `gurow-p1-v2`)

The recommendation above assumed that either a Chromium presentation join or a calibrated optical rig could be acquired. On the reference host neither was available: the qualified-collector attempt found 0/18 attributable input→canvas/label→hardware-presentation chains (#34), and the only camera delivers 30 fps (#41). Under `gurow-p1-v1` the latency criterion therefore could only be `NOT_MEASURED`, independent of engine performance.

Comparable canvas editors do not gate on photon latency:

- Figma gates editor performance on frame time (average and maximum) and CPU profiles, running a headless Chromium in GPU-enabled VMs on every pull request with a 20% regression margin, plus a small set of real laptops. Its public write-up does not describe input-to-photon or optical measurement. [Keeping Figma Fast](https://www.figma.com/blog/keeping-figma-fast/); [Figma, faster](https://www.figma.com/blog/figma-faster/).
- tldraw reports per-interaction `fps` and `p95FrameTime`, with Long Animation Frame attribution where available. [tldraw performance](https://tldraw.dev/sdk-features/performance).
- Event Timing still excludes continuous `wheel`/`pointermove` input (see the table above), so no standard browser API measures continuous-interaction latency.

The project therefore adopted [ADR 0019](../adr/0019-measure-p1-responsiveness-with-frame-time-and-an-in-app-latency-proxy.md): rAF frame intervals and an in-app input-to-frame proxy with a documented presentation estimate, simplified sampling, and a delay-injection sanity check. The limitations recorded in the table above (rAF is not proof of displayed pixels) remain true; v2 reports them as limitations instead of treating them as disqualifying. The sections above describe the superseded `gurow-p1-v1` design.
