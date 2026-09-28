# T06-L3-01 collector qualification status

Contract `gurow-p1-v1`. Ticket [#34](https://github.com/harkon666/Gurow/issues/34), under [#7](https://github.com/harkon666/Gurow/issues/7).

**Collector verdict: `UNSUPPORTED`. Collector status: `not_qualified`.** No profile hash may be consumed by L3-03 for acceptance evidence. This file is the in-repo record; the raw artefacts of each attempt stay in ignored `.harness/t06/qualification/` per [the harness workflow](../../agents/harness.md).

## The qualification run

| Field | Value |
| --- | --- |
| Verdict | `UNSUPPORTED` — captured, parsed, and gated; no validity failures |
| Profile | `gurow-collector-v3`, hash `953bea4f2ad9da42…` |
| Geometry class | `qualification_only` (see below) |
| Source | commit `9b3ae57`, working tree dirty |
| Host | NVIDIA Lovelace (driver 610.57.04), Omarchy, Hyprland 0.56.2, Wayland/Ozone, Chrome 152.0.7977.82, eDP-2 1920×1200 @ 165 Hz, DPR 1.5 |
| Trace | 134,458 raw Chromium events; per-scenario slices of 10,630 (pan), 8,321 (zoom), 13,685 (drag) |
| Clock mapping | offset derived from 10 paired sync marks, spread 0.109 ms (limit 5 ms) |
| Chains | 18 input-originated across pan/zoom/drag; 2 application-internal; 4 setup dispatches excluded |
| Tied to the presented canvas revision | **0 / 18** |
| With a computable latency | **0 / 18** |

### Why UNSUPPORTED

Per input, the parser records one of:

- the input could only be tied to a *subsequent* paint, not to the presentation of its canvas revision;
- the event carries no presented-frame ID and no actual hardware presentation timestamp;
- the presentation timing is fallback/fabricated, so no platform hardware timestamp exists.

This is the structural limitation, not a tuning problem: a chain qualifies only when one presentation event carries this canvas revision, its matching label revision **and** a real hardware presentation timestamp. Raw Chromium emits no such canvas/label join for a custom WebGPU canvas. Contract §6 anticipates exactly this — "If the installed stack cannot expose this chain, L3-01 delivers a documented `UNSUPPORTED` collector result" — and AC6 accepts it as the deliverable.

### The falsification checks did run (AC4)

The 80 ms injections were driven through real browser input and read back from the page, so the checks are observed rather than asserted:

| Evidence | Observed |
| --- | --- |
| Injected app delay executed | 2 times; dispatch CPU duration shifted **+79.75 ms** |
| Injected label delay executed | 2 times; label commit duration 0.00 ms → **80.00 ms** |
| Attributed-endpoint shift (app, label) | `NOT_MEASURED` — there is no attributed endpoint to shift |
| Fault injection at seal time | `enabled: false`, both delays 0 |

The delay demonstrably ran and the endpoint demonstrably does not exist. Those two facts are reported separately, and the CPU/label numbers are labelled diagnostics: contract §6 forbids them standing in for visible response.

### Other gates on this run

- 21 retained failed examples in `failed-examples/`, each the real parser's or finalizer's output: empty trace, negative and misordered timestamps, wrong clock units, absent clock mapping, duplicate IDs, revision mismatch, backwards label revision, uncommitted label, canvas-only frame, missing frame ID, late label, unrelated paint, fabricated feedback, submission-only, new-labels-old-canvas, plus four finalizer gates. **None was wrongly accepted.**
- Hardware adapter confirmed (NVIDIA Lovelace, fallback flag unset *and* not a known software renderer name).
- Zero device-loss events, zero page errors.
- Input grouping fixed by the collector as `gurow-coalescing-v1` (oldest unconsumed input); every observed group had size 1, recorded rather than assumed.
- Drag began on the selected centre card, re-selected outside the timed window through real pointer input.

## Geometry: qualification vs acceptance

The reference window of contract §3 (1200×720 CSS at DPR 1.5) **cannot fit this desktop**: eDP-2 is 1280×800 logical at scale 1.5, the top bar reserves 26, leaving 774, and a Chromium `--app` window adds 56 logical pixels of its own chrome — so 720 CSS pixels of viewport need a 776-pixel surface. The window is also tiled beside the editor in normal use.

Decision recorded 2026-09-28 by the project owner, as the versioned protocol explanation contract §1 requires: **a collector qualification does not need the reference window; an acceptance series still does.** Demonstrating that an input reaches a coherent presentation is independent of the window's size, while the acceptance workload's visible-card band and p95 thresholds are defined against it.

This is enforced, not merely documented:

- `qualify:native` runs in `--mode collector` and accepts the window the compositor lays out.
- The profile records `geometry_class`, **derived** from the observed viewport and DPR, never claimed. This run is `qualification_only`.
- `validateCollectorProfile` rejects a `qualification_only` profile whenever reference geometry is required, and holds any profile that claims `reference` to the actual 1200×720 / DPR 1.5 facts in every mode. An acceptance run therefore cannot inherit this profile's geometry.
- `--mode acceptance` restores the strict gate for L3-03.

A related trap is closed on the way: `Browser.setWindowBounds` is a request, not a guarantee. Under this tiling compositor Chromium goes on reporting the CSS viewport it was asked for while its Wayland surface stays tiled — an earlier attempt recorded a 1200×720 viewport it never had. Collector mode does not call it, and the compositor-observed surface is validated separately.

## Consequences

- **L3-03 is blocked** from using this collector for primary latency. The **optical acquisition alternative** in contract §6 is the defined path.
- Follow-up [#41](https://github.com/harkon666/Gurow/issues/41) owns that decision and is recorded as a native blocker of [#37](https://github.com/harkon666/Gurow/issues/37), because a closed L3-01 with `UNSUPPORTED` does not unblock L3-03 on its own.
- L3-02 and L3-04 may progress (contract §6).
- #7 stays open. Nothing here establishes a performance result: no p95, no threshold comparison, no acceptance environment.

## Re-running

```
cd frontend && bun run qualify:native              # collector qualification
cd frontend && bun run scripts/benchmark/qualify.ts --mode acceptance …   # reference geometry required
```

The driver builds the current source, re-probes every host fact, and writes a complete evidence set — including a preflight failure — to `.harness/t06/qualification/`.

No expected verdict is pinned in the command. To make a regression fail the check, add `--expect-verdict UNSUPPORTED` to both the `qualify:native` script and the `t06-l3-01-qualify` check, which `scripts/test_harness.py` keeps identical. Re-qualification is required after any browser, adapter or driver change (contract §3).

## Routine checks do not qualify anything

`collector-tests`, `editor-lifecycle` and the rest of the full profile are code and regression evidence. They do not qualify a collector, do not unblock L3-03, and do not substitute for the presentation evidence above.
