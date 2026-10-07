#!/usr/bin/env bun
/**
 * T06 functional P1 flow (#39): one continuous browser session on a fresh
 * production build. Steps that T04/T05 already assert are repeated here on the
 * same document, so recovery and the no-WebGPU path must keep the Skills,
 * connections and Task edits this flow created, not only the fixture.
 *
 * Run from frontend: bun run scripts/t06-functional-check.ts [--skip-build]
 * Headless Chromium on ANGLE, like T05: functional evidence, not performance.
 */
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import puppeteer, { type Page } from 'puppeteer-core'
import { resolveChromiumExecutable, waitForServerReady } from './benchmark/browser'
import { closeEditorPanels, openSkillList, selectSkillFromList } from './editor-navigation'

const FRONTEND = path.resolve(import.meta.dir, '..')
const PORT = Number(process.env.PORT ?? 3462)
const URL = `http://127.0.0.1:${PORT}`
const CHECKPOINT_KEY = 'gurow:checkpoint:fixture-user:lp-rust-graphics-mvp'

interface Box { x: number; y: number; width: number; height: number }
interface Label extends Box { id: string; title: string }
interface Edge { from_id: string; to_id: string }

const steps: string[] = []
function pass(step: string, detail: string) {
  steps.push(step)
  console.log(`  ✓ ${step}: ${detail}`)
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
const close = (a: number, b: number, tolerance = 2) => Math.abs(a - b) <= tolerance

/** Label rectangles relative to the canvas overlay, independent of page scroll. */
const labels = (page: Page): Promise<Label[]> => page.$$eval('[id^="card-label-"]', els => {
  const origin = document.querySelector('#labels-overlay')!.getBoundingClientRect()
  return els.map(el => {
    const r = el.getBoundingClientRect()
    return { id: el.id.replace('card-label-', ''), title: el.querySelector('h3')!.textContent ?? '', x: r.x - origin.x, y: r.y - origin.y, width: r.width, height: r.height }
  }).sort((a, b) => a.id.localeCompare(b.id))
})
const labelBox = async (page: Page, id: string): Promise<Box> => (await labels(page)).find(l => l.id === id)!
/** The live engine graph the detail panel renders, sorted for comparison. */
const graph = (page: Page): Promise<string[]> => page.$eval('#skill-detail-panel', el =>
  (JSON.parse((el as HTMLElement).dataset.connections ?? '[]') as Edge[]).map(c => `${c.from_id}->${c.to_id}`).sort())
const checkpoint = (page: Page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), CHECKPOINT_KEY)
const selectedId = (page: Page) => page.$eval('#selected-skill-id', el => el.textContent?.trim())
const zoomLabel = (page: Page) => page.$eval('#editor-zoom-label', el => el.textContent?.trim())

/**
 * Clicks a visible canvas point rather than an off-canvas label centre.
 * The non-scrolling label overlay is separately covered by label-scroll-check.
 */
