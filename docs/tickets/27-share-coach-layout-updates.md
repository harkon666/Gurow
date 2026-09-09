## Parent

https://github.com/harkon666/Gurow/issues/1

## What to build

Allow the owning Coach to improve card positions on an already published Version and let an enrolled learner see the updated shared Canvas Layout on reopening. Keep learning content immutable and camera navigation local to each Account and Path context.

Stage: MVP. Spec coverage: US74, US75, US76, US77.

## Acceptance criteria

- [ ] The owning Coach can reposition published Skill cards through the editor and persist a layout-only update without creating a new Learning Path Version.
- [ ] Learners see the latest layout for their pinned Version on reopening while retaining their own local camera state; they cannot save position edits.
- [ ] Layout requests cannot alter Skills, Tasks, Prerequisites, progress, Reviews, or XP, and backend authorization protects against direct requests as well as UI misuse.
- [ ] Expected-revision saves reject stale layout writes while retaining local edits; undoing a saved position change creates a newly validated edit.
- [ ] A Coach/learner browser scenario verifies layout refresh, unchanged learning definitions/history, camera isolation, and rejected learner mutation.

## Blocked by

- [#22](https://github.com/harkon666/Gurow/issues/22) — Navigate an enrolled Version and inspect learning requirements
