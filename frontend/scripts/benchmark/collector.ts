import { createHash } from 'crypto'
import type { Scenario } from '../../src/components/editor/benchmarkHooks'

/**
 * Collector profile, trace parser and qualification reporting for the P1/T06
 * measurement contract `gurow-p1-v1` — v1-only, historical. Contract
 * gurow-p1-v2 (ADR 0019) retired this collector; v2 captures use `run.ts`.
 *
 * The parser is deliberately unable to produce a latency it did not observe.
 * Contract gurow-p1-v1 forbids CPU duration, GPU submit completion,
 * `requestAnimationFrame` cadence or an assumed next paint from standing in for
 * visible response, so a missing presentation link yields a null endpoint and a
 * non-passing verdict rather than an estimate.
 */

/** A value the run could not establish. Never substituted with a guess. */
export const UNKNOWN = 'unknown' as const

/** Geometry of the live canvas, recorded to validate headed configuration. */
export interface CanvasGeometry {
  css_bounds: { x: number; y: number; width: number; height: number }
  backing_size: { width: number; height: number }
}

export interface NativeWindowGeometry {
  headed: boolean
  device_metrics_emulated: boolean
  x: number; y: number; width: number; height: number
  screen_width: number; screen_height: number
  available_x: number; available_y: number; available_width: number; available_height: number
  visual_viewport_scale: number
  document_visible: boolean; focused: boolean
  canvas_unobscured: boolean; labels_visible: boolean
  skill_list_visible: boolean; task_panel_visible: boolean
}

export interface HostEnvironmentInfo {
  cpu: string
  logical_cpus: number
  physical_memory_bytes: number
  os: string
  kernel: string
  /** Reported by the actual WebGPU adapter, or `unknown`. */
  gpu_adapter: string
  gpu_driver: string
  is_fallback: boolean
  compositor: string
  /** Null when the active output could not be identified. */
  display_output: string | null
  /** Null when the refresh rate could not be read from the host. */
  display_refresh_hz: number | null
  /** Read from the live page, never assumed. */
  device_pixel_ratio: number | null
  viewport_css: [number, number] | null
  canvas_geometry: CanvasGeometry | null
  browser_executable: string
  browser_version: string
  browser_backend: string
  browser_command_line: string[]
  native_window: NativeWindowGeometry | null
}

/**
 * Mapping between the Chromium trace clock and the page's `performance.now()`
 * domain, derived from user-timing marks emitted at known page times.
 *
 * Without this mapping the two clocks share no origin and no latency can be
 * computed, so the parser refuses to guess one.
 */
export interface ClockMapping {
  trace_clock: string
  page_clock: string
  /** `trace_ts_ms - page_now_ms`, median over observed sync marks. */
  trace_to_page_offset_ms: number | null
  /** Spread across sync samples; a wide spread makes the mapping unusable. */
  offset_spread_ms: number | null
  sample_count: number
  method: string
}

export interface TraceConfiguration {
  categories: string[]
  parser_version: string
  clock_origin: string
  clock_units: 'us' | 'ms'
  timestamp_scale_to_ms: number
  clock_mapping: ClockMapping
}

export interface FaultInjectionConfig {
  enabled: boolean
  app_delay_ms: number
  label_delay_ms: number
  /** Times the injected application delay was observed to execute. */
  app_delays_applied: number
  /** Times the injected label delay was observed to execute. */
  label_delays_applied: number
}

/**
 * The coalescing rule the collector itself fixes, per contract §6.
 *
 * The rule is part of the hashed profile so a report reducer inherits it instead
 * of inventing its own grouping after seeing the numbers.
 */
export interface InputCoalescingRule {
  rule_id: string
  attributed_origin: string
  description: string
}

/** Rule implemented by `recordDispatch` in the application instrumentation. */
export const GUROW_INPUT_COALESCING: InputCoalescingRule = {
  rule_id: 'gurow-coalescing-v1',
  attributed_origin: 'oldest_unconsumed_input',
  description:
    'A dispatch is attributed to the oldest input it incorporated. Every superseded input is ' +
    'retained with its own origin and carries the same conservative oldest-to-presentation latency.',
}

export interface OpticalAcquisitionRequirements {
  protocol_id: string
  minimum_capture_fps: number
  nominal_frame_period_ms: number
  uncertainty_window_rule: string
  percentile_policy: string
  acceptance_sampling: {
    duration_per_window_seconds: number
    windows_per_scenario: number
    warmup_seconds: number
    equivalent_120hz_input_count_min: number
    equivalent_120hz_input_count_max: number
    minimum_response_groups: number
    minimum_presented_intervals: number
  }
}

/**
 * Whether the run stood on the reference window geometry of contract §3.
 *
 * `qualification_only` is an honest, self-limiting record: the collector may be
 * qualified on it, but no acceptance series can be, so an L3-03 run cannot
 * inherit this profile's geometry as if it were the reference environment.
 */
export type GeometryClass = 'reference' | 'qualification_only'

/** Identity of the source the qualification ran against, per contract §4. */
export interface SourceIdentity {
  commit: string
  tree_dirty: boolean
  build_hash: string
  source_fingerprint: string
}

export interface CollectorProfile {
  version: string
  contract_id: string
  hash: string
  status: 'QUALIFIED' | 'UNSUPPORTED' | 'NOT_MEASURED'
  unsupported_reason?: string
  identity: SourceIdentity
  host: HostEnvironmentInfo
  /** Derived from the observed window, never claimed independently of it. */
  geometry_class: GeometryClass
  trace_configuration: TraceConfiguration
  fault_injection: FaultInjectionConfig
  input_coalescing: InputCoalescingRule
  optical_requirements?: OpticalAcquisitionRequirements
}

export interface TraceEvent {
  cat?: string
  name?: string
  ph?: string
  /** On the trace clock, in the unit declared by the profile. */
  ts: number
  dur?: number
  tts?: number
  pid?: number
  tid?: number
  args?: Record<string, unknown>
  id?: string
}

