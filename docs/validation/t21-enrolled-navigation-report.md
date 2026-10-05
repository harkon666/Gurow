# T21 Navigating an enrolled Version: local evidence

Ticket [#22](https://github.com/harkon666/Gurow/issues/22) (T21). Recorded on 2026-10-05 from harness checks of branch `feat/t21-navigate-enrolled-version`, based on `8f1abc6`, with the T21 changes in the working tree. Run logs stay local in `.harness/runs/`. This report was written before the final full check, which covers it.

An enrolled learner opens the Version their Enrollment joined, on the Coach's shared Canvas Layout or through the keyboard Skill/Prerequisite list, and reads each Skill's outcome and Tasks. Access, Mastery and Enrollment XP are shown separately, as the backend derives them. The canvas is read-only for learners: the engine's `SetReadOnly` mode lets them pan, zoom and select, and turns a drag on a card into a pan. Routes are described in the [backend README](../../backend/README.md#navigating-an-enrolled-version-t21).

## Environment

| Item | Value |
|---|---|
| Database | PostgreSQL from `compose.yaml` on 127.0.0.1:5433; no new migration |
| Backend tests | `gurow_test`, truncated before each test; fixture identities over the controlled P2 fixture, whose Version 1 is amended as published content |
| Browser check database | `gurow_t21_browser_test`, migrated and emptied before the run |
| Email | The Resend HTTP mailer, pointed at the local stand-in of `POST /emails`; every verification and Invitation link is read from a delivered email |
| Browser | Headless Chromium via puppeteer-core, `--enable-unsafe-webgpu --use-gl=angle`, 1400×900; separate browser contexts per person, one shared by two learners for the camera check; a page without `navigator.gpu` for the list-only check |
| Served backend and frontend | `backend/src/index.ts` with Better Auth sessions; Nitro production build, `/api/*` forwarded |

## Commands and outcomes

| Command | Coverage | Result |
|---|---|---|
| `cargo test -p engine-core read_only` | Read-only canvas: select, pan by dragging a card, zoom, refused edits, layout loading, a drag cancelled by entering read-only | 2 pass, 0 fail (27 engine-core tests in all) |
| `bun test src/components/editor/protocol.test.ts` (frontend) | `SetReadOnly` command schema | pass |
| `bun test test/enrolled-version.test.ts` (backend) | Pinned content and layout, Access/Mastery/XP and lock reasons with readable history, learner writes refused, visibility | 4 pass, 0 fail |
| `bun test` (backend) | All backend suites | 195 pass, 0 fail |
| `bun run scripts/t21-enrolled-navigation-check.ts` (frontend) | Browser flow below, on a fresh build | 8 of 8 steps passed |
| Full harness check and the T04–T06, T15–T20, T44 checks | Regressions | see the final run in `.harness/` |

Browser steps, with real Accounts that sign up and verify through emailed links:

1. **Enrollment opens its Version**: the Coach publishes Linear Algebra (Vectors; Matrices requiring Mastery of Vectors and 20 XP) and invites Lena, who accepts from the emailed link. "Open Linear Algebra, Version 1" opens her Enrollment with a WebGPU canvas and the list. Clicking the Vectors card shows its outcome and its Required and Enrichment Tasks.
2. **Pinned content**: the Coach publishes Version 2, renaming Vectors to "Vectors (revised)". Lena's page, canvas labels and Enrollment list still show Version 1.
3. **Access, Mastery and XP**: Matrices is shown locked in the list and on its card, with "Requires Mastery of “Vectors”" and "Needs 20 more XP: the threshold is 20 XP and this Enrollment has 0 XP", its outcome and its Task. After the Coach approves Vectors' Required Task (sent through the API; the submission UI is T22): 20 XP, Vectors mastered, Matrices open. Lena starts Matrices and sends work. The Coach revokes the Approval: 0 XP, Matrices locked again with both reasons, and its pending work and the revoked Approval remain readable.
3b. **Open page follows the Coach**: with the page left open, the Coach approves a new revision; returning to the page shows 20 XP, Vectors mastered, Matrices open and both revisions. The Coach deactivates the Enrollment; Refresh shows it inactive, every Skill locked and Mastery and XP kept. After reactivation and another revocation, returning shows it active, with 0 XP and Matrices locked.
4. **Read-only canvas**: the page has no inputs and no add, connect, undo, redo or save controls. It shows "View only · layout by the Coach". Dragging the Matrices card by (+90, +60) selects it and pans both cards by that amount, keeping their relative position. Ctrl+Z does nothing, and Ctrl+wheel zooms. Lena's requests to save a Draft, read the Coach's Version or write her Enrollment's Version answer 404, and the stored layout is unchanged. A Coach layout change appears when she reopens the page. It is written in SQL here because the Coach's layout UI is T27.
5. **Camera isolation**: Lena's pan and zoom are stored only under `gurow:camera:<Lena>:enrollment:<her Enrollment>` and restored on reopening. In the same browser storage, Pia opens her own Enrollment in the same Version at 100%. Her view is stored under her own key, and Lena's camera is unchanged.
6. **Privacy**: Pia, enrolled in the same Version, and Oscar, the Coach of another Workspace, see "Enrollment not available" without its content. Their reads of Lena's Version, records and Submissions answer 404, and Pia lists only her own Enrollment. Carla, the owning Coach, opens it in the coach context.
7. **No WebGPU**: without `navigator.gpu`, the list-only page reaches Matrices by keyboard, showing it locked with both reasons and 0 XP, its Task and its submitted work. It then reaches Vectors and its Task. Nothing is editable.

Mutation checks, each restored afterwards. Each one failed the named test:

| Mutation | Failed |
|---|---|
| Read-only engine still drags cards | Engine read-only test; browser step 4 |
| Enrollment view readable by any Account | Backend AC5 |
| Enrollment view shows the Path's latest Version | Backend AC1 |
| Camera stored per Version, shared across Accounts | Browser step 5 |
| Lock reasons hidden | Browser step 3 |
| Task details editable without an edit handler | Browser step 1 |
| No revalidation when returning to the page | Browser step 3b |
| Task history not read again with the records | Browser step 3b |

## Review fixes

An independent review found one Spec problem, fixed with a test. The learning records were read only when the page opened, so a page left open kept showing Access, Mastery and XP the Coach had since changed. The page now reads them again whenever it becomes visible or regains focus, and offers Refresh at any time. Records on show stay until a confirmed answer replaces them; a failed read keeps them and says they may be out of date. Task histories on show are read again with each confirmed read (browser step 3b).

The review's Standards note suggested sharing the browser scripts' helpers (`api`, `setValue`, `emailedLink`). They are kept local: every browser check carries its own, and extracting them for some scripts only would mix two patterns. That is a separate refactor across all checks.

## Not proven here

- The Coach's UI for changing a published Version's layout is T27. The reopening step writes the change in SQL.
- Learner Submissions and Coach Reviews are made through the API; their UIs are T22 and T23.
- The learner is not told when a newer Version exists. That was not agreed; the page states that the Enrollment stays on its Version. Records are re-read on return and on request, not pushed in real time.
- The owning Coach can open `/enrollments/:id` (ADR 0013 allows it), but navigation to it from the Coach's pages is later work.
- Keyboard checks cover list navigation and Task details, not the Tab order of every control. The headed P1 capture was not run.
