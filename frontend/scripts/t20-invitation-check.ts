#!/usr/bin/env bun
/**
 * T20 invitation check (#21): the production frontend build forwarding /api to the
 * production backend entry (Better Auth sessions) on a freshly migrated PostgreSQL
 * database, with email delivered through the Resend HTTP mailer to a local stand-in of
 * Resend's API (ADR 0023). Every link a browser opens is read from an email the
 * stand-in received. A Coach invites learners from a published Version; delivery
 * fails and is retried; a learner follows the emailed link through sign-up and email
 * verification to an Enrollment in that Version only; an unrelated Account and the
 * Coach are refused; closure blocks a pending Invitation while existing Enrollments
 * continue, and reopening admits it; repeated acceptance keeps an inactive Enrollment
 * inactive. A lost connection is reported with a retry. A second backend in the default
 * configuration, without an email provider, shows an Invitation as not emailed. The
 * stand-in proves the request contract, not delivery by Resend itself.
 *
 * Run from frontend: bun run scripts/t20-invitation-check.ts [--skip-build]
 */
import { SQL } from 'bun'
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import puppeteer, { type Browser, type HTTPRequest, type Page } from 'puppeteer-core'
import { startResendStandIn } from '../../backend/test/support/resend-stand-in'
import { resolveChromiumExecutable, waitForServerReady } from './benchmark/browser'

const FRONTEND = path.resolve(import.meta.dir, '..')
const BACKEND = path.resolve(FRONTEND, '../backend')
const PORT = Number(process.env.PORT ?? 3499)
const API_PORT = Number(process.env.API_PORT ?? 3500)
const ORIGIN = `http://127.0.0.1:${PORT}`
// A second served pair in the default configuration, without an email provider, on the same database.
const LOG_ONLY_PORT = Number(process.env.LOG_ONLY_PORT ?? 3501)
const LOG_ONLY_API_PORT = Number(process.env.LOG_ONLY_API_PORT ?? 3502)
const LOG_ONLY_ORIGIN = `http://127.0.0.1:${LOG_ONLY_PORT}`
const SECRET = 't20-browser-check-secret-not-for-production'
const DATABASE_URL = process.env.T20_DATABASE_URL ?? 'postgres://gurow:gurow@127.0.0.1:5433/gurow_t20_browser_test'
const PASSWORD = 'correct horse battery staple'

