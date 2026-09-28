import { describe, it, expect } from 'bun:test'
import {
  computeProfileHash,
  validateCollectorProfile,
  parseTraceEvidence,
  verifyControlledDelayShift,
  generateUnsupportedReport,
  type CollectorProfile,
  type TraceEvent,
  type CorrelationEvent,
} from './collector'

function createSampleProfile(overrides: Partial<CollectorProfile> = {}): CollectorProfile {
  const base: Omit<CollectorProfile, 'hash'> = {
    version: 'gurow-collector-v1',
    contract_id: 'gurow-p1-v1',
    status: 'UNSUPPORTED',
    unsupported_reason: 'Wayland presentation feedback uncalibrated',
    host: {
      cpu: '13th Gen Intel Core i5-13500HX',
      logical_cpus: 20,
      physical_memory_bytes: 16462508032,
      os: 'Omarchy 4.0.4',
      kernel: '7.2.5-3-omarchy x86_64',
      gpu_adapter: 'NVIDIA AD107M GeForce RTX 4050 Mobile',
      gpu_driver: '610.57.04',
      is_fallback: false,
      compositor: 'wayland-1',
      display_output: 'eDP-2',
      display_refresh_hz: 165,
      device_pixel_ratio: 1.5,
      viewport_css: [1200, 720],
      browser_executable: '/usr/bin/chromium',
      browser_version: '152.0.7977.82 Arch Linux',
      browser_backend: 'Wayland / Ozone',
    },
    trace_configuration: {
      categories: ['cc', 'viz', 'input', 'benchmark', 'gpu', 'blink.user_timing'],
      parser_version: '1.0.0',
      clock_origin: 'monotonic_kernel',
      clock_units: 'us',
      timestamp_scale_to_ms: 0.001,
    },
    fault_injection: {
      enabled: false,
      app_delay_ms: 0,
      label_delay_ms: 0,
    },
    ...overrides,
  }

  const hash = computeProfileHash(base)
  return { ...base, hash }
}

describe('Collector Profile Validation (AC1, AC4, AC6)', () => {
  it('computes deterministic profile hashes', () => {
    const profile1 = createSampleProfile()
    const profile2 = createSampleProfile()
    expect(profile1.hash).toBe(profile2.hash)
    expect(profile1.hash.length).toBe(64)
  })

  it('rejects software fallback adapters under AC1', () => {
    const fallbackProfile = createSampleProfile()
    fallbackProfile.host.is_fallback = true
    fallbackProfile.hash = computeProfileHash(fallbackProfile)

    const result = validateCollectorProfile(fallbackProfile)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain(
      'Software/fallback adapter cannot be marked qualified (AC1 violation).'
    )
  })

  it('rejects acceptance mode when fault injection is enabled (AC4)', () => {
    const faultProfile = createSampleProfile({
      fault_injection: {
        enabled: true,
        app_delay_ms: 80,
        label_delay_ms: 0,
      },
    })

    const nonAcceptanceResult = validateCollectorProfile(faultProfile, {
      requireAcceptanceMode: false,
    })
    expect(nonAcceptanceResult.valid).toBe(true)

    const acceptanceResult = validateCollectorProfile(faultProfile, {
      requireAcceptanceMode: true,
    })
    expect(acceptanceResult.valid).toBe(false)
    expect(acceptanceResult.errors).toContain(
      'Acceptance mode rejects profiles with fault injection enabled (AC4 violation).'
    )
  })

  it('detects profile tampering or hash mismatches', () => {
    const profile = createSampleProfile()
    profile.host.gpu_driver = 'tampered-driver'
    const result = validateCollectorProfile(profile)
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('Profile hash mismatch')
  })
})