export interface CorrelationEvent {
  input_id: string
  scenario: Scenario | null
  /** Superseded inputs incorporated into this dispatch, oldest first. */
  coalesced_input_ids: string[]
  /** Pre-dispatch browser input time on the page clock; null when unobserved. */
  input_origin_ms: number | null
  app_revision: number
  canvas_revision: number
  /** Label revision current when the dispatch ran, before any new commit. */
  label_revision_at_dispatch: number
  /** Null while the label overlay has not committed for this revision. */
  label_revision: number | null
  /** App revision the closing label commit had observed; null when uncommitted. */
  label_commit_app_revision: number | null
  /** Page-clock time after the synchronous label commit/delay; never presentation. */
  label_commit_ms: number | null
  /** Measured CPU duration of the dispatch; null when not measured. */
  cpu_work_duration_ms: number | null
  /** Null unless the run actually measured GPU submit completion. */
  gpu_submit_duration_ms: number | null
  /** Null unless the run actually sampled rAF cadence. */
  raf_cadence_ms: number | null
}

/** How a presentation event was tied to an input, if at all. */
export type FrameLink = 'revision_matched' | 'temporal_next_paint' | 'none'

export type PresentationProvenance =
  | 'platform_presentation_feedback'
  | 'unrelated_next_paint'
  | 'fabricated'
  | 'missing'

export interface InputPresentationChain {
  input_id: string
  scenario: Scenario | null
  /**
   * Inputs that coalesced into this chain, oldest first. Each member inherits
   * this chain's latency under `gurow-coalescing-v1`; the group is never
   * counted as one acceptance sample.
   */
  coalesced_input_ids: string[]
  /** Pre-dispatch origin on the page clock; null when unobserved. */
  input_timestamp_ms: number | null
  app_revision: number
  canvas_revision: number
  label_revision: number | null
  /** Null when no presentation event could be tied to this input. */
  presented_frame_id: string | null
  /** Null unless a real presentation event was linked. Never synthesised. */
  presentation_timestamp_ms: number | null
  /** Null whenever the endpoint or the origin is unavailable. */
  latency_ms: number | null
  frame_link: FrameLink
  presentation_provenance: PresentationProvenance
  /** Diagnostics only. Contract forbids these as a response substitute. */
  diagnostics: {
    cpu_duration_ms: number | null
    gpu_submit_ms: number | null
    raf_interval_ms: number | null
  }
}

export interface TraceParseResult {
  valid: boolean
  errors: string[]
  chains: InputPresentationChain[]
  verdict: 'QUALIFIED' | 'UNSUPPORTED' | 'NOT_MEASURED'
  reasons: string[]
}

function canonicalJson(val: unknown): string {
  if (val === null || typeof val !== 'object') {
    return JSON.stringify(val)
  }
  if (Array.isArray(val)) {
    return '[' + val.map((v) => canonicalJson(v)).join(',') + ']'
  }
  const record = val as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const entries = keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(record[k]))
  return '{' + entries.join(',') + '}'
}

/**
 * Computes canonical SHA-256 hash of a CollectorProfile omitting the hash property.
 */
export function computeProfileHash(profile: Omit<CollectorProfile, 'hash'>): string {
  const canonical = canonicalJson(profile)
  return createHash('sha256').update(canonical).digest('hex')
}

