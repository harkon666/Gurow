#!/usr/bin/env bun
/**
 * T24 Approval correction check (#25): the production frontend build forwarding /api to
 * the production backend entry (Better Auth sessions) on a freshly migrated PostgreSQL
 * database, with email through the Resend HTTP mailer to a local stand-in. Real Accounts:
 * Carla publishes a Version and invites Lena and Pia, who verify and accept. Lena's work
 * is approved (decisions are T23's UI; set up here through the API), then Carla revokes
 * Approvals from the history in the UI: only she can, only with a reason, and only the
 * backend's confirmation shows it. Revoking one of two valid Approvals keeps the Task's
 * contribution and Mastery; revoking the final one corrects them, and Matrices loses
 * Access while keeping its own Mastery; both Carla and Lena read why. A later Approval
 * restores the reward once. A revocation already made in another tab is refused and
 * re-read, a lost answer is reconciled with the history, and everything survives reload.
 *
 * Run from frontend: bun run scripts/t24-correct-approval-check.ts [--skip-build]
 */
import { SQL } from 'bun'
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import puppeteer, { type Browser, type BrowserContext, type Page } from 'puppeteer-core'
import { startResendStandIn } from '../../backend/test/support/resend-stand-in'
import { resolveChromiumExecutable, waitForServerReady } from './benchmark/browser'
import { openSkillList, readCardProgress, openTask, openSkillView } from './editor-navigation'

const FRONTEND = path.resolve(import.meta.dir, '..')
const BACKEND = path.resolve(FRONTEND, '../backend')
const PORT = Number(process.env.PORT ?? 3525)
const API_PORT = Number(process.env.API_PORT ?? 3526)
const ORIGIN = `http://127.0.0.1:${PORT}`
const SECRET = 't24-browser-check-secret-not-for-production'
const DATABASE_URL = process.env.T24_DATABASE_URL ?? 'postgres://gurow:gurow@127.0.0.1:5433/gurow_t24_browser_test'
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

