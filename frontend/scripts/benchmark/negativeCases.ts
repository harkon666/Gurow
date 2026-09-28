/**
 * Deterministic AC5 rejection fixtures and the gate cases for the finalizer.
 *
 * Every case is a named mutation of one of two self-contained fixtures, so the
 * negative evidence never depends on what the live run happened to capture: an
 * empty capture cannot silently turn each negative case into a pass.
 */
import fs from 'fs'
import path from 'path'
import {
  parseTraceEvidence,
  verifyControlledDelayShift,
  type CollectorProfile,
  type CorrelationEvent,
  type DelayCheckResult,
  type TraceEvent,
  type TraceParseResult,
} from './collector'
import { finalizeQualification } from './qualification'

/** One fixture a case may mutate before it reaches the parser. */
interface Fixture {
  trace: TraceEvent[]
  correlation: CorrelationEvent[]
  profile: CollectorProfile
}

interface NegativeCase {
  name: string
  /** `plain` is a single ordered frame; `coherent` is the full qualifying shape. */
  base: 'plain' | 'coherent'
  /** `invalid` must be structurally rejected; `unsupported` must not qualify. */
  expectation: 'invalid' | 'unsupported'
  mutate?: (fixture: Fixture) => void
}

const CORRELATION: CorrelationEvent = {
  input_id: 'neg-1',
  scenario: 'pan',
  coalesced_input_ids: [],
  input_origin_ms: 1000,
  app_revision: 1,
  canvas_revision: 1,
  label_revision_at_dispatch: 0,
  label_revision: 1,
  label_commit_app_revision: 1,
  label_commit_ms: 1002,
  cpu_work_duration_ms: 2,
  gpu_submit_duration_ms: null,
  raf_cadence_ms: null,
}

/** One well-formed, ordered frame: enough to pass the structural checks. */
const PLAIN_TRACE: TraceEvent[] = [
  { cat: 'viz', name: 'DrawFrame', ts: 1_000_000, ph: 'X', pid: 1, tid: 1 },
]

/** Explicit synthetic qualification-schema example, never browser evidence. */
const COHERENT_TRACE: TraceEvent[] = [
  { name: 'gurow:app_dispatch:neg-1:1', ts: 1_000_000, ph: 'R', pid: 1, tid: 1 },
  {
    name: 'PresentationFeedback', ts: 1_016_000, ph: 'I', pid: 1, tid: 2, id: 'frame-1',
    args: {
      flags: 0x06, canvas_revision: 1, label_revision: 1,
      label_commit_app_revision: 1, presentation_timestamp: 1_016_000,
    },
  },
]

const NEGATIVE_CASES: NegativeCase[] = [
  { name: 'empty-trace', base: 'plain', expectation: 'invalid', mutate: (f) => { f.trace = [] } },
  {
    name: 'negative-timestamp', base: 'plain', expectation: 'invalid',
    mutate: (f) => { f.trace = [{ cat: 'input', name: 'MouseEvent', ts: -12345, ph: 'X', pid: 1, tid: 1 }] },
  },
  {
    name: 'misordered-timestamps', base: 'plain', expectation: 'invalid',
    mutate: (f) => {
      f.trace = [
        { cat: 'viz', name: 'DrawFrame', ts: 2_000_000, ph: 'X', pid: 1, tid: 1 },
        { cat: 'viz', name: 'DrawFrame', ts: 1_000_000, ph: 'X', pid: 1, tid: 1 },
      ]
    },
  },
  {
    name: 'duplicate-ids', base: 'plain', expectation: 'invalid',
    mutate: (f) => { f.correlation.push({ ...CORRELATION }) },
  },
  {
    // Incoherent because the closing label commit never observed the dispatched
    // revision. A label revision merely ahead of the canvas revision is
    // legitimate and must not be rejected.
    name: 'revision-mismatch', base: 'plain', expectation: 'invalid',
    mutate: (f) => {
      f.correlation[0] = { ...f.correlation[0], app_revision: 5, canvas_revision: 5, label_commit_app_revision: 4 }
    },
  },
  {
    name: 'label-revision-backwards', base: 'plain', expectation: 'invalid',
    mutate: (f) => {
      f.correlation[0] = { ...f.correlation[0], label_revision_at_dispatch: 7, label_revision: 3 }
    },
  },
  {
    name: 'label-never-committed', base: 'plain', expectation: 'invalid',
    mutate: (f) => {
      f.correlation[0] = { ...f.correlation[0], label_revision: null, label_commit_app_revision: null }
    },
  },
  {
    name: 'wrong-clock-units', base: 'plain', expectation: 'invalid',
    mutate: (f) => {
      f.profile = {
        ...f.profile,
        trace_configuration: { ...f.profile.trace_configuration, timestamp_scale_to_ms: 1 },
      }
    },
  },
  {
    name: 'no-clock-mapping', base: 'plain', expectation: 'invalid',
    mutate: (f) => {
      f.profile = {
        ...f.profile,
        trace_configuration: {
          ...f.profile.trace_configuration,
          clock_mapping: { ...f.profile.trace_configuration.clock_mapping, trace_to_page_offset_ms: null },
        },
      }
    },
  },
  {
    name: 'canvas-only', base: 'coherent', expectation: 'unsupported',
    mutate: (f) => { delete f.trace[1].args!.label_revision },
  },
  {
    name: 'missing-frame', base: 'coherent', expectation: 'unsupported',
    mutate: (f) => { delete f.trace[1].id },
  },
  {
    name: 'late-label', base: 'coherent', expectation: 'unsupported',
    mutate: (f) => { f.correlation[0] = { ...f.correlation[0], label_commit_ms: 1017 } },
  },
  {
    name: 'unrelated-paint', base: 'coherent', expectation: 'unsupported',
    mutate: (f) => { f.trace[1].args!.canvas_revision = 99 },
  },
  {
    name: 'fabricated-feedback', base: 'coherent', expectation: 'unsupported',
    mutate: (f) => { f.trace[1].args!.fabricated = true },
  },
  {
    name: 'submission-only', base: 'coherent', expectation: 'unsupported',
    mutate: (f) => { f.trace[1].name = 'DisplayScheduler::DrawAndSwap' },
  },
  {
    name: 'new-labels-old-canvas', base: 'coherent', expectation: 'unsupported',
    mutate: (f) => { f.correlation[0] = { ...f.correlation[0], label_commit_app_revision: 2 } },
  },
]

