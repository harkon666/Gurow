## Parent

[Spec #46 — Canvas-first UI and per-Skill Kanban](https://github.com/harkon666/Gurow/issues/46)

## What to build

UX02: Let authorized authors connect Skills directly by dragging a connection point, without confusing that gesture with moving the card. Deliver pointer input through the public editor boundary, graph validation, rendering/feedback, authorized persistence, and restored application behavior. Keep the existing non-drag connection path usable regardless of whether the navigation redesign has landed.

A → C and B → C are two separately created Prerequisites, both required under existing ALL semantics. This is not a new relationship type, bulk connection mode, or change to Access, Mastery, XP Thresholds, or Overrides.

## Acceptance criteria

- [ ] AC1: Dragging an authorized Skill card body moves the card; dragging its edge connection point starts connection creation instead. Points are discoverable on hover or selection. Existing selection, multiselection, pan, and zoom behavior remains correct.
- [ ] AC2: Create fresh A, B, and C through the actual UI, drag A → C and then B → C, and observe the correct directed connections. Highlight valid destinations. Reload restores both connections against the same newly created Skills; no fixed-fixture endpoint fallback is allowed.
- [ ] AC3: Cancellation and invalid drops leave the graph unchanged. Self-connections, duplicates, missing/cross-context endpoints, cycles, and applicable Optional-Skill/required-Skill restrictions are rejected with concise feedback. Validate at both authoritative engine/domain boundaries as applicable; feedback is not a substitute for authorization.
- [ ] AC4: Selecting a connection allows authorized deletion. Creation and deletion participate in editor undo/redo with one completed gesture as one operation; undo of a saved edit is a newly validated change, not a rewind of durable learning history. Rejecting a change or failed persistence must not silently lose graph edits.
- [ ] AC5: The non-drag Skill-detail action creates/removes the same edges using the same validations. Keyboard users can access this action in the existing details view or its UX01 replacement. Permissions remain unchanged: Learners cannot edit published graph content or reposition shared cards, and authorized published-layout edits cannot rewrite learning content.
- [ ] AC6: Exercise real pointer gestures at changed pan/zoom, including cancellation and rejected targets. Verify target geometry/labels stay aligned and the right endpoints are chosen. Public Rust command/output tests supplement, but do not replace, browser evidence that handles work.
- [ ] AC7: Save/reload, stale or rejected writes, undo/redo, and learning Access demonstrate that no second independently persisted graph was introduced. Existing ALL prerequisite checks, XP thresholds, overrides, and CPU document recovery remain intact.
- [ ] AC8: Map this ticket to parent AC-02, connection portions of AC-08/AC-10, and user stories 8–14, 44. Add acceptance checks to the current harness; retain applicable current full regressions before review and distinguish unrun headed performance evidence.

## Testing and handoff

Use real browser/application pointer and keyboard workflows, backend-authorized persistence, and public Rust editor commands/outputs for deterministic interaction and graph invariants. Do not couple acceptance to private engine state or replace the Rust-owned graph with React state. Do not defer this ticket's tests to a final integration task.

UX01 is not a blocker: this slice must work with whichever authorized details shell is current. Coordinate any shared editor-shell changes. After all five feature tickets complete, the implementer integrating the last slice must exercise combined canvas → connections → board → learning/review → return/reload journeys and map parent acceptance coverage; this publication does not alter parent #46.

## Blocked by

None — can start immediately.
