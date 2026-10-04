/**
 * T06-L3-02 browser fixture check (issue #35).
 *
 * Builds the current source, measures the settled canvas in the real route,
 * generates the three contract workloads for that canvas, then loads each one
 * through the route's checkpoint restore in a dedicated browser profile and
 * records what the browser actually shows. Every verdict in the report is
 * derived from a recorded observation; a check that could not run is
 * NOT_MEASURED, never PASS. No timing is measured here.
 *
 * Usage:
 *   bun run scripts/benchmark/fixture-check.ts --contract ../docs/benchmarks/p1/protocol-v4.json --out ../.harness/t06/fixtures [--headed]
 */

import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import type { CameraState, LearningPathCheckpoint } from '../../src/components/editor/protocol'
import { getCheckpointKey } from '../../src/components/editor/checkpoint'
import { INITIAL_LEARNING_PATH_FIXTURE } from '../../src/fixtures/learningPath'
import {
  contractSizes,
  requireRecipe,
  computeApplicationHash,
  computeEditorIdentityHash,
  computeVisibleCardIds,
  estimateConnectionVisibility,
  fixtureFilePaths,
  fixtureStorageEntries,
  formatSkillId,
  generateBenchmarkFixture,
  intersectsWithPositiveArea,
  isBenchmarkSkillId,
  loadBenchmarkContract,
  motionAmplitudeCss,
  readFixtureFiles,
  validatePlannedPathVisibility,
  writeFixtureFiles,
  FixtureRejectedError,
  type BenchmarkContract,
  type BenchmarkFixture,
  type BenchmarkSize,
  type CanvasRect,
  type Size,
  type PathVisibilityResult,
} from './fixture'
import { computeBuildHash, resolveChromiumExecutable, waitForServerReady } from './browser'
import { computeSourceFingerprint } from './sourceFingerprint'

const REPO_ROOT = path.resolve(import.meta.dir, '../../..')
const FRONTEND_DIR = path.resolve(REPO_ROOT, 'frontend')
const EDITOR_TIMEOUT_MS = 180_000
// Historical fixture smoke-check layout from reference-environment.json; v2
// acceptance may use any unobscured canvas meeting minimum_canvas_css.
const CHECK_VIEWPORT = { width: 1200, height: 720, dpr: 1.5 }

interface CliOptions {
  contractPath: string
  outDir: string
  port: number
  headless: boolean
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    contractPath: path.resolve(REPO_ROOT, 'docs/benchmarks/p1/protocol-v4.json'),
    outDir: path.resolve(REPO_ROOT, '.harness/t06/fixtures'),
    port: 3474,
    headless: true,
  }
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1]
    if (argv[i] === '--contract' && value) { options.contractPath = path.resolve(process.cwd(), value); i++ }
    else if (argv[i] === '--out' && value) { options.outDir = path.resolve(process.cwd(), value); i++ }
    else if (argv[i] === '--port' && value) { options.port = parseInt(value, 10); i++ }
    else if (argv[i] === '--headed') { options.headless = false }
  }
  return options
}

// ---------------------------------------------------------------------------
// Evidence: every verdict comes from a recorded expected/observed pair.
// ---------------------------------------------------------------------------

const CRITERIA = {
  AC1: 'Three fixtures with exact counts, stable IDs, one Task per Skill and deterministic hashes',
  AC2: 'Valid DAG, no duplicates or broken associations; identity follows recipe and viewport',
  AC3: 'Loaded via route and checkpoint restore in a dedicated profile; live export, list and selected Task show fixture IDs',
  AC4: 'Task panel open: primary/large initial visible cards and planned path inside the contract band; clipped cards and DOM labels; submitted vs visible counts',
  AC5: 'Real WebGPU drawing and HTML labels; Task save/edit/reload keeps UI and engine identity coherent',
  AC6: 'Malformed or mismatched input rejected without damaging another profile or substituting a smaller workload; L3-03 metadata emitted',
} as const
type Criterion = keyof typeof CRITERIA
type Verdict = 'PASS' | 'FAIL' | 'NOT_MEASURED'

interface CheckRecord {
  ac: Criterion
  id: string
  expected: unknown
  observed: unknown
  verdict: Verdict
}

class Evidence {
  readonly checks: CheckRecord[] = []

  /** Records a check that passes only when the observation equals the expectation. */
  expect(ac: Criterion, id: string, expected: unknown, observed: unknown): boolean {
    const verdict = isDeepStrictEqual(expected, observed) ? 'PASS' : 'FAIL'
    this.checks.push({ ac, id, expected, observed, verdict })
    if (verdict === 'FAIL') console.log(`  FAIL ${ac} ${id}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(observed)}`)
    return verdict === 'PASS'
  }

  /** Records a check described by a predicate over the observation. */
  satisfies(ac: Criterion, id: string, expectation: string, observed: unknown, pass: boolean): boolean {
    this.checks.push({ ac, id, expected: expectation, observed, verdict: pass ? 'PASS' : 'FAIL' })
    if (!pass) console.log(`  FAIL ${ac} ${id}: expected ${expectation}, observed ${JSON.stringify(observed)}`)
    return pass
  }

  /** Records evidence that could not be collected. */
  missing(acs: Criterion[], id: string, error: unknown): void {
    const observed = error instanceof Error ? error.message : String(error)
    console.log(`  NOT_MEASURED ${acs.join(',')} ${id}: ${observed}`)
    for (const ac of acs) this.checks.push({ ac, id, expected: 'evidence collected', observed, verdict: 'NOT_MEASURED' })
  }

  /** Runs one observation phase; an abort leaves its criteria NOT_MEASURED. */
  async phase(acs: Criterion[], id: string, body: () => Promise<void> | void): Promise<void> {
    try {
      await body()
    } catch (err: unknown) {
      this.missing(acs, `${id}:aborted`, err)
    }
  }

  verdict(ac: Criterion): Verdict {
    const own = this.checks.filter((c) => c.ac === ac)
    if (own.some((c) => c.verdict === 'FAIL')) return 'FAIL'
    if (own.length === 0 || own.some((c) => c.verdict === 'NOT_MEASURED')) return 'NOT_MEASURED'
    return 'PASS'
  }
}

function overallVerdict(verdicts: Verdict[]): Verdict {
  if (verdicts.includes('FAIL')) return 'FAIL'
  if (verdicts.includes('NOT_MEASURED')) return 'NOT_MEASURED'
  return 'PASS'
}

// ---------------------------------------------------------------------------
// Browser observation helpers
// ---------------------------------------------------------------------------

