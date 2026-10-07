## Parent

[Spec #46 — Canvas-first UI and per-Skill Kanban](https://github.com/harkon666/Gurow/issues/46)

## What to build

UX03: Deliver a complete personal Task Board for one Skill, including customizable columns, Task authoring and organization, durable authorized storage, safe retention, and coherent completion/XP. This combines the approved basic personal board and column-customization slices into one end-to-end feature.

Open the board from the temporary Skill summary and return to the prior canvas position and zoom. Establish the reusable board interaction/persistence contracts through this working personal feature, not through a separate framework-only refactor. Coach and Learner behavior is delivered by UX04 and UX05, not implicitly enabled by the personal implementation.

## Acceptance criteria

- [ ] AC1: Selecting a personal Skill and choosing Open board opens that Skill's spacious Task Board; returning retains canvas position/zoom. Multiple Skills and Paths show their own Tasks. Initial columns are Backlog, To Do, In Progress, Done, with exactly one Completion Column initially named Done.
- [ ] AC2: Authorized users add Tasks with a required title and optional description, edit them, reorder within columns, and move between columns via drag and a keyboard-operable menu/selection alternative. Column movement does not change Task ownership. Existing reward and other personal learning settings remain reachable rather than being removed by simplified Task authoring.
- [ ] AC3: Entering the Completion Column completes the Task; leaving it undoes completion under existing backend-confirmed permissions and XP Award/Correction rules. Retry/repetition does not multiply rewards. Personal Mastery stays unchanged. Any retained alternate completion action keeps membership consistent with completion, rather than creating another source of truth.
- [ ] AC4: Users add, rename, reorder, and remove columns. Completion depends on column identity/role rather than its label. Removing a populated column requires an explicit surviving destination and never deletes Tasks. Removing the last usable column is prevented.
- [ ] AC5: Removing the Completion Column requires a replacement and a Task destination. Explain the consequences before confirmation and reconcile affected Task membership/completion as one validated change. Cross-completion-boundary moves caused by column deletion follow the same XP rules as direct moves; no persisted state can show a Task completed outside its designated column or incomplete inside it.
- [ ] AC6: Eligible Task deletion offers undo using a normal revalidated edit. Tasks with history instead follow explicit revision-checked Archival; archived records remain reachable outside active columns, preserve progress/XP/Mastery, and cannot be resurrected by board undo or stale document saves. Keep Task title/description and membership consistent after creation, reuse, deletion, or archival through existing permitted entry points.
- [ ] AC7: Initialize existing active completed personal Tasks in Done and other active Tasks in Backlog, preserving existing relative order where available. Do not replay completion, change XP/Mastery, duplicate cards/columns, or place archived Tasks in active columns. Repeated/concurrent initialization and reopening preserve subsequent customization.
- [ ] AC8: Server-side validation enforces personal ownership and same-Skill/board membership. Wrong Account/Path/Skill/column/Task operations are rejected. Column ordering, card ordering, names, role, and membership survive reopening and actual UI reload; another Skill/Path/Account is unchanged.
- [ ] AC9: A completion-coupled move cannot persist only the column or only the learning update. Test rejected writes, retries/lost answers, and competing tabs. Stale changes do not silently overwrite newer organization or lose Tasks; user-visible errors retain recoverable local intent under the correct identity, and saved feedback requires backend confirmation.
- [ ] AC10: At narrow viewports the board supports horizontal navigation and a usable column selector, with full-screen details as appropriate. Keyboard users reach Task/column actions, get useful validation feedback and focus restoration, and can manage Tasks without drag or WebGPU.
- [ ] AC11: Browser tests prove the complete personal journey and reload; API tests backed by real PostgreSQL prove ownership, initial placement, conflicts, atomic completion changes, retry-safe XP, and retention. Assert stored learning state independently of optimistic UI. Follow the current harness, including current-build acceptance and full affected regressions before review.
- [ ] AC12: Map this ticket to parent AC-03/AC-04, personal portions of AC-01/AC-07/AC-08/AC-10, and user stories 6–7, 15–25, 36–38, 43–45 as applicable. The board contracts must be usable by later role-specific tickets without sharing learner progress or mutating published definitions.

## Testing and handoff

Use the agreed browser/application primary seam and public backend requests against real PostgreSQL; reuse existing personal-learning, retention, save-conflict, and keyboard test patterns. Prefer behavior-level assertions rather than private storage layout. Include completion-column replacement with populated columns, a completed Task whose reward changes, repeated completion/uncompletion, and a failed coupled update without inventing new XP rules.

All tests for this slice land here. UX04 and UX05 depend on its working board/column contract, not on a speculative generic component. When all five feature tickets are complete, final handoff must include the combined parent journeys and current acceptance mapping; no separate integration ticket is being created.

## Blocked by

- [UX01 #47 — Clean canvas navigation](https://github.com/harkon666/Gurow/issues/47).
