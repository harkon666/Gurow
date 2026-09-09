## Parent

https://github.com/harkon666/Gurow/issues/1

## What to build

Let a signed-in personal owner create a Learning Path with a goal, add Skills with outcomes and Tasks, arrange their cards, and connect Prerequisites. Persist and reopen the Path through the backend and PostgreSQL while reusing the proven editor/application boundary.

Stage: MVP. Spec coverage: US02, US06, US08, US11, US12, US68, US73, US77, US83.

## Acceptance criteria

- [ ] The owner can create and reopen multiple personal Paths, each with its own goal, Skills, Tasks, and one flat card per Skill.
- [ ] Skill/Task editing in React and card/connection editing in Rust remain correctly associated after backend persistence and reload; Tasks stay outside the editor snapshot.
- [ ] Backend writes enforce ownership, one Path per Skill, one Skill per Task, same-Path connections, and DAG validity as well as immediate editor cycle rejection.
- [ ] Completed edits autosave with an expected revision; stale writes do not overwrite accepted state and the local dirty work remains available. Rich conflict-resolution presentation follows in its own slice.
- [ ] Camera remains local per Account/Path and ephemeral selection/undo state is not confused with durable content or shared layout.
- [ ] Browser-to-backend tests cover authoring, a rejected unauthorized or invalid edit, coherent reload, and failure feedback without claiming an unsaved change is durable.

## Blocked by

- [#16](https://github.com/harkon666/Gurow/issues/16) — Sign in and enter an owner-only Personal Workspace
