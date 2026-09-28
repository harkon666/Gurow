import { describe, it, expect } from 'bun:test'
import {
  medianInPhase,
  phaseContains,
  phaseDiagnosticCpu,
  phaseLabelCommitMs,
  phaseLatency,
  type PhaseWindow,
} from './phases'
import type { InputPresentationChain } from './collector'

const WINDOW: PhaseWindow = { name: 'baseline', scenario: 'pan', start_ms: 100, end_ms: 200 }

function chain(overrides: Partial<InputPresentationChain> = {}): InputPresentationChain {
  return {
    input_id: 'in-1',
    scenario: 'pan',
    coalesced_input_ids: [],
    input_timestamp_ms: 150,
    app_revision: 1,
    canvas_revision: 1,
    label_revision: 1,
    presented_frame_id: 'frame-1',
    presentation_timestamp_ms: 166,
    latency_ms: 16,
    frame_link: 'revision_matched',
    presentation_provenance: 'platform_presentation_feedback',
    diagnostics: { cpu_duration_ms: 2, gpu_submit_ms: null, raf_interval_ms: 6.06 },
    ...overrides,
  }
}

describe('phase membership', () => {
  it('includes both bounds and excludes an unobserved timestamp', () => {
    expect(phaseContains(WINDOW, 100)).toBe(true)
    expect(phaseContains(WINDOW, 200)).toBe(true)
    expect(phaseContains(WINDOW, 99.9)).toBe(false)
    expect(phaseContains(WINDOW, 200.1)).toBe(false)
    expect(phaseContains(WINDOW, null)).toBe(false)
  })

  it('returns null rather than a median of nothing', () => {
    expect(medianInPhase([], WINDOW, () => 150, () => 1)).toBeNull()
    expect(medianInPhase([1], WINDOW, () => 500, () => 1)).toBeNull()
    expect(medianInPhase([1], WINDOW, () => 150, () => null)).toBeNull()
    expect(medianInPhase([1], WINDOW, () => 150, () => Infinity)).toBeNull()
  })
})

describe('phase reducers', () => {
  it('medians only the latencies whose input fell inside the phase', () => {
    const chains = [
      chain({ input_timestamp_ms: 120, latency_ms: 10 }),
      chain({ input_timestamp_ms: 180, latency_ms: 20 }),
      chain({ input_timestamp_ms: 900, latency_ms: 999 }),
    ]
    expect(phaseLatency(chains, WINDOW)).toBe(15)
  })

  it('reports no latency for a phase whose chains produced no endpoint', () => {
    const chains = [chain({ latency_ms: null }), chain({ input_timestamp_ms: null })]
    expect(phaseLatency(chains, WINDOW)).toBeNull()
    // The CPU diagnostic survives even when the attributed endpoint does not.
    expect(phaseDiagnosticCpu(chains, WINDOW)).toBe(2)
  })

  it('medians the label commit durations inside the phase', () => {
    const commits = [
      { commit_ms: 110, commit_duration_ms: 1 },
      { commit_ms: 190, commit_duration_ms: 81 },
      { commit_ms: 400, commit_duration_ms: 500 },
    ]
    expect(phaseLabelCommitMs(commits, WINDOW)).toBe(41)
  })
})
