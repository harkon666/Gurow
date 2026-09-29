import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { computeProfileHash, GUROW_INPUT_COALESCING, type CollectorProfile } from './collector'
import { generateBenchmarkFixture } from './fixture'
import { gateExitCode, markdownReport, nearestRank, reduceReport, verifyArtifactBindings, verifyArtifacts, type BenchmarkReport, type CaptureManifest, type CaptureRun, type Protocol, type Verdict } from './report'
import { runCli } from './report-cli'

// Entire record is SYNTHETIC: no observed hardware, qualified collector, or P1 result.
const contract = readFileSync(resolve(import.meta.dir, '../../../docs/benchmarks/p1/protocol.json'))
const p = JSON.parse(contract.toString()) as Protocol
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const F = 'b'.repeat(64)
const ids = ['create_select','pan_zoom_drag','connection_cycle_rejection','task_edit','undo_redo','reload','keyboard_list_no_webgpu','device_loss_recovery_retry']
function profile(): CollectorProfile {
  const base: Omit<CollectorProfile, 'hash'> = {
    version: 'gurow-collector-v3', contract_id: p.contract_id, status: 'QUALIFIED', geometry_class: 'reference',
    identity: { commit: 'test-commit', tree_dirty: false, build_hash: 'a'.repeat(64), source_fingerprint: F },
    host: { cpu: 'SYNTHETIC cpu', logical_cpus: 20, physical_memory_bytes: 1e10, os: 'SYNTHETIC os', kernel: 'SYNTHETIC kernel', gpu_adapter: 'SYNTHETIC hardware', gpu_driver: 'SYNTHETIC driver', is_fallback: false, compositor: 'Hyprland 0.56.2', display_output: 'eDP-2', display_refresh_hz: 165, device_pixel_ratio: 1.5, viewport_css: [1200,720], browser_executable: '/synthetic/chromium', browser_version: '152.0.0', browser_backend: 'Wayland', browser_command_line: ['/synthetic/chromium'], canvas_geometry: { css_bounds: { x: 0,y: 0,width: 1200,height: 720 }, backing_size: {width: 1800,height:1080} }, native_window: { headed: true, device_metrics_emulated: false, x:0,y:0,width:1220,height:750,screen_width:1920,screen_height:1200,available_x:0,available_y:0,available_width:1920,available_height:1200,visual_viewport_scale:1,document_visible:true,focused:true,canvas_unobscured:true,labels_visible:true,skill_list_visible:true,task_panel_visible:true } },
    trace_configuration: {categories:['viz'],parser_version:'3.0.0',clock_origin:'chromium_trace_monotonic',clock_units:'us',timestamp_scale_to_ms:.001,clock_mapping:{ trace_clock:'chromium_trace_monotonic',page_clock:'performance_now_ms',trace_to_page_offset_ms:0,offset_spread_ms:0,sample_count:5,method:'SYNTHETIC' }},
    fault_injection: {enabled:false,app_delay_ms:0,label_delay_ms:0,app_delays_applied:0,label_delays_applied:0},input_coalescing:GUROW_INPUT_COALESCING,
  }
  return {...base,hash:computeProfileHash(base)}
}
function run(cards: 100 | 1000 | 10000, scenario: 'pan'|'zoom'|'drag', repetition: number): CaptureRun {
  const inputs = Array.from({length:3600},(_,i) => {
    const scheduled = 10000 + i * 1000 / 120
    const origin = Math.ceil(scheduled)
    return {id:`${cards}-${scenario}-${repetition}-${i}`,kind:scenario,scheduled_ms:scheduled,injection_ms:scheduled,origin_ms:origin,classification:'presented' as const,reason:null}
  })
  const members = Array.from({length:1500},() => [] as string[])
  for (const i of inputs) members[Math.floor((i.origin_ms! - 10000) / 20)]!.push(i.id)
  const groups = Array.from({length:1500},(_,j) => ({
    member_ids: members[j]!,
    frame_id:`f${j}`,presentation_ms:10050+j*20,provenance:'platform_presentation_feedback' as const,
    frame_link:'revision_matched' as const,app_revision:j,canvas_revision:j,label_revision:j,optical_latency:null,
  }))
  return {id:`${cards}-${scenario}-${repetition}`,cards,scenario,repetition,source_fingerprint:F,profile_hash:'',fixture_hash:'c'.repeat(64),acquisition:'chromium',clock:'chromium_trace_monotonic',units:'ms',warmup_seconds:10,active_seconds:30,drain_seconds:2,windows:{warmup_start_ms:0,active_start_ms:10000,active_end_ms:40000,drain_end_ms:42000},scheduled:3600,delivered:3600,invalid_reasons:[],visibility:{initial:cards===100?100:200,minimum:cards===100?100:190,maximum:cards===100?100:210,path_verified:true,labels_enabled:true,labels:{initial:cards===100?100:200,minimum:cards===100?100:190,maximum:cards===100?100:210},connections:{initial:cards===100?100:300,minimum:cards===100?100:290,maximum:cards===100?100:310}},inputs,
    groups,intervals:groups.map(g => ({frame_id:g.frame_id,previous_presentation_ms:g.presentation_ms-20,presentation_ms:g.presentation_ms,bounds:{lower_ms:20,upper_ms:20},censored:false,coherent:true})),optical_calibration:null}
}
function manifest(): CaptureManifest {
  const prof = profile()
  const runs = ([100,1000,10000] as const).flatMap(cards => (['pan','zoom','drag'] as const).flatMap(s => [1,2,3].map(rep => run(cards,s,rep))))
  for (const r of runs) {
    r.profile_hash = prof.hash
    r.fixture_hash = r.cards === 100 ? 'd'.repeat(64) : r.cards === 10000 ? 'e'.repeat(64) : 'c'.repeat(64)
  }
  const counter = (value: number | null, reason: string | null = null) => ({value,unit:'synthetic',reason})
  return {schema:'gurow-p1-capture-manifest-v1',synthetic:true,identity:{contract_id:p.contract_id,contract_sha256:sha(contract),parent_issue:7,commit:prof.identity.commit,tree_dirty:false,source_fingerprint:F,build_hash:prof.identity.build_hash,timestamp:'SYNTHETIC timestamp',runner_version:'synthetic-1',parser_version:'3.0.0',collector_version:prof.version,profile_hash:prof.hash},environment:{host:prof.host,ac_power_online:true,cpu_governor:'powersave',display_output:'eDP-2',compositor_scale:1.5,vrr:false,dedicated_profile:true,production_build:true,interruptions:[]},profile:prof,fixture:{hash:'c'.repeat(64),seed:'none-deterministic',algorithm_version:'gurow-grid-gap-v1',cards:1000,connections:2000,initial_visible_cards:200,camera_and_cell:{z0:.5,px:20,py:20,offset_x:0,offset_y:0},task_association_verified:true,manifest_path:'primary-manifest.json',checkpoint_path:'primary-checkpoint.json'},comparison_fixtures:[{cards:100,connections:200,hash:'d'.repeat(64),manifest_path:'comparison-100.json',checkpoint_path:'checkpoint-100.json'},{cards:10000,connections:20000,hash:'e'.repeat(64),manifest_path:'comparison-10000.json',checkpoint_path:'checkpoint-10000.json'}],runs,functional:ids.map(id => ({id,action:id,assertion:'synthetic',command_or_log:'synthetic-fixture.log',source_fingerprint:F,result:'PASS' as const,reason:null})),diagnostics:{initialization_to_first_coherent_render_ms:counter(1),browser_process_tree_rss_bytes:counter(1),js_heap_bytes:counter(null,'not recorded'),wasm_memory_bytes:counter(null,'not recorded'),gpu_memory_bytes:counter(null,'unsupported'),draw_calls:counter(1),upload_bytes:counter(1),json_boundary_calls:counter(1),json_boundary_bytes:counter(1),json_boundary_duration_ms:counter(1),limitations:['SYNTHETIC']},artifacts:[{path:'report.test.ts',sha256:sha(readFileSync(import.meta.filename)),role:'synthetic fixture source'}]}
}
const reduce = (m:CaptureManifest) => reduceReport(m,p,contract)
function retimeFrames(r: CaptureRun, duration: (index: number) => number): void {
  let previous = r.groups[0]!.presentation_ms! - 20
  for (const [index, interval] of r.intervals.entries()) {
    const next = previous + duration(index)
    interval.previous_presentation_ms = previous
    interval.presentation_ms = next
    interval.bounds = {lower_ms:next-previous,upper_ms:next-previous}
    r.groups[index]!.presentation_ms = next
    previous = next
  }
}
function opticalOnsets(r: CaptureRun, responseMin: number, responseMax: number): void {
  const byId=new Map(r.inputs.map(i=>[i.id,i]))
  for (const g of r.groups) {
    const oldest=Math.min(...g.member_ids.map(id=>byId.get(id)!.origin_ms!))
    g.provenance='optical_display';g.frame_link='optically_attributed'
    g.optical_onsets={input:{lower_ms:oldest,upper_ms:oldest+1},response:{lower_ms:oldest+responseMin,upper_ms:oldest+responseMax}}
    g.optical_latency={lower_ms:responseMin-1,upper_ms:responseMax}
    g.presentation_ms=oldest+responseMin
  }
  for (const [index,interval] of r.intervals.entries()) {
    const current=r.groups[index]!.optical_onsets!.response
    const previous=index===0 ? {lower_ms:current.lower_ms-20,upper_ms:current.upper_ms-20} : r.groups[index-1]!.optical_onsets!.response
    interval.optical_onsets={previous,current}
    interval.optical_frame={video_artifact:r.optical_calibration!.raw_video,capture_frame_index:index}
    interval.bounds={lower_ms:Math.max(0,current.lower_ms-previous.upper_ms),upper_ms:current.upper_ms-previous.lower_ms}
  }
}
describe('P1 report-v1 SYNTHETIC reducer', () => {
  it('nearest rank, exact threshold, every run and synthetic gate', () => {
    expect(nearestRank([1,2,3,4,5,6,7,8,9,10],.95)).toBe(10)
    const r = reduce(manifest())
    expect(r.metrics.verdict).toBe('PASS'); expect(r.functional.verdict).toBe('PASS')
    expect(r.runs.find(x => x.cards===1000)?.input_to_visible.upper).toMatchObject({n:3600,p50:46,p95:50,duration_seconds:30})
    expect(r.runs.find(x => x.cards===1000)?.input_to_visible.upper.max).toBeCloseTo(50,8)
    expect(r.runs.find(x => x.cards===1000)?.presented_editor_frame_interval.upper.p95).toBe(20)
    expect(r.gate.verdict).toBe('NOT_MEASURED'); expect(gateExitCode(r)).toBe(2)
    expect(markdownReport(r)).toContain('SYNTHETIC — NOT P1 EVIDENCE')
    expect(verifyArtifacts(r.artifacts,import.meta.dir)).toEqual([])
  })
  it('valid slow drag fails independently of other runs, and comparison slowness has no threshold', () => {
    const m=manifest()
    // 80 of 1,500 (>5%) coherent intervals are 21 ms; pair them with 19 ms intervals.
    retimeFrames(m.runs.find(r=>r.cards===1000&&r.scenario==='drag'&&r.repetition===2)!, i => i < 160 ? (i % 2 === 0 ? 21 : 19) : 20)
    m.runs.filter(r=>r.cards===100).forEach(r=>retimeFrames(r, i => i < 160 ? (i % 2 === 0 ? 21 : 19) : 20))
    const r=reduce(m)
    expect(r.runs.find(x=>x.id==='1000-drag-2')?.presented_editor_frame_interval.verdict).toBe('FAIL')
    expect(r.metrics.verdict).toBe('FAIL'); expect(r.comparisons[0].verdict).toBe('PASS')
    expect(r.gate.criteria.AC2).toBe('FAIL')
  })
  it('excludes drain-only intervals from active frame p95 without hiding a boundary stall', () => {
    const m=manifest(), target=m.runs.find(r=>r.cards===1000&&r.scenario==='pan'&&r.repetition===1)!
    retimeFrames(target,i=>i<300 ? (i<20 ? 21 : 20) : i===300 ? 24000 : 1)
    const result=reduce(m).runs.find(r=>r.id===target.id)!
    expect(result.validity).toBe('PASS')
    expect(result.presented_editor_frame_interval.upper.n).toBe(301)
    expect(result.presented_editor_frame_interval.verdict).toBe('FAIL')
  })
  it('rejects an unrecorded active-window terminal stall despite minimum pacing', () => {
    const m=manifest(), target=m.runs.find(r=>r.cards===1000&&r.scenario==='pan'&&r.repetition===1)!
    const trimmed=target.groups.splice(-75)
    target.intervals.splice(-75)
    const lateIds=new Set(trimmed.flatMap(g=>g.member_ids))
    for (const input of target.inputs) if (lateIds.has(input.id)) {
      input.classification='late';input.reason='not delivered';input.injection_ms=null;input.origin_ms=null
    }
    target.delivered=target.scheduled-lateIds.size
    expect(target.delivered).toBeGreaterThanOrEqual(p.sampling.minimum_delivered_requests)
    const result=reduce(m).runs.find(r=>r.id===target.id)!
    expect(result.reasons).toContain('Active-window terminal presentation/stall not accounted for.')
    expect(result.validity).toBe('NOT_MEASURED')
  })
  it('rejects a delivered browser origin entering after the active window', () => {
    const m=manifest();m.runs[0]!.inputs[0]!.origin_ms=40010
    expect(reduce(m).runs[0]!.reasons).toContain('Input deadline/injection/origin outside active window or misordered.')
  })
  it('coalesced slow originals count once each among fast singleton groups', () => {
    const m=manifest(), r=m.runs.find(r=>r.cards===1000&&r.scenario==='pan'&&r.repetition===1)!
    const fast=r.inputs.slice(0,-181), slow=r.inputs.slice(-181)
    const group=(member_ids:string[], frame:number, presentation_ms:number) => ({
      member_ids, frame_id:`f${frame}`, presentation_ms,
      provenance:'platform_presentation_feedback' as const, frame_link:'revision_matched' as const,
      app_revision:frame,canvas_revision:frame,label_revision:frame,optical_latency:null,
    })
    r.groups=fast.map((input,index)=>group([input.id],index,input.origin_ms!+30))
    r.groups.push(group(slow.map(input=>input.id),fast.length,slow.at(-1)!.origin_ms!+60))
    let previous=r.groups[0]!.presentation_ms!-8
    r.intervals=r.groups.map(g=>{
      const current=g.presentation_ms!, interval={frame_id:g.frame_id,previous_presentation_ms:previous,presentation_ms:current,
        bounds:{lower_ms:current-previous,upper_ms:current-previous},censored:false,coherent:true}
      previous=current
      return interval
    })
    expect(r.groups.filter(g=>g.member_ids.length===1)).toHaveLength(3419)
    expect(r.groups.at(-1)!.member_ids).toHaveLength(181)
    const result=reduce(m).runs.find(x=>x.id===r.id)!
    expect(result.validity).toBe('PASS')
    expect(result.input_to_visible).toMatchObject({verdict:'FAIL',upper:{n:3600}})
    expect(result.presented_editor_frame_interval.verdict).toBe('PASS')
  })
  it('rejects comparison fixture connection counts and run hashes that do not match protocol', () => {
    const wrongCount=manifest();wrongCount.comparison_fixtures[0]!.connections=199
    expect(reduce(wrongCount).gate.criteria.AC4).toBe('NOT_MEASURED')
    const wrongHash=manifest();wrongHash.runs.find(r=>r.cards===100)!.fixture_hash='a'.repeat(64)
    expect(reduce(wrongHash).gate.criteria.AC4).toBe('NOT_MEASURED')
    const missing=manifest();missing.comparison_fixtures=[]
    expect(reduce(missing).gate.criteria.AC4).toBe('NOT_MEASURED')
    const duplicate=manifest();duplicate.comparison_fixtures.push({...duplicate.comparison_fixtures[0]!})
    expect(reduce(duplicate).gate.criteria.AC4).toBe('NOT_MEASURED')
  })
  it('binds comparison metadata to hashed real checkpoint bytes and geometry', () => {
    const directory=mkdtempSync(join(tmpdir(),'gurow-comparison-test-'))
    try {
      const m=manifest();m.synthetic=false // Exercise binding only; never emit a real gate report.
      m.artifacts=[]
      for (const cards of [100,1000,10000] as const) {
        const f=cards===1000 ? m.fixture : m.comparison_fixtures.find(f=>f.cards===cards)!
        const generated=generateBenchmarkFixture(cards)
        if (cards===1000) m.fixture.camera_and_cell={z0:generated.geometry.z0,px:generated.geometry.px,py:generated.geometry.py,
          offset_x:generated.geometry.camera.offset_x,offset_y:generated.geometry.camera.offset_y}
        f.hash=generated.manifest.checkpoint_hash
        f.manifest_path=`manifest-${cards}.json`;f.checkpoint_path=`checkpoint-${cards}.json`
        m.runs.filter(r=>r.cards===cards).forEach(r=>r.fixture_hash=f.hash)
        const manifestBytes=Buffer.from(JSON.stringify(generated.manifest))
        const checkpointBytes=Buffer.from(JSON.stringify(generated.checkpoint))
        writeFileSync(join(directory,f.manifest_path),manifestBytes)
        writeFileSync(join(directory,f.checkpoint_path),checkpointBytes)
        const prefix=cards===1000 ? 'primary-fixture' : 'comparison-fixture'
        m.artifacts.push({role:`${prefix}-manifest`,path:f.manifest_path,sha256:sha(manifestBytes)},
          {role:`${prefix}-checkpoint`,path:f.checkpoint_path,sha256:sha(checkpointBytes)})
      }
      expect(verifyArtifacts(m.artifacts,directory)).toEqual([])
      expect(verifyArtifactBindings(m,directory)).toEqual([])
      m.fixture.camera_and_cell.z0+=.1
      expect(verifyArtifactBindings(m,directory).join(' ')).toContain('Primary fixture metadata differs')
      m.fixture.camera_and_cell.z0-=.1
      const primaryCheckpoint=m.artifacts.find(a=>a.role==='primary-fixture-checkpoint')!
      m.artifacts=m.artifacts.filter(a=>a!==primaryCheckpoint)
      expect(verifyArtifactBindings(m,directory).join(' ')).toContain('Fixture 1000 manifest/checkpoint artifact missing.')
      m.artifacts.push(primaryCheckpoint)
      const f=m.comparison_fixtures[0]!, record=JSON.parse(readFileSync(join(directory,f.checkpoint_path),'utf8'))
      record.editor.connections.pop()
      const bytes=Buffer.from(JSON.stringify(record))
      writeFileSync(join(directory,f.checkpoint_path),bytes)
      m.artifacts.find(a=>a.path===f.checkpoint_path)!.sha256=sha(bytes)
      expect(verifyArtifacts(m.artifacts,directory)).toEqual([])
      expect(verifyArtifactBindings(m,directory).join(' ')).toContain('checkpoint does not match')
      const rawManifest=JSON.parse(readFileSync(join(directory,f.manifest_path),'utf8'))
      delete rawManifest.cell_pitch_world
      const manifestBytes=Buffer.from(JSON.stringify(rawManifest))
      writeFileSync(join(directory,f.manifest_path),manifestBytes)
      m.artifacts.find(a=>a.path===f.manifest_path)!.sha256=sha(manifestBytes)
      expect(verifyArtifactBindings(m,directory).join(' ')).toContain('geometry')
      // Recompute every declared hash after moving a card: consistency alone must not qualify layout.
      for (const cards of [100,1000] as const) {
        const fixture=cards===1000 ? m.fixture : m.comparison_fixtures[0]!
        const generated=generateBenchmarkFixture(cards)
        const moved=structuredClone(generated.checkpoint)
        moved.editor.cards[0]!.position.x+=1000
        fixture.hash=sha(Buffer.from(JSON.stringify(moved)))
        m.runs.filter(r=>r.cards===cards).forEach(r=>r.fixture_hash=fixture.hash)
        const fixtureRecord={...generated.manifest,checkpoint_hash:fixture.hash}
        for (const [path,contents] of [[fixture.manifest_path,fixtureRecord],[fixture.checkpoint_path,moved]] as const) {
          const data=Buffer.from(JSON.stringify(contents))
          writeFileSync(join(directory,path),data)
          m.artifacts.find(a=>a.path===path)!.sha256=sha(data)
        }
        expect(verifyArtifacts(m.artifacts,directory)).toEqual([])
        expect(verifyArtifactBindings(m,directory).join(' ')).toContain(`Fixture ${cards} geometry/checkpoint does not match contracted layout.`)
      }
    } finally {rmSync(directory,{recursive:true,force:true})}
  })
  it('does not combine physical and injected acquisition series', () => {
    const m=manifest(), optical=m.runs.find(r=>r.cards===1000)!
    optical.acquisition='optical'; optical.clock='optical_capture_clock'
    optical.inputs.forEach(i=>i.injection_ms=null)
    optical.optical_calibration={qualified:true,independent_input_evidence:true,raw_video:m.artifacts[0]!.path,calibration_artifact:m.artifacts[0]!.path}
    opticalOnsets(optical,50,50)
    expect(reduce(m).gate.criteria.AC3).toBe('NOT_MEASURED')
    expect(reduce(m).gate.reasons.join(' ')).toContain('Mixed optical and Chromium acquisition')
  })
  it('missing runs and AC evidence stay incomplete', () => {
    const m=manifest(); m.runs=m.runs.filter(r=>r.id!=='1000-zoom-3'&&r.cards!==10000); m.functional.pop()
    const r=reduce(m)
    expect(r.gate.verdict).toBe('NOT_MEASURED'); expect(r.gate.criteria.AC4).toBe('NOT_MEASURED')
    expect(r.metrics.reasons).toContain('Missing primary zoom run 3'); expect(r.functional.verdict).toBe('NOT_MEASURED')
  })
  it('requires observed label and connection visibility counts in each run and reports them', () => {
    const m=manifest(), target=m.runs[0]!
    expect(markdownReport(reduce(m))).toContain('Visible connections')
    target.visibility.labels=undefined as unknown as CaptureRun['visibility']['labels']
    expect(reduce(m).runs[0]!.reasons).toContain('Card/label/connection visibility counts or path invalid or unverified.')
    target.visibility.labels={initial:100,minimum:100,maximum:100}
    target.visibility.connections.maximum=target.cards*3
    expect(reduce(m).runs[0]!.validity).toBe('NOT_MEASURED')
  })
  it('null optional counter without reason independently leaves AC4 incomplete', () => {
    const m=manifest(); m.diagnostics.gpu_memory_bytes.reason=null
    const report=reduce(m)
    expect(report.gate.criteria.AC4).toBe('NOT_MEASURED')
    expect(report.gate.reasons).toContain('Diagnostic gpu_memory_bytes requires a value or null + reason.')
    expect(report.comparisons.every(c=>c.verdict==='PASS')).toBe(true)
  })
  it('fabricated presentation provenance independently invalidates a run', () => {
    const m=manifest(); m.runs[0]!.groups[0]!.provenance='fabricated'
    const runReport=reduce(m).runs[0]!
    expect(runReport.validity).toBe('NOT_MEASURED')
    expect(runReport.reasons).toContain('Unqualified/fabricated presentation or revision mismatch.')
  })
  it('rejects malformed accounting, censored terminal interval, unresolved and invalid visibility', () => {
    const m=manifest(), r=m.runs[0]; r.delivered=3599; r.inputs[0].classification='unresolved'; r.inputs[0].reason='trace lost'; r.intervals.at(-1)!.censored=true; r.visibility.minimum=179
    const report=reduce(m)
    expect(report.runs[0].validity).toBe('NOT_MEASURED'); expect(report.runs[0].reasons.join(' ')).toMatch(/counts mismatch|unresolved/)
    expect(report.runs[0].reasons.join(' ')).toContain('Censored')
    const primary=m.runs.find(r=>r.cards===1000)!; primary.visibility.minimum=179
    expect(reduce(m).runs.find(r=>r.id===primary.id)?.validity).toBe('NOT_MEASURED')
  })
  it('rejects fabricated provenance, mixed clocks, profile/source mismatch and actual environment geometry', () => {
    const m=manifest(), r=m.runs[0]; r.groups[0].provenance='fabricated'; r.clock='different'; r.source_fingerprint='d'.repeat(64)
    m.environment.host={...m.environment.host, gpu_adapter:'different'}
    expect(reduce(m).gate.reasons.join(' ')).toMatch(/environment/)
    expect(reduce(m).runs[0].reasons.join(' ')).toMatch(/clock|source/)
    const n=manifest(); n.profile.host.viewport_css=[800,600]; n.environment.host=n.profile.host
    expect(reduce(n).gate.criteria.AC3).toBe('NOT_MEASURED')
  })
  it('verifies missing and corrupted artifacts, contract checksum and no-default-to-zero', () => {
    const m=manifest(); m.artifacts[0].path='nonexistent.json'; m.artifacts[0].sha256='0'.repeat(64)
    expect(verifyArtifacts(m.artifacts,import.meta.dir).join(' ')).toContain('missing')
    expect(verifyArtifacts([{path:'../../../../../../etc/passwd',role:'raw-input-frame-log',sha256:'0'.repeat(64)}],import.meta.dir).join(' ')).toContain('Invalid artifact')
    const unbound=manifest(); unbound.synthetic=false; unbound.artifacts[0].role='collector-profile'
    expect(verifyArtifactBindings(unbound,import.meta.dir).join(' ')).toContain('not readable JSON')
    const r=reduceReport(m,p,contract,verifyArtifacts(m.artifacts,import.meta.dir))
    expect(r.gate.criteria.AC3).toBe('NOT_MEASURED')
    const n=manifest(); n.identity.contract_sha256='0'.repeat(64); n.runs[0].groups=[]; n.runs[0].intervals=[]
    const reduced=reduce(n)
    expect(reduced.runs[0].input_to_visible.upper.p95).toBeNull(); expect(reduced.gate.verdict).toBe('NOT_MEASURED')
  })
  it('exit codes map verdict states without generating unmarked test reports', () => {
    const synthetic=reduce(manifest())
    expect(gateExitCode(synthetic)).toBe(2)
    // Shape-only transition table; no capture record or output report is marked real.
    const state=(verdict:Verdict, ac2:Verdict) => gateExitCode({
      synthetic:false, gate:{verdict,criteria:{AC1:'PASS',AC2:ac2,AC3:'PASS',AC4:'PASS',AC5:'PASS'}},
    } as BenchmarkReport)
    expect(state('PASS','PASS')).toBe(0)
    expect(state('FAIL','FAIL')).toBe(1)
    expect(state('NOT_MEASURED','NOT_MEASURED')).toBe(2)
    expect(state('FAIL','NOT_MEASURED')).toBe(1)
  })
  it('optical upper passes, lower fails, overlapping bound is uncertain; physical origins cannot mix', () => {
    const m=manifest(), r=m.runs.find(r=>r.cards===1000)!
    r.acquisition='optical'; r.clock='optical_capture_clock'; r.inputs.forEach(i=>i.injection_ms=null); r.optical_calibration={qualified:true,independent_input_evidence:true,raw_video:m.artifacts[0].path,calibration_artifact:m.artifacts[0].path}
    opticalOnsets(r,50,50)
    expect(reduce(m).runs.find(x=>x.id===r.id)?.input_to_visible.verdict).toBe('PASS')
    opticalOnsets(r,52,53)
    expect(reduce(m).runs.find(x=>x.id===r.id)?.input_to_visible.verdict).toBe('FAIL')
    opticalOnsets(r,50,51)
    expect(reduce(m).runs.find(x=>x.id===r.id)?.input_to_visible).toMatchObject({verdict:'NOT_MEASURED',reasons:['uncertainty_overlaps_limit']})
    r.clock='chromium_trace_monotonic'
    expect(reduce(m).runs.find(x=>x.id===r.id)?.validity).toBe('NOT_MEASURED')
  })
  it('rejects an optical group member occurring after its claimed display response', () => {
    const m=manifest(), target=m.runs.find(r=>r.cards===1000)!
    target.acquisition='optical';target.clock='optical_capture_clock'
    target.inputs.forEach(i=>i.injection_ms=null)
    target.optical_calibration={qualified:true,independent_input_evidence:true,raw_video:m.artifacts[0]!.path,calibration_artifact:m.artifacts[0]!.path}
    opticalOnsets(target,50,50)
    const member=target.groups[0]!.member_ids[1]!
    target.inputs.find(i=>i.id===member)!.origin_ms=target.groups[0]!.optical_onsets!.response.upper_ms+1
    expect(reduce(m).runs.find(r=>r.id===target.id)!.reasons).toContain('Optical response precedes a grouped original input.')
  })
  it('rejects relaxed v1 protocol, contradictory frame attribution, and narrowed optical onset', () => {
    const m=manifest(), relaxed={...p,thresholds_ms:{frame_p95:500,input_to_visible_p95:500}}
    expect(reduceReport(m,relaxed,contract).gate.criteria.AC3).toBe('NOT_MEASURED')
    const bytes=Buffer.from(JSON.stringify(relaxed))
    m.identity.contract_sha256=sha(bytes)
    expect(reduceReport(m,relaxed,bytes).gate.criteria.AC3).toBe('NOT_MEASURED')
    const n=manifest(), run=n.runs.find(r=>r.cards===1000)!
    run.groups[0]!.presentation_ms! += 1
    expect(reduce(n).runs.find(r=>r.id===run.id)?.validity).toBe('NOT_MEASURED')
    const q=manifest(), optical=q.runs.find(r=>r.cards===1000)!
    optical.acquisition='optical';optical.clock='optical_capture_clock';optical.inputs.forEach(i=>i.injection_ms=null)
    optical.optical_calibration={qualified:true,independent_input_evidence:true,raw_video:q.artifacts[0]!.path,calibration_artifact:q.artifacts[0]!.path}
    opticalOnsets(optical,50,50)
    expect(reduce(q).runs.find(r=>r.id===optical.id)?.input_to_visible.verdict).toBe('PASS')
    optical.groups[0]!.optical_onsets!.input={lower_ms:0,upper_ms:1}
    expect(reduce(q).runs.find(r=>r.id===optical.id)?.validity).toBe('NOT_MEASURED')
    opticalOnsets(optical,50,50)
    optical.intervals[0]!.bounds={lower_ms:1,upper_ms:1}
    expect(reduce(q).runs.find(r=>r.id===optical.id)?.validity).toBe('NOT_MEASURED')
    opticalOnsets(optical,50,50)
    optical.intervals[10]!.optical_frame=null
    expect(reduce(q).runs.find(r=>r.id===optical.id)?.validity).toBe('NOT_MEASURED')
    opticalOnsets(optical,50,50)
    optical.intervals[10]!.optical_frame!.capture_frame_index=9
    expect(reduce(q).runs.find(r=>r.id===optical.id)?.validity).toBe('NOT_MEASURED')
    const k=manifest();k.runs.find(r=>r.cards===1000)!.inputs[0]!.kind='zoom'
    expect(reduce(k).runs.find(r=>r.cards===1000)?.validity).toBe('NOT_MEASURED')
  })
  it('CLI writes JSON and readable Markdown but synthetic and invalid inputs exit 2', () => {
    const directory=mkdtempSync(join(tmpdir(),'gurow-report-test-'))
    try {
      const m=manifest(), input=join(directory,'capture.json'), output=join(directory,'result')
      writeFileSync(join(directory,'proof.txt'),'SYNTHETIC fixture, not hardware evidence')
      m.artifacts=[{role:'synthetic fixture',path:'proof.txt',sha256:sha(readFileSync(join(directory,'proof.txt')))}]
      writeFileSync(input,JSON.stringify(m));expect(runCli(['--input',input,'--contract',resolve(import.meta.dir,'../../../docs/benchmarks/p1/protocol.json'),'--out',output])).toBe(2)
      expect(JSON.parse(readFileSync(`${output}.json`,'utf8')).gate.verdict).toBe('NOT_MEASURED')
      expect(readFileSync(`${output}.md`,'utf8')).toContain('Per-run statistics (unrounded ms)')
      m.artifacts[0]!.sha256='0'.repeat(64);writeFileSync(input,JSON.stringify(m))
      expect(runCli(['--input',input,'--contract',resolve(import.meta.dir,'../../../docs/benchmarks/p1/protocol.json'),'--out',output])).toBe(2)
      expect(JSON.parse(readFileSync(`${output}.json`,'utf8')).gate.criteria.AC3).toBe('NOT_MEASURED')
    } finally { rmSync(directory,{recursive:true,force:true}) }
  })
})