interface UiState {
  editor_ready: boolean
  gpu_error: string | null
  checkpoint_error: string | null
  submitted_cards: number | null
  list_ids: string[]
  /** HTML label boxes as laid out, and the card screen rects the engine delivered with them. */
  labels: Array<{ id: string; card: CanvasRect } & CanvasRect>
  canvas: CanvasRect & { backing_width: number; backing_height: number }
  window: { inner_width: number; inner_height: number; device_pixel_ratio: number }
}

async function readUi(page: Page): Promise<UiState> {
  return page.evaluate(() => {
    const rectOf = (el: Element) => {
      const r = el.getBoundingClientRect()
      return { left: r.left, top: r.top, width: r.width, height: r.height }
    }
    const canvas = document.getElementById('editor-canvas') as HTMLCanvasElement
    const overlay = rectOf(document.getElementById('labels-overlay')!)
    const count = document.getElementById('editor-card-count')?.textContent?.match(/(\d+)/)
    return {
      editor_ready: (window as unknown as { __gurowEditorReady?: boolean }).__gurowEditorReady === true,
      gpu_error: document.getElementById('editor-gpu-error-notice')?.textContent?.trim() ?? null,
      checkpoint_error: document.getElementById('checkpoint-error-alert')?.textContent?.trim() ?? null,
      submitted_cards: count ? Number(count[1]) : null,
      list_ids: Array.from(document.querySelectorAll('#skill-prerequisite-list [id^="skill-list-item-"]'))
        .map((el) => el.id.slice('skill-list-item-'.length)),
      labels: Array.from(document.querySelectorAll('#labels-overlay [id^="card-label-"]'))
        .map((el) => {
          // The label's inline box is the engine's card world rect, placed by the camera container's
          // transform; CSS padding can make the laid-out label taller.
          const style = (el as HTMLElement).style
          const camera = new DOMMatrixReadOnly(getComputedStyle(document.getElementById('labels-camera')!).transform)
          return {
            id: el.id.slice('card-label-'.length),
            ...rectOf(el),
            card: {
              left: overlay.left + camera.e + parseFloat(style.left) * camera.a,
              top: overlay.top + camera.f + parseFloat(style.top) * camera.d,
              width: parseFloat(style.width) * camera.a,
              height: parseFloat(style.height) * camera.d,
            },
          }
        }),
      canvas: { ...rectOf(canvas), backing_width: canvas.width, backing_height: canvas.height },
      window: { inner_width: window.innerWidth, inner_height: window.innerHeight, device_pixel_ratio: window.devicePixelRatio },
    }
  })
}

/** Label IDs whose laid-out DOM box intersects the clipped canvas with positive area. */
function visibleLabelIds(ui: UiState): string[] {
  return ui.labels.filter((label) => intersectsWithPositiveArea(label, ui.canvas)).map((l) => l.id)
}

/** Card IDs whose delivered screen rect intersects the clipped canvas with positive area. */
function visibleCardIds(ui: UiState): string[] {
  return ui.labels.filter((label) => intersectsWithPositiveArea(label.card, ui.canvas)).map((l) => l.id)
}

function cardRect(ui: UiState, id: string): CanvasRect {
  const label = ui.labels.find((l) => l.id === id)
  if (!label) throw new Error(`No HTML label for card '${id}'`)
  return label.card
}

/**
 * Camera the engine actually delivered, recovered from a reference card's
 * screen rect: zoom from its width, offsets from its canvas-local position.
 */
function deliveredCamera(ui: UiState, fixture: BenchmarkFixture, referenceId: string): CameraState {
  const card = fixture.checkpoint.editor.cards.find((c) => c.id === referenceId)!
  const rect = cardRect(ui, referenceId)
  const zoom = rect.width / card.size.width
  return {
    zoom,
    offset_x: rect.left - ui.canvas.left - card.position.x * zoom,
    offset_y: rect.top - ui.canvas.top - card.position.y * zoom,
  }
}

/** Waits until the route has either initialised the editor or reported why not. */
async function waitForEditorSettled(page: Page, expectedLabels: number | null): Promise<void> {
  await page.waitForFunction(
    (expected) => {
      const ready = (window as unknown as { __gurowEditorReady?: boolean }).__gurowEditorReady === true
      const failed = document.getElementById('editor-gpu-error-notice') || document.getElementById('checkpoint-error-alert')
      const labels = document.querySelectorAll('#labels-overlay [id^="card-label-"]').length
      return failed || (ready && (expected === null || labels === expected))
    },
    { timeout: EDITOR_TIMEOUT_MS, polling: 250 },
    expectedLabels
  )
}

async function seedStorage(page: Page, entries: Array<[string, string]>): Promise<void> {
  await page.evaluate((items) => {
    localStorage.clear()
    for (const [key, value] of items) localStorage.setItem(key, value)
  }, entries)
}

async function reloadRoute(page: Page, expectedLabels: number | null): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForEditorSettled(page, expectedLabels)
}

async function readStoredCheckpoint(page: Page, key: string): Promise<string | null> {
  return page.evaluate((k) => localStorage.getItem(k), key)
}

