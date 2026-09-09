## Parent

https://github.com/harkon666/Gurow/issues/1

## What to build

Use a real personal Path from the browser to mark Tasks complete, configure rewards, independently declare Mastery, inspect Access reasons, and explicitly bypass gates. Connect the already-proven personal rules to the canvas/list and learning panels so the user's motivational choices survive reload.

Stage: MVP. Spec coverage: US13, US14, US15, US16, US17, US18, US19, US20, US21, US22, US23, US24, US25, US26, US27, US79.

## Acceptance criteria

- [ ] The UI distinguishes Access, XP, and Mastery; Task completion and personal Mastery declaration are separate actions with evidence/review optional.
- [ ] Users may leave Mastery unclaimed or declare it freely, and may explicitly bypass both Prerequisites and XP without a required reason or score/Mastery mutation.
- [ ] Completion, undoing completion, and reward edits produce the backend-confirmed current contribution and understandable recorded corrections, including the 20-to-50 example.
- [ ] Each Path displays its own XP, spending no XP on unlock; current thresholds and ALL Prerequisites can relock started work while retaining existing work and declared Mastery.
- [ ] Locked Skills retain title, outcome, and lock reasons, and the same actions and outcomes are reachable from keyboard/list navigation.
- [ ] Browser-to-PostgreSQL checks cover the motivational flow, retry behavior, independent Mastery, cross-Path XP isolation, reload, and failed-write feedback.

## Blocked by

- [#17](https://github.com/harkon666/Gurow/issues/17) — Create and reopen a personal Learning Path with Skills and Tasks
