import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { createServer } from '../src/app'
import { createAuth } from '../src/auth'
import type { Database } from '../src/db/client'
import { accounts, authCredentials, enrollmentInvitations, enrollments, personalWorkspaces } from '../src/db/schema'
import { FIXTURE_IDENTITY_HEADER } from '../src/identity'
import { prepareTestDatabase, resetTestDatabase } from './support/database'
import { seedEnrollmentFixture, seedPersonalFixture, type EnrollmentFixture } from './support/fixtures'

/**
 * T15 sign-in through the served backend: Better Auth email/password sessions over
 * real PostgreSQL (ADR 0022). Each "browser" is a cookie jar; verification links are
 * captured from the mailer instead of being delivered.
 */
const ORIGIN = 'http://localhost:3000'
const PASSWORD = 'correct horse battery staple'

let db: Database, close: () => Promise<void>, server: ReturnType<typeof createServer>, fx: EnrollmentFixture
let outbox: { to: string; url: string }[]
beforeAll(async () => { ({ db, close } = await prepareTestDatabase()) })
afterAll(async () => { await close() })
beforeEach(async () => {
  await resetTestDatabase(db)
  fx = await seedEnrollmentFixture(db)
  outbox = []
  const auth = createAuth({ db, baseURL: ORIGIN, secret: 'test-secret-with-at-least-32-characters!', sendVerificationEmail: async (message) => { outbox.push(message) } })
  server = createServer({ db, auth })
})