function rectCentre(rect: CanvasRect): { x: number; y: number } {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

/** Selects a card with a real pointer click on the canvas under its label. */
async function selectCard(page: Page, id: string): Promise<void> {
  const centre = rectCentre(cardRect(await readUi(page), id))
  await page.mouse.click(centre.x, centre.y)
  await page.waitForFunction(
    (skillId) => document.getElementById('selected-skill-id')?.textContent?.trim() === skillId,
    { timeout: 15_000 },
    id
  )
}

/**
 * Performs real input and waits until the engine delivers a new screen rect for a card:
 * a moved card changes its label's world bounds, a camera change the container transform.
 */
async function actAndWaitForCardMove(page: Page, id: string, act: () => Promise<void>): Promise<void> {
  const selector = `#card-label-${id}`
  const placement = (sel: string) =>
    `${document.querySelector(sel)?.getAttribute('style')}|${document.getElementById('labels-camera')?.style.transform}`
  await page.evaluate(`window.__gurowLabelPlacement = ${placement.toString()}`)
  const before = await page.evaluate((sel) => (window as any).__gurowLabelPlacement(sel), selector)
  await act()
  await page.waitForFunction(
    (sel, prev) => (window as any).__gurowLabelPlacement(sel) !== prev,
    { timeout: 15_000, polling: 'raf' },
    selector,
    before
  )
}

interface PixelCounts { card_pixels: number; highlight_pixels: number; area: number }

/**
 * Counts GPU-drawn card fill and selection highlight pixels inside a card's
 * rectangle with the HTML labels hidden, so only canvas pixels are counted.
 */
async function countCanvasPixels(page: Page, rects: CanvasRect[]): Promise<PixelCounts[]> {
  await page.$eval('#labels-overlay', (el) => { (el as HTMLElement).style.visibility = 'hidden' })
  try {
    const results: PixelCounts[] = []
    for (const rect of rects) {
      const png = await page.screenshot({
        type: 'png',
        clip: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      })
      const out = execFileSync('python3', ['-c', `
import sys, io
from PIL import Image
im = Image.open(io.BytesIO(sys.stdin.buffer.read())).convert('RGB')
targets = [(59, 130, 245), (128, 185, 248)]
card = highlight = 0
data = im.tobytes()
for i in range(0, len(data), 3):
    r, g, b = data[i], data[i + 1], data[i + 2]
    if any(max(abs(r - t[0]), abs(g - t[1]), abs(b - t[2])) <= 4 for t in targets):
        highlight += 1
    elif r >= 24 and g >= 30 and b >= 40:
        card += 1
print(card, highlight, im.width * im.height)
`], { input: png, encoding: 'utf8' }).trim().split(' ').map(Number)
      results.push({ card_pixels: out[0], highlight_pixels: out[1], area: out[2] })
    }
    return results
  } finally {
    await page.$eval('#labels-overlay', (el) => { (el as HTMLElement).style.visibility = '' })
  }
}

async function readAdapter(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(async () => {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<any> } }).gpu
    const adapter = await gpu?.requestAdapter()
    if (!adapter) return null
    const info = adapter.info ?? {}
    return {
      vendor: info.vendor ?? null,
      architecture: info.architecture ?? null,
      device: info.device ?? null,
      description: info.description ?? null,
      is_fallback_adapter: info.isFallbackAdapter ?? adapter.isFallbackAdapter ?? null,
    }
  })
}

