#!/usr/bin/env bun
/**
 * T31 arrange-selection check (#32): the production frontend build forwarding /api to
 * the production backend entry (Better Auth sessions) on a freshly migrated PostgreSQL
 * database, in headless Chromium with WebGPU. A real Account arranges a persisted
 * personal Learning Path on the canvas: Shift+drag on the empty canvas draws a
 * selection box (at two camera positions and zoom levels), and dragging one selected
 * card moves the whole selection. The HTML labels and the WebGPU connections follow
 * the moving cards; the drag is one undo step and its save, undo and redo are each one
 * validated backend save. Reload restores the arrangement without the selection or
 * history. Dragging a selection against the world limit stops the whole group with
 * its relative positions intact. Another Account, a stale revision and an
 * out-of-bounds position are refused by the backend.
 *
 * Run from frontend: bun run scripts/t31-arrange-selection-check.ts [--skip-build]
 */
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import puppeteer, { type Page } from 'puppeteer-core'
import { resolveChromiumExecutable, waitForServerReady } from './benchmark/browser'
import { closeEditorPanels } from './editor-navigation'

const FRONTEND = path.resolve(import.meta.dir, '..')
const BACKEND = path.resolve(FRONTEND, '../backend')
const PORT = Number(process.env.PORT ?? 3571)
const API_PORT = Number(process.env.API_PORT ?? 3572)
const ORIGIN = `http://127.0.0.1:${PORT}`
const DATABASE_URL = process.env.T31_DATABASE_URL ?? 'postgres://gurow:gurow@127.0.0.1:5433/gurow_t31_browser_test'
const PASSWORD = 'correct horse battery staple'
const MAX_WORLD = 1_000_000

interface Point { x: number; y: number }
interface Rect extends Point { width: number; height: number }
interface Camera { x: number; y: number; zoom: number }
interface Doc {
  learningPath: { id: string; title: string; goal: string; revision: number }
  editor: { format_version: 1; cards: { id: string; title: string; position: Point }[]; connections: { from_id: string; to_id: string }[] }
  application: { skills: unknown[] }
}