const steps: string[] = []
function pass(step: string, detail: string) {
  steps.push(step)
  console.log(`  ✓ ${step}: ${detail}`)
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const resend = startResendStandIn()

/** The latest emailed link to `to` with a subject starting `subject`, waiting for its delivery. */
async function emailedLink(to: string, subject: string, after = 0) {
  for (let i = 0; i < 100; i++) {
    const fresh = resend.sent.slice(after).filter((e) => e.to.some((a) => a.toLowerCase() === to.toLowerCase()) && e.subject.startsWith(subject))
    const link = fresh.length ? /https?:\/\/\S+/.exec(fresh.at(-1)!.text)?.[0] : undefined
    if (link) return link
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`no "${subject}" email reached ${to}`)
}

async function api(page: Page, apiPath: string, method = 'GET', body?: unknown): Promise<{ status: number; body: any }> {
  return page.evaluate(async (p: string, m: string, b: string | null) => {
    const response = await fetch(`/api${p}`, { method: m, headers: b === null ? undefined : { 'content-type': 'application/json' }, body: b ?? undefined })
    return { status: response.status, body: await response.json().catch(() => null) }
  }, apiPath, method, body === undefined ? null : JSON.stringify(body))
}
const text = (page: Page, selector: string) => page.$eval(selector, (el) => el.textContent?.trim() ?? '')
const data = (page: Page, selector: string): Promise<Record<string, string | undefined>> => page.$eval(selector, (el) => ({ ...(el as HTMLElement).dataset }))
/** Runs `act` and waits for the admission panel to show the backend's next answer. */
async function nextNotice(page: Page, act: () => Promise<void>) {
  const before = Number(await page.$eval('#admission-notice', (el) => (el as HTMLElement).dataset.answer).catch(() => '0'))
  await act()
  await page.waitForFunction((n: number) => Number((document.querySelector('#admission-notice') as HTMLElement | null)?.dataset.answer ?? 0) > n, {}, before)
  return { notice: await data(page, '#admission-notice'), text: await text(page, '#admission-notice') }
}
async function setValue(page: Page, selector: string, value: string) {
  await page.$eval(selector, (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
}
/** Signs up or in on the entry page; `returnsTo` is where it lands (the Personal Workspace without one). */
async function authenticate(page: Page, mode: 'sign-in' | 'sign-up', email: string, returnsTo = '#personal-workspace') {
  await page.waitForSelector('#sign-in-form')
  await setValue(page, '#email-input', email)
  await setValue(page, '#password-input', PASSWORD)
  await page.click(mode === 'sign-in' ? '#sign-in-btn' : '#sign-up-btn')
  await page.waitForSelector(returnsTo)
}
/** Opens the latest verification link emailed to `email`, as the Account's owner would. */
async function verifyFromEmail(page: Page, email: string, after = 0) {
  await page.goto(await emailedLink(email, 'Verify', after), { waitUntil: 'networkidle0' })
}
/** A Coach's published Version with one required Skill and one Required Task, authored and published through the API. */
async function publishVersion(page: Page, workspaceId: string, title: string) {
  const created = (await api(page, `/coach/workspaces/${workspaceId}/learning-paths`, 'POST', { title, goal: `${title} goal` })).body
  const skillId = crypto.randomUUID()
  const saved = await api(page, `/coach/learning-paths/${created.learningPath.id}/draft`, 'PUT', {
    expectedRevision: created.learningPath.revision, title, goal: `${title} goal`,
    editor: { format_version: 1, cards: [{ id: skillId, title: 'Vectors', position: { x: 80, y: 80 } }], connections: [] },
    application: { skills: [{ id: skillId, title: 'Vectors', outcome: 'Add vectors', optional: false, xpThreshold: 0, tasks: [{ id: crypto.randomUUID(), title: 'Drills', description: '', required: true, xpReward: 10 }] }] },
  })
  check(saved.status === 200, `saving ${title}: ${JSON.stringify(saved)}`)
  const published = await api(page, `/coach/learning-paths/${created.learningPath.id}/publication`, 'POST', { expectedRevision: saved.body.learningPath.revision })
  check(published.status === 200, `publishing ${title}: ${JSON.stringify(published)}`)
  return published.body.version.id as string
}
async function invitationRow(page: Page, email: string): Promise<Record<string, string | undefined> & { id: string }> {
  await page.waitForFunction((e: string) => document.querySelector(`#invitation-list [data-email="${e}"]`), {}, email)
  return page.$eval(`#invitation-list [data-email="${email}"]`, (el) => ({ ...(el as HTMLElement).dataset, id: el.id.replace('invitation-', '') }))
}
/** Sends an Invitation from the Coach's admission panel and waits for the backend's answer. */
async function inviteFromUi(page: Page, email: string) {
  const answer = await nextNotice(page, async () => {
    await setValue(page, '#invite-email-input', email)
    await page.click('#send-invitation-btn')
  })
  return { ...answer, row: await invitationRow(page, email) }
}
async function waitForInvitationPage(page: Page) {
  await page.waitForFunction(() => { const s = (document.querySelector('#invitation') as HTMLElement | null)?.dataset.state; return s && s !== 'loading' })
  return (await data(page, '#invitation')).state
}
async function acceptFromUi(page: Page): Promise<Record<string, string | undefined> & { text: string }> {
  const before = Number(await page.$eval('#invitation-result', (el) => (el as HTMLElement).dataset.attempt).catch(() => '0'))
  await page.click('#accept-invitation-btn')
  await page.waitForFunction((n: number) => Number((document.querySelector('#invitation-result') as HTMLElement | null)?.dataset.attempt ?? 0) > n, {}, before)
  return { ...(await data(page, '#invitation-result')), text: await text(page, '#invitation-result') }
}
/**
 * Makes matching requests from `page` fail as a lost connection would, until the
 * returned function is called.
 */
async function failRequests(page: Page, matches: (url: URL, method: string) => boolean) {
  await page.setRequestInterception(true)
  const handler = (request: HTTPRequest) => {
    if (request.isInterceptResolutionHandled()) return
    void (matches(new URL(request.url()), request.method()) ? request.abort('failed') : request.continue())
  }
  page.on('request', handler)
  return async () => {
    page.off('request', handler)
    await page.setRequestInterception(false)
  }
}
async function newPage(browser: Browser, errors: string[]) {
  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('dialog', (dialog) => { errors.push(`dialog ${dialog.type()}`); void dialog.accept() })
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 })
  return page
}

/** The production backend and frontend as served without RESEND_API_KEY, sharing the check's database and session secret. */
async function startLogOnlyServers() {
  let output = ''
  const api = spawn('bun', ['run', 'src/index.ts'], {
    cwd: BACKEND,
    env: { ...process.env, DATABASE_URL, PORT: String(LOG_ONLY_API_PORT), BETTER_AUTH_URL: LOG_ONLY_ORIGIN, BETTER_AUTH_SECRET: SECRET, NODE_ENV: 'test', RESEND_API_KEY: '', RESEND_API_URL: '', MAIL_FROM: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  api.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString() })
  api.stderr!.on('data', (chunk: Buffer) => { output += chunk.toString() })
  const web = spawn('node', ['.output/server/index.mjs'], { cwd: FRONTEND, env: { ...process.env, PORT: String(LOG_ONLY_PORT), GUROW_API_ORIGIN: `http://127.0.0.1:${LOG_ONLY_API_PORT}` }, stdio: 'ignore' })
  await waitForServerReady(LOG_ONLY_ORIGIN)
  for (let i = 0; i < 30; i++) {
    if ((await fetch(`${LOG_ONLY_ORIGIN}/api/account`).catch(() => null))?.status === 401) break
    await new Promise((r) => setTimeout(r, 300))
  }
  check(output.includes('RESEND_API_KEY is not set'), `the log-only backend did not start in log-only mode: ${output}`)
  return { output: () => output, stop: () => { web.kill(); api.kill() } }
}

async function main() {
  if (!process.argv.includes('--skip-build')) {
    console.log('Building current sources (Wasm + production bundle)...')
    execFileSync('bun', ['run', 'build'], { cwd: FRONTEND, stdio: 'inherit' })
  }
  execFileSync('bun', ['run', 'test/support/prepare-browser-database.ts'], { cwd: BACKEND, stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: DATABASE_URL } })

  const apiServer = spawn('bun', ['run', 'src/index.ts'], {
    cwd: BACKEND,
    env: {
      ...process.env, DATABASE_URL, PORT: String(API_PORT), BETTER_AUTH_URL: ORIGIN, BETTER_AUTH_SECRET: SECRET, NODE_ENV: 'test',
      RESEND_API_KEY: resend.apiKey, RESEND_API_URL: resend.url, MAIL_FROM: 'Gurow <invitations@gurow.test>',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  const web = spawn('node', ['.output/server/index.mjs'], { cwd: FRONTEND, env: { ...process.env, PORT: String(PORT), GUROW_API_ORIGIN: `http://127.0.0.1:${API_PORT}` }, stdio: 'ignore' })
  const browser = await puppeteer.launch({
    executablePath: resolveChromiumExecutable(), headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-webgpu', '--use-gl=angle', '--disable-dev-shm-usage'],
  })
  const sql = new SQL({ url: DATABASE_URL, max: 1 })
  const errors: string[] = []
  let current: Page | null = null
  try {
    await waitForServerReady(ORIGIN)
    for (let i = 0; i < 30; i++) {
      if ((await fetch(`${ORIGIN}/api/account`).catch(() => null))?.status === 401) break
      await new Promise((r) => setTimeout(r, 300))
    }

    // 1. The Coach verifies her address from the delivered email and publishes two Paths; Version 1 offers admission.
    const carla = current = await newPage(browser, errors)
    await carla.goto(ORIGIN, { waitUntil: 'networkidle0' })
    await authenticate(carla, 'sign-up', 'carla@gurow.test')
    await verifyFromEmail(carla, 'carla@gurow.test')
    await carla.waitForSelector('#email-verification-status[data-verified="true"]')
    const workspace = (await api(carla, '/coach/workspaces', 'POST', { name: 'Linear Algebra Studio' })).body.workspace
    const algebra = await publishVersion(carla, workspace.id, 'Linear Algebra')
    const calculus = await publishVersion(carla, workspace.id, 'Calculus')
    await carla.goto(`${ORIGIN}/coach/versions/${algebra}`, { waitUntil: 'networkidle0' })
    await carla.waitForSelector('#enrollment-admission[data-closed="false"]')
    check(await text(carla, '#admission-state') === 'Open to new Enrollments', `admission: ${await text(carla, '#admission-state')}`)
    check(await carla.$eval('#published-version', (el) => el.querySelectorAll('input, textarea, select').length) === 0, 'the published content gained inputs')
    pass('published Version offers admission', `Carla verified via Resend email; Version 1 of Linear Algebra (${algebra.slice(0, 8)}) is open to new Enrollments`)

    // 2. Invite Lena: the Invitation is stored and its link delivered through the Resend API.
    const lenaInvite = await inviteFromUi(carla, 'lena@gurow.test')
    check(lenaInvite.notice.kind === 'sent' && lenaInvite.row.delivery === 'sent' && lenaInvite.row.accepted === 'false', `invite: ${JSON.stringify(lenaInvite)}`)
    const lenaLink = await emailedLink('lena@gurow.test', 'You are invited')
    check(lenaLink === `${ORIGIN}/invitations/${lenaInvite.row.id}`, `emailed link ${lenaLink}`)
    const lenaEmail = resend.sent.filter((e) => e.subject.startsWith('You are invited')).at(-1)!
    check(lenaEmail.from === 'Gurow <invitations@gurow.test>' && lenaEmail.text.includes('Linear Algebra (Version 1) in Linear Algebra Studio') && lenaEmail.idempotencyKey === `enrollment-invitation/${lenaInvite.row.id}/1`, `email: ${JSON.stringify(lenaEmail)}`)
    pass('invitation delivered', `"${lenaInvite.text}" → Resend POST /emails to lena@gurow.test with ${lenaLink}`)

    // 3. A failed delivery keeps the Invitation; a failed retry says so; a later retry delivers it.
    resend.fail(500)
    const piaInvite = await inviteFromUi(carla, 'pia@gurow.test')
    check(piaInvite.notice.kind === 'undelivered' && piaInvite.row.delivery === 'failed' && piaInvite.text.includes('Resend refused the email (500)'), `failed invite: ${JSON.stringify(piaInvite)}`)
    const retry = async () => {
      const answer = await nextNotice(carla, () => carla.click(`#resend-invitation-${piaInvite.row.id}`))
      return { ...answer, row: await invitationRow(carla, 'pia@gurow.test') }
    }
    const failedRetry = await retry()
    check(failedRetry.notice.kind === 'undelivered' && failedRetry.row.delivery === 'failed', `failed retry: ${JSON.stringify(failedRetry)}`)
    resend.fail(null)
    const delivered = await retry()
    check(delivered.notice.kind === 'sent' && delivered.row.delivery === 'sent', `retry: ${JSON.stringify(delivered)}`)
    const piaLink = await emailedLink('pia@gurow.test', 'You are invited')
    check(piaLink.endsWith(piaInvite.row.id) && resend.sent.filter((e) => e.subject.startsWith('You are invited')).at(-1)!.idempotencyKey === `enrollment-invitation/${piaInvite.row.id}/3`, `retried email ${piaLink}`)
    const [{ count: piaRows }] = await sql`select count(*)::int as count from enrollment_invitations where lower(email) = 'pia@gurow.test'`
    check(piaRows === 1, `Pia has ${piaRows} Invitations`)
    pass('delivery retry', 'Resend 500 → "not delivered" kept; failed retry reported; third attempt delivered the same Invitation')

    // 4. Lena follows the emailed link: sign-up returns to it, an unverified address is refused, the verification email brings her back.
    const lena = current = await newPage(browser, errors)
    await lena.goto(lenaLink, { waitUntil: 'networkidle0' })
    check(await waitForInvitationPage(lena) === 'signed-out', 'a signed-out browser was not asked to sign in')
    await lena.click('#invitation-sign-in')
    await authenticate(lena, 'sign-up', 'Lena@Gurow.test', '#invitation[data-state="refused"]')
    check(new URL(lena.url()).pathname === `/invitations/${lenaInvite.row.id}`, `sign-up returned to ${lena.url()}`)
    check((await data(lena, '#invitation-refused')).refusal === 'email_not_verified' && !(await text(lena, '#invitation')).includes('Linear Algebra'), 'an unverified Account saw the offer or another refusal')
    const sentBefore = resend.sent.length
    await lena.click('#send-verification-btn')
    await lena.waitForSelector('#verification-notice')
    await verifyFromEmail(lena, 'lena@gurow.test', sentBefore)
    check(new URL(lena.url()).pathname === `/invitations/${lenaInvite.row.id}`, `verification returned to ${lena.url()}`)
    check(await waitForInvitationPage(lena) === 'offer', 'the verified addressee does not see the offer')
    check(await text(lena, '#offer-path-title') === 'Linear Algebra' && await text(lena, '#offer-version') === 'Version 1' && (await data(lena, '#invitation-offer')).versionId === algebra, 'offer details')
    pass('verified identity', 'emailed link → sign-up → back to the Invitation, refused email_not_verified → verification email → back, offer of Linear Algebra Version 1')

    // 4b. A lost connection is reported, never left loading, and retrying recovers; a failed acceptance accepts nothing.
    const invitationPath = `/api/invitations/${lenaInvite.row.id}`
    let restore = await failRequests(lena, (url) => url.pathname === invitationPath)
    await lena.reload({ waitUntil: 'networkidle0' })
    check(await waitForInvitationPage(lena) === 'failed' && (await text(lena, '#invitation-error')).includes('could not be reached'), `lost read: ${await text(lena, '#invitation')}`)
    await restore()
    await lena.click('#invitation-retry')
    check(await waitForInvitationPage(lena) === 'offer', 'retrying did not show the offer')
    restore = await failRequests(lena, (url, method) => url.pathname === `${invitationPath}/accept` && method === 'POST')
    const lost = await acceptFromUi(lena)
    check(lost.outcome === 'backend_unreachable' && lost.text.includes('nothing was accepted') && await lena.$('#accept-invitation-btn') !== null, `lost accept: ${JSON.stringify(lost)}`)
    await restore()
    const [{ count: beforeAccept }] = await sql`select count(*)::int as count from enrollments`
    check(beforeAccept === 0, `an Enrollment exists before acceptance reached the backend: ${beforeAccept}`)
    pass('lost connection', 'failed Invitation read → "could not be reached" + Try again → offer; failed acceptance → "nothing was accepted", accept still offered, no Enrollment')

    // 5. Acceptance enrolls Lena in that Version only; accepting again reuses the Enrollment.
    const enrolled = await acceptFromUi(lena)
    check(enrolled.outcome === 'enrolled' && enrolled.status === 'active' && enrolled.text.includes('You are enrolled in Linear Algebra, Version 1'), `accept: ${JSON.stringify(enrolled)}`)
    await lena.reload({ waitUntil: 'networkidle0' })
    await waitForInvitationPage(lena)
    check((await data(lena, '#existing-enrollment')).status === 'active', 'the existing Enrollment is not shown')
    const again = await acceptFromUi(lena)
    check(again.outcome === 'already-enrolled' && again.enrollmentId === enrolled.enrollmentId, `repeat: ${JSON.stringify(again)}`)
    const lenaEnrollments = await sql`select e.learning_path_version_id as version from enrollments e join accounts a on a.id = e.account_id where lower(a.email) = 'lena@gurow.test'`
    check(lenaEnrollments.length === 1 && lenaEnrollments[0].version === algebra && lenaEnrollments[0].version !== calculus, `Lena's Enrollments: ${JSON.stringify(lenaEnrollments)}`)
    check((await invitationRow(carla, 'lena@gurow.test')).accepted === 'false', 'the Coach view changed without a reload')
    await carla.reload({ waitUntil: 'networkidle0' })
    check((await invitationRow(carla, 'lena@gurow.test')).accepted === 'true', 'the Coach does not see the acceptance')
    pass('backend-confirmed acceptance', `Enrollment ${enrolled.enrollmentId!.slice(0, 8)} in Version 1 only (not Calculus); repeat acceptance → same Enrollment; Coach sees "accepted"`)

    // 6. An unrelated verified Account opening Lena's link is refused without seeing the offer.
    const mallory = current = await newPage(browser, errors)
    await mallory.goto(ORIGIN, { waitUntil: 'networkidle0' })
    await authenticate(mallory, 'sign-up', 'mallory@gurow.test')
    await verifyFromEmail(mallory, 'mallory@gurow.test')
    await mallory.goto(lenaLink, { waitUntil: 'networkidle0' })
    check(await waitForInvitationPage(mallory) === 'refused' && (await data(mallory, '#invitation-refused')).refusal === 'email_mismatch', 'Mallory was not refused email_mismatch')
    check(!(await text(mallory, '#invitation')).includes('Linear Algebra') && await mallory.$('#accept-invitation-btn') === null, 'Mallory sees the offer')
    const malloryAccept = await api(mallory, `/invitations/${lenaInvite.row.id}/accept`, 'POST')
    check(malloryAccept.status === 403 && malloryAccept.body.error === 'email_mismatch', `Mallory accept: ${JSON.stringify(malloryAccept)}`)
    const [{ count: malloryEnrollments }] = await sql`select count(*)::int as count from enrollments e join accounts a on a.id = e.account_id where a.email = 'mallory@gurow.test'`
    check(malloryEnrollments === 0, 'Mallory was enrolled')
    pass('unrelated Account rejected', 'Mallory (verified) on Lena\'s link: email_mismatch, no offer shown, API accept 403, no Enrollment')

    // 7. The Coach cannot enroll in her own Workspace, even with an Invitation to her verified address.
    await inviteFromUi(carla, 'carla@gurow.test')
    await carla.goto(await emailedLink('carla@gurow.test', 'You are invited'), { waitUntil: 'networkidle0' })
    check(await waitForInvitationPage(carla) === 'offer', 'the Coach does not see her own offer')
    const owner = await acceptFromUi(carla)
    check(owner.outcome === 'owner_cannot_enroll' && owner.text.includes('cannot enroll as a learner in their own Workspace'), `owner: ${JSON.stringify(owner)}`)
    pass('owner rejected', `Carla accepting her own Invitation: "${owner.text}"`)

    // 8. Closure: Pia's pending Invitation cannot enroll her; Lena continues; reopening admits Pia.
    await carla.goto(`${ORIGIN}/coach/versions/${algebra}`, { waitUntil: 'networkidle0' })
    await carla.waitForSelector('#enrollment-closure-btn')
    check(await text(carla, '#enrollment-closure-btn') === 'Close Version 1 to new Enrollments', 'closure button')
    await carla.click('#enrollment-closure-btn')
    await carla.waitForSelector('#enrollment-admission[data-closed="true"]')
    const pia = current = await newPage(browser, errors)
    await pia.goto(piaLink, { waitUntil: 'networkidle0' })
    await waitForInvitationPage(pia)
    await pia.click('#invitation-sign-in')
    await authenticate(pia, 'sign-up', 'pia@gurow.test', '#invitation[data-state="refused"]')
    await verifyFromEmail(pia, 'pia@gurow.test')
    check(await waitForInvitationPage(pia) === 'offer', 'Pia does not see her offer')
    const closed = await acceptFromUi(pia)
    check(closed.outcome === 'enrollment_closed' && closed.text.includes('closed to new Enrollments'), `closed: ${JSON.stringify(closed)}`)
    await lena.reload({ waitUntil: 'networkidle0' })
    await waitForInvitationPage(lena)
    const lenaWhileClosed = await acceptFromUi(lena)
    check(lenaWhileClosed.outcome === 'already-enrolled' && lenaWhileClosed.status === 'active', `Lena while closed: ${JSON.stringify(lenaWhileClosed)}`)
    const lenaTask = await api(lena, `/enrollments/${enrolled.enrollmentId}/learning-state`)
    check(lenaTask.status === 200, 'Lena lost access to her Enrollment while closed')
    await carla.click('#enrollment-closure-btn')
    await carla.waitForSelector('#enrollment-admission[data-closed="false"]')
    await pia.reload({ waitUntil: 'networkidle0' })
    await waitForInvitationPage(pia)
    const reopened = await acceptFromUi(pia)
    check(reopened.outcome === 'enrolled' && reopened.status === 'active', `after reopening: ${JSON.stringify(reopened)}`)
    pass('closed admission', `closed: Pia "${closed.text.slice(0, 60)}…", Lena still active; reopened: Pia enrolled`)

    // 9. A further Invitation never reactivates an inactive Enrollment.
    const deactivated = await api(lena, `/enrollments/${enrolled.enrollmentId}/deactivate`, 'POST', {})
    check(deactivated.status === 200 && deactivated.body.enrollment.status === 'inactive', `deactivation: ${JSON.stringify(deactivated)}`)
    await carla.reload({ waitUntil: 'networkidle0' })
    await carla.waitForSelector('#invite-email-input')
    const sentBeforeSecond = resend.sent.length
    await setValue(carla, '#invite-email-input', 'lena@gurow.test')
    await carla.click('#send-invitation-btn')
    const secondLink = await emailedLink('lena@gurow.test', 'You are invited', sentBeforeSecond)
    check(secondLink !== lenaLink, 'the second Invitation reused the first link')
    await lena.goto(secondLink, { waitUntil: 'networkidle0' })
    check(await waitForInvitationPage(lena) === 'offer' && (await data(lena, '#existing-enrollment')).status === 'inactive', 'the inactive Enrollment is not shown')
    const inactive = await acceptFromUi(lena)
    check(inactive.outcome === 'already-enrolled' && inactive.status === 'inactive' && inactive.enrollmentId === enrolled.enrollmentId && await lena.$('#enrollment-inactive') !== null, `inactive: ${JSON.stringify(inactive)}`)
    const [{ status }] = await sql`select status from enrollments where id = ${enrolled.enrollmentId}`
    check(status === 'inactive', `stored status ${status}`)
    pass('inactive stays inactive', `second emailed Invitation → same Enrollment ${enrolled.enrollmentId!.slice(0, 8)}, still inactive; only the Coach can reactivate`)

    // 10. The default configuration, without an email provider, never claims an email was sent.
    const logOnly = await startLogOnlyServers()
    try {
      const sentBeforeLogOnly = resend.sent.length
      await carla.goto(`${LOG_ONLY_ORIGIN}/coach/versions/${algebra}`, { waitUntil: 'networkidle0' })
      await carla.waitForSelector('#invite-email-input')
      const logged = await inviteFromUi(carla, 'logan@gurow.test')
      check(logged.notice.kind === 'undelivered' && logged.text.includes('no email was sent') && logged.text.includes('no email provider configured') && !logged.text.includes('emailed'), `log-only invite: ${JSON.stringify(logged)}`)
      check(logged.row.delivery === 'logged' && (await text(carla, `#invitation-${logged.row.id}`)).includes('email not sent (no email provider configured)'), `log-only row: ${JSON.stringify(logged.row)}`)
      const [stored] = await sql`select delivery_status, delivered_at from enrollment_invitations where id = ${logged.row.id}`
      check(stored.delivery_status === 'logged' && stored.delivered_at === null, `stored: ${JSON.stringify(stored)}`)
      check(resend.sent.length === sentBeforeLogOnly, 'the log-only server reached the Resend stand-in')
      const deadline = Date.now() + 5000
      while (!logOnly.output().includes(`[gurow] enrollment invitation for logan@gurow.test: ${LOG_ONLY_ORIGIN}/invitations/${logged.row.id}`) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      check(logOnly.output().includes(`invitations/${logged.row.id}`), 'the log-only server did not log the link')
      pass('no provider configured', `"${logged.text}"; stored 'logged', nothing reached Resend, link only in the server log`)
    } finally {
      logOnly.stop()
    }

    check(errors.length === 0, `page errors: ${errors.join('; ')}`)
    console.log(`\nT20 invitation check passed (${steps.length} steps; ${resend.sent.length} emails through the Resend stand-in).`)
  } catch (error) {
    const shot = path.resolve(FRONTEND, '../.harness/t20-failure.png')
    await current?.screenshot({ path: shot }).then(() => console.error(`screenshot: ${shot}`)).catch(() => {})
    if (errors.length > 0) console.error(`page errors:\n  ${errors.join('\n  ')}`)
    throw error
  } finally {
    await sql.close()
    await browser.close()
    web.kill()
    apiServer.kill()
    resend.stop()
  }
}

main().catch((error) => {
  console.error(`\nT20 invitation check FAILED after ${steps.length} steps: ${error instanceof Error ? `${error.message}\n${error.stack}` : error}`)
  process.exit(1)
})