/** A browser: keeps the cookies the server sets and sends them back, like a same-origin fetch. */
class Browser {
  cookies = new Map<string, string>()
  async request(path: string, { method = 'GET', body, headers = {} }: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    const response = await server.request(new URL(path, ORIGIN).toString(), {
      method,
      redirect: 'manual',
      headers: {
        origin: ORIGIN,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.cookies.size ? { cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ') } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...attributes] = header.split(';')
      const [name, value] = [pair.slice(0, pair.indexOf('=')).trim(), pair.slice(pair.indexOf('=') + 1)]
      const expired = attributes.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === ''
      if (expired) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
    return response
  }
  signUp(email: string, extra: Record<string, unknown> = {}) {
    return this.request('/api/auth/sign-up/email', { method: 'POST', body: { email, password: PASSWORD, name: email.split('@')[0], ...extra } })
  }
  signIn(email: string, password = PASSWORD) {
    return this.request('/api/auth/sign-in/email', { method: 'POST', body: { email, password } })
  }
  signOut() { return this.request('/api/auth/sign-out', { method: 'POST', body: {} }) }
  async account() {
    const response = await this.request('/api/account')
    return { status: response.status, body: await response.json() as any }
  }
  enter() { return this.request('/api/personal/workspace', { method: 'PUT' }) }
}

async function signedUp(email: string) {
  const browser = new Browser()
  expect((await browser.signUp(email)).status).toBe(200)
  return browser
}
const json = async (response: Response | Promise<Response>) => (await response).json() as Promise<any>
const workspaceRows = (accountId: string) => db.select().from(personalWorkspaces).where(eq(personalWorkspaces.ownerAccountId, accountId))

describe('AC1: browser sign-in establishes an authenticated Account; no client-named Actor is authority', () => {
  it('signs up, signs out and signs back in to the same persisted Account with a hashed credential', async () => {
    const browser = await signedUp('ada@gurow.test')
    const first = await browser.account()
    expect(first.status).toBe(200)
    expect(first.body.account.email).toBe('ada@gurow.test')
    const [row] = await db.select().from(accounts).where(eq(accounts.id, first.body.account.id))
    expect(row.email).toBe('ada@gurow.test')
    const [credential] = await db.select().from(authCredentials).where(eq(authCredentials.userId, row.id))
    expect(credential.providerId).toBe('credential')
    expect(credential.password).not.toContain(PASSWORD)

    expect((await browser.signOut()).status).toBe(200)
    expect((await browser.account()).status).toBe(401)
    expect((await browser.signIn('ada@gurow.test', 'wrong password')).status).toBe(401)
    expect((await browser.account()).status).toBe(401)
    expect((await browser.signIn('ada@gurow.test')).status).toBe(200)
    expect((await browser.account()).body.account.id).toBe(row.id)
  })

  it('rejects anonymous requests, the P2 fixture header, raw Account IDs and forged or signed-out session cookies', async () => {
    const anonymous = new Browser()
    for (const [path, method] of [['/api/account', 'GET'], ['/api/personal/workspace', 'PUT'], [`/api/enrollments/${crypto.randomUUID()}`, 'GET']] as const) {
      expect((await anonymous.request(path, { method })).status).toBe(401)
      // The fixture resolver's header names a real fixture Actor, but the served backend never trusts it.
      expect((await anonymous.request(path, { method, headers: { [FIXTURE_IDENTITY_HEADER]: 'learner' } })).status).toBe(401)
      expect((await anonymous.request(path, { method, headers: { [FIXTURE_IDENTITY_HEADER]: fx.accounts.learner.id } })).status).toBe(401)
    }
    expect(await workspaceRows(fx.accounts.learner.id)).toEqual([])

    const browser = await signedUp('grace@gurow.test')
    const [name, value] = [...browser.cookies].find(([cookie]) => cookie.endsWith('session_token'))!
    const forged = new Browser()
    forged.cookies.set(name, value.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')))
    expect((await forged.account()).status).toBe(401)
    const stolenAfterSignOut = new Browser()
    stolenAfterSignOut.cookies = new Map(browser.cookies)
    expect((await stolenAfterSignOut.account()).status).toBe(200)
    await browser.signOut()
    expect((await stolenAfterSignOut.account()).status).toBe(401)
  })
})

describe('AC2: one persisted Personal Workspace per Account', () => {
  it('keeps the same Workspace across repeated entries and sign-ins', async () => {
    const browser = await signedUp('ada@gurow.test')
    const { body: { account } } = await browser.account()
    const first = await browser.enter()
    expect(first.status).toBe(201)
    const { workspace } = await first.json() as any
    expect((await browser.enter()).status).toBe(200)
    await browser.signOut()
    await browser.signIn('ada@gurow.test')
    const again = await browser.enter()
    expect(again.status).toBe(200)
    expect((await again.json() as any).workspace.id).toBe(workspace.id)
    expect((await workspaceRows(account.id)).map((row) => row.id)).toEqual([workspace.id])
  })

  it('creates exactly one Workspace when first entries from several sessions race', async () => {
    await signedUp('race@gurow.test')
    const sessions = await Promise.all(Array.from({ length: 4 }, async () => {
      const browser = new Browser()
      expect((await browser.signIn('race@gurow.test')).status).toBe(200)
      return browser
    }))
    const responses = await Promise.all(Array.from({ length: 16 }, (_, i) => sessions[i % sessions.length].enter()))
    expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 201])
    const ids = new Set(await Promise.all(responses.map(async (r) => (await r.json() as any).workspace.id)))
    expect(ids.size).toBe(1)
    const { body: { account } } = await sessions[0].account()
    expect((await workspaceRows(account.id)).map((row) => row.id)).toEqual([...ids])
  })
})

describe('AC3: only the owner reads or writes the Workspace, including after Account switching', () => {
  it('hides one Account\'s Workspace, Paths and Task writes from another Account in the same browser', async () => {
    // The fixture learner and peer get real credentials; their Personal Workspaces come from the T13 fixture.
    const px = await seedPersonalFixture(db, fx)
    const browser = new Browser()
    for (const email of ['owner@gurow.test', 'other@gurow.test']) {
      expect((await browser.signUp(email)).status).toBe(200)
      await browser.signOut()
    }
    const owner = (await db.select().from(accounts).where(eq(accounts.email, 'owner@gurow.test')))[0]
    const other = (await db.select().from(accounts).where(eq(accounts.email, 'other@gurow.test')))[0]
    // Move the learner's personal Paths to the signed-up owner, so its Workspace holds real content.
    await db.update(personalWorkspaces).set({ ownerAccountId: owner.id }).where(eq(personalWorkspaces.id, px.workspaces.learnerSpace.id))

    await browser.signIn('owner@gurow.test')
    const entered = await json(browser.enter())
    expect(entered.workspace.id).toBe(px.workspaces.learnerSpace.id)
    // Both fixture Paths share one creation time, so only membership is fixed, not order.
    expect(entered.learningPaths.map((p: any) => p.title).sort()).toEqual(['Personal Guitar', 'Personal Rust'])
    const ownWorkspace = `/api/personal/workspaces/${entered.workspace.id}`
    const path = `/api/personal/learning-paths/${px.paths.main.id}`
    expect((await browser.request(ownWorkspace)).status).toBe(200)
    expect((await browser.request(`${path}/learning-state`)).status).toBe(200)

    await browser.signOut()
    expect((await browser.request(ownWorkspace)).status).toBe(401)
    await browser.signIn('other@gurow.test')
    const othersEntry = await browser.enter()
    expect(othersEntry.status).toBe(201)
    expect((await othersEntry.json() as any).workspace.id).not.toBe(entered.workspace.id)
    expect((await browser.request(ownWorkspace)).status).toBe(404)
    expect((await browser.request(`${path}/learning-state`)).status).toBe(404)
    const write = await browser.request(`${path}/tasks/${px.tasks.taskA.id}/completion`, { method: 'PUT' })
    expect(write.status).toBe(404)
    expect((await browser.request(`${path}/tasks/${px.tasks.taskA.id}/reward`, { method: 'PUT', body: { xpReward: 99 } })).status).toBe(404)
    expect((await browser.request(`/api/personal/workspaces/${px.workspaces.peerSpace.id}`)).status).toBe(404)

    // Switching back: the owner's write lands and the other Account's attempts left nothing behind.
    await browser.signOut()
    await browser.signIn('owner@gurow.test')
    const before = await json(browser.request(`${path}/learning-state`))
    expect(before.learningState.xp).toBe(0)
    expect(before.learningState.tasks.find((t: any) => t.taskId === px.tasks.taskA.id).xpReward).toBe(20)
    const completed = await json(browser.request(`${path}/tasks/${px.tasks.taskA.id}/completion`, { method: 'PUT' }))
    expect(completed.learningState.xp).toBe(20)
    expect((await workspaceRows(other.id)).length).toBe(1)
  })
})

describe('AC4: verified-email state comes only from the identity integration', () => {
  const inviteTo = async (email: string) => (await db.insert(enrollmentInvitations)
    .values({ learningPathVersionId: fx.versions.version1.id, email, invitedByAccountId: fx.accounts.coach.id }).returning())[0]

  it('ignores a client claim of verification and verifies only through the emailed link', async () => {
    const invitation = await inviteTo('newcomer@gurow.test')
    const browser = new Browser()
    expect((await browser.signUp('newcomer@gurow.test', { emailVerified: true })).status).toBe(200)
    expect((await browser.account()).body.account.emailVerified).toBe(false)
    expect((await browser.request('/api/auth/update-user', { method: 'POST', body: { emailVerified: true } })).status).toBeOneOf([200, 400])
    expect((await browser.account()).body.account.emailVerified).toBe(false)
    const [row] = await db.select().from(accounts).where(eq(accounts.email, 'newcomer@gurow.test'))
    expect(row.emailVerified).toBe(false)

    // The later invitation flow reads the same trusted state.
    const accept = () => browser.request(`/api/invitations/${invitation.id}/accept`, { method: 'POST' })
    expect(await json(accept())).toEqual({ error: 'email_not_verified' })
    expect(outbox.map((m) => m.to)).toEqual(['newcomer@gurow.test'])
    const link = new URL(outbox[0].url)
    const tampered = new URL(link)
    tampered.searchParams.set('token', `${link.searchParams.get('token')}x`)
    await new Browser().request(tampered.pathname + tampered.search)
    expect((await browser.account()).body.account.emailVerified).toBe(false)

    await new Browser().request(link.pathname + link.search)
    expect((await browser.account()).body.account.emailVerified).toBe(true)
    const accepted = await accept()
    expect(accepted.status).toBe(201)
    expect((await accepted.json() as any).enrollment.accountId).toBe(row.id)
  })

  it('cannot take over an existing verified address by signing up with it again', async () => {
    for (const email of ['learner@gurow.test', 'LEARNER@gurow.test']) {
      const response = await new Browser().signUp(email)
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(response.status).toBeLessThan(500)
    }
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(accounts).where(sql`lower(${accounts.email}) = 'learner@gurow.test'`)
    expect(count).toBe(1)
    expect(await db.select().from(authCredentials)).toEqual([])
    expect(await db.select().from(enrollments)).toEqual([])
  })
})

describe('AC5: the active context is personal, with no permanent Coach/Learner Account type', () => {
  it('describes the Account by identity and verification state only', async () => {
    const browser = await signedUp('ada@gurow.test')
    const { body } = await browser.account()
    expect(Object.keys(body.account).sort()).toEqual(['email', 'emailVerified', 'id', 'name'])
    const columns = await db.execute<{ column_name: string }>(sql`select column_name from information_schema.columns where table_name = 'accounts' order by column_name`)
    expect([...columns].map((c) => c.column_name)).toEqual(['created_at', 'email', 'email_verified', 'id', 'image', 'name', 'updated_at'])
  })
})
