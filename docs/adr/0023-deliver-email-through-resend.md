# Deliver email through Resend's HTTP API

Verification links and Enrollment Invitations leave the backend through one mailer (`backend/src/mail.ts`). The served backend uses Resend's HTTP API (`POST https://api.resend.com/emails`, Bearer API key) when `RESEND_API_KEY` is set, and otherwise only logs each link, as before. This supersedes the "no delivery provider is integrated" part of [ADR 0022](0022-sign-in-with-better-auth-email-and-password.md); sign-in itself is unchanged.

An Invitation is stored before its email is sent, and delivery runs outside the storing transaction, so a slow or failed provider never holds database locks or loses an Invitation. Each attempt is numbered and sends Resend an `Idempotency-Key` of `enrollment-invitation/<id>/<attempt>`: a repeated request within one attempt is delivered once, while the Coach's explicit "Send again" starts a new attempt. The Invitation records what became of its last attempt: `sent` only when the provider accepted the email, `logged` when no provider is configured and the link was only written to the server log, `failed` when the provider refused it or could not be reached (`pending` before the first attempt). The mailer reports `logged` itself, so a server without a provider never claims an email was sent, and the Coach sees that no email left. Delivery state never affects who may accept: acceptance still requires an Account with the matching verified email, and Invitations have no expiry because none was agreed.

Resend was chosen over SMTP and over a log-only seam because it is a single authenticated HTTP request with no extra dependency or local mail service, while still being a real provider for production. The cost is that local and CI checks cannot reach Resend: they run the same HTTP mailer against a local stand-in of Resend's documented contract (`backend/test/support/resend-stand-in.ts`). This proves the request Gurow sends and how it handles refusals, unreachable providers and retries, but not delivery by Resend itself.

External setup required before production delivery, none of which has been exercised:

- A Resend account, with the sending domain added and verified (its SPF and DKIM DNS records published).
- `RESEND_API_KEY`: an API key with sending access; `MAIL_FROM`: a sender on that verified domain, such as `Gurow <invitations@example.com>`. The backend refuses to start with a key but no sender.
- `BETTER_AUTH_URL` set to the public origin, because emailed verification and invitation links are built from it.
- Optionally, delivery monitoring (bounces and complaints) in Resend; Gurow does not consume Resend webhooks.
