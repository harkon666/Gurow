#!/usr/bin/env bun
/**
 * T16 personal Path authoring check (#17): the production frontend build forwarding
 * /api to the production backend entry (Better Auth sessions) on a freshly migrated
 * PostgreSQL database, in headless Chromium with WebGPU. A signed-in owner creates two
 * Paths, adds Skills with outcomes and Tasks, connects and drags cards, and reloads;
 * a cycle, a stale save from a second tab, a failed save, an invalid API edit and
 * another Account are each refused without losing accepted state.
 *
 * Run from frontend: bun run scripts/t16-path-authoring-check.ts [--skip-build]
 */
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import puppeteer, { type HTTPRequest, type Page } from 'puppeteer-core'
import { resolveChromiumExecutable, waitForServerReady } from './benchmark/browser'
import { closeEditorPanels, openNewSkill } from './editor-navigation'

const FRONTEND = path.resolve(import.meta.dir, '..')
const BACKEND = path.resolve(FRONTEND, '../backend')
const PORT = Number(process.env.PORT ?? 3491)
const API_PORT = Number(process.env.API_PORT ?? 3492)
const ORIGIN = `http://127.0.0.1:${PORT}`
const DATABASE_URL = process.env.T16_DATABASE_URL ?? 'postgres://gurow:gurow@127.0.0.1:5433/gurow_t16_browser_test'
const PASSWORD = 'correct horse battery staple'

interface Box { x: number; y: number; width: number; height: number }
interface Label extends Box { id: string; title: string }
interface Edge { from_id: string; to_id: string }
interface Doc {
  learningPath: { id: string; personalWorkspaceId: string; title: string; goal: string; revision: number }
  editor: { format_version: 1; cards: { id: string; title: string; position: { x: number; y: number } }[]; connections: Edge[] }
  application: { skills: { id: string; title: string; outcome: string; tasks: { id: string; title: string; description: string }[] }[] }
}

