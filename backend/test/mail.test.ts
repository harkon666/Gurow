import { afterEach, expect, it, spyOn } from 'bun:test'
import { invitationEmail, loggingMailer, MailDeliveryError, resendMailer, verificationEmail } from '../src/mail'
import { startResendStandIn } from './support/resend-stand-in'

/** T20 (#21): the Resend HTTP mailer and the emails it sends (ADR 0023). */
let resend: ReturnType<typeof startResendStandIn> | null = null
afterEach(() => { resend?.stop(); resend = null })

const invitation = invitationEmail({
  invitationId: '0f6a1c3e-0000-4000-8000-000000000001', to: 'lena@gurow.test', link: 'https://gurow.test/invitations/0f6a1c3e-0000-4000-8000-000000000001',
  learningPathTitle: 'Linear <Algebra> & "Proofs"', versionNumber: 2, coachWorkspaceName: 'Studio', attempt: 3,
})

it('posts one email to Resend with the Bearer key, sender, recipient, both bodies and the idempotency key', async () => {
  resend = startResendStandIn('re_unit')
  expect(await resendMailer({ apiKey: 're_unit', from: 'Gurow <invitations@gurow.test>', apiUrl: resend.url })(invitation)).toBe('delivered')
  expect(resend.sent).toHaveLength(1)
  expect(resend.sent[0]).toMatchObject({
    from: 'Gurow <invitations@gurow.test>', to: ['lena@gurow.test'], subject: 'You are invited to Linear <Algebra> & "Proofs" on Gurow',
    idempotencyKey: 'enrollment-invitation/0f6a1c3e-0000-4000-8000-000000000001/3',
  })
  expect(resend.sent[0].text).toContain('Linear <Algebra> & "Proofs" (Version 2) in Studio')
  expect(resend.sent[0].text).toContain(invitation.link)
  // HTML bodies escape what the Coach typed.
  expect(resend.sent[0].html).toContain('Linear &#60;Algebra&#62; &#38; &#34;Proofs&#34; (Version 2) in Studio')
  expect(resend.sent[0].html).not.toContain('<Algebra>')
})

it('rejects when Resend refuses the request or cannot be reached', async () => {
  resend = startResendStandIn('re_unit')
  const wrongKey = resendMailer({ apiKey: 're_wrong', from: 'Gurow <a@gurow.test>', apiUrl: resend.url })
  const refused = await wrongKey(invitation).catch((error) => error)
  expect(refused).toBeInstanceOf(MailDeliveryError)
  expect(refused).toMatchObject({ status: 401, message: 'Resend refused the email (401): API key is invalid' })

  resend.fail(503)
  expect(await resendMailer({ apiKey: 're_unit', from: 'Gurow <a@gurow.test>', apiUrl: resend.url })(invitation).catch((e) => e)).toMatchObject({ status: 503 })

  const url = resend.url
  resend.stop()
  const unreachable = await resendMailer({ apiKey: 're_unit', from: 'Gurow <a@gurow.test>', apiUrl: url })(invitation).catch((e) => e)
  expect(unreachable).toMatchObject({ status: null })
  expect(unreachable.message).toStartWith('Resend could not be reached')
})

it('logs each link in the format local development and the T15 check read, reporting it as logged', async () => {
  const log = spyOn(console, 'log').mockImplementation(() => {})
  try {
    // It never claims delivery: the caller learns the email was only logged.
    expect(await loggingMailer(verificationEmail('ada@gurow.test', 'http://localhost:3000/api/auth/verify-email?token=t'))).toBe('logged')
    expect(await loggingMailer(invitation)).toBe('logged')
    expect(log.mock.calls.map((call) => call[0])).toEqual([
      '[gurow] email verification for ada@gurow.test: http://localhost:3000/api/auth/verify-email?token=t',
      `[gurow] enrollment invitation for lena@gurow.test: ${invitation.link}`,
    ])
  } finally {
    log.mockRestore()
  }
})
