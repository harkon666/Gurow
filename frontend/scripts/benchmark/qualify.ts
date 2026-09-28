/**
 * T06-L3-01 qualification driver.
 *
 * Drives one controlled pan, zoom and drag through real browser input on the
 * headed reference browser, derives a trace/page clock mapping, and reports
 * whichever verdict the evidence supports. The verdict is never predetermined:
 * an UNSUPPORTED result is a finding, and `--expect-verdict` turns an already
 * established finding into a regression check the harness can fail on.
 *
 * Artefact writing lives in `artifacts.ts`, the AC5 rejection fixtures in
 * `negativeCases.ts`, and the AC4 phase reducers in `phases.ts`; what remains
 * here is the observation sequence itself.
 */
import puppeteer, { type Page, type CDPSession } from 'puppeteer-core'
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
  getOpticalAcquisitionRequirements,
  validateReferenceEnvironment,
  isSoftwareAdapter,
  GUROW_INPUT_COALESCING,
  UNKNOWN,
  type CanvasGeometry,
  type CollectorProfile,
  type CorrelationEvent,
  type DelayCheckResult,
  type FaultInjectionConfig,
  type GeometryClass,
  type HostEnvironmentInfo,
  type SourceIdentity,
  type TraceEvent,
} from './collector'
import { finalizeQualification } from './qualification'
import { computeSourceFingerprint } from './sourceFingerprint'
import { phaseDiagnosticCpu, phaseLabelCommitMs, phaseLatency, type PhaseWindow } from './phases'
import { runNegativeCases } from './negativeCases'
import {
  traceConfiguration,
  writeObservedLimitations,
  writePreflightFailureArtifacts,
  writePreflightPass,
  writeRunArtifacts,
  COLLECTOR_VERSION,
  CONTRACT_ID,
  type ScenarioWindows,
} from './artifacts'
import {
  SCENARIOS,
  type BenchmarkHooks,
  type DispatchRecord,
  type LabelCommitRecord,
  type Scenario,
} from '../../src/components/editor/benchmarkHooks'

declare global {
  interface Window {
    __gurowBenchmarkHooks: BenchmarkHooks
  }
}

const REPO_ROOT = path.resolve(__dirname, '../../..')
const FRONTEND_DIR = path.resolve(REPO_ROOT, 'frontend')

interface DriverOptions {
  contractPath: string
  outDir: string
  port: number
  headless: boolean
  expectVerdict: string | null
  mode: QualificationMode
}

/**
 * What the run is trying to establish.
 *
 * `collector` qualifies the evidence chain on whatever window the desktop gives
 * it; `acceptance` additionally demands the reference geometry of contract §3.
 * Every other gate — hardware adapter, unobscured canvas, clock mapping,
 * disabled injection — applies to both.
 */
type QualificationMode = 'collector' | 'acceptance'

function parseArgs(argv: string[]): DriverOptions {
  const options: DriverOptions = {
    contractPath: path.resolve(REPO_ROOT, 'docs/benchmarks/p1/protocol.json'),
    outDir: path.resolve(REPO_ROOT, '.harness/t06/qualification'),
    port: 3465,
    headless: false,
    expectVerdict: null,
    mode: 'collector',
  }
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1]
    if (argv[i] === '--contract' && value) { options.contractPath = path.resolve(process.cwd(), value); i++ }
    else if (argv[i] === '--out' && value) { options.outDir = path.resolve(process.cwd(), value); i++ }
    else if (argv[i] === '--port' && value) { options.port = parseInt(value, 10); i++ }
    else if (argv[i] === '--expect-verdict' && value) { options.expectVerdict = value; i++ }
    else if (argv[i] === '--headless') { options.headless = true }
    else if (argv[i] === '--mode' && (value === 'collector' || value === 'acceptance')) {
      options.mode = value
      i++
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))

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

/** Records what the browser reports about itself, from its own command line. */
async function recordBrowserIdentity(host: HostEnvironmentInfo, cdp: CDPSession): Promise<void> {
  const version = await cdp.send('Browser.getVersion')
  const command = await cdp.send('Browser.getBrowserCommandLine')
  host.browser_version = version.product
  host.browser_command_line = command.arguments
  host.browser_executable = command.arguments[0] ?? UNKNOWN
  const ozone = [...command.arguments].reverse().find((arg) => arg.startsWith('--ozone-platform='))
  host.browser_backend = ozone ? `${ozone.split('=')[1]} / Ozone (actual browser command line)` : UNKNOWN
}

