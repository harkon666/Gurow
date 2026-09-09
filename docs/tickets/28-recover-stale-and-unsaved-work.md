## Parent

https://github.com/harkon666/Gurow/issues/1

## What to build

Make rejected stale saves and interrupted editing recoverable from the application without silently overwriting accepted state or mixing private work across Accounts. Complete the user-facing recovery path for personal/Coach editing and learner drafts while preserving the distinct editor and application payloads.

Stage: MVP. Spec coverage: US77, US78, US79, US83, US85.

## Acceptance criteria

- [ ] When two tabs save against the same base revision, the stale write is rejected, accepted server state remains intact, and the losing tab retains its local editor/application checkpoint.
- [ ] The UI explains the conflict and lets the owner inspect retained local work, load current state, and deliberately reapply edits through a new validated save rather than force-overwriting stale state.
- [ ] Interrupted draft editing remains recoverable only for its owning Account/context; Account switching cannot expose another learner's draft or personal Path recovery data.
- [ ] Restored editor IDs, positions, connections, and separately owned Task data remain coherent; format version, save revision, and Learning Path Version are not interchangeable.
- [ ] Offline/failed Submission, Review, and XP requests remain unsuccessful until backend confirmation and retain appropriate local input without claiming offline domain completion.
- [ ] Browser integration checks exercise competing tabs, reload/recovery, rejected reapplication, and Account switching through the real persistence and visibility boundaries.

## Blocked by

- [#23](https://github.com/harkon666/Gurow/issues/23) — Prepare private work and send Task revisions from the learning UI
- [#28](https://github.com/harkon666/Gurow/issues/28) — Update shared Canvas Layout without changing learning content
