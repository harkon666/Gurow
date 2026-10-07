#!/usr/bin/env bun
/**
 * UX02 (#48, parent #46): drag Prerequisite connections on the current build,
 * against real BetterAuth, the backend and an isolated migrated PostgreSQL.
 * Requires harness checks build and db-up; isolated ports 3593/3594 and database
 * gurow_ux02_browser_test make this check eligible for parallel execution.
 * Run from frontend: bun run scripts/ux02-connections-check.ts [--skip-build]
 *
 * AC1: body drag moves a card, its connection point starts a connection; points on
 *      hover/selection; selection, box multiselection, pan and zoom still work.
 * AC2: fresh A, B, C created through Add Skill; A → C and B → C dragged with real
 *      pointer input; valid targets highlighted; reload restores both edges.
 * AC3: Escape, empty-canvas drop, self, duplicate, cycle, Optional → required and
 *      missing/foreign endpoints leave the graph and revision unchanged, with feedback.
 * AC4: a pressed connection is selected and deleted (button and Delete key); one
 *      undo/redo per gesture; undo of a saved edit is a new save; failed persistence
 *      keeps the edge locally until retried.
 * AC5: the keyboard detail action makes and removes the same edges with the same
 *      validations; a learner and a published layout cannot connect.
 * AC6: every gesture runs at a changed pan/zoom; endpoints follow the label geometry.
 * AC7: stale write keeps the drag edit and reapplies it; ALL-prerequisite Access,
 *      renderer failure and retry keep the one Rust-owned graph.
 */
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import path from 'node:path'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import { startResendStandIn } from '../../backend/test/support/resend-stand-in'
import { resolveChromiumExecutable, waitForServerReady } from './benchmark/browser'

const FRONTEND = path.resolve(import.meta.dir, '..')
const BACKEND = path.resolve(FRONTEND, '../backend')
const PORT = 3593
const API_PORT = 3594
const ORIGIN = `http://127.0.0.1:${PORT}`
const DATABASE_URL = 'postgres://gurow:gurow@127.0.0.1:5433/gurow_ux02_browser_test'
const PASSWORD = 'correct horse battery staple'
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }
function pass(message: string) { console.log(`  ✓ ${message}`) }
type Edge = { from_id: string; to_id: string }
type Box = { x: number; y: number; width: number; height: number; cx: number; cy: number }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const edgeKey = (edges: Edge[]) => edges.map((e) => `${e.from_id}>${e.to_id}`).sort().join(',')

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
const visible = (page: Page, selector: string) => page.$eval(selector, (el) => el.getClientRects().length > 0).catch(() => false)
const text = (page: Page, selector: string) => page.$eval(selector, (el) => (el as HTMLElement).innerText.trim())
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
    server.once('error', (error) => reject(new Error(`UX02 requires unused port ${port}: ${error.message}`)))
    server.listen(port, '127.0.0.1', () => server.close((error) => error ? reject(error) : resolve()))
  })
}
async function box(page: Page, selector: string): Promise<Box> {
  const r = await page.$eval(selector, (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height } })
  return { ...r, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }
}
/** The engine graph as the application holds it (also present while no Skill is open). */
async function localEdges(page: Page): Promise<Edge[]> {
  return JSON.parse(await page.$eval('#skill-detail-panel', (el) => el.getAttribute('data-connections') ?? '[]'))
}
async function waitEdges(page: Page, expected: Edge[]) {
  await page.waitForFunction((want) => {
    const edges = JSON.parse(document.querySelector('#skill-detail-panel')?.getAttribute('data-connections') ?? '[]') as Edge[]
    return edges.map((e) => `${e.from_id}>${e.to_id}`).sort().join(',') === want
  }, {}, edgeKey(expected))
}
async function saved(page: Page, revision: number) {
  await page.waitForSelector(`#save-status[data-state="saved"][data-revision="${revision}"]`)
}
async function revisionShown(page: Page) {
  return Number(await page.$eval('#save-status', (el) => (el as HTMLElement).dataset.revision))
}
async function open(page: Page, route: string, root = '#path-editor', gpu = 'ready') {
  await page.bringToFront()
  await page.goto(`${ORIGIN}${route}`, { waitUntil: 'networkidle0' })
  await page.waitForSelector(`${root}[data-gpu-status="${gpu}"]`, { timeout: 20000 })
}
async function camera(page: Page) {
  return page.$eval('#labels-camera', (el) => getComputedStyle(el).transform)
}
async function closePanels(page: Page) {
  for (let i = 0; i < 3 && (await visible(page, '#skill-detail-panel') || await visible(page, '#skill-prerequisite-list')); i++) {
    await page.keyboard.press('Escape')
    await pause(50)
  }
}
/** Hovers a card and returns where its now-shown connection point is drawn. */
async function connectionPoint(page: Page, id: string): Promise<Box> {
  const card = await box(page, `#card-label-${id}`)
  await page.mouse.move(card.cx, card.cy, { steps: 3 })
  await page.waitForSelector(`#card-connection-point-${id}`, { visible: true })
  const point = await box(page, `#card-connection-point-${id}`)
  // Aligned with the label: centred on the middle of its right edge.
  check(Math.abs(point.cx - (card.x + card.width)) < 1.5 && Math.abs(point.cy - card.cy) < 1.5, `connection point of ${id} is not on its card edge: ${JSON.stringify({ point, card })}`)
  return point
}
/**
 * A real pointer drag from a card's connection point. `inspect` runs while the
 * pointer is held over the destination, before the release (or Escape).
 */
