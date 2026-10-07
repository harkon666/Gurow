#!/usr/bin/env bun
/**
 * T25 Access Override check (#26): the production frontend build forwarding /api to the
 * production backend entry (Better Auth sessions) on a freshly migrated PostgreSQL
 * database, with email through the Resend HTTP mailer to a local stand-in. Real Accounts:
 * Carla publishes Linear Algebra and invites Lena and Pia; Otto, Coach of another
 * Workspace, invites Lena to his own Path. Carla grants Lena an Access Override for the
 * locked Matrices from the Enrollment page, with a reason, and reads the recorded action,
 * Actor, target and time; Lena then sends work for it, while Pia's Enrollment and Lena's
 * other Enrollment stay unchanged and no XP or Mastery is recorded. An inactive
 * Enrollment cannot start or send work despite the override, which the UI never offers
 * as reactivation. Carla revokes it with a reason: ordinary Access returns, Lena's
 * work, draft and history stay, and the work sent under the override is still approved
 * from the Review. Learners, peers and the other Workspace's Coach change nothing; a
 * grant made elsewhere while the page still offers one is refused, a lost answer is
 * reconciled, and reload keeps it all.
 *
 * Run from frontend: bun run scripts/t25-access-override-check.ts [--skip-build]
 */
import { SQL } from 'bun'
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import puppeteer, { type Browser, type BrowserContext, type Page } from 'puppeteer-core'
import { startResendStandIn } from '../../backend/test/support/resend-stand-in'
import { resolveChromiumExecutable, waitForServerReady } from './benchmark/browser'
import { openCoachReview, openSkillList, readSkillStatus } from './editor-navigation'

const FRONTEND = path.resolve(import.meta.dir, '..')
const BACKEND = path.resolve(FRONTEND, '../backend')
const PORT = Number(process.env.PORT ?? 3527)
const API_PORT = Number(process.env.API_PORT ?? 3528)
const ORIGIN = `http://127.0.0.1:${PORT}`
const SECRET = 't25-browser-check-secret-not-for-production'
const DATABASE_URL = process.env.T25_DATABASE_URL ?? 'postgres://gurow:gurow@127.0.0.1:5433/gurow_t25_browser_test'
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
async function ok(page: Page, apiPath: string, method = 'GET', body?: unknown, status = [200, 201]) {
  const result = await api(page, apiPath, method, body)
  check(status.includes(result.status), `${method} ${apiPath} answered ${result.status}: ${JSON.stringify(result.body)}`)
  return result.body
}
const text = (page: Page, selector: string) => page.$eval(selector, (el) => el.textContent?.trim() ?? '')
const data = (page: Page, selector: string): Promise<Record<string, string | undefined>> => page.$eval(selector, (el) => ({ ...(el as HTMLElement).dataset }))
async function setValue(page: Page, selector: string, v: string) {
  await page.$eval(selector, (el, next) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, next)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, v)
}
/** Types at the end of a field with real key presses, replacing what it held when `replace`. */
async function typeInto(page: Page, selector: string, input: string, replace = false) {
  await page.focus(selector)
  await page.keyboard.down('Control')
  await page.keyboard.press(replace ? 'a' : 'End')
  await page.keyboard.up('Control')
  if (replace) await page.keyboard.press('Backspace')
  await page.keyboard.type(input)
}
async function authenticate(page: Page, mode: 'sign-in' | 'sign-up', email: string) {
  await page.goto(ORIGIN, { waitUntil: 'networkidle0' })
  await page.waitForSelector('#sign-in-form')
  await setValue(page, '#email-input', email)
  await setValue(page, '#password-input', PASSWORD)
  await page.click(mode === 'sign-in' ? '#sign-in-btn' : '#sign-up-btn')
  await page.waitForSelector('#personal-workspace')
}
/** Signs up and verifies the address from the delivered email; returns the Account ID. */
async function signUpVerified(page: Page, email: string) {
  const before = resend.sent.length
  await authenticate(page, 'sign-up', email)
  await page.goto(await emailedLink(email, 'Verify', before), { waitUntil: 'networkidle0' })
  await page.waitForSelector('#email-verification-status[data-verified="true"]')
  return (await ok(page, '/account')).account.id as string
}

