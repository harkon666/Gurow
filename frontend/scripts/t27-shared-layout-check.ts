#!/usr/bin/env bun
/**
 * T27 shared Canvas Layout check (#28): the production frontend build forwarding /api
 * to the production backend entry (Better Auth sessions) on a freshly migrated
 * PostgreSQL database, with email through the Resend HTTP mailer to a local stand-in.
 * Real Accounts take every step. A Coach publishes Linear Algebra and enrolls a
 * learner, who builds learning history (an Approval, Mastery, XP, pending work; sent
 * and decided through the API, as the Review UI is covered by T22-T26). On the
 * published Version's page the Coach drags a card of the shared layout on the WebGPU
 * canvas; the move autosaves as a layout-only update (no new Version, no content
 * change), and undoing it is sent as a new save. The learner sees the new arrangement
 * on reopening, at her own camera; the Coach's camera is stored under his Account and
 * the Version, hers under her Account and Enrollment. The learner can neither move a
 * card nor save positions through the API. Two Coach tabs on the same layout revision:
 * the second save is refused as stale while its arrangement stays on screen, unsaved,
 * until discarded. Learning definitions and history are unchanged throughout.
 *
 * Run from frontend: bun run scripts/t27-shared-layout-check.ts [--skip-build]
 */
import { SQL } from 'bun'
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import puppeteer, { type Browser, type BrowserContext, type Page } from 'puppeteer-core'
import { startResendStandIn } from '../../backend/test/support/resend-stand-in'
import { resolveChromiumExecutable, waitForServerReady } from './benchmark/browser'

const FRONTEND = path.resolve(import.meta.dir, '..')
const BACKEND = path.resolve(FRONTEND, '../backend')
const PORT = Number(process.env.PORT ?? 3531)
const API_PORT = Number(process.env.API_PORT ?? 3532)
const ORIGIN = `http://127.0.0.1:${PORT}`
const SECRET = 't27-browser-check-secret-not-for-production'
const DATABASE_URL = process.env.T27_DATABASE_URL ?? 'postgres://gurow:gurow@127.0.0.1:5433/gurow_t27_browser_test'
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
/** On-screen offset of card `b` from card `a`. */
async function offset(page: Page, a: string, b: string) {
  const ls = await labels(page)
  const from = ls.find((l) => l.id === a)!, to = ls.find((l) => l.id === b)!
  return { x: to.x - from.x, y: to.y - from.y }
}
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
/** Ctrl+wheel over the canvas centre: zoom about the pointer. */
async function wheelZoom(page: Page, deltaY: number) {
  const before = await text(page, '#editor-zoom-label')
  const box = (await (await page.$('#editor-canvas'))!.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.keyboard.down('Control')
  await page.mouse.wheel({ deltaY })
  await page.keyboard.up('Control')
  await page.waitForFunction((z: string) => document.querySelector('#editor-zoom-label')?.textContent?.trim() !== z, {}, before)
}
const storedCamera = (page: Page, key: string) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null'), key)
const cameraKeys = (page: Page) => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('gurow:camera:')).sort())
const zoomText = (zoom: number) => `${Math.round(zoom * 100)}%`

