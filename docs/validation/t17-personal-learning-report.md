# T17 personal completion, Mastery, rewards and Access: local evidence

Ticket [#18](https://github.com/harkon666/Gurow/issues/18) (T17). Recorded on 2026-10-05 from harness checks of branch `feat/t17-track-personal-learning`, based on `8064311`, with the T17 changes in the working tree. Run logs stay local in `.harness/runs/`. This report was written before the final full check, which covers it.

The owner of a personal Path tracks it from the Path page (`/paths/$pathId`): marking Tasks complete, setting Task rewards, declaring or withdrawing Mastery, setting a Skill's XP Threshold and bypassing its gates. Each is a separate backend action on the T13 learning routes ([backend README](../../backend/README.md#personal-learning-interface-t13)), plus one new owner-only route for the threshold. The page shows only the records the backend returned ([ADR 0001](../adr/0001-separate-access-from-mastery.md), [ADR 0009](../adr/0009-scope-personal-xp-access-checks-to-learning-paths.md)); the actions never change the Path document or its revision.

## Environment

| Item | Value |
|---|---|
| Database | PostgreSQL from `compose.yaml` on 127.0.0.1:5433; no new migration (the threshold column exists since T13) |
| Backend tests | `gurow_test`, truncated before each test |
| Browser check database | `gurow_t17_browser_test`, migrated and emptied before the run |
| Browser | Headless Chromium via puppeteer-core, `--enable-unsafe-webgpu --use-gl=angle`; the check requires the editor's WebGPU status `ready` (and `unsupported` for its no-WebGPU step) |
| Served backend | `backend/src/index.ts` (production entry, Better Auth sessions) |
| Served frontend | Nitro production build, `/api/*` forwarded to the backend |

## Commands and outcomes

| Command | Coverage | Result |
|---|---|---|
| `bun test test/personal-tracking.test.ts` (backend) | Authored Paths: new Tasks at reward 0, 20→50 corrections, the threshold route (owner-only, validated, per-Skill, relocking started work), Path-local XP across two authored Paths, revision untouched by learning actions | 4 pass, 0 fail |
| `bun test src/components/path/learning.test.ts` (frontend) | Learning records: confirmed-only display, Retry resends the same action, one action at a time, older reads dropped, reads requested during an action wait for it, failed reads invent nothing | 7 pass, 0 fail |
| `bun run scripts/t17-personal-learning-check.ts` (frontend) | Browser flow below, on a fresh build | 12 of 12 steps passed |
| Full harness check and the T13/T15/T16/T04/T05/editor-lifecycle/T06-functional/T44 checks | Regressions after adding optional slots to the shared panel, list and label overlay | see the final run in `.harness/` |

Browser steps (one signed-in Account unless noted):

1. **Separate states**: after authoring Ownership → Lifetimes with Tasks, the header shows Path XP 0, the panel shows Access and Mastery in separate sections, and the list and canvas labels show Lifetimes as locked. Lifetimes keeps its title and outcome, explains "Requires Mastery of “Ownership”, which is not declared", and does not offer completion. A threshold typed for Lifetimes but not set does not follow the selection to Ownership.
2. **Completion and corrections**: reward 20 on an incomplete Task contributes 0; completing it gives 20; changing the reward to 50 gives 50; undoing gives 0; completing again gives 50. The panel's XP record reads "completed: +20 XP (award)", "reward changed while complete: +30 XP (correction)", "completion undone: −50 XP (correction)", "completed again: +50 XP (correction)", matching the stored history. An incomplete Task's reward edit contributes 0, and Mastery stays unclaimed throughout.
3. **Independent Mastery**: declaring Ownership's Mastery (no evidence or review) opens Lifetimes. Its request is held while a goal edit autosaves, which asks for fresh records; no records are read until the declaration is answered, and it stays shown afterwards; a threshold of 40 met by 50 XP spends nothing; Lifetimes' Task earns 10 and its Mastery is declared without changing XP.
4. **Relock**: withdrawing Ownership's Mastery relocks Lifetimes by its Prerequisite; after re-declaring it, undoing the 50-XP Task relocks Lifetimes by its threshold ("Needs 30 more XP: the threshold is 40 and this Path has 10 XP"). Both times Lifetimes keeps its completed Task and declared Mastery.
5. **Bypass**: "Bypass Prerequisites and XP Threshold" asks for no reason (no dialog); Lifetimes becomes "Open by override" with XP, XP history and Mastery history unchanged; removing the bypass relocks it.
6. **Retry**: the completion request reaches the backend but its answer is lost (patched `fetch`). The page reports "Not recorded" and still shows the earlier XP and an incomplete Task, while the backend already has the completion. Retry shows the confirmed XP, with one XP event for the Task.
7. **Failed write**: with the reward request aborted, the error is shown, the Task still shows its old contribution, the Path XP never shows the new total, the backend keeps the old reward, and the typed value stays in the field. Retry records the +10 correction.
8. **Keyboard and list**: with the keyboard only, the list selects locked Lifetimes; Tab and Enter set its threshold to 1000 ("Needs 965 more XP"), toggle the bypass on and off, and Space undoes its Task. Completion is then unavailable with an explanation, and its Mastery stays declared.
9. **Cross-Path XP**: a second Path earns 2000 XP; the first still shows 25 and keeps Lifetimes locked against this Path's 25 XP.
10. **Reload**: XP, thresholds, rewards, completions, both declarations and the XP records reopen unchanged; the document revision is still the one from authoring.
11. **No WebGPU**: with `navigator.gpu` removed, the list shows Lifetimes locked; keyboard selection shows its title and reason, and Tab plus Enter withdraws and re-declares its Mastery.
12. **Unauthorized Account**: another Account receives 404 for the learning state, completion undo, threshold and bypass; the owner's records are unchanged.

Mutation checks, each restored afterwards: writing the threshold to every Skill of the Path failed backend AC4 (the first version of that test did not catch it and was tightened); not refreshing the records after a document save failed browser step 1; swallowing a failed action failed browser step 6; removing the older-answer guard failed a learning-records unit test.

## Review round 1

An independent Standards/Spec review found two P2 defects, both fixed here with regression tests that failed first:

- **A confirmed action could be hidden by a concurrent read.** Answers were ordered by when requests were sent, but the backend serves them in Path-lock order. A read requested by an autosave while an action was in flight could answer first and cause the action's confirmed answer to be dropped, or answer last with pre-commit records and overwrite it. Reads requested during an action are now sent once it is answered. Two unit tests (one per order) and browser step 3 failed with the earlier controller (the page kept "unclaimed" after the declaration was confirmed) and pass now.
- **A threshold draft followed the selection.** The threshold field was keyed by its value only, so moving to a Skill with the same threshold kept the typed draft, and Set would have applied it to that Skill. It is now keyed by Skill as well; browser step 1 failed before the fix.

## What is not verified

- There is no separate "start Task" control; starting is recorded by completion. The backend start route is unchanged and covered by T13.
- Threshold changes are not recorded in a history; the spec requires histories for XP, Mastery and overrides only.
- Competing learning actions from two tabs rely on the backend's idempotent actions under the Path lock (T13, T14); the browser check does not race two tabs.
- Archived Tasks keep their contribution and appear in the XP record by title, but no archive control is offered (T30).
- A deployed origin, HTTPS and production configuration are not exercised (see the [T15 report](t15-sign-in-report.md)).
- The headed P1 performance capture was not run. The label overlay gained an optional status badge that the P1 editor does not use.