describe('Parser Checks and Failure Rejections (AC5)', () => {
  const profile = createSampleProfile()

  it('rejects empty trace arrays', () => {
    const result = parseTraceEvidence([], [], profile)
    expect(result.valid).toBe(false)
    expect(result.verdict).toBe('NOT_MEASURED')
    expect(result.errors).toContain('Trace events array is empty.')
  })

  it('rejects negative or malformed timestamps', () => {
    const traceEvents: TraceEvent[] = [
      { cat: 'input', name: 'MouseEvent', ts: -500, ph: 'X' },
    ]
    const correlation: CorrelationEvent[] = [
      {
        input_id: 'in-1',
        scenario: 'pan',
        scheduled_time_ms: 1000,
        injected_time_ms: 1000,
        app_revision: 1,
        canvas_revision: 1,
        label_revision: 1,
        cpu_work_duration_ms: 2,
        gpu_submit_duration_ms: 1,
        raf_cadence_ms: 6.06,
      },
    ]

    const result = parseTraceEvidence(traceEvents, correlation, profile)
    expect(result.valid).toBe(false)
    expect(result.verdict).toBe('NOT_MEASURED')
    expect(result.errors.some((e) => e.includes('Negative timestamp'))).toBe(true)
  })

  it('rejects duplicate input IDs', () => {
    const traceEvents: TraceEvent[] = [
      { cat: 'input', name: 'MouseEvent', ts: 1000000, ph: 'X' },
      { cat: 'viz', name: 'DisplayScheduler::DrawAndSwap', ts: 1010000, ph: 'X' },
    ]
    const correlation: CorrelationEvent[] = [
      {
        input_id: 'dup-1',
        scenario: 'pan',
        scheduled_time_ms: 1000,
        injected_time_ms: 1000,
        app_revision: 1,
        canvas_revision: 1,
        label_revision: 1,
        cpu_work_duration_ms: 2,
        gpu_submit_duration_ms: 1,
        raf_cadence_ms: 6.06,
      },
      {
        input_id: 'dup-1', // duplicate!
        scenario: 'pan',
        scheduled_time_ms: 1008,
        injected_time_ms: 1008,
        app_revision: 2,
        canvas_revision: 2,
        label_revision: 2,
        cpu_work_duration_ms: 2,
        gpu_submit_duration_ms: 1,
        raf_cadence_ms: 6.06,
      },
    ]

    const result = parseTraceEvidence(traceEvents, correlation, profile)
    expect(result.valid).toBe(false)
    expect(result.verdict).toBe('NOT_MEASURED')
    expect(result.errors.some((e) => e.includes('Duplicate input ID detected'))).toBe(true)
  })

  it('rejects canvas and label revision mismatches', () => {
    const traceEvents: TraceEvent[] = [
      { cat: 'input', name: 'MouseEvent', ts: 1000000, ph: 'X' },
      { cat: 'viz', name: 'DisplayScheduler::DrawAndSwap', ts: 1010000, ph: 'X' },
    ]
    const correlation: CorrelationEvent[] = [
      {
        input_id: 'mismatch-1',
        scenario: 'zoom',
        scheduled_time_ms: 1000,
        injected_time_ms: 1000,
        app_revision: 5,
        canvas_revision: 5,
        label_revision: 4, // mismatch!
        cpu_work_duration_ms: 2,
        gpu_submit_duration_ms: 1,
        raf_cadence_ms: 6.06,
      },
    ]

    const result = parseTraceEvidence(traceEvents, correlation, profile)
    expect(result.valid).toBe(false)
    expect(result.verdict).toBe('NOT_MEASURED')
    expect(result.errors.some((e) => e.includes('does not match label revision'))).toBe(true)
  })
})

