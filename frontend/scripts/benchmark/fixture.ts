/**
 * Deterministic benchmark fixtures for P1/T06 (issue #35 / T06-L3-02).
 * Contracts: gurow-p1-v5 (protocol-v5.json, ADR 0020) and the historical gurow-p1-v4
 * (protocol-v4.json); docs/benchmarks/p1/contract.md §4.
 *
 * The numeric workload comes from the contract file, and the camera geometry
 * from the canvas dimensions measured in the settled browser layout, so neither
 * is restated here. Written fixture files are only accepted back after they
 * reproduce the recipe exactly, which keeps a malformed or smaller workload
 * from being substituted silently.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type {
  CameraState,
  LearningPathCheckpoint,
  PrerequisiteConnection,
  SkillCard,
  SkillPayload,
} from '../../src/components/editor/protocol'
import { CameraStateSchema } from '../../src/components/editor/protocol'
import {
  getCameraKey,
  getCheckpointKey,
  validateCheckpointIntegrity,
} from '../../src/components/editor/checkpoint'
import { INITIAL_LEARNING_PATH_FIXTURE } from '../../src/fixtures/learningPath'
/** The current contract. gurow-p1-v4 stays readable so its 1,000-card primary can be re-run for comparison. */
export const CONTRACT_ID = 'gurow-p1-v5'
export const CONTRACT_IDS = ['gurow-p1-v4', CONTRACT_ID] as const
export type ContractId = (typeof CONTRACT_IDS)[number]

export const FIXTURE_GENERATOR_VERSION = 'gurow-p1-fixture-v2'
export const BENCHMARK_SIZES = [100, 300, 1000, 10000] as const
export type BenchmarkSize = (typeof BENCHMARK_SIZES)[number]

/**
 * Storage scope of the route (`frontend/src/routes/index.tsx`). The browser
 * check proves the match: a wrong scope restores the four-Skill fallback.
 */
export const BENCHMARK_ACCOUNT_ID = 'fixture-user'
export const BENCHMARK_PATH_ID = INITIAL_LEARNING_PATH_FIXTURE.id

/** Contract §4: target viewport block and the card-plus-gap cell used for z0. */
const TARGET_COLUMNS = 10
const PRIMARY_TARGET_ROWS = 20
const Z0_CELL_WORLD = { width: 220, height: 120 } as const
const Z0_BOUNDS = { min: 0.1, max: 4 } as const

export interface Size {
  width: number
  height: number
}

export interface WorldPoint {
  x: number
  y: number
}

const SizeSchema = z.object({ width: z.number().positive(), height: z.number().positive() })
const WorkloadSchema = z.object({
  cards: z.number().int(),
  connections: z.number().int(),
  grid_columns: z.number().int().positive(),
  grid_rows: z.number().int().positive(),
})
const ProtocolSchema = z.object({
  contract_id: z.enum(CONTRACT_IDS),
  sampling: z.object({
    pan_drag_amplitude_cell_fraction: z.number().positive(),
    zoom_min_factor: z.number().positive(),
    zoom_max_factor: z.number().positive(),
  }),
  primary: WorkloadSchema.extend({
    initial_visible_cards: z.number().int().positive(),
    visible_cards_median_min: z.number().int().positive(),
    visible_cards_median_max: z.number().int().positive(),
    html_labels: z.literal(true),
  }),
  comparisons: z.array(WorkloadSchema),
  card_size_world: SizeSchema,
  minimum_canvas_css: SizeSchema,
})

export interface GridRecipe {
  cards: BenchmarkSize
  connections: number
  grid_columns: number
  grid_rows: number
  target_columns: number
  target_rows: number
  /** Geometric visible cards expected before any interaction. */
  initial_visible_cards: number
  /** Primary per-run median visibility band; null for either comparison. */
  visibility_band: { min: number; max: number } | null
}

/** Planned motion extremes (contract §5, protocol-v4.json `sampling`). */
export interface PlannedMotion {
  /** Pan and drag amplitude as a fraction of one cell pitch. */
  amplitude_cell_fraction: number
  zoom_min_factor: number
  zoom_max_factor: number
}

