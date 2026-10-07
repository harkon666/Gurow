## Parent

[Spec #46 — Canvas-first UI and per-Skill Kanban](https://github.com/harkon666/Gurow/issues/46)

## What to build

UX04: Give an authorized Coach a customizable Task Board for preparing one Skill's Tasks within a Learning Path Draft. Use the working board contracts from UX03 while enforcing Coach/Draft ownership rather than borrowing personal completion semantics. Deliver UI → authorized backend → persistence → restored browser behavior with tests in this slice.

Initial columns are Ideas, In preparation, Ready (Ide, Sedang disusun, Siap). These express material readiness only, not publication eligibility, Approval, or learner progress. Review remains a separate reachable workflow.

## Acceptance criteria

- [ ] AC1: A Coach opens a Draft Skill summary, enters its preparation board, and returns to the prior canvas position and zoom. Initial columns and the correct Tasks appear, with persistence scoped to the authorized Coach Draft and Skill.
- [ ] AC2: The Coach adds/edits Tasks with title and optional description, reorders/moves cards, and customizes columns through drag and non-drag controls. Required/Enrichment designation, XP rewards, Skill rules, and other existing authoring controls remain accessible. Invalid empty titles or out-of-context references are rejected through the normal application boundary.
- [ ] AC3: Rename/reorder/add/remove columns persist after reload. Deleting a populated column requires a surviving destination and keeps every Task; the last usable column cannot be removed. No personal Completion Column coupling is applied to Draft columns.
- [ ] AC4: Moving a Task to Ready neither grants Approval/XP/Mastery nor changes a Learner's board or learning state. Publishing still follows existing progression validation: column name/placement is not an additional eligibility rule. Draft readiness positions are not copied as learner progress.
- [ ] AC5: Published Task definitions and rules remain immutable. Changes to published material require the normal Draft/new-Version workflow. Learners and unauthorized Accounts cannot edit Draft columns, Task definitions, or rewards; board persistence cannot be used to rewrite published content or shared learning records.
- [ ] AC6: Existing Draft Tasks initialize into the first preparation column, retaining relative Task order where available. Initialization is repeat/concurrency safe and does not reset customization, modify Versions, or change evidence/XP/Mastery. Tasks created/reused later remain associated with the right Skill and usable in the board.
- [ ] AC7: Eligible Draft Task deletion and undo remain validated; material retained by published Versions follows the existing explicit Archival contract instead. Archived Draft material does not reappear through board undo or stale reapplication. Existing published Versions and their learner evidence remain unchanged, with archived history still reachable.
- [ ] AC8: The separate Review entry point still reaches authorized submitted learner work without exposing private Submission Drafts. The board is not a learner-assessment queue, and navigating to review does not mutate preparation columns.
- [ ] AC9: Test save/reload, wrong Coach/Workspace/Draft/Skill references, stale/conflicting writes, rejected changes, and identity switching. Preserve recoverable local intent without falsely reporting saved or leaking another context's content. Cover keyboard/non-drag workflows, narrow-screen board/column navigation, and learning navigation without WebGPU.
- [ ] AC10: Add browser acceptance and real-PostgreSQL request tests for the complete Coach journey, including publication without a new column-based gate and preservation of published material/history. Follow current-build harness checks and current full regression checks before review; UX03's personal tests do not establish Coach acceptance.
- [ ] AC11: Map this ticket to parent AC-05, Coach portions of AC-01/AC-03/AC-07/AC-08/AC-10, and user stories 6–7, 15–17, 23–28, 35, 37–38, 43–45 as applicable.

## Testing and handoff

Use the existing Coach Draft/publication browser patterns and public API/database fixtures. Assert actual domain records and a reloaded UI rather than private component state. Coordinate shared board contracts with UX05 through non-overlapping changes or serial ownership; neither role-specific ticket blocks the other after UX03 is done.

Each slice owns its tests. The implementer integrating the last of the five tickets owns the final combined parent acceptance run and coverage reconciliation across canvas, connections, all boards, review, return/reload, keyboard, narrow screens, conflicts, and renderer fallback. This is an overall handoff condition, not a hidden UX04→UX05 dependency or a new integration issue.

## Blocked by

- [UX03 #49 — Personal Kanban and shared board/column contracts](https://github.com/harkon666/Gurow/issues/49).
