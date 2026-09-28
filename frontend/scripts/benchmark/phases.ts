/**
 * Controlled phase windows on the page clock, and the reducers that read them.
 *
 * A phase is a closed interval of `performance.now()` values. Membership is
 * asked once, here, so the AC4 reducers cannot drift into three slightly
 * different notions of "inside the phase".
 */
import { medianOrNull, type InputPresentationChain } from './collector'
import type { Scenario } from '../../src/components/editor/benchmarkHooks'

/** One controlled phase of the run, bounded on the page clock. */
export interface PhaseWindow {
  name: 'baseline' | 'app-delay' | 'label-delay'
  scenario: Scenario
  start_ms: number
  end_ms: number
}

/** Whether a page-clock timestamp falls inside this phase. */
export function phaseContains(window: PhaseWindow, pageMs: number | null): boolean {
  return pageMs !== null && pageMs >= window.start_ms && pageMs <= window.end_ms
}

/**
 * Median of the values whose page-clock time falls inside one phase.
 *
 * Returns null when the phase produced no value, which is what makes the AC4
 * checks report NOT_MEASURED instead of inventing a shift.
 */
export function medianInPhase<T>(
  items: T[],
  window: PhaseWindow,
  pageMs: (item: T) => number | null,
  value: (item: T) => number | null
): number | null {
  const sample: number[] = []
  for (const item of items) {
    if (!phaseContains(window, pageMs(item))) continue
    const observed = value(item)
    if (observed !== null && Number.isFinite(observed)) sample.push(observed)
  }
  return medianOrNull(sample)
}

/** Median attributed latency of the chains whose input fell inside one phase. */
export function phaseLatency(
  chains: InputPresentationChain[],
  window: PhaseWindow
): number | null {
  return medianInPhase(chains, window, (c) => c.input_timestamp_ms, (c) => c.latency_ms)
}

/** Median CPU-side dispatch duration in a phase, used for diagnostics only. */
export function phaseDiagnosticCpu(
  chains: InputPresentationChain[],
  window: PhaseWindow
): number | null {
  return medianInPhase(
    chains,
    window,
    (c) => c.input_timestamp_ms,
    (c) => c.diagnostics.cpu_duration_ms
  )
}

/**
 * Median label-commit duration inside a phase window.
 *
 * This proves whether an injected label delay actually executed, so a failing
 * AC4 label check can be read as "the endpoint ignores labels" rather than
 * "the delay never ran".
 */
export function phaseLabelCommitMs(
  commits: { commit_ms: number; commit_duration_ms: number }[],
  window: PhaseWindow
): number | null {
  return medianInPhase(commits, window, (c) => c.commit_ms, (c) => c.commit_duration_ms)
}
