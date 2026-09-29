/**
 * Deterministic benchmark fixtures and generator for P1/T06 (issue #35 / T06-L3-02).
 * Contract: gurow-p1-v1 (docs/benchmarks/p1/contract.md and protocol.json).
 *
 * Provides:
 * - Deterministic card grid, DAG forward-edge connections, and Task associations
 *   for 100, 1,000 and 10,000 workloads.
 * - Strict integrity validation (no cycles, self-edges, dangling edges, duplicates,
 *   or broken Task associations).
 * - Exact viewport geometry and initial camera offsets targeting 200 visible cards
 *   (or 100 for comparison).
 * - Geometric card and connection visibility calculations across planned interaction paths.
 * - Deterministic manifest computation and SHA-256 fingerprinting.
 * - LocalStorage seeding helpers for browser runs.
 */

import { createHash } from 'node:crypto'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  CameraState,
  LearningPathCheckpoint,
  PrerequisiteConnection,
  SkillCard,
  SkillPayload,
  TaskPayload,
} from '../../src/components/editor/protocol'
import { CameraStateSchema } from '../../src/components/editor/protocol'
import { validateCheckpointIntegrity } from '../../src/components/editor/checkpoint'
import { INITIAL_LEARNING_PATH_FIXTURE } from '../../src/fixtures/learningPath'

export const CONTRACT_ID = 'gurow-p1-v1' as const
export const BENCHMARK_SIZES = [100, 1000, 10000] as const
export type BenchmarkSize = (typeof BENCHMARK_SIZES)[number]

export const BENCHMARK_ACCOUNT_ID = 'fixture-user' as const
export const BENCHMARK_PATH_ID = INITIAL_LEARNING_PATH_FIXTURE.id

export const REFERENCE_VIEWPORT_CSS = {
  width: 1200,
  height: 720,
} as const

/**
 * Settled canvas CSS dimensions inside the 1200x720 reference window:
 * - Width: 1200 - 288 (left sidebar) - 320 (right sidebar) = 592 CSS px.
 * - Height: 720 - 44 (header) - 48 (toolbar) = 628 CSS px.
 * Contract §4: "With settled canvas CSS dimensions W,H, target a 10-column x 20-row viewport".
 */
export const SETTLED_CANVAS_CSS = {
  width: 592,
  height: 628,
} as const

export const REFERENCE_CANVAS_CSS = SETTLED_CANVAS_CSS

export const CARD_SIZE_WORLD = {
  width: 180,
  height: 80,
} as const

export interface GridRecipe {
  cards: BenchmarkSize
  connections: number
  grid_columns: number
  grid_rows: number
  target_columns: number
  target_rows: number
  initial_visible_cards: number
  visible_cards_min: number
  visible_cards_max: number
}

export const GRID_RECIPES: Record<BenchmarkSize, GridRecipe> = {
  100: {
    cards: 100,
    connections: 200,
    grid_columns: 10,
    grid_rows: 10,
    target_columns: 10,
    target_rows: 10,
    initial_visible_cards: 100,
    visible_cards_min: 90,
    visible_cards_max: 100,
  },
  1000: {
    cards: 1000,
    connections: 2000,
    grid_columns: 25,
    grid_rows: 40,
    target_columns: 10,
    target_rows: 20,
    initial_visible_cards: 200,
    visible_cards_min: 180,
    visible_cards_max: 240,
  },
  10000: {
    cards: 10000,
    connections: 20000,
    grid_columns: 100,
    grid_rows: 100,
    target_columns: 10,
    target_rows: 20,
    initial_visible_cards: 200,
    visible_cards_min: 180,
    visible_cards_max: 240,
  },
}

export interface FixtureGeometry {
  canvas_css: { width: number; height: number }
  z0: number
  px: number
  py: number
  card_size: { width: number; height: number }
  start_col: number
  start_row: number
  center_col: number
  center_row: number
  center_card_id: string
  center_card_world: { x: number; y: number }
  camera: CameraState
}

export interface FixtureManifest {
  contract_id: typeof CONTRACT_ID
  size: BenchmarkSize
  card_count: number
  connection_count: number
  grid_columns: number
  grid_rows: number
  target_columns: number
  target_rows: number
  cell_pitch_world: { x: number; y: number }
  camera_initial: CameraState
  center_card: {
    id: string
    col: number
    row: number
    world_pos: { x: number; y: number }
  }
  initial_visible_cards: number
  visibility_band: { min: number; max: number }
  checkpoint_hash: string
  created_at: string
  learning_path_id: string
  account_id: string
}

