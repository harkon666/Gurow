## Parent

https://github.com/harkon666/Gurow/issues/1

## What to build

Reach the existing Skills and Tasks through a keyboard-accessible Skill/Prerequisite list, including when WebGPU cannot initialize or the renderer fails during editing. Preserve the active CPU-side document, attempt renderer recreation, and let users retry while the list remains usable.

Stage: P1. Spec coverage: US78, US81, US82.

## Acceptance criteria

- [ ] Keyboard navigation through the Skill/Prerequisite list selects the correct Skill and opens its existing Task panel with the same data as canvas selection.
- [ ] No-WebGPU startup provides the usable list and Task path with an explanation of canvas availability; positioning remains a canvas operation.
- [ ] Exercising renderer failure or device loss retains the CPU document and application Task data, including unsaved edits.
- [ ] Successful recreation redraws the current document; unsuccessful recovery presents a retry action and keeps list navigation functional.
- [ ] Browser checks exercise both the real rendering path and failure/list paths, verifying the retained graph, card positions, and Task association.

## Blocked by

- [#5](https://github.com/harkon666/Gurow/issues/5) — Edit a Skill Task and restore the complete local learning scene
