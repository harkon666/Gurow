import { createApp } from './app'
import { createDatabase } from './db/client'
import { noTrustedIdentity } from './identity'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is not set; copy backend/.env.example to backend/.env')

// No production sign-in exists yet, so protected routes reject every request;
// the fixture identity used by integration tests is never wired here.
export default createApp({ db: createDatabase(url).db, identity: noTrustedIdentity })
