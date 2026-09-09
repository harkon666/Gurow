## Parent

https://github.com/harkon666/Gurow/issues/1

## What to build

Create Prerequisite connections between visible Skill cards in one Learning Path fixture, render one Bezier connection style, and explain rejected cycle-creating edits. The same connection data drives the graph and canvas; this ticket needs selectable cards but can be implemented independently of camera interactions.

Stage: P1. Spec coverage: US11, US12, US71.

## Acceptance criteria

- [ ] A user can connect two Skills and see the new directed Prerequisite connection rendered between their cards.
- [ ] Branching and multiple Prerequisites are supported within the same Path fixture; self-cycles and longer cycles are rejected immediately, preserving the previous graph.
- [ ] Rejected connections produce understandable application feedback and leave card identities and valid connections intact.
- [ ] Connections remain attached to engine-owned card positions and represent one graph, without a second independently editable prerequisite authority in React.
- [ ] Public-core and browser checks cover accepted connections, branching, and unchanged state after a cycle-creating edit.

## Blocked by

- [#2](https://github.com/harkon666/Gurow/issues/2) — Create and select Skill cards in the Rust/WebGPU editor
