## Parent

https://github.com/harkon666/Gurow/issues/1

## What to build

Let an authorized author reuse an accessible Skill with its Tasks in another editable Learning Path, or reuse one Task in another Skill, through a deliberate copy action. Give the resulting definitions independent identities and editing behavior without inheriting evidence or progress.

Stage: MVP. Spec coverage: US07, US09, US10, US36, US48.

## Acceptance criteria

- [ ] Copying a Skill creates a new Skill logical ID and new IDs for its copied Task definitions in the destination Path; copying a Task alone creates a new Task in its destination Skill.
- [ ] The source remains unchanged when the copy is edited, and its Submissions, Approvals, XP, Mastery, and Enrollment progress never transfer.
- [ ] A copied Skill brings its own Task definitions; prerequisites involving Skills outside the copied set are not carried across as cross-Path or cross-Version links. Destination dependencies are authored under the normal graph rules.
- [ ] Source reads and destination writes obey their existing privacy/ownership rules, and published content can only be changed through an editable Draft/new Version.
- [ ] Browser/backend tests copy personal and authorized Coach content, edit the result, reload both sides, and verify new identities, isolated definitions, and absent inherited progress.

## Blocked by

- [#20](https://github.com/harkon666/Gurow/issues/20) — Publish a completable Version and preserve its learning contract