export interface BenchmarkContract {
  contract_id: ContractId
  /** SHA-256 of the contract file bytes, for source identity. */
  sha256: string
  /** Size of the primary workload that carries the pass thresholds. */
  primary_size: BenchmarkSize
  motion: PlannedMotion
  card_size_world: Size
  minimum_canvas_css: Size
  /** Only the sizes the contract defines; v4 has no 300-card workload. */
  recipes: Partial<Record<BenchmarkSize, GridRecipe>>
}

/**
 * Parses a protocol file into fixture recipes (contract §1 and §4).
 * Visibility bands are primary-run median limits, not path-extreme gates;
 * comparisons have no visibility threshold.
 */
export function parseBenchmarkContract(raw: string): BenchmarkContract {
  const protocol = ProtocolSchema.parse(JSON.parse(raw))
  const primarySize = protocol.primary.cards as BenchmarkSize
  const recipes: Partial<Record<BenchmarkSize, GridRecipe>> = {}

  for (const workload of [protocol.primary, ...protocol.comparisons]) {
    const size = workload.cards as BenchmarkSize
    if (!BENCHMARK_SIZES.includes(size)) {
      throw new Error(`Contract ${protocol.contract_id} workload of ${workload.cards} cards is not a benchmark size.`)
    }
    if (workload.grid_columns * workload.grid_rows !== size) {
      throw new Error(`Contract grid ${workload.grid_columns}x${workload.grid_rows} does not hold ${size} cards.`)
    }
    const fullGrid = workload.grid_rows < PRIMARY_TARGET_ROWS
    const targetRows = fullGrid ? workload.grid_rows : PRIMARY_TARGET_ROWS
    recipes[size] = {
      cards: size,
      connections: workload.connections,
      grid_columns: workload.grid_columns,
      grid_rows: workload.grid_rows,
      target_columns: TARGET_COLUMNS,
      target_rows: targetRows,
      initial_visible_cards: fullGrid ? size : protocol.primary.initial_visible_cards,
      visibility_band: size === primarySize
        ? { min: protocol.primary.visible_cards_median_min, max: protocol.primary.visible_cards_median_max }
        : null,
    }
  }

  return {
    contract_id: protocol.contract_id,
    sha256: createHash('sha256').update(raw).digest('hex'),
    primary_size: primarySize,
    motion: {
      amplitude_cell_fraction: protocol.sampling.pan_drag_amplitude_cell_fraction,
      zoom_min_factor: protocol.sampling.zoom_min_factor,
      zoom_max_factor: protocol.sampling.zoom_max_factor,
    },
    card_size_world: protocol.card_size_world,
    minimum_canvas_css: protocol.minimum_canvas_css,
    recipes,
  }
}

/** Benchmark sizes the contract defines, smallest first. */
export function contractSizes(contract: BenchmarkContract): BenchmarkSize[] {
  return BENCHMARK_SIZES.filter((size) => contract.recipes[size])
}

/** The contract's recipe for `size`; throws when the contract defines no such workload. */
export function requireRecipe(contract: BenchmarkContract, size: BenchmarkSize): GridRecipe {
  const recipe = contract.recipes[size]
  if (!recipe) throw new Error(`Contract ${contract.contract_id} defines no ${size}-card workload.`)
  return recipe
}

export function loadBenchmarkContract(contractPath: string): BenchmarkContract {
  return parseBenchmarkContract(readFileSync(contractPath, 'utf8'))
}

export interface FixtureGeometry {
  canvas_css: Size
  z0: number
  cell_pitch_world: WorldPoint
  card_size_world: Size
  start_col: number
  start_row: number
  center_card: { id: string; col: number; row: number; world_pos: WorldPoint }
  camera: CameraState
}

export interface FixtureManifest {
  contract_id: ContractId
  contract_sha256: string
  generator_version: typeof FIXTURE_GENERATOR_VERSION
  size: BenchmarkSize
  card_count: number
  connection_count: number
  grid_columns: number
  grid_rows: number
  target_columns: number
  target_rows: number
  geometry: FixtureGeometry
  initial_visible_cards: number
  visibility_band: { min: number; max: number } | null
  /** SHA-256 of the checkpoint exactly as written. */
  checkpoint_hash: string
  /** Order-insensitive editor identity at engine (f32) precision. */
  editor_identity_hash: string
  /** Order-insensitive Skill/Task payload identity. */
  application_hash: string
  saved_at: string
  learning_path_id: string
  account_id: string
}

