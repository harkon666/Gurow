#!/usr/bin/env bun
/**
 * P1 gate capture (#39, ADR 0020): the 300-card gate capture plus the
 * 1,000-card informational run, reduced to the one short report #7 asks for.
 *
 * Usage (from frontend): bun run capture:p1:gate [--report-only] [run.ts flags such as --headless]
 * Each capture builds current sources (run.ts). --report-only re-summarizes
 * the captures already in --out. Exit 0 PASS, 1 FAIL, 2 NOT_MEASURED.
 *
 * The verdict is the reducer's metrics verdict for the 300-card capture: the
 * 20 ms / 50 ms pooled p95 limits, run validity, preflight and sanity checks.
 * The reducer's functional, comparison and diagnostic criteria (#38, #40) are
 * out of the MVP gate; the functional flow is the t06-functional harness check.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { nearestRank, stats, type BenchmarkReport, type CaptureManifest, type CaptureRun, type Protocol, type Statistics, type Verdict } from './report'

const FRONTEND = path.resolve(import.meta.dir, '../..')
const ROOT = path.resolve(FRONTEND, '..')
const CONTRACT = path.join(ROOT, 'docs/benchmarks/p1/protocol-v5.json')
const INFORMATIONAL_CARDS = 1000

/** run.ts writes a stub with only gate reasons when a capture cannot start. */
export type PrimaryInput = BenchmarkReport | { gate: { verdict: Verdict; reasons: string[] }; input_error?: string }
export interface GateSummary { verdict: Verdict; reasons: string[]; markdown: string }

const ms = (v: number | null) => v === null ? '—' : v.toFixed(1)
const formatP50P95 = (s: Statistics) => `${ms(s.p50)} / ${ms(s.p95)}`
const isReport = (r: PrimaryInput | null): r is BenchmarkReport => !!r && 'scenarios' in r && Array.isArray(r.scenarios)
const formatRange = (values: (number | null)[]) => {
  const known = values.filter((v): v is number => v !== null)
  if (!known.length) return '—'
  const lo = Math.min(...known), hi = Math.max(...known)
  return lo === hi ? String(lo) : `${lo}–${hi}`
}

function environmentLines(env: CaptureManifest['environment'] & { idle_raf_hz?: number; gpu_driver_source?: string }): string[] {
  let adapter = env.gpu_adapter
  try {
    const a = JSON.parse(env.gpu_adapter)
    adapter = [a.vendor, a.architecture, a.description || a.device].filter(Boolean).join(' ') + (a.fallback ? ' (fallback)' : '')
  } catch { /* keep the raw string */ }
  return [
    `- CPU: ${env.cpu}`,
    `- GPU: ${adapter || 'unknown'}${env.hardware_gpu ? '' : ' (not a hardware adapter)'}; driver ${env.gpu_driver || 'unknown'}`,
    `- OS: ${env.os} ${env.kernel}, ${env.compositor || 'unknown compositor'}`,
    `- Browser: ${env.browser_version} (${env.headed ? 'headed' : 'headless'})`,
    `- Viewport: ${env.window_inner_size.width}×${env.window_inner_size.height} CSS px window, canvas ${env.canvas_css.width}×${env.canvas_css.height} CSS px, DPR ${env.device_pixel_ratio}`,
    `- Refresh: ${env.display_refresh_hz} Hz display${env.idle_raf_hz ? `, idle rAF ${env.idle_raf_hz.toFixed(1)} Hz` : ''}`,
    `- Power: ${env.ac_power_online ? 'AC' : 'battery or unknown'}; CPU governor ${env.cpu_governor || 'unknown'}`,
    ...(env.interruptions.length ? [`- Interruptions: ${env.interruptions.join('; ')}`] : []),
  ]
}

function visibleMedian(run: CaptureRun): number | null {
  return nearestRank((run.visibility ?? []).map(v => v.visible_cards), .5)
}

