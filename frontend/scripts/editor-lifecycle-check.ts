/** Real React/Wasm browser regression; software GPU is functional evidence only.
 * Run from frontend: bun run scripts/editor-lifecycle-check.ts
 * Requires built src/pkg Wasm and Chromium (CHROME_BIN / PUPPETEER_EXECUTABLE_PATH).
 * Dedicated Vite fixture server: no production routes or test engine exports.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { BenchmarkHooks } from '../src/components/editor/benchmarkHooks'

declare global {
  interface Window {
    __gurowBenchmarkHooks: BenchmarkHooks
    __labelFrames: { now: number; commit: number | null }[]
  }
}
const root = fileURLToPath(new URL('..', import.meta.url))
const server = await createServer({
  root, configFile: false, plugins: [react(), tailwindcss()],
  cacheDir: fileURLToPath(new URL('../../.harness/editor-lifecycle-vite', import.meta.url)),
  server: { host: '127.0.0.1', port: Number(process.env.LIFECYCLE_PORT ?? 3471), strictPort: true },
})
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined
const failures: string[] = []
try {
  await server.listen()
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH ?? process.env.CHROME_BIN ?? execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim()
  browser = await puppeteer.launch({ executablePath, headless: true,
    userDataDir: fileURLToPath(new URL('../../.harness/editor-lifecycle-chromium', import.meta.url)), args: [
    '--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader',
    '--enable-features=Vulkan', '--disable-vulkan-surface', '--disable-dev-shm-usage',
  ] })
  for (const backend of ['software-webgpu', 'unsupported'] as const) {
    for (const arrival of ['before', 'during', 'after'] as const) {
      const name = `${backend}/${arrival}`
      const page = await browser.newPage()
      page.setDefaultTimeout(20_000)
      const errors: string[] = []
      page.on('pageerror', error => errors.push(String(error)))
      try {
        await page.setViewport({ width: 1000, height: 800 })
        await page.evaluateOnNewDocument((unsupported) => {
          if (unsupported) Object.defineProperty(navigator, 'gpu', { value: undefined })
          window.__gurowBenchmarkHooks = {
            enabled: true, app_delay_ms: 0, label_delay_ms: 0, app_revision: 0,
            canvas_revision: 0, label_revision: 0, pending_inputs: [], dispatches: [],
            label_commits: [], clock_syncs: [], active_scenario: null,
            app_delays_applied: 0, label_delays_applied: 0,
          }
          window.__labelFrames = []
          new MutationObserver(records => {
            if (!records.some(r => (r.target as Element).closest?.('#labels-overlay'))) return
            requestAnimationFrame(() => window.__labelFrames.push({
              now: performance.now(), commit: window.__gurowBenchmarkHooks.label_commits.at(-1)?.commit_ms ?? null,
            }))
          }).observe(document, { subtree: true, attributes: true, childList: true })
        }, backend === 'unsupported')
        // Hold the real Wasm network resource, not a mocked module/engine.
        await page.setRequestInterception(true)
        let release!: () => void
        let observed!: () => void
        const blocked = new Promise<void>(resolve => { observed = resolve })
        const gate = new Promise<void>(resolve => { release = resolve })
        page.on('request', async request => {
          if (new URL(request.url()).pathname.endsWith('.wasm')) { observed(); await gate }
          await request.continue()
        })
        await page.goto(`${server.resolvedUrls!.local[0]}scripts/fixtures/editor-lifecycle.html?arrival=${arrival}`, { waitUntil: 'domcontentloaded' })
        await Promise.race([blocked, new Promise((_, reject) => setTimeout(() => reject(new Error('Wasm request not observed')), 20_000))])
        await page.waitForSelector('#editor-canvas')
        await page.click('#editor-canvas')
        await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
        assert.equal(await page.evaluate(() => window.__gurowBenchmarkHooks.dispatches.length), 0, 'early input must not dispatch into an uninitialized engine')
        if (arrival === 'during') await page.click('#deliver')
        release()
        await page.waitForFunction(() => document.querySelector('#status')?.textContent !== 'initializing')
        assert.equal(await page.$eval('#status', el => el.textContent), backend === 'unsupported' ? 'unsupported' : 'ready')
        if (arrival === 'after') await page.click('#deliver')
        await page.waitForSelector('#card-label-lifecycle-skill')
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        const expectedLoads = arrival === 'after' ? 2 : 1
        const loads = () => page.evaluate(() => window.__gurowBenchmarkHooks.dispatches.filter(d => d.command_type === 'LoadDocument').length)
        assert.equal(await loads(), expectedLoads, 'each document identity must load once into this engine')
        // Rendered position relative to the overlay: labels sit at world bounds
        // inside the camera-transformed container, so style.left is world space.
        const renderedPosition = () => {
          const label = document.querySelector('#card-label-lifecycle-skill')!.getBoundingClientRect()
          const overlay = document.querySelector('#labels-overlay')!.getBoundingClientRect()
          return { x: Math.round((label.x - overlay.x) * 1000) / 1000, y: Math.round((label.y - overlay.y) * 1000) / 1000 }
        }
        await page.evaluate(`window.__renderedLabelPosition = ${renderedPosition.toString()}`)
        const position = () => page.evaluate(() => (window as any).__renderedLabelPosition() as { x: number; y: number })
        assert.deepEqual(await position(), { x: 120, y: 130 }, 'camera restoration must follow viewport setup in every backend')
        if (backend === 'software-webgpu') {
          const original = await position()
          const rect = await page.$eval('#card-label-lifecycle-skill', el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y } })
          await page.mouse.move(rect.x + 40, rect.y + 40); await page.mouse.down()
          await page.mouse.move(rect.x + 100, rect.y + 80, { steps: 4 }); await page.mouse.up()
          await page.waitForFunction(x => (window as any).__renderedLabelPosition().x !== x, {}, original.x)
          await page.click('#rerender')
          assert.equal(await loads(), expectedLoads, 'same props must not erase user history')
          await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
          await page.waitForFunction(({ x, y }) => {
            const p = (window as any).__renderedLabelPosition()
            return p.x === x && p.y === y
          }, {}, original)
          await page.click('#observe-camera')
          await page.evaluate(() => { window.__gurowBenchmarkHooks.label_delay_ms = 80; window.__labelFrames = [] })
          await page.mouse.move(700, 500); await page.mouse.wheel({ deltaY: 12 })
          await page.waitForFunction(() => window.__gurowBenchmarkHooks.label_commits.some(c => c.commit_duration_ms >= 80))
          await page.waitForFunction(() => window.__labelFrames.length > 0)
          const timing = await page.evaluate(() => ({
            commit: window.__gurowBenchmarkHooks.label_commits.at(-1)!,
            dispatch: window.__gurowBenchmarkHooks.dispatches.filter(d => d.command_type === 'PanCamera').at(-1)!,
            frame: window.__labelFrames.at(-1)!,
            latestDispatch: window.__gurowBenchmarkHooks.dispatches.at(-1)!,
          }))
          assert.ok(timing.commit.commit_ms >= timing.dispatch.input_origin_ms! + 80, 'commit_ms must record completion AFTER the 80ms delay')
          assert.equal(timing.dispatch.label_commit_ms, timing.commit.commit_ms)
          assert.equal(timing.commit.app_revision, timing.dispatch.app_revision, 'commit must identify rendered label state, not later global revisions')
          assert.equal(timing.latestDispatch.command_type, 'ExportSnapshot')
          assert.ok(timing.latestDispatch.app_revision > timing.commit.app_revision)
          assert.equal(timing.latestDispatch.label_commit_ms, null, 'a later non-label dispatch cannot borrow an older geometry commit')
          assert.ok(timing.frame.commit !== null && timing.frame.now >= timing.commit.commit_ms, 'layout commit must finish before the next observed rAF opportunity (not presentation proof)')
          await page.evaluate(() => { window.__gurowBenchmarkHooks.label_delay_ms = 0 })
        }
        await page.click('#remount')
        await page.waitForFunction(count => window.__gurowBenchmarkHooks.dispatches.filter(d => d.command_type === 'LoadDocument').length === count, {}, expectedLoads + 1)
        await page.waitForSelector('#card-label-lifecycle-skill')
        assert.deepEqual(await position(), { x: 120, y: 130 }, 'new engine must receive same document identity')
        assert.deepEqual(errors, [])
        console.log(`PASS ${name}: early input, load identity, camera, remount${backend === 'software-webgpu' ? ', drag/undo and 80ms pre-paint completion' : ''}`)
      } catch (error) {
        failures.push(`${name}: ${String(error)}`)
        console.error(`FAIL ${failures.at(-1)}`)
      } finally { await page.close() }
    }
  }
} finally {
  await browser?.close()
  await server.close()
}
assert.deepEqual(failures, [], 'lifecycle regressions')
console.log('Functional diagnostic only: headless SwiftShader / no-GPU fallback; no hardware presentation or performance qualification claimed.')
