#!/usr/bin/env bun
/**
 * T15 sign-in integration check (#16): the production frontend build forwarding
 * /api to the production backend entry point (Better Auth sessions, ADR 0022) on
 * a separate, freshly migrated PostgreSQL database. One browser context signs up,
 * enters its Personal Workspace, reloads, verifies its email through the logged
 * link, signs out, switches Accounts and is refused the first Account's Workspace.
 *
 * Run from frontend: bun run scripts/t15-sign-in-check.ts [--skip-build]
 * Local evidence only: email delivery and a deployed origin are not exercised.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import puppeteer, { type Page } from 'puppeteer-core'
import { resolveChromiumExecutable, waitForServerReady } from './benchmark/browser'

const FRONTEND = path.resolve(import.meta.dir, '..')
const BACKEND = path.resolve(FRONTEND, '../backend')
const PORT = Number(process.env.PORT ?? 3481)
const API_PORT = Number(process.env.API_PORT ?? 3482)
const ORIGIN = `http://127.0.0.1:${PORT}`
const DATABASE_URL = process.env.T15_DATABASE_URL ?? 'postgres://gurow:gurow@127.0.0.1:5433/gurow_browser_test'
const PASSWORD = 'correct horse battery staple'

const steps: string[] = []
function pass(step: string, detail: string) {
  steps.push(step)
  console.log(`  ✓ ${step}: ${detail}`)
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Verification links the backend logged, by address (no email provider is integrated). */
const mail = new Map<string, string>()
function captureMail(server: ChildProcess) {
  let buffer = ''
  server.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      const match = /\[gurow\] email verification for (\S+): (\S+)/.exec(line)
      if (match) mail.set(match[1], match[2])
    }
  })
}
async function verificationLink(email: string) {
  for (let i = 0; i < 50 && !mail.has(email); i++) await new Promise((r) => setTimeout(r, 100))
  check(mail.has(email), `no verification link was logged for ${email}`)
  return mail.get(email)!
}

const text = (page: Page, selector: string) => page.$eval(selector, (el) => el.textContent?.trim() ?? '')
const workspaceIdFromUrl = (page: Page) => /\/workspaces\/([0-9a-f-]{36})$/.exec(new URL(page.url()).pathname)?.[1]

async function authenticate(page: Page, mode: 'sign-in' | 'sign-up', email: string, password = PASSWORD) {
  await page.waitForSelector('#sign-in-form')
  await page.$eval('#email-input', (el) => { (el as HTMLInputElement).value = '' })
  await page.type('#email-input', email)
  await page.$eval('#password-input', (el) => { (el as HTMLInputElement).value = '' })
  await page.type('#password-input', password)
  await page.click(mode === 'sign-in' ? '#sign-in-btn' : '#sign-up-btn')
}

/** Waits for the signed-in Personal Workspace page and reads what it shows. */
async function workspacePage(page: Page) {
  await page.waitForSelector('#personal-workspace')
  const id = workspaceIdFromUrl(page)
  const shown = await page.$eval('main', (el) => (el as HTMLElement).dataset.workspaceId)
  check(id && id === shown, `workspace URL ${page.url()} and rendered id ${shown} differ`)
  return {
    id,
    context: await text(page, '#active-context'),
    contextKind: await page.$eval('#active-context', (el) => (el as HTMLElement).dataset.context),
    email: await text(page, '#account-email'),
    verification: await text(page, '#email-verification-status'),
    // The context switch (T18) names the contexts one Account can act in; everything else
    // in the header names the active context and the Account, never an Account type.
    header: await page.$eval('header', (el) => {
      const copy = el.cloneNode(true) as HTMLElement
      copy.querySelector('#context-switch')?.remove()
      return copy.textContent?.trim() ?? ''
    }),
    contextSwitch: await page.$$eval('#context-switch a', (links) => links.map((a) => `${a.textContent}:${a.getAttribute('aria-current') ?? ''}`)),
    paths: await text(page, '#workspace-paths'),
  }
}

async function signOut(page: Page) {
  await page.click('#sign-out-btn')
  await page.waitForSelector('#sign-in-form')
}