/**
 * Records the adapter the browser actually selected, and refuses software.
 *
 * The WebGPU fallback flag is not sufficient: Chromium leaves it unset for
 * SwiftShader, which would otherwise be recorded as a hardware run (AC1).
 */
async function recordSelectedAdapter(host: HostEnvironmentInfo, page: Page): Promise<void> {
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

  host.is_fallback = adapter.isFallback
  const parts = [adapter.vendor, adapter.architecture, adapter.device, adapter.description]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
  host.gpu_adapter = parts.length > 0 ? parts.join(' / ') : UNKNOWN

  if (isSoftwareAdapter(host.gpu_adapter)) {
    throw new Error(
      `AC1 Violation: software renderer '${host.gpu_adapter}' selected. ` +
        'Launch with Vulkan plus NVIDIA PRIME offload so a hardware adapter is used.'
    )
  }
  if (host.gpu_adapter === UNKNOWN) {
    console.warn(
      'WebGPU adapter reported no identifying fields; AC1 requires escalation for an unknown adapter.'
    )
  }
}

/** The CSS viewport contract §3 fixes for the reference environment. */
const REFERENCE_VIEWPORT = { width: 1200, height: 720 }

async function readViewport(page: Page) {
  return page.evaluate(() => ({
    width: innerWidth, height: innerHeight, outerWidth, outerHeight,
  }))
}

/** One window as the compositor itself reports it. */
interface CompositorWindow {
  address: string
  floating: boolean
  at: [number, number]
  size: [number, number]
}

/** Finds our own browser window in the compositor's client list, by pid. */
function compositorWindow(browserPid: number | undefined): CompositorWindow | null {
  if (browserPid === undefined) return null
  const clients = JSON.parse(tryExec('hyprctl clients -j') ?? '[]') as Array<
    CompositorWindow & { pid: number }
  >
  const client = clients.find((entry) => entry.pid === browserPid)
  return client ? { address: client.address, floating: client.floating, at: client.at, size: client.size } : null
}

/** The monitor the reference run must fit inside, in logical pixels. */
interface CompositorMonitor {
  name: string
  logical_width: number
  logical_height: number
  reserved: [number, number, number, number]
}

function compositorMonitor(name: string | null): CompositorMonitor | null {
  const monitors = JSON.parse(tryExec('hyprctl monitors -j') ?? '[]') as Array<{
    name: string; width: number; height: number; scale: number; reserved: number[]
  }>
  const monitor = monitors.find((entry) => entry.name === name) ?? monitors[0]
  if (!monitor) return null
  return {
    name: monitor.name,
    logical_width: monitor.width / monitor.scale,
    logical_height: monitor.height / monitor.scale,
    reserved: [monitor.reserved[0], monitor.reserved[1], monitor.reserved[2], monitor.reserved[3]],
  }
}

/**
 * Reports whether the reference headed configuration can fit this desktop.
 *
 * Contract §3 requires a geometry report rather than a measurement when it
 * cannot, so the arithmetic is stated: the window surface the browser needs is
 * the reference CSS viewport plus the app window's own measured chrome, and the
 * space it has is the monitor's logical size minus the compositor's reserved
 * area. The driver does not reconfigure the desktop to make room.
 */
async function assessWindowFeasibility(
  page: Page,
  browserPid: number | undefined,
  displayOutput: string | null
): Promise<string[]> {
  const window = compositorWindow(browserPid)
  const monitor = compositorMonitor(displayOutput)
  if (!window || !monitor) return []

  const view = await readViewport(page)
  const inset = { width: window.size[0] - view.width, height: window.size[1] - view.height }
  if (!(inset.width >= 0 && inset.height >= 0)) return []

  const required = {
    width: REFERENCE_VIEWPORT.width + inset.width,
    height: REFERENCE_VIEWPORT.height + inset.height,
  }
  const available = {
    width: monitor.logical_width - monitor.reserved[0] - monitor.reserved[2],
    height: monitor.logical_height - monitor.reserved[1] - monitor.reserved[3],
  }
  console.log(
    `  Window feasibility: needs ${required.width}×${required.height} logical ` +
      `(viewport ${REFERENCE_VIEWPORT.width}×${REFERENCE_VIEWPORT.height} + chrome ${inset.width}×${inset.height}), ` +
      `available ${available.width}×${available.height} on ${monitor.name}.`
  )
  if (required.width <= available.width && required.height <= available.height) return []

  return [
    `Reference headed configuration cannot fit this desktop: a ${REFERENCE_VIEWPORT.width}×${REFERENCE_VIEWPORT.height} ` +
      `CSS viewport needs a ${required.width}×${required.height} logical window surface (measured app chrome ` +
      `${inset.width}×${inset.height}), but ${monitor.name} offers ${available.width}×${available.height} after its ` +
      `reserved area [${monitor.reserved.join(', ')}] (contract §3). Escalate to measurement review; do not measure a ` +
      'clipped canvas and do not reconfigure the desktop to make room.',
  ]
}

