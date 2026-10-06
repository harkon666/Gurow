#!/usr/bin/env bun
/**
 * T21 enrolled navigation check (#22): the production frontend build forwarding /api
 * to the production backend entry (Better Auth sessions) on a freshly migrated
 * PostgreSQL database, with email through the Resend HTTP mailer to a local stand-in.
 * Real Accounts take every step: a Coach publishes a Version and invites two
 * learners, who verify their emailed addresses and accept. The learner opens the
 * Version her Enrollment joined from the acceptance, keeps it after the Coach
 * publishes Version 2, and sees Access, Mastery and Enrollment XP separately, with a
 * Locked Skill's reasons and its submitted work, as Approvals and a revocation change
 * them. On the WebGPU canvas she pans, zooms and selects, but cannot move a card; the
 * Coach's layout change reaches her on reopening. Her camera is stored only under her
 * Account and Enrollment. Without WebGPU, the keyboard list reaches the same Task
 * details. A peer in the same Version and another Workspace's Coach are refused her
 * Enrollment; the owning Coach can read it. Submitting from the UI is T22, so learner
 * work is sent and reviewed through the API here.
 *
 * Run from frontend: bun run scripts/t21-enrolled-navigation-check.ts [--skip-build]
 */
import { SQL } from 'bun'
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import puppeteer, { type Browser, type BrowserContext, type Page } from 'puppeteer-core'
import { startResendStandIn } from '../../backend/test/support/resend-stand-in'
import { resolveChromiumExecutable, waitForServerReady } from './benchmark/browser'

const FRONTEND = path.resolve(import.meta.dir, '..')
const BACKEND = path.resolve(FRONTEND, '../backend')
const PORT = Number(process.env.PORT ?? 3511)
const API_PORT = Number(process.env.API_PORT ?? 3512)
const ORIGIN = `http://127.0.0.1:${PORT}`
const SECRET = 't21-browser-check-secret-not-for-production'
const DATABASE_URL = process.env.T21_DATABASE_URL ?? 'postgres://gurow:gurow@127.0.0.1:5433/gurow_t21_browser_test'
const PASSWORD = 'correct horse battery staple'

