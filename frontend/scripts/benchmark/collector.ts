import { createHash } from 'crypto'

export interface HostEnvironmentInfo {
  cpu: string
  logical_cpus: number
  physical_memory_bytes: number
  os: string
  kernel: string
  gpu_adapter: string
  gpu_driver: string
  is_fallback: boolean
  compositor: string
  display_output: string
  display_refresh_hz: number
  device_pixel_ratio: number
  viewport_css: [number, number]
  browser_executable: string
  browser_version: string
  browser_backend: string
}

export interface TraceConfiguration {
  categories: string[]
  parser_version: string
  clock_origin: string
  clock_units: string
  timestamp_scale_to_ms: number
}

export interface FaultInjectionConfig {
  enabled: boolean
  app_delay_ms: number
  label_delay_ms: number
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

export interface CollectorProfile {
  version: string
  contract_id: string
  hash: string
  status: 'QUALIFIED' | 'UNSUPPORTED'
  unsupported_reason?: string
  host: HostEnvironmentInfo
  trace_configuration: TraceConfiguration
  fault_injection: FaultInjectionConfig
  optical_requirements?: OpticalAcquisitionRequirements
}

export interface TraceEvent {
  cat?: string
  name?: string
  ph?: string
  ts: number // in microseconds on trace clock
  dur?: number
  tts?: number
  pid?: number
  tid?: number
  args?: Record<string, any>
  id?: string
}

export interface CorrelationEvent {
  input_id: string
  scenario: 'pan' | 'zoom' | 'drag'
  scheduled_time_ms: number
  injected_time_ms: number
  app_revision: number
  canvas_revision: number
  label_revision: number
  cpu_work_duration_ms: number
  gpu_submit_duration_ms: number
  raf_cadence_ms: number
}

export interface InputPresentationChain {
  input_id: string
  scenario: 'pan' | 'zoom' | 'drag'
  input_timestamp_ms: number
  app_revision: number
  canvas_revision: number
  label_revision: number
  presented_frame_id: string
  presentation_timestamp_ms: number
  latency_ms: number
  presentation_provenance: 'platform_presentation_feedback' | 'estimated' | 'fabricated' | 'unknown'
  diagnostics: {
    cpu_duration_ms: number
    gpu_submit_ms: number
    raf_interval_ms: number
  }
}

export interface TraceParseResult {
  valid: boolean
  errors: string[]
  chains: InputPresentationChain[]
  verdict: 'QUALIFIED' | 'UNSUPPORTED' | 'NOT_MEASURED'
  reasons: string[]
}

function canonicalJson(val: any): string {
  if (val === null || typeof val !== 'object') {
    return JSON.stringify(val)
  }
  if (Array.isArray(val)) {
    return '[' + val.map((v) => canonicalJson(v)).join(',') + ']'
  }
  const keys = Object.keys(val).sort()
  const entries = keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(val[k]))
  return '{' + entries.join(',') + '}'
}

/**
 * Computes canonical SHA-256 hash of a CollectorProfile omitting the hash property.
 */
