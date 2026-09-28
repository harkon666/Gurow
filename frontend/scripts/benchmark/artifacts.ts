/**
 * Every file the qualification driver leaves on disk.
 *
 * Artefact writing lives here so the driver stays a sequence of observations:
 * a failed attempt and a completed attempt emit the same shapes, and neither
 * path re-derives the profile skeleton for itself.
 */
import fs from 'fs'
import path from 'path'
import {
  computeProfileHash,
  deriveClockMapping,
  generateQualificationReport,
  getOpticalAcquisitionRequirements,
  verifyControlledDelayShift,
  GUROW_INPUT_COALESCING,
  type ClockMapping,
  type CollectorProfile,
  type DelayCheckResult,
  type FaultInjectionConfig,
  type GeometryClass,
  type HostEnvironmentInfo,
  type SourceIdentity,
  type TraceConfiguration,
  type TraceEvent,
  type TraceParseResult,
} from './collector'
import type { PhaseWindow } from './phases'
import { SCENARIOS, type DispatchRecord, type Scenario } from '../../src/components/editor/benchmarkHooks'

export const COLLECTOR_VERSION = 'gurow-collector-v3'
export const CONTRACT_ID = 'gurow-p1-v1'
export const PARSER_VERSION = '3.0.0'

/** Page-clock bounds of one driven scenario. */
export type ScenarioWindows = Record<Scenario, { start_ms: number; end_ms: number }>

export function traceConfiguration(
  categories: string[],
  clockMapping: ClockMapping
): TraceConfiguration {
  return {
    categories,
    parser_version: PARSER_VERSION,
    clock_origin: 'chromium_trace_monotonic',
    clock_units: 'us',
    timestamp_scale_to_ms: 0.001,
    clock_mapping: clockMapping,
  }
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
}

/**
 * Records a preflight failure as a complete NOT_MEASURED evidence set.
 *
 * The environment is rejected before any capture, so there is no delay evidence
 * at all: one unavailable check is reused for both AC4 rows rather than implying
 * two separate observations.
 */
export function writePreflightFailureArtifacts(options: {
  outDir: string
  identity: SourceIdentity
  host: HostEnvironmentInfo
  geometryClass: GeometryClass
  browserWindow: unknown
  reasons: string[]
}): CollectorProfile {
  const { outDir, identity, host, reasons } = options
  const unavailable = verifyControlledDelayShift(null, null, 80)

  writeJson(path.resolve(outDir, 'environment-preflight.json'), {
    status: 'NOT_MEASURED',
    identity,
    host,
    browser_window: options.browserWindow,
    reasons,
  })

  const base: Omit<CollectorProfile, 'hash'> = {
    version: COLLECTOR_VERSION,
    contract_id: CONTRACT_ID,
    status: 'NOT_MEASURED',
    unsupported_reason: reasons.join(' '),
    identity,
    host,
    geometry_class: options.geometryClass,
    trace_configuration: traceConfiguration([], deriveClockMapping([], [], 'us')),
    fault_injection: {
      enabled: false, app_delay_ms: 0, label_delay_ms: 0,
      app_delays_applied: 0, label_delays_applied: 0,
    },
    input_coalescing: GUROW_INPUT_COALESCING,
    optical_requirements: getOpticalAcquisitionRequirements(),
  }
  const profile: CollectorProfile = { ...base, hash: computeProfileHash(base) }

  writeJson(path.resolve(outDir, 'collector-profile.json'), profile)
  writeJson(path.resolve(outDir, 'qualification-report.json'), {
    verdict: profile.status,
    stage: 'environment-preflight-before-capture',
    reasons,
    identity,
    host,
    profile_hash: profile.hash,
    app_delay_check: unavailable,
    label_delay_check: unavailable,
  })
  fs.writeFileSync(
    path.resolve(outDir, 'qualification-report.md'),
    generateQualificationReport(profile, reasons, {
      scenariosTested: [],
      chains: [],
      gpuAdapter: host.gpu_adapter,
      browserVersion: host.browser_version,
      appDelayCheck: unavailable,
      labelDelayCheck: unavailable,
      diagnosticShifts: { appDispatchShiftMs: null, labelCommitShiftMs: null },
    })
  )
  return profile
}

/** Writes the preflight record of an environment that passed every gate. */
export function writePreflightPass(options: {
  outDir: string
  identity: SourceIdentity
  host: HostEnvironmentInfo
  browserWindow: unknown
}): void {
  writeJson(path.resolve(options.outDir, 'environment-preflight.json'), {
    status: 'PASS',
    identity: options.identity,
    host: options.host,
    browser_window: options.browserWindow,
    reasons: [],
  })
}

