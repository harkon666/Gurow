/** Genuine WebGPU validation faults through the real React/Wasm recovery path.
 * Headless SwiftShader is functional evidence, not P1/platform qualification.
 * Run: cd frontend && bun run scripts/gpu-error-check.ts (requires built src/pkg).
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Optional fixed-baseline replay loads only the old hook, without overwriting
// another worker's files or rebuilding production output.
const baseline = process.env.GPU_ERROR_BASELINE
const baselineHook = baseline ? execFileSync('git', ['show', `${baseline}:frontend/src/components/editor/useWasmEditor.ts`], {
  cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8',
}) : null
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)), configFile: false,
  plugins: [{ name: 'gpu-error-baseline', enforce: 'pre', load(id) {
    if (baselineHook && id.endsWith('/src/components/editor/useWasmEditor.ts')) return baselineHook
  }, configureServer(vite) {
    vite.middlewares.use('/gpu-prerequisite', (_request, response) => {
      response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>GPU prerequisite</title>')
    })
  } }, react(), tailwindcss()],
  cacheDir: fileURLToPath(new URL('../../.harness/gpu-error-vite', import.meta.url)),
  server: { host: '127.0.0.1', port: Number(process.env.GPU_ERROR_PORT ?? 3473), strictPort: true },
})
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined
async function checkDeviceOwnership(browser: Awaited<ReturnType<typeof puppeteer.launch>>) {
  for (const pendingReplacement of [false, true]) {
    const page = await browser.newPage()
    page.setDefaultTimeout(15_000)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(String(error)))
    try {
      await page.setViewport({ width: 1000, height: 800 })
      await page.evaluateOnNewDocument((pending) => {
        const scope = window as any
        scope.__raceDevices = []; scope.__releaseDevice = []; scope.__raceLost = []
        let requests = 0
        const request = (window as any).GPUAdapter.prototype.requestDevice
        ;(window as any).GPUAdapter.prototype.requestDevice = async function (...args: any[]) {
          const index = requests++
          const device = await request.apply(this, args)
          scope.__raceDevices[index] = device
          device.lost.then(() => { scope.__raceLost[index] = true })
          if (index === 0 || (pending && index === 1)) {
            await new Promise<void>(resolve => { scope.__releaseDevice[index] = resolve })
          }
          return device
        }
      }, pendingReplacement)
      const base = server.resolvedUrls!.local[0]
      await page.goto(`${base}gpu-prerequisite`, { waitUntil: 'networkidle0' })
      await page.evaluate(async () => { await navigator.gpu.requestAdapter() })
      await page.goto(`${base}scripts/fixtures/editor-lifecycle.html?arrival=before`, { waitUntil: 'networkidle0' })
      await page.waitForFunction(() => typeof (window as any).__releaseDevice[0] === 'function')
      await page.click('#remount')
      if (pendingReplacement) {
        await page.waitForFunction(() => typeof (window as any).__releaseDevice[1] === 'function')
        await page.evaluate(() => (window as any).__releaseDevice[0]())
        await new Promise(resolve => setTimeout(resolve, 250))
        assert.ok(await page.evaluate(() => (window as any).__gurowActiveDevice !== (window as any).__raceDevices[0]), 'stale completion must not be adopted during newer setup')
        await page.evaluate(() => (window as any).__releaseDevice[1]())
      }
      await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'ready')
      assert.ok(await page.evaluate(() => (window as any).__gurowActiveDevice === (window as any).__raceDevices[1]), 'replacement device must own the editor')
      if (!pendingReplacement) await page.evaluate(() => (window as any).__releaseDevice[0]())
      await new Promise(resolve => setTimeout(resolve, 300))
      assert.ok(await page.evaluate(() => !(window as any).__raceLost[1]), 'stale requestDevice completion must not destroy the healthy replacement')
      assert.ok(await page.evaluate(() => (window as any).__gurowActiveDevice === (window as any).__raceDevices[1]), 'stale completion must not replace active device identity')
      // Unowned requests use a genuine adapter/device, but cannot adopt/destroy
      // the editor's device or acquire its initialization error scopes.
      await page.evaluate(async () => {
        const scope = window as any
        const adapter = await navigator.gpu.requestAdapter()
        if (!adapter) throw new Error('Unrelated WebGPU adapter unavailable')
        scope.__unrelatedDevice = await adapter.requestDevice()
      })
      assert.ok(await page.evaluate(() => !(window as any).__raceLost[1] && (window as any).__gurowActiveDevice === (window as any).__raceDevices[1]), 'unrelated requestDevice must not retire the app device')
      await page.evaluate(() => (window as any).__unrelatedDevice.destroy())
      // Device loss must still be observed after the race (checking cannot stay
      // stuck true). Automatic recovery must attach a new healthy renderer.
      await page.evaluate(() => (window as any).__raceDevices[1].destroy())
      await page.waitForFunction(() => (window as any).__gurowActiveDevice && (window as any).__gurowActiveDevice !== (window as any).__raceDevices[1] && document.querySelector('#status')?.textContent === 'ready')
      await page.waitForSelector('#card-label-lifecycle-skill')
      assert.deepEqual(errors, [])
      console.log(`PASS device ownership: stale completion ${pendingReplacement ? 'during setup' : 'after ready'}, unrelated device isolation, real loss recovery`)
    } finally { await page.close() }
  }
}
try {
  await server.listen()
  browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH ?? process.env.CHROME_BIN ?? execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(),
    userDataDir: fileURLToPath(new URL('../../.harness/gpu-error-chromium', import.meta.url)),
    headless: true, dumpio: process.env.GPU_ERROR_DEBUG === '1', args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--enable-features=Vulkan', '--disable-vulkan-surface', '--disable-dev-shm-usage'],
  })
  if (!process.argv.includes('--ownership-only')) {
  const page = await browser.newPage()
  page.setDefaultTimeout(15_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(String(error)))
  page.on('console', msg => { if (/validation|Renderer|WebGPU/.test(msg.text())) console.log(`[browser] ${msg.text()}`) })
  await page.setViewport({ width: 1280, height: 800 })
  await page.evaluateOnNewDocument(() => {
    const scope = window as any
    scope.__devices = []
    scope.__fault = false
    scope.__validationErrors = 0
    const request = (window as any).GPUAdapter.prototype.requestDevice
    ;(window as any).GPUAdapter.prototype.requestDevice = async function (...args: any[]) {
      const device = await request.apply(this, args)
      scope.__devices.push(device)
      device.addEventListener('uncapturederror', () => scope.__validationErrors++)
      if (scope.__loseNewDevices) device.destroy()
      return device
    }
    const current = (window as any).GPUCanvasContext.prototype.getCurrentTexture
    ;(window as any).GPUCanvasContext.prototype.getCurrentTexture = function () {
      const texture = current.call(this)
      if (scope.__fault) texture.destroy()
      return texture
    }
  })
  const url = `${server.resolvedUrls!.local[0]}scripts/fixtures/gpu-error.html`
  // Chromium on this host may return null during first GPU-process startup.
  // Establish the adapter prerequisite before mounting the editor under test.
  await page.goto(`${server.resolvedUrls!.local[0]}gpu-prerequisite`, { waitUntil: 'networkidle0' })
  await page.evaluate(async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      if (await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })) return
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    throw new Error('WebGPU adapter unavailable before regression')
  })
  await page.goto(url, { waitUntil: 'networkidle0' })
  await page.waitForFunction(() => ['ready', 'error'].includes(document.querySelector('#status')?.textContent ?? ''))
  if (await page.$eval('#status', el => el.textContent) !== 'ready') {
    console.error('Adapter prerequisite diagnostics:', await page.evaluate(async () => {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
      return { adapter: adapter ? adapter.info : null, devices: (window as any).__devices.length }
    }))
  }
  assert.equal(await page.$eval('#status', el => el.textContent), 'ready', 'regression prerequisite: software WebGPU must initialize')
  const snapshot = async () => { await page.click('#snapshot'); return JSON.parse(await page.$eval('#document', el => el.textContent!)) }
  const original = await snapshot()
  const rect = await page.$eval('#card-label-skill-rust-basics', el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y } })
  await page.mouse.move(rect.x + 40, rect.y + 40); await page.mouse.down()
  await page.mouse.move(rect.x + 100, rect.y + 80, { steps: 4 }); await page.mouse.up()
  const moved = await snapshot()
  assert.notDeepEqual(moved.cards[0].position, original.cards[0].position)
  // The Skill list is a temporary panel since UX01 (#47): open it, then use the keyboard.
  const openList = async () => {
    await page.click('#btn-skill-list'); await page.waitForSelector('#skill-prerequisite-list'); await page.focus('#skill-prerequisite-list')
  }
  await openList(); await page.keyboard.press('Home'); await page.keyboard.press('Enter')
  await page.type('#task-draft', 'unsaved task draft survives GPU failure')
  // No subsequent editor input: genuine uncaptured validation arrives asynchronously.
  // Recovery is forced to fail on its first render with a destroyed canvas texture.
  await page.evaluate(async () => {
    const scope = window as any
    scope.__fault = true
    const device = scope.__devices.at(-1)
    device.createBuffer({ label: 'issue-43-genuine-validation', size: 4, usage: 129 })
    // Flush the test operation; no application command/input follows it.
    await device.queue.onSubmittedWorkDone()
  })
  await page.waitForFunction(() => (window as any).__validationErrors > 0, { timeout: 5000 })
  console.log('Observed genuine GPU validation error; waiting for recovery UI')
  await page.waitForSelector('#editor-gpu-error-notice', { timeout: 5000 })
  await page.waitForSelector('#recovery-error-banner')
  assert.ok(await page.evaluate(() => (window as any).__validationErrors > 0), 'browser must produce a real uncaptured GPU error')
  assert.equal(await page.$eval('#status', el => el.textContent), 'error')
  assert.ok(await page.evaluate(() => (window as any).__gpuEvents.some((event: any) =>
    event.type === 'GpuError' && event.message.includes('MapRead|Storage'))), 'real uncaptured validation must emit serialized EditorEvent::GpuError')
  const count = await page.evaluate(() => (window as any).__devices.length)
  assert.equal(count, 2, 'one automatic recovery, not duplicate captures')
  await new Promise(resolve => setTimeout(resolve, 700))
  assert.equal(await page.evaluate(() => (window as any).__devices.length), count, 'repeated validation failure must not loop')
  assert.deepEqual(await snapshot(), moved, 'CPU positions and connections survive failed recovery')
  await openList(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter')
  assert.equal(await page.$eval('#selected', el => el.textContent), 'skill-ownership')
  await openList(); await page.keyboard.press('Home'); await page.keyboard.press('Enter')
  assert.equal(await page.$eval('#task-draft', el => (el as HTMLInputElement).value), 'unsaved task draft survives GPU failure')
  await page.click('#btn-retry-renderer')
  await page.waitForFunction(n => (window as any).__devices.length === n, {}, count + 1)
  await page.waitForFunction(() => !(document.querySelector('#btn-retry-renderer') as HTMLButtonElement)?.disabled)
  assert.equal(await page.$eval('#status', el => el.textContent), 'error', 'failing explicit retry must not advertise ready')
  await new Promise(resolve => setTimeout(resolve, 700))
  assert.equal(await page.evaluate(() => (window as any).__devices.length), count + 1)
  await page.evaluate(() => { (window as any).__fault = false })
  await page.click('#btn-retry-renderer')
  await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'ready')
  assert.deepEqual(await snapshot(), moved)
  await page.click('#editor-undo-btn')
  assert.deepEqual(await snapshot(), original, 'undo history survives renderer replacements')
  await page.click('#editor-redo-btn')
  assert.deepEqual(await snapshot(), moved, 'redo history survives renderer replacements')
  // API activity on a retired device must not affect the current UI. Production
  // retirement destroys its allocations and ignores its eventual lost promise.
  const beforeStale = await page.evaluate(() => (window as any).__devices.length)
  await page.evaluate(() => (window as any).__devices[0].createBuffer({ label: 'retired-validation', size: 4, usage: 129 }))
  await new Promise(resolve => setTimeout(resolve, 500))
  assert.equal(await page.$eval('#status', el => el.textContent), 'ready')
  assert.equal(await page.evaluate(() => (window as any).__devices.length), beforeStale)
  console.log('PASS async genuine validation: GpuError, bounded automatic/explicit failed recovery, list/Task draft, positions/connections/history, successful retry, retired errors ignored')
  // A fresh user command has rearmed automatic recovery. Its replacement now
  // loses the real device before attachment: this must also remain bounded.
  await page.evaluate(() => { const scope = window as any; scope.__loseNewDevices = true; scope.__devices.at(-1).destroy() })
  await page.waitForSelector('#recovery-error-banner')
  await page.waitForFunction(() => !(document.querySelector('#btn-retry-renderer') as HTMLButtonElement)?.disabled)
  const lostCount = await page.evaluate(() => (window as any).__devices.length)
  assert.equal(lostCount, beforeStale + 1, 'one automatic attempt on device loss')
  await new Promise(resolve => setTimeout(resolve, 500))
  assert.equal(await page.evaluate(() => (window as any).__devices.length), lostCount, 'repeated device loss must not loop')
  await page.evaluate(() => { (window as any).__loseNewDevices = false })
  await page.click('#btn-retry-renderer')
  await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'ready')
  assert.deepEqual(await snapshot(), moved)
  console.log('PASS genuine repeated device loss: bounded failed replacement and successful explicit retry')
  // First-create errors must not be overwritten by ready after async initialization.
  await page.evaluateOnNewDocument(() => { (window as any).__fault = true })
  await page.goto(url, { waitUntil: 'networkidle0' })
  await page.waitForSelector('#editor-gpu-error-notice')
  assert.equal(await page.$eval('#status', el => el.textContent), 'error')
  assert.ok(!JSON.parse(await page.$eval('#statuses', el => el.textContent!)).includes('ready'))
  assert.ok(await page.evaluate(() => (window as any).__gpuEvents.some((event: any) => event.type === 'GpuError' && /Destroyed texture/.test(event.message))))
  assert.equal((await snapshot()).cards.length, 2, 'initial render failure retains CPU document')
  await page.evaluate(() => { (window as any).__fault = false })
  await page.click('#btn-retry-renderer')
  await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'ready')
  assert.deepEqual(errors, [], 'no uncaught JS/Wasm exceptions')
  console.log('PASS initial invalid current texture: never ready, CPU document/list preserved, explicit retry succeeds')
  await page.close()
  }
  await checkDeviceOwnership(browser)
} finally {
  await browser?.close()
  await server.close()
}
