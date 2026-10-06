#!/usr/bin/env bun
/**
 * T28 recovery check (#29): the production frontend build forwarding /api to the
 * production backend entry (Better Auth sessions) on a freshly migrated PostgreSQL
 * database, with email through the Resend HTTP mailer to a local stand-in. Real
 * Accounts take every step on the WebGPU editor.
 *
 * Personal Path: two tabs edit on the same revision; the second tab's save is refused
 * as stale, the accepted state stays, and its editor and Task changes stay on screen
 * and in this browser, listed for inspection. The tab is closed (an interruption); a
 * new tab shows the accepted Path and offers the kept work, whose reapplication is
 * refused by the backend (a Prerequisite cycle with a connection saved meanwhile)
 * without losing it; after the owner resolves the cycle it is reapplied as a new save.
 * Skill identities, card positions, connections and Task contents stay coherent after
 * reload, and kept records with another format, Version or an incoherent document are
 * refused. A Coach's Draft conflict is reapplied from the conflict itself, and kept work
 * of another Version of that Path is never offered. A shared layout conflict is put
 * aside, survives the tab and is reapplied. Account switching in one browser never
 * shows another Account's kept Path work or Submission Draft. Offline Submission,
 * Review and XP requests stay unsuccessful, keep the input, and succeed only once the
 * backend confirms them.
 *
 * Run from frontend: bun run scripts/t28-recovery-check.ts [--skip-build]
 */
import { SQL } from 'bun'
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import puppeteer, { type Browser, type BrowserContext, type HTTPRequest, type Page } from 'puppeteer-core'
import { startResendStandIn } from '../../backend/test/support/resend-stand-in'
import { resolveChromiumExecutable, waitForServerReady } from './benchmark/browser'

const FRONTEND = path.resolve(import.meta.dir, '..')
const BACKEND = path.resolve(FRONTEND, '../backend')
const PORT = Number(process.env.PORT ?? 3541)
const API_PORT = Number(process.env.API_PORT ?? 3542)
const ORIGIN = `http://127.0.0.1:${PORT}`
const SECRET = 't28-browser-check-secret-not-for-production'
const DATABASE_URL = process.env.T28_DATABASE_URL ?? 'postgres://gurow:gurow@127.0.0.1:5433/gurow_t28_browser_test'
const PASSWORD = 'correct horse battery staple'

