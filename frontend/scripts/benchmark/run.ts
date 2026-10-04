#!/usr/bin/env bun
/** T06-L3-03 headed, opt-in v2 capture. This is not an AC1 functional certification. */
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import puppeteer, { type Page, type CDPSession } from 'puppeteer-core'
import { computeBuildHash, resolveChromiumExecutable, waitForServerReady } from './browser'
import { computeSourceFingerprint } from './sourceFingerprint'
import { isSoftwareAdapter } from './collector'
import { BENCHMARK_SIZES, CONTRACT_IDS, fixtureStorageEntries, generateBenchmarkFixture, loadBenchmarkContract, motionAmplitudeCss, readFixtureFiles, requireRecipe, writeFixtureFiles, type BenchmarkContract, type BenchmarkFixture, type BenchmarkSize } from './fixture'
import { motionAt, nearestRank, pace, type Motion } from './scenarios'
import type { Protocol } from './report'
import { markdownSummary, summarizeTrace, type TraceSummary } from './trace-summary'
import type { Scenario } from '../../src/components/editor/benchmarkHooks'

const ROOT = path.resolve(import.meta.dir, '../../..')
const FRONTEND = path.join(ROOT, 'frontend')
const VERSION = 'gurow-p1-runner-v3'
/** Sanity captures run at a low rate so an injected delay cannot serialize the
 * 120 Hz schedule; the contract fixes the delay and shift, not this rate. */
const SANITY_CAPTURE = { active_ms: 2000, drain_ms: 2000, hz: 8 } as const
/** Upper bound for warm-up input to drain before the next seeded reload. */
const WARMUP_DRAIN_TIMEOUT_MS = 10000
/** Idle rAF may differ from the reported display refresh by at most this fraction. */
const REFRESH_TOLERANCE = 0.1
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.max(0, ms)))
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')
const git = (...args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()

export function acPowerOnline(powerSupplyRoot = '/sys/class/power_supply'): boolean {
  try {
    return readdirSync(powerSupplyRoot).some(name => {
      const supply = path.join(powerSupplyRoot, name)
      try {
        return readFileSync(path.join(supply, 'type'), 'utf8').trim() === 'Mains' &&
          readFileSync(path.join(supply, 'online'), 'utf8').trim() === '1'
      } catch { return false }
    })
  } catch { return false }
}

type ActiveWindow = { pid?: number; class?: string; at?: number[]; size?: number[] } | null
/** Hyprland's focused window, or null when the compositor cannot be asked. Asynchronous,
 * so polling it never blocks the Node thread that paces the 120 Hz schedule. */
function activeWindow(): Promise<ActiveWindow> {
  return new Promise(resolve => execFile('hyprctl', ['activewindow', '-j'], { encoding: 'utf8' }, (error, stdout) => {
    try { resolve(error ? null : JSON.parse(stdout)) } catch { resolve(null) }
  }))
}

/** Idle rAF cadence and the reported refresh rate agree within the tolerance. */
export function refreshAgrees(idleRafHz: number, displayHz: number, tolerance = REFRESH_TOLERANCE): boolean {
  return idleRafHz > 0 && displayHz > 0 && Math.abs(idleRafHz - displayHz) / displayHz <= tolerance
}

export interface WindowPlacement { screen_x: number; screen_y: number; outer_width: number; outer_height: number
  screen_width: number; screen_height: number; avail_left: number; avail_top: number }
/** The whole browser window lies inside the screen's available area, in the
 * same coordinates on Wayland (origin 0,0) and X11 (absolute, below the bar). */
export function windowFitsScreen(w: WindowPlacement): boolean {
  return w.screen_x >= w.avail_left && w.screen_y >= w.avail_top &&
    w.screen_x + w.outer_width <= w.avail_left + w.screen_width &&
    w.screen_y + w.outer_height <= w.avail_top + w.screen_height
}

/** Console text showing that WebGPU work failed while the renderer reported no error. */
export function isWebGpuFailure(text: string): boolean {
  return /Invalid (Texture|TextureView|CommandBuffer|Buffer)|device lost|VK_ERROR_/i.test(text)
}

/** Browser-delivered movement inputs, including no-ops the editor ignored;
 * the drag's pointerdown is not a scheduled request. */
export function deliveredCount(inputs: Array<{ event_type?: string }>, noOpInputs = 0): number {
  return inputs.filter(input => input.event_type !== 'pointerdown').length + noOpInputs
}

interface Options { size: BenchmarkSize | null; contract: string; out: string; port: number; headless: boolean; diagnostic: boolean; trace: boolean }
function args(argv: string[]): Options {
  const parsed: Options = { size: null, contract: path.join(ROOT, 'docs/benchmarks/p1/protocol-v5.json'), out: path.join(ROOT, '.harness/t06/primary'), port: 3475, headless: false, diagnostic: false, trace: false }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--size' || flag === '--port' || flag === '--contract' || flag === '--out') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`)
      if (flag === '--size') parsed.size = Number(value) as BenchmarkSize
      if (flag === '--port') parsed.port = Number(value)
      if (flag === '--contract') parsed.contract = path.resolve(value)
      if (flag === '--out') parsed.out = path.resolve(value)
    } else if (flag === '--headless') { parsed.headless = true; parsed.diagnostic = true }
    else if (flag === '--diagnostic') parsed.diagnostic = true
    else if (flag === '--trace') { parsed.trace = true; parsed.diagnostic = true }
    else throw new Error(`Unknown option ${flag}`)
  }
  if ((parsed.size !== null && !BENCHMARK_SIZES.includes(parsed.size)) || !Number.isSafeInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535) throw new Error('Unsupported size or port')
  return parsed
}