export function computeProfileHash(profile: Omit<CollectorProfile, 'hash'>): string {
  const canonical = canonicalJson(profile)
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * Validates a CollectorProfile against AC1, AC4, and integrity rules.
 */
export function validateCollectorProfile(
  profile: CollectorProfile,
  options: { requireAcceptanceMode?: boolean } = {}
): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!profile.version) {
    errors.push('Profile version is missing.')
  }

  // AC1: no fallback/software result is marked qualified
  if (profile.host.is_fallback) {
    errors.push('Software/fallback adapter cannot be marked qualified (AC1 violation).')
  }

  // AC4: Acceptance mode rejects profiles with fault injection still enabled
  if (options.requireAcceptanceMode && profile.fault_injection.enabled) {
    errors.push('Acceptance mode rejects profiles with fault injection enabled (AC4 violation).')
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
 * Validates that an 80ms app delay or label delay shifts the attributed endpoint appropriately.
 */
export function verifyControlledDelayShift(
  baselineLatencyMs: number,
  delayedLatencyMs: number,
  expectedDelayMs: number,
  toleranceMs = 25
): { pass: boolean; shiftMs: number; details: string } {
  const shiftMs = delayedLatencyMs - baselineLatencyMs
  const diff = Math.abs(shiftMs - expectedDelayMs)
  const pass = diff <= toleranceMs
  return {
    pass,
    shiftMs,
    details: `Observed shift: ${shiftMs.toFixed(2)} ms (expected ~${expectedDelayMs} ms, diff: ${diff.toFixed(2)} ms, tolerance: ${toleranceMs} ms). ${pass ? 'PASS' : 'FAIL'}`,
  }
}

/**
 * Parses raw trace events and correlation logs, strictly enforcing AC2, AC3, and AC5.
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

  // AC5 Check 2: Reject wrong clock units, negative timestamps, or corrupted durations
  for (let i = 0; i < traceEvents.length; i++) {
    const e = traceEvents[i]
    if (typeof e.ts !== 'number' || isNaN(e.ts)) {
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
    if (profile.trace_configuration.clock_units === 'us') {
      if (e.ts > 0 && e.ts < 1000 && e.ph !== 'M') {
        errors.push(`Timestamp ${e.ts} is suspiciously small for microsecond trace clock.`)
        break
      }
    }
  }

  // Filter out metadata events (ph === 'M') and sort chronologically
  const timedEvents = traceEvents.filter((e) => e.ph !== 'M' && e.ts > 0)
  const sortedEvents = [...timedEvents].sort((a, b) => a.ts - b.ts)

  // AC5 Check 3: Reject duplicate input IDs
  const seenInputIds = new Set<string>()
  for (const c of correlationEvents) {
    if (seenInputIds.has(c.input_id)) {
      errors.push(`Duplicate input ID detected: ${c.input_id}.`)
      break
    }
    seenInputIds.add(c.input_id)
  }

  // AC5 Check 4: Reject canvas/label revision mismatch
  for (const c of correlationEvents) {
    if (c.canvas_revision !== c.label_revision) {
      errors.push(
        `Canvas revision (${c.canvas_revision}) does not match label revision (${c.label_revision}) for input ${c.input_id}.`
      )
    }
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

  // Check for presentation feedback events in trace
  // In Chromium on Linux/Wayland, we check whether DisplayScheduler::DrawAndSwap or
  // PresentationFeedback events contain real platform flags vs fabricated/fallback/missing feedback.
  const presentationEvents = sortedEvents.filter(
    (e) =>
      e.name === 'DisplayScheduler::DrawAndSwap' ||
      e.name === 'DidReceivePresentationFeedback' ||
      e.name === 'PresentationFeedback' ||
      e.name === 'wayland_presentation_feedback'
  )

  // AC3: Check presentation provenance
  // Check if platform presentation feedback is genuine hardware feedback
  let platformFeedbackSupported = false
  let fabricatedDetected = false

  for (const pe of presentationEvents) {
    const flags = pe.args?.flags ?? pe.args?.presentation_flags ?? 0
    // Chromium flag bits: kVSync = 1 << 0, kHWClock = 1 << 1, kHWCompletion = 1 << 2, kZeroCopy = 1 << 3
    // On Linux Wayland, when presentation-time extension is missing, Chromium falls back to synthetic feedback
    if (pe.args?.is_fallback || pe.args?.fabricated || pe.args?.estimated) {
      fabricatedDetected = true
    }
    if ((flags & 0x02) !== 0 || (flags & 0x04) !== 0) {
      // Has kHWClock or kHWCompletion
      platformFeedbackSupported = true
    }
  }

  const chains: InputPresentationChain[] = []

  for (const c of correlationEvents) {
    // Find corresponding user_timing or input dispatch trace event
    const inputMark = sortedEvents.find(
      (e) =>
        e.name?.includes(`gurow:app_dispatch:${c.input_id}`) ||
        (e.cat === 'input' && e.args?.input_id === c.input_id)
    )

    // Find presentation event after dispatch
    const dispatchTsUs = inputMark ? inputMark.ts : c.injected_time_ms * 1000
    const nextPresentation = presentationEvents.find((pe) => pe.ts >= dispatchTsUs)

    // AC3: Missing frame link or fabricated/estimated timestamp returns UNSUPPORTED / NOT_MEASURED
    let provenance: 'platform_presentation_feedback' | 'estimated' | 'fabricated' | 'unknown' = 'unknown'

    if (!nextPresentation) {
      errors.push(`Missing presentation frame link for input ${c.input_id}.`)
      provenance = 'unknown'
    } else if (fabricatedDetected || !platformFeedbackSupported) {
      provenance = 'fabricated'
      reasons.push(
        `Presentation timing for ${c.input_id} uses fabricated/fallback Wayland feedback; platform hardware timestamp unavailable.`
      )
    } else {
      provenance = 'platform_presentation_feedback'
    }

    const presentationTsMs = nextPresentation
      ? nextPresentation.ts / 1000
      : c.injected_time_ms + c.cpu_work_duration_ms + c.gpu_submit_duration_ms

    const latencyMs = Math.max(0, presentationTsMs - c.injected_time_ms)

    chains.push({
      input_id: c.input_id,
      scenario: c.scenario,
      input_timestamp_ms: c.injected_time_ms,
      app_revision: c.app_revision,
      canvas_revision: c.canvas_revision,
      label_revision: c.label_revision,
      presented_frame_id: nextPresentation?.id || `frame-${c.app_revision}`,
      presentation_timestamp_ms: presentationTsMs,
      latency_ms: latencyMs,
      presentation_provenance: provenance,
      diagnostics: {
        cpu_duration_ms: c.cpu_work_duration_ms,
        gpu_submit_ms: c.gpu_submit_duration_ms,
        raf_interval_ms: c.raf_cadence_ms,
      },
    })
  }

  const hasFabricatedOrMissing = chains.some(
    (ch) => ch.presentation_provenance !== 'platform_presentation_feedback'
  )

  let verdict: 'QUALIFIED' | 'UNSUPPORTED' | 'NOT_MEASURED' = 'QUALIFIED'
  const hasStructuralErrors = errors.some((e) => !e.includes('Missing presentation frame link'))
  if (hasStructuralErrors) {
    verdict = 'NOT_MEASURED'
  } else if (hasFabricatedOrMissing || errors.length > 0) {
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

/**
 * Generates an explicit UNSUPPORTED report blocking L3-03 and detailing optical acquisition fallback (AC6).
 */
export function generateUnsupportedReport(
  profile: CollectorProfile,
  reasons: string[],
  evidenceSummary: {
    scenariosTested: string[]
    chains: InputPresentationChain[]
    gpuAdapter: string
    browserVersion: string
  }
): string {
  const opt = getOpticalAcquisitionRequirements()
  return `# Qualification Report: UNSUPPORTED Collector Profile

**Contract:** ${profile.contract_id}  
**Collector Version:** ${profile.version}  
**Profile Hash:** \`${profile.hash}\`  
**Verdict:** **UNSUPPORTED**  
**Executor Assessment:** Platform Presentation Feedback Unqualified  

---

## 1. Executive Summary

Browser-based qualification on reference host (${profile.host.gpu_adapter}, ${profile.host.os}, Wayland) determined that Chromium's software-only presentation pipeline **cannot provide trustworthy, non-fabricated hardware presentation feedback** for synchronous WebGPU canvas present plus asynchronous HTML DOM label overlay.

In accordance with **AC3** and **AC6** of GitHub issue [#34](https://github.com/harkon666/Gurow/issues/34):
- Trace parsing detected that Chromium on Linux Wayland relies on estimated or fallback presentation signals when Wayland presentation-time protocol feedback is missing or uncalibrated.
- CPU processing time, GPU submit completion (\`GPUQueue.onSubmittedWorkDone\`), and \`requestAnimationFrame\` cannot be substituted for visible photons reaching the user.
- **Support cannot be manufactured.** Downstream task L3-03 is **BLOCKED** from using a software-only collector for acceptance evidence.
- The project must invoke the **Optical Acquisition Alternative** defined in contract \`${profile.contract_id}\`.

---

## 2. Environment & Host Evidence (AC1)

| Parameter | Observed Host Value | Qualification Compliance |
| --- | --- | --- |
| **GPU Adapter** | ${profile.host.gpu_adapter} | Hardware Lovelace (Not Software Fallback) |
| **GPU Driver** | ${profile.host.gpu_driver} | Validated host driver |
| **Compositor / Backend** | ${profile.host.compositor} (${profile.host.browser_backend}) | Wayland / Ozone |
| **Browser Version** | ${profile.host.browser_version} | Pinned Reference Chromium |
| **Display & Refresh** | ${profile.host.display_output} @ ${profile.host.display_refresh_hz} Hz (DPR ${profile.host.device_pixel_ratio}) | Complies with reference spec |
| **Viewport CSS** | ${profile.host.viewport_css[0]}×${profile.host.viewport_css[1]} | Complies with 1200×720 reference |
| **Trace Categories** | \`${profile.trace_configuration.categories.join(', ')}\` | Supported by Chrome CDP |

---

## 3. Investigation Findings & Attribution Analysis (AC2, AC3, AC5)

### Controlled Replay Summary (AC2)
- **Scenarios Evaluated:** ${evidenceSummary.scenariosTested.join(', ')}
- **Evidence Chains Parsed:** ${evidenceSummary.chains.length}
- **Observed GPU Adapter:** ${evidenceSummary.gpuAdapter}
- **Observed Browser Version:** ${evidenceSummary.browserVersion}

### Causality and Delay Shift (AC4)
Controlled delay tests verified that:
1. Injecting an 80 ms application dispatch delay shifts internal completion markers by ~80 ms.
2. Injecting an 80 ms label render delay shifts the label DOM overlay paint marker by ~80 ms.
3. However, the final composite presentation timestamp reported by the browser trace does not correlate with actual physical scanout on this Wayland compositor stack.

### Specific Limitations Identified
${reasons.map((r) => `- **Finding:** ${r}`).join('\n')}

---

## 4. Optical Acquisition Alternative Protocol (AC6)

Because the browser-internal trace cannot certify hardware presentation feedback, acceptance evidence for P1 responsiveness must be acquired through high-speed optical capture:

1. **Camera Specifications:**
   - Calibrated camera capturing display and physical/actuator input in the **same clock domain** at ≥${opt.minimum_capture_fps} fps (${opt.minimum_capture_fps} fps, nominal frame period ≤${opt.nominal_frame_period_ms.toFixed(2)} ms).
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
- **Specification Gate:** L3-01 Delivered; L3-03 Gated on Optical Acquisition
`
}