const steps: string[] = []
function pass(step: string, detail: string) {
  steps.push(step)
  console.log(`  ✓ ${step}: ${detail}`)
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
const near = (a: number, b: number, tolerance = 1.5) => Math.abs(a - b) <= tolerance

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
async function setValue(page: Page, selector: string, value: string) {
  await page.$eval(selector, (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
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

interface Label { id: string; x: number; y: number }
const labels = (page: Page): Promise<Label[]> => page.$$eval('[id^="card-label-"]', (els) => {
  const origin = document.querySelector('#labels-overlay')!.getBoundingClientRect()
  return els.map((el) => {
    const r = el.getBoundingClientRect()
    return { id: el.id.replace('card-label-', ''), x: r.x - origin.x, y: r.y - origin.y }
  })
})
const settle = (page: Page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
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
/** Opens an Enrollment page and waits for its renderer state, its cards and its learning records. */
async function openEnrollment(page: Page, enrollmentId: string, gpu: 'ready' | 'unsupported' = 'ready') {
  await page.goto(`${ORIGIN}/enrollments/${enrollmentId}`, { waitUntil: 'networkidle0' })
  await page.waitForSelector(`#enrolled-version[data-gpu-status="${gpu}"]`, { timeout: 20000 }).catch(async () => {
    throw new Error(`the Enrollment page did not reach '${gpu}' (status ${await page.$eval('#enrolled-version', (el) => (el as HTMLElement).dataset.gpuStatus).catch(() => 'absent')})`)
  })
  await page.waitForFunction(() => (document.querySelector('#enrollment-xp') as HTMLElement | null)?.dataset.xp !== '')
  await page.waitForFunction(() => document.querySelectorAll('[id^="card-label-"]').length === 2)
}
/** Selects a Skill in the keyboard list: focus it, Home, ArrowDown n times, Enter. */
async function keyboardSelect(page: Page, index: number, id: string) {
  await page.focus('#skill-prerequisite-list')
  await page.keyboard.press('Home')
  for (let i = 0; i < index; i++) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await waitSelected(page, id)
}
/** What the page shows for the selected Skill and the Enrollment. */
async function shown(page: Page) {
  return page.evaluate(() => {
    const q = (s: string) => document.querySelector(s) as HTMLElement | null
    return {
      xp: q('#enrollment-xp')?.dataset.xp,
      access: q('#skill-access')?.dataset.access,
      mastery: q('#skill-mastery')?.dataset.mastery,
      reasons: [...document.querySelectorAll('#lock-reasons li')].map((li) => li.textContent?.trim() ?? ''),
      title: q('#selected-skill-title')?.textContent?.trim(),
    }
  })
}
// The learner's private draft fields (T22) are their own work, not the Version's content.
const readOnlyControls = (page: Page) => page.evaluate(() => ({
  panelInputs: [...document.querySelectorAll('#skill-detail-panel input, #skill-detail-panel textarea, #skill-detail-panel select')].filter((el) => !el.closest('[data-task-work]')).length,
  pageInputs: [...document.querySelectorAll('#enrolled-version input, #enrolled-version textarea, #enrolled-version select')].filter((el) => !el.closest('[data-task-work]')).length,
  edits: ['#new-skill-form', '#editor-undo-btn', '#editor-redo-btn', '#editor-add-card-btn', '#connect-skill-select', '#add-task-btn', '[id^="disconnect-"]', '#save-status']
    .filter((s) => document.querySelector(s) !== null),
  badge: document.querySelector('#editor-read-only-badge')?.textContent?.trim() ?? null,
}))
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
  return { pathId: created.learningPath.id as string, versionId: published.version.id as string, revision: published.learningPath.revision as number, ...ids }
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

    // 1. A Coach publishes Version 1 and invites two verified learners, who accept; the learner opens her Enrollment from the acceptance.
    const { page: carla } = await newContext(browser, errors)
    current = carla
    await signUpVerified(carla, 'carla@gurow.test')
    const workspace = (await ok(carla, '/coach/workspaces', 'POST', { name: 'Linear Algebra Studio' })).workspace
    const la = await publishLinearAlgebra(carla, workspace.id)
    const { context: learners, page: lena } = await newContext(browser, errors)
    current = lena
    const lenaId = await signUpVerified(lena, 'lena@gurow.test')
    const lenaEnrollment = await inviteAndAccept(carla, lena, la.versionId, 'lena@gurow.test')
    await lena.click('#open-enrollment')
    await lena.waitForSelector('#enrolled-version[data-gpu-status="ready"]', { timeout: 20000 })
    check(new URL(lena.url()).pathname === `/enrollments/${lenaEnrollment}`, `the acceptance opened ${lena.url()}`)
    await openEnrollment(lena, lenaEnrollment)
    check(await text(lena, '#enrolled-path-title') === 'Linear Algebra' && (await data(lena, '#enrolled-version-badge')).versionNumber === '1' && (await data(lena, '#enrolled-version')).versionId === la.versionId, 'the page does not show Version 1 of Linear Algebra')
    check((await data(lena, '#active-context')).context === 'learner' && (await text(lena, '#version-pinned-note')).includes('stays on Version 1'), 'the learner context or pinned note is missing')
    const listed = await lena.$$eval('#skill-prerequisite-list [role="option"]', (els) => els.map((el) => el.id.replace('skill-list-item-', '')))
    check(JSON.stringify(listed) === JSON.stringify([la.vectors, la.matrices]), `listed Skills ${listed}`)
    const vectorsPoint = await cardPoint(lena, la.vectors)
    await lena.mouse.click(vectorsPoint.x, vectorsPoint.y)
    await waitSelected(lena, la.vectors)
    check((await text(lena, '#skill-detail-panel')).includes('Add and scale vectors in R^n') && await text(lena, `#task-title-${la.drills}`) === 'Vector drills' && await text(lena, `#task-description-${la.drills}`) === 'Exercises 1–10' && await text(lena, `#task-badge-${la.reading}`) === 'Enrichment', 'the selected Skill does not show its outcome and Tasks')
    pass('enrollment opens its Version', `invitation accepted → "Open Linear Algebra, Version 1" → canvas (WebGPU ready) and list show Vectors/Matrices; clicking Vectors shows its outcome and Tasks`)

    // 2. The Coach publishes Version 2 with a renamed Skill; the learner's Enrollment stays on Version 1.
    const draft = await ok(carla, `/coach/learning-paths/${la.pathId}/drafts`, 'POST', { expectedRevision: la.revision })
    draft.application.skills[0].title = 'Vectors (revised)'
    draft.editor.cards[0].title = 'Vectors (revised)'
    const savedV2 = await ok(carla, `/coach/learning-paths/${la.pathId}/draft`, 'PUT', { expectedRevision: draft.learningPath.revision, title: draft.learningPath.title, goal: draft.learningPath.goal, editor: draft.editor, application: draft.application })
    const v2 = await ok(carla, `/coach/learning-paths/${la.pathId}/publication`, 'POST', { expectedRevision: savedV2.learningPath.revision })
    check(v2.version.versionNumber === 2, 'Version 2 was not published')
    await openEnrollment(lena, lenaEnrollment)
    check((await data(lena, '#enrolled-version-badge')).versionNumber === '1' && !(await text(lena, '#enrolled-version')).includes('revised'), 'the learner was switched to Version 2 content')
    check((await text(lena, `#card-label-${la.vectors}`)).includes('Vectors') && !(await text(lena, `#card-label-${la.vectors}`)).includes('revised'), 'the canvas shows Version 2 titles')
    await lena.goto(`${ORIGIN}/learning`, { waitUntil: 'networkidle0' })
    await lena.waitForSelector('#learner-enrollments')
    const enrollmentsListed = await lena.$$eval('#learner-enrollments [data-enrollment-id]', (els) => els.map((el) => `${(el as HTMLElement).dataset.enrollmentId}:${el.textContent}`))
    check(enrollmentsListed.length === 1 && enrollmentsListed[0].startsWith(lenaEnrollment) && enrollmentsListed[0].includes('Version 1'), `listed Enrollments: ${enrollmentsListed}`)
    pass('pinned content', 'Version 2 ("Vectors (revised)") published; reopening still shows Version 1 titles on canvas, list and badge; /learning lists Linear Algebra · Version 1')

    // 3. Access, Mastery and Enrollment XP are separate; the Locked Skill shows its title, outcome and reasons.
    await openEnrollment(lena, lenaEnrollment)
    check((await data(lena, `#skill-status-${la.matrices}`)).access === 'locked' && (await data(lena, `#card-status-${la.matrices}`)).locked === 'true', 'Matrices is not shown locked in the list and on its card')
    await keyboardSelect(lena, 1, la.matrices)
    let s = await shown(lena)
    check(s.xp === '0' && s.access === 'locked' && s.mastery === 'not-mastered' && s.title === 'Matrices', `initial: ${JSON.stringify(s)}`)
    check(s.reasons.length === 2 && s.reasons[0] === 'Requires Mastery of “Vectors”' && s.reasons[1] === 'Needs 20 more XP: the threshold is 20 XP and this Enrollment has 0 XP', `lock reasons: ${s.reasons}`)
    check((await text(lena, '#skill-detail-panel')).includes('Multiply matrices as linear maps') && await text(lena, `#task-title-${la.matrixDrills}`) === 'Matrix drills', 'the Locked Skill hides its outcome or Tasks')
    // Work is sent through the API (T22 adds the UI); the Coach approves Vectors' Required Task.
    const route = (task: string) => `/enrollments/${lenaEnrollment}/tasks/${task}/submission`
    const vectorWork = (await ok(lena, `${route(la.drills)}/revisions`, 'POST', { text: 'Vector drill answers', urls: ['https://example.com/vectors'] })).revision.id
    await ok(carla, `${route(la.drills)}/revisions/${vectorWork}/review`, 'POST', { decision: 'approval' })
    await openEnrollment(lena, lenaEnrollment)
    await keyboardSelect(lena, 0, la.vectors)
    s = await shown(lena)
    check(s.xp === '20' && s.access === 'open' && s.mastery === 'mastered', `after Approval, Vectors: ${JSON.stringify(s)}`)
    await lena.waitForSelector(`#task-history-${la.drills}[data-state="ready"][data-revisions="1"]`)
    check((await text(lena, `#task-history-${la.drills}`)).includes('Approved') && (await data(lena, `#task-learning-${la.drills}`)).xpContribution === '20', 'the approved work or its contribution is not shown')
    await keyboardSelect(lena, 1, la.matrices)
    s = await shown(lena)
    check(s.access === 'open' && s.mastery === 'not-mastered' && s.reasons.length === 0 && s.xp === '20', `after Approval, Matrices: ${JSON.stringify(s)}`)
    // Work on Matrices while open; then the Coach revokes the Vectors Approval and Matrices locks again.
    await ok(lena, `/enrollments/${lenaEnrollment}/tasks/${la.matrixDrills}/start`, 'POST')
    await ok(lena, `${route(la.matrixDrills)}/revisions`, 'POST', { text: 'Matrix drill answers' })
    await ok(carla, `${route(la.drills)}/revisions/${vectorWork}/review/revoke`, 'POST', { reason: 'Wrong exercise set' })
    await openEnrollment(lena, lenaEnrollment)
    await keyboardSelect(lena, 1, la.matrices)
    s = await shown(lena)
    check(s.xp === '0' && s.access === 'locked' && s.mastery === 'not-mastered' && s.reasons.length === 2, `after revocation, Matrices: ${JSON.stringify(s)}`)
    await lena.waitForSelector(`#task-history-${la.matrixDrills}[data-state="ready"][data-revisions="1"]`)
    check((await text(lena, `#task-history-${la.matrixDrills}`)).includes('Matrix drill answers') && (await text(lena, `#task-history-${la.matrixDrills}`)).includes('Awaiting Review') && (await data(lena, `#task-learning-${la.matrixDrills}`)).started === 'true', 'the Locked Skill\'s submitted work is not reachable')
    await keyboardSelect(lena, 0, la.vectors)
    s = await shown(lena)
    check(s.access === 'open' && s.mastery === 'not-mastered', `after revocation, Vectors: ${JSON.stringify(s)}`)
    await lena.waitForSelector(`#task-history-${la.drills}[data-state="ready"]`)
    check((await text(lena, `#task-history-${la.drills}`)).includes('Approval revoked') && (await text(lena, `#task-history-${la.drills}`)).includes('Wrong exercise set'), 'the revoked Approval is not shown in the history')
    pass('Access, Mastery and XP', 'Matrices locked (Mastery of Vectors; 20 more XP) → Approval: 20 XP, Vectors mastered, Matrices open → revocation: 0 XP, Matrices locked again, its pending work and the revoked Approval stay readable')

    // 3b. The page stays open while the Coach changes the records; returning to it or Refresh shows the backend's current state.
    const generation = async () => Number((await data(lena, '#enrollment-records')).generation)
    const returnToPage = async () => {
      const before = await generation()
      await lena.evaluate(() => window.dispatchEvent(new Event('focus')))
      await lena.waitForFunction((n: number) => Number((document.querySelector('#enrollment-records') as HTMLElement | null)?.dataset.generation) > n, {}, before)
    }
    const refreshButton = async () => {
      const before = await generation()
      await lena.click('#enrollment-records-refresh')
      await lena.waitForFunction((n: number) => Number((document.querySelector('#enrollment-records') as HTMLElement | null)?.dataset.generation) > n, {}, before)
    }
    const chips = async () => ({ vectors: (await data(lena, `#skill-status-${la.vectors}`)).access, matrices: (await data(lena, `#skill-status-${la.matrices}`)).access })
    const secondWork = (await ok(lena, `${route(la.drills)}/revisions`, 'POST', { text: 'Corrected vector drills' })).revision.id
    await ok(carla, `${route(la.drills)}/revisions/${secondWork}/review`, 'POST', { decision: 'approval' })
    check((await shown(lena)).xp === '0', 'the open page changed before the learner returned to it')
    await returnToPage()
    s = await shown(lena)
    check(s.xp === '20' && s.title === 'Vectors' && s.access === 'open' && s.mastery === 'mastered' && (await chips()).matrices === 'open', `after the Coach's Approval, on return: ${JSON.stringify(s)} ${JSON.stringify(await chips())}`)
    await lena.waitForSelector(`#task-history-${la.drills}[data-state="ready"][data-revisions="2"]`)
    check((await text(lena, `#task-history-${la.drills}`)).includes('Corrected vector drills'), 'the shown Task history was not read again')
    await ok(carla, `/enrollments/${lenaEnrollment}/deactivate`, 'POST', { reason: 'Paused for the holidays' })
    await refreshButton()
    s = await shown(lena)
    check((await data(lena, '#enrollment-status')).status === 'inactive' && s.access === 'locked' && s.mastery === 'mastered' && s.xp === '20' && s.reasons[0]?.startsWith('This Enrollment is inactive'), `after deactivation, on Refresh: ${JSON.stringify(s)}`)
    check(JSON.stringify(await chips()) === JSON.stringify({ vectors: 'locked', matrices: 'locked' }) && await lena.$('#enrollment-inactive-note') !== null, `chips after deactivation: ${JSON.stringify(await chips())}`)
    await ok(carla, `/enrollments/${lenaEnrollment}/reactivate`, 'POST', { reason: 'Back after the holidays' })
    await ok(carla, `${route(la.drills)}/revisions/${secondWork}/review/revoke`, 'POST', { reason: 'Still the wrong set' })
    await returnToPage()
    s = await shown(lena)
    check((await data(lena, '#enrollment-status')).status === 'active' && s.xp === '0' && s.access === 'open' && s.mastery === 'not-mastered' && (await chips()).matrices === 'locked', `after reactivation and revocation, on return: ${JSON.stringify(s)} ${JSON.stringify(await chips())}`)
    pass('open page follows the Coach', 'without a reload: Coach Approval → on return 20 XP, Vectors mastered, Matrices open, 2 revisions listed; Coach deactivation → Refresh shows inactive, every Skill locked, Mastery and XP kept; reactivation + revocation → on return active, 0 XP, Matrices locked')

    // 4. Read-only navigation: pan, zoom and select work; dragging a card pans; nothing edits the Version.
    const storedCards = async () => JSON.stringify(await sql`select skill_id, x, y from version_skill_cards where learning_path_version_id = ${la.versionId} order by skill_id`)
    const cardsBefore = await storedCards()
    await openEnrollment(lena, lenaEnrollment)
    const controls = await readOnlyControls(lena)
    check(controls.panelInputs === 0 && controls.pageInputs === 0 && controls.edits.length === 0 && controls.badge === 'View only · layout by the Coach', `editing controls on the learner page: ${JSON.stringify(controls)}`)
    check((await data(lena, '#editor-canvas')).readOnly === 'true', 'the canvas is not read-only')
    const beforeDrag = await labels(lena)
    const grab = await cardPoint(lena, la.matrices)
    await lena.mouse.move(grab.x, grab.y)
    await lena.mouse.down()
    await lena.mouse.move(grab.x + 90, grab.y + 60, { steps: 12 })
    await lena.mouse.up()
    await settle(lena)
    await waitSelected(lena, la.matrices)
    const afterDrag = await labels(lena)
    for (const label of beforeDrag) {
      const moved = afterDrag.find((l) => l.id === label.id)!
      check(near(moved.x - label.x, 90) && near(moved.y - label.y, 60), `dragging moved ${label.id} by (${moved.x - label.x}, ${moved.y - label.y}) instead of panning everything by (90, 60)`)
    }
    const relative = (ls: Label[]) => { const a = ls.find((l) => l.id === la.vectors)!, b = ls.find((l) => l.id === la.matrices)!; return { x: b.x - a.x, y: b.y - a.y } }
    check(near(relative(afterDrag).x, relative(beforeDrag).x) && near(relative(afterDrag).y, relative(beforeDrag).y), 'the card moved relative to the other card')
    await lena.keyboard.down('Control')
    await lena.keyboard.press('z')
    await lena.keyboard.up('Control')
    await settle(lena)
    check(JSON.stringify(relative(await labels(lena))) === JSON.stringify(relative(afterDrag)) && await lena.$('.bg-red-950\\/90') === null, 'Ctrl+Z changed the canvas or reported an engine error')
    const zoomBefore = await text(lena, '#editor-zoom-label')
    const canvasBox = (await (await lena.$('#editor-canvas'))!.boundingBox())!
    await lena.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2)
    // Ctrl+wheel zooms about the pointer; a plain wheel pans.
    await lena.keyboard.down('Control')
    await lena.mouse.wheel({ deltaY: -240 })
    await lena.keyboard.up('Control')
    await lena.waitForFunction((z: string) => document.querySelector('#editor-zoom-label')?.textContent?.trim() !== z, {}, zoomBefore)
    check(await storedCards() === cardsBefore, 'the stored layout changed')
    const writes = await Promise.all([
      api(lena, `/coach/learning-paths/${la.pathId}/draft`, 'PUT', { expectedRevision: v2.learningPath.revision, title: 'Mine', goal: '', editor: draft.editor, application: draft.application }),
      api(lena, `/coach/learning-path-versions/${la.versionId}`),
      api(lena, `/enrollments/${lenaEnrollment}/version`, 'PUT', { editor: draft.editor }),
    ])
    check(writes.every((w) => w.status === 404) && await storedCards() === cardsBefore, `learner writes answered ${writes.map((w) => w.status)}`)
    // The Coach's later layout change (stored directly: the Coach's layout UI is T27) is what the learner sees on reopening.
    await sql`update version_skill_cards set x = x + 200 where learning_path_version_id = ${la.versionId} and skill_id = ${la.matrices}`
    const camera = await lena.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), `gurow:camera:${lenaId}:enrollment:${lenaEnrollment}`)
    check(camera?.zoom > 1, `the camera is not stored under Lena's Account and Enrollment: ${JSON.stringify(camera)}`)
    const relativeBeforeReopen = relative(await labels(lena))
    await openEnrollment(lena, lenaEnrollment)
    await settle(lena)
    check(near(relative(await labels(lena)).x - relativeBeforeReopen.x, 200 * camera.zoom, 2), `the reopened layout does not show the Coach's change (zoom ${camera.zoom})`)
    pass('read-only canvas', `no editing controls; dragging Matrices selected it and panned both cards (+90,+60) without moving it; Ctrl+Z inert; wheel zoom ${zoomBefore} → ${await text(lena, '#editor-zoom-label')}; learner writes 404; stored layout unchanged; the Coach's +200 move appears on reopening`)

    // 5. Camera state is local to the Account and Enrollment.
    const lenaKey = `gurow:camera:${lenaId}:enrollment:${lenaEnrollment}`
    const zoomLabel = await text(lena, '#editor-zoom-label')
    check(zoomLabel === `${Math.round(camera.zoom * 100)}%` && zoomLabel !== '100%', `the camera was not restored on reopening (${zoomLabel}, stored ${camera.zoom})`)
    const cameraKeys = async (page: Page) => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('gurow:camera:')).sort())
    check(JSON.stringify(await cameraKeys(lena)) === JSON.stringify([lenaKey]), `camera keys: ${await cameraKeys(lena)}`)
    // Pia, in the same browser (same local storage), opens her own Enrollment in the same Version.
    await signOut(lena)
    const piaId = await signUpVerified(lena, 'pia@gurow.test')
    const piaEnrollment = await inviteAndAccept(carla, lena, la.versionId, 'pia@gurow.test')
    await openEnrollment(lena, piaEnrollment)
    check(await text(lena, '#editor-zoom-label') === '100%', `Pia's view opened at Lena's camera (${await text(lena, '#editor-zoom-label')})`)
    const piaGrab = await cardPoint(lena, la.vectors)
    await lena.mouse.move(piaGrab.x, piaGrab.y)
    await lena.mouse.down()
    await lena.mouse.move(piaGrab.x - 40, piaGrab.y + 30, { steps: 6 })
    await lena.mouse.up()
    const piaKey = `gurow:camera:${piaId}:enrollment:${piaEnrollment}`
    await lena.waitForFunction((k: string) => localStorage.getItem(k) !== null, {}, piaKey)
    const lenaCameraAfter = await lena.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), lenaKey)
    check(JSON.stringify(lenaCameraAfter) === JSON.stringify(camera), 'Pia\'s navigation changed Lena\'s stored camera')
    check(JSON.stringify(await cameraKeys(lena)) === JSON.stringify([lenaKey, piaKey].sort()), `camera keys: ${await cameraKeys(lena)}`)
    pass('camera isolation', `Lena's ${zoomLabel} restored from ${lenaKey.slice(0, 40)}…; Pia's Enrollment in the same browser opened at 100% and stored its own key; Lena's camera untouched`)

    // 6. Privacy: a peer in the same Version and another Workspace's Coach are refused; the owning Coach can read it.
    const privateRoutes = [`/enrollments/${lenaEnrollment}/version`, `/enrollments/${lenaEnrollment}/learning-state`, route(la.drills), route(la.matrixDrills)]
    await lena.goto(`${ORIGIN}/enrollments/${lenaEnrollment}`, { waitUntil: 'networkidle0' })
    await lena.waitForSelector('#enrollment-unavailable')
    check(!(await text(lena, 'main')).includes('Vectors') && !(await text(lena, 'main')).includes('Matrix drill'), 'the peer sees Lena\'s content')
    const peerReads = await Promise.all(privateRoutes.map((r) => api(lena, r)))
    check(peerReads.every((r) => r.status === 404 && r.body.error === 'enrollment_not_found'), `peer reads: ${peerReads.map((r) => r.status)}`)
    const piaListed = (await ok(lena, '/enrollments')).enrollments.map((e: any) => e.id)
    check(JSON.stringify(piaListed) === JSON.stringify([piaEnrollment]), `Pia lists ${piaListed}`)
    const { page: oscar } = await newContext(browser, errors)
    current = oscar
    await signUpVerified(oscar, 'oscar@gurow.test')
    await ok(oscar, '/coach/workspaces', 'POST', { name: 'Oscar Studio' })
    await oscar.goto(`${ORIGIN}/enrollments/${lenaEnrollment}`, { waitUntil: 'networkidle0' })
    await oscar.waitForSelector('#enrollment-unavailable')
    const oscarReads = await Promise.all(privateRoutes.map((r) => api(oscar, r)))
    check(oscarReads.every((r) => r.status === 404) && !(await text(oscar, 'main')).includes('Vectors'), `other Coach reads: ${oscarReads.map((r) => r.status)}`)
    current = carla
    await openEnrollment(carla, lenaEnrollment)
    check((await data(carla, '#active-context')).context === 'coach' && (await data(carla, '#enrollment-xp')).xp === '0' && (await data(carla, '#enrolled-version-badge')).versionNumber === '1', 'the owning Coach cannot read the Enrollment')
    pass('privacy', 'Pia (same Version) and Oscar (another Workspace) get "not available" without content and 404 on Version, records and Submissions; Pia lists only her own Enrollment; Carla (owning Coach) reads it')

    // 7. Without WebGPU, the keyboard list reaches the same Skill and Task details.
    await signOut(lena)
    await authenticate(lena, 'sign-in', 'lena@gurow.test')
    const noGpu = current = await newPage(learners, errors)
    await noGpu.evaluateOnNewDocument(() => {
      Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true })
    })
    await openEnrollment(noGpu, lenaEnrollment, 'unsupported')
    check(await noGpu.$('#editor-gpu-notice') !== null && (await text(noGpu, '#canvas-availability-explanation')).includes('keyboard-accessible list'), 'the no-WebGPU notice is missing')
    await keyboardSelect(noGpu, 1, la.matrices)
    s = await shown(noGpu)
    check(s.title === 'Matrices' && s.access === 'locked' && s.reasons.length === 2 && s.xp === '0', `list-only Matrices: ${JSON.stringify(s)}`)
    await noGpu.waitForSelector(`#task-history-${la.matrixDrills}[data-state="ready"][data-revisions="1"]`)
    check(await text(noGpu, `#task-title-${la.matrixDrills}`) === 'Matrix drills' && (await text(noGpu, `#task-history-${la.matrixDrills}`)).includes('Matrix drill answers'), 'the list-only view does not reach the Task details')
    await noGpu.keyboard.press('ArrowUp')
    await waitSelected(noGpu, la.vectors)
    check(await text(noGpu, `#task-title-${la.drills}`) === 'Vector drills' && (await shown(noGpu)).mastery === 'not-mastered', 'ArrowUp did not reach Vectors and its Task')
    check((await readOnlyControls(noGpu)).panelInputs === 0, 'the list-only view offers editing')
    pass('no WebGPU', 'list-only page: keyboard reaches Matrices (locked, both reasons, 0 XP) with its Task and submitted work, then Vectors and its Task; nothing editable')

    check(errors.length === 0, `page errors: ${errors.join('; ')}`)
    console.log(`\nT21 enrolled navigation check passed (${steps.length} steps).`)
  } catch (error) {
    const shot = path.resolve(FRONTEND, '../.harness/t21-failure.png')
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
  console.error(`\nT21 enrolled navigation check FAILED after ${steps.length} steps: ${error instanceof Error ? `${error.message}\n${error.stack}` : error}`)
  process.exit(1)
})