/** Installed before every navigation; no benchmark work is performed by the app otherwise. */
async function installHooks(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    // Observe the application's own WebGPU adapter request rather than making
    // a second request that could select the other GPU on dual-GPU laptops.
    const gpu = navigator.gpu
    if (gpu) {
      const request = gpu.requestAdapter.bind(gpu)
      gpu.requestAdapter = async (options) => {
        const adapter = await request(options)
        if (adapter) {
          const info = adapter.info
          ;(window as any).__gurowEditorAdapter = {
            vendor: info?.vendor ?? '', architecture: info?.architecture ?? '',
            device: info?.device ?? '', description: info?.description ?? '',
            fallback: (info as GPUAdapterInfo & { isFallbackAdapter?: boolean })?.isFallbackAdapter ??
              (adapter as GPUAdapter & { isFallbackAdapter?: boolean }).isFallbackAdapter ?? null,
            power_preference: options?.powerPreference ?? 'none',
          }
          const requestDevice = adapter.requestDevice.bind(adapter)
          adapter.requestDevice = async (...args) => {
            const device = await requestDevice(...args)
            device.lost.then(reason => { (window as any).__gurowDeviceLost = String(reason.message || reason.reason) })
            return device
          }
        }
        return adapter
      }
    }
    ;(window as any).__gurowBenchmarkHooks = {
      enabled: true, app_delay_ms: 0, label_delay_ms: 0,
      app_revision: 0, canvas_revision: 0, label_revision: 0,
      pending_inputs: [], inputs: [], dispatches: [], label_commits: [], frames: [], input_samples: [], clock_syncs: [],
      active_scenario: null, app_delays_applied: 0, label_delays_applied: 0, next_input_index: 0,
    }
  })
}
async function ready(page: Page, count: number): Promise<void> {
  try {
    await page.waitForFunction(n => {
      const w = window as any
      if (document.getElementById('editor-gpu-error-notice') || document.getElementById('checkpoint-error-alert')) return true
      return w.__gurowEditorReady === true && document.querySelectorAll('#labels-overlay [id^="card-label-"]').length === n
    }, { timeout: count > 1000 ? 180000 : 30000, polling: 250 }, count)
  } catch (error) {
    const status = await page.evaluate(() => ({ ready: (window as any).__gurowEditorReady,
      hooks: !!(window as any).__gurowBenchmarkHooks, adapter: (window as any).__gurowEditorAdapter,
      gpu: document.getElementById('editor-gpu-error-notice')?.textContent,
      labels: document.querySelectorAll('#labels-overlay [id^="card-label-"]').length,
      text: document.body?.innerText.slice(0, 300) }))
    throw new Error(`Editor readiness failed for ${count}: ${JSON.stringify(status)}; ${String(error)}`)
  }
  const state = await page.evaluate(() => ({ ready: (window as any).__gurowEditorReady, gpu: document.getElementById('editor-gpu-error-notice')?.textContent, checkpoint: document.getElementById('checkpoint-error-alert')?.textContent }))
  if (!state.ready || state.gpu || state.checkpoint) throw new Error(`Fixture route failed: ${JSON.stringify(state)}`)
}
async function seed(page: Page, url: string, fixture: BenchmarkFixture): Promise<void> {
  await page.evaluate(entries => { localStorage.clear(); for (const [key, value] of entries) localStorage.setItem(key, value) }, fixtureStorageEntries(fixture))
  await page.goto(`${url}/editor`, { waitUntil: 'domcontentloaded' })
  await ready(page, fixture.size)
  const checkpointKey = fixtureStorageEntries(fixture)[0][0]
  const stored = await page.evaluate(key => localStorage.getItem(key), checkpointKey)
  if (!stored || hash(stored) !== fixture.manifest.checkpoint_hash) throw new Error('Route checkpoint read-back differs from fixture hash')
  const id = fixture.manifest.geometry.center_card.id
  const observed = await page.evaluate((expected) => ({
    count: document.querySelectorAll('#skill-prerequisite-list [id^="skill-list-item-"]').length,
    center: !!document.getElementById(`card-label-${expected}`),
    labels: document.querySelectorAll('#labels-overlay [id^="card-label-"]').length,
  }), id)
  if (observed.count !== fixture.size || observed.labels !== fixture.size || !observed.center) throw new Error(`Fixture route identity mismatch: ${JSON.stringify(observed)}`)
  const rect = await page.$eval(`#card-label-${id}`, el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
  await page.mouse.click(rect.x, rect.y)
  await page.waitForFunction(skill => document.getElementById('selected-skill-id')?.textContent?.trim() === skill && !!document.querySelector('[id^="task-edit-title-"]'), { timeout: 15000 }, id)
  const expectedTask = fixture.checkpoint.application.skills.find(skill => skill.id === id)?.tasks[0]
  if (!expectedTask) throw new Error('Center Skill has no fixture Task')
  const actualTask = await page.$eval(`#task-edit-title-${expectedTask.id}`, el => (el as HTMLInputElement).value)
  if (actualTask !== expectedTask.title) throw new Error('Selected Task does not match the fixture payload')
}
interface Visibility { time_ms: number; visible_cards: number; visible_labels: number; submitted_cards: number | null; canvas: { x: number; y: number; width: number; height: number; backing_width: number; backing_height: number }; focused: boolean; visible: boolean; gpu_error: string | null; task_panel: boolean
  /** Time since the last recorded rAF while the page still answers; a diagnostic, not a gate. */
  raf_age_ms: number | null
  /** Hyprland's focused window is this browser; null outside a sampled run. */
  browser_active?: boolean | null }
async function visibility(page: Page): Promise<Visibility> {
  return page.evaluate(() => {
    const canvas = document.getElementById('editor-canvas') as HTMLCanvasElement
    const b = canvas.getBoundingClientRect()
    const labels = [...document.querySelectorAll('#labels-overlay [id^="card-label-"]')] as HTMLElement[]
    const overlay = document.getElementById('labels-overlay')!.getBoundingClientRect()
    const intersects = (x: number, y: number, w: number, h: number) => Math.min(x + w, b.right) > Math.max(x, b.left) && Math.min(y + h, b.bottom) > Math.max(y, b.top)
    const count = document.getElementById('editor-card-count')?.textContent?.match(/(\d+)/)
    // Labels carry engine world bounds; the camera container's transform maps them to engine screen rects.
    const camera = new DOMMatrixReadOnly(getComputedStyle(document.getElementById('labels-camera')!).transform)
    return {
      time_ms: performance.now(),
      visible_cards: labels.filter(el => { const s = el.style; return intersects(overlay.left + camera.e + parseFloat(s.left) * camera.a, overlay.top + camera.f + parseFloat(s.top) * camera.d, parseFloat(s.width) * camera.a, parseFloat(s.height) * camera.d) }).length,
      visible_labels: labels.filter(el => { const r = el.getBoundingClientRect(); return intersects(r.left, r.top, r.width, r.height) }).length,
      submitted_cards: count ? Number(count[1]) : null,
      canvas: { x: b.x, y: b.y, width: b.width, height: b.height, backing_width: canvas.width, backing_height: canvas.height },
      focused: document.hasFocus(), visible: document.visibilityState === 'visible',
      gpu_error: document.getElementById('editor-gpu-error-notice')?.textContent?.trim() ?? null,
      task_panel: !!document.getElementById('selected-skill-id') && !!document.querySelector('[id^="task-edit-title-"]'),
      raf_age_ms: (() => { const last = (window as any).__gurowBenchmarkHooks?.last_frame_ms; return typeof last === 'number' ? performance.now() - last : null })(),
    }
  })
}
interface CaptureWindow { start: number; end: number; drain: number }
/** Resets the in-page evidence; a missing window marks warm-up/setup input as unmeasured. */
async function hook(page: Page, scenario: Scenario, appDelay: number, labelDelay: number, refreshHz: number, capture?: CaptureWindow): Promise<void> {
  await page.evaluate(({ scenario, appDelay, labelDelay, refreshHz, capture }) => {
    const h = (window as any).__gurowBenchmarkHooks
    if (!h?.enabled) throw new Error('In-page benchmark hooks unavailable')
    h.active_scenario = scenario; h.app_delay_ms = appDelay; h.label_delay_ms = labelDelay
    h.pending_inputs = []; h.inputs = []; h.dispatches = []; h.label_commits = []; h.frames = []; h.input_samples = []; h.next_input_index = 0
    h.app_delays_applied = 0; h.label_delays_applied = 0; h.last_frame_ms = undefined; h.no_op_inputs = 0
    h.capture_start_ms = capture?.start ?? null; h.capture_end_ms = capture?.end ?? null; h.drain_end_ms = capture?.drain ?? null; h.refresh_hz = refreshHz
  }, { scenario, appDelay, labelDelay, refreshHz, capture: capture ?? null })
}

/** One real browser input for the scenario; pan and zoom are wheel input, drag is pointer movement. */
function sendMotion(cdp: CDPSession, scenario: Scenario, point: Motion): Promise<unknown> {
  return scenario === 'drag'
    ? cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'left', buttons: 1 })
    : cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: point.delta_x!, deltaY: point.delta_y!, modifiers: point.modifiers ?? 0 })
}

