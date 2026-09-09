## Parent

https://github.com/harkon666/Gurow/issues/1

## What to build

Make the complete P1 interaction flow responsive on the agreed primary workload and record reproducible acceptance evidence. Resolve measured bottlenecks in the existing path rather than building speculative optimizations. This ticket is the explicit gate before P2 begins.

Stage: P1. Spec coverage: US80, US82, US83, US84.

## Acceptance criteria

- [ ] The actual Rust/Wasm/WebGPU path completes card creation, pan/zoom/drag, valid connections and cycle rejection, React Task editing, one-step drag undo/redo, local restoration, keyboard navigation, and renderer recovery.
- [ ] For 1,000 cards, approximately 200 visible cards, and 2,000 total connections with HTML labels enabled, p95 frame time is at most 20 ms and p95 input-to-visible-response latency is at most 50 ms during the recorded pan/zoom/drag sequence.
- [ ] Record CPU, RAM, GPU, OS, browser, viewport, DPR, refresh rate, actual visible counts, fixture, sequence, warm-up, sample count/duration, and measurement limitations; CPU processing time alone is not visible-response latency.
- [ ] Record comparison results for 100 and 10,000 cards and diagnostics for initialization, memory, draw calls, uploads, and boundary traffic without inventing additional pass thresholds or promising 10,000-card capacity.
- [ ] Failures are fixed or explicitly reported for design reassessment; a failed or unmeasured required check cannot close the P1 gate or unblock P2.

## Blocked by

- [#6](https://github.com/harkon666/Gurow/issues/6) — Keep Skill and Task navigation usable through renderer failure
