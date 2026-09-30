#!/usr/bin/env bun
/**
 * Usage: bun run scripts/benchmark/report-cli.ts --input CAPTURE.json --contract protocol-v4.json --out PREFIX
 *
 * CAPTURE.json is the gurow-p1-capture-manifest-v4 interface in report.ts.
 * Paths in `artifacts` are relative to CAPTURE.json, SHA-256 hex, and must exist.
 * `runs` preserves all attempts, with raw rAF frame intervals and per-input proxy
 * and raw latency arrays. Primary repetitions are pooled per scenario; v1
 * presentation/optical manifests cannot be reinterpreted as v2 evidence.
 * The normative protocol-v4.json bytes and fixture generator are pinned.
 * See report.test.ts for a complete SYNTHETIC example.
 * Optional --verify-current-source compares capture fingerprint to this checkout;
 * leave off for reproducible historical/offline reduction. Artifact hashes and
 * bindings do not authenticate a self-attested browser capture; independently
 * review headed hardware, timing hooks and raw capture before claiming P1 proof.
 * Outputs PREFIX.json and PREFIX.md. Exit 0 complete real PASS, 1 proven FAIL,
 * 2 missing/invalid evidence (including synthetic), with reports still written.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { gateExitCode, markdownReport, reduceReport, verifyArtifactBindings, verifyArtifacts, type CaptureManifest, type Protocol } from './report'
import { computeSourceFingerprint } from './sourceFingerprint'

export function runCli(args: string[]): number {
  const option = (name: string): string | undefined => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
  const input = option('--input'), contract = option('--contract'), out = option('--out')
  if (!input || !contract || !out) { console.error('Usage: --input CAPTURE.json --contract protocol-v4.json --out PREFIX (see report-cli.ts header for manifest schema)'); return 2 }
  try {
    const manifest = JSON.parse(readFileSync(input, 'utf8')) as CaptureManifest
    const contractBytes = readFileSync(contract)
    const protocol = JSON.parse(contractBytes.toString()) as Protocol
    const errors = verifyArtifacts(manifest.artifacts, dirname(resolve(input)))
    if (!errors.length) errors.push(...verifyArtifactBindings(manifest, dirname(resolve(input))))
    if (args.includes('--verify-current-source') && !manifest.synthetic && manifest.identity?.source_fingerprint !== computeSourceFingerprint(resolve(import.meta.dir, '../../..'))) {
      errors.push('Captured source fingerprint differs from current checkout; cannot independently verify historical source.')
    }
    const report = reduceReport(manifest, protocol, contractBytes, errors)
    writeFileSync(`${out}.json`, JSON.stringify(report, null, 2) + '\n')
    writeFileSync(`${out}.md`, markdownReport(report))
    console.log(`Report ${report.gate.verdict}${report.synthetic ? ' (SYNTHETIC)' : ''}: ${out}.json, ${out}.md`)
    return gateExitCode(report)
  } catch (error) {
    const reason = `Report input invalid: ${error instanceof Error ? error.message : String(error)}`
    console.error(reason)
    try {
      writeFileSync(`${out}.json`, JSON.stringify({ status: 'NOT_MEASURED', input_error: reason, synthetic: false }, null, 2) + '\n')
      writeFileSync(`${out}.md`, `# P1 report unavailable — NOT_MEASURED\n\n${reason}\n`)
    } catch (writeError) { console.error(`Cannot write invalid-input report: ${String(writeError)}`) }
    return 2
  }
}
if (import.meta.main) process.exitCode = runCli(process.argv.slice(2))
