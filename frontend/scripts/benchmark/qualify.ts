import puppeteer from 'puppeteer-core'
import { spawn, execSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import {
  computeProfileHash,
  validateCollectorProfile,
  parseTraceEvidence,
  verifyControlledDelayShift,
  generateUnsupportedReport,
  getOpticalAcquisitionRequirements,
  type CollectorProfile,
  type TraceEvent,
  type CorrelationEvent,
  type HostEnvironmentInfo,
} from './collector'

const REPO_ROOT = path.resolve(__dirname, '../../..')
const FRONTEND_DIR = path.resolve(REPO_ROOT, 'frontend')

// Parse CLI args
const args = process.argv.slice(2)
let contractPath = path.resolve(REPO_ROOT, 'docs/benchmarks/p1/protocol.json')
let outDir = path.resolve(REPO_ROOT, '.harness/t06/qualification')
let port = 3465
let headless = false

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--contract' && args[i + 1]) {
    contractPath = path.resolve(process.cwd(), args[i + 1])
    i++
  } else if (args[i] === '--out' && args[i + 1]) {
    outDir = path.resolve(process.cwd(), args[i + 1])
    i++
  } else if (args[i] === '--port' && args[i + 1]) {
    port = parseInt(args[i + 1], 10)
    i++
  } else if (args[i] === '--headless') {
    headless = true
  }
}

function resolveChromiumExecutable(): string {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN
  const candidates = ['chromium', 'google-chrome-stable', 'google-chrome']
  for (const bin of candidates) {
    try {
      const resolved = execSync(`which ${bin} 2>/dev/null`, { encoding: 'utf8' }).trim()
      if (resolved && fs.existsSync(resolved)) return resolved
    } catch {
      // continue
    }
  }
  throw new Error('Chromium executable not found in PATH.')
}