const steps: string[] = []
function pass(step: string, detail: string) {
  steps.push(step)
  console.log(`  ✓ ${step}: ${detail}`)
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
const near = (a: number, b: number, tolerance = 1.5) => Math.abs(a - b) <= tolerance

async function api(page: Page, apiPath: string, method = 'GET', body?: unknown): Promise<{ status: number; body: any }> {
  return page.evaluate(async (p: string, m: string, b: string | null) => {
    const response = await fetch(`/api${p}`, { method: m, headers: b === null ? undefined : { 'content-type': 'application/json' }, body: b ?? undefined })
    return { status: response.status, body: await response.json().catch(() => null) }
  }, apiPath, method, body === undefined ? null : JSON.stringify(body))
}
async function readDoc(page: Page, pathId: string): Promise<Doc> {
  const result = await api(page, `/personal/learning-paths/${pathId}`)
  check(result.status === 200, `reading Path ${pathId} answered ${result.status}`)
  return result.body
}
/** Stored card positions by Skill ID. */
const stored = async (page: Page, pathId: string) => Object.fromEntries((await readDoc(page, pathId)).editor.cards.map((c) => [c.id, c.position])) as Record<string, Point>
/** Same Skills at exactly the same positions, whatever the order. */
const samePositions = (a: Record<string, Point>, b: Record<string, Point>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([id, p]) => b[id]?.x === p.x && b[id]?.y === p.y)
const saveFrom = (doc: Doc) => ({ expectedRevision: doc.learningPath.revision, title: doc.learningPath.title, goal: doc.learningPath.goal, editor: doc.editor, application: doc.application })

async function setValue(page: Page, selector: string, value: string) {
  await page.$eval(selector, (el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
}
async function signUp(page: Page, email: string) {
  await page.goto(ORIGIN, { waitUntil: 'networkidle0' })
  await page.waitForSelector('#sign-in-form')
  await setValue(page, '#email-input', email)
  await setValue(page, '#password-input', PASSWORD)
  await page.click('#sign-up-btn')
  await page.waitForSelector('#personal-workspace')
  return page.$eval('main', (el) => (el as HTMLElement).dataset.accountId!)
}
async function createPath(page: Page, title: string, goal: string) {
  await page.goto(ORIGIN, { waitUntil: 'networkidle0' })
  await page.waitForSelector('#new-path-title')
  await setValue(page, '#new-path-title', title)
  await setValue(page, '#new-path-goal', goal)
  await page.click('#create-path-btn')
  await page.waitForSelector('#path-editor[data-path-id]')
  return page.$eval('#path-editor', (el) => (el as HTMLElement).dataset.pathId!)
}
/** Opens the Path editor with a live WebGPU renderer, `cards` labels and a saved status. */
async function openEditor(page: Page, pathId: string, cards: number) {
  await page.goto(`${ORIGIN}/paths/${pathId}`, { waitUntil: 'networkidle0' })
  await page.waitForSelector('#path-editor[data-gpu-status="ready"]', { timeout: 20000 }).catch(async () => {
    throw new Error(`the editor did not reach WebGPU 'ready' (status ${await page.$eval('#path-editor', (el) => (el as HTMLElement).dataset.gpuStatus).catch(() => 'absent')})`)
  })
  await page.waitForFunction((n: number) => document.querySelectorAll('[id^="card-label-"]').length === n, {}, cards)
  await page.waitForSelector('#save-status[data-state="saved"]')
}
const saveState = (page: Page) => page.$eval('#save-status', (el) => ({ state: (el as HTMLElement).dataset.state!, revision: Number((el as HTMLElement).dataset.revision) }))
async function waitForSaved(page: Page, revision: number) {
  await page.waitForFunction((want: number) => {
    const el = document.querySelector('#save-status') as HTMLElement | null
    return el?.dataset.state === 'saved' && Number(el.dataset.revision) === want
  }, { timeout: 10000 }, revision).catch(async () => {
    throw new Error(`expected "saved" at revision ${revision}, status is ${JSON.stringify(await saveState(page))}`)
  })
}
const settle = (page: Page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))

/** The camera the overlay applies to every label: the engine's, from CameraChanged. */
const camera = (page: Page): Promise<Camera> => page.$eval('#labels-camera', (el) => {
  const [x, y, zoom] = ((el as HTMLElement).style.transform.match(/-?\d+(\.\d+)?(e-?\d+)?/g) ?? []).map(Number)
  return { x, y, zoom }
})
/** Canvas-relative label rectangles by Skill ID. */
const labels = (page: Page): Promise<Record<string, Rect>> => page.$$eval('[id^="card-label-"]', (els) => {
  const origin = document.querySelector('#labels-overlay')!.getBoundingClientRect()
  return Object.fromEntries(els.map((el) => {
    const r = el.getBoundingClientRect()
    return [el.id.replace('card-label-', ''), { x: r.x - origin.x, y: r.y - origin.y, width: r.width, height: r.height }]
  }))
})
const selectedLabels = (page: Page) => page.$$eval('[id^="card-label-"][data-selected="true"]', (els) => els.map((el) => el.id.replace('card-label-', '')).sort())
const canvasOrigin = (page: Page) => page.$eval('#editor-canvas', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y } })
/** Page coordinates of a world point under the current camera. */
async function toPage(page: Page, world: Point): Promise<Point> {
  const [cam, origin] = await Promise.all([camera(page), canvasOrigin(page)])
  return { x: origin.x + world.x * cam.zoom + cam.x, y: origin.y + world.y * cam.zoom + cam.y }
}
/** Each label sits where its stored world position lands under the camera, at the card's scaled size. */
async function labelsMatch(page: Page, positions: Record<string, Point>) {
  const [cam, ls] = await Promise.all([camera(page), labels(page)])
  const wrong = Object.entries(positions).filter(([id, p]) => {
    const l = ls[id]
    return !l || !near(l.x, p.x * cam.zoom + cam.x) || !near(l.y, p.y * cam.zoom + cam.y) || !near(l.width, 180 * cam.zoom) || !near(l.height, 80 * cam.zoom)
  })
  check(wrong.length === 0, `labels off their stored positions: ${JSON.stringify(wrong.map(([id]) => ({ id, label: ls[id], world: positions[id], camera: cam })))}`)
}

