# T22 Preparing and sending learner work: local evidence

Ticket [#23](https://github.com/harkon666/Gurow/issues/23) (T22). Recorded on 2026-10-05 from harness checks of branch `feat/t22-submit-work-from-learning-ui`, based on `fca0eee`, with the T22 changes in the working tree. Run logs stay local in `.harness/runs/`. This report was written before the final full check, which covers it.

Each Task in an enrolled learner's sidebar now has a private working space: a draft of text and links that only the learner can read. The learner saves it to the backend on request. Unsaved edits are also kept in this browser under `gurow:submission-draft:<Account>:<Enrollment>:<Task>` until a saved draft holds the same contents. Sending first saves the draft, then asks the backend for a new immutable revision of the Task's one Submission. Only the backend's 201 counts as sent. A failed draft save or a backend refusal (4xx) says "Not sent" and keeps the work. When the send's answer is lost (no answer, or a gateway error), the page reads the Submission history before saying anything: a matching revision sent after that draft save is reported as sent, and otherwise the page says the send is not confirmed and holds Send until the history has been read. The sent history is shown below the draft, separately from it. Each revision states how it stands, so a newer revision never appears to inherit an earlier Approval. The owning Coach's view of the same page has no draft fields and never requests a draft. T22 adds no backend routes: it uses the draft and Submission routes of T08 and T12.

## Environment

| Item | Value |
|---|---|
| Database | PostgreSQL from `compose.yaml` on 127.0.0.1:5433; no new migration |
| Browser check database | `gurow_t22_browser_test`, migrated and emptied before the run |
| Email | The Resend HTTP mailer, pointed at the local stand-in of `POST /emails`; every verification and Invitation link is read from a delivered email |
| Browser | Headless Chromium via puppeteer-core, `--enable-unsafe-webgpu --use-gl=angle`, 1400×900; one browser context per person, with Lena's shared by a list-only page (no `navigator.gpu`) and by the Account-switch steps |
| Served backend and frontend | `backend/src/index.ts` with Better Auth sessions; Nitro production build, `/api/*` forwarded |

## Commands and outcomes

| Command | Coverage | Result |
|---|---|---|
| `bun test src/components/path/submissionWork.test.ts` (frontend) | Account/Enrollment/Task recovery keys, keeping and forgetting edits, corrupt and throwing storage, link and size checks, the Access/Enrollment send gate, revision notes, refusal versus unknown outcome, finding a send in the history | 12 pass, 0 fail |
| `bun run scripts/t22-submit-work-check.ts` (frontend) | Browser flow below, on a fresh build | 9 of 9 steps passed |
| `bun run scripts/t21-enrolled-navigation-check.ts` (frontend) | T21 regression, with the changed expectation below | see the final run in `.harness/` |
| Full harness check, backend suites and the T04–T06, T15–T21, T44 checks | Regressions | see the final run in `.harness/` |

Browser steps, with real Accounts that sign up and verify through emailed links. The Coach publishes Linear Algebra: Vectors (Required "Vector drills", 20 XP, and Enrichment "Read chapter 1") before Matrices (requires Mastery of Vectors and 20 XP; Required "Matrix drills"). Lena and Pia accept emailed Invitations. The Coach's Reviews go through the API, because the review UI is T23.

1. **Private draft**: Lena clicks the Vectors card on the WebGPU canvas and types text and a link into "Vector drills". The unsaved edits are kept under her recovery key. "Save draft" stores them in `submission_drafts` and clears the local copy. The Coach's draft read answers 403 and the Submission read 404. After a reload, the saved draft is shown and no work is listed as sent.
2. **Local recovery**: Lena types another line and leaves the page without saving. Reopening restores the line with "Restored unsaved edits from this browser … not saved to Gurow yet"; the stored draft is unchanged. Recovered edits on another Task are discarded back to its saved draft.
3. **Offline send**: with the browser offline, Send shows "Not sent: the backend could not be reached. Nothing was submitted; your work is still here and kept in this browser." The text, link and local copy remain, and neither the UI nor PostgreSQL has a revision.
4. **Send confirmed**: Send shows "Sent as Revision 1 …, confirmed by Gurow", and Revision 1 appears Awaiting Review with its text and link, stored exactly. The Coach reads it. A later saved draft edit leaves Revision 1 unchanged and is not visible to the Coach.
5. **Corrections and reload**: a second send supersedes the pending Revision 1 ("Replaced by Revision 2 before it was reviewed"), and the backend refuses a Review of it (409). The Coach requests changes on Revision 2; the feedback is shown on return to the page. Lena replaces the text and sends Revision 3, which the Coach approves: 20 XP and Vectors mastered. Revision 4 is then pending with "Needs its own Review: it does not inherit the Approval of Revision 3, which still counts", while XP and Mastery stay. After a reload the history reads superseded, changes requested, approved, pending, and the draft holds the last sent contents.
6. **Keyboard entry and reuse**: on a page without WebGPU, the keyboard list reaches Matrices. An empty draft cannot be sent, and a link without a scheme is explained before sending. The link note states that Gurow keeps links, not copies of the pages. A commit-pinned link is sent with Enter on the focused button; the Coach requests changes, and the correction is sent as Revision 2. A reload keeps both. The same notes link sent for "Read chapter 1" creates that Task's own pending Submission, which the drills' Approval does not approve.
7. **Access failures**: the Coach revokes the Vectors Approval while Lena's page still shows Matrices open. Send on Matrices answers "Not sent: this Skill is locked now, and sending work needs Access …; your work is still here and saved as your private draft". The page re-reads the records: Matrices locked, Send disabled with the reason, history unchanged. Pia's Matrices is locked from the start: Send is disabled, and the API answers 403 `skill_locked`. After the Coach deactivates Lena's Enrollment, Send is disabled with "This Enrollment is inactive", and the API refuses.
8. **Privacy and Account switching**: Lena leaves an unsent line in her draft. The owning Coach's view of her Enrollment has no draft fields and makes no `/draft` request. None of the unsent or saved-but-unsent draft text is on the page, and every draft read answers 403. Another tab of Lena's browser signs in as Pia; Lena's open page becomes "Enrollment not available" without her work. In that browser, Pia's own draft for the same Task is empty, with no recovery notice, and Pia's reads of Lena's drafts and Submission answer 404. Lena's recovery copy is unchanged, and Pia has none. Lena signs back in and recovers her unsent line.

9. **Lost answers**: request interception on Lena's page forwards one send to the backend, which commits it, and then drops the answer in the browser. The page reads the history and shows "Sent as Revision 2 … the answer was lost, but your submitted work shows it"; one revision is stored. A second send is dropped before it reaches the backend, and the history read that follows is dropped too. The page says "Not confirmed: Gurow did not answer, so this send may or may not have arrived", never "Nothing was submitted". Send is held until the history can be read, and the work stays. "Check again" reads the history ("not in your submitted work below") and re-enables Send. Sending then creates Revision 3, so three revisions are stored and none is duplicated.

Changed expectation: the T21 check asserted that the learner's page has no inputs at all. The learner's own draft fields are now expected there, so that check excludes `[data-task-work]`; the Version's Skills and Tasks remain read-only (ADR 0005).

Mutation checks, each restored afterwards. Each one failed the named test:

| Mutation | Failed |
|---|---|
| Send offered whatever the Access and Enrollment state | Unit test; browser step 7 |
| Recovery keyed by Task only, shared across Accounts and Enrollments | Unit test; browser step 1 |
| A refused send shown as sent | Browser step 7 |
| The Coach's view renders the draft composer | Browser step 8 (draft requests from the Coach's page) |
| A pending revision after an Approval presented as approved | Unit test; browser step 5 |
| A failed send clears the work | Browser step 3 |
| A lost answer treated as a refusal | Unit test; browser step 9 |
| A lost answer not reconciled with the history | Unit test; browser step 9 |
| Send not held while the history is unread | Browser step 9 |

