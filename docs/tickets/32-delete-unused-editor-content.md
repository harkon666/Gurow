## Parent

https://github.com/harkon666/Gurow/issues/1

## What to build

Complete the editor deletion flow for unused learning content and editable Prerequisite connections, using the existing history-retention guard. A delete or undo must produce a valid persisted editor/application result and cannot bypass published-content immutability or rewrite assessment history.

Stage: MVP. Spec coverage: US66, US67, US71, US72, US77.

## Acceptance criteria

- [ ] An authorized author can delete an unused Skill card and its unused owned Task definitions, or remove a connection from an editable Path, leaving no dangling editor or learning references.
- [ ] Any affected learning history prevents permanent deletion and leads to the existing Archival behavior; the action cannot delete published Version content in place.
- [ ] Undo/redo for accepted editor deletion restores or reapplies valid definitions, positions, and graph connections through the normal ownership/validation boundary, including after a save.
- [ ] Undo does not rewind Reviews, XP, Mastery, or Enrollment history; a restoration that no longer passes current backend rules is rejected with local work retained.
- [ ] Browser-to-backend checks cover unused deletion, connection deletion, semantic reload, undo/redo, retained historical work, and rejection of forbidden or stale edits.

## Blocked by

- [#31](https://github.com/harkon666/Gurow/issues/31) — Archive learning content while keeping evidence and progress readable