/** Holds Shift and drags across the canvas from one world point to another: a selection box. */
async function boxSelect(page: Page, from: Point, to: Point, { release = true } = {}) {
  await closeEditorPanels(page)
  const a = await toPage(page, from), b = await toPage(page, to)
  await page.keyboard.down('Shift')
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 8 })
  if (!release) return
  await page.mouse.up()
  await page.keyboard.up('Shift')
  await settle(page)
}
/** A canvas point inside the card's label that reaches the canvas, so input goes through the engine. */
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

/**
 * Counts pixels the WebGPU canvas drew inside a canvas-relative rectangle, with the
 * HTML labels hidden. Background is (18, 20, 28) and card fill (28, 36, 48); a
 * connection is drawn in (≈52, 113, 211) and the selection box fill in (≈23, 34, 54).
 */
async function canvasPixels(page: Page, area: Rect, kind: 'connection' | 'box'): Promise<number> {
  const origin = await canvasOrigin(page)
  await page.$eval('#labels-overlay', (el) => { (el as HTMLElement).style.visibility = 'hidden' })
  await settle(page)
  const png = await page.screenshot({ clip: { x: origin.x + area.x, y: origin.y + area.y, width: area.width, height: area.height }, encoding: 'base64' })
  await page.$eval('#labels-overlay', (el) => { (el as HTMLElement).style.visibility = '' })
  return page.evaluate(async (data: string, k: string) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob())
    const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const px = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
    let count = 0
    for (let i = 0; i < px.length; i += 4) {
      const [r, g, b] = [px[i], px[i + 1], px[i + 2]]
      if (k === 'connection' ? b >= 150 && r < 120 : b >= 51 && b <= 70 && b - r >= 25 && g < 45) count++
    }
    return count
  }, png as string, kind)
}
/** A small canvas-relative square around the on-screen midpoint of a connection's curve. */
async function connectionMidpoint(page: Page, from: Point, to: Point): Promise<Rect> {
  // The curve from the source's right middle to the target's left middle is symmetric: t = 0.5 is the midpoint of its ends.
  const cam = await camera(page)
  const x = ((from.x + 180 + to.x) / 2) * cam.zoom + cam.x, y = ((from.y + 40 + to.y + 40) / 2) * cam.zoom + cam.y
  return { x: Math.round(x - 6), y: Math.round(y - 6), width: 12, height: 12 }
}
/** Ctrl+wheel over the canvas centre: zoom about the pointer. */
async function wheelZoom(page: Page, deltaY: number) {
  const before = (await camera(page)).zoom
  const box = (await (await page.$('#editor-canvas'))!.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.keyboard.down('Control')
  await page.mouse.wheel({ deltaY })
  await page.keyboard.up('Control')
  await page.waitForFunction((z: number) => {
    const m = (document.querySelector('#labels-camera') as HTMLElement).style.transform.match(/scale\(([^)]+)\)/)
    return m !== null && Number(m[1]) !== z
  }, {}, before)
}

/** Ownership → Lifetimes → Async, with Traits beside them. */
const SKILLS = {
  ownership: { title: 'Ownership', at: { x: 100, y: 100 } },
  lifetimes: { title: 'Lifetimes', at: { x: 400, y: 100 } },
  traits: { title: 'Traits', at: { x: 100, y: 320 } },
  async: { title: 'Async', at: { x: 700, y: 460 } },
}
type SkillKey = keyof typeof SKILLS

/** Saves a document of Skills (no Tasks) at given positions through the owner's API. */
async function seed(page: Page, pathId: string, cards: Array<{ id: string; title: string; position: Point }>, connections: Array<{ from_id: string; to_id: string }>) {
  const doc = await readDoc(page, pathId)
  const result = await api(page, `/personal/learning-paths/${pathId}/document`, 'PUT', {
    ...saveFrom(doc),
    editor: { format_version: 1, cards, connections },
    application: { skills: cards.map((c) => ({ id: c.id, title: c.title, outcome: `Understand ${c.title}`, tasks: [] })) },
  })
  check(result.status === 200, `seeding Path ${pathId} answered ${result.status}: ${JSON.stringify(result.body)}`)
  return result.body.learningPath.revision as number
}

