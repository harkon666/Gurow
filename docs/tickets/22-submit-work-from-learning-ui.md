## Parent

https://github.com/harkon666/Gurow/issues/1

## What to build

Turn the learner's Task panel into a private working space and connect sending/correcting work to the existing Submission API. Show sent revision history separately from editable draft contents and provide Account-scoped local recovery for unsent work.

Stage: MVP. Spec coverage: US42, US43, US44, US45, US47, US48, US49, US50, US78, US79, US81.

## Acceptance criteria

- [ ] A learner can edit and save text/URL draft contents privately, recover local unsent edits in the same Account context, and send only when Access and Enrollment state permit.
- [ ] Sending shows a backend-confirmed immutable revision in the Task's one Submission history; a failed or offline send retains editable work and does not appear successfully submitted.
- [ ] New revisions supersede pending older ones, and UI history preserves prior valid Approvals without implying that a new revision inherits them.
- [ ] Reusing evidence for another Task uses a separate Submission; the UI accurately explains that submitted URLs do not freeze the external destination.
- [ ] Coach and peer views never receive unsent draft contents, including through local recovery or Account switching.
- [ ] Browser-to-PostgreSQL tests cover draft-to-send-to-correction-to-reload from both canvas and keyboard/list entry, including Access failure and privacy.

## Blocked by

- [#22](https://github.com/harkon666/Gurow/issues/22) — Navigate an enrolled Version and inspect learning requirements
