<!-- Written by `bun run capture:p1:gate` (#39) on 2026-10-04; raw evidence stays local in .harness/t06/gate/. -->

# P1 gate — PASS

Contract gurow-p1-v5 (ADR 0020): 300 cards / 600 connections with HTML labels. Limits per scenario: pooled p95 frame interval ≤ 20 ms and p95 input-to-frame proxy ≤ 50 ms.

Source: `411052304b780e97ee3e3160379ca45f0511e3a2` (uncommitted changes), fingerprint `79a6bd4c8a03`; captured 2026-10-04T11:46:44.844Z.

## Gate: 300 cards

| Scenario | Verdict | Frame p50 / p95 (ms) | Proxy p50 / p95 (ms) | Input reaching page | Visible cards (run medians) |
|---|---|---|---|---|---|
| pan | PASS | 6.1 / 6.2 | 29.4 / 36.1 | 10762 / 10800 (3 valid runs) | 200 |
| zoom | PASS | 6.1 / 6.2 | 29.1 / 35.5 | 10768 / 10800 (3 valid runs) | 200 |
| drag | PASS | 6.1 / 6.2 | 16.6 / 22.0 | 10800 / 10800 (3 valid runs) | 200 |

## Informational: 1000 cards (no threshold)

2000 connections, 3 run(s), contract gurow-p1-v5.

| Scenario | Frame p50 / p95 (ms) | Proxy p50 / p95 (ms) | Input reaching page | Visible cards (median) | Run notes |
|---|---|---|---|---|---|
| pan | 24.2 / 24.4 | 2618.6 / 4963.9 | 1606 / 3600 | 200 | backpressure: page received under the minimum input fraction |
| zoom | 24.2 / 30.2 | 2690.5 / 5284.6 | 1585 / 3600 | 200 | backpressure: page received under the minimum input fraction |
| drag | 24.3 / 30.4 | 45.3 / 58.9 | 3600 / 3600 | 200 | valid |

## Environment

- CPU: 13th Gen Intel(R) Core(TM) i5-13500HX
- GPU: nvidia lovelace; driver 610.57.04
- OS: linux 7.2.5-3-omarchy, Hyprland
- Browser: Chrome/152.0.7977.82 (headed)
- Viewport: 1884×982 CSS px window, canvas 1276×890 CSS px, DPR 1
- Refresh: 165 Hz display, idle rAF 163.9 Hz
- Power: AC; CPU governor powersave

## Measurement limitation

The input-to-frame proxy is measured in the page: input timestamp to the first animation-frame callback after the canvas and HTML labels committed that input, plus one refresh interval. It covers input queueing, application, renderer submission and label commit on the main thread; it does not observe compositor output, scanout or physical pixels.

Evidence: local `.harness/t06/gate/primary-300/` (reducer report and raw runs) and `.harness/t06/gate/informational-1000/capture.json`; `.harness/` is not committed.
