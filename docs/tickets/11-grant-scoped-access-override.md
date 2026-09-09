## Parent

https://github.com/harkon666/Gurow/issues/1

## What to build

Allow an owning Coach to grant or withdraw an Access Override for one Skill in one Enrollment through the backend. Demonstrate that waived Prerequisites and XP requirements change permission without changing achievement or another learner's rules.

Stage: P2. Spec coverage: US57, US58, US59.

## Acceptance criteria

- [ ] Granting an override bypasses both Prerequisites and the XP Threshold only for the identified Skill and Enrollment.
- [ ] Grant and revocation require a brief reason and record action, Coach, learner, Enrollment, Skill, and time automatically.
- [ ] Revocation returns to ordinary Access rules while retaining existing work, XP, and Mastery; eligible pending work remains reviewable.
- [ ] Unauthorized Actors and cross-Workspace or cross-Enrollment targets are rejected without changing Access elsewhere.
- [ ] PostgreSQL-backed request tests cover unmet Prerequisites and XP together, record completeness, revocation, and unchanged learning achievements. Enrollment inactivity is integrated in the lifecycle slice.

## Blocked by

- [#10](https://github.com/harkon666/Gurow/issues/10) — Review a Submission Revision and derive XP, Mastery, and Access
