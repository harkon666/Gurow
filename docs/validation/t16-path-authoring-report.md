# T16 personal Learning Path authoring: local evidence

Ticket [#17](https://github.com/harkon666/Gurow/issues/17) (T16). Recorded on 2026-10-05 from harness full checks of branch `feat/t16-author-personal-learning-path`, based on `bdfca14`, with the T16 changes in the working tree. Run logs stay local in `.harness/runs/`. This report was written before the final full check, which covers it.

The owner authors a personal Path in the browser editor and the backend stores it as one document per save: the editor snapshot (format version, one card per Skill with its position, connections) beside the application payload (Path title and goal, Skill titles and outcomes, Tasks), based on an expected revision ([ADR 0015](../adr/0015-own-live-editor-state-in-rust.md), [ADR 0016](../adr/0016-save-editor-snapshots-with-revision-checks.md)). The API is described in the [backend README](../../backend/README.md#personal-path-authoring-t16).

## Environment

| Item | Value |
|---|---|
| Database | PostgreSQL 18.6 from `compose.yaml` on 127.0.0.1:5433; migration `0010_personal_authoring` applied |
| Backend tests | `gurow_test`, truncated before each test |
| Browser check database | `gurow_t16_browser_test`, migrated and emptied before the run |
| Browser | Headless Chromium 152.0.7977.82 via puppeteer-core, `--enable-unsafe-webgpu --use-gl=angle`; the check requires the editor's WebGPU status `ready` |
| Served backend | `backend/src/index.ts` (production entry, Better Auth sessions) |
| Served frontend | Nitro production build, `/api/*` forwarded to the backend |

## Commands and outcomes

| Command | Coverage | Result |
|---|---|---|
| `bun test test/authoring.test.ts` (backend) | AC1–AC5 at the request boundary on PostgreSQL | 10 pass, 0 fail, 204 assertions |
| `bun test` (backend) | All backend suites | 151 pass, 0 fail |
| `bun test src/components/path/autosave.test.ts` (frontend) | Autosave timing, revisions, conflict, failure, leaving (also during a save in flight) | 9 pass, 0 fail |
| `bun test` (frontend) | All frontend unit tests | pass |
| `bun run scripts/t16-path-authoring-check.ts` (frontend) | Browser flow below, on a fresh build | 9 of 9 steps passed |
| t15-sign-in, t04, t05, editor-lifecycle, t06-functional, t44 label-scroll | Regressions after sharing the sidebar and list with the P1 editor | all passed |

Browser steps (one signed-in Account unless noted):

1. **Authoring**: create a Path with a goal from the Personal Workspace; add two Skills with outcomes, one Task each, and a Prerequisite. The stored document has both Skills, each Task under its own Skill, one connection, and an editor snapshot without any Task or outcome text.
2. **Cycle rejection**: connecting back to the first Skill is rejected by the editor at once; the live graph, the save revision and the stored connections are unchanged.
3. **Drag autosave and local camera**: a completed drag is saved (+90, +60, revision + 1). Pan and zoom are stored only in `localStorage` under `gurow:camera:<accountId>:<pathId>` and cause no save.
4. **Coherent reload**: the same cards appear at the same screen positions under the restored camera; each card opens its own outcome and Task; no Skill is selected and Undo is disabled.
5. **Multiple Paths**: a second Path holds only its own Skill and opens at the default camera. With its first goal save held on the network, a second goal edit is made and the editor is left; once the held save completes, the second edit is saved after it (revision 3). The first Path reopens from the Workspace unchanged.
6. **Stale save**: this tab saves a goal of its own; a second tab then saves another; the stale tab's edit is refused, autosave stops, and both of its later local edits stay on screen while the backend keeps the other tab's revision. Discarding loads the accepted version, and changing the goal back to this tab's earlier value is stored as a new revision, not merely shown as saved.
7. **Failure feedback**: with the save request aborted, the status goes `dirty → saving → failed` with the error shown, never `saved`; the backend is unchanged and the field keeps the edit; Retry saves it.
8. **Invalid edits**: through the API, a cycle answers 422 `prerequisite_cycle` and another Path's Skill 409 `skill_owned_elsewhere`; the document is unchanged.
9. **Unauthorized Account**: another Account sees "Learning Path not available" without the owner's content; its API read and write answer 404; the owner reopens the Path unchanged.

The backend suite adds what the browser does not reach: the full owner-only matrix (peer, both Coaches, unrelated and unverified Accounts, anonymous; coach-mode, unknown and malformed Path IDs); refusal of foreign Skill and Task IDs and of moving a Task to another Skill, with no partial writes; two Paths racing to claim one new Skill ID (exactly one wins); eight competing saves on one revision (exactly one accepted); unchanged saves keeping the revision; and content saves leaving XP, Mastery, rewards and their histories untouched.

Mutation checks, each restored afterwards: removing the revision check failed both AC4 backend tests; removing cycle detection and removing the Task-to-Skill check each failed an AC3 test; a frontend that resends after a 409 failed browser step 6; closing the editor without sending an edit made during an in-flight save failed browser step 5 and an autosave unit test; reinstating a client-side "already saved" cache failed browser step 6 (status "saved" at revision 4 while the backend needed revision 5).

An independent review of the first version found two autosave defects, both fixed here. A client-side cache skipped sending a document equal to the last one this tab had saved, so after discarding a conflict (or after another tab saved meanwhile), returning to that content showed "saved" without reaching the backend; every save is now sent, and the backend keeps the revision for an unchanged document. Leaving the editor while a save was in flight dropped later edits; the autosave now reads the document when the editor closes and sends it after the in-flight save, on the revision that save was accepted at, unless that save turned out stale.

During development, the first browser runs failed because the check clicked "Add Skill" before the asynchronous Wasm/WebGPU engine existed. "Add Skill" is now disabled until the engine reports a status, and the check waits for `ready`. A later failure showed that discarding to the saved version left the engine's selection set; it is now cleared there too.

## What is not verified

- Unsaved local work lives only in the open page. After a conflict or failure, a reload (which now asks first) loses it; persisted recovery and richer conflict resolution belong to T28.
- Renaming a Skill after creation, and deleting Skills, Tasks or connections beyond removing a connection, are not offered; removal is refused by the backend until T30/T32.
- Adding Skills without WebGPU (the CPU fallback editor) is possible but not exercised by this check.
- A deployed origin, HTTPS and production configuration are not exercised (see the [T15 report](t15-sign-in-report.md)).
- The headed P1 performance capture was not run; this ticket does not change rendering.
