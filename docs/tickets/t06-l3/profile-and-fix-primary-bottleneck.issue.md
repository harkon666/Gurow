## Parent

https://github.com/harkon666/Gurow/issues/7

## What to build

The first v4 capture (2026-09-30, 1,000 cards) failed every scenario: frame p95 48.6 ms (pan), 84.9 ms (zoom), 121.2 ms (drag) against 20 ms; drag latency proxy p95 167 ms against 50 ms; pan/zoom held wheel input back for seconds (about 900 and 640 of 3,600 inputs reached the page).

Profile the existing Rust/Wasm/wgpu/React path and fix the largest measured costs. These failures are felt at any workload size, so fix them whether or not the gate size changes.

**Revised 2026-10-02 (ADR 0020):** gate workload is now 300 cards (see #7). This task is inside the 5-day performance timebox ending 2026-10-09.

## Approach

- Record one Chromium DevTools performance trace per scenario (pan, zoom, drag). Use the opt-in timers only if the trace is ambiguous.
- Start with the wheel-input backlog. Input that waits for seconds points to per-event work that cannot keep up (for example a JSON round-trip or a React label commit per input), not to GPU cost.
- Fix the 1–2 largest costs the trace shows, within the existing architecture (ADR 0015, 0017). Do not hide labels, the Skill list or the Task sidebar.

## Acceptance criteria

- [ ] For each scenario, a short note names the largest cost the trace shows and attaches a trace screenshot or summary.
- [ ] The fix keeps labels aligned with cards (US80) and the list/sidebar unchanged. Add a focused regression test where it is cheap (for example input coalescing).
- [ ] Before/after `capture:p1` results at 300 cards (gate) and 1,000 cards (informational): p50/p95 frame interval, latency proxy, and input delivery counts.
- [ ] Existing checks pass.

## Exit

If the gate still fails at the end of the timebox, or the trace shows the cost is inherent to an ADR decision (HTML labels per ADR 0017, the JSON boundary per ADR 0015), stop and record the evidence for a design reassessment in #7. Do not work around the decision.

## Blocked by

None.
