## Parent

[Spec #46 — Canvas-first UI and per-Skill Kanban](https://github.com/harkon666/Gurow/issues/46)

## What to build

UX05: Give each Learner a personal organization board for one versioned Skill within one Enrollment, using the shared board contracts delivered in UX03. Deliver customizable columns, durable card positions, explicit Submission actions, and accurate separate Review status through the existing authorized application/backend/database boundaries.

Done means finished working, not submitted or approved. Official Task definitions remain immutable to the learner, and personal Tasks inside an Enrollment remain out of scope. This slice integrates the already-existing Coach Review behavior; it does not depend on the new Coach preparation board UX04.

## Acceptance criteria

- [ ] AC1: A Learner opens a Skill summary in an enrolled Version, enters its board, and returns to the previous canvas position/zoom. Initial columns are Backlog, To Do, In Progress, Done. Only Tasks of that Skill and Version appear; card organization belongs to this Enrollment.
- [ ] AC2: Learners add/rename/reorder/remove their own columns and reorder/move cards via drag or keyboard-operable menu/selection. Removing a populated column requires a surviving destination and never deletes official Tasks; the last usable column remains. Changes survive reopen/reload and do not affect another Skill, Enrollment, learner, or Coach Draft.
- [ ] AC3: Moving into or out of Done is organizational only: it does not send a Submission, create/revoke Approval, award/remove XP, or alter Mastery. Do not reuse the personal board's completion side effects. Card placement does not confer Access or bypass an inactive Enrollment.
- [ ] AC4: Submit for review remains an explicit action with existing Access and Enrollment checks. Preserve private editable Submission Drafts, immutable sent revisions, supersession, review eligibility, and audit/history rules. A board move cannot silently expose draft contents to a Coach.
- [ ] AC5: Cards and the Skill summary show accurate review state independently of columns, including finished-but-unsent, pending, Changes Requested, and Approval where applicable. Distinguish newest Submission Revision status from an earlier still-valid Approval; a latest pending revision must not falsely remove existing evidence or inherit an earlier revision's Approval.
- [ ] AC6: Exercise explicit send → Changes Requested → corrected send → Approval → newer pending revision → Approval Revocation through existing authorized workflows. Review changes update visible review/learning state but never automatically move cards, including a Changes Requested card still in Done. Approval/XP/Mastery continue to follow actual valid evidence, not board labels.
- [ ] AC7: Learners cannot add private Tasks to an Enrollment or edit/delete official Task definitions, required/reward settings, published graph content, or shared card positions. Backend authorization rejects direct attempts, not merely hidden buttons. Board customization cannot leak another learner's board or private Submission Draft.
- [ ] AC8: Initialize existing active Tasks with at least one valid Approval into Done, others into Backlog, retaining existing relative order where available. Preserve latest-revision status even when an earlier Approval qualified the initial placement. Archived history stays outside active columns. Initialization does not replay actions, change XP/Mastery/Approvals/Versions, duplicate cards/columns, or reset later customization under repeated/concurrent opens.
- [ ] AC9: Test two Learners and separate Enrollment contexts, including identical logical Skill/Task IDs in different Versions. Wrong Account/Enrollment/Version/Skill/column references and stale/conflicting edits are rejected appropriately without cross-context mutations, data loss, or false save success. Existing inactive/locked learning behavior and valid older evidence stay intact.
- [ ] AC10: Keyboard/non-drag use, narrow-screen details and horizontal board with column selection, visible review errors, focus restoration, and no-WebGPU navigation remain usable. Recoverable local changes and Submission Draft privacy survive errors/reload under their correct identity boundaries.
- [ ] AC11: Add current-build browser journeys using real role transitions and public API tests backed by real PostgreSQL. Assert both the reloaded board and actual learning/evidence records. Cover older valid Approval plus new pending revision and review outcomes leaving column placement unchanged. Run this slice's acceptance and current full regression checks before review.
- [ ] AC12: Map this ticket to parent AC-06, learner portions of AC-01/AC-03/AC-07/AC-08/AC-10, and user stories 6–7, 15–17, 25, 29–38, 43–45 as applicable. This does not substitute for UX04's preparation-board acceptance or UX02's real pointer connection checks.

## Testing and handoff

Use existing enrolled-learning, Submission, Review, revocation, privacy, and lifecycle behavior as test prior art. The primary seam is browser/application behavior, with real database-backed requests proving durable isolation and evidence rules. Do not treat a single mutually exclusive card badge as proof that all revision/evidence combinations are represented correctly.

UX04 and UX05 may proceed independently after UX03, with coordinated ownership of shared board code. Every ticket includes its own tests; the implementer integrating the last completed slice must also reconcile all parent criteria and run combined canvas → connections → boards → learning/review → return/reload acceptance, including keyboard, narrow screens, conflicts, and renderer fallback. Parent completion cannot be claimed from isolated ticket passes alone; publication does not modify or close parent #46.

## Blocked by

- [UX03 #49 — Personal Kanban and shared board/column contracts](https://github.com/harkon666/Gurow/issues/49).