/** Launches Chromium on a dedicated profile, wiped first unless `reset` is false. */
async function launch(
  chromiumPath: string,
  profileDir: string,
  headless: boolean,
  reset = true
): Promise<{ browser: Browser; page: Page }> {
  if (reset) rmSync(profileDir, { recursive: true, force: true })
  mkdirSync(profileDir, { recursive: true })
  const browser = await puppeteer.launch({
    executablePath: chromiumPath,
    headless,
    userDataDir: profileDir,
    // No Vulkan feature flag: with it, this Chromium composites the WebGPU
    // canvas as black, so its drawing could not be observed at all.
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-webgpu', '--use-gl=angle', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage()
  page.setDefaultTimeout(30_000)
  await page.setViewport({
    // Fixture smoke-check uses the recorded reference layout; v2 protocol only
    // specifies a minimum canvas size, not a fixed viewport or DPR.
    width: CHECK_VIEWPORT.width,
    height: CHECK_VIEWPORT.height,
    deviceScaleFactor: CHECK_VIEWPORT.dpr,
  })
  return { browser, page }
}

// ---------------------------------------------------------------------------
// Observation phases
// ---------------------------------------------------------------------------

interface DeliveredState {
  camera: CameraState
  /** Centre card displacement from its fixture position, in world units. */
  centre_dx_world: number
  visible_cards: string[]
  visible_labels: number
  geometric_visible: string[]
}

/**
 * Reads the delivered camera and card rects and predicts, from the fixture at
 * that same camera, which cards should be visible (contract §4).
 */
async function readDeliveredState(page: Page, fixture: BenchmarkFixture, referenceId: string): Promise<DeliveredState> {
  const ui = await readUi(page)
  const { canvas_css: canvas, center_card } = fixture.manifest.geometry
  const camera = deliveredCamera(ui, fixture, referenceId)
  const centre = cardRect(ui, center_card.id)
  const centreDx = (centre.left - ui.canvas.left - camera.offset_x) / camera.zoom - center_card.world_pos.x
  return {
    camera,
    centre_dx_world: centreDx,
    visible_cards: visibleCardIds(ui),
    visible_labels: visibleLabelIds(ui).length,
    geometric_visible: computeVisibleCardIds(fixture.checkpoint.editor.cards, camera, canvas, { id: center_card.id, dx: centreDx, dy: 0 }),
  }
}

const sorted = (ids: string[]) => [...ids].sort()

interface WorkloadObservation {
  size: BenchmarkSize
  submitted_cards: number | null
  dom_labels: number
  initial: DeliveredState
  canvas_after_selection: UiState['canvas']
  window: UiState['window']
  selected_task_title: string | null
  pixels: { selected_card: PixelCounts; neighbour_card: PixelCounts }
  path_probe: Array<{ step: string } & DeliveredState>
  live_export: Record<string, unknown> | null
}

/** Loads one fixture and records IDs, cards, labels, visibility and GPU pixels (AC3–AC5). */
async function observeWorkload(page: Page, evidence: Evidence, fixture: BenchmarkFixture): Promise<WorkloadObservation> {
  const { size, manifest } = fixture
  const { canvas_css: canvas, center_card } = manifest.geometry
  const fixtureIds = fixture.checkpoint.editor.cards.map((c) => c.id)
  const centreIndex = fixtureIds.indexOf(center_card.id)
  const centreTask = fixture.checkpoint.application.skills[centreIndex].tasks[0]
  const neighbourId = fixtureIds[centreIndex + 1]
  const fallbackIds = INITIAL_LEARNING_PATH_FIXTURE.skills.map((s) => s.id)

  await seedStorage(page, fixtureStorageEntries(fixture))
  await reloadRoute(page, size)
  let ui = await readUi(page)

  evidence.expect('AC3', `${size}:checkpoint-restored-without-error`, null, ui.checkpoint_error)
  evidence.expect('AC3', `${size}:four-skill-fallback-absent`, [], fallbackIds.filter((id) => ui.list_ids.includes(id)))
  evidence.expect('AC3', `${size}:list-shows-fixture-ids`, fixtureIds, ui.list_ids)
  evidence.expect('AC3', `${size}:labels-show-fixture-ids`, sorted(fixtureIds), sorted(ui.labels.map((l) => l.id)))
  evidence.expect('AC5', `${size}:webgpu-editor-ready`, { editor_ready: true, gpu_error: null }, { editor_ready: ui.editor_ready, gpu_error: ui.gpu_error })
  evidence.expect('AC4', `${size}:submitted-cards`, size, ui.submitted_cards)

  await selectCard(page, center_card.id)
  const selectedTaskTitle = await page.$eval(`#task-edit-title-${centreTask.id}`, (el) => (el as HTMLInputElement).value).catch(() => null)
  evidence.expect('AC3', `${size}:selected-task-panel`, centreTask.title, selectedTaskTitle)

  ui = await readUi(page)
  evidence.expect('AC4', `${size}:canvas-matches-fixture-geometry`, canvas, { width: ui.canvas.width, height: ui.canvas.height })
  evidence.expect('AC4', `${size}:canvas-backing-follows-dpr`,
    { width: Math.floor(ui.canvas.width * ui.window.device_pixel_ratio), height: Math.floor(ui.canvas.height * ui.window.device_pixel_ratio) },
    { width: ui.canvas.backing_width, height: ui.canvas.backing_height })

  const initial = await readDeliveredState(page, fixture, neighbourId)
  evidence.satisfies('AC4', `${size}:delivered-camera-is-fixture-camera`, 'zoom within 0.1% and offsets within 0.5 CSS px of the manifest camera',
    initial.camera, Math.abs(initial.camera.zoom / fixture.camera.zoom - 1) < 1e-3 &&
      Math.abs(initial.camera.offset_x - fixture.camera.offset_x) < 0.5 && Math.abs(initial.camera.offset_y - fixture.camera.offset_y) < 0.5)
  evidence.expect('AC4', `${size}:initial-visible-cards`, manifest.initial_visible_cards, initial.visible_cards.length)
  evidence.expect('AC4', `${size}:visible-cards-match-geometry`,
    sorted(computeVisibleCardIds(fixture.checkpoint.editor.cards, fixture.camera, canvas)), sorted(initial.visible_cards))

  const [selectedPixels, neighbourPixels] = await countCanvasPixels(page, [cardRect(ui, center_card.id), cardRect(ui, neighbourId)])
  // Anti-aliased connection edges can graze a highlight colour, hence ratios rather than zero.
  evidence.satisfies('AC5', `${size}:gpu-draws-selected-card`, 'card fill over 30% and selection highlight over 10% of the card',
    selectedPixels, selectedPixels.card_pixels > 0.3 * selectedPixels.area && selectedPixels.highlight_pixels > 0.1 * selectedPixels.area)
  evidence.satisfies('AC5', `${size}:gpu-draws-unselected-neighbour`, 'card fill over 30% and selection highlight under 1% of the card',
    neighbourPixels, neighbourPixels.card_pixels > 0.3 * neighbourPixels.area && neighbourPixels.highlight_pixels < 0.01 * neighbourPixels.area)

  return {
    size,
    submitted_cards: ui.submitted_cards,
    dom_labels: ui.labels.length,
    initial,
    canvas_after_selection: ui.canvas,
    window: ui.window,
    selected_task_title: selectedTaskTitle,
    pixels: { selected_card: selectedPixels, neighbour_card: neighbourPixels },
    path_probe: [],
    live_export: null,
  }
}

/** Ctrl+wheel zoom rule of the editor and contract §5: factor = exp(-deltaY * rate). */
const WHEEL_ZOOM_RATE = 0.005

/**
 * Drives the extremes of the planned pan, zoom and drag paths with real
 * browser input (AC4). At each delivered state it checks that the extreme was
 * reached, that the visible cards equal the geometric prediction at the
 * delivered camera, and that they stay inside the band. Releasing the drag
 * completes an operation whose route save is the live engine export for this
 * size (AC3); it must be the fixture apart from that observed move.
 */
async function probePlannedPath(
  page: Page,
  evidence: Evidence,
  contract: BenchmarkContract,
  fixture: BenchmarkFixture,
  observation: WorkloadObservation
): Promise<void> {
  const { size, manifest } = fixture
  const { canvas_css, center_card } = manifest.geometry
  const band = manifest.visibility_band
  const amplitude = motionAmplitudeCss(manifest.geometry, contract.motion)
  const ids = fixture.checkpoint.editor.cards.map((c) => c.id)
  const referenceId = ids[ids.indexOf(center_card.id) + 1]
  const key = getCheckpointKey(manifest.account_id, manifest.learning_path_id)
  const ui = await readUi(page)
  const canvasCentre = { x: ui.canvas.left + canvas_css.width / 2, y: ui.canvas.top + canvas_css.height / 2 }

  type Reached = (state: DeliveredState) => { expected: number; observed: number; tolerance: number }
  const measure = async (step: string, act: () => Promise<void>, reached: Reached) => {
    await actAndWaitForCardMove(page, center_card.id, act)
    const state = await readDeliveredState(page, fixture, referenceId)
    observation.path_probe.push({ step, ...state })
    const r = reached(state)
    evidence.satisfies('AC4', `${size}:path-${step}-reached`, `${r.expected.toFixed(4)} ± ${r.tolerance}`, r.observed,
      Math.abs(r.observed - r.expected) <= r.tolerance)
    evidence.expect('AC4', `${size}:path-${step}-cards-match-geometry`, sorted(state.geometric_visible), sorted(state.visible_cards))
    if (band) {
      evidence.satisfies('AC4', `${size}:path-${step}-in-band`, `visible cards within [${band.min}, ${band.max}]`,
        state.visible_cards.length, state.visible_cards.length >= band.min && state.visible_cards.length <= band.max)
    }
  }

  const panned = (expected: number): Reached => (s) => ({ expected, observed: s.camera.offset_x - fixture.camera.offset_x, tolerance: 0.5 })
  const zoomed = (expected: number): Reached => (s) => ({ expected, observed: s.camera.zoom / fixture.camera.zoom, tolerance: 1e-3 })
  const dragged = (expected: number): Reached => (s) => ({ expected, observed: s.centre_dx_world * s.camera.zoom, tolerance: 0.5 })

  // Wheel deltas injected under DPR emulation reach the page divided by the DPR, so they are scaled up.
  const dpr = CHECK_VIEWPORT.dpr
  await page.mouse.move(canvasCentre.x, canvasCentre.y)
  await measure('pan-positive', () => page.mouse.wheel({ deltaX: -amplitude * dpr }), panned(amplitude))
  await measure('pan-negative', () => page.mouse.wheel({ deltaX: 2 * amplitude * dpr }), panned(-amplitude))
  await measure('pan-return', () => page.mouse.wheel({ deltaX: -amplitude * dpr }), panned(0))

  const { zoom_max_factor: zoomMax, zoom_min_factor: zoomMin } = contract.motion
  const zoomDelta = (from: number, to: number) => (-Math.log(to / from) / WHEEL_ZOOM_RATE) * dpr
  await page.keyboard.down('Control')
  try {
    await measure('zoom-in', () => page.mouse.wheel({ deltaY: zoomDelta(1, zoomMax) }), zoomed(zoomMax))
    await measure('zoom-out', () => page.mouse.wheel({ deltaY: zoomDelta(zoomMax, zoomMin) }), zoomed(zoomMin))
    await measure('zoom-return', () => page.mouse.wheel({ deltaY: zoomDelta(zoomMin, 1) }), zoomed(1))
  } finally {
    await page.keyboard.up('Control')
  }

  const revisionBefore = JSON.parse((await readStoredCheckpoint(page, key)) ?? '{"editor":{"revision":0}}').editor.revision
  const grab = rectCentre(cardRect(await readUi(page), center_card.id))
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  try {
    await measure('drag-positive', () => page.mouse.move(grab.x + amplitude, grab.y, { steps: 3 }), dragged(amplitude))
    await measure('drag-negative', () => page.mouse.move(grab.x - amplitude, grab.y, { steps: 3 }), dragged(-amplitude))
  } finally {
    await page.mouse.up()
  }

  await page.waitForFunction(
    (k, before) => JSON.parse(localStorage.getItem(k) ?? '{"editor":{"revision":0}}').editor.revision > before,
    { timeout: 30_000, polling: 100 },
    key, revisionBefore
  )
  // The release leaves the centre card at the delivered drag extreme; every other card, and the
  // centre card once that observed move is undone, must still be the fixture.
  const released = observation.path_probe.at(-1)!
  const saved = JSON.parse((await readStoredCheckpoint(page, key))!) as LearningPathCheckpoint
  const savedCentre = saved.editor.cards.find((c) => c.id === center_card.id)
  const centreDrift = savedCentre
    ? Math.hypot(savedCentre.position.x - (center_card.world_pos.x + released.centre_dx_world), savedCentre.position.y - center_card.world_pos.y)
    : null
  const normalised = {
    ...saved.editor,
    cards: saved.editor.cards.map((c) =>
      c.id === center_card.id && centreDrift !== null && centreDrift < 0.05 ? { ...c, position: { ...center_card.world_pos } } : c),
  }
  observation.live_export = {
    revision: saved.editor.revision,
    centre_moved_world: released.centre_dx_world,
    centre_drift_from_observed_world: centreDrift,
    editor_identity_hash: computeEditorIdentityHash(normalised),
  }
  evidence.expect('AC3', `${size}:live-engine-export-matches-fixture`, manifest.editor_identity_hash, computeEditorIdentityHash(normalised))
}

/** Replaces a Task title through real keyboard input in the Task panel. */
async function typeTaskTitle(page: Page, taskId: string, title: string): Promise<void> {
  await page.click(`#task-edit-title-${taskId}`)
  await page.keyboard.down('Control')
  await page.keyboard.press('a')
  await page.keyboard.up('Control')
  await page.keyboard.type(title)
}

async function waitForSavedTaskTitle(page: Page, key: string, taskId: string, title: string): Promise<LearningPathCheckpoint> {
  await page.waitForFunction(
    (k, id, expected) => {
      const raw = localStorage.getItem(k)
      if (!raw) return false
      const saved = JSON.parse(raw)
      return saved.application.skills.some((s: any) => s.tasks.some((t: any) => t.id === id && t.title === expected))
    },
    { timeout: 30_000, polling: 100 },
    key, taskId, title
  )
  return JSON.parse((await readStoredCheckpoint(page, key))!) as LearningPathCheckpoint
}

/**
 * Edits the centre Task through the UI, reloads, and compares the route's
 * saves (produced from the live engine's ExportSnapshot) with the fixture
 * identity before and after the reload (AC3, AC5).
 */
async function checkEditReload(page: Page, evidence: Evidence, fixture: BenchmarkFixture): Promise<Record<string, unknown>> {
  const { manifest } = fixture
  const key = getCheckpointKey(manifest.account_id, manifest.learning_path_id)
  const centreId = manifest.geometry.center_card.id
  const skill = fixture.checkpoint.application.skills.find((s) => s.id === centreId)!
  const task = skill.tasks[0]
  const editedTitle = `${task.title} edited by T06-L3-02`

  const expectedEdited = structuredClone(fixture.checkpoint.application)
  expectedEdited.skills.find((s) => s.id === centreId)!.tasks[0].title = editedTitle

  await typeTaskTitle(page, task.id, editedTitle)
  const edited = await waitForSavedTaskTitle(page, key, task.id, editedTitle)
  evidence.expect('AC3', 'edit:live-engine-export-matches-fixture', manifest.editor_identity_hash, computeEditorIdentityHash(edited.editor))
  evidence.expect('AC5', 'edit:saved-application-has-only-the-edit', computeApplicationHash(expectedEdited), computeApplicationHash(edited.application))

  await reloadRoute(page, fixture.size)
  const reloaded = await readUi(page)
  evidence.expect('AC5', 'reload:fresh-ui-fixture-ids', fixture.checkpoint.editor.cards.map((c) => c.id), reloaded.list_ids)
  evidence.expect('AC5', 'reload:fresh-editor-ready', true, reloaded.editor_ready)
  await selectCard(page, centreId)
  const reloadedTitle = await page.$eval(`#task-edit-title-${task.id}`, (el) => (el as HTMLInputElement).value)
  evidence.expect('AC5', 'reload:task-edit-restored', editedTitle, reloadedTitle)

  // A second save from the freshly loaded engine proves its identity too.
  await typeTaskTitle(page, task.id, task.title)
  const restored = await waitForSavedTaskTitle(page, key, task.id, task.title)
  evidence.expect('AC5', 'reload:fresh-engine-export-matches-fixture', manifest.editor_identity_hash, computeEditorIdentityHash(restored.editor))
  evidence.expect('AC5', 'reload:restored-application-matches-fixture', manifest.application_hash, computeApplicationHash(restored.application))

  return {
    task_id: task.id,
    edited_title: editedTitle,
    edited_revision: edited.editor.revision,
    reloaded_title: reloadedTitle,
    restored_revision: restored.editor.revision,
    engine_editor_identity_after_edit: computeEditorIdentityHash(edited.editor),
    engine_editor_identity_after_reload: computeEditorIdentityHash(restored.editor),
  }
}

interface MalformedCase {
  id: string
  change: (checkpoint: LearningPathCheckpoint) => void
}

const MALFORMED_CASES: MalformedCase[] = [
  { id: 'orphan-card', change: (c) => { c.editor.cards[0].id = 'corrupted-orphan-card' } },
  { id: 'foreign-learning-path', change: (c) => { c.application.learning_path_id = 'another-learning-path' } },
  { id: 'dangling-connection', change: (c) => { c.editor.connections[0].to_id = formatSkillId(99999) } },
]

/** Setup-side rejection of malformed and substituted fixture files (AC6). */
function checkSetupRejection(evidence: Evidence, contract: BenchmarkContract, outDir: string, fixtures: Record<BenchmarkSize, BenchmarkFixture>): void {
  const primary = contract.primary_size
  // Any other workload of the contract; v5 has none smaller than its primary.
  const other = contractSizes(contract).find((size) => size !== primary)!
  const cases: Array<{ id: string; tamper: (dir: string) => void }> = [
    ...MALFORMED_CASES.map((c) => ({
      id: c.id,
      tamper: (dir: string) => {
        const checkpoint = structuredClone(fixtures[primary].checkpoint)
        c.change(checkpoint)
        writeFileSync(fixtureFilePaths(dir, primary).checkpoint, JSON.stringify(checkpoint))
      },
    })),
    {
      id: 'smaller-workload-substituted',
      tamper: (dir) => writeFileSync(fixtureFilePaths(dir, primary).checkpoint, JSON.stringify(fixtures[other].checkpoint)),
    },
    {
      id: 'manifest-for-other-size',
      tamper: (dir) => writeFileSync(fixtureFilePaths(dir, primary).manifest, JSON.stringify(fixtures[other].manifest)),
    },
  ]
  for (const c of cases) {
    const dir = path.join(outDir, 'malformed', c.id)
    rmSync(dir, { recursive: true, force: true })
    writeFixtureFiles(dir, fixtures[primary])
    c.tamper(dir)
    let outcome: string
    try {
      readFixtureFiles(contract, dir, primary)
      outcome = 'accepted'
    } catch (err: unknown) {
      outcome = err instanceof FixtureRejectedError ? 'rejected' : `unexpected ${String(err)}`
    }
    evidence.expect('AC6', `setup:${c.id}`, 'rejected', outcome)
  }
}

/**
 * Route-side rejection: each malformed checkpoint must raise the route's alert,
 * restore no fixture card, and survive Create Skill plus a completed drag (AC6).
 */
async function checkRouteRejection(page: Page, evidence: Evidence, fixture: BenchmarkFixture): Promise<Record<string, unknown>> {
  const key = getCheckpointKey(fixture.manifest.account_id, fixture.manifest.learning_path_id)
  const results: Record<string, unknown> = {}
  for (const c of MALFORMED_CASES) {
    const checkpoint = structuredClone(fixture.checkpoint)
    c.change(checkpoint)
    const raw = JSON.stringify(checkpoint)
    await seedStorage(page, [[key, raw]])
    await reloadRoute(page, null)
    const ui = await readUi(page)
    const restoredFixtureCards = ui.list_ids.filter(isBenchmarkSkillId).length
    evidence.satisfies('AC6', `route:${c.id}:rejection-shown`, 'checkpoint error alert', ui.checkpoint_error, !!ui.checkpoint_error)
    evidence.expect('AC6', `route:${c.id}:no-fixture-cards-restored`, 0, restoredFixtureCards)

    // Create Skill and a completed card drag both reach the route's checkpoint save; the
    // rejected draft must survive them. The alert appears before the editor finishes
    // initialising, so wait for the enabled control first.
    const createSkill = await page.waitForSelector('#editor-add-card-btn:not([disabled])', { timeout: EDITOR_TIMEOUT_MS })
    const beforeCreate = await readUi(page)
    await createSkill!.click()
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const afterCreate = await readUi(page)
    evidence.expect('AC6', `route:${c.id}:create-skill-blocked-while-rejected`, beforeCreate.submitted_cards, afterCreate.submitted_cards)

    const dragged = afterCreate.labels[0]
    const dragFrom = rectCentre(dragged.card)
    await actAndWaitForCardMove(page, dragged.id, async () => {
      await page.mouse.move(dragFrom.x, dragFrom.y)
      await page.mouse.down()
      await page.mouse.move(dragFrom.x + 40, dragFrom.y + 20, { steps: 4 })
      await page.mouse.up()
    })
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    evidence.expect('AC6', `route:${c.id}:rejected-draft-preserved`, sha256(raw), sha256((await readStoredCheckpoint(page, key)) ?? ''))
    results[c.id] = {
      alert: ui.checkpoint_error,
      submitted_cards_before_create: beforeCreate.submitted_cards,
      submitted_cards_after_create: afterCreate.submitted_cards,
      dragged_card: dragged.id,
      restored_fixture_cards: restoredFixtureCards,
    }
  }
  return results
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2))
  const contract = loadBenchmarkContract(options.contractPath)
  const evidence = new Evidence()
  const limitations: string[] = []
  mkdirSync(options.outDir, { recursive: true })

  const git = (...args: string[]) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  console.log('[1/6] Building the current source...')
  execFileSync('bun', ['run', 'build'], { cwd: FRONTEND_DIR, stdio: 'inherit' })
  const identity = {
    contract_id: contract.contract_id,
    contract_path: path.relative(REPO_ROOT, options.contractPath),
    contract_sha256: contract.sha256,
    source_commit: git('rev-parse', 'HEAD'),
    tree_dirty: git('status', '--porcelain').length > 0,
    source_fingerprint: computeSourceFingerprint(REPO_ROOT),
    build_hash: computeBuildHash(FRONTEND_DIR),
    timestamp: new Date().toISOString(),
  }
  console.log(`  ${identity.source_commit}${identity.tree_dirty ? ' (dirty)' : ''}, build ${identity.build_hash}`)

  const server = spawn('node', ['.output/server/index.mjs'], {
    cwd: FRONTEND_DIR,
    env: { ...process.env, PORT: String(options.port) },
    stdio: 'ignore',
  })
  const serverUrl = `http://127.0.0.1:${options.port}`
  const chromiumPath = resolveChromiumExecutable()
  const profileDir = path.join(options.outDir, 'profile-working')
  const otherProfileDir = path.join(options.outDir, 'profile-isolation')
  let browser: Browser | null = null

  const fixtures = {} as Record<BenchmarkSize, BenchmarkFixture>
  const pathVisibility = {} as Record<BenchmarkSize, PathVisibilityResult>
  const observations: Partial<Record<BenchmarkSize, WorkloadObservation>> = {}
  // Filled by the phases; anything still null was not observed.
  const state: {
    canvas: Size | null
    adapter: Record<string, unknown> | null
    browserVersion: string | null
    editReload: Record<string, unknown> | null
    routeRejection: Record<string, unknown> | null
    otherProfile: Record<string, unknown> | null
  } = { canvas: null, adapter: null, browserVersion: null, editReload: null, routeRejection: null, otherProfile: null }

  try {
    await waitForServerReady(serverUrl)
    const launched = await launch(chromiumPath, profileDir, options.headless)
    browser = launched.browser
    const page = launched.page
    state.browserVersion = await browser.version()

    await evidence.phase(['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6'], 'measure-canvas', async () => {
      console.log('[2/6] Measuring the settled canvas in the default route...')
      await page.goto(`${serverUrl}/editor`, { waitUntil: 'domcontentloaded' })
      await seedStorage(page, [])
      await reloadRoute(page, null)
      await selectCard(page, (await readUi(page)).labels[0].id)
      const ui = await readUi(page)
      state.canvas = { width: ui.canvas.width, height: ui.canvas.height }
      state.adapter = await readAdapter(page)
      evidence.expect('AC4', 'window-matches-fixture-smoke-layout',
        { inner_width: CHECK_VIEWPORT.width, inner_height: CHECK_VIEWPORT.height, device_pixel_ratio: CHECK_VIEWPORT.dpr },
        ui.window)
      console.log(`  canvas ${ui.canvas.width}x${ui.canvas.height} CSS px, adapter ${JSON.stringify(state.adapter)}`)
    })
    const canvas = state.canvas
    if (!canvas) throw new Error('Canvas could not be measured; no fixture geometry exists.')

    await evidence.phase(['AC1', 'AC2', 'AC4'], 'generate', () => {
      console.log('[3/6] Generating, writing and re-reading the fixtures...')
      const fixtureDir = path.join(options.outDir, 'fixtures')
      for (const size of contractSizes(contract)) {
        writeFixtureFiles(fixtureDir, generateBenchmarkFixture(contract, size, { canvasCss: canvas }))
        let fixture: BenchmarkFixture
        try {
          fixture = readFixtureFiles(contract, fixtureDir, size)
          evidence.expect('AC2', `${size}:files-pass-dag-and-association-validation`, 'accepted', 'accepted')
        } catch (err: unknown) {
          evidence.expect('AC2', `${size}:files-pass-dag-and-association-validation`, 'accepted', String(err))
          continue
        }
        fixtures[size] = fixture
        const recipe = requireRecipe(contract, size)
        evidence.expect('AC1', `${size}:counts`, { cards: size, connections: recipe.connections, skills: size, tasks: size },
          { cards: fixture.checkpoint.editor.cards.length, connections: fixture.checkpoint.editor.connections.length,
            skills: fixture.checkpoint.application.skills.length,
            tasks: new Set(fixture.checkpoint.application.skills.flatMap((s) => s.tasks.map((t) => t.id))).size })
        const again = generateBenchmarkFixture(contract, size, { canvasCss: canvas })
        evidence.expect('AC1', `${size}:deterministic-hash`, fixture.manifest.checkpoint_hash, again.manifest.checkpoint_hash)
        pathVisibility[size] = validatePlannedPathVisibility(fixture, contract.motion)
        evidence.satisfies('AC4', `${size}:planned-path-geometry`, 'initial count as recipe and every sample inside the band',
          pathVisibility[size], pathVisibility[size].in_band)
      }
      const hashes = contractSizes(contract).map((size) => fixtures[size].manifest.editor_identity_hash)
      evidence.expect('AC2', 'sizes-have-distinct-identity', contractSizes(contract).length, new Set(hashes).size)
    })

    console.log('[4/6] Loading each fixture through the route...')
    for (const size of contractSizes(contract)) {
      if (!fixtures[size]) continue
      await evidence.phase(['AC3', 'AC4', 'AC5'], `load-${size}`, async () => {
        console.log(`  ${size} cards: restore, selection, visibility and GPU pixels`)
        const observation = await observeWorkload(page, evidence, fixtures[size])
        observations[size] = observation
        if (size === contract.primary_size) {
          console.log(`  ${size} cards: Task edit, save and reload`)
          state.editReload = await checkEditReload(page, evidence, fixtures[size])
        }
        console.log(`  ${size} cards: planned-path extremes and live engine export`)
        await probePlannedPath(page, evidence, contract, fixtures[size], observation)
      })
    }

    await evidence.phase(['AC6'], 'rejection', async () => {
      console.log('[5/6] Rejecting malformed and substituted input...')
      checkSetupRejection(evidence, contract, options.outDir, fixtures)
      const primary = fixtures[contract.primary_size]
      const key = getCheckpointKey(primary.manifest.account_id, primary.manifest.learning_path_id)

      // A second dedicated profile holds the valid primary fixture throughout.
      const seeded = await launch(chromiumPath, otherProfileDir, options.headless)
      let otherBefore: string | null
      try {
        await seeded.page.goto(`${serverUrl}/editor`, { waitUntil: 'domcontentloaded' })
        await seedStorage(seeded.page, fixtureStorageEntries(primary))
        await reloadRoute(seeded.page, primary.size)
        otherBefore = await readStoredCheckpoint(seeded.page, key)
      } finally {
        await seeded.browser.close()
      }

      state.routeRejection = await checkRouteRejection(page, evidence, primary)

      const survivor = await launch(chromiumPath, otherProfileDir, options.headless, false)
      try {
        await survivor.page.goto(`${serverUrl}/editor`, { waitUntil: 'domcontentloaded' })
        await waitForEditorSettled(survivor.page, primary.size)
        const stored = await readStoredCheckpoint(survivor.page, key)
        const ui = await readUi(survivor.page)
        state.otherProfile = { checkpoint_sha256: stored ? sha256(stored) : null, submitted_cards: ui.submitted_cards, checkpoint_error: ui.checkpoint_error }
        evidence.expect('AC6', 'other-profile-checkpoint-unchanged', otherBefore ? sha256(otherBefore) : 'seeded', stored ? sha256(stored) : null)
        evidence.expect('AC6', 'other-profile-still-loads-primary', { submitted_cards: primary.size, checkpoint_error: null },
          { submitted_cards: ui.submitted_cards, checkpoint_error: ui.checkpoint_error })
      } finally {
        await survivor.browser.close()
      }
    })
  } catch (err: unknown) {
    evidence.missing(['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6'], 'driver', err)
  } finally {
    await browser?.close()
    server.kill('SIGTERM')
  }

  console.log('[6/6] Writing fixture metadata and the report...')
  if (options.headless) {
    limitations.push('Headless Chromium with emulated DPR: functional evidence only, not the headed hardware reference browser (contract §1, §3).')
  }
  if (state.adapter?.is_fallback_adapter === true) {
    limitations.push('WebGPU ran on a fallback (software) adapter; drawing is real WebGPU output but not hardware acceleration.')
  }
  limitations.push('Connection visibility counts are centre-to-centre estimates, not tessellated mesh intersections.')
  limitations.push('Planned-path browser probes sample the motion extremes only; continuous-path validation belongs to the L3-03 run.')
  limitations.push('Profiles are separate Chromium user-data directories, so the isolation check confirms the other profile is intact rather than exercising shared storage.')

  const setupMetadataPath = path.join(options.outDir, 'setup-metadata.json')
  const fixtureMetadata = Object.fromEntries(
    (Object.keys(fixtures) as unknown as BenchmarkSize[]).map((size) => {
      const files = fixtureFilePaths(path.join(options.outDir, 'fixtures'), size)
      const describe = (file: string) => ({ path: path.relative(REPO_ROOT, file), sha256: sha256(readFileSync(file)) })
      const fixture = fixtures[size]
      return [size, {
        manifest: describe(files.manifest),
        checkpoint: describe(files.checkpoint),
        camera: describe(files.camera),
        checkpoint_hash: fixture.manifest.checkpoint_hash,
        editor_identity_hash: fixture.manifest.editor_identity_hash,
        application_hash: fixture.manifest.application_hash,
        geometry: fixture.manifest.geometry,
        visibility_band: fixture.manifest.visibility_band,
        planned_path: pathVisibility[size] ?? null,
        connections: estimateConnectionVisibility(fixture.checkpoint.editor.connections, fixture.checkpoint.editor.cards, fixture.camera, fixture.manifest.geometry.canvas_css),
      }]
    })
  )

  evidence.satisfies('AC6', 'setup-metadata-emitted', 'metadata for all three fixtures', Object.keys(fixtureMetadata),
    contractSizes(contract).every((size) => size in fixtureMetadata))
  const verdicts = Object.fromEntries((Object.keys(CRITERIA) as Criterion[]).map((ac) => [ac, evidence.verdict(ac)])) as Record<Criterion, Verdict>
  const overall = overallVerdict(Object.values(verdicts))
  const primary = fixtures[contract.primary_size]
  const setupMetadata = {
    schema: 'gurow-p1-fixture-setup-v1',
    ...identity,
    setup_verdict: overall,
    browser: { executable: chromiumPath, version: state.browserVersion, headless: options.headless, adapter: state.adapter },
    measured_canvas_css: state.canvas,
    viewport_css: { width: CHECK_VIEWPORT.width, height: CHECK_VIEWPORT.height },
    device_pixel_ratio: CHECK_VIEWPORT.dpr,
    storage: { account_id: primary?.manifest.account_id ?? null, learning_path_id: primary?.manifest.learning_path_id ?? null },
    fixtures: fixtureMetadata,
  }
  writeFileSync(setupMetadataPath, JSON.stringify(setupMetadata, null, 2) + '\n')

  const report = {
    schema: 'gurow-t06-l3-02-fixture-report-v2',
    identity,
    environment: setupMetadata.browser,
    measured_canvas_css: state.canvas,
    setup_metadata: path.relative(REPO_ROOT, setupMetadataPath),
    browser_observations: observations,
    edit_reload: state.editReload,
    route_rejection: state.routeRejection,
    other_profile_after_rejection: state.otherProfile,
    checks: evidence.checks,
    verdicts,
    overall_verdict: overall,
    limitations,
    performance: 'No timing measured; no performance verdict is implied.',
  }
  const reportJsonPath = path.join(options.outDir, 'fixture-report.json')
  writeFileSync(reportJsonPath, JSON.stringify(report, null, 2) + '\n')
  writeFileSync(path.join(options.outDir, 'fixture-report.md'), renderMarkdown(report, observations))

  console.log(`\nOverall verdict: ${overall}`)
  for (const ac of Object.keys(CRITERIA) as Criterion[]) console.log(`  ${ac}: ${verdicts[ac]}`)
  console.log(`Report: ${reportJsonPath}`)
  return overall === 'PASS' ? 0 : 1
}

