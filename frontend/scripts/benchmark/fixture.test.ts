import { describe, expect, it } from 'bun:test'
import {
  BENCHMARK_SIZES,
  GRID_RECIPES,
  computeFixtureGeometry,
  generateBenchmarkFixture,
  validateBenchmarkFixture,
  computeCardVisibility,
  computeConnectionVisibility,
  validatePlannedPathVisibility,
  formatSkillId,
  formatTaskId,
  computeCheckpointHash,
} from './fixture'
import type { BenchmarkFixture } from './fixture'

describe('Deterministic Benchmark Fixture Generator (T06-L3-02)', () => {
  describe('AC1: Exact counts, stable IDs, associated Tasks, and deterministic hashes', () => {
    for (const size of BENCHMARK_SIZES) {
      it(`generates exactly ${size} cards and ${GRID_RECIPES[size].connections} connections with stable IDs`, () => {
        const fixture = generateBenchmarkFixture(size)

        expect(fixture.checkpoint.editor.cards).toHaveLength(size)
        expect(fixture.checkpoint.editor.connections).toHaveLength(
          GRID_RECIPES[size].connections
        )
        expect(fixture.checkpoint.application.skills).toHaveLength(size)

        // Check stable IDs on first and last elements
        expect(fixture.checkpoint.editor.cards[0].id).toBe('p1-skill-00000')
        expect(fixture.checkpoint.editor.cards[size - 1].id).toBe(
          formatSkillId(size - 1)
        )

        // Check associated Task per Skill
        for (let i = 0; i < size; i++) {
          const skill = fixture.checkpoint.application.skills[i]
          expect(skill.id).toBe(formatSkillId(i))
          expect(skill.tasks).toHaveLength(1)
          const task = skill.tasks[0]
          expect(task.id).toBe(formatTaskId(i))
          expect(task.title.length).toBeGreaterThan(0)
          expect(task.description.length).toBeGreaterThan(0)
        }
      })
    }

    it('produces completely deterministic SHA-256 hashes across repeated runs', () => {
      const run1 = generateBenchmarkFixture(1000)
      const run2 = generateBenchmarkFixture(1000)

      expect(run1.manifest.checkpoint_hash).toBe(run2.manifest.checkpoint_hash)
      expect(run1.manifest.checkpoint_hash.length).toBe(64)
      expect(run1.manifest.checkpoint_hash).toMatch(/^[a-f0-9]{64}$/)

      // Altering anything changes the hash
      const mutatedCheckpoint = structuredClone(run1.checkpoint)
      mutatedCheckpoint.application.skills[0].tasks[0].title = 'Mutated Task Title'
      const mutatedHash = computeCheckpointHash(mutatedCheckpoint)
      expect(mutatedHash).not.toBe(run1.manifest.checkpoint_hash)
    })
  })

  describe('AC2: DAG validity, acyclicity, no dangling/duplicate edges, distinct identities', () => {
    for (const size of BENCHMARK_SIZES) {
      it(`validates strict DAG invariants for ${size} cards without cycles or self-edges`, () => {
        const fixture = generateBenchmarkFixture(size)
        const cards = fixture.checkpoint.editor.cards
        const connections = fixture.checkpoint.editor.connections
        const cardIdSet = new Set(cards.map((c) => c.id))

        expect(cardIdSet.size).toBe(size)

        const edgeSet = new Set<string>()
        for (const conn of connections) {
          // No self connection
          expect(conn.from_id).not.toBe(conn.to_id)

          // No duplicate connection
          const key = `${conn.from_id}->${conn.to_id}`
          expect(edgeSet.has(key)).toBe(false)
          edgeSet.add(key)

          // Endpoints exist
          expect(cardIdSet.has(conn.from_id)).toBe(true)
          expect(cardIdSet.has(conn.to_id)).toBe(true)

          // Forward only (i < j guarantees acyclicity)
          const fromIndex = parseInt(conn.from_id.replace('p1-skill-', ''), 10)
          const toIndex = parseInt(conn.to_id.replace('p1-skill-', ''), 10)
          expect(fromIndex).toBeLessThan(toIndex)
        }
      })
    }

    it('produces distinct hashes and identities when size changes', () => {
      const fix100 = generateBenchmarkFixture(100)
      const fix1000 = generateBenchmarkFixture(1000)
      const fix10000 = generateBenchmarkFixture(10000)

      const hashes = new Set([
        fix100.manifest.checkpoint_hash,
        fix1000.manifest.checkpoint_hash,
        fix10000.manifest.checkpoint_hash,
      ])
      expect(hashes.size).toBe(3)
    })
  })

  describe('AC4: Geometry, visibility targeting 200 cards, and planned path validation', () => {
    it('computes exact initial visible cards count of 200 for 1000 and 10000, and 100 for 100', () => {
      const fix100 = generateBenchmarkFixture(100)
      const fix1000 = generateBenchmarkFixture(1000)
      const fix10000 = generateBenchmarkFixture(10000)

      const vis100 = computeCardVisibility(
        fix100.checkpoint.editor.cards,
        fix100.camera
      )
      expect(vis100.visibleCount).toBe(100)

      const vis1000 = computeCardVisibility(
        fix1000.checkpoint.editor.cards,
        fix1000.camera
      )
      expect(vis1000.visibleCount).toBe(200)

      const vis10000 = computeCardVisibility(
        fix10000.checkpoint.editor.cards,
        fix10000.camera
      )
      expect(vis10000.visibleCount).toBe(200)
    })

    it('keeps primary (1000) visible cards strictly in [180, 240] throughout pan, zoom, and drag paths', () => {
      const fix1000 = generateBenchmarkFixture(1000)
      const result = validatePlannedPathVisibility(fix1000)

      expect(result.initialVisible).toBe(200)
      expect(result.minVisible).toBeGreaterThanOrEqual(180)
      expect(result.maxVisible).toBeLessThanOrEqual(240)
      expect(result.inBand).toBe(true)
      expect(result.violations).toHaveLength(0)
    })

    it('keeps large (10000) visible cards strictly in [180, 240] throughout pan, zoom, and drag paths', () => {
      const fix10000 = generateBenchmarkFixture(10000)
      const result = validatePlannedPathVisibility(fix10000)

      expect(result.initialVisible).toBe(200)
      expect(result.minVisible).toBeGreaterThanOrEqual(180)
      expect(result.maxVisible).toBeLessThanOrEqual(240)
      expect(result.inBand).toBe(true)
      expect(result.violations).toHaveLength(0)
    })

    it('computes connection visibility metrics separating both-endpoints from bounding box', () => {
      const fix1000 = generateBenchmarkFixture(1000)
      const cardsById = new Map(
        fix1000.checkpoint.editor.cards.map((c) => [c.id, c])
      )
      const connVis = computeConnectionVisibility(
        fix1000.checkpoint.editor.connections,
        cardsById,
        fix1000.camera
      )

      expect(connVis.bothEndpointsVisibleCount).toBeGreaterThan(0)
      expect(connVis.atLeastOneEndpointVisibleCount).toBeGreaterThanOrEqual(
        connVis.bothEndpointsVisibleCount
      )
      expect(connVis.boundingBoxIntersectsCount).toBeGreaterThanOrEqual(
        connVis.atLeastOneEndpointVisibleCount
      )
    })

    it('fails geometry setup if scale z0 falls outside [0.1, 4.0]', () => {
      expect(() => {
        computeFixtureGeometry(1000, { width: 100, height: 100 })
      }).toThrow(/Geometry setup failure: computed z0 .* is outside permitted bounds/)
    })
  })

  describe('AC6: Rejection of malformed/mismatched fixtures', () => {
    it('rejects a fixture with mismatched skill IDs in application payload', () => {
      const valid = generateBenchmarkFixture(100)
      const invalid = structuredClone(valid) as BenchmarkFixture
      invalid.checkpoint.application.skills[0].id = 'wrong-id'

      expect(() => validateBenchmarkFixture(invalid)).toThrow(/AC2 Violation/)
    })

    it('rejects a fixture with self-connections', () => {
      const valid = generateBenchmarkFixture(100)
      const invalid = structuredClone(valid) as BenchmarkFixture
      invalid.checkpoint.editor.connections[0] = {
        from_id: 'p1-skill-00000',
        to_id: 'p1-skill-00000',
      }

      expect(() => validateBenchmarkFixture(invalid)).toThrow(
        /AC2 Violation: self-connection/
      )
    })

    it('rejects a fixture with backward or cyclic connections', () => {
      const valid = generateBenchmarkFixture(100)
      const invalid = structuredClone(valid) as BenchmarkFixture
      invalid.checkpoint.editor.connections[0] = {
        from_id: 'p1-skill-00010',
        to_id: 'p1-skill-00005',
      }

      expect(() => validateBenchmarkFixture(invalid)).toThrow(
        /AC2 Violation: backward or cyclic connection/
      )
    })

    it('rejects a fixture with dangling connections', () => {
      const valid = generateBenchmarkFixture(100)
      const invalid = structuredClone(valid) as BenchmarkFixture
      invalid.checkpoint.editor.connections[0] = {
        from_id: 'p1-skill-00000',
        to_id: 'p1-skill-99999',
      }

      expect(() => validateBenchmarkFixture(invalid)).toThrow(
        /AC2 Violation: dangling connection/
      )
    })

    it('rejects a fixture with duplicate connections', () => {
      const valid = generateBenchmarkFixture(100)
      const invalid = structuredClone(valid) as BenchmarkFixture
      invalid.checkpoint.editor.connections[1] = {
        from_id: invalid.checkpoint.editor.connections[0].from_id,
        to_id: invalid.checkpoint.editor.connections[0].to_id,
      }

      expect(() => validateBenchmarkFixture(invalid)).toThrow(
        /AC2 Violation: duplicate connection/
      )
    })

    it('rejects a fixture with empty task title or description', () => {
      const valid = generateBenchmarkFixture(100)
      const invalid = structuredClone(valid) as BenchmarkFixture
      invalid.checkpoint.application.skills[0].tasks[0].title = '   '

      expect(() => validateBenchmarkFixture(invalid)).toThrow(
        /AC1 Violation: task '.*' has empty title/
      )
    })

    it('rejects a fixture with a tampered checkpoint hash', () => {
      const valid = generateBenchmarkFixture(100)
      const invalid = structuredClone(valid) as BenchmarkFixture
      invalid.manifest.checkpoint_hash = 'bad-hash'

      expect(() => validateBenchmarkFixture(invalid)).toThrow(
        /AC1 Violation: checkpoint hash mismatch/
      )
    })
  })
})
