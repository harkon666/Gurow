## Parent

https://github.com/harkon666/Gurow/issues/1

## What to build

Open a minimal Learning Path fixture in the browser, create flat Skill cards, and select a card to see the correct Skill in a React panel. Render actual card geometry and selection with Rust/Wasm/wgpu/WebGPU, with HTML labels positioned from engine output. This is the first usable P1 path, including the build and browser integration needed to run it; it does not add backend learning behavior.

Stage: P1. Spec coverage: US68, US73, US80.

## Acceptance criteria

- [ ] A real WebGPU browser initializes the Rust/Wasm editor and displays created Skill cards and their HTML labels; a mocked canvas or list-only implementation does not satisfy this check.
- [ ] Selecting different cards shows the corresponding stable fixture Skill ID and title in React, with one flat card per Skill and a visible selection state.
- [ ] The pure editor core owns cards, positions, and selection; renderer and browser adapter responsibilities remain separate, and React has no second authoritative position store.
- [ ] Defined commands and events connect the engine and application using the agreed initial JSON boundary; the fixture contains no learning progress inside the renderer.
- [ ] A reproducible browser smoke check covers creation and selection, and the build/run procedure records the actual browser and GPU environment used.

## Blocked by

None — can start immediately.
