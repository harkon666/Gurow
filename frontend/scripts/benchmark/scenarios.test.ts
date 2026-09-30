import { describe, expect, test } from 'bun:test'
import { deadlines, motionAt, nearestRank, pace, triangle } from './scenarios'

describe('absolute nominal schedule', () => {
  test('30 seconds at 120 Hz has exactly 3600 slots without drift', () => {
    const slots = deadlines({ start_ms: 125, duration_ms: 30000, hz: 120 })
    expect(slots).toHaveLength(3600)
    expect(slots[0]).toBe(125)
    expect(slots[3599]).toBeCloseTo(125 + 3599 / 120 * 1000)
  })
  test('late slots do not shift the next deadline', async () => {
    let now = 100
    const sent: number[] = []
    const result = await pace({ start_ms: 100, duration_ms: 1000, hz: 4 }, () => now, async ms => { now += ms }, async (_, deadline) => { sent.push(deadline); now += 340 })
    expect(sent).toEqual([100, 350, 600])
    expect(result).toEqual({ scheduled: 4, sent: 3, missed: 1, errors: [] })
  })
  test('invalid schedule rejected', () => {
    expect(() => deadlines({ start_ms: 0, duration_ms: 30001, hz: 120 })).toThrow()
    expect(() => deadlines({ start_ms: 0, duration_ms: 30000, hz: 0 })).toThrow()
  })
})

describe('motion and evidence math', () => {
  test('two-second triangle reaches both extrema and returns to origin', () => {
    expect([0, 500, 1000, 1500, 2000].map(t => triangle(t))).toEqual([0, 1, 0, -1, 0])
  })
  test('pan delta telescopes; zoom CDP wheel implements exponential rule', () => {
    const c = { x: 500, y: 300 }
    expect(motionAt('pan', 500, 0, c, 20, .99, 1.01).delta_x).toBe(-20)
    const zoom = motionAt('zoom', 500, 0, c, 20, .99, 1.01)
    expect(Math.exp(-zoom.delta_y! * .005)).toBeCloseTo(1.01)
    expect(zoom.modifiers).toBe(2)
    expect(motionAt('drag', 1500, 1000, c, 20, .99, 1.01).x).toBe(480)
  })
  test('missing and malformed statistics never masquerade as zero', () => {
    // Runner and reducer share this rule for the visibility median.
    expect(nearestRank([150, 250], .5)).toBe(150)
    expect(nearestRank([140, 150, 250, 260], .5)).toBe(150)
    expect(nearestRank([], .95)).toBeNull()
    expect(nearestRank([1, 2, 3, 4, 5, 100], .95)).toBe(100)
    expect(nearestRank([NaN], .95)).toBeNull()
  })
})
