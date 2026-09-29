import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  BENCHMARK_SIZES,
  computeCheckpointHash,
  computeEditorIdentityHash,
  computeFixtureGeometry,
  computeVisibleCardIds,
  estimateConnectionVisibility,
  fixtureFilePaths,
  fixtureStorageEntries,
  formatSkillId,
  formatTaskId,
  generateBenchmarkFixture,
  loadBenchmarkContract,
  parseBenchmarkContract,
  readFixtureFiles,
  validateBenchmarkFixture,
  validatePlannedPathVisibility,
  writeFixtureFiles,
  FixtureRejectedError,
  type BenchmarkFixture,
  type BenchmarkSize,
} from './fixture'
import { loadCheckpoint } from '../../src/components/editor/checkpoint'

const CONTRACT_PATH = path.resolve(import.meta.dir, '../../../docs/benchmarks/p1/protocol.json')
const contract = loadBenchmarkContract(CONTRACT_PATH)
/** Canvas measured at 1200x720 with the list and Task panel open (fixture-check). */
const CANVAS = { width: 592, height: 628 }

const generate = (size: BenchmarkSize, canvasCss = CANVAS) =>
  generateBenchmarkFixture(contract, size, { canvasCss })

function mutated(fixture: BenchmarkFixture, change: (f: BenchmarkFixture) => void): BenchmarkFixture {
  const copy = structuredClone(fixture)
  change(copy)
  return copy
}