export interface BenchmarkFixture {
  size: BenchmarkSize
  recipe: GridRecipe
  manifest: FixtureManifest
  checkpoint: LearningPathCheckpoint
  camera: CameraState
}

export function formatSkillId(index: number): string {
  return `p1-skill-${String(index).padStart(5, '0')}`
}

export function formatTaskId(index: number): string {
  return `p1-task-${String(index).padStart(5, '0')}`
}

export function isBenchmarkSkillId(id: string): boolean {
  return /^p1-skill-\d+$/.test(id)
}

export function parseSkillIndex(id: string): number {
  const match = id.match(/^p1-skill-(\d+)$/)
  if (!match) {
    throw new Error(`Invalid benchmark Skill ID: '${id}'`)
  }
  return parseInt(match[1], 10)
}

/** World position of the card centred in grid cell (col, row), at engine f32 precision. */
function cardWorldPosition(col: number, row: number, pitch: WorldPoint, card: Size): WorldPoint {
  return {
    x: Math.fround(col * pitch.x + (pitch.x - card.width) / 2),
    y: Math.fround(row * pitch.y + (pitch.y - card.height) / 2),
  }
}

/**
 * Computes z0, cell pitches and the initial camera (contract §4):
 * z0 = min(1, W/(10*220), H/(rows*120)); px = W/(10*z0), py = H/(rows*z0);
 * the viewport starts at the interior block floor((cols-10)/2), floor((rows-rows_t)/2).
 */
export function computeFixtureGeometry(
  recipe: GridRecipe,
  cardSize: Size,
  canvasCss: Size
): FixtureGeometry {
  const { width: W, height: H } = canvasCss
  const z0 = Math.min(
    1,
    W / (recipe.target_columns * Z0_CELL_WORLD.width),
    H / (recipe.target_rows * Z0_CELL_WORLD.height)
  )
  if (!(z0 >= Z0_BOUNDS.min && z0 <= Z0_BOUNDS.max)) {
    throw new Error(
      `Geometry setup failure: z0 ${z0} for canvas ${W}x${H} is outside [${Z0_BOUNDS.min}, ${Z0_BOUNDS.max}].`
    )
  }

  const pitch = { x: W / (recipe.target_columns * z0), y: H / (recipe.target_rows * z0) }
  const startCol = Math.floor((recipe.grid_columns - recipe.target_columns) / 2)
  const startRow = Math.floor((recipe.grid_rows - recipe.target_rows) / 2)
  const centerCol = startCol + Math.floor(recipe.target_columns / 2)
  const centerRow = startRow + Math.floor(recipe.target_rows / 2)

  return {
    canvas_css: { width: W, height: H },
    z0,
    cell_pitch_world: pitch,
    card_size_world: { ...cardSize },
    start_col: startCol,
    start_row: startRow,
    center_card: {
      id: formatSkillId(centerRow * recipe.grid_columns + centerCol),
      col: centerCol,
      row: centerRow,
      world_pos: cardWorldPosition(centerCol, centerRow, pitch, cardSize),
    },
    camera: {
      // `0 -` keeps a zero start index from serialising as -0.
      offset_x: 0 - startCol * pitch.x * z0,
      offset_y: 0 - startRow * pitch.y * z0,
      zoom: z0,
    },
  }
}

/**
 * Forward edges by increasing gap g=1,2,..., then source i=0..N-g-1, taking
 * (i,i+g) until the recipe's edge count exists (contract §4).
 */
