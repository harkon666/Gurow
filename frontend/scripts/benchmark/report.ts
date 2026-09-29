import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import { computeProfileHash, validateCollectorProfile, validateReferenceEnvironment, isSoftwareAdapter, type CollectorProfile, type HostEnvironmentInfo } from './collector'
import { computeCheckpointHash, generateBenchmarkFixture, type FixtureManifest } from './fixture'

/** Capture-manifest-v1: all times are milliseconds on the named clock. Every request
 * has exactly one terminal classification; groups contain original input IDs, not
 * already-reduced latencies. Raw evidence is referenced by SHA-256 artifacts. */
export type Verdict = 'PASS' | 'FAIL' | 'NOT_MEASURED'
export type Scenario = 'pan' | 'zoom' | 'drag'
export type Acquisition = 'chromium' | 'optical'
export interface Bound { lower_ms: number; upper_ms: number }
export interface OpticalOnsets { input: Bound; response: Bound }
export interface OriginalInput {
  id: string; kind: string; scheduled_ms: number; injection_ms: number | null; origin_ms: number | null
  classification: 'presented' | 'noop' | 'late' | 'unresolved'
  reason: string | null
}
export interface ResponseGroup {
  member_ids: string[]; frame_id: string; presentation_ms: number | null
  provenance: 'platform_presentation_feedback' | 'optical_display' | 'fabricated' | 'missing'
  frame_link: 'revision_matched' | 'optically_attributed' | 'temporal_next_paint' | 'none'
  app_revision: number; canvas_revision: number; label_revision: number
  /** Optical onset uncertainty for the oldest original member, conservatively repeated. */
  optical_latency: Bound | null
  /** Onset windows on the calibrated optical clock, before latency reduction. */
  optical_onsets?: OpticalOnsets | null
}
export interface FrameInterval { frame_id: string; bounds: Bound | null; censored: boolean; coherent: boolean
  /** Consecutive presentation-feedback timestamps on run.clock (Chromium only). */
  previous_presentation_ms?: number; presentation_ms?: number
  /** Consecutive calibrated optical display-onset windows (optical only). */
  optical_onsets?: { previous: Bound; current: Bound } | null
  /** Optical video frame index, including frames with no input response group. */
  optical_frame?: { video_artifact: string; capture_frame_index: number } | null }
export interface CaptureRun {
  id: string; cards: 100 | 1000 | 10000; scenario: Scenario; repetition: number
  source_fingerprint: string; profile_hash: string; fixture_hash: string
  acquisition: Acquisition; clock: string; units: 'ms'
  warmup_seconds: number; active_seconds: number; drain_seconds: number
  windows: { warmup_start_ms: number; active_start_ms: number; active_end_ms: number; drain_end_ms: number }
  scheduled: number; delivered: number; invalid_reasons: string[]
  visibility: { initial: number; minimum: number; maximum: number; path_verified: boolean; labels_enabled: boolean
    labels: { initial: number; minimum: number; maximum: number }
    connections: { initial: number; minimum: number; maximum: number } }
  inputs: OriginalInput[]; groups: ResponseGroup[]; intervals: FrameInterval[]
  /** Optical evidence has independent input cadence and capture calibration. */
  optical_calibration: { qualified: boolean; independent_input_evidence: boolean; raw_video: string; calibration_artifact: string } | null
}
export interface Artifact { path: string; sha256: string; role: string }
export interface OptionalCounter { value: number | null; unit: string; reason: string | null }
export interface DiagnosticRecord {
  initialization_to_first_coherent_render_ms: OptionalCounter
  browser_process_tree_rss_bytes: OptionalCounter
  js_heap_bytes: OptionalCounter; wasm_memory_bytes: OptionalCounter; gpu_memory_bytes: OptionalCounter
  draw_calls: OptionalCounter; upload_bytes: OptionalCounter
  json_boundary_calls: OptionalCounter; json_boundary_bytes: OptionalCounter; json_boundary_duration_ms: OptionalCounter
  limitations: string[]
}
export interface FunctionalAssertion {
  id: string; action: string; assertion: string; command_or_log: string
  source_fingerprint: string; result: Verdict; reason: string | null
}
export interface ComparisonFixture {
  cards: 100 | 10000; connections: number; hash: string; manifest_path: string; checkpoint_path: string
}
export interface CaptureManifest {
  schema: 'gurow-p1-capture-manifest-v1'; synthetic: boolean
  identity: { contract_id: string; contract_sha256: string; parent_issue: 7
    commit: string; tree_dirty: boolean; source_fingerprint: string; build_hash: string
    timestamp: string; runner_version: string; parser_version: string; collector_version: string; profile_hash: string }
  environment: { host: HostEnvironmentInfo; ac_power_online: boolean; cpu_governor: string
    display_output: string; compositor_scale: number; vrr: boolean; dedicated_profile: boolean
    production_build: boolean; interruptions: string[] }
  profile: CollectorProfile
  fixture: { hash: string; seed: string; algorithm_version: string; cards: 1000; connections: 2000
    initial_visible_cards: 200; camera_and_cell: Record<string, number>; task_association_verified: boolean
    manifest_path: string; checkpoint_path: string }
  comparison_fixtures: ComparisonFixture[]
  runs: CaptureRun[]; functional: FunctionalAssertion[]; diagnostics: DiagnosticRecord
  artifacts: Artifact[]
}
export interface Protocol {
  contract_id: string; report_schema: string; parent_issue: number
  thresholds_ms: { frame_p95: number; input_to_visible_p95: number }
  primary: { cards: number; connections: number; initial_visible_cards: number; visible_cards_min: number; visible_cards_max: number; html_labels: boolean }
  comparisons: { cards: number; connections: number }[]
  sampling: { warmup_seconds: number; active_seconds: number; drain_seconds: number; repetitions_per_scenario: number
    minimum_delivered_requests: number; minimum_response_groups: number; minimum_presented_intervals: number }
  scenarios: Scenario[]; optical_equivalent_input_count_per_30s: { min: number; max: number }
  percentile: string; latency_statistics_unit: string; censored_tail_policy: string
}
export interface Statistics { unit: 'ms'; n: number; duration_seconds: number; p50: number | null; p95: number | null; max: number | null; observations: number[] }
export interface MetricReport { verdict: Verdict; reasons: string[]; lower: Statistics; upper: Statistics }
export interface RunReport { id: string; cards: number; scenario: Scenario; repetition: number; validity: Verdict; reasons: string[]
  visibility: CaptureRun['visibility']
  input_to_visible: MetricReport; presented_editor_frame_interval: MetricReport; group_sizes: number[]; counts: { scheduled: number; delivered: number; classified: number; late: number; unresolved: number } }