/** Median of a numeric sample, or null when the sample is empty. */
export function medianOrNull(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * Derives the trace/page clock mapping from paired user-timing sync marks.
 *
 * `pageSyncs` records the `performance.now()` value at which each
 * `gurow:clock_sync:<index>` mark was emitted; the trace supplies the same
 * mark on the trace clock. The offset is the median difference, and its spread
 * is retained so a noisy or unusable mapping stays visible.
 */
export function deriveClockMapping(
  traceEvents: TraceEvent[],
  pageSyncs: { index: number; page_now_ms: number }[],
  clockUnits: 'us' | 'ms'
): ClockMapping {
  const scale = clockUnits === 'us' ? 0.001 : 1
  const offsets: number[] = []

  for (const sync of pageSyncs) {
    const markName = `gurow:clock_sync:${sync.index}`
    const traceMark = traceEvents.find((e) => e.name === markName)
    if (!traceMark) continue
    offsets.push(traceMark.ts * scale - sync.page_now_ms)
  }

  const base: ClockMapping = {
    trace_clock: 'chromium_trace_monotonic',
    page_clock: 'performance_now_ms',
    trace_to_page_offset_ms: null,
    offset_spread_ms: null,
    sample_count: offsets.length,
    method:
      'Median of (trace_ts_ms - page_now_ms) over gurow:clock_sync user-timing marks observed in both domains.',
  }

  if (offsets.length === 0) return base

  return {
    ...base,
    trace_to_page_offset_ms: medianOrNull(offsets),
    offset_spread_ms: Math.max(...offsets) - Math.min(...offsets),
  }
}

/** Maximum tolerated spread across clock-sync samples before the mapping is unusable. */
export const CLOCK_MAPPING_MAX_SPREAD_MS = 5

/** Markers identifying a CPU/software renderer rather than real hardware. */
const SOFTWARE_ADAPTER_MARKERS = [
  'swiftshader',
  'llvmpipe',
  'lavapipe',
  'softwarerasterizer',
  'software rasterizer',
  'microsoft basic render',
  'warp',
]

/**
 * Reports whether an adapter description names a known software renderer.
 *
 * AC1 forbids marking a fallback or software result qualified, and the WebGPU
 * `isFallbackAdapter` flag is not sufficient on its own: Chromium leaves it
 * unset for SwiftShader.
 */
export function isSoftwareAdapter(adapterDescription: string): boolean {
  const normalized = adapterDescription.toLowerCase()
  return SOFTWARE_ADAPTER_MARKERS.some((marker) => normalized.includes(marker))
}

/**
 * Errors specific to the reference *window* geometry of contract §3.
 *
 * Separated because these two facts are what an acceptance series needs fixed —
 * the workload's visible-card band and the p95 thresholds are defined against
 * them. Demonstrating that an input reaches a coherent presentation does not
 * depend on the window being one particular size.
 */
function referenceGeometryErrors(host: HostEnvironmentInfo): string[] {
  const errors: string[] = []
  if (host.viewport_css?.[0] !== 1200 || host.viewport_css?.[1] !== 720) {
    errors.push('Actual headed viewport must be 1200×720 CSS pixels (contract §3).')
  }
  if (host.device_pixel_ratio !== 1.5) errors.push('Actual native DPR must be 1.5 (contract §3).')
  return errors
}

export interface EnvironmentGateOptions {
  /**
   * Require the exact reference viewport and DPR (contract §3).
   *
   * An acceptance run must be on the reference geometry. A collector
   * qualification need not be: it proves the evidence chain exists on this
   * stack, whatever size the compositor laid the window out at.
   */
  requireReferenceGeometry?: boolean
}

/** Pre-capture gate, also rechecked at the final publication boundary. */
export function validateReferenceEnvironment(
  host: HostEnvironmentInfo,
  options: EnvironmentGateOptions = {}
): string[] {
  const errors: string[] = []
  if (options.requireReferenceGeometry) errors.push(...referenceGeometryErrors(host))
  for (const field of ['browser_version', 'browser_backend', 'browser_executable', 'compositor'] as const) {
    if (!host[field]?.trim() || host[field] === UNKNOWN) errors.push(`Actual ${field} is unknown (AC1).`)
  }
  if (/^wayland-\d+$/.test(host.compositor) || !/\d+\.\d+/.test(host.compositor)) {
    errors.push('Compositor identity and version are required; a Wayland socket is not an identity (AC1).')
  }
  if (!host.browser_command_line?.length) errors.push('Actual browser command line was not recorded (AC1).')
  if (host.viewport_css === null) errors.push('Actual headed viewport was not recorded (AC1).')
  if (host.device_pixel_ratio === null) {
    errors.push('Device pixel ratio was not read from the live page (AC1).')
  }
  const canvas = host.canvas_geometry
  if (!canvas) errors.push('Canvas CSS and backing geometry were not recorded (AC1).')
  else {
    const { x, y, width, height } = canvas.css_bounds
    if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 ||
      x + width > (host.viewport_css?.[0] ?? 0) + 0.01 || y + height > (host.viewport_css?.[1] ?? 0) + 0.01) {
      errors.push('Canvas is clipped or has invalid bounds; the entire canvas must be inside the viewport (contract §3).')
    }
    // ResizeObserver sizing floors physical pixels; DOMRect float snapping can
    // add subpixel noise. Allow one pixel plus 0.001 physical pixels, never two.
    const backingRoundingTolerance = 1.001
    if (!Number.isInteger(canvas.backing_size.width) || !Number.isInteger(canvas.backing_size.height) ||
      canvas.backing_size.width <= 0 || canvas.backing_size.height <= 0 ||
      Math.abs(canvas.backing_size.width - width * (host.device_pixel_ratio ?? 0)) > backingRoundingTolerance ||
      Math.abs(canvas.backing_size.height - height * (host.device_pixel_ratio ?? 0)) > backingRoundingTolerance) {
      errors.push('Canvas backing size does not match observed CSS size × native DPR (contract §3).')
    }
  }
  const native = host.native_window
  if (!native) errors.push('Native headed window/screen geometry was not observed (AC1).')
  else {
    if (!native.headed || native.device_metrics_emulated || native.visual_viewport_scale !== 1) {
      errors.push('Headed native geometry is required; device emulation/zoom is not reference evidence (contract §3).')
    }
    const dimensions = [native.x, native.y, native.width, native.height, native.screen_width,
      native.screen_height, native.available_x, native.available_y, native.available_width, native.available_height]
    if (!dimensions.every(Number.isFinite) || native.width <= 0 || native.height <= 0 ||
      native.width < (host.viewport_css?.[0] ?? 0) || native.height < (host.viewport_css?.[1] ?? 0) ||
      native.x < native.available_x || native.y < native.available_y ||
      native.x + native.width > native.available_x + native.available_width + 1 ||
      native.y + native.height > native.available_y + native.available_height + 1) {
      errors.push('Native window is outside the available display bounds (contract §3).')
    }
    if (!native.document_visible || !native.focused || !native.canvas_unobscured || !native.labels_visible ||
      !native.skill_list_visible || !native.task_panel_visible) {
      errors.push('Canvas must be visible, focused and unobscured with labels, Skill list and Task panel retained (contract §3).')
    }
  }
  return errors
}

/**
 * Validates a CollectorProfile against AC1, AC4, and integrity rules.
 *
 * In acceptance mode every host field the contract requires must be a real
 * observation: an `unknown` adapter or a null refresh rate is an escalation,
 * not a recordable result.
 *
 * Reference geometry is required for acceptance and optional for a collector
 * qualification, but a profile that *claims* `reference` is always held to it,
 * so the weaker mode cannot be used to smuggle in a reference-looking profile.
 */