export function generateConnections(recipe: GridRecipe): PrerequisiteConnection[] {
  const size = recipe.cards
  const connections: PrerequisiteConnection[] = []
  for (let g = 1; connections.length < recipe.connections && g < size; g++) {
    for (let i = 0; i < size - g && connections.length < recipe.connections; i++) {
      connections.push({ from_id: formatSkillId(i), to_id: formatSkillId(i + g) })
    }
  }
  return connections
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** SHA-256 of the checkpoint exactly as serialized. */
export function computeCheckpointHash(checkpoint: LearningPathCheckpoint): string {
  return sha256Json(checkpoint)
}

/**
 * Identity of an editor document as the engine holds it: IDs, titles, f32
 * geometry and edges, independent of export order. Comparing this with a live
 * engine export proves the loaded document is the fixture.
 */
export function computeEditorIdentityHash(editor: {
  cards: SkillCard[]
  connections: PrerequisiteConnection[]
}): string {
  const cards = editor.cards
    .map((c) => [c.id, c.title, Math.fround(c.position.x), Math.fround(c.position.y),
      Math.fround(c.size.width), Math.fround(c.size.height)])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  const connections = editor.connections
    .map((c) => `${c.from_id}->${c.to_id}`)
    .sort()
  return sha256Json({ cards, connections })
}

/** Order-insensitive identity of the Skill/Task application payload. */
export function computeApplicationHash(application: LearningPathCheckpoint['application']): string {
  const skills = [...application.skills].sort((a, b) => a.id.localeCompare(b.id))
  return sha256Json({ learning_path_id: application.learning_path_id, skills })
}

export interface GenerateFixtureOptions {
  canvasCss: Size
  savedAt?: string
}

/** Generates a complete, validated benchmark fixture (contract §4). */
export function generateBenchmarkFixture(
  contract: BenchmarkContract,
  size: BenchmarkSize,
  options: GenerateFixtureOptions
): BenchmarkFixture {
  const recipe = requireRecipe(contract, size)
  const cardSize = contract.card_size_world
  const geometry = computeFixtureGeometry(recipe, cardSize, options.canvasCss)
  const savedAt = options.savedAt ?? '2026-09-28T00:00:00.000Z'

  const cards: SkillCard[] = []
  const skills: SkillPayload[] = []
  for (let i = 0; i < size; i++) {
    const skillId = formatSkillId(i)
    cards.push({
      id: skillId,
      title: `Skill ${skillId}`,
      position: cardWorldPosition(
        i % recipe.grid_columns,
        Math.floor(i / recipe.grid_columns),
        geometry.cell_pitch_world,
        cardSize
      ),
      size: { ...cardSize },
    })
    skills.push({
      id: skillId,
      outcome: `Master and demonstrate core competency for ${skillId}.`,
      tasks: [
        {
          id: formatTaskId(i),
          title: `Task for ${skillId}`,
          description: `Deterministic benchmark verification task for ${skillId}.`,
          required: i % 2 === 0,
        },
      ],
    })
  }

  const checkpoint: LearningPathCheckpoint = {
    version: 1,
    saved_at: savedAt,
    editor: {
      format_version: 1,
      revision: 1,
      cards,
      connections: generateConnections(recipe),
    },
    application: {
      learning_path_id: BENCHMARK_PATH_ID,
      skills,
    },
  }

  const manifest: FixtureManifest = {
    contract_id: contract.contract_id,
    contract_sha256: contract.sha256,
    generator_version: FIXTURE_GENERATOR_VERSION,
    size,
    card_count: cards.length,
    connection_count: checkpoint.editor.connections.length,
    grid_columns: recipe.grid_columns,
    grid_rows: recipe.grid_rows,
    target_columns: recipe.target_columns,
    target_rows: recipe.target_rows,
    geometry,
    initial_visible_cards: recipe.initial_visible_cards,
    visibility_band: recipe.visibility_band,
    checkpoint_hash: computeCheckpointHash(checkpoint),
    editor_identity_hash: computeEditorIdentityHash(checkpoint.editor),
    application_hash: computeApplicationHash(checkpoint.application),
    saved_at: savedAt,
    learning_path_id: BENCHMARK_PATH_ID,
    account_id: BENCHMARK_ACCOUNT_ID,
  }

  const fixture: BenchmarkFixture = {
    size,
    recipe,
    manifest,
    checkpoint,
    camera: { ...geometry.camera },
  }
  validateBenchmarkFixture(fixture)
  return fixture
}

/**
 * Validates the workload invariants (issue #35 AC1/AC2): exact counts, stable
 * IDs, one distinct nonempty Task per Skill, a forward-only DAG without self,
 * duplicate or dangling edges, the route's checkpoint integrity rules, and the
 * manifest hashes.
 */
export function validateBenchmarkFixture(fixture: BenchmarkFixture): void {
  const { recipe, checkpoint, camera, manifest } = fixture
  const cards = checkpoint.editor.cards
  const connections = checkpoint.editor.connections
  const skills = checkpoint.application.skills

  if (fixture.size !== recipe.cards || manifest.size !== recipe.cards) {
    throw new Error(`Fixture size mismatch: recipe ${recipe.cards}, fixture ${fixture.size}, manifest ${manifest.size}`)
  }
  if (cards.length !== recipe.cards) {
    throw new Error(`AC1 Violation: card count must be exactly ${recipe.cards}, got ${cards.length}`)
  }
  if (connections.length !== recipe.connections) {
    throw new Error(`AC1 Violation: connection count must be exactly ${recipe.connections}, got ${connections.length}`)
  }
  if (skills.length !== recipe.cards) {
    throw new Error(`AC1 Violation: skill count must be exactly ${recipe.cards}, got ${skills.length}`)
  }

  const cardIds = new Set<string>()
  cards.forEach((card, i) => {
    if (card.id !== formatSkillId(i)) {
      throw new Error(`AC1 Violation: expected card ID '${formatSkillId(i)}', got '${card.id}'`)
    }
    if (cardIds.has(card.id)) {
      throw new Error(`AC2 Violation: duplicate card ID '${card.id}'`)
    }
    cardIds.add(card.id)
  })

  const taskIds = new Set<string>()
  skills.forEach((skill, i) => {
    if (skill.id !== cards[i].id) {
      throw new Error(`AC2 Violation: skill ID '${skill.id}' does not match card ID '${cards[i].id}'`)
    }
    if (skill.tasks.length !== 1) {
      throw new Error(`AC1 Violation: skill '${skill.id}' must have exactly 1 task, got ${skill.tasks.length}`)
    }
    const task = skill.tasks[0]
    if (task.id !== formatTaskId(i)) {
      throw new Error(`AC1 Violation: expected task ID '${formatTaskId(i)}', got '${task.id}'`)
    }
    if (!task.title.trim() || !task.description.trim()) {
      throw new Error(`AC1 Violation: task '${task.id}' needs a nonempty title and description`)
    }
    if (taskIds.has(task.id)) {
      throw new Error(`AC2 Violation: duplicate task ID '${task.id}'`)
    }
    taskIds.add(task.id)
  })

  const edges = new Set<string>()
  for (const conn of connections) {
    if (conn.from_id === conn.to_id) {
      throw new Error(`AC2 Violation: self-connection on card '${conn.from_id}'`)
    }
    const edgeKey = `${conn.from_id}->${conn.to_id}`
    if (edges.has(edgeKey)) {
      throw new Error(`AC2 Violation: duplicate connection '${edgeKey}'`)
    }
    edges.add(edgeKey)
    if (!cardIds.has(conn.from_id) || !cardIds.has(conn.to_id)) {
      throw new Error(`AC2 Violation: dangling connection '${edgeKey}'`)
    }
    // Every edge points to a higher index, so no cycle can exist.
    if (parseSkillIndex(conn.from_id) >= parseSkillIndex(conn.to_id)) {
      throw new Error(`AC2 Violation: backward or cyclic connection '${edgeKey}'`)
    }
  }

  validateCheckpointIntegrity(checkpoint, manifest.learning_path_id)
  CameraStateSchema.parse(camera)

  const hashes = {
    checkpoint_hash: computeCheckpointHash(checkpoint),
    editor_identity_hash: computeEditorIdentityHash(checkpoint.editor),
    application_hash: computeApplicationHash(checkpoint.application),
  }
  for (const [field, computed] of Object.entries(hashes)) {
    const recorded = manifest[field as keyof typeof hashes]
    if (computed !== recorded) {
      throw new Error(`AC1 Violation: ${field} mismatch: manifest '${recorded}', computed '${computed}'`)
    }
  }
}

export interface CanvasRect {
  left: number
  top: number
  width: number
  height: number
}

/** True when two rectangles overlap with positive area (contract §4 visibility). */
export function intersectsWithPositiveArea(a: CanvasRect, b: CanvasRect): boolean {
  const width = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)
  const height = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top)
  return width > 0 && height > 0
}