async function select(page: Page, id: string) {
  await closeEditorPanels(page)
  const point = await page.$eval(`#card-label-${id}`, el => {
    const canvas = document.querySelector('#editor-canvas')!, r = el.getBoundingClientRect()
    for (let y = r.top + 8; y < r.bottom - 8; y += 8) for (let x = r.left + 8; x < r.right - 8; x += 8) {
      if (document.elementFromPoint(x, y) === canvas) return { x, y }
    }
    return null
  })
  check(point, `Card ${id} is not visible on the canvas`)
  await page.mouse.click(point.x, point.y)
  await page.waitForFunction((want: string) => document.querySelector('#selected-skill-id')?.textContent?.trim() === want, {}, id)
}
/** React-controlled inputs need the native setter before the input event. */
async function setTaskTitle(page: Page, taskId: string, value: string) {
  await page.$eval(`#task-edit-title-${taskId}`, (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
}
async function savedTask(page: Page, taskId: string, title: string) {
  await page.waitForFunction((key: string, id: string, want: string) => {
    const cp = JSON.parse(localStorage.getItem(key) ?? 'null')
    return cp?.application.skills.some((s: any) => s.tasks.some((t: any) => t.id === id && t.title === want))
  }, { timeout: 5000 }, CHECKPOINT_KEY, taskId, title)
}
async function connect(page: Page, from: string, to: string) {
  await select(page, from)
  await page.select('#connect-skill-select', to)
  await page.click('#btn-add-dependent')
}
/** Moves selection through the keyboard listbox only: no pointer, no canvas. */
async function keyboardSelect(page: Page, id: string) {
  await selectSkillFromList(page, id)
}
/** A canvas point at least 30 px from every label and not under a banner, so a press pans instead of picking. */
const emptyPoint = (page: Page) => page.evaluate(() => {
  const element = document.querySelector('#editor-canvas')!
  const canvas = element.getBoundingClientRect()
  const rects = [...document.querySelectorAll('[id^="card-label-"]')].map(el => el.getBoundingClientRect())
  for (let y = canvas.top + 40; y < canvas.bottom - 40; y += 20) for (let x = canvas.left + 40; x < canvas.right - 40; x += 20) {
    if (document.elementFromPoint(x, y) === element && rects.every(r => x < r.left - 30 || x > r.right + 30 || y < r.top - 30 || y > r.bottom + 30)) return { x, y }
  }
  return null
})
/** Every label moved by the same screen vector, i.e. the camera moved, not the cards. */
function sameShift(before: Label[], after: Label[], dx: number, dy: number) {
  return before.length === after.length && before.every((b, i) => after[i].id === b.id && close(after[i].x - b.x, dx) && close(after[i].y - b.y, dy) && close(after[i].width, b.width))
}
async function settle(page: Page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}
async function waitForLabels(page: Page, expected: Label[]) {
  await page.waitForFunction((want: Label[]) => {
    const origin = document.querySelector('#labels-overlay')?.getBoundingClientRect()
    const els = document.querySelectorAll('[id^="card-label-"]')
    return !!origin && els.length === want.length && want.every(card => {
      const el = document.getElementById(`card-label-${card.id}`)
      const r = el?.getBoundingClientRect()
      return !!r && el!.querySelector('h3')?.textContent === card.title && Math.abs(r.x - origin.x - card.x) < 1 &&
        Math.abs(r.y - origin.y - card.y) < 1 && Math.abs(r.width - card.width) < 1 && Math.abs(r.height - card.height) < 1
    })
  }, { timeout: 10000 }, expected)
}
/** Hides the HTML labels and counts card-fill pixels the WebGPU canvas drew inside an overlay-relative box. */
async function canvasCardPixels(page: Page, box: Box): Promise<number> {
  const canvas = await page.$eval('#editor-canvas', el => el.getBoundingClientRect().toJSON() as DOMRect)
  const left = Math.max(canvas.x + box.x + 12, canvas.x), top = Math.max(canvas.y + box.y + 12, canvas.y)
  const right = Math.min(canvas.x + box.x + box.width - 12, canvas.right), bottom = Math.min(canvas.y + box.y + box.height - 12, canvas.bottom)
  check(right - left > 10 && bottom - top > 10, 'Pixel sample box is off the canvas')
  await page.$eval('#labels-overlay', el => { (el as HTMLElement).style.visibility = 'hidden' })
  await settle(page)
  const png = await page.screenshot({ clip: { x: left, y: top, width: right - left, height: bottom - top }, encoding: 'base64' })
  await page.$eval('#labels-overlay', el => { (el as HTMLElement).style.visibility = '' })
  // Background is (18, 20, 28); card fill is (28, 36, 48). Decode in the page to avoid an image dependency.
  return page.evaluate(async (data: string) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob())
    const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const px = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
    let count = 0
    for (let i = 0; i < px.length; i += 4) if (px[i] >= 24 && px[i + 1] >= 30 && px[i + 2] >= 40) count++
    return count
  }, png as string)
}

