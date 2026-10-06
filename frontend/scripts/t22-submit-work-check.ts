#!/usr/bin/env bun
/**
 * T22 learner work check (#23): the production frontend build forwarding /api to the
 * production backend entry (Better Auth sessions) on a freshly migrated PostgreSQL
 * database, with email through the Resend HTTP mailer to a local stand-in. Real
 * Accounts take every step: a Coach publishes a Version and invites two learners, who
 * verify their emailed addresses and accept. The learner prepares a private draft
 * from a canvas-selected Skill, saves it, recovers unsaved edits after a reload, fails
 * to send while offline, sends, corrects and reloads; a newer revision supersedes a
 * pending one and an Approval stays with its own revision. From the keyboard list
 * without WebGPU she drafts, sends and corrects another Task, and reuses evidence for
 * a third through its own Submission. Sending to a Skill that has become locked, or
 * from an inactive Enrollment, sends nothing and keeps the work. The Coach and a peer
 * never receive unsent draft contents, including after Account switches in the same
 * browser. A send whose answer is lost is reconciled with the Submission history
 * instead of being reported unsent. Reviewing from the UI is T23, so the Coach's
 * decisions go through the API.
 *
 * Run from frontend: bun run scripts/t22-submit-work-check.ts [--skip-build]
 */
import { SQL } from 'bun'
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import puppeteer, { type Browser, type BrowserContext, type Page } from 'puppeteer-core'
import { startResendStandIn } from '../../backend/test/support/resend-stand-in'
import { resolveChromiumExecutable, waitForServerReady } from './benchmark/browser'

