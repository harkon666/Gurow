# T26 Stopping and resuming participation from learner and Coach views: local evidence

Ticket [#27](https://github.com/harkon666/Gurow/issues/27) (T26). Recorded on 2026-10-06 from harness checks of branch `feat/t26-stop-resume-participation`, based on `c5721a1`, with the T26 changes in the working tree. Run logs stay local in `.harness/runs/`. This report was written before the final full check, which covers it.

Below the header of an Enrollment page, both viewers now find its participation. An active Enrollment offers its learner "Stop participating…" and the owning Coach "Deactivate Enrollment…"; an inactive one offers the Coach "Reactivate Enrollment…" and the learner nothing, since only the Coach resumes it. The learner's reason is optional: an empty one is sent as no reason. The Coach's reason is required for both actions. Before confirming, the form states what the rules will do: for a deactivation, that no Task can be started and no work sent, that nothing is removed and unsent drafts stay private, how many sent revisions stay decidable, and who can resume it; for a reactivation, that the same Enrollment resumes on its Version with its XP, Mastery and history, and each Skill's Access under the current rules (open, locked with its unmet requirements, or open by Coach override). As with a Review (T23), a revocation (T24) or an override (T25), the change counts as recorded only once the backend answers; the page shows the returned record (action, Actor, time, reason), reads the records again, and says the status follows it only once that read is on show. A refusal says "Not recorded … Nothing changed"; a lost answer is reconciled with the participation records by action, Actor and reason. Both viewers can open the list of participation records.

While the Enrollment is inactive, a Task that has no saved draft, no sent work and no start cannot be started: its draft field is disabled and says so. A Task already begun keeps its private draft editable, as the backend allows; sending stays disabled. The Coach's awaiting-Review queue says that work sent while active can still be decided, that an Approval adds XP and Mastery as usual, and that it does not reactivate the Enrollment.

Backend: unchanged. The UI consumes the T12 routes `POST /api/enrollments/:enrollmentId/deactivate` and `/reactivate`, and `lifecycleHistory` from the learning state.

## Environment

| Item | Value |
|---|---|
| Database | PostgreSQL from `compose.yaml` on 127.0.0.1:5433; no new migration |
| Browser check database | `gurow_t26_browser_test`, migrated and emptied before the run |
| Email | The Resend HTTP mailer, pointed at the local stand-in; every verification and Invitation link is read from a delivered email |
| Browser | Headless Chromium via puppeteer-core, `--enable-unsafe-webgpu --use-gl=angle`, 1400×900; one browser context per person |
| Served backend and frontend | `backend/src/index.ts` with Better Auth sessions; Nitro production build, `/api/*` forwarded |

## Commands and outcomes

| Command | Coverage | Result |
|---|---|---|
| `bun test src/components/path/lifecycleWork.test.ts src/components/path/submissionWork.test.ts` (frontend) | Either participant deactivates, only the Coach reactivates; no reason needed from the learner, a reason within 500 characters from the Coach; refusal messages; deactivation and reactivation outlooks with current Access; a lost answer found only in a later record of the same action, Actor and reason; record text for both readers; an inactive Enrollment starts no new Task but keeps work already begun editable | 22 pass, 0 fail |
| `bun run scripts/t26-participation-check.ts` (frontend) | Browser flow below, on a fresh build | 10 of 10 steps passed |
| Full harness check, backend suites (including T12's lifecycle suite) and the earlier browser checks | Regressions | see the final run in `.harness/` |

Browser steps, with real Accounts that sign up and verify through emailed links. Carla publishes Linear Algebra: Vectors (Required "Vector drills", 20 XP, and "Vector extension", 5 XP) before Matrices (requires Mastery of Vectors and 25 XP; Required "Matrix drills", 15 XP). Lena and Pia accept Carla's emailed Invitations. Otto coaches another Workspace.

1. **Active work**: Lena sends Vector drills Revision 1 from her page and saves a private draft. The untouched extension is editable; her page offers "Stop participating…".
2. **Learner deactivation**: the outlook says no new Task can be started and no work sent, her unsent drafts stay private, her Coach can still decide the 1 revision she sent, and only her Coach can reactivate it. The reason is optional and Confirm is enabled with none. With the request held, the page says only "Deactivating the Enrollment…" and the Enrollment stays active, in the UI and in PostgreSQL. Once confirmed: "Recorded by Gurow: Enrollment deactivated by you (lena) · (time) · No reason given…"; one record names Lena as Actor without a reason. Lena is offered no reactivation; a repeated deactivation answers 409 `enrollment_already_inactive`.
3. **Inactive**: Vectors is Locked with only the inactivity reason. Send is disabled; the existing draft stays editable and is saved again. The untouched extension cannot be started (field disabled, "a new Task cannot be started"). Starting it, creating its draft and sending answer 403 `enrollment_inactive`. Revision 1 is still awaiting Review with its text; 0 XP. Carla's draft read answers 403 `draft_private`, and her page holds neither a draft editor nor the draft text.
4. **Pending Review**: Carla reads that Lena cannot start Tasks or send work, that she can still review work sent while active and that only she can reactivate it, and the queue's note. She approves Revision 1 from the queue: 20 XP for both while the Enrollment stays inactive; one XP event, no new lifecycle record.
5. **Unauthorized reactivation**: Lena's reactivation answers 403 `coach_only`; Pia's reactivation and deactivation answer 404; Otto's answers 404 and the Enrollment is unavailable to him. Following the original Invitation again, and a new one, answers "already enrolled" with the same, inactive Enrollment. An Access Override granted meanwhile leaves it inactive; Matrices stays Locked with "It does not reactivate this Enrollment".
6. **Reactivation**: Confirm stays disabled for an empty and a blank reason. The outlook says "The same Enrollment resumes on Version 1, with its 20 XP, 0 Skills mastered and all its work and history" and "Access is evaluated under the current rules: “Vectors”: open, “Matrices”: open by Coach override". The answer is dropped after the backend commits; the page confirms it from the records ("the answer was lost, but the participation records show it"). The Enrollment row is the same (id, Version, learner) and active; one record names Carla and her reason. The page shows 20 XP, Version 1, Vectors open, Matrices open by override, and offers "Deactivate Enrollment…".
7. **Resumed learning**: Lena reads both records (her deactivation without a reason, Carla's reactivation with it), 20 XP, her approved Revision 1 and her kept draft. The extension can be started again; she sends it and Matrix drills from her page.
8. **Coach deactivation**: the outlook says the 2 revisions awaiting Review stay decidable and only Carla can reactivate. The reason is required in the UI; the API refuses a reactivation with a blank or absent reason (422). Recorded with Carla and her reason. Carla approves the extension while inactive: 25 XP and Vectors mastered for both, one more XP and one Mastery event, still inactive. Lena reads all three records, is offered no reactivation, and her send answers 403 `enrollment_inactive`.
9. **Reload**: Carla and Lena read deactivate, reactivate, deactivate, 25 XP, Vectors mastered and Matrix drills Revision 1 awaiting Review. Pia's Enrollment stays active.
10. **Long history on a short window**: Carla records ten more reactivations and deactivations, each with a reason of up to 480 characters (23 records). On a 560px-high window, with the records open (and, for Carla, the reactivation form open), the participation block stays within 40% of the window. Its latest record, the reason field and Confirm, the Matrix drills revision and the Mastery section can each be scrolled to and reached.

Mutation checks, each restored afterwards. Each one failed the named test:

| Mutation | Failed |
|---|---|
| The learner's deactivation requires a reason | Unit test; browser step 2 |
| The learner is offered reactivation | Unit test; browser step 2 |
| An inactive Enrollment lets an untouched Task be started | Unit test; browser step 3 |
| The participation block without its height limit (review fix) | Browser step 10 |

## Decisions

- Participation is shown below the Enrollment header for both viewers, since it concerns the whole Enrollment rather than one Skill; the records list is collapsed by default.
- "Starting a Task" in the UI is preparing its first draft. An inactive Enrollment blocks that only for a Task without a saved draft, sent work or start, matching the backend, which keeps existing private work editable.
- A lost answer is matched by action, Actor and reason after the last known record, so a learner's reasonless deactivation never confirms a Coach's.

## Review fixes

An independent review reported one Spec finding (P2) and one Standards note (P3).

- **A long participation history could push the learning history off a page that does not scroll, fixed with a test**: the participation block sat outside the scrolling learning panes and listed every record, while the document itself does not scroll. Many records with long reasons, or the form on a short window, took the panes' height, leaving records, form controls and the learning history unreachable. Reproduced by browser step 10 (the block took 724px of a 560px window). The block is now limited to 35% of the window height and scrolls on its own; step 10 passes.
- **Duplicated record/confirm/refresh/reconcile flow (P3, nonblocking), not changed**: the flow repeats the one in `AccessOverrideControl` (and the same `attempt` wrapper appears in other components). Extracting it would change the T23–T25 controls as well, outside this ticket; it is left for a separate refactoring.

## Not proven here

- A deactivation refused because it was already made from another tab (409) is covered by its message in the unit test, not by a browser step.
- A learner giving an optional reason is accepted by the API and the form, but the browser flow deactivates without one.
- The headed P1 capture was not run.