interface ScenarioMotion { anchor: { x: number; y: number }; amplitude: number; zoomMin: number; zoomMax: number }
/** Drag grabs the selected centre card; wheel scenarios act at the canvas centre. */
async function scenarioMotion(page: Page, scenario: Scenario, fixture: BenchmarkFixture, contract: BenchmarkContract): Promise<ScenarioMotion> {
  const centre = await page.$eval(`#card-label-${fixture.manifest.geometry.center_card.id}`, el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
  const { canvas } = await visibility(page)
  return {
    anchor: scenario === 'drag' ? centre : { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 },
    amplitude: motionAmplitudeCss(fixture.manifest.geometry, contract.motion),
    zoomMin: contract.motion.zoom_min_factor, zoomMax: contract.motion.zoom_max_factor,
  }
}

/** Sends the scheduled motion without awaiting acknowledgement, so CDP never serializes the schedule. */
function drive(cdp: CDPSession, scenario: Scenario, motion: ScenarioMotion, start: number, durationMs: number, hz: number, errors: string[], label: string) {
  const requests: Promise<unknown>[] = []
  const delivery = pace({ start_ms: start, duration_ms: durationMs, hz }, () => performance.now(), wait, async k => {
    const point = motionAt(scenario, k * 1000 / hz, (k - 1) * 1000 / hz, motion.anchor, motion.amplitude, motion.zoomMin, motion.zoomMax)
    requests.push(sendMotion(cdp, scenario, point).catch(error => { errors.push(`${label} CDP: ${String(error)}`) }))
  })
  return { delivery, requests }
}

interface Settings { warmup_ms: number; hz: number; refresh_hz: number }

/** Diagnostic profile (#42): a shorter warm-up, then a traced window of the same scheduled input. Never acceptance evidence. */
const TRACE_WARMUP_MS = 3000
const TRACE_ACTIVE_MS = 5000
const TRACE_CATEGORIES = ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame',
  'blink.user_timing', 'toplevel', 'v8.execute', 'disabled-by-default-v8.cpu_profiler']

async function traceScenario(page: Page, cdp: CDPSession, scenario: Scenario, fixture: BenchmarkFixture, contract: BenchmarkContract, hz: number, file: string): Promise<TraceSummary> {
  const errors: string[] = []
  const motion = await scenarioMotion(page, scenario, fixture, contract)
  await page.evaluate(() => { (window as any).__gurowBenchmarkHooks.trace_stages = true })
  let tracing = false
  try {
    if (scenario === 'drag') await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: motion.anchor.x, y: motion.anchor.y, button: 'left', buttons: 1, clickCount: 1 })
    await page.tracing.start({ path: file, categories: TRACE_CATEGORIES })
    tracing = true
    const { delivery, requests } = drive(cdp, scenario, motion, performance.now() + 50, TRACE_ACTIVE_MS, hz, errors, 'trace')
    await delivery
    await Promise.race([Promise.all(requests), wait(WARMUP_DRAIN_TIMEOUT_MS)])
  } finally {
    // Never leave tracing, a pressed button or stage measures behind for the next scenario.
    if (tracing) await page.tracing.stop()
    if (scenario === 'drag') await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: motion.anchor.x, y: motion.anchor.y, button: 'left', buttons: 0, clickCount: 1 })
    await page.evaluate(() => { (window as any).__gurowBenchmarkHooks.trace_stages = false })
  }
  if (errors.length) throw new Error(`${scenario} trace input errors: ${errors.join('; ')}`)
  return summarizeTrace(JSON.parse(readFileSync(file, 'utf8')))
}