function renderMarkdown(
  report: { identity: Record<string, unknown>; checks: CheckRecord[]; verdicts: Record<Criterion, Verdict>; overall_verdict: Verdict; limitations: string[]; measured_canvas_css: Size | null },
  observations: Partial<Record<BenchmarkSize, WorkloadObservation>>
): string {
  const cell = (value: unknown) => '`' + JSON.stringify(value).replace(/\|/g, '\\|').slice(0, 160) + '`'
  const lines = [
    '# T06-L3-02 benchmark fixture report',
    '',
    ...Object.entries(report.identity).map(([k, v]) => `- **${k}:** \`${String(v)}\``),
    `- **measured canvas (CSS px):** \`${JSON.stringify(report.measured_canvas_css)}\``,
    `- **overall verdict:** **${report.overall_verdict}**`,
    '',
    '## Criteria',
    '',
    '| Criterion | Requirement | Verdict |',
    '| --- | --- | --- |',
    ...(Object.keys(CRITERIA) as Criterion[]).map((ac) => `| ${ac} | ${CRITERIA[ac]} | **${report.verdicts[ac]}** |`),
    '',
    '## Browser workloads',
    '',
    '| Size | Submitted cards | DOM labels | Visible cards | Visible labels | Path probe visible cards (labels) |',
    '| --- | --- | --- | --- | --- | --- |',
    ...Object.values(observations).map((o) =>
      `| ${o!.size} | ${o!.submitted_cards} | ${o!.dom_labels} | ${o!.initial.visible_cards.length} | ${o!.initial.visible_labels} | ` +
      `${o!.path_probe.map((p) => `${p.step} ${p.visible_cards.length} (${p.visible_labels})`).join(', ')} |`),
    '',
    '## Checks',
    '',
    '| Criterion | Check | Expected | Observed | Verdict |',
    '| --- | --- | --- | --- | --- |',
    ...report.checks.map((c) => `| ${c.ac} | ${c.id} | ${cell(c.expected)} | ${cell(c.observed)} | ${c.verdict} |`),
    '',
    '## Limitations',
    '',
    ...report.limitations.map((l) => `- ${l}`),
    '',
  ]
  return lines.join('\n')
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('Fixture check failed:', err)
    process.exit(1)
  }
)