const revocation = (revisionId: string) => `#revocation-${revisionId}`
async function waitRevocation(page: Page, revisionId: string, kind: string) {
  await page.waitForSelector(`${revocation(revisionId)}[data-status="${kind}"]`).catch(async () => {
    const panel = await page.$(revocation(revisionId))
    throw new Error(`revocation of ${revisionId} did not reach ${kind} (${panel ? `${JSON.stringify(await data(page, revocation(revisionId)))}: ${await text(page, revocation(revisionId))}` : 'no revocation control'})`)
  })
}
/** Reads the records again as returning to the page does, and waits until every read has answered. */
async function revisit(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForFunction(() => (document.querySelector('#enrollment-records') as HTMLElement | null)?.dataset.reading === 'false')
  await page.waitForNetworkIdle({ idleTime: 250 })
}
/** The lines explaining what a revocation changed, as shown under the revision. */
const effect = (page: Page, revisionId: string) => page.$$eval(`#revision-revocation-${revisionId} .revocation-effect li`, (els) => els.map((el) => el.textContent?.trim() ?? ''))
const xpLines = async (page: Page, taskId: string) => {
  await at(page, taskId)
  return page.$$eval(`#task-xp-history-${taskId} li`, (els) => els.map((el) => (el.textContent ?? '').split(' · ')[0]))
}
/** The selected Skill's Mastery history, from its History view. */
const masteryLines = async (page: Page) => {
  await openSkillView(page, 'history')
  return page.$$eval('#skill-mastery-history li', (els) => els.map((el) => (el.textContent ?? '').split(' · ')[0]))
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

    const { page: carla } = await newContext(browser, errors)
    await act(carla)
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
    const storedReviews = async (task: string) => [...await sql`select r.revision_number as revision, v.decision, v.feedback, v.decided_at::text as decided, v.revocation_reason as reason, v.revoked_at is not null as revoked from submission_reviews v join submission_revisions r on r.id = v.revision_id join submissions s on s.id = r.submission_id where s.enrollment_id = ${enrollment} and s.task_id = ${task} order by r.revision_number`].map((row: any) => ({ revision: row.revision, decision: row.decision, feedback: row.feedback, decided: row.decided, reason: row.reason, revoked: row.revoked }))
    const xpEvents = async () => [...await sql`select e.task_id, e.kind, e.amount, r.revision_number from xp_events e join submission_revisions r on r.id = e.revision_id where e.enrollment_id = ${enrollment} order by e.id`].map((row: any) => [row.task_id, row.kind, row.amount, row.revision_number])
    const masteryEvents = async () => [...await sql`select e.skill_id, e.action, r.revision_number from mastery_events e join submission_revisions r on r.id = e.revision_id where e.enrollment_id = ${enrollment} order by e.id`].map((row: any) => [row.skill_id, row.action, row.revision_number])
    const send = async (task: string, body: string) => (await ok(lena, `${taskRoute(task)}/submission/revisions`, 'POST', { text: body, urls: [] })).revision.id as string
    const approve = (task: string, revisionId: string) => ok(carla, `${taskRoute(task)}/submission/revisions/${revisionId}/review`, 'POST', { decision: 'approval' })
    const revokeRoute = (task: string, revisionId: string) => `${taskRoute(task)}/submission/revisions/${revisionId}/review/revoke`
    const progress = async (page: Page) => ({
      xp: (await data(page, '#enrollment-xp')).xp,
      vectors: await readCardProgress(page, la.vectors),
      matrices: await readCardProgress(page, la.matrices),
    })
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
    const revisionStatus = (page: Page, revisionId: string) => page.$eval(`#revision-${revisionId}`, (el) => (el as HTMLElement).dataset.status)

    // Revocations can be held, or committed with their answer dropped, and the records read held, on Carla's page.
    const faults = { hold: null as null | (() => void), holding: false, commitThenDrop: 0, holdRecords: false, heldRecords: null as null | import('puppeteer-core').HTTPRequest }
    await carla.setRequestInterception(true)
    carla.on('request', (request) => void (async () => {
      const isRevocation = request.method() === 'POST' && /\/submission\/revisions\/[^/]+\/review\/revoke$/.test(new URL(request.url()).pathname)
      if (request.method() === 'GET' && new URL(request.url()).pathname.endsWith('/learning-state') && faults.holdRecords) {
        faults.holdRecords = false
        faults.heldRecords = request
        return
      }
      if (isRevocation && faults.holding) {
        await new Promise<void>((release) => { faults.hold = release })
        return request.continue()
      }
      if (isRevocation && faults.commitThenDrop > 0) {
        faults.commitThenDrop--
        const cookie = (await carla.cookies()).map((c) => `${c.name}=${c.value}`).join('; ')
        const committed = await fetch(request.url(), { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: request.postData() })
        check(committed.status === 200, `the forwarded revocation answered ${committed.status}`)
        return request.abort('connectionreset')
      }
      return request.continue()
    })())

    // 1. Lena's work earns two valid Approvals of Vector drills and one of Matrix drills (decisions are T23's UI; here through the API).
    const r1 = await send(la.drills, 'Exercise 1: u + v = (3, 1)')
    await approve(la.drills, r1)
    const r2 = await send(la.drills, 'Exercise 1, with the working shown')
    await approve(la.drills, r2)
    const m1 = await send(la.matrixDrills, 'Matrix drills 11–20: all answers with working')
    await approve(la.matrixDrills, m1)
    check(same(await xpEvents(), [[la.drills, 'award', 20, 1], [la.matrixDrills, 'award', 15, 1]]) && same(await masteryEvents(), [[la.vectors, 'award', 1], [la.matrices, 'award', 1]]), `setup events: ${JSON.stringify([await xpEvents(), await masteryEvents()])}`)
    const original = await storedReviews(la.drills)
    await act(carla)
    await openEnrollment(carla, enrollment)
    await keyboardSelect(carla, 0, la.vectors)
    let revisions = await history(carla, la.drills, 2)
    check(same(revisions.map((r) => r.status), ['approval', 'approval']) && same(await progress(carla), { xp: '35', vectors: ['open', 'mastered'], matrices: ['open', 'mastered'] }), `Carla's start: ${JSON.stringify([revisions.map((r) => r.status), await progress(carla)])}`)
    check(await carla.$(`#revoke-open-${r1}`) !== null && await carla.$(`#revoke-open-${r2}`) !== null, 'Carla\'s approved revisions offer no revocation')
    pass('setup', 'drills Revisions 1 and 2 approved, Matrix drills Revision 1 approved: 35 XP, Vectors and Matrices mastered; each approved revision on Carla\'s page offers "Revoke Approval of Revision n…"')

    // 2. Only the owning Coach can revoke, and only with a reason; nothing else records anything.
    await act(lena)
    await openEnrollment(lena, enrollment)
    await keyboardSelect(lena, 0, la.vectors)
    await history(lena, la.drills, 2)
    check(await lena.$('[data-approval-revocation]') === null && await lena.$('[id^="revoke-open-"]') === null, 'Lena\'s page offers a revocation')
    const selfRevoke = await api(lena, revokeRoute(la.drills, r1), 'POST', { reason: 'I disagree' })
    check(selfRevoke.status === 403 && selfRevoke.body?.error === 'coach_only', `Lena's revocation answered ${selfRevoke.status}`)
    await act(pia)
    const peerRevoke = await api(pia, revokeRoute(la.drills, r1), 'POST', { reason: 'Peer correction' })
    const peerHistory = await api(pia, `${taskRoute(la.drills)}/submission`)
    const peerRecords = await api(pia, `/enrollments/${enrollment}/learning-state`)
    check(peerRevoke.status === 404 && peerHistory.status === 404 && peerRecords.status === 404, `Pia's revocation/history/records answered ${peerRevoke.status}/${peerHistory.status}/${peerRecords.status}`)
    await openEnrollment(pia, piaEnrollment)
    check(await pia.$('[data-approval-revocation]') === null, 'Pia\'s own Enrollment offers a revocation')
    await act(carla)
    await carla.click(`#revoke-open-${r1}`)
    await carla.waitForFunction((id: string) => document.activeElement?.id === id, {}, `revoke-reason-${r1}`)
    let control = await data(carla, revocation(r1))
    check(control.canRevoke === 'false' && (await text(carla, `#revoke-hint-${r1}`)).includes('needs a reason'), `revocation offered without a reason: ${JSON.stringify(control)}`)
    await typeInto(carla, `#revoke-reason-${r1}`, '   ')
    check((await data(carla, revocation(r1))).canRevoke === 'false', 'a blank reason allows the revocation')
    const blank = await api(carla, revokeRoute(la.drills, r1), 'POST', { reason: '  ' })
    check(blank.status === 422 && blank.body?.error === 'invalid_revocation', `a blank reason answered ${blank.status}`)
    check(same(await storedReviews(la.drills), original) && original.every((r) => !r.revoked), 'a refused revocation changed the stored Reviews')
    pass('authority and reason', 'Lena\'s page has no revocation and her API call answers 403 coach_only; Pia gets 404 for the revocation, the history and the records, and her own page has none; Carla\'s "Revoke" stays disabled ("needs a reason") for an empty and blank reason, which the API refuses 422; nothing stored')

    // 3. Revoking one of two valid Approvals: shown only once confirmed, then explained as kept by the other Approval.
    const outlook1 = await text(carla, `#revoke-outlook-${r1}`)
    check(outlook1.includes('The Approval of Revision 2 also counts, so this Task keeps its 20 XP contribution and its evidence for Mastery of “Vectors”.'), `outlook for Revision 1: ${outlook1}`)
    const reason1 = 'Revision 1 was graded against the wrong answer key.'
    await typeInto(carla, `#revoke-reason-${r1}`, reason1, true)
    check((await data(carla, revocation(r1))).canRevoke === 'true', 'a reason did not enable the revocation')
    faults.holding = true
    await carla.click(`#revoke-confirm-${r1}`)
    await waitRevocation(carla, r1, 'recording')
    for (let i = 0; i < 50 && !faults.hold; i++) await new Promise((r) => setTimeout(r, 20))
    check(faults.hold, 'the revocation request was not held')
    await new Promise((r) => setTimeout(r, 400))
    check((await text(carla, `#revoke-status-${r1}`)).startsWith('Revoking the Approval of Revision 1') && await revisionStatus(carla, r1) === 'approval' && await carla.$(`#revision-revocation-${r1}`) === null && same(await progress(carla), { xp: '35', vectors: ['open', 'mastered'], matrices: ['open', 'mastered'] }), 'a revocation was shown before the backend confirmed it')
    check((await storedReviews(la.drills)).every((r) => !r.revoked), 'the held revocation reached the backend')
    faults.holding = false
    faults.hold!()
    await waitRevocation(carla, r1, 'recorded')
    await carla.waitForSelector(`${revocation(r1)}[data-refresh="read"]`)
    const recorded1 = await text(carla, `#revoke-status-${r1}`)
    check(recorded1.startsWith('Revocation of the Approval of Revision 1 recorded, confirmed by Gurow') && recorded1.includes('The original Approval stays in the history') && recorded1.includes('as Gurow derived them after it') && (await data(carla, revocation(r1))).confirmedBy === 'answer', `status after revoking Revision 1: ${recorded1}`)
    await carla.waitForSelector(`#revision-${r1}[data-status="approval_revoked"]`)
    check((await text(carla, `#revision-${r1}`)).includes(`Approval revoked`) && (await text(carla, `#revision-${r1}`)).includes(reason1) && (await text(carla, `#revision-${r1}`)).includes('Approval decided'), 'the revoked revision does not keep its decision and show the reason')
    check(same(await effect(carla, r1), ['The Approval of Revision 2 still counted, so this Task kept its 20 XP contribution and its evidence for Mastery of “Vectors”; nothing was corrected.']), `Carla's effect of revoking Revision 1: ${JSON.stringify(await effect(carla, r1))}`)
    check(same(await progress(carla), { xp: '35', vectors: ['open', 'mastered'], matrices: ['open', 'mastered'] }) && await carla.$(`#revoke-open-${r1}`) === null && await carla.$(`#revoke-open-${r2}`) !== null, `Carla's progress after revoking Revision 1: ${JSON.stringify(await progress(carla))}`)
    let stored = await storedReviews(la.drills)
    check(stored[0].revoked && stored[0].reason === reason1 && stored[0].decision === 'approval' && stored[0].decided === original[0].decided && same(stored[1], original[1]), `stored after revoking Revision 1: ${JSON.stringify(stored)}`)
    check(same(await xpEvents(), [[la.drills, 'award', 20, 1], [la.matrixDrills, 'award', 15, 1]]) && same(await masteryEvents(), [[la.vectors, 'award', 1], [la.matrices, 'award', 1]]), 'revoking one of two Approvals recorded an XP or Mastery change')
    await act(lena)
    await revisit(lena)
    await lena.waitForSelector(`#revision-${r1}[data-status="approval_revoked"]`)
    check((await text(lena, `#revision-${r1}`)).includes(reason1) && same(await effect(lena, r1), await effect(carla, r1)) && same(await progress(lena), { xp: '35', vectors: ['open', 'mastered'], matrices: ['open', 'mastered'] }), `Lena's view of the first revocation: ${JSON.stringify(await effect(lena, r1))}`)
    pass('one of two Approvals', 'outlook "Revision 2 also counts…"; with the request held: "Revoking…", Revision 1 still approved, 35 XP, nothing stored; once confirmed: "recorded … original Approval stays", Revision 1 revoked with its reason and decision kept, "Revision 2 still counted … nothing was corrected" for Carla and Lena; 35 XP, both Masteries, no XP or Mastery events')

    // 4. Revoking the final Approval corrects XP and Mastery; Matrices loses Access but keeps its own Mastery.
    await act(carla)
    await carla.click(`#revoke-open-${r2}`)
    const outlook2 = await text(carla, `#revoke-outlook-${r2}`)
    check(outlook2.includes('This is the Task\'s only valid Approval: revoking it removes its 20 XP and its evidence for Mastery of “Vectors” until another revision is approved.'), `outlook for Revision 2: ${outlook2}`)
    const reason2 = 'Revision 2 copies the solution manual.'
    await typeInto(carla, `#revoke-reason-${r2}`, reason2)
    // The records read after the confirmation is held: the revocation is confirmed, its corrected progress not yet claimed.
    faults.holdRecords = true
    await carla.click(`#revoke-confirm-${r2}`)
    await waitRevocation(carla, r2, 'recorded')
    for (let i = 0; i < 100 && !faults.heldRecords; i++) await new Promise((r) => setTimeout(r, 20))
    check(faults.heldRecords, 'the records read after the revocation was not held')
    const reading2 = await text(carla, `#revoke-status-${r2}`)
    check((await data(carla, revocation(r2))).refresh === 'reading' && reading2.includes('Reading the corrected XP, Mastery and Access') && !reading2.includes('derived them after it') && (await data(carla, '#enrollment-xp')).xp === '35', `while the records are read: ${reading2}`)
    // The history read meanwhile already explains the revocation from its own snapshot, not from the stale records.
    await carla.waitForSelector(`#revision-${r2}[data-status="approval_revoked"]`)
    const whileStale = await effect(carla, r2)
    check(same(whileStale, ['It was this Task\'s last valid Approval: its 20 XP were removed by an XP Correction.', 'Mastery of “Vectors” was revoked; its award stays in the Mastery history.'])
      && !whileStale.join(' ').includes('no Mastery changed') && (await readCardProgress(carla, la.vectors))[1] === 'mastered', `effect with the history read and the records held: ${JSON.stringify(whileStale)}`)
    await faults.heldRecords!.continue()
    await carla.waitForSelector(`${revocation(r2)}[data-refresh="read"]`)
    await carla.waitForSelector('#enrollment-xp[data-xp="15"]')
    check(same(await progress(carla), { xp: '15', vectors: ['open', 'not-mastered'], matrices: ['locked', 'mastered'] }), `Carla's progress after the final revocation: ${JSON.stringify(await progress(carla))}`)
    const finalEffect = [
      'It was this Task\'s last valid Approval: its 20 XP were removed by an XP Correction.',
      'Mastery of “Vectors” was revoked; its award stays in the Mastery history.',
      '“Matrices” requires Mastery of “Vectors”, so it is locked now; its own Mastery, supported by its own Approvals, stays.',
    ]
    await carla.waitForSelector(`#revision-${r2}[data-status="approval_revoked"]`)
    check(same(await effect(carla, r2), finalEffect), `Carla's effect of the final revocation: ${JSON.stringify(await effect(carla, r2))}`)
    await at(carla, la.drills)
    await carla.waitForSelector(`#task-learning-${la.drills}[data-approved="false"][data-xp-contribution="0"]`)
    check(same(await xpLines(carla, la.drills), ['Awarded +20 XP: Approval of Revision 1', 'Corrected −20 XP: the Approval of Revision 2 was revoked']), `drills XP history: ${JSON.stringify(await xpLines(carla, la.drills))}`)
    check(same(await masteryLines(carla), ['Mastered: Approval of “Vector drills” Revision 1', 'Mastery revoked: the Approval of “Vector drills” Revision 2 was revoked']), `Vectors Mastery history: ${JSON.stringify(await masteryLines(carla))}`)
    check(same(await xpEvents(), [[la.drills, 'award', 20, 1], [la.matrixDrills, 'award', 15, 1], [la.drills, 'correction', -20, 2]]) && same(await masteryEvents(), [[la.vectors, 'award', 1], [la.matrices, 'award', 1], [la.vectors, 'revocation', 2]]), `stored events after the final revocation: ${JSON.stringify([await xpEvents(), await masteryEvents()])}`)
    stored = await storedReviews(la.drills)
    check(stored.every((r) => r.revoked && r.decision === 'approval') && stored[1].reason === reason2 && stored[1].decided === original[1].decided, `stored Reviews after the final revocation: ${JSON.stringify(stored)}`)
    // Matrices: Access and its lock reasons apart from its own Mastery, for both.
    await keyboardSelect(carla, 1, la.matrices)
    const matricesView = async (page: Page) => ({
      access: await text(page, '#skill-access-state'), reasons: await text(page, '#lock-reasons'),
      mastery: await text(page, '#skill-mastery-state'), kept: await page.$('#skill-mastery-kept') !== null,
      history: await masteryLines(page),
    })
    const expectedMatrices = (v: Awaited<ReturnType<typeof matricesView>>) => v.access === 'Locked' && v.reasons.includes('Requires Mastery of “Vectors”') && v.reasons.includes('Needs 5 more XP: the threshold is 20 XP and this Enrollment has 15 XP')
      && v.mastery === 'Mastered' && v.kept && same(v.history, ['Mastered: Approval of “Matrix drills” Revision 1'])
    check(expectedMatrices(await matricesView(carla)), `Carla's Matrices: ${JSON.stringify(await matricesView(carla))}`)
    await act(lena)
    await revisit(lena)
    await lena.waitForSelector('#enrollment-xp[data-xp="15"]')
    check(same(await progress(lena), { xp: '15', vectors: ['open', 'not-mastered'], matrices: ['locked', 'mastered'] }) && same(await effect(lena, r2), finalEffect), `Lena after the final revocation: ${JSON.stringify([await progress(lena), await effect(lena, r2)])}`)
    await keyboardSelect(lena, 1, la.matrices)
    check(expectedMatrices(await matricesView(lena)), `Lena's Matrices: ${JSON.stringify(await matricesView(lena))}`)
    await lena.screenshot({ path: path.resolve(FRONTEND, '../.harness/t24-learner-correction.png') })
    pass('final Approval', 'outlook "only valid Approval: … removes its 20 XP and its evidence for Mastery"; with the records read held: "recorded" + "Reading the corrected…", XP 35 unclaimed, while the history read already explains the XP Correction and Mastery revocation (no "no Mastery changed"); then 15 XP, Vectors not mastered, Matrices locked ("Requires Mastery of “Vectors”", "Needs 5 more XP") but Mastered ("its Mastery stays"); the effect (XP Correction, Mastery revoked, Matrices locked keeping its Mastery), XP and Mastery histories shown to both; events: −20 correction and a Vectors revocation caused by Revision 2')

    // 5. A later Approval restores the contribution once, and the history stays readable.
    await keyboardSelect(lena, 0, la.vectors)
    check(await sendFromUi(lena, la.drills, 'Exercise 1, redone from the definitions', true) === 3, 'the corrected work is not Revision 3')
    const r3 = (await ok(lena, `${taskRoute(la.drills)}/submission`)).submission.revisions[2].id as string
    await act(carla)
    await revisit(carla)
    await keyboardSelect(carla, 0, la.vectors)
    await at(carla, la.drills)
    await carla.waitForSelector(`#task-review-${la.drills}[data-target-revision="3"]`)
    await at(carla, la.drills)
    await carla.click(`#task-review-approve-${la.drills}`)
    await at(carla, la.drills)
    await carla.waitForSelector(`#task-review-${la.drills}[data-status="recorded"][data-refresh="read"]`)
    await carla.waitForSelector('#enrollment-xp[data-xp="35"]')
    check(same(await progress(carla), { xp: '35', vectors: ['open', 'mastered'], matrices: ['open', 'mastered'] }), `Carla after the restoring Approval: ${JSON.stringify(await progress(carla))}`)
    check(same(await xpLines(carla, la.drills), ['Awarded +20 XP: Approval of Revision 1', 'Corrected −20 XP: the Approval of Revision 2 was revoked', 'Restored +20 XP: Approval of Revision 3']), `drills XP history after restoration: ${JSON.stringify(await xpLines(carla, la.drills))}`)
    check(same(await masteryLines(carla), ['Mastered: Approval of “Vector drills” Revision 1', 'Mastery revoked: the Approval of “Vector drills” Revision 2 was revoked', 'Mastered: Approval of “Vector drills” Revision 3']), `Vectors Mastery history after restoration: ${JSON.stringify(await masteryLines(carla))}`)
    check(same(await xpEvents(), [[la.drills, 'award', 20, 1], [la.matrixDrills, 'award', 15, 1], [la.drills, 'correction', -20, 2], [la.drills, 'correction', 20, 3]]) && same(await masteryEvents(), [[la.vectors, 'award', 1], [la.matrices, 'award', 1], [la.vectors, 'revocation', 2], [la.vectors, 'award', 3]]), `stored events after restoration: ${JSON.stringify([await xpEvents(), await masteryEvents()])}`)
    revisions = await history(carla, la.drills, 3)
    check(same(revisions.map((r) => r.status), ['approval_revoked', 'approval_revoked', 'approval']) && revisions[0].text.includes(reason1) && revisions[1].text.includes(reason2), 'the revoked revisions are not readable beside the new Approval')
    await act(lena)
    await revisit(lena)
    await lena.waitForSelector('#enrollment-xp[data-xp="35"]')
    check(same(await progress(lena), { xp: '35', vectors: ['open', 'mastered'], matrices: ['open', 'mastered'] }) && same(await xpLines(lena, la.drills), await xpLines(carla, la.drills)), `Lena after restoration: ${JSON.stringify(await progress(lena))}`)
    pass('restoration', 'Lena\'s Revision 3 approved in the Review → 35 XP, Vectors mastered, Matrices open; XP history "Awarded +20 (1) / Corrected −20 (2 revoked) / Restored +20 (3)" and Mastery history award/revoked/award for both; one award event per Task, no duplicate reward; revoked revisions and reasons stay readable')

    // 6. Another tab revoked first: refused and re-read. A lost answer: the history confirms it, and nothing doubles.
    const r4 = await send(la.drills, 'Exercise 1, typeset')
    await approve(la.drills, r4)
    await act(carla)
    await revisit(carla)
    await carla.waitForSelector(`#revision-${r4}[data-status="approval"]`)
    await carla.click(`#revoke-open-${r3}`)
    const otherTab = 'Revoked from the other tab: wrong exercise.'
    await ok(carla, revokeRoute(la.drills, r3), 'POST', { reason: otherTab })
    await typeInto(carla, `#revoke-reason-${r3}`, 'Revision 3 skips a step.')
    await carla.click(`#revoke-confirm-${r3}`)
    await waitRevocation(carla, r3, 'refused')
    await carla.waitForSelector(`${revocation(r3)}[data-refresh="read"]`)
    const refused = await text(carla, `#revoke-status-${r3}`)
    check(refused.startsWith('Not revoked: the Approval of Revision 3 was already revoked (perhaps from another tab)') && refused.includes('Nothing changed') && refused.includes('The history and progress shown were read again.'), `already revoked: ${refused}`)
    await carla.waitForSelector(`#revision-${r3}[data-status="approval_revoked"]`)
    check((await text(carla, `#revision-${r3}`)).includes(otherTab) && same(await effect(carla, r3), ['The Approval of Revision 4 still counted, so this Task kept its 20 XP contribution and its evidence for Mastery of “Vectors”; nothing was corrected.']) && same(await progress(carla), { xp: '35', vectors: ['open', 'mastered'], matrices: ['open', 'mastered'] }), `after the refused revocation: ${JSON.stringify(await effect(carla, r3))}`)
    check((await storedReviews(la.drills))[2].reason === otherTab, 'the refused revocation replaced the recorded reason')
    await carla.click(`#revoke-open-${r4}`)
    const reason4 = 'Revision 4 is not the learner\'s own work.'
    await typeInto(carla, `#revoke-reason-${r4}`, reason4)
    faults.commitThenDrop = 1
    await carla.click(`#revoke-confirm-${r4}`)
    await waitRevocation(carla, r4, 'recorded')
    await carla.waitForSelector(`${revocation(r4)}[data-refresh="read"]`)
    check(faults.commitThenDrop === 0 && (await data(carla, revocation(r4))).confirmedBy === 'history' && (await text(carla, `#revoke-status-${r4}`)).includes('the answer was lost, but the history shows it'), `lost revocation answer: ${await text(carla, `#revoke-status-${r4}`)}`)
    await carla.waitForSelector('#enrollment-xp[data-xp="15"]')
    check(same(await effect(carla, r4), finalEffect) && same(await progress(carla), { xp: '15', vectors: ['open', 'not-mastered'], matrices: ['locked', 'mastered'] }), `after the lost-answer revocation: ${JSON.stringify(await effect(carla, r4))}`)
    check(same(await xpEvents(), [[la.drills, 'award', 20, 1], [la.matrixDrills, 'award', 15, 1], [la.drills, 'correction', -20, 2], [la.drills, 'correction', 20, 3], [la.drills, 'correction', -20, 4]]) && same(await masteryEvents(), [[la.vectors, 'award', 1], [la.matrices, 'award', 1], [la.vectors, 'revocation', 2], [la.vectors, 'award', 3], [la.vectors, 'revocation', 4]]), `stored events after the lost answer: ${JSON.stringify([await xpEvents(), await masteryEvents()])}`)
    pass('stale and lost answers', 'Revision 3 revoked from another tab while this page offered it → "Not revoked: … already revoked (perhaps from another tab) … Nothing changed", re-read shows the other tab\'s reason and "Revision 4 still counted"; Revision 4 revoked with the answer dropped → "recorded … the history shows it", 15 XP, one −20 correction and one Mastery revocation for it')

    // 7. Reload: decisions, reasons, corrections and their explanations come back from PostgreSQL for both; Pia still reads nothing.
    await openEnrollment(carla, enrollment)
    await keyboardSelect(carla, 0, la.vectors)
    revisions = await history(carla, la.drills, 4)
    const reloaded = (page: Page) => Promise.all([r1, r2, r3, r4].map((id) => effect(page, id)))
    const expectedEffects = [
      ['The Approval of Revision 2 still counted, so this Task kept its 20 XP contribution and its evidence for Mastery of “Vectors”; nothing was corrected.'],
      finalEffect,
      ['The Approval of Revision 4 still counted, so this Task kept its 20 XP contribution and its evidence for Mastery of “Vectors”; nothing was corrected.'],
      finalEffect,
    ]
    check(same(revisions.map((r) => r.status), ['approval_revoked', 'approval_revoked', 'approval_revoked', 'approval_revoked']) && same(await reloaded(carla), expectedEffects) && same(await progress(carla), { xp: '15', vectors: ['open', 'not-mastered'], matrices: ['locked', 'mastered'] }), `Carla after reload: ${JSON.stringify(await reloaded(carla))}`)
    check(await carla.$('[id^="revoke-open-"]') === null, 'a revoked Approval offers another revocation after reload')
    await carla.$eval(`#revision-${r4}`, (el) => el.scrollIntoView({ block: 'center' }))
    await carla.screenshot({ path: path.resolve(FRONTEND, '../.harness/t24-coach-correction.png') })
    await act(lena)
    await openEnrollment(lena, enrollment)
    await keyboardSelect(lena, 0, la.vectors)
    revisions = await history(lena, la.drills, 4)
    check(same(await reloaded(lena), expectedEffects) && [reason1, reason2, otherTab, reason4].every((reason, i) => revisions[i].text.includes(reason)) && same(await progress(lena), { xp: '15', vectors: ['open', 'not-mastered'], matrices: ['locked', 'mastered'] }), `Lena after reload: ${JSON.stringify(await reloaded(lena))}`)
    check(same(await xpLines(lena, la.drills), ['Awarded +20 XP: Approval of Revision 1', 'Corrected −20 XP: the Approval of Revision 2 was revoked', 'Restored +20 XP: Approval of Revision 3', 'Corrected −20 XP: the Approval of Revision 4 was revoked']), `Lena's XP history after reload: ${JSON.stringify(await xpLines(lena, la.drills))}`)
    await act(pia)
    await pia.goto(`${ORIGIN}/enrollments/${enrollment}`, { waitUntil: 'networkidle0' })
    await pia.waitForSelector('#enrollment-unavailable')
    check(!(await pia.evaluate(() => document.body.innerText)).includes(reason1), 'Pia reads Lena\'s revocation reasons')
    pass('reload and visibility', 'after reload Carla and Lena see four revoked Approvals with their reasons and the same explanations (kept by Revision 2 / corrected / kept by Revision 4 / corrected), the full XP history, 15 XP, Matrices locked and mastered; no revoked Approval offers another revocation; Pia\'s view of Lena\'s Enrollment is unavailable')

    check(errors.length === 0, `page errors: ${errors.join('; ')}`)
    console.log(`\nT24 Approval correction check passed (${steps.length} steps).`)
  } catch (error) {
    const shot = path.resolve(FRONTEND, '../.harness/t24-failure.png')
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
  console.error(`\nT24 Approval correction check FAILED after ${steps.length} steps: ${error instanceof Error ? `${error.message}\n${error.stack}` : error}`)
  process.exit(1)
})
