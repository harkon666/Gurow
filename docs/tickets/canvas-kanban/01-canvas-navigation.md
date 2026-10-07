## Parent

[Spec #46 — Canvas-first UI and per-Skill Kanban](https://github.com/harkon666/Gurow/issues/46)

## What to build

UX01: Replace permanent sidebars with a clean, accessible canvas navigation shell across personal, Coach Draft, and enrolled learning views. Provide a labeled toolbar and temporary Skill summary without removing existing capabilities. Remove implementation-oriented chrome while preserving truthful save feedback, recovery, and meaningful learning history. This combines the approved navigation and technical-cleanup slices.

Keep the existing Task presentation usable until the board tickets deliver their views; do not add a dead Open board action or claim Kanban exists in this slice. No engine replacement or learning-rule change is authorized.

## Acceptance criteria

- [ ] AC1: Personal, Coach Draft, and enrolled views have no permanently open left/right sidebar. Add Skill, searchable keyboard-navigable Skill list, and More actions are discoverable with text labels and appropriate permissions. Selecting a Skill opens the correct dismissible summary with learning outcome, relationships, and applicable learning state.
- [ ] AC2: Existing creation, copy/reuse, authorized deletion, Required/Enrichment and reward settings, Access/Mastery/XP controls, archived history, Submissions, and Reviews remain reachable in their proper context. Provide a separate Coach Review entry point. Test the actions rather than merely asserting old panels are absent.
- [ ] AC3: Keyboard users can enter the list, search, select different Skills, reach their Tasks and authorized actions, and dismiss temporary views with sensible focus restoration. Narrow viewports use usable full-screen details rather than permanent squeezed sidebars.
- [ ] AC4: User-facing views no longer display technical Skill IDs, save-revision numbers, Rust Owned/React Domain Payload labels, or the Simulate GPU Failure button. Internal identity, revision checks, and diagnostic/test hooks remain intact. Learning Path Versions and Submission Revision history remain accessible.
- [ ] AC5: Saving, saved, failed, and stale-conflict states remain distinct in user language. A rejected/stale save preserves recoverable local changes under the correct identity and never reports success. Exercise the actual recovery controls and a reload after successful save.
- [ ] AC6: Without WebGPU and under injected renderer failure, the Skill list still leads to Tasks, Submissions, and Reviews as authorized; the CPU-side document survives and retry remains available. Update fault injection to use a test facility rather than relying on a removed product button. Do not remove recovery coverage to make tests pass.
- [ ] AC7: Add current-build browser checks for the above journeys in applicable roles, with authenticated/persisted behavior where relevant. Preserve existing learning, layout-ownership, retention, and renderer-recovery regressions. Cross-context controls cannot grant unauthorized writes.
- [ ] AC8: Map this ticket to parent AC-01, AC-09, and the navigation/recovery portions of AC-08/AC-10, and user stories 1–5, 14, 25, 28, 39–45. Board-specific navigation and responsive checks continue in UX03–UX05; passing this ticket does not claim them complete.

## Testing and handoff

Use browser/application behavior as the primary seam and existing backend behavior for actual save/recovery checks. Test keyboard and narrow-screen flows from real controls, not component internals. Follow the current ticket harness: current-build checks, isolated ports/databases for parallel browser work, focused checks during fixes, and current full checks before review. Do not claim the separate headed P1 performance gate from functional results.

This ticket and UX02 may start independently, but shared editor-shell files require coordinated ownership rather than overlapping writers. At overall feature handoff, the implementer integrating the last completed slice must run the combined parent journeys; there is no separate integration ticket and no permission to omit that final check.

## Blocked by

None — can start immediately.