async function main() {
  if (!process.argv.includes('--skip-build')) {
    console.log('Building current sources (Wasm + production bundle)...')
    execFileSync('bun', ['run', 'build'], { cwd: FRONTEND, stdio: 'inherit' })
  }
  execFileSync('bun', ['run', 'test/support/prepare-browser-database.ts'], { cwd: BACKEND, stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: DATABASE_URL } })

  // The production backend entry point: identity only from Better Auth sessions.
  // A developer's backend/.env may hold a real Resend key; this check reads the logged mail instead.
  const api = spawn('bun', ['run', 'src/index.ts'], {
    cwd: BACKEND,
    env: { ...process.env, DATABASE_URL, PORT: String(API_PORT), BETTER_AUTH_URL: ORIGIN, BETTER_AUTH_SECRET: 't15-browser-check-secret-not-for-production', NODE_ENV: 'test', RESEND_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  captureMail(api)
  const web = spawn('node', ['.output/server/index.mjs'], { cwd: FRONTEND, env: { ...process.env, PORT: String(PORT), GUROW_API_ORIGIN: `http://127.0.0.1:${API_PORT}` }, stdio: 'ignore' })
  const browser = await puppeteer.launch({ executablePath: resolveChromiumExecutable(), headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] })
  const pageErrors: string[] = []
  try {
    await waitForServerReady(ORIGIN)
    for (let i = 0; i < 30; i++) {
      if ((await fetch(`${ORIGIN}/api/account`).catch(() => null))?.status === 401) break
      await new Promise((r) => setTimeout(r, 300))
    }
    const context = await browser.createBrowserContext()
    const page = await context.newPage()
    page.setDefaultTimeout(10000)
    page.on('pageerror', (error) => pageErrors.push(String(error)))

    // 1. The product entry asks for sign-in; a wrong credential is refused.
    await page.goto(ORIGIN, { waitUntil: 'networkidle0' })
    await page.waitForSelector('#sign-in-form')
    await authenticate(page, 'sign-in', 'nobody@gurow.test')
    await page.waitForSelector('#auth-error')
    check(new URL(page.url()).pathname === '/', `a failed sign-in left the entry page: ${page.url()}`)
    pass('entry requires sign-in', `${await text(page, '#auth-error')}`)

    // 2. Sign-up signs in and enters the Account's Personal Workspace.
    await authenticate(page, 'sign-up', 'ada@gurow.test')
    const ada = await workspacePage(page)
    check(ada.context === 'Personal Workspace' && ada.contextKind === 'personal', `context shown as ${ada.context}/${ada.contextKind}`)
    check(ada.email === 'ada@gurow.test', `account shown as ${ada.email}`)
    check(ada.verification === 'Email not verified', `new Account shown as ${ada.verification}`)
    check(!/coach|learner/i.test(ada.header), `the header names an Account type: ${ada.header}`)
    check(JSON.stringify(ada.contextSwitch) === JSON.stringify(['Personal:page', 'Learning:', 'Coaching:']), `context switch: ${ada.contextSwitch}`)
    check(ada.paths.includes('No Learning Paths yet.'), `unexpected Workspace contents: ${ada.paths}`)
    pass('sign-up enters a Personal Workspace', `${ada.id}, context "${ada.context}", ${ada.email}, ${ada.verification}`)

    // 3. Reload and repeated entry keep the session and the same Workspace.
    await page.reload({ waitUntil: 'networkidle0' })
    check((await workspacePage(page)).id === ada.id, 'reload changed the Workspace')
    await page.goto(ORIGIN, { waitUntil: 'networkidle0' })
    check((await workspacePage(page)).id === ada.id, 'entering again opened another Workspace')
    pass('reload and re-entry', `same Workspace ${ada.id} after reload and a second entry`)

    // 4. Only the emailed link verifies the address; the client cannot claim it.
    const claim = await page.evaluate(async () => (await fetch('/api/auth/update-user', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ emailVerified: true }) })).status)
    await page.reload({ waitUntil: 'networkidle0' })
    check((await workspacePage(page)).verification === 'Email not verified', 'a client claim verified the address')
    await page.goto(await verificationLink('ada@gurow.test'), { waitUntil: 'networkidle0' })
    const verified = await workspacePage(page)
    check(verified.id === ada.id && verified.verification === 'Email verified', `after the link: ${verified.id} ${verified.verification}`)
    pass('verified-email state', `client claim answered ${claim} and changed nothing; the logged link verified ${verified.email}`)

    // 5. Signing out ends access, including to the Workspace URL.
    await signOut(page)
    await page.goto(`${ORIGIN}/workspaces/${ada.id}`, { waitUntil: 'networkidle0' })
    await page.waitForSelector('#sign-in-form')
    const anonymous = await page.evaluate(async (id) => (await fetch(`/api/personal/workspaces/${id}`, { headers: { 'x-gurow-fixture-identity': 'learner' } })).status, ada.id)
    check(anonymous === 401, `signed-out read with a fixture header answered ${anonymous}`)
    pass('sign-out', `Workspace URL returns to sign-in; API answers ${anonymous} even with the P2 fixture header`)

    // 6. Account switching in the same browser: the other Account cannot open Ada's Workspace.
    await authenticate(page, 'sign-up', 'grace@gurow.test')
    const grace = await workspacePage(page)
    check(grace.id !== ada.id && grace.email === 'grace@gurow.test', `switched Account opened ${grace.id} as ${grace.email}`)
    await page.goto(`${ORIGIN}/workspaces/${ada.id}`, { waitUntil: 'networkidle0' })
    await page.waitForSelector('#workspace-unavailable')
    const visible = await page.$eval('body', (el) => el.innerText)
    check(!visible.includes('ada@gurow.test'), 'the refused page shows the owner\'s email')
    check(await text(page, '#account-email') === 'grace@gurow.test', 'the refused page is not in Grace\'s context')
    const direct = await page.evaluate(async (id) => (await fetch(`/api/personal/workspaces/${id}`)).status, ada.id)
    check(direct === 404, `Grace's direct read of Ada's Workspace answered ${direct}`)
    await page.click('#open-own-workspace-btn')
    check((await workspacePage(page)).id === grace.id, 'the recovery link did not open Grace\'s own Workspace')
    pass('rejection of another Account', `Grace (${grace.id}) sees "Personal Workspace not available" for Ada's ${ada.id}; API ${direct}`)

    // 7. Switching back restores the owner's access and its Workspace.
    await signOut(page)
    await authenticate(page, 'sign-in', 'ada@gurow.test')
    const back = await workspacePage(page)
    check(back.id === ada.id && back.email === 'ada@gurow.test' && back.verification === 'Email verified', `switching back opened ${back.id} as ${back.email}`)
    pass('switch back', `Ada signs in again to ${back.id}, still verified`)

    // 8. Account switching in another tab of the same browser: the first tab, never
    // reloaded, must stop showing Ada's Workspace once the session belongs to Grace.
    const showsAda = (tab: Page) => tab.$eval('body', (el) => `${el.innerText.includes('ada@gurow.test')}; page reads "${el.innerText.slice(0, 160).replace(/\s+/g, ' ')}"`)
    // Ada's Workspace must leave the screen; the tab may show sign-in or Grace's own context.
    const hidesAda = (tab: Page, signedOutAllowed: boolean) => tab.waitForFunction((allowSignIn: boolean) =>
      !document.body.innerText.includes('ada@gurow.test') && document.querySelector('#personal-workspace') === null &&
      ((allowSignIn && document.querySelector('#sign-in-form') !== null) ||
        (document.querySelector('#workspace-unavailable') !== null && document.querySelector('#account-email')?.textContent === 'grace@gurow.test')),
    { timeout: 5000, polling: 100 }, signedOutAllowed) // a background tab runs no animation frames
    const signInAs = (tab: Page, email: string) => tab.evaluate(async (address) => {
      await fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      await fetch('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: address, password: 'correct horse battery staple' }) })
    }, email)
    const other = await context.newPage()
    other.setDefaultTimeout(10000)
    other.on('pageerror', (error) => pageErrors.push(String(error)))
    await other.goto(ORIGIN, { waitUntil: 'networkidle0' })
    check((await workspacePage(other)).id === ada.id, 'the second tab did not share Ada\'s session')
    await signOut(other)
    await authenticate(other, 'sign-in', 'grace@gurow.test')
    check((await workspacePage(other)).id === grace.id, 'the second tab did not switch to Grace')
    await hidesAda(page, true).catch(async () => {
      throw new Error(`the background tab still shows Ada's Workspace after a switch in another tab (shows Ada: ${await showsAda(page)})`)
    })
    const announcedEnd = await page.$('#sign-in-form') ? 'sign-in' : 'Grace\'s context'

    // A session changed outside this application's UI (no announcement) is caught when the tab is resumed.
    await page.bringToFront()
    await signInAs(page, 'ada@gurow.test')
    await page.goto(`${ORIGIN}/workspaces/${ada.id}`, { waitUntil: 'networkidle0' })
    check((await workspacePage(page)).id === ada.id, 'Ada could not reopen her Workspace')
    await other.bringToFront()
    await signInAs(other, 'grace@gurow.test')
    await page.bringToFront()
    await hidesAda(page, false).catch(async () => {
      throw new Error(`the resumed tab still shows Ada's Workspace after an unannounced switch (shows Ada: ${await showsAda(page)})`)
    })
    await other.close()
    pass('switch in another tab', `a background tab drops Ada's Workspace (now ${announcedEnd}) when another tab switches to Grace; a resumed tab shows Grace's refusal after a switch outside the UI`)

    check(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`)
    console.log(`\nT15 sign-in check passed (${steps.length} steps).`)
  } finally {
    await browser.close()
    web.kill()
    api.kill()
  }
}

main().catch((error) => {
  console.error(`\nT15 sign-in check FAILED after ${steps.length} steps: ${error instanceof Error ? error.stack : error}`)
  process.exit(1)
})