describe('Separation of Diagnostics and Provenance (AC2, AC3, AC6)', () => {
  const profile = createSampleProfile()

  it('marks evidence UNSUPPORTED when presentation feedback is fabricated/estimated', () => {
    const traceEvents: TraceEvent[] = [
      { cat: 'blink.user_timing', name: 'gurow:app_dispatch:in-101:1', ts: 1000000, ph: 'R' },
      {
        cat: 'viz',
        name: 'DisplayScheduler::DrawAndSwap',
        ts: 1015000,
        ph: 'X',
        args: { fabricated: true, is_fallback: true },
      },
    ]
    const correlation: CorrelationEvent[] = [
      {
        input_id: 'in-101',
        scenario: 'pan',
        scheduled_time_ms: 1000,
        injected_time_ms: 1000,
        app_revision: 1,
        canvas_revision: 1,
        label_revision: 1,
        cpu_work_duration_ms: 4.5,
        gpu_submit_duration_ms: 1.2,
        raf_cadence_ms: 6.06,
      },
    ]

    const result = parseTraceEvidence(traceEvents, correlation, profile)
    expect(result.valid).toBe(true)
    expect(result.verdict).toBe('UNSUPPORTED')
    expect(result.chains.length).toBe(1)
    expect(result.chains[0].presentation_provenance).toBe('fabricated')
    expect(result.chains[0].diagnostics.cpu_duration_ms).toBe(4.5)
    expect(result.chains[0].diagnostics.gpu_submit_ms).toBe(1.2)
  })

  it('marks evidence QUALIFIED when verified platform presentation feedback is present', () => {
    const traceEvents: TraceEvent[] = [
      { cat: 'blink.user_timing', name: 'gurow:app_dispatch:in-201:1', ts: 1000000, ph: 'R' },
      {
        cat: 'viz',
        name: 'DisplayScheduler::DrawAndSwap',
        ts: 1016000,
        ph: 'X',
        // flags: kHWClock | kHWCompletion = 0x02 | 0x04 = 0x06
        args: { flags: 0x06, is_fallback: false },
      },
    ]
    const correlation: CorrelationEvent[] = [
      {
        input_id: 'in-201',
        scenario: 'drag',
        scheduled_time_ms: 1000,
        injected_time_ms: 1000,
        app_revision: 1,
        canvas_revision: 1,
        label_revision: 1,
        cpu_work_duration_ms: 3.2,
        gpu_submit_duration_ms: 0.8,
        raf_cadence_ms: 6.06,
      },
    ]

    const result = parseTraceEvidence(traceEvents, correlation, profile)
    expect(result.valid).toBe(true)
    expect(result.verdict).toBe('QUALIFIED')
    expect(result.chains[0].presentation_provenance).toBe('platform_presentation_feedback')
    expect(result.chains[0].latency_ms).toBe(16)
  })
})

describe('Controlled Delay Shift Verification (AC4)', () => {
  it('passes when 80ms delay shifts the attributed endpoint by ~80ms', () => {
    const baselineLatency = 14.5
    const delayedAppLatency = 95.2 // shift ~80.7 ms
    const check = verifyControlledDelayShift(baselineLatency, delayedAppLatency, 80, 25)
    expect(check.pass).toBe(true)
    expect(check.shiftMs).toBeCloseTo(80.7, 1)
  })

  it('fails when delay does not shift the attributed endpoint', () => {
    const baselineLatency = 14.5
    const unresponsiveLatency = 15.0 // did not shift!
    const check = verifyControlledDelayShift(baselineLatency, unresponsiveLatency, 80, 25)
    expect(check.pass).toBe(false)
  })
})

describe('Explicit Unsupported Report Generation (AC6)', () => {
  it('generates markdown report with optical acquisition requirements and blocks L3-03', () => {
    const profile = createSampleProfile()
    const reasons = [
      'Chromium Wayland presentation-time protocol is unsupported or fabricated by ozone/wayland_frame_manager.cc.',
    ]
    const report = generateUnsupportedReport(profile, reasons, {
      scenariosTested: ['pan', 'zoom', 'drag'],
      chains: [],
      gpuAdapter: profile.host.gpu_adapter,
      browserVersion: profile.host.browser_version,
    })

    expect(report).toContain('# Qualification Report: UNSUPPORTED Collector Profile')
    expect(report).toContain('**Verdict:** **UNSUPPORTED**')
    expect(report).toContain('L3-03 is **BLOCKED**')
    expect(report).toContain('Optical Acquisition Alternative Protocol')
    expect(report).toContain('240 fps')
    expect(report).toContain('[\\max(0, c - b), d - a]')
  })
})