/** Builds the gate verdict and the short markdown report from the reduced 300-card and raw 1,000-card captures. */
export function summarizeGate(protocol: Protocol, primary: PrimaryInput | null, informational: CaptureManifest | null, links: { primary: string; informational: string }): GateSummary {
  const { frame_p95, input_to_frame_proxy_p95 } = protocol.thresholds_ms
  const reasons: string[] = []
  let verdict: Verdict = 'NOT_MEASURED'
  if (!primary) reasons.push('No 300-card capture report.')
  else if (!isReport(primary)) reasons.push(...(primary.input_error ? [primary.input_error] : primary.gate.reasons))
  else if (primary.synthetic) reasons.push('Synthetic evidence cannot satisfy the gate.')
  else if (primary.fixture?.cards !== protocol.primary.cards || primary.identity?.contract_id !== protocol.contract_id) reasons.push(`Capture is not the ${protocol.primary.cards}-card ${protocol.contract_id} workload.`)
  else {
    verdict = primary.metrics.verdict
    reasons.push(...primary.metrics.reasons, ...primary.scenarios.filter(s => s.verdict === 'FAIL').map(s => `${s.scenario} pooled p95 exceeds a limit.`))
  }

  const lines = [`# P1 gate — ${verdict}`, '',
    `Contract ${protocol.contract_id} (ADR 0020): ${protocol.primary.cards} cards / ${protocol.primary.connections} connections with HTML labels. ` +
    `Limits per scenario: pooled p95 frame interval ≤ ${frame_p95} ms and p95 input-to-frame proxy ≤ ${input_to_frame_proxy_p95} ms.`, '']
  if (isReport(primary)) {
    const id = primary.identity
    lines.push(`Source: \`${id.commit}\`${id.tree_dirty ? ' (uncommitted changes)' : ''}, fingerprint \`${id.source_fingerprint.slice(0, 12)}\`; captured ${id.timestamp}.`, '')
  }

  lines.push(`## Gate: ${protocol.primary.cards} cards`, '')
  if (isReport(primary)) {
    lines.push('| Scenario | Verdict | Frame p50 / p95 (ms) | Proxy p50 / p95 (ms) | Input reaching page | Visible cards (run medians) |', '|---|---|---|---|---|---|')
    for (const s of primary.scenarios) {
      const runs = primary.runs.filter(r => r.cards === protocol.primary.cards && r.scenario === s.scenario)
      const delivered = runs.reduce((n, r) => n + r.counts.delivered, 0), scheduled = runs.reduce((n, r) => n + r.counts.scheduled, 0)
      lines.push(`| ${s.scenario} | ${s.verdict} | ${formatP50P95(s.frame_interval_ms)} | ${formatP50P95(s.input_to_frame_proxy_ms)} | ${delivered} / ${scheduled} (${s.valid_runs} valid runs) | ${formatRange(runs.map(r => r.visibility_median))} |`)
    }
  } else lines.push('No reduced capture.')
  if (verdict !== 'PASS' && reasons.length) lines.push('', 'Reasons:', ...[...new Set(reasons)].map(r => `- ${r}`))

  lines.push('', `## Informational: ${INFORMATIONAL_CARDS} cards (no threshold)`, '')
  const infoRuns = (informational?.runs ?? []).filter(r => r.cards === INFORMATIONAL_CARDS)
  if (infoRuns.length) {
    lines.push(`${informational!.fixture.connections} connections, ${infoRuns.length} run(s), contract ${informational!.identity.contract_id}.`, '',
      '| Scenario | Frame p50 / p95 (ms) | Proxy p50 / p95 (ms) | Input reaching page | Visible cards (median) | Run notes |', '|---|---|---|---|---|---|')
    for (const scenario of protocol.scenarios) {
      const runs = infoRuns.filter(r => r.scenario === scenario)
      if (!runs.length) { lines.push(`| ${scenario} | — | — | — | — | not captured |`); continue }
      const seconds = runs.reduce((n, r) => n + r.active_seconds, 0)
      const frames = stats(runs.flatMap(r => r.frame_interval_ms), seconds), proxy = stats(runs.flatMap(r => r.input_to_frame_proxy_ms), seconds)
      const delivered = runs.reduce((n, r) => n + r.delivered, 0), scheduled = runs.reduce((n, r) => n + r.scheduled, 0)
      const backpressure = delivered < scheduled * protocol.sampling.minimum_delivered_fraction ? ['backpressure: page received under the minimum input fraction'] : []
      const notes = [...new Set([...runs.flatMap(r => r.invalid_reasons), ...backpressure])].join('; ') || 'valid'
      lines.push(`| ${scenario} | ${formatP50P95(frames)} | ${formatP50P95(proxy)} | ${delivered} / ${scheduled} | ${formatRange(runs.map(visibleMedian))} | ${notes} |`)
    }
  } else lines.push('Not recorded.')

  const env = isReport(primary) ? primary.environment : informational?.environment
  lines.push('', '## Environment', '', ...(env ? environmentLines(env) : ['Not recorded (no capture reached the preflight).']))
  lines.push('', '## Measurement limitation', '',
    'The input-to-frame proxy is measured in the page: input timestamp to the first animation-frame callback after the canvas and HTML labels committed that input, ' +
    'plus one refresh interval. It covers input queueing, application, renderer submission and label commit on the main thread; it does not observe compositor output, scanout or physical pixels.',
    '', `Evidence: [${protocol.primary.cards}-card reducer report](${links.primary}), [${INFORMATIONAL_CARDS}-card raw capture](${links.informational}).`, '')
  return { verdict, reasons: [...new Set(reasons)], markdown: lines.join('\n') }
}

