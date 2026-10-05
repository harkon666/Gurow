# T20 Invitations and Enrollment Closure: local evidence

Ticket [#21](https://github.com/harkon666/Gurow/issues/21) (T20). Recorded on 2026-10-05 from harness checks of branch `feat/t20-invite-and-admit-learners`, based on `ba6b849`, with the T20 changes in the working tree. Run logs stay local in `.harness/runs/`. This report was written before the final full check, which covers it.

A Coach invites one email address to one published Version, and the Account with that verified email accepts it through the emailed link, joining that Version only. The Coach closes or reopens the Version to new Enrollments without changing existing ones. Email leaves through Resend's HTTP API ([ADR 0023](../adr/0023-deliver-email-through-resend.md)). Routes and refusals are described in the [backend README](../../backend/README.md#invitations-and-enrollment-closure-t20).

## Environment

| Item | Value |
|---|---|
| Database | PostgreSQL from `compose.yaml` on 127.0.0.1:5433; migration `0014_invitation_delivery` applied |
| Backend tests | `gurow_test`, truncated before each test; served backend (`createServer`) with Better Auth sessions |
| Browser check database | `gurow_t20_browser_test`, migrated and emptied before the run |
| Email | The Resend HTTP mailer, pointed (`RESEND_API_URL`) at a local stand-in of Resend's `POST /emails` contract (`backend/test/support/resend-stand-in.ts`) |
| Browser | Headless Chromium via puppeteer-core, `--enable-unsafe-webgpu --use-gl=angle`, 1400×900; four separate browser contexts; request interception for lost-connection faults |
| Served backend | `backend/src/index.ts` (production entry) with `RESEND_API_KEY`, `RESEND_API_URL`, `MAIL_FROM`; for the last step a second instance in the default configuration without them, on the same database |
| Served frontend | Nitro production build, `/api/*` forwarded to the backend |

## Commands and outcomes

| Command | Coverage | Result |
|---|---|---|
| `bun test test/invitation.test.ts test/mail.test.ts` (backend) | Invitation creation and delivery, verified identity, unrelated Accounts, no expiry, repeated and competing acceptance, inactive Enrollments, owner refusal, closure and reopening, forced-order races between closure and acceptance, delivery failures and retries, a server without an email provider, the Resend request contract | 19 pass, 0 fail |
| `bun test` (backend) | All earlier backend suites | 191 pass, 0 fail |
| `bun run scripts/t20-invitation-check.ts` (frontend) | Browser flow below, on a fresh build | 11 of 11 steps passed |
| Full harness check and the T04/T05/T06/T15/T18/T19/T44 checks | Regressions | see the final run in `.harness/` |

Browser steps:

1. **Published Version offers admission**: the Coach verifies her address through the delivered email and publishes two Paths. Version 1's page shows "Open to new Enrollments", and the published content itself still has no inputs.
2. **Invitation delivered**: "Send invitation" to lena@gurow.test reports the email sent. The stand-in received a Resend request from `MAIL_FROM` naming "Linear Algebra (Version 1) in Linear Algebra Studio" with the link `/invitations/<id>` and the idempotency key for attempt 1.
3. **Delivery retry**: with the stand-in answering 500, an Invitation to pia@gurow.test is kept and shown as not delivered. A retry that also fails is reported. The third attempt delivers the same Invitation, which still has one row.
4. **Verified identity**: Lena opens the emailed link signed out, signs up from it and returns to the Invitation, where an unverified address is refused without showing the offer. "Send a verification email" delivers a link that verifies her and returns her to the offer of Linear Algebra Version 1.
5. **Lost connection**: with requests for the Invitation failing as a dropped connection would, the page reports that Gurow could not be reached instead of staying on "Checking the Invitation…", and "Try again" shows the offer once the connection is back. A failed acceptance reports that nothing was accepted, keeps the accept button, and no Enrollment exists.
6. **Backend-confirmed acceptance**: accepting shows "You are enrolled in Linear Algebra, Version 1". Accepting again after a reload shows the same Enrollment. The database holds one Enrollment for Lena, in Version 1 and not in Calculus. The Coach sees "accepted" after a reload.
7. **Unrelated Account rejected**: Mallory, verified, opens Lena's link and is refused `email_mismatch` with no offer and no accept button. Her API acceptance answers 403, and she has no Enrollment.
8. **Owner rejected**: the Coach accepting an Invitation to her own address is told a Coach cannot enroll in their own Workspace.
9. **Closed admission**: after "Close Version 1 to new Enrollments", Pia (verified through the emailed link) is refused because the Version is closed. Lena still accepts as already enrolled, still active, and still reads her learning state. After reopening, Pia is enrolled.
10. **Inactive stays inactive**: Lena deactivates her Enrollment, and the Coach sends her a second Invitation. Accepting it shows the same Enrollment, still inactive, with a note that only the Coach can reactivate it.
11. **No email provider configured**: on a second backend served without `RESEND_API_KEY`, the Coach's Invitation is shown as saved but not emailed, because no provider is configured, and stored as `logged`. Nothing reached the Resend stand-in, and the link appears only in that server's log.

Mutation checks, each restored afterwards. Each one failed the named test:

| Mutation | Failed |
|---|---|
| Acceptance reads the Version without `FOR SHARE` | Closure ordering: the acceptance finished without waiting on the uncommitted closure |
| Verified-email check removed | AC2 emailed-link flow |
| Enrollment Closure ignored at acceptance | AC4 closure flow and closure ordering |
| Resend without the owner check | AC6 owner-only resend |
| Invitations to an unpublished Draft allowed | AC1 refusals |
| Workspace owner may enroll | AC3 owner refusal |
| The logging mailer reports delivery | Logging-mailer unit test and the backend no-provider test |
| A logged email recorded as `sent` | Backend no-provider test |
| Invitation page reads without catching a lost connection | Browser step 5 (still loading after 10 s) |
| A logged email shown as a delivery failure, or as emailed | Browser step 11 |

Closure without its explicit `FOR UPDATE` does not fail any test: the closure's `UPDATE` takes the same row lock, so admission stays correct, and only the `changed` flag under concurrent closures relies on it.

## Review fixes

An independent review found two Spec problems, both fixed with tests:

- Without `RESEND_API_KEY`, the logging mailer resolved like a delivery, so the Invitation was stored as `sent` and the Coach read "Invitation emailed" although no email left. The mailer now reports `logged`, stored as its own delivery status and shown as not emailed (backend no-provider test, browser step 11).
- A lost connection while reading the Invitation left the page loading indefinitely. It is now reported with "Try again", and a lost acceptance keeps the accept button (browser step 5).

A Standards note about duplicated cookie handling in the backend tests was also addressed: `backend/test/support/browser.ts` now serves both the sign-in and invitation suites.

## Not proven here

- Delivery by Resend itself. The checks prove the request Gurow sends and how it handles refusals, unreachable providers and retries. Production delivery needs the external setup listed in ADR 0023: a Resend account, a verified sending domain with SPF and DKIM records, `RESEND_API_KEY`, `MAIL_FROM` and a public `BETTER_AUTH_URL`.
- Decisions the ticket did not specify: Invitations can be sent while a Version is closed (they admit after reopening), and to the Coach's own address (refused at acceptance). Delivery status is informational. Invitations have no expiry or revocation, since none was agreed.
- Opening the enrolled Version after acceptance is T21. Keyboard-only flows and the headed P1 capture were not run.
- Other owner-only pages load through `useOwnedView`, which has the same unhandled lost-connection pattern; it predates T20 and is left for a separate fix.