describe('benchmark contract', () => {
  it('reads every workload from protocol.json instead of restating it', () => {
    expect(contract.contract_id).toBe('gurow-p1-v1')
    expect(contract.primary_size).toBe(1000)
    expect(contract.motion).toEqual({ amplitude_cell_fraction: 0.1, zoom_min_factor: 0.99, zoom_max_factor: 1.01 })
    expect(contract.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(contract.recipes[1000]).toMatchObject({
      connections: 2000, grid_columns: 25, grid_rows: 40, initial_visible_cards: 200,
      visibility_band: { min: 180, max: 240 },
    })
    expect(contract.recipes[10000]).toMatchObject({ connections: 20000, target_rows: 20, visibility_band: { min: 180, max: 240 } })
    expect(contract.recipes[100]).toMatchObject({ connections: 200, target_rows: 10, visibility_band: null })
  })

  it('rejects a different contract or a missing workload', () => {
    const raw = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'))
    expect(() => parseBenchmarkContract(JSON.stringify({ ...raw, contract_id: 'other' }))).toThrow()
    expect(() => parseBenchmarkContract(JSON.stringify({ ...raw, comparisons: raw.comparisons.slice(0, 1) })))
      .toThrow(/no 10000-card workload/)
  })
})

describe('AC1: exact counts, stable IDs, one Task per Skill, deterministic hashes', () => {
  for (const size of BENCHMARK_SIZES) {
    it(`generates ${size} cards and ${2 * size} connections with stable IDs and Tasks`, () => {
      const fixture = generate(size)
      expect(fixture.checkpoint.editor.cards).toHaveLength(size)
      expect(fixture.checkpoint.editor.connections).toHaveLength(2 * size)
      expect(fixture.checkpoint.application.skills).toHaveLength(size)
      fixture.checkpoint.application.skills.forEach((skill, i) => {
        expect(fixture.checkpoint.editor.cards[i].id).toBe(formatSkillId(i))
        expect(skill.id).toBe(formatSkillId(i))
        expect(skill.tasks.map((t) => t.id)).toEqual([formatTaskId(i)])
        expect(skill.tasks[0].title.trim()).not.toBe('')
        expect(skill.tasks[0].description.trim()).not.toBe('')
      })
    })
  }

  it('produces identical hashes for the same recipe and canvas', () => {
    const a = generate(1000)
    const b = generate(1000)
    expect(a.manifest).toEqual(b.manifest)
    expect(a.manifest.checkpoint_hash).toMatch(/^[a-f0-9]{64}$/)
    const changed = mutated(a, (f) => { f.checkpoint.application.skills[0].tasks[0].title = 'Changed' })
    expect(computeCheckpointHash(changed.checkpoint)).not.toBe(a.manifest.checkpoint_hash)
  })

  it('keeps card geometry exact at engine f32 precision', () => {
    for (const card of generate(1000).checkpoint.editor.cards) {
      expect(Math.fround(card.position.x)).toBe(card.position.x)
      expect(Math.fround(card.position.y)).toBe(card.position.y)
    }
  })

  it('persists canvas, z0, pitches, start indices and camera in the manifest', () => {
    const { geometry } = generate(1000).manifest
    expect(geometry.canvas_css).toEqual(CANVAS)
    expect(geometry.z0).toBeCloseTo(Math.min(1, 592 / 2200, 628 / 2400), 12)
    expect(geometry.cell_pitch_world.x * geometry.z0).toBeCloseTo(59.2, 9)
    expect(geometry.cell_pitch_world.y * geometry.z0).toBeCloseTo(31.4, 9)
    expect([geometry.start_col, geometry.start_row]).toEqual([7, 10])
    expect(geometry.camera.offset_x).toBeCloseTo(-7 * 59.2, 9)
    expect(geometry.camera.offset_y).toBeCloseTo(-10 * 31.4, 9)
    expect(geometry.center_card.id).toBe(formatSkillId(20 * 25 + 12))
  })
})

describe('AC2: DAG validity and fixture identity', () => {
  for (const size of BENCHMARK_SIZES) {
    it(`builds a forward-only DAG without self, duplicate or dangling edges for ${size}`, () => {
      const fixture = generate(size)
      const ids = new Set(fixture.checkpoint.editor.cards.map((c) => c.id))
      const edges = new Set<string>()
      for (const { from_id, to_id } of fixture.checkpoint.editor.connections) {
        expect(ids.has(from_id) && ids.has(to_id)).toBe(true)
        expect(from_id < to_id).toBe(true)
        edges.add(`${from_id}->${to_id}`)
      }
      expect(edges.size).toBe(2 * size)
    })
  }

  it('gives each size and each canvas its own identity', () => {
    const hashes = new Set(BENCHMARK_SIZES.map((size) => generate(size).manifest.checkpoint_hash))
    expect(hashes.size).toBe(3)
    expect(generate(1000, { width: 600, height: 628 }).manifest.editor_identity_hash)
      .not.toBe(generate(1000).manifest.editor_identity_hash)
  })

  it('passes the route checkpoint loader unchanged', () => {
    const fixture = generate(1000)
    const storage = new Map(fixtureStorageEntries(fixture))
    const loaded = loadCheckpoint(
      { getItem: (key: string) => storage.get(key) ?? null } as Storage,
      fixture.manifest.account_id,
      fixture.manifest.learning_path_id
    )
    expect(loaded).toEqual(fixture.checkpoint)
  })

  it('matches an engine export whatever its order and decimal rendering', () => {
    const fixture = generate(1000)
    const exported = {
      cards: [...fixture.checkpoint.editor.cards].reverse().map((c) => ({
        ...c, position: { x: Number(c.position.x.toPrecision(9)), y: Number(c.position.y.toPrecision(9)) },
      })),
      connections: [...fixture.checkpoint.editor.connections].reverse(),
    }
    expect(computeEditorIdentityHash(exported)).toBe(fixture.manifest.editor_identity_hash)
    exported.cards[0].position.x += 1
    expect(computeEditorIdentityHash(exported)).not.toBe(fixture.manifest.editor_identity_hash)
  })

  const invalid: Array<[string, (f: BenchmarkFixture) => void, RegExp]> = [
    ['a mismatched Skill ID', (f) => { f.checkpoint.application.skills[0].id = 'wrong-id' }, /AC2 Violation: skill ID/],
    ['a self-connection', (f) => { f.checkpoint.editor.connections[0] = { from_id: formatSkillId(0), to_id: formatSkillId(0) } }, /self-connection/],
    ['a backward edge', (f) => { f.checkpoint.editor.connections[0] = { from_id: formatSkillId(10), to_id: formatSkillId(5) } }, /backward or cyclic/],
    ['a dangling edge', (f) => { f.checkpoint.editor.connections[0] = { from_id: formatSkillId(0), to_id: 'p1-skill-99999' } }, /dangling connection/],
    ['a duplicate edge', (f) => { f.checkpoint.editor.connections[1] = { ...f.checkpoint.editor.connections[0] } }, /duplicate connection/],
    ['an empty Task title', (f) => { f.checkpoint.application.skills[0].tasks[0].title = '  ' }, /nonempty title/],
    ['a second Task on one Skill', (f) => { f.checkpoint.application.skills[0].tasks.push({ ...f.checkpoint.application.skills[1].tasks[0] }) }, /exactly 1 task/],
    ['a tampered hash', (f) => { f.manifest.checkpoint_hash = 'bad' }, /checkpoint_hash mismatch/],
  ]
  for (const [name, change, error] of invalid) {
    it(`rejects ${name}`, () => {
      expect(() => validateBenchmarkFixture(mutated(generate(100), change))).toThrow(error)
    })
  }
})

describe('AC4: geometry and planned-path visibility', () => {
  it('shows 200 cards for the primary and large workloads and the whole 100-card grid', () => {
    for (const [size, visible] of [[100, 100], [1000, 200], [10000, 200]] as const) {
      const fixture = generate(size)
      expect(computeVisibleCardIds(fixture.checkpoint.editor.cards, fixture.camera, CANVAS)).toHaveLength(visible)
    }
  })

  for (const size of [1000, 10000] as const) {
    it(`keeps ${size} cards inside [180, 240] along the pan, zoom and drag paths`, () => {
      const result = validatePlannedPathVisibility(generate(size), contract.motion)
      expect(result.violations).toEqual([])
      expect(result.initial_visible).toBe(200)
      expect(result.min_visible).toBeGreaterThanOrEqual(180)
      expect(result.max_visible).toBeLessThanOrEqual(240)
      expect(result.samples).toBe(3 * 41 + 1)
    })
  }

  it('reports the 100-card comparison without applying the primary band', () => {
    const result = validatePlannedPathVisibility(generate(100), contract.motion)
    expect(result.in_band).toBe(true)
    expect(result.initial_visible).toBe(100)
  })

  it('reports a camera that leaves the band', () => {
    const fixture = generate(1000)
    const shifted = mutated(fixture, (f) => { f.manifest.geometry.canvas_css = { width: 800, height: 628 } })
    expect(validatePlannedPathVisibility(shifted, contract.motion).in_band).toBe(false)
  })

  it('labels connection counts as estimates', () => {
    const fixture = generate(1000)
    const counts = estimateConnectionVisibility(
      fixture.checkpoint.editor.connections, fixture.checkpoint.editor.cards, fixture.camera, CANVAS
    )
    expect(counts.both_endpoint_centres_visible_estimate).toBeGreaterThan(0)
    expect(counts.bounding_box_intersects_estimate).toBeGreaterThanOrEqual(counts.both_endpoint_centres_visible_estimate)
  })

  it('fails geometry setup when z0 leaves [0.1, 4]', () => {
    expect(() => computeFixtureGeometry(contract.recipes[1000], contract.card_size_world, { width: 100, height: 100 }))
      .toThrow(/Geometry setup failure/)
  })
})

describe('AC6: setup rejects malformed or substituted fixture files', () => {
  const setupDir = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gurow-fixture-'))
    for (const size of BENCHMARK_SIZES) writeFixtureFiles(dir, generate(size))
    return dir
  }

  it('accepts the files it wrote', () => {
    const dir = setupDir()
    for (const size of BENCHMARK_SIZES) {
      expect(readFixtureFiles(contract, dir, size).manifest).toEqual(generate(size).manifest)
    }
  })

  const edit = (file: string, change: (json: any) => void) => {
    const json = JSON.parse(readFileSync(file, 'utf8'))
    change(json)
    writeFileSync(file, JSON.stringify(json))
  }

  it('rejects a smaller workload presented as the primary one', () => {
    const dir = setupDir()
    const primary = fixtureFilePaths(dir, 1000)
    const small = fixtureFilePaths(dir, 100)
    writeFileSync(primary.checkpoint, readFileSync(small.checkpoint))
    expect(() => readFixtureFiles(contract, dir, 1000)).toThrow(FixtureRejectedError)
  })

  it('rejects a manifest for another size', () => {
    const dir = setupDir()
    writeFileSync(fixtureFilePaths(dir, 1000).manifest, readFileSync(fixtureFilePaths(dir, 100).manifest))
    expect(() => readFixtureFiles(contract, dir, 1000)).toThrow(/manifest describes 100 cards/)
  })

  it('rejects an orphan card, a moved camera and truncated JSON', () => {
    const dir = setupDir()
    const files = fixtureFilePaths(dir, 1000)
    const original = readFileSync(files.checkpoint)
    edit(files.checkpoint, (c) => { c.editor.cards[0].id = 'orphan' })
    expect(() => readFixtureFiles(contract, dir, 1000)).toThrow(FixtureRejectedError)
    writeFileSync(files.checkpoint, original)
    edit(files.camera, (c) => { c.offset_x += 1 })
    expect(() => readFixtureFiles(contract, dir, 1000)).toThrow(/camera differs/)
    writeFileSync(files.manifest, '{"size": 1000')
    expect(() => readFixtureFiles(contract, dir, 1000)).toThrow(FixtureRejectedError)
  })

  it('rejects files generated from another contract', () => {
    const dir = setupDir()
    edit(fixtureFilePaths(dir, 100).manifest, (m) => { m.contract_sha256 = '0'.repeat(64) })
    expect(() => readFixtureFiles(contract, dir, 100)).toThrow(/different contract/)
  })
})