export interface RunArtifacts {
  outDir: string
  profile: CollectorProfile
  parseResult: TraceParseResult
  reasons: string[]
  failures: string[]
  profileValidation: { valid: boolean; errors: string[] }
  traceEvents: TraceEvent[]
  clockMapping: ClockMapping
  scenarioWindows: ScenarioWindows
  phases: PhaseWindow[]
  appDelayCheck: DelayCheckResult
  labelDelayCheck: DelayCheckResult
  diagnosticShifts: {
    appDispatchShiftMs: number | null
    labelCommitShiftMs: number | null
    baselineLabelCommitMs: number | null
    delayedLabelCommitMs: number | null
  }
  faultInjection: FaultInjectionConfig
  setupDispatches: DispatchRecord[]
  inputDispatchCount: number
  nonInputDispatches: DispatchRecord[]
  scenariosWithoutInput: Scenario[]
  deviceLossEvents: string[]
  pageErrors: string[]
  negativeCasesWronglyAccepted: string[]
}

/**
 * Writes the raw traces, profile and both report forms for a completed attempt.
 *
 * Called before any assertion runs, so an invalidated attempt still leaves its
 * complete evidence behind (contract §5: preserve all attempts and reasons).
 */
export function writeRunArtifacts(run: RunArtifacts): void {
  const { outDir, profile, parseResult, clockMapping } = run

  fs.writeFileSync(
    path.resolve(outDir, 'raw-trace.json'),
    JSON.stringify(run.traceEvents, null, 2)
  )

  const offsetMs = clockMapping.trace_to_page_offset_ms
  for (const scenario of SCENARIOS) {
    const window = run.scenarioWindows[scenario]
    const slice =
      offsetMs === null
        ? []
        : run.traceEvents.filter((event) => {
            const pageMs = event.ts * 0.001 - offsetMs
            return pageMs >= window.start_ms && pageMs <= window.end_ms
          })
    writeJson(path.resolve(outDir, `raw-trace-${scenario}.json`), {
      scenario,
      window_page_ms: window,
      clock_offset_ms: offsetMs,
      note:
        offsetMs === null
          ? 'Clock mapping unresolved; per-scenario slicing is not possible. See raw-trace.json.'
          : 'Events selected by mapped page-clock time inside the scenario window.',
      event_count: slice.length,
      events: slice,
    })
  }

  writeJson(path.resolve(outDir, 'collector-profile.json'), profile)

  fs.writeFileSync(
    path.resolve(outDir, 'qualification-report.md'),
    generateQualificationReport(profile, run.reasons, {
      scenariosTested: [...SCENARIOS],
      chains: parseResult.chains,
      gpuAdapter: profile.host.gpu_adapter,
      browserVersion: profile.host.browser_version,
      appDelayCheck: run.appDelayCheck,
      labelDelayCheck: run.labelDelayCheck,
      diagnosticShifts: run.diagnosticShifts,
    })
  )

  writeJson(path.resolve(outDir, 'qualification-report.json'), {
    contract_id: profile.contract_id,
    collector_version: profile.version,
    profile_hash: profile.hash,
    identity: profile.identity,
    verdict: profile.status,
    geometry_class: profile.geometry_class,
    parser_errors: parseResult.errors,
    reasons: run.reasons,
    qualification_failures: run.failures,
    input_coalescing: profile.input_coalescing,
    fault_injection_observed: run.faultInjection,
    setup_dispatch_count: run.setupDispatches.length,
    setup_dispatches: run.setupDispatches,
    input_dispatch_count: run.inputDispatchCount,
    non_input_dispatch_count: run.nonInputDispatches.length,
    non_input_dispatches: run.nonInputDispatches,
    scenarios_without_observed_input: run.scenariosWithoutInput,
    device_loss_events: run.deviceLossEvents.slice(0, 20),
    device_loss_event_count: run.deviceLossEvents.length,
    page_errors: run.pageErrors.slice(0, 20),
    negative_cases_wrongly_accepted: run.negativeCasesWronglyAccepted,
    chains_count: parseResult.chains.length,
    chains_revision_matched: parseResult.chains.filter((c) => c.frame_link === 'revision_matched').length,
    chains_with_latency: parseResult.chains.filter((c) => c.latency_ms !== null).length,
    coalesced_group_sizes: parseResult.chains.map((c) => c.coalesced_input_ids.length + 1),
    clock_mapping: clockMapping,
    acceptance_profile_validation: run.profileValidation,
    scenario_windows: run.scenarioWindows,
    phases: run.phases,
    controlled_delays: {
      app_delay_check: run.appDelayCheck,
      label_delay_check: run.labelDelayCheck,
      diagnostic_only_shifts: run.diagnosticShifts,
    },
    optical_requirements: profile.optical_requirements,
  })
}

/** Retains the real run's own rejections alongside the constructed cases. */
export function writeObservedLimitations(
  failedExamplesDir: string,
  parseResult: TraceParseResult
): void {
  if (parseResult.errors.length === 0 && parseResult.reasons.length === 0) return
  writeJson(path.resolve(failedExamplesDir, 'observed-run-limitations.json'), {
    verdict: parseResult.verdict,
    errors: parseResult.errors,
    reasons: [...new Set(parseResult.reasons)],
  })
}
