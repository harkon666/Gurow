import { createServer } from './app'
import { createAuth } from './auth'
import { createDatabase } from './db/client'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is not set; copy backend/.env.example to backend/.env')
const secret = process.env.BETTER_AUTH_SECRET
if (!secret || secret.length < 32) throw new Error('BETTER_AUTH_SECRET must hold at least 32 characters; see backend/.env.example')
const baseURL = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000'

const { db } = createDatabase(url)
const auth = createAuth({
  db, baseURL, secret,
  // No email provider is integrated yet (ADR 0022): the link is only logged, so this
  // server can verify addresses for local development but not deliver real email.
  sendVerificationEmail: async ({ to, url: link }) => console.log(`[gurow] email verification for ${to}: ${link}`),
})

// Identity comes only from Better Auth sessions; the P2 fixture header is never trusted.
export default { port: Number(process.env.PORT ?? 3001), fetch: createServer({ db, auth }).fetch }
