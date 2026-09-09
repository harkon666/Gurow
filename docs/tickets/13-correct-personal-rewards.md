## Parent

https://github.com/harkon666/Gurow/issues/1

## What to build

Use owner-only personal Learning Path fixtures through the backend to complete Tasks, correct rewards, declare Mastery freely, and explicitly bypass Access gates. This P2 slice verifies personal rules independently of the coach Review chain, including retention of an archived completed Task's contribution without defining a full archive-management UI.

Stage: P2. Spec coverage: US16, US17, US18, US19, US20, US21, US22, US23, US24, US25, US27, US67.

## Acceptance criteria

- [ ] Only the personal owner can act; Mastery can be declared without evidence or left unclaimed, and Task completion neither declares Mastery nor requires evidence/review.
- [ ] A completed Task contributes its current reward and an incomplete Task contributes zero; repeated completion actions never multiply the contribution.
- [ ] For a completed Task, changing 20 to 50 records +30; undoing completion removes 50 and completing again restores 50. Editing an incomplete reward leaves its contribution zero.
- [ ] Personal XP Thresholds use only current XP from that Path and can relock started work; an explicit personal override waives both gates without a reason or changes to XP/Mastery.
- [ ] Corrections preserve independently declared Mastery; archiving a completed Task preserves its contribution, Mastery, history, and owner-only visibility without adding a restoration policy.
- [ ] Request-level domain tests read back persisted contributions, corrections, ownership, and Access outcomes, keeping personal progress separate from coach Enrollments.

## Blocked by

- [#8](https://github.com/harkon666/Gurow/issues/8) — Accept an Enrollment Invitation and read scoped participation
