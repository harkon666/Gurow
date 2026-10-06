# T27 Updating a shared Canvas Layout without changing learning content: local evidence

Ticket [#28](https://github.com/harkon666/Gurow/issues/28) (T27). Recorded on 2026-10-06 from harness checks of branch `feat/t27-shared-canvas-layout`, based on `d252093`, with the T27 changes in the working tree. Run logs stay local in `.harness/runs/`. This report was written before the final full check, which covers it.

A published Version's page now shows its shared Canvas Layout above the read-only content, on a canvas in a new layout-only mode. The owning Coach can drag cards and undo or redo those moves. The engine refuses new cards and connection changes there, and the page offers none. Each completed move autosaves the card positions alone against the Version's own layout revision. Undoing a saved move is sent as a new save. The same view appears on the Path page when no Draft is open. A stale save is refused. The arrangement on the canvas is kept, unsaved, and autosave stops until the Coach discards it and loads the saved layout. If that load fails, the conflict and its control stay, and the Coach can try again. The Coach's camera is stored locally under his Account and the Version. Each learner's camera is stored under their own Account and Enrollment. Learners see the latest layout when they reopen their Enrollment, on the same read-only canvas as in T21.

Engine: `SetLayoutOnly` (`engine-core`) lets a canvas move cards and undo or redo the moves, while refusing `CreateCard`, `ConnectSkills` and `DisconnectSkills` with a reason. Replacing the document no longer re-applies the initial camera (`useWasmEditor`). The camera is restored for a new engine or a new camera only, so loading a saved document keeps the viewer's navigation. This also applies to discarding a Draft's local edits in the Path editor.

Backend: migration `0015_version_layout_revision` adds `learning_path_versions.layout_revision`, the expected revision of layout saves. It is distinct from the Path's content revision, the Version number and the snapshot format version. `PUT /api/coach/learning-path-versions/:versionId/layout` accepts exactly `{ expectedRevision, cards: [{ id, position }] }` for a published Version of a Path in the caller's Workspace:

- It locks the Version row and writes only moved cards.
- It advances the layout revision only on a change.
- It leaves the Path revision, the Version's content, every other Version and every Enrollment's records untouched.
- It creates no Version.

Refusals:

- A body naming anything else (titles, Tasks, connections, rules) answers 422 `invalid_layout` as a whole.
- A Skill outside the Version answers 422 `skill_not_in_version`.
- A stale revision answers 409 `stale_revision` with the accepted document.
- Every other Account, including learners and other Coaches, gets 404 `version_not_found`, also for a malformed body. A Draft's layout stays part of the Draft save.

## Environment

| Item | Value |
|---|---|
| Database | PostgreSQL from `compose.yaml` on 127.0.0.1:5433; migration 0015 applied to the test databases |
| Browser check database | `gurow_t27_browser_test`, migrated and emptied before the run |
| Email | The Resend HTTP mailer, pointed at the local stand-in; every verification and Invitation link is read from a delivered email |
| Browser | Headless Chromium via puppeteer-core, `--enable-unsafe-webgpu --use-gl=angle`, 1400×900; one browser context per person, two tabs for the Coach in step 6 |
| Served backend and frontend | `backend/src/index.ts` with Better Auth sessions; Nitro production build, `/api/*` forwarded |

## Commands and outcomes

| Command | Coverage | Result |
|---|---|---|
| `cargo test -p engine-core layout_only` | A drag moves a card as one undo step; undo/redo of moves; new cards and connection changes refused with a reason, document unchanged; leaving the mode restores editing | 1 pass |
| `bun test src/components/editor/protocol.test.ts` (frontend) | `SetLayoutOnly` command schema | pass |
| `bun test test/version-layout.test.ts test/enrolled-version.test.ts` (backend) | Layout save by the owner without a new Version or content change; the learner's reopened Version shows it; content/rule fields, foreign Skills, bounds and duplicates refused; learners, peers, other Coaches and the unauthenticated refused, also with malformed bodies; a Draft is not a published Version; learning records (XP, Mastery, Reviews, starts, Submissions) identical before and after; stale save refused with the accepted layout; undo as a new save; concurrent saves on one revision, exactly one accepted | 9 pass, 0 fail |
| `bun run scripts/t27-shared-layout-check.ts` (frontend) | Browser flow below, on a fresh build | 7 of 7 steps passed |
| Full harness check (backend 205 tests, frontend 317 unit tests, Rust, every earlier browser check) | Regressions | see the final run in `.harness/` |

Browser steps, with real Accounts that sign up and verify through emailed links. Carla publishes Linear Algebra: Vectors (Required "Vector drills", 20 XP) before Matrices (requires Mastery of Vectors and 20 XP; Required "Matrix drills", 15 XP), cards at (80, 120) and (420, 160). Lena accepts Carla's emailed Invitation. Through the API, Lena sends Vector drills and Carla approves it (20 XP, Vectors mastered). Lena then starts Matrix drills and sends it. The Path, Version, Skill, Task, Prerequisite and Enrollment rows and the learning records of both readers are recorded at this point.

1. **Learner view**: Lena opens her Enrollment (WebGPU ready) and zooms to 135%. Her camera is stored under her Account and Enrollment.
2. **Coach layout save**: on the Version page, the canvas is layout-only. It shows the "Layout only · content stays as published" badge and Undo, and offers no Skill, connection or title controls. Carla zooms to 74% and drags Matrices by (150, 90) px; the page says "Saved · layout revision 1". PostgreSQL stores Matrices moved by (150, 90)/0.74 world units and Vectors unchanged. The Version count stays 1 and no Version 2 link appears. The recorded rows and learning records are identical.
3. **Undo is a new save**: Undo saves revision 2 with Matrices back at (420, 160). Redo saves revision 3 at the moved position. Nothing else changes.
4. **Layout refresh and camera isolation**: Lena's open page is unchanged until she reopens it. Then Matrices has shifted by the stored world delta at her own 135%, with her stored camera and keys unchanged. Carla's 74% is restored from her Version key. Carla's view of Lena's Enrollment opens at 100%.
5. **Learner mutation rejected**: Lena's canvas is read-only, with no Undo and no save status. Dragging Matrices pans without moving it. Her layout PUTs (plain, with content fields, and on her Enrollment) answer 404. The Coach Version page is unavailable to her. The stored layout is unchanged.
6. **Stale layout save**: Carla has two tabs at revision 3, and tab B zooms to 100%. Tab A moves Vectors and saves revision 4. Tab B moves Matrices and is refused: "Layout revision 4 was saved elsewhere. Your arrangement here is kept but not saved." Its card stays moved and the store keeps revision 4. A further move in tab B is not sent. Loading the saved layout fails once (the request is rejected in the page). The conflict, an error and the control to try again stay, and nothing changes. The second attempt shows revision 4, with tab B still at its own 100% camera.
7. **Unchanged learning**: after four layout saves and a refused one, the recorded rows and learning records are identical. They include the Path revision, Version 1 content, Enrollment, 20 XP, Mastery of Vectors, and the approved and pending revisions, for both readers. Lena's page shows Version 1, 20 XP and Vectors mastered.

Mutation checks, each restored afterwards. Each one failed the named test:

| Mutation | Failed |
|---|---|
| The layout revision is not compared (any save overwrites) | Backend AC4 |
| Extra body fields (content) are not refused | Backend AC3 |
| A stale answer is treated as an ordinary failure in the layout editor | Browser step 6 |

## Decisions

- A published Version has its own layout revision rather than sharing the Path's content revision. Arranging Version 1 never conflicts with editing or publishing the Draft. A Draft's layout stays part of the Draft save.
- A layout save carries positions only, and any other field refuses the whole request, so no layout request can be read as a content change. Cards of the Version's own Skills may be sent in any subset; only moved cards are written.
- The layout editor sits on the Coach's Version page, above the published content. The page has room for the canvas, and the Coach reads the content beside the arrangement.

## Review fixes

An independent review reported two Spec findings (P2) and no actionable Standards finding:

- **A failed "Discard mine" left the editor stuck, fixed with a test**: when loading the saved layout failed, the conflict became a failed save. That hid the Discard control, and Retry sent nothing because autosave stays stopped after a conflict. Reproduced by browser step 6 (the request rejected once). The conflict and its control now stay, with the error beside them, and a second attempt loads the layout. Step 6 passes.
- **Discarding restored the mount-time camera, fixed with a test**: replacing the cards re-applied the camera the page had opened with, and that old camera was then stored. Reproduced by browser step 6 (tab B zoomed to 100% came back at 74%). The camera is no longer re-applied when the document is replaced; this applies to every editor. Step 6 passes.

The same failed-Discard pattern in the Draft editor (`PathEditor`, T16/T18) is not changed here. T28 covers recovery of stale editor saves. The review's Standards note is also T28 scope: an unsaved arrangement is lost when the page is left or reloaded, and the page asks before leaving.

## Not proven here

- The engine's refusal of card and connection edits on the Coach canvas is proven by the Rust test only. The page offers no control for them.
- The Coach layout page without WebGPU (list only) and the layout view on the Path page (no open Draft) are not driven by a drag. The latter is rendered by the T19 regression only.
- Local recovery of an unsaved arrangement across reloads is T28.
- The headed P1 capture was not run.
