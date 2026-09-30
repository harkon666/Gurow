import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { generateBenchmarkFixture, parseBenchmarkContract } from './fixture'
import { gateExitCode, markdownReport, nearestRank, reduceReport, verifyArtifactBindings, verifyArtifacts, type CaptureManifest, type CaptureRun, type Protocol } from './report'
import { runCli } from './report-cli'

// Entire example is SYNTHETIC: no observed hardware or P1 acceptance result.
const contract = readFileSync(resolve(import.meta.dir, '../../../docs/benchmarks/p1/protocol-v4.json'))
const p = JSON.parse(contract.toString()) as Protocol
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const F = 'b'.repeat(64)
const sample = (cards: number) => Array.from({ length: 61 }, (_, i) => ({ time_ms: 10000 + i * 500, visible_cards: cards === 100 ? 100 : 200, dom_labels: cards === 100 ? 100 : 200, submitted_primitives: 300 }))
const fixture = (cards: 100 | 1000 | 10000) => {
  const generated = generateBenchmarkFixture(parseBenchmarkContract(contract.toString()), cards, { canvasCss: { width: 1000, height: 600 } })
  return { cards, connections: cards * 2, hash: generated.manifest.checkpoint_hash, geometry: generated.manifest.geometry,
    manifest_path: `manifest-${cards}.json`, checkpoint_path: `checkpoint-${cards}.json`, task_association_verified: true }
}
const fixtures = { 100: fixture(100), 1000: fixture(1000), 10000: fixture(10000) }
function run(cards: 100 | 1000 | 10000, scenario: 'pan' | 'zoom' | 'drag', repetition: number): CaptureRun {
  const raw = Array(1200).fill(40 - 1000 / 165)
  return { id: `${cards}-${scenario}-${repetition}`, cards, scenario, repetition, source_fingerprint: F, fixture_hash: fixtures[cards].hash,
    warmup_seconds: 10, active_seconds: 30, drain_seconds: 2, scheduled: 3600, sent: 3600, delivered: 3600, invalid_reasons: [],
    frame_interval_ms: Array(1200).fill(20), input_to_frame_proxy_ms: raw.map(v => v + 1000 / 165), input_to_frame_raw_ms: raw,
    visibility: sample(cards), tab_visible: true, tab_focused: true, device_lost: false, page_errors: [], delays_enabled: false }
}
const ids = ['create_select','pan_zoom_drag','connection_cycle_rejection','task_edit','undo_redo','reload','keyboard_list_no_webgpu','device_loss_recovery_retry']
function manifest(): CaptureManifest {
  const counter = (value: number | null, reason: string | null = null) => ({ value, unit: 'synthetic', reason })
  return { schema: 'gurow-p1-capture-manifest-v4', synthetic: true,
    identity: { contract_id: p.contract_id, contract_sha256: sha(contract), parent_issue: 7, commit: 'synthetic', tree_dirty: false, source_fingerprint: F, build_hash: 'a'.repeat(64), timestamp: 'synthetic', runner_version: 'synthetic-1' },
    environment: { cpu: 'synthetic cpu', physical_memory_bytes: 1000000000, os: 'synthetic os', kernel: 'synthetic kernel', compositor: 'synthetic compositor', cpu_governor: 'powersave', browser_executable: 'synthetic/chromium', browser_version: '152', browser_flags: [], gpu_adapter: 'synthetic hardware', gpu_driver: 'synthetic driver', hardware_gpu: true, display_refresh_hz: 165, window_inner_size: { width: 1400, height: 900 }, device_pixel_ratio: 1.5, canvas_css: { width: 1000, height: 600 }, canvas_backing: { width: 1500, height: 900 }, browser_zoom_percent: 100, ac_power_online: true, dedicated_profile: true, production_build: true, headed: true, canvas_unobscured: true, interruptions: [] },
    fixture: fixtures[1000], comparison_fixtures: [fixtures[100], fixtures[10000]],
    runs: ([100,1000,10000] as const).flatMap(cards => (['pan','zoom','drag'] as const).flatMap(s => Array.from({ length: cards === 1000 ? 3 : 1 }, (_, i) => run(cards,s,i+1)))),
    functional: ids.map(id => ({ id, action: id, assertion: 'synthetic', command_or_log: 'synthetic.log', source_fingerprint: F, result: 'PASS', reason: null })),
    diagnostics: { initialization_to_first_render_ms: counter(1), process_rss_bytes: counter(1), js_heap_bytes: counter(null, 'not recorded'), wasm_memory_bytes: counter(null, 'not recorded'), draw_calls: counter(1), upload_bytes: counter(1), json_boundary_calls: counter(1), json_boundary_bytes: counter(1), json_boundary_duration_ms: counter(1), limitations: ['SYNTHETIC'] },
    sanity_checks: { application_update_p50_shift_ms: 65, label_commit_p50_shift_ms: 70 },
    artifacts: [{ path: 'report.test.ts', sha256: sha(readFileSync(import.meta.filename)), role: 'synthetic-source' }] }
}
const reduce = (m: CaptureManifest) => reduceReport(m,p,contract)
const target = (m: CaptureManifest, scenario = 'drag') => m.runs.find(r => r.cards === 1000 && r.scenario === scenario && r.repetition === 2)!
describe('P1 report-v4 SYNTHETIC reducer', () => {
  it('uses nearest rank, exact thresholds, pooled scenarios and an explicit proxy limitation', () => {
    expect(nearestRank([1,2,3,4,5,6,7,8,9,10], .95)).toBe(10)
    const r = reduce(manifest())
    expect(r.schema).toBe('gurow-p1-report-v4')
    expect(r.scenarios).toHaveLength(3)
    expect(r.scenarios.every(s => s.verdict === 'PASS')).toBe(true)
    expect(r.scenarios[0].frame_interval_ms).toMatchObject({ n: 3600, p50: 20, p95: 20, max: 20, duration_seconds: 90 })
    expect(r.scenarios[0].input_to_frame_proxy_ms).toMatchObject({ n: 3600, p95: 40 })
    expect(r.runs.find(x => x.id === '1000-pan-1')?.frame_interval_ms).toMatchObject({ n: 1200, p95: 20, duration_seconds: 30 })
    expect(r.metrics.verdict).toBe('PASS')
    expect(r.gate.verdict).toBe('NOT_MEASURED'); expect(gateExitCode(r)).toBe(2)
    expect(markdownReport(r)).toContain('does not observe compositor output, scanout or physical pixels')
    expect(verifyArtifacts(r.artifacts, import.meta.dir)).toEqual([])
  })
  it('gates pooled nearest-rank p95, not the worst per-run p95; each scenario is separate', () => {
    const m = manifest(), slow = target(m)
    // 181 of 3600 pooled frame intervals cross rank 3420, while 180 do not.
    slow.frame_interval_ms.fill(21, 0, 180)
    expect(reduce(m).scenarios.find(s => s.scenario === 'drag')?.verdict).toBe('PASS')
    slow.frame_interval_ms[180] = 21
    const r = reduce(m)
    expect(r.scenarios.find(s => s.scenario === 'drag')?.verdict).toBe('FAIL')
    expect(r.scenarios.find(s => s.scenario === 'pan')?.verdict).toBe('PASS')
    expect(r.gate.criteria.AC2).toBe('FAIL')
    expect(r.runs.find(x => x.id === slow.id)?.validity).toBe('PASS')
    expect(r.comparisons.every(c => c.verdict === 'PASS')).toBe(true)
    slow.frame_interval_ms.fill(20)
    slow.input_to_frame_proxy_ms.fill(50 + 1e-7, 0, 181)
    slow.input_to_frame_raw_ms.fill(50 + 1e-7 - 1000 / 165, 0, 181)
    expect(reduce(m).scenarios.find(s => s.scenario === 'drag')?.verdict).toBe('FAIL')
  })
  it('rejects SwiftShader even when a fallback flag claims hardware', () => {
    const m = manifest()
    m.environment.gpu_adapter = '{"vendor":"google","architecture":"swiftshader","fallback":false}'
    m.environment.hardware_gpu = true
    expect(reduce(m).gate.criteria.AC3).toBe('NOT_MEASURED')
  })

  it('refuses non-synthetic runs that omit delivered original input observations', () => {
    const m = manifest()
    m.synthetic = false
    const r = target(m)
    r.captured_input_ids = Array.from({ length: 3600 }, (_, i) => `input-${i}`)
    r.captured_sample_ids = r.captured_input_ids.slice(0, 1200)
    expect(reduce(m).runs.find(result => result.id === r.id)?.reasons.join(' '))
      .toContain('Per-original input IDs or latency observations missing')
  })

  it('invalid sending, visibility median, loss/focus/errors and disabled delays are required', () => {
    const m = manifest(), r = target(m)
    r.sent = 2879; r.delivered = 2879
    expect(reduce(m).runs.find(x => x.id === r.id)?.reasons.join(' ')).toContain('Sender delivered below the minimum')
    r.sent = 2880; r.delivered = 2881
    expect(reduce(m).runs.find(x => x.id === r.id)?.reasons.join(' ')).toContain('Page-delivered input count invalid')
    r.sent = 3600; r.delivered = 3600
    r.visibility.forEach((v, i) => { if (i < 31) v.visible_cards = 251 })
    expect(reduce(m).runs.find(x => x.id === r.id)?.reasons.join(' ')).toContain('Median visible cards')
    r.visibility.forEach(v => { v.visible_cards = 200 })
    r.tab_focused = false; r.page_errors.push('test error'); r.device_lost = true; r.delays_enabled = true
    expect(reduce(m).runs.find(x => x.id === r.id)?.validity).toBe('NOT_MEASURED')
    expect(reduce(m).scenarios.find(s => s.scenario === 'drag')?.verdict).toBe('NOT_MEASURED')
  })
  it('counts no-op inputs as delivered without requiring a latency observation for them', () => {
    const m = manifest(), r = target(m)
    // Real (non-synthetic) accounting: 3,585 observed inputs plus 15 zero-travel no-ops.
    m.synthetic = false
    r.no_op_inputs = 15
    r.input_to_frame_raw_ms = Array(3585).fill(40 - 1000 / 165); r.input_to_frame_proxy_ms = r.input_to_frame_raw_ms.map(v => v + 1000 / 165)
    r.captured_input_ids = r.input_to_frame_raw_ms.map((_, i) => `input-${i}`); r.captured_sample_ids = [...r.captured_input_ids]
    const reasons = reduce(m).runs.find(x => x.id === r.id)!.reasons.join(' ')
    expect(reasons).not.toContain('Per-original input IDs')
    r.no_op_inputs = 0
    expect(reduce(m).runs.find(x => x.id === r.id)!.reasons.join(' ')).toContain('Per-original input IDs')
  })
  it('keeps a backpressured run valid: it can fail but never pass', () => {
    const m = manifest(), r = target(m)
    r.delivered = 900
    const run = reduce(m).runs.find(x => x.id === r.id)!
    expect([run.validity, run.backpressured]).toEqual(['PASS', true])
    const drag = reduce(m).scenarios.find(s => s.scenario === 'drag')!
    expect(drag.verdict).toBe('NOT_MEASURED')
    expect(drag.reasons.join(' ')).toContain('can fail but not pass')
    r.frame_interval_ms = Array(1200).fill(48)
    expect(reduce(m).scenarios.find(s => s.scenario === 'drag')?.verdict).toBe('FAIL')
  })
  it('requires every repetition and pooled sample minima; missing comparisons only affect AC4', () => {
    const m = manifest(); m.runs = m.runs.filter(r => r.id !== '1000-pan-3' && r.cards !== 10000)
    expect(reduce(m).scenarios.find(s => s.scenario === 'pan')?.reasons).toContain('Missing or invalid primary pan run 3')
    expect(reduce(m).gate.criteria.AC4).toBe('NOT_MEASURED')
    const n = manifest(); n.runs.filter(r => r.cards === 1000 && r.scenario === 'zoom').forEach(r => { r.frame_interval_ms = Array(333).fill(20); r.input_to_frame_raw_ms = Array(333).fill(40 - 1000 / 165); r.input_to_frame_proxy_ms = Array(333).fill(40) })
    expect(reduce(n).scenarios.find(s => s.scenario === 'zoom')?.reasons.join(' ')).toContain('Insufficient pooled')
    expect(reduce(n).scenarios.find(s => s.scenario === 'pan')?.verdict).toBe('PASS')
  })
  it('rejects v1 manifests, tampered protocol, inconsistent raw/proxy, bad sanity and missing diagnostics', () => {
    const m = manifest(); (m as {schema: string}).schema = 'gurow-p1-capture-manifest-v1'
    expect(reduce(m).gate.criteria.AC3).toBe('NOT_MEASURED')
    const n = manifest(), r = target(n)
    r.input_to_frame_raw_ms[0] = 0
    expect(reduce(n).runs.find(x => x.id === r.id)?.validity).toBe('NOT_MEASURED')
    r.input_to_frame_raw_ms = []
    r.input_to_frame_proxy_ms = []
    expect(reduce(n).runs.find(x => x.id === r.id)?.reasons.join(' ')).toContain('accounting mismatch')
    n.sanity_checks.label_commit_p50_shift_ms = 59
    n.diagnostics.js_heap_bytes.reason = null
    expect(reduce(n).gate.criteria.AC3).toBe('NOT_MEASURED')
    expect(reduce(n).gate.criteria.AC4).toBe('NOT_MEASURED')
    const altered = { ...p, thresholds_ms: { frame_p95: 200, input_to_frame_proxy_p95: 500 } }
    expect(reduceReport(manifest(), altered, Buffer.from(JSON.stringify(altered))).gate.criteria.AC3).toBe('NOT_MEASURED')
  })
  it('verifies raw log binding, fixture layout and missing/corrupt artifacts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gurow-v2-report-'))
    try {
      const m = manifest(); m.synthetic = false; m.artifacts = []
      for (const cards of [100,1000,10000] as const) {
        const f = fixtures[cards]
        const generated = generateBenchmarkFixture(parseBenchmarkContract(contract.toString()), cards, { canvasCss: f.geometry.canvas_css })
        for (const [file, record, role] of [[f.manifest_path, generated.manifest, `${cards === 1000 ? 'primary' : 'comparison'}-fixture-manifest`], [f.checkpoint_path, generated.checkpoint, `${cards === 1000 ? 'primary' : 'comparison'}-fixture-checkpoint`]] as const) {
          const bytes = Buffer.from(JSON.stringify(record)); writeFileSync(join(directory, file), bytes)
          m.artifacts.push({ path: file, role, sha256: sha(bytes) })
        }
      }
      for (const [role, file, record] of [['raw-input-frame-log', 'runs.json', m.runs], ['functional-log', 'functional.json', m.functional]] as const) {
        const bytes = Buffer.from(JSON.stringify(record)); writeFileSync(join(directory, file), bytes); m.artifacts.push({ role, path: file, sha256: sha(bytes) })
      }
      // Individual run files share a role with runs.json; the aggregate is
      // the artifact bound to the manifest's full runs array.
      const singleRun = Buffer.from(JSON.stringify(m.runs[0]))
      writeFileSync(join(directory, 'raw-1000-pan-1.json'), singleRun)
      m.artifacts.unshift({ role: 'raw-input-frame-log', path: 'raw-1000-pan-1.json', sha256: sha(singleRun) })
      expect(verifyArtifacts(m.artifacts, directory)).toEqual([])
      expect(verifyArtifactBindings(m, directory)).toEqual([])
      m.runs[0].delivered = 0
      expect(verifyArtifactBindings(m, directory).join(' ')).toContain('content differs')
      m.runs[0].delivered = 3600
      m.fixture.geometry.z0 += .1
      expect(verifyArtifactBindings(m, directory).join(' ')).toContain('geometry/checkpoint')
      expect(verifyArtifacts([{path:'../../../../etc/passwd', role:'raw-input-frame-log', sha256:'0'.repeat(64)}],directory).join(' ')).toContain('Invalid artifact')
      m.artifacts[0].sha256 = '0'.repeat(64)
      expect(verifyArtifacts(m.artifacts,directory).join(' ')).toContain('SHA-256 mismatch')
    } finally { rmSync(directory,{recursive:true,force:true}) }
  })
  it('CLI emits reproducible synthetic JSON/Markdown with missing-evidence exit code', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gurow-v2-cli-'))
    try {
      const m = manifest(), input = join(directory,'capture.json'), output = join(directory,'result')
      writeFileSync(join(directory,'proof.txt'),'synthetic')
      m.artifacts = [{role:'synthetic', path:'proof.txt', sha256:sha(readFileSync(join(directory,'proof.txt')))}]
      writeFileSync(input,JSON.stringify(m))
      expect(runCli(['--input',input,'--contract',resolve(import.meta.dir,'../../../docs/benchmarks/p1/protocol-v4.json'),'--out',output])).toBe(2)
      expect(JSON.parse(readFileSync(`${output}.json`,'utf8')).schema).toBe('gurow-p1-report-v4')
      expect(readFileSync(`${output}.md`,'utf8')).toContain('Pooled scenarios')
      m.artifacts[0].sha256='0'.repeat(64); writeFileSync(input,JSON.stringify(m))
      expect(runCli(['--input',input,'--contract',resolve(import.meta.dir,'../../../docs/benchmarks/p1/protocol-v4.json'),'--out',output])).toBe(2)
      expect(JSON.parse(readFileSync(`${output}.json`,'utf8')).gate.criteria.AC3).toBe('NOT_MEASURED')
    } finally { rmSync(directory,{recursive:true,force:true}) }
  })
})