export interface BenchmarkFixture {
  size: BenchmarkSize
  recipe: GridRecipe
  geometry: FixtureGeometry
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

export function parseSkillIndex(id: string): number {
  const match = id.match(/^p1-skill-(\d+)$/)
  if (!match) {
    throw new Error(`Invalid benchmark Skill ID: '${id}'`)
  }
  return parseInt(match[1], 10)
}

/**
 * Computes world cell pitches, scale factor z0, and initial camera offset
 * following Contract §4:
 *
 * - With settled canvas CSS dimensions W, H, target 10 cols x 20 rows (or 10x10 for 100).
 * - z0 = min(1, W / (targetCols * 220), H / (targetRows * 120)).
 * - Fails geometry setup if z0 is outside [0.1, 4].
 * - px = W / (targetCols * z0), py = H / (targetRows * z0).
 * - Centered viewport on interior block: startCol = floor((cols - targetCols) / 2),
 *   startRow = floor((rows - targetRows) / 2).
 * - Camera offset: offset_x = -startCol * (W / targetCols), offset_y = -startRow * (H / targetRows).
 */
export function computeFixtureGeometry(
  size: BenchmarkSize,
  canvasCss: { width: number; height: number } = SETTLED_CANVAS_CSS
): FixtureGeometry {
  const recipe = GRID_RECIPES[size]
  if (!recipe) {
    throw new Error(`Unsupported benchmark fixture size: ${size}`)
  }

  const { width: W, height: H } = canvasCss
  const targetCols = recipe.target_columns
  const targetRows = recipe.target_rows

  const z0 = Math.min(1, W / (targetCols * 220), H / (targetRows * 120))
  if (z0 < 0.1 || z0 > 4.0) {
    throw new Error(
      `Geometry setup failure: computed z0 ${z0.toFixed(4)} is outside permitted bounds [0.1, 4.0].`
    )
  }

  const px = W / (targetCols * z0)
  const py = H / (targetRows * z0)

  const startCol = Math.floor((recipe.grid_columns - targetCols) / 2)
  const startRow = Math.floor((recipe.grid_rows - targetRows) / 2)

  const offset_x = -startCol * (W / targetCols)
  const offset_y = -startRow * (H / targetRows)

  const centerCol = startCol + Math.floor(targetCols / 2)
  const centerRow = startRow + Math.floor(targetRows / 2)
  const centerIndex = centerRow * recipe.grid_columns + centerCol
  const centerCardId = formatSkillId(centerIndex)

  const centerCardWorld = {
    x: centerCol * px + (px - CARD_SIZE_WORLD.width) / 2,
    y: centerRow * py + (py - CARD_SIZE_WORLD.height) / 2,
  }

  return {
    canvas_css: { width: W, height: H },
    z0,
    px,
    py,
    card_size: { ...CARD_SIZE_WORLD },
    start_col: startCol,
    start_row: startRow,
    center_col: centerCol,
    center_row: centerRow,
    center_card_id: centerCardId,
    center_card_world: centerCardWorld,
    camera: {
      offset_x,
      offset_y,
      zoom: z0,
    },
  }
}

/**
 * Generates forward connections following Contract §4:
 *
 * "Add forward edges by enumerating increasing gap g=1,2,..., then source i=0..N-g-1,
 * taking (i,i+g) until 2*N edges exist. No duplicate, self, cross-Path or cyclic edge is possible."
 */
export function generateConnections(size: BenchmarkSize): PrerequisiteConnection[] {
  const targetCount = size * 2
  const connections: PrerequisiteConnection[] = []
  let g = 1

  while (connections.length < targetCount) {
    for (let i = 0; i < size - g && connections.length < targetCount; i++) {
      connections.push({
        from_id: formatSkillId(i),
        to_id: formatSkillId(i + g),
      })
    }
    g++
  }

  return connections
}

/** Computes canonical SHA-256 hash for deterministic checkpoint comparison. */
export function computeCheckpointHash(checkpoint: LearningPathCheckpoint): string {
  const json = JSON.stringify(checkpoint)
  return createHash('sha256').update(json).digest('hex')
}

export interface GenerateFixtureOptions {
  canvasCss?: { width: number; height: number }
  savedAt?: string
  learningPathId?: string
  accountId?: string
}

/**
 * Generates a complete, validated benchmark fixture matching Contract §4.
 */
export function generateBenchmarkFixture(
  size: BenchmarkSize,
  options: GenerateFixtureOptions = {}
): BenchmarkFixture {
  const recipe = GRID_RECIPES[size]
  if (!recipe) {
    throw new Error(`Unsupported benchmark size: ${size}`)
  }

  const canvasCss = options.canvasCss ?? SETTLED_CANVAS_CSS
  const geometry = computeFixtureGeometry(size, canvasCss)
  const learningPathId = options.learningPathId ?? BENCHMARK_PATH_ID
  const accountId = options.accountId ?? BENCHMARK_ACCOUNT_ID
  const savedAt = options.savedAt ?? '2026-09-28T00:00:00.000Z'

  const cards: SkillCard[] = []
  const skills: SkillPayload[] = []

  const { px, py } = geometry

  for (let i = 0; i < size; i++) {
    const col = i % recipe.grid_columns
    const row = Math.floor(i / recipe.grid_columns)

    const skillId = formatSkillId(i)
    const taskId = formatTaskId(i)

    const cardWorldX = col * px + (px - CARD_SIZE_WORLD.width) / 2
    const cardWorldY = row * py + (py - CARD_SIZE_WORLD.height) / 2

    cards.push({
      id: skillId,
      title: `Skill ${skillId}`,
      position: { x: cardWorldX, y: cardWorldY },
      size: { ...CARD_SIZE_WORLD },
    })

    const task: TaskPayload = {
      id: taskId,
      title: `Task for ${skillId}`,
      description: `Deterministic benchmark verification task for ${skillId}.`,
      required: i % 2 === 0,
    }

    skills.push({
      id: skillId,
      outcome: `Master and demonstrate core competency for ${skillId}.`,
      tasks: [task],
    })
  }

  const connections = generateConnections(size)

  const checkpoint: LearningPathCheckpoint = {
    version: 1,
    saved_at: savedAt,
    editor: {
      format_version: 1,
      revision: 1,
      cards,
      connections,
    },
    application: {
      learning_path_id: learningPathId,
      skills,
    },
  }

  const checkpointHash = computeCheckpointHash(checkpoint)

  const manifest: FixtureManifest = {
    contract_id: CONTRACT_ID,
    size,
    card_count: cards.length,
    connection_count: connections.length,
    grid_columns: recipe.grid_columns,
    grid_rows: recipe.grid_rows,
    target_columns: recipe.target_columns,
    target_rows: recipe.target_rows,
    cell_pitch_world: { x: px, y: py },
    camera_initial: { ...geometry.camera },
    center_card: {
      id: geometry.center_card_id,
      col: geometry.center_col,
      row: geometry.center_row,
      world_pos: { ...geometry.center_card_world },
    },
    initial_visible_cards: recipe.initial_visible_cards,
    visibility_band: {
      min: recipe.visible_cards_min,
      max: recipe.visible_cards_max,
    },
    checkpoint_hash: checkpointHash,
    created_at: savedAt,
    learning_path_id: learningPathId,
    account_id: accountId,
  }

  const fixture: BenchmarkFixture = {
    size,
    recipe,
    geometry,
    manifest,
    checkpoint,
    camera: { ...geometry.camera },
  }

  validateBenchmarkFixture(fixture, size)

  return fixture
}

/**
 * Validates all semantic and syntactic invariants required for benchmark workloads (AC 1 & AC 2):
 * - Exactly N cards and 2*N unique forward connections
 * - Valid DAG: no self-edges, no duplicates, no cycles, no dangling endpoints
 * - Exactly one distinct task per skill with nonempty title and description
 * - Exact schema and envelope integrity against LearningPathCheckpointSchema
 * - Deterministic hash matches manifest
 */
export function validateBenchmarkFixture(
  fixture: BenchmarkFixture,
  expectedSize?: BenchmarkSize
): void {
  const { size, checkpoint, camera, manifest } = fixture

  if (expectedSize !== undefined && size !== expectedSize) {
    throw new Error(`Fixture size mismatch: expected ${expectedSize}, got ${size}`)
  }

  const recipe = GRID_RECIPES[size]
  if (!recipe) {
    throw new Error(`Invalid fixture size in validation: ${size}`)
  }

  const cards = checkpoint.editor.cards
  const connections = checkpoint.editor.connections
  const skills = checkpoint.application.skills

  // 1. Exact counts
  if (cards.length !== recipe.cards) {
    throw new Error(
      `AC1 Violation: card count must be exactly ${recipe.cards}, got ${cards.length}`
    )
  }
  if (connections.length !== recipe.connections) {
    throw new Error(
      `AC1 Violation: connection count must be exactly ${recipe.connections}, got ${connections.length}`
    )
  }
  if (skills.length !== recipe.cards) {
    throw new Error(
      `AC1 Violation: skill count in application must be exactly ${recipe.cards}, got ${skills.length}`
    )
  }

  // 2. Card ID stability and uniqueness
  const cardIdSet = new Set<string>()
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i]
    const expectedId = formatSkillId(i)
    if (card.id !== expectedId) {
      throw new Error(`AC1 Violation: expected card ID '${expectedId}', got '${card.id}'`)
    }
    if (cardIdSet.has(card.id)) {
      throw new Error(`AC2 Violation: duplicate card ID detected '${card.id}'`)
    }
    cardIdSet.add(card.id)
  }

  // 3. Task association: exactly 1 distinct task per skill, matching IDs, nonempty title/desc
  const taskIdSet = new Set<string>()
  for (let i = 0; i < skills.length; i++) {
    const skill = skills[i]
    if (skill.id !== cards[i].id) {
      throw new Error(
        `AC2 Violation: skill ID '${skill.id}' does not match card ID '${cards[i].id}'`
      )
    }
    if (!skill.tasks || skill.tasks.length !== 1) {
      throw new Error(
        `AC1 Violation: skill '${skill.id}' must have exactly 1 task, got ${skill.tasks?.length ?? 0}`
      )
    }
    const task = skill.tasks[0]
    const expectedTaskId = formatTaskId(i)
    if (task.id !== expectedTaskId) {
      throw new Error(
        `AC1 Violation: expected task ID '${expectedTaskId}', got '${task.id}'`
      )
    }
    if (!task.title || task.title.trim().length === 0) {
      throw new Error(`AC1 Violation: task '${task.id}' has empty title`)
    }
    if (!task.description || task.description.trim().length === 0) {
      throw new Error(`AC1 Violation: task '${task.id}' has empty description`)
    }
    if (taskIdSet.has(task.id)) {
      throw new Error(`AC2 Violation: duplicate task ID detected '${task.id}'`)
    }
    taskIdSet.add(task.id)
  }

  // 4. Connection DAG validation: no self, no duplicate, forward-only, no dangling, acyclic
  const edgeSet = new Set<string>()
  for (const conn of connections) {
    if (conn.from_id === conn.to_id) {
      throw new Error(
        `AC2 Violation: self-connection detected on card '${conn.from_id}'`
      )
    }
    const edgeKey = `${conn.from_id}->${conn.to_id}`
    if (edgeSet.has(edgeKey)) {
      throw new Error(
        `AC2 Violation: duplicate connection detected '${edgeKey}'`
      )
    }
    edgeSet.add(edgeKey)

    if (!cardIdSet.has(conn.from_id)) {
      throw new Error(
        `AC2 Violation: dangling connection from_id '${conn.from_id}' not found in cards`
      )
    }
    if (!cardIdSet.has(conn.to_id)) {
      throw new Error(
        `AC2 Violation: dangling connection to_id '${conn.to_id}' not found in cards`
      )
    }

    const fromIdx = parseSkillIndex(conn.from_id)
    const toIdx = parseSkillIndex(conn.to_id)
    if (fromIdx >= toIdx) {
      throw new Error(
        `AC2 Violation: backward or cyclic connection from '${conn.from_id}' to '${conn.to_id}'`
      )
    }
  }

  // 5. Checkpoint schema and semantic integrity
  validateCheckpointIntegrity(checkpoint, manifest.learning_path_id)
  CameraStateSchema.parse(camera)

  // 6. Deterministic hash verification
  const computedHash = computeCheckpointHash(checkpoint)
  if (computedHash !== manifest.checkpoint_hash) {
    throw new Error(
      `AC1 Violation: checkpoint hash mismatch: manifest has '${manifest.checkpoint_hash}', computed '${computedHash}'`
    )
  }
}