async function main() {
  if (!process.argv.includes('--skip-build')) {
    console.log('Building current sources (Wasm + production bundle)...')
    execFileSync('bun', ['run', 'build'], { cwd: FRONTEND, stdio: 'inherit' })
  }
  execFileSync('bun', ['run', 'test/support/prepare-browser-database.ts'], { cwd: BACKEND, stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: DATABASE_URL } })
  const apiServer = spawn('bun', ['run', 'src/index.ts'], {
    cwd: BACKEND,
    env: { ...process.env, DATABASE_URL, PORT: String(API_PORT), BETTER_AUTH_URL: ORIGIN, BETTER_AUTH_SECRET: 't31-browser-check-secret-not-for-production', NODE_ENV: 'test' },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  const web = spawn('node', ['.output/server/index.mjs'], { cwd: FRONTEND, env: { ...process.env, PORT: String(PORT), GUROW_API_ORIGIN: `http://127.0.0.1:${API_PORT}` }, stdio: 'ignore' })
  const browser = await puppeteer.launch({
    executablePath: resolveChromiumExecutable(), headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-webgpu', '--use-gl=angle', '--disable-dev-shm-usage'],
  })
  const errors: string[] = []
  let current: Page | null = null
  try {
    await waitForServerReady(ORIGIN)
    for (let i = 0; i < 30; i++) {
      if ((await fetch(`${ORIGIN}/api/account`).catch(() => null))?.status === 401) break
      await new Promise((r) => setTimeout(r, 300))
    }
    const context = await browser.createBrowserContext()
    const page = current = await context.newPage()
    page.setDefaultTimeout(10000)
    page.on('pageerror', (error) => errors.push(String(error)))
    // Every reload happens with the document saved; an unsaved-work prompt is a failure.
    page.on('dialog', (dialog) => { errors.push(`dialog ${dialog.type()}`); void dialog.accept() })
    await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 })

    // 0. Ada's persisted personal Path: four Skills, Ownership → Lifetimes → Async.
    const adaId = await signUp(page, 'ada@gurow.test')
    const pathId = await createPath(page, 'Systems Rust', 'Arrange the borrow checker chapter')
    const ids = Object.fromEntries(Object.keys(SKILLS).map((k) => [k, crypto.randomUUID()])) as Record<SkillKey, string>
    const start = Object.fromEntries((Object.keys(SKILLS) as SkillKey[]).map((k) => [ids[k], SKILLS[k].at])) as Record<string, Point>
    let revision = await seed(page, pathId,
      (Object.keys(SKILLS) as SkillKey[]).map((k) => ({ id: ids[k], title: SKILLS[k].title, position: SKILLS[k].at })),
      [{ from_id: ids.ownership, to_id: ids.lifetimes }, { from_id: ids.lifetimes, to_id: ids.async }])
    await openEditor(page, pathId, 4)
    await waitForSaved(page, revision)
    await labelsMatch(page, start)

    // 1. Box selection at the opening camera and after panning and zooming.
    check((await camera(page)).zoom === 1, `the editor opened at zoom ${(await camera(page)).zoom}`)
    await boxSelect(page, { x: 60, y: 60 }, { x: 420, y: 200 }, { release: false })
    // Between Ownership and Lifetimes, below their connection: covered by the box only.
    const insideBox = { x: 290, y: 160, width: 100, height: 30 }
    const boxPixels = await canvasPixels(page, insideBox, 'box')
    await page.mouse.up()
    await page.keyboard.up('Shift')
    await settle(page)
    const afterBoxPixels = await canvasPixels(page, insideBox, 'box')
    check(boxPixels > 1500 && afterBoxPixels < 30, `selection box pixels while drawn ${boxPixels}, after release ${afterBoxPixels}`)
    check(JSON.stringify(await selectedLabels(page)) === JSON.stringify([ids.ownership, ids.lifetimes].sort()), `the box at 100% selected ${await selectedLabels(page)}`)
    check((await page.$eval('#canvas-selection-count', (el) => (el as HTMLElement).dataset.count)) === '2', 'no "2 Skills selected" status')
    check(await page.$('#selected-skill-id') === null, 'a multiselection opened one Skill in the sidebar')
    check((await saveState(page)).revision === revision && await page.$eval('#editor-undo-btn', (el) => (el as HTMLButtonElement).disabled), 'selecting was saved or recorded as an edit')

    // Zoom out about the canvas centre, then pan with a plain drag on the empty canvas.
    await wheelZoom(page, 120)
    const empty = await toPage(page, { x: 600, y: 250 })
    await page.mouse.move(empty.x, empty.y)
    await page.mouse.down()
    await page.mouse.move(empty.x - 60, empty.y + 40, { steps: 4 })
    await page.mouse.up()
    await settle(page)
    const moved = await camera(page)
    check(moved.zoom < 0.95 && moved.zoom > 0.3, `zoomed to ${moved.zoom}`)
    check(await page.$('#canvas-selection-count') === null, 'the panning press kept the multiselection')
    await boxSelect(page, { x: 60, y: 300 }, { x: 900, y: 560 })
    check(JSON.stringify(await selectedLabels(page)) === JSON.stringify([ids.traits, ids.async].sort()), `the box at ${Math.round(moved.zoom * 100)}% selected ${await selectedLabels(page)}`)
    await labelsMatch(page, start)
    pass('box selection', `at 100% a Shift+drag box (WebGPU drew ${boxPixels} box pixels, ${afterBoxPixels} after release) selects Ownership and Lifetimes ("2 Skills selected", no single Skill opened, nothing saved); after zooming to ${Math.round(moved.zoom * 100)}% and panning (${moved.x.toFixed(0)}, ${moved.y.toFixed(0)}) a box selects Traits and Async`)

    // 2. Dragging one selected card moves the selection; labels and connections follow while it moves.
    await boxSelect(page, { x: 60, y: 60 }, { x: 420, y: 420 })
    const group = [ids.ownership, ids.lifetimes, ids.traits]
    check(JSON.stringify(await selectedLabels(page)) === JSON.stringify([...group].sort()), `the drag selection is ${await selectedLabels(page)}`)
    const before = await labels(page)
    const grab = await cardPoint(page, ids.lifetimes)
    const [dx, dy] = [120, 80]
    await page.mouse.move(grab.x, grab.y)
    await page.mouse.down()
    await page.mouse.move(grab.x + dx, grab.y + dy, { steps: 10 })
    await settle(page)
    // Mid-drag: every selected label moved by the pointer's movement; the rest stayed.
    const during = await labels(page)
    for (const id of group) check(near(during[id].x - before[id].x, dx) && near(during[id].y - before[id].y, dy), `label ${id} moved by (${during[id].x - before[id].x}, ${during[id].y - before[id].y}) during the drag`)
    check(near(during[ids.async].x, before[ids.async].x) && near(during[ids.async].y, before[ids.async].y), 'the unselected Async label moved')
    check((await saveState(page)).revision === revision, 'a save was sent before the drag was released')
    const z = moved.zoom
    const world = (id: string) => ({ x: start[id].x + (group.includes(id) ? dx / z : 0), y: start[id].y + (group.includes(id) ? dy / z : 0) })
    await labelsMatch(page, Object.fromEntries(Object.keys(start).map((id) => [id, world(id)])))
    // Connections are drawn from the engine's card positions: both curves run to the moved cards.
    const linkMoved = await connectionMidpoint(page, world(ids.ownership), world(ids.lifetimes))
    const linkStretched = await connectionMidpoint(page, world(ids.lifetimes), world(ids.async))
    const linkOld = await connectionMidpoint(page, start[ids.ownership], start[ids.lifetimes])
    const [movedPx, stretchedPx, oldPx] = [await canvasPixels(page, linkMoved, 'connection'), await canvasPixels(page, linkStretched, 'connection'), await canvasPixels(page, linkOld, 'connection')]
    check(movedPx >= 8 && stretchedPx >= 8 && oldPx === 0, `connection pixels during the drag: Ownership→Lifetimes ${movedPx} at its moved midpoint, ${oldPx} at its old one; Lifetimes→Async ${stretchedPx}`)
    await page.screenshot({ path: path.resolve(FRONTEND, '../.harness/t31-selection-drag.png') })
    await page.mouse.up()
    await settle(page)
    check(JSON.stringify(await selectedLabels(page)) === JSON.stringify([...group].sort()), 'the drag changed the selection')
    pass('labels and connections follow', `at ${Math.round(z * 100)}% dragging Lifetimes by (${dx}, ${dy}) px moves the labels of Ownership, Lifetimes and Traits by exactly that, Async stays; labels sit at the engine's world positions × camera; the connection curves run to the moved cards (${movedPx} and ${stretchedPx} connection pixels at their new midpoints, ${oldPx} at the old one); nothing saved before release`)

    // 3. The completed drag is one undo step; its save, the undo and the redo are each one validated save.
    await waitForSaved(page, revision + 1)
    const afterDrag = await stored(page, pathId)
    for (const id of Object.keys(start)) check(near(afterDrag[id].x, world(id).x, 0.5) && near(afterDrag[id].y, world(id).y, 0.5), `stored ${id} at ${JSON.stringify(afterDrag[id])}, expected ${JSON.stringify(world(id))}`)
    await labelsMatch(page, afterDrag)
    check(!await page.$eval('#editor-undo-btn', (el) => (el as HTMLButtonElement).disabled), 'the drag left nothing to undo')
    await closeEditorPanels(page)
    await page.click('#editor-undo-btn')
    await waitForSaved(page, revision + 2)
    check(samePositions(await stored(page, pathId), start), `after one undo the stored positions are ${JSON.stringify(await stored(page, pathId))}`)
    check(await page.$eval('#editor-undo-btn', (el) => (el as HTMLButtonElement).disabled), 'one undo did not undo the whole drag')
    await labelsMatch(page, start)
    await page.click('#editor-redo-btn')
    await waitForSaved(page, revision + 3)
    check(samePositions(await stored(page, pathId), afterDrag), `after redo the stored positions are ${JSON.stringify(await stored(page, pathId))}`)
    check(await page.$eval('#editor-redo-btn', (el) => (el as HTMLButtonElement).disabled), 'one redo did not redo the whole drag')
    await labelsMatch(page, afterDrag)
    revision += 3
    pass('one undo step', `release → saved revision ${revision - 2} with the three cards at +(${(dx / z).toFixed(1)}, ${(dy / z).toFixed(1)}) world units and Async unchanged; one Undo → revision ${revision - 1} with all three back and nothing left to undo; one Redo → revision ${revision} with all three moved again`)

    // 4. Reload keeps the saved arrangement; selection and undo history were session-only.
    await page.reload({ waitUntil: 'networkidle0' })
    await openEditor(page, pathId, 4)
    await waitForSaved(page, revision)
    await labelsMatch(page, afterDrag)
    check((await camera(page)).zoom === z, `the camera reopened at ${(await camera(page)).zoom}, not ${z}`)
    check((await selectedLabels(page)).length === 0 && await page.$('#canvas-selection-count') === null, `the selection survived the reload: ${await selectedLabels(page)}`)
    check(await page.$eval('#editor-undo-btn', (el) => (el as HTMLButtonElement).disabled) && await page.$eval('#editor-redo-btn', (el) => (el as HTMLButtonElement).disabled), 'the undo history survived the reload')
    // Unauthorized and invalid layout edits are refused by the backend and change nothing.
    const accepted = await readDoc(page, pathId)
    const shifted = { ...accepted.editor, cards: accepted.editor.cards.map((c) => ({ ...c, position: { x: c.position.x + 500, y: c.position.y } })) }
    const stale = await api(page, `/personal/learning-paths/${pathId}/document`, 'PUT', { ...saveFrom(accepted), expectedRevision: revision - 1, editor: shifted })
    const outside = await api(page, `/personal/learning-paths/${pathId}/document`, 'PUT', { ...saveFrom(accepted), editor: { ...accepted.editor, cards: accepted.editor.cards.map((c, i) => (i === 0 ? { ...c, position: { x: MAX_WORLD + 1, y: 0 } } : c)) } })
    check(stale.status === 409 && outside.status === 422, `stale save answered ${stale.status}, out-of-bounds save ${outside.status}: ${JSON.stringify(outside.body)}`)
    const graceContext = await browser.createBrowserContext()
    const grace = current = await graceContext.newPage()
    grace.setDefaultTimeout(10000)
    grace.on('pageerror', (error) => errors.push(String(error)))
    await signUp(grace, 'grace@gurow.test')
    const graceRead = await api(grace, `/personal/learning-paths/${pathId}`)
    const graceWrite = await api(grace, `/personal/learning-paths/${pathId}/document`, 'PUT', { ...saveFrom(accepted), editor: shifted })
    await grace.goto(`${ORIGIN}/paths/${pathId}`, { waitUntil: 'networkidle0' })
    await grace.waitForSelector('#path-unavailable')
    check(graceRead.status === 404 && graceWrite.status === 404 && await grace.$('#editor-canvas') === null, `another Account: read ${graceRead.status}, write ${graceWrite.status}`)
    await graceContext.close()
    current = page
    check(JSON.stringify(await readDoc(page, pathId)) === JSON.stringify(accepted), 'a refused layout edit changed the Path')
    pass('reload and refused edits', `reopened at revision ${revision} with the dragged arrangement and the same ${Math.round(z * 100)}% camera, no selection and nothing to undo or redo; stale save → ${stale.status}, position beyond 1,000,000 → ${outside.status}; Grace: read ${graceRead.status}, write ${graceWrite.status}, editor not available; Path unchanged`)

    // 5. A selection dragged against the world limit stops as a group, keeping its shape.
    const far = await createPath(page, 'Far Frontier', 'Cards at the edge of the world')
    const edge = { e: crypto.randomUUID(), f: crypto.randomUUID() }
    const edgeStart = { [edge.e]: { x: MAX_WORLD - 500, y: 0 }, [edge.f]: { x: MAX_WORLD - 300, y: 150 } }
    const farRevision = await seed(page, far, [
      { id: edge.e, title: 'Embedded', position: edgeStart[edge.e] },
      { id: edge.f, title: 'Firmware', position: edgeStart[edge.f] },
    ], [{ from_id: edge.e, to_id: edge.f }])
    // Open the Path with the camera already at the edge (camera state is the owner's local view).
    await page.evaluate((key: string) => localStorage.setItem(key, JSON.stringify({ offset_x: -(1_000_000 - 700), offset_y: 100, zoom: 1 })), `gurow:camera:${adaId}:${far}`)
    await openEditor(page, far, 2)
    await waitForSaved(page, farRevision)
    await labelsMatch(page, edgeStart)
    await boxSelect(page, { x: MAX_WORLD - 600, y: -60 }, { x: MAX_WORLD - 50, y: 260 })
    check(JSON.stringify(await selectedLabels(page)) === JSON.stringify([edge.e, edge.f].sort()), `the edge box selected ${await selectedLabels(page)}`)
    const edgeGrab = await cardPoint(page, edge.e)
    await page.mouse.move(edgeGrab.x, edgeGrab.y)
    await page.mouse.down()
    await page.mouse.move(edgeGrab.x + 500, edgeGrab.y + 30, { steps: 10 })
    await page.mouse.up()
    await waitForSaved(page, farRevision + 1)
    const limited = await stored(page, far)
    check(limited[edge.f].x === MAX_WORLD && near(limited[edge.f].y, 180, 0.5) && limited[edge.e].x === MAX_WORLD - 200 && near(limited[edge.e].y, 30, 0.5), `stored at the limit: ${JSON.stringify(limited)}`)
    await labelsMatch(page, limited)
    await closeEditorPanels(page)
    await page.click('#editor-undo-btn')
    await waitForSaved(page, farRevision + 2)
    check(samePositions(await stored(page, far), edgeStart), `undo at the limit stored ${JSON.stringify(await stored(page, far))}`)
    pass('world limits', `dragging Embedded+Firmware 500 px right at 100% stops when Firmware reaches x = 1,000,000: saved Embedded (${limited[edge.e].x}, ${limited[edge.e].y.toFixed(1)}), Firmware (${limited[edge.f].x}, ${limited[edge.f].y.toFixed(1)}), same 200×150 offset; one Undo stores both starting positions`)

    check(errors.length === 0, `page errors: ${errors.join('; ')}`)
    console.log(`\nT31 arrange-selection check passed (${steps.length} steps).`)
  } catch (error) {
    const shot = path.resolve(FRONTEND, '../.harness/t31-failure.png')
    await current?.screenshot({ path: shot }).then(() => console.error(`screenshot: ${shot}`)).catch(() => {})
    if (errors.length > 0) console.error(`page errors:\n  ${errors.join('\n  ')}`)
    throw error
  } finally {
    await browser.close()
    web.kill()
    apiServer.kill()
  }
}

main().catch((error) => {
  console.error(`\nT31 arrange-selection check FAILED after ${steps.length} steps: ${error instanceof Error ? `${error.message}\n${error.stack}` : error}`)
  process.exit(1)
})
