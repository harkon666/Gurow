#!/usr/bin/env bun
/**
 * T23 Coach review check (#24): the production frontend build forwarding /api to the
 * production backend entry (Better Auth sessions) on a freshly migrated PostgreSQL
 * database, with email through the Resend HTTP mailer to a local stand-in. Real
 * Accounts take every step: Carla publishes a Version and invites Lena and Pia, who
 * verify their emailed addresses and accept. Lena sends work from her learning page;
 * Carla finds it from the Version's list of enrolled learners, reads the exact revision
 * and decides it in the UI: Changes Requested needs feedback, a revision replaced while
 * she was deciding cannot be decided, and an Approval shows its reward, Mastery and the
 * dependent Access only after the backend confirms it, never twice. Lena reads the
 * feedback, corrects, and sees the resulting progress; a newer revision is assessed on
 * its own while the earlier Approval keeps counting. After the Skill locks, Carla still
 * reviews the work sent before, from the keyboard on a page without WebGPU. Lena cannot
 * review her own work and Pia cannot reach it; Carla's pages never receive a draft.
 * Approval Revocation has no UI before T24, so revocations go through the API.
 *
 * Run from frontend: bun run scripts/t23-review-work-check.ts [--skip-build]
 */
import { SQL } from 'bun'
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import puppeteer, { type Browser, type BrowserContext, type Page } from 'puppeteer-core'
import { startResendStandIn } from '../../backend/test/support/resend-stand-in'
import { resolveChromiumExecutable, waitForServerReady } from './benchmark/browser'
import { closeEditorPanels, openCoachReview, openSkillList, readCardProgress, readSkillStatus, waitAwaitingReview, openTask } from './editor-navigation'

const FRONTEND = path.resolve(import.meta.dir, '..')
const BACKEND = path.resolve(FRONTEND, '../backend')
const PORT = Number(process.env.PORT ?? 3523)
const API_PORT = Number(process.env.API_PORT ?? 3524)
const ORIGIN = `http://127.0.0.1:${PORT}`
const SECRET = 't23-browser-check-secret-not-for-production'
const DATABASE_URL = process.env.T23_DATABASE_URL ?? 'postgres://gurow:gurow@127.0.0.1:5433/gurow_t23_browser_test'
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
/** Shows one Task's own controls when they are not on screen: a learner's board details or the Coach's Tasks view, one Task at a time. */
async function at(page: Page, taskId: string) {
  if (!await page.$(`#task-learning-${taskId}`)) await openTask(page, taskId)
  // A Task just opened reads its private draft first; its controls settle once that read answers.
  if (await page.$(`#task-work-${taskId}`)) await page.waitForSelector(`#task-work-${taskId}:not([data-draft-state="loading"])`)
}
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
const value = (page: Page, selector: string) => page.$eval(selector, (el) => (el as HTMLTextAreaElement | HTMLInputElement).value)
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

