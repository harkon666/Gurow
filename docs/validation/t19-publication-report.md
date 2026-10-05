# T19 Publishing a Learning Path Version: local evidence

Ticket [#20](https://github.com/harkon666/Gurow/issues/20) (T19). Recorded on 2026-10-05 from harness checks of branch `feat/t19-publish-learning-path-version`, based on `675e33b`, with the T19 changes in the working tree. Run logs stay local in `.harness/runs/`. This report was written before the final full check, which covers it.

A Coach publishes a Draft only when its required route can be completed under ordinary rules ([ADR 0008](../adr/0008-validate-required-progression-before-publication.md)). A blocked route is refused with the affected Skills and their unmet requirements. A published Version's learning content and rules are frozen ([ADR 0005](../adr/0005-keep-learners-on-their-learning-path-version.md)). Changes go into a new Draft copied from the latest Version, keeping the logical Skill and Task IDs ([ADR 0004](../adr/0004-scope-skills-and-tasks-to-learning-paths.md)). Routes and refusals are described in the [backend README](../../backend/README.md#publishing-a-learning-path-version-t19).

## Environment

| Item | Value |
|---|---|
| Database | PostgreSQL from `compose.yaml` on 127.0.0.1:5433; migrations `0012_published_versions_immutable` and `0013_version_title_goal` applied |
| Backend tests | `gurow_test`, truncated before each test |
| Browser check database | `gurow_t19_browser_test`, migrated and emptied before the run |
| Browser | Headless Chromium via puppeteer-core, `--enable-unsafe-webgpu --use-gl=angle`, 1800×900; the check requires WebGPU status `ready` |
| Served backend | `backend/src/index.ts` (production entry, Better Auth sessions) |
| Served frontend | Nitro production build, `/api/*` forwarded to the backend |

## Commands and outcomes

| Command | Coverage | Result |
|---|---|---|
| `bun test test/publication.test.ts` (backend) | Route check, refusals, immutability through the API and the database, per-Version titles and goals, forced-order races between direct writes and publication, new Versions with stable IDs, a pinned fixture Enrollment, the non-owner matrix, competing requests | 12 pass, 0 fail |
| `bun test` (backend) | All earlier backend suites, now with the immutability triggers | 172 pass, 0 fail |
| `bun run scripts/t19-publication-check.ts` (frontend) | Browser flow below, on a fresh build | 7 of 7 steps passed |
| Full harness check and the T04/T05/T06/T15–T18/T44 checks | Regressions | see the final run in `.harness/` |

Browser steps:

1. **Blocked Draft**: the Coach authors Vectors (Required Tasks worth 30 and 30, an Enrichment Task worth 50), Matrices (threshold 100, after Vectors) and an Optional "History of algebra" with a 50-XP Task.
2. **Rejected publication**: "Publish Version 1" shows that Matrices "needs 100 XP, but Required Tasks on reachable required Skills award only 60 XP". The Draft stays open with the same revision and content, and nothing is published.
3. **Valid route**: setting the threshold to 60 in the editor hides the stale refusal. Publishing shows Version 1 read-only, with no inputs, and offers "Prepare Version 2 as a Draft".
4. **Immutable in place**: a direct typo save answers 409 `no_open_draft`, as does a second publication. A save based on the revision before publication answers 409 `stale_revision`. Version 1 is unchanged.
5. **New content Version**: the prepared Draft opens in the editor as a copy of Version 1. The Coach corrects an outcome and a Task title and changes the goal; meanwhile Version 1 still states its original goal. Version 2 is published with the same Skill and Task IDs and its own goal.
6. **Immutable old content**: the Version 1 page still shows the original typos and goal after a reload, and its API content equals the content first published.
7. **Unauthorized writes**: another Account sees "not available" for Version 1. Its publish, prepare, Version read and Draft save requests answer 404, and the first Coach's Path and Versions are unchanged.

Mutation checks, each restored afterwards. Each one failed the named test:

| Mutation | Failed |
|---|---|
| A required Skill with no Required Task counts as masterable | AC3 and the route unit test |
| Enrichment rewards count toward the route | AC1/AC2 and the route unit test |
| Optional Skills count as required | AC1/AC2, AC3 and the route unit test |
| A Skill's own rewards count toward its own threshold | AC1 (self-funding) |
| Publication skips the route check | AC1/AC2, AC1 (self-funding), AC3, AC5 |
| The Path lock drops the Workspace-owner condition | AC6 |
| The content triggers are dropped from the test database | AC4 |
| The content trigger locks only published Versions (the first review's finding) | both forced-order race tests |
| Publication validates the Draft without locking it first | the write-in-progress race test |
| Title and goal are read from and saved to the shared Path (the first review's finding) | the per-Version title/goal test |
| A published Version's title and goal are not guarded by the database | the per-Version title/goal test and the goal race test |

## Decisions made in this ticket

- **No required Skill, no publication.** The ticket asks for a completable Version. A Draft with no required Skill, including an empty one, is refused with "A Version needs at least one required Skill for learners to complete".
- **Publication and new Drafts are revision-checked.** Both carry the Path revision the Coach saw and advance it, so the Coach publishes exactly the saved Draft they looked at. The publish button is disabled while the Draft has unsaved or refused changes.
- **Immutability in the database.** Triggers refuse writes to a published Version's Skills, Tasks and Prerequisites, and refuse unpublishing, renumbering or deleting it. The earlier P2 tests configured rewards, thresholds and Prerequisites on the published fixture Versions directly. They now do so through `amendPublished`, a test helper that disables the three content triggers inside its own transaction as the schema owner. The enrollment fixture now writes Version content as a Draft and publishes it afterwards. No expectation in those tests changed.

## Review fixes

An independent review of the first implementation found two problems, both reproduced on PostgreSQL:

- **Draft writes did not serialize with publication.** The content trigger locked the Version row only when it was already published. A direct write to a Draft could commit after a publication had validated the earlier content, leaving a published Version whose required route no longer held. Migration `0013_version_title_goal` now locks the Version `FOR SHARE` for every content write, and `publishDraft` locks the Draft `FOR UPDATE` before reading it for validation. Two forced-order tests hold one side open on a separate connection and observe the other waiting (`pg_blocking_pids`). In one, a publication waits for a write in progress and then refuses the route that write broke. In the other, a write waiting for a publication in progress is refused.
- **Earlier Versions changed their title and goal.** Title and goal were stored once on the Path, so saving the next Draft changed what Version 1 showed, even before the Draft was published. Each Version now holds its own title and goal (existing Versions take their Path's values), the database guards them once published, and a test reads Version 1 unchanged while Version 2 is drafted and after it is published. The earlier note that title and goal were not versioned was a decision of this ticket, not of the spec, and it is withdrawn.

## What is not verified

- Access Overrides cannot affect publication because the check reads only the Draft's content. The test shows that a learner's override in Version 1 does not unblock Version 3, but no Draft-level override exists to test.
- The learner-facing view of an enrolled Version belongs to T21, invitations to a chosen Version to T20, and Canvas Layout changes on a published Version to T27. Here the layout is only shown to stay writable in the database.
- Skill titles cannot be renamed in the editor, because card titles are engine-owned. The browser typo fixes therefore use an outcome and a Task title, while the backend test corrects a Skill title.
- Keyboard-only publication is not exercised. The headed P1 performance capture was not run.
