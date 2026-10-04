import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { clearCaptureOutputs, gateArgs, summarizeGate, type PrimaryInput } from './gate'
import { stats, type BenchmarkReport, type CaptureManifest, type CaptureRun, type Protocol, type Verdict } from './report'

// SYNTHETIC reduced/raw records: only the fields the gate summary reads.
const protocol = JSON.parse(readFileSync(resolve(import.meta.dir, '../../../docs/benchmarks/p1/protocol-v5.json'), 'utf8')) as Protocol
const links = { primary: 'primary-300/report.md', informational: 'informational-1000/capture.json' }
const environment = {
  cpu: 'Synthetic CPU', os: 'linux', kernel: '7.0', compositor: 'Hyprland', cpu_governor: 'performance', browser_version: 'Chrome/152',
  gpu_adapter: '{"vendor":"nvidia","architecture":"lovelace","fallback":false}', gpu_driver: '610.57', hardware_gpu: true,
  display_refresh_hz: 165, idle_raf_hz: 164.2, window_inner_size: { width: 1884, height: 982 }, device_pixel_ratio: 1.25,
  canvas_css: { width: 1276, height: 890 }, ac_power_online: true, headed: true, interruptions: [] as string[],
} as unknown as CaptureManifest['environment']

/** The reducer decides scenario and metrics verdicts; each is given here independently. */
function primary(verdicts: Record<'pan' | 'zoom' | 'drag', Verdict>, metrics: Verdict = 'PASS', metricsReasons: string[] = []): BenchmarkReport {
  const frame = stats([6, 6, 7, 30], 90), proxy = stats([20, 30, 40], 90)
  const scenarios = (['pan', 'zoom', 'drag'] as const).map(scenario => ({ scenario, verdict: verdicts[scenario], reasons: [], valid_runs: 3,
    frame_interval_ms: frame, input_to_frame_proxy_ms: proxy, input_to_frame_raw_ms: proxy }))
  const runs = scenarios.flatMap(s => [1, 2, 3].map(repetition => ({ id: `300-${s.scenario}-${repetition}`, cards: 300, scenario: s.scenario, repetition,
    counts: { scheduled: 3600, sent: 3600, delivered: 3590, no_op: 0 }, visibility_median: 190 + repetition })))
  return { synthetic: false, identity: { contract_id: 'gurow-p1-v5', commit: 'abc123', tree_dirty: false, source_fingerprint: 'f'.repeat(64), timestamp: '2026-10-04T00:00:00Z' },
    environment, fixture: { cards: 300, connections: 600 }, scenarios, runs, metrics: { verdict: metrics, reasons: metricsReasons },
    // The reducer's full gate also needs functional/comparison evidence the MVP gate no longer requires.
    gate: { verdict: 'NOT_MEASURED', reasons: ['Missing functional create_select'] } } as unknown as BenchmarkReport
}

function informational(): CaptureManifest {
  const run = (scenario: 'pan' | 'zoom' | 'drag', delivered: number) => ({ id: `1000-${scenario}-1`, cards: 1000, scenario, repetition: 1, scheduled: 3600, delivered,
    invalid_reasons: [], frame_interval_ms: [10, 12, 40], input_to_frame_proxy_ms: [30, 60, 90], visibility: [{ visible_cards: 200 }, { visible_cards: 210 }, { visible_cards: 220 }] }) as unknown as CaptureRun
  return { identity: { contract_id: 'gurow-p1-v5' }, environment, fixture: { cards: 1000, connections: 2000 }, runs: [run('pan', 1200), run('zoom', 3600), run('drag', 3600)] } as unknown as CaptureManifest
}