/**
 * Settles the headed window and reports the geometry it actually got.
 *
 * In `acceptance` mode the exact reference window is required, and the browser
 * is asked to size itself. In `collector` mode the compositor's own layout is
 * accepted: this proves the evidence chain exists on this stack, and the profile
 * records `qualification_only` so it can never pass for an acceptance
 * environment. `Browser.setWindowBounds` is deliberately not used there — it is
 * a request, not a guarantee, and under a tiling compositor Chromium goes on
 * reporting the CSS viewport it was asked for while its Wayland surface stays
 * tiled, which would record a viewport the run never had.
 */
async function settleHeadedWindow(
  page: Page,
  cdp: CDPSession,
  browserPid: number | undefined,
  displayOutput: string | null,
  mode: QualificationMode
): Promise<string[]> {
  const errors: string[] = []
  const shortfall = await assessWindowFeasibility(page, browserPid, displayOutput)

  if (mode === 'acceptance') {
    errors.push(...shortfall)
    const initial = await readViewport(page)
    if (initial.width !== REFERENCE_VIEWPORT.width || initial.height !== REFERENCE_VIEWPORT.height) {
      console.log(
        `  Viewport ${initial.width}×${initial.height} as laid out; asking the browser to size its own window.`
      )
      const nativeWindow = await cdp.send('Browser.getWindowForTarget')
      try {
        await cdp.send('Browser.setWindowBounds', {
          windowId: nativeWindow.windowId,
          bounds: { windowState: 'normal' },
        })
        for (let attempt = 0; attempt < 3; attempt++) {
          const actual = await readViewport(page)
          if (actual.width === REFERENCE_VIEWPORT.width && actual.height === REFERENCE_VIEWPORT.height) break
          await cdp.send('Browser.setWindowBounds', {
            windowId: nativeWindow.windowId,
            bounds: {
              width: actual.outerWidth + REFERENCE_VIEWPORT.width - actual.width,
              height: actual.outerHeight + REFERENCE_VIEWPORT.height - actual.height,
            },
          })
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      } catch (error) {
        errors.push(`Native window sizing failed: ${String(error)}`)
      }
    }
  } else if (shortfall.length > 0) {
    console.log('  Collector qualification proceeds on the window the compositor laid out.')
  }

  await page.evaluate(() =>
    document.querySelector('#canvas-editor-container')?.scrollIntoView({ block: 'center' })
  )
  await new Promise((resolve) => setTimeout(resolve, 500))
  return errors
}

/** AC1: settled live geometry, visibility and backing sizes, read from the page. */
async function observeLiveGeometry(page: Page) {
  return page.evaluate(() => {
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
      available: {
        x: (screen as Screen & { availLeft: number }).availLeft,
        y: (screen as Screen & { availTop: number }).availTop,
        width: screen.availWidth,
        height: screen.availHeight,
      },
      visualScale: window.visualViewport?.scale ?? 0,
      documentVisible: document.visibilityState === 'visible', focused: document.hasFocus(),
      unobscured, labelsVisible: visible('[id^="card-label-"]'),
      listVisible: visible('[aria-label="Skill and Prerequisite List"]'),
      taskPanelVisible: visible('#skill-detail-panel'),
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      canvas: canvas && rect
        ? {
            css_bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            backing_size: { width: canvas.width, height: canvas.height },
          }
        : null,
    }
  })
}

/**
 * Corrects window and screen facts with what the compositor itself reports.
 *
 * On Hyprland, Wayland's `screenX`/`availHeight` may omit native desktop detail
 * such as position and reserved panel area.
 */
