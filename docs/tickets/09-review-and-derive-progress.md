## Parent

https://github.com/harkon666/Gurow/issues/1

## What to build

Let the owning Coach decide an exact Submission Revision through the backend and read the resulting learning state. Approval contributes its Task reward once, derives Skill Mastery from Required Tasks, and reevaluates dependent Access; Changes Requested provides mandatory feedback. Use the agreed two-Skill reference Path to demonstrate the full request-to-progress behavior.

Stage: P2. Spec coverage: US13, US15, US26, US31, US32, US46, US49, US50, US54, US56, US59.

## Acceptance criteria

- [ ] Only the authorized owning Coach can record Approval or Changes Requested; feedback is mandatory for Changes Requested, and superseded pending revisions reject decisions without progress effects.
- [ ] A nonempty set of Required Tasks yields Skill Mastery only when every Task has a valid Approval; Enrichment Tasks do not block it, and there is no separate Skill sign-off.
- [ ] A Task contributes its configured reward once while any valid Approval exists in the Enrollment; repeated decisions or additional approved revisions do not multiply it.
- [ ] In the reference Path, approving A's Required Task grants 20 Enrollment XP and Mastery of A, opening B with its Mastery and 20-XP requirements without spending XP.
- [ ] Access uses current ALL Prerequisites and Enrollment-local XP; personal or other Enrollment XP cannot satisfy it.
- [ ] A new revision after Approval neither invalidates the earlier Approval nor inherits it; prior eligible, unsuperseded work remains reviewable if Skill Access has since been lost.
- [ ] PostgreSQL-backed requests verify the transitions, readable feedback/history, authorization, and coherent rejection of stale or repeated operations.

## Blocked by

- [#9](https://github.com/harkon666/Gurow/issues/9) — Send private Task drafts as immutable Submission Revisions