/** Contract §5 warm-up: identical real CDP input outside any measured window. */
async function warmUp(page: Page, cdp: CDPSession, scenario: Scenario, fixture: BenchmarkFixture, contract: BenchmarkContract, settings: Settings): Promise<{ warmup_end_ms: number; errors: string[] }> {
  const errors: string[] = []
  const onError = (error: unknown) => { errors.push(String(error)) }
  page.on('pageerror', onError)
  try {
    const motion = await scenarioMotion(page, scenario, fixture, contract)
    await hook(page, scenario, 0, 0, settings.refresh_hz)
    if (scenario === 'drag') await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: motion.anchor.x, y: motion.anchor.y, button: 'left', buttons: 1, clickCount: 1 })
    const { delivery, requests } = drive(cdp, scenario, motion, performance.now() + 50, settings.warmup_ms, settings.hz, errors, 'warmup')
    await delivery
    // Let the warm-up input drain before the next seeded reload; this interval
    // is outside the measured window and cannot validate a bad run.
    await Promise.race([Promise.all(requests), wait(WARMUP_DRAIN_TIMEOUT_MS).then(() => { errors.push('warmup CDP requests timed out') })])
    if (scenario === 'drag') await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: motion.anchor.x, y: motion.anchor.y, button: 'left', buttons: 0, clickCount: 1 })
    await page.evaluate(() => { (window as any).__gurowBenchmarkHooks.active_scenario = null })
    return { warmup_end_ms: performance.now(), errors }
  } finally {
    page.off('pageerror', onError)
  }
}

interface MeasureConfig { active_ms: number; drain_ms: number; hz: number; refresh_hz: number; app_delay_ms: number; label_delay_ms: number
  /** Acceptance runs must have injection off; sanity captures deliberately enable it. */
  acceptance: boolean; minimum_sent_fraction: number; visible_band: { min: number; max: number } | null
  /** Whether the compositor still shows this browser; null when not applicable (headless). */
  browser_active: () => Promise<boolean | null> }