function observeNativeDesktop(host: HostEnvironmentInfo, browserPid: number | undefined): string[] {
  const errors: string[] = []
  try {
    const client = compositorWindow(browserPid)
    if (!client) {
      errors.push('Compositor reported no window for this browser; native geometry is unconfirmed (AC1).')
    }
    const monitors = JSON.parse(tryExec('hyprctl monitors -j') ?? '[]') as Array<{
      name: string; x: number; y: number; width: number; height: number; scale: number; reserved: number[]
    }>
    const monitor = monitors.find((entry) => entry.name === host.display_output)
    if (client && host.native_window) {
      Object.assign(host.native_window, {
        x: client.at[0], y: client.at[1], width: client.size[0], height: client.size[1],
      })
    }
    if (monitor && host.native_window) {
      Object.assign(host.native_window, {
        available_x: monitor.x + monitor.reserved[0],
        available_y: monitor.y + monitor.reserved[1],
        available_width: monitor.width / monitor.scale - monitor.reserved[0] - monitor.reserved[2],
        available_height: monitor.height / monitor.scale - monitor.reserved[1] - monitor.reserved[3],
      })
    }
  } catch (error) {
    errors.push(`Native desktop geometry observation failed: ${String(error)}`)
  }
  return errors
}

interface CanvasRect { x: number; y: number; width: number; height: number }

/** A label's id and centre, in CSS pixels. */
interface LabelTarget { id: string; cx: number; cy: number }

/**
 * Selects, through real pointer input, the card nearest the canvas centre.
 *
 * Contract §5 drags the selected centre card. The camera has already moved by
 * the time drag runs and `SetCamera` may not teleport it back, so the centre
 * card is re-selected here — outside any timed window — instead of dragging at a
 * coordinate the browser would discard.
 */
async function selectCentreCard(page: Page, canvas: CanvasRect): Promise<LabelTarget> {
  const centreX = canvas.x + canvas.width / 2
  const centreY = canvas.y + canvas.height / 2
  const nearest = await page.evaluate((rect: CanvasRect) => {
    const labels = Array.from(document.querySelectorAll<HTMLElement>('[id^="card-label-"]'))
    const cx = rect.x + rect.width / 2
    const cy = rect.y + rect.height / 2
    const inside = labels
      .map((element) => {
        const bounds = element.getBoundingClientRect()
        return { id: element.id, cx: bounds.x + bounds.width / 2, cy: bounds.y + bounds.height / 2 }
      })
      .filter((label) =>
        label.cx >= rect.x && label.cx <= rect.x + rect.width &&
        label.cy >= rect.y && label.cy <= rect.y + rect.height
      )
      .sort((a, b) => (a.cx - cx) ** 2 + (a.cy - cy) ** 2 - ((b.cx - cx) ** 2 + (b.cy - cy) ** 2))
    return { inside, total: labels.length }
  }, canvas)

  if (nearest.inside.length === 0) {
    throw new Error(
      `Drag geometry failure: none of ${nearest.total} card labels lie inside the canvas rect ` +
        `(x ${canvas.x.toFixed(1)}, y ${canvas.y.toFixed(1)}, ` +
        `w ${canvas.width.toFixed(1)}, h ${canvas.height.toFixed(1)}).`
    )
  }

  const target = nearest.inside[0]
  await page.mouse.click(target.cx, target.cy)
  await new Promise((resolve) => setTimeout(resolve, 250))

  const selected = await page.evaluate(
    (id: string) => document.getElementById(id)?.dataset.selected === 'true'
  , target.id)
  if (!selected) {
    throw new Error(`Selection failure: clicking ${target.id} did not mark it selected.`)
  }
  console.log(
    `  Selected centre card ${target.id} at (${target.cx.toFixed(1)}, ${target.cy.toFixed(1)}); ` +
      `canvas centre (${centreX.toFixed(1)}, ${centreY.toFixed(1)})`
  )
  return target
}

/**
 * Drives one scenario through real browser input only.
 *
 * Pan uses ordinary wheel input, zoom Ctrl+wheel at the canvas centre, and drag
 * an actual pointer down/move/up on the selected card, moving horizontally out
 * and back so the motion stays inside the clipped canvas rectangle (contract §5).
 */
