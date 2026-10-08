#!/usr/bin/env bun
/**
 * UX01 (#47, parent #46): current-build, authenticated canvas navigation journeys.
 * Requires harness checks build and db-up; isolated ports 3591/3592 and PostgreSQL
 * gurow_ux01_browser_test make this check eligible for parallel execution.
 * Run from frontend: bun run scripts/ux01-navigation-check.ts [--skip-build]
 *
 * AC1/3: closed initial shell, labeled controls, keyboard search/selection, Tasks,
 * Escape/focus restoration and full-screen narrow details in all three contexts.
 * AC2/4: actual authoring, completion, Submission and Coach Review; clean chrome
 * without hiding meaningful Version / Submission Revision history.
 * AC5: held, failed, rejected and stale saves; actual retry/reapply; semantic reload.
 * AC6: no-WebGPU learning and injected renderer failure, CPU document and retry.
 * AC7: real BetterAuth/Resend/PostgreSQL, forbidden writes leave state unchanged.
 * AC8: navigation/recovery subset of parent AC-01/08/09/10, not board acceptance.
 * T18/19/23/28/29/30/32 remain complementary coverage for publication, complete
 * copy/reuse/archival/deletion rules and recovery identity/merge permutations.
 */
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import path from 'node:path'
import puppeteer, { type Browser, type HTTPRequest, type Page } from 'puppeteer-core'
import { startResendStandIn } from '../../backend/test/support/resend-stand-in'
import { closeSummaryBoard, editBoardTask, openSkillView, openTask } from './editor-navigation'
import { resolveChromiumExecutable, waitForServerReady } from './benchmark/browser'