export interface BenchmarkReport {
  schema: 'gurow-p1-report-v1'; synthetic: boolean; identity: CaptureManifest['identity']; environment: CaptureManifest['environment']
  fixture: CaptureManifest['fixture']; comparison_fixtures: ComparisonFixture[]; runs: RunReport[]; functional: { verdict: Verdict; assertions: FunctionalAssertion[]; reasons: string[] }
  diagnostics: DiagnosticRecord; comparisons: { cards: number; verdict: Verdict; runs: RunReport[]; reasons: string[] }[]
  artifacts: Artifact[]; metrics: { verdict: Verdict; reasons: string[]; worst_runs: Record<string, string | null> }
  gate: { criteria: Record<'AC1' | 'AC2' | 'AC3' | 'AC4' | 'AC5', Verdict>; verdict: Verdict; reasons: string[]; required_follow_up: string[] }
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
// Changing any normative v1 value requires a versioned contract change, not a
// caller-supplied JSON file with the same contract_id and relaxed thresholds.
const APPROVED_V1_SHA256 = '1ffe143745d68eda253d993d8f3dff55043ec042811b3fd2527d03b6ffb72d10'
// Fixture generator is deterministic and takes no random seed; bind metadata to this implementation.
const FIXTURE_SEED = 'none-deterministic', FIXTURE_ALGORITHM = 'gurow-grid-gap-v1'
const good = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
const text = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0
const hex = (s: unknown) => typeof s === 'string' && /^[a-f0-9]{64}$/i.test(s)
const notMeasured = (reasons: string[]) => reasons.length ? 'NOT_MEASURED' as const : 'PASS' as const
export function combineVerdicts(verdicts: Verdict[]): Verdict {
  return verdicts.includes('FAIL') ? 'FAIL' : verdicts.includes('NOT_MEASURED') ? 'NOT_MEASURED' : 'PASS'
}
export function nearestRank(values: number[], fraction: number): number | null {
  if (!values.length || !values.every(good) || fraction <= 0 || fraction > 1) return null
  return [...values].sort((a, b) => a - b)[Math.ceil(fraction * values.length) - 1]
}
function stats(values: number[], duration_seconds: number): Statistics {
  return { unit: 'ms', n: values.length, duration_seconds, p50: nearestRank(values, .5), p95: nearestRank(values, .95),
    max: values.length ? Math.max(...values) : null, observations: values }
}
function metric(bounds: Bound[], duration: number, limit: number | null, reasons: string[]): MetricReport {
  const lower = stats(bounds.map(b => b.lower_ms), duration), upper = stats(bounds.map(b => b.upper_ms), duration)
  let verdict: Verdict = 'NOT_MEASURED'
  if (!reasons.length && lower.p95 !== null && upper.p95 !== null) {
    verdict = limit === null || upper.p95 <= limit ? 'PASS' : lower.p95 > limit ? 'FAIL' : 'NOT_MEASURED'
    if (verdict === 'NOT_MEASURED') reasons.push('uncertainty_overlaps_limit')
  }
  return { verdict, reasons, lower, upper }
}
/** No path may escape the manifest directory; all raw references must be verified. */
export function verifyArtifacts(artifacts: Artifact[], directory: string): string[] {
  const errors: string[] = [], paths = new Set<string>()
  if (!Array.isArray(artifacts) || !artifacts.length) return ['Artifact inventory is empty.']
  for (const a of artifacts) {
    if (!a || !text(a.path) || isAbsolute(a.path) || relative(directory, resolve(directory, a.path)).startsWith('..') || !text(a.role) || !hex(a.sha256)) {
      errors.push(`Invalid artifact reference ${a?.path ?? '(missing)'}`); continue
    }
    if (paths.has(a.path)) errors.push(`Duplicate artifact ${a.path}`)
    paths.add(a.path)
    try {
      const root = realpathSync(directory), target = realpathSync(resolve(directory, a.path))
      if (relative(root, target).startsWith('..') || isAbsolute(relative(root, target))) { errors.push(`Artifact escapes manifest directory: ${a.path}`); continue }
      if (hash(readFileSync(target)) !== a.sha256) errors.push(`Artifact SHA-256 mismatch: ${a.path}`)
    }
    catch { errors.push(`Artifact missing/unreadable: ${a.path}`) }
  }
  return errors
}
/** The CLI compares evidence bytes with the exact records being reduced. Merely
 * listing a correctly hashed but unrelated file cannot validate a gate. */
export function verifyArtifactBindings(m: CaptureManifest, directory: string): string[] {
  if (m.synthetic) return []
  const errors: string[] = []
  for (const [role, value] of [['collector-profile', m.profile], ['raw-input-frame-log', m.runs], ['functional-log', m.functional]] as const) {
    const a = m.artifacts?.find(x => x.role === role)
    if (!a) continue
    try {
      const contents = JSON.parse(readFileSync(resolve(directory, a.path), 'utf8'))
      if (JSON.stringify(contents) !== JSON.stringify(value)) errors.push(`${role} content differs from manifest records.`)
    } catch { errors.push(`${role} is not readable JSON.`) }
  }
  for (const fixture of [m.fixture, ...(m.comparison_fixtures ?? [])]) {
    if (!fixture) continue
    const prefix = fixture.cards === 1000 ? 'primary-fixture' : 'comparison-fixture'
    const manifestArtifact = m.artifacts?.find(a => a.role === `${prefix}-manifest` && a.path === fixture.manifest_path)
    const checkpointArtifact = m.artifacts?.find(a => a.role === `${prefix}-checkpoint` && a.path === fixture.checkpoint_path)
    if (!manifestArtifact || !checkpointArtifact) { errors.push(`Fixture ${fixture.cards} manifest/checkpoint artifact missing.`); continue }
    try {
      const record = JSON.parse(readFileSync(resolve(directory, manifestArtifact.path), 'utf8')) as FixtureManifest
      const checkpoint = JSON.parse(readFileSync(resolve(directory, checkpointArtifact.path), 'utf8'))
      const expected = generateBenchmarkFixture(fixture.cards, {
        savedAt: record.created_at, learningPathId: record.learning_path_id, accountId: record.account_id,
      })
      if (record.contract_id !== m.identity.contract_id || record.size !== fixture.cards || record.card_count !== fixture.cards ||
        record.connection_count !== fixture.connections || record.checkpoint_hash !== fixture.hash)
        errors.push(`Fixture ${fixture.cards} raw manifest does not match the reduced workload.`)
      if (checkpoint?.editor?.cards?.length !== fixture.cards || checkpoint?.editor?.connections?.length !== fixture.connections ||
        computeCheckpointHash(checkpoint) !== fixture.hash || checkpoint?.application?.learning_path_id !== record.learning_path_id)
        errors.push(`Fixture ${fixture.cards} checkpoint does not match manifest/count/hash.`)
      if (JSON.stringify(record) !== JSON.stringify(expected.manifest) || JSON.stringify(checkpoint) !== JSON.stringify(expected.checkpoint))
        errors.push(`Fixture ${fixture.cards} geometry/checkpoint does not match contracted layout.`)
      if (fixture.cards === 1000 && ('camera_and_cell' in fixture) &&
        (fixture.seed !== FIXTURE_SEED || fixture.algorithm_version !== FIXTURE_ALGORITHM ||
          Object.keys(fixture.camera_and_cell ?? {}).sort().join(',') !== 'offset_x,offset_y,px,py,z0' ||
          fixture.camera_and_cell.z0 !== expected.geometry.z0 || fixture.camera_and_cell.px !== expected.geometry.px ||
          fixture.camera_and_cell.py !== expected.geometry.py || fixture.camera_and_cell.offset_x !== expected.geometry.camera.offset_x ||
          fixture.camera_and_cell.offset_y !== expected.geometry.camera.offset_y))
        errors.push('Primary fixture metadata differs from verified generator geometry and algorithm.')
    } catch { errors.push(`Fixture ${fixture.cards} manifest/checkpoint unreadable or invalid.`) }
  }
  const qualification = m.artifacts?.find(a => a.role === 'qualification-report')
  if (qualification) try {
    const record = JSON.parse(readFileSync(resolve(directory, qualification.path), 'utf8'))
    if (record.verdict !== 'QUALIFIED' || record.profile_hash !== m.profile.hash || record.identity?.source_fingerprint !== m.identity.source_fingerprint || record.identity?.build_hash !== m.identity.build_hash || record.acceptance_profile_validation?.valid !== true || record.controlled_delays?.app_delay_check?.status !== 'PASS' || record.controlled_delays?.label_delay_check?.status !== 'PASS') errors.push('Qualification report does not establish this profile/source with both delay checks.')
  } catch { errors.push('Qualification report unreadable.') }
  const build = m.artifacts?.find(a => a.role === 'production-build')
  if (build && build.sha256 !== m.identity.build_hash) errors.push('Production build artifact digest differs from build identity.')
  for (const r of m.runs ?? []) if (r.acquisition === 'optical') {
    const calibration = m.artifacts?.find(a => a.role === 'optical-calibration' && a.path === r.optical_calibration?.calibration_artifact)
    const video = m.artifacts?.find(a => a.role === 'optical-video' && a.path === r.optical_calibration?.raw_video)
    if (!calibration || !video) errors.push(`Optical run ${r.id} requires verified calibration and video artifacts.`)
    else try {
      const record = JSON.parse(readFileSync(resolve(directory, calibration.path), 'utf8'))
      if (record.run_id !== r.id || record.source_fingerprint !== m.identity.source_fingerprint || record.video_sha256 !== video.sha256 || record.qualified !== true || record.independent_input_evidence !== true) errors.push(`Optical calibration ${r.id} not bound to source, run and video.`)
    } catch { errors.push(`Optical calibration ${r.id} unreadable.`) }
  }
  return errors
}
const REQUIRED_FUNCTIONAL = ['create_select', 'pan_zoom_drag', 'connection_cycle_rejection', 'task_edit', 'undo_redo', 'reload', 'keyboard_list_no_webgpu', 'device_loss_recovery_retry'] as const
function reduceRun(run: CaptureRun, m: CaptureManifest, p: Protocol): RunReport {
  const reasons: string[] = []
  const primary = run.cards === p.primary.cards
  const expectedFixture = primary ? p.primary : p.comparisons.find(c => c.cards === run.cards)
  const comparison = primary ? null : m.comparison_fixtures?.find(c => c.cards === run.cards)
  if (!expectedFixture || !hex(run.fixture_hash) ||
    (primary && run.fixture_hash !== m.fixture?.hash) ||
    (!primary && (!comparison || comparison.connections !== expectedFixture.connections || !hex(comparison.hash) || run.fixture_hash !== comparison.hash)))
    reasons.push('Fixture identity/count missing or mismatched.')
  if (run.source_fingerprint !== m.identity.source_fingerprint || run.profile_hash !== m.identity.profile_hash) reasons.push('Run source/profile identity mismatch.')
  if (!p.scenarios.includes(run.scenario) || !Number.isInteger(run.repetition) || run.repetition < 1 || run.repetition > p.sampling.repetitions_per_scenario) reasons.push('Run scenario/repetition invalid.')
  if (run.warmup_seconds !== p.sampling.warmup_seconds || run.active_seconds !== p.sampling.active_seconds || run.drain_seconds > p.sampling.drain_seconds || !good(run.drain_seconds)) reasons.push('Run window lengths invalid.')
  const w = run.windows
  if (!w || ![w.warmup_start_ms,w.active_start_ms,w.active_end_ms,w.drain_end_ms].every(good) || w.active_start_ms - w.warmup_start_ms !== run.warmup_seconds * 1000 || w.active_end_ms - w.active_start_ms !== run.active_seconds * 1000 || w.drain_end_ms - w.active_end_ms !== run.drain_seconds * 1000) reasons.push('Warmup/active/drain monotonic windows invalid.')
  if (run.units !== 'ms' || !text(run.clock) || (run.acquisition === 'chromium' && run.clock !== m.profile.trace_configuration.clock_origin) || (run.acquisition === 'optical' && run.clock !== 'optical_capture_clock')) reasons.push('Unqualified or mixed clock/units.')
  if (run.acquisition !== 'optical' && run.acquisition !== 'chromium') reasons.push('Acquisition unknown.')
  if (!Array.isArray(run.invalid_reasons) || run.invalid_reasons.length) reasons.push(...(run.invalid_reasons ?? ['Invalid run reasons missing.']))
  const v = run.visibility
  const countsValid = (counts: { initial: number; minimum: number; maximum: number } | undefined, total: number) =>
    counts && [counts.initial, counts.minimum, counts.maximum].every(Number.isSafeInteger) &&
    counts.minimum >= 0 && counts.minimum <= counts.initial && counts.initial <= counts.maximum && counts.maximum <= total
  if (!v || !v.path_verified || !v.labels_enabled || !countsValid(v,run.cards) ||
    !countsValid(v.labels,run.cards) || !countsValid(v.connections,expectedFixture?.connections ?? 0) || !v.labels.minimum ||
    (primary && (v.initial !== p.primary.initial_visible_cards || v.minimum < p.primary.visible_cards_min || v.maximum > p.primary.visible_cards_max)))
    reasons.push('Card/label/connection visibility counts or path invalid or unverified.')
  if (!Number.isInteger(run.scheduled) || run.scheduled !== 3600 || !Number.isInteger(run.delivered) || run.delivered < 0 || run.delivered > run.scheduled || !Array.isArray(run.inputs) || run.inputs.length !== run.scheduled) reasons.push('Scheduled/delivered/input accounting mismatch.')
  const ids = new Set<string>(), members = new Set<string>()
  let delivered = 0, late = 0, unresolved = 0
  const expectedKinds: Record<Scenario, string[]> = { pan: ['pan', 'pointermove'], zoom: ['zoom', 'wheel'], drag: ['drag', 'pointermove'] }
  for (const [index, input] of (run.inputs ?? []).entries()) {
    if (w && Math.abs(input.scheduled_ms - (w.active_start_ms + index * 1000 / 120)) > 0.000001) reasons.push('Original 120 Hz absolute input schedule mismatched.')
    if (!text(input.id) || ids.has(input.id) || !expectedKinds[run.scenario]?.includes(input.kind) || !['presented','noop','late','unresolved'].includes(input.classification)) reasons.push('Duplicate/malformed/unclassified or scenario-mismatched input.')
    ids.add(input.id)
    if (!good(input.scheduled_ms) || (w && (input.scheduled_ms < w.active_start_ms || input.scheduled_ms >= w.active_end_ms)) ||
      (input.injection_ms !== null && (!good(input.injection_ms) || input.injection_ms < input.scheduled_ms || (input.classification !== 'late' && w && input.injection_ms >= w.active_end_ms))) ||
      (input.classification !== 'late' && w && good(input.origin_ms) && (input.origin_ms < w.active_start_ms || input.origin_ms >= w.active_end_ms)) ||
      (run.acquisition === 'chromium' && input.classification !== 'late' && (input.injection_ms === null || (good(input.origin_ms) && input.origin_ms < input.injection_ms)))) reasons.push('Input deadline/injection/origin outside active window or misordered.')
    if (run.acquisition === 'optical' && input.injection_ms !== null) reasons.push('Physical optical origin cannot use injected-input timestamp.')
    if (input.classification === 'late') late++
    else { delivered++; if (!good(input.origin_ms)) reasons.push('Missing/invalid original input origin.'); if (input.classification === 'unresolved') unresolved++ }
    if (input.classification !== 'presented' && !text(input.reason)) reasons.push('Non-presented input lacks predeclared reason.')
  }
  if (delivered !== run.delivered || late !== run.scheduled - run.delivered || unresolved) reasons.push('Delivered/late counts mismatch or unresolved responses.')
  if ((run.inputs ?? []).some(i => i.classification === 'noop')) reasons.push('No-op classification lacks a qualified predeclared collector rule.')
  if (run.acquisition === 'chromium' && delivered < p.sampling.minimum_delivered_requests) reasons.push('Automated pacing below minimum.')
  if (run.acquisition === 'optical' && (delivered < p.optical_equivalent_input_count_per_30s.min || delivered > p.optical_equivalent_input_count_per_30s.max || !run.optical_calibration?.qualified || !run.optical_calibration.independent_input_evidence || !text(run.optical_calibration.raw_video) || !m.artifacts.some(a => a.path === run.optical_calibration?.raw_video))) reasons.push('Optical load/calibration/video incomplete.')
  const responses: Bound[] = []
  const frameGroups = new Map<string, ResponseGroup>()
  for (const g of run.groups ?? []) {
    const prior = frameGroups.get(g.frame_id)
    if (prior && (prior.presentation_ms !== g.presentation_ms || prior.app_revision !== g.app_revision || prior.canvas_revision !== g.canvas_revision || prior.label_revision !== g.label_revision)) reasons.push('Conflicting presentation time/revision for one frame ID.')
    else frameGroups.set(g.frame_id, g)
    if (!g.member_ids?.length || !text(g.frame_id) || !Number.isInteger(g.app_revision) || g.app_revision < 0 || g.canvas_revision !== g.app_revision || g.label_revision !== g.app_revision ||
      (run.acquisition === 'chromium' && (g.provenance !== 'platform_presentation_feedback' || g.frame_link !== 'revision_matched')) ||
      (run.acquisition === 'optical' && (g.provenance !== 'optical_display' || g.frame_link !== 'optically_attributed'))) reasons.push('Unqualified/fabricated presentation or revision mismatch.')
    const origins = g.member_ids.map(id => (run.inputs ?? []).find(i => i.id === id))
    for (const id of g.member_ids) { if (members.has(id)) reasons.push('Duplicate group member.'); members.add(id) }
    if (origins.some(i => !i || i.classification !== 'presented' || !good(i.origin_ms))) { reasons.push('Group contains unknown/non-presented member.'); continue }
    const oldest = Math.min(...origins.map(i => i!.origin_ms!))
    if (run.acquisition === 'optical') {
      const onset = g.optical_onsets
      if (onset && good(onset.response?.lower_ms) && origins.some(i => i!.origin_ms! > onset.response.lower_ms))
        reasons.push('Optical response precedes a grouped original input.')
      if (!onset || ![onset.input?.lower_ms, onset.input?.upper_ms, onset.response?.lower_ms, onset.response?.upper_ms].every(good) ||
        onset.input.lower_ms > onset.input.upper_ms || onset.response.lower_ms > onset.response.upper_ms ||
        oldest < onset.input.lower_ms || oldest > onset.input.upper_ms ||
        (w && (onset.input.lower_ms < w.active_start_ms || onset.response.upper_ms > w.drain_end_ms)) ||
        (g.presentation_ms !== null && (!good(g.presentation_ms) || g.presentation_ms < onset.response.lower_ms || g.presentation_ms > onset.response.upper_ms)) ||
        g.optical_latency?.lower_ms !== Math.max(0, onset.response.lower_ms - onset.input.upper_ms) ||
        g.optical_latency?.upper_ms !== onset.response.upper_ms - onset.input.lower_ms) reasons.push('Optical latency not derived from calibrated input/response onset windows.')
    }
    const bound = run.acquisition === 'optical' ? g.optical_latency : good(g.presentation_ms) ? { lower_ms: g.presentation_ms - oldest, upper_ms: g.presentation_ms - oldest } : null
    if (!bound || !good(bound.lower_ms) || !good(bound.upper_ms) || bound.lower_ms > bound.upper_ms || (run.acquisition === 'chromium' && (origins.some(i => i!.origin_ms! > g.presentation_ms!) || (w && g.presentation_ms! > w.drain_end_ms)))) { reasons.push('Missing/negative/misordered response time or optical bound.'); continue }
    // Collector's pinned rule attributes the oldest original origin to every member.
    for (const _ of origins) responses.push(bound)
  }
  if ((run.groups?.length ?? 0) < p.sampling.minimum_response_groups) reasons.push('Insufficient response groups.')
  if ((run.inputs ?? []).some(i => i.classification === 'presented' && !members.has(i.id))) reasons.push('Presented input absent from groups.')
  const frames: Bound[] = []
  const intervals = run.intervals ?? []
  for (const [index, interval] of intervals.entries()) {
    if (!text(interval.frame_id) || !interval.coherent || interval.censored || !interval.bounds || !good(interval.bounds.lower_ms) || !good(interval.bounds.upper_ms) || interval.bounds.lower_ms > interval.bounds.upper_ms) reasons.push('Censored/invalid/noncoherent terminal frame interval.')
    else if (w && (run.acquisition === 'chromium'
      ? good(interval.previous_presentation_ms) && good(interval.presentation_ms) &&
        interval.presentation_ms > w.active_start_ms && interval.previous_presentation_ms < w.active_end_ms
      : interval.optical_onsets?.current && good(interval.optical_onsets.current.upper_ms) &&
        good(interval.optical_onsets.previous?.lower_ms) && interval.optical_onsets.current.upper_ms > w.active_start_ms &&
        interval.optical_onsets.previous.lower_ms < w.active_end_ms)) frames.push(interval.bounds)
    if (run.acquisition === 'chromium') {
      const group = frameGroups.get(interval.frame_id)
      if (!good(interval.previous_presentation_ms) || !good(interval.presentation_ms) ||
        interval.presentation_ms <= interval.previous_presentation_ms ||
        interval.bounds?.lower_ms !== interval.presentation_ms - interval.previous_presentation_ms ||
        interval.bounds.upper_ms !== interval.presentation_ms - interval.previous_presentation_ms ||
        (index > 0 && intervals[index - 1]?.presentation_ms !== interval.previous_presentation_ms) ||
        (group && group.presentation_ms !== interval.presentation_ms) ||
        (w && interval.presentation_ms > w.drain_end_ms)) reasons.push('Frame interval not derived from consecutive coherent presentation timestamps.')
    } else if (run.acquisition === 'optical') {
      const onset = interval.optical_onsets, group = frameGroups.get(interval.frame_id)
      const videoFrame = interval.optical_frame
      if (!videoFrame || videoFrame.video_artifact !== run.optical_calibration?.raw_video ||
        !Number.isSafeInteger(videoFrame.capture_frame_index) || videoFrame.capture_frame_index < 0 ||
        (index > 0 && (!intervals[index - 1]?.optical_frame || videoFrame.capture_frame_index <= intervals[index - 1]!.optical_frame!.capture_frame_index))) reasons.push('Optical interval missing a unique ordered raw video-frame reference.')
      if (!onset || ![onset.previous?.lower_ms, onset.previous?.upper_ms, onset.current?.lower_ms, onset.current?.upper_ms].every(good) ||
        onset.previous.lower_ms > onset.previous.upper_ms || onset.current.lower_ms > onset.current.upper_ms ||
        onset.current.lower_ms <= onset.previous.upper_ms ||
        interval.bounds?.lower_ms !== Math.max(0, onset.current.lower_ms - onset.previous.upper_ms) ||
        interval.bounds.upper_ms !== onset.current.upper_ms - onset.previous.lower_ms ||
        (index > 0 && (intervals[index - 1]?.optical_onsets?.current.lower_ms !== onset.previous.lower_ms || intervals[index - 1]?.optical_onsets?.current.upper_ms !== onset.previous.upper_ms)) ||
        (group?.optical_onsets && (group.optical_onsets.response.lower_ms !== onset.current.lower_ms || group.optical_onsets.response.upper_ms !== onset.current.upper_ms)) ||
        (w && onset.current.upper_ms > w.drain_end_ms)) reasons.push('Optical frame interval not derived from consecutive calibrated presentation onset windows.')
    }
  }
  if (w && !intervals.some(i => i.coherent && !i.censored && (run.acquisition === 'chromium'
    ? good(i.previous_presentation_ms) && good(i.presentation_ms) &&
      i.previous_presentation_ms <= w.active_end_ms && i.presentation_ms >= w.active_end_ms
    : i.optical_onsets && good(i.optical_onsets.previous?.lower_ms) && good(i.optical_onsets.current?.lower_ms) &&
      i.optical_onsets.previous.lower_ms <= w.active_end_ms && i.optical_onsets.current.lower_ms >= w.active_end_ms)))
    reasons.push('Active-window terminal presentation/stall not accounted for.')
  const intervalIds = new Set(intervals.map(i => i.frame_id))
  if (frames.length < p.sampling.minimum_presented_intervals || intervalIds.size !== (run.intervals ?? []).length) reasons.push('Insufficient active-window or duplicate presented intervals.')
  if ((run.groups ?? []).some(g => !intervalIds.has(g.frame_id))) reasons.push('Response group frame absent from coherent presented intervals.')
  const input_to_visible = metric(responses, run.active_seconds, primary ? p.thresholds_ms.input_to_visible_p95 : null, [...new Set(reasons)])
  const presented_editor_frame_interval = metric(frames, run.active_seconds, primary ? p.thresholds_ms.frame_p95 : null, [...new Set(reasons)])
  return { id: run.id, cards: run.cards, scenario: run.scenario, repetition: run.repetition, validity: notMeasured(reasons), reasons: [...new Set(reasons)], visibility: run.visibility, input_to_visible, presented_editor_frame_interval,
    group_sizes: (run.groups ?? []).map(g => g.member_ids.length), counts: { scheduled: run.scheduled, delivered: run.delivered, classified: run.inputs?.length ?? 0, late, unresolved } }
}
export function reduceReport(m: CaptureManifest, p: Protocol, contractBytes: Uint8Array, artifactErrors: string[] = []): BenchmarkReport {
  const structural: string[] = [...artifactErrors]
  if (!m.synthetic) for (const role of ['raw-input-frame-log', 'collector-profile', 'functional-log', 'production-build', 'primary-fixture-manifest', 'primary-fixture-checkpoint',
    ...((m.runs ?? []).some(r => r.acquisition === 'chromium') ? ['raw-trace', 'qualification-report'] : [])]) {
    if (!m.artifacts?.some(a => a.role === role)) structural.push(`Missing required ${role} artifact.`)
  }
  if (hash(contractBytes) !== APPROVED_V1_SHA256 || JSON.stringify(p) !== JSON.stringify(JSON.parse(new TextDecoder().decode(contractBytes))) || m.schema !== 'gurow-p1-capture-manifest-v1' || typeof m.synthetic !== 'boolean' || p.contract_id !== 'gurow-p1-v1' || p.report_schema !== 'gurow-p1-report-v1' || p.percentile !== 'nearest_rank_ceil' || p.latency_statistics_unit !== 'each_original_delivered_input' || p.censored_tail_policy !== 'NOT_MEASURED') structural.push('Contract/manifest schema or approved versioned v1 policy mismatched.')
  if (m.identity.contract_id !== p.contract_id || m.identity.contract_sha256 !== hash(contractBytes) || m.identity.parent_issue !== p.parent_issue || !text(m.identity.commit) || !hex(m.identity.source_fingerprint) || !hex(m.identity.build_hash) || !text(m.identity.timestamp) || !text(m.identity.runner_version) || !text(m.identity.parser_version) || !text(m.identity.collector_version)) structural.push('Contract/source/build/runner identity invalid.')
  const profile = m.profile
  const opticalOnly = (m.runs ?? []).length > 0 && m.runs.every(r => r.acquisition === 'optical')
  if ((m.runs ?? []).some(r => r.acquisition === 'optical') && (m.runs ?? []).some(r => r.acquisition === 'chromium'))
    structural.push('Mixed optical and Chromium acquisition series; physical and injected origins cannot be combined.')
  const profileErrors = profile ? opticalOnly
    ? [...validateReferenceEnvironment(profile.host, { requireReferenceGeometry: true }),
      ...(profile.hash === computeProfileHash((({ hash: _hash, ...rest }) => rest)(profile)) ? [] : ['Profile hash mismatch.']),
      ...(profile.geometry_class === 'reference' && !profile.host.is_fallback && !isSoftwareAdapter(profile.host.gpu_adapter) && profile.host.gpu_adapter !== 'unknown' && profile.host.gpu_driver !== 'unknown' && !profile.fault_injection.enabled && !profile.fault_injection.app_delay_ms && !profile.fault_injection.label_delay_ms ? [] : ['Optical reference profile environment/fault injection invalid.'])]
    : validateCollectorProfile(profile, { requireAcceptanceMode: true, requireReferenceGeometry: true }).errors : ['Collector profile missing.']
  if (profile && (profile.contract_id !== p.contract_id || profile.hash !== m.identity.profile_hash || profile.identity.commit !== m.identity.commit || profile.identity.tree_dirty !== m.identity.tree_dirty || profile.identity.source_fingerprint !== m.identity.source_fingerprint || profile.identity.build_hash !== m.identity.build_hash || profile.version !== m.identity.collector_version || profile.trace_configuration.parser_version !== m.identity.parser_version)) structural.push('Collector profile/source/parser identity mismatch.')
  if (profileErrors.length || (!opticalOnly && profile?.status !== 'QUALIFIED')) structural.push('Acquisition/profile not qualified for acceptance: ' + profileErrors.join('; '))
  if (m.environment?.host?.gpu_adapter !== profile?.host?.gpu_adapter || m.environment?.host?.gpu_driver !== profile?.host?.gpu_driver || m.environment?.host?.browser_version !== profile?.host?.browser_version || !m.environment?.ac_power_online || m.environment.cpu_governor !== 'powersave' || m.environment.display_output !== 'eDP-2' || m.environment.compositor_scale !== 1.5 || m.environment.vrr !== false || !m.environment.dedicated_profile || !m.environment.production_build || m.environment.interruptions?.length) structural.push('Reference environment incomplete/changed/interrupted.')
  if (!m.fixture || m.fixture.cards !== p.primary.cards || m.fixture.connections !== p.primary.connections || m.fixture.initial_visible_cards !== p.primary.initial_visible_cards || !hex(m.fixture.hash) || m.fixture.seed !== FIXTURE_SEED || m.fixture.algorithm_version !== FIXTURE_ALGORITHM || !m.fixture.task_association_verified || !text(m.fixture.manifest_path) || !text(m.fixture.checkpoint_path) || !Object.values(m.fixture.camera_and_cell ?? {}).every(v => typeof v === 'number' && Number.isFinite(v))) structural.push('Primary fixture invalid.')
  const comparisonFixtureReasons: string[] = []
  for (const expected of p.comparisons) {
    const matches = m.comparison_fixtures?.filter(f => f.cards === expected.cards) ?? []
    if (matches.length !== 1 || matches[0].connections !== expected.connections || !hex(matches[0].hash) || !text(matches[0].manifest_path) || !text(matches[0].checkpoint_path) ||
      (!m.synthetic && (!m.artifacts?.some(a => a.role === 'comparison-fixture-manifest' && a.path === matches[0].manifest_path) ||
        !m.artifacts?.some(a => a.role === 'comparison-fixture-checkpoint' && a.path === matches[0].checkpoint_path))))
      comparisonFixtureReasons.push(`Comparison fixture ${expected.cards}/${expected.connections} identity or raw manifest missing.`)
  }
  if ((m.comparison_fixtures?.length ?? 0) !== p.comparisons.length) comparisonFixtureReasons.push('Unexpected comparison fixture identity.')
  structural.push(...comparisonFixtureReasons)
  const runs = (m.runs ?? []).map(r => reduceRun(r, m, p))
  const keys = new Set<string>(), metricReasons: string[] = [...structural]
  for (const r of runs) { const key = `${r.cards}/${r.scenario}/${r.repetition}`; if (keys.has(key)) metricReasons.push(`Duplicate run ${key}`); keys.add(key) }
  for (const scenario of p.scenarios) for (let i = 1; i <= p.sampling.repetitions_per_scenario; i++) if (!keys.has(`1000/${scenario}/${i}`)) metricReasons.push(`Missing primary ${scenario} run ${i}`)
  const primary = runs.filter(r => r.cards === p.primary.cards)
  const primaryVerdicts = primary.flatMap(r => [r.input_to_visible.verdict, r.presented_editor_frame_interval.verdict])
  const metricsVerdict = combineVerdicts([notMeasured(metricReasons), ...primaryVerdicts])
  const functionalReasons = REQUIRED_FUNCTIONAL.filter(id => !m.functional?.some(f => f.id === id)).map(id => `Missing functional ${id}`)
  for (const f of m.functional ?? []) if (!text(f.action) || !text(f.assertion) || !text(f.command_or_log) || f.source_fingerprint !== m.identity.source_fingerprint || !['PASS','FAIL','NOT_MEASURED'].includes(f.result) || (f.result !== 'PASS' && !text(f.reason))) functionalReasons.push(`Invalid functional assertion ${f.id}`)
  const functionalVerdict = combineVerdicts([notMeasured(functionalReasons), ...(m.functional ?? []).map(f => f.result)])
  const comparisons = p.comparisons.map(c => { const subset = runs.filter(r => r.cards === c.cards), reasons: string[] = []
    for (const s of p.scenarios) for (let i = 1; i <= p.sampling.repetitions_per_scenario; i++) if (!keys.has(`${c.cards}/${s}/${i}`)) reasons.push(`Missing comparison ${c.cards}/${s}/${i}`)
    if (subset.some(r => r.validity !== 'PASS')) reasons.push(`Invalid comparison ${c.cards} evidence`)
    return { cards: c.cards, verdict: notMeasured(reasons), runs: subset, reasons }
  })
  const diagnosticReasons: string[] = []
  const counterNames = ['initialization_to_first_coherent_render_ms','browser_process_tree_rss_bytes','js_heap_bytes','wasm_memory_bytes','gpu_memory_bytes','draw_calls','upload_bytes','json_boundary_calls','json_boundary_bytes','json_boundary_duration_ms'] as const
  for (const name of counterNames) { const c = m.diagnostics?.[name]; if (!c || !text(c.unit) || (c.value === null ? !text(c.reason) : !good(c.value))) diagnosticReasons.push(`Diagnostic ${name} requires a value or null + reason.`) }
  const ac4 = notMeasured([...diagnosticReasons, ...comparisonFixtureReasons, ...comparisons.flatMap(c => c.reasons)])
  const criteria = { AC1: functionalVerdict, AC2: metricsVerdict, AC3: notMeasured(structural), AC4: ac4, AC5: notMeasured([...structural, ...metricReasons.filter(r => r.startsWith('Missing primary'))]) }
  const verdict = m.synthetic ? 'NOT_MEASURED' : combineVerdicts(Object.values(criteria))
  const reasons = [...new Set([...structural, ...metricReasons, ...functionalReasons, ...comparisons.flatMap(c => c.reasons), ...diagnosticReasons, ...(m.synthetic ? ['Synthetic evidence cannot satisfy a real gate.'] : [])])]
  const worst_runs: Record<string, string | null> = {}
  for (const scenario of p.scenarios) for (const name of ['input_to_visible','presented_editor_frame_interval'] as const) {
    const eligible = primary.filter(r => r.scenario === scenario && r[name].upper.p95 !== null)
    worst_runs[`${scenario}/${name}`] = eligible.sort((a,b) => b[name].upper.p95! - a[name].upper.p95!)[0]?.id ?? null
  }
  return { schema: 'gurow-p1-report-v1', synthetic: m.synthetic, identity: m.identity, environment: m.environment, fixture: m.fixture, comparison_fixtures: m.comparison_fixtures ?? [], runs,
    functional: { verdict: functionalVerdict, assertions: m.functional ?? [], reasons: functionalReasons }, diagnostics: m.diagnostics, comparisons,
    artifacts: m.artifacts ?? [], metrics: { verdict: metricsVerdict, reasons: metricReasons, worst_runs }, gate: { criteria, verdict, reasons, required_follow_up: verdict === 'PASS' ? [] : reasons.length ? reasons : ['Investigate failing metric/functional assertion.'] } }
}
export function gateExitCode(report: BenchmarkReport): 0 | 1 | 2 {
  if (report.synthetic) return 2
  if (report.gate.verdict === 'FAIL') return 1
  return report.gate.verdict === 'PASS' && !Object.values(report.gate.criteria).includes('NOT_MEASURED') ? 0 : 2
}
export function markdownReport(r: BenchmarkReport): string {
  const lines = [`# P1 report — ${r.gate.verdict}${r.synthetic ? ' (SYNTHETIC — NOT P1 EVIDENCE)' : ''}`, '', `Contract: ${r.identity.contract_id} (${r.identity.contract_sha256})`, `Source: ${r.identity.commit} / ${r.identity.source_fingerprint}`, `Collector profile: ${r.identity.profile_hash}`, '', `Functional: **${r.functional.verdict}** · Metrics: **${r.metrics.verdict}** · Gate: **${r.gate.verdict}**`, '', '## Gate criteria', ...Object.entries(r.gate.criteria).map(([k,v]) => `- ${k}: ${v}`), '', '## Runs', '| Workload | Scenario | Repetition | Frame p95 upper (ms) | Input p95 upper (ms) | Frame | Input |', '|---|---|---:|---:|---:|---|---|']
  for (const run of r.runs) lines.push(`| ${run.cards} | ${run.scenario} | ${run.repetition} | ${run.presented_editor_frame_interval.upper.p95 ?? '—'} | ${run.input_to_visible.upper.p95 ?? '—'} | ${run.presented_editor_frame_interval.verdict} | ${run.input_to_visible.verdict} |`)
  lines.push('', '## Observed visibility (initial / minimum / maximum)', '| Run | Cards | HTML labels | Visible connections | Full path verified |', '|---|---|---|---|---|')
  for (const run of r.runs) {
    const counts = (value: { initial: number; minimum: number; maximum: number } | undefined) => value ? `${value.initial} / ${value.minimum} / ${value.maximum}` : 'NOT_MEASURED'
    lines.push(`| ${run.id} | ${counts(run.visibility)} | ${counts(run.visibility?.labels)} | ${counts(run.visibility?.connections)} | ${run.visibility?.path_verified === true ? 'yes' : 'no'} |`)
  }
  lines.push('', '## Per-run statistics (unrounded ms)', '| Run | Metric | n | Active duration (s) | Lower p50 / p95 / max | Upper p50 / p95 / max |', '|---|---|---:|---:|---|---|')
  for (const run of r.runs) for (const name of ['presented_editor_frame_interval', 'input_to_visible'] as const) {
    const metric = run[name], values = (s: Statistics) => `${s.p50 ?? '—'} / ${s.p95 ?? '—'} / ${s.max ?? '—'}`
    lines.push(`| ${run.id} | ${name} | ${metric.upper.n} | ${metric.upper.duration_seconds} | ${values(metric.lower)} | ${values(metric.upper)} |`)
  }
  lines.push('', '## Functional', ...r.functional.assertions.map(a => `- ${a.id}: ${a.result} — ${a.action}; ${a.assertion} (${a.command_or_log})`), '', '## Comparisons', ...r.comparisons.map(c => `- ${c.cards}: ${c.verdict}${c.reasons.length ? ' — ' + c.reasons.join('; ') : ''} (no primary thresholds)`), ...r.comparison_fixtures.map(f => `- Fixture ${f.cards} cards / ${f.connections} connections: ${f.manifest_path}, ${f.checkpoint_path} (checkpoint SHA-256 ${f.hash})`), '', '## Diagnostic limitations', ...Object.entries(r.diagnostics ?? {}).filter(([,v]) => v && typeof v === 'object' && 'value' in v && v.value === null).map(([k,v]) => `- ${k}: ${(v as OptionalCounter).reason}`), ...(r.diagnostics?.limitations ?? []).map(x => `- ${x}`), '', '## Raw artifacts (SHA-256)', ...r.artifacts.map(a => `- ${a.role}: ${a.path} — ${a.sha256}`), '', '## Reasons / follow-up', ...(r.gate.required_follow_up.length ? r.gate.required_follow_up.map(x => `- ${x}`) : ['- None']), '')
  return lines.join('\n')
}