/**
 * Computes positive-area intersection of cards with canvas rect [0, W] x [0, H] (Contract §4).
 */
export function computeCardVisibility(
  cards: SkillCard[],
  camera: CameraState,
  canvasCss: { width: number; height: number } = SETTLED_CANVAS_CSS
): { visibleCardIds: string[]; visibleCount: number } {
  const { width: W, height: H } = canvasCss
  const { offset_x, offset_y, zoom } = camera
  const visibleCardIds: string[] = []

  for (const card of cards) {
    const sx = card.position.x * zoom + offset_x
    const sy = card.position.y * zoom + offset_y
    const sw = card.size.width * zoom
    const sh = card.size.height * zoom

    const interW = Math.max(0, Math.min(sx + sw, W) - Math.max(sx, 0))
    const interH = Math.max(0, Math.min(sy + sh, H) - Math.max(sy, 0))

    if (interW > 0 && interH > 0) {
      visibleCardIds.push(card.id)
    }
  }

  return {
    visibleCardIds,
    visibleCount: visibleCardIds.length,
  }
}

/**
 * Computes connection visibility against the canvas rect (Contract §4).
 * Returns both endpoints visible count, at least one endpoint visible, and bounding box intersection.
 */
export function computeConnectionVisibility(
  connections: PrerequisiteConnection[],
  cardsById: Map<string, SkillCard>,
  camera: CameraState,
  canvasCss: { width: number; height: number } = SETTLED_CANVAS_CSS
): {
  bothEndpointsVisibleCount: number
  atLeastOneEndpointVisibleCount: number
  boundingBoxIntersectsCount: number
} {
  const { width: W, height: H } = canvasCss
  const { offset_x, offset_y, zoom } = camera

  let bothEndpointsVisibleCount = 0
  let atLeastOneEndpointVisibleCount = 0
  let boundingBoxIntersectsCount = 0

  for (const conn of connections) {
    const fromCard = cardsById.get(conn.from_id)
    const toCard = cardsById.get(conn.to_id)
    if (!fromCard || !toCard) continue

    const fromCx = (fromCard.position.x + fromCard.size.width / 2) * zoom + offset_x
    const fromCy = (fromCard.position.y + fromCard.size.height / 2) * zoom + offset_y
    const toCx = (toCard.position.x + toCard.size.width / 2) * zoom + offset_x
    const toCy = (toCard.position.y + toCard.size.height / 2) * zoom + offset_y

    const fromIn = fromCx >= 0 && fromCx <= W && fromCy >= 0 && fromCy <= H
    const toIn = toCx >= 0 && toCx <= W && toCy >= 0 && toCy <= H

    if (fromIn && toIn) bothEndpointsVisibleCount++
    if (fromIn || toIn) atLeastOneEndpointVisibleCount++

    const minX = Math.min(fromCx, toCx)
    const maxX = Math.max(fromCx, toCx)
    const minY = Math.min(fromCy, toCy)
    const maxY = Math.max(fromCy, toCy)

    if (maxX >= 0 && minX <= W && maxY >= 0 && minY <= H) {
      boundingBoxIntersectsCount++
    }
  }

  return {
    bothEndpointsVisibleCount,
    atLeastOneEndpointVisibleCount,
    boundingBoxIntersectsCount,
  }
}