async function dragConnection(page: Page, fromId: string, to: { id?: string; x?: number; y?: number }, inspect?: () => Promise<void>, cancel = false) {
  const start = await connectionPoint(page, fromId)
  const target = to.id ? await box(page, `#card-label-${to.id}`) : { cx: to.x!, cy: to.y! }
  await page.mouse.move(start.cx, start.cy)
  await page.mouse.down()
  await page.waitForSelector('#connection-drag-hint', { visible: true })
  await page.mouse.move(target.cx, target.cy, { steps: 12 })
  if (to.id) await page.waitForSelector(`#card-label-${to.id}[data-connect-hover="true"], #card-label-${to.id}[data-connect-target="source"]`)
  await inspect?.()
  if (cancel) await page.keyboard.press('Escape')
  await page.mouse.up()
  await page.waitForFunction(() => !document.querySelector('#connection-drag-hint'))
}
/** A point of a drawn connection (the engine's Bézier, from label geometry) that no card covers. */
async function edgeMidpoint(page: Page, fromId: string, toId: string) {
  const from = await box(page, `#card-label-${fromId}`), to = await box(page, `#card-label-${toId}`)
  const zoom = await page.$eval('#labels-camera', (el) => new DOMMatrix(getComputedStyle(el).transform).a)
  const cards = await page.$$eval('[id^="card-label-"]', (els) => els.map((el) => el.getBoundingClientRect().toJSON() as DOMRect))
  const p0 = { x: from.x + from.width, y: from.cy }, p3 = { x: to.x, y: to.cy }
  const dx = Math.max(Math.abs(p3.x - p0.x), 40 * zoom) * 0.5
  const p1 = { x: p0.x + dx, y: p0.y }, p2 = { x: p3.x - dx, y: p3.y }
  const at = (t: number) => {
    const u = 1 - t
    return { x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x, y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y }
  }
  for (const t of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.15, 0.85, 0.1, 0.9]) {
    const p = at(t)
    if (!cards.some((c) => p.x >= c.x - 4 && p.x <= c.x + c.width + 4 && p.y >= c.y - 4 && p.y <= c.y + c.height + 4)) return p
  }
  throw new Error(`connection ${fromId} → ${toId} is covered by cards everywhere`)
}
async function toast(page: Page, includes: RegExp) {
  await page.waitForSelector('#editor-error-toast', { visible: true })
  const message = await text(page, '#editor-error-toast')
  check(includes.test(message), `feedback "${message}" does not match ${includes}`)
  await page.$eval('#editor-error-toast button', (b) => (b as HTMLButtonElement).click())
  return message
}
async function newPage(browser: Browser, errors: string[], noGpu = false) {
  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('dialog', (dialog) => { errors.push(`unexpected ${dialog.type()} dialog`); void dialog.dismiss() })
  await page.evaluateOnNewDocument((unsupported) => {
    ;(window as any).__GUROW_TESTING__ = true
    if (unsupported) Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true })
  }, noGpu)
  return page
}