const FRONTEND = path.resolve(import.meta.dir, '..')
const BACKEND = path.resolve(FRONTEND, '../backend')
const PORT = Number(process.env.PORT ?? 3521)
const API_PORT = Number(process.env.API_PORT ?? 3522)
const ORIGIN = `http://127.0.0.1:${PORT}`
const SECRET = 't22-browser-check-secret-not-for-production'
const DATABASE_URL = process.env.T22_DATABASE_URL ?? 'postgres://gurow:gurow@127.0.0.1:5433/gurow_t22_browser_test'
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
async function signOut(page: Page) {
  await page.click('#sign-out-btn')
  await page.waitForSelector('#sign-in-form')
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
  await page.waitForFunction(() => document.querySelectorAll('[id^="card-label-"]').length === 2)
  const point = await cardPoint(page, id)
  await page.mouse.click(point.x, point.y)
  await waitSelected(page, id)
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

    const { page: carla } = await newContext(browser, errors)
    current = carla
    await signUpVerified(carla, 'carla@gurow.test')
    const workspace = (await ok(carla, '/coach/workspaces', 'POST', { name: 'Linear Algebra Studio' })).workspace
    const la = await publishLinearAlgebra(carla, workspace.id)
    const { context: learners, page: lena } = await newContext(browser, errors)
    current = lena
    const lenaId = await signUpVerified(lena, 'lena@gurow.test')
    const enrollment = await inviteAndAccept(carla, lena, la.versionId, 'lena@gurow.test')
    const taskRoute = (task: string) => `/enrollments/${enrollment}/tasks/${task}`
    const recoveryKey = (task: string, account = lenaId, enrollmentId = enrollment) => `gurow:submission-draft:${account}:${enrollmentId}:${task}`
    const stored = (page: Page, key: string) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null'), key)
    const storedDraft = async (task: string) => (await sql`select text, urls from submission_drafts where enrollment_id = ${enrollment} and task_id = ${task}`)[0] ?? null
    const storedRevisions = async (task: string) => [...await sql`select r.revision_number, r.text, r.urls, r.superseded_at is not null as superseded from submission_revisions r join submissions s on s.id = r.submission_id where s.enrollment_id = ${enrollment} and s.task_id = ${task} order by r.revision_number`]

    // 1. From a canvas-selected Skill, the learner writes a private draft and saves it; the Coach cannot read it.
    await openEnrollment(lena, enrollment)
    await canvasSelect(lena, la.vectors)
    await draftReady(lena, la.drills)
    check(await text(lena, work(la.drills)).then((t) => t.includes('Only you can see it')), 'the draft is not presented as private')
    await typeInto(lena, `#task-work-text-${la.drills}`, 'Exercise 1: u + v = (3, 1)')
    await lena.click(`#task-work-add-url-${la.drills}`)
    await typeInto(lena, `#task-work-url-${la.drills}-0`, 'https://notes.example/vectors-v1')
    let w = await data(lena, work(la.drills))
    check(w.unsaved === 'true' && w.keptLocally === 'true', `unsaved edits are not kept locally: ${JSON.stringify(w)}`)
    check((await stored(lena, recoveryKey(la.drills)))?.text === 'Exercise 1: u + v = (3, 1)', 'unsaved edits are not in the Account-scoped recovery key')
    await lena.click(`#task-work-save-${la.drills}`)
    await waitStatus(lena, la.drills, 'saved')
    w = await data(lena, work(la.drills))
    check(w.unsaved === 'false' && w.keptLocally === 'false' && await stored(lena, recoveryKey(la.drills)) === null, `the saved draft is still marked unsaved: ${JSON.stringify(w)}`)
    check(JSON.stringify(await storedDraft(la.drills)) === JSON.stringify({ text: 'Exercise 1: u + v = (3, 1)', urls: ['https://notes.example/vectors-v1'] }), `stored draft: ${JSON.stringify(await storedDraft(la.drills))}`)
    const coachDraftRead = await api(carla, `${taskRoute(la.drills)}/draft`)
    const coachSubmissionRead = await api(carla, `${taskRoute(la.drills)}/submission`)
    check(coachDraftRead.status === 403 && !JSON.stringify(coachDraftRead.body).includes('Exercise 1') && coachSubmissionRead.status === 404, `Coach reads of the unsent draft answered ${coachDraftRead.status}/${coachSubmissionRead.status}`)
    await openEnrollment(lena, enrollment)
    await canvasSelect(lena, la.vectors)
    await draftReady(lena, la.drills)
    check(await value(lena, `#task-work-text-${la.drills}`) === 'Exercise 1: u + v = (3, 1)' && await value(lena, `#task-work-url-${la.drills}-0`) === 'https://notes.example/vectors-v1' && await lena.$(`#task-work-recovered-${la.drills}`) === null, 'the saved draft did not come back after reloading')
    await history(lena, la.drills, 0)
    pass('private draft', 'canvas click on Vectors → typed text and a link (kept under the Account-scoped recovery key) → Save draft stored them in PostgreSQL; the Coach gets 403 on the draft and 404 on the Submission; reload shows the saved draft and no sent work')

    // 2. Unsaved edits survive an interrupted session in the same Account context, and can be discarded.
    await typeInto(lena, `#task-work-text-${la.drills}`, '\nExercise 2: 2u = (4, 2)')
    await lena.goto('about:blank')
    await openEnrollment(lena, enrollment)
    await canvasSelect(lena, la.vectors)
    await draftReady(lena, la.drills)
    check(await lena.$(`#task-work-recovered-${la.drills}`) !== null && await value(lena, `#task-work-text-${la.drills}`) === 'Exercise 1: u + v = (3, 1)\nExercise 2: 2u = (4, 2)', 'the unsaved edits were not recovered')
    check((await storedDraft(la.drills))?.text === 'Exercise 1: u + v = (3, 1)', 'recovery changed the saved draft')
    await typeInto(lena, `#task-work-text-${la.reading}`, 'A throwaway note')
    await lena.goto('about:blank')
    await openEnrollment(lena, enrollment)
    await canvasSelect(lena, la.vectors)
    await draftReady(lena, la.reading)
    await lena.click(`#task-work-discard-${la.reading}`)
    check(await value(lena, `#task-work-text-${la.reading}`) === '' && await stored(lena, recoveryKey(la.reading)) === null, 'discarding the recovered edits did not restore the saved (empty) draft')
    pass('local recovery', 'unsaved line restored after leaving the page, with the "not saved yet" notice and the stored draft unchanged; another Task\'s recovered edits discarded back to its saved draft')

    // 3. Sending while offline fails visibly: nothing is submitted and the work stays.
    await lena.setOfflineMode(true)
    await lena.click(`#task-work-send-${la.drills}`)
    await waitStatus(lena, la.drills, 'not-sent')
    await lena.setOfflineMode(false)
    check((await text(lena, `#task-work-status-${la.drills}`)).startsWith('Not sent: the backend could not be reached. Nothing was submitted; your work is still here and kept in this browser'), `offline status: ${await text(lena, `#task-work-status-${la.drills}`)}`)
    check(await value(lena, `#task-work-text-${la.drills}`) === 'Exercise 1: u + v = (3, 1)\nExercise 2: 2u = (4, 2)' && (await stored(lena, recoveryKey(la.drills)))?.text.includes('Exercise 2'), 'the offline send lost the work or its local copy')
    check((await data(lena, `#task-history-${la.drills}`)).revisions === '0' && (await storedRevisions(la.drills)).length === 0 && (await api(lena, `${taskRoute(la.drills)}/submission`)).status === 404, 'the offline send appears submitted')
    pass('offline send', '"Not sent: the backend could not be reached"; text and link still editable and kept in this browser; no revision in the UI or PostgreSQL')

    // 4. Sending is confirmed by the backend and appears in the one Submission's history.
    await lena.click(`#task-work-send-${la.drills}`)
    await waitStatus(lena, la.drills, 'sent')
    check((await data(lena, work(la.drills))).sentRevision === '1' && (await text(lena, `#task-work-status-${la.drills}`)).startsWith('Sent as Revision 1'), 'the confirmation does not name Revision 1')
    let revisions = await history(lena, la.drills, 1)
    check(revisions[0].status === 'pending' && revisions[0].text.includes('Exercise 2: 2u = (4, 2)') && revisions[0].text.includes('https://notes.example/vectors-v1') && revisions[0].note === 'Waiting for your Coach\'s Review.', `history after sending: ${JSON.stringify(revisions)}`)
    check(JSON.stringify((await storedRevisions(la.drills)).map((r) => r.text)) === JSON.stringify(['Exercise 1: u + v = (3, 1)\nExercise 2: 2u = (4, 2)']) && await stored(lena, recoveryKey(la.drills)) === null, 'the sent revision is not stored exactly, or its local copy remains')
    const coachView = (await ok(carla, `${taskRoute(la.drills)}/submission`)).submission
    check(coachView.revisions.length === 1 && coachView.revisions[0].text.includes('Exercise 2'), 'the Coach does not see the sent revision')
    // Later draft edits never touch the sent revision.
    await typeInto(lena, `#task-work-text-${la.drills}`, '\nExercise 3: in progress')
    await lena.click(`#task-work-save-${la.drills}`)
    await waitStatus(lena, la.drills, 'saved')
    check(!(await storedRevisions(la.drills))[0].text.includes('Exercise 3') && !JSON.stringify(await ok(carla, `${taskRoute(la.drills)}/submission`)).includes('Exercise 3'), 'editing the draft changed the sent revision or reached the Coach')
    pass('send confirmed', 'Send → "Sent as Revision 1 … confirmed" and Revision 1 Awaiting Review in the history with its text and link, stored exactly; the Coach reads it; a later saved draft edit leaves Revision 1 unchanged and private')

    // 5. Corrections: a new revision supersedes a pending one; an Approval stays with its revision; reload keeps the history.
    await lena.click(`#task-work-send-${la.drills}`)
    await waitStatus(lena, la.drills, 'sent')
    revisions = await history(lena, la.drills, 2)
    check(revisions[0].status === 'superseded' && revisions[0].note.includes('Replaced by Revision 2') && revisions[1].status === 'pending', `after a second send: ${JSON.stringify(revisions)}`)
    const revisionIds = (await ok(carla, `${taskRoute(la.drills)}/submission`)).submission.revisions.map((r: any) => r.id)
    const supersededReview = await api(carla, `${taskRoute(la.drills)}/submission/revisions/${revisionIds[0]}/review`, 'POST', { decision: 'approval' })
    check(supersededReview.status === 409, `reviewing the superseded revision answered ${supersededReview.status}`)
    await ok(carla, `${taskRoute(la.drills)}/submission/revisions/${revisionIds[1]}/review`, 'POST', { decision: 'changes_requested', feedback: 'Show the working for exercise 3' })
    await lena.evaluate(() => window.dispatchEvent(new Event('focus')))
    await lena.waitForSelector(`#task-history-${la.drills} li[data-revision-number="2"][data-status="changes_requested"]`)
    revisions = await history(lena, la.drills, 2)
    check(revisions[1].text.includes('Show the working for exercise 3') && revisions[1].note.includes('send a correction as a new revision'), `feedback is not shown: ${JSON.stringify(revisions[1])}`)
    await typeInto(lena, `#task-work-text-${la.drills}`, 'Exercise 3: (1,2)·(3,4) = 1·3 + 2·4 = 11', true)
    await lena.click(`#task-work-send-${la.drills}`)
    await waitStatus(lena, la.drills, 'sent')
    revisions = await history(lena, la.drills, 3)
    const third = (await ok(carla, `${taskRoute(la.drills)}/submission`)).submission.revisions[2]
    check(third.text === 'Exercise 3: (1,2)·(3,4) = 1·3 + 2·4 = 11' && JSON.stringify(third.urls) === JSON.stringify(['https://notes.example/vectors-v1']), `the correction was not sent as typed: ${JSON.stringify(third)}`)
    await ok(carla, `${taskRoute(la.drills)}/submission/revisions/${third.id}/review`, 'POST', { decision: 'approval' })
    await lena.evaluate(() => window.dispatchEvent(new Event('focus')))
    await lena.waitForSelector('#enrollment-xp[data-xp="20"]')
    await lena.waitForSelector(`#task-history-${la.drills} li[data-revision-number="3"][data-status="approval"]`)
    await typeInto(lena, `#task-work-text-${la.drills}`, '\nAlso: the dot product is commutative.')
    await lena.click(`#task-work-send-${la.drills}`)
    await waitStatus(lena, la.drills, 'sent')
    revisions = await history(lena, la.drills, 4)
    check(revisions[2].status === 'approval' && revisions[3].status === 'pending' && revisions[3].note === 'Needs its own Review: it does not inherit the Approval of Revision 3, which still counts.', `after sending past an Approval: ${JSON.stringify(revisions.map((r) => [r.status, r.note]))}`)
    await lena.evaluate(() => window.dispatchEvent(new Event('focus')))
    await lena.waitForFunction(() => (document.querySelector('#enrollment-records') as HTMLElement).dataset.reading === 'false')
    check((await data(lena, '#enrollment-xp')).xp === '20' && (await data(lena, '#skill-mastery')).mastery === 'mastered', 'the new revision changed the earlier Approval\'s XP or Mastery')
    await openEnrollment(lena, enrollment)
    await canvasSelect(lena, la.vectors)
    revisions = await history(lena, la.drills, 4)
    check(JSON.stringify(revisions.map((r) => r.status)) === JSON.stringify(['superseded', 'changes_requested', 'approval', 'pending']), `history after reload: ${revisions.map((r) => r.status)}`)
    await draftReady(lena, la.drills)
    check(await value(lena, `#task-work-text-${la.drills}`) === 'Exercise 3: (1,2)·(3,4) = 1·3 + 2·4 = 11\nAlso: the dot product is commutative.', 'the draft after reload is not the last sent contents')
    await lena.$eval(work(la.drills), (el) => el.scrollIntoView({ block: 'start' }))
    await lena.screenshot({ path: path.resolve(FRONTEND, '../.harness/t22-learner-work.png') })
    pass('corrections and reload', 'Revision 2 superseded Revision 1 (whose Review the backend refuses) → Changes Requested feedback shown → correction sent as Revision 3 and approved (20 XP, Mastery) → Revision 4 pending "does not inherit the Approval of Revision 3", XP and Mastery kept; reload shows superseded/changes requested/approved/pending')

    // 6. Keyboard list without WebGPU: draft, send, correct and reload another Task; reuse evidence through a separate Submission.
    const noGpu = current = await newPage(learners, errors)
    await noGpu.evaluateOnNewDocument(() => {
      Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true })
    })
    await openEnrollment(noGpu, enrollment, 'unsupported')
    await keyboardSelect(noGpu, 1, la.matrices)
    await draftReady(noGpu, la.matrixDrills)
    check((await data(noGpu, work(la.matrixDrills))).canSend === 'false', 'an empty draft can be sent')
    await typeInto(noGpu, `#task-work-text-${la.matrixDrills}`, 'Matrix drills 11–20 answers')
    await noGpu.focus(`#task-work-add-url-${la.matrixDrills}`)
    await noGpu.keyboard.press('Enter')
    await typeInto(noGpu, `#task-work-url-${la.matrixDrills}-0`, 'notes.example/matrices')
    check((await text(noGpu, `#task-work-problem-${la.matrixDrills}`)).includes('not a full http(s) link') && (await data(noGpu, work(la.matrixDrills))).canSend === 'false', 'an invalid link is not explained before sending')
    await typeInto(noGpu, `#task-work-url-${la.matrixDrills}-0`, 'https://github.com/lena/la/blob/3f2c1e9/matrices.md', true)
    check((await text(noGpu, `#task-work-url-note-${la.matrixDrills}`)).includes('not a copy of the pages they lead to'), 'the link note does not explain that destinations are not frozen')
    await noGpu.focus(`#task-work-send-${la.matrixDrills}`)
    await noGpu.keyboard.press('Enter')
    await waitStatus(noGpu, la.matrixDrills, 'sent')
    await history(noGpu, la.matrixDrills, 1)
    const matrixFirst = (await ok(carla, `${taskRoute(la.matrixDrills)}/submission`)).submission.revisions[0]
    await ok(carla, `${taskRoute(la.matrixDrills)}/submission/revisions/${matrixFirst.id}/review`, 'POST', { decision: 'changes_requested', feedback: 'Exercise 14 is missing' })
    await noGpu.evaluate(() => window.dispatchEvent(new Event('focus')))
    await noGpu.waitForSelector(`#task-history-${la.matrixDrills} li[data-status="changes_requested"]`)
    await typeInto(noGpu, `#task-work-text-${la.matrixDrills}`, '\nExercise 14: AB ≠ BA here')
    await noGpu.focus(`#task-work-send-${la.matrixDrills}`)
    await noGpu.keyboard.press('Enter')
    await waitStatus(noGpu, la.matrixDrills, 'sent')
    await history(noGpu, la.matrixDrills, 2)
    // Reusing the same evidence for the reading Task goes into that Task's own Submission.
    await keyboardSelect(noGpu, 0, la.vectors)
    await draftReady(noGpu, la.reading)
    check((await text(noGpu, `#task-work-reuse-note-${la.reading}`)).includes('each Task has its own Submission and Review'), 'the reuse note is missing')
    await typeInto(noGpu, `#task-work-text-${la.reading}`, 'Same notes as my vector drills')
    await noGpu.focus(`#task-work-add-url-${la.reading}`)
    await noGpu.keyboard.press('Enter')
    await typeInto(noGpu, `#task-work-url-${la.reading}-0`, 'https://notes.example/vectors-v1')
    await noGpu.focus(`#task-work-send-${la.reading}`)
    await noGpu.keyboard.press('Enter')
    await waitStatus(noGpu, la.reading, 'sent')
    const readingRevisions = await history(noGpu, la.reading, 1)
    const readingSubmission = (await ok(carla, `${taskRoute(la.reading)}/submission`)).submission
    const drillsSubmission = (await ok(carla, `${taskRoute(la.drills)}/submission`)).submission
    const state = (await ok(noGpu, `/enrollments/${enrollment}/learning-state`)).learningState
    check(readingSubmission.id !== drillsSubmission.id && readingSubmission.revisions.length === 1 && readingRevisions[0].status === 'pending' && state.tasks.find((t: any) => t.taskId === la.reading).approved === false, 'reused evidence did not get its own pending Submission')
    await openEnrollment(noGpu, enrollment, 'unsupported')
    await keyboardSelect(noGpu, 1, la.matrices)
    const matrixRevisions = await history(noGpu, la.matrixDrills, 2)
    check(matrixRevisions[0].status === 'changes_requested' && matrixRevisions[1].text.includes('Exercise 14: AB ≠ BA here') && matrixRevisions[1].text.includes('https://github.com/lena/la/blob/3f2c1e9/matrices.md'), `keyboard history after reload: ${JSON.stringify(matrixRevisions)}`)
    pass('keyboard entry and reuse', 'without WebGPU, list → Matrices: invalid link explained, fixed-version link sent with Enter → Changes Requested → correction Revision 2 → reload keeps both; the same notes link sent for "Read chapter 1" made its own pending Submission, not approved by the drills\' Approval')

    // 7. Access failures: a Skill locked since the page was read, a locked Skill from the start, an inactive Enrollment.
    // A background tab is throttled, so the page acted on is brought to the front first (before the stale read is set up).
    current = lena
    await lena.bringToFront()
    await openEnrollment(lena, enrollment)
    await keyboardSelect(lena, 1, la.matrices)
    await draftReady(lena, la.matrixDrills)
    await typeInto(lena, `#task-work-text-${la.matrixDrills}`, '\nExercise 15: rank 2')
    check((await data(lena, work(la.matrixDrills))).canSend === 'true', 'the open Skill does not allow sending')
    const approvedThird = (await ok(carla, `${taskRoute(la.drills)}/submission`)).submission.revisions[2].id
    await ok(carla, `${taskRoute(la.drills)}/submission/revisions/${approvedThird}/review/revoke`, 'POST', { reason: 'Exercise 3 used the wrong vectors' })
    check((await data(lena, `#skill-access`)).access === 'open', 'the page re-read the records before the learner acted')
    await lena.click(`#task-work-send-${la.matrixDrills}`)
    await waitStatus(lena, la.matrixDrills, 'not-sent')
    check((await text(lena, `#task-work-status-${la.matrixDrills}`)).startsWith('Not sent: this Skill is locked now, and sending work needs Access. Nothing was submitted; your work is still here and saved as your private draft'), `locked status: ${await text(lena, `#task-work-status-${la.matrixDrills}`)}`)
    await lena.waitForSelector('#skill-access[data-access="locked"]')
    await lena.waitForSelector(`${work(la.matrixDrills)}[data-can-send="false"]`)
    check((await text(lena, `#task-work-blocked-${la.matrixDrills}`)).startsWith('This Skill is locked') && (await value(lena, `#task-work-text-${la.matrixDrills}`)).endsWith('Exercise 15: rank 2'), 'the locked Skill does not explain why sending is blocked, or lost the work')
    check((await storedRevisions(la.matrixDrills)).length === 2 && (await storedDraft(la.matrixDrills))?.text.endsWith('Exercise 15: rank 2') && (await history(lena, la.matrixDrills, 2)).length === 2, 'the refused send changed the history or lost the draft')
    // Pia's Matrices is locked from the start: no send offered, and the backend refuses one.
    const { context: piaContext, page: pia } = await newContext(browser, errors)
    current = pia
    const piaId = await signUpVerified(pia, 'pia@gurow.test')
    const piaEnrollment = await inviteAndAccept(carla, pia, la.versionId, 'pia@gurow.test')
    await openEnrollment(pia, piaEnrollment)
    await keyboardSelect(pia, 1, la.matrices)
    await draftReady(pia, la.matrixDrills)
    await typeInto(pia, `#task-work-text-${la.matrixDrills}`, 'Pia tries early')
    check((await data(pia, work(la.matrixDrills))).canSend === 'false' && await pia.$eval(`#task-work-send-${la.matrixDrills}`, (b) => (b as HTMLButtonElement).disabled), 'a locked Skill offers sending')
    const piaSend = await api(pia, `/enrollments/${piaEnrollment}/tasks/${la.matrixDrills}/submission/revisions`, 'POST', { text: 'Pia tries early', urls: [] })
    check(piaSend.status === 403 && piaSend.body.error === 'skill_locked', `locked send answered ${piaSend.status}`)
    // An inactive Enrollment offers no sending anywhere, while its drafts stay readable to the learner.
    current = lena
    await lena.bringToFront()
    await ok(carla, `/enrollments/${enrollment}/deactivate`, 'POST', { reason: 'Paused for the holidays' })
    await openEnrollment(lena, enrollment)
    await canvasSelect(lena, la.vectors)
    await draftReady(lena, la.drills)
    await typeInto(lena, `#task-work-text-${la.drills}`, '\nWhile inactive')
    check((await data(lena, work(la.drills))).canSend === 'false' && (await text(lena, `#task-work-blocked-${la.drills}`)).startsWith('This Enrollment is inactive'), 'the inactive Enrollment offers sending')
    check((await api(lena, `${taskRoute(la.drills)}/submission/revisions`, 'POST', { text: 'While inactive', urls: [] })).status === 403, 'the backend accepted a send from an inactive Enrollment')
    await ok(carla, `/enrollments/${enrollment}/reactivate`, 'POST', { reason: 'Back after the holidays' })
    pass('Access failures', 'Coach revoked the Vectors Approval behind the open page → Send on Matrices: "Not sent: this Skill is locked now…", the records re-read (locked, Send disabled with the reason), the draft kept and saved, history unchanged; Pia\'s locked Matrices offers no Send and the API answers 403 skill_locked; after deactivation Send is disabled with "This Enrollment is inactive" and the API refuses')

    // 8. Privacy: the Coach and a peer never receive unsent draft contents, including across Account switches in one browser.
    current = lena
    const secret = 'Unsent idea: use the rank-nullity theorem'
    await openEnrollment(lena, enrollment)
    await canvasSelect(lena, la.vectors)
    await draftReady(lena, la.drills)
    await typeInto(lena, `#task-work-text-${la.drills}`, secret, true)
    check((await stored(lena, recoveryKey(la.drills)))?.text === secret, 'the unsent idea is not kept for recovery')
    // The owning Coach's view: no draft fields, no draft requests, no unsent text.
    current = carla
    await carla.bringToFront()
    const coachRequests: string[] = []
    carla.on('request', (request) => coachRequests.push(request.url()))
    await openEnrollment(carla, enrollment)
    await canvasSelect(carla, la.vectors)
    await carla.waitForSelector(`#task-history-${la.drills}[data-state="ready"]`)
    await keyboardSelect(carla, 1, la.matrices)
    await carla.waitForSelector(`#task-history-${la.matrixDrills}[data-state="ready"]`)
    const coachPage = await text(carla, 'main')
    check(await carla.$('[data-task-work]') === null && !coachRequests.some((url) => url.includes('/draft')), `the Coach view offers drafts or requested them: ${coachRequests.filter((u) => u.includes('/draft'))}`)
    check(!coachPage.includes(secret) && !coachPage.includes('Exercise 15: rank 2') && !coachPage.includes('While inactive'), 'the Coach view shows unsent draft contents')
    const coachDraftReads = await Promise.all([la.drills, la.reading, la.matrixDrills].map((task) => api(carla, `${taskRoute(task)}/draft`)))
    check(coachDraftReads.every((r) => r.status === 403 && !JSON.stringify(r.body).includes('Exercise')), `Coach draft reads: ${coachDraftReads.map((r) => r.status)}`)
    // Account switch in Lena's browser: another tab signs in as Pia (and tells the other tabs, as the app's sign-in does).
    current = lena
    const tabB = await newPage(learners, errors)
    await tabB.goto(`${ORIGIN}/learning`, { waitUntil: 'networkidle0' })
    await tabB.evaluate(async (email: string, password: string) => {
      const response = await fetch('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
      if (!response.ok) throw new Error(`sign-in answered ${response.status}`)
      new BroadcastChannel('gurow:session').postMessage('changed')
    }, 'pia@gurow.test', PASSWORD)
    await lena.bringToFront()
    await lena.waitForSelector('#enrollment-unavailable')
    check(!(await text(lena, 'main')).includes(secret) && !(await text(lena, 'main')).includes('Exercise'), 'Lena\'s open tab kept her draft after the Account switch')
    await tabB.close()
    await openEnrollment(lena, piaEnrollment)
    await canvasSelect(lena, la.vectors)
    await draftReady(lena, la.drills)
    check(await value(lena, `#task-work-text-${la.drills}`) === '' && await lena.$(`#task-work-recovered-${la.drills}`) === null && !(await text(lena, 'main')).includes(secret), 'Pia sees Lena\'s recovered draft')
    const piaReads = await Promise.all([`${taskRoute(la.drills)}/draft`, `${taskRoute(la.matrixDrills)}/draft`, `${taskRoute(la.drills)}/submission`].map((r) => api(lena, r)))
    check(piaReads.every((r) => r.status === 404 && r.body.error === 'enrollment_not_found'), `Pia's reads of Lena's work: ${piaReads.map((r) => r.status)}`)
    check((await stored(lena, recoveryKey(la.drills)))?.text === secret && await stored(lena, recoveryKey(la.drills, piaId, piaEnrollment)) === null, 'the Account switch changed or copied Lena\'s recovery data')
    await signOut(lena)
    await authenticate(lena, 'sign-in', 'lena@gurow.test')
    await openEnrollment(lena, enrollment)
    await canvasSelect(lena, la.vectors)
    await draftReady(lena, la.drills)
    check(await lena.$(`#task-work-recovered-${la.drills}`) !== null && await value(lena, `#task-work-text-${la.drills}`) === secret, 'Lena did not get her unsent edits back')
    await piaContext.close()
    pass('privacy', 'owning Coach: no draft fields, no /draft request, none of the unsent or saved draft text on the page, 403 on every draft; Pia signing in from another tab turned Lena\'s open page into "not available"; in the same browser Pia\'s own composer is empty and Lena\'s work answers 404; Lena signing back in recovers her unsent edits')

    // 9. A send whose answer is lost is not reported as unsent: the history decides, and sending again waits for it.
    current = lena
    const sendRoute = `${taskRoute(la.reading)}/submission/revisions`
    const faults = { commitThenDrop: 0, dropSend: 0, dropHistory: 0 }
    await lena.setRequestInterception(true)
    const intercept = async (request: import('puppeteer-core').HTTPRequest) => {
      const url = new URL(request.url()).pathname
      if (request.method() === 'POST' && url === `/api${sendRoute}` && faults.commitThenDrop > 0) {
        faults.commitThenDrop--
        // The backend commits the revision; the browser never gets the answer.
        const cookie = (await lena.cookies()).map((c) => `${c.name}=${c.value}`).join('; ')
        const committed = await fetch(request.url(), { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: request.postData() })
        check(committed.status === 201, `the forwarded send answered ${committed.status}`)
        return request.abort('connectionreset')
      }
      if (request.method() === 'POST' && url === `/api${sendRoute}` && faults.dropSend > 0) {
        faults.dropSend--
        return request.abort('connectionreset')
      }
      if (request.method() === 'GET' && url === `/api${taskRoute(la.reading)}/submission` && faults.dropHistory > 0) {
        faults.dropHistory--
        return request.abort('connectionreset')
      }
      return request.continue()
    }
    lena.on('request', (request) => void intercept(request))
    await openEnrollment(lena, enrollment)
    await canvasSelect(lena, la.vectors)
    await draftReady(lena, la.reading)
    await history(lena, la.reading, 1)
    await typeInto(lena, `#task-work-text-${la.reading}`, '\nPages 1–12 summarised')
    faults.commitThenDrop = 1
    await lena.click(`#task-work-send-${la.reading}`)
    await waitStatus(lena, la.reading, 'sent')
    w = await data(lena, work(la.reading))
    check(faults.commitThenDrop === 0 && w.confirmedBy === 'history' && w.sentRevision === '2' && (await text(lena, `#task-work-status-${la.reading}`)).includes('the answer was lost, but your submitted work shows it'), `lost answer after commit: ${JSON.stringify(w)} ${await text(lena, `#task-work-status-${la.reading}`)}`)
    revisions = await history(lena, la.reading, 2)
    check((await storedRevisions(la.reading)).length === 2 && revisions[1].text.includes('Pages 1–12 summarised'), 'the committed revision is missing or duplicated')
    // The send never arrives and the history cannot be read at first: nothing is claimed, and sending again waits.
    await typeInto(lena, `#task-work-text-${la.reading}`, '\nPage 13 too')
    faults.dropSend = 1
    faults.dropHistory = 1
    await lena.click(`#task-work-send-${la.reading}`)
    await waitStatus(lena, la.reading, 'unconfirmed')
    let unconfirmed = await text(lena, `#task-work-status-${la.reading}`)
    w = await data(lena, work(la.reading))
    check(w.checked === 'false' && w.canSend === 'false' && unconfirmed.includes('may or may not have arrived') && !unconfirmed.includes('Nothing was submitted') && unconfirmed.includes('sending again is paused'), `unconfirmed, history unread: ${JSON.stringify(w)} ${unconfirmed}`)
    check((await value(lena, `#task-work-text-${la.reading}`)).endsWith('Page 13 too') && (await storedRevisions(la.reading)).length === 2, 'the lost send lost the work or reached the backend')
    await lena.click(`#task-work-check-${la.reading}`)
    await lena.waitForSelector(`${work(la.reading)}[data-checked="true"]`)
    unconfirmed = await text(lena, `#task-work-status-${la.reading}`)
    check((await data(lena, work(la.reading))).canSend === 'true' && unconfirmed.includes('it is not in your submitted work below') && !unconfirmed.includes('Nothing was submitted'), `unconfirmed after the check: ${unconfirmed}`)
    await lena.click(`#task-work-send-${la.reading}`)
    await waitStatus(lena, la.reading, 'sent')
    check((await data(lena, work(la.reading))).confirmedBy === 'answer' && (await data(lena, work(la.reading))).sentRevision === '3', 'sending again was not confirmed as Revision 3')
    revisions = await history(lena, la.reading, 3)
    check(JSON.stringify((await storedRevisions(la.reading)).map((r) => r.superseded)) === JSON.stringify([true, true, false]) && revisions[2].text.includes('Page 13 too'), `the revisions after the lost answers are not the expected three: ${JSON.stringify(await storedRevisions(la.reading))} / ${JSON.stringify(revisions)}`)
    lena.removeAllListeners('request')
    await lena.setRequestInterception(false)
    pass('lost answers', 'POST committed but its answer dropped → "Sent as Revision 2 … the answer was lost, but your submitted work shows it", one stored revision; POST and the history read dropped → "Not confirmed … may or may not have arrived", Send paused, work kept, no "Nothing was submitted"; Check again → "not in your submitted work", Send enabled → Revision 3; three revisions stored, no duplicate')

    check(errors.length === 0, `page errors: ${errors.join('; ')}`)
    console.log(`\nT22 learner work check passed (${steps.length} steps).`)
  } catch (error) {
    const shot = path.resolve(FRONTEND, '../.harness/t22-failure.png')
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
  console.error(`\nT22 learner work check FAILED after ${steps.length} steps: ${error instanceof Error ? `${error.message}\n${error.stack}` : error}`)
  process.exit(1)
})
