# T24 Correcting an Approval from the Coach UI: local evidence

Ticket [#25](https://github.com/harkon666/Gurow/issues/25) (T24). Recorded on 2026-10-06 from harness checks of branch `feat/t24-correct-approval-from-coach-ui`, based on `b09d4cc`, with the T24 changes in the working tree. Run logs stay local in `.harness/runs/`. This report was written before the final full check, which covers it.

The owning Coach can now revoke an Approval from the Submission history. Each approved revision on the Coach's page offers "Revoke Approval of Revision n…". This opens a required reason field and states what the rules will do: the other Approvals that keep the Task's contribution, or that this is the Task's only valid Approval. A revocation counts as recorded only once the backend answers 200. The history and the records are then read again, and the page says that XP, Mastery and Access follow the revocation only once that read is on show. As with a Review (T23), a refusal says "Not revoked … Nothing changed", reads both again and keeps the reason. A lost answer is reconciled with the history (same revision, same reason).

The revoked revision keeps its original decision ("Approval decided …", feedback) and shows "Approval revoked …: reason" to both the learner and the Coach. Beneath it, the page explains what the revocation changed, as the backend read it together with that history, rather than a prediction. Either the Approvals still counting at that moment kept the contribution and the evidence for Mastery, or the final Approval's loss removed the XP through an XP Correction and revoked Mastery. In the second case, the page names the Skills that now lack Access because they need that Mastery, and says whether their own Mastery stays. The Skill panel separates Access (with its lock reasons) from Mastery: a locked Skill that keeps its Mastery says so. It lists the Skill's Mastery history, with the Task revision behind each award or revocation. Each Task's XP history reads "Awarded", "Corrected … was revoked" or "Restored", with its revision.

Backend: the revocation route is T10's, unchanged. A revoked Approval's revision in the Submission history carries its `revocation` outcome (Approvals still counting then, XP Correction, Mastery revoked), read in the same transaction as the history. The learning state's `xpHistory` events also carry `revisionNumber`; `masteryHistory` events carry `taskId` and `revisionNumber`. See the [backend README](../../backend/README.md#correcting-an-approval-t24).

## Environment

| Item | Value |
|---|---|
| Database | PostgreSQL from `compose.yaml` on 127.0.0.1:5433; no new migration |
| Browser check database | `gurow_t24_browser_test`, migrated and emptied before the run |
| Email | The Resend HTTP mailer, pointed at the local stand-in; every verification and Invitation link is read from a delivered email |
| Browser | Headless Chromium via puppeteer-core, `--enable-unsafe-webgpu --use-gl=angle`, 1400×900; one browser context per person |
| Served backend and frontend | `backend/src/index.ts` with Better Auth sessions; Nitro production build, `/api/*` forwarded |

## Commands and outcomes

| Command | Coverage | Result |
|---|---|---|
| `bun test test/revocation.test.ts` (backend) | T10's revocation suite, plus each XP and Mastery event naming its revision and Task for the learner and the Coach, through award, final revocation and restoration; each revoked Approval's outcome read with its history, with two revocations in the same millisecond told apart | 19 pass, 0 fail |
| `bun test src/components/path/revocationWork.test.ts` (frontend) | Mandatory reason; refusal messages; a lost answer found only on the same revision with the same reason; the outlook with other Approvals and for the only one; kept vs corrected effects from the backend's outcome; the outcome trusted over records read before the revocation; no claimed Mastery or XP change for Enrichment or zero-reward Tasks; dependent Skills locked with their own Mastery kept; XP and Mastery history wording | 10 pass, 0 fail |
| `bun run scripts/t24-correct-approval-check.ts` (frontend) | Browser flow below, on a fresh build | 7 of 7 steps passed |
| Full harness check, backend suites, T23 and the earlier browser checks | Regressions | see the final run in `.harness/` |

Browser steps, with real Accounts that sign up and verify through emailed links. Carla publishes Linear Algebra: Vectors (Required "Vector drills", 20 XP; Enrichment reading) before Matrices (requires Mastery of Vectors and 20 XP; Required "Matrix drills", 15 XP). Lena and Pia accept emailed Invitations. Decisions are T23's UI and are set up through the API, except the restoring Approval in step 5.

1. **Setup**: drills Revisions 1 and 2 and Matrix drills Revision 1 approved: 35 XP, both Skills mastered. Each approved revision on Carla's page offers a revocation.
2. **Authority and reason**: Lena's page has no revocation control, and her API revocation answers 403 `coach_only`. Pia's revocation, and her reads of Lena's history and records, answer 404; her own page has no control. Carla's "Revoke" stays disabled, explaining that a reason is needed, for an empty and a blank reason; the API refuses a blank one with 422. Nothing is stored.
3. **One of two valid Approvals**: the outlook says "The Approval of Revision 2 also counts…". With the request held in the browser, the page says "Revoking the Approval of Revision 1…". Revision 1 still shows as approved, the page still shows 35 XP, and nothing is stored. Once confirmed: "Revocation … recorded, confirmed by Gurow. The original Approval stays in the history", then "derived them after it". Revision 1 shows the reason with its original decision kept, and "The Approval of Revision 2 still counted, so this Task kept its 20 XP contribution and its evidence for Mastery of “Vectors”; nothing was corrected", for Carla and for Lena. PostgreSQL keeps the decision and its time, adds the reason, and has no new XP or Mastery event.
4. **Final Approval**: the outlook says "This is the Task's only valid Approval: revoking it removes its 20 XP and its evidence for Mastery…". The records read after confirmation is held: "Reading the corrected XP, Mastery and Access…", 35 XP, no claim. The history read meanwhile already explains the XP Correction and the Mastery revocation, with no "no Mastery changed", while the stale records still show Vectors mastered. Then 15 XP, Vectors not mastered, Matrices locked but Mastered. Both see the same three lines under Revision 2: the XP Correction, Mastery of Vectors revoked, and Matrices locked while keeping its own Mastery. Matrices' panel, for both, lists "Requires Mastery of “Vectors”" and "Needs 5 more XP" under Access, separately from "Mastered" and "its Mastery stays" under Mastery. The XP history reads "Awarded +20 XP: Approval of Revision 1" and "Corrected −20 XP: the Approval of Revision 2 was revoked". The Vectors Mastery history names both drills revisions. Stored: one −20 correction and one Vectors Mastery revocation, both caused by Revision 2.
5. **Restoration**: Lena sends Revision 3 from her page; Carla approves it in the Review. Both see 35 XP, Vectors mastered and Matrices open. The XP history adds "Restored +20 XP: Approval of Revision 3", and the Mastery history reads award, revoked, award. Each Task has one award event; the revoked revisions and their reasons stay readable.
6. **Stale and lost answers**: Revision 4 is approved, and Revision 3's Approval is revoked from another tab while this page still offers it. Revoking it here answers "Not revoked: the Approval of Revision 3 was already revoked (perhaps from another tab) … Nothing changed". The page reads again and shows the other tab's reason and "The Approval of Revision 4 still counted…"; the stored reason is the other tab's. Revoking Revision 4 with the answer dropped after the backend commits: "recorded … the history shows it", 15 XP, exactly one −20 correction and one Mastery revocation for Revision 4.
7. **Reload and visibility**: after reloading, Carla and Lena see the same: four revoked Approvals with their reasons and explanations (kept by Revision 2, corrected, kept by Revision 4, corrected), the full XP history, 15 XP, and Matrices locked and mastered. No revoked Approval offers another revocation. Lena's Enrollment is unavailable to Pia, and none of the reasons reaches her.

Mutation checks, each restored afterwards. Each one failed the named test:

| Mutation | Failed |
|---|---|
| A revocation shown as recorded before the backend answers | Browser step 3 |
| The learner's page renders the revocation control | Browser step 2 |
| A revocation allowed without a reason | Unit test; browser step 2 |
| The effect computed from the Approvals counting now instead of at the revocation (first version) | Unit test; browser step 7 |
| The Mastery outcome inferred from the records instead of the outcome read with the history (review fix) | Unit test; browser step 4 |
| Approvals still counting compared at millisecond precision (review fix) | Backend test |
| Corrected progress claimed before the history and records are read again | Browser step 4 |

## Decisions

- The control lives on each approved revision in the Task's history, beside the evidence it revokes; there is no separate correction screen.
- The outlook before revoking states the rule (the other Approvals that count now, or the only one). The confirmed explanation is read from the backend's XP and Mastery events, which name their cause, never derived from the outlook. A Skill locked by the lost Mastery is named from the current records.
- A revocation is recorded once (409 for another), so the page says revoking again after "Not confirmed" is safe.

## Review fixes

An independent review found one Standards smell and two Spec problems, all in the explanation of a revocation's outcome.

- **Spec (P2), fixed with tests**: the explanation combined the Submission history and the learning records, read separately. With the history already showing the revocation and the records still from before it, the absence of a Mastery revocation event was taken as proof that Mastery had not changed ("“Vectors” was not mastered then"), although the final Approval's loss had revoked it. The backend now reads each revoked Approval's outcome in the same transaction as the history, and the UI explains from that alone; only the Skills locked now come from the current records, and stale records merely omit them. Browser step 4 asserts the explanation while the records read is held; inferring Mastery from the records fails it.
- **Spec (P3) / Standards, fixed with a test**: which other Approvals still counted at the revocation was decided in the browser from JSON times, which keep milliseconds, while transitions are ordered in microseconds. PostgreSQL now compares them at full precision. A backend test places two revocations in one millisecond; comparing in milliseconds fails it.

## Not proven here

- Access Overrides and Enrollment lifecycle UI are T25 and T26; the explanation for a dependent Skill kept open by an Override ("stays open by an Access Override") is not tested.
- Keyboard use of the revocation is ordinary buttons and a text field; the check uses clicks and focuses the reason field, not a full Tab order. The headed P1 capture was not run.
