## Parent

https://github.com/harkon666/Gurow/issues/1

## What to build

Publish a Coach's Draft only when its required learning route can be completed under ordinary rules. Show useful validation failures, freeze the published learning contract, and prepare subsequent changes as a new Version while retaining earlier content and pinned fixture Enrollments.

Stage: MVP. Spec coverage: US29, US30, US31, US33, US34, US35, US36.

## Acceptance criteria

- [ ] Publication checks reachability using Required Tasks on required Skills only, accounting for current prerequisite Mastery and available XP without counting locked work toward its own unlock.
- [ ] Optional Skills, Enrichment Tasks, and Access Overrides cannot rescue a blocked required route; reject it with affected Skills and unmet requirements, including the 60-reachable-XP versus 100-required example.
- [ ] Every publishable required Skill can obtain Mastery through a nonempty Required Task set; drafts with zero Tasks never obtain Mastery by an empty condition.
- [ ] Published learning content and rules cannot be edited in place, including typo corrections; preparing an update yields an editable Draft and a distinct published Version.
- [ ] Logical Skill and Task IDs remain stable across Versions in the same Path while definitions remain version-specific; old fixture Enrollments retain their Version and progress without migration.
- [ ] Browser/backend tests demonstrate rejected publication, a valid published route, a new content Version, immutable old content, and enforcement against direct unauthorized writes.

## Blocked by

- [#19](https://github.com/harkon666/Gurow/issues/19) — Own a Coach Workspace and author a Learning Path Draft