async function measured(page: Page, cdp: CDPSession, scenario: Scenario, fixture: BenchmarkFixture, contract: BenchmarkContract, config: MeasureConfig): Promise<any> {
  const sample = async (): Promise<Visibility> => { const [v, active] = await Promise.all([visibility(page), config.browser_active()]); return { ...v, browser_active: active } }
  const samples: Visibility[] = [await sample()]
  const errors: string[] = []
  const onError = (e: unknown) => { errors.push(String(e)) }
  const onConsole = (m: { text(): string }) => { if (isWebGpuFailure(m.text())) errors.push(`WebGPU: ${m.text().slice(0, 200)}`) }
  page.on('pageerror', onError)
  page.on('console', onConsole)
  let periodic: ReturnType<typeof setInterval> | undefined
  try {
    const motion = await scenarioMotion(page, scenario, fixture, contract)
    const start = performance.now() + 250
    const pageNow = await page.evaluate(() => performance.now())
    const pageStart = pageNow + start - performance.now()
    const capture = { start: pageStart, end: pageStart + config.active_ms, drain: pageStart + config.active_ms + config.drain_ms }
    await hook(page, scenario, config.app_delay_ms, config.label_delay_ms, config.refresh_hz, capture)
    await page.evaluate(() => {
      const h = (window as any).__gurowBenchmarkHooks
      const log: any[] = []
      const record = () => log.push({ at_ms: performance.now(), focused: document.hasFocus(), visible: document.visibilityState })
      document.addEventListener('visibilitychange', record)
      window.addEventListener('focus', record)
      window.addEventListener('blur', record)
      h.focus_events = log
      record()
    })
    // 2 Hz visibility, including whether the compositor still shows this browser:
    // an occluded Wayland window stops rAF while visibilityState stays visible.
    periodic = setInterval(() => { void sample().then(v => samples.push(v)).catch(e => errors.push(`visibility: ${e}`)) }, 500)
    if (scenario === 'drag') await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: motion.anchor.x, y: motion.anchor.y, button: 'left', buttons: 1, clickCount: 1 })
    const { delivery: pending, requests } = drive(cdp, scenario, motion, start, config.active_ms, config.hz, errors, 'CDP dispatch')
    const delivery = await pending
    await wait(Math.max(0, start + config.active_ms + config.drain_ms - performance.now()))
    let acknowledgementsComplete = false
    await Promise.race([Promise.all(requests).then(() => { acknowledgementsComplete = true }), wait(config.drain_ms)])
    // Unacknowledged requests after drain are browser-side backlog behind a busy
    // app (backpressure), recorded as such; a rejected request is still an error.
    if (scenario === 'drag') await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: motion.anchor.x, y: motion.anchor.y, button: 'left', buttons: 0, clickCount: 1 })
    clearInterval(periodic); periodic = undefined
    samples.push(await sample())
    const raw = await page.evaluate(() => {
      const h = (window as any).__gurowBenchmarkHooks
      // A stalled rAF never reaches the deadline itself; the editor's seal keeps
      // the open stall and charges unresolved inputs, never discarding a tail.
      const sealed = typeof h.seal === 'function'
      if (sealed) h.seal()
      return { sealed, inputs: h.inputs, pending_inputs: h.pending_inputs, dispatches: h.dispatches, label_commits: h.label_commits, frames: h.frames, input_samples: h.input_samples, no_op_inputs: h.no_op_inputs ?? 0, focus_events: h.focus_events, device_lost: (window as any).__gurowDeviceLost ?? null, app_delays_applied: h.app_delays_applied, label_delays_applied: h.label_delays_applied, capture_start_ms: h.capture_start_ms, capture_end_ms: h.capture_end_ms, drain_end_ms: h.drain_end_ms, refresh_hz: h.refresh_hz, app_delay_ms: h.app_delay_ms, label_delay_ms: h.label_delay_ms }
    })
    // Chromium can add pointer moves when content shifts under the cursor, so
    // page observations are capped at the requests the driver sent.
    const observed = deliveredCount(raw.inputs ?? [], raw.no_op_inputs)
    const delivered = Math.min(observed, delivery.sent)
    const reasons: string[] = []
    if (!raw.sealed) reasons.push('editor_capture_seal_missing')
    if (delivery.sent < delivery.scheduled * config.minimum_sent_fraction) reasons.push('insufficient_sent_inputs')
    if (errors.length || delivery.errors.length) reasons.push('page_or_cdp_error')
    if (samples.some(v => !v.focused || !v.visible || v.browser_active === false) || raw.focus_events?.some((e: any) => !e.focused || e.visible !== 'visible')) reasons.push('focus_or_visibility_loss')
    if (samples.some(v => !!v.gpu_error) || raw.device_lost) reasons.push('gpu_device_error')
    if (samples.some(v => !v.task_panel || v.submitted_cards !== fixture.size || v.visible_labels === 0)) reasons.push('labels_list_or_sidebar_missing')
    const visibleMedian = nearestRank(samples.map(s => s.visible_cards), .5)
    if (config.visible_band && (visibleMedian === null || visibleMedian < config.visible_band.min || visibleMedian > config.visible_band.max)) reasons.push('visible_card_median_out_of_band')
    if (!Array.isArray(raw.frames) || raw.frames.length < 2 || !Array.isArray(raw.input_samples) || !raw.input_samples.length) reasons.push('missing_in_app_frame_or_proxy_evidence')
    if (config.acceptance && (raw.app_delay_ms || raw.label_delay_ms)) reasons.push('injection_enabled_in_acceptance')
    const frameIntervals = raw.frames?.map((f: any) => f.frame_interval_ms).filter((n: unknown) => typeof n === 'number' && Number.isFinite(n)) ?? []
    const inputSamples = raw.input_samples ?? []
    const rafAges = samples.map(v => v.raf_age_ms).filter((v): v is number => typeof v === 'number')
    return { scenario, windows: { active_start_ms: capture.start, active_end_ms: capture.end, drain_end_ms: capture.drain }, scheduled: delivery.scheduled, sent: delivery.sent, cdp_missed: delivery.missed, cdp_errors: delivery.errors, cdp_unacknowledged_after_drain: !acknowledgementsComplete, delivered, observed_inputs: observed, no_op_inputs: raw.no_op_inputs,
      frame_interval_ms: frameIntervals, input_to_frame_proxy_ms: inputSamples.map((s: any) => s.proxy_ms), input_to_frame_raw_ms: inputSamples.map((s: any) => s.raw_ms),
      captured_input_ids: raw.inputs?.map((input: any) => input.input_id) ?? [], captured_sample_ids: inputSamples.map((s: any) => s.input_id),
      visibility: samples.map(v => ({ time_ms: v.time_ms, visible_cards: v.visible_cards, dom_labels: v.visible_labels, submitted_primitives: v.submitted_cards })), visibility_detail: samples,
      max_raf_age_while_responsive_ms: rafAges.length ? Math.max(...rafAges) : null,
      tab_visible: !samples.some(v => !v.visible) && !raw.focus_events?.some((e: any) => e.visible !== 'visible'),
      tab_focused: !samples.some(v => !v.focused || v.browser_active === false) && !raw.focus_events?.some((e: any) => !e.focused), device_lost: samples.some(v => !!v.gpu_error) || !!raw.device_lost, page_errors: errors,
      delays_enabled: !!(raw.app_delay_ms || raw.label_delay_ms), median_visible_cards: visibleMedian, errors, invalid_reasons: reasons, injection: { app_delay_ms: config.app_delay_ms, label_delay_ms: config.label_delay_ms }, raw }
  } finally {
    if (periodic) clearInterval(periodic)
    page.off('pageerror', onError)
    page.off('console', onConsole)
  }
}

function artifact(out: string, name: string, value: unknown, role: string) {
  const body = JSON.stringify(value, null, 2) + '\n'
  writeFileSync(path.join(out, name), body)
  return { path: name, sha256: hash(body), role }
}