/** A card displaced along the planned drag path. */
export interface CardDisplacement {
  id: string
  dx: number
  dy: number
}

/** IDs of cards whose screen rectangle intersects the canvas [0,W]x[0,H]. */
export function computeVisibleCardIds(
  cards: SkillCard[],
  camera: CameraState,
  canvasCss: Size,
  displacement?: CardDisplacement
): string[] {
  const canvas = { left: 0, top: 0, ...canvasCss }
  const visible: string[] = []
  for (const card of cards) {
    const moved = displacement?.id === card.id
    const x = card.position.x + (moved ? displacement.dx : 0)
    const y = card.position.y + (moved ? displacement.dy : 0)
    const rect = {
      left: x * camera.zoom + camera.offset_x,
      top: y * camera.zoom + camera.offset_y,
      width: card.size.width * camera.zoom,
      height: card.size.height * camera.zoom,
    }
    if (intersectsWithPositiveArea(rect, canvas)) visible.push(card.id)
  }
  return visible
}

/**
 * Conservative connection counts. The renderer tessellates curves, so these
 * centre-to-centre figures are estimates, not exact mesh intersections.
 */
export function estimateConnectionVisibility(
  connections: PrerequisiteConnection[],
  cards: SkillCard[],
  camera: CameraState,
  canvasCss: Size
): { both_endpoint_centres_visible_estimate: number; bounding_box_intersects_estimate: number } {
  const cardsById = new Map(cards.map((c) => [c.id, c]))
  const centre = (card: SkillCard) => ({
    x: (card.position.x + card.size.width / 2) * camera.zoom + camera.offset_x,
    y: (card.position.y + card.size.height / 2) * camera.zoom + camera.offset_y,
  })
  const inside = (p: WorldPoint) => p.x >= 0 && p.x <= canvasCss.width && p.y >= 0 && p.y <= canvasCss.height

  let both = 0
  let bbox = 0
  for (const conn of connections) {
    const from = cardsById.get(conn.from_id)
    const to = cardsById.get(conn.to_id)
    if (!from || !to) continue
    const a = centre(from)
    const b = centre(to)
    if (inside(a) && inside(b)) both++
    // Closed-interval test: a horizontal or vertical segment has a zero-area box.
    if (Math.max(a.x, b.x) >= 0 && Math.min(a.x, b.x) <= canvasCss.width &&
        Math.max(a.y, b.y) >= 0 && Math.min(a.y, b.y) <= canvasCss.height) bbox++
  }
  return { both_endpoint_centres_visible_estimate: both, bounding_box_intersects_estimate: bbox }
}

