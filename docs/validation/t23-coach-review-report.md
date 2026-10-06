# T23 Reviewing learner work from the Coach UI: local evidence

Ticket [#24](https://github.com/harkon666/Gurow/issues/24) (T23). Recorded on 2026-10-06 from harness checks of branch `feat/t23-review-work-from-coach-ui`, based on `a877391`, with the T23 changes in the working tree. Run logs stay local in `.harness/runs/`. This report was written before the final full check, which covers it.

The owning Coach now finds sent work and decides it in the UI. A published Version's page lists its enrolled learners, each with the revisions awaiting Review. An Enrollment's page names its learner and has an "Awaiting your Review" list: each entry is a button that opens the Task beside its sent history and moves focus to the Review. The Review names the revision it decides ("Approve Revision 3", "Request changes to Revision 3"). Changes Requested needs feedback; Approval may have some. Only the backend's 201 counts as recorded. XP, Mastery and Access are then read again from the backend, never predicted. The Review says they follow the decision only once that read is on show; while it runs it says so, and when it fails it says the progress shown may be out of date and offers to read it again. A refused decision (the revision was replaced meanwhile, or already decided) says "Not recorded … Nothing changed", reads the history and the records again, and keeps the feedback. The decision is never moved to the newer revision. When the answer is lost, the history decides whether it was recorded. Learners see the feedback in their history. When a later revision gets Changes Requested, the history says that an earlier Approval still counts. Each Task shows its XP history, so a reward awarded once is visibly awarded once.

The backend adds one read route and two fields; decisions use the T09 route unchanged. `GET /coach/learning-path-versions/:versionId/enrollments` is for the owner of the Version's Workspace only. The Enrollment's learning state lists its `awaitingReview` revisions, and its `/version` read names the `learner`. A revision awaits Review while it is sent, not superseded and undecided. It stays listed after the Skill locks or the Enrollment is deactivated, because it was sent with valid Access (ADR 0007). See the [backend README](../../backend/README.md#finding-work-to-review-t23).

## Environment

| Item | Value |
|---|---|
| Database | PostgreSQL from `compose.yaml` on 127.0.0.1:5433; no new migration |
| Browser check database | `gurow_t23_browser_test`, migrated and emptied before the run |
| Email | The Resend HTTP mailer, pointed at the local stand-in of `POST /emails`; every verification and Invitation link is read from a delivered email |
| Browser | Headless Chromium via puppeteer-core, `--enable-unsafe-webgpu --use-gl=angle`, 1400×900; one browser context per person, with a Coach page without `navigator.gpu` in Carla's context |
| Served backend and frontend | `backend/src/index.ts` with Better Auth sessions; Nitro production build, `/api/*` forwarded |

## Commands and outcomes

| Command | Coverage | Result |
|---|---|---|
| `bun test test/coach-review.test.ts` (backend) | The Version's Enrollments for the owner only (learner, peer, another Coach, unrelated: 404; anonymous: 401; unpublished, unknown and malformed Versions: 404); exactly the revisions awaiting a decision, after supersession, Changes Requested, Approval and a revision sent after an Approval; work staying listed and approvable after the Skill locks and the Enrollment is deactivated; the learner named on the Enrollment | 3 pass, 0 fail |
| `bun test src/components/path/reviewWork.test.ts src/components/path/submissionWork.test.ts` (frontend) | Mandatory feedback for Changes Requested only, blank feedback sent as none, the one revision awaiting a decision, refusal messages, a lost answer found only on the same revision with the same decision, Coach and learner notes about earlier Approvals | 20 pass, 0 fail |
| `bun run scripts/t23-review-work-check.ts` (frontend) | Browser flow below, on a fresh build | 9 of 9 steps passed |
| Full harness check, backend suites and the T04–T06, T15–T22, T44 checks | Regressions | see the final run in `.harness/` |

Browser steps, with real Accounts that sign up and verify through emailed links. Carla publishes Linear Algebra: Vectors (Required "Vector drills", 20 XP, and Enrichment "Read chapter 1") before Matrices (requires Mastery of Vectors and 20 XP; Required "Matrix drills", 15 XP). Lena and Pia accept emailed Invitations. Approval Revocation has no UI before T24, so the revocations in step 7 go through the API.

1. **Find and inspect**: Lena sends Vector drills from her page, then saves an unsent private line in her draft. Carla's Version page lists Lena with "1 awaiting Review" and Pia with none. Lena's Enrollment page names her and lists the drills' Revision 1. A click on the Vectors card shows the revision's exact text and link, and the Review targets Revision 1. A Task with nothing sent offers no decision. Carla's page has no draft fields and none of Lena's private text.
2. **Changes Requested needs feedback**: "Request changes" stays disabled, with the reason, for empty and blank feedback; the API answers 422 and stores nothing. With feedback: "Changes Requested of Revision 1 recorded, confirmed by Gurow". The history shows the feedback, the queue is empty, and XP is 0.
3. **Feedback and correction**: returning to her page, Lena sees "Changes requested", the feedback and "send a correction as a new revision". Her page has no Review. She sends the correction as Revision 2.
4. **Stale decision**: Carla's page shows Revision 2 when Lena sends Revision 3 from elsewhere. Approving Revision 2 answers "Not recorded: the learner sent a newer revision, which replaced Revision 2 before your decision … Nothing changed". The page reads the history again: Revision 2 is superseded and Revision 3 is now the one to decide. The feedback is kept. XP, Mastery and Access are unchanged, and PostgreSQL has no new Review, XP or Mastery row.
5. **Confirmed progress**: with the Approval request held in the browser, the page says "Recording Approval of Revision 3…" while XP stays 0, Vectors unmastered and Matrices locked; nothing is stored. Once the answer arrives, the page says "Approval of Revision 3 recorded". The records read that follows is held: the page says "Reading the resulting XP, Mastery and Access…" and XP stays 0. The read then fails: the page says the progress "could not be read, so what is shown above may be out of date", XP stays 0, and the header reports the failed read. "Read them again" succeeds: "XP, Mastery and Access above are as Gurow derived them after it", 20 XP with one award in the Task's XP history, Vectors mastered and Matrices open. Lena sees the same, and opening Matrices leaves her 20 XP.
6. **Independent assessment**: Lena sends Revision 4. Carla reads "It does not inherit the Approval of Revision 3, which counts whatever you decide here" and requests changes; XP and Mastery stay on both pages. Lena reads "the Approval of Revision 3 still counts". Carla approves Revision 5, and its answer is dropped after the backend commits it; the page reports it recorded from the history. Revision 6 is approved from another tab, and this page's Changes Requested is refused: "Revision 6 already has a decision". Three Approvals in all: one 20-XP award and one Mastery award are stored.
7. **Review after Access loss, from the keyboard**: Lena sends Matrix drills while Matrices is open. Carla revokes the Vectors Approvals, which locks Matrices. On a Coach page without WebGPU, the queue still lists the Matrix drills. Tab from the top of the page reaches the entry, and Enter opens Matrices with the feedback field focused. Typing, Tab and Enter on "Approve Revision 1" record it: 15 XP, Matrices mastered but still locked, and Lena's page gives "Requires Mastery of “Vectors”" as the reason.
8. **Self-approval and peers**: Lena's page has no Review, and her API decision on her own revision answers 403 `coach_only`. Pia's decision answers 404 `enrollment_not_found`; she cannot list the Version's Enrollments (404), and Lena's Enrollment is "not available" to her. Pia's own page has no Review. Nothing is stored, and the revision stays in Carla's queue.
9. **Reload and privacy**: after a reload, both see the drills history as changes requested, superseded, revoked, changes requested, revoked, revoked, with the feedback, and 15 XP with Matrices mastered and locked. None of the requests from Carla's pages asked for a Submission draft.

Changed expectation: a T10 test compared the whole learning state before and after refused revocations. New revisions are sent between those reads, and `awaitingReview` now lists them, so the test compares everything except `awaitingReview`; the progress records must still be identical.

Mutation checks, each restored afterwards. Each one failed the named test:

| Mutation | Failed |
|---|---|
| A revision superseded before a decision still listed as awaiting | Backend test |
| Changes Requested allowed without feedback | Unit test; browser step 2 |
| A decision shown as recorded before the backend answers | Browser step 5 |
| No new read of the history and records after a refused decision | Browser step 4 |
| A decision moved to the newest pending revision | Browser step 4 |
| The learner's page renders the Review | Browser step 3 |
| The queue hides revisions of locked Skills | Browser step 7 |
| A lost answer treated as a refusal | Browser step 6 |
| Progress claimed as soon as the backend answers, before the records are read again (review fix) | Browser step 5 |

## Decisions

- The Coach finds work from the Version (its enrolled learners and their queues) and then within an Enrollment. There is no Workspace-wide inbox; a Coach with many Versions opens each one.
- A decision names the revision the Coach was shown. When a newer one arrives in the meantime, the decision is refused rather than redirected, so nobody approves contents they have not read.
- Lost answers are reconciled with the history rather than retried. A decision is never recorded twice (the backend refuses a second one with 409), so deciding again after "Not confirmed" is safe and the page says so.
- The queue and the progress are read again when the page becomes visible and on Refresh; there is no push from the backend.

## Review fixes

An independent review found no Standards problem and one Spec problem.

- **Spec (P2), fixed with a test**: after a decision, the Review said at once that the XP, Mastery and Access shown followed it, and a refusal said at once that the history and progress were read again. Both reads had only been started; a slow or failed records read left the earlier progress on show under that claim. The history and records reads now report whether fresh data is on show, and the Review waits for both: "reading", then the claim, or "may be out of date" with "Read them again". Browser step 5 holds and then fails the records read after the Approval; claiming the progress at once fails it.

## Not proven here

- Approval Revocation in the UI is T24; the revocations here go through the API.
- Keyboard checks cover reaching the queue with Tab, opening it with Enter, typing feedback and approving with Tab and Enter, not the Tab order of every control. The headed P1 capture was not run.