async function main(): Promise<number> {
  const options = args(process.argv.slice(2))
  const protocolBytes = readFileSync(options.contract)
  const protocol = JSON.parse(protocolBytes.toString()) as Protocol
  if (!(CONTRACT_IDS as readonly string[]).includes(protocol.contract_id) || protocol.report_schema !== 'gurow-p1-report-v4') throw new Error('Runner requires protocol-v5.json or protocol-v4.json')
  // The fixture schema pins the same contract IDs, so a v1 protocol fails here too.
  const fixtureContract = loadBenchmarkContract(options.contract)
  // Default to the contract's primary; any other size can never qualify the gate.
  options.size ??= fixtureContract.primary_size
  requireRecipe(fixtureContract, options.size)
  if (options.size !== fixtureContract.primary_size) options.diagnostic = true
  const size = options.size
  const sampling = protocol.sampling
  mkdirSync(options.out, { recursive: true })
  execFileSync('bun', ['run', 'build'], { cwd: FRONTEND, stdio: 'inherit' })
  const buildHash = computeBuildHash(FRONTEND)
  if (!buildHash) throw new Error('Production build missing')
  const chromium = resolveChromiumExecutable()
  // Headed flag trial on Hyprland + NVIDIA (2026-09-30): native Wayland with
  // ANGLE-on-Vulkan displays nothing, and native Wayland with the GL compositor
  // hands WebGPU an invalid canvas texture every frame, so nothing is drawn.
  // ANGLE-on-Vulkan through XWayland displays the WebGPU canvas without errors.
  // The headless diagnostic uses the same ANGLE path as the T05 browser check.
  const browserFlags = ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-webgpu', '--disable-dev-shm-usage', '--window-size=1600,900',
    ...(options.headless ? ['--use-gl=angle'] : ['--enable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE', '--use-angle=vulkan', '--ozone-platform=x11'])]
  // Omarchy exports GDK_SCALE=2 for XWayland apps; Chromium's X11 backend would
  // turn it into DPR 2 at compositor scale 1. The recorded DPR stays the actual one.
  const browserEnv = { ...process.env, GDK_SCALE: '1' }
  const server = spawn('node', ['.output/server/index.mjs'], { cwd: FRONTEND, env: { ...process.env, PORT: String(options.port) }, stdio: 'ignore' })
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined
  const url = `http://127.0.0.1:${options.port}`
  const artifacts: ReturnType<typeof artifact>[] = []
  const runs: any[] = []
  const sanity: any[] = []
  try {
    await waitForServerReady(url)
    browser = await puppeteer.launch({ executablePath: chromium, headless: options.headless, defaultViewport: null, userDataDir: path.join(options.out, 'profile'), args: [...browserFlags], env: browserEnv })
    const page = await browser.newPage()
    // A renderer can fail every frame (e.g. an invalid canvas texture) without
    // surfacing a GPU error; such a page draws nothing and must not be measured.
    const setupWebGpuFailures: string[] = []
    page.on('console', m => { if (isWebGpuFailure(m.text())) setupWebGpuFailures.push(m.text().slice(0, 200)) })
    await installHooks(page)
    page.setDefaultTimeout(30000)
    const ref = JSON.parse(readFileSync(path.join(ROOT, 'docs/benchmarks/p1/reference-environment.json'), 'utf8'))
    // v2 records actual desktop geometry; the v1 inventory's 1200x720/DPR
    // values are not locked settings and leave only a 592px canvas with both
    // sidebars open. Never emulate DPR for a headed acceptance capture.
    if (options.headless) await page.setViewport({ width: 1600, height: 900 })
    await page.goto(`${url}/editor`, { waitUntil: 'domcontentloaded' })
    // A dedicated profile is intentionally persistent for reproduction, but
    // reruns must not inherit its previous fixture at the default-route probe.
    await page.evaluate(() => localStorage.clear())
    await page.reload({ waitUntil: 'domcontentloaded' })
    await ready(page, 4)
    // Generate the fixture against the settled canvas with the Task sidebar
    // open; the sidebar changes the canvas width on the real application route.
    await page.click('#labels-overlay [id^="card-label-"]')
    await page.waitForFunction(() => !!document.querySelector('#skill-detail-panel'), { timeout: 15000 })
    const initial = await visibility(page)
    if (initial.canvas.width < protocol.minimum_canvas_css.width || initial.canvas.height < protocol.minimum_canvas_css.height) throw new Error(`Canvas ${initial.canvas.width}x${initial.canvas.height} below contract minimum`)
    const fixtureDir = path.join(options.out, 'fixtures')
    writeFixtureFiles(fixtureDir, generateBenchmarkFixture(fixtureContract, size, { canvasCss: { width: initial.canvas.width, height: initial.canvas.height } }))
    const fixture = readFixtureFiles(fixtureContract, fixtureDir, size)
    for (const [name, role] of [['manifest', 'primary-fixture-manifest'], ['checkpoint', 'primary-fixture-checkpoint'], ['camera', 'primary-fixture-camera']] as const) {
      const filename = `fixtures/${name}-${size}.json`
      artifacts.push({ path: filename, sha256: hash(readFileSync(path.join(options.out, filename))), role })
    }
    const cdp = await page.createCDPSession()
    const refreshHz = (() => {
      if (process.env.GUROW_DISPLAY_REFRESH_HZ) return Number(process.env.GUROW_DISPLAY_REFRESH_HZ)
      try {
        const monitors = JSON.parse(execFileSync('hyprctl', ['monitors', '-j'], { encoding: 'utf8' })) as Array<{ focused?: boolean; refreshRate?: number }>
        return monitors.find(m => m.focused)?.refreshRate ?? NaN
      } catch { return NaN }
    })()
    if (!(refreshHz > 0) || !Number.isFinite(refreshHz)) throw new Error('Cannot measure current display refresh with hyprctl; set GUROW_DISPLAY_REFRESH_HZ explicitly')
    await seed(page, url, fixture)
    const adapter = await page.evaluate(() => (window as any).__gurowEditorAdapter ?? null)
    const windowInfo = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
      screen_x: screenX, screen_y: screenY, outer_width: outerWidth, outer_height: outerHeight,
      screen_width: screen.availWidth, screen_height: screen.availHeight,
      // X11 reports absolute window positions and an available area below the bar.
      avail_left: (screen as Screen & { availLeft?: number }).availLeft ?? 0,
      avail_top: (screen as Screen & { availTop?: number }).availTop ?? 0 }))
    const onAc = acPowerOnline()
    // GPUAdapterInfo.description is empty on Linux Chromium. Use the host
    // driver only when the editor actually selected the sole NVIDIA GPU.
    const nvidiaDriver = (() => {
      if (adapter?.vendor?.toLowerCase() !== 'nvidia') return ''
      try {
        const versions = execFileSync('nvidia-smi', ['--query-gpu=driver_version', '--format=csv,noheader'], { encoding: 'utf8' }).trim().split('\n')
        return versions.length === 1 ? versions[0].trim() : ''
      } catch { return '' }
    })()
    const browserPid = browser.process()?.pid
    const browserActive = options.headless ? async () => null : async () => !!browserPid && (await activeWindow())?.pid === browserPid
    const focusedWindow = await activeWindow()
    // Idle rAF cadence checks the refresh rate the proxy adds per sample.
    const idleFrames = await page.evaluate(() => new Promise<number[]>(resolve => {
      const stamps: number[] = []
      const tick = (t: number) => { stamps.push(t); if (stamps.length < 61) requestAnimationFrame(tick); else resolve(stamps) }
      requestAnimationFrame(tick)
    }))
    const idleInterval = nearestRank(idleFrames.slice(1).map((t, i) => t - idleFrames[i]), .5)
    const idleRafHz = idleInterval ? 1000 / idleInterval : NaN
    const onScreen = !!focusedWindow && !!browserPid && focusedWindow.pid === browserPid &&
      windowFitsScreen(windowInfo)
    const environment = {
      cpu: os.cpus()[0]?.model ?? '', physical_memory_bytes: os.totalmem(), os: os.platform(), kernel: os.release(), compositor: process.env.XDG_CURRENT_DESKTOP ?? '',
      cpu_governor: (() => { try { return readFileSync('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor', 'utf8').trim() } catch { return '' } })(),
      browser_executable: chromium, browser_version: await browser.version(), browser_flags: browserFlags,
      gpu_adapter: adapter ? JSON.stringify(adapter) : '', gpu_driver: adapter?.description || nvidiaDriver,
      gpu_driver_source: adapter?.description ? 'editor WebGPU adapter description' : nvidiaDriver ? 'nvidia-smi (single NVIDIA GPU; editor adapter vendor=nvidia)' : 'unavailable',
      hardware_gpu: !!adapter && adapter.fallback === false && !isSoftwareAdapter(JSON.stringify(adapter)),
      display_refresh_hz: refreshHz, idle_raf_hz: idleRafHz, window_inner_size: { width: windowInfo.width, height: windowInfo.height }, device_pixel_ratio: windowInfo.dpr,
      canvas_css: { width: initial.canvas.width, height: initial.canvas.height }, canvas_backing: { width: initial.canvas.backing_width, height: initial.canvas.backing_height },
      browser_zoom_percent: 100, ac_power_online: onAc, dedicated_profile: true, production_build: true,
      headed: !options.headless, canvas_unobscured: onScreen && initial.canvas.x >= 0 && initial.canvas.y >= 0 && initial.canvas.x + initial.canvas.width <= windowInfo.width && initial.canvas.y + initial.canvas.height <= windowInfo.height,
      interruptions: [] as string[], window_observation: { ...windowInfo, browser_pid: browserPid ?? null, active_window: focusedWindow }, reference: ref,
    }
    if (setupWebGpuFailures.length) environment.interruptions.push(`WebGPU failed during setup (${setupWebGpuFailures.length} console errors), first: ${setupWebGpuFailures[0]}`)
    if (!refreshAgrees(idleRafHz, refreshHz)) environment.interruptions.push(`Idle rAF ${idleRafHz.toFixed(1)} Hz differs from reported display refresh ${refreshHz} Hz by more than ${REFRESH_TOLERANCE * 100}%`)
    artifacts.push(artifact(options.out, 'environment.json', environment, 'environment'))
    if (!options.diagnostic && (!environment.hardware_gpu || !environment.canvas_unobscured ||
      !environment.gpu_driver || !environment.ac_power_online || environment.interruptions.length)) {
      throw new Error('Headed hardware preflight failed (selected editor adapter, on-screen window, driver, AC or refresh rate); no acceptance series attempted. See environment.json')
    }
    const primary = size === fixtureContract.primary_size
    const visibleBand = requireRecipe(fixtureContract, size).visibility_band
    const runConfig = { refresh_hz: refreshHz, minimum_sent_fraction: sampling.minimum_sent_fraction, visible_band: visibleBand, browser_active: browserActive }
    if (options.trace) {
      const sections: string[] = [`# Diagnostic trace — ${size} cards (${protocol.contract_id}); not acceptance evidence`, '',
        `Each scenario: ${TRACE_WARMUP_MS / 1000} s warm-up, then ${TRACE_ACTIVE_MS / 1000} s of ${sampling.input_hz} Hz input traced with stage measures and the V8 sampling profiler enabled, which add overhead.`, '']
      for (const scenario of protocol.scenarios) {
        await seed(page, url, fixture)
        const warmup = await warmUp(page, cdp, scenario, fixture, fixtureContract, { warmup_ms: TRACE_WARMUP_MS, hz: sampling.input_hz, refresh_hz: refreshHz })
        if (warmup.errors.length) throw new Error(`${scenario} warmup page errors: ${warmup.errors.join('; ')}`)
        await seed(page, url, fixture)
        const summary = await traceScenario(page, cdp, scenario, fixture, fixtureContract, sampling.input_hz, path.join(options.out, `trace-${size}-${scenario}.json`))
        writeFileSync(path.join(options.out, `trace-${size}-${scenario}.summary.json`), JSON.stringify(summary, null, 2) + '\n')
        sections.push(markdownSummary(scenario, summary))
      }
      writeFileSync(path.join(options.out, `trace-${size}.md`), sections.join('\n'))
      console.log(`Diagnostic traces written to ${options.out}`)
      return 2
    }
    const delay = protocol.sanity_check.injected_delay_ms
    if (primary) {
      // Paired low-rate captures avoid serializing the injected delay against
      // the 120 Hz acceptance input period.
      for (const [target, app, label] of [['baseline', 0, 0], ['application_update', delay, 0], ['label_commit', 0, delay]] as const) {
        await seed(page, url, fixture)
        const result = await measured(page, cdp, 'pan', fixture, fixtureContract, { ...runConfig, ...SANITY_CAPTURE, app_delay_ms: app, label_delay_ms: label, acceptance: false })
        const values = result.raw.input_samples?.map((s: any) => s.proxy_ms).filter((v: unknown) => typeof v === 'number' && Number.isFinite(v)) ?? []
        const entry = { target, p50_ms: nearestRank(values, .5), samples: values.length, delays_applied: target === 'application_update' ? result.raw.app_delays_applied : result.raw.label_delays_applied, invalid_reasons: result.invalid_reasons, result }
        sanity.push(entry)
        artifacts.push(artifact(options.out, `sanity-${target}.json`, entry, 'sanity-capture'))
      }
    }
    const minimumShift = protocol.sanity_check.minimum_p50_shift_ms
    const sanityOk = !primary || sanity.every(s => s.invalid_reasons.length === 0) && sanity.slice(1).every(s => sanity[0].p50_ms !== null && s.p50_ms !== null && s.delays_applied > 0 && s.p50_ms - sanity[0].p50_ms >= minimumShift)
    const repetitions = primary ? sampling.runs_per_scenario : protocol.comparisons.find(c => c.cards === size)?.runs_per_scenario ?? 1
    const active = { active_ms: sampling.active_seconds * 1000, drain_ms: sampling.drain_seconds * 1000, hz: sampling.input_hz }
    for (const scenario of protocol.scenarios) {
      if (!sanityOk) break
      // One warm-up per scenario, followed by independent restores/captures.
      await seed(page, url, fixture)
      const warmup = await warmUp(page, cdp, scenario, fixture, fixtureContract, { warmup_ms: sampling.warmup_seconds * 1000, hz: sampling.input_hz, refresh_hz: refreshHz })
      if (warmup.errors.length) throw new Error(`${scenario} warmup page errors: ${warmup.errors.join('; ')}`)
      artifacts.push(artifact(options.out, `warmup-${scenario}.json`, warmup, 'warmup-log'))
      for (let repetition = 1; repetition <= repetitions; repetition++) {
        await seed(page, url, fixture)
        const result = await measured(page, cdp, scenario, fixture, fixtureContract, { ...runConfig, ...active, app_delay_ms: 0, label_delay_ms: 0, acceptance: true })
        const run = { id: `${size}-${scenario}-${repetition}`, cards: size, scenario, repetition, source_fingerprint: computeSourceFingerprint(ROOT), fixture_hash: fixture.manifest.checkpoint_hash, warmup_seconds: sampling.warmup_seconds, active_seconds: sampling.active_seconds, drain_seconds: sampling.drain_seconds, ...result }
        runs.push(run)
        artifacts.push(artifact(options.out, `raw-${run.id}.json`, run, 'raw-input-frame-log'))
        console.log(`${run.id}: CDP ${run.sent}/${run.scheduled}, page ${run.delivered} (observed ${run.observed_inputs}), no-op ${run.no_op_inputs}; ${run.invalid_reasons.join(', ') || 'valid'}`)
      }
    }
    artifacts.push(artifact(options.out, 'runs.json', runs, 'raw-input-frame-log'))
    artifacts.push(artifact(options.out, 'functional.json', [], 'functional-log'))
    artifacts.push(artifact(options.out, 'build.json', { build_hash: buildHash, source_fingerprint: computeSourceFingerprint(ROOT) }, 'production-build'))
    const missing = (unit: string, reason: string) => ({ value: null, unit, reason })
    const manifest = {
      schema: 'gurow-p1-capture-manifest-v4', synthetic: false, diagnostic: options.diagnostic,
      identity: { contract_id: protocol.contract_id, contract_sha256: hash(protocolBytes), parent_issue: 7, commit: git('rev-parse', 'HEAD'), tree_dirty: !!git('status', '--porcelain'), source_fingerprint: computeSourceFingerprint(ROOT), build_hash: buildHash, timestamp: new Date().toISOString(), runner_version: VERSION },
      environment, fixture: { hash: fixture.manifest.checkpoint_hash, cards: size, connections: fixture.recipe.connections, geometry: fixture.manifest.geometry, task_association_verified: true, manifest_path: `fixtures/manifest-${size}.json`, checkpoint_path: `fixtures/checkpoint-${size}.json` }, comparison_fixtures: [],
      sanity_checks: { application_update_p50_shift_ms: sanity[0]?.p50_ms == null || sanity[1]?.p50_ms == null ? null : sanity[1].p50_ms - sanity[0].p50_ms, label_commit_p50_shift_ms: sanity[0]?.p50_ms == null || sanity[2]?.p50_ms == null ? null : sanity[2].p50_ms - sanity[0].p50_ms },
      runs, functional: [], diagnostics: {
        initialization_to_first_render_ms: missing('ms', 'Initial render was not separately instrumented'), process_rss_bytes: missing('bytes', 'Browser process tree not collected'),
        js_heap_bytes: missing('bytes', 'Heap snapshot not collected'), wasm_memory_bytes: missing('bytes', 'Wasm memory not exposed'),
        draw_calls: missing('calls', 'Renderer counter not exposed'), upload_bytes: missing('bytes', 'Renderer counter not exposed'),
        json_boundary_calls: missing('calls', 'Boundary counter not exposed'), json_boundary_bytes: missing('bytes', 'Boundary counter not exposed'), json_boundary_duration_ms: missing('ms', 'Boundary counter not exposed'),
        limitations: ['Proxy covers main-thread queueing, application, renderer submission and label commit; not compositor output, scanout or physical pixels.'],
      }, artifacts,
    }
    writeFileSync(path.join(options.out, 'capture.json'), JSON.stringify(manifest, null, 2) + '\n')
    // Reducer is the only authority for gate verdicts; never translate capture validity into PASS here.
    const reducer = spawn('bun', ['run', 'scripts/benchmark/report-cli.ts', '--input', path.join(options.out, 'capture.json'), '--contract', options.contract, '--out', path.join(options.out, 'report')], { cwd: FRONTEND, stdio: 'inherit' })
    const exit = await new Promise<number>(resolve => reducer.on('close', code => resolve(code ?? 2)))
    if (!sanityOk) console.error(`Sanity delay shift below ${minimumShift} ms or missing; acceptance captures not attempted.`)
    return options.diagnostic || !sanityOk || runs.some(r => r.invalid_reasons.length) ? 2 : exit
  } finally {
    await browser?.close()
    server.kill()
  }
}
if (import.meta.main) main().then(code => { process.exitCode = code }).catch(error => {
  const reason = error instanceof Error ? error.message : String(error)
  console.error(`Capture NOT_MEASURED: ${reason}`)
  try {
    const out = args(process.argv.slice(2)).out
    mkdirSync(out, { recursive: true })
    if (!existsSync(path.join(out, 'report.json'))) {
      writeFileSync(path.join(out, 'report.json'), JSON.stringify({ schema: 'gurow-p1-report-v4', gate: { verdict: 'NOT_MEASURED', reasons: [reason] }, input_error: reason }, null, 2) + '\n')
      writeFileSync(path.join(out, 'report.md'), `# P1 capture unavailable — NOT_MEASURED\n\n${reason}\n`)
    }
  } catch (writeError) { console.error(`Cannot write NOT_MEASURED report: ${String(writeError)}`) }
  process.exitCode = 2
})