export interface PathVisibilityResult {
  initial_visible: number
  min_visible: number
  max_visible: number
  samples: number
  in_band: boolean
  violations: string[]
}

/** Samples per half-period of the planned motion (0.05 of the amplitude). */
const PATH_STEPS = 20

/** Screen-space pan/drag amplitude in CSS px for a fixture (contract §5). */
export function motionAmplitudeCss(geometry: FixtureGeometry, motion: PlannedMotion): number {
  return motion.amplitude_cell_fraction * geometry.cell_pitch_world.x * geometry.z0
}

/** Zoom factor at a motion phase in [-1, 1], reaching the contract extremes at ±1. */
export function zoomFactorAt(phase: number, motion: PlannedMotion): number {
  return phase >= 0 ? 1 + phase * (motion.zoom_max_factor - 1) : 1 + phase * (1 - motion.zoom_min_factor)
}

/** Camera after zooming by `factor` about the canvas centre. */
export function zoomAboutCentre(camera: CameraState, factor: number, canvas: Size): CameraState {
  return {
    offset_x: canvas.width / 2 - (canvas.width / 2 - camera.offset_x) * factor,
    offset_y: canvas.height / 2 - (canvas.height / 2 - camera.offset_y) * factor,
    zoom: camera.zoom * factor,
  }
}

/**
 * Checks geometric card visibility along the planned pan, zoom and drag paths
 * (contract §5): pan moves camera X and drag moves the centre card by the
 * contract amplitude, zoom scales between the contract factors about the canvas
 * centre. Every sample must stay inside the visibility band, if one applies.
 */