const steps: string[] = []
function pass(step: string, detail: string) {
  steps.push(step)
  console.log(`  ✓ ${step}: ${detail}`)
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

const resend = startResendStandIn()

async function emailedLink(to: string, subject: string, after = 0) {
  for (let i = 0; i < 100; i++) {
    const fresh = resend.sent.slice(after).filter((e) => e.to.some((a) => a.toLowerCase() === to.toLowerCase()) && e.subject.startsWith(subject))
    const link = fresh.length ? /https?:\/\/\S+/.exec(fresh.at(-1)!.text)?.[0] : undefined
    if (link) return link
    await pause(50)
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
const texts = (page: Page, selector: string) => page.$$eval(selector, (els) => els.map((el) => el.textContent?.trim() ?? ''))
const value = (page: Page, selector: string) => page.$eval(selector, (el) => (el as HTMLInputElement | HTMLTextAreaElement).value)
const data = (page: Page, selector: string): Promise<Record<string, string | undefined>> => page.$eval(selector, (el) => ({ ...(el as HTMLElement).dataset }))
/** React-controlled fields need the native value setter before the input event. */
async function setValue(page: Page, selector: string, v: string) {
  await page.$eval(selector, (el, next) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, next)
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  }, v)
}
/** Types at the end of a field with real key presses. */
async function typeInto(page: Page, selector: string, input: string) {
  await page.focus(selector)
  await page.keyboard.down('Control')
  await page.keyboard.press('End')
  await page.keyboard.up('Control')
  await page.keyboard.type(input)
}
async function authenticate(page: Page, mode: 'sign-in' | 'sign-up', email: string) {
  await page.bringToFront()
  await page.goto(ORIGIN, { waitUntil: 'networkidle0' })
  await page.waitForSelector('#sign-in-form')
  await setValue(page, '#email-input', email)
  await setValue(page, '#password-input', PASSWORD)
  await page.click(mode === 'sign-in' ? '#sign-in-btn' : '#sign-up-btn')
  await page.waitForSelector('#personal-workspace')
}
async function signOut(page: Page) {
  await page.bringToFront()
  await page.goto(ORIGIN, { waitUntil: 'networkidle0' })
  await page.waitForSelector('#sign-out-btn')
  await page.click('#sign-out-btn')
  await page.waitForSelector('#sign-in-form')
}
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
async function offset(page: Page, a: string, b: string) {
  const ls = await labels(page)
  const from = ls.find((l) => l.id === a)!, to = ls.find((l) => l.id === b)!
  return { x: to.x - from.x, y: to.y - from.y }
}
const zoomOf = async (page: Page) => Number((await text(page, '#editor-zoom-label')).replace('%', '')) / 100
const settle = (page: Page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
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
async function drag(page: Page, id: string, dx: number, dy: number) {
  // A background tab runs no animation frames: input goes to the tab in front.
  await page.bringToFront()
  const grab = await cardPoint(page, id)
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  await page.mouse.move(grab.x + dx, grab.y + dy, { steps: 10 })
  await page.mouse.up()
  await settle(page)
}
/** Selects a Skill by clicking its card on the WebGPU canvas. */
async function select(page: Page, id: string) {
  await page.bringToFront()
  const point = await cardPoint(page, id)
  await page.mouse.click(point.x, point.y)
  await page.waitForFunction((want: string) => document.querySelector('#selected-skill-id')?.textContent?.trim() === want, {}, id)
}
const graph = async (page: Page): Promise<string[]> => (JSON.parse(await page.$eval('#skill-detail-panel', (el) => (el as HTMLElement).dataset.connections ?? '[]')) as { from_id: string; to_id: string }[])
  .map((c) => `${c.from_id}>${c.to_id}`).sort()

const saveState = (page: Page, selector = '#save-status') => page.$eval(selector, (el) => ({ state: (el as HTMLElement).dataset.state!, revision: Number((el as HTMLElement).dataset.revision) }))
async function waitForSaved(page: Page, revision: number, selector = '#save-status') {
  await page.waitForFunction((want: number, s: string) => {
    const el = document.querySelector(s) as HTMLElement | null
    return el?.dataset.state === 'saved' && Number(el.dataset.revision) === want
  }, { timeout: 10000 }, revision, selector).catch(async () => {
    throw new Error(`expected "saved" at revision ${revision}, status is ${JSON.stringify(await saveState(page, selector).catch(() => null))}`)
  })
}
async function waitForState(page: Page, state: string, selector = '#save-status') {
  await page.waitForFunction((want: string, s: string) => (document.querySelector(s) as HTMLElement | null)?.dataset.state === want, { timeout: 10000 }, state, selector)
    .catch(async () => { throw new Error(`expected save state ${state}, status is ${JSON.stringify(await saveState(page, selector).catch(() => null))}`) })
}
/** Opens a Path editor (personal or a Coach's Draft) with a live WebGPU renderer, its cards and a saved status. */
async function openPath(page: Page, url: string, cards: number, revision: number) {
  await page.bringToFront()
  await page.goto(`${ORIGIN}${url}`, { waitUntil: 'networkidle0' })
  await page.waitForSelector('#path-editor[data-gpu-status="ready"]', { timeout: 20000 }).catch(async () => {
    throw new Error(`the editor did not reach WebGPU 'ready' (status ${await page.$eval('#path-editor', (el) => (el as HTMLElement).dataset.gpuStatus).catch(() => 'absent')})`)
  })
  await page.waitForFunction((n: number) => document.querySelectorAll('[id^="card-label-"]').length === n, {}, cards)
  await waitForSaved(page, revision)
}
async function openVersion(page: Page, versionId: string, revision: number) {
  await page.bringToFront()
  await page.goto(`${ORIGIN}/coach/versions/${versionId}`, { waitUntil: 'networkidle0' })
  await page.waitForSelector('#version-layout[data-gpu-status="ready"]', { timeout: 20000 })
  await page.waitForFunction(() => document.querySelectorAll('[id^="card-label-"]').length === 2)
  await waitForSaved(page, revision, '#layout-save-status')
}
async function openEnrollment(page: Page, enrollmentId: string) {
  await page.bringToFront()
  await page.goto(`${ORIGIN}/enrollments/${enrollmentId}`, { waitUntil: 'networkidle0' })
  await page.waitForSelector('#enrolled-version[data-gpu-status="ready"]', { timeout: 20000 })
  await page.waitForFunction(() => (document.querySelector('#enrollment-xp') as HTMLElement | null)?.dataset.xp !== '')
  await page.waitForFunction(() => document.querySelectorAll('[id^="card-label-"]').length === 2)
}
const work = (taskId: string) => `#task-work-${taskId}`
const draftReady = (page: Page, taskId: string) => page.waitForSelector(`${work(taskId)}[data-draft-state="ready"]`)
async function waitStatus(page: Page, taskId: string, kind: string) {
  await page.waitForSelector(`${work(taskId)}[data-status="${kind}"]`).catch(async () => {
    throw new Error(`task ${taskId} did not reach status ${kind} (status ${(await data(page, work(taskId))).status}: ${await text(page, work(taskId))})`)
  })
}
const reviewPanel = (taskId: string) => `#task-review-${taskId}`
async function waitReview(page: Page, taskId: string, selector: string) {
  await page.waitForSelector(`${reviewPanel(taskId)}${selector}`).catch(async () => {
    throw new Error(`review of ${taskId} did not reach ${selector} (${JSON.stringify(await data(page, reviewPanel(taskId)).catch(() => null))})`)
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
/** Closes a tab without its beforeunload prompt, as a crash or a killed browser would. */
const interrupt = (page: Page) => page.close({ runBeforeUnload: false })

const keptKeys = (page: Page, prefix: string) => page.evaluate((p) => Object.keys(localStorage).filter((k) => k.startsWith(p)).sort(), prefix)
const keptRecords = (page: Page, prefix: string) => page.evaluate((p) => Object.keys(localStorage).filter((k) => k.startsWith(p)).map((k) => JSON.parse(localStorage.getItem(k)!)), prefix)
const keptEntries = (page: Page, prefix = '') => page.$$eval(`#${prefix}kept-work [data-kept-entry]`, (els) => els.map((el) => ({
  id: (el as HTMLElement).dataset.keptEntry!,
  baseRevision: Number((el as HTMLElement).dataset.baseRevision),
  reapply: (el as HTMLElement).dataset.reapply!,
  text: el.textContent ?? '',
  changes: [...el.querySelectorAll('li')].map((li) => li.textContent?.trim() ?? ''),
})))
async function waitEntry(page: Page, id: string, outcome: string, prefix = '') {
  await page.waitForSelector(`#${prefix}kept-work [data-kept-entry="${id}"][data-reapply="${outcome}"]`).catch(async () => {
    throw new Error(`kept entry ${id} did not reach ${outcome}: ${JSON.stringify(await keptEntries(page, prefix))}`)
  })
}

/** Linear Algebra, published through the Coach's API: Vectors (20-XP Required Task) before Matrices (15-XP Required Task). */
async function publishLinearAlgebra(page: Page, workspaceId: string) {
  const created = await ok(page, `/coach/workspaces/${workspaceId}/learning-paths`, 'POST', { title: 'Linear Algebra', goal: 'Linear maps with confidence' })
  const ids = { vectors: crypto.randomUUID(), matrices: crypto.randomUUID(), drills: crypto.randomUUID(), matrixDrills: crypto.randomUUID() }
  const saved = await ok(page, `/coach/learning-paths/${created.learningPath.id}/draft`, 'PUT', {
    expectedRevision: created.learningPath.revision, title: 'Linear Algebra', goal: 'Linear maps with confidence',
    editor: { format_version: 1, cards: [{ id: ids.vectors, title: 'Vectors', position: { x: 80, y: 120 } }, { id: ids.matrices, title: 'Matrices', position: { x: 420, y: 160 } }], connections: [{ from_id: ids.vectors, to_id: ids.matrices }] },
    application: { skills: [
      { id: ids.vectors, title: 'Vectors', outcome: 'Add and scale vectors in R^n', optional: false, xpThreshold: 0, tasks: [
        { id: ids.drills, title: 'Vector drills', description: 'Exercises 1–10', required: true, xpReward: 20 },
      ] },
      { id: ids.matrices, title: 'Matrices', outcome: 'Multiply matrices as linear maps', optional: false, xpThreshold: 20, tasks: [
        { id: ids.matrixDrills, title: 'Matrix drills', description: 'Exercises 11–20', required: true, xpReward: 15 },
      ] },
    ] },
  })
  const published = await ok(page, `/coach/learning-paths/${created.learningPath.id}/publication`, 'POST', { expectedRevision: saved.learningPath.revision })
  return { pathId: created.learningPath.id as string, versionId: published.version.id as string, ...ids }
}
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
      await pause(300)
    }

    // 0. Pat's personal Path: Vectors and Matrices, one Task each, not connected.
    const { context: patContext, page: patA } = await newContext(browser, errors)
    current = patA
    const patId = await signUpVerified(patA, 'pat@gurow.test')
    const created = await ok(patA, '/personal/learning-paths', 'POST', { title: 'Linear Algebra', goal: 'Self-study' })
    const p = { path: created.learningPath.id as string, vectors: crypto.randomUUID(), matrices: crypto.randomUUID(), vectorTask: crypto.randomUUID(), matrixTask: crypto.randomUUID() }
    const seeded = await ok(patA, `/personal/learning-paths/${p.path}/document`, 'PUT', {
      expectedRevision: created.learningPath.revision, title: 'Linear Algebra', goal: 'Self-study',
      editor: { format_version: 1, cards: [{ id: p.vectors, title: 'Vectors', position: { x: 80, y: 120 } }, { id: p.matrices, title: 'Matrices', position: { x: 480, y: 160 } }], connections: [] },
      application: { skills: [
        { id: p.vectors, title: 'Vectors', outcome: 'Add and scale vectors', tasks: [{ id: p.vectorTask, title: 'Vector drills', description: 'Exercises 1–10' }] },
        { id: p.matrices, title: 'Matrices', outcome: 'Multiply matrices', tasks: [{ id: p.matrixTask, title: 'Matrix drills', description: 'Exercises 11–20' }] },
      ] },
    })
    const r0 = seeded.learningPath.revision as number
    const pathUrl = `/paths/${p.path}`
    const storedPath = () => ok(patA, `/personal/learning-paths/${p.path}`)
    const patPrefix = `gurow:kept-work:${patId}:personal:${p.path}:-:`

    // 1. Two tabs on revision r0: tab A's save is accepted, tab B's is refused as stale and its work stays.
    await openPath(patA, pathUrl, 2, r0)
    const patB = await newPage(patContext, errors)
    current = patB
    await openPath(patB, pathUrl, 2, r0)
    await patA.bringToFront()
    await setValue(patA, '#path-goal-input', 'Goal saved in tab A')
    await waitForSaved(patA, r0 + 1)
    const acceptedByA = await storedPath()
    await select(patB, p.matrices)
    await setValue(patB, '#skill-outcome-input', 'Multiply and invert matrices')
    await waitForState(patB, 'conflict')
    // More work after the conflict stays local: a Task, a card move and a connection.
    await patB.click('#add-task-btn')
    await drag(patB, p.vectors, 60, 80)
    await select(patB, p.matrices)
    await setValue(patB, '#connect-skill-select', p.vectors)
    await patB.click('#btn-add-prerequisite')
    await patB.waitForFunction((pair: string) => (document.querySelector('#skill-detail-panel') as HTMLElement).dataset.connections?.includes(pair.split('>')[1]), {}, `${p.vectors}>${p.matrices}`)
    await pause(900)
    check((await saveState(patB)).state === 'conflict', 'autosave resumed after the conflict')
    check(same(await storedPath(), acceptedByA), `the stale tab changed the accepted Path: ${JSON.stringify((await storedPath()).learningPath)}`)
    const conflictText = await text(patB, '#save-conflict')
    check(conflictText.includes(`Revision ${r0 + 1} was saved elsewhere`) && conflictText.includes('kept but not saved') && conflictText.includes('nothing was overwritten'), `conflict text: ${conflictText}`)
    const conflictChanges = await texts(patB, '#conflict-changes li')
    check(same(conflictChanges, ['Edited the learning outcome of “Matrices”', 'Added the Task “New Task” to “Matrices”', 'Moved the card “Vectors”', 'Connected “Vectors” → “Matrices”']), `listed changes: ${JSON.stringify(conflictChanges)}`)
    check(await patB.$('#reapply-mine-btn') !== null && await patB.$('#keep-aside-btn') !== null && await patB.$('#load-accepted-btn') !== null, 'the conflict does not offer reapply, keep aside and discard')
    await patB.screenshot({ path: path.resolve(FRONTEND, '../.harness/t28-conflict.png') })
    let records = await keptRecords(patB, patPrefix)
    check(records.length === 1, `kept records after the conflict: ${records.length}`)
    const kept = records[0]
    const newTask = kept.mine.application.skills.find((s: any) => s.id === p.matrices).tasks.find((t: any) => t.id !== p.matrixTask)
    const keptVectors = kept.mine.editor.cards.find((c: any) => c.id === p.vectors).position
    check(kept.baseRevision === r0 && kept.context.accountId === patId && kept.context.versionId === null && kept.base.goal === 'Self-study' && kept.mine.editor.format_version === 1 &&
      kept.mine.application.skills.find((s: any) => s.id === p.matrices).outcome === 'Multiply and invert matrices' && newTask?.title === 'New Task' &&
      (keptVectors.x !== 80 || keptVectors.y !== 120) && same(kept.mine.editor.connections, [{ from_id: p.vectors, to_id: p.matrices }]), `kept record: ${JSON.stringify(kept)}`)
    check(await value(patB, '#skill-outcome-input') === 'Multiply and invert matrices' && await value(patB, `#task-edit-title-${newTask.id}`) === 'New Task' && await value(patB, '#path-goal-input') === 'Self-study', 'the stale tab lost its local work')
    pass('competing tabs', `tab A saved rev ${r0 + 1}; tab B's save on rev ${r0} → conflict "${conflictText.slice(0, 60)}…", 4 changes listed, PostgreSQL still holds tab A's Path, tab B's outcome/Task/move/connection kept on screen and under ${patPrefix.slice(0, 26)}… (base rev ${r0})`)

    // 2. The tab is interrupted; a new tab shows the accepted Path and offers the kept work.
    await interrupt(patB)
    const patC = await newPage(patContext, errors)
    current = patC
    await openPath(patC, pathUrl, 2, r0 + 1)
    await patC.waitForSelector('#kept-work [data-kept-entry]')
    let entries = await keptEntries(patC)
    check(entries.length === 1 && entries[0].id === kept.id && entries[0].baseRevision === r0 && same(entries[0].changes, conflictChanges) && entries[0].text.includes(`Revision ${r0 + 1} is saved now`), `kept work offered: ${JSON.stringify(entries)}`)
    check(await value(patC, '#path-goal-input') === 'Goal saved in tab A', 'the reopened tab does not show the accepted goal')
    await select(patC, p.matrices)
    check(await value(patC, '#skill-outcome-input') === 'Multiply matrices' && await patC.$(`#task-edit-title-${newTask.id}`) === null && (await graph(patC)).length === 0, 'the kept work was applied without being asked')
    pass('recovery after interruption', `tab B closed without a prompt; a new tab shows rev ${r0 + 1} (tab A's goal, original outcome) and offers the kept work based on rev ${r0} with the same 4 changes`)

    // 3. Reapplying is refused by the backend when the merge forms a cycle with a connection saved meanwhile; the work stays kept.
    await select(patA, p.vectors)
    await setValue(patA, '#connect-skill-select', p.matrices)
    await patA.click('#btn-add-prerequisite')
    await waitForSaved(patA, r0 + 2)
    const beforeRefusal = await storedPath()
    check(same(beforeRefusal.editor.connections, [{ from_id: p.matrices, to_id: p.vectors }]), `tab A's connection: ${JSON.stringify(beforeRefusal.editor.connections)}`)
    await patC.bringToFront()
    await patC.click(`#kept-work [data-kept-entry="${kept.id}"] [data-action="reapply"]`)
    await waitEntry(patC, kept.id, 'refused')
    const refusal = await text(patC, `#kept-outcome-${kept.id}`)
    check(refusal.includes('Gurow refused the reapplied changes') && refusal.includes('cycle') && refusal.includes('“Vectors”') && refusal.includes('still kept'), `refusal: ${refusal}`)
    await patC.screenshot({ path: path.resolve(FRONTEND, '../.harness/t28-kept-refused.png') })
    check(same(await storedPath(), beforeRefusal), 'the refused reapplication changed the stored Path')
    check(same((await keptRecords(patC, patPrefix)).map((r) => r.id), [kept.id]), 'the refused work is no longer kept')
    // The editor, which held nothing unsaved, now shows the version the changes were refused against.
    await waitForSaved(patC, r0 + 2)
    await select(patC, p.vectors)
    check(same(await graph(patC), [`${p.matrices}>${p.vectors}`]), `tab C's graph after the refusal: ${await graph(patC)}`)
    pass('rejected reapplication', `tab A connected Matrices → Vectors (rev ${r0 + 2}); reapplying the kept Vectors → Matrices → "${refusal.slice(0, 80)}…"; PostgreSQL unchanged, the work still kept, the editor shows rev ${r0 + 2}`)

    // 4. The owner removes the conflicting connection, then reapplies: one new validated save holding both sides' work.
    await patC.click(`#disconnect-${p.matrices}-${p.vectors}`)
    await waitForSaved(patC, r0 + 3)
    await patC.click(`#kept-work [data-kept-entry="${kept.id}"] [data-action="reapply"]`)
    await patC.waitForFunction(() => document.querySelector('#kept-work [data-kept-entry]') === null)
    await waitForSaved(patC, r0 + 4)
    const reapplied = await storedPath()
    const matrices = reapplied.application.skills.find((s: any) => s.id === p.matrices)
    check(reapplied.learningPath.revision === r0 + 4 && reapplied.learningPath.goal === 'Goal saved in tab A' && matrices.outcome === 'Multiply and invert matrices' &&
      same(matrices.tasks.map((t: any) => [t.id, t.title]), [[p.matrixTask, 'Matrix drills'], [newTask.id, 'New Task']]) &&
      same(reapplied.editor.connections, [{ from_id: p.vectors, to_id: p.matrices }]) &&
      same(reapplied.editor.cards.find((c: any) => c.id === p.vectors).position, keptVectors) && same(reapplied.editor.cards.find((c: any) => c.id === p.matrices).position, { x: 480, y: 160 }),
    `reapplied Path: ${JSON.stringify(reapplied)}`)
    check(same(reapplied.editor.cards.map((c: any) => c.id).sort(), reapplied.application.skills.map((s: any) => s.id).sort()), 'cards and Skills diverged')
    check((await keptKeys(patC, patPrefix)).length === 0, 'the reapplied work is still kept')

    // Coherent after a real reload: identities, positions, connections and Task contents as stored.
    await openPath(patC, pathUrl, 2, r0 + 4)
    check(await patC.$('#kept-work') === null, 'kept work offered again after it was saved')
    const zoom = await zoomOf(patC)
    const shown = await offset(patC, p.vectors, p.matrices)
    check(Math.abs(shown.x - (480 - keptVectors.x) * zoom) <= 2 && Math.abs(shown.y - (160 - keptVectors.y) * zoom) <= 2, `card offset after reload ${JSON.stringify(shown)} at zoom ${zoom}`)
    await select(patC, p.matrices)
    check(await value(patC, '#skill-outcome-input') === 'Multiply and invert matrices' && await value(patC, `#task-edit-title-${newTask.id}`) === 'New Task' && await value(patC, `#task-edit-title-${p.matrixTask}`) === 'Matrix drills' &&
      same(await graph(patC), [`${p.vectors}>${p.matrices}`]), 'the reloaded editor and Task panel disagree with the stored Path')
    pass('reapplied as a new save', `after removing Matrices → Vectors (rev ${r0 + 3}), reapplying saved rev ${r0 + 4}: tab A's goal + tab B's outcome, Task ${newTask.id.slice(0, 8)}…, moved card and connection; after reload the canvas offset, Task panel and graph match PostgreSQL`)

    // 5. Kept records are restored only whole and only in their own format, Account and Version context.
    await patC.evaluate((prefix: string, accountId: string, pathId: string, base: any) => {
      const record = (id: string, change: (r: any) => void) => {
        const r = { format: 1, id, context: { accountId, kind: 'personal', pathId, versionId: null }, baseRevision: 0, base, mine: structuredClone(base), editedAt: new Date().toISOString() }
        r.mine.goal = 'Forged goal'
        change(r)
        localStorage.setItem(`${prefix}${id}`, JSON.stringify(r))
      }
      record('canvas-format', (r) => { r.mine.editor.format_version = 2 })
      record('other-version', (r) => { r.context.versionId = 'a-version-id' })
      record('record-format', (r) => { r.format = 2 })
      record('orphan-card', (r) => { r.mine.application.skills.pop() })
    }, patPrefix, patId, p.path, kept.base)
    await openPath(patC, pathUrl, 2, r0 + 4)
    await patC.waitForSelector('#kept-work-refused')
    const refusedText = await text(patC, '#kept-work-refused')
    check(['canvas format version 2 is not supported', 'belongs to another Account, Path or Version', 'record format 2 is not supported', 'has no Skill'].every((s) => refusedText.includes(s)) && (await keptEntries(patC)).length === 0, `refused records: ${refusedText}`)
    check((await keptKeys(patC, patPrefix)).length === 0 && (await storedPath()).learningPath.goal === 'Goal saved in tab A', 'refused records were kept or applied')
    pass('incoherent records refused', `"${refusedText.slice(0, 110)}…"; none offered, all removed, the stored goal unchanged`)

    // 6. A Coach's Draft conflict is reapplied from the conflict; kept work of another Version of the Path is not offered.
    const { context: carlaContext, page: carla } = await newContext(browser, errors)
    current = carla
    const carlaId = await signUpVerified(carla, 'carla@gurow.test')
    const workspace = (await ok(carla, '/coach/workspaces', 'POST', { name: 'Linear Algebra Studio' })).workspace
    const la = await publishLinearAlgebra(carla, workspace.id)
    const published = await ok(carla, `/coach/learning-paths/${la.pathId}`)
    const prepared = await ok(carla, `/coach/learning-paths/${la.pathId}/drafts`, 'POST', { expectedRevision: published.learningPath.revision })
    const draftId = prepared.draft.id as string
    const rd = prepared.learningPath.revision as number
    check(draftId !== la.versionId && prepared.draft.versionNumber === 2, `prepared Draft ${JSON.stringify(prepared.draft)}`)
    const draftPrefix = `gurow:kept-work:${carlaId}:draft:${la.pathId}:${draftId}:`
    // Work kept for Version 1 of the same Path at the same save revision: another Learning Path Version.
    await carla.evaluate((accountId: string, pathId: string, versionId: string, revision: number, document: any) => {
      const base = { title: document.learningPath.title, goal: document.learningPath.goal, editor: { format_version: 1, cards: document.editor.cards, connections: document.editor.connections }, application: document.application }
      const mine = { ...structuredClone(base), goal: 'Goal kept for Version 1' }
      localStorage.setItem(`gurow:kept-work:${accountId}:draft:${pathId}:${versionId}:v1-work`, JSON.stringify({ format: 1, id: 'v1-work', context: { accountId, kind: 'draft', pathId, versionId }, baseRevision: revision, base, mine, editedAt: new Date().toISOString() }))
    }, carlaId, la.pathId, la.versionId, rd, prepared)
    const draftUrl = `/coach/paths/${la.pathId}`
    await openPath(carla, draftUrl, 2, rd)
    const carlaB = await newPage(carlaContext, errors)
    current = carlaB
    await openPath(carlaB, draftUrl, 2, rd)
    check(await carla.$('#kept-work') === null && await carlaB.$('#kept-work') === null && !(await carlaB.content()).includes('Goal kept for Version 1'), 'work kept for Version 1 is offered in the Draft of Version 2')
    await carla.bringToFront()
    await setValue(carla, '#path-goal-input', 'Draft goal from tab 1')
    await waitForSaved(carla, rd + 1)
    await drag(carlaB, la.matrices, 60, 70)
    await select(carlaB, la.vectors)
    await setValue(carlaB, `#task-xp-reward-${la.drills}`, '30')
    await waitForState(carlaB, 'conflict')
    check(same(await texts(carlaB, '#conflict-changes li'), ['Set the reward of “Vector drills” to 30 XP', 'Moved the card “Matrices”']) && (await keptKeys(carlaB, draftPrefix)).length === 1, `Draft conflict changes: ${await texts(carlaB, '#conflict-changes li')}`)
    const draftMine = (await keptRecords(carlaB, draftPrefix))[0].mine
    const movedMatrices = draftMine.editor.cards.find((c: any) => c.id === la.matrices).position
    // The reapplied save is held; meanwhile Ctrl+Z (a window shortcut the locked editor still receives) undoes the move.
    let held: HTTPRequest | null = null
    const hold = (request: HTTPRequest) => {
      if (request.isInterceptResolutionHandled()) return
      if (request.method() === 'PUT' && request.url().endsWith('/draft') && held === null) held = request
      else void request.continue()
    }
    await carlaB.setRequestInterception(true)
    carlaB.on('request', hold)
    await carlaB.click('#reapply-mine-btn')
    for (let i = 0; i < 100 && held === null; i++) await pause(50)
    check(held !== null, 'the reapplied save was not sent')
    const locked = await carlaB.evaluate(() => ['#path-goal-input', '#new-skill-title', '#editor-canvas'].map((s) => document.querySelector(s)?.closest('[inert]') !== null))
    check((await data(carlaB, '#path-editor')).reapplying === 'true' && locked.every(Boolean) && await carlaB.$eval('#reapply-mine-btn', (el) => (el as HTMLButtonElement).disabled), `the editor is not locked while reapplying: ${locked}`)
    await carlaB.keyboard.down('Control')
    await carlaB.keyboard.press('z')
    await carlaB.keyboard.up('Control')
    await carlaB.waitForFunction((prefix: string, id: string, x: number) => Object.keys(localStorage).filter((k) => k.startsWith(prefix))
      .some((k) => JSON.parse(localStorage.getItem(k)!).mine.editor.cards.find((c: any) => c.id === id).position.x !== x), {}, draftPrefix, la.matrices, movedMatrices.x)
    await (held as HTTPRequest | null)!.continue()
    carlaB.off('request', hold)
    await carlaB.setRequestInterception(false)
    await waitForSaved(carlaB, rd + 2)
    // The undo made during the save is not lost when the reapplied Draft replaces the editor's document.
    await carlaB.waitForSelector('#kept-work [data-kept-entry]')
    const slipped = await keptEntries(carlaB)
    check(slipped.length === 1 && same(slipped[0].changes, ['Moved the card “Matrices”']) && (await keptKeys(carlaB, draftPrefix)).length === 1, `edit made while reapplying: ${JSON.stringify(slipped)}`)
    check((await data(carlaB, '#path-editor')).reapplying === 'false', 'the editor stayed locked')
    await carlaB.click(`#kept-work [data-kept-entry="${slipped[0].id}"] [data-action="discard"]`)
    await carlaB.waitForFunction(() => document.querySelector('#kept-work [data-kept-entry]') === null)
    // Showing the accepted Draft clears the selection, as loading any accepted document does.
    await select(carlaB, la.vectors)
    check(await carlaB.$('#save-conflict') === null && await value(carlaB, '#path-goal-input') === 'Draft goal from tab 1' && await value(carlaB, `#task-xp-reward-${la.drills}`) === '30', 'the reapplied Draft is not shown')
    const draft = await ok(carla, `/coach/learning-paths/${la.pathId}`)
    check(draft.learningPath.revision === rd + 2 && draft.learningPath.goal === 'Draft goal from tab 1' && draft.application.skills[0].tasks[0].xpReward === 30 && draft.draft.id === draftId && draft.versions.length === 1 &&
      same(draft.editor.cards.find((c: any) => c.id === la.matrices).position, movedMatrices),
      `stored Draft: ${JSON.stringify({ revision: draft.learningPath.revision, goal: draft.learningPath.goal, reward: draft.application.skills[0].tasks[0].xpReward, versions: draft.versions.length })}`)
    check((await keptKeys(carlaB, draftPrefix)).length === 0 && (await keptKeys(carlaB, `gurow:kept-work:${carlaId}:draft:${la.pathId}:${la.versionId}:`)).length === 1, 'the Draft\'s kept work remains, or Version 1\'s was touched')
    const version1 = await ok(carla, `/coach/learning-path-versions/${la.versionId}`)
    check(version1.application.skills[0].tasks[0].xpReward === 20 && version1.learningPath.goal !== 'Draft goal from tab 1', 'the published Version changed')
    await carlaB.close()
    pass('Draft conflict reapplied', `Draft v2 (id ${draftId.slice(0, 8)}…, save rev ${rd}): tab 1 saved the goal (rev ${rd + 1}); tab 2's move + reward edit → conflict → "Reapply my changes to revision ${rd + 1}" (editor locked; a Ctrl+Z during the held save kept as its own work, not lost) saved rev ${rd + 2} with both; Version 1 unchanged; work kept for Version 1 at the same save revision never offered`)

    // 7. A shared layout conflict: the arrangement is put aside, survives its tab, and is reapplied onto the accepted layout.
    const layoutPrefix = `gurow:kept-work:${carlaId}:layout:${la.pathId}:${la.versionId}:`
    const storedLayout = async () => {
      const [version] = await sql`select layout_revision from learning_path_versions where id = ${la.versionId}`
      const cards = await sql`select skill_id, x, y from version_skill_cards where learning_path_version_id = ${la.versionId}`
      const at = (id: string) => { const c = cards.find((row: any) => row.skill_id === id); return { x: Number(c.x), y: Number(c.y) } }
      return { revision: Number(version.layout_revision), vectors: at(la.vectors), matrices: at(la.matrices) }
    }
    await openVersion(carla, la.versionId, 0)
    const l2 = await newPage(carlaContext, errors)
    current = l2
    await openVersion(l2, la.versionId, 0)
    await drag(carla, la.vectors, 90, 40)
    await waitForSaved(carla, 1, '#layout-save-status')
    const afterL1 = await storedLayout()
    await drag(l2, la.matrices, 70, 90)
    await waitForState(l2, 'conflict', '#layout-save-status')
    check(same(await texts(l2, '#layout-conflict-changes li'), ['Moved the card “Matrices”']) && (await text(l2, '#layout-save-conflict')).includes('Layout revision 1 was saved elsewhere'), `layout conflict: ${await text(l2, '#layout-save-conflict')}`)
    const layoutKept = (await keptRecords(l2, layoutPrefix))[0]
    const mineMatrices = layoutKept.mine.find((c: any) => c.id === la.matrices).position
    await l2.click('#layout-keep-aside-btn')
    await waitForSaved(l2, 1, '#layout-save-status')
    await l2.waitForSelector('#layout-kept-work [data-kept-entry]')
    check(same(await storedLayout(), afterL1), 'putting the arrangement aside saved it')
    await interrupt(l2)
    const l3 = await newPage(carlaContext, errors)
    current = l3
    await openVersion(l3, la.versionId, 1)
    const layoutEntries = await keptEntries(l3, 'layout-')
    check(layoutEntries.length === 1 && layoutEntries[0].baseRevision === 0 && same(layoutEntries[0].changes, ['Moved the card “Matrices”']), `kept layout work: ${JSON.stringify(layoutEntries)}`)
    await l3.click(`#layout-kept-work [data-kept-entry="${layoutEntries[0].id}"] [data-action="reapply"]`)
    await waitForSaved(l3, 2, '#layout-save-status')
    await l3.waitForFunction(() => document.querySelector('#layout-kept-work [data-kept-entry]') === null)
    const reappliedLayout = await storedLayout()
    check(reappliedLayout.revision === 2 && same(reappliedLayout.vectors, afterL1.vectors) && same(reappliedLayout.matrices, mineMatrices) && (await keptKeys(l3, layoutPrefix)).length === 0, `reapplied layout ${JSON.stringify(reappliedLayout)}, kept Matrices ${JSON.stringify(mineMatrices)}`)
    await l3.close()
    current = carla
    pass('layout kept aside and reapplied', `tab 1 moved Vectors (layout rev 1); tab 2's Matrices move → conflict → "Show the saved version, keep mine aside" → tab closed; a new tab offers it (base 0) and reapplies → layout rev 2 with both moves`)

    // 8. Account switching on one browser: another Account sees none of Pat's kept Path work.
    const patD = await newPage(patContext, errors)
    current = patD
    await openPath(patD, pathUrl, 2, r0 + 4)
    await patD.setOfflineMode(true)
    await setValue(patD, '#path-goal-input', 'Offline goal by Pat')
    await waitForState(patD, 'failed')
    await patD.setOfflineMode(false)
    check((await keptRecords(patD, patPrefix)).some((r) => r.mine.goal === 'Offline goal by Pat') && (await storedPath()).learningPath.goal === 'Goal saved in tab A', 'the failed save was stored, or its work not kept')
    await interrupt(patD)
    await signOut(patA)
    current = patA
    await authenticate(patA, 'sign-up', 'quinn@gurow.test')
    const quinnId = (await ok(patA, '/account')).account.id as string
    await patA.goto(`${ORIGIN}${pathUrl}`, { waitUntil: 'networkidle0' })
    await patA.waitForSelector('#path-unavailable')
    check(await patA.$('#kept-work') === null && !(await patA.content()).includes('Offline goal by Pat'), 'Quinn sees Pat\'s kept work on Pat\'s Path')
    const quinnPath = (await ok(patA, '/personal/learning-paths', 'POST', { title: 'Quinn\'s Path', goal: 'Own goal' })).learningPath
    await openPath(patA, `/paths/${quinnPath.id}`, 0, quinnPath.revision)
    check(await patA.$('#kept-work') === null && !(await patA.content()).includes('Offline goal by Pat') && quinnId !== patId, 'Quinn\'s own Path offers Pat\'s kept work')
    check((await keptKeys(patA, patPrefix)).length === 1, 'Quinn\'s session removed Pat\'s kept work')
    await signOut(patA)
    await authenticate(patA, 'sign-in', 'pat@gurow.test')
    await openPath(patA, pathUrl, 2, r0 + 4)
    entries = await keptEntries(patA)
    check(entries.length === 1 && same(entries[0].changes, ['Changed the goal to “Offline goal by Pat”']), `Pat's kept work after switching back: ${JSON.stringify(entries)}`)
    await patA.click(`#kept-work [data-kept-entry="${entries[0].id}"] [data-action="discard"]`)
    await patA.waitForFunction(() => document.querySelector('#kept-work [data-kept-entry]') === null)
    check((await keptKeys(patA, patPrefix)).length === 0 && (await storedPath()).learningPath.goal === 'Goal saved in tab A', 'discarding kept work stored it or kept it')
    pass('personal Account switching', 'Pat\'s offline goal edit failed and was kept; signed out; Quinn on the same browser gets "not available" for Pat\'s Path and no kept work on either Path; Pat signs back in and is offered it, then discards it')

    // Learner drafts: Pia, on Lena's browser, sees none of Lena's unsent work.
    const { page: learner } = await newContext(browser, errors)
    current = learner
    await signUpVerified(learner, 'pia@gurow.test')
    const piaEnrollment = await inviteAndAccept(carla, learner, la.versionId, 'pia@gurow.test')
    await signOut(learner)
    await signUpVerified(learner, 'lena@gurow.test')
    const enrollment = await inviteAndAccept(carla, learner, la.versionId, 'lena@gurow.test')
    await openEnrollment(learner, enrollment)
    await select(learner, la.vectors)
    await draftReady(learner, la.drills)
    await typeInto(learner, `#task-work-text-${la.drills}`, 'Lena: u + v = (3, 1)')
    check((await data(learner, work(la.drills))).keptLocally === 'true', 'Lena\'s unsaved draft is not kept locally')
    await signOut(learner)
    await authenticate(learner, 'sign-in', 'pia@gurow.test')
    await openEnrollment(learner, piaEnrollment)
    await select(learner, la.vectors)
    await draftReady(learner, la.drills)
    check(await value(learner, `#task-work-text-${la.drills}`) === '' && await learner.$(`#task-work-recovered-${la.drills}`) === null && !(await learner.content()).includes('Lena: u + v'), 'Pia sees Lena\'s unsent draft')
    await learner.goto(`${ORIGIN}/enrollments/${enrollment}`, { waitUntil: 'networkidle0' })
    await learner.waitForSelector('#enrollment-unavailable')
    check(!(await learner.content()).includes('Lena: u + v'), 'Lena\'s Enrollment page shows her draft to Pia')
    await signOut(learner)
    await authenticate(learner, 'sign-in', 'lena@gurow.test')
    await openEnrollment(learner, enrollment)
    await select(learner, la.vectors)
    await draftReady(learner, la.drills)
    check(await value(learner, `#task-work-text-${la.drills}`) === 'Lena: u + v = (3, 1)' && await learner.$(`#task-work-recovered-${la.drills}`) !== null, 'Lena\'s unsent draft did not come back')
    pass('learner Account switching', 'Lena\'s unsaved draft kept locally; Pia signing in on the same browser sees an empty draft for the same Task and "not available" for Lena\'s Enrollment; Lena signs back in and gets it restored')

    // 9. Offline Submission, Review and XP: unsuccessful until the backend confirms, with the input kept.
    const storedRevisions = async () => [...await sql`select r.revision_number from submission_revisions r join submissions s on s.id = r.submission_id where s.enrollment_id = ${enrollment} and s.task_id = ${la.drills}`]
    await learner.setOfflineMode(true)
    await learner.click(`#task-work-send-${la.drills}`)
    await waitStatus(learner, la.drills, 'not-sent')
    await learner.setOfflineMode(false)
    check((await text(learner, `#task-work-status-${la.drills}`)).startsWith('Not sent: the backend could not be reached. Nothing was submitted') && await value(learner, `#task-work-text-${la.drills}`) === 'Lena: u + v = (3, 1)' && (await storedRevisions()).length === 0,
      `offline send: ${await text(learner, `#task-work-status-${la.drills}`)}`)
    await learner.click(`#task-work-send-${la.drills}`)
    await waitStatus(learner, la.drills, 'sent')
    check((await storedRevisions()).length === 1, 'the confirmed send is not stored')

    await openEnrollment(carla, enrollment)
    await select(carla, la.vectors)
    await carla.waitForSelector(`${reviewPanel(la.drills)}[data-target-revision="1"]`)
    await typeInto(carla, `#task-review-feedback-${la.drills}`, 'Correct: well done.')
    const storedReviews = async () => [...await sql`select v.decision from submission_reviews v join submission_revisions r on r.id = v.revision_id join submissions s on s.id = r.submission_id where s.enrollment_id = ${enrollment}`]
    await carla.setOfflineMode(true)
    await carla.click(`#task-review-approve-${la.drills}`)
    await waitReview(carla, la.drills, '[data-status="unconfirmed"][data-checked="false"]')
    check(await value(carla, `#task-review-feedback-${la.drills}`) === 'Correct: well done.' && (await data(carla, '#enrollment-xp')).xp === '0', 'the offline decision lost the feedback or showed XP')
    await carla.setOfflineMode(false)
    check((await storedReviews()).length === 0 && (await ok(learner, `/enrollments/${enrollment}/learning-state`)).learningState.xp === 0, 'the offline decision was stored')
    await carla.click(`#task-review-check-${la.drills}`)
    await waitReview(carla, la.drills, '[data-status="unconfirmed"][data-checked="true"]')
    await carla.click(`#task-review-approve-${la.drills}`)
    await waitReview(carla, la.drills, '[data-status="recorded"][data-refresh="read"]')
    check((await data(carla, '#enrollment-xp')).xp === '20' && (await storedReviews()).length === 1, 'the confirmed Approval did not show XP 20')

    await ok(patA, `/personal/learning-paths/${p.path}/tasks/${p.vectorTask}/reward`, 'PUT', { xpReward: 10 })
    await openPath(patA, pathUrl, 2, r0 + 4)
    await patA.waitForFunction(() => (document.querySelector('#path-xp') as HTMLElement | null)?.dataset.xp === '0')
    await select(patA, p.vectors)
    await patA.setOfflineMode(true)
    await patA.click(`#task-completion-btn-${p.vectorTask}`)
    await patA.waitForSelector('#learning-error')
    check((await data(patA, '#path-xp')).xp === '0' && (await data(patA, `#task-learning-${p.vectorTask}`)).completed === 'false', 'the offline completion was shown as done')
    await patA.setOfflineMode(false)
    check((await ok(patA, `/personal/learning-paths/${p.path}/learning-state`)).learningState.xp === 0, 'the offline completion was stored')
    await patA.click('#learning-retry-btn')
    await patA.waitForFunction(() => (document.querySelector('#path-xp') as HTMLElement | null)?.dataset.xp === '10')
    check((await ok(patA, `/personal/learning-paths/${p.path}/learning-state`)).learningState.xp === 10, 'the retried completion is not stored')
    pass('offline learning requests', 'offline Send → "Not sent…", text kept, no revision; online Send stored Revision 1. Offline Approval → unconfirmed with the feedback kept, XP 0 and no Review stored; Check again → not recorded; Approve → recorded, XP 20 after the read. Offline completion → error, XP 0; Retry → XP 10 once confirmed')

    check(errors.length === 0, `page errors: ${errors.join('; ')}`)
    await carla.screenshot({ path: path.resolve(FRONTEND, '../.harness/t28-coach-review.png') }).catch(() => {})
    console.log(`\nT28 recovery check passed (${steps.length} steps).`)
  } catch (error) {
    const shot = path.resolve(FRONTEND, '../.harness/t28-failure.png')
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
  console.error(`\nT28 recovery check FAILED after ${steps.length} steps: ${error instanceof Error ? `${error.message}\n${error.stack}` : error}`)
  process.exit(1)
})
