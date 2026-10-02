## Parent

https://github.com/harkon666/Gurow/issues/7

## What to build

One browser end-to-end check that exercises the complete functional P1 flow on current sources, plus a command that runs the 300-card capture and prints a PASS/FAIL summary.

**Revised 2026-10-02 (ADR 0020):** slimmed for the MVP. Fail-closed gating, source/profile/artifact hash coherence, the evidence manifest and the separate independent review are dropped.

Stage: P1/T06. Spec coverage: US80, US82, US83, US84. Parent criteria: AC1, AC2.

## Acceptance criteria

- [ ] A browser check covers card creation/selection, pan/zoom/drag, a valid connection, cycle rejection with the graph unchanged, Task editing, one-step drag undo/redo, and reload restoration. Reuse the T04/T05 smoke checks where they already cover a step.
- [ ] The same check covers the no-WebGPU keyboard/list path and one renderer failure-and-recovery cycle, including the retry UI, without losing the document or Task data.
- [ ] It is registered in `harness.json` with a realistic timeout and builds current sources first.
- [ ] Add a 300-card / 600-connection gate workload to the protocol, fixture generator and runner. Sizes are currently fixed to 100/1,000/10,000, and any size other than 1,000 is forced into diagnostic mode (`frontend/scripts/benchmark/run.ts:95-96`).
- [ ] A `capture:p1:gate` script runs the 300-card capture (and the 1,000-card informational run) and writes the short report described in #7.

## Blocked by

None.