describe('P1 gate summary (SYNTHETIC)', () => {
  it('passes on the 300-card metrics verdict alone and records the report fields #7 asks for', () => {
    const s = summarizeGate(protocol, primary({ pan: 'PASS', zoom: 'PASS', drag: 'PASS' }), informational(), links)
    expect(s.verdict).toBe('PASS')
    expect(s.markdown).toStartWith('# P1 gate — PASS')
    expect(s.markdown).toContain('| pan | PASS | 6.0 / 30.0 | 30.0 / 40.0 | 10770 / 10800 (3 valid runs) | 191–193 |')
    for (const field of ['CPU: Synthetic CPU', 'GPU: nvidia lovelace; driver 610.57', 'OS: linux 7.0, Hyprland', 'Browser: Chrome/152 (headed)',
      'canvas 1276×890 CSS px, DPR 1.25', 'Refresh: 165 Hz display, idle rAF 164.2 Hz', 'does not observe compositor output, scanout or physical pixels']) expect(s.markdown).toContain(field)
  })

  it('reports 1,000 cards without a verdict and flags held-back input', () => {
    const s = summarizeGate(protocol, primary({ pan: 'PASS', zoom: 'PASS', drag: 'PASS' }), informational(), links)
    const section = s.markdown.slice(s.markdown.indexOf('## Informational'), s.markdown.indexOf('## Environment'))
    expect(section).toContain('2000 connections, 3 run(s)')
    expect(section).toContain('| pan | 12.0 / 40.0 | 60.0 / 90.0 | 1200 / 3600 | 210 | backpressure')
    expect(section).toContain('| zoom | 12.0 / 40.0 | 60.0 / 90.0 | 3600 / 3600 | 210 | valid |')
    expect(section).not.toMatch(/PASS|FAIL/)
  })

  it('fails when any scenario exceeds a limit, and lists it', () => {
    const s = summarizeGate(protocol, primary({ pan: 'PASS', zoom: 'FAIL', drag: 'PASS' }, 'FAIL'), informational(), links)
    expect(s.verdict).toBe('FAIL')
    expect(s.reasons).toContain('zoom pooled p95 exceeds a limit.')
    expect(s.markdown).toContain('- zoom pooled p95 exceeds a limit.')
    expect(s.markdown).toContain('| zoom | FAIL |')
    // The full reducer gate (functional/comparison evidence) never decides the MVP gate.
    expect(summarizeGate(protocol, primary({ pan: 'PASS', zoom: 'PASS', drag: 'PASS' }, 'NOT_MEASURED', ['Missing or invalid primary pan run 2']), null, links).verdict).toBe('NOT_MEASURED')
  })

  it('cannot pass on an invalid, missing, synthetic or wrong-size capture', () => {
    const invalid = summarizeGate(protocol, primary({ pan: 'PASS', zoom: 'PASS', drag: 'PASS' }, 'NOT_MEASURED', ['Application/label delay sanity checks incomplete or below required shift.']), null, links)
    expect(invalid.verdict).toBe('NOT_MEASURED')
    expect(invalid.markdown).toContain('sanity checks incomplete')
    expect(invalid.markdown).toContain('## Informational: 1000 cards (no threshold)\n\nNot recorded.')

    const stub: PrimaryInput = { gate: { verdict: 'NOT_MEASURED', reasons: ['Headed hardware preflight failed'] } }
    const failed = summarizeGate(protocol, stub, informational(), links)
    expect(failed).toMatchObject({ verdict: 'NOT_MEASURED', reasons: ['Headed hardware preflight failed'] })
    expect(failed.markdown).toContain('CPU: Synthetic CPU') // environment from the informational run
    expect(summarizeGate(protocol, null, null, links).verdict).toBe('NOT_MEASURED')

    const synthetic = primary({ pan: 'PASS', zoom: 'PASS', drag: 'PASS' })
    synthetic.synthetic = true
    expect(summarizeGate(protocol, synthetic, null, links).verdict).toBe('NOT_MEASURED')
    const thousand = primary({ pan: 'PASS', zoom: 'PASS', drag: 'PASS' })
    thousand.fixture.cards = 1000
    expect(summarizeGate(protocol, thousand, null, links).reasons).toEqual(['Capture is not the 300-card gurow-p1-v5 workload.'])
    const v4 = primary({ pan: 'PASS', zoom: 'PASS', drag: 'PASS' })
    v4.identity.contract_id = 'gurow-p1-v4'
    expect(summarizeGate(protocol, v4, null, links).verdict).toBe('NOT_MEASURED')
    const crashed: PrimaryInput = { gate: { verdict: 'NOT_MEASURED', reasons: [] }, input_error: 'Production build missing' }
    expect(summarizeGate(protocol, crashed, null, links).reasons).toEqual(['Production build missing'])
  })

  it('removes an earlier report so a capture that fails before writing cannot reuse it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gurow-gate-'))
    try {
      for (const file of ['capture.json', 'report.json', 'report.md', 'environment.json']) writeFileSync(join(dir, file), '{}')
      clearCaptureOutputs(dir)
      expect(['capture.json', 'report.json', 'report.md'].some(file => existsSync(join(dir, file)))).toBe(false)
      expect(existsSync(join(dir, 'environment.json'))).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('passes run.ts flags through with or without --out', () => {
    expect(gateArgs(['--headless'], '/tmp/gate')).toEqual({ out: '/tmp/gate', reportOnly: false, passThrough: ['--headless'] })
    expect(gateArgs(['--headless', '--out', '/tmp/x', '--report-only', '--port', '3480'], '/tmp/gate'))
      .toEqual({ out: '/tmp/x', reportOnly: true, passThrough: ['--headless', '--port', '3480'] })
    expect(() => gateArgs(['--out'], '/tmp/gate')).toThrow('Missing value for --out')
  })
})