const FRONTEND = path.resolve(import.meta.dir, '..')
const BACKEND = path.resolve(FRONTEND, '../backend')
const PORT = 3591
const API_PORT = 3592
const ORIGIN = `http://127.0.0.1:${PORT}`
const DATABASE_URL = 'postgres://gurow:gurow@127.0.0.1:5433/gurow_ux01_browser_test'
const PASSWORD = 'correct horse battery staple'
const steps: string[] = []
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }
function pass(message: string) { steps.push(message); console.log(`  ✓ ${message}`) }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const text = (page: Page, selector: string) => page.$eval(selector, (el) => (el as HTMLElement).innerText.trim())
const value = (page: Page, selector: string) => page.$eval(selector, (el) => (el as HTMLInputElement).value)
const visible = (page: Page, selector: string) => page.$eval(selector, (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden').catch(() => false)
async function setValue(page: Page, selector: string, next: string) {
  await page.$eval(selector, (el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, next)
}
async function activate(page: Page, selector: string) {
  await page.waitForSelector(selector, { visible: true })
  await page.focus(selector)
  await page.keyboard.press('Enter')
}
/** Reach a real learning action with Tab rather than focusing a hidden/inert control. */
async function tabActivate(page: Page, selector: string) {
  for (let i = 0; i < 100; i++) {
    if (await page.evaluate((s) => document.activeElement === document.querySelector(s), selector)) {
      await page.keyboard.press('Enter')
      return
    }
    await page.keyboard.press('Tab')
  }
  throw new Error(`keyboard cannot reach ${selector}`)
}
async function api(page: Page, route: string, method = 'GET', body?: unknown): Promise<{ status: number; body: any }> {
  return page.evaluate(async (r, m, b) => {
    const response = await fetch(`/api${r}`, { method: m, headers: b === null ? undefined : { 'content-type': 'application/json' }, body: b })
    return { status: response.status, body: await response.json().catch(() => null) }
  }, route, method, body === undefined ? null : JSON.stringify(body))
}
async function ok(page: Page, route: string, method = 'GET', body?: unknown) {
  const result = await api(page, route, method, body)
  check([200, 201].includes(result.status), `${method} ${route}: ${result.status} ${JSON.stringify(result.body)}`)
  return result.body
}
async function portFree(port: number) {
  await new Promise<void>((resolve, reject) => {
    const server = createServer()
    server.once('error', (error) => reject(new Error(`UX01 requires unused port ${port}: ${error.message}`)))
    server.listen(port, '127.0.0.1', () => server.close((error) => error ? reject(error) : resolve()))
  })
}
async function state(page: Page, expected: string) {
  const selector = await visible(page, '#skill-detail-panel') ? '#detail-save-status' : '#save-status'
  await page.waitForSelector(`${selector}[data-state="${expected}"]`, { visible: true })
  const wording = await text(page, selector)
  check(wording.length > 0 && !/revision\s*\d/i.test(wording), `technical/empty save feedback: ${wording}`)
  if (['failed', 'rejected', 'conflict'].includes(expected)) check(/not saved|failed|refused|elsewhere|conflict/i.test(wording), `failure appears successful: ${wording}`)
  return wording
}
async function saved(page: Page, revision: number) {
  await page.waitForSelector(`#save-status[data-state="saved"][data-revision="${revision}"]`)
  await state(page, 'saved')
}
/** `board`: the context has a Task Board (personal since UX03 #49, Coach Drafts since UX04 #50, learner Enrollments since UX05 #51); Coach Review never has one. */
async function cleanChrome(page: Page, ids: string[], board = false) {
  const body = await page.evaluate(() => document.body.innerText)
  for (const id of ids) {
    if (body.includes(id)) {
      const occurrences = await page.evaluate((identity) => [...document.querySelectorAll('body *')]
        .filter((el) => el.children.length === 0 && (el as HTMLElement).innerText?.includes(identity) && el.getClientRects().length > 0)
        .map((el) => ({ tag: el.tagName, id: el.id, text: (el as HTMLElement).innerText, display: getComputedStyle(el).display })), id)
      throw new Error(`technical identity is visible: ${id}; nodes ${JSON.stringify(occurrences)}; context ${body.slice(Math.max(0, body.indexOf(id) - 100), body.indexOf(id) + 150)}`)
    }
  }
  check(!/Rust Owned|React Domain Payload|Simulate GPU Failure/i.test(body), 'implementation chrome is visible')
  if (!board) check(!/Open board/i.test(body) && !await page.$('#open-board-btn'), 'a board action is visible where this context has no Task Board yet')
  check(!await visible(page, '#btn-simulate-gpu-failure'), 'product exposes fault injection')
  for (const selector of ['#save-status', '#detail-save-status', '#layout-save-status']) {
    if (await visible(page, selector)) check(!/revision\s*\d/i.test(await text(page, selector)), 'numeric save revision exposed')
  }
}
async function shell(page: Page, author: boolean) {
  await page.waitForSelector('#btn-skill-list', { visible: true })
  check(!await visible(page, '#skill-detail-panel') && !await visible(page, '#skill-prerequisite-list'), 'initial shell retains a permanent sidebar')
  const canvasShare = await page.$eval('#editor-canvas', (el) => {
    const root = el.closest('#path-editor, #enrolled-version')!
    return el.getBoundingClientRect().width / root.getBoundingClientRect().width
  })
  check(canvasShare > 0.85, `closed navigation still reserves sidebar space (canvas width share ${canvasShare})`)
  check(/skill list/i.test(await text(page, '#btn-skill-list')), 'Skill list lacks a visible text label')
  check(/more/i.test(await text(page, '#btn-more-actions')), 'More lacks a visible text label')
  const add = await page.$$eval('button', (buttons) => buttons.filter((b) => b.getClientRects().length && /^add skill$/i.test(b.innerText.trim())).map((b) => ({ disabled: b.disabled })))
  check(author ? add.some((b) => !b.disabled) : add.every((b) => b.disabled), `Add Skill permission/label wrong (author=${author})`)
  await activate(page, '#btn-more-actions')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.activeElement?.id === 'btn-more-actions')
  if (!author) {
    await page.waitForSelector('#enrollment-records[data-reading="false"]')
    const generation = await page.$eval('#enrollment-records', (el) => Number((el as HTMLElement).dataset.generation))
    await activate(page, '#btn-more-actions')
    const refreshed = page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname.endsWith('/learning-state') && response.status() === 200)
    await tabActivate(page, '#more-enrollment-records-refresh')
    await refreshed
    await page.waitForFunction((before) => {
      const records = document.querySelector('#enrollment-records') as HTMLElement | null
      return records?.dataset.reading === 'false' && Number(records.dataset.generation) > before
    }, {}, generation)
    await page.waitForFunction(() => document.activeElement?.id === 'btn-more-actions')
    check(!await visible(page, '#more-enrollment-records-refresh'), 'More refresh did not dismiss its temporary menu')
  }
  await activate(page, '#btn-skill-list')
  await page.waitForFunction(() => document.activeElement?.id === 'skill-search')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.activeElement?.id === 'btn-skill-list')
}
async function closeDetails(page: Page) {
  // Escape returns from a summary view (Edit, prerequisites, History) to the summary, then closes it.
  for (let i = 0; i < 3 && await visible(page, '#skill-detail-panel'); i++) {
    const view = await page.$eval('#skill-detail-panel', (el) => (el as HTMLElement).dataset.view)
    await page.keyboard.press('Escape')
    if (view !== 'summary') await page.waitForSelector('#skill-detail-panel[data-view="summary"]')
  }
  await page.waitForFunction(() => !document.querySelector('#skill-detail-panel')?.getClientRects().length)
  await page.waitForFunction(() => document.activeElement?.id === 'btn-skill-list')
}
/** Search and select using real keys; selection is checked through content, not a printed ID. */
async function select(page: Page, title: string, task: string, outcome?: string) {
  await page.bringToFront()
  if (await visible(page, '#skill-detail-panel')) await closeDetails(page)
  await activate(page, '#btn-skill-list')
  await page.waitForFunction(() => document.activeElement?.id === 'skill-search')
  await page.keyboard.type(title)
  await page.waitForFunction((name) => {
    const options = [...document.querySelectorAll('#skill-prerequisite-list [role="option"]')]
    return options.length === 1 && options[0].textContent?.includes(name)
  }, {}, title)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Home')
  await page.keyboard.press('Enter')
  await page.waitForSelector('#skill-detail-panel', { visible: true })
  check((await text(page, '#selected-skill-title')) === title, `search selected the wrong Skill, wanted ${title}`)
  if (outcome) check((await text(page, '#skill-detail-panel')).includes(outcome), 'summary lost the learning outcome')
  check(/Requires/.test(await text(page, '#skill-detail-panel')), 'summary lost relationships')
  check(!await visible(page, '#skill-prerequisite-list'), 'list remains open behind the selected summary')
  // Its Tasks are reachable from the summary: on its board where the context has one, otherwise in its Tasks view.
  await openTask(page, task)
  await closeSummaryBoard(page)
  await openSkillView(page, 'summary')
}
/** Edits the selected Skill's learning outcome in its Edit view: a document edit saved like any other. */
async function editOutcome(page: Page, next: string) {
  await openSkillView(page, 'edit')
  await setValue(page, '#skill-outcome-input', next)
}
async function shownOutcome(page: Page) {
  await openSkillView(page, 'edit')
  return value(page, '#skill-outcome-input')
}
async function narrow(page: Page, title: string, task: string) {
  if (await visible(page, '#skill-detail-panel')) await closeDetails(page)
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 })
  await select(page, title, task)
  const geometry = await page.$eval('#skill-detail-panel', (el) => {
    const dialog = el.closest('dialog, [role="dialog"]') ?? el
    const r = dialog.getBoundingClientRect()
    return { width: r.width, height: r.height, left: r.left, top: r.top, overflow: document.documentElement.scrollWidth > innerWidth }
  })
  check(geometry.width >= 380 && geometry.height >= 830 && Math.abs(geometry.left) <= 2 && Math.abs(geometry.top) <= 2 && !geometry.overflow, `narrow detail is squeezed rather than full-screen: ${JSON.stringify(geometry)}`)
  await activate(page, '#btn-close-skill-details')
  await page.waitForFunction(() => document.activeElement?.id === 'btn-skill-list')
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
}
async function open(page: Page, route: string, root = '#path-editor', gpu = 'ready') {
  await page.bringToFront()
  await page.goto(`${ORIGIN}${route}`, { waitUntil: 'networkidle0' })
  await page.waitForSelector(`${root}[data-gpu-status="${gpu}"]`, { timeout: 20000 })
}
async function failRenderer(page: Page) {
  await page.evaluate(() => {
    const scope = window as any
    if (typeof scope.__GUROW_EDITOR_TEST__?.simulateDeviceLoss !== 'function') throw new Error('UX01 test opt-in did not expose simulateDeviceLoss')
    scope.__ux01RequestAdapter = navigator.gpu.requestAdapter
    navigator.gpu.requestAdapter = async () => null
    scope.__GUROW_EDITOR_TEST__.simulateDeviceLoss()
  })
  await page.waitForSelector('#recovery-error-banner')
}
async function retryRenderer(page: Page, root: string) {
  if (await visible(page, '#skill-detail-panel')) await closeDetails(page)
  await page.evaluate(() => { navigator.gpu.requestAdapter = (window as any).__ux01RequestAdapter })
  await activate(page, '#btn-retry-renderer')
  await page.waitForSelector(`${root}[data-gpu-status="ready"]`, { timeout: 20000 })
}
async function newPage(browser: Browser, errors: string[], noGpu = false) {
  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('dialog', (dialog) => { errors.push(`unexpected ${dialog.type()} dialog`); void dialog.dismiss() })
  await page.evaluateOnNewDocument((unsupported) => {
    // Explicit test opt-in, installed before the application starts.
    ;(window as any).__GUROW_TESTING__ = true
    if (unsupported) Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true })
  }, noGpu)
  return page
}
function fixture() {
  const a = crypto.randomUUID(), b = crypto.randomUUID(), ta = crypto.randomUUID(), tb = crypto.randomUUID()
  return { a, b, ta, tb,
    editor: { format_version: 1, cards: [{ id: a, title: 'Vectors', position: { x: 80, y: 100 } }, { id: b, title: 'Matrices', position: { x: 420, y: 100 } }], connections: [{ from_id: a, to_id: b }] },
    application: { skills: [
      { id: a, title: 'Vectors', outcome: 'Add vectors confidently', optional: false, xpThreshold: 0, tasks: [{ id: ta, title: 'Vector drills', description: 'Show your calculation', required: true, xpReward: 20 }] },
      { id: b, title: 'Matrices', outcome: 'Compose linear maps', optional: false, xpThreshold: 0, tasks: [{ id: tb, title: 'Matrix drills', description: 'Multiply two matrices', required: true, xpReward: 10 }] },
    ] },
  }
}
const payload = (doc: any) => ({ expectedRevision: doc.learningPath.revision, title: doc.learningPath.title, goal: doc.learningPath.goal, editor: doc.editor, application: doc.application })

