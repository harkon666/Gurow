# T18 Coach Workspace and Learning Path Draft: local evidence

Ticket [#19](https://github.com/harkon666/Gurow/issues/19) (T18). Recorded on 2026-10-05 from harness checks of branch `feat/t18-coach-learning-path-draft`, based on `6c9c672`, with the T18 changes in the working tree. Run logs stay local in `.harness/runs/`. This report was written before the final full check, which covers it.

An Account switches from its personal context to its owning-Coach context, creates a Coach Workspace and authors coach-mode Learning Paths as Drafts in the same editor as personal Paths. A Draft is the Path's one unpublished Version ([ADR 0005](../adr/0005-keep-learners-on-their-learning-path-version.md)); its document has the T16 editor/application split ([ADR 0016](../adr/0016-save-editor-snapshots-with-revision-checks.md)) and also carries the Draft's rules: Required or Enrichment Tasks with rewards, Optional Skills, and XP Thresholds. Routes and refusals are described in the [backend README](../../backend/README.md#coach-workspaces-and-learning-path-drafts-t18).

## Environment

| Item | Value |
|---|---|
| Database | PostgreSQL from `compose.yaml` on 127.0.0.1:5433; migration `0011_coach_drafts` applied |
| Backend tests | `gurow_test`, truncated before each test |
| Browser check database | `gurow_t18_browser_test`, migrated and emptied before the run |
| Browser | Headless Chromium via puppeteer-core, `--enable-unsafe-webgpu --use-gl=angle`, 1800×900; the check requires WebGPU status `ready` |
| Served backend | `backend/src/index.ts` (production entry, Better Auth sessions) |
| Served frontend | Nitro production build, `/api/*` forwarded to the backend |

## Commands and outcomes

| Command | Coverage | Result |
|---|---|---|
| `bun test test/coach-authoring.test.ts` (backend) | Workspace ownership and the non-owner matrix, two Paths on one subject, ID claims across Paths and modes, Draft rules and their validation, the Optional-Prerequisite rule, cycles, outside connections, no enrolment in a Draft, stale and competing saves | 5 pass, 0 fail |
| `bun test src/components/path/draftRules.test.ts` (frontend) | The editor's Optional-Prerequisite checks for connections, existing graphs and Optional toggles | 3 pass, 0 fail |
| `bun run scripts/t18-coach-draft-check.ts` (frontend) | Browser flow below, on a fresh build | 8 of 8 steps passed |
| Full harness check and the T04/T05/T06/T15/T16/T17/T44 checks | Regressions after the editor gained a coach mode and the header a context switch | see the final run in `.harness/` |

Browser steps:

1. **Contexts**: the Account creates a private personal Path, then switches to "Coaching". No Workspace is listed yet. It creates "Linear Algebra Studio", and the header reads "Coaching · Linear Algebra Studio".
2. **Draft rules**: a Draft "Linear Algebra" opens in the editor marked "Draft · not published", without personal XP. The Coach adds Vectors (one Required Task worth 20 and one Enrichment Task worth 5), Matrices (threshold 20, one Required Task worth 30), an Optional "History of algebra", and Eigenvalues (threshold 50, no Task yet). Three Prerequisites are added. The stored Draft holds exactly these rules, and the list shows Required/Optional and thresholds.
3. **Immediate refusals**: connecting the Optional Skill to Matrices is refused in the panel with both titles. Making Vectors Optional (it leads to Matrices) is refused. A cycle is refused by the engine. The graph, the Draft and its revision are unchanged, and the page stays "saved".
4. **Backend validation**: the same edits sent directly answer 422 `optional_prerequisite` and `prerequisite_cycle`, and a connection to a Skill of the second Path answers 422 `connection_outside_path`. The Draft is unchanged.
5. **Independent Paths**: a second Draft, "Linear Algebra for Engineers", has its own Vectors Skill with a different outcome and Task. The Workspace lists both Paths.
6. **Reload**: Optional, thresholds, Required/Enrichment, rewards and Prerequisites reopen in the editor. None of the coach pages' API requests (28) goes to `/personal`, and no coach page shows the personal Path.
7. **Context switch back**: the Personal Workspace lists only the personal Path.
8. **Another Coach**: a second Account lists no Workspace. It sees "not available" for the first Coach's Workspace and Draft, and its API reads and writes answer 404. Its own new Workspace does not appear in the first Coach's list, and the first Coach's Draft is unchanged.

Mutation checks, each restored afterwards: removing the Optional-Prerequisite rule from the backend failed AC4; dropping the Workspace owner check from the Path lock failed AC1; accepting a Skill ID owned by another Path failed AC2; removing the editor's Optional check before connecting failed browser step 3.

## T06 check fix

The `t06-functional` check had an intermittent timeout at its first "+ Skill" click on `/editor`, reported in the [T17 report](t17-personal-learning-report.md), and it blocked two T18 full runs in a row. Diagnostics showed the button was still disabled when clicked: the fixture labels and the "WebGPU Rust Editor" badge appear while the renderer is initializing, and the button is enabled only once it is ready. The product behaved correctly, but the check clicked too early. It now waits for the button to be enabled. Run after `editor-lifecycle`, the sequence used in the full check, it failed 1 of 3 and 1 of 6 runs before the fix and passed 6 of 6 after it.

## T15 check expectation

The T15 sign-in check asserted that no header text matches "coach" or "learner", so that an Account is never shown as an Account type ([ADR 0010](../adr/0010-use-contextual-coach-and-learner-roles.md)). The Personal/Coaching switch added here names a context the Account can act in, which ADR 0010 and this ticket's context-switch criterion call for. The check now applies the same assertion to the header without the switch, and asserts separately that the switch offers "Personal" (current) and "Coaching".

## What is not verified

- An Account may own several Coach Workspaces; each still has exactly one owner. The MVP documents do not limit the number per Account.
- Publication, the required-route validation and new Versions after publication belong to T19. A Path with no open Draft shows "no open Draft" and refuses saves (409 `no_open_draft`), but this ticket never creates such a Path.
- Learner-facing coach views are later slices (T21). Here "no personal data in a coach context" is checked on the Coach's own pages and requests.
- Removing Skills or Tasks from a Draft is refused until T32. Copying Skills between Paths belongs to T29.
- Keyboard-only authoring of Draft rules is possible (native inputs and checkboxes) but not exercised. The headed P1 performance capture was not run.
