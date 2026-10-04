import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { computeCheckpointHash, generateBenchmarkFixture, loadBenchmarkContract, type BenchmarkSize, type ContractId, type FixtureManifest } from './fixture'
import { isSoftwareAdapter } from './collector'
import { nearestRank } from './scenarios'
import type { Scenario } from '../../src/components/editor/benchmarkHooks'

/** Approved protocols; reducer policy is pinned to these bytes. v5 gates on 300 cards (ADR 0020); v4 keeps the 1,000-card primary for comparison. */
export const PROTOCOL_PATHS: Record<ContractId, string> = {
  'gurow-p1-v4': resolve(import.meta.dir, '../../../docs/benchmarks/p1/protocol-v4.json'),
  'gurow-p1-v5': resolve(import.meta.dir, '../../../docs/benchmarks/p1/protocol-v5.json'),
}
const approvedPath = (id: string | undefined): string | undefined => (PROTOCOL_PATHS as Record<string, string>)[id ?? '']

/** V2 capture interchange: times are milliseconds on the in-page performance clock.
 * Preserve every attempt, including invalid attempts; only valid repetitions pool.
 * Raw samples are never replaced with per-run percentiles by the runner. */
export type Verdict = 'PASS' | 'FAIL' | 'NOT_MEASURED'
export type { Scenario }
export interface Artifact { path: string; sha256: string; role: string }
export interface OptionalCounter { value: number | null; unit: string; reason: string | null }
export interface DiagnosticRecord {
  initialization_to_first_render_ms: OptionalCounter
  process_rss_bytes: OptionalCounter
  js_heap_bytes: OptionalCounter
  wasm_memory_bytes: OptionalCounter
  draw_calls: OptionalCounter
  upload_bytes: OptionalCounter
  json_boundary_calls: OptionalCounter
  json_boundary_bytes: OptionalCounter
  json_boundary_duration_ms: OptionalCounter
  limitations: string[]
}
export interface FunctionalAssertion {
  id: string; action: string; assertion: string; command_or_log: string
  source_fingerprint: string; result: Verdict; reason: string | null
}
export interface FixtureRecord {
  cards: BenchmarkSize; connections: number; hash: string
  manifest_path: string; checkpoint_path: string; geometry: FixtureManifest['geometry']
  task_association_verified: boolean
}
export interface VisibilitySample { time_ms: number; visible_cards: number; dom_labels: number; submitted_primitives: number }
export interface CaptureRun {
  id: string; cards: BenchmarkSize; scenario: Scenario; repetition: number
  source_fingerprint: string; fixture_hash: string
  warmup_seconds: number; active_seconds: number; drain_seconds: number
  /** Requests the driver actually sent; below the sent minimum the run is invalid. */
  sent: number
  /** Inputs observed by the page, at most `sent`; below the delivered minimum the
   * app held back input (backpressure) and the run can FAIL but never PASS. */
  scheduled: number; delivered: number; invalid_reasons: string[]
  /** In-window inputs the editor ignored as no-ops; excluded from latency. */
  no_op_inputs?: number
  /** Frame intervals from consecutive rAF timestamps, including terminal open stall. */
  frame_interval_ms: number[]
  /** Input timeStamp to first frame after canvas AND label commit, plus 1000/refresh_hz. */
  input_to_frame_proxy_ms: number[]
  /** Same input observations without the nominal refresh interval. */
  input_to_frame_raw_ms: number[]
  /** Original browser event IDs and one terminal/proxy result per original. */
  captured_input_ids?: string[]; captured_sample_ids?: string[]
  visibility: VisibilitySample[]
  tab_visible: boolean; tab_focused: boolean; device_lost: boolean; page_errors: string[]
  delays_enabled: boolean
}
export interface CaptureManifest {
  schema: 'gurow-p1-capture-manifest-v4'; synthetic: boolean
  identity: { contract_id: string; contract_sha256: string; parent_issue: 7
    commit: string; tree_dirty: boolean; source_fingerprint: string; build_hash: string
    timestamp: string; runner_version: string }
  environment: { cpu: string; physical_memory_bytes: number; os: string; kernel: string
    compositor: string; cpu_governor: string; browser_executable: string; browser_version: string
    browser_flags: string[]; gpu_adapter: string; gpu_driver: string; hardware_gpu: boolean
    display_refresh_hz: number; window_inner_size: { width: number; height: number }
    device_pixel_ratio: number; canvas_css: { width: number; height: number }
    canvas_backing: { width: number; height: number }; browser_zoom_percent: number
    ac_power_online: boolean; dedicated_profile: boolean; production_build: boolean
    headed: boolean; canvas_unobscured: boolean; interruptions: string[] }
  fixture: FixtureRecord; comparison_fixtures: FixtureRecord[]
  runs: CaptureRun[]; functional: FunctionalAssertion[]; diagnostics: DiagnosticRecord
  sanity_checks: { application_update_p50_shift_ms: number | null; label_commit_p50_shift_ms: number | null }
  artifacts: Artifact[]
}
export interface Protocol {
  contract_id: string; report_schema: string; parent_issue: number
  thresholds_ms: { frame_p95: number; input_to_frame_proxy_p95: number }
  primary: { cards: number; connections: number; initial_visible_cards: number
    visible_cards_median_min: number; visible_cards_median_max: number; html_labels: boolean }
  comparisons: { cards: number; connections: number; runs_per_scenario: number }[]
  minimum_canvas_css: { width: number; height: number }; browser_zoom_percent: number
  sampling: { warmup_seconds: number; active_seconds: number; drain_seconds: number
    runs_per_scenario: number; input_hz: number; minimum_sent_fraction: number; minimum_delivered_fraction: number
    minimum_pooled_latency_samples: number; minimum_pooled_frame_intervals: number
    visibility_sample_hz: number; motion_period_seconds: number
    pan_drag_amplitude_cell_fraction: number; zoom_min_factor: number; zoom_max_factor: number }
  scenarios: Scenario[]; percentile: string
  sanity_check: { injected_delay_ms: number; minimum_p50_shift_ms: number }
}
export interface Statistics { unit: 'ms'; n: number; duration_seconds: number; p50: number | null; p95: number | null; max: number | null; over_50_ms: number }
export interface RunReport {
  id: string; cards: number; scenario: Scenario; repetition: number; validity: Verdict; reasons: string[]
  counts: { scheduled: number; sent: number; delivered: number; no_op: number }; backpressured: boolean; visibility_median: number | null
  frame_interval_ms: Statistics; input_to_frame_proxy_ms: Statistics; input_to_frame_raw_ms: Statistics
}
export interface ScenarioReport {
  scenario: Scenario; verdict: Verdict; reasons: string[]; valid_runs: number
  frame_interval_ms: Statistics; input_to_frame_proxy_ms: Statistics; input_to_frame_raw_ms: Statistics
}
export interface BenchmarkReport {
  schema: 'gurow-p1-report-v4'; synthetic: boolean
  identity: CaptureManifest['identity']; environment: CaptureManifest['environment']
  fixture: FixtureRecord; runs: RunReport[]; scenarios: ScenarioReport[]
  functional: { verdict: Verdict; assertions: FunctionalAssertion[]; reasons: string[] }
  diagnostics: DiagnosticRecord; comparisons: { cards: number; verdict: Verdict; runs: RunReport[]; reasons: string[] }[]
  artifacts: Artifact[]; metrics: { verdict: Verdict; reasons: string[] }
  limitations: string[]
  gate: { criteria: Record<'AC1' | 'AC2' | 'AC3' | 'AC4' | 'AC5', Verdict>; verdict: Verdict; reasons: string[]; required_follow_up: string[] }
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const good = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
const text = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0
const hex = (s: unknown) => typeof s === 'string' && /^[a-f0-9]{64}$/i.test(s)
const status = (reasons: string[]): Verdict => reasons.length ? 'NOT_MEASURED' : 'PASS'
export function combineVerdicts(verdicts: Verdict[]): Verdict {
  return verdicts.includes('FAIL') ? 'FAIL' : verdicts.includes('NOT_MEASURED') ? 'NOT_MEASURED' : 'PASS'
}
export { nearestRank }
export function stats(values: number[], duration_seconds: number): Statistics {
  return { unit: 'ms', n: values.length, duration_seconds, p50: nearestRank(values, .5), p95: nearestRank(values, .95),
    max: values.length ? Math.max(...values) : null, over_50_ms: values.filter(v => v > 50).length }
}
/** No artifact may escape the manifest directory, even through a symlink. */
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
    } catch { errors.push(`Artifact missing/unreadable: ${a.path}`) }
  }
  return errors
}
/** Hashed files must contain the records actually reduced, not unrelated bytes. */
export function verifyArtifactBindings(m: CaptureManifest, directory: string): string[] {
  if (m.synthetic) return []
  const errors: string[] = []
  const artifactErrors = verifyArtifacts(m.artifacts, directory)
  if (artifactErrors.length) return artifactErrors
  for (const [role, file, value] of [['raw-input-frame-log', 'runs.json', m.runs], ['functional-log', 'functional.json', m.functional]] as const) {
    const a = m.artifacts?.find(x => x.role === role && x.path === file)
    if (!a) { errors.push(`Missing ${role} artifact.`); continue }
    try {
      if (JSON.stringify(JSON.parse(readFileSync(resolve(directory, a.path), 'utf8'))) !== JSON.stringify(value)) errors.push(`${role} content differs from manifest records.`)
    } catch { errors.push(`${role} is not readable JSON.`) }
  }
  const contractPath = approvedPath(m.identity?.contract_id)
  if (!contractPath) return [...errors, `Contract ${m.identity?.contract_id} is not an approved protocol.`]
  const contract = loadBenchmarkContract(contractPath)
  for (const f of [m.fixture, ...(m.comparison_fixtures ?? [])]) {
    if (!f) continue
    const prefix = f === m.fixture ? 'primary-fixture' : 'comparison-fixture'
    const manifestArtifact = m.artifacts?.find(a => a.role === `${prefix}-manifest` && a.path === f.manifest_path)
    const checkpointArtifact = m.artifacts?.find(a => a.role === `${prefix}-checkpoint` && a.path === f.checkpoint_path)
    if (!manifestArtifact || !checkpointArtifact) { errors.push(`Fixture ${f.cards} manifest/checkpoint artifact missing.`); continue }
    try {
      const record = JSON.parse(readFileSync(resolve(directory, f.manifest_path), 'utf8')) as FixtureManifest
      const checkpoint = JSON.parse(readFileSync(resolve(directory, f.checkpoint_path), 'utf8'))
      const expected = generateBenchmarkFixture(contract, f.cards, { canvasCss: record.geometry.canvas_css, savedAt: record.saved_at })
      if (record.contract_id !== m.identity.contract_id || f.hash !== record.checkpoint_hash || f.connections !== record.connection_count ||
        JSON.stringify(f.geometry) !== JSON.stringify(record.geometry) || computeCheckpointHash(checkpoint) !== f.hash ||
        JSON.stringify(record) !== JSON.stringify(expected.manifest) || JSON.stringify(checkpoint) !== JSON.stringify(expected.checkpoint))
        errors.push(`Fixture ${f.cards} geometry/checkpoint does not match contracted layout.`)
    } catch { errors.push(`Fixture ${f.cards} manifest/checkpoint unreadable or invalid.`) }
  }
  return errors
}
const REQUIRED_FUNCTIONAL = ['create_select', 'pan_zoom_drag', 'connection_cycle_rejection', 'task_edit', 'undo_redo', 'reload', 'keyboard_list_no_webgpu', 'device_loss_recovery_retry'] as const
function reduceRun(r: CaptureRun, m: CaptureManifest, p: Protocol): RunReport {
  const reasons: string[] = [...(Array.isArray(r.invalid_reasons) ? r.invalid_reasons : ['Invalidation record missing.'])]
  const fixture = r.cards === p.primary.cards ? m.fixture : m.comparison_fixtures?.find(f => f.cards === r.cards)
  if (!fixture || fixture.hash !== r.fixture_hash || fixture.cards !== r.cards || !fixture.task_association_verified) reasons.push('Fixture identity mismatch.')
  if (r.source_fingerprint !== m.identity.source_fingerprint) reasons.push('Run source identity mismatch.')
  if (!p.scenarios.includes(r.scenario) || !Number.isInteger(r.repetition) || r.repetition < 1 || r.repetition > (r.cards === p.primary.cards ? p.sampling.runs_per_scenario : p.comparisons.find(c => c.cards === r.cards)?.runs_per_scenario ?? 0)) reasons.push('Run scenario/repetition invalid.')
  if (r.warmup_seconds !== p.sampling.warmup_seconds || r.active_seconds !== p.sampling.active_seconds || !good(r.drain_seconds) || r.drain_seconds > p.sampling.drain_seconds) reasons.push('Run duration invalid.')
  const scheduled = p.sampling.active_seconds * p.sampling.input_hz
  if (r.no_op_inputs !== undefined && (!Number.isInteger(r.no_op_inputs) || r.no_op_inputs < 0)) reasons.push('No-op input count invalid.')
  if (r.scheduled !== scheduled || !Number.isInteger(r.sent) || r.sent < 0 || r.sent > scheduled || r.sent / scheduled < p.sampling.minimum_sent_fraction) reasons.push('Sender delivered below the minimum fraction of the schedule, or schedule invalid.')
  if (!Number.isInteger(r.delivered) || r.delivered < 0 || r.delivered > r.sent) reasons.push('Page-delivered input count invalid.')
  const backpressured = Number.isInteger(r.delivered) && r.delivered / scheduled < p.sampling.minimum_delivered_fraction
  if (r.tab_visible !== true || r.tab_focused !== true || r.device_lost !== false || !Array.isArray(r.page_errors) || r.page_errors.length || r.delays_enabled !== false) reasons.push('Focus/visibility/device/page error or delay injection during run.')
  for (const name of ['frame_interval_ms', 'input_to_frame_proxy_ms', 'input_to_frame_raw_ms'] as const) if (!Array.isArray(r[name]) || !r[name].every(good)) reasons.push(`Invalid ${name} samples.`)
  // Coalesced pointer events retain their own timestamps, so there may be more
  // latency observations than delivered driver events. Never silently accept an
  // empty run or discard observations to fit the driver count.
  if (!Array.isArray(r.input_to_frame_proxy_ms) || !Array.isArray(r.input_to_frame_raw_ms) ||
    !r.input_to_frame_proxy_ms.length || r.input_to_frame_proxy_ms.length !== r.input_to_frame_raw_ms.length) reasons.push('Input sample/raw accounting mismatch.')
  if (!m.synthetic) {
    const originals = r.captured_input_ids, samples = r.captured_sample_ids
    if (!Array.isArray(originals) || !Array.isArray(samples) ||
      // No-op inputs count as delivered but have no latency observation.
      originals.length < r.delivered - (r.no_op_inputs ?? 0) || samples.length !== originals.length ||
      samples.length !== r.input_to_frame_proxy_ms?.length ||
      new Set(originals).size !== originals.length || new Set(samples).size !== samples.length ||
      originals.some((id, i) => !text(id) || id !== samples[i]))
      reasons.push('Per-original input IDs or latency observations missing/duplicated.')
  }
  const refresh = 1000 / m.environment.display_refresh_hz
  if (!good(refresh) || !Number.isFinite(refresh) || (r.input_to_frame_raw_ms ?? []).some((v, i) => Math.abs((r.input_to_frame_proxy_ms?.[i] ?? NaN) - v - refresh) > 1e-6)) reasons.push('Proxy does not equal raw input latency plus one refresh interval.')
  if (!Array.isArray(r.visibility) || !r.visibility.length || r.visibility.some(v => !good(v.time_ms) || !Number.isInteger(v.visible_cards) || v.visible_cards < 0 || v.visible_cards > r.cards || !Number.isInteger(v.dom_labels) || v.dom_labels < 0 || !Number.isInteger(v.submitted_primitives) || v.submitted_primitives < 0)) reasons.push('Visibility samples missing or invalid.')
  const visible = (r.visibility ?? []).map(v => v.visible_cards)
  const median = nearestRank(visible, .5)
  if (r.cards === p.primary.cards && (median === null || median < p.primary.visible_cards_median_min || median > p.primary.visible_cards_median_max)) reasons.push('Median visible cards outside primary band.')
  const count = 1 + p.sampling.active_seconds * p.sampling.visibility_sample_hz
  if (visible.length < count) reasons.push('Insufficient 2 Hz visibility samples including run start.')
  return { id: r.id, cards: r.cards, scenario: r.scenario, repetition: r.repetition, validity: status(reasons), reasons: [...new Set(reasons)],
    counts: { scheduled: r.scheduled, sent: r.sent, delivered: r.delivered, no_op: r.no_op_inputs ?? 0 }, backpressured, visibility_median: median,
    frame_interval_ms: stats(Array.isArray(r.frame_interval_ms) ? r.frame_interval_ms : [], r.active_seconds),
    input_to_frame_proxy_ms: stats(Array.isArray(r.input_to_frame_proxy_ms) ? r.input_to_frame_proxy_ms : [], r.active_seconds),
    input_to_frame_raw_ms: stats(Array.isArray(r.input_to_frame_raw_ms) ? r.input_to_frame_raw_ms : [], r.active_seconds) }
}
export function reduceReport(m: CaptureManifest, p: Protocol, contractBytes: Uint8Array, artifactErrors: string[] = []): BenchmarkReport {
  const structural = [...artifactErrors]
  const approvedFile = approvedPath(p.contract_id)
  const approved = approvedFile ? readFileSync(approvedFile) : new Uint8Array()
  if (!approvedFile || hash(contractBytes) !== hash(approved) || JSON.stringify(p) !== JSON.stringify(JSON.parse(new TextDecoder().decode(contractBytes))) ||
    m.schema !== 'gurow-p1-capture-manifest-v4' || p.report_schema !== 'gurow-p1-report-v4' || p.percentile !== 'nearest_rank_ceil') structural.push('Contract/manifest schema or approved v2 policy mismatched; v1 evidence is historical only.')
  if (typeof m.synthetic !== 'boolean' || m.identity?.contract_id !== p.contract_id || m.identity?.contract_sha256 !== hash(contractBytes) ||
    m.identity?.parent_issue !== p.parent_issue || !text(m.identity?.commit) || !hex(m.identity?.source_fingerprint) || !hex(m.identity?.build_hash) ||
    !text(m.identity?.runner_version) || !text(m.identity?.timestamp)) structural.push('Contract/source/build/runner identity invalid.')
  const env = m.environment
  if (!env || !text(env.cpu) || !good(env.physical_memory_bytes) || !text(env.os) || !text(env.kernel) || !text(env.compositor) ||
    !text(env.cpu_governor) || !text(env.browser_executable) || !text(env.browser_version) || !Array.isArray(env.browser_flags) ||
    !text(env.gpu_adapter) || isSoftwareAdapter(env.gpu_adapter ?? '') || !text(env.gpu_driver) || env.hardware_gpu !== true || !good(env.display_refresh_hz) ||
    !good(env.window_inner_size?.width) || !good(env.window_inner_size?.height) || !good(env.device_pixel_ratio) ||
    !good(env.canvas_css?.width) || env.canvas_css.width < p.minimum_canvas_css.width || !good(env.canvas_css?.height) || env.canvas_css.height < p.minimum_canvas_css.height ||
    !good(env.canvas_backing?.width) || !good(env.canvas_backing?.height) || env.browser_zoom_percent !== p.browser_zoom_percent ||
    !env.ac_power_online || !env.dedicated_profile || !env.production_build || !env.headed || !env.canvas_unobscured || !Array.isArray(env.interruptions) || env.interruptions.length) structural.push('Headed hardware environment/geometry incomplete or interrupted.')
  if (!m.fixture || m.fixture.cards !== p.primary.cards || m.fixture.connections !== p.primary.connections || !hex(m.fixture.hash) || !m.fixture.task_association_verified) structural.push('Primary fixture invalid.')
  if (!m.synthetic) for (const role of ['raw-input-frame-log', 'functional-log', 'production-build', 'primary-fixture-manifest', 'primary-fixture-checkpoint']) if (!m.artifacts?.some(a => a.role === role)) structural.push(`Missing required ${role} artifact.`)
  const runs = (m.runs ?? []).map(r => reduceRun(r, m, p))
  const keys = new Set<string>(), metricReasons = [...structural]
  for (const r of runs) { const key = `${r.cards}/${r.scenario}/${r.repetition}`; if (keys.has(key)) metricReasons.push(`Duplicate run ${key}`); keys.add(key) }
  const scenarios = p.scenarios.map(scenario => {
    const own = runs.filter(r => r.cards === p.primary.cards && r.scenario === scenario)
    const valid = own.filter(r => r.validity === 'PASS')
    const reasons: string[] = []
    for (let i = 1; i <= p.sampling.runs_per_scenario; i++) if (!own.some(r => r.repetition === i && r.validity === 'PASS')) reasons.push(`Missing or invalid primary ${scenario} run ${i}`)
    const pooled = (name: 'frame_interval_ms' | 'input_to_frame_proxy_ms' | 'input_to_frame_raw_ms') => valid.flatMap(r => (m.runs ?? []).find(source => source.id === r.id)?.[name] ?? [])
    const frames = pooled('frame_interval_ms'), proxy = pooled('input_to_frame_proxy_ms')
    if (frames.length < p.sampling.minimum_pooled_frame_intervals) reasons.push(`Insufficient pooled ${scenario} frame intervals.`)
    if (proxy.length < p.sampling.minimum_pooled_latency_samples) reasons.push(`Insufficient pooled ${scenario} latency samples.`)
    const frameStats = stats(frames, valid.reduce((total, r) => total + r.frame_interval_ms.duration_seconds, 0))
    const proxyStats = stats(proxy, valid.reduce((total, r) => total + r.input_to_frame_proxy_ms.duration_seconds, 0))
    const rawStats = stats(pooled('input_to_frame_raw_ms'), proxyStats.duration_seconds)
    const overLimit = frameStats.p95! > p.thresholds_ms.frame_p95 || proxyStats.p95! > p.thresholds_ms.input_to_frame_proxy_p95
    // An app that held back input cannot pass on the inputs it let through.
    if (!reasons.length && !overLimit && valid.some(r => r.backpressured)) reasons.push(`${scenario} page delivery fell below the minimum under backpressure; the run can fail but not pass.`)
    const verdict: Verdict = reasons.length ? 'NOT_MEASURED' : overLimit ? 'FAIL' : 'PASS'
    return { scenario, verdict, reasons, valid_runs: valid.length, frame_interval_ms: frameStats, input_to_frame_proxy_ms: proxyStats, input_to_frame_raw_ms: rawStats }
  })
  metricReasons.push(...scenarios.flatMap(s => s.reasons))
  const metricsVerdict = combineVerdicts([status(metricReasons), ...scenarios.map(s => s.verdict)])
  const functionalReasons = REQUIRED_FUNCTIONAL.filter(id => !m.functional?.some(f => f.id === id)).map(id => `Missing functional ${id}`)
  for (const f of m.functional ?? []) if (!text(f.action) || !text(f.assertion) || !text(f.command_or_log) || f.source_fingerprint !== m.identity.source_fingerprint || !['PASS','FAIL','NOT_MEASURED'].includes(f.result) || (f.result !== 'PASS' && !text(f.reason))) functionalReasons.push(`Invalid functional assertion ${f.id}`)
  const functionalVerdict = combineVerdicts([status(functionalReasons), ...(m.functional ?? []).map(f => f.result)])
  const comparisonReasons: string[] = []
  const comparisons = p.comparisons.map(c => {
    const fixture = m.comparison_fixtures?.filter(f => f.cards === c.cards) ?? []
    const subset = runs.filter(r => r.cards === c.cards), reasons: string[] = []
    if (fixture.length !== 1 || fixture[0].connections !== c.connections || !hex(fixture[0].hash)) reasons.push(`Comparison fixture ${c.cards} missing/invalid.`)
    for (const s of p.scenarios) for (let i = 1; i <= c.runs_per_scenario; i++) if (!subset.some(r => r.scenario === s && r.repetition === i && r.validity === 'PASS')) reasons.push(`Missing or invalid comparison ${c.cards}/${s}/${i}`)
    comparisonReasons.push(...reasons)
    return { cards: c.cards, verdict: status(reasons), runs: subset, reasons }
  })
  const diagnosticReasons: string[] = []
  const names = ['initialization_to_first_render_ms','process_rss_bytes','js_heap_bytes','wasm_memory_bytes','draw_calls','upload_bytes','json_boundary_calls','json_boundary_bytes','json_boundary_duration_ms'] as const
  for (const name of names) { const c = m.diagnostics?.[name]; if (!c || !text(c.unit) || (c.value === null ? !text(c.reason) : !good(c.value))) diagnosticReasons.push(`Diagnostic ${name} requires a value or null + reason.`) }
  const sanity = m.sanity_checks
  if (!sanity || !good(sanity.application_update_p50_shift_ms) || !good(sanity.label_commit_p50_shift_ms) || sanity.application_update_p50_shift_ms < p.sanity_check.minimum_p50_shift_ms || sanity.label_commit_p50_shift_ms < p.sanity_check.minimum_p50_shift_ms) structural.push('Application/label delay sanity checks incomplete or below required shift.')
  const criteria = { AC1: functionalVerdict, AC2: metricsVerdict, AC3: status(structural), AC4: status([...diagnosticReasons, ...comparisonReasons]), AC5: status([...structural, ...metricReasons]) }
  const verdict = m.synthetic ? 'NOT_MEASURED' : combineVerdicts(Object.values(criteria))
  const reasons = [...new Set([...structural, ...metricReasons, ...functionalReasons, ...comparisonReasons, ...diagnosticReasons, ...scenarios.filter(s => s.verdict === 'FAIL').map(s => `${s.scenario} pooled p95 exceeds threshold.`), ...(m.synthetic ? ['Synthetic evidence cannot satisfy a real gate.'] : [])])]
  return { schema: 'gurow-p1-report-v4', synthetic: m.synthetic, identity: m.identity, environment: m.environment, fixture: m.fixture, runs, scenarios,
    functional: { verdict: functionalVerdict, assertions: m.functional ?? [], reasons: functionalReasons }, diagnostics: m.diagnostics, comparisons,
    artifacts: m.artifacts ?? [], metrics: { verdict: metricsVerdict, reasons: metricReasons },
    limitations: ['input_to_frame_proxy_ms covers input queueing, application, renderer submission and HTML label commit on the main thread; the added refresh interval estimates presentation. It does not observe compositor output, scanout or physical pixels.'],
    gate: { criteria, verdict, reasons, required_follow_up: verdict === 'PASS' ? [] : reasons.length ? reasons : ['Investigate failing metric or functional assertion.'] } }
}
export function gateExitCode(report: BenchmarkReport): 0 | 1 | 2 {
  if (report.synthetic) return 2
  return report.gate.verdict === 'PASS' ? 0 : report.gate.verdict === 'FAIL' ? 1 : 2
}
export function markdownReport(r: BenchmarkReport): string {
  const fmt = (s: Statistics) => `${s.n} / ${s.duration_seconds} / ${s.p50 ?? '—'} / ${s.p95 ?? '—'} / ${s.max ?? '—'}`
  const lines = [`# P1 report — ${r.gate.verdict}${r.synthetic ? ' (SYNTHETIC — NOT P1 EVIDENCE)' : ''}`, '', `Contract: ${r.identity.contract_id} (${r.identity.contract_sha256})`, `Source: ${r.identity.commit} / ${r.identity.source_fingerprint}`, '', ...r.limitations.map(l => `Limitation: ${l}`), '', `Functional: **${r.functional.verdict}** · Metrics: **${r.metrics.verdict}** · Gate: **${r.gate.verdict}**`, '', '## Gate criteria', ...Object.entries(r.gate.criteria).map(([k,v]) => `- ${k}: ${v}`), '', '## Pooled scenarios', '| Scenario | Verdict | Valid runs | Frame n / s / p50 / p95 / max (ms) | Proxy n / s / p50 / p95 / max (ms) | Raw input n / s / p50 / p95 / max (ms) |', '|---|---|---:|---|---|---|']
  for (const s of r.scenarios) lines.push(`| ${s.scenario} | ${s.verdict} | ${s.valid_runs} | ${fmt(s.frame_interval_ms)} | ${fmt(s.input_to_frame_proxy_ms)} | ${fmt(s.input_to_frame_raw_ms)} |`)
  lines.push('', '## Runs (p95 per run is reported, not gated)', '| Run | Scenario | Validity | Page / sent / scheduled | Visible median | Frame n / s / p50 / p95 / max (ms) | Proxy n / s / p50 / p95 / max (ms) |', '|---|---|---|---:|---:|---|---|')
  for (const run of r.runs) lines.push(`| ${run.id} | ${run.scenario} | ${run.validity} | ${run.counts.delivered} / ${run.counts.sent} / ${run.counts.scheduled} (no-op ${run.counts.no_op}${run.backpressured ? ', backpressure' : ''}) | ${run.visibility_median ?? '—'} | ${fmt(run.frame_interval_ms)} | ${fmt(run.input_to_frame_proxy_ms)} |`)
  lines.push('', '## Functional', ...r.functional.assertions.map(a => `- ${a.id}: ${a.result} — ${a.action}; ${a.assertion} (${a.command_or_log})`), '', '## Comparisons (no primary thresholds)', ...r.comparisons.map(c => `- ${c.cards}: ${c.verdict}${c.reasons.length ? ' — ' + c.reasons.join('; ') : ''}`), '', '## Diagnostic limitations', ...Object.entries(r.diagnostics ?? {}).filter(([,v]) => v && typeof v === 'object' && 'value' in v && v.value === null).map(([k,v]) => `- ${k}: ${(v as OptionalCounter).reason}`), ...(r.diagnostics?.limitations ?? []).map(x => `- ${x}`), '', '## Raw artifacts (SHA-256)', ...r.artifacts.map(a => `- ${a.role}: ${a.path} — ${a.sha256}`), '', '## Reasons / follow-up', ...(r.gate.required_follow_up.length ? r.gate.required_follow_up.map(x => `- ${x}`) : ['- None']), '')
  return lines.join('\n')
}
