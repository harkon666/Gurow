## Parent

https://github.com/harkon666/Gurow/issues/1

## What to build

Provide learner self-deactivation and Coach deactivation/reactivation in the application, showing the resulting read-only learning history and continued eligibility of previously submitted work. This consumes the existing lifecycle API and can proceed independently of the override-management UI.

Stage: MVP. Spec coverage: US60, US61, US62, US63, US64.

## Acceptance criteria

- [ ] Learner self-deactivation requires no reason; Coach deactivation and reactivation require recorded reasons.
- [ ] Inactive participation blocks new Task starts and sends while preserving history, XP, and Mastery; unsent draft contents remain private.
- [ ] The Coach can still decide eligible unsuperseded work submitted before inactivity, and resulting XP/Mastery is visible without reactivating the Enrollment.
- [ ] Only the owning Coach can resume participation, retaining the Enrollment, Version, and progress and showing current Access; replayed invitations or an existing override do not resume it.
- [ ] Browser scenarios cover both deactivation actors, pending Review, unauthorized reactivation, and resumed learning with preserved history.

## Blocked by

- [#24](https://github.com/harkon666/Gurow/issues/24) — Review learner work and show the resulting progress
