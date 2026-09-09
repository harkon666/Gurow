## Parent

https://github.com/harkon666/Gurow/issues/1

## What to build

Select a Skill, edit one simple associated Task in React, and locally save and reopen the coherent Learning Path fixture. Combine the existing editor interactions and graph with application-owned Task data, preserving the boundary that P1 is intended to prove.

Stage: P1. Spec coverage: US08, US73, US76, US78, US83.

## Acceptance criteria

- [ ] Selecting different Skills addresses the correct Task; editing its contents updates application-owned data without putting Task contents in the engine snapshot.
- [ ] A checkpoint contains an editor snapshot with format version, Skill references, positions, and connections plus a separately owned, associated application payload.
- [ ] Reload semantically restores IDs, positions, connections, and Task contents; the editor and Task payload cannot silently restore mismatched associations.
- [ ] Completed operations save locally, and camera state is local to the Account/fixture and Path context; selection, in-progress drag, and undo history remain session-only.
- [ ] The browser flow covers create, connect, drag, Task edit, undo/redo, save, and reload, comparing observable state rather than JSON property order. This local proof does not claim backend persistence.

## Blocked by

- [#3](https://github.com/harkon666/Gurow/issues/3) — Pan, zoom, drag, and undo Skill placement
- [#4](https://github.com/harkon666/Gurow/issues/4) — Connect Skills while preserving a valid Prerequisite Graph
