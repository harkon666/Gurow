## Parent

https://github.com/harkon666/Gurow/issues/1

## What to build

Expose the agreed Enrollment Deactivation and Reactivation behavior through the backend, preserving learning history and draft privacy. Integrate the existing Review and override behavior so stopping participation has the same result regardless of Skill gates or pending work.

Stage: P2. Spec coverage: US60, US61, US62, US63, US64.

## Acceptance criteria

- [ ] The owning Coach can deactivate with a recorded reason, while the learner can self-deactivate without a required reason.
- [ ] Inactivity blocks new Task starts and new Submissions/revisions even with an active Skill override; invitation acceptance does not reactivate participation.
- [ ] Eligible unsuperseded work sent while active and with valid Access remains reviewable, and its Approval may still contribute XP/Mastery.
- [ ] Deactivation itself removes no Approval, XP, or Mastery; history remains readable within its existing visibility rules and drafts remain learner-only.
- [ ] Only the owning Coach can explicitly reactivate with a recorded reason, retaining Enrollment, Version, and progress and reevaluating current Access.
- [ ] PostgreSQL-backed request tests cover both deactivation actors, override/admission interactions, eligible Reviews, privacy, and unauthorized reactivation.

## Blocked by

- [#12](https://github.com/harkon666/Gurow/issues/12) — Grant and revoke an audited Access Override
