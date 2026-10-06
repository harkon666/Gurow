# T25 Managing Access Overrides from the Coach UI: local evidence

Ticket [#26](https://github.com/harkon666/Gurow/issues/26) (T25). Recorded on 2026-10-06 from harness checks of branch `feat/t25-coach-access-overrides`, based on `6248842`, with the T25 changes in the working tree. Run logs stay local in `.harness/runs/`. This report was written before the final full check, which covers it.

The owning Coach can now grant or revoke an Access Override from the learner's Enrollment page. When a Skill is selected, its Access section offers the Coach "Grant Access Override…", or "Revoke Access Override…" while one is in force. The form names the learner and the Skill. It states what the rules will do: for a grant, the unmet Prerequisites and XP Threshold it waives for this learner and Skill only, and that XP, Mastery and other Enrollments do not change; for a revocation, the ordinary requirements that will lock the Skill and that sent work stays reviewable. A brief reason is required. As with a Review (T23) or a revocation (T24), the change counts as recorded only once the backend answers. The page then shows the record it returned (action, Actor, target, time, reason), reads the records again, and says Access follows the change only once that read is on show. A refusal says "Not recorded … Nothing changed", reads again and keeps the reason. A lost answer is reconciled with the Override Records.

Both the learner and the Coach read every Override Record of the Skill: "Access Override granted / revoked by …", the Skill and learner it targets in this Enrollment only, its time and reason. While an override is in force, the Access section shows its reason, lists the requirements it waives and says it changes no XP or Mastery. On an inactive Enrollment, the Skill stays Locked with inactivity as its only reason, and the page says the override does not reactivate the Enrollment; nothing in the Access section offers reactivation.

Backend: the T11 override routes are unchanged. `GET /api/enrollments/:enrollmentId/version` adds `coach: { id, name }`, the Workspace's owner by name only, so both viewers can name the Actor of a record. See the [backend README](../../backend/README.md#access-overrides-from-the-coach-ui-t25).

## Environment

| Item | Value |
|---|---|
| Database | PostgreSQL from `compose.yaml` on 127.0.0.1:5433; no new migration |
| Browser check database | `gurow_t25_browser_test`, migrated and emptied before the run |
| Email | The Resend HTTP mailer, pointed at the local stand-in; every verification and Invitation link is read from a delivered email |
| Browser | Headless Chromium via puppeteer-core, `--enable-unsafe-webgpu --use-gl=angle`, 1400×900; one browser context per person |
| Served backend and frontend | `backend/src/index.ts` with Better Auth sessions; Nitro production build, `/api/*` forwarded |

## Commands and outcomes

| Command | Coverage | Result |
|---|---|---|
| `bun test test/enrolled-version.test.ts test/override.test.ts` (backend) | The document names the Workspace's Coach (`id`, `name`) without an email; T11's override suite as regression | pass (see the final run) |
| `bun test src/components/path/overrideWork.test.ts` (frontend) | Mandatory reason within 500 characters; refusal messages; a lost answer found only in a later record of the same Skill, action, reason and, for a revocation, the same target grant; waived requirements are not lock reasons, inactivity always is; grant and revocation outlooks, including that an override is not a reactivation; record text with action, Actor and target for the Coach and the learner | 8 pass, 0 fail |
| `bun run scripts/t25-access-override-check.ts` (frontend) | Browser flow below, on a fresh build | 7 of 7 steps passed |
| Full harness check, backend suites and the earlier browser checks | Regressions | see the final run in `.harness/` |

Browser steps, with real Accounts that sign up and verify through emailed links. Carla publishes Linear Algebra: Vectors (Required "Vectors drills", 20 XP) before Matrices (requires Mastery of Vectors and 20 XP; Required "Matrices drills", 15 XP). Lena and Pia accept Carla's emailed Invitations. Otto, Coach of another Workspace, publishes Statistics with the same shape and invites Lena. Deactivation and reactivation are T26's UI and are made through the API.

1. **Authority**: Matrices is Locked for Lena with "Requires Mastery of “Vectors”" and "Needs 20 more XP". Neither Lena's nor Pia's page has an override control. Lena's grant answers 403 `coach_only`, Pia's 404 and Otto's 404; Lena's Enrollment is unavailable to Otto. Carla's grant into Lena's Statistics Enrollment, or with Otto's Skill on her own Enrollment, answers 404. A blank reason answers 422. Nothing is stored.
2. **Grant**: the outlook says "For this learner and Skill only, it waives: Requires Mastery of “Vectors”; Needs 20 more XP…" and "XP and Mastery do not change, and no other Enrollment or learner is affected." Confirm stays disabled for an empty and a blank reason. With the request held in the browser, the page says only "Granting the Access Override…": Matrices stays Locked and nothing is stored. Once confirmed: "Recorded by Gurow: Access Override granted by you (carla) · “Matrices” for lena, in this Enrollment only · (time) · Reason: …", and the same record in the Skill's Override Records. PostgreSQL holds one grant naming Carla, Lena, the Enrollment, Matrices, the reason and the time. Matrices is open by override; 0 XP, nothing mastered, no XP or Mastery event.
3. **Use**: Lena reads "Open by Coach override", the reason, "Waived: Requires Mastery of “Vectors”", "Waived: Needs 20 more XP" and "It changes no XP or Mastery", and the record "granted by carla, Coach of this Workspace · “Matrices” for you". She sends Matrices drills Revision 1 from her page and saves a further draft. XP and Mastery are unchanged. Pia's learning state and Lena's Statistics Enrollment are exactly as before; Lena's send in Statistics is refused 403 `skill_locked`.
4. **Inactive**: with the override in force, Lena deactivates. For Lena and Carla, Matrices is Locked with "This Enrollment is inactive…" as its only reason, and the page says "It does not reactivate this Enrollment…". No control in the Access section offers reactivation. Lena's Send is disabled; starting and sending answer 403 `enrollment_inactive`. The Enrollment stays inactive with the override stored. After Carla's separate reactivation, the override applies again.
5. **Revoke**: Lena's revocation answers 403 and Otto's 404. The outlook says "Access returns to the ordinary rules, which lock “Matrices” now: …" and that sent work stays reviewable. The reason is required. The answer is dropped after the backend commits; the page confirms it from the Override Records ("the answer was lost, but the Override Records show it"). Exactly one revoke record names the grant. Matrices is Locked with its ordinary reasons.
6. **Eligible later Review**: Lena sees Matrices Locked with its ordinary reasons, both records, Revision 1 awaiting Review and her saved draft; sending is refused (403 `skill_locked`). Carla opens Revision 1 from the awaiting queue and approves it: 15 XP, Matrices mastered and still locked, for both; one XP and one Mastery event.
7. **Stale page and reload**: while Carla's page still offers a grant, one is made elsewhere. Granting here answers "Not recorded: an Access Override for this Skill is already in force (perhaps granted from another tab) … Nothing changed"; the page reads again, and the form closes since a revocation is now due. After reloading, Carla and Lena read grant, revoke, grant with their reasons, Matrices open by override and mastered, and 15 XP. Pia's and Otto's Enrollments are unchanged.

Mutation checks, each restored afterwards. Each one failed the named test:

| Mutation | Failed |
|---|---|
| A grant shown as recorded before the backend answers | Browser step 2 |
| The learner's page renders the override control | Browser step 1 |
| A grant allowed without a reason | Unit test; browser step 2 |
| Waived requirements still listed as lock reasons while an override is in force | Unit test; browser step 4 |
| A lost answer matched to any record of the same Skill, action and reason, including earlier ones | Unit test |
| A lost revocation matched without its target grant (review fix) | Unit test |
| The note that an override does not reactivate an inactive Enrollment removed | Browser step 4 |

## Decisions

- The control lives in the selected Skill's Access section on the Enrollment page, the Coach's existing learner view, beside the Access it changes; there is no separate override screen.
- The Actor is named from the record's `coachAccountId`: "you" for the signed-in Coach, the Workspace Coach's name for the learner. The backend exposes that Coach's name only, not their email address.
- Lock reasons omit requirements an override in force waives. On an inactive Enrollment the override's requirements are therefore not listed as reasons, and inactivity is.
- When the records show that the other action is due (granted or revoked elsewhere), an open form closes and a reason written for the other action is not carried over.

## Review fixes

An independent review found one problem, reported on both axes (Standards and Spec, P2).

- **Lost revocation confirmed by another grant's revocation, fixed with a test**: a revocation targets exactly one grant, but the reconciliation of a lost answer matched only the Skill, action, reason and a later sequence. If grant A was revoked elsewhere for another reason, and grant B was then granted and revoked with this request's reason, B's revocation was shown as "Recorded" for the request against A, and the reason typed was cleared. The request now carries its target grant (null for a grant), and only a record naming the same grant confirms it. A unit test covers this case; dropping the grant check fails it. The browser flow is unchanged, since that interleaving needs three timed operations across tabs.

## Not proven here

- Deactivation and reactivation are driven through the API; their UI is T26.
- A lost grant cannot be told apart from another grant of the same Skill with the same reason made after it by the same Coach: a grant names no earlier record. The page then confirms that grant, which has the same effect.
- Keyboard use of the override form is ordinary buttons and a text field; the check focuses the reason field and types, but does not walk a full Tab order. The headed P1 capture was not run.