function readJson<T>(file: string): T | null {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T } catch { return null }
}

/** Reports from an earlier run must not stand in for a capture that fails before writing its own. */
export function clearCaptureOutputs(dir: string) {
  for (const file of ['capture.json', 'report.json', 'report.md']) rmSync(path.join(dir, file), { force: true })
}

/** Splits gate options from the run.ts flags passed through to both captures. */
export function gateArgs(argv: string[], defaultOut: string) {
  const outIndex = argv.indexOf('--out')
  if (outIndex >= 0 && (!argv[outIndex + 1] || argv[outIndex + 1].startsWith('--'))) throw new Error('Missing value for --out')
  const out = path.resolve(outIndex >= 0 ? argv[outIndex + 1] : defaultOut)
  const passThrough = argv.filter((a, i) => a !== '--report-only' && (outIndex < 0 || (i !== outIndex && i !== outIndex + 1)))
  return { out, reportOnly: argv.includes('--report-only'), passThrough }
}

function capture(out: string, extra: string[]): Promise<number> {
  clearCaptureOutputs(out)
  const child = spawn('bun', ['run', 'scripts/benchmark/run.ts', '--contract', CONTRACT, '--out', out, ...extra], { cwd: FRONTEND, stdio: 'inherit' })
  return new Promise(resolve => child.on('close', code => resolve(code ?? 2)))
}

async function main(argv: string[]): Promise<number> {
  const { out, reportOnly, passThrough } = gateArgs(argv, path.join(ROOT, '.harness/t06/gate'))
  const protocol = JSON.parse(readFileSync(CONTRACT, 'utf8')) as Protocol
  const primaryDir = path.join(out, `primary-${protocol.primary.cards}`), infoDir = path.join(out, `informational-${INFORMATIONAL_CARDS}`)
  mkdirSync(out, { recursive: true })
  if (!reportOnly) {
    // run.ts exits nonzero whenever its full reducer gate is not PASS; the summary below decides.
    await capture(primaryDir, passThrough)
    await capture(infoDir, ['--size', String(INFORMATIONAL_CARDS), ...passThrough])
  }
  const primaryReport = path.join(primaryDir, 'report.json'), infoCapture = path.join(infoDir, 'capture.json')
  const summary = summarizeGate(protocol, existsSync(primaryReport) ? readJson<PrimaryInput>(primaryReport) : null,
    existsSync(infoCapture) ? readJson<CaptureManifest>(infoCapture) : null,
    { primary: path.relative(out, path.join(primaryDir, 'report.md')), informational: path.relative(out, infoCapture) })
  writeFileSync(path.join(out, 'gate-report.md'), summary.markdown)
  writeFileSync(path.join(out, 'gate-report.json'), JSON.stringify({ verdict: summary.verdict, reasons: summary.reasons }, null, 2) + '\n')
  console.log(`\n${summary.markdown}\nP1 gate ${summary.verdict}: ${path.join(out, 'gate-report.md')}`)
  return summary.verdict === 'PASS' ? 0 : summary.verdict === 'FAIL' ? 1 : 2
}

if (import.meta.main) main(process.argv.slice(2)).then(code => { process.exitCode = code }).catch(error => {
  console.error(`P1 gate NOT_MEASURED: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
})
