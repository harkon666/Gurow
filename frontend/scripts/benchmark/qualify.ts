import puppeteer from 'puppeteer-core'
import { spawn, execSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { createHash } from 'crypto'
import {
  computeProfileHash,
  deriveClockMapping,
  parseTraceEvidence,
  verifyControlledDelayShift,
  generateQualificationReport,
  getOpticalAcquisitionRequirements,
  UNKNOWN,
  isSoftwareAdapter,
  type CanvasGeometry,
  type CollectorProfile,
  type DelayCheckResult,
  type InputPresentationChain,
  type TraceEvent,
  type CorrelationEvent,
  type HostEnvironmentInfo,
  type SourceIdentity,
} from './collector'
import { finalizeQualification } from './qualification'
import { computeSourceFingerprint } from './sourceFingerprint'
import { validateReferenceEnvironment } from './collector'

/**
 * T06-L3-01 qualification driver.
 *
 * Drives one controlled pan, zoom and drag through real browser input on the
 * headed reference browser, derives a trace/page clock mapping, and reports
 * whichever verdict the evidence supports. The verdict is never predetermined:
 * an UNSUPPORTED result is a finding, and `--expect-verdict` turns that finding
 * into a regression check the harness can fail on.
 */

const REPO_ROOT = path.resolve(__dirname, '../../..')
const FRONTEND_DIR = path.resolve(REPO_ROOT, 'frontend')

const args = process.argv.slice(2)
let contractPath = path.resolve(REPO_ROOT, 'docs/benchmarks/p1/protocol.json')
let outDir = path.resolve(REPO_ROOT, '.harness/t06/qualification')
let port = 3465
let headless = false
let expectVerdict: string | null = null

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
  } else if (args[i] === '--expect-verdict' && args[i + 1]) {
    expectVerdict = args[i + 1]
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

function tryExec(command: string): string | null {
  try {
    const out = execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

/** Reads the GPU driver version from the host, or returns `unknown`. */
function probeGpuDriver(): string {
  const nvidiaSmi = tryExec('nvidia-smi --query-gpu=driver_version --format=csv,noheader')
  if (nvidiaSmi) return nvidiaSmi.split('\n')[0].trim()

  const glx = tryExec('glxinfo -B 2>/dev/null')
  if (glx) {
    const nvidia = glx.match(/OpenGL core profile version string:.*NVIDIA\s+([\d.]+)/)
    if (nvidia) return nvidia[1]
    const mesa = glx.match(/OpenGL version string:\s*([^\n]+)/)
    if (mesa) return mesa[1].trim()
  }
  return UNKNOWN
}

/**
 * Reads the active display output name and refresh rate from the compositor.
 *
 * Returns nulls rather than the reference values when the host cannot be
 * queried, because AC1 treats an unobserved host fact as an escalation.
 */
function probeDisplay(): { output: string | null; refreshHz: number | null } {
  const hyprJson = tryExec('hyprctl monitors -j')
  if (hyprJson) {
    try {
      const monitors = JSON.parse(hyprJson) as {
        name?: string
        refreshRate?: number
        focused?: boolean
      }[]
      const active = monitors.find((m) => m.focused) ?? monitors[0]
      if (active) {
        return {
          output: active.name ?? null,
          refreshHz:
            typeof active.refreshRate === 'number' ? Math.round(active.refreshRate * 100) / 100 : null,
        }
      }
    } catch {
      // fall through to wlr-randr
    }
  }

  const wlr = tryExec('wlr-randr')
  if (wlr) {
    const outputMatch = wlr.match(/^(\S+)/m)
    const rateMatch = wlr.match(/(\d+\.\d+)\s*Hz\s*\(current\)/) ?? wlr.match(/(\d+\.\d+)\s*Hz/)
    return {
      output: outputMatch ? outputMatch[1] : null,
      refreshHz: rateMatch ? Math.round(parseFloat(rateMatch[1]) * 100) / 100 : null,
    }
  }

  return { output: null, refreshHz: null }
}

/** Records the source identity the qualification ran against (contract §4). */
function getSourceIdentity(): SourceIdentity {
  const commit = tryExec(`git -C ${REPO_ROOT} rev-parse HEAD`) ?? UNKNOWN
  const status = tryExec(`git -C ${REPO_ROOT} status --porcelain`)
  const serverEntry = path.resolve(FRONTEND_DIR, '.output/server/index.mjs')

  let buildHash: string = UNKNOWN
  if (fs.existsSync(serverEntry)) {
    const hash = createHash('sha256')
    hash.update(fs.readFileSync(serverEntry))
    const wasmDir = path.resolve(FRONTEND_DIR, 'src/pkg')
    if (fs.existsSync(wasmDir)) {
      for (const entry of fs.readdirSync(wasmDir).sort()) {
        if (entry.endsWith('.wasm') || entry.endsWith('.js')) {
          hash.update(entry)
          hash.update(fs.readFileSync(path.resolve(wasmDir, entry)))
        }
      }
    }
    buildHash = hash.digest('hex')
  }

  return {
    commit,
    tree_dirty: status !== null && status.length > 0,
    build_hash: buildHash,
    source_fingerprint: computeSourceFingerprint(REPO_ROOT),
  }
}

/**
 * Collects host facts that do not depend on the browser session.
 *
 * Adapter identity, viewport, DPR and canvas geometry are filled in later from
 * the live page; nothing here substitutes a reference value for an observation.
 */
function getHostInfo(chromiumPath: string): HostEnvironmentInfo {
  const cpus = os.cpus()
  const cpuModel = cpus.length > 0 ? cpus[0].model : UNKNOWN

  const kernel = tryExec('uname -r') ?? os.release()

  let osName = `${os.type()} ${os.release()}`
  try {
    if (fs.existsSync('/etc/os-release')) {
      const osRelease = fs.readFileSync('/etc/os-release', 'utf8')
      const prettyMatch = osRelease.match(/PRETTY_NAME="?([^"\n]+)"?/)
      if (prettyMatch) osName = prettyMatch[1]
    }
  } catch {
    // keep the os module fallback
  }

  const display = probeDisplay()
  let compositor: string = UNKNOWN
  const hyprland = tryExec('hyprctl version -j')
  if (hyprland) {
    try {
      const version = JSON.parse(hyprland) as { version?: string; commit?: string }
      if (version.version) compositor = `Hyprland ${version.version} (${version.commit ?? UNKNOWN})`
    } catch { /* Unknown is rejected rather than guessed from WAYLAND_DISPLAY. */ }
  }

  return {
    cpu: cpuModel,
    logical_cpus: cpus.length,
    physical_memory_bytes: os.totalmem(),
    os: osName,
    kernel,
    gpu_adapter: UNKNOWN,
    gpu_driver: probeGpuDriver(),
    is_fallback: false,
    compositor,
    display_output: display.output,
    display_refresh_hz: display.refreshHz,
    device_pixel_ratio: null,
    viewport_css: null,
    canvas_geometry: null,
    browser_executable: chromiumPath,
    browser_version: UNKNOWN,
    browser_backend: UNKNOWN,
    browser_command_line: [],
    native_window: null,
  }
}

/** One controlled phase of the run, bounded on the page clock. */
interface PhaseWindow {
  name: 'baseline' | 'app-delay' | 'label-delay'
  scenario: 'pan' | 'zoom' | 'drag'
  start_ms: number
  end_ms: number
}

/** Median of a numeric sample, or null when the sample is empty. */
function medianOrNull(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * Median attributed latency of the chains whose input fell inside one phase.
 *
 * Returns null when no chain in the phase produced a real endpoint, which is
 * what makes the AC4 check report NOT_MEASURED instead of inventing a shift.
 */
function phaseLatency(chains: InputPresentationChain[], window: PhaseWindow): number | null {
  const inPhase = chains.filter(
    (c) =>
      c.input_timestamp_ms !== null &&
      c.input_timestamp_ms >= window.start_ms &&
      c.input_timestamp_ms <= window.end_ms &&
      c.latency_ms !== null
  )
  return medianOrNull(inPhase.map((c) => c.latency_ms as number))
}

/** Median CPU-side dispatch duration in a phase, used for diagnostics only. */
function phaseDiagnosticCpu(
  chains: InputPresentationChain[],
  window: PhaseWindow
): number | null {
  const inPhase = chains.filter(
    (c) =>
      c.input_timestamp_ms !== null &&
      c.input_timestamp_ms >= window.start_ms &&
      c.input_timestamp_ms <= window.end_ms &&
      c.diagnostics.cpu_duration_ms !== null
  )
  return medianOrNull(inPhase.map((c) => c.diagnostics.cpu_duration_ms as number))
}

/**
 * Median label-commit duration inside a phase window.
 *
 * This proves whether an injected label delay actually executed, so a failing
 * AC4 label check can be read as "the endpoint ignores labels" rather than
 * "the delay never ran".
 */
function phaseLabelCommitMs(
  commits: { commit_ms: number; commit_duration_ms: number }[],
  window: PhaseWindow
): number | null {
  const inPhase = commits.filter(
    (c) => c.commit_ms >= window.start_ms && c.commit_ms <= window.end_ms
  )
  return medianOrNull(inPhase.map((c) => c.commit_duration_ms))
}

async function main() {
  console.log('=== Gurow P1/T06-L3-01: Qualify Presentation Evidence on Reference Browser ===')
  console.log(`Contract: ${contractPath}`)
  console.log(`Output:   ${outDir}`)
  if (expectVerdict) console.log(`Expected verdict: ${expectVerdict}`)

  if (!fs.existsSync(contractPath)) {
    throw new Error(`Contract protocol not found at ${contractPath}.`)
  }

  fs.mkdirSync(outDir, { recursive: true })
  const failedExamplesDir = path.resolve(outDir, 'failed-examples')
  fs.mkdirSync(failedExamplesDir, { recursive: true })

  const chromiumPath = resolveChromiumExecutable()

  // Contract §2: full checks build the current source before testing the
  // browser. An existing .output directory may be stale, so always rebuild.
  console.log('\nBuilding frontend and WebAssembly from current source...')
  execSync('bun run build', { cwd: FRONTEND_DIR, stdio: 'inherit' })

  const hostInfo = getHostInfo(chromiumPath)
  const identity = getSourceIdentity()

  console.log(`Host CPU: ${hostInfo.cpu} (${hostInfo.logical_cpus} cores)`)
  console.log(`GPU driver: ${hostInfo.gpu_driver}`)
  console.log(
    `Display: ${hostInfo.display_output ?? 'unresolved'} @ ${hostInfo.display_refresh_hz ?? 'unresolved'} Hz`
  )
  console.log(`Compositor: ${hostInfo.compositor} (${hostInfo.browser_backend})`)
  console.log(`Chromium: ${hostInfo.browser_version}`)
  console.log(`Source: ${identity.commit}${identity.tree_dirty ? ' (dirty)' : ''}`)

  console.log(`\nStarting local server on port ${port}...`)
  const server = spawn('node', ['.output/server/index.mjs'], {
    cwd: FRONTEND_DIR,
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore',
  })

  const serverUrl = `http://127.0.0.1:${port}`
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null

  try {
    await waitForServerReady(serverUrl)
    console.log(`Server responsive at ${serverUrl}`)

    // A dedicated, FRESH profile per attempt. Reusing it leaks camera and
    // checkpoint state between runs, so a later run would start from whatever
    // the previous one left on screen instead of the fixture's initial camera.
    const browserProfileDir = path.resolve(outDir, 'browser-profile')
    fs.rmSync(browserProfileDir, { recursive: true, force: true })
    fs.mkdirSync(browserProfileDir, { recursive: true })

    console.log(`\nLaunching Chromium (headed=${!headless}) with WebGPU...`)
    browser = await puppeteer.launch({
      executablePath: chromiumPath,
      headless,
      userDataDir: browserProfileDir,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--enable-unsafe-webgpu',
        '--enable-features=Vulkan,WaylandPerSurfaceScale',
        '--use-gl=angle',
        '--window-size=1200,776',
        `--ozone-platform=${process.env.WAYLAND_DISPLAY ? 'wayland' : 'x11'}`,
        `--app=${serverUrl}`,
      ],
      // PRIME offload pins Chromium to the discrete GPU. Without it this host
      // either selects SwiftShader (software, with the WebGPU fallback flag
      // unset) or contends over the integrated GPU and loses the device with
      // VK_ERROR_OUT_OF_DEVICE_MEMORY mid-run.
      env: {
        ...process.env,
        __NV_PRIME_RENDER_OFFLOAD: '1',
        __GLX_VENDOR_LIBRARY_NAME: 'nvidia',
        __VK_LAYER_NV_optimus: 'NVIDIA_only',
      },
      defaultViewport: null,
    })

    // Reuse the app window. newPage() would create a normal browser window.
    const page = (await browser.pages())[0]
    if (!page) throw new Error('No native app window was created.')
    await page.bringToFront()
    const windowCdp = await page.createCDPSession()
    const actualVersion = await windowCdp.send('Browser.getVersion')
    const actualCommand = await windowCdp.send('Browser.getBrowserCommandLine')
    hostInfo.browser_version = actualVersion.product
    hostInfo.browser_command_line = actualCommand.arguments
    hostInfo.browser_executable = actualCommand.arguments[0] ?? UNKNOWN
    const ozone = [...actualCommand.arguments].reverse().find((arg) => arg.startsWith('--ozone-platform='))
    hostInfo.browser_backend = ozone ? `${ozone.split('=')[1]} / Ozone (actual browser command line)` : UNKNOWN

    // Contract §3: record interruptions and memory pressure. A lost WebGPU
    // device or exhausted device memory invalidates the attempt, and must be
    // named as environment contention rather than reported as a slow or
    // unresponsive application.
    const deviceLossEvents: string[] = []
    const pageErrors: string[] = []
    page.on('console', (message) => {
      const text = message.text()
      if (/device lost|OUT_OF_DEVICE_MEMORY|vkAllocateMemory failed/i.test(text)) {
        deviceLossEvents.push(text.slice(0, 300))
      }
    })
    page.on('pageerror', (error) => {
      pageErrors.push(String(error).slice(0, 300))
    })

    // Install the opt-in instrumentation before any application code runs.
    await page.evaluateOnNewDocument(() => {
      ;(window as unknown as { __gurowBenchmarkHooks: unknown }).__gurowBenchmarkHooks = {
        enabled: true,
        app_delay_ms: 0,
        label_delay_ms: 0,
        app_revision: 0,
        canvas_revision: 0,
        label_revision: 0,
        pending_input: null,
        dispatches: [],
        label_commits: [],
        clock_syncs: [],
        active_scenario: null,
        raf_intervals_ms: [],
      }
    })

    await page.goto(`${serverUrl}/`, { waitUntil: 'networkidle0' })
    await page.waitForSelector('canvas#editor-canvas', { timeout: 15000 })
    await page.waitForSelector('#card-label-skill-rust-basics', { timeout: 15000 })
    await page.waitForFunction(
      () => (window as unknown as { __gurowEditorReady?: boolean }).__gurowEditorReady === true,
      { timeout: 15000 }
    )

    // AC1: record the adapter the browser actually selected.
    const adapterResult = await page.evaluate(async () => {
      const gpu = (navigator as unknown as { gpu?: GPU }).gpu
      if (!gpu) return { error: 'navigator.gpu not available' }
      const adapter = await gpu.requestAdapter()
      if (!adapter) return { error: 'WebGPU requestAdapter returned null' }
      const info = (adapter as unknown as { info?: Record<string, string> }).info ?? {}
      return {
        vendor: info.vendor ?? null,
        architecture: info.architecture ?? null,
        device: info.device ?? null,
        description: info.description ?? null,
        isFallback: (adapter as unknown as { isFallbackAdapter?: boolean }).isFallbackAdapter ?? false,
      }
    })

    console.log('Detected WebGPU Adapter:', JSON.stringify(adapterResult))
    if ('error' in adapterResult && adapterResult.error) {
      throw new Error(`WebGPU initialization failed: ${adapterResult.error}`)
    }
    const adapter = adapterResult as {
      vendor: string | null
      architecture: string | null
      device: string | null
      description: string | null
      isFallback: boolean
    }
    if (adapter.isFallback) {
      throw new Error('AC1 Violation: Software fallback WebGPU adapter detected. Must be real hardware.')
    }

    hostInfo.is_fallback = adapter.isFallback
    const adapterParts = [adapter.vendor, adapter.architecture, adapter.device, adapter.description]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
    hostInfo.gpu_adapter = adapterParts.length > 0 ? adapterParts.join(' / ') : UNKNOWN

    // The fallback flag is not sufficient: Chromium leaves it unset for
    // SwiftShader, which would otherwise be recorded as a hardware run.
    if (isSoftwareAdapter(hostInfo.gpu_adapter)) {
      throw new Error(
        `AC1 Violation: software renderer '${hostInfo.gpu_adapter}' selected. ` +
          'Launch with Vulkan plus NVIDIA PRIME offload so a hardware adapter is used.'
      )
    }
    if (hostInfo.gpu_adapter === UNKNOWN) {
      console.warn(
        'WebGPU adapter reported no identifying fields; AC1 requires escalation for an unknown adapter.'
      )
    }

    // Resize only our own native app window; never emulate device metrics.
    const nativeWindow = await windowCdp.send('Browser.getWindowForTarget')
    const geometrySetupErrors: string[] = []
    try {
      await windowCdp.send('Browser.setWindowBounds', { windowId: nativeWindow.windowId, bounds: { windowState: 'normal' } })
      for (let attempt = 0; attempt < 3; attempt++) {
        const actual = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, outerWidth, outerHeight }))
        if (actual.width === 1200 && actual.height === 720) break
        await windowCdp.send('Browser.setWindowBounds', {
          windowId: nativeWindow.windowId,
          bounds: { width: actual.outerWidth + 1200 - actual.width, height: actual.outerHeight + 720 - actual.height },
        })
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    } catch (error) { geometrySetupErrors.push(`Native window sizing failed: ${String(error)}`) }
    await page.evaluate(() => document.querySelector('#canvas-editor-container')?.scrollIntoView({ block: 'center' }))
    await new Promise((resolve) => setTimeout(resolve, 500))
    const settledWindow = await windowCdp.send('Browser.getWindowForTarget')

    // AC1: read settled live geometry, visibility and backing sizes.
    const liveGeometry = await page.evaluate(() => {
      const canvas = document.querySelector('canvas#editor-canvas') as HTMLCanvasElement | null
      const rect = canvas?.getBoundingClientRect()
      const visible = (selector: string) => Array.from(document.querySelectorAll(selector)).some((element) => {
        const bounds = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return style.visibility === 'visible' && style.display !== 'none' && Number(style.opacity) > 0 &&
          bounds.width > 0 && bounds.height > 0 && bounds.right > 0 && bounds.bottom > 0 &&
          bounds.left < innerWidth && bounds.top < innerHeight
      })
      const unobscured = !!canvas && !!rect && [0.01, 0.5, 0.99].every((fx) =>
        [0.01, 0.5, 0.99].every((fy) => {
          const hit = document.elementFromPoint(rect.x + rect.width * fx, rect.y + rect.height * fy)
          return hit === canvas || !!hit?.closest('[id^="card-label-"]')
        }))
      return {
        dpr: window.devicePixelRatio,
        available: { x: (screen as Screen & { availLeft: number }).availLeft, y: (screen as Screen & { availTop: number }).availTop, width: screen.availWidth, height: screen.availHeight },
        visualScale: window.visualViewport?.scale ?? 0,
        documentVisible: document.visibilityState === 'visible', focused: document.hasFocus(),
        unobscured, labelsVisible: visible('[id^="card-label-"]'),
        listVisible: visible('[aria-label="Skill and Prerequisite List"]'),
        taskPanelVisible: visible('#skill-detail-panel'),
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        screenWidth: window.screen.width,
        screenHeight: window.screen.height,
        canvas:
          canvas && rect
            ? {
                css_bounds: {
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                },
                backing_size: { width: canvas.width, height: canvas.height },
              }
            : null,
      }
    })

    hostInfo.device_pixel_ratio = liveGeometry.dpr
    hostInfo.viewport_css = [liveGeometry.innerWidth, liveGeometry.innerHeight]
    hostInfo.canvas_geometry = liveGeometry.canvas as CanvasGeometry | null
    hostInfo.native_window = {
      headed: !headless, device_metrics_emulated: false,
      x: settledWindow.bounds.left ?? NaN, y: settledWindow.bounds.top ?? NaN,
      width: settledWindow.bounds.width ?? NaN, height: settledWindow.bounds.height ?? NaN,
      screen_width: liveGeometry.screenWidth, screen_height: liveGeometry.screenHeight,
      available_x: liveGeometry.available.x, available_y: liveGeometry.available.y,
      available_width: liveGeometry.available.width, available_height: liveGeometry.available.height,
      visual_viewport_scale: liveGeometry.visualScale, document_visible: liveGeometry.documentVisible,
      focused: liveGeometry.focused, canvas_unobscured: liveGeometry.unobscured,
      labels_visible: liveGeometry.labelsVisible, skill_list_visible: liveGeometry.listVisible,
      task_panel_visible: liveGeometry.taskPanelVisible,
    }
    // On Hyprland, verify compositor-observed position/size and reserved panel
    // area: Wayland's screenX/availHeight may omit that native desktop detail.
    try {
      const clients = JSON.parse(tryExec('hyprctl clients -j') ?? '[]') as Array<{ pid: number; at: number[]; size: number[] }>
      const client = clients.find((entry) => entry.pid === browser?.process()?.pid)
      const monitors = JSON.parse(tryExec('hyprctl monitors -j') ?? '[]') as Array<{
        name: string; x: number; y: number; width: number; height: number; scale: number; reserved: number[]
      }>
      const monitor = monitors.find((entry) => entry.name === hostInfo.display_output)
      if (client) Object.assign(hostInfo.native_window!, { x: client.at[0], y: client.at[1], width: client.size[0], height: client.size[1] })
      if (monitor) Object.assign(hostInfo.native_window!, {
        available_x: monitor.x + monitor.reserved[0], available_y: monitor.y + monitor.reserved[1],
        available_width: monitor.width / monitor.scale - monitor.reserved[0] - monitor.reserved[2],
        available_height: monitor.height / monitor.scale - monitor.reserved[1] - monitor.reserved[3],
      })
    } catch (error) { geometrySetupErrors.push(`Native desktop geometry observation failed: ${String(error)}`) }
    const environmentErrors = [...geometrySetupErrors, ...validateReferenceEnvironment(hostInfo)]
    fs.writeFileSync(path.resolve(outDir, 'environment-preflight.json'), JSON.stringify({
      status: environmentErrors.length ? 'NOT_MEASURED' : 'PASS', identity, host: hostInfo,
      browser_window: settledWindow, reasons: environmentErrors,
    }, null, 2))
    if (environmentErrors.length) {
      const base: Omit<CollectorProfile, 'hash'> = {
        version: 'gurow-collector-v3', contract_id: 'gurow-p1-v1', status: 'NOT_MEASURED',
        unsupported_reason: environmentErrors.join(' '), identity, host: hostInfo,
        trace_configuration: { categories: [], parser_version: '3.0.0', clock_origin: 'chromium_trace_monotonic',
          clock_units: 'us', timestamp_scale_to_ms: 0.001, clock_mapping: deriveClockMapping([], [], 'us') },
        fault_injection: { enabled: false, app_delay_ms: 0, label_delay_ms: 0 },
        optical_requirements: getOpticalAcquisitionRequirements(),
      }
      const failedProfile = { ...base, hash: computeProfileHash(base) }
      fs.writeFileSync(path.resolve(outDir, 'collector-profile.json'), JSON.stringify(failedProfile, null, 2))
      fs.writeFileSync(path.resolve(outDir, 'qualification-report.json'), JSON.stringify({
        verdict: 'NOT_MEASURED', stage: 'environment-preflight-before-capture', reasons: environmentErrors,
        identity, host: hostInfo, profile_hash: failedProfile.hash,
        app_delay_check: verifyControlledDelayShift(null, null, 80),
        label_delay_check: verifyControlledDelayShift(null, null, 80),
      }, null, 2))
      fs.writeFileSync(path.resolve(outDir, 'qualification-report.md'), generateQualificationReport(failedProfile, environmentErrors, {
        scenariosTested: [], chains: [], gpuAdapter: hostInfo.gpu_adapter, browserVersion: hostInfo.browser_version,
        appDelayCheck: verifyControlledDelayShift(null, null, 80), labelDelayCheck: verifyControlledDelayShift(null, null, 80),
        diagnosticShifts: { appDispatchShiftMs: null, labelCommitShiftMs: null },
      }))
      throw new Error(`Reference environment preflight failed before capture: ${environmentErrors.join(' ')}`)
    }
    console.log(
      `Live geometry: ${liveGeometry.innerWidth}×${liveGeometry.innerHeight} CSS @ DPR ${liveGeometry.dpr}`
    )

    // Sample rAF cadence once as a diagnostic, before the timed phases.
    const rafCadenceMs = await page.evaluate(
      () =>
        new Promise<number | null>((resolve) => {
          const stamps: number[] = []
          const tick = (now: number) => {
            stamps.push(now)
            if (stamps.length < 20) {
              requestAnimationFrame(tick)
              return
            }
            const gaps = stamps.slice(1).map((s, i) => s - stamps[i])
            gaps.sort((a, b) => a - b)
            resolve(gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)] : null)
          }
          requestAnimationFrame(tick)
        })
    )
    console.log(`Sampled rAF cadence: ${rafCadenceMs === null ? 'unavailable' : `${rafCadenceMs.toFixed(2)} ms`}`)

    const traceCategories = [
      'cc',
      'viz',
      'input',
      'benchmark',
      'gpu',
      'disabled-by-default-devtools.timeline',
      'blink.user_timing',
    ]

    const cdp = await page.createCDPSession()
    const traceEvents: TraceEvent[] = []
    cdp.on('Tracing.dataCollected', (data: { value: TraceEvent[] }) =>
      traceEvents.push(...data.value)
    )

    await cdp.send('Tracing.start', { traceConfig: { includedCategories: traceCategories } })

    /** Emits paired clock-sync marks so the two clocks can be related. */
    const emitClockSyncs = async (count: number) => {
      await page.evaluate(async (n: number) => {
        const hooks = (window as unknown as { __gurowBenchmarkHooks: { clock_syncs: unknown[] } })
          .__gurowBenchmarkHooks
        for (let i = 0; i < n; i++) {
          const index = hooks.clock_syncs.length
          const pageNow = performance.now()
          performance.mark(`gurow:clock_sync:${index}`)
          hooks.clock_syncs.push({ index, page_now_ms: pageNow })
          await new Promise((r) => setTimeout(r, 20))
        }
      }, count)
    }

    await emitClockSyncs(5)

    // Let startup layout settle: the route emits repeated ResizeViewport
    // commands while the canvas backing size converges, and an input delivered
    // during that churn can be lost.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          let quietFrames = 0
          const hooks = (window as unknown as { __gurowBenchmarkHooks: { dispatches: unknown[] } })
            .__gurowBenchmarkHooks
          let last = hooks.dispatches.length
          const tick = () => {
            const current = hooks.dispatches.length
            quietFrames = current === last ? quietFrames + 1 : 0
            last = current
            if (quietFrames >= 30) {
              resolve()
              return
            }
            requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        })
    )

    const canvasElement = await page.$('canvas#editor-canvas')
    const canvasBox = canvasElement ? await canvasElement.boundingBox() : null
    if (!canvasBox) throw new Error('Canvas bounding box not found.')
    console.log(
      `Canvas rect: x ${canvasBox.x.toFixed(1)}, y ${canvasBox.y.toFixed(1)}, ${canvasBox.width.toFixed(1)}×${canvasBox.height.toFixed(1)}`
    )
    const centerX = canvasBox.x + canvasBox.width / 2
    const centerY = canvasBox.y + canvasBox.height / 2

    const setScenario = async (scenario: 'pan' | 'zoom' | 'drag' | null) => {
      await page.evaluate((s: string | null) => {
        const hooks = (window as unknown as {
          __gurowBenchmarkHooks: { active_scenario: string | null }
        }).__gurowBenchmarkHooks
        hooks.active_scenario = s
      }, scenario)
    }

    const pageNow = () => page.evaluate(() => performance.now())

    /** Drives one scenario through real browser input only. */
    const driveScenario = async (scenario: 'pan' | 'zoom' | 'drag') => {
      await setScenario(scenario)
      if (scenario === 'pan') {
        await page.mouse.move(centerX, centerY)
        await page.mouse.wheel({ deltaX: 25, deltaY: 0 })
      } else if (scenario === 'zoom') {
        await page.mouse.move(centerX, centerY)
        await page.keyboard.down('Control')
        await page.mouse.wheel({ deltaX: 0, deltaY: -20 })
        await page.keyboard.up('Control')
      } else {
        // Contract §3: drag a card that actually lies inside the clipped canvas
        // rectangle. The preceding pan and zoom move the camera, so the fixture
        // card is not reliably on screen by the time drag runs; pick whichever
        // card is currently visible instead of dragging at a coordinate the
        // browser would discard. No visible card is a real geometry failure.
        const target = await page.evaluate(
          (rect: { x: number; y: number; width: number; height: number }) => {
            const labels = Array.from(
              document.querySelectorAll<HTMLElement>('[id^="card-label-"]')
            )
            const candidates = labels.map((el) => {
              const r = el.getBoundingClientRect()
              return { id: el.id, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }
            })
            const inside = candidates.filter(
              (c) =>
                c.cx >= rect.x &&
                c.cx <= rect.x + rect.width &&
                c.cy >= rect.y &&
                c.cy <= rect.y + rect.height
            )
            return { inside, total: candidates.length }
          },
          { x: canvasBox.x, y: canvasBox.y, width: canvasBox.width, height: canvasBox.height }
        )

        if (target.inside.length === 0) {
          throw new Error(
            `Drag geometry failure: none of ${target.total} card labels lie inside the canvas rect ` +
              `(x ${canvasBox.x.toFixed(1)}, y ${canvasBox.y.toFixed(1)}, ` +
              `w ${canvasBox.width.toFixed(1)}, h ${canvasBox.height.toFixed(1)}).`
          )
        }

        const chosen = target.inside[0]
        console.log(`  Dragging ${chosen.id} at (${chosen.cx.toFixed(1)}, ${chosen.cy.toFixed(1)})`)
        const dragX = chosen.cx
        const dragY = chosen.cy
        await page.mouse.move(dragX, dragY)
        await page.mouse.down()
        // Keep the whole motion inside the canvas and move in steps so the
        // intermediate pointermove events are actually delivered.
        const dragEndX = Math.min(dragX + 30, canvasBox.x + canvasBox.width - 2)
        await page.mouse.move(dragEndX, dragY, { steps: 4 })
        await page.mouse.up()
      }
      await new Promise((r) => setTimeout(r, 250))
      await setScenario(null)
    }

    const scenarioWindows: Record<string, { start_ms: number; end_ms: number }> = {}
    for (const scenario of ['pan', 'zoom', 'drag'] as const) {
      console.log(`\nExecuting controlled ${scenario} interaction through browser input...`)
      const start = await pageNow()
      await driveScenario(scenario)
      scenarioWindows[scenario] = { start_ms: start, end_ms: await pageNow() }
    }

    // AC4: controlled delay phases, driven through browser input so the timed
    // interaction never bypasses the real event path.
    console.log('\nRunning controlled delay phases (AC4)...')
    const setDelays = async (appDelayMs: number, labelDelayMs: number) => {
      await page.evaluate(
        ({ appDelayMs: a, labelDelayMs: l }: { appDelayMs: number; labelDelayMs: number }) => {
          const hooks = (window as unknown as {
            __gurowBenchmarkHooks: { app_delay_ms: number; label_delay_ms: number }
          }).__gurowBenchmarkHooks
          hooks.app_delay_ms = a
          hooks.label_delay_ms = l
        },
        { appDelayMs, labelDelayMs }
      )
    }

    const phases: PhaseWindow[] = []
    const runPhase = async (
      name: PhaseWindow['name'],
      appDelayMs: number,
      labelDelayMs: number
    ) => {
      await setDelays(appDelayMs, labelDelayMs)
      const start = await pageNow()
      await driveScenario('pan')
      await driveScenario('pan')
      phases.push({ name, scenario: 'pan', start_ms: start, end_ms: await pageNow() })
      console.log(`  Phase ${name} complete (app=${appDelayMs} ms, label=${labelDelayMs} ms).`)
    }

    await runPhase('baseline', 0, 0)
    await runPhase('app-delay', 80, 0)
    await runPhase('label-delay', 0, 80)

    // Fault injection must be off before the profile is built for acceptance.
    await setDelays(0, 0)
    await emitClockSyncs(5)

    console.log('\nStopping trace and collecting performance events...')
    const traceComplete = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve))
    await cdp.send('Tracing.end')
    await traceComplete
    console.log(`Captured ${traceEvents.length} raw trace events from Chromium.`)

    const runtime = await page.evaluate(() => {
      const hooks = (window as unknown as {
        __gurowBenchmarkHooks: {
          dispatches: unknown[]
          label_commits: unknown[]
          clock_syncs: unknown[]
        }
      }).__gurowBenchmarkHooks
      return {
        dispatches: hooks.dispatches,
        labelCommits: hooks.label_commits,
        clockSyncs: hooks.clock_syncs,
      }
    })

    type RuntimeDispatch = {
      input_id: string
      command_type: string
      scenario: 'pan' | 'zoom' | 'drag' | null
      input_origin_ms: number | null
      app_revision: number
      canvas_revision: number
      label_revision_at_dispatch: number
      label_revision: number | null
      label_commit_app_revision: number | null
      label_commit_ms: number | null
      cpu_work_ms: number
    }
    const dispatches = runtime.dispatches as RuntimeDispatch[]
    const labelCommits = runtime.labelCommits as {
      label_revision: number
      app_revision: number
      commit_ms: number
      commit_duration_ms: number
    }[]
    const clockSyncs = runtime.clockSyncs as { index: number; page_now_ms: number }[]
    console.log(
      `Captured ${dispatches.length} dispatches, ${runtime.labelCommits.length} label commits, ${clockSyncs.length} clock syncs.`
    )

    const clockMapping = deriveClockMapping(traceEvents, clockSyncs, 'us')
    console.log(
      `Clock mapping: offset ${clockMapping.trace_to_page_offset_ms ?? 'unresolved'} ms over ${clockMapping.sample_count} samples (spread ${clockMapping.offset_spread_ms ?? 'n/a'} ms).`
    )

    // Diagnostics stay null unless the run actually measured them. GPU submit
    // completion is not sampled per input here, so it is recorded as absent
    // rather than filled with a constant.
    // Only dispatches caused by an observed browser input are measurement
    // inputs. Application-internal dispatches (document load, camera restore,
    // persistence) are retained in the artefact but must not be presented as
    // inputs that failed to produce a presentation.
    const inputDispatches = dispatches.filter((d) => d.input_origin_ms !== null)
    const nonInputDispatches = dispatches.filter((d) => d.input_origin_ms === null)
    console.log(
      `Input-originated dispatches: ${inputDispatches.length}; application-internal: ${nonInputDispatches.length}.`
    )

    // AC2 requires evidence for each of pan, zoom and drag. A scenario that
    // produced no observed input is a load-generation failure, not a result.
    const scenariosWithoutInput = (['pan', 'zoom', 'drag'] as const).filter(
      (scenario) => !inputDispatches.some((d) => d.scenario === scenario)
    )

    const correlationEvents: CorrelationEvent[] = inputDispatches.map((d) => ({
      input_id: d.input_id,
      scenario: d.scenario,
      input_origin_ms: d.input_origin_ms,
      app_revision: d.app_revision,
      canvas_revision: d.canvas_revision,
      label_revision_at_dispatch: d.label_revision_at_dispatch,
      label_revision: d.label_revision,
      label_commit_app_revision: d.label_commit_app_revision,
      label_commit_ms: d.label_commit_ms ?? null,
      cpu_work_duration_ms: d.cpu_work_ms,
      gpu_submit_duration_ms: null,
      raf_cadence_ms: rafCadenceMs,
    }))

    const baseProfile: Omit<CollectorProfile, 'hash'> = {
      version: 'gurow-collector-v3',
      contract_id: 'gurow-p1-v1',
      // Placeholder only; replaced below by the parsed verdict before hashing.
      status: 'NOT_MEASURED',
      identity,
      host: hostInfo,
      trace_configuration: {
        categories: traceCategories,
        parser_version: '3.0.0',
        clock_origin: 'chromium_trace_monotonic',
        clock_units: 'us',
        timestamp_scale_to_ms: 0.001,
        clock_mapping: clockMapping,
      },
      fault_injection: { enabled: false, app_delay_ms: 0, label_delay_ms: 0 },
      optical_requirements: getOpticalAcquisitionRequirements(),
    }

    // Parse first so the verdict comes from the evidence, then seal the profile.
    const provisional: CollectorProfile = {
      ...baseProfile,
      hash: computeProfileHash(baseProfile),
    }
    const parseResult = parseTraceEvidence(traceEvents, correlationEvents, provisional)
    console.log(`\nParser verdict: ${parseResult.verdict}`)
    if (parseResult.errors.length > 0) console.log('Parser errors:', parseResult.errors)
    if (parseResult.reasons.length > 0) {
      console.log('Parser findings:', [...new Set(parseResult.reasons)])
    }

    // AC4: compare the attributed endpoint across phases.
    const findPhase = (name: PhaseWindow['name']) =>
      phases.find((p) => p.name === name) as PhaseWindow
    const baselinePhase = findPhase('baseline')
    const appPhase = findPhase('app-delay')
    const labelPhase = findPhase('label-delay')

    const appDelayCheck: DelayCheckResult = verifyControlledDelayShift(
      phaseLatency(parseResult.chains, baselinePhase),
      phaseLatency(parseResult.chains, appPhase),
      80,
      30
    )
    const labelDelayCheck: DelayCheckResult = verifyControlledDelayShift(
      phaseLatency(parseResult.chains, baselinePhase),
      phaseLatency(parseResult.chains, labelPhase),
      80,
      35
    )
    console.log(`  App delay check:   ${appDelayCheck.status} — ${appDelayCheck.details}`)
    console.log(`  Label delay check: ${labelDelayCheck.status} — ${labelDelayCheck.details}`)

    const baselineCpu = phaseDiagnosticCpu(parseResult.chains, baselinePhase)
    const appCpu = phaseDiagnosticCpu(parseResult.chains, appPhase)
    const baselineCommitMs = phaseLabelCommitMs(labelCommits, baselinePhase)
    const labelPhaseCommitMs = phaseLabelCommitMs(labelCommits, labelPhase)
    const diagnosticShifts = {
      appDispatchShiftMs: baselineCpu !== null && appCpu !== null ? appCpu - baselineCpu : null,
      labelCommitShiftMs:
        baselineCommitMs !== null && labelPhaseCommitMs !== null
          ? labelPhaseCommitMs - baselineCommitMs
          : null,
      baselineLabelCommitMs: baselineCommitMs,
      delayedLabelCommitMs: labelPhaseCommitMs,
    }
    console.log(
      `  Label commit duration: baseline ${baselineCommitMs?.toFixed(2) ?? 'n/a'} ms -> delayed ${labelPhaseCommitMs?.toFixed(2) ?? 'n/a'} ms (proves whether the injected delay ran)`
    )

    // AC5: retain the parser's actual rejection output for each negative case,
    // rather than writing stubs that were never run through the parser.
    // Self-contained fixtures: these must exercise the parser deterministically
    // and must not depend on what the live run happened to capture, otherwise an
    // empty run would silently turn every negative case into a pass.
    const negativeBase: CorrelationEvent = {
      input_id: 'neg-1',
      scenario: 'pan',
      input_origin_ms: 1000,
      app_revision: 1,
      canvas_revision: 1,
      label_revision_at_dispatch: 0,
      label_revision: 1,
      label_commit_app_revision: 1,
      label_commit_ms: 1002,
      cpu_work_duration_ms: 2,
      gpu_submit_duration_ms: null,
      raf_cadence_ms: null,
    }
    const okTrace: TraceEvent[] = [
      { cat: 'viz', name: 'DrawFrame', ts: 1_000_000, ph: 'X', pid: 1, tid: 1 },
    ]

    // Explicit synthetic qualification-schema examples, never browser evidence.
    const coherentTrace: TraceEvent[] = [
      { name: 'gurow:app_dispatch:neg-1:1', ts: 1_000_000, ph: 'R', pid: 1, tid: 1 },
      { name: 'PresentationFeedback', ts: 1_016_000, ph: 'I', pid: 1, tid: 2, id: 'frame-1',
        args: { flags: 0x06, canvas_revision: 1, label_revision: 1,
          label_commit_app_revision: 1, presentation_timestamp: 1_016_000 } },
    ]
    const negativeProfile: CollectorProfile = {
      ...provisional,
      trace_configuration: { ...provisional.trace_configuration,
        clock_mapping: { ...clockMapping, trace_to_page_offset_ms: 0, offset_spread_ms: 0, sample_count: 5 } },
    }
    const negativeCases: {
      name: string; trace: TraceEvent[]; correlation: CorrelationEvent[]; unsupported?: boolean
    }[] = [
      { name: 'empty-trace', trace: [], correlation: [negativeBase] },
      {
        name: 'negative-timestamp',
        trace: [{ cat: 'input', name: 'MouseEvent', ts: -12345, ph: 'X', pid: 1, tid: 1 }],
        correlation: [negativeBase],
      },
      {
        name: 'misordered-timestamps',
        trace: [
          { cat: 'viz', name: 'DrawFrame', ts: 2_000_000, ph: 'X', pid: 1, tid: 1 },
          { cat: 'viz', name: 'DrawFrame', ts: 1_000_000, ph: 'X', pid: 1, tid: 1 },
        ],
        correlation: [negativeBase],
      },
      {
        name: 'duplicate-ids',
        trace: okTrace,
        correlation: [negativeBase, { ...negativeBase }],
      },
      {
        // Incoherent because the closing label commit never observed the
        // dispatched revision. A label revision merely ahead of the canvas
        // revision is legitimate and must not be rejected.
        name: 'revision-mismatch',
        trace: okTrace,
        correlation: [
          { ...negativeBase, app_revision: 5, canvas_revision: 5, label_commit_app_revision: 4 },
        ],
      },
      {
        name: 'label-revision-backwards',
        trace: okTrace,
        correlation: [{ ...negativeBase, label_revision_at_dispatch: 7, label_revision: 3 }],
      },
      {
        name: 'label-never-committed',
        trace: okTrace,
        correlation: [{ ...negativeBase, label_revision: null, label_commit_app_revision: null }],
      },
      { name: 'wrong-clock-units', trace: okTrace, correlation: [negativeBase] },
      { name: 'no-clock-mapping', trace: okTrace, correlation: [negativeBase] },
    ]

    for (const name of ['canvas-only', 'missing-frame', 'late-label', 'unrelated-paint',
      'fabricated-feedback', 'submission-only', 'new-labels-old-canvas']) {
      const trace = structuredClone(coherentTrace)
      const correlation = { ...negativeBase }
      if (name === 'canvas-only') delete trace[1].args!.label_revision
      if (name === 'missing-frame') delete trace[1].id
      if (name === 'late-label') correlation.label_commit_ms = 1017
      if (name === 'unrelated-paint') trace[1].args!.canvas_revision = 99
      if (name === 'fabricated-feedback') trace[1].args!.fabricated = true
      if (name === 'submission-only') trace[1].name = 'DisplayScheduler::DrawAndSwap'
      if (name === 'new-labels-old-canvas') correlation.label_commit_app_revision = 2
      negativeCases.push({ name, trace, correlation: [correlation], unsupported: true })
    }
    const acceptedNegativeCases: string[] = []
    for (const negative of negativeCases) {
      let caseProfile = negativeProfile
      if (negative.name === 'wrong-clock-units') {
        caseProfile = {
          ...negativeProfile,
          trace_configuration: { ...negativeProfile.trace_configuration, timestamp_scale_to_ms: 1 },
        }
      } else if (negative.name === 'no-clock-mapping') {
        caseProfile = {
          ...negativeProfile,
          trace_configuration: {
            ...negativeProfile.trace_configuration,
            clock_mapping: { ...negativeProfile.trace_configuration.clock_mapping, trace_to_page_offset_ms: null },
          },
        }
      }
      const result = parseTraceEvidence(negative.trace, negative.correlation, caseProfile)
      fs.writeFileSync(
        path.resolve(failedExamplesDir, `${negative.name}.json`),
        JSON.stringify(
          {
            case: negative.name,
            input: { trace: negative.trace, correlation: negative.correlation },
            parser_result: {
              valid: result.valid,
              verdict: result.verdict,
              errors: result.errors,
              reasons: [...new Set(result.reasons)],
              chains: result.chains,
            },
          },
          null,
          2
        )
      )
      const leakedEndpoint = result.chains.some((chain) =>
        chain.latency_ms !== null || chain.presentation_timestamp_ms !== null || chain.presented_frame_id !== null)
      if (negative.unsupported
        ? result.verdict !== 'UNSUPPORTED' || leakedEndpoint
        : result.valid) {
        acceptedNegativeCases.push(negative.name)
      }
    }

    for (const name of ['invalid-final-gate', 'invalid-profile-gate', 'app-delay-gate', 'label-delay-gate']) {
      const input = {
        profile: name === 'invalid-profile-gate' ? { ...provisional, hash: 'tampered' } : provisional,
        parsed: parseResult,
        appDelayCheck: name === 'app-delay-gate' ? verifyControlledDelayShift(16, 16, 80) : appDelayCheck,
        labelDelayCheck: name === 'label-delay-gate' ? verifyControlledDelayShift(16, 16, 80) : labelDelayCheck,
        invalidRunReasons: name === 'invalid-final-gate'
          ? ['Synthetic invalid-run finalization regression example.'] : [],
      }
      const result = finalizeQualification(input)
      fs.writeFileSync(path.resolve(failedExamplesDir, `${name}.json`), JSON.stringify({
        note: 'Fault-injected finalization example, not a separate browser attempt.', input, result,
      }, null, 2))
      if (result.profile.status !== 'NOT_MEASURED' || result.failures.length === 0) {
        acceptedNegativeCases.push(name)
      }
    }

    // Every validity/causality gate runs BEFORE publication or hashing.
    const invalidRunReasons = [
      ...deviceLossEvents.map((event) => `WebGPU device loss: ${event}`),
      ...pageErrors.map((error) => `Browser page error: ${error}`),
      ...acceptedNegativeCases.map((name) => `Negative case wrongly accepted: ${name}`),
      ...scenariosWithoutInput.map((scenario) => `No browser input observed for ${scenario}.`),
      ...(headless ? ['Headless execution is diagnostic only, not reference qualification.'] : []),
    ]
    const finalization = finalizeQualification({
      profile: provisional, parsed: parseResult, appDelayCheck, labelDelayCheck, invalidRunReasons,
    })
    const { profile, profileValidation } = finalization

    // Retain the real run's rejections alongside the constructed cases.
    if (parseResult.errors.length > 0 || parseResult.reasons.length > 0) {
      fs.writeFileSync(
        path.resolve(failedExamplesDir, 'observed-run-limitations.json'),
        JSON.stringify(
          {
            verdict: parseResult.verdict,
            errors: parseResult.errors,
            reasons: [...new Set(parseResult.reasons)],
          },
          null,
          2
        )
      )
    }

    // Raw traces: the full buffer, plus per-scenario slices cut by the real
    // scenario time windows rather than arbitrary indices.
    fs.writeFileSync(path.resolve(outDir, 'raw-trace.json'), JSON.stringify(traceEvents, null, 2))

    const offsetMs = clockMapping.trace_to_page_offset_ms
    for (const scenario of ['pan', 'zoom', 'drag'] as const) {
      const window = scenarioWindows[scenario]
      const slice =
        offsetMs === null
          ? []
          : traceEvents.filter((e) => {
              const pageMs = e.ts * 0.001 - offsetMs
              return pageMs >= window.start_ms && pageMs <= window.end_ms
            })
      fs.writeFileSync(
        path.resolve(outDir, `raw-trace-${scenario}.json`),
        JSON.stringify(
          {
            scenario,
            window_page_ms: window,
            clock_offset_ms: offsetMs,
            note:
              offsetMs === null
                ? 'Clock mapping unresolved; per-scenario slicing is not possible. See raw-trace.json.'
                : 'Events selected by mapped page-clock time inside the scenario window.',
            event_count: slice.length,
            events: slice,
          },
          null,
          2
        )
      )
    }

    fs.writeFileSync(
      path.resolve(outDir, 'collector-profile.json'),
      JSON.stringify(profile, null, 2)
    )

    const report = generateQualificationReport(profile, finalization.reasons, {
      scenariosTested: ['pan', 'zoom', 'drag'],
      chains: parseResult.chains,
      gpuAdapter: hostInfo.gpu_adapter,
      browserVersion: hostInfo.browser_version,
      appDelayCheck,
      labelDelayCheck,
      diagnosticShifts,
    })
    fs.writeFileSync(path.resolve(outDir, 'qualification-report.md'), report)

    fs.writeFileSync(
      path.resolve(outDir, 'qualification-report.json'),
      JSON.stringify(
        {
          contract_id: profile.contract_id,
          collector_version: profile.version,
          profile_hash: profile.hash,
          identity: profile.identity,
          verdict: profile.status,
          parser_errors: parseResult.errors,
          reasons: finalization.reasons,
          qualification_failures: finalization.failures,
          input_dispatch_count: inputDispatches.length,
          non_input_dispatch_count: nonInputDispatches.length,
          non_input_dispatches: nonInputDispatches,
          scenarios_without_observed_input: scenariosWithoutInput,
          device_loss_events: deviceLossEvents.slice(0, 20),
          device_loss_event_count: deviceLossEvents.length,
          page_errors: pageErrors.slice(0, 20),
          negative_cases_wrongly_accepted: acceptedNegativeCases,
          chains_count: parseResult.chains.length,
          chains_revision_matched: parseResult.chains.filter(
            (c) => c.frame_link === 'revision_matched'
          ).length,
          chains_with_latency: parseResult.chains.filter((c) => c.latency_ms !== null).length,
          clock_mapping: clockMapping,
          acceptance_profile_validation: profileValidation,
          scenario_windows: scenarioWindows,
          phases,
          controlled_delays: {
            app_delay_check: appDelayCheck,
            label_delay_check: labelDelayCheck,
            diagnostic_only_shifts: diagnosticShifts,
          },
          optical_requirements: profile.optical_requirements,
        },
        null,
        2
      )
    )

    console.log(`\nQualification report: ${path.resolve(outDir, 'qualification-report.md')}`)
    console.log(`Collector profile:    ${path.resolve(outDir, 'collector-profile.json')}`)

    // Assertions run only after every artefact is on disk, so a failed run
    // still leaves complete evidence behind (contract: preserve all attempts
    // and the reasons for invalidation).
    const failures = [...finalization.failures]
    if (expectVerdict && profile.status !== expectVerdict) {
      failures.push(
        `Verdict regression: expected ${expectVerdict} but the evidence produced ${profile.status}. ` +
          'Re-qualify and update the expected verdict deliberately.'
      )
    }

    if (failures.length > 0) {
      throw new Error(`Qualification checks failed:\n  - ${failures.join('\n  - ')}`)
    }

    console.log(`=== Qualification complete: ${profile.status} ===`)
  } finally {
    if (browser) await browser.close()
    server.kill('SIGTERM')
  }
}

main().catch((err) => {
  console.error('Qualification failed:', err)
  process.exit(1)
})
