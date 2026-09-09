## Parent

https://github.com/harkon666/Gurow/issues/1

## What to build

Let an Account enter its owning Coach context, create a Coach Workspace and editable Learning Path Drafts, and design their Skills, Tasks, and progression rules. Reuse the persistent authoring flow while applying Coach Workspace ownership and the distinction between required and enrichment work.

Stage: MVP. Spec coverage: US01, US04, US05, US06, US07, US08, US28, US65.

## Acceptance criteria

- [ ] A Coach Workspace has exactly one owning Coach and can contain multiple coach-mode Paths; each Path belongs to one Workspace and ownership grants no authority elsewhere.
- [ ] The owner authors outcomes and Tasks for each Path independently, including different Tasks for the same subject in different Paths.
- [ ] Draft editing configures Required and Enrichment Tasks, Optional Skills, Task rewards, XP Thresholds, and same-Version Prerequisites; incomplete Drafts may be saved without awarding Mastery.
- [ ] An Optional Skill cannot be a Prerequisite for a required Skill, and cycles or cross-Path connections are rejected through UI feedback and backend validation.
- [ ] The browser clearly switches personal and owning Coach contexts without exposing private personal data to a coached-learning context.
- [ ] End-to-end authoring/reload tests verify Workspace authority, persisted Draft requirements, and isolation from another Coach's content.

## Blocked by

- [#17](https://github.com/harkon666/Gurow/issues/17) — Create and reopen a personal Learning Path with Skills and Tasks
