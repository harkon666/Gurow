## Parent

https://github.com/harkon666/Gurow/issues/1

## What to build

Let an enrolled learner save and read a private Task draft, send text and URLs for assessment, and correct it through a new immutable revision using the P2 backend interface. The Coach can read sent contents but never the unsent draft. This introduces the durable Submission behavior consumed by later Review and product UI slices.

Stage: P2. Spec coverage: US42, US43, US44, US45, US47, US48.

## Acceptance criteria

- [ ] Saved draft contents are visible only to the learner; unauthorized draft reads and writes, including Coach reads, are rejected.
- [ ] Sending with valid Access creates an immutable revision for exactly one Task, with at most one Submission per Task/Enrollment even under competing sends.
- [ ] Text and submitted URLs are retained exactly as sent; linked destinations are neither fetched into a frozen archive nor claimed to be immutable.
- [ ] A newer revision supersedes earlier undecided revisions of the same Submission; previously sent contents cannot be edited in place.
- [ ] Separate Tasks require separate Submission histories even when evidence is reused; unavailable Access blocks new sends without deleting existing work.
- [ ] PostgreSQL-backed request tests demonstrate draft privacy, immutable revision reads, supersession, uniqueness, and no successful response before persistence.

## Blocked by

- [#8](https://github.com/harkon666/Gurow/issues/8) — Accept an Enrollment Invitation and read scoped participation