async function main() {
  console.log('=== Gurow P1/T06 functional flow (#39) ===')
  if (!process.argv.includes('--skip-build')) {
    console.log('Building current sources (Wasm + production bundle)...')
    execFileSync('bun', ['run', 'build'], { cwd: FRONTEND, stdio: 'inherit' })
  }
  const server = spawn('node', ['.output/server/index.mjs'], { cwd: FRONTEND, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' })
  const browser = await puppeteer.launch({
    executablePath: resolveChromiumExecutable(), headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-webgpu', '--use-gl=angle', '--disable-dev-shm-usage'],
  })
  const pageErrors: string[] = []
  try {
    await waitForServerReady(URL)
    const page = await browser.newPage()
    page.setDefaultTimeout(10000)
    page.on('pageerror', error => pageErrors.push(String(error)))
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })
    await page.goto(`${URL}/editor`, { waitUntil: 'networkidle0' })
    await page.evaluate(() => localStorage.clear())
    await page.reload({ waitUntil: 'networkidle0' })
    await page.waitForSelector('#card-label-skill-rust-basics')
    // Labels and the badge text appear while the renderer is still initializing; "+ Skill"
    // is enabled only once it is ready, and a click before that does nothing.
    await page.waitForSelector('#editor-add-card-btn:not([disabled])')
    const gpuStatus = await page.$eval('#gpu-status-badge', el => (el as HTMLElement).dataset.status)
    check(gpuStatus === 'ready', `WebGPU renderer not active: "${gpuStatus}"`)
    const fixtureIds = (await labels(page)).map(l => l.id)

    console.log('\n--- Create and select ---')
    await closeEditorPanels(page)
    await page.click('#editor-add-card-btn')
    await page.waitForFunction((n: number) => document.querySelectorAll('[id^="card-label-"]').length === n, {}, fixtureIds.length + 1)
    await closeEditorPanels(page)
    await page.click('#editor-add-card-btn')
    await page.waitForFunction((n: number) => document.querySelectorAll('[id^="card-label-"]').length === n, {}, fixtureIds.length + 2)
    const [first, second] = (await labels(page)).map(l => l.id).filter(id => !fixtureIds.includes(id)).sort()
    check(first?.startsWith('skill-custom-') && second?.startsWith('skill-custom-'), `Expected two new Skills, got ${first}, ${second}`)
    await select(page, second)
    await select(page, first)
    const firstTask = `task-${first}-intro`, secondTask = `task-${second}-intro`
    const firstLabel = (await labels(page)).find(l => l.id === first)!.title
    await page.waitForSelector(`#task-edit-title-${firstTask}`)
    pass('create_select', `created ${first} and ${second}; canvas click selects ${await selectedId(page)} and shows its Task`)

    console.log('\n--- Task editing ---')
    const firstTitle = 'T06 flow: first new Task', fixtureTitle = 'T06 flow: fixture Task'
    await setTaskTitle(page, firstTask, firstTitle)
    await page.click(`#task-edit-required-${firstTask}`)
    await page.waitForFunction((id: string) => document.querySelector(`#task-badge-${id}`)?.textContent?.trim() === 'Enrichment', {}, firstTask)
    await savedTask(page, firstTask, firstTitle)
    await select(page, 'skill-rust-basics')
    await setTaskTitle(page, 'task-rust-toolchain', fixtureTitle)
    await savedTask(page, 'task-rust-toolchain', fixtureTitle)
    const saved = await checkpoint(page)
    check(saved.application.skills.find((s: any) => s.id === first).tasks[0].required === false, 'Required toggle not saved')
    check(!JSON.stringify(saved.editor).includes(firstTitle), 'Task content leaked into the editor snapshot')
    pass('task_edit', 'new and fixture Task titles plus the Required toggle saved in the application payload only')

    console.log('\n--- Valid connection and cycle rejection ---')
    await connect(page, first, second)
    await page.waitForFunction((edge: string) => JSON.parse((document.querySelector('#skill-detail-panel') as HTMLElement).dataset.connections ?? '[]')
      .some((c: Edge) => `${c.from_id}->${c.to_id}` === edge), {}, `${first}->${second}`)
    await connect(page, 'skill-rust-basics', first)
    await page.waitForFunction((edge: string) => JSON.parse((document.querySelector('#skill-detail-panel') as HTMLElement).dataset.connections ?? '[]')
      .some((c: Edge) => `${c.from_id}->${c.to_id}` === edge), {}, `skill-rust-basics->${first}`)
    const graphBefore = await graph(page)
    check(graphBefore.includes(`skill-rust-basics->${first}`) && graphBefore.includes(`${first}->${second}`), `Connections missing: ${graphBefore}`)
    const savedEdges = async () => ((await checkpoint(page)).editor.connections as Edge[]).map(c => `${c.from_id}->${c.to_id}`).sort()
    await page.waitForFunction((key: string, n: number) => JSON.parse(localStorage.getItem(key)!).editor.connections.length === n, {}, CHECKPOINT_KEY, graphBefore.length)
    // second -> rust-basics closes rust-basics -> first -> second -> rust-basics.
    await connect(page, second, 'skill-rust-basics')
    await page.waitForSelector('#cycle-rejection-alert')
    // The refusal's kind, not its wording (#52); connectionRejection.test.ts covers the message.
    const rejection = await page.$eval('#cycle-rejection-alert', el => (el as HTMLElement).dataset.kind)
    check(rejection === 'cycle', `Expected a cycle refusal, got kind "${rejection}"`)
    await settle(page)
    check(JSON.stringify(await graph(page)) === JSON.stringify(graphBefore), 'Rejected cycle changed the live graph')
    check(JSON.stringify(await savedEdges()) === JSON.stringify(graphBefore), 'Rejected cycle changed the saved graph')
    pass('connection_cycle_rejection', `${graphBefore.length} edges incl. two on new Skills; cycle through them rejected, live and saved graph unchanged`)

    console.log('\n--- Pan, zoom and drag ---')
    await closeEditorPanels(page)
    const start = await emptyPoint(page)
    check(start, 'No empty canvas point for panning')
    let before = await labels(page)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x + 60, start.y + 40, { steps: 6 })
    await page.mouse.up()
    await settle(page)
    let after = await labels(page)
    check(sameShift(before, after, 60, 40), 'Pointer pan did not move every label by (+60, +40)')
    before = after
    await page.mouse.move(start.x, start.y)
    await page.mouse.wheel({ deltaY: 50 })
    await settle(page)
    after = await labels(page)
    check(sameShift(before, after, 0, -50), 'Wheel pan did not move every label by (0, -50)')
    const zoomBefore = await zoomLabel(page)
    before = after
    await page.keyboard.down('Control')
    await page.mouse.wheel({ deltaY: -60 })
    await page.keyboard.up('Control')
    await page.waitForFunction((z: string) => document.querySelector('#editor-zoom-label')?.textContent?.trim() !== z, {}, zoomBefore)
    await settle(page)
    after = await labels(page)
    const scale = after[0].width / before[0].width
    check(scale > 1.2 && after.every((a, i) => Math.abs(a.width / before[i].width - scale) < 0.01 && Math.abs(a.height / before[i].height - scale) < 0.01),
      `Ctrl+wheel zoom did not scale every label uniformly (scale ${scale})`)
    const zoomed = await zoomLabel(page)
    const dragFrom = await labelBox(page, second)
    const savedBeforeDrag = ((await checkpoint(page)).editor.cards as { id: string; position: { x: number; y: number } }[]).find(c => c.id === second)!.position
    const overlay = await page.$eval('#labels-overlay', el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y } })
    const grab = { x: overlay.x + dragFrom.x + 30, y: overlay.y + dragFrom.y + 30 }
    await page.mouse.move(grab.x, grab.y)
    await page.mouse.down()
    await page.mouse.move(grab.x + 90, grab.y + 60, { steps: 12 })
    await page.mouse.up()
    await settle(page)
    const dragged = await labelBox(page, second)
    check(close(dragged.x - dragFrom.x, 90, 3) && close(dragged.y - dragFrom.y, 60, 3), `Drag moved ${second} by (${dragged.x - dragFrom.x}, ${dragged.y - dragFrom.y})`)
    const others = (await labels(page)).filter(l => l.id !== second)
    check(others.every(o => { const z = after.find(x => x.id === o.id)!; return close(o.x, z.x) && close(o.y, z.y) }), 'Drag moved a card other than the dragged one')
    pass('pan_zoom_drag', `pointer pan (+60,+40) and wheel pan (0,-50) move all labels; Ctrl+wheel ${zoomBefore}→${zoomed} scales them ×${scale.toFixed(3)}; drag moves ${second} (+90,+60)`)

    console.log('\n--- One-step drag undo/redo ---')
    await closeEditorPanels(page)
    await page.click('#editor-undo-btn')
    await settle(page)
    const undone = await labelBox(page, second)
    check(close(undone.x, dragFrom.x) && close(undone.y, dragFrom.y), `One Undo did not return the whole drag: (${undone.x}, ${undone.y}) vs (${dragFrom.x}, ${dragFrom.y})`)
    check(JSON.stringify(await graph(page)) === JSON.stringify(graphBefore), 'Undo of the drag also changed the graph')
    await page.click('#editor-redo-btn')
    await settle(page)
    const redone = await labelBox(page, second)
    check(close(redone.x, dragged.x) && close(redone.y, dragged.y), 'One Redo did not restore the dragged position')
    pass('undo_redo', 'a 12-move drag is one Undo step (back to its start, graph intact) and one Redo step')

    console.log('\n--- Reload restoration ---')
    await page.waitForFunction((key: string, id: string, x: number) => {
      const card = JSON.parse(localStorage.getItem(key)!).editor.cards.find((c: any) => c.id === id)
      return card && card.position.x !== x
    }, {}, CHECKPOINT_KEY, second, savedBeforeDrag.x)
    // The camera save is debounced; wait until it holds the zoom on screen.
    await page.waitForFunction((label: string) => {
      const camera = JSON.parse(localStorage.getItem('gurow:camera:fixture-user:lp-rust-graphics-mvp') ?? 'null')
      return camera && `${Math.round(camera.zoom * 100)}%` === label
    }, {}, zoomed)
    const sceneBefore = await labels(page)
    await page.reload({ waitUntil: 'networkidle0' })
    await waitForLabels(page, sceneBefore)
    check(await zoomLabel(page) === zoomed, 'Camera zoom not restored')
    check(await page.$eval('#editor-undo-btn', b => (b as HTMLButtonElement).disabled), 'Undo history survived reload')
    await select(page, first)
    check(JSON.stringify(await graph(page)) === JSON.stringify(graphBefore), 'Graph differs after reload')
    check(await page.$eval(`#task-edit-title-${firstTask}`, el => (el as HTMLInputElement).value) === firstTitle, 'New Skill Task title lost on reload')
    check(await page.$eval(`#task-edit-required-${firstTask}`, el => (el as HTMLInputElement).checked) === false, 'Required toggle lost on reload')
    pass('reload', `${sceneBefore.length} labels (ids, titles, geometry), camera ${zoomed}, ${graphBefore.length} edges and Task edits restored in a new engine`)

    console.log('\n--- Renderer failure and recovery ---')
    // Hold the automatic attempt, then fail it, so the retry UI is exercised.
    await page.evaluate(() => {
      const scope = window as any
      scope.__origRequestAdapter = navigator.gpu.requestAdapter
      scope.__recoveryRequests = 0
      navigator.gpu.requestAdapter = async () => {
        scope.__recoveryRequests++
        return new Promise(resolve => { scope.__finishRecoveryAttempt = () => resolve(null) })
      }
      scope.__gurowActiveDevice.destroy()
    })
    await page.waitForSelector('#editor-gpu-error-notice')
    await page.waitForFunction(() => (window as any).__recoveryRequests === 1)
    // The document stays usable through the list while the renderer is down.
    await keyboardSelect(page, second)
    const failureTitle = 'T06 flow: edited while renderer failed'
    await setTaskTitle(page, secondTask, failureTitle)
    await savedTask(page, secondTask, failureTitle)
    await closeEditorPanels(page)
    await page.click('#btn-retry-renderer')
    await settle(page)
    check(await page.evaluate(() => (window as any).__recoveryRequests) === 1, 'Retry overlapped the pending automatic attempt')
    await page.evaluate(() => (window as any).__finishRecoveryAttempt())
    await page.waitForSelector('#recovery-error-banner')
    check(await page.$('#btn-retry-renderer'), 'Retry button missing after unsuccessful recovery')
    await page.evaluate(() => { navigator.gpu.requestAdapter = (window as any).__origRequestAdapter })
    await closeEditorPanels(page)
    await page.click('#btn-retry-renderer')
    await page.waitForFunction(() => !document.querySelector('#editor-gpu-error-notice') &&
      (document.querySelector('#gpu-status-badge') as HTMLElement | null)?.dataset.status === 'ready', { timeout: 15000 })
    await waitForLabels(page, sceneBefore)
    await select(page, first)
    check(JSON.stringify(await graph(page)) === JSON.stringify(graphBefore), 'Graph lost across renderer recovery')
    check(await page.$eval(`#task-edit-title-${firstTask}`, el => (el as HTMLInputElement).value) === firstTitle, 'Task edit lost across renderer recovery')
    await select(page, second)
    check(await page.$eval(`#task-edit-title-${secondTask}`, el => (el as HTMLInputElement).value) === failureTitle, 'Task edited during failure lost')
    await closeEditorPanels(page)
    const dragTarget = await labelBox(page, second)
    const pixels = await canvasCardPixels(page, dragTarget)
    check(pixels >= 100, `Recovered canvas did not draw the dragged card (${pixels} card pixels)`)
    // Negative control: empty canvas away from every card (a connection curve may cross it).
    const empty = await emptyPoint(page)
    check(empty, 'No empty canvas point for the pixel control')
    const origin = await page.$eval('#editor-canvas', el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y } })
    const emptyControlPixels = await canvasCardPixels(page, { x: empty.x - origin.x - 32, y: empty.y - origin.y - 32, width: 64, height: 64 })
    check(emptyControlPixels * 10 < pixels, `Empty canvas shows as many card pixels (${emptyControlPixels}) as the card (${pixels})`)
    pass('device_loss_recovery_retry', `device loss → failed automatic attempt → retry banner → Retry succeeds; scene, graph and Task edits (incl. one during failure) kept; canvas draws ${second} at its dragged position (${pixels} card px; empty control ${emptyControlPixels})`)
    await page.close()

    console.log('\n--- No-WebGPU keyboard/list path ---')
    // Same browser context, so the document this flow saved is the one loaded.
    const noGpu = await browser.newPage()
    noGpu.setDefaultTimeout(10000)
    noGpu.on('pageerror', error => pageErrors.push(String(error)))
    await noGpu.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })
    await noGpu.evaluateOnNewDocument(() => {
      Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true })
    })
    await noGpu.goto(`${URL}/editor`, { waitUntil: 'networkidle0' })
    await noGpu.waitForSelector('#editor-gpu-notice')
    await openSkillList(noGpu)
    const note = await noGpu.$eval('#list-positioning-note', el => el.textContent ?? '')
    check(note.includes('Card positioning remains a canvas operation'), `Positioning note missing: ${note}`)
    const listed = await noGpu.$$eval('#skill-prerequisite-list [role="option"]', els => els.map(el => el.id.replace('skill-list-item-', '')))
    check(listed.includes(first) && listed.includes(second), 'No-WebGPU list is missing the Skills created in this flow')
    await keyboardSelect(noGpu, first)
    check(await noGpu.$eval(`#task-edit-title-${firstTask}`, el => (el as HTMLInputElement).value) === firstTitle, 'No-WebGPU path lost the new Skill Task edit')
    await keyboardSelect(noGpu, second)
    check(await noGpu.$eval(`#task-edit-title-${secondTask}`, el => (el as HTMLInputElement).value) === failureTitle, 'No-WebGPU path lost a Task edit')
    await openSkillList(noGpu)
    const prereqs = await noGpu.$eval(`#skill-list-item-${second}`, el => el.textContent ?? '')
    check(prereqs.includes(`Requires: ${firstLabel}`), `No-WebGPU list lost the ${first} → ${second} connection: ${prereqs}`)
    await keyboardSelect(noGpu, second)
    const noGpuTitle = 'T06 flow: edited without WebGPU'
    await setTaskTitle(noGpu, secondTask, noGpuTitle)
    await savedTask(noGpu, secondTask, noGpuTitle)
    pass('keyboard_list_no_webgpu', `without navigator.gpu the list shows ${listed.length} Skills incl. both new ones and their prerequisite; keyboard selects ${second}, edits its Task and saves`)

    check(pageErrors.length === 0, `Unhandled page errors: ${pageErrors.join('; ')}`)
    console.log(`\n✅ T06 functional flow passed (${steps.length} steps: ${steps.join(', ')})`)
  } finally {
    await browser.close()
    server.kill()
  }
}

main().catch(error => {
  console.error('\n❌ T06 functional flow failed:', error)
  process.exit(1)
})