async function driveScenario(
  page: Page,
  scenario: Scenario,
  canvas: CanvasRect,
  selectedCard: LabelTarget | null
): Promise<void> {
  await page.evaluate((active: Scenario | null) => {
    window.__gurowBenchmarkHooks.active_scenario = active
  }, scenario)

  const centreX = canvas.x + canvas.width / 2
  const centreY = canvas.y + canvas.height / 2

  if (scenario === 'pan') {
    await page.mouse.move(centreX, centreY)
    await page.mouse.wheel({ deltaX: 25, deltaY: 0 })
  } else if (scenario === 'zoom') {
    await page.mouse.move(centreX, centreY)
    await page.keyboard.down('Control')
    await page.mouse.wheel({ deltaX: 0, deltaY: -20 })
    await page.keyboard.up('Control')
  } else {
    if (!selectedCard) throw new Error('Drag requires the selected centre card, chosen before the window.')
    const target = selectedCard
    const excursion = Math.min(30, canvas.x + canvas.width - 2 - target.cx)
    if (!(excursion > 0)) {
      throw new Error(
        `Drag geometry failure: selected card ${target.id} leaves no horizontal room inside the canvas.`
      )
    }
    await page.mouse.move(target.cx, target.cy)
    await page.mouse.down()
    // Steps keep the intermediate pointermove events deliverable; out and back
    // is the contract's horizontal ± excursion at qualification scale.
    await page.mouse.move(target.cx + excursion, target.cy, { steps: 4 })
    await page.mouse.move(target.cx, target.cy, { steps: 4 })
    await page.mouse.up()
  }

  await new Promise((resolve) => setTimeout(resolve, 250))
  await page.evaluate(() => {
    window.__gurowBenchmarkHooks.active_scenario = null
  })
}