## Decisions

- Drafts are saved on request, not autosaved; unsaved edits are kept locally after every change, so an interruption loses nothing in that browser.
- Sending saves the draft first. If the backend refuses the send after that save, the work is in the saved draft as well as on screen. If the draft save itself fails (as offline in step 3), nothing is sent, and the latest edits are on screen and, when the browser can store them, in local recovery; they are not in the backend draft. After a confirmed send the draft holds the sent contents as the starting point for a correction.
- A lost answer is reconciled with the history rather than retried automatically. There is no idempotency key, so a send that is still in progress at the server when the history is read could arrive after "not in your submitted work"; making sends idempotent would change the backend API and is left to T28's work on failed requests.
- Saving a private draft for a locked Skill is allowed (the backend allows it; T12 refuses only a first draft in an inactive Enrollment). Only sending needs Access.
- Evidence reuse is explained, not automated: the learner sends it from each Task, which gets its own Submission and Review.

## Review fixes

An independent review found one Spec problem and two Standards notes.

- **Spec (P2), fixed with a test**: every failed send was reported as "Not sent … Nothing was submitted", including a send that the backend committed but whose answer never arrived. Retrying would then add a revision and supersede the pending one. Refusals (4xx) and unknown outcomes are now told apart, and an unknown outcome is reconciled with the Submission history (browser step 9; three mutations).
- **Standards (P3), fixed**: this report claimed a failed send always left the work in the saved draft. That holds only when the draft save succeeded; the Decisions section now says so, and that the offline step proves local recovery, not a backend draft.
- **Standards (P3), declined**: sharing the browser scripts' helpers (`api`, `emailedLink`, authentication) between T21 and T22. As in the T21 review, every browser check carries its own; extracting them for two scripts only would mix two patterns. That is a separate refactor across all checks.

## Not proven here

- Local recovery copies stay in the browser after sign-out under the owning Account's key, and the application reads them only for that Account. They are not encrypted or removed on sign-out; conflict handling and recovery across tabs are T28.
- The Coach's review UI is T23. Reviews and revocations here go through the API.
- Tasks are not marked started by drafting or sending; the explicit start (T12) has no UI yet.
- Keyboard checks cover list selection, typing and sending with Enter, not the Tab order of every control. The headed P1 capture was not run.