/** Opens a published Version's page as its Coach and waits for the layout canvas, its cards and a saved status. */
async function openVersion(page: Page, versionId: string, revision: number) {
  await page.bringToFront()
  await page.goto(`${ORIGIN}/coach/versions/${versionId}`, { waitUntil: 'networkidle0' })
  await page.waitForSelector('#version-layout[data-gpu-status="ready"]', { timeout: 20000 }).catch(async () => {
    throw new Error(`the layout canvas did not reach 'ready' (status ${await page.$eval('#version-layout', (el) => (el as HTMLElement).dataset.gpuStatus).catch(() => 'absent')})`)
  })
  await page.waitForFunction(() => document.querySelectorAll('[id^="card-label-"]').length === 2)
  await page.waitForSelector(`#layout-save-status[data-state="saved"][data-revision="${revision}"]`)
}
/** Opens an Enrollment page and waits for its renderer, its cards and its learning records. */
async function openEnrollment(page: Page, enrollmentId: string) {
  await page.goto(`${ORIGIN}/enrollments/${enrollmentId}`, { waitUntil: 'networkidle0' })
  await page.waitForSelector('#enrolled-version[data-gpu-status="ready"]', { timeout: 20000 })
  await page.waitForFunction(() => (document.querySelector('#enrollment-xp') as HTMLElement | null)?.dataset.xp !== '')
  await page.waitForFunction(() => document.querySelectorAll('[id^="card-label-"]').length === 2)
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
 * Linear Algebra, published through the Coach's API: Vectors (20-XP Required Task)
 * before Matrices, which requires Mastery of Vectors and 20 XP and has a 15-XP Required Task.
 */
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

    // 0. A Coach publishes Version 1 and enrolls a learner, who builds learning history.
    const { context: coachContext, page: carla } = await newContext(browser, errors)
    current = carla
    const carlaId = await signUpVerified(carla, 'carla@gurow.test')
    const workspace = (await ok(carla, '/coach/workspaces', 'POST', { name: 'Linear Algebra Studio' })).workspace
    const la = await publishLinearAlgebra(carla, workspace.id)
    const { page: lena } = await newContext(browser, errors)
    current = lena
    const lenaId = await signUpVerified(lena, 'lena@gurow.test')
    const enrollment = await inviteAndAccept(carla, lena, la.versionId, 'lena@gurow.test')
    const route = (task: string) => `/enrollments/${enrollment}/tasks/${task}/submission`
    const vectorWork = (await ok(lena, `${route(la.drills)}/revisions`, 'POST', { text: 'Vector drill answers', urls: ['https://example.com/vectors'] })).revision.id
    await ok(carla, `${route(la.drills)}/revisions/${vectorWork}/review`, 'POST', { decision: 'approval', feedback: 'Well done' })
    await ok(lena, `/enrollments/${enrollment}/tasks/${la.matrixDrills}/start`, 'POST')
    await ok(lena, `${route(la.matrixDrills)}/revisions`, 'POST', { text: 'Matrix drill answers' })

    /** Everything that must not change: the Path, its Versions and their content, and the learning records as both readers see them. */
    const definitions = async () => JSON.stringify({
      path: await sql`select id, title, goal, revision from learning_paths where id = ${la.pathId}`,
      versions: await sql`select id, version_number, title, goal, published_at, enrollment_closed_at from learning_path_versions where learning_path_id = ${la.pathId} order by version_number`,
      skills: await sql`select * from version_skills where learning_path_version_id = ${la.versionId} order by skill_id`,
      tasks: await sql`select * from version_tasks where learning_path_version_id = ${la.versionId} order by task_id`,
      prerequisites: await sql`select * from version_prerequisites where learning_path_version_id = ${la.versionId} order by skill_id`,
      enrollment: await sql`select * from enrollments where id = ${enrollment}`,
    })
    const history = async () => JSON.stringify({
      learner: await ok(lena, `/enrollments/${enrollment}/learning-state`),
      coach: await ok(carla, `/enrollments/${enrollment}/learning-state`),
      drills: await ok(lena, route(la.drills)),
      matrixDrills: await ok(lena, route(la.matrixDrills)),
    })
    const storedLayout = async () => {
      const [version] = await sql`select layout_revision from learning_path_versions where id = ${la.versionId}`
      const cards = await sql`select skill_id, x, y from version_skill_cards where learning_path_version_id = ${la.versionId}`
      const at = (id: string) => { const c = cards.find((row: any) => row.skill_id === id); return { x: Number(c.x), y: Number(c.y) } }
      return { revision: Number(version.layout_revision), vectors: at(la.vectors), matrices: at(la.matrices) }
    }
    const definitionsBefore = await definitions()
    const historyBefore = await history()
    check(JSON.parse(historyBefore).learner.learningState.xp === 20, 'the learning history was not built')
    check(JSON.stringify(await storedLayout()) === JSON.stringify({ revision: 0, vectors: { x: 80, y: 120 }, matrices: { x: 420, y: 160 } }), `initial layout ${JSON.stringify(await storedLayout())}`)

    // 1. The learner opens her Enrollment and zooms in: her camera is hers alone.
    await openEnrollment(lena, enrollment)
    await wheelZoom(lena, -60)
    const lenaKey = `gurow:camera:${lenaId}:enrollment:${enrollment}`
    await lena.waitForFunction((k: string) => localStorage.getItem(k) !== null, {}, lenaKey)
    const lenaCamera = await storedCamera(lena, lenaKey)
    check(lenaCamera.zoom > 1, `Lena's camera ${JSON.stringify(lenaCamera)}`)
    const lenaOffsetBefore = await offset(lena, la.vectors, la.matrices)
    check(near(lenaOffsetBefore.x, 340 * lenaCamera.zoom) && near(lenaOffsetBefore.y, 40 * lenaCamera.zoom), `Lena's initial layout ${JSON.stringify(lenaOffsetBefore)}`)
    pass('learner view', `Lena opens Version 1 (WebGPU ready), zooms to ${zoomText(lenaCamera.zoom)}; camera stored under ${lenaKey.slice(0, 32)}…`)

    // 2. The Coach drags a published card on the Version's layout canvas; the move autosaves as a layout-only update.
    await openVersion(carla, la.versionId, 0)
    check((await data(carla, '#editor-canvas')).layoutOnly === 'true' && (await text(carla, '#editor-layout-only-badge')).startsWith('Layout only'), 'the Coach canvas is not layout-only')
    const coachControls = await carla.evaluate(() => ['#editor-add-card-btn', '#new-skill-form', '#connect-skill-select', '[id^="disconnect-"]', '#path-title-input', '#editor-read-only-badge'].filter((s) => document.querySelector(s) !== null))
    check(coachControls.length === 0 && await carla.$('#editor-undo-btn') !== null, `content-editing controls on the layout canvas: ${coachControls}`)
    await wheelZoom(carla, 60)
    const carlaKey = `gurow:camera:${carlaId}:version:${la.versionId}`
    await carla.waitForFunction((k: string) => localStorage.getItem(k) !== null, {}, carlaKey)
    const carlaZoom = (await storedCamera(carla, carlaKey)).zoom
    check(carlaZoom < 1, `Carla's zoom ${carlaZoom}`)
    const carlaOffsetBefore = await offset(carla, la.vectors, la.matrices)
    await drag(carla, la.matrices, 150, 90)
    await carla.waitForSelector('#layout-save-status[data-state="saved"][data-revision="1"]')
    const carlaOffsetAfter = await offset(carla, la.vectors, la.matrices)
    check(near(carlaOffsetAfter.x - carlaOffsetBefore.x, 150) && near(carlaOffsetAfter.y - carlaOffsetBefore.y, 90), `the card moved by ${JSON.stringify(carlaOffsetAfter)} − ${JSON.stringify(carlaOffsetBefore)}`)
    await carla.screenshot({ path: path.resolve(FRONTEND, '../.harness/t27-coach-layout.png') })
    const moved = await storedLayout()
    const dx = 150 / carlaZoom, dy = 90 / carlaZoom
    check(moved.revision === 1 && near(moved.matrices.x, 420 + dx, 1) && near(moved.matrices.y, 160 + dy, 1) && JSON.stringify(moved.vectors) === JSON.stringify({ x: 80, y: 120 }), `stored after the move: ${JSON.stringify(moved)}`)
    check(await definitions() === definitionsBefore && await history() === historyBefore, 'the layout save changed learning definitions or history')
    check(await carla.$('#version-link-2') === null && (await sql`select count(*)::int as n from learning_path_versions where learning_path_id = ${la.pathId}`)[0].n === 1, 'a Version or Draft was created')
    pass('Coach layout save', `Carla (zoom ${zoomText(carlaZoom)}) drags Matrices by (150, 90) px → "Saved · layout revision 1"; stored Matrices (${moved.matrices.x.toFixed(1)}, ${moved.matrices.y.toFixed(1)}); still one Version; Path, Version, Skills, Tasks, Prerequisites, Enrollment and records unchanged`)

    // 3. Undoing the saved move is a new, validated save; redoing it is another.
    await carla.click('#editor-undo-btn')
    await carla.waitForSelector('#layout-save-status[data-state="saved"][data-revision="2"]')
    const undone = await storedLayout()
    check(undone.revision === 2 && JSON.stringify(undone.matrices) === JSON.stringify({ x: 420, y: 160 }), `stored after undo: ${JSON.stringify(undone)}`)
    check(near((await offset(carla, la.vectors, la.matrices)).x, carlaOffsetBefore.x), 'the undo did not move the card back on screen')
    await carla.click('#editor-redo-btn')
    await carla.waitForSelector('#layout-save-status[data-state="saved"][data-revision="3"]')
    const redone = await storedLayout()
    check(redone.revision === 3 && JSON.stringify(redone.matrices) === JSON.stringify(moved.matrices), `stored after redo: ${JSON.stringify(redone)}`)
    check(await definitions() === definitionsBefore && await history() === historyBefore, 'undo/redo changed learning definitions or history')
    pass('undo is a new save', 'Undo → revision 2 with Matrices back at (420, 160); Redo → revision 3 at the moved position; nothing else changed')

    // 4. The learner sees the latest layout on reopening, at her own camera; the Coach's camera stays his.
    check(near((await offset(lena, la.vectors, la.matrices)).x, lenaOffsetBefore.x), 'the open learner page changed before reopening')
    await openEnrollment(lena, enrollment)
    await settle(lena)
    check(await text(lena, '#editor-zoom-label') === zoomText(lenaCamera.zoom), `Lena reopened at ${await text(lena, '#editor-zoom-label')}, not her ${zoomText(lenaCamera.zoom)}`)
    const lenaOffsetAfter = await offset(lena, la.vectors, la.matrices)
    check(near(lenaOffsetAfter.x - lenaOffsetBefore.x, dx * lenaCamera.zoom, 2) && near(lenaOffsetAfter.y - lenaOffsetBefore.y, dy * lenaCamera.zoom, 2), `Lena's reopened layout moved by (${lenaOffsetAfter.x - lenaOffsetBefore.x}, ${lenaOffsetAfter.y - lenaOffsetBefore.y}), expected (${dx * lenaCamera.zoom}, ${dy * lenaCamera.zoom})`)
    check(JSON.stringify(await storedCamera(lena, lenaKey)) === JSON.stringify(lenaCamera) && JSON.stringify(await cameraKeys(lena)) === JSON.stringify([lenaKey]), `Lena's camera storage: ${await cameraKeys(lena)}`)
    check((await data(lena, '#enrolled-version-badge')).versionNumber === '1' && (await data(lena, '#enrollment-xp')).xp === '20', 'the learner page changed Version or XP')
    await openVersion(carla, la.versionId, 3)
    check(await text(carla, '#editor-zoom-label') === zoomText(carlaZoom) && JSON.stringify(await cameraKeys(carla)) === JSON.stringify([carlaKey]), `Carla's camera: ${await text(carla, '#editor-zoom-label')} ${await cameraKeys(carla)}`)
    // The Coach opening the learner's Enrollment has a camera of its own there, not his layout camera.
    await openEnrollment(carla, enrollment)
    check(await text(carla, '#editor-zoom-label') === '100%', `Carla's view of the Enrollment opened at ${await text(carla, '#editor-zoom-label')}`)
    pass('layout refresh and camera isolation', `Lena reopens: Matrices shifted by (${dx.toFixed(1)}, ${dy.toFixed(1)}) world units at her own ${zoomText(lenaCamera.zoom)}; Carla's ${zoomText(carlaZoom)} restored from her Version key; Carla's Enrollment view opens at 100%`)

    // 5. The learner cannot move cards or save positions.
    await openEnrollment(lena, enrollment)
    check((await data(lena, '#editor-canvas')).readOnly === 'true' && await lena.$('#editor-undo-btn') === null && await lena.$('#layout-save-status') === null, 'the learner canvas offers layout editing')
    const lenaOffsetPinned = await offset(lena, la.vectors, la.matrices)
    await drag(lena, la.matrices, -120, 70)
    check(near((await offset(lena, la.vectors, la.matrices)).x, lenaOffsetPinned.x) && near((await offset(lena, la.vectors, la.matrices)).y, lenaOffsetPinned.y), 'dragging moved a card on the learner canvas')
    const learnerWrites = await Promise.all([
      api(lena, `/coach/learning-path-versions/${la.versionId}/layout`, 'PUT', { expectedRevision: 3, cards: [{ id: la.matrices, position: { x: -500, y: -500 } }] }),
      api(lena, `/coach/learning-path-versions/${la.versionId}/layout`, 'PUT', { expectedRevision: 3, cards: [{ id: la.matrices, position: { x: -500, y: -500 } }], application: { skills: [] } }),
      api(lena, `/enrollments/${enrollment}/version/layout`, 'PUT', { expectedRevision: 3, cards: [{ id: la.matrices, position: { x: -500, y: -500 } }] }),
    ])
    check(learnerWrites.every((w) => w.status === 404), `learner layout writes answered ${learnerWrites.map((w) => w.status)}`)
    await lena.goto(`${ORIGIN}/coach/versions/${la.versionId}`, { waitUntil: 'networkidle0' })
    await lena.waitForSelector('#version-unavailable')
    check(await lena.$('#version-layout') === null, 'the learner reached the Coach layout canvas')
    check(JSON.stringify(await storedLayout()) === JSON.stringify(redone), `the learner changed the stored layout: ${JSON.stringify(await storedLayout())}`)
    pass('learner mutation rejected', 'dragging on Lena\'s read-only canvas pans without moving cards; her layout PUTs (plain, with content, on her Enrollment) answer 404; the Coach Version page is unavailable to her; stored layout unchanged')

    // 6. Two Coach tabs on the same layout revision: the second save is refused, its arrangement kept until discarded.
    const tabB = current = await newPage(coachContext, errors)
    await openVersion(carla, la.versionId, 3)
    await openVersion(tabB, la.versionId, 3)
    await drag(carla, la.vectors, -60, 120)
    await carla.waitForSelector('#layout-save-status[data-state="saved"][data-revision="4"]')
    const accepted = await storedLayout()
    check(accepted.revision === 4 && JSON.stringify(accepted.matrices) === JSON.stringify(redone.matrices) && !near(accepted.vectors.y, 120, 1), `stored after tab A: ${JSON.stringify(accepted)}`)
    // Tab B's own navigation (C1) differs from the camera it opened with (C0); discarding the layout must keep it.
    await tabB.bringToFront()
    await wheelZoom(tabB, -60)
    const tabBCamera = await storedCamera(tabB, carlaKey)
    check(!near(tabBCamera.zoom, carlaZoom, 0.01), `tab B's zoom ${tabBCamera.zoom} did not move away from ${carlaZoom}`)
    const tabBBefore = await offset(tabB, la.vectors, la.matrices)
    await drag(tabB, la.matrices, 100, -50)
    await tabB.waitForSelector('#layout-save-status[data-state="conflict"]')
    check((await text(tabB, '#layout-save-conflict')).includes('Layout revision 4 was saved elsewhere') && (await text(tabB, '#layout-save-conflict')).includes('kept but not saved'), `conflict text: ${await text(tabB, '#layout-save-conflict')}`)
    const tabBKept = await offset(tabB, la.vectors, la.matrices)
    await tabB.screenshot({ path: path.resolve(FRONTEND, '../.harness/t27-layout-conflict.png') })
    check(near(tabBKept.x - tabBBefore.x, 100) && near(tabBKept.y - tabBBefore.y, -50), 'tab B lost its local arrangement')
    check(JSON.stringify(await storedLayout()) === JSON.stringify(accepted), `the stale save changed the stored layout: ${JSON.stringify(await storedLayout())}`)
    // A later move in tab B stays local too: nothing is sent after a conflict.
    await drag(tabB, la.matrices, 30, 30)
    await new Promise((r) => setTimeout(r, 900))
    check((await data(tabB, '#layout-save-status')).state === 'conflict' && JSON.stringify(await storedLayout()) === JSON.stringify(accepted), 'tab B saved after its conflict')
    // Loading the saved layout fails once (the backend is unreachable): the conflict and its Discard control stay.
    await tabB.bringToFront()
    await tabB.evaluate((versionId: string) => {
      const original = window.fetch
      let failNext = true
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        if (failNext && String(input).endsWith(`/api/coach/learning-path-versions/${versionId}`) && (init?.method ?? 'GET') === 'GET') {
          failNext = false
          return Promise.reject(new TypeError('Failed to fetch'))
        }
        return original(input, init)
      }) as typeof fetch
    }, la.versionId)
    await tabB.click('#layout-load-accepted-btn')
    await tabB.waitForSelector('#layout-load-error')
    check((await data(tabB, '#layout-save-status')).state === 'conflict' && (await text(tabB, '#layout-load-error')).includes('could not load the saved layout') && await tabB.$('#layout-load-accepted-btn') !== null,
      `after a failed load tab B shows ${(await data(tabB, '#layout-save-status')).state}, Discard ${await tabB.$('#layout-load-accepted-btn') !== null}`)
    check(near((await offset(tabB, la.vectors, la.matrices)).x, tabBKept.x + 30) && JSON.stringify(await storedLayout()) === JSON.stringify(accepted), 'the failed load changed the canvas or the store')
    await tabB.click('#layout-load-accepted-btn')
    await tabB.waitForSelector('#layout-save-status[data-state="saved"][data-revision="4"]')
    await settle(tabB)
    check(await tabB.$('#layout-load-error') === null, 'the load error stayed after the saved layout loaded')
    const tabBLoaded = await offset(tabB, la.vectors, la.matrices)
    check(await text(tabB, '#editor-zoom-label') === zoomText(tabBCamera.zoom) && JSON.stringify(await storedCamera(tabB, carlaKey)) === JSON.stringify(tabBCamera),
      `discarding the layout moved tab B's camera: ${await text(tabB, '#editor-zoom-label')} (stored ${JSON.stringify(await storedCamera(tabB, carlaKey))}), expected ${zoomText(tabBCamera.zoom)}`)
    const tabBZoom = tabBCamera.zoom
    check(near(tabBLoaded.x, (accepted.matrices.x - accepted.vectors.x) * tabBZoom, 2) && near(tabBLoaded.y, (accepted.matrices.y - accepted.vectors.y) * tabBZoom, 2), `tab B after discarding shows ${JSON.stringify(tabBLoaded)}`)
    check(await definitions() === definitionsBefore && await history() === historyBefore, 'the conflict changed learning definitions or history')
    await tabB.close()
    current = carla
    pass('stale layout save', 'tab A moves Vectors → revision 4; tab B (opened at 3) moves Matrices → "Layout revision 4 was saved elsewhere… kept but not saved", its card stays moved, the store keeps revision 4, a further move is not sent; a failed load keeps the conflict and Discard; "Discard mine" then shows revision 4 at tab B\'s own camera')

    // 7. Learning definitions and history are what they were; the published content reads as before.
    await openVersion(carla, la.versionId, 4)
    check((await text(carla, '#published-skills')).includes('Add and scale vectors in R^n') && (await text(carla, '#published-skills')).includes('Requires Mastery of: Vectors') && await carla.$('#version-link-2') === null, 'the published content changed')
    await openEnrollment(lena, enrollment)
    check((await data(lena, '#enrollment-xp')).xp === '20' && (await data(lena, `#skill-status-${la.vectors}`)).mastery === 'mastered' && (await data(lena, '#enrolled-version-badge')).versionNumber === '1', 'the learner\'s progress changed')
    check(await definitions() === definitionsBefore && await history() === historyBefore, 'learning definitions or history changed')
    pass('unchanged learning', 'Path revision, Version 1 content, Enrollment, XP (20), Mastery of Vectors, the approved and pending revisions are identical for both readers after four layout saves and a refused one')

    check(errors.length === 0, `page errors: ${errors.join('; ')}`)
    console.log(`\nT27 shared layout check passed (${steps.length} steps).`)
  } catch (error) {
    const shot = path.resolve(FRONTEND, '../.harness/t27-failure.png')
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
  console.error(`\nT27 shared layout check FAILED after ${steps.length} steps: ${error instanceof Error ? `${error.message}\n${error.stack}` : error}`)
  process.exit(1)
})
