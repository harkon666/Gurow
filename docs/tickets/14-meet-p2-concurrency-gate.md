## Parent

https://github.com/harkon666/Gurow/issues/1

## What to build

Make the complete P2 request flow retain coherent learning results when operations are retried or race across Enrollment, Submission, Review, revocation, and lifecycle boundaries. Repair any integration races and record actual PostgreSQL-backed acceptance results. This is the gate before subsequent product slices.

Stage: P2. Spec coverage: US39, US44, US45, US54, US55, US65, US85.

## Acceptance criteria

- [ ] Competing invitation acceptance retains one Enrollment, and competing sends retain one Submission per Task/Enrollment with immutable, coherently ordered revisions.
- [ ] A Review that becomes stale through a newer authoritative revision is rejected without XP/Mastery effects; operations respect the accepted order when Review wins first.
- [ ] Repeated or competing Approvals and revocations produce correct single Task contributions and correction history, without partial progress on rejected writes.
- [ ] Races involving deactivation or override changes enforce Access at the authoritative operation while preserving eligibility of legitimate earlier work.
- [ ] The reference Enrollment-to-Approval-to-revocation flow, privacy/authority matrix, lifecycle checks, and personal 20-to-50 correction/retention behavior pass against real persistence.
- [ ] Report actual commands, fixtures, PostgreSQL environment, and outcomes; calculation-only tests, mock persistence, or unexecuted checks cannot close the P2 gate.

## Blocked by

- [#11](https://github.com/harkon666/Gurow/issues/11) — Revoke Approval and retain coherent learning history
- [#13](https://github.com/harkon666/Gurow/issues/13) — Stop and resume Enrollment while retaining eligible Reviews
- [#14](https://github.com/harkon666/Gurow/issues/14) — Correct personal Task rewards without rewriting Mastery