/** Finalizer gates, each fault-injected into one input of the same decision. */
const GATE_CASES = ['invalid-final-gate', 'invalid-profile-gate', 'app-delay-gate', 'label-delay-gate'] as const

export interface NegativeRunOptions {
  /** Profile whose clock mapping is resolved, so cases fail for their own reason. */
  parserProfile: CollectorProfile
  /**
   * The run's own profile, used unmodified by the gate cases.
   *
   * A gate case must fail on the fault it injects, so it cannot be handed a
   * profile whose hash was already invalidated by a fixture mutation.
   */
  runProfile: CollectorProfile
  parseResult: TraceParseResult
  appDelayCheck: DelayCheckResult
  labelDelayCheck: DelayCheckResult
  failedExamplesDir: string
}

/**
 * Runs every rejection fixture through the real parser and finalizer.
 *
 * Each case's actual output is retained on disk (AC5), and the returned names
 * are the cases the pipeline wrongly accepted — an invalidation reason for the
 * whole run, never a silent pass.
 */
export function runNegativeCases(options: NegativeRunOptions): string[] {
  const { parserProfile, runProfile, failedExamplesDir } = options
  const wronglyAccepted: string[] = []

  for (const negative of NEGATIVE_CASES) {
    const fixture: Fixture = {
      trace: structuredClone(negative.base === 'coherent' ? COHERENT_TRACE : PLAIN_TRACE),
      correlation: [{ ...CORRELATION }],
      profile: parserProfile,
    }
    negative.mutate?.(fixture)

    const result = parseTraceEvidence(fixture.trace, fixture.correlation, fixture.profile)
    fs.writeFileSync(
      path.resolve(failedExamplesDir, `${negative.name}.json`),
      JSON.stringify(
        {
          case: negative.name,
          expectation: negative.expectation,
          input: { trace: fixture.trace, correlation: fixture.correlation },
          parser_result: {
            valid: result.valid,
            verdict: result.verdict,
            errors: result.errors,
            reasons: [...new Set(result.reasons)],
            chains: result.chains,
          },
        },
        null,
        2
      )
    )

    const leakedEndpoint = result.chains.some(
      (chain) =>
        chain.latency_ms !== null ||
        chain.presentation_timestamp_ms !== null ||
        chain.presented_frame_id !== null
    )
    const accepted =
      negative.expectation === 'unsupported'
        ? result.verdict !== 'UNSUPPORTED' || leakedEndpoint
        : result.valid
    if (accepted) wronglyAccepted.push(negative.name)
  }

  for (const name of GATE_CASES) {
    const input = {
      profile: name === 'invalid-profile-gate' ? { ...runProfile, hash: 'tampered' } : runProfile,
      parsed: options.parseResult,
      appDelayCheck:
        name === 'app-delay-gate' ? verifyControlledDelayShift(16, 16, 80) : options.appDelayCheck,
      labelDelayCheck:
        name === 'label-delay-gate' ? verifyControlledDelayShift(16, 16, 80) : options.labelDelayCheck,
      invalidRunReasons:
        name === 'invalid-final-gate' ? ['Synthetic invalid-run finalization regression example.'] : [],
    }
    const result = finalizeQualification(input)
    fs.writeFileSync(
      path.resolve(failedExamplesDir, `${name}.json`),
      JSON.stringify(
        { note: 'Fault-injected finalization example, not a separate browser attempt.', input, result },
        null,
        2
      )
    )
    if (result.profile.status !== 'NOT_MEASURED' || result.failures.length === 0) {
      wronglyAccepted.push(name)
    }
  }

  return wronglyAccepted
}