const steps: string[] = []
function pass(step: string, detail: string) {
  steps.push(step)
  console.log(`  ✓ ${step}: ${detail}`)
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
const close = (a: number, b: number, tolerance = 1.5) => Math.abs(a - b) <= tolerance

/** Calls the backend from the page, with the page's own session cookie. */
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
const edgesOf = (edges: Edge[]) => edges.map((e) => `${e.from_id}>${e.to_id}`).sort()

const text = (page: Page, selector: string) => page.$eval(selector, (el) => el.textContent?.trim() ?? '')
const labels = (page: Page): Promise<Label[]> => page.$$eval('[id^="card-label-"]', (els) => {
  const origin = document.querySelector('#labels-overlay')!.getBoundingClientRect()
  return els.map((el) => {
    const r = el.getBoundingClientRect()
    return { id: el.id.replace('card-label-', ''), title: el.querySelector('h3')!.textContent ?? '', x: r.x - origin.x, y: r.y - origin.y, width: r.width, height: r.height }
  }).sort((a, b) => a.id.localeCompare(b.id))
})
/** The live engine graph the detail panel renders. */
const graph = async (page: Page): Promise<string[]> => edgesOf(JSON.parse(await page.$eval('#skill-detail-panel', (el) => (el as HTMLElement).dataset.connections ?? '[]')))
const settle = (page: Page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const saveState = (page: Page) => page.$eval('#save-status', (el) => ({ state: (el as HTMLElement).dataset.state!, revision: Number((el as HTMLElement).dataset.revision) }))
async function waitForSaved(page: Page, revision: number) {
  await page.waitForFunction((want: number) => {
    const el = document.querySelector('#save-status') as HTMLElement | null
    return el?.dataset.state === 'saved' && Number(el.dataset.revision) === want
  }, { timeout: 10000 }, revision).catch(async () => {
    throw new Error(`expected "saved" at revision ${revision}, status is ${JSON.stringify(await saveState(page))}`)
  })
}
async function waitForState(page: Page, state: string) {
  await page.waitForFunction((want: string) => (document.querySelector('#save-status') as HTMLElement | null)?.dataset.state === want, { timeout: 10000 }, state)
    .catch(async () => { throw new Error(`expected save state ${state}, status is ${JSON.stringify(await saveState(page))}`) })
}
/** React-controlled fields need the native value setter before the input event. */
async function setValue(page: Page, selector: string, value: string) {
  await page.$eval(selector, (el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
}
const fieldValue = (page: Page, selector: string) => page.$eval(selector, (el) => (el as HTMLInputElement).value)

async function authenticate(page: Page, mode: 'sign-in' | 'sign-up', email: string) {
  await page.waitForSelector('#sign-in-form')
  await setValue(page, '#email-input', email)
  await setValue(page, '#password-input', PASSWORD)
  await page.click(mode === 'sign-in' ? '#sign-in-btn' : '#sign-up-btn')
  await page.waitForSelector('#personal-workspace')
}
async function signOut(page: Page) {
  await closeEditorPanels(page)
  await page.click('#sign-out-btn')
  await page.waitForSelector('#sign-in-form')
}

/** Waits for the Path editor with a live WebGPU renderer and `cards` labels. */
async function openEditor(page: Page, cards: number) {
  // A real WebGPU renderer, not the CPU fallback: the engine reported 'ready'.
  await page.waitForSelector('#path-editor[data-gpu-status="ready"]', { timeout: 20000 }).catch(async () => {
    throw new Error(`the editor did not reach WebGPU 'ready' (status ${await page.$eval('#path-editor', (el) => (el as HTMLElement).dataset.gpuStatus).catch(() => 'absent')})`)
  })
  await page.waitForFunction((n: number) => document.querySelectorAll('[id^="card-label-"]').length === n, {}, cards)
  return page.$eval('#path-editor', (el) => (el as HTMLElement).dataset.pathId!)
}
async function createPath(page: Page, title: string, goal: string) {
  await setValue(page, '#new-path-title', title)
  await setValue(page, '#new-path-goal', goal)
  await page.click('#create-path-btn')
  return openEditor(page, 0)
}
async function addSkill(page: Page, title: string, outcome: string) {
  const before = (await labels(page)).map((l) => l.id)
  await openNewSkill(page)
  await setValue(page, '#new-skill-title', title)
  await setValue(page, '#new-skill-outcome', outcome)
  await page.click('#add-skill-btn')
  await page.waitForFunction((n: number) => document.querySelectorAll('[id^="card-label-"]').length === n, {}, before.length + 1)
  const id = (await labels(page)).map((l) => l.id).find((x) => !before.includes(x))!
  await page.waitForFunction((want: string) => document.querySelector('#selected-skill-id')?.textContent?.trim() === want, {}, id)
  return id
}
/** Clicks a visible canvas point of the card, so selection goes through the engine. */
async function select(page: Page, id: string) {
  await closeEditorPanels(page)
  const point = await page.$eval(`#card-label-${id}`, (el) => {
    const canvas = document.querySelector('#editor-canvas')!, r = el.getBoundingClientRect()
    for (let y = r.top + 8; y < r.bottom - 8; y += 8) for (let x = r.left + 8; x < r.right - 8; x += 8) {
      if (document.elementFromPoint(x, y) === canvas) return { x, y }
    }
    return null
  })
  check(point, `card ${id} is not visible on the canvas`)
  await page.mouse.click(point.x, point.y)
  await page.waitForFunction((want: string) => document.querySelector('#selected-skill-id')?.textContent?.trim() === want, {}, id)
}
async function addTask(page: Page, title: string, description: string) {
  const before = await page.$$eval('[id^="task-edit-title-"]', (els) => els.map((el) => el.id))
  await page.click('#add-task-btn')
  await page.waitForFunction((n: number) => document.querySelectorAll('[id^="task-edit-title-"]').length === n, {}, before.length + 1)
  const id = (await page.$$eval('[id^="task-edit-title-"]', (els) => els.map((el) => el.id))).find((x) => !before.includes(x))!.replace('task-edit-title-', '')
  await setValue(page, `#task-edit-title-${id}`, title)
  await setValue(page, `#task-edit-description-${id}`, description)
  return id
}
async function connect(page: Page, from: string, to: string) {
  await select(page, from)
  await page.select('#connect-skill-select', to)
  await page.click('#btn-add-dependent')
}
/** A canvas point at least 30 px from every label, so a press pans instead of picking. */
const emptyPoint = (page: Page) => page.evaluate(() => {
  const element = document.querySelector('#editor-canvas')!
  const canvas = element.getBoundingClientRect()
  const rects = [...document.querySelectorAll('[id^="card-label-"]')].map((el) => el.getBoundingClientRect())
  for (let y = canvas.top + 40; y < canvas.bottom - 40; y += 20) for (let x = canvas.left + 40; x < canvas.right - 40; x += 20) {
    if (document.elementFromPoint(x, y) === element && rects.every((r) => x < r.left - 30 || x > r.right + 30 || y < r.top - 30 || y > r.bottom + 30)) return { x, y }
  }
  return null
})
async function waitForLabels(page: Page, expected: Label[]) {
  await page.waitForFunction((want: Label[]) => {
    const origin = document.querySelector('#labels-overlay')?.getBoundingClientRect()
    const els = document.querySelectorAll('[id^="card-label-"]')
    return !!origin && els.length === want.length && want.every((card) => {
      const el = document.getElementById(`card-label-${card.id}`)
      const r = el?.getBoundingClientRect()
      return !!r && el!.querySelector('h3')?.textContent === card.title && Math.abs(r.x - origin.x - card.x) < 1.5 &&
        Math.abs(r.y - origin.y - card.y) < 1.5 && Math.abs(r.width - card.width) < 1.5
    })
  }, { timeout: 10000 }, expected).catch(async () => {
    throw new Error(`labels differ: want ${JSON.stringify(expected)}, have ${JSON.stringify(await labels(page))}`)
  })
}

async function main() {
  if (!process.argv.includes('--skip-build')) {
    console.log('Building current sources (Wasm + production bundle)...')
    execFileSync('bun', ['run', 'build'], { cwd: FRONTEND, stdio: 'inherit' })
  }
  execFileSync('bun', ['run', 'test/support/prepare-browser-database.ts'], { cwd: BACKEND, stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: DATABASE_URL } })

  // The production backend entry point: identity only from Better Auth sessions.
  // A developer's backend/.env may hold a real Resend key; this check reads the logged mail instead.
  const apiServer = spawn('bun', ['run', 'src/index.ts'], {
    cwd: BACKEND,
    env: { ...process.env, DATABASE_URL, PORT: String(API_PORT), BETTER_AUTH_URL: ORIGIN, BETTER_AUTH_SECRET: 't16-browser-check-secret-not-for-production', NODE_ENV: 'test', RESEND_API_KEY: '' },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  const web = spawn('node', ['.output/server/index.mjs'], { cwd: FRONTEND, env: { ...process.env, PORT: String(PORT), GUROW_API_ORIGIN: `http://127.0.0.1:${API_PORT}` }, stdio: 'ignore' })
  const browser = await puppeteer.launch({
    executablePath: resolveChromiumExecutable(), headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-webgpu', '--use-gl=angle', '--disable-dev-shm-usage'],
  })
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  let current: Page | null = null
  try {
    await waitForServerReady(ORIGIN)
    for (let i = 0; i < 30; i++) {
      if ((await fetch(`${ORIGIN}/api/account`).catch(() => null))?.status === 401) break
      await new Promise((r) => setTimeout(r, 300))
    }
    const context = await browser.createBrowserContext()
    const page = await context.newPage()
    page.setDefaultTimeout(10000)
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    // Every reload and navigation here happens with the document saved; an unsaved-work prompt is a failure.
    const dialogs: string[] = []
    page.on('dialog', (dialog) => { dialogs.push(dialog.type()); void dialog.accept() })
    current = page
    await page.setViewport({ width: 1400, height: 860, deviceScaleFactor: 1 })

    // 1. Authoring: a signed-in owner creates a Path with a goal, Skills with outcomes, Tasks and a Prerequisite.
    await page.goto(ORIGIN, { waitUntil: 'networkidle0' })
    await authenticate(page, 'sign-up', 'ada@gurow.test')
    const adaId = await page.$eval('main', (el) => (el as HTMLElement).dataset.accountId!)
    const pathA = await createPath(page, 'Systems Rust', 'Ship a small allocator')
    check(new URL(page.url()).pathname === `/paths/${pathA}`, `the new Path opened at ${page.url()}`)
    check((await saveState(page)).state === 'saved' && (await saveState(page)).revision === 0, `a new Path starts as ${JSON.stringify(await saveState(page))}`)
    const ownership = await addSkill(page, 'Ownership', 'Explain moves and borrows')
    const lifetimes = await addSkill(page, 'Lifetimes', 'Annotate lifetimes in signatures')
    await select(page, ownership)
    const ownershipTask = await addTask(page, 'Borrow exercises', 'Ten borrow checker exercises')
    await select(page, lifetimes)
    const lifetimesTask = await addTask(page, 'Annotate lifetimes', 'Annotate a parser')
    await connect(page, ownership, lifetimes)
    await page.waitForFunction((from: string, to: string) => JSON.parse((document.querySelector('#skill-detail-panel') as HTMLElement).dataset.connections ?? '[]')
      .some((c: Edge) => c.from_id === from && c.to_id === to), {}, ownership, lifetimes)
    await waitForState(page, 'saved')
    const doc = await readDoc(page, pathA)
    const skillsSaved = doc.application.skills.map((s) => [s.id, s.title, s.outcome, s.tasks.map((t) => `${t.id}:${t.title}:${t.description}`)])
    check(JSON.stringify(skillsSaved) === JSON.stringify([
      [ownership, 'Ownership', 'Explain moves and borrows', [`${ownershipTask}:Borrow exercises:Ten borrow checker exercises`]],
      [lifetimes, 'Lifetimes', 'Annotate lifetimes in signatures', [`${lifetimesTask}:Annotate lifetimes:Annotate a parser`]],
    ]), `saved Skills/Tasks: ${JSON.stringify(skillsSaved)}`)
    check(JSON.stringify(edgesOf(doc.editor.connections)) === JSON.stringify([`${ownership}>${lifetimes}`]), `saved connections: ${edgesOf(doc.editor.connections)}`)
    check(JSON.stringify(doc.editor.cards.map((c) => c.id)) === JSON.stringify([ownership, lifetimes]), 'saved cards are not one per Skill')
    const snapshot = JSON.stringify(doc.editor)
    check(![ownershipTask, lifetimesTask, 'Borrow exercises', 'Annotate a parser', 'Explain moves'].some((t) => snapshot.includes(t)), 'Task or outcome content leaked into the editor snapshot')
    check(doc.learningPath.title === 'Systems Rust' && doc.learningPath.goal === 'Ship a small allocator', `saved Path ${doc.learningPath.title} / ${doc.learningPath.goal}`)
    pass('authoring', `Path ${pathA} rev ${doc.learningPath.revision}: 2 Skills with outcomes, one Task each, ${ownership.slice(0, 8)}→${lifetimes.slice(0, 8)}; snapshot holds only cards and connections`)

    // 2. A cycle is rejected in the editor at once; nothing is saved for it.
    const revisionBeforeCycle = (await saveState(page)).revision
    const graphBefore = await graph(page)
    await connect(page, lifetimes, ownership)
    await page.waitForSelector('#cycle-rejection-alert[data-kind="cycle"]')
    await new Promise((r) => setTimeout(r, 900))
    check(JSON.stringify(await graph(page)) === JSON.stringify(graphBefore), 'the rejected cycle changed the live graph')
    check((await saveState(page)).revision === revisionBeforeCycle && (await saveState(page)).state === 'saved', `the rejected cycle produced a save: ${JSON.stringify(await saveState(page))}`)
    check(JSON.stringify(edgesOf((await readDoc(page, pathA)).editor.connections)) === JSON.stringify(graphBefore), 'the rejected cycle reached the backend')
    pass('cycle rejection', `"${(await text(page, '#cycle-rejection-alert')).slice(0, 60)}…"; graph and revision ${revisionBeforeCycle} unchanged`)

    // 3. A completed drag autosaves the card position; camera changes stay local.
    await closeEditorPanels(page)
    const dragFrom = (await labels(page)).find((l) => l.id === lifetimes)!
    const storedBefore = (await readDoc(page, pathA)).editor.cards.find((c) => c.id === lifetimes)!.position
    const overlay = await page.$eval('#labels-overlay', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y } })
    const grab = { x: overlay.x + dragFrom.x + 30, y: overlay.y + dragFrom.y + 30 }
    await page.mouse.move(grab.x, grab.y)
    await page.mouse.down()
    await page.mouse.move(grab.x + 90, grab.y + 60, { steps: 12 })
    await page.mouse.up()
    await waitForSaved(page, revisionBeforeCycle + 1)
    const storedAfter = (await readDoc(page, pathA)).editor.cards.find((c) => c.id === lifetimes)!.position
    check(close(storedAfter.x - storedBefore.x, 90) && close(storedAfter.y - storedBefore.y, 60), `stored drag moved ${JSON.stringify(storedBefore)} → ${JSON.stringify(storedAfter)}`)
    check(await page.$eval('#editor-undo-btn', (el) => !(el as HTMLButtonElement).disabled), 'undo is not available after the drag')
    const revisionAfterDrag = revisionBeforeCycle + 1
    const start = await emptyPoint(page)
    check(start, 'no empty canvas point for panning')
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x + 70, start.y + 30, { steps: 6 })
    await page.mouse.up()
    await page.keyboard.down('Control')
    await page.mouse.wheel({ deltaY: -60 })
    await page.keyboard.up('Control')
    await settle(page)
    await new Promise((r) => setTimeout(r, 900))
    const cameraKey = `gurow:camera:${adaId}:${pathA}`
    const camera = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), cameraKey)
    check(camera && camera.zoom > 1 && camera.offset_x !== 0, `camera not stored locally under ${cameraKey}: ${JSON.stringify(camera)}`)
    const afterCamera = await readDoc(page, pathA)
    check(afterCamera.learningPath.revision === revisionAfterDrag && (await saveState(page)).revision === revisionAfterDrag, 'a camera change produced a save')
    check(!/camera|zoom|offset_x|selected|undo/i.test(JSON.stringify(afterCamera)), 'view state reached the durable document')
    pass('drag autosave and local camera', `drag saved as rev ${revisionAfterDrag} (+90,+60); pan/zoom stored only at ${cameraKey} (zoom ${camera.zoom.toFixed(2)})`)

    // 4. Reload restores the same Skills, Tasks, positions, connections and camera, with no selection or undo history.
    const beforeReload = await labels(page)
    await page.reload({ waitUntil: 'networkidle0' })
    await openEditor(page, 2)
    await waitForLabels(page, beforeReload)
    check(await page.$('#selected-skill-id') === null, 'a selection survived the reload')
    check(await page.$eval('#editor-undo-btn', (el) => (el as HTMLButtonElement).disabled), 'undo history survived the reload')
    check(JSON.stringify(await graph(page)) === JSON.stringify([`${ownership}>${lifetimes}`]), `reloaded graph ${await graph(page)}`)
    const reloadedStatus = await saveState(page)
    check(reloadedStatus.state === 'saved' && reloadedStatus.revision === revisionAfterDrag, `reloaded status ${JSON.stringify(reloadedStatus)}`)
    await select(page, lifetimes)
    check(await fieldValue(page, `#task-edit-title-${lifetimesTask}`) === 'Annotate lifetimes', 'Lifetimes did not open its own Task')
    check(await page.$(`#task-edit-title-${ownershipTask}`) === null, 'Lifetimes shows Ownership\'s Task')
    await select(page, ownership)
    check(await fieldValue(page, `#task-edit-title-${ownershipTask}`) === 'Borrow exercises' && await fieldValue(page, '#skill-outcome-input') === 'Explain moves and borrows', 'Ownership did not reopen with its Task and outcome')
    check(await fieldValue(page, '#path-goal-input') === 'Ship a small allocator', 'the goal did not reopen')
    pass('coherent reload', `same ${beforeReload.length} card positions under the restored camera; each card opens its own Skill outcome and Task; no selection, undo disabled`)

    // 5. A second Path keeps its own content and camera; the first reopens unchanged.
    await closeEditorPanels(page)
    await page.click('#back-to-workspace')
    await page.waitForSelector('#personal-workspace')
    check((await text(page, '#workspace-paths')).includes('Ship a small allocator'), 'the Workspace does not list the Path goal')
    const pathB = await createPath(page, 'Jazz Guitar', 'Comp through a blues')
    check(pathB !== pathA && (await text(page, '#editor-zoom-label')) === '100%', `the second Path opened ${pathB} at zoom ${await text(page, '#editor-zoom-label')}`)
    const voicings = await addSkill(page, 'Shell voicings', 'Voice ii-V-I changes')
    await waitForSaved(page, 1)
    // Leaving while a save is in flight: the later edit, not yet sent, still follows it.
    const held: { request: HTTPRequest | null } = { request: null }
    const holdFirstSave = (request: HTTPRequest) => {
      if (request.isInterceptResolutionHandled()) return
      if (held.request === null && request.method() === 'PUT' && request.url().endsWith('/document')) held.request = request
      else void request.continue()
    }
    await page.setRequestInterception(true)
    page.on('request', holdFirstSave)
    await closeEditorPanels(page)
    await setValue(page, '#path-goal-input', 'Comp through a minor blues')
    await waitForState(page, 'saving')
    for (let i = 0; i < 50 && held.request === null; i++) await new Promise((r) => setTimeout(r, 50))
    check(held.request, 'the first save never reached the network')
    await closeEditorPanels(page)
    await setValue(page, '#path-goal-input', 'Comp through a slow blues')
    await closeEditorPanels(page)
    await page.click('#back-to-workspace')
    await page.waitForSelector('#personal-workspace')
    await held.request.continue()
    let left = await readDoc(page, pathB)
    for (let i = 0; i < 25 && left.learningPath.goal !== 'Comp through a slow blues'; i++) {
      await new Promise((r) => setTimeout(r, 200))
      left = await readDoc(page, pathB)
    }
    page.off('request', holdFirstSave)
    await page.setRequestInterception(false)
    check(left.learningPath.goal === 'Comp through a slow blues' && left.learningPath.revision === 3,
      `an edit made during an in-flight save was lost on leaving (goal "${left.learningPath.goal}", rev ${left.learningPath.revision})`)
    await page.waitForSelector(`[data-learning-path-id="${pathA}"] a`)
    await page.click(`[data-learning-path-id="${pathA}"] a`)
    await openEditor(page, 2)
    await waitForLabels(page, beforeReload)
    const docB = await readDoc(page, pathB)
    check(JSON.stringify(docB.application.skills.map((s) => s.id)) === JSON.stringify([voicings]) && !(await labels(page)).some((l) => l.id === voicings), 'the Paths share Skills')
    pass('multiple Paths', `Path ${pathB} holds only "Shell voicings" at its own camera; an edit made while a save was held and the editor was left reached rev 3 after it; ${pathA} reopens from the Workspace with its 2 Skills in place`)

    // 6. A save based on a stale revision is refused; the accepted state stays and the local work stays on screen.
    // First this tab saves a goal of its own, which it returns to after discarding the conflict.
    await closeEditorPanels(page)
    await setValue(page, '#path-goal-input', 'Goal A from this tab')
    await waitForSaved(page, revisionAfterDrag + 1)
    const other = await context.newPage()
    other.setDefaultTimeout(10000)
    other.on('pageerror', (error) => pageErrors.push(String(error)))
    await other.setViewport({ width: 1400, height: 860, deviceScaleFactor: 1 })
    await other.goto(`${ORIGIN}/paths/${pathA}`, { waitUntil: 'networkidle0' })
    await openEditor(other, 2)
    await setValue(other, '#path-goal-input', 'Goal from the second tab')
    await waitForSaved(other, revisionAfterDrag + 2)
    await page.bringToFront()
    await select(page, ownership)
    await setValue(page, `#task-edit-title-${ownershipTask}`, 'Edit from the stale tab')
    await waitForState(page, 'conflict')
    await page.waitForSelector('#save-conflict')
    await setValue(page, '#skill-outcome-input', 'Still editing locally')
    await new Promise((r) => setTimeout(r, 900))
    check((await saveState(page)).state === 'conflict', 'autosave resumed after the conflict')
    check(await fieldValue(page, `#task-edit-title-${ownershipTask}`) === 'Edit from the stale tab' && await fieldValue(page, '#skill-outcome-input') === 'Still editing locally', 'the local work was not kept')
    let accepted = await readDoc(page, pathA)
    const acceptedTask = accepted.application.skills.find((s) => s.id === ownership)!
    check(accepted.learningPath.revision === revisionAfterDrag + 2 && accepted.learningPath.goal === 'Goal from the second tab' &&
      acceptedTask.tasks[0].title === 'Borrow exercises' && acceptedTask.outcome === 'Explain moves and borrows', `the stale save overwrote accepted state: ${JSON.stringify(accepted.learningPath)} ${JSON.stringify(acceptedTask)}`)
    const conflictText = await text(page, '#save-conflict')
    await closeEditorPanels(page)
    await page.click('#load-accepted-btn')
    await waitForSaved(page, revisionAfterDrag + 2)
    check(await fieldValue(page, '#path-goal-input') === 'Goal from the second tab', 'loading the saved version kept the stale goal')
    await select(page, ownership)
    check(await fieldValue(page, `#task-edit-title-${ownershipTask}`) === 'Borrow exercises', 'loading the saved version kept the stale Task title')
    // Going back to this tab's earlier accepted goal is a real edit: the backend must hold it, not just the status.
    await closeEditorPanels(page)
    await setValue(page, '#path-goal-input', 'Goal A from this tab')
    await waitForSaved(page, revisionAfterDrag + 3)
    check((await readDoc(page, pathA)).learningPath.goal === 'Goal A from this tab', 'returning to an earlier goal was shown as saved but not stored')
    await other.close()
    pass('stale save', `"${conflictText.slice(0, 70)}…"; backend kept rev ${revisionAfterDrag + 2} from the other tab while both local edits stayed visible until discarded; returning to this tab's earlier goal saved rev ${revisionAfterDrag + 3}`)

    // 7. A failed save is reported as unsaved and never as saved; a retry saves it.
    await page.evaluate(() => {
      const seen: string[] = ((window as any).__saveStates = [])
      const el = document.querySelector('#save-status')!
      new MutationObserver(() => seen.push((el as HTMLElement).dataset.state!)).observe(el, { attributes: true, attributeFilter: ['data-state'] })
    })
    const blockSaves = (request: HTTPRequest) => {
      if (request.isInterceptResolutionHandled()) return
      if (request.method() === 'PUT' && request.url().endsWith('/document')) void request.abort('connectionfailed')
      else void request.continue()
    }
    await page.setRequestInterception(true)
    page.on('request', blockSaves)
    await closeEditorPanels(page)
    await setValue(page, '#path-goal-input', 'Goal written while offline')
    await waitForState(page, 'failed')
    const failure = await text(page, '#save-error')
    const statesWhileFailing: string[] = await page.evaluate(() => (window as any).__saveStates)
    check(!statesWhileFailing.includes('saved'), `a failed save was shown as saved: ${statesWhileFailing}`)
    check((await readDoc(page, pathA)).learningPath.goal === 'Goal A from this tab', 'the failed save reached the backend')
    check(await fieldValue(page, '#path-goal-input') === 'Goal written while offline', 'the unsaved goal was dropped')
    page.off('request', blockSaves)
    await page.setRequestInterception(false)
    await page.click('#retry-save-btn')
    await waitForSaved(page, revisionAfterDrag + 4)
    check((await readDoc(page, pathA)).learningPath.goal === 'Goal written while offline', 'the retried save did not reach the backend')
    pass('failure feedback', `states ${statesWhileFailing.join('→')} with "${failure}"; retry saved rev ${revisionAfterDrag + 4}`)

    // 8. Invalid edits sent straight to the backend are refused and change nothing.
    accepted = await readDoc(page, pathA)
    const base = { expectedRevision: accepted.learningPath.revision, title: accepted.learningPath.title, goal: accepted.learningPath.goal, editor: accepted.editor, application: accepted.application }
    const cycle = await api(page, `/personal/learning-paths/${pathA}/document`, 'PUT', { ...base, editor: { ...base.editor, connections: [...base.editor.connections, { from_id: lifetimes, to_id: ownership }] } })
    const borrowed = (await readDoc(page, pathB)).application.skills[0]
    const crossPath = await api(page, `/personal/learning-paths/${pathA}/document`, 'PUT', { ...base, editor: { ...base.editor, cards: [...base.editor.cards, { id: borrowed.id, title: borrowed.title, position: { x: 0, y: 0 } }] }, application: { skills: [...base.application.skills, { ...borrowed }] } })
    check(cycle.status === 422 && cycle.body.error === 'prerequisite_cycle', `a cycle answered ${cycle.status} ${JSON.stringify(cycle.body)}`)
    check(crossPath.status === 409 && crossPath.body.error === 'skill_owned_elsewhere', `another Path's Skill answered ${crossPath.status} ${JSON.stringify(crossPath.body)}`)
    check(JSON.stringify(await readDoc(page, pathA)) === JSON.stringify(accepted), 'a refused edit changed the Path')
    pass('invalid edits', `cycle → ${cycle.status} ${cycle.body.error}; Skill of another Path → ${crossPath.status} ${crossPath.body.error}; rev ${accepted.learningPath.revision} unchanged`)

    // 9. Another Account is refused the Path in the UI and the API; the owner finds it intact.
    await signOut(page)
    await authenticate(page, 'sign-up', 'grace@gurow.test')
    await page.goto(`${ORIGIN}/paths/${pathA}`, { waitUntil: 'networkidle0' })
    await page.waitForSelector('#path-unavailable')
    const visible = await page.$eval('body', (el) => el.innerText)
    check(!['Ownership', 'Systems Rust', 'ada@gurow.test', 'allocator'].some((t) => visible.includes(t)), 'the refused page shows the owner\'s content')
    const graceRead = await api(page, `/personal/learning-paths/${pathA}`)
    const graceWrite = await api(page, `/personal/learning-paths/${pathA}/document`, 'PUT', { ...base, goal: 'Grace was here' })
    check(graceRead.status === 404 && graceWrite.status === 404, `another Account answered read ${graceRead.status}, write ${graceWrite.status}`)
    await signOut(page)
    await page.goto(ORIGIN, { waitUntil: 'networkidle0' })
    await authenticate(page, 'sign-in', 'ada@gurow.test')
    await page.goto(`${ORIGIN}/paths/${pathA}`, { waitUntil: 'networkidle0' })
    await openEditor(page, 2)
    check(JSON.stringify(await readDoc(page, pathA)) === JSON.stringify(accepted), 'another Account changed the Path')
    pass('unauthorized Account', `Grace sees "Learning Path not available"; API read ${graceRead.status}, write ${graceWrite.status}; Ada reopens rev ${accepted.learningPath.revision} intact`)

    check(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`)
    check(dialogs.length === 0, `unexpected dialogs while the document was saved: ${dialogs}`)
    console.log(`\nT16 Path authoring check passed (${steps.length} steps).`)
  } catch (error) {
    // Evidence for a failed run: what the page showed and logged.
    const shot = path.resolve(FRONTEND, '../.harness/t16-failure.png')
    await current?.screenshot({ path: shot }).then(() => console.error(`screenshot: ${shot}`)).catch(() => {})
    if (consoleErrors.length > 0) console.error(`console errors:\n  ${consoleErrors.slice(-10).join('\n  ')}`)
    if (pageErrors.length > 0) console.error(`page errors:\n  ${pageErrors.join('\n  ')}`)
    throw error
  } finally {
    await browser.close()
    web.kill()
    apiServer.kill()
  }
}

main().catch((error) => {
  console.error(`\nT16 Path authoring check FAILED after ${steps.length} steps: ${error instanceof Error ? `${error.message}\n${error.stack}` : error}`)
  process.exit(1)
})