async function main() {
  await portFree(PORT)
  await portFree(API_PORT)
  if (!process.argv.includes('--skip-build')) execFileSync('bun', ['run', 'build'], { cwd: FRONTEND, stdio: 'inherit' })
  execFileSync('bun', ['run', 'test/support/prepare-browser-database.ts'], { cwd: BACKEND, stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: DATABASE_URL } })
  const resend = startResendStandIn()
  const backend = spawn('bun', ['run', 'src/index.ts'], { cwd: BACKEND, env: { ...process.env, DATABASE_URL, PORT: String(API_PORT), BETTER_AUTH_URL: ORIGIN, BETTER_AUTH_SECRET: 'ux01-browser-check-secret-not-for-production', NODE_ENV: 'test', RESEND_API_KEY: resend.apiKey, RESEND_API_URL: resend.url, MAIL_FROM: 'Gurow <invitations@gurow.test>' }, stdio: ['ignore', 'ignore', 'inherit'] })
  const web = spawn('node', ['.output/server/index.mjs'], { cwd: FRONTEND, env: { ...process.env, PORT: String(PORT), GUROW_API_ORIGIN: `http://127.0.0.1:${API_PORT}` }, stdio: 'ignore' })
  let browser: Browser | undefined
  let current: Page | undefined
  const errors: string[] = []
  async function emailLink(email: string, subject: string, after: number) {
    for (let i = 0; i < 100; i++) {
      const mail = resend.sent.slice(after).filter((m) => m.to.includes(email) && m.subject.startsWith(subject)).at(-1)
      const link = mail && /https?:\/\/\S+/.exec(mail.text)?.[0]
      if (link) return link
      await pause(50)
    }
    throw new Error(`missing ${subject} email for ${email}`)
  }
  async function authenticate(page: Page, email: string, signup = true) {
    current = page
    await page.bringToFront()
    const before = resend.sent.length
    await page.goto(ORIGIN, { waitUntil: 'networkidle0' })
    await page.waitForSelector('#sign-in-form')
    await setValue(page, '#email-input', email)
    await setValue(page, '#password-input', PASSWORD)
    await activate(page, signup ? '#sign-up-btn' : '#sign-in-btn')
    await page.waitForSelector('#personal-workspace')
    if (signup) {
      await page.goto(await emailLink(email, 'Verify', before), { waitUntil: 'networkidle0' })
      await page.waitForSelector('#email-verification-status[data-verified="true"]')
    }
  }
  try {
    await waitForServerReady(ORIGIN)
    for (let i = 0; i < 50; i++) {
      if ((await fetch(`${ORIGIN}/api/account`).catch(() => null))?.status === 401) break
      check(i < 49, 'backend never became ready')
      await pause(200)
    }
    browser = await puppeteer.launch({ executablePath: resolveChromiumExecutable(), headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-webgpu', '--use-gl=angle', '--disable-dev-shm-usage'] })
    const owner = await newPage(browser, errors)
    await authenticate(owner, 'owner@ux01.test')
    const personal = await ok(owner, '/personal/learning-paths', 'POST', { title: 'Personal algebra', goal: 'Learn independently' })
    const p = fixture(), pathId = personal.learningPath.id as string
    const personalRoute = `/personal/learning-paths/${pathId}`
    const seed = await ok(owner, `${personalRoute}/document`, 'PUT', { expectedRevision: personal.learningPath.revision, title: 'Personal algebra', goal: 'Learn independently', editor: p.editor, application: p.application })
    let revision = seed.learningPath.revision as number
    await open(owner, `/paths/${pathId}`)
    await shell(owner, true)
    await activate(owner, '#editor-add-card-btn')
    await owner.waitForSelector('#new-skill-title', { visible: true })
    await setValue(owner, '#new-skill-title', 'UX01 scratch')
    await setValue(owner, '#new-skill-outcome', 'Create and remove an unused Skill')
    await tabActivate(owner, '#add-skill-btn')
    await saved(owner, ++revision)
    const scratch = (await ok(owner, personalRoute)).application.skills.find((s: any) => s.title === 'UX01 scratch')
    check(scratch, 'Add Skill did not persist a new Skill')
    if (await visible(owner, '#skill-detail-panel')) await owner.keyboard.press('Escape')
    if (await visible(owner, '#new-skill-title')) await activate(owner, '#btn-close-add-skill')
    await activate(owner, '#btn-skill-list')
    await owner.waitForSelector('#skill-search', { visible: true })
    await owner.keyboard.type('UX01 scratch')
    await owner.keyboard.press('ArrowDown')
    await owner.keyboard.press('Enter')
    await owner.waitForFunction(() => document.querySelector('#selected-skill-title')?.textContent === 'UX01 scratch')
    // Deletion is an infrequent Skill action, behind the summary's Skill actions menu.
    await tabActivate(owner, '#skill-actions-btn')
    await tabActivate(owner, '#delete-skill-btn')
    await saved(owner, ++revision)
    check(!(await ok(owner, personalRoute)).application.skills.some((s: any) => s.id === scratch.id), 'authorized unused-Skill deletion did not persist')
    await select(owner, 'Vectors', p.ta, 'Add vectors confidently')
    await cleanChrome(owner, [pathId, p.a, p.b, p.ta, p.tb], true)
    await select(owner, 'Matrices', p.tb, 'Compose linear maps')
    await openSkillView(owner, 'prerequisites')
    check((await text(owner, '#incoming-prerequisites-list')).includes('Vectors'), 'selected Matrices has wrong prerequisites')
    // Rejected connections must explain the problem without exposing engine IDs,
    // in either the summary or the canvas toast behind it.
    const graphBeforeRejection = await owner.$eval('#skill-detail-panel', el => el.getAttribute('data-connections'))
    await owner.select('#connect-skill-select', p.a)
    await activate(owner, '#btn-add-prerequisite')
    await owner.waitForFunction(() => document.querySelector('#cycle-rejection-alert')?.textContent?.includes('already'))
    let rejection = await text(owner, '#cycle-rejection-alert')
    check(rejection.includes('Vectors') && rejection.includes('Matrices'), 'duplicate rejection must identify Skills by title')
    await cleanChrome(owner, [p.a, p.b], true)
    await activate(owner, '#btn-add-dependent')
    await owner.waitForFunction(() => document.querySelector('#cycle-rejection-alert')?.textContent?.includes('cycle'))
    rejection = await text(owner, '#cycle-rejection-alert')
    check(rejection.includes('Vectors') && rejection.includes('Matrices'), 'cycle rejection must identify Skills by title')
    await cleanChrome(owner, [p.a, p.b], true)
    check(await owner.$eval('#skill-detail-panel', el => el.getAttribute('data-connections')) === graphBeforeRejection, 'rejected connections changed the CPU graph')
    const afterRejection = await ok(owner, personalRoute)
    check(afterRejection.learningPath.revision === revision && same(afterRejection.editor.connections, p.editor.connections), 'rejected connections changed the persisted graph or revision')
    await narrow(owner, 'Vectors', p.ta)
    pass('AC1/3/4 personal: closed labeled shell, searchable keyboard selection of two Skills, correct Tasks/relationships, focus return and full-screen details')

    // A real document edit (the learning outcome) is held in transit: saving cannot be confused with saved.
    await select(owner, 'Vectors', p.ta)
    let held: HTTPRequest | null = null
    let hold = true
    await owner.setRequestInterception(true)
    const intercept = (request: HTTPRequest) => {
      if (hold && request.method() === 'PUT' && new URL(request.url()).pathname === `/api${personalRoute}/document`) { held = request; return }
      void request.continue()
    }
    owner.on('request', intercept)
    await editOutcome(owner, 'Saved through the summary')
    const savingText = await state(owner, 'saving')
    for (let i = 0; i < 100 && !held; i++) await pause(20)
    check(held, 'saving state was not backed by a held write')
    check((await ok(owner, personalRoute)).application.skills.find((s: any) => s.id === p.a).outcome === 'Add vectors confidently', 'held save reached PostgreSQL')
    hold = false
    await (held as HTTPRequest).continue()
    await saved(owner, ++revision)
    check(savingText !== await text(owner, '#save-status'), 'saving/saved wording identical')
    owner.off('request', intercept)
    await owner.setRequestInterception(false)

    await owner.setOfflineMode(true)
    await editOutcome(owner, 'Recovered after offline save')
    const failedText = await state(owner, 'failed')
    await owner.setOfflineMode(false)
    check((await ok(owner, personalRoute)).application.skills.find((s: any) => s.id === p.a).outcome === 'Saved through the summary', 'offline edit was stored')
    check(await shownOutcome(owner) === 'Recovered after offline save', 'failed save lost local Task')
    await closeDetails(owner)
    await activate(owner, '#retry-save-btn')
    await saved(owner, ++revision)

    // Another accepted edit makes this tab stale; actual reapply must retain both edits.
    const accepted = await ok(owner, personalRoute)
    await ok(owner, `${personalRoute}/document`, 'PUT', { ...payload(accepted), goal: 'Accepted elsewhere' })
    await select(owner, 'Vectors', p.ta)
    await editOutcome(owner, 'Reapplied Task')
    const conflictText = await state(owner, 'conflict')
    check(conflictText !== failedText && await shownOutcome(owner) === 'Reapplied Task', 'conflict indistinguishable or local Task lost')
    check((await ok(owner, personalRoute)).application.skills.find((s: any) => s.id === p.a).outcome === 'Recovered after offline save', 'stale save overwrote accepted Task')
    await closeDetails(owner)
    await activate(owner, '#reapply-mine-btn')
    revision += 2
    await saved(owner, revision)
    const merged = await ok(owner, personalRoute)
    check(merged.learningPath.goal === 'Accepted elsewhere' && merged.application.skills.find((s: any) => s.id === p.a).outcome === 'Reapplied Task', 'reapply did not preserve accepted goal and local Task')
    await open(owner, `/paths/${pathId}`)
    await select(owner, 'Vectors', p.ta)
    check(await shownOutcome(owner) === 'Reapplied Task', 'newly loaded summary lost reapplied Task')
    check(await value(owner, '#path-goal-input') === 'Accepted elsewhere', 'newly loaded Path lost accepted goal')
    pass('AC5 saving/failed/conflict: real persisted writes, failed local work, actual Retry/Reapply, semantic reload')

    // A real backend validation rejection, not a mocked response.
    const refusedTitle = 'x'.repeat(2001) // API limit is 2,000; an empty outcome is a valid draft.
    await editOutcome(owner, refusedTitle)
    await state(owner, 'rejected')
    check(await shownOutcome(owner) === refusedTitle, 'refused draft was discarded')
    check((await ok(owner, personalRoute)).application.skills.find((s: any) => s.id === p.a).outcome === 'Reapplied Task', 'rejected save changed backend state')
    await closeDetails(owner)
    await activate(owner, '#retry-save-btn')
    await state(owner, 'rejected')
    await select(owner, 'Vectors', p.ta)
    await editOutcome(owner, 'Validated Task')
    await saved(owner, ++revision)
    // A personal Task's reward and completion are worked in its board details.
    await openTask(owner, p.ta)
    await setValue(owner, `#board-task-reward-${p.ta}`, '7')
    await activate(owner, `#board-task-reward-${p.ta}-set`)
    await owner.waitForFunction(() => !document.querySelector('#learning-pending'))
    await tabActivate(owner, `#board-task-completion-btn-${p.ta}`)
    await owner.waitForSelector(`#board-task-learning-${p.ta}[data-completed="true"]`)
    await closeSummaryBoard(owner)
    check((await ok(owner, `${personalRoute}/learning-state`)).learningState.xp === 7, 'summary completion/reward did not change actual Path XP')
    pass('AC2/5 real rejected save stays local and retries honestly; corrected save, reward setting and completion persist')

    const coach = await newPage(browser, errors)
    await authenticate(coach, 'coach@ux01.test')
    const workspace = (await ok(coach, '/coach/workspaces', 'POST', { name: 'UX01 studio' })).workspace
    const draft = await ok(coach, `/coach/workspaces/${workspace.id}/learning-paths`, 'POST', { title: 'Coached algebra', goal: 'Explain linear maps' })
    const c = fixture(), coachPath = draft.learningPath.id as string
    const draftRoute = `/coach/learning-paths/${coachPath}/draft`
    const draftSeed = await ok(coach, draftRoute, 'PUT', { expectedRevision: draft.learningPath.revision, title: 'Coached algebra', goal: 'Explain linear maps', editor: c.editor, application: c.application })
    current = coach
    await open(coach, `/coach/paths/${coachPath}`)
    await shell(coach, true)
    await select(coach, 'Vectors', c.ta, 'Add vectors confidently')
    await openTask(coach, c.ta)
    await editBoardTask(coach, c.ta, { title: 'Coach-authored Task' })
    await saved(coach, draftSeed.learningPath.revision + 1)
    check(await visible(coach, `#board-task-required-${c.ta}`), 'Draft Required/Enrichment setting became unreachable')
    await closeSummaryBoard(coach)
    await cleanChrome(coach, [coachPath, c.a, c.b, c.ta, c.tb], true)
    await narrow(coach, 'Matrices', c.tb)
    const savedDraft = await ok(coach, `/coach/learning-paths/${coachPath}`)
    const version = (await ok(coach, `/coach/learning-paths/${coachPath}/publication`, 'POST', { expectedRevision: savedDraft.learningPath.revision })).version
    pass('AC1/2/3/4 Coach Draft: clean shell, real Task authoring, Required setting, narrow details; published through authoritative API')

    const learner = await newPage(browser, errors, true)
    await authenticate(learner, 'learner@ux01.test')
    const beforeInvite = resend.sent.length
    await ok(coach, `/coach/learning-path-versions/${version.id}/invitations`, 'POST', { email: 'learner@ux01.test' })
    await learner.goto(await emailLink('learner@ux01.test', 'You are invited', beforeInvite), { waitUntil: 'networkidle0' })
    await activate(learner, '#accept-invitation-btn')
    await learner.waitForSelector('#invitation-result[data-outcome="enrolled"]')
    const enrollment = await learner.$eval('#invitation-result', (el) => (el as HTMLElement).dataset.enrollmentId!)
    current = learner
    await open(learner, `/enrollments/${enrollment}`, '#enrolled-version', 'unsupported')
    await shell(learner, false)
    check(/Version\s+1/i.test(await text(learner, 'body')), 'meaningful Learning Path Version missing')
    await select(learner, 'Matrices', c.tb, 'Compose linear maps')
    await select(learner, 'Vectors', c.ta, 'Add vectors confidently')
    check(!await visible(learner, `#task-edit-title-${c.ta}`) && !await visible(learner, '#delete-skill-btn'), 'learner can edit official definitions')
    await openTask(learner, c.ta)
    await learner.waitForSelector(`#task-work-${c.ta}[data-draft-state="ready"]`)
    await setValue(learner, `#task-work-text-${c.ta}`, 'UX01 evidence: (1, 2) + (2, 3) = (3, 5)')
    await tabActivate(learner, `#task-work-send-${c.ta}`)
    await learner.waitForSelector(`#task-work-${c.ta}[data-status="sent"]`)
    await learner.waitForSelector(`#task-history-${c.ta}[data-revisions="1"]`)
    check(/Revision\s+1/.test(await text(learner, `#task-history-${c.ta}`)), 'Submission Revision history was hidden with technical save revisions')
    await closeSummaryBoard(learner)
    await cleanChrome(learner, [enrollment, version.id, c.a, c.b, c.ta], true)
    await narrow(learner, 'Vectors', c.ta)
    pass('AC1/2/3/4/6 learner without WebGPU: permitted shell, two Skills and Tasks, actual Submission, meaningful Version/Revision and narrow details')

    // Coach reaches Review from the Version entry point, never from a fake board.
    const review = await newPage(browser, errors, true)
    await authenticate(review, 'coach@ux01.test', false)
    current = review
    await review.goto(`${ORIGIN}/coach/versions/${version.id}`, { waitUntil: 'networkidle0' })
    await review.waitForSelector(`#open-enrollment-${enrollment}`)
    await activate(review, `#open-enrollment-${enrollment}`)
    await review.waitForSelector('#enrolled-version[data-gpu-status="unsupported"]')
    check(/coach review/i.test(await text(review, '#btn-coach-review')), 'separate Coach Review entry point lacks a text label')
    await activate(review, '#btn-coach-review')
    await review.waitForSelector(`#awaiting-review-${c.ta}[data-revision-number="1"]`)
    await tabActivate(review, `#awaiting-review-${c.ta}`)
    await review.waitForSelector(`#task-review-${c.ta}[data-target-revision="1"]`)
    check(!await visible(review, `#task-work-text-${c.ta}`), 'Coach sees learner private draft editor')
    await setValue(review, `#task-review-feedback-${c.ta}`, 'Correct vector addition')
    await tabActivate(review, `#task-review-approve-${c.ta}`)
    await review.waitForSelector(`#task-review-${c.ta}[data-status="recorded"][data-refresh="read"]`)
    check((await ok(review, `/enrollments/${enrollment}/learning-state`)).learningState.xp === 20, 'Review did not award the authoritative reward')
    await cleanChrome(review, [enrollment, c.a, c.ta])
    pass('AC2/4/6 separate labeled Coach Review entry → no-WebGPU keyboard Task → actual Approval, persisted XP and history')

    // Lost renderer must preserve CPU content, allow list navigation and retry in place.
    current = owner
    await open(owner, `/paths/${pathId}`)
    const beforeFailure = await ok(owner, personalRoute)
    await failRenderer(owner)
    await select(owner, 'Vectors', p.ta)
    check(await shownOutcome(owner) === 'Validated Task', 'renderer failure lost CPU Task')
    await editOutcome(owner, 'Edited with renderer down')
    await saved(owner, ++revision)
    await retryRenderer(owner, '#path-editor')
    const afterFailure = await ok(owner, personalRoute)
    check(same(beforeFailure.editor, afterFailure.editor), 'renderer failure/retry mutated cards or prerequisites')
    await open(owner, `/paths/${pathId}`)
    await select(owner, 'Vectors', p.ta)
    check(await shownOutcome(owner) === 'Edited with renderer down', 'reloaded document lost edit made during failure')
    pass('AC6 injected failure: CPU Task/graph survive, list edits persist, actual renderer Retry and semantic reload')

    const gpuLearner = await newPage(browser, errors)
    await authenticate(gpuLearner, 'learner@ux01.test', false)
    current = gpuLearner
    await open(gpuLearner, `/enrollments/${enrollment}`, '#enrolled-version')
    await failRenderer(gpuLearner)
    await select(gpuLearner, 'Vectors', c.ta)
    await openTask(gpuLearner, c.ta)
    await gpuLearner.waitForSelector(`#task-work-${c.ta}[data-draft-state="ready"]`)
    await setValue(gpuLearner, `#task-work-text-${c.ta}`, 'Revision two sent while renderer is unavailable')
    await tabActivate(gpuLearner, `#task-work-send-${c.ta}`)
    await gpuLearner.waitForSelector(`#task-work-${c.ta}[data-status="sent"]`)
    await gpuLearner.waitForSelector(`#task-history-${c.ta}[data-revisions="2"]`)
    check(/Revision\s+1/.test(await text(gpuLearner, `#task-history-${c.ta}`)) && /Revision\s+2/.test(await text(gpuLearner, `#task-history-${c.ta}`)), 'renderer failure lost meaningful Revision history')
    await retryRenderer(gpuLearner, '#enrolled-version')
    current = coach
    await open(coach, `/enrollments/${enrollment}`, '#enrolled-version')
    await failRenderer(coach)
    await select(coach, 'Vectors', c.ta)
    await openTask(coach, c.ta)
    await coach.waitForSelector(`#task-review-${c.ta}[data-target-revision="2"]`)
    await tabActivate(coach, `#task-review-approve-${c.ta}`)
    await coach.waitForSelector(`#task-review-${c.ta}[data-status="recorded"][data-refresh="read"]`)
    check((await ok(coach, `/enrollments/${enrollment}/learning-state`)).learningState.xp === 20, 'second Approval during failure duplicated XP')
    await retryRenderer(coach, '#enrolled-version')
    await open(gpuLearner, `/enrollments/${enrollment}`, '#enrolled-version')
    await select(gpuLearner, 'Vectors', c.ta)
    await openTask(gpuLearner, c.ta)
    await gpuLearner.waitForSelector(`#task-history-${c.ta}[data-revisions="2"]`)
    check((await text(gpuLearner, `#task-history-${c.ta}`)).includes('Revision two sent while renderer is unavailable'), 'reload lost Submission sent during renderer failure')
    pass('AC6 renderer-down learner and Coach: keyboard Submission Revision 2 and Approval, retry both renderers, history after reload, no duplicate XP')

    // Forbidden contextual writes are tested with real sessions, not hidden controls alone.
    const personalBefore = await ok(owner, personalRoute)
    const publishedCoachPath = await ok(coach, `/coach/learning-paths/${coachPath}`)
    await ok(coach, `/coach/learning-paths/${coachPath}/drafts`, 'POST', { expectedRevision: publishedCoachPath.learningPath.revision })
    const draftBefore = await ok(coach, `/coach/learning-paths/${coachPath}`)
    const learningBefore = await ok(coach, `/enrollments/${enrollment}/learning-state`)
    const submissionRoute = `/enrollments/${enrollment}/tasks/${c.ta}/submission`
    const submissionBefore = await ok(coach, submissionRoute)
    const revisionId = submissionBefore.submission.revisions[0].id
    const denied = [
      await api(learner, `${personalRoute}/document`, 'PUT', { ...payload(personalBefore), title: 'Intrusion' }),
      await api(learner, draftRoute, 'PUT', { ...payload(draftBefore), title: 'Intrusion' }),
      await api(coach, `${personalRoute}/document`, 'PUT', { ...payload(personalBefore), title: 'Intrusion' }),
      await api(learner, `${submissionRoute}/revisions/${revisionId}/review`, 'POST', { decision: 'approval', feedback: 'Self approval' }),
    ]
    check(denied.every((r) => [403, 404].includes(r.status)), `cross-context write results: ${denied.map((r) => r.status)}`)
    check(same(await ok(owner, personalRoute), personalBefore) && same(await ok(coach, `/coach/learning-paths/${coachPath}`), draftBefore), 'forbidden write changed a Path')
    check(same(await ok(coach, `/enrollments/${enrollment}/learning-state`), learningBefore) && same(await ok(coach, submissionRoute), submissionBefore), 'forbidden Review changed progress/history')
    pass('AC7 forbidden personal/Draft/self-Review writes leave persisted documents, learning state and Submission history unchanged')
    check(errors.length === 0, `browser errors: ${errors.join('; ')}`)
    console.log(`\nUX01 navigation check passed (${steps.length} journeys). Board and headed P1 acceptance are not claimed.`)
  } catch (error) {
    console.error(`UX01 failed at ${current?.url() ?? 'startup'} after ${steps.length} journeys`)
    if (errors.length) console.error(errors.join('\n'))
    throw error
  } finally {
    await browser?.close()
    web.kill()
    backend.kill()
    resend.stop()
  }
}
main().catch((error) => { console.error(error); process.exit(1) })