async function waitSelected(page: Page, id: string) {
  await page.waitForFunction((want: string) => document.querySelector('#selected-skill-id')?.textContent?.trim() === want, {}, id)
}
/** Opens an Enrollment page and waits for its renderer state and its learning records. */
async function openEnrollment(page: Page, enrollmentId: string, gpu: 'ready' | 'unsupported' = 'ready') {
  await page.goto(`${ORIGIN}/enrollments/${enrollmentId}`, { waitUntil: 'networkidle0' })
  await page.waitForSelector(`#enrolled-version[data-gpu-status="${gpu}"]`, { timeout: 20000 })
  await page.waitForFunction(() => (document.querySelector('#enrollment-xp') as HTMLElement | null)?.dataset.xp !== '')
}
/** Selects a Skill in the keyboard list: focus it, Home, ArrowDown n times, Enter. */
async function keyboardSelect(page: Page, index: number, id: string) {
  await openSkillList(page)
  await page.focus('#skill-prerequisite-list')
  await page.keyboard.press('Home')
  for (let i = 0; i < index; i++) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await waitSelected(page, id)
}
const work = (taskId: string) => `#task-work-${taskId}`
const draftReady = (page: Page, taskId: string) => page.waitForSelector(`${work(taskId)}[data-draft-state="ready"]`)
async function history(page: Page, taskId: string, revisions: number) {
  await page.waitForSelector(`#task-history-${taskId}[data-state="${revisions === 0 ? 'none' : 'ready'}"][data-revisions="${revisions}"]`)
  return page.$$eval(`#task-history-${taskId} li[id^="revision-"]`, (els) => els.map((el) => ({
    number: Number((el as HTMLElement).dataset.revisionNumber),
    status: (el as HTMLElement).dataset.status,
    text: el.textContent ?? '',
    note: el.querySelector('.revision-note')?.textContent?.trim() ?? '',
  })))
}
async function waitStatus(page: Page, taskId: string, kind: string) {
  await page.waitForSelector(`${work(taskId)}[data-status="${kind}"]`).catch(async () => {
    throw new Error(`task ${taskId} did not reach status ${kind} (status ${(await data(page, work(taskId))).status}: ${await text(page, work(taskId))})`)
  })
}
async function newContext(browser: Browser, errors: string[]) {
  const context = await browser.createBrowserContext()
  return { context, page: await newPage(context, errors) }
}
async function newPage(context: BrowserContext, errors: string[]) {
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('dialog', (dialog) => { errors.push(`dialog ${dialog.type()}`); void dialog.accept() })
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 })
  return page
}

/**
 * A two-Skill Path published through the Coach's API: `first` (a 20-XP Required Task)
 * before `second`, which requires Mastery of `first` and 20 XP and has a 15-XP Required Task.
 */