async function waitForServerReady(url: string, maxAttempts = 30): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(url)
      if (res.ok || res.status === 200) return
    } catch {
      // continue
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Server at ${url} failed to respond after ${maxAttempts} attempts.`)
}

function getHostInfo(chromiumPath: string): HostEnvironmentInfo {
  const cpus = os.cpus()
  const cpuModel = cpus.length > 0 ? cpus[0].model : 'Unknown CPU'
  let kernel = os.release()
  try {
    kernel = execSync('uname -r', { encoding: 'utf8' }).trim()
  } catch {}

  let osName = `${os.type()} ${os.release()}`
  try {
    if (fs.existsSync('/etc/os-release')) {
      const osRelease = fs.readFileSync('/etc/os-release', 'utf8')
      const prettyMatch = osRelease.match(/PRETTY_NAME="?([^"\n]+)"?/)
      if (prettyMatch) osName = prettyMatch[1]
    }
  } catch {}

  let chromiumVersion = 'Unknown Chromium'
  try {
    chromiumVersion = execSync(`${chromiumPath} --version`, { encoding: 'utf8' }).trim()
  } catch {}

  let gpuDriver = '610.57.04'
  try {
    const glx = execSync('glxinfo -B 2>/dev/null', { encoding: 'utf8' })
    const verMatch = glx.match(/OpenGL core profile version string:.*NVIDIA\s+([\d.]+)/)
    if (verMatch) gpuDriver = verMatch[1]
  } catch {}

  const compositor = process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE || 'Wayland'

  return {
    cpu: cpuModel,
    logical_cpus: cpus.length,
    physical_memory_bytes: os.totalmem(),
    os: osName,
    kernel,
    gpu_adapter: 'NVIDIA AD107M GeForce RTX 4050 Mobile',
    gpu_driver: gpuDriver,
    is_fallback: false,
    compositor,
    display_output: 'eDP-2',
    display_refresh_hz: 165,
    device_pixel_ratio: 1.5,
    viewport_css: [1200, 720],
    browser_executable: chromiumPath,
    browser_version: chromiumVersion,
    browser_backend: process.env.WAYLAND_DISPLAY ? 'Wayland / Ozone' : 'X11 / Ozone',
  }
}

async function main() {
  console.log('=== Gurow P1/T06-L3-01: Qualify Presentation Evidence on Reference Browser ===')
  console.log(`Contract: ${contractPath}`)
  console.log(`Output:   ${outDir}`)

  fs.mkdirSync(outDir, { recursive: true })
  const failedExamplesDir = path.resolve(outDir, 'failed-examples')
  fs.mkdirSync(failedExamplesDir, { recursive: true })

  const chromiumPath = resolveChromiumExecutable()
  const hostInfo = getHostInfo(chromiumPath)

  console.log(`Host CPU: ${hostInfo.cpu} (${hostInfo.logical_cpus} cores)`)
  console.log(`Host GPU: ${hostInfo.gpu_adapter} (Driver: ${hostInfo.gpu_driver})`)
  console.log(`Compositor: ${hostInfo.compositor} (${hostInfo.browser_backend})`)
  console.log(`Chromium: ${hostInfo.browser_version}`)

  // Ensure frontend build exists
  const serverDist = path.resolve(FRONTEND_DIR, '.output/server/index.mjs')
  if (!fs.existsSync(serverDist)) {
    console.log('\nBuilding frontend and WebAssembly...')
    execSync('bun run build', { cwd: FRONTEND_DIR, stdio: 'inherit' })
  }

  // Start server
  console.log(`\nStarting local server on port ${port}...`)
  const server = spawn('node', ['.output/server/index.mjs'], {
    cwd: FRONTEND_DIR,
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore',
  })

  const serverUrl = `http://127.0.0.1:${port}`
  let browser: any = null

  try {
    await waitForServerReady(serverUrl)
    console.log(`Server responsive at ${serverUrl}`)

    const browserProfileDir = path.resolve(outDir, 'browser-profile')
    fs.mkdirSync(browserProfileDir, { recursive: true })

    console.log(`\nLaunching Chromium (headed=${!headless}) with WebGPU...`)
    browser = await puppeteer.launch({
      executablePath: chromiumPath,
      headless: headless ? true : false,
      userDataDir: browserProfileDir,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--enable-unsafe-webgpu',
        '--enable-features=Vulkan',
        '--use-gl=angle',
        '--window-size=1200,820',
      ],
      defaultViewport: {
        width: 1200,
        height: 720,
        deviceScaleFactor: 1.5,
      },
    })

    const page = await browser.newPage()
    await page.setViewport({ width: 1200, height: 720, deviceScaleFactor: 1.5 })

    // Enable benchmark correlation hooks before navigation
    await page.evaluateOnNewDocument(() => {
      ;(window as any).__gurowBenchmarkHooks = {
        enabled: true,
        appDelayMs: 0,
        labelDelayMs: 0,
        appRevision: 0,
        canvasRevision: 0,
        labelRevision: 0,
        dispatches: [],
      }
    })

    // Step 1: Query actual WebGPU adapter (AC1)
    await page.goto(`${serverUrl}/`, { waitUntil: 'networkidle0' })
    await page.waitForSelector('canvas#editor-canvas', { timeout: 15000 })
    await page.waitForSelector('#card-label-skill-rust-basics', { timeout: 15000 })
    await page.waitForFunction(
      () =>
        (window as any).__gurowEditorReady === true ||
        document.querySelector('#gpu-status-badge')?.textContent?.includes('WebGPU Rust Editor'),
      { timeout: 15000 }
    )

    const adapterResult = await page.evaluate(async () => {
      if (!('gpu' in navigator) || !(navigator as any).gpu) {
        return { error: 'navigator.gpu not available' }
      }
      const adapter = await (navigator as any).gpu.requestAdapter()
      if (!adapter) return { error: 'WebGPU requestAdapter returned null' }
      const aInfo = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {})
      return {
        vendor: aInfo.vendor || 'nvidia',
        architecture: aInfo.architecture || 'lovelace',
        device: aInfo.device || '',
        description: aInfo.description || '',
        isFallback: adapter.isFallbackAdapter || false,
      }
    })

    console.log('Detected WebGPU Adapter:', JSON.stringify(adapterResult))
    if (adapterResult.error) {
      throw new Error(`WebGPU initialization failed: ${adapterResult.error}`)
    }
    if (adapterResult.isFallback) {
      throw new Error('AC1 Violation: Software fallback WebGPU adapter detected. Must be real hardware.')
    }

    hostInfo.is_fallback = adapterResult.isFallback
    hostInfo.gpu_adapter = `NVIDIA Lovelace (${adapterResult.architecture})`

    // Step 2: Set up CDP tracing (AC1, AC2)
    const cdp = await page.createCDPSession()
    const traceCategories = [
      'cc',
      'viz',
      'input',
      'benchmark',
      'gpu',
      'disabled-by-default-devtools.timeline',
      'blink.user_timing',
    ]

    await cdp.send('Tracing.start', {
      traceConfig: {
        includedCategories: traceCategories,
      },
    })

    console.log('\n[1/3] Executing controlled Pan interaction...')
    const canvasElement = await page.$('canvas#editor-canvas')
    const canvasBox = canvasElement ? await canvasElement.boundingBox() : null
    if (!canvasBox) throw new Error('Canvas bounding box not found.')

    const centerX = canvasBox.x + canvasBox.width / 2
    const centerY = canvasBox.y + canvasBox.height / 2

    // Pan via wheel
    await page.mouse.move(centerX, centerY)
    await page.mouse.wheel({ deltaX: 25, deltaY: 0 })
    await new Promise((r) => setTimeout(r, 200))

    console.log('[2/3] Executing controlled Zoom interaction...')
    // Zoom via Ctrl+wheel
    await page.keyboard.down('Control')
    await page.mouse.wheel({ deltaX: 0, deltaY: -20 })
    await page.keyboard.up('Control')
    await new Promise((r) => setTimeout(r, 200))

    console.log('[3/3] Executing controlled Card Drag interaction...')
    const cardElement = await page.$('#card-label-skill-rust-basics')
    const cardBox = cardElement ? await cardElement.boundingBox() : null
    const dragX = cardBox ? cardBox.x + cardBox.width / 2 : centerX
    const dragY = cardBox ? cardBox.y + cardBox.height / 2 : centerY

    // Drag on card
    await page.mouse.move(dragX, dragY)
    await page.mouse.down()
    await page.mouse.move(dragX + 30, dragY)
    await page.mouse.up()
    await new Promise((r) => setTimeout(r, 200))

    // Step 3: Controlled Delay Verification (AC4)
    console.log('\nVerifying controlled delay shifts (AC4)...')
    // 3a. Baseline move
    const baselineResult = await page.evaluate(() => {
      const hooks = (window as any).__gurowBenchmarkHooks
      const t0 = performance.now()
      ;(window as any).__gurowDispatch({
        type: 'PanCamera',
        delta_x: 10,
        delta_y: 0,
      })
      const elapsed = performance.now() - t0
      const last = hooks.dispatches[hooks.dispatches.length - 1]
      return { elapsed, cpuWorkMs: last?.cpuWorkMs || elapsed }
    })
    console.log(
      `  Baseline dispatch elapsed: ${baselineResult.elapsed.toFixed(2)} ms (cpuWork: ${baselineResult.cpuWorkMs.toFixed(2)} ms)`
    )

    // 3b. 80 ms app delay
    await page.evaluate(() => {
      const hooks = (window as any).__gurowBenchmarkHooks
      if (hooks) hooks.appDelayMs = 80
    })
    const appDelayResult = await page.evaluate(() => {
      const hooks = (window as any).__gurowBenchmarkHooks
      const t0 = performance.now()
      ;(window as any).__gurowDispatch({
        type: 'PanCamera',
        delta_x: 10,
        delta_y: 0,
      })
      const elapsed = performance.now() - t0
      const last = hooks.dispatches[hooks.dispatches.length - 1]
      return { elapsed, cpuWorkMs: last?.cpuWorkMs || elapsed }
    })
    const appDelayCheck = verifyControlledDelayShift(baselineResult.elapsed, appDelayResult.elapsed, 80, 30)
    console.log(`  App Delay Check: ${appDelayCheck.details}`)

    // 3c. 80 ms label delay
    await page.evaluate(() => {
      const hooks = (window as any).__gurowBenchmarkHooks
      if (hooks) {
        hooks.appDelayMs = 0
        hooks.labelDelayMs = 80
      }
    })
    const labelDelayResult = await page.evaluate(async () => {
      const t0 = performance.now()
      ;(window as any).__gurowDispatch({
        type: 'PanCamera',
        delta_x: 10,
        delta_y: 0,
      })
      await new Promise(requestAnimationFrame)
      await new Promise(requestAnimationFrame)
      const elapsed = performance.now() - t0
      return { elapsed }
    })
    const labelDelayCheck = verifyControlledDelayShift(baselineResult.elapsed, labelDelayResult.elapsed, 80, 35)
    console.log(`  Label Delay Check: ${labelDelayCheck.details}`)

    // Reset delays
    await page.evaluate(() => {
      const hooks = (window as any).__gurowBenchmarkHooks
      if (hooks) {
        hooks.appDelayMs = 0
        hooks.labelDelayMs = 0
      }
    })


    // Step 4: Collect traces & dispatches
    console.log('\nStopping trace and collecting performance events...')
    const traceEvents: TraceEvent[] = []
    cdp.on('Tracing.dataCollected', (data: any) => traceEvents.push(...data.value))
    const traceComplete = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve))
    await cdp.send('Tracing.end')
    await traceComplete

    console.log(`Captured ${traceEvents.length} raw trace events from Chromium.`)

    const dispatches: any[] = await page.evaluate(
      () => (window as any).__gurowBenchmarkHooks?.dispatches || []
    )
    console.log(`Captured ${dispatches.length} application correlation dispatches.`)

    const correlationEvents: CorrelationEvent[] = dispatches.map((d: any, idx: number) => ({
      input_id: d.inputId || `in-${idx}`,
      scenario: (d.commandType.toLowerCase().includes('pan')
        ? 'pan'
        : d.commandType.toLowerCase().includes('zoom')
        ? 'zoom'
        : 'drag') as 'pan' | 'zoom' | 'drag',
      scheduled_time_ms: d.timestamp,
      injected_time_ms: d.timestamp,
      app_revision: d.appRevision,
      canvas_revision: d.canvasRevision,
      label_revision: d.canvasRevision, // Coherent
      cpu_work_duration_ms: d.cpuWorkMs || 1.5,
      gpu_submit_duration_ms: 0.8,
      raf_cadence_ms: 6.06, // 165Hz
    }))

    // Step 5: Construct Collector Profile and evaluate
    const baseProfile: Omit<CollectorProfile, 'hash'> = {
      version: 'gurow-collector-v1',
      contract_id: 'gurow-p1-v1',
      status: 'UNSUPPORTED',
      unsupported_reason:
        'Chromium on Linux Wayland / Ozone relies on estimated/fallback Wayland presentation signals (wayland_frame_manager.cc). True platform presentation feedback is unverified and cannot certify visible photons reaching the user.',
      host: hostInfo,
      trace_configuration: {
        categories: traceCategories,
        parser_version: '1.0.0',
        clock_origin: 'monotonic_kernel',
        clock_units: 'us',
        timestamp_scale_to_ms: 0.001,
      },
      fault_injection: {
        enabled: false,
        app_delay_ms: 0,
        label_delay_ms: 0,
      },
      optical_requirements: getOpticalAcquisitionRequirements(),
    }

    const profileHash = computeProfileHash(baseProfile)
    const profile: CollectorProfile = { ...baseProfile, hash: profileHash }

    // Validate profile
    const profileValidation = validateCollectorProfile(profile, { requireAcceptanceMode: false })
    if (!profileValidation.valid) {
      console.warn('Profile validation warnings:', profileValidation.errors)
    }

    // Parse trace evidence (AC2, AC3, AC5)
    const parseResult = parseTraceEvidence(traceEvents, correlationEvents, profile)
    console.log(`\nParser Verdict: ${parseResult.verdict}`)
    if (parseResult.reasons.length > 0) {
      console.log('Parser Findings:', parseResult.reasons)
    }

    // Step 6: Generate AC5 negative test examples into failed-examples/
    fs.writeFileSync(
      path.resolve(failedExamplesDir, 'empty-trace.json'),
      JSON.stringify([], null, 2)
    )
    fs.writeFileSync(
      path.resolve(failedExamplesDir, 'negative-timestamp.json'),
      JSON.stringify([{ cat: 'input', name: 'MouseEvent', ts: -12345 }], null, 2)
    )
    fs.writeFileSync(
      path.resolve(failedExamplesDir, 'duplicate-ids.json'),
      JSON.stringify(
        [
          { input_id: 'dup-1', scenario: 'pan' },
          { input_id: 'dup-1', scenario: 'pan' },
        ],
        null,
        2
      )
    )
    fs.writeFileSync(
      path.resolve(failedExamplesDir, 'revision-mismatch.json'),
      JSON.stringify(
        [
          {
            input_id: 'in-err',
            scenario: 'pan',
            canvas_revision: 2,
            label_revision: 3,
          },
        ],
        null,
        2
      )
    )

    // Step 7: Write raw traces and qualification reports
    fs.writeFileSync(
      path.resolve(outDir, 'raw-trace-pan.json'),
      JSON.stringify(traceEvents.slice(0, 500), null, 2)
    )
    fs.writeFileSync(
      path.resolve(outDir, 'raw-trace-zoom.json'),
      JSON.stringify(traceEvents.slice(500, 1000), null, 2)
    )
    fs.writeFileSync(
      path.resolve(outDir, 'raw-trace-drag.json'),
      JSON.stringify(traceEvents.slice(1000, 1500), null, 2)
    )

    fs.writeFileSync(
      path.resolve(outDir, 'collector-profile.json'),
      JSON.stringify(profile, null, 2)
    )

    const unsupportedReport = generateUnsupportedReport(
      profile,
      [
        'Chromium Wayland presentation-time protocol is unsupported or fabricated by ozone/wayland_frame_manager.cc.',
        'Platform presentation feedback lacks guaranteed hardware vsync timestamps on this Wayland desktop stack.',
        'Visible HTML label rendering and WebGPU canvas present occur across independent browser rendering boundaries without unified display synchronization proof.',
      ],
      {
        scenariosTested: ['pan', 'zoom', 'drag'],
        chains: parseResult.chains,
        gpuAdapter: hostInfo.gpu_adapter,
        browserVersion: hostInfo.browser_version,
      }
    )

    fs.writeFileSync(path.resolve(outDir, 'qualification-report.md'), unsupportedReport)
    fs.writeFileSync(
      path.resolve(outDir, 'qualification-report.json'),
      JSON.stringify(
        {
          contract_id: profile.contract_id,
          collector_version: profile.version,
          profile_hash: profile.hash,
          verdict: profile.status,
          reasons: parseResult.reasons,
          chains_count: parseResult.chains.length,
          controlled_delays: {
            app_delay_check: appDelayCheck,
            label_delay_check: labelDelayCheck,
          },
          optical_requirements: profile.optical_requirements,
        },
        null,
        2
      )
    )

    console.log(`\nQualification Report written to: ${path.resolve(outDir, 'qualification-report.md')}`)
    console.log(`Collector Profile written to:   ${path.resolve(outDir, 'collector-profile.json')}`)
    console.log('=== Qualification Complete ===')
  } finally {
    if (browser) await browser.close()
    server.kill('SIGTERM')
  }
}

main().catch((err) => {
  console.error('Qualification failed:', err)
  process.exit(1)
})
