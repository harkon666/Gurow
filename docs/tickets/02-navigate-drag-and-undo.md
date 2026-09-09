## Parent

https://github.com/harkon666/Gurow/issues/1

## What to build

Let a canvas user navigate the existing Skill cards and reposition one card predictably. A completed drag can be undone and redone as one edit, and labels and selection stay aligned during movement. This slice adds interaction behavior through the browser, engine commands, rendering, and public-core tests.

Stage: P1. Spec coverage: US70, US72, US80.

## Acceptance criteria

- [ ] Mouse/trackpad pan and cursor-anchored zoom work across the initial 10%–400% range, with world coordinates bounded to plus or minus 1,000,000 on each axis.
- [ ] Dragging preserves the initial pointer-to-card offset at different zoom levels, and the resulting card position is owned by the engine.
- [ ] One completed drag is exactly one undo step; undo restores its initial position and redo restores the final position without affecting learning-domain state.
- [ ] HTML labels, selection geometry, and the existing React selection remain associated with the correct Skill through pan, zoom, drag, undo, and redo.
- [ ] Public-core tests cover coordinate round trips, cursor anchoring, drag offsets, and undo invariants; browser checks exercise the actual interactions without serializing the whole scene for every pointer movement.

## Blocked by

- [#2](https://github.com/harkon666/Gurow/issues/2) — Create and select Skill cards in the Rust/WebGPU editor
