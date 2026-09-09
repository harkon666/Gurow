## Parent

https://github.com/harkon666/Gurow/issues/1

## What to build

Select several Skill cards with a box and drag the selection as one arrangement edit in a persisted editable Path. Extend the proven single-card flow while keeping connections, HTML labels, undo semantics, and backend saves coherent.

Stage: MVP. Spec coverage: US69, US72, US77, US80.

## Acceptance criteria

- [ ] Box selection identifies the intended cards at different camera positions/zoom levels, and dragging preserves their relative positions within world limits.
- [ ] Connections and labels remain attached to the correct Skills while a selection moves, without copying position authority into React.
- [ ] One completed selection drag is one undo step; undo/redo and the subsequent validated save restore all affected positions coherently.
- [ ] Reload preserves the final saved arrangement while selection and undo history remain session-only; unauthorized layout editing remains rejected.
- [ ] Public-core and browser persistence checks cover multiselection, dragging, undo/redo, limits, and label/edge alignment, with relevant primary-workload regression measurements for changed interaction paths.

## Blocked by

- [#17](https://github.com/harkon666/Gurow/issues/17) — Create and reopen a personal Learning Path with Skills and Tasks
