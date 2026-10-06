#!/usr/bin/env bun
/**
 * T26 participation check (#27): the production frontend build forwarding /api to the
 * production backend entry (Better Auth sessions) on a freshly migrated PostgreSQL
 * database, with email through the Resend HTTP mailer to a local stand-in. Real Accounts:
 * Carla publishes Linear Algebra and invites Lena and Pia; Otto coaches another Workspace.
 * Lena sends work and keeps a private draft, then stops participating from her Enrollment
 * page without a reason. While inactive she starts and sends nothing, her draft stays
 * hers alone and her history stays readable; Carla still approves the work Lena sent, and
 * XP and Mastery follow without reactivating. Lena, Pia and Otto cannot reactivate, and
 * neither a replayed invitation nor an Access Override resumes the Enrollment. Carla
 * reactivates it with a reason (its lost answer reconciled with the records): the same
 * Enrollment, Version and progress, with Access under the current rules, and Lena resumes
 * learning. Carla then deactivates it herself with a reason, still decides the work sent
 * before, and reload keeps every record.
 *
 * Run from frontend: bun run scripts/t26-participation-check.ts [--skip-build]
 */
import { SQL } from 'bun'
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import puppeteer, { type Browser, type BrowserContext, type Page } from 'puppeteer-core'
import { startResendStandIn } from '../../backend/test/support/resend-stand-in'
import { resolveChromiumExecutable, waitForServerReady } from './benchmark/browser'

const FRONTEND = path.resolve(import.meta.dir, '..')
const BACKEND = path.resolve(FRONTEND, '../backend')
const PORT = Number(process.env.PORT ?? 3529)
const API_PORT = Number(process.env.API_PORT ?? 3530)
const ORIGIN = `http://127.0.0.1:${PORT}`
const SECRET = 't26-browser-check-secret-not-for-production'
const DATABASE_URL = process.env.T26_DATABASE_URL ?? 'postgres://gurow:gurow@127.0.0.1:5433/gurow_t26_browser_test'
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
 * A two-Skill Path published through the Coach's API: Vectors (Required Tasks of 20 and
 * 5 XP: drills and an extension) before Matrices, which requires Mastery of Vectors and
 * 25 XP and has a 15-XP Required Task.
 */