export function validateCollectorProfile(
  profile: CollectorProfile,
  options: { requireAcceptanceMode?: boolean } & EnvironmentGateOptions = {}
): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  const requireReferenceGeometry =
    options.requireReferenceGeometry ?? options.requireAcceptanceMode ?? false

  if (!profile.version) {
    errors.push('Profile version is missing.')
  }

  if (profile.geometry_class === 'reference') {
    errors.push(...referenceGeometryErrors(profile.host))
  } else if (requireReferenceGeometry) {
    errors.push(
      'Acceptance requires the reference window geometry; this profile is qualification-only (contract §3).'
    )
  }

  // AC1: no fallback/software result is marked qualified
  if (profile.host.is_fallback) {
    errors.push('Software/fallback adapter cannot be marked qualified (AC1 violation).')
  }

  // Chromium reports isFallbackAdapter === false for SwiftShader, so the flag
  // alone does not satisfy AC1. Verified on this reference host: launching with
  // only --enable-unsafe-webgpu yields vendor 'google', architecture
  // 'swiftshader' with the fallback flag unset.
  if (isSoftwareAdapter(profile.host.gpu_adapter)) {
    errors.push(
      `Adapter '${profile.host.gpu_adapter}' is a software renderer; it cannot be marked qualified (AC1 violation).`
    )
  }

  if (profile.status === 'QUALIFIED' && profile.host.is_fallback) {
    errors.push('A fallback adapter run cannot carry QUALIFIED status (AC1 violation).')
  }

  // AC4: Acceptance mode rejects profiles with fault injection still enabled
  if (options.requireAcceptanceMode && profile.fault_injection.enabled) {
    errors.push('Acceptance mode rejects profiles with fault injection enabled (AC4 violation).')
  }
  if (
    options.requireAcceptanceMode &&
    (profile.fault_injection.app_delay_ms > 0 || profile.fault_injection.label_delay_ms > 0)
  ) {
    errors.push('Acceptance mode rejects a profile still carrying injected delays (AC4 violation).')
  }

  // Contract §6: the collector, not a downstream reducer, fixes the grouping.
  if (profile.input_coalescing?.rule_id !== GUROW_INPUT_COALESCING.rule_id) {
    errors.push(
      `Profile must declare coalescing rule '${GUROW_INPUT_COALESCING.rule_id}' (contract §6).`
    )
  }

  // AC1: acceptance mode cannot record an unresolved host fact.
  if (options.requireAcceptanceMode) {
    const { host } = profile
    errors.push(...validateReferenceEnvironment(host, { requireReferenceGeometry }))
    if (profile.identity.tree_dirty && !/^[a-f0-9]{64}$/i.test(profile.identity.source_fingerprint ?? '')) {
      errors.push('Dirty source requires a valid 64-hex source fingerprint (AC1).')
    }
    if (host.gpu_adapter === UNKNOWN || host.gpu_adapter === '') {
      errors.push('Actual GPU adapter is unknown; AC1 requires escalation, not a recorded guess.')
    }
    if (host.gpu_driver === UNKNOWN || host.gpu_driver === '') {
      errors.push('Actual GPU driver is unknown; AC1 requires escalation, not a recorded guess.')
    }
    if (host.display_refresh_hz === null) {
      errors.push('Display refresh rate was not observed (AC1).')
    }
    if (host.device_pixel_ratio === null) {
      errors.push('Device pixel ratio was not read from the live page (AC1).')
    }
    if (host.viewport_css === null) {
      errors.push('Actual headed viewport was not recorded (AC1).')
    }
    if (host.canvas_geometry === null) {
      errors.push('Canvas CSS and backing geometry were not recorded (AC1).')
    }
    if (host.display_output === null) {
      errors.push('Active display output was not identified (AC1).')
    }
  }

  // AC1: a declared clock mapping must exist and be usable.
  const mapping = profile.trace_configuration.clock_mapping
  if (mapping.trace_to_page_offset_ms === null) {
    errors.push('Trace/page clock mapping was not established (AC1).')
  } else if (
    mapping.offset_spread_ms !== null &&
    mapping.offset_spread_ms > CLOCK_MAPPING_MAX_SPREAD_MS
  ) {
    errors.push(
      `Clock mapping spread ${mapping.offset_spread_ms.toFixed(2)} ms exceeds ${CLOCK_MAPPING_MAX_SPREAD_MS} ms; mapping is unusable (AC1).`
    )
  }

  const { hash, ...rest } = profile
  const expectedHash = computeProfileHash(rest)
  if (hash !== expectedHash) {
    errors.push(`Profile hash mismatch: expected ${expectedHash}, got ${hash}.`)
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * Validates that an 80 ms injected delay shifts the *attributed* endpoint.
 *
 * Both latencies must come from the same attributed endpoint. A null on either
 * side means the endpoint was unavailable, which is NOT_MEASURED rather than a
 * pass or a fail — the delay may well have worked, but this run cannot say so.
 */
export function verifyControlledDelayShift(
  baselineLatencyMs: number | null,
  delayedLatencyMs: number | null,
  expectedDelayMs: number,
  toleranceMs = 25
): {
  status: 'PASS' | 'FAIL' | 'NOT_MEASURED'
  pass: boolean
  shiftMs: number | null
  details: string
} {
  if (baselineLatencyMs === null || delayedLatencyMs === null) {
    return {
      status: 'NOT_MEASURED',
      pass: false,
      shiftMs: null,
      details:
        'Attributed endpoint unavailable on at least one side; the delay shift cannot be verified against presentation evidence (NOT_MEASURED).',
    }
  }

  const shiftMs = delayedLatencyMs - baselineLatencyMs
  const diff = Math.abs(shiftMs - expectedDelayMs)
  const pass = diff <= toleranceMs
  return {
    status: pass ? 'PASS' : 'FAIL',
    pass,
    shiftMs,
    details: `Observed shift: ${shiftMs.toFixed(2)} ms (expected ~${expectedDelayMs} ms, diff: ${diff.toFixed(2)} ms, tolerance: ${toleranceMs} ms). ${pass ? 'PASS' : 'FAIL'}`,
  }
}

/**
 * Reports whether one chain is qualification-grade evidence.
 *
 * The single predicate both the parser verdict and the final publication gate
 * use, so the two cannot drift into disagreeing definitions of "coherent".
 */
export function isQualifiedChain(chain: InputPresentationChain): boolean {
  return (
    chain.presentation_provenance === 'platform_presentation_feedback' &&
    chain.frame_link === 'revision_matched' &&
    typeof chain.presented_frame_id === 'string' &&
    chain.presented_frame_id.trim().length > 0 &&
    chain.presentation_timestamp_ms !== null &&
    Number.isFinite(chain.presentation_timestamp_ms) &&
    chain.latency_ms !== null &&
    Number.isFinite(chain.latency_ms) &&
    chain.latency_ms >= 0
  )
}

/**
 * Trace phases whose timestamps are monotonic per thread.
 *
 * Instant/mark and complete events are emitted in timestamp order; async and
 * flow phases are not, so they are excluded from the misordering check.
 */
const ORDERED_PHASES = new Set(['I', 'R', 'i', 'X'])

/** Trace event names that can carry presentation feedback. */
const PRESENTATION_EVENT_NAMES = new Set([
  'DisplayScheduler::DrawAndSwap',
  'DidReceivePresentationFeedback',
  'PresentationFeedback',
  'wayland_presentation_feedback',
])

/** Chromium presentation flags: kVSync 1<<0, kHWClock 1<<1, kHWCompletion 1<<2. */
const FLAG_HW_CLOCK = 0x02
const FLAG_HW_COMPLETION = 0x04

function readNumberArg(args: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = args?.[key]
  return typeof value === 'number' ? value : undefined
}

/**
 * Parses raw trace events and correlation logs, strictly enforcing AC2, AC3, AC5.
 *
 * Structural rejections (AC5) short-circuit before any chain is built. A chain
 * is only QUALIFIED-eligible when a presentation event is tied to its canvas
 * revision *and* carries hardware feedback flags; a merely subsequent paint is
 * recorded as `unrelated_next_paint` and cannot pass.
 */
export function parseTraceEvidence(
  traceEvents: TraceEvent[],
  correlationEvents: CorrelationEvent[],
  profile: CollectorProfile
): TraceParseResult {
  const errors: string[] = []
  const reasons: string[] = []

  // AC5 Check 1: Reject empty traces
  if (!traceEvents || traceEvents.length === 0) {
    errors.push('Trace events array is empty.')
    return {
      valid: false,
      errors,
      chains: [],
      verdict: 'NOT_MEASURED',
      reasons: ['Empty trace evidence'],
    }
  }

  const { clock_units: clockUnits, timestamp_scale_to_ms: declaredScale } =
    profile.trace_configuration

  // AC5 Check 2: Reject a declared unit/scale pair that disagrees.
  const expectedScale = clockUnits === 'us' ? 0.001 : 1
  if (declaredScale !== expectedScale) {
    errors.push(
      `Declared clock units '${clockUnits}' disagree with timestamp scale ${declaredScale} (expected ${expectedScale}).`
    )
  }

  // AC5 Check 3: Reject negative or malformed timestamps and durations.
  for (let i = 0; i < traceEvents.length; i++) {
    const e = traceEvents[i]
    if (typeof e.ts !== 'number' || !Number.isFinite(e.ts)) {
      errors.push(`Invalid timestamp at index ${i}: ${e.ts}`)
      break
    }
    if (e.ts < 0) {
      errors.push(`Negative timestamp detected at index ${i}: ${e.ts}`)
      break
    }
    if (e.dur !== undefined && e.dur < 0) {
      errors.push(`Negative duration detected at index ${i}: ${e.dur}`)
      break
    }
  }

  const timedEvents = traceEvents.filter((e) => e.ph !== 'M' && e.ts > 0)

  // AC5 Check 4: Reject misordered timestamps within one thread's stream.
  //
  // Only instant/mark ('I', 'R', 'i') and complete ('X') events are emitted in
  // timestamp order per thread. Async and flow phases ('b', 'e', 's', 'f', 'n')
  // are legitimately emitted out of order against them, so including those
  // would reject every healthy Chromium trace. Sorting the checked phases away
  // instead of rejecting them would hide a genuinely corrupted trace.
  const lastTsByThread = new Map<string, number>()
  for (const e of timedEvents) {
    if (!ORDERED_PHASES.has(e.ph ?? '')) continue
    const threadKey = `${e.pid ?? 'na'}:${e.tid ?? 'na'}`
    const previous = lastTsByThread.get(threadKey)
    if (previous !== undefined && e.ts < previous) {
      errors.push(
        `Misordered timestamp in thread ${threadKey}: ${e.ts} follows ${previous}.`
      )
      break
    }
    lastTsByThread.set(threadKey, e.ts)
  }

  const sortedEvents = [...timedEvents].sort((a, b) => a.ts - b.ts)

  // AC5 Check 5: Reject duplicate input IDs
  const seenInputIds = new Set<string>()
  for (const c of correlationEvents) {
    if (seenInputIds.has(c.input_id)) {
      errors.push(`Duplicate input ID detected: ${c.input_id}.`)
      break
    }
    seenInputIds.add(c.input_id)
  }

  // AC5 Check 6: Reject canvas/label revision incoherence.
  //
  // The two counters advance independently: several document mutations can be
  // followed by a single label commit, so equality is not the invariant.
  // Coherence means the commit that closed this chain actually observed this
  // canvas revision, and that the label evidence did not move backwards.
  for (const c of correlationEvents) {
    if (c.label_revision === null || c.label_commit_app_revision === null) {
      errors.push(`Label overlay never committed for input ${c.input_id}.`)
      continue
    }
    if (c.label_commit_app_revision < c.app_revision) {
      errors.push(
        `Label commit for input ${c.input_id} observed app revision ${c.label_commit_app_revision}, which predates the dispatched revision ${c.app_revision}.`
      )
    }
    if (c.label_revision < c.label_revision_at_dispatch) {
      errors.push(
        `Label revision for input ${c.input_id} moved backwards: ${c.label_revision} is older than ${c.label_revision_at_dispatch} at dispatch.`
      )
    }
  }

  // AC1/AC3: without a clock mapping the two domains are incomparable.
  const mapping = profile.trace_configuration.clock_mapping
  const offsetMs = mapping.trace_to_page_offset_ms
  if (offsetMs === null) {
    errors.push(
      'No trace/page clock mapping is available; trace and page timestamps share no origin.'
    )
  }

  if (errors.length > 0) {
    return {
      valid: false,
      errors,
      chains: [],
      verdict: 'NOT_MEASURED',
      reasons: errors,
    }
  }

  const scale = clockUnits === 'us' ? 0.001 : 1
  /** Converts a trace timestamp to the page's `performance.now()` domain. */
  const toPageMs = (traceTs: number): number => traceTs * scale - (offsetMs as number)

  const presentationEvents = sortedEvents.filter(
    (e) => e.name !== undefined && PRESENTATION_EVENT_NAMES.has(e.name)
  )

  if (presentationEvents.length === 0) {
    reasons.push('Trace contains no presentation feedback events at all.')
  }

  const chains: InputPresentationChain[] = []

  for (const c of correlationEvents) {
    const dispatchMark = sortedEvents.find((e) =>
      e.name === `gurow:app_dispatch:${c.input_id}:${c.app_revision}`
    )

    // The dispatch itself must describe one coherent state before any frame can
    // be said to present it: the closing label commit observed exactly the
    // canvas revision this dispatch rendered.
    const dispatchStateCoherent =
      c.label_commit_app_revision === c.canvas_revision && c.app_revision === c.canvas_revision

    // Qualification schema, not invented Chromium args: a future acquisition
    // join must demonstrate BOTH revisions on this same frame. Raw Chromium
    // currently provides no such join, so remains honestly unsupported.
    const presentsThisState = (pe: TraceEvent) =>
      dispatchStateCoherent &&
      (readNumberArg(pe.args, 'canvas_revision') ??
        readNumberArg(pe.args, 'gurow_canvas_revision')) === c.canvas_revision &&
      readNumberArg(pe.args, 'label_revision') === c.label_revision &&
      readNumberArg(pe.args, 'label_commit_app_revision') === c.canvas_revision
    const dispatchTs = dispatchMark?.ts
    const dispatchMs = dispatchTs === undefined ? null : toPageMs(dispatchTs)
    const assessPresentation = (event: TraceEvent | undefined) => {
      const flags = readNumberArg(event?.args, 'flags') ??
        readNumberArg(event?.args, 'presentation_flags') ?? 0
      const declaredFallback = Boolean(
        event?.args?.is_fallback || event?.args?.fabricated || event?.args?.estimated
      )
      const hasHardwareFeedback = Number.isInteger(flags) &&
        (flags & FLAG_HW_CLOCK) !== 0 && (flags & FLAG_HW_COMPLETION) !== 0
      // Receipt/submission time is not presentation time. The explicit actual
      // timestamp uses the profile's declared trace units and clock.
      const actualPresentationTs = readNumberArg(event?.args, 'presentation_timestamp')
      const endpointMs = actualPresentationTs === undefined ? null : toPageMs(actualPresentationTs)
      const hasFrame = typeof event?.id === 'string' && event.id.trim().length > 0
      const chronologyValid = dispatchMs !== null && Number.isFinite(dispatchMs) &&
        c.label_commit_ms !== null && Number.isFinite(c.label_commit_ms) &&
        endpointMs !== null && Number.isFinite(endpointMs) && endpointMs >= 0 &&
        dispatchMs <= c.label_commit_ms && c.label_commit_ms <= endpointMs &&
        actualPresentationTs! <= event!.ts &&
        c.input_origin_ms !== null && Number.isFinite(c.input_origin_ms) &&
        c.input_origin_ms >= 0 && c.input_origin_ms <= dispatchMs
      const isPresentation = event?.name !== 'DisplayScheduler::DrawAndSwap'
      return { declaredFallback, hasHardwareFeedback, endpointMs, hasFrame, chronologyValid,
        isPresentation, eligible: !declaredFallback && hasHardwareFeedback && hasFrame &&
          chronologyValid && isPresentation }
    }
    const coherentCandidates = presentationEvents.filter(presentsThisState)
    // Choose the first actual coherent presentation, not the first receipt or
    // submission with matching revision args. Invalid candidates remain useful
    // for diagnostics only when no genuinely eligible endpoint exists.
    const eligible = coherentCandidates
      .map((event) => ({ event, assessment: assessPresentation(event) }))
      .filter(({ assessment }) => assessment.eligible)
      .sort((a, b) => a.assessment.endpointMs! - b.assessment.endpointMs!)
    const revisionMatched = eligible[0]?.event ?? coherentCandidates[0]
    const temporalNext =
      dispatchTs === undefined
        ? undefined
        : presentationEvents.find((pe) => pe.ts >= dispatchTs)

    let frameLink: FrameLink = 'none'
    let linked: TraceEvent | undefined
    if (revisionMatched) {
      frameLink = 'revision_matched'
      linked = revisionMatched
    } else if (temporalNext) {
      frameLink = 'temporal_next_paint'
      linked = temporalNext
      reasons.push(
        `Input ${c.input_id} could only be tied to a subsequent paint, not to the presentation of canvas revision ${c.canvas_revision}.`
      )
    } else {
      reasons.push(`No presentation event follows the dispatch of input ${c.input_id}.`)
    }

    const { declaredFallback, hasHardwareFeedback, endpointMs, hasFrame,
      chronologyValid, isPresentation } = assessPresentation(linked)
    if (linked && (!hasFrame || !chronologyValid || !isPresentation)) {
      reasons.push(`Input ${c.input_id} lacks a nonempty presented-frame ID, actual hardware presentation time, or ordered input -> dispatch -> label commit -> presentation evidence; submission is not presentation.`)
    }
    if (endpointMs !== null && c.input_origin_ms !== null && endpointMs < c.input_origin_ms) {
      reasons.push(`Input ${c.input_id} produced a negative interval; clock mapping or input origin is invalid.`)
    }

    let provenance: PresentationProvenance
    if (!linked) {
      provenance = 'missing'
    } else if (declaredFallback || !hasHardwareFeedback) {
      provenance = 'fabricated'
      reasons.push(
        `Presentation timing for ${c.input_id} uses fabricated/fallback feedback; platform hardware timestamp unavailable.`
      )
    } else if (frameLink !== 'revision_matched' || !hasFrame || !chronologyValid || !isPresentation) {
      provenance = 'unrelated_next_paint'
    } else {
      provenance = 'platform_presentation_feedback'
    }

    // Never synthesise an endpoint. Only a real linked presentation event and a
    // real pre-dispatch origin can produce a latency.
    const presentationTsMs = provenance === 'platform_presentation_feedback' ? endpointMs : null
    let latencyMs: number | null = null
    if (presentationTsMs !== null && c.input_origin_ms !== null) {
      const delta = presentationTsMs - c.input_origin_ms
      if (delta < 0) {
        // A negative interval means the mapping or the origin is wrong. Record
        // it as unavailable instead of clamping it to zero.
        reasons.push(
          `Input ${c.input_id} produced a negative interval (${delta.toFixed(2)} ms); clock mapping or input origin is invalid.`
        )
      } else {
        latencyMs = delta
      }
    } else if (c.input_origin_ms === null) {
      reasons.push(
        `Input ${c.input_id} has no pre-dispatch browser input timestamp; AC2 requires the original input origin.`
      )
    }

    chains.push({
      input_id: c.input_id,
      scenario: c.scenario,
      coalesced_input_ids: c.coalesced_input_ids,
      input_timestamp_ms: c.input_origin_ms,
      app_revision: c.app_revision,
      canvas_revision: c.canvas_revision,
      label_revision: c.label_revision,
      presented_frame_id: presentationTsMs === null ? null : linked?.id ?? null,
      presentation_timestamp_ms: presentationTsMs,
      latency_ms: latencyMs,
      frame_link: frameLink,
      presentation_provenance: provenance,
      diagnostics: {
        cpu_duration_ms: c.cpu_work_duration_ms,
        gpu_submit_ms: c.gpu_submit_duration_ms,
        raf_interval_ms: c.raf_cadence_ms,
      },
    })
  }

  const allQualified = chains.length > 0 && chains.every(isQualifiedChain)

  let verdict: 'QUALIFIED' | 'UNSUPPORTED' | 'NOT_MEASURED'
  if (chains.length === 0) {
    verdict = 'NOT_MEASURED'
    reasons.push('No correlated inputs were available to evaluate.')
  } else if (allQualified) {
    verdict = 'QUALIFIED'
  } else {
    verdict = 'UNSUPPORTED'
  }

  return {
    valid: errors.length === 0,
    errors,
    chains,
    verdict,
    reasons,
  }
}

/**
 * Builds the canonical optical acquisition requirements specification per contract gurow-p1-v1.
 */
export function getOpticalAcquisitionRequirements(): OpticalAcquisitionRequirements {
  return {
    protocol_id: 'gurow-optical-v1',
    minimum_capture_fps: 240,
    nominal_frame_period_ms: 4.167,
    uncertainty_window_rule:
      'Given input onset [a, b] and display response onset [c, d] in identical camera clock domain, latency lies in [max(0, c - b), d - a].',
    percentile_policy:
      'Compute nearest-rank p95 of lower and upper bounds separately. PASS requires upper-bound p95 <= limit; FAIL requires lower-bound p95 > limit; otherwise inconclusive / NOT_MEASURED.',
    acceptance_sampling: {
      duration_per_window_seconds: 30,
      windows_per_scenario: 3,
      warmup_seconds: 10,
      equivalent_120hz_input_count_min: 3420,
      equivalent_120hz_input_count_max: 3780,
      minimum_response_groups: 300,
      minimum_presented_intervals: 300,
    },
  }
}

/** Outcome of one controlled fault-injection check, as actually observed. */
export interface DelayCheckResult {
  status: 'PASS' | 'FAIL' | 'NOT_MEASURED'
  pass: boolean
  shiftMs: number | null
  details: string
}

export interface QualificationEvidence {
  scenariosTested: string[]
  chains: InputPresentationChain[]
  gpuAdapter: string
  browserVersion: string
  appDelayCheck: DelayCheckResult
  labelDelayCheck: DelayCheckResult
  /** Diagnostic-only shifts, explicitly not presentation evidence. */
  diagnosticShifts: { appDispatchShiftMs: number | null; labelCommitShiftMs: number | null }
}

function complianceCell(ok: boolean, okText: string, badText: string): string {
  return ok ? okText : `**${badText}**`
}

function formatValue(value: string | number | null): string {
  return value === null ? '_not observed_' : String(value)
}

/**
 * Renders the qualification report for whatever verdict the evidence produced.
 *
 * Every compliance cell and every delay-check line is derived from the profile
 * and the observed results, so the report cannot claim a verification the run
 * did not perform.
 */
export function generateQualificationReport(
  profile: CollectorProfile,
  reasons: string[],
  evidence: QualificationEvidence
): string {
  const opt = getOpticalAcquisitionRequirements()
  const { host } = profile
  const blocked = profile.status !== 'QUALIFIED'
  const linkedChains = evidence.chains.filter((c) => c.frame_link === 'revision_matched').length
  const measuredChains = evidence.chains.filter((c) => c.latency_ms !== null).length

  return `# Qualification Report: ${profile.status} Collector Profile

**Contract:** ${profile.contract_id}
**Collector Version:** ${profile.version}
**Profile Hash:** \`${profile.hash}\`
**Verdict:** **${profile.status}**
**Window geometry:** ${profile.geometry_class}${
    profile.geometry_class === 'reference'
      ? ''
      : ' — the collector may be qualified on this window, but no acceptance series may be'
  }
**Source Commit:** \`${profile.identity.commit}\`${profile.identity.tree_dirty ? ' (working tree dirty)' : ''}
**Build Hash:** \`${profile.identity.build_hash}\`
**Source Fingerprint:** \`${profile.identity.source_fingerprint}\`

**Actual browser command line:** \`${JSON.stringify(host.browser_command_line)}\`

**Native window/screen and visibility observations:** \`${JSON.stringify(host.native_window)}\`

---

## 1. Executive Summary

Browser-based qualification on the reference host (${formatValue(host.gpu_adapter)}, ${host.os}, ${host.browser_backend}) produced the verdict **${profile.status}**.

${
  profile.status === 'QUALIFIED'
    ? `A presentation endpoint was tied to the presented canvas revision for every correlated input, with hardware presentation feedback. Downstream task L3-03 may consume this collector at profile hash \`${profile.hash}\`.`
    : `${profile.unsupported_reason ?? 'The evidence chain could not be qualified.'}

- CPU processing time, GPU submit completion (\`GPUQueue.onSubmittedWorkDone\`) and \`requestAnimationFrame\` cadence are recorded as diagnostics only and are **not** substituted for visible response.
- **Support was not manufactured.** Downstream task L3-03 is **BLOCKED** from using this collector for acceptance evidence.
- The project must invoke the **Optical Acquisition Alternative** defined in contract \`${profile.contract_id}\`.`
}

---

## 2. Environment & Host Evidence (AC1)

| Parameter | Observed Host Value | Qualification Compliance |
| --- | --- | --- |
| **GPU Adapter** | ${formatValue(host.gpu_adapter)} | ${complianceCell(!host.is_fallback && host.gpu_adapter !== UNKNOWN, 'Hardware adapter reported by WebGPU', 'Fallback or unresolved adapter')} |
| **GPU Driver** | ${formatValue(host.gpu_driver)} | ${complianceCell(host.gpu_driver !== UNKNOWN, 'Read from host', 'Not resolved')} |
| **Compositor / Backend** | ${host.compositor} (${host.browser_backend}) | Recorded as observed |
| **Browser Version** | ${host.browser_version} | Recorded as observed |
| **Display & Refresh** | ${formatValue(host.display_output)} @ ${formatValue(host.display_refresh_hz)} Hz (DPR ${formatValue(host.device_pixel_ratio)}) | ${complianceCell(host.display_refresh_hz !== null && host.device_pixel_ratio !== null, 'Read from host and live page', 'Not fully observed')} |
| **Viewport CSS** | ${host.viewport_css ? `${host.viewport_css[0]}×${host.viewport_css[1]}` : '_not observed_'} | ${
    profile.geometry_class === 'reference'
      ? complianceCell(
          host.viewport_css?.[0] === 1200 && host.viewport_css?.[1] === 720,
          'Matches 1200×720 reference',
          'Does not match reference viewport'
        )
      : 'Qualification-only geometry: **not** an acceptance environment'
  } |
| **Canvas Geometry** | ${host.canvas_geometry ? `${host.canvas_geometry.css_bounds.width}×${host.canvas_geometry.css_bounds.height} CSS, ${host.canvas_geometry.backing_size.width}×${host.canvas_geometry.backing_size.height} backing` : '_not observed_'} | ${complianceCell(host.canvas_geometry !== null, 'Recorded', 'Not recorded')} |
| **Trace Categories** | \`${profile.trace_configuration.categories.join(', ')}\` | Supported by Chrome CDP |
| **Clock Mapping** | offset ${formatValue(profile.trace_configuration.clock_mapping.trace_to_page_offset_ms)} ms over ${profile.trace_configuration.clock_mapping.sample_count} samples (spread ${formatValue(profile.trace_configuration.clock_mapping.offset_spread_ms)} ms) | ${complianceCell(profile.trace_configuration.clock_mapping.trace_to_page_offset_ms !== null, 'Derived from paired sync marks', 'Not established')} |

---

## 3. Investigation Findings & Attribution Analysis (AC2, AC3, AC5)

### Controlled Replay Summary (AC2)
- **Scenarios Evaluated:** ${evidence.scenariosTested.join(', ')}
- **Evidence Chains Parsed:** ${evidence.chains.length}
- **Chains Tied to a Presented Canvas Revision:** ${linkedChains} / ${evidence.chains.length}
- **Chains With a Computable Latency:** ${measuredChains} / ${evidence.chains.length}
- **Observed GPU Adapter:** ${formatValue(evidence.gpuAdapter)}
- **Observed Browser Version:** ${evidence.browserVersion}

### Causality and Delay Shift (AC4)

Both checks below compare the *attributed* endpoint. Where that endpoint is
unavailable the result is \`NOT_MEASURED\`, and the diagnostic-only shift is
reported separately so it is not mistaken for presentation evidence.

| Check | Status | Observed Shift | Detail |
| --- | --- | --- | --- |
| 80 ms application dispatch delay | **${evidence.appDelayCheck.status}** | ${evidence.appDelayCheck.shiftMs === null ? '_unavailable_' : `${evidence.appDelayCheck.shiftMs.toFixed(2)} ms`} | ${evidence.appDelayCheck.details} |
| 80 ms label render delay | **${evidence.labelDelayCheck.status}** | ${evidence.labelDelayCheck.shiftMs === null ? '_unavailable_' : `${evidence.labelDelayCheck.shiftMs.toFixed(2)} ms`} | ${evidence.labelDelayCheck.details} |

Diagnostic-only shifts (CPU-side, **not** presentation evidence): app dispatch ${formatValue(
    evidence.diagnosticShifts.appDispatchShiftMs === null
      ? null
      : Number(evidence.diagnosticShifts.appDispatchShiftMs.toFixed(2))
  )} ms, label commit ${formatValue(
    evidence.diagnosticShifts.labelCommitShiftMs === null
      ? null
      : Number(evidence.diagnosticShifts.labelCommitShiftMs.toFixed(2))
  )} ms.

### Structural Limitation of Browser-Internal Evidence

A chain qualifies only when one presentation event carries this canvas revision,
its matching label revision and an actual hardware presentation timestamp. Raw
Chromium emits no such canvas/label join for a custom WebGPU canvas, so on an
unmodified browser stack this collector can only report \`UNSUPPORTED\` or
\`NOT_MEASURED\`; a \`QUALIFIED\` verdict requires an acquisition path that
supplies the join. That is a property of the platform, not of this parser.

Input grouping is fixed by the collector as \`${profile.input_coalescing.rule_id}\`
(${profile.input_coalescing.attributed_origin}), never by a report reducer.

### Specific Limitations Identified
${reasons.length === 0 ? '_None recorded._' : [...new Set(reasons)].map((r) => `- **Finding:** ${r}`).join('\n')}

---

## 4. Optical Acquisition Alternative Protocol (AC6)

${
  blocked
    ? 'Because the browser-internal trace cannot certify hardware presentation feedback, acceptance evidence for P1 responsiveness must be acquired through high-speed optical capture:'
    : 'Retained for reference; this run qualified a browser collector, so optical acquisition is not required for acceptance.'
}

1. **Camera Specifications:**
   - Calibrated camera capturing display and physical/actuator input in the **same clock domain** at ≥${opt.minimum_capture_fps} fps (nominal frame period ≤${opt.nominal_frame_period_ms.toFixed(2)} ms).
   - Documented bound for rolling shutter, exposure duration, and scanout phase.
2. **Uncertainty Interval Accounting:**
   - For input onset interval $[a, b]$ and display update interval $[c, d]$, latency is bounded by $[\\max(0, c - b), d - a]$.
   - Compute nearest-rank p95 separately for lower and upper bounds.
   - **PASS:** Upper-bound p95 $\\le$ 50 ms.
   - **FAIL:** Lower-bound p95 $>$ 50 ms.
   - **NOT_MEASURED:** Uncertainty overlaps threshold.
3. **Workload and Equivalence:**
   - 30-second active windows following a 10-second warm-up.
   - Input load: ${opt.acceptance_sampling.equivalent_120hz_input_count_min} to ${opt.acceptance_sampling.equivalent_120hz_input_count_max} inputs per run (120 Hz equivalent).
   - At least ${opt.acceptance_sampling.minimum_response_groups} response groups and ${opt.acceptance_sampling.minimum_presented_intervals} presented content intervals per run.

---

## 5. Artifact Hashes & Signatures

- **Collector Profile Hash:** \`${profile.hash}\`
- **Specification Gate:** ${blocked ? 'L3-01 Delivered; L3-03 Gated on Optical Acquisition' : 'L3-01 Delivered; L3-03 may consume this collector'}
`
}