/** A visible canvas point inside the card, so input goes through the engine. */
async function cardPoint(page: Page, id: string) {
  await closeEditorPanels(page)
  const point = await page.$eval(`#card-label-${id}`, (el) => {
    const canvas = document.querySelector('#editor-canvas')!, r = el.getBoundingClientRect()
    for (let y = r.top + 8; y < r.bottom - 8; y += 8) for (let x = r.left + 8; x < r.right - 8; x += 8) {
      if (document.elementFromPoint(x, y) === canvas) return { x, y }
    }
    return null
  })
  check(point, `card ${id} is not visible on the canvas`)
  return point
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
/** Selects a Skill by clicking its card on the WebGPU canvas. */
async function canvasSelect(page: Page, id: string) {
  await closeEditorPanels(page)
  await page.waitForFunction(() => document.querySelectorAll('[id^="card-label-"]').length === 2)
  const point = await cardPoint(page, id)
  await page.mouse.click(point.x, point.y)
  await waitSelected(page, id)
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
async function draftReady(page: Page, taskId: string) {
  await at(page, taskId)
  await page.waitForSelector(`${work(taskId)}[data-draft-state="ready"]`)
}
async function history(page: Page, taskId: string, revisions: number) {
  await at(page, taskId)
  await page.waitForSelector(`#task-history-${taskId}[data-state="${revisions === 0 ? 'none' : 'ready'}"][data-revisions="${revisions}"]`)
  return page.$$eval(`#task-history-${taskId} li[id^="revision-"]`, (els) => els.map((el) => ({
    number: Number((el as HTMLElement).dataset.revisionNumber),
    status: (el as HTMLElement).dataset.status,
    text: el.textContent ?? '',
    note: el.querySelector('.revision-note')?.textContent?.trim() ?? '',
  })))
}
async function waitStatus(page: Page, taskId: string, kind: string) {
  await at(page, taskId)
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
 * Linear Algebra, published through the Coach's API: Vectors (20-XP Required Task and
 * an Enrichment reading) before Matrices, which requires Mastery of Vectors and 20 XP
 * and has a 15-XP Required Task.
 */
async function publishLinearAlgebra(page: Page, workspaceId: string) {
  const created = await ok(page, `/coach/workspaces/${workspaceId}/learning-paths`, 'POST', { title: 'Linear Algebra', goal: 'Linear maps with confidence' })
  const ids = { vectors: crypto.randomUUID(), matrices: crypto.randomUUID(), drills: crypto.randomUUID(), reading: crypto.randomUUID(), matrixDrills: crypto.randomUUID() }
  const saved = await ok(page, `/coach/learning-paths/${created.learningPath.id}/draft`, 'PUT', {
    expectedRevision: created.learningPath.revision, title: 'Linear Algebra', goal: 'Linear maps with confidence',
    editor: { format_version: 1, cards: [{ id: ids.vectors, title: 'Vectors', position: { x: 80, y: 120 } }, { id: ids.matrices, title: 'Matrices', position: { x: 420, y: 160 } }], connections: [{ from_id: ids.vectors, to_id: ids.matrices }] },
    application: { skills: [
      { id: ids.vectors, title: 'Vectors', outcome: 'Add and scale vectors in R^n', optional: false, xpThreshold: 0, tasks: [
        { id: ids.drills, title: 'Vector drills', description: 'Exercises 1–10', required: true, xpReward: 20 },
        { id: ids.reading, title: 'Read chapter 1', description: 'Optional background', required: false, xpReward: 0 },
      ] },
      { id: ids.matrices, title: 'Matrices', outcome: 'Multiply matrices as linear maps', optional: false, xpThreshold: 20, tasks: [
        { id: ids.matrixDrills, title: 'Matrix drills', description: 'Exercises 11–20', required: true, xpReward: 15 },
      ] },
    ] },
  })
  const published = await ok(page, `/coach/learning-paths/${created.learningPath.id}/publication`, 'POST', { expectedRevision: saved.learningPath.revision })
  return { pathId: created.learningPath.id as string, versionId: published.version.id as string, ...ids }
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

const reviewPanel = (taskId: string) => `#task-review-${taskId}`
async function waitReview(page: Page, taskId: string, kind: string) {
  await at(page, taskId)
  await page.waitForSelector(`${reviewPanel(taskId)}[data-status="${kind}"]`).catch(async () => {
    const panel = await page.$(reviewPanel(taskId))
    throw new Error(`review of ${taskId} did not reach ${kind} (${panel ? `${JSON.stringify(await data(page, reviewPanel(taskId)))}: ${await text(page, reviewPanel(taskId))}` : 'no review panel'})`)
  })
}
/** Reads the records again as returning to the page does, and waits until every read has answered. */
async function revisit(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForFunction(() => (document.querySelector('#enrollment-records') as HTMLElement | null)?.dataset.reading === 'false')
  await page.waitForNetworkIdle({ idleTime: 250 })
}
/** The learner sends a Task's work from her sidebar: the draft text replaced or extended, then Send. */
async function sendFromUi(page: Page, taskId: string, input: string, replace = false) {
  await at(page, taskId)
  await page.bringToFront()
  await draftReady(page, taskId)
  await typeInto(page, `#task-work-text-${taskId}`, input, replace)
  await page.$eval(`#task-work-send-${taskId}`, (el) => el.scrollIntoView({ block: 'center' }))
  await page.click(`#task-work-send-${taskId}`)
  await waitStatus(page, taskId, 'sent')
  return Number((await data(page, work(taskId))).sentRevision)
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
  /** The person acting next: their page comes to the front, as a background tab's input can stall. */
  const act = async (page: Page) => { current = page; await page.bringToFront() }
  try {
    await waitForServerReady(ORIGIN)
    for (let i = 0; i < 30; i++) {
      if ((await fetch(`${ORIGIN}/api/account`).catch(() => null))?.status === 401) break
      await new Promise((r) => setTimeout(r, 300))
    }

    const { context: coachContext, page: carla } = await newContext(browser, errors)
    await act(carla)
    // Every request any of Carla's pages makes, to prove none of them asks for a draft.
    const coachRequests: string[] = []
    coachContext.on('targetcreated', async (target) => { (await target.page())?.on('request', (r) => coachRequests.push(r.url())) })
    carla.on('request', (r) => coachRequests.push(r.url()))
    await signUpVerified(carla, 'carla@gurow.test')
    const workspace = (await ok(carla, '/coach/workspaces', 'POST', { name: 'Linear Algebra Studio' })).workspace
    const la = await publishLinearAlgebra(carla, workspace.id)
    const { page: lena } = await newContext(browser, errors)
    await act(lena)
    await signUpVerified(lena, 'lena@gurow.test')
    const enrollment = await inviteAndAccept(carla, lena, la.versionId, 'lena@gurow.test')
    const { page: pia } = await newContext(browser, errors)
    await signUpVerified(pia, 'pia@gurow.test')
    const piaEnrollment = await inviteAndAccept(carla, pia, la.versionId, 'pia@gurow.test')
    const taskRoute = (task: string) => `/enrollments/${enrollment}/tasks/${task}`
    const storedReviews = async (task: string) => [...await sql`select r.revision_number as revision, v.decision, v.feedback, v.revoked_at is not null as revoked from submission_reviews v join submission_revisions r on r.id = v.revision_id join submissions s on s.id = r.submission_id where s.enrollment_id = ${enrollment} and s.task_id = ${task} order by r.revision_number`].map((row: any) => [row.revision, row.decision, row.feedback, row.revoked])
    const xpEvents = async () => [...await sql`select task_id, kind, amount from xp_events where enrollment_id = ${enrollment} order by id`].map((row: any) => [row.task_id, row.kind, row.amount])
    const masteryEvents = async () => [...await sql`select skill_id, action from mastery_events where enrollment_id = ${enrollment} order by id`].map((row: any) => [row.skill_id, row.action])
    const revisionIds = async (task: string) => (await ok(carla, `${taskRoute(task)}/submission`)).submission.revisions.map((r: any) => r.id) as string[]
    const progress = async (page: Page) => ({
      xp: (await data(page, '#enrollment-xp')).xp,
      vectors: await readCardProgress(page, la.vectors),
      matrices: await readCardProgress(page, la.matrices),
    })
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

    // Review requests can be held, or committed with their answer dropped, and the records read held, on Carla's page.
    const faults = { hold: null as null | (() => void), holding: false, commitThenDrop: 0, holdRecords: false, heldRecords: null as null | import('puppeteer-core').HTTPRequest }
    await carla.setRequestInterception(true)
    carla.on('request', (request) => void (async () => {
      const isReview = request.method() === 'POST' && /\/submission\/revisions\/[^/]+\/review$/.test(new URL(request.url()).pathname)
      if (request.method() === 'GET' && new URL(request.url()).pathname.endsWith('/learning-state') && faults.holdRecords) {
        faults.holdRecords = false
        faults.heldRecords = request
        return
      }
      if (isReview && faults.holding) {
        await new Promise<void>((release) => { faults.hold = release })
        return request.continue()
      }
      if (isReview && faults.commitThenDrop > 0) {
        faults.commitThenDrop--
        const cookie = (await carla.cookies()).map((c) => `${c.name}=${c.value}`).join('; ')
        const committed = await fetch(request.url(), { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: request.postData() })
        check(committed.status === 201, `the forwarded decision answered ${committed.status}`)
        return request.abort('connectionreset')
      }
      return request.continue()
    })())

    // 1. Carla finds Lena's sent work from the Version's learners and reads the exact revision; Lena's private draft never reaches her.
    await openEnrollment(lena, enrollment)
    await canvasSelect(lena, la.vectors)
    await draftReady(lena, la.drills)
    await at(lena, la.drills)
    await lena.click(`#task-work-add-url-${la.drills}`)
    await at(lena, la.drills)
    await typeInto(lena, `#task-work-url-${la.drills}-0`, 'https://notes.example/vectors-v1')
    check(await sendFromUi(lena, la.drills, 'Exercise 1: u + v = (3, 1)') === 1, 'Lena\'s first send is not Revision 1')
    const secret = 'Private scratch: exercise 2 is not ready'
    await at(lena, la.drills)
    await typeInto(lena, `#task-work-text-${la.drills}`, `\n${secret}`)
    await at(lena, la.drills)
    await lena.click(`#task-work-save-${la.drills}`)
    await waitStatus(lena, la.drills, 'saved')
    await act(carla)
    await carla.goto(`${ORIGIN}/coach/versions/${la.versionId}`, { waitUntil: 'networkidle0' })
    await carla.waitForSelector('#version-enrollments[data-count="2"]')
    const lenaEntry = await data(carla, `#version-enrollment-${enrollment}`)
    const piaEntry = await data(carla, `#version-enrollment-${piaEnrollment}`)
    check(lenaEntry.email === 'lena@gurow.test' && lenaEntry.awaitingReview === '1' && piaEntry.awaitingReview === '0' && (await data(carla, '#version-enrollments')).awaitingReview === '1', `Version learners: ${JSON.stringify([lenaEntry, piaEntry])}`)
    check((await text(carla, `#version-enrollment-${enrollment}`)).includes('1 awaiting Review'), 'Lena\'s entry does not say her work awaits Review')
    await carla.click(`#open-enrollment-${enrollment}`)
    await carla.waitForSelector('#enrolled-version[data-gpu-status="ready"]', { timeout: 20000 })
    await waitAwaitingReview(carla, 1)
    check((await text(carla, '#enrolled-learner')).includes('lena@gurow.test') && (await data(carla, `#awaiting-review-${la.drills}`)).revisionNumber === '1' && (await readSkillStatus(carla, `#skill-status-${la.vectors}`)).awaitingReview === '1', 'the Enrollment page does not name Lena or list her revision awaiting Review')
    await canvasSelect(carla, la.vectors)
    let revisions = await history(carla, la.drills, 1)
    check(revisions[0].status === 'pending' && revisions[0].text.includes('Exercise 1: u + v = (3, 1)') && revisions[0].text.includes('https://notes.example/vectors-v1') && revisions[0].note === 'Awaiting your Review.', `Carla's view of Revision 1: ${JSON.stringify(revisions)}`)
    await at(carla, la.drills)
    let panel = await data(carla, reviewPanel(la.drills))
    await at(carla, la.drills)
    check(panel.targetRevision === '1' && (await text(carla, `#task-review-target-${la.drills}`)).startsWith('Deciding Revision 1'), `the review does not target Revision 1: ${JSON.stringify(panel)}`)
    await history(carla, la.reading, 0)
    await at(carla, la.reading)
    check(await carla.$(`#task-review-none-${la.reading}`) !== null, 'a Task without sent work offers a decision')
    check(await carla.$('[data-task-work]') === null && !(await carla.evaluate(() => document.body.innerText)).includes(secret), 'Carla\'s page shows draft fields or Lena\'s private draft')
    pass('find and inspect', 'Version page lists Lena (1 awaiting Review) and Pia (0) → Lena\'s Enrollment names her and queues drills Revision 1 → canvas click on Vectors shows its exact text and link, the Review targets Revision 1; no draft fields or private draft text')

    // 2. Changes Requested needs feedback; the decision is shown once the backend confirms it.
    await at(carla, la.drills)
    check(panel.canRequestChanges === 'false' && panel.canApprove === 'true' && (await text(carla, `#task-review-hint-${la.drills}`)).includes('needs feedback'), `Changes Requested is offered without feedback: ${JSON.stringify(panel)}`)
    await at(carla, la.drills)
    await typeInto(carla, `#task-review-feedback-${la.drills}`, '   ')
    await at(carla, la.drills)
    check((await data(carla, reviewPanel(la.drills))).canRequestChanges === 'false', 'blank feedback allows Changes Requested')
    const blank = await api(carla, `${taskRoute(la.drills)}/submission/revisions/${(await revisionIds(la.drills))[0]}/review`, 'POST', { decision: 'changes_requested', feedback: '  ' })
    check(blank.status === 422 && blank.body?.error === 'invalid_review' && (await storedReviews(la.drills)).length === 0, `Changes Requested without feedback answered ${blank.status}`)
    const feedback1 = 'Show the working for exercise 1, step by step.'
    await at(carla, la.drills)
    await typeInto(carla, `#task-review-feedback-${la.drills}`, feedback1, true)
    await at(carla, la.drills)
    check((await data(carla, reviewPanel(la.drills))).canRequestChanges === 'true', 'feedback did not enable Changes Requested')
    await at(carla, la.drills)
    await carla.click(`#task-review-request-changes-${la.drills}`)
    await waitReview(carla, la.drills, 'recorded')
    await at(carla, la.drills)
    await carla.waitForSelector(`${reviewPanel(la.drills)}[data-refresh="read"]`)
    await at(carla, la.drills)
    check((await text(carla, `#task-review-status-${la.drills}`)).startsWith('Changes Requested of Revision 1 recorded, confirmed by Gurow') && (await data(carla, reviewPanel(la.drills))).confirmedBy === 'answer', `status after Changes Requested: ${await text(carla, `#task-review-status-${la.drills}`)}`)
    await at(carla, la.drills)
    await carla.waitForSelector(`#task-history-${la.drills} li[data-revision-number="1"][data-status="changes_requested"]`)
    await waitAwaitingReview(carla, 0)
    revisions = await history(carla, la.drills, 1)
    await at(carla, la.drills)
    check(revisions[0].text.includes(`Feedback: ${feedback1}`) && await carla.$(`#task-review-none-${la.drills}`) !== null && await value(carla, `#task-review-feedback-${la.drills}`).catch(() => '') === '', 'the recorded feedback is not shown, or a decision is still offered')
    check(same(await storedReviews(la.drills), [[1, 'changes_requested', feedback1, false]]) && (await data(carla, '#enrollment-xp')).xp === '0', `stored after Changes Requested: ${JSON.stringify(await storedReviews(la.drills))}`)
    pass('changes requested', 'Request changes disabled (hint) for empty and blank feedback, the API answers 422 and stores nothing; with feedback → "Changes Requested of Revision 1 recorded, confirmed by Gurow", the history shows the feedback, the queue is empty, XP 0')

    // 3. Lena reads the feedback and sends a correction while she has Access.
    await act(lena)
    await revisit(lena)
    await at(lena, la.drills)
    await lena.waitForSelector(`#task-history-${la.drills} li[data-revision-number="1"][data-status="changes_requested"]`)
    revisions = await history(lena, la.drills, 1)
    check(revisions[0].text.includes(`Feedback: ${feedback1}`) && revisions[0].note === 'Your Coach asked for changes; send a correction as a new revision.', `Lena's view of the feedback: ${JSON.stringify(revisions)}`)
    check(await lena.$('[data-task-review]') === null, 'Lena\'s page offers a Review')
    check(await sendFromUi(lena, la.drills, 'Exercise 1: u + v = (2 + 1, 0 + 1) = (3, 1)', true) === 2, 'the correction is not Revision 2')
    pass('feedback and correction', 'on returning, Lena sees Changes Requested with the feedback and "send a correction as a new revision"; her page has no Review; the correction is sent as Revision 2')

    // 4. A revision replaced while Carla was deciding cannot be decided; the page explains and reads the history again.
    await act(carla)
    await revisit(carla)
    // Read before the stale case is set up: reading the Skill list reopens the summary (UX01, #47).
    const beforeStale = await progress(carla)
    await at(carla, la.drills)
    await carla.waitForSelector(`${reviewPanel(la.drills)}[data-target-revision="2"]`)
    await at(carla, la.drills)
    await typeInto(carla, `#task-review-feedback-${la.drills}`, 'Correct now.')
    // Lena sends again from another device meanwhile; Carla's page is not told.
    const third = await ok(lena, `${taskRoute(la.drills)}/submission/revisions`, 'POST', { text: 'Exercise 1: u + v = (3, 1), with a sketch', urls: ['https://notes.example/sketch'] })
    check(third.revision.revisionNumber === 3, 'Lena\'s second correction is not Revision 3')
    await at(carla, la.drills)
    check((await data(carla, reviewPanel(la.drills))).targetRevision === '2', 'Carla\'s page moved on before deciding; the stale case was not set up')
    await at(carla, la.drills)
    await carla.click(`#task-review-approve-${la.drills}`)
    await waitReview(carla, la.drills, 'refused')
    const refused = await text(carla, `#task-review-status-${la.drills}`)
    check(refused.startsWith('Not recorded: the learner sent a newer revision, which replaced Revision 2 before your decision') && refused.includes('Nothing changed') && refused.includes('Your feedback is kept'), `stale decision status: ${refused}`)
    await at(carla, la.drills)
    await carla.waitForSelector(`${reviewPanel(la.drills)}[data-refresh="read"]`)
    await at(carla, la.drills)
    check((await text(carla, `#task-review-status-${la.drills}`)).endsWith('The history and progress shown were read again.'), `refusal after the read: ${await text(carla, `#task-review-status-${la.drills}`)}`)
    await at(carla, la.drills)
    await carla.waitForSelector(`#task-history-${la.drills} li[data-revision-number="2"][data-status="superseded"]`)
    await at(carla, la.drills)
    await carla.waitForSelector(`${reviewPanel(la.drills)}[data-target-revision="3"]`)
    await carla.waitForFunction(() => (document.querySelector('#enrollment-records') as HTMLElement).dataset.reading === 'false')
    revisions = await history(carla, la.drills, 3)
    check(same(revisions.map((r) => r.status), ['changes_requested', 'superseded', 'pending']) && revisions[1].note.includes('Replaced by Revision 3'), `history after the stale decision: ${JSON.stringify(revisions.map((r) => [r.status, r.note]))}`)
    await at(carla, la.drills)
    check(await value(carla, `#task-review-feedback-${la.drills}`) === 'Correct now.' && same(await progress(carla), beforeStale) && same(await progress(carla), { xp: '0', vectors: ['open', 'not-mastered'], matrices: ['locked', 'not-mastered'] }), `after the stale decision: ${JSON.stringify(await progress(carla))}`)
    check(same(await storedReviews(la.drills), [[1, 'changes_requested', feedback1, false]]) && (await xpEvents()).length === 0 && (await masteryEvents()).length === 0, 'the stale decision stored a Review, XP or Mastery')
    pass('stale decision', 'Lena sent Revision 3 while Carla\'s page showed Revision 2 → Approve Revision 2 → "Not recorded: … replaced Revision 2 before your decision … Nothing changed", history re-read (2 superseded, 3 awaiting), feedback kept; XP 0, no Mastery, no Review, XP or Mastery rows stored')

    // 5. An Approval is shown only after the backend confirms it; reward, Mastery and the dependent Access follow, without spending XP.
    await at(carla, la.drills)
    await typeInto(carla, `#task-review-feedback-${la.drills}`, 'Correct now: well done.', true)
    faults.holding = true
    await at(carla, la.drills)
    await carla.click(`#task-review-approve-${la.drills}`)
    await waitReview(carla, la.drills, 'recording')
    for (let i = 0; i < 50 && !faults.hold; i++) await new Promise((r) => setTimeout(r, 20))
    check(faults.hold, 'the Approval request was not held')
    await new Promise((r) => setTimeout(r, 400))
    await at(carla, la.drills)
    check(same(await progress(carla), { xp: '0', vectors: ['open', 'not-mastered'], matrices: ['locked', 'not-mastered'] }) && (await data(carla, `#task-learning-${la.drills}`)).approved === 'false' && (await text(carla, `#task-review-status-${la.drills}`)).startsWith('Recording Approval of Revision 3'), 'progress or Approval was shown before the backend confirmed it')
    check((await storedReviews(la.drills)).length === 1, 'the held Approval reached the backend')
    // The records read after the decision is held, then fails: the decision is confirmed, its progress is not claimed.
    faults.holdRecords = true
    faults.holding = false
    faults.hold!()
    await waitReview(carla, la.drills, 'recorded')
    for (let i = 0; i < 100 && !faults.heldRecords; i++) await new Promise((r) => setTimeout(r, 20))
    check(faults.heldRecords, 'the records read after the Approval was not held')
    await at(carla, la.drills)
    let decided = await text(carla, `#task-review-status-${la.drills}`)
    await at(carla, la.drills)
    check((await data(carla, reviewPanel(la.drills))).refresh === 'reading' && decided.startsWith('Approval of Revision 3 recorded, confirmed by Gurow') && decided.includes('Reading the resulting XP, Mastery and Access') && !decided.includes('derived them after it') && (await data(carla, '#enrollment-xp')).xp === '0', `while the records are read: ${decided}`)
    await faults.heldRecords!.abort('connectionreset')
    await at(carla, la.drills)
    await carla.waitForSelector(`${reviewPanel(la.drills)}[data-refresh="failed"]`)
    await at(carla, la.drills)
    decided = await text(carla, `#task-review-status-${la.drills}`)
    check(decided.includes('could not be read, so what is shown above may be out of date') && !decided.includes('derived them after it') && (await data(carla, '#enrollment-xp')).xp === '0' && await carla.$('#enrollment-records-error') !== null, `after the failed records read: ${decided}`)
    await at(carla, la.drills)
    await carla.click(`#task-review-reread-${la.drills}`)
    await at(carla, la.drills)
    await carla.waitForSelector(`${reviewPanel(la.drills)}[data-refresh="read"]`)
    await at(carla, la.drills)
    check((await text(carla, `#task-review-status-${la.drills}`)).includes('XP, Mastery and Access above are as Gurow derived them after it'), 'the progress claim is missing after a successful read')
    await carla.waitForSelector('#enrollment-xp[data-xp="20"]')
    await at(carla, la.drills)
    await carla.waitForSelector(`#task-learning-${la.drills}[data-approved="true"][data-xp-contribution="20"]`)
    check(same(await progress(carla), { xp: '20', vectors: ['open', 'mastered'], matrices: ['open', 'not-mastered'] }), `Carla's progress after Approval: ${JSON.stringify(await progress(carla))}`)
    await carla.waitForSelector(`#task-xp-history-${la.drills}[data-events="1"]`)
    check(same(await xpEvents(), [[la.drills, 'award', 20]]) && same(await masteryEvents(), [[la.vectors, 'award']]) && same((await storedReviews(la.drills)).at(-1), [3, 'approval', 'Correct now: well done.', false]), 'stored XP, Mastery or Review after Approval')
    await act(lena)
    await revisit(lena)
    await lena.waitForSelector('#enrollment-xp[data-xp="20"]')
    check(same(await progress(lena), { xp: '20', vectors: ['open', 'mastered'], matrices: ['open', 'not-mastered'] }) && (await text(lena, '#skill-mastery-state')) === 'Mastered', `Lena's progress after Approval: ${JSON.stringify(await progress(lena))}`)
    revisions = await history(lena, la.drills, 3)
    await at(lena, la.drills)
    check(revisions[2].status === 'approval' && revisions[2].text.includes('Feedback: Correct now: well done.') && (await text(lena, `#task-learning-${la.drills}`)).includes('approved, contributes 20 XP'), 'Lena does not see the Approval and its reward')
    await keyboardSelect(lena, 1, la.matrices)
    check((await text(lena, '#skill-access-state')) === 'Open' && (await data(lena, '#enrollment-xp')).xp === '20', 'Matrices did not open, or opening it spent XP')
    pass('confirmed progress', 'with the Approval request held: "Recording…", XP 0, Vectors not mastered, Matrices locked, nothing stored; once answered: "Approval of Revision 3 recorded" while the records read is held ("Reading…", XP 0) and then fails ("may be out of date", XP 0); "Read them again" → "derived them after it", 20 XP (one award event), Vectors mastered, Matrices open; Lena sees the same and the 20 XP stay after Matrices opens')

    // 6. A newer revision is assessed on its own; the earlier Approval keeps counting, and the reward never doubles.
    await canvasSelect(lena, la.vectors)
    check(await sendFromUi(lena, la.drills, '\nAlso: the dot product is commutative.') === 4, 'the revision after the Approval is not Revision 4')
    await act(carla)
    await revisit(carla)
    await at(carla, la.drills)
    await carla.waitForSelector(`${reviewPanel(la.drills)}[data-target-revision="4"]`)
    revisions = await history(carla, la.drills, 4)
    await at(carla, la.drills)
    check(revisions[3].note === 'Awaiting your Review. It does not inherit the Approval of Revision 3, which counts whatever you decide here.' && (await text(carla, `#task-review-target-${la.drills}`)).includes('The Approval of Revision 3 keeps counting'), `Carla's note on Revision 4: ${revisions[3].note}`)
    const feedback4 = 'Prove commutativity from the definition.'
    await at(carla, la.drills)
    await typeInto(carla, `#task-review-feedback-${la.drills}`, feedback4)
    await at(carla, la.drills)
    await carla.click(`#task-review-request-changes-${la.drills}`)
    await waitReview(carla, la.drills, 'recorded')
    await at(carla, la.drills)
    await carla.waitForSelector(`#task-history-${la.drills} li[data-revision-number="4"][data-status="changes_requested"]`)
    await carla.waitForFunction(() => (document.querySelector('#enrollment-records') as HTMLElement).dataset.reading === 'false')
    check(same(await progress(carla), { xp: '20', vectors: ['open', 'mastered'], matrices: ['open', 'not-mastered'] }), 'Changes Requested on a newer revision removed the earlier Approval\'s progress')
    await act(lena)
    await revisit(lena)
    await at(lena, la.drills)
    await lena.waitForSelector(`#task-history-${la.drills} li[data-revision-number="4"][data-status="changes_requested"]`)
    revisions = await history(lena, la.drills, 4)
    check(revisions[3].note === 'Your Coach asked for changes to this revision; the Approval of Revision 3 still counts.' && revisions[3].text.includes(feedback4) && (await data(lena, '#enrollment-xp')).xp === '20', `Lena's view of Revision 4: ${JSON.stringify(revisions[3])}`)
    // Another Approval of the same Task, whose answer is lost: the history confirms it, and the reward is not added again.
    check(await sendFromUi(lena, la.drills, '\nProof: u·v = Σ uᵢvᵢ = Σ vᵢuᵢ = v·u.') === 5, 'the proof is not Revision 5')
    await act(carla)
    await revisit(carla)
    await at(carla, la.drills)
    await carla.waitForSelector(`${reviewPanel(la.drills)}[data-target-revision="5"]`)
    faults.commitThenDrop = 1
    await at(carla, la.drills)
    await carla.click(`#task-review-approve-${la.drills}`)
    await waitReview(carla, la.drills, 'recorded')
    await at(carla, la.drills)
    check(faults.commitThenDrop === 0 && (await data(carla, reviewPanel(la.drills))).confirmedBy === 'history' && (await text(carla, `#task-review-status-${la.drills}`)).includes('the answer was lost, but the history shows it'), `lost Approval answer: ${await text(carla, `#task-review-status-${la.drills}`)}`)
    await at(carla, la.drills)
    await carla.waitForSelector(`#task-history-${la.drills} li[data-revision-number="5"][data-status="approval"]`)
    // A third Approval comes from another tab while this page still offers Revision 6: refused here, nothing doubles.
    check(await sendFromUi(lena, la.drills, '\nTypo fixed.') === 6, 'the typo fix is not Revision 6')
    await act(carla)
    await revisit(carla)
    await at(carla, la.drills)
    await carla.waitForSelector(`${reviewPanel(la.drills)}[data-target-revision="6"]`)
    await ok(carla, `${taskRoute(la.drills)}/submission/revisions/${(await revisionIds(la.drills))[5]}/review`, 'POST', { decision: 'approval' })
    await at(carla, la.drills)
    await typeInto(carla, `#task-review-feedback-${la.drills}`, 'One more fix, please.')
    await at(carla, la.drills)
    await carla.click(`#task-review-request-changes-${la.drills}`)
    await waitReview(carla, la.drills, 'refused')
    await at(carla, la.drills)
    check((await text(carla, `#task-review-status-${la.drills}`)).includes('Revision 6 already has a decision (perhaps from another tab)'), `already decided: ${await text(carla, `#task-review-status-${la.drills}`)}`)
    await at(carla, la.drills)
    await carla.waitForSelector(`#task-history-${la.drills} li[data-revision-number="6"][data-status="approval"]`)
    await carla.waitForFunction(() => (document.querySelector('#enrollment-records') as HTMLElement).dataset.reading === 'false')
    check(same(await progress(carla), { xp: '20', vectors: ['open', 'mastered'], matrices: ['open', 'not-mastered'] }) && (await data(carla, `#task-xp-history-${la.drills}`)).events === '1', 'three Approvals changed the reward or Mastery')
    check(same(await xpEvents(), [[la.drills, 'award', 20]]) && same(await masteryEvents(), [[la.vectors, 'award']]) && same((await storedReviews(la.drills)).map((r) => [r[0], r[1]]), [[1, 'changes_requested'], [3, 'approval'], [4, 'changes_requested'], [5, 'approval'], [6, 'approval']]), `stored after three Approvals: ${JSON.stringify([await xpEvents(), await storedReviews(la.drills)])}`)
    pass('independent assessment', 'Revision 4 "does not inherit the Approval of Revision 3" → Changes Requested; XP 20 and Mastery kept for both; Lena reads "the Approval of Revision 3 still counts"; Revision 5 approved with the answer dropped → "recorded … the history shows it"; Revision 6 approved from another tab → this page\'s Changes Requested refused "already has a decision"; one 20-XP award and one Mastery award stored in all')

    // 7. After Matrices locks, Carla still reviews its work sent with Access, from the keyboard on a page without WebGPU.
    await act(lena)
    await keyboardSelect(lena, 1, la.matrices)
    check(await sendFromUi(lena, la.matrixDrills, 'Matrix drills 11–20: all answers with working') === 1, 'the Matrix drills are not Revision 1')
    for (const index of [2, 4, 5]) {
      await ok(carla, `${taskRoute(la.drills)}/submission/revisions/${(await revisionIds(la.drills))[index]}/review/revoke`, 'POST', { reason: 'Graded against the wrong answer key.' })
    }
    const noGpu = await newPage(coachContext, errors)
    await noGpu.evaluateOnNewDocument(() => {
      Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true })
    })
    await act(noGpu)
    await openEnrollment(noGpu, enrollment, 'unsupported')
    await waitAwaitingReview(noGpu, 1)
    check(same(await progress(noGpu), { xp: '0', vectors: ['open', 'not-mastered'], matrices: ['locked', 'not-mastered'] }) && (await readSkillStatus(noGpu, `#skill-status-${la.matrices}`)).awaitingReview === '1', `Carla's records after the revocations: ${JSON.stringify(await progress(noGpu))}`)
    // Tab from the start of the page to Coach Review, open the queue with Enter (UX01, #47),
    // then Tab until the queued revision has focus and open it with Enter.
    await closeEditorPanels(noGpu)
    await noGpu.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    let reached = false
    for (let i = 0; i < 60 && !reached; i++) {
      await noGpu.keyboard.press('Tab')
      const focused = await noGpu.evaluate(() => document.activeElement?.id)
      if (focused === 'btn-coach-review') {
        await noGpu.keyboard.press('Enter')
        await noGpu.waitForSelector('#awaiting-review', { visible: true })
      }
      reached = focused === `awaiting-review-${la.matrixDrills}`
    }
    check(reached, 'Tab never reached the queued Matrix drills revision')
    await noGpu.keyboard.press('Enter')
    await waitSelected(noGpu, la.matrices)
    await noGpu.waitForFunction((id: string) => document.activeElement?.id === id, {}, `task-review-feedback-${la.matrixDrills}`)
    await at(noGpu, la.matrixDrills)
    check((await data(noGpu, reviewPanel(la.matrixDrills))).targetRevision === '1' && (await text(noGpu, `#task-history-${la.matrixDrills}`)).includes('Matrix drills 11–20: all answers with working'), 'the queued revision did not open beside its contents')
    await noGpu.keyboard.type('Clear and complete.')
    await noGpu.keyboard.press('Tab')
    check(await noGpu.evaluate(() => document.activeElement?.id) === `task-review-approve-${la.matrixDrills}`, 'Tab from the feedback does not reach Approve')
    await noGpu.keyboard.press('Enter')
    await waitReview(noGpu, la.matrixDrills, 'recorded')
    await noGpu.waitForSelector('#enrollment-xp[data-xp="15"]')
    await waitAwaitingReview(noGpu, 0)
    check(same(await progress(noGpu), { xp: '15', vectors: ['open', 'not-mastered'], matrices: ['locked', 'mastered'] }), `after approving locked work: ${JSON.stringify(await progress(noGpu))}`)
    check(same(await storedReviews(la.matrixDrills), [[1, 'approval', 'Clear and complete.', false]]), 'the keyboard Approval was not stored')
    await act(lena)
    await revisit(lena)
    await lena.waitForSelector('#enrollment-xp[data-xp="15"]')
    check(same(await progress(lena), { xp: '15', vectors: ['open', 'not-mastered'], matrices: ['locked', 'mastered'] }) && (await text(lena, '#lock-reasons')).includes('Requires Mastery of “Vectors”'), `Lena after the locked Approval: ${JSON.stringify(await progress(lena))}`)
    pass('review after Access loss', 'Lena sent Matrix drills while Matrices was open; revoking the Vectors Approvals (API) locked it; on a page without WebGPU Tab reached the queued revision, Enter opened it with the feedback focused, typing + Tab + Enter approved it: 15 XP, Matrices mastered but still locked (Requires Mastery of Vectors)')

    // 8. Lena cannot review her own work; Pia cannot reach it; neither is recorded.
    await keyboardSelect(lena, 0, la.vectors)
    check(await sendFromUi(lena, la.reading, 'Chapter 1 summary') === 1, 'the reading is not Revision 1')
    const own = (await ok(lena, `${taskRoute(la.reading)}/submission`)).submission.revisions[0].id
    const selfApproval = await api(lena, `${taskRoute(la.reading)}/submission/revisions/${own}/review`, 'POST', { decision: 'approval' })
    check(selfApproval.status === 403 && selfApproval.body?.error === 'coach_only' && await lena.$('[data-task-review]') === null && await lena.$('[id^="task-review-approve-"]') === null, `self-approval answered ${selfApproval.status}, or Lena's page offers a Review`)
    await act(pia)
    const peerReview = await api(pia, `${taskRoute(la.reading)}/submission/revisions/${own}/review`, 'POST', { decision: 'approval' })
    const peerList = await api(pia, `/coach/learning-path-versions/${la.versionId}/enrollments`)
    check(peerReview.status === 404 && peerReview.body?.error === 'enrollment_not_found' && peerList.status === 404, `Pia's review/list answered ${peerReview.status}/${peerList.status}`)
    await pia.goto(`${ORIGIN}/enrollments/${enrollment}`, { waitUntil: 'networkidle0' })
    await pia.waitForSelector('#enrollment-unavailable')
    check(!(await pia.evaluate(() => document.body.innerText)).includes('Chapter 1 summary'), 'Pia sees Lena\'s work')
    await openEnrollment(pia, piaEnrollment)
    check(await pia.$('[data-task-review]') === null && await pia.$('#awaiting-review') === null && await pia.$('#btn-coach-review') === null, 'Pia\'s own Enrollment offers a Review')
    check((await storedReviews(la.reading)).length === 0, 'a learner\'s decision was stored')
    await act(noGpu)
    await revisit(noGpu)
    await openCoachReview(noGpu)
    await noGpu.waitForSelector(`#awaiting-review-${la.reading}`)
    pass('self-approval and peers', 'Lena\'s page has no Review and her API decision answers 403 coach_only; Pia gets 404 on the decision and the Version\'s learners, and "Enrollment not available" without the work; nothing stored, the revision stays in Carla\'s queue')

    // 9. Reload: the decisions, feedback and progress come back from PostgreSQL; no Coach page ever asked for a draft.
    await act(carla)
    await openEnrollment(carla, enrollment)
    await canvasSelect(carla, la.vectors)
    revisions = await history(carla, la.drills, 6)
    check(same(revisions.map((r) => r.status), ['changes_requested', 'superseded', 'approval_revoked', 'changes_requested', 'approval_revoked', 'approval_revoked']) && revisions[0].text.includes(feedback1) && revisions[3].text.includes(feedback4), `Carla's history after reload: ${revisions.map((r) => r.status)}`)
    check(same(await progress(carla), { xp: '15', vectors: ['open', 'not-mastered'], matrices: ['locked', 'mastered'] }), 'Carla\'s progress after reload')
    await carla.$eval(reviewPanel(la.reading), (el) => el.scrollIntoView({ block: 'center' }))
    await carla.screenshot({ path: path.resolve(FRONTEND, '../.harness/t23-coach-review.png') })
    await act(lena)
    await openEnrollment(lena, enrollment)
    await canvasSelect(lena, la.vectors)
    revisions = await history(lena, la.drills, 6)
    check(same(revisions.map((r) => r.status), ['changes_requested', 'superseded', 'approval_revoked', 'changes_requested', 'approval_revoked', 'approval_revoked']) && same(await progress(lena), { xp: '15', vectors: ['open', 'not-mastered'], matrices: ['locked', 'mastered'] }), 'Lena\'s history or progress after reload')
    const draftRequests = coachRequests.filter((url) => /\/tasks\/[^/]+\/draft$/.test(new URL(url).pathname))
    check(draftRequests.length === 0 && coachRequests.some((url) => url.includes('/submission')), `Carla's pages requested drafts: ${draftRequests.join(', ')}`)
    pass('reload and privacy', 'after reload both see changes requested, superseded, revoked Approvals and the feedback, 15 XP, Matrices mastered and locked; none of Carla\'s requests asked for a draft')

    check(errors.length === 0, `page errors: ${errors.join('; ')}`)
    console.log(`\nT23 Coach review check passed (${steps.length} steps).`)
  } catch (error) {
    const shot = path.resolve(FRONTEND, '../.harness/t23-failure.png')
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
  console.error(`\nT23 Coach review check FAILED after ${steps.length} steps: ${error instanceof Error ? `${error.message}\n${error.stack}` : error}`)
  process.exit(1)
})