async function main() {
  await portFree(PORT)
  await portFree(API_PORT)
  if (!process.argv.includes('--skip-build')) execFileSync('bun', ['run', 'build'], { cwd: FRONTEND, stdio: 'inherit' })
  execFileSync('bun', ['run', 'test/support/prepare-browser-database.ts'], { cwd: BACKEND, stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: DATABASE_URL } })
  const resend = startResendStandIn()
  const backend = spawn('bun', ['run', 'src/index.ts'], { cwd: BACKEND, env: { ...process.env, DATABASE_URL, PORT: String(API_PORT), BETTER_AUTH_URL: ORIGIN, BETTER_AUTH_SECRET: 'ux02-browser-check-secret-not-for-production', NODE_ENV: 'test', RESEND_API_KEY: resend.apiKey, RESEND_API_URL: resend.url, MAIL_FROM: 'Gurow <invitations@gurow.test>' }, stdio: ['ignore', 'ignore', 'inherit'] })
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
  async function authenticate(page: Page, email: string) {
    current = page
    await page.bringToFront()
    const before = resend.sent.length
    await page.goto(ORIGIN, { waitUntil: 'networkidle0' })
    await page.waitForSelector('#sign-in-form')
    await setValue(page, '#email-input', email)
    await setValue(page, '#password-input', PASSWORD)
    await activate(page, '#sign-up-btn')
    await page.waitForSelector('#personal-workspace')
    await page.goto(await emailLink(email, 'Verify', before), { waitUntil: 'networkidle0' })
    await page.waitForSelector('#email-verification-status[data-verified="true"]')
  }
  try {
    await waitForServerReady(ORIGIN)
    for (let i = 0; i < 50; i++) {
      if ((await fetch(`${ORIGIN}/api/account`).catch(() => null))?.status === 401) break
      check(i < 49, 'backend never became ready')
      await pause(200)
    }
    browser = await puppeteer.launch({ executablePath: resolveChromiumExecutable(), headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-webgpu', '--use-gl=angle', '--disable-dev-shm-usage'] })

    // ---- Personal Path: fresh A, B, C through the actual Add Skill UI.
    const owner = await newPage(browser, errors)
    await authenticate(owner, 'owner@ux02.test')
    const created = await ok(owner, '/personal/learning-paths', 'POST', { title: 'Drag algebra', goal: 'Connect Skills by dragging' })
    const pathId = created.learningPath.id as string
    const route = `/personal/learning-paths/${pathId}`
    let revision = created.learningPath.revision as number
    await open(owner, `/paths/${pathId}`)
    const titles = ['Drag A', 'Drag B', 'Drag C']
    for (const title of titles) {
      await activate(owner, '#editor-add-card-btn')
      await owner.waitForSelector('#new-skill-title', { visible: true })
      await setValue(owner, '#new-skill-title', title)
      await setValue(owner, '#new-skill-outcome', `Outcome of ${title}`)
      await owner.$eval('#new-skill-form', (form) => (form as HTMLFormElement).requestSubmit())
      await saved(owner, ++revision)
      await closePanels(owner)
      if (await visible(owner, '#new-skill-title')) await activate(owner, '#btn-close-add-skill')
    }
    const skills = (await ok(owner, route)).application.skills as Array<{ id: string; title: string }>
    const id = (title: string) => skills.find((s) => s.title === title)!.id
    const [A, B, C] = titles.map(id)
    check(A && B && C && new Set([A, B, C]).size === 3, 'Add Skill did not persist three new Skills')
    check(![A, B, C].some((x) => /^skill-/.test(x)), 'fresh Skills reused fixed fixture identities')
    // Put C to the right of A and B so the drags cross empty canvas.
    await closePanels(owner)

    // ---- AC1: connection points are discoverable on hover and selection.
    await owner.mouse.move(5, 990)
    check(!await visible(owner, `#card-connection-point-${A}`), 'connection point shown without hover or selection')
    await connectionPoint(owner, A)
    const cBox0 = await box(owner, `#card-label-${C}`)
    await owner.mouse.move(cBox0.cx, cBox0.cy)
    await owner.waitForFunction((a) => !document.querySelector(`#card-connection-point-${a}`), {}, A)
    check(await visible(owner, `#card-connection-point-${C}`), 'hovered card shows no connection point')
    // Selection shows the point without hover: select A from the keyboard list, pointer away from every card.
    await owner.mouse.move(5, 990)
    await owner.waitForFunction((c) => !document.querySelector(`#card-connection-point-${c}`), {}, C)
    await activate(owner, '#btn-skill-list')
    await owner.keyboard.type('Drag A')
    await owner.keyboard.press('Enter')
    await owner.waitForSelector(`#card-label-${A}[data-selected="true"]`)
    check(await owner.$(`#card-connection-point-${A}`) && !await owner.$(`#card-connection-point-${B}`), 'selection does not show exactly the selected card\'s connection point')
    await closePanels(owner)

    // ---- AC1/6: body drag moves C (one undo step), at a changed pan and zoom.
    const zoomIn = await box(owner, '#editor-canvas')
    // Ctrl+wheel zooms at the cursor; a plain wheel pans.
    await owner.mouse.move(zoomIn.x + 60, zoomIn.y + 60)
    await owner.keyboard.down('Control')
    await owner.mouse.wheel({ deltaY: -25 })
    await owner.keyboard.up('Control')
    await owner.waitForFunction((before) => getComputedStyle(document.querySelector('#labels-camera')!).transform !== before, {}, 'matrix(1, 0, 0, 1, 0, 0)')
    // Pan: an empty-canvas drag moves the camera, not a card.
    const beforePan = await camera(owner)
    await owner.mouse.move(zoomIn.x + 40, zoomIn.y + zoomIn.height - 40)
    await owner.mouse.down()
    await owner.mouse.move(zoomIn.x + 110, zoomIn.y + zoomIn.height - 70, { steps: 6 })
    await owner.mouse.up()
    check(await camera(owner) !== beforePan, 'empty-canvas drag did not pan')
    const zoomed = await owner.$eval('#labels-camera', (el) => new DOMMatrix(getComputedStyle(el).transform).a)
    check(Math.abs(zoomed - 1) > 0.05 && zoomed < 2, `camera zoom unchanged or too large (${zoomed})`)
    await closePanels(owner)

    const cBefore = await box(owner, `#card-label-${C}`)
    await owner.mouse.move(cBefore.cx - 30, cBefore.cy)
    await owner.mouse.down()
    await owner.mouse.move(cBefore.cx + 170, cBefore.cy - 20, { steps: 10 })
    await owner.mouse.up()
    await saved(owner, ++revision)
    const cAfter = await box(owner, `#card-label-${C}`)
    check(Math.abs(cAfter.x - cBefore.x - 200) < 3 && Math.abs(cAfter.y - cBefore.y + 20) < 3, `body drag did not move C with the pointer: ${JSON.stringify({ cBefore, cAfter })}`)
    check((await localEdges(owner)).length === 0 && (await ok(owner, route)).editor.connections.length === 0, 'body drag created a connection')
    await closePanels(owner)
    // Stacked cards: C dragged over A's connection point; a press there moves C, never connects from A.
    const aUnder = await box(owner, `#card-label-${A}`)
    const cTop = await box(owner, `#card-label-${C}`)
    const coveredPoint = { x: aUnder.x + aUnder.width, y: aUnder.cy }
    await owner.mouse.move(cTop.x + 20, cTop.cy)
    await owner.mouse.down()
    await owner.mouse.move(coveredPoint.x - 40 + 20, aUnder.cy, { steps: 10 })
    await owner.mouse.up()
    await saved(owner, ++revision)
    await closePanels(owner)
    const cOver = await box(owner, `#card-label-${C}`)
    check(cOver.x < coveredPoint.x - 20 && cOver.x + cOver.width > coveredPoint.x + 20, `C does not cover A's connection point: ${JSON.stringify({ cOver, coveredPoint })}`)
    await owner.mouse.move(coveredPoint.x, coveredPoint.y, { steps: 3 })
    await pause(100)
    check(!await owner.$(`#card-connection-point-${A}`) && await owner.$eval('#editor-canvas', (el) => (el as HTMLElement).dataset.hoverConnectionPoint) === 'false', 'covered connection point of A is offered')
    await owner.mouse.down()
    await owner.mouse.move(coveredPoint.x + 30, coveredPoint.y + 40, { steps: 8 })
    check(!await owner.$('#connection-drag-hint'), 'a press on the front card body started a connection from the card behind it')
    await owner.mouse.up()
    await saved(owner, ++revision)
    const cPushed = await box(owner, `#card-label-${C}`)
    check(Math.abs(cPushed.x - cOver.x - 30) < 3 && Math.abs(cPushed.y - cOver.y - 40) < 3 && same(await box(owner, `#card-label-${A}`), aUnder), 'the press did not move the front card alone')
    check((await localEdges(owner)).length === 0, 'stacked press created a connection')
    await closePanels(owner)
    for (let i = 0; i < 2; i++) {
      await owner.keyboard.down('Control'); await owner.keyboard.press('z'); await owner.keyboard.up('Control')
      await saved(owner, ++revision)
    }
    check(same(await box(owner, `#card-label-${C}`), cAfter), 'undo did not return C')
    pass('AC1/6 points on hover only; body drag moves the card at a changed pan/zoom and connects nothing')

    // ---- AC2: A → C, then B → C, highlighted targets, persisted.
    for (const from of [A, B]) {
      await dragConnection(owner, from, { id: C }, async () => {
        const marks = await owner.$$eval('[id^="card-label-"]', (els) => Object.fromEntries(els.map((el) => [el.id.slice('card-label-'.length), (el as HTMLElement).dataset.connectTarget])))
        check(marks[from] === 'source' && marks[C] === 'valid', `valid destination not highlighted: ${JSON.stringify(marks)}`)
        check(await owner.$eval(`#card-label-${C}`, (el) => (el as HTMLElement).dataset.connectHover === 'true'), 'target under pointer not marked')
      })
      await saved(owner, ++revision)
      check(!await visible(owner, '#skill-detail-panel'), 'a connection drag opened the Skill summary')
    }
    const expected: Edge[] = [{ from_id: A, to_id: C }, { from_id: B, to_id: C }]
    await waitEdges(owner, expected)
    check(edgeKey((await ok(owner, route)).editor.connections) === edgeKey(expected), 'persisted graph is not A → C and B → C')
    // Direction: C now requires both A and B, as the summary reads it.
    await activate(owner, '#btn-skill-list')
    await owner.keyboard.type('Drag C')
    await owner.keyboard.press('Enter')
    await owner.waitForSelector('#incoming-prerequisites-list')
    const incoming = await text(owner, '#incoming-prerequisites-list')
    check(incoming.includes('Drag A') && incoming.includes('Drag B'), `C does not require A and B: ${incoming}`)
    await closePanels(owner)

    // Reload: the newly loaded engine holds the same edges between the same new Skills.
    await open(owner, `/paths/${pathId}`)
    await waitEdges(owner, expected)
    revision = await revisionShown(owner)
    pass('AC2 fresh A, B, C; two real drags into C highlight valid targets and survive reload as A → C, B → C')

    // ---- AC7: ALL semantics through Access of the one persisted graph.
    const access = async () => Object.fromEntries((await ok(owner, `${route}/learning-state`)).learningState.skills.map((s: any) => [s.skillId, s.access]))
    check((await access())[C] === false, 'C accessible before its prerequisites are mastered')
    await ok(owner, `${route}/skills/${A}/mastery`, 'PUT')
    check((await access())[C] === false, 'C accessible after only one of ALL prerequisites')
    await ok(owner, `${route}/skills/${B}/mastery`, 'PUT')
    check((await access())[C] === true, 'C not accessible once both prerequisites are mastered')
    await ok(owner, `${route}/skills/${A}/mastery`, 'DELETE')
    await ok(owner, `${route}/skills/${B}/mastery`, 'DELETE')
    pass('AC7 dragged edges drive ALL-prerequisite Access through the single persisted graph')

    // ---- AC3/6: cancelled and invalid gestures change neither graph nor revision; again at a new camera.
    await owner.mouse.move(zoomIn.x + 600, zoomIn.y + 600)
    const beforeZoomOut = await camera(owner)
    await owner.keyboard.down('Control')
    await owner.mouse.wheel({ deltaY: 40 })
    await owner.keyboard.up('Control')
    await owner.mouse.wheel({ deltaX: 40, deltaY: -30 })
    await owner.waitForFunction((before) => getComputedStyle(document.querySelector('#labels-camera')!).transform !== before, {}, beforeZoomOut)
    const graph = await localEdges(owner)
    const unchanged = async (what: string) => {
      await pause(300)
      check(edgeKey(await localEdges(owner)) === edgeKey(graph), `${what} changed the editor graph`)
      const stored = await ok(owner, route)
      check(stored.learningPath.revision === revision && edgeKey(stored.editor.connections) === edgeKey(graph), `${what} changed the persisted graph or revision`)
    }
    const bBox = await box(owner, `#card-label-${B}`)
    await dragConnection(owner, A, { id: B }, undefined, true)
    await unchanged('Escape mid-drag')
    check(!await visible(owner, '#skill-detail-panel'), 'cancelled drag opened a Skill')
    const canvas = await box(owner, '#editor-canvas')
    await dragConnection(owner, A, { x: canvas.x + canvas.width - 30, y: canvas.y + canvas.height - 30 })
    await unchanged('empty-canvas drop')
    // Self: out of A and back onto it.
    await dragConnection(owner, A, { x: bBox.cx, y: bBox.y + bBox.height + 60 }, undefined, true)
    const aStart = await connectionPoint(owner, A)
    const aBox = await box(owner, `#card-label-${A}`)
    await owner.mouse.move(aStart.cx, aStart.cy)
    await owner.mouse.down()
    await owner.mouse.move(aStart.cx + 80, aStart.cy + 120, { steps: 6 })
    await owner.mouse.move(aBox.cx, aBox.cy, { steps: 6 })
    await owner.waitForSelector(`#card-label-${A}[data-connect-target="source"]`)
    await owner.mouse.up()
    await toast(owner, /itself/i)
    await unchanged('self-connection drop')
    // Duplicate and cycle: the target is marked invalid before the drop and explained after it.
    await dragConnection(owner, A, { id: C }, async () => {
      check(await owner.$eval(`#card-label-${C}`, (el) => (el as HTMLElement).dataset.connectTarget) === 'invalid', 'duplicate target highlighted as valid')
    })
    await toast(owner, /already exists/i)
    await unchanged('duplicate drop')
    await dragConnection(owner, C, { id: A }, async () => {
      check(await owner.$eval(`#card-label-${A}`, (el) => (el as HTMLElement).dataset.connectTarget) === 'invalid', 'cycle target highlighted as valid')
    })
    const cycle = await toast(owner, /cycle/i)
    check(!skills.some((s) => cycle.includes(s.id)), 'cycle feedback exposes Skill IDs')
    await unchanged('cycle drop')
    // Missing and foreign endpoints are refused at the domain boundary, too.
    const stored = await ok(owner, route)
    const put = (connections: Edge[]) => api(owner, `${route}/document`, 'PUT', { expectedRevision: stored.learningPath.revision, title: stored.learningPath.title, goal: stored.learningPath.goal, editor: { ...stored.editor, connections }, application: stored.application })
    check((await put([...graph, { from_id: crypto.randomUUID(), to_id: A }])).body?.error === 'connection_outside_path', 'missing endpoint accepted by backend')
    check((await put([...graph, { from_id: C, to_id: A }])).body?.error === 'prerequisite_cycle', 'cycle accepted by backend')
    await unchanged('refused document writes')
    pass('AC3/6 Escape, empty drop, self, duplicate, cycle and missing endpoint leave graph and revision unchanged with concise feedback')

    // ---- AC4: select a connection by pressing it; delete; undo/redo as single steps; undo is a new save.
    await closePanels(owner)
    const mid = await edgeMidpoint(owner, B, C)
    await owner.mouse.click(mid.x, mid.y)
    await owner.waitForSelector(`#selected-connection-bar[data-from-id="${B}"][data-to-id="${C}"]`)
    check(/Drag B.*Drag C/.test(await text(owner, '#selected-connection-label')), 'selected connection not named by its Skills')
    await activate(owner, '#btn-delete-connection')
    await saved(owner, ++revision)
    await waitEdges(owner, [{ from_id: A, to_id: C }])
    check(!await visible(owner, '#selected-connection-bar'), 'deleted connection stays selected')
    await activate(owner, '#editor-undo-btn')
    await saved(owner, ++revision)
    await waitEdges(owner, expected)
    check(edgeKey((await ok(owner, route)).editor.connections) === edgeKey(expected), 'undo of a saved deletion was not saved as a new change')
    await activate(owner, '#editor-redo-btn')
    await saved(owner, ++revision)
    await waitEdges(owner, [{ from_id: A, to_id: C }])
    await activate(owner, '#editor-undo-btn')
    await saved(owner, ++revision)
    await waitEdges(owner, expected)
    // A completed connection drag is one undo step, with Ctrl+Z / Ctrl+Y.
    const withAB = [...expected, { from_id: A, to_id: B }]
    await dragConnection(owner, A, { id: B })
    await saved(owner, ++revision)
    await waitEdges(owner, withAB)
    const cardsBefore = await owner.$$eval('[id^="card-label-"]', (els) => els.map((el) => el.getBoundingClientRect().toJSON()))
    await owner.keyboard.down('Control'); await owner.keyboard.press('z'); await owner.keyboard.up('Control')
    await saved(owner, ++revision)
    await waitEdges(owner, expected)
    check(same(await owner.$$eval('[id^="card-label-"]', (els) => els.map((el) => el.getBoundingClientRect().toJSON())), cardsBefore), 'undoing the drag moved a card')
    await owner.keyboard.down('Control'); await owner.keyboard.press('y'); await owner.keyboard.up('Control')
    await saved(owner, ++revision)
    await waitEdges(owner, withAB)
    await owner.keyboard.down('Control'); await owner.keyboard.press('z'); await owner.keyboard.up('Control')
    await saved(owner, ++revision)
    await waitEdges(owner, expected)
    // Keyboard deletion of a selected connection, then failed persistence keeps the local edit.
    const midA = await edgeMidpoint(owner, A, C)
    await owner.mouse.click(midA.x, midA.y)
    await owner.waitForSelector(`#selected-connection-bar[data-from-id="${A}"]`)
    await owner.setOfflineMode(true)
    await owner.focus('#editor-canvas')
    await owner.keyboard.press('Delete')
    await owner.waitForSelector('#save-status[data-state="failed"]')
    await waitEdges(owner, [{ from_id: B, to_id: C }])
    await owner.setOfflineMode(false)
    check(edgeKey((await ok(owner, route)).editor.connections) === edgeKey(expected), 'failed save reached the backend')
    await activate(owner, '#retry-save-btn')
    await saved(owner, ++revision)
    check(edgeKey((await ok(owner, route)).editor.connections) === edgeKey([{ from_id: B, to_id: C }]), 'retried deletion not persisted')
    await activate(owner, '#editor-undo-btn')
    await saved(owner, ++revision)
    await waitEdges(owner, expected)
    pass('AC4 pressed edge selected, deleted by button and Delete key; one-gesture undo/redo saved as new changes; failed save keeps and retries the edit')

    // ---- AC7: a stale write keeps the dragged edge locally and reapplies it.
    const accepted = await ok(owner, route)
    await ok(owner, `${route}/document`, 'PUT', { expectedRevision: accepted.learningPath.revision, title: accepted.learningPath.title, goal: 'Accepted elsewhere', editor: accepted.editor, application: accepted.application })
    await dragConnection(owner, A, { id: B })
    await owner.waitForSelector('#save-status[data-state="conflict"]')
    await waitEdges(owner, withAB)
    check(edgeKey((await ok(owner, route)).editor.connections) === edgeKey(expected), 'stale write overwrote the accepted document')
    await activate(owner, '#reapply-mine-btn')
    revision = accepted.learningPath.revision + 2
    await saved(owner, revision)
    const merged = await ok(owner, route)
    check(merged.learningPath.goal === 'Accepted elsewhere' && edgeKey(merged.editor.connections) === edgeKey(withAB), 'reapply lost the accepted goal or the dragged edge')
    pass('AC7 stale save keeps the dragged edge locally; Reapply saves it over the accepted change')

    // ---- AC5: the keyboard detail action makes/removes the same edges with the same validation.
    await closePanels(owner)
    await activate(owner, '#btn-skill-list')
    await owner.keyboard.type('Drag B')
    await owner.keyboard.press('Enter')
    await owner.waitForFunction(() => document.querySelector('#selected-skill-title')?.textContent === 'Drag B')
    await owner.select('#connect-skill-select', C)
    await activate(owner, '#btn-add-dependent')
    await owner.waitForFunction(() => /already exists/.test(document.querySelector('#cycle-rejection-alert')?.textContent ?? ''))
    await owner.select('#connect-skill-select', C)
    await activate(owner, '#btn-add-prerequisite')
    await owner.waitForFunction(() => /cycle/.test(document.querySelector('#cycle-rejection-alert')?.textContent ?? ''))
    check(revision === await revisionShown(owner), 'rejected detail actions saved')
    await activate(owner, `#disconnect-${A}-${B}`)
    await saved(owner, ++revision)
    await waitEdges(owner, expected)
    await owner.select('#connect-skill-select', A)
    await activate(owner, '#btn-add-prerequisite')
    await saved(owner, ++revision)
    await waitEdges(owner, withAB)
    await activate(owner, `#disconnect-${A}-${B}`)
    await saved(owner, ++revision)
    await waitEdges(owner, expected)
    await closePanels(owner)
    pass('AC5 keyboard detail action rejects duplicate/cycle like a drop and creates/removes the same A → B edge')

    // ---- AC7: renderer failure keeps the CPU graph; after retry, drags still connect.
    // The gated test facility (not a product control) injects a lost device whose recovery fails once.
    await owner.evaluate(() => {
      const scope = window as any
      scope.__ux02RequestAdapter = navigator.gpu.requestAdapter
      navigator.gpu.requestAdapter = async () => null
      scope.__GUROW_EDITOR_TEST__.simulateDeviceLoss()
    })
    await owner.waitForSelector('#recovery-error-banner')
    await owner.waitForSelector('#path-editor[data-gpu-status="error"]')
    await waitEdges(owner, expected)
    check(!await owner.$('[id^="card-connection-point-"]'), 'connection points offered without a renderer')
    await owner.evaluate(() => { navigator.gpu.requestAdapter = (window as any).__ux02RequestAdapter })
    await activate(owner, '#btn-retry-renderer')
    await owner.waitForSelector('#path-editor[data-gpu-status="ready"]', { timeout: 20000 })
    await waitEdges(owner, expected)
    await dragConnection(owner, A, { id: B })
    await saved(owner, ++revision)
    await waitEdges(owner, withAB)
    pass('AC7 renderer failure keeps the CPU graph; after recovery a drag still connects')

    // ---- AC3/5: Coach Draft applies the Optional → required rule to drops and the detail action alike.
    const coach = await newPage(browser, errors)
    await authenticate(coach, 'coach@ux02.test')
    const workspace = (await ok(coach, '/coach/workspaces', 'POST', { name: 'UX02 studio' })).workspace
    const draft = await ok(coach, `/coach/workspaces/${workspace.id}/learning-paths`, 'POST', { title: 'Coached drags', goal: 'Connect by dragging' })
    const coachPath = draft.learningPath.id as string
    const draftRoute = `/coach/learning-paths/${coachPath}/draft`
    const [opt, req, req2] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
    const skill = (sid: string, title: string, optional: boolean) => ({ id: sid, title, outcome: `${title} outcome`, optional, xpThreshold: 0, tasks: [{ id: crypto.randomUUID(), title: `${title} task`, description: '', required: true, xpReward: 0 }] })
    await ok(coach, draftRoute, 'PUT', {
      expectedRevision: draft.learningPath.revision, title: 'Coached drags', goal: 'Connect by dragging',
      editor: { format_version: 1, cards: [{ id: opt, title: 'Optional extra', position: { x: 80, y: 100 } }, { id: req, title: 'Required core', position: { x: 520, y: 100 } }, { id: req2, title: 'Required base', position: { x: 80, y: 360 } }], connections: [] },
      application: { skills: [skill(opt, 'Optional extra', true), skill(req, 'Required core', false), skill(req2, 'Required base', false)] },
    })
    current = coach
    await open(coach, `/coach/paths/${coachPath}`)
    const coachRevision = await revisionShown(coach)
    await dragConnection(coach, opt, { id: req }, async () => {
      check(await coach.$eval(`#card-label-${req}`, (el) => (el as HTMLElement).dataset.connectTarget) === 'invalid', 'Optional → required target highlighted as valid')
    })
    await toast(coach, /Optional Skill .*cannot be a Prerequisite/i)
    await pause(300)
    check((await localEdges(coach)).length === 0 && await revisionShown(coach) === coachRevision, 'Optional → required drop changed the Draft')
    await dragConnection(coach, req2, { id: req })
    await saved(coach, coachRevision + 1)
    check(edgeKey((await ok(coach, `/coach/learning-paths/${coachPath}`)).editor.connections) === edgeKey([{ from_id: req2, to_id: req }]), 'Coach drag not persisted to the Draft')
    pass('AC3/5 Coach Draft: Optional → required drop refused like the detail action; a valid drag persists')

    // ---- AC5: a published layout moves cards only; a learner cannot connect at all.
    const savedDraft = await ok(coach, `/coach/learning-paths/${coachPath}`)
    const version = (await ok(coach, `/coach/learning-paths/${coachPath}/publication`, 'POST', { expectedRevision: savedDraft.learningPath.revision })).version
    await coach.goto(`${ORIGIN}/coach/versions/${version.id}`, { waitUntil: 'networkidle0' })
    await coach.waitForSelector('#version-layout[data-gpu-status="ready"]', { timeout: 20000 })
    const optCard = await box(coach, `#card-label-${opt}`)
    await coach.mouse.move(optCard.cx, optCard.cy, { steps: 3 })
    await pause(150)
    check(!await coach.$(`#card-connection-point-${opt}`), 'published layout offers a connection point')
    // Pressing where the point would be moves the card, never connects.
    await coach.mouse.move(optCard.x + optCard.width - 2, optCard.cy)
    await coach.mouse.down()
    await coach.mouse.move(optCard.x + optCard.width + 300, optCard.cy + 10, { steps: 8 })
    check(!await coach.$('#connection-drag-hint'), 'published layout started a connection')
    await coach.mouse.up()
    await pause(500)
    const published = await ok(coach, `/coach/learning-path-versions/${version.id}`)
    check(edgeKey(published.editor.connections) === edgeKey([{ from_id: req2, to_id: req }]), 'published layout changed Version connections')

    const learner = await newPage(browser, errors)
    await authenticate(learner, 'learner@ux02.test')
    const beforeInvite = resend.sent.length
    await ok(coach, `/coach/learning-path-versions/${version.id}/invitations`, 'POST', { email: 'learner@ux02.test' })
    await learner.goto(await emailLink('learner@ux02.test', 'You are invited', beforeInvite), { waitUntil: 'networkidle0' })
    await activate(learner, '#accept-invitation-btn')
    await learner.waitForSelector('#invitation-result[data-outcome="enrolled"]')
    const enrollment = await learner.$eval('#invitation-result', (el) => (el as HTMLElement).dataset.enrollmentId!)
    current = learner
    await open(learner, `/enrollments/${enrollment}`, '#enrolled-version')
    const reqCard = await box(learner, `#card-label-${req2}`)
    await learner.mouse.move(reqCard.cx, reqCard.cy, { steps: 3 })
    await pause(150)
    check(!await learner.$(`#card-connection-point-${req2}`), 'learner sees a connection point')
    await learner.mouse.move(reqCard.x + reqCard.width - 2, reqCard.cy)
    await learner.mouse.down()
    await learner.mouse.move(reqCard.x + reqCard.width + 400, reqCard.cy - 200, { steps: 8 })
    check(!await learner.$('#connection-drag-hint'), 'learner started a connection')
    await learner.mouse.up()
    check(!await learner.$('#btn-add-prerequisite'), 'learner offered the detail connection action')
    pass('AC5 published layout and learner view offer no connection point or action; presses never connect')

    check(errors.length === 0, `page errors: ${errors.join('; ')}`)
    console.log('\nUX02 connections check passed.')
  } catch (error) {
    if (current) await current.screenshot({ path: path.join(FRONTEND, '..', '.harness', 'ux02-failure.png') }).catch(() => {})
    throw error
  } finally {
    await browser?.close()
    backend.kill()
    web.kill()
    resend.stop()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
