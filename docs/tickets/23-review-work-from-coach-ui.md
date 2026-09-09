## Parent

https://github.com/harkon666/Gurow/issues/1

## What to build

Let the owning Coach open sent work for an enrolled learner, decide an exact revision, and let the learner see feedback and resulting progress in the learning UI. Reuse the existing transactional Review rules and retain keyboard access to assessment activities.

Stage: MVP. Spec coverage: US15, US26, US31, US32, US41, US46, US49, US50, US54, US56, US59, US79, US81.

## Acceptance criteria

- [ ] The owning Coach can find and inspect a learner's submitted revision and choose Approval or Changes Requested, with mandatory feedback for the latter.
- [ ] Stale pending revisions cannot be decided; the UI explains the rejected operation and refreshes authoritative revision state without partial progress.
- [ ] The learner sees feedback and may correct through a new revision with valid Access, while older valid Approvals remain effective and newer ones are independently assessed.
- [ ] After backend confirmation, Task reward, Required-Task Mastery, and dependent Access display the correct state without duplicate rewards or XP spending.
- [ ] The Coach can review previously eligible work after Skill Access loss, and keyboard/list navigation reaches the Review without requiring a working canvas.
- [ ] A two-Account browser scenario submits, requests changes, resubmits, approves, and observes progress, including self-approval/peer rejection and private-draft exclusion.

## Blocked by

- [#23](https://github.com/harkon666/Gurow/issues/23) — Prepare private work and send Task revisions from the learning UI
