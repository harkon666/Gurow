## Parent

https://github.com/harkon666/Gurow/issues/1

## What to build

Make the complete P1 interaction flow responsive on a realistic Learning Path and record enough evidence to trust the result. Fix measured bottlenecks in the existing path; do not build speculative optimizations. P1 is a timeboxed engine spike: it either passes, or produces evidence for a design reassessment of the editor engine.

Stage: P1. Spec coverage: US80, US82, US83, US84.

**Revised 2026-10-02 (MVP right-sizing, ADR 0020).** The gate workload is reduced from 1,000 to 300 cards, the 1,000-card run becomes informational, the 100/10,000 comparisons and resource diagnostics are deferred, and this gate no longer blocks P2. The 20 ms / 50 ms limits and the in-app measurement method of contract `gurow-p1-v4` (ADR 0019) are unchanged.

## Measurement

Use the existing `capture:p1` tooling and the in-app method of contract `gurow-p1-v4`: frame time from animation-frame intervals; input latency as the in-app proxy (input timestamp to the first animation-frame callback after canvas and HTML labels committed that input, plus one refresh interval). The proxy does not observe compositor or scanout time; the report says so.

## Acceptance criteria

- [ ] The actual Rust/Wasm/WebGPU path completes card creation, pan/zoom/drag, valid connections and cycle rejection, React Task editing, one-step drag undo/redo, local restoration, keyboard navigation, and renderer recovery, proven by one browser end-to-end check (#39).
- [ ] **Gate workload:** 300 cards, 600 connections, HTML labels enabled, with roughly 150–250 cards visible. p95 frame time ≤ 20 ms and p95 input-to-frame proxy ≤ 50 ms for pan, zoom and drag.
- [ ] **Informational:** the same capture at 1,000 cards / 2,000 connections is recorded alongside, with no pass threshold.
- [ ] The report records CPU, GPU, OS, browser, viewport, DPR, refresh rate, visible counts and the proxy limitation. A single short markdown report is enough.

## Timebox and exit

- Performance work (#42 and any follow-up) is timeboxed to **5 working days, ending 2026-10-09**.
- If the 300-card gate still fails at the end of the timebox, stop optimizing. Record the measured bottleneck and open a design reassessment of the editor engine (for example HTML labels, the JSON boundary, or Canvas2D/SVG instead of WebGPU) rather than adding more instrumentation.

## Not in scope for the MVP gate

- 100 / 10,000-card comparisons and draw-call / upload / boundary diagnostics (#38, deferred).
- Fail-closed harness gate, artifact hash coherence, and a separate independent decision review (#39 slimmed, #40 closed).
- Native Wayland support (#43 documented XWayland as supported).

## Blocked by

None. (#6 is closed.)
