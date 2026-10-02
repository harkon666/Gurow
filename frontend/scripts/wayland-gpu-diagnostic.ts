#!/usr/bin/env bun
/** Opt-in headed #43 diagnosis; never a P1 performance/acceptance capture.
 * Uses the existing production build. Captures browser-only compositor crops.
 */
import puppeteer from 'puppeteer-core'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createServer } from 'node:http'
import { resolveChromiumExecutable, waitForServerReady, computeBuildHash } from './benchmark/browser'

const root = path.resolve(import.meta.dir, '../..')
const out = path.resolve(process.env.GPU_DIAGNOSTIC_OUT ?? path.join(root, '.harness/t43/platform'))
mkdirSync(out, { recursive: true })
const port = Number(process.env.GPU_DIAGNOSTIC_PORT ?? 3483)
// Separate secure localhost origin: no app, Wasm or global device observers.
const rawServer = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' })
  response.end('<!doctype html><html><title>Raw WebGPU diagnosis</title><body></body></html>')
})
await new Promise<void>((resolve, reject) => {
  rawServer.once('error', reject)
  rawServer.listen(port + 1, '127.0.0.1', resolve)
})
// Spawn only after the raw probe port is acquired; startup failure cannot orphan it.
const server = spawn('node', ['.output/server/index.mjs'], { cwd: path.join(root, 'frontend'), env: { ...process.env, PORT: String(port) }, stdio: 'ignore' })
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const variants: Array<{
  name: string
  platform: 'wayland' | 'x11'
  config: Partial<Pick<GPUCanvasConfiguration, 'format' | 'alphaMode'>>
  vulkanAngle?: boolean
}> = [
  { name: 'wayland-default', platform: 'wayland', config: {} },
  { name: 'wayland-rgba', platform: 'wayland', config: { format: 'rgba8unorm' } },
  { name: 'wayland-bgra', platform: 'wayland', config: { format: 'bgra8unorm' } },
  { name: 'wayland-premultiplied', platform: 'wayland', config: { alphaMode: 'premultiplied' } },
  { name: 'xwayland-gl', platform: 'x11', config: {} },
  { name: 'xwayland-vulkan', platform: 'x11', config: {}, vulkanAngle: true },
  { name: 'wayland-vulkan', platform: 'wayland', config: {}, vulkanAngle: true },
]
const selected = process.argv.slice(2)
const results: unknown[] = []
try {
  await waitForServerReady(`http://127.0.0.1:${port}`)
  for (const variant of variants.filter(v => !selected.length || selected.includes(v.name))) {
    const flags = ['--no-sandbox', '--enable-unsafe-webgpu', '--disable-dev-shm-usage',
      ...('vulkanAngle' in variant && variant.vulkanAngle ? ['--enable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE', '--use-angle=vulkan'] : ['--enable-features=Vulkan', '--use-gl=angle']),
      `--ozone-platform=${variant.platform}`]
    const browser = await puppeteer.launch({ executablePath: resolveChromiumExecutable(), headless: false, defaultViewport: null,
      // Puppeteer removes feature flags from options.args while merging defaults.
      // Preserve the requested list and also record the actual child process args.
      userDataDir: path.join(out, `profile-${variant.name}`), args: [...flags], env: { ...process.env, GDK_SCALE: '1' } })
    const consoleLog: string[] = []
    try {
      const actualLaunchArgs = browser.process()?.spawnargs
      if (!actualLaunchArgs) throw new Error('Actual Chromium launch arguments unavailable')
      const featurePrefix = '--enable-features='
      const requestedFeatures = flags.filter(arg => arg.startsWith(featurePrefix)).flatMap(arg => arg.slice(featurePrefix.length).split(','))
      const actualFeatures = actualLaunchArgs.filter(arg => arg.startsWith(featurePrefix)).flatMap(arg => arg.slice(featurePrefix.length).split(','))
      if (!requestedFeatures.length || !requestedFeatures.every(feature => actualFeatures.includes(feature))) {
        throw new Error('Requested feature flags absent from recorded or actual Chromium launch arguments')
      }
      const page = await browser.newPage()
      page.on('console', msg => consoleLog.push(`${msg.type()}: ${msg.text()}`))
      page.on('pageerror', error => consoleLog.push(`pageerror: ${String(error)}`))
      await page.evaluateOnNewDocument((override) => {
        const w = window as any
        w.__gpuDiagnosis = { configs: [], errors: [], adapters: [] }
        const originalConfigure = GPUCanvasContext.prototype.configure
        GPUCanvasContext.prototype.configure = function (configuration: GPUCanvasConfiguration) {
          const cfg = { ...configuration, ...override }
          w.__gpuDiagnosis.configs.push({ format: cfg.format, alphaMode: cfg.alphaMode, usage: cfg.usage, viewFormats: cfg.viewFormats, width: this.canvas.width, height: this.canvas.height })
          return originalConfigure.call(this, cfg)
        }
        const request = navigator.gpu.requestAdapter.bind(navigator.gpu)
        navigator.gpu.requestAdapter = async options => {
          const adapter = await request(options)
          if (adapter) {
            w.__gpuDiagnosis.adapters.push({ ...JSON.parse(JSON.stringify(adapter.info)), vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description })
            const requestDevice = adapter.requestDevice.bind(adapter)
            adapter.requestDevice = async descriptor => {
              const device = await requestDevice(descriptor)
              device.addEventListener('uncapturederror', event => w.__gpuDiagnosis.errors.push(event.error.message))
              return device
            }
          }
          return adapter
        }
      }, variant.config)
      await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle0' })
      await page.waitForSelector('#editor-canvas')
      await page.keyboard.press('F11')
      await wait(1800)
      const state = await page.evaluate(() => ({ ...(window as any).__gpuDiagnosis,
        badge: document.querySelector('#gpu-status-badge')?.textContent,
        notice: document.querySelector('#editor-gpu-error-notice')?.textContent,
        labels: document.querySelectorAll('[id^="card-label-"]').length,
        canvas: (() => { const c = document.querySelector('#editor-canvas') as HTMLCanvasElement; const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, backingWidth: c.width, backingHeight: c.height, dpr: devicePixelRatio } })() }))
      await page.screenshot({ path: path.join(out, `${variant.name}-cdp.png`) })
      const clients = JSON.parse(execFileSync('hyprctl', ['clients', '-j'], { encoding: 'utf8' }))
      const client = clients.find((c: any) => c.pid === browser.process()?.pid)
      let compositorCapture: string | null = null
      if (client) {
        compositorCapture = path.join(out, `${variant.name}-screen.png`)
        execFileSync('grim', ['-g', `${client.at[0]},${client.at[1]} ${client.size[0]}x${client.size[1]}`, compositorCapture])
      }
      // Exercise the real production keyboard/list boundary on this GPU host.
      await page.focus('#skill-prerequisite-list')
      await page.keyboard.press('Home'); await page.keyboard.press('Enter')
      const firstSkill = await page.$eval('#selected-skill-id', el => el.textContent)
      await page.keyboard.press('End'); await page.keyboard.press('Enter')
      const lastSkill = await page.$eval('#selected-skill-id', el => el.textContent)
      if (!firstSkill || !lastSkill || firstSkill === lastSkill) throw new Error('Keyboard Skill navigation did not change selection')
      const navigation = { firstSkill, lastSkill, tasksAvailable: !!(await page.$('#associated-tasks-list')) }
      if (!navigation.tasksAvailable) throw new Error('Keyboard selection did not open associated Tasks')
      let retry = null
      if (state.notice) {
        await page.focus('#btn-retry-renderer'); await page.keyboard.press('Enter')
        await wait(1200)
        retry = await page.evaluate(() => ({
          notice: document.querySelector('#editor-gpu-error-notice')?.textContent,
          retryEnabled: !(document.querySelector('#btn-retry-renderer') as HTMLButtonElement)?.disabled,
          selectedSkill: document.querySelector('#selected-skill-id')?.textContent,
          labels: document.querySelectorAll('[id^="card-label-"]').length,
          deviceCount: (window as any).__gpuDiagnosis.adapters.length,
        }))
        if (!retry.notice || !retry.retryEnabled || retry.selectedSkill !== lastSkill || retry.labels !== state.labels) {
          throw new Error('Native failed retry did not retain document/list and another retry')
        }
        if (client) execFileSync('grim', ['-g', `${client.at[0]},${client.at[1]} ${client.size[0]}x${client.size[1]}`, path.join(out, `${variant.name}-recovery-screen.png`)])
      }
      // Independently exercise raw WebGPU, without wgpu or editor pipelines.
      const rawPage = await browser.newPage()
      await rawPage.goto(`http://127.0.0.1:${port + 1}`)
      const raw = await rawPage.evaluate(async () => {
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
        if (!adapter) return { error: 'No adapter' }
        const device = await adapter.requestDevice()
        const errors: string[] = []
        device.addEventListener('uncapturederror', e => errors.push(e.error.message))
        const canvas = document.createElement('canvas'); canvas.width = 300; canvas.height = 200
        canvas.style.cssText = 'position:fixed;left:20px;top:100px;z-index:99999;width:300px;height:200px'
        document.body.append(canvas)
        const ctx = canvas.getContext('webgpu') as unknown as GPUCanvasContext
        const format = navigator.gpu.getPreferredCanvasFormat()
        const usage = (window as unknown as { GPUTextureUsage: { RENDER_ATTACHMENT: number } }).GPUTextureUsage.RENDER_ATTACHMENT
        ctx.configure({ device, format, alphaMode: 'opaque', usage })
        device.pushErrorScope('validation')
        const texture = ctx.getCurrentTexture()
        const encoder = device.createCommandEncoder()
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0.2, g: 0.8, b: 0.1, a: 1 } }] })
        pass.end(); device.queue.submit([encoder.finish()])
        const scoped = await device.popErrorScope()
        await new Promise(resolve => setTimeout(resolve, 500))
        const result = { format, width: texture.width, height: texture.height, scopedError: scoped?.message ?? null, errors }
        ctx.unconfigure(); device.destroy()
        return result
      })
      if (client) execFileSync('grim', ['-g', `${client.at[0]},${client.at[1]} ${client.size[0]}x${client.size[1]}`, path.join(out, `${variant.name}-raw-screen.png`)])
      const result = { name: variant.name, flags, actualLaunchArgs, state, navigation, retry, raw, client, compositorCapture, consoleLog }
      results.push(result)
      writeFileSync(path.join(out, `${variant.name}.json`), JSON.stringify(result, null, 2))
      console.log(JSON.stringify({ name: variant.name, state, raw }))
    } finally { await browser.close() }
  }
} finally {
  server.kill('SIGTERM')
  rawServer.close()
  writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ capturedAt: new Date().toISOString(), sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), buildHash: computeBuildHash(path.join(root, 'frontend')), browser: execFileSync(resolveChromiumExecutable(), ['--version'], { encoding: 'utf8' }).trim(), results }, null, 2))
}
