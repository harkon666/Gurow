## Parent

https://github.com/harkon666/Gurow/issues/1

## What to build

Expose Approval Revocation in the Coach's assessment history and show its effects to the learner without hiding earlier work or decisions. Make current XP, Mastery, and Access changes understandable using the already-proven correction contract.

Stage: MVP. Spec coverage: US27, US51, US52, US53, US55, US59.

## Acceptance criteria

- [ ] Only the owning Coach can revoke an identified Approval through the UI, with a mandatory reason stored alongside the retained original decision.
- [ ] The learner and Coach see whether remaining valid Approvals preserve the Task contribution and Mastery or whether the final supporting Approval's loss corrects them.
- [ ] Dependent Access updates and lock reasons remain distinct from independently supported Mastery on dependent Skills.
- [ ] Later Approval restores the contribution without duplication, while revision, award, and correction history remain readable within their existing visibility rules.
- [ ] Browser-to-backend checks cover multiple-valid-Approval and final-Approval cases, unauthorized correction, reload, and no successful correction display before confirmation.

## Blocked by

- [#24](https://github.com/harkon666/Gurow/issues/24) — Review learner work and show the resulting progress