export interface PathVisibilityResult {
  initialVisible: number
  minVisible: number
  maxVisible: number
  inBand: boolean
  violations: string[]
}

/**
 * Validates that the geometric card visibility stays strictly within the
 * required band (180-240 for 1000/10000; exactly 100 for 100) across all points
 * along the planned interaction path (Contract §4 & §5, AC 4).
 */
export function validatePlannedPathVisibility(
  fixture: BenchmarkFixture,
  canvasCss: { width: number; height: number } = SETTLED_CANVAS_CSS
): PathVisibilityResult {
  const { recipe, geometry, checkpoint, camera } = fixture
  const cards = checkpoint.editor.cards
  const { width: W, height: H } = canvasCss
  const { px, z0, center_col, center_row } = geometry

  const initial = computeCardVisibility(cards, camera, canvasCss).visibleCount
  const violations: string[] = []

  if (initial !== recipe.initial_visible_cards) {
    violations.push(
      `Initial visible count ${initial} does not match recipe target ${recipe.initial_visible_cards}`
    )
  }

  let minVisible = initial
  let maxVisible = initial

  function checkStep(ox: number, oy: number, zoom: number, movedCenterCard?: { dx: number; dy: number }) {
    let count = 0
    const centerIndex = center_row * recipe.grid_columns + center_col

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i]
      let posX = card.position.x
      let posY = card.position.y

      if (movedCenterCard && i === centerIndex) {
        posX += movedCenterCard.dx
        posY += movedCenterCard.dy
      }

      const sx = posX * zoom + ox
      const sy = posY * zoom + oy
      const sw = card.size.width * zoom
      const sh = card.size.height * zoom

      const interW = Math.max(0, Math.min(sx + sw, W) - Math.max(sx, 0))
      const interH = Math.max(0, Math.min(sy + sh, H) - Math.max(sy, 0))

      if (interW > 0 && interH > 0) {
        count++
      }
    }

    minVisible = Math.min(minVisible, count)
    maxVisible = Math.max(maxVisible, count)

    if (count < recipe.visible_cards_min || count > recipe.visible_cards_max) {
      violations.push(
        `Visible count ${count} left allowed band [${recipe.visible_cards_min}, ${recipe.visible_cards_max}]`
      )
    }
  }

  // 1. Pan motion: camera X shifts between +-0.1 screen-space cell pitch (W / targetCols)
  const cellPitchScreenX = W / recipe.target_columns
  for (let step = -1; step <= 1; step += 0.05) {
    const shiftX = step * 0.1 * cellPitchScreenX
    checkStep(camera.offset_x + shiftX, camera.offset_y, z0)
  }

  // 2. Zoom motion: zoom between 0.99*z0 and 1.01*z0 anchored at canvas center (W/2, H/2)
  for (let step = -1; step <= 1; step += 0.05) {
    const factor = 1 + step * 0.01
    const zoom = z0 * factor
    const ox = W / 2 - (W / 2 - camera.offset_x) * factor
    const oy = H / 2 - (H / 2 - camera.offset_y) * factor
    checkStep(ox, oy, zoom)
  }

  // 3. Drag motion: center card moves horizontally by +-0.1 cell pitch while mouse is down
  for (let step = -1; step <= 1; step += 0.05) {
    const dx = step * 0.1 * px
    checkStep(camera.offset_x, camera.offset_y, z0, { dx, dy: 0 })
  }

  return {
    initialVisible: initial,
    minVisible,
    maxVisible,
    inBand: violations.length === 0,
    violations,
  }
}