/** Emits paired clock-sync marks so the two clocks can be related. */
async function emitClockSyncs(page: Page, count: number): Promise<void> {
  await page.evaluate(async (n: number) => {
    const hooks = window.__gurowBenchmarkHooks
    for (let i = 0; i < n; i++) {
      const index = hooks.clock_syncs.length
      const pageNow = performance.now()
      performance.mark(`gurow:clock_sync:${index}`)
      hooks.clock_syncs.push({ index, page_now_ms: pageNow })
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }, count)
}

/**
 * Waits until the application stops dispatching on its own.
 *
 * The route emits repeated ResizeViewport commands while the canvas backing size
 * converges, and an input delivered during that churn can be lost.
 */
async function waitForDispatchQuiet(page: Page, quietFrames = 30): Promise<void> {
  await page.evaluate(
    (required: number) =>
      new Promise<void>((resolve) => {
        const hooks = window.__gurowBenchmarkHooks
        let quiet = 0
        let last = hooks.dispatches.length
        const tick = () => {
          const current = hooks.dispatches.length
          quiet = current === last ? quiet + 1 : 0
          last = current
          if (quiet >= required) {
            resolve()
            return
          }
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    quietFrames
  )
}

/** Samples rAF cadence once as a diagnostic, before the timed phases. */
async function sampleRafCadence(page: Page): Promise<number | null> {
  return page.evaluate(
    () =>
      new Promise<number | null>((resolve) => {
        const stamps: number[] = []
        const tick = (now: number) => {
          stamps.push(now)
          if (stamps.length < 20) {
            requestAnimationFrame(tick)
            return
          }
          const gaps = stamps.slice(1).map((stamp, i) => stamp - stamps[i])
          gaps.sort((a, b) => a - b)
          resolve(gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)] : null)
        }
        requestAnimationFrame(tick)
      })
  )
}

async function setInjectedDelays(page: Page, appDelayMs: number, labelDelayMs: number): Promise<void> {
  await page.evaluate(
    ({ app, label }: { app: number; label: number }) => {
      window.__gurowBenchmarkHooks.app_delay_ms = app
      window.__gurowBenchmarkHooks.label_delay_ms = label
    },
    { app: appDelayMs, label: labelDelayMs }
  )
}

/**
 * Reads back the fault-injection state the page is actually in (AC4).
 *
 * Observed, never asserted: the acceptance gate can only reject injection that
 * is still enabled if the profile records what the page reports.
 */
async function readFaultInjection(page: Page): Promise<FaultInjectionConfig> {
  const observed = await page.evaluate(() => {
    const hooks = window.__gurowBenchmarkHooks
    return {
      app_delay_ms: hooks.app_delay_ms,
      label_delay_ms: hooks.label_delay_ms,
      app_delays_applied: hooks.app_delays_applied,
      label_delays_applied: hooks.label_delays_applied,
    }
  })
  return {
    ...observed,
    enabled: observed.app_delay_ms > 0 || observed.label_delay_ms > 0,
  }
}

/** Reads the correlation log the instrumentation accumulated in the page. */
async function readRuntimeRecords(page: Page): Promise<{
  dispatches: DispatchRecord[]
  labelCommits: LabelCommitRecord[]
  clockSyncs: { index: number; page_now_ms: number }[]
}> {
  return page.evaluate(() => {
    const hooks = window.__gurowBenchmarkHooks
    return {
      dispatches: hooks.dispatches,
      labelCommits: hooks.label_commits,
      clockSyncs: hooks.clock_syncs,
    }
  })
}

async function main() {
  const { contractPath, outDir, port, headless, expectVerdict, mode } = options
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
  console.log(`Compositor: ${hostInfo.compositor}`)
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
    await recordBrowserIdentity(hostInfo, windowCdp)
    console.log(`Chromium: ${hostInfo.browser_version} (${hostInfo.browser_backend})`)

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
      window.__gurowBenchmarkHooks = {
        enabled: true,
        app_delay_ms: 0,
        label_delay_ms: 0,
        app_revision: 0,
        canvas_revision: 0,
        label_revision: 0,
        pending_inputs: [],
        dispatches: [],
        label_commits: [],
        clock_syncs: [],
        active_scenario: null,
        app_delays_applied: 0,
        label_delays_applied: 0,
      }
    })

    await page.goto(`${serverUrl}/`, { waitUntil: 'networkidle0' })
    await page.waitForSelector('canvas#editor-canvas', { timeout: 15000 })
    await page.waitForSelector('#card-label-skill-rust-basics', { timeout: 15000 })
    await page.waitForFunction(
      () => (window as unknown as { __gurowEditorReady?: boolean }).__gurowEditorReady === true,
      { timeout: 15000 }
    )

    await recordSelectedAdapter(hostInfo, page)

    const geometrySetupErrors = await settleHeadedWindow(
      page, windowCdp, browser.process()?.pid, hostInfo.display_output, mode
    )
    const settledWindow = await windowCdp.send('Browser.getWindowForTarget')
    const liveGeometry = await observeLiveGeometry(page)

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
    geometrySetupErrors.push(...observeNativeDesktop(hostInfo, browser.process()?.pid))

    // Derived from what was observed, never claimed: a run only carries
    // reference geometry when the window it actually got was the reference one.
    const geometryClass: GeometryClass =
      hostInfo.viewport_css?.[0] === REFERENCE_VIEWPORT.width &&
      hostInfo.viewport_css?.[1] === REFERENCE_VIEWPORT.height &&
      hostInfo.device_pixel_ratio === 1.5
        ? 'reference'
        : 'qualification_only'
    console.log(`Window geometry class: ${geometryClass}`)
    if (geometryClass === 'qualification_only' && mode === 'collector') {
      console.log(
        '  Collector qualification only: this evidence cannot serve as an acceptance environment.'
      )
    }

    const environmentErrors = [
      ...geometrySetupErrors,
      ...validateReferenceEnvironment(hostInfo, { requireReferenceGeometry: mode === 'acceptance' }),
    ]
    if (environmentErrors.length) {
      const failedProfile = writePreflightFailureArtifacts({
        outDir, identity, host: hostInfo, geometryClass,
        browserWindow: settledWindow, reasons: environmentErrors,
      })
      console.log(`Preflight profile hash: ${failedProfile.hash}`)
      throw new Error(`Headed environment preflight failed before capture: ${environmentErrors.join(' ')}`)
    }
    writePreflightPass({ outDir, identity, host: hostInfo, browserWindow: settledWindow })
    console.log(
      `Live geometry: ${liveGeometry.innerWidth}×${liveGeometry.innerHeight} CSS @ DPR ${liveGeometry.dpr}`
    )

    const rafCadenceMs = await sampleRafCadence(page)
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
    cdp.on('Tracing.dataCollected', (data: { value: TraceEvent[] }) => traceEvents.push(...data.value))
    await cdp.send('Tracing.start', { traceConfig: { includedCategories: traceCategories } })

    await emitClockSyncs(page, 5)
    await waitForDispatchQuiet(page)

    const canvasElement = await page.$('canvas#editor-canvas')
    const canvasBox = canvasElement ? await canvasElement.boundingBox() : null
    if (!canvasBox) throw new Error('Canvas bounding box not found.')
    console.log(
      `Canvas rect: x ${canvasBox.x.toFixed(1)}, y ${canvasBox.y.toFixed(1)}, ${canvasBox.width.toFixed(1)}×${canvasBox.height.toFixed(1)}`
    )

    // Selection and settling are setup, not measurement: the dispatches they
    // produce are retained as evidence but never presented as timed inputs.
    console.log('\nSelecting the centre card through real pointer input...')
    await selectCentreCard(page, canvasBox)
    const setupRecords = await readRuntimeRecords(page)
    const setupDispatchCount = setupRecords.dispatches.length

    const scenarioWindows = {} as ScenarioWindows
    const pageNow = () => page.evaluate(() => performance.now())
    for (const scenario of SCENARIOS) {
      console.log(`\nExecuting controlled ${scenario} interaction through browser input...`)
      // Re-selecting happens outside the window: pan and zoom have moved the
      // camera, and the selection click must not be timed as an interaction.
      const selectedCard = scenario === 'drag' ? await selectCentreCard(page, canvasBox) : null
      const start = await pageNow()
      await driveScenario(page, scenario, canvasBox, selectedCard)
      scenarioWindows[scenario] = { start_ms: start, end_ms: await pageNow() }
    }

    // AC4: controlled delay phases, driven through browser input so the timed
    // interaction never bypasses the real event path.
    console.log('\nRunning controlled delay phases (AC4)...')
    const phases: PhaseWindow[] = []
    const runPhase = async (name: PhaseWindow['name'], appDelayMs: number, labelDelayMs: number) => {
      await setInjectedDelays(page, appDelayMs, labelDelayMs)
      const start = await pageNow()
      await driveScenario(page, 'pan', canvasBox, null)
      await driveScenario(page, 'pan', canvasBox, null)
      phases.push({ name, scenario: 'pan', start_ms: start, end_ms: await pageNow() })
      console.log(`  Phase ${name} complete (app=${appDelayMs} ms, label=${labelDelayMs} ms).`)
    }

    await runPhase('baseline', 0, 0)
    await runPhase('app-delay', 80, 0)
    await runPhase('label-delay', 0, 80)

    // Fault injection must be off before the profile is built for acceptance.
    await setInjectedDelays(page, 0, 0)
    await emitClockSyncs(page, 5)
    const faultInjection = await readFaultInjection(page)
    console.log(
      `Fault injection read back: enabled=${faultInjection.enabled}, ` +
        `app delays executed=${faultInjection.app_delays_applied}, ` +
        `label delays executed=${faultInjection.label_delays_applied}`
    )

    console.log('\nStopping trace and collecting performance events...')
    const traceComplete = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve))
    await cdp.send('Tracing.end')
    await traceComplete
    console.log(`Captured ${traceEvents.length} raw trace events from Chromium.`)

    const runtime = await readRuntimeRecords(page)
    const setupDispatches = runtime.dispatches.slice(0, setupDispatchCount)
    const timedDispatches = runtime.dispatches.slice(setupDispatchCount)
    const labelCommits = runtime.labelCommits
    const clockSyncs = runtime.clockSyncs
    console.log(
      `Captured ${timedDispatches.length} timed dispatches (${setupDispatches.length} setup), ` +
        `${labelCommits.length} label commits, ${clockSyncs.length} clock syncs.`
    )

    const clockMapping = deriveClockMapping(traceEvents, clockSyncs, 'us')
    console.log(
      `Clock mapping: offset ${clockMapping.trace_to_page_offset_ms ?? 'unresolved'} ms over ${clockMapping.sample_count} samples (spread ${clockMapping.offset_spread_ms ?? 'n/a'} ms).`
    )

    // Only dispatches caused by an observed browser input are measurement
    // inputs. Application-internal dispatches (document load, camera restore,
    // persistence) are retained in the artefact but must not be presented as
    // inputs that failed to produce a presentation. GPU submit completion is
    // not sampled per input here, so it is recorded as absent rather than
    // filled with a constant.
    const inputDispatches = timedDispatches.filter((d) => d.input_origin_ms !== null)
    const nonInputDispatches = timedDispatches.filter((d) => d.input_origin_ms === null)
    console.log(
      `Input-originated dispatches: ${inputDispatches.length}; application-internal: ${nonInputDispatches.length}.`
    )

    // AC2 requires evidence for each of pan, zoom and drag. A scenario that
    // produced no observed input is a load-generation failure, not a result.
    const scenariosWithoutInput = SCENARIOS.filter(
      (scenario) => !inputDispatches.some((d) => d.scenario === scenario)
    )

    const correlationEvents: CorrelationEvent[] = inputDispatches.map((d) => ({
      input_id: d.input_id,
      scenario: d.scenario,
      coalesced_input_ids: d.coalesced_inputs.map((input) => input.input_id),
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
      version: COLLECTOR_VERSION,
      contract_id: CONTRACT_ID,
      // Placeholder only; replaced below by the parsed verdict before hashing.
      status: 'NOT_MEASURED',
      identity,
      host: hostInfo,
      geometry_class: geometryClass,
      trace_configuration: traceConfiguration(traceCategories, clockMapping),
      fault_injection: faultInjection,
      input_coalescing: GUROW_INPUT_COALESCING,
      optical_requirements: getOpticalAcquisitionRequirements(),
    }

    // Parse first so the verdict comes from the evidence, then seal the profile.
    const provisional: CollectorProfile = { ...baseProfile, hash: computeProfileHash(baseProfile) }
    const parseResult = parseTraceEvidence(traceEvents, correlationEvents, provisional)
    console.log(`\nParser verdict: ${parseResult.verdict}`)
    if (parseResult.errors.length > 0) console.log('Parser errors:', parseResult.errors)
    if (parseResult.reasons.length > 0) {
      console.log('Parser findings:', [...new Set(parseResult.reasons)])
    }

    // AC4: compare the attributed endpoint across phases.
    const findPhase = (name: PhaseWindow['name']) => phases.find((p) => p.name === name) as PhaseWindow
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
      `  Dispatch CPU duration: baseline ${baselineCpu?.toFixed(2) ?? 'n/a'} ms -> delayed ${appCpu?.toFixed(2) ?? 'n/a'} ms (proves whether the injected app delay ran)`
    )
    console.log(
      `  Label commit duration: baseline ${baselineCommitMs?.toFixed(2) ?? 'n/a'} ms -> delayed ${labelPhaseCommitMs?.toFixed(2) ?? 'n/a'} ms (proves whether the injected label delay ran)`
    )

    // AC5: run every rejection fixture through the real parser and finalizer.
    // The parser profile carries a resolved mapping so each case fails for its
    // own reason rather than for a missing clock mapping.
    const negativeCasesWronglyAccepted = runNegativeCases({
      parserProfile: {
        ...provisional,
        trace_configuration: {
          ...provisional.trace_configuration,
          clock_mapping: { ...clockMapping, trace_to_page_offset_ms: 0, offset_spread_ms: 0, sample_count: 5 },
        },
      },
      runProfile: provisional,
      parseResult,
      appDelayCheck,
      labelDelayCheck,
      failedExamplesDir,
    })

    // Every validity/causality gate runs BEFORE publication or hashing.
    const invalidRunReasons = [
      ...deviceLossEvents.map((event) => `WebGPU device loss: ${event}`),
      ...pageErrors.map((error) => `Browser page error: ${error}`),
      ...negativeCasesWronglyAccepted.map((name) => `Negative case wrongly accepted: ${name}`),
      ...scenariosWithoutInput.map((scenario) => `No browser input observed for ${scenario}.`),
      ...(headless ? ['Headless execution is diagnostic only, not reference qualification.'] : []),
    ]
    const finalization = finalizeQualification({
      profile: provisional, parsed: parseResult, appDelayCheck, labelDelayCheck, invalidRunReasons, mode,
    })
    const { profile, profileValidation } = finalization

    writeObservedLimitations(failedExamplesDir, parseResult)
    writeRunArtifacts({
      outDir,
      profile,
      parseResult,
      reasons: finalization.reasons,
      failures: finalization.failures,
      profileValidation,
      traceEvents,
      clockMapping,
      scenarioWindows,
      phases,
      appDelayCheck,
      labelDelayCheck,
      diagnosticShifts,
      faultInjection,
      setupDispatches,
      inputDispatchCount: inputDispatches.length,
      nonInputDispatches,
      scenariosWithoutInput: [...scenariosWithoutInput],
      deviceLossEvents,
      pageErrors,
      negativeCasesWronglyAccepted,
    })

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