async function publishPath(page: Page, workspaceId: string, title: string, [first, second]: [string, string]) {
  const created = await ok(page, `/coach/workspaces/${workspaceId}/learning-paths`, 'POST', { title, goal: `${title} with confidence` })
  const ids = { first: crypto.randomUUID(), second: crypto.randomUUID(), firstTask: crypto.randomUUID(), secondTask: crypto.randomUUID() }
  const saved = await ok(page, `/coach/learning-paths/${created.learningPath.id}/draft`, 'PUT', {
    expectedRevision: created.learningPath.revision, title, goal: `${title} with confidence`,
    editor: { format_version: 1, cards: [{ id: ids.first, title: first, position: { x: 80, y: 120 } }, { id: ids.second, title: second, position: { x: 420, y: 160 } }], connections: [{ from_id: ids.first, to_id: ids.second }] },
    application: { skills: [
      { id: ids.first, title: first, outcome: `Work with ${first}`, optional: false, xpThreshold: 0, tasks: [
        { id: ids.firstTask, title: `${first} drills`, description: 'Exercises 1–10', required: true, xpReward: 20 },
      ] },
      { id: ids.second, title: second, outcome: `Work with ${second}`, optional: false, xpThreshold: 20, tasks: [
        { id: ids.secondTask, title: `${second} drills`, description: 'Exercises 11–20', required: true, xpReward: 15 },
      ] },
    ] },
  })
  const published = await ok(page, `/coach/learning-paths/${created.learningPath.id}/publication`, 'POST', { expectedRevision: saved.learningPath.revision })
  return { versionId: published.version.id as string, ...ids }
}
/** Invites `email` to the Version and follows the emailed link as `page`'s Account; returns the Enrollment ID. */
async function inviteAndAccept(coach: Page, learner: Page, versionId: string, email: string) {
  const before = resend.sent.length
  const invited = await ok(coach, `/coach/learning-path-versions/${versionId}/invitations`, 'POST', { email })
  check(invited.delivered === true, `invitation to ${email} not delivered`)
  await learner.goto(await emailedLink(email, 'You are invited', before), { waitUntil: 'networkidle0' })
  await learner.waitForSelector('#accept-invitation-btn')
  await learner.click('#accept-invitation-btn')
  await learner.waitForSelector('#invitation-result[data-outcome="enrolled"]')
  return (await data(learner, '#invitation-result')).enrollmentId!
}
/** The learner sends a Task's work from her sidebar: the draft text replaced or extended, then Send. */
async function sendFromUi(page: Page, taskId: string, input: string, replace = false) {
  await page.bringToFront()
  await draftReady(page, taskId)
  await typeInto(page, `#task-work-text-${taskId}`, input, replace)
  await page.$eval(`#task-work-send-${taskId}`, (el) => el.scrollIntoView({ block: 'center' }))
  await page.click(`#task-work-send-${taskId}`)
  await waitStatus(page, taskId, 'sent')
  return Number((await data(page, work(taskId))).sentRevision)
}
/** Reads the records again as returning to the page does, and waits until every read has answered. */
async function revisit(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForFunction(() => (document.querySelector('#enrollment-records') as HTMLElement | null)?.dataset.reading === 'false')
  await page.waitForNetworkIdle({ idleTime: 250 })
}
const control = (skillId: string) => `#override-control-${skillId}`
async function waitOverride(page: Page, skillId: string, kind: string, extra = '') {
  await page.waitForSelector(`${control(skillId)}[data-status="${kind}"]${extra}`).catch(async () => {
    const panel = await page.$(control(skillId))
    throw new Error(`override of ${skillId} did not reach ${kind}${extra} (${panel ? `${JSON.stringify(await data(page, control(skillId)))}: ${await text(page, control(skillId))}` : 'no override control'})`)
  })
}
/** The Override Records of the selected Skill, as listed in its Access section. */
const overrideLines = (page: Page) => page.$$eval('#skill-override-history li', (els) => els.map((el) => ({ action: (el as HTMLElement).dataset.action, text: el.textContent?.trim() ?? '' })))
const lockReasons = (page: Page) => page.$$eval('#lock-reasons li', (els) => els.map((el) => el.textContent?.trim() ?? ''))
/** Whether any control in the Access section offers to reactivate the Enrollment. */
const offersReactivation = (page: Page) => page.$$eval('#skill-access button', (els) => els.some((el) => /reactivat/i.test(el.textContent ?? '')))

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
  /** The person acting next: their page comes to the front, as a background tab's input can stall. */
  const act = async (page: Page) => { current = page; await page.bringToFront() }
  try {
    await waitForServerReady(ORIGIN)
    for (let i = 0; i < 30; i++) {
      if ((await fetch(`${ORIGIN}/api/account`).catch(() => null))?.status === 401) break
      await new Promise((r) => setTimeout(r, 300))
    }

    const { page: carla } = await newContext(browser, errors)
    await act(carla)
    const carlaId = await signUpVerified(carla, 'carla@gurow.test')
    const workspace = (await ok(carla, '/coach/workspaces', 'POST', { name: 'Linear Algebra Studio' })).workspace
    const la = await publishPath(carla, workspace.id, 'Linear Algebra', ['Vectors', 'Matrices'])
    const { page: lena } = await newContext(browser, errors)
    await act(lena)
    const lenaId = await signUpVerified(lena, 'lena@gurow.test')
    const enrollment = await inviteAndAccept(carla, lena, la.versionId, 'lena@gurow.test')
    const { page: pia } = await newContext(browser, errors)
    await signUpVerified(pia, 'pia@gurow.test')
    const piaEnrollment = await inviteAndAccept(carla, pia, la.versionId, 'pia@gurow.test')
    const { page: otto } = await newContext(browser, errors)
    await signUpVerified(otto, 'otto@gurow.test')
    const ottoWorkspace = (await ok(otto, '/coach/workspaces', 'POST', { name: 'Statistics Studio' })).workspace
    const stats = await publishPath(otto, ottoWorkspace.id, 'Statistics', ['Probability', 'Inference'])
    const lenaStats = await inviteAndAccept(otto, lena, stats.versionId, 'lena@gurow.test')

    const grantRoute = (skill: string, target = enrollment) => `/enrollments/${target}/skills/${skill}/access-overrides`
    const revokeRoute = (skill: string, grantId: string, target = enrollment) => `${grantRoute(skill, target)}/${grantId}/revoke`
    const taskRoute = (task: string, target = enrollment) => `/enrollments/${target}/tasks/${task}`
    const storedOverrides = async () => [...await sql`select id, enrollment_id, skill_id, coach_account_id, learner_account_id, action, grant_record_id, reason, occurred_at::text as occurred from override_records order by sequence`].map((row: any) => ({ id: row.id, enrollment: row.enrollment_id, skill: row.skill_id, coach: row.coach_account_id, learner: row.learner_account_id, action: row.action, grant: row.grant_record_id, reason: row.reason, occurred: row.occurred }))
    const progressRows = async () => [...await sql`select (select count(*)::int from xp_events) as xp, (select count(*)::int from mastery_events) as mastery`][0] as { xp: number; mastery: number }
    const enrollmentStatus = async (id: string) => [...await sql`select status from enrollments where id = ${id}`][0]?.status
    const state = async (page: Page, target = enrollment) => (await ok(page, `/enrollments/${target}/learning-state`)).learningState
    const skillOf = (s: any, id: string) => s.skills.find((x: any) => x.skillId === id)
    const progress = async (page: Page) => ({
      xp: (await data(page, '#enrollment-xp')).xp,
      vectors: await readSkillStatus(page, `#skill-status-${la.first}`).then((d) => [d.access, d.mastery]),
      matrices: await readSkillStatus(page, `#skill-status-${la.second}`).then((d) => [d.access, d.mastery]),
    })
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
    const lockedMatrices = ['Requires Mastery of “Vectors”', 'Needs 20 more XP: the threshold is 20 XP and this Enrollment has 0 XP']
    const piaBefore = await state(pia, piaEnrollment)
    const lenaStatsBefore = await state(lena, lenaStats)

    // Grants and revocations can be held, or committed with their answer dropped, on Carla's pages.
    const faults = { hold: null as null | (() => void), holding: false, commitThenDrop: 0 }
    const intercept = async (page: Page) => {
      await page.setRequestInterception(true)
      page.on('request', (request) => void (async () => {
        const isOverride = request.method() === 'POST' && /\/access-overrides(\/[^/]+\/revoke)?$/.test(new URL(request.url()).pathname)
        if (isOverride && faults.holding) {
          await new Promise<void>((release) => { faults.hold = release })
          return request.continue()
        }
        if (isOverride && faults.commitThenDrop > 0) {
          faults.commitThenDrop--
          const cookie = (await page.cookies()).map((c) => `${c.name}=${c.value}`).join('; ')
          const committed = await fetch(request.url(), { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: request.postData() })
          check(committed.status === 200 || committed.status === 201, `the forwarded override answered ${committed.status}`)
          return request.abort('connectionreset')
        }
        return request.continue()
      })())
    }
    await intercept(carla)

    // 1. Matrices is locked for Lena; only Carla, and only in her own Workspace, may change that.
    await act(lena)
    await openEnrollment(lena, enrollment)
    await keyboardSelect(lena, 1, la.second)
    check((await text(lena, '#skill-access-state')) === 'Locked' && same(await lockReasons(lena), lockedMatrices), `Lena's Matrices before: ${await text(lena, '#skill-access')}`)
    check(await lena.$('[data-access-override-control]') === null && await lena.$('[id^="override-open-"]') === null, 'Lena\'s page offers an Access Override')
    const selfGrant = await api(lena, grantRoute(la.second), 'POST', { reason: 'I am ready' })
    check(selfGrant.status === 403 && selfGrant.body?.error === 'coach_only', `Lena's own grant answered ${selfGrant.status}`)
    await act(pia)
    const peerGrant = await api(pia, grantRoute(la.second), 'POST', { reason: 'Peer favour' })
    check(peerGrant.status === 404, `Pia's grant for Lena answered ${peerGrant.status}`)
    await openEnrollment(pia, piaEnrollment)
    check(await pia.$('[data-access-override-control]') === null, 'Pia\'s own Enrollment offers an Access Override')
    await act(otto)
    const foreignGrant = await api(otto, grantRoute(la.second), 'POST', { reason: 'Another Workspace' })
    check(foreignGrant.status === 404, `Otto's grant in Carla's Workspace answered ${foreignGrant.status}`)
    await otto.goto(`${ORIGIN}/enrollments/${enrollment}`, { waitUntil: 'networkidle0' })
    await otto.waitForSelector('#enrollment-unavailable')
    check(await otto.$('[data-access-override-control]') === null, 'Otto sees an Access Override control for Carla\'s learner')
    await act(carla)
    const intoOtto = await api(carla, grantRoute(stats.second, lenaStats), 'POST', { reason: 'Not my Workspace' })
    const foreignSkill = await api(carla, grantRoute(stats.second), 'POST', { reason: 'Skill of another Path' })
    check(intoOtto.status === 404 && foreignSkill.status === 404, `Carla's grant into Otto's Enrollment / with Otto's Skill answered ${intoOtto.status}/${foreignSkill.status}`)
    const blank = await api(carla, grantRoute(la.second), 'POST', { reason: '   ' })
    check(blank.status === 422 && blank.body?.error === 'invalid_override_reason', `blank reason answered ${blank.status}`)
    check((await storedOverrides()).length === 0, 'a refused grant stored an Override Record')
    pass('authority', 'Matrices Locked for Lena (Requires Mastery of “Vectors”; Needs 20 more XP); no override control on Lena\'s or Pia\'s page; Lena 403 coach_only, Pia 404, Otto 404 and his view of the Enrollment unavailable; Carla into Otto\'s Enrollment / with Otto\'s Skill 404; blank reason 422; no record stored')

    // 2. Carla grants it from Lena's Enrollment page: a reason is required, nothing shows before the backend confirms.
    await openEnrollment(carla, enrollment)
    await keyboardSelect(carla, 1, la.second)
    await carla.waitForSelector(`${control(la.second)}[data-action="grant"]`)
    await carla.click(`#override-open-${la.second}`)
    await carla.waitForFunction((id: string) => document.activeElement?.id === id, {}, `override-reason-${la.second}`)
    const outlook = await text(carla, `#override-outlook-${la.second}`)
    check(outlook.includes('For this learner and Skill only, it waives: Requires Mastery of “Vectors”; Needs 20 more XP') && outlook.includes('XP and Mastery do not change, and no other Enrollment or learner is affected.'), `grant outlook: ${outlook}`)
    check((await data(carla, control(la.second))).canRecord === 'false' && (await text(carla, `#override-hint-${la.second}`)).includes('needs a brief reason'), 'a grant without a reason is offered')
    await carla.keyboard.type('   ')
    check((await data(carla, control(la.second))).canRecord === 'false', 'a grant with a blank reason is offered')
    await typeInto(carla, `#override-reason-${la.second}`, 'Lena passed linear algebra at her previous school.', true)
    await carla.waitForSelector(`${control(la.second)}[data-can-record="true"]`)
    faults.holding = true
    await carla.click(`#override-confirm-${la.second}`)
    await waitOverride(carla, la.second, 'recording')
    for (let i = 0; i < 50 && !faults.hold; i++) await new Promise((r) => setTimeout(r, 20))
    check(faults.hold, 'the grant request was not held')
    await new Promise((r) => setTimeout(r, 400))
    check((await text(carla, `#override-status-${la.second}`)) === 'Granting the Access Override…' && (await text(carla, '#skill-access-state')) === 'Locked' && await carla.$('#skill-override') === null && await carla.$('#skill-override-history') === null, `shown before confirmation: ${await text(carla, '#skill-access')}`)
    check((await storedOverrides()).length === 0, 'the held grant reached the backend')
    faults.holding = false
    faults.hold!()
    await waitOverride(carla, la.second, 'recorded', '[data-refresh="read"]')
    const [granted] = await storedOverrides()
    check(granted && same({ ...granted, id: '', occurred: '' }, { id: '', enrollment, skill: la.second, coach: carlaId, learner: lenaId, action: 'grant', grant: null, reason: 'Lena passed linear algebra at her previous school.', occurred: '' }), `stored grant: ${JSON.stringify(granted)}`)
    const grantedAt = await carla.evaluate((at: string) => new Date(at).toLocaleString(), (await state(carla)).overrideHistory[0].occurredAt)
    const recorded = await text(carla, `#override-status-${la.second}`)
    check(recorded.includes('Recorded by Gurow: Access Override granted by you (carla) · “Matrices” for lena, in this Enrollment only') && recorded.includes(grantedAt) && recorded.includes('Reason: Lena passed linear algebra at her previous school.') && recorded.includes('Access is shown as Gurow derived it after this change.'), `Carla's recorded grant: ${recorded}`)
    let records = await overrideLines(carla)
    check(records.length === 1 && records[0].action === 'grant' && records[0].text.includes('Access Override granted by you (carla) · “Matrices” for lena, in this Enrollment only') && records[0].text.includes(grantedAt), `Carla's Override Records: ${JSON.stringify(records)}`)
    check((await text(carla, '#skill-access-state')) === 'Open by Coach override' && same(await progress(carla), { xp: '0', vectors: ['open', 'not-mastered'], matrices: ['override', 'not-mastered'] }), `Carla after the grant: ${JSON.stringify(await progress(carla))}`)
    check(same(await progressRows(), { xp: 0, mastery: 0 }), 'the grant recorded XP or Mastery')
    pass('grant', `reason required (blank refused in the UI); held POST shows only "Granting the Access Override…" with Matrices Locked and no record; confirmed: "Access Override granted by you (carla) · “Matrices” for lena, in this Enrollment only · ${grantedAt} · Reason: …"; stored with Carla, Lena, Enrollment, Skill, time; Matrices open by override, 0 XP, nothing mastered, no XP/Mastery rows`)

    // 3. Lena uses it for Matrices only; nobody else's rules change.
    await act(lena)
    await revisit(lena)
    await keyboardSelect(lena, 1, la.second)
    const lenaAccess = await text(lena, '#skill-override')
    check((await text(lena, '#skill-access-state')) === 'Open by Coach override' && lenaAccess.includes('Your Coach waived this Skill\'s Prerequisites and XP Threshold for you, in this Enrollment only: Lena passed linear algebra at her previous school.') && lenaAccess.includes('Waived: Requires Mastery of “Vectors”') && lenaAccess.includes('Waived: Needs 20 more XP') && lenaAccess.includes('It changes no XP or Mastery.'), `Lena's Access: ${lenaAccess}`)
    records = await overrideLines(lena)
    check(records.length === 1 && records[0].text.includes('Access Override granted by carla, Coach of this Workspace · “Matrices” for you, in this Enrollment only') && records[0].text.includes('Reason: Lena passed'), `Lena's Override Records: ${JSON.stringify(records)}`)
    check(await lena.$('[data-access-override-control]') === null, 'Lena\'s page offers to change the override')
    const sent = await sendFromUi(lena, la.secondTask, 'Matrix drills 11–20, with working.')
    check(sent === 1, `Lena's Matrices work is Revision ${sent}`)
    await typeInto(lena, `#task-work-text-${la.secondTask}`, 'Notes for the next attempt', true)
    await lena.click(`#task-work-save-${la.secondTask}`)
    await lena.waitForSelector(`${work(la.secondTask)}[data-unsaved="false"]`)
    check(same(await progress(lena), { xp: '0', vectors: ['open', 'not-mastered'], matrices: ['override', 'not-mastered'] }) && same(await progressRows(), { xp: 0, mastery: 0 }), `Lena's progress under the override: ${JSON.stringify(await progress(lena))}`)
    const lenaVectorsStart = await api(lena, `${taskRoute(la.firstTask)}/start`, 'POST')
    check(lenaVectorsStart.status === 201 || lenaVectorsStart.status === 200, `Vectors start answered ${lenaVectorsStart.status}`)
    check(same(await state(pia, piaEnrollment), piaBefore) && skillOf(piaBefore, la.second).access === false, 'Pia\'s Enrollment changed with Lena\'s override')
    check(same(await state(lena, lenaStats), lenaStatsBefore) && skillOf(lenaStatsBefore, stats.second).access === false, 'Lena\'s other Enrollment changed with the override')
    const otherSend = await api(lena, `${taskRoute(stats.secondTask, lenaStats)}/submission/revisions`, 'POST', { text: 'Inference work', urls: [] })
    check(otherSend.status === 403 && otherSend.body?.error === 'skill_locked', `Lena's send in her other Enrollment answered ${otherSend.status}`)
    await act(pia)
    await revisit(pia)
    check((await readSkillStatus(pia, `#skill-status-${la.second}`)).access === 'locked', 'Pia\'s Matrices opened')
    pass('use', 'Lena reads "Open by Coach override", the reason, what it waives and "It changes no XP or Mastery", and the record "granted by carla, Coach of this Workspace · “Matrices” for you"; she sends Matrix drills Revision 1 from the UI and keeps a saved draft; 0 XP, nothing mastered; Pia\'s Enrollment and Lena\'s Statistics Enrollment unchanged (Inference still locked, send 403 skill_locked)')

    // 4. An inactive Enrollment cannot start or send work despite the override, and nothing offers it as reactivation.
    await act(lena)
    await ok(lena, `/enrollments/${enrollment}/deactivate`, 'POST', {})
    await openEnrollment(lena, enrollment)
    await keyboardSelect(lena, 1, la.second)
    await draftReady(lena, la.secondTask)
    check((await data(lena, '#enrollment-status')).status === 'inactive' && (await text(lena, '#skill-access-state')) === 'Locked' && same(await lockReasons(lena), ['This Enrollment is inactive: no Skill can be worked on until the Coach reactivates it']), `Lena's inactive Matrices: ${await text(lena, '#skill-access')}`)
    check((await text(lena, '#skill-override-inactive')).startsWith('It does not reactivate this Enrollment') && !(await offersReactivation(lena)), `Lena's override while inactive: ${await text(lena, '#skill-override')}`)
    check((await data(lena, work(la.secondTask))).canSend === 'false' && (await text(lena, `#task-work-blocked-${la.secondTask}`)).startsWith('This Enrollment is inactive'), 'Lena can send while inactive')
    const inactiveStart = await api(lena, `${taskRoute(la.secondTask)}/start`, 'POST')
    const inactiveSend = await api(lena, `${taskRoute(la.secondTask)}/submission/revisions`, 'POST', { text: 'Sent while inactive', urls: [] })
    check(inactiveStart.status === 403 && inactiveStart.body?.error === 'enrollment_inactive' && inactiveSend.status === 403 && inactiveSend.body?.error === 'enrollment_inactive', `inactive start/send answered ${inactiveStart.status}/${inactiveSend.status}`)
    await act(carla)
    await revisit(carla)
    check((await text(carla, '#skill-access-state')) === 'Locked' && (await text(carla, '#skill-override-inactive')).includes('override or not') && !(await offersReactivation(carla)), `Carla's inactive Matrices: ${await text(carla, '#skill-access')}`)
    check(await enrollmentStatus(enrollment) === 'inactive' && (await storedOverrides()).length === 1, 'the override changed the Enrollment status')
    await ok(carla, `/enrollments/${enrollment}/reactivate`, 'POST', { reason: 'Lena is back from holiday.' })
    await revisit(carla)
    check((await text(carla, '#skill-access-state')) === 'Open by Coach override', 'the override did not apply again after reactivation')
    pass('inactive', 'with the override in force and the Enrollment inactive, Matrices is Locked for Lena and Carla with only "This Enrollment is inactive…" as reason and "It does not reactivate this Enrollment…"; no Access control offers reactivation; Send disabled; start/send 403 enrollment_inactive; status stays inactive until the Coach\'s separate reactivation, after which the override applies again')

    // 5. Carla revokes it with a reason; the answer is lost but the records show it once.
    const grantId = granted.id
    await act(lena)
    const lenaRevoke = await api(lena, revokeRoute(la.second, grantId), 'POST', { reason: 'Keep it' })
    await act(otto)
    const ottoRevoke = await api(otto, revokeRoute(la.second, grantId), 'POST', { reason: 'Another Workspace' })
    check(lenaRevoke.status === 403 && ottoRevoke.status === 404 && (await storedOverrides()).length === 1, `Lena/Otto revocation answered ${lenaRevoke.status}/${ottoRevoke.status}`)
    await act(carla)
    await carla.waitForSelector(`${control(la.second)}[data-action="revoke"]`)
    await carla.click(`#override-open-${la.second}`)
    await carla.waitForFunction((id: string) => document.activeElement?.id === id, {}, `override-reason-${la.second}`)
    const revokeText = await text(carla, `#override-outlook-${la.second}`)
    check(revokeText.includes('Access returns to the ordinary rules, which lock “Matrices” now: Requires Mastery of “Vectors”; Needs 20 more XP') && revokeText.includes('Work already sent stays in the history and remains reviewable'), `revoke outlook: ${revokeText}`)
    check((await data(carla, control(la.second))).canRecord === 'false', 'a revocation without a reason is offered')
    faults.commitThenDrop = 1
    await carla.keyboard.type('Back to the ordinary route: Vectors first.')
    await carla.waitForSelector(`${control(la.second)}[data-can-record="true"]`)
    await carla.click(`#override-confirm-${la.second}`)
    await waitOverride(carla, la.second, 'recorded', '[data-refresh="read"]')
    const lost = await text(carla, `#override-status-${la.second}`)
    check(faults.commitThenDrop === 0 && (await data(carla, control(la.second))).confirmedBy === 'history' && lost.includes('the answer was lost, but the Override Records show it') && lost.includes('Access Override revoked by you (carla)'), `lost revocation answer: ${lost}`)
    const stored = await storedOverrides()
    check(stored.length === 2 && stored[1].action === 'revoke' && stored[1].grant === grantId && stored[1].coach === carlaId && stored[1].reason === 'Back to the ordinary route: Vectors first.', `stored revocation: ${JSON.stringify(stored)}`)
    check((await text(carla, '#skill-access-state')) === 'Locked' && same(await lockReasons(carla), lockedMatrices) && await carla.$('#skill-override') === null, `Carla's Matrices after the revocation: ${await text(carla, '#skill-access')}`)
    await carla.waitForSelector(`${control(la.second)}[data-action="grant"]`)
    pass('revoke', 'Lena 403, Otto 404; revoke outlook names the ordinary locks and that sent work stays reviewable; reason required; the answer was dropped after commit and the Override Records confirmed it ("the answer was lost…") with exactly one revoke record naming the grant; Matrices Locked with its ordinary reasons')

    // 6. Ordinary Access returns for Lena; her work, draft and history stay, and the work sent under the override is approved.
    await act(lena)
    await revisit(lena)
    await keyboardSelect(lena, 1, la.second)
    await draftReady(lena, la.secondTask)
    check((await text(lena, '#skill-access-state')) === 'Locked' && same(await lockReasons(lena), lockedMatrices) && await lena.$('#skill-override') === null, `Lena's Matrices after the revocation: ${await text(lena, '#skill-access')}`)
    records = await overrideLines(lena)
    check(same(records.map((r) => r.action), ['grant', 'revoke']) && records[1].text.includes('Access Override revoked by carla, Coach of this Workspace · “Matrices” for you') && records[1].text.includes('Reason: Back to the ordinary route: Vectors first.'), `Lena's Override Records: ${JSON.stringify(records)}`)
    const kept = await history(lena, la.secondTask, 1)
    check(kept[0].status === 'pending' && kept[0].text.includes('Matrix drills 11–20, with working.'), `Lena's sent work: ${JSON.stringify(kept)}`)
    check(await lena.$eval(`#task-work-text-${la.secondTask}`, (el) => (el as HTMLTextAreaElement).value) === 'Notes for the next attempt' && (await data(lena, work(la.secondTask))).canSend === 'false', 'Lena\'s draft was lost or she can still send')
    const lockedSend = await api(lena, `${taskRoute(la.secondTask)}/submission/revisions`, 'POST', { text: 'After revocation', urls: [] })
    check(lockedSend.status === 403 && lockedSend.body?.error === 'skill_locked', `send after revocation answered ${lockedSend.status}`)
    await act(carla)
    await openCoachReview(carla)
    await carla.waitForSelector(`#awaiting-review-${la.secondTask}[data-revision-number="1"]`)
    await carla.click(`#awaiting-review-${la.secondTask}`)
    await carla.waitForSelector(`#task-review-${la.secondTask}[data-target-revision="1"]`)
    await carla.click(`#task-review-approve-${la.secondTask}`)
    await carla.waitForSelector(`#task-review-${la.secondTask}[data-status="recorded"][data-refresh="read"]`)
    check(same(await progress(carla), { xp: '15', vectors: ['open', 'not-mastered'], matrices: ['locked', 'mastered'] }) && await carla.$('#skill-mastery-kept') !== null, `Carla after the later Review: ${JSON.stringify(await progress(carla))}`)
    check(same(await progressRows(), { xp: 1, mastery: 1 }), `XP/Mastery rows after the later Review: ${JSON.stringify(await progressRows())}`)
    await act(lena)
    await revisit(lena)
    check(same(await progress(lena), { xp: '15', vectors: ['open', 'not-mastered'], matrices: ['locked', 'mastered'] }), `Lena after the later Review: ${JSON.stringify(await progress(lena))}`)
    pass('eligible later Review', 'after the revocation Lena sees Matrices Locked with its ordinary reasons, both records, Revision 1 awaiting Review and her saved draft; sending is refused (403 skill_locked); Carla approves Revision 1 from the queue: 15 XP and Matrices mastered (still locked) for both, one XP and one Mastery event')

    // 7. A grant made elsewhere while this page still offers one is refused; everything survives reload; Otto's Workspace is untouched.
    await act(carla)
    await carla.click(`#override-open-${la.second}`)
    await typeInto(carla, `#override-reason-${la.second}`, 'Stale page reason')
    // Another tab or device grants meanwhile; this page is not refocused, so it still offers a grant.
    const elsewhere = await api(carla, grantRoute(la.second), 'POST', { reason: 'Exam retake allowed early.' })
    check(elsewhere.status === 201 && (await data(carla, control(la.second))).action === 'grant', `the grant elsewhere answered ${elsewhere.status}`)
    await carla.click(`#override-confirm-${la.second}`)
    await waitOverride(carla, la.second, 'refused', '[data-refresh="read"]')
    const refused = await text(carla, `#override-status-${la.second}`)
    check(refused.startsWith('Not recorded: an Access Override for this Skill is already in force (perhaps granted from another tab)') && refused.includes('Nothing changed'), `stale grant: ${refused}`)
    await carla.waitForSelector(`${control(la.second)}[data-action="revoke"][data-open="false"]`)
    check((await storedOverrides()).length === 3 && (await text(carla, '#skill-access-state')) === 'Open by Coach override', 'the refused grant was stored, or the grant made elsewhere is not shown')
    for (const page of [carla, lena]) {
      await act(page)
      await openEnrollment(page, enrollment)
      await keyboardSelect(page, 1, la.second)
      records = await overrideLines(page)
      check(same(records.map((r) => r.action), ['grant', 'revoke', 'grant']) && records[2].text.includes('Reason: Exam retake allowed early.'), `Override Records after reload: ${JSON.stringify(records)}`)
      check((await text(page, '#skill-access-state')) === 'Open by Coach override' && same(await progress(page), { xp: '15', vectors: ['open', 'not-mastered'], matrices: ['override', 'mastered'] }), `progress after reload: ${JSON.stringify(await progress(page))}`)
    }
    check(same(await state(lena, lenaStats), lenaStatsBefore) && same(await state(pia, piaEnrollment), piaBefore), 'another Enrollment changed')
    await act(otto)
    check((await state(otto, lenaStats)).overrideHistory.length === 0, 'Otto\'s Enrollment has Override Records')
    pass('reload', 'a grant made elsewhere while the page still offered one is refused ("already in force (perhaps granted from another tab)… Nothing changed") and its form closes once Revoke is due; after reload Carla and Lena read grant, revoke, grant with reasons, Matrices open by override and mastered, 15 XP; Pia\'s and Otto\'s Enrollments unchanged')

    check(errors.length === 0, `page errors: ${errors.join('; ')}`)
    console.log(`\nT25 Access Override check passed (${steps.length} steps).`)
  } catch (error) {
    const shot = path.resolve(FRONTEND, '../.harness/t25-failure.png')
    await (current as Page | null)?.screenshot({ path: shot }).then(() => console.error(`screenshot: ${shot}`)).catch(() => {})
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
  console.error(`\nT25 Access Override check FAILED after ${steps.length} steps: ${error instanceof Error ? `${error.message}\n${error.stack}` : error}`)
  process.exit(1)
})
