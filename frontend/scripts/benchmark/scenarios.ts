import type { Scenario } from '../../src/components/editor/benchmarkHooks'

export interface Schedule { start_ms: number; duration_ms: number; hz: number }
export interface Motion { scenario: Scenario; x: number; y: number; delta_x?: number; delta_y?: number; modifiers?: number }

/** Exact, absolute deadlines: timer drift never shifts subsequent deadlines. */
export function deadlines({ start_ms, duration_ms, hz }: Schedule): number[] {
  if (![start_ms, duration_ms, hz].every(Number.isFinite) || start_ms < 0 || duration_ms <= 0 || hz <= 0 || !Number.isInteger(duration_ms * hz / 1000)) {
    throw new Error('Invalid absolute input schedule')
  }
  return Array.from({ length: duration_ms * hz / 1000 }, (_, k) => start_ms + k * 1000 / hz)
}

/** Triangle in [-1,+1], period two seconds, starting at zero. */
export function triangle(elapsed_ms: number, period_ms = 2000): number {
  if (!Number.isFinite(elapsed_ms) || !Number.isFinite(period_ms) || period_ms <= 0) throw new Error('Invalid motion phase')
  const phase = ((elapsed_ms % period_ms) + period_ms) % period_ms / period_ms
  return phase < .25 ? 4 * phase : phase < .75 ? 2 - 4 * phase : 4 * phase - 4
}

/** CDP wheel deltas are relative; motion targets are absolute about the fixture. */
export function motionAt(scenario: Scenario, elapsed_ms: number, previous_ms: number, centre: { x: number; y: number }, amplitude_px: number, zoom_min: number, zoom_max: number): Motion {
  if (!Number.isFinite(amplitude_px) || amplitude_px <= 0 || !(zoom_min > 0 && zoom_min < 1 && zoom_max > 1)) throw new Error('Invalid fixture motion geometry')
  const phase = triangle(elapsed_ms), previous = triangle(previous_ms)
  if (scenario === 'drag') return { scenario, x: centre.x + amplitude_px * phase, y: centre.y }
  if (scenario === 'pan') return { scenario, x: centre.x, y: centre.y, delta_x: amplitude_px * (previous - phase), delta_y: 0 }
  if (scenario === 'zoom') {
    const factor = (p: number) => p >= 0 ? 1 + p * (zoom_max - 1) : 1 + p * (1 - zoom_min)
    return { scenario, x: centre.x, y: centre.y, delta_x: 0, delta_y: -Math.log(factor(phase) / factor(previous)) / .005, modifiers: 2 }
  }
  throw new Error(`Unknown scenario: ${scenario}`)
}

/** Nearest-rank percentile (`ceil(fraction*n)`, 1-based); also the median rule at 0.5. */
export function nearestRank(values: number[], fraction: number): number | null {
  if (!values.length || !values.every(v => Number.isFinite(v) && v >= 0) || !(fraction > 0 && fraction <= 1)) return null
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]
}

/** CDP awaits protocol acknowledgement, not a render; missed slots remain recorded. */
export async function pace(schedule: Schedule, now: () => number, sleep: (ms: number) => Promise<void>, send: (index: number, deadline: number) => Promise<void>): Promise<{ scheduled: number; sent: number; missed: number; errors: string[] }> {
  const slots = deadlines(schedule)
  let sent = 0, missed = 0
  const errors: string[] = []
  for (let k = 0; k < slots.length; k++) {
    const deadline = slots[k]
    if (now() < deadline) await sleep(deadline - now())
    if (now() >= schedule.start_ms + schedule.duration_ms) { missed++; continue }
    try { await send(k, deadline); sent++ } catch (error) { errors.push(`${k}: ${String(error)}`) }
  }
  return { scheduled: slots.length, sent, missed, errors }
}
