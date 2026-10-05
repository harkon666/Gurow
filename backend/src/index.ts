import { createServer } from './app'
import { createAuth } from './auth'
import { createDatabase } from './db/client'
import { invitationEmail, loggingMailer, resendMailer, verificationEmail } from './mail'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is not set; copy backend/.env.example to backend/.env')
const secret = process.env.BETTER_AUTH_SECRET
if (!secret || secret.length < 32) throw new Error('BETTER_AUTH_SECRET must hold at least 32 characters; see backend/.env.example')
const baseURL = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000'

// Email goes through Resend when it is configured (ADR 0023). Without RESEND_API_KEY
// the links are only logged: enough for local development, but nothing is delivered.
const resendKey = process.env.RESEND_API_KEY
const mailFrom = process.env.MAIL_FROM
if (resendKey && !mailFrom) throw new Error('MAIL_FROM must name a sender on a Resend-verified domain when RESEND_API_KEY is set')
const mailer = resendKey ? resendMailer({ apiKey: resendKey, from: mailFrom!, apiUrl: process.env.RESEND_API_URL }) : loggingMailer
if (!resendKey) console.warn('[gurow] RESEND_API_KEY is not set: emails are logged, not delivered')

const { db } = createDatabase(url)
const auth = createAuth({ db, baseURL, secret, sendVerificationEmail: async ({ to, url: link }) => { await mailer(verificationEmail(to, link)) } })
const delivery = {
  send: async (message: Parameters<typeof invitationEmail>[0]) => mailer(invitationEmail(message)),
  link: (invitationId: string) => new URL(`/invitations/${invitationId}`, baseURL).toString(),
}

// Identity comes only from Better Auth sessions; the P2 fixture header is never trusted.
export default { port: Number(process.env.PORT ?? 3001), fetch: createServer({ db, auth, delivery }).fetch }
