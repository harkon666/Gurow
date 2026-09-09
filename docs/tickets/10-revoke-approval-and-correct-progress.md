## Parent

https://github.com/harkon666/Gurow/issues/1

## What to build

Correct an assessed revision through an authorized Approval Revocation and read the resulting XP, Mastery, Access, and retained history from the backend. The correction is scoped to the supporting evidence, including cases with multiple valid Approvals for one Task.

Stage: P2. Spec coverage: US27, US51, US52, US53, US55, US59.

## Acceptance criteria

- [ ] Revocation identifies one Approval, requires the owning Coach and a recorded reason, and retains the original Review decision.
- [ ] Revoking one of several valid Approvals preserves the Task contribution; revoking the last removes it through one recorded XP Correction.
- [ ] Mastery is reevaluated from remaining valid Approvals and retained or revoked accordingly, with award history preserved.
- [ ] The reference scenario relocks B when A's supporting Mastery/XP is lost, while independently supported Mastery on B and eligible previously sent work are retained.
- [ ] A later valid Approval restores the Task reward without multiplying it; repeated or rejected revocations leave coherent progress and correction history.
- [ ] PostgreSQL-backed request tests read back the full before/after state and demonstrate that unauthorized or failed corrections leave no partial XP/Mastery effects.

## Blocked by

- [#10](https://github.com/harkon666/Gurow/issues/10) — Review a Submission Revision and derive XP, Mastery, and Access