/**
 * Writes the manifest, checkpoint, and camera JSON files for one fixture to disk.
 */
export function writeFixtureFiles(
  outDir: string,
  fixture: BenchmarkFixture
): { manifestPath: string; checkpointPath: string; cameraPath: string } {
  mkdirSync(outDir, { recursive: true })

  const manifestPath = join(outDir, `manifest-${fixture.size}.json`)
  const checkpointPath = join(outDir, `checkpoint-${fixture.size}.json`)
  const cameraPath = join(outDir, `camera-${fixture.size}.json`)

  writeFileSync(manifestPath, JSON.stringify(fixture.manifest, null, 2) + '\n')
  writeFileSync(checkpointPath, JSON.stringify(fixture.checkpoint, null, 2) + '\n')
  writeFileSync(cameraPath, JSON.stringify(fixture.camera, null, 2) + '\n')

  return { manifestPath, checkpointPath, cameraPath }
}

/**
 * Seeds a Storage interface (e.g. window.localStorage in Puppeteer) with fixture data.
 */
export function seedStorageWithFixture(
  storage: { setItem: (key: string, value: string) => void },
  fixture: BenchmarkFixture,
  accountId = BENCHMARK_ACCOUNT_ID,
  pathId = BENCHMARK_PATH_ID
): void {
  const checkpointKey = `gurow:checkpoint:${accountId}:${pathId}`
  const cameraKey = `gurow:camera:${accountId}:${pathId}`

  storage.setItem(checkpointKey, JSON.stringify(fixture.checkpoint))
  storage.setItem(cameraKey, JSON.stringify(fixture.camera))
}