export function validatePlannedPathVisibility(fixture: BenchmarkFixture, motion: PlannedMotion): PathVisibilityResult {
  const { recipe, checkpoint, camera, manifest } = fixture
  const { canvas_css: canvas, center_card } = manifest.geometry
  const amplitude = motionAmplitudeCss(manifest.geometry, motion)
  const cards = checkpoint.editor.cards
  const violations: string[] = []
  const counts: number[] = []

  const countVisible = (label: string, view: CameraState, displacement?: CardDisplacement) => {
    const count = computeVisibleCardIds(cards, view, canvas, displacement).length
    counts.push(count)
    const band = recipe.visibility_band
    if (band && (count < band.min || count > band.max)) {
      violations.push(`${label}: ${count} visible cards left band [${band.min}, ${band.max}]`)
    }
  }

  const initial = computeVisibleCardIds(cards, camera, canvas).length
  if (initial !== recipe.initial_visible_cards) {
    violations.push(`initial: ${initial} visible cards, expected ${recipe.initial_visible_cards}`)
  }

  for (let k = -PATH_STEPS; k <= PATH_STEPS; k++) {
    const phase = k / PATH_STEPS
    countVisible(`pan ${phase}`, { ...camera, offset_x: camera.offset_x + phase * amplitude })
    countVisible(`zoom ${phase}`, zoomAboutCentre(camera, zoomFactorAt(phase, motion), canvas))
    countVisible(`drag ${phase}`, camera, { id: center_card.id, dx: (phase * amplitude) / camera.zoom, dy: 0 })
  }

  return {
    initial_visible: initial,
    min_visible: Math.min(initial, ...counts),
    max_visible: Math.max(initial, ...counts),
    samples: counts.length + 1,
    in_band: violations.length === 0,
    violations,
  }
}

export interface FixtureFiles {
  manifest: string
  checkpoint: string
  camera: string
}

export function fixtureFilePaths(dir: string, size: BenchmarkSize): FixtureFiles {
  return {
    manifest: join(dir, `manifest-${size}.json`),
    checkpoint: join(dir, `checkpoint-${size}.json`),
    camera: join(dir, `camera-${size}.json`),
  }
}

/** Writes the manifest, checkpoint and camera files for one fixture. */
export function writeFixtureFiles(dir: string, fixture: BenchmarkFixture): FixtureFiles {
  mkdirSync(dir, { recursive: true })
  const files = fixtureFilePaths(dir, fixture.size)
  writeFileSync(files.manifest, JSON.stringify(fixture.manifest, null, 2) + '\n')
  writeFileSync(files.checkpoint, JSON.stringify(fixture.checkpoint, null, 2) + '\n')
  writeFileSync(files.camera, JSON.stringify(fixture.camera, null, 2) + '\n')
  return files
}

export class FixtureRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FixtureRejectedError'
  }
}

/**
 * Reads fixture files back for setup and accepts them only if they are exactly
 * the recipe regenerated at the recorded canvas. A malformed, mismatched or
 * smaller workload is rejected instead of being loaded.
 */
export function readFixtureFiles(
  contract: BenchmarkContract,
  dir: string,
  size: BenchmarkSize
): BenchmarkFixture {
  const files = fixtureFilePaths(dir, size)
  try {
    const manifest = JSON.parse(readFileSync(files.manifest, 'utf8')) as FixtureManifest
    const checkpoint = JSON.parse(readFileSync(files.checkpoint, 'utf8')) as LearningPathCheckpoint
    const camera = JSON.parse(readFileSync(files.camera, 'utf8')) as CameraState
    if (manifest.size !== size) {
      throw new Error(`manifest describes ${manifest.size} cards, setup requested ${size}`)
    }
    if (manifest.contract_sha256 !== contract.sha256) {
      throw new Error('manifest was generated from a different contract file')
    }
    const expected = generateBenchmarkFixture(contract, size, {
      canvasCss: manifest.geometry.canvas_css,
      savedAt: manifest.saved_at,
    })
    const loaded: BenchmarkFixture = { size, recipe: expected.recipe, manifest, checkpoint, camera }
    validateBenchmarkFixture(loaded)
    if (JSON.stringify(manifest) !== JSON.stringify(expected.manifest)) {
      throw new Error('manifest differs from the regenerated recipe')
    }
    if (JSON.stringify(camera) !== JSON.stringify(expected.camera)) {
      throw new Error('camera differs from the manifest geometry')
    }
    return loaded
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new FixtureRejectedError(`Rejected ${size}-card fixture in ${dir}: ${reason}`)
  }
}

/** The route's own storage keys and values that seed one fixture. */
export function fixtureStorageEntries(fixture: BenchmarkFixture): Array<[string, string]> {
  const { account_id, learning_path_id } = fixture.manifest
  return [
    [getCheckpointKey(account_id, learning_path_id), JSON.stringify(fixture.checkpoint)],
    [getCameraKey(account_id, learning_path_id), JSON.stringify(fixture.camera)],
  ]
}
