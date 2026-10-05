/**
 * Outgoing email (ADR 0023): verification links and Enrollment Invitations go
 * through one {@link Mailer}. The served backend uses Resend's HTTP API when it is
 * configured and otherwise only logs each link, which is enough for local
 * development but delivers nothing; callers are told which happened.
 */

export interface Email {
  to: string
  subject: string
  text: string
  html: string
  /** The one link the email exists to deliver, also what the logging mailer prints. */
  link: string
  purpose: 'email verification' | 'enrollment invitation'
  /** Sent as Resend's `Idempotency-Key`, so a retried request is delivered once. */
  idempotencyKey?: string
}

/**
 * What became of an email: `delivered` when the provider accepted it, `logged` when no
 * provider is configured and its link was only written to the server log.
 */
export type MailOutcome = 'delivered' | 'logged'

/** Delivers one email; rejects when the provider did not accept it. */
export type Mailer = (email: Email) => Promise<MailOutcome>

export class MailDeliveryError extends Error {
  constructor(readonly status: number | null, message: string) { super(message) }
}

export interface ResendConfig {
  apiKey: string
  /** Sender address on a domain verified in the Resend account, e.g. `Gurow <invitations@example.com>`. */
  from: string
  /** API origin; a local stand-in in tests. */
  apiUrl?: string
  fetch?: typeof fetch
}

/** Sends through Resend's `POST /emails` (https://resend.com/docs/api-reference/emails/send-email). */
export function resendMailer({ apiKey, from, apiUrl = 'https://api.resend.com', fetch: send = fetch }: ResendConfig): Mailer {
  return async (email) => {
    let response: Response
    try {
      response = await send(new URL('/emails', apiUrl), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          ...(email.idempotencyKey ? { 'idempotency-key': email.idempotencyKey } : {}),
        },
        body: JSON.stringify({ from, to: [email.to], subject: email.subject, text: email.text, html: email.html }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch (error) {
      throw new MailDeliveryError(null, `Resend could not be reached: ${error instanceof Error ? error.message : error}`)
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { message?: unknown } | null
      throw new MailDeliveryError(response.status, `Resend refused the email (${response.status}): ${typeof body?.message === 'string' ? body.message : response.statusText}`)
    }
    return 'delivered'
  }
}

/** Development stand-in: prints the link instead of delivering it, and says so. */
export const loggingMailer: Mailer = async ({ purpose, to, link }) => {
  console.log(`[gurow] ${purpose} for ${to}: ${link}`)
  return 'logged'
}

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export function verificationEmail(to: string, link: string): Email {
  return {
    to, link, purpose: 'email verification',
    subject: 'Verify your Gurow email address',
    text: `Open this link to verify ${to} for your Gurow Account:\n\n${link}\n`,
    html: `<p>Open this link to verify ${escape(to)} for your Gurow Account:</p><p><a href="${escape(link)}">Verify email address</a></p>`,
  }
}

export interface InvitationMessage {
  invitationId: string
  to: string
  link: string
  learningPathTitle: string
  versionNumber: number
  coachWorkspaceName: string
  /** Distinguishes one delivery attempt; a retry of the same attempt reuses it. */
  attempt: number
}

export function invitationEmail(message: InvitationMessage): Email {
  const offer = `${message.learningPathTitle} (Version ${message.versionNumber}) in ${message.coachWorkspaceName}`
  return {
    to: message.to, link: message.link, purpose: 'enrollment invitation',
    idempotencyKey: `enrollment-invitation/${message.invitationId}/${message.attempt}`,
    subject: `You are invited to ${message.learningPathTitle} on Gurow`,
    text: `You are invited to join ${offer}.\n\nSign in with ${message.to}, verify it if you have not yet, and accept here:\n\n${message.link}\n`,
    html: `<p>You are invited to join <strong>${escape(offer)}</strong>.</p><p>Sign in with ${escape(message.to)}, verify it if you have not yet, and accept here:</p><p><a href="${escape(message.link)}">Open the invitation</a></p>`,
  }
}
