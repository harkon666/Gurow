## Parent

https://github.com/harkon666/Gurow/issues/1

## What to build

Through a small backend request interface, accept a fixture Invitation into a published Learning Path Version and read the resulting participation as its learner or owning Coach. Establish the real PostgreSQL persistence and controlled identity fixture needed for this complete P2 behavior. Production sign-in, email delivery, and a full dashboard remain later slices.

Stage: P2. Spec coverage: US37, US38, US39, US41, US65.

## Acceptance criteria

- [ ] Controlled fixtures identify Accounts, one owning Coach Workspace, published learning content, and an Invitation to exactly one Version and verified email; fixture identity is not exposed as production authentication.
- [ ] An eligible acceptance returns a persisted Enrollment pinned to the offered Version and does not join other Paths.
- [ ] Repeated or competing acceptance for the same Account/Version returns one coherent Enrollment without resetting progress or creating another XP context.
- [ ] The matching verified-email condition, admission closure, and prohibition on owner Enrollment in their Coach Workspace are enforced at the backend boundary.
- [ ] Only the learner and owning Coach can read the Enrollment; peers, unrelated Accounts, and another Workspace's Coach are rejected.
- [ ] Request-level integration tests use actual PostgreSQL and read back durable outcomes, including rejected operations without partial Enrollment creation.

## Blocked by

- [#7](https://github.com/harkon666/Gurow/issues/7) — Meet the P1 responsiveness and recovery acceptance gate
