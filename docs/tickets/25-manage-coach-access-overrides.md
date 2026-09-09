## Parent

https://github.com/harkon666/Gurow/issues/1

## What to build

Add an individual Skill's override grant/revocation flow to the Coach's learner view and reflect it in the learner's learning panel. Include the required reason and readable audit record while keeping ordinary progress and Enrollment lifecycle intact.

Stage: MVP. Spec coverage: US57, US58, US59, US64.

## Acceptance criteria

- [ ] The Coach targets one learner Enrollment and Skill, supplies a brief reason, and sees the automatically recorded action, Actor, target, and time.
- [ ] The learner gains Access despite unmet Prerequisites and XP only for that target, with XP/Mastery unchanged and other Enrollments unaffected.
- [ ] Revocation with a reason restores ordinary Access and preserves work, history, and eligibility of earlier valid submissions.
- [ ] An inactive Enrollment remains unable to start or send work even if an override is present; the UI does not present override as reactivation.
- [ ] A browser flow grants, uses, and revokes the exception, verifies an eligible later Review, and rejects cross-Workspace changes.

## Blocked by

- [#24](https://github.com/harkon666/Gurow/issues/24) — Review learner work and show the resulting progress