async function publishPath(page: Page, workspaceId: string, title: string) {
  const created = await ok(page, `/coach/workspaces/${workspaceId}/learning-paths`, 'POST', { title, goal: `${title} with confidence` })
  const ids = { vectors: crypto.randomUUID(), matrices: crypto.randomUUID(), drills: crypto.randomUUID(), extension: crypto.randomUUID(), matrixDrills: crypto.randomUUID() }
  const saved = await ok(page, `/coach/learning-paths/${created.learningPath.id}/draft`, 'PUT', {
    expectedRevision: created.learningPath.revision, title, goal: `${title} with confidence`,
    editor: { format_version: 1, cards: [{ id: ids.vectors, title: 'Vectors', position: { x: 80, y: 120 } }, { id: ids.matrices, title: 'Matrices', position: { x: 420, y: 160 } }], connections: [{ from_id: ids.vectors, to_id: ids.matrices }] },
    application: { skills: [
      { id: ids.vectors, title: 'Vectors', outcome: 'Work with Vectors', optional: false, xpThreshold: 0, tasks: [
        { id: ids.drills, title: 'Vector drills', description: 'Exercises 1–10', required: true, xpReward: 20 },
        { id: ids.extension, title: 'Vector extension', description: 'Exercise 11', required: true, xpReward: 5 },
      ] },
      { id: ids.matrices, title: 'Matrices', outcome: 'Work with Matrices', optional: false, xpThreshold: 25, tasks: [
        { id: ids.matrixDrills, title: 'Matrix drills', description: 'Exercises 12–20', required: true, xpReward: 15 },
      ] },
    ] },
  })
  const published = await ok(page, `/coach/learning-paths/${created.learningPath.id}/publication`, 'POST', { expectedRevision: saved.learningPath.revision })
  return { versionId: published.version.id as string, ...ids }
}
/** Invites `email` to the Version and follows the emailed link as `page`'s Account; returns the link and the result. */
async function inviteAndAccept(coach: Page, learner: Page, versionId: string, email: string) {
  const before = resend.sent.length
  const invited = await ok(coach, `/coach/learning-path-versions/${versionId}/invitations`, 'POST', { email })
  check(invited.delivered === true, `invitation to ${email} not delivered`)
  const link = await emailedLink(email, 'You are invited', before)
  return { link, ...await accept(learner, link) }
}
async function accept(learner: Page, link: string) {
  await learner.goto(link, { waitUntil: 'networkidle0' })
  await learner.waitForSelector('#accept-invitation-btn')
  await learner.click('#accept-invitation-btn')
  await learner.waitForSelector('#invitation-result[data-outcome]')
  const result = await data(learner, '#invitation-result')
  return { enrollmentId: result.enrollmentId!, outcome: result.outcome!, status: result.status! }
}
/** The learner sends a Task's work from her sidebar: the draft text replaced, then Send. */
async function sendFromUi(page: Page, taskId: string, input: string) {
  await draftReady(page, taskId)
  await typeInto(page, `#task-work-text-${taskId}`, input, true)
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
const PARTICIPATION = '#enrollment-participation'
async function waitParticipation(page: Page, kind: string, extra = '') {
  await page.waitForSelector(`${PARTICIPATION}[data-status="${kind}"]${extra}`).catch(async () => {
    throw new Error(`participation did not reach ${kind}${extra} (${JSON.stringify(await data(page, PARTICIPATION))}: ${await text(page, PARTICIPATION)})`)
  })
}
/** The lifecycle records as listed on the page, opening the list first. */
async function lifecycleLines(page: Page) {
  if (await page.$('#lifecycle-history') === null) await page.click('#participation-history-toggle')
  await page.waitForSelector('#lifecycle-history')
  return page.$$eval('#lifecycle-history li', (els) => els.map((el) => ({ action: (el as HTMLElement).dataset.action, text: el.textContent?.trim() ?? '' })))
}
const lockReasons = (page: Page) => page.$$eval('#lock-reasons li', (els) => els.map((el) => el.textContent?.trim() ?? ''))
const textareaValue = (page: Page, taskId: string) => page.$eval(`#task-work-text-${taskId}`, (el) => ({ value: (el as HTMLTextAreaElement).value, disabled: (el as HTMLTextAreaElement).disabled }))

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
    const la = await publishPath(carla, workspace.id, 'Linear Algebra')
    const { page: lena } = await newContext(browser, errors)
    await act(lena)
    const lenaId = await signUpVerified(lena, 'lena@gurow.test')
    const lenaInvitation = await inviteAndAccept(carla, lena, la.versionId, 'lena@gurow.test')
    const enrollment = lenaInvitation.enrollmentId
    const { page: pia } = await newContext(browser, errors)
    await signUpVerified(pia, 'pia@gurow.test')
    const piaEnrollment = (await inviteAndAccept(carla, pia, la.versionId, 'pia@gurow.test')).enrollmentId
    const { page: otto } = await newContext(browser, errors)
    await signUpVerified(otto, 'otto@gurow.test')
    await ok(otto, '/coach/workspaces', 'POST', { name: 'Statistics Studio' })

    const taskRoute = (task: string) => `/enrollments/${enrollment}/tasks/${task}`
    const lifecycleRoute = (action: 'deactivate' | 'reactivate', target = enrollment) => `/enrollments/${target}/${action}`
    const storedLifecycle = async () => [...await sql`select enrollment_id, learning_path_version_id, actor_account_id, learner_account_id, action, reason from enrollment_lifecycle_records order by sequence`]
      .map((row: any) => ({ enrollment: row.enrollment_id, version: row.learning_path_version_id, actor: row.actor_account_id, learner: row.learner_account_id, action: row.action, reason: row.reason }))
    const storedEnrollment = async (id = enrollment) => [...await sql`select id, status, learning_path_version_id, account_id from enrollments where id = ${id}`][0] as { id: string; status: string; learning_path_version_id: string; account_id: string }
    const progressRows = async () => [...await sql`select (select count(*)::int from xp_events) as xp, (select count(*)::int from mastery_events) as mastery`][0] as { xp: number; mastery: number }
    const progress = async (page: Page) => ({
      status: (await data(page, '#enrollment-status')).status,
      xp: (await data(page, '#enrollment-xp')).xp,
      vectors: await data(page, `#skill-status-${la.vectors}`).then((d) => [d.access, d.mastery]),
      matrices: await data(page, `#skill-status-${la.matrices}`).then((d) => [d.access, d.mastery]),
    })
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
    const INACTIVE_REASON = 'This Enrollment is inactive: no Skill can be worked on until the Coach reactivates it'
    const enrolledBefore = await storedEnrollment()

    // Lifecycle changes can be held, or committed with their answer dropped, on any page.
    const faults = { hold: null as null | (() => void), holding: false, commitThenDrop: 0 }
    const intercept = async (page: Page) => {
      await page.setRequestInterception(true)
      page.on('request', (request) => void (async () => {
        const isLifecycle = request.method() === 'POST' && /\/enrollments\/[^/]+\/(de|re)activate$/.test(new URL(request.url()).pathname)
        if (isLifecycle && faults.holding) {
          await new Promise<void>((release) => { faults.hold = release })
          return request.continue()
        }
        if (isLifecycle && faults.commitThenDrop > 0) {
          faults.commitThenDrop--
          const cookie = (await page.cookies()).map((c) => `${c.name}=${c.value}`).join('; ')
          const committed = await fetch(request.url(), { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: request.postData() })
          check(committed.status === 200, `the forwarded lifecycle change answered ${committed.status}`)
          return request.abort('connectionreset')
        }
        return request.continue()
      })())
    }
    await intercept(carla)
    await intercept(lena)

    // 1. Lena works while active: she sends Vector drills and keeps a private draft; the extension is untouched.
    await act(lena)
    await openEnrollment(lena, enrollment)
    await keyboardSelect(lena, 0, la.vectors)
    const sent = await sendFromUi(lena, la.drills, 'Vector drills 1–10, with working.')
    check(sent === 1, `Lena's drills are Revision ${sent}`)
    await typeInto(lena, `#task-work-text-${la.drills}`, 'Private notes for the drills', true)
    await lena.click(`#task-work-save-${la.drills}`)
    await lena.waitForSelector(`${work(la.drills)}[data-unsaved="false"]`)
    await draftReady(lena, la.extension)
    check((await data(lena, work(la.extension))).startBlocked === 'false' && !(await textareaValue(lena, la.extension)).disabled, 'the untouched extension cannot be started while active')
    check((await text(lena, '#participation-open')) === 'Stop participating…' && (await data(lena, PARTICIPATION)).action === 'deactivate', `Lena's participation control: ${await text(lena, PARTICIPATION)}`)
    pass('active work', 'Lena sends Vector drills Revision 1 from the UI and saves a private draft "Private notes for the drills"; the untouched Vector extension is editable; her page offers "Stop participating…"')

    // 2. Lena stops participating without a reason; nothing is shown as done before the backend confirms it.
    await lena.click('#participation-open')
    await lena.waitForFunction(() => document.activeElement?.id === 'participation-reason')
    const learnerOutlook = await text(lena, '#participation-outlook')
    check(learnerOutlook.includes('You stop participating: no new Task can be started and no work sent') && learnerOutlook.includes('your unsent drafts stay private to you')
      && learnerOutlook.includes('Your Coach can still decide the 1 revision you sent awaiting Review') && learnerOutlook.includes('Only your Coach can reactivate this Enrollment; accepting an invitation again does not.'), `Lena's outlook: ${learnerOutlook}`)
    check((await data(lena, PARTICIPATION)).canRecord === 'true' && await lena.$('#participation-hint') === null && (await text(lena, PARTICIPATION)).includes('Reason (optional; none is needed'), 'Lena\'s deactivation asks for a reason')
    faults.holding = true
    await lena.click('#participation-confirm')
    await waitParticipation(lena, 'recording')
    for (let i = 0; i < 50 && !faults.hold; i++) await new Promise((r) => setTimeout(r, 20))
    check(faults.hold, 'the deactivation request was not held')
    await new Promise((r) => setTimeout(r, 400))
    check((await text(lena, '#participation-status')) === 'Deactivating the Enrollment…' && (await data(lena, '#enrollment-status')).status === 'active', `shown before confirmation: ${await text(lena, PARTICIPATION)}`)
    check((await storedEnrollment()).status === 'active' && (await storedLifecycle()).length === 0, 'the held deactivation reached the backend')
    faults.holding = false
    faults.hold!()
    await waitParticipation(lena, 'recorded', '[data-refresh="read"]')
    const recordedText = await text(lena, '#participation-status')
    const deactivatedAt = await lena.evaluate((at: string) => new Date(at).toLocaleString(), (await ok(lena, `/enrollments/${enrollment}/learning-state`)).learningState.lifecycleHistory[0].occurredAt)
    check(recordedText.includes('Recorded by Gurow: Enrollment deactivated by you (lena)') && recordedText.includes(deactivatedAt) && recordedText.includes('No reason given') && recordedText.includes('Status and Access are shown as Gurow derived them after this change.'), `Lena's recorded deactivation: ${recordedText}`)
    check(same(await storedLifecycle(), [{ enrollment, version: la.versionId, actor: lenaId, learner: lenaId, action: 'deactivate', reason: null }]) && (await storedEnrollment()).status === 'inactive', `stored deactivation: ${JSON.stringify(await storedLifecycle())}`)
    check((await data(lena, '#enrollment-status')).status === 'inactive' && (await text(lena, '#participation-inactive')).includes('until your Coach reactivates this Enrollment')
      && await lena.$('#participation-open') === null && (await data(lena, PARTICIPATION)).action === '', `Lena after deactivating: ${await text(lena, PARTICIPATION)}`)
    const again = await api(lena, lifecycleRoute('deactivate'), 'POST', {})
    check(again.status === 409 && again.body?.error === 'enrollment_already_inactive' && (await storedLifecycle()).length === 1, `repeated deactivation answered ${again.status}`)
    pass('learner deactivation', `no reason needed (Confirm enabled with an empty optional reason); held POST shows only "Deactivating the Enrollment…" while active; confirmed "Enrollment deactivated by you (lena) · ${deactivatedAt} · No reason given…"; stored with Lena as Actor and no reason; no reactivation offered to Lena; repeat 409 enrollment_already_inactive`)

    // 3. Inactive: no new Task start or send, history and progress kept, and the draft stays Lena's alone.
    await keyboardSelect(lena, 0, la.vectors)
    await draftReady(lena, la.drills)
    await draftReady(lena, la.extension)
    check((await text(lena, '#skill-access-state')) === 'Locked' && same(await lockReasons(lena), [INACTIVE_REASON]), `Lena's inactive Vectors: ${await text(lena, '#skill-access')}`)
    check((await data(lena, work(la.drills))).canSend === 'false' && (await text(lena, `#task-work-blocked-${la.drills}`)).startsWith('This Enrollment is inactive'), 'Lena can send while inactive')
    const draft = await textareaValue(lena, la.drills)
    check(draft.value === 'Private notes for the drills' && !draft.disabled, `Lena's draft while inactive: ${JSON.stringify(draft)}`)
    await typeInto(lena, `#task-work-text-${la.drills}`, ' (kept)')
    await lena.click(`#task-work-save-${la.drills}`)
    await waitStatus(lena, la.drills, 'saved')
    const extension = await textareaValue(lena, la.extension)
    check((await data(lena, work(la.extension))).startBlocked === 'true' && extension.disabled && (await text(lena, `#task-work-start-blocked-${la.extension}`)).includes('a new Task cannot be started'), `the extension while inactive: ${JSON.stringify(extension)}`)
    const kept = await history(lena, la.drills, 1)
    check(kept[0].status === 'pending' && kept[0].text.includes('Vector drills 1–10, with working.'), `Lena's sent work while inactive: ${JSON.stringify(kept)}`)
    const start = await api(lena, `${taskRoute(la.extension)}/start`, 'POST')
    const newDraft = await api(lena, `${taskRoute(la.extension)}/draft`, 'PUT', { text: 'Starting while inactive', urls: [] })
    const send = await api(lena, `${taskRoute(la.drills)}/submission/revisions`, 'POST', { text: 'Sent while inactive', urls: [] })
    check([start, newDraft, send].every((r) => r.status === 403 && r.body?.error === 'enrollment_inactive'), `inactive start/new draft/send answered ${start.status}/${newDraft.status}/${send.status}`)
    check(same(await progress(lena), { status: 'inactive', xp: '0', vectors: ['locked', 'not-mastered'], matrices: ['locked', 'not-mastered'] }), `Lena's progress while inactive: ${JSON.stringify(await progress(lena))}`)
    await act(carla)
    const coachDraft = await api(carla, `${taskRoute(la.drills)}/draft`)
    check(coachDraft.status === 403 && coachDraft.body?.error === 'draft_private', `Carla's draft read answered ${coachDraft.status}`)
    await openEnrollment(carla, enrollment)
    await keyboardSelect(carla, 0, la.vectors)
    await history(carla, la.drills, 1)
    check(!(await carla.content()).includes('Private notes') && await carla.$('[data-task-work]') === null, 'Carla\'s page shows Lena\'s draft')
    pass('inactive', 'Vectors Locked with only the inactivity reason; Send disabled; the existing draft stays editable and saves; the untouched extension is not startable (textarea disabled, "a new Task cannot be started"); API start / new draft / send 403 enrollment_inactive; Revision 1 still pending, 0 XP; Carla 403 draft_private and her page holds no draft text')

    // 4. Carla still decides the work sent while active; XP and Mastery follow without reactivating.
    check((await text(carla, '#participation-inactive')).includes('lena cannot start Tasks or send work. You can still review work sent while it was active; only you can reactivate it.')
      && (await text(carla, '#awaiting-review-inactive')).includes('does not reactivate the Enrollment'), `Carla's inactive page: ${await text(carla, PARTICIPATION)}`)
    await carla.waitForSelector(`#awaiting-review-${la.drills}[data-revision-number="1"]`)
    await carla.click(`#awaiting-review-${la.drills}`)
    await carla.waitForSelector(`#task-review-${la.drills}[data-target-revision="1"]`)
    await carla.click(`#task-review-approve-${la.drills}`)
    await carla.waitForSelector(`#task-review-${la.drills}[data-status="recorded"][data-refresh="read"]`)
    check(same(await progress(carla), { status: 'inactive', xp: '20', vectors: ['locked', 'not-mastered'], matrices: ['locked', 'not-mastered'] }), `Carla after the Review: ${JSON.stringify(await progress(carla))}`)
    check(same(await progressRows(), { xp: 1, mastery: 0 }) && (await storedEnrollment()).status === 'inactive' && (await storedLifecycle()).length === 1, 'the Review changed participation or recorded no progress')
    await act(lena)
    await revisit(lena)
    check(same(await progress(lena), { status: 'inactive', xp: '20', vectors: ['locked', 'not-mastered'], matrices: ['locked', 'not-mastered'] }) && (await history(lena, la.drills, 1))[0].status === 'approval', `Lena after the Review: ${JSON.stringify(await progress(lena))}`)
    pass('pending Review', 'Carla reads "You can still review work sent while it was active" and the queue note, approves Revision 1 from the queue: 20 XP for both (Vectors still needs its extension) while the Enrollment stays inactive; one XP event, no lifecycle record')

    // 5. Nobody but Carla resumes it: not Lena, a peer, another Workspace's Coach, a replayed invitation or an override.
    const lenaReactivate = await api(lena, lifecycleRoute('reactivate'), 'POST', { reason: 'I want to continue' })
    check(lenaReactivate.status === 403 && lenaReactivate.body?.error === 'coach_only' && await lena.$('#participation-open') === null, `Lena's reactivation answered ${lenaReactivate.status}`)
    await act(pia)
    const piaReactivate = await api(pia, lifecycleRoute('reactivate'), 'POST', { reason: 'Peer favour' })
    const piaDeactivate = await api(pia, lifecycleRoute('deactivate'), 'POST', {})
    await act(otto)
    const ottoReactivate = await api(otto, lifecycleRoute('reactivate'), 'POST', { reason: 'Another Workspace' })
    await otto.goto(`${ORIGIN}/enrollments/${enrollment}`, { waitUntil: 'networkidle0' })
    await otto.waitForSelector('#enrollment-unavailable')
    check(piaReactivate.status === 404 && piaDeactivate.status === 404 && ottoReactivate.status === 404 && await otto.$(PARTICIPATION) === null, `Pia/Otto answered ${piaReactivate.status}/${piaDeactivate.status}/${ottoReactivate.status}`)
    await act(lena)
    const replayed = await accept(lena, lenaInvitation.link)
    check(replayed.outcome === 'already-enrolled' && replayed.status === 'inactive' && replayed.enrollmentId === enrollment && await lena.$('#enrollment-inactive') !== null, `replayed invitation: ${JSON.stringify(replayed)}`)
    await act(carla)
    const reinvited = await inviteAndAccept(carla, lena, la.versionId, 'lena@gurow.test')
    check(reinvited.outcome === 'already-enrolled' && reinvited.status === 'inactive' && reinvited.enrollmentId === enrollment, `new invitation: ${JSON.stringify(reinvited)}`)
    await ok(carla, `/enrollments/${enrollment}/skills/${la.matrices}/access-overrides`, 'POST', { reason: 'Lena studied matrices at her previous school.' })
    check((await storedEnrollment()).status === 'inactive' && (await storedLifecycle()).length === 1, 'an invitation or an override resumed the Enrollment')
    await act(lena)
    await openEnrollment(lena, enrollment)
    await keyboardSelect(lena, 1, la.matrices)
    check((await data(lena, '#enrollment-status')).status === 'inactive' && (await text(lena, '#skill-access-state')) === 'Locked' && (await text(lena, '#skill-override-inactive')).startsWith('It does not reactivate this Enrollment'), `Lena's Matrices with the override while inactive: ${await text(lena, '#skill-access')}`)
    pass('unauthorized reactivation', 'Lena 403 coach_only and no reactivation control; Pia 404 (reactivate and deactivate); Otto 404 and the Enrollment unavailable to him; the replayed and a new invitation answer "already enrolled", inactive, same Enrollment; an Access Override granted meanwhile leaves it inactive ("It does not reactivate this Enrollment")')

    // 6. Carla reactivates it with a reason; the answer is lost but the records show it.
    await act(carla)
    await revisit(carla)
    check((await text(carla, '#participation-open')) === 'Reactivate Enrollment…', `Carla's control: ${await text(carla, PARTICIPATION)}`)
    await carla.click('#participation-open')
    await carla.waitForFunction(() => document.activeElement?.id === 'participation-reason')
    const resumeOutlook = await text(carla, '#participation-outlook')
    check(resumeOutlook.includes('The same Enrollment resumes on Version 1, with its 20 XP, 0 Skills mastered and all its work and history.')
      && resumeOutlook.includes('Access is evaluated under the current rules:') && resumeOutlook.includes('“Vectors”: open') && resumeOutlook.includes('“Matrices”: open by Coach override'), `reactivation outlook: ${resumeOutlook}`)
    check((await data(carla, PARTICIPATION)).canRecord === 'false' && (await text(carla, '#participation-hint')).includes('needs to give a reason'), 'a reactivation without a reason is offered')
    await carla.keyboard.type('   ')
    check((await data(carla, PARTICIPATION)).canRecord === 'false', 'a reactivation with a blank reason is offered')
    await typeInto(carla, '#participation-reason', 'Lena is back after her exams.', true)
    await carla.waitForSelector(`${PARTICIPATION}[data-can-record="true"]`)
    faults.commitThenDrop = 1
    await carla.click('#participation-confirm')
    await waitParticipation(carla, 'recorded', '[data-refresh="read"]')
    const lostText = await text(carla, '#participation-status')
    check(faults.commitThenDrop === 0 && (await data(carla, PARTICIPATION)).confirmedBy === 'history' && lostText.includes('the answer was lost, but the participation records show it')
      && lostText.includes('Enrollment reactivated by you (carla)') && lostText.includes('Reason: Lena is back after her exams.'), `lost reactivation answer: ${lostText}`)
    const resumed = await storedEnrollment()
    check(same(resumed, { ...enrolledBefore, status: 'active' }) && enrolledBefore.status === 'active', `the resumed Enrollment: ${JSON.stringify(resumed)} (before ${JSON.stringify(enrolledBefore)})`)
    check(same((await storedLifecycle()).slice(1), [{ enrollment, version: la.versionId, actor: carlaId, learner: lenaId, action: 'reactivate', reason: 'Lena is back after her exams.' }]), `stored reactivation: ${JSON.stringify(await storedLifecycle())}`)
    check(same(await progress(carla), { status: 'active', xp: '20', vectors: ['open', 'not-mastered'], matrices: ['override', 'not-mastered'] }) && (await data(carla, '#enrolled-version-badge')).versionNumber === '1', `Carla after reactivating: ${JSON.stringify(await progress(carla))}`)
    check((await text(carla, '#participation-open')) === 'Deactivate Enrollment…', 'Carla is not offered deactivation once active')
    pass('reactivation', 'reason required (empty and blank refused in the UI); the outlook names Version 1, 20 XP, 0 Skills mastered and the current Access ("Vectors": open, "Matrices": open by Coach override); the answer was dropped after commit and the records confirmed it once; same Enrollment row (id, Version, learner) now active; the record names Carla and her reason')

    // 7. Lena resumes with her history: the records, the approved work, her draft, and new work sent.
    await act(lena)
    await revisit(lena)
    let lines = await lifecycleLines(lena)
    check(same(lines.map((l) => l.action), ['deactivate', 'reactivate']) && lines[0].text.includes('Enrollment deactivated by you (lena)') && lines[0].text.includes('No reason given')
      && lines[1].text.includes('Enrollment reactivated by carla, Coach of this Workspace') && lines[1].text.includes('Reason: Lena is back after her exams.'), `Lena's lifecycle records: ${JSON.stringify(lines)}`)
    check(same(await progress(lena), { status: 'active', xp: '20', vectors: ['open', 'not-mastered'], matrices: ['override', 'not-mastered'] }) && await lena.$('#participation-inactive') === null, `Lena resumed: ${JSON.stringify(await progress(lena))}`)
    await keyboardSelect(lena, 0, la.vectors)
    check((await history(lena, la.drills, 1))[0].status === 'approval' && (await textareaValue(lena, la.drills)).value === 'Private notes for the drills (kept)', 'Lena\'s approved work or draft was lost')
    await lena.waitForSelector(`${work(la.extension)}[data-start-blocked="false"]`)
    check(await sendFromUi(lena, la.extension, 'Exercise 11, solved two ways.') === 1, 'Lena could not send the extension after reactivation')
    await keyboardSelect(lena, 1, la.matrices)
    check(await sendFromUi(lena, la.matrixDrills, 'Matrix drills 12–20.') === 1, 'Lena could not send Matrix drills under the override')
    pass('resumed learning', 'Lena reads both records (her own without a reason, Carla\'s with it), 20 XP, Vectors open, Matrices open by override, her approved Revision 1 and her kept draft; the extension is startable again and she sends it and Matrix drills from the UI')

    // 8. Carla deactivates it herself with a reason, and still decides the work sent before.
    await act(carla)
    await revisit(carla)
    await carla.click('#participation-open')
    await carla.waitForFunction(() => document.activeElement?.id === 'participation-reason')
    const coachOutlook = await text(carla, '#participation-outlook')
    check(coachOutlook.includes('The learner can no longer start Tasks or send work in this Enrollment.') && coachOutlook.includes('You can still decide the 2 revisions awaiting your Review')
      && coachOutlook.includes('invitations and Access Overrides do not'), `Carla's deactivation outlook: ${coachOutlook}`)
    check((await data(carla, PARTICIPATION)).canRecord === 'false' && (await text(carla, '#participation-hint')).includes('needs to give a reason'), 'a Coach deactivation without a reason is offered')
    await carla.keyboard.type('Paused while Lena repeats the prerequisites.')
    await carla.waitForSelector(`${PARTICIPATION}[data-can-record="true"]`)
    await carla.click('#participation-confirm')
    await waitParticipation(carla, 'recorded', '[data-refresh="read"][data-confirmed-by="answer"]')
    check((await text(carla, '#participation-status')).includes('Enrollment deactivated by you (carla)') && (await text(carla, '#participation-status')).includes('Reason: Paused while Lena repeats the prerequisites.'), `Carla's deactivation: ${await text(carla, '#participation-status')}`)
    check(same((await storedLifecycle()).slice(2), [{ enrollment, version: la.versionId, actor: carlaId, learner: lenaId, action: 'deactivate', reason: 'Paused while Lena repeats the prerequisites.' }]) && (await storedEnrollment()).status === 'inactive', `stored Coach deactivation: ${JSON.stringify(await storedLifecycle())}`)
    const blankCoach = await api(carla, lifecycleRoute('reactivate'), 'POST', { reason: '  ' })
    const noReasonCoach = await api(carla, lifecycleRoute('reactivate'), 'POST', {})
    check(blankCoach.status === 422 && noReasonCoach.status === 422 && (await storedLifecycle()).length === 3, `reasonless Coach reactivation answered ${blankCoach.status}/${noReasonCoach.status}`)
    await carla.waitForSelector(`#awaiting-review-${la.extension}[data-revision-number="1"]`)
    await carla.click(`#awaiting-review-${la.extension}`)
    await carla.waitForSelector(`#task-review-${la.extension}[data-target-revision="1"]`)
    await carla.click(`#task-review-approve-${la.extension}`)
    await carla.waitForSelector(`#task-review-${la.extension}[data-status="recorded"][data-refresh="read"]`)
    check(same(await progress(carla), { status: 'inactive', xp: '25', vectors: ['locked', 'mastered'], matrices: ['locked', 'not-mastered'] }) && (await storedEnrollment()).status === 'inactive' && same(await progressRows(), { xp: 2, mastery: 1 }), `Carla after the later Review: ${JSON.stringify(await progress(carla))}`)
    await act(lena)
    await revisit(lena)
    lines = await lifecycleLines(lena)
    check(lines.length === 3 && lines[2].text.includes('Enrollment deactivated by carla, Coach of this Workspace') && lines[2].text.includes('Reason: Paused while Lena repeats the prerequisites.') && await lena.$('#participation-open') === null, `Lena after Carla's deactivation: ${JSON.stringify(lines)}`)
    const lockedSend = await api(lena, `${taskRoute(la.matrixDrills)}/submission/revisions`, 'POST', { text: 'Sent while inactive', urls: [] })
    check(lockedSend.status === 403 && lockedSend.body?.error === 'enrollment_inactive' && same(await progress(lena), { status: 'inactive', xp: '25', vectors: ['locked', 'mastered'], matrices: ['locked', 'not-mastered'] }), `Lena while Carla's deactivation holds: ${lockedSend.status} ${JSON.stringify(await progress(lena))}`)
    pass('coach deactivation', 'the outlook says the 2 awaiting revisions stay decidable and only Carla resumes it; reason required in the UI and by the API (blank/absent 422); recorded with Carla and her reason; Carla approves the extension while inactive: 25 XP and Vectors mastered (one more XP and one Mastery event), still inactive; Lena reads all three records, cannot reactivate or send (403 enrollment_inactive)')

    // 9. Reload keeps every record, the history and the progress, for both.
    for (const page of [carla, lena]) {
      await act(page)
      await openEnrollment(page, enrollment)
      lines = await lifecycleLines(page)
      check(same(lines.map((l) => l.action), ['deactivate', 'reactivate', 'deactivate']), `lifecycle records after reload: ${JSON.stringify(lines)}`)
      check(same(await progress(page), { status: 'inactive', xp: '25', vectors: ['locked', 'mastered'], matrices: ['locked', 'not-mastered'] }), `progress after reload: ${JSON.stringify(await progress(page))}`)
      await keyboardSelect(page, 1, la.matrices)
      check((await history(page, la.matrixDrills, 1))[0].status === 'pending', 'Matrix drills Revision 1 is not awaiting Review after reload')
    }
    check((await storedEnrollment(piaEnrollment)).status === 'active', 'Pia\'s Enrollment changed')
    pass('reload', 'after reload Carla and Lena read deactivate, reactivate, deactivate, 25 XP, Vectors mastered, and Matrix drills Revision 1 awaiting Review; Pia\'s Enrollment stays active')

    // 10. A long participation history on a short window leaves the learning history and the form reachable.
    await act(carla)
    const longReason = (n: number) => `Pause ${n}: ${'the learner asked to stop for a while because of exams, travel and work commitments. '.repeat(5)}`.slice(0, 480)
    for (let n = 1; n <= 10; n++) {
      await ok(carla, lifecycleRoute('reactivate'), 'POST', { reason: longReason(n) })
      await ok(carla, lifecycleRoute('deactivate'), 'POST', { reason: longReason(n) })
    }
    /** Whether the element is on screen and is what a click at its centre reaches. */
    const reachable = (page: Page, selector: string) => page.$eval(selector, (el) => {
      el.scrollIntoView({ block: 'nearest' })
      const box = el.getBoundingClientRect()
      const x = box.left + Math.min(box.width / 2, 20)
      const y = box.top + Math.min(box.height / 2, 8)
      const hit = document.elementFromPoint(x, y)
      return box.height > 0 && box.top >= 0 && box.bottom <= window.innerHeight + 1 && hit !== null && (el === hit || el.contains(hit))
    })
    for (const page of [lena, carla]) {
      await act(page)
      await page.setViewport({ width: 1400, height: 560, deviceScaleFactor: 1 })
      await openEnrollment(page, enrollment)
      lines = await lifecycleLines(page)
      check(lines.length === 23, `records on the short window: ${lines.length}`)
      if (page === carla) {
        await carla.click('#participation-open')
        await carla.waitForSelector('#participation-confirm')
      }
      const block = await page.$eval(PARTICIPATION, (el) => ({ height: el.getBoundingClientRect().height, viewport: window.innerHeight }))
      check(block.height <= block.viewport * 0.4 + 1, `participation takes ${block.height}px of a ${block.viewport}px window`)
      check(await reachable(page, '#lifecycle-history li:last-child'), 'the latest participation record cannot be reached')
      if (page === carla) check(await reachable(carla, '#participation-confirm') && await reachable(carla, '#participation-reason'), 'the reactivation form cannot be reached')
      await keyboardSelect(page, 1, la.matrices)
      await history(page, la.matrixDrills, 1)
      check(await reachable(page, `#task-history-${la.matrixDrills} li[id^="revision-"]`) && await reachable(page, '#skill-mastery'), 'the learning history cannot be reached beside a long participation history')
      await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 })
    }
    pass('long history', 'with 23 records of up to 480 characters on a 560px-high window, the participation block (records open, and Carla\'s reactivation form open) stays within 40% of the window; its latest record, the reason field and Confirm, the Matrix drills revision and the Mastery section can each be scrolled to and reached')

    check(errors.length === 0, `page errors: ${errors.join('; ')}`)
    console.log(`\nT26 participation check passed (${steps.length} steps).`)
  } catch (error) {
    const shot = path.resolve(FRONTEND, '../.harness/t26-failure.png')
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
  console.error(`\nT26 participation check FAILED after ${steps.length} steps: ${error instanceof Error ? `${error.message}\n${error.stack}` : error}`)
  process.exit(1)
})
