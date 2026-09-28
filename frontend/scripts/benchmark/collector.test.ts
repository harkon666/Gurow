import { describe, it, expect } from 'bun:test'
import {
  computeProfileHash,
  deriveClockMapping,
  validateCollectorProfile,
  parseTraceEvidence,
  verifyControlledDelayShift,
  generateQualificationReport,
  getOpticalAcquisitionRequirements,
  UNKNOWN,
  GUROW_INPUT_COALESCING,
  isSoftwareAdapter,
  type ClockMapping,
  type CollectorProfile,
  type CorrelationEvent,
  type DelayCheckResult,
  type TraceEvent,
} from './collector'

import { finalizeQualification } from './qualification'

const RESOLVED_CLOCK_MAPPING: ClockMapping = {
  trace_clock: 'chromium_trace_monotonic',
  page_clock: 'performance_now_ms',
  trace_to_page_offset_ms: 0,
  offset_spread_ms: 0.4,
  sample_count: 5,
  method: 'test fixture',
}

function createSampleProfile(overrides: Partial<CollectorProfile> = {}): CollectorProfile {
  const base: Omit<CollectorProfile, 'hash'> = {
    version: 'gurow-collector-v3',
    contract_id: 'gurow-p1-v1',
    status: 'UNSUPPORTED',
    unsupported_reason: 'Wayland presentation feedback uncalibrated',
    identity: {
      commit: '32121f95feba7cfac3a5dd3e8c4ed066c618a227',
      tree_dirty: false,
      build_hash: 'a'.repeat(64),
      source_fingerprint: 'b'.repeat(64),
    },
    host: {
      cpu: '13th Gen Intel Core i5-13500HX',
      logical_cpus: 20,
      physical_memory_bytes: 16462508032,
      os: 'Omarchy 4.0.4',
      kernel: '7.2.5-3-omarchy x86_64',
      gpu_adapter: 'nvidia / lovelace',
      gpu_driver: '610.57.04',
      is_fallback: false,
      compositor: 'Hyprland 0.56.2',
      browser_command_line: ['/usr/bin/chromium', '--ozone-platform=wayland'],
      native_window: {
        headed: true, device_metrics_emulated: false,
        x: 0, y: 26, width: 1220, height: 750,
        screen_width: 1280, screen_height: 800,
        available_x: 0, available_y: 26, available_width: 1280, available_height: 774,
        visual_viewport_scale: 1, document_visible: true, focused: true,
        canvas_unobscured: true, labels_visible: true, skill_list_visible: true, task_panel_visible: true,
      },
      display_output: 'eDP-2',
      display_refresh_hz: 165,
      device_pixel_ratio: 1.5,
      viewport_css: [1200, 720],
      canvas_geometry: {
        css_bounds: { x: 0, y: 48, width: 1200, height: 672 },
        backing_size: { width: 1800, height: 1008 },
      },
      browser_executable: '/usr/bin/chromium',
      browser_version: '152.0.7977.82 Arch Linux',
      browser_backend: 'Wayland / Ozone',
    },
    trace_configuration: {
      categories: ['cc', 'viz', 'input', 'benchmark', 'gpu', 'blink.user_timing'],
      parser_version: '3.0.0',
      clock_origin: 'chromium_trace_monotonic',
      clock_units: 'us',
      timestamp_scale_to_ms: 0.001,
      clock_mapping: RESOLVED_CLOCK_MAPPING,
    },
    fault_injection: {
      enabled: false,
      app_delay_ms: 0,
      label_delay_ms: 0,
      app_delays_applied: 4,
      label_delays_applied: 2,
    },
    input_coalescing: GUROW_INPUT_COALESCING,
    geometry_class: 'reference',
    ...overrides,
  }

  const hash = computeProfileHash(base)
  return { ...base, hash }
}

function createCorrelation(overrides: Partial<CorrelationEvent> = {}): CorrelationEvent {
  return {
    input_id: 'in-1',
    scenario: 'pan',
    coalesced_input_ids: [],
    input_origin_ms: 1000,
    app_revision: 1,
    canvas_revision: 1,
    label_revision_at_dispatch: 0,
    label_revision: 1,
    label_commit_app_revision: 1,
    label_commit_ms: 1002,
    cpu_work_duration_ms: 2,
    gpu_submit_duration_ms: null,
    raf_cadence_ms: 6.06,
    ...overrides,
  }
}

/** Synthetic qualification-schema evidence, NOT fields emitted by Chromium.
 * Contract §6 requires both rendered revisions in the same identified frame and
 * an actual hardware presentation timestamp, not DrawAndSwap submission.
 */
function hardwarePresentationTrace(inputId: string, canvasRevision: number): TraceEvent[] {
  return [
    {
      cat: 'blink.user_timing',
      name: `gurow:app_dispatch:${inputId}:${canvasRevision}`,
      ts: 1_000_000,
      ph: 'R',
      pid: 1,
      tid: 1,
    },
    {
      cat: 'viz',
      name: 'PresentationFeedback',
      ts: 1_016_000,
      ph: 'X',
      pid: 1,
      tid: 2,
      id: 'swap-7',
      args: {
        flags: 0x06, is_fallback: false, canvas_revision: canvasRevision,
        label_revision: 1, label_commit_app_revision: canvasRevision,
        presentation_timestamp: 1_016_000,
      },
    },
  ]
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
        enabled: true, app_delay_ms: 80, label_delay_ms: 0,
        app_delays_applied: 6, label_delays_applied: 0,
      },
    })

    expect(validateCollectorProfile(faultProfile, { requireAcceptanceMode: false }).valid).toBe(true)

    const acceptanceResult = validateCollectorProfile(faultProfile, { requireAcceptanceMode: true })
    expect(acceptanceResult.valid).toBe(false)
    expect(acceptanceResult.errors).toContain(
      'Acceptance mode rejects profiles with fault injection enabled (AC4 violation).'
    )
  })

  it('rejects a profile still carrying injected delays in acceptance mode (AC4)', () => {
    // A profile can claim `enabled: false` while the page was read back with a
    // delay still set; the recorded delays themselves must fail acceptance.
    const stillInjecting = createSampleProfile({
      fault_injection: {
        enabled: false, app_delay_ms: 80, label_delay_ms: 0,
        app_delays_applied: 6, label_delays_applied: 0,
      },
    })

    expect(validateCollectorProfile(stillInjecting).valid).toBe(true)
    const acceptance = validateCollectorProfile(stillInjecting, { requireAcceptanceMode: true })
    expect(acceptance.valid).toBe(false)
    expect(acceptance.errors).toContain(
      'Acceptance mode rejects a profile still carrying injected delays (AC4 violation).'
    )
  })

  it('qualifies a collector on a non-reference window but refuses acceptance on it', () => {
    // The tiling desktop lays the window out; the evidence chain does not depend
    // on its size, but an acceptance series does (contract §3).
    const tiled = createSampleProfile({ geometry_class: 'qualification_only' })
    tiled.host.viewport_css = [621, 694]
    tiled.host.canvas_geometry = {
      css_bounds: { x: 0, y: 48, width: 621, height: 646 },
      backing_size: { width: 932, height: 969 },
    }
    tiled.host.native_window!.width = 621
    tiled.host.native_window!.height = 750
    const { hash: _hash, ...base } = tiled
    tiled.hash = computeProfileHash(base)

    // Collector mode: every other publication gate still applies.
    expect(validateCollectorProfile(tiled, {
      requireAcceptanceMode: true, requireReferenceGeometry: false,
    })).toEqual({ valid: true, errors: [] })

    const acceptance = validateCollectorProfile(tiled, {
      requireAcceptanceMode: true, requireReferenceGeometry: true,
    })
    expect(acceptance.valid).toBe(false)
    expect(acceptance.errors).toContain(
      'Acceptance requires the reference window geometry; this profile is qualification-only (contract §3).'
    )
  })

  it('holds a profile claiming reference geometry to it in every mode', () => {
    // The weaker mode must not become a way to publish a reference-looking
    // profile that never stood on the reference window.
    const claimed = createSampleProfile({ geometry_class: 'reference' })
    claimed.host.viewport_css = [621, 694]
    const { hash: _hash, ...base } = claimed
    claimed.hash = computeProfileHash(base)

    for (const options of [{}, { requireAcceptanceMode: true }] as const) {
      const result = validateCollectorProfile(claimed, options)
      expect(result.valid).toBe(false)
      expect(result.errors).toContain('Actual headed viewport must be 1200×720 CSS pixels (contract §3).')
    }
  })

  it('requires the collector to declare its own coalescing rule (contract §6)', () => {
    const invented = createSampleProfile({
      input_coalescing: {
        rule_id: 'reducer-invented-v0',
        attributed_origin: 'newest_input',
        description: 'Grouping decided after seeing the numbers.',
      },
    })

    const result = validateCollectorProfile(invented)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes(GUROW_INPUT_COALESCING.rule_id))).toBe(true)
  })

  it('rejects a software renderer even when the fallback flag is unset (AC1)', () => {
    // Observed on the reference host: launching Chromium with only
    // --enable-unsafe-webgpu reports vendor 'google', architecture
    // 'swiftshader' and isFallbackAdapter === false.
    const swiftshader = createSampleProfile()
    swiftshader.host.gpu_adapter = 'google / swiftshader'
    swiftshader.host.is_fallback = false
    swiftshader.hash = computeProfileHash(swiftshader)

    const result = validateCollectorProfile(swiftshader)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('is a software renderer'))).toBe(true)
  })

  it('identifies known software renderers by name', () => {
    expect(isSoftwareAdapter('google / swiftshader')).toBe(true)
    expect(isSoftwareAdapter('Mesa llvmpipe (LLVM 17)')).toBe(true)
    expect(isSoftwareAdapter('lavapipe')).toBe(true)
    expect(isSoftwareAdapter('nvidia / lovelace')).toBe(false)
    expect(isSoftwareAdapter('Intel / gen-12lp')).toBe(false)
  })

  it('rejects an unknown adapter or driver in acceptance mode (AC1)', () => {
    const unknownHost = createSampleProfile()
    unknownHost.host.gpu_adapter = UNKNOWN
    unknownHost.host.gpu_driver = UNKNOWN
    unknownHost.hash = computeProfileHash(unknownHost)

    const result = validateCollectorProfile(unknownHost, { requireAcceptanceMode: true })
    expect(result.valid).toBe(false)
    expect(
      result.errors.some((e) => e.includes('Actual GPU adapter is unknown'))
    ).toBe(true)
    expect(result.errors.some((e) => e.includes('Actual GPU driver is unknown'))).toBe(true)
  })

  it('rejects unobserved headed geometry in acceptance mode (AC1)', () => {
    const noGeometry = createSampleProfile()
    noGeometry.host.device_pixel_ratio = null
    noGeometry.host.viewport_css = null
    noGeometry.host.canvas_geometry = null
    noGeometry.host.display_refresh_hz = null
    noGeometry.hash = computeProfileHash(noGeometry)

    const result = validateCollectorProfile(noGeometry, { requireAcceptanceMode: true })
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Device pixel ratio was not read from the live page (AC1).')
    expect(result.errors).toContain('Actual headed viewport was not recorded (AC1).')
    expect(result.errors).toContain('Canvas CSS and backing geometry were not recorded (AC1).')
    expect(result.errors).toContain('Display refresh rate was not observed (AC1).')
  })

  it('rejects a profile whose clock mapping was never established (AC1)', () => {
    const noMapping = createSampleProfile()
    noMapping.trace_configuration.clock_mapping = {
      ...RESOLVED_CLOCK_MAPPING,
      trace_to_page_offset_ms: null,
      offset_spread_ms: null,
      sample_count: 0,
    }
    noMapping.hash = computeProfileHash(noMapping)

    const result = validateCollectorProfile(noMapping)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Trace/page clock mapping was not established (AC1).')
  })

  it('rejects a clock mapping whose samples disagree too widely (AC1)', () => {
    const noisy = createSampleProfile()
    noisy.trace_configuration.clock_mapping = {
      ...RESOLVED_CLOCK_MAPPING,
      offset_spread_ms: 42,
    }
    noisy.hash = computeProfileHash(noisy)

    const result = validateCollectorProfile(noisy)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('mapping is unusable'))).toBe(true)
  })

  it('detects profile tampering or hash mismatches', () => {
    const profile = createSampleProfile()
    profile.host.gpu_driver = 'tampered-driver'
    const result = validateCollectorProfile(profile)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('Profile hash mismatch'))).toBe(true)
  })
})

describe('Reference environment acceptance gates', () => {
  it('allows one physical pixel of flooring plus DOMRect floating-point noise, not two', () => {
    const profile = createSampleProfile()
    // Actual native DPR-1.5 observation: ResizeObserver layout floors to 814×885,
    // while getBoundingClientRect snaps to 815.000061×886.000031 physical pixels.
    profile.host.canvas_geometry = {
      css_bounds: { x: 304.66668701171875, y: 104.33333587646484, width: 543.3333740234375, height: 590.6666870117188 },
      backing_size: { width: 814, height: 885 },
    }
    const { hash: _hash, ...hashInput } = profile
    profile.hash = computeProfileHash(hashInput)
    expect(validateCollectorProfile(profile, { requireAcceptanceMode: true })).toEqual({ valid: true, errors: [] })
    profile.host.canvas_geometry.backing_size.width = 813
    profile.hash = computeProfileHash(hashInput)
    expect(validateCollectorProfile(profile, { requireAcceptanceMode: true }).errors).toContain(
      'Canvas backing size does not match observed CSS size × native DPR (contract §3).'
    )
  })
  for (const defect of ['clipped-canvas', 'wrong-dpr', 'wrong-viewport', 'backing-size',
    'obscured', 'emulated', 'offscreen-window', 'missing-native', 'browser-version',
    'browser-backend', 'compositor', 'socket-as-compositor', 'dirty-fingerprint'] as const) {
    it(`rejects ${defect} before final qualification`, () => {
      const profile = createSampleProfile()
      if (defect === 'clipped-canvas') { profile.host.canvas_geometry!.css_bounds.y = 210.3333; profile.host.canvas_geometry!.css_bounds.height = 590.6667 }
      if (defect === 'wrong-dpr') profile.host.device_pixel_ratio = 1
      if (defect === 'wrong-viewport') profile.host.viewport_css![0] = 1199
      if (defect === 'backing-size') profile.host.canvas_geometry!.backing_size.width = 1
      if (defect === 'obscured') profile.host.native_window!.canvas_unobscured = false
      if (defect === 'emulated') profile.host.native_window!.device_metrics_emulated = true
      if (defect === 'offscreen-window') profile.host.native_window!.height = 900
      if (defect === 'missing-native') profile.host.native_window = null
      if (defect === 'browser-version') profile.host.browser_version = UNKNOWN
      if (defect === 'browser-backend') profile.host.browser_backend = UNKNOWN
      if (defect === 'compositor') profile.host.compositor = UNKNOWN
      if (defect === 'socket-as-compositor') profile.host.compositor = 'wayland-1'
      if (defect === 'dirty-fingerprint') { profile.identity.tree_dirty = true; profile.identity.source_fingerprint = UNKNOWN }
      const { hash: _hash, ...base } = profile
      profile.hash = computeProfileHash(base)
      expect(validateCollectorProfile(profile, { requireAcceptanceMode: true }).valid).toBe(false)
      const parsed = parseTraceEvidence(hardwarePresentationTrace('in-1', 1), [createCorrelation()], profile)
      parsed.chains = (['pan', 'zoom', 'drag'] as const).map((scenario) => ({ ...parsed.chains[0], scenario }))
      const result = finalizeQualification({ profile, parsed,
        appDelayCheck: verifyControlledDelayShift(16, 96, 80),
        labelDelayCheck: verifyControlledDelayShift(16, 96, 80), invalidRunReasons: [] })
      expect(result.profile.status).toBe('NOT_MEASURED')
      expect(result.failures.length).toBeGreaterThan(0)
    })
  }
})

describe('Clock mapping derivation (AC1)', () => {
  it('derives the median offset from paired sync marks', () => {
    const trace: TraceEvent[] = [
      { name: 'gurow:clock_sync:0', ts: 5_000_000, ph: 'R', pid: 1, tid: 1 },
      { name: 'gurow:clock_sync:1', ts: 5_020_000, ph: 'R', pid: 1, tid: 1 },
      { name: 'gurow:clock_sync:2', ts: 5_040_000, ph: 'R', pid: 1, tid: 1 },
    ]
    const syncs = [
      { index: 0, page_now_ms: 1000 },
      { index: 1, page_now_ms: 1020 },
      { index: 2, page_now_ms: 1040 },
    ]

    const mapping = deriveClockMapping(trace, syncs, 'us')
    expect(mapping.sample_count).toBe(3)
    expect(mapping.trace_to_page_offset_ms).toBe(4000)
    expect(mapping.offset_spread_ms).toBe(0)
  })

  it('reports an unresolved mapping when no sync mark reached the trace', () => {
    const mapping = deriveClockMapping([{ name: 'other', ts: 1000, pid: 1, tid: 1 }], [
      { index: 0, page_now_ms: 10 },
    ], 'us')
    expect(mapping.trace_to_page_offset_ms).toBeNull()
    expect(mapping.sample_count).toBe(0)
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
    const result = parseTraceEvidence(
      [{ cat: 'input', name: 'MouseEvent', ts: -500, ph: 'X', pid: 1, tid: 1 }],
      [createCorrelation()],
      profile
    )
    expect(result.valid).toBe(false)
    expect(result.verdict).toBe('NOT_MEASURED')
    expect(result.errors.some((e) => e.includes('Negative timestamp'))).toBe(true)
  })

  it('rejects misordered timestamps within one thread instead of sorting them away', () => {
    const result = parseTraceEvidence(
      [
        { cat: 'viz', name: 'DrawFrame', ts: 2_000_000, ph: 'X', pid: 1, tid: 1 },
        { cat: 'viz', name: 'DrawFrame', ts: 1_000_000, ph: 'X', pid: 1, tid: 1 },
      ],
      [createCorrelation()],
      profile
    )
    expect(result.valid).toBe(false)
    expect(result.verdict).toBe('NOT_MEASURED')
    expect(result.errors.some((e) => e.includes('Misordered timestamp'))).toBe(true)
  })

  it('accepts interleaving across different threads', () => {
    const result = parseTraceEvidence(
      [
        { cat: 'viz', name: 'DrawFrame', ts: 2_000_000, ph: 'X', pid: 1, tid: 1 },
        { cat: 'viz', name: 'DrawFrame', ts: 1_000_000, ph: 'X', pid: 1, tid: 2 },
      ],
      [createCorrelation()],
      profile
    )
    expect(result.errors.some((e) => e.includes('Misordered timestamp'))).toBe(false)
  })

  it('accepts out-of-order async and flow phases, which Chromium emits normally', () => {
    // Verified against a real 75,860-event trace: 'b','e','s','f','n' phases
    // interleave against complete events, while 'I'/'R'/'X' stay monotonic.
    const result = parseTraceEvidence(
      [
        { cat: 'viz', name: 'TileManager::Check', ts: 8_521_298_329, ph: 'X', pid: 1, tid: 1 },
        { cat: 'viz', name: 'Graphics.Pipeline', ts: 8_518_266_875, ph: 's', pid: 1, tid: 1 },
        { cat: 'viz', name: 'LayerTreeHostImpl::Commit', ts: 8_518_329_665, ph: 'f', pid: 1, tid: 1 },
      ],
      [createCorrelation()],
      profile
    )
    expect(result.errors.some((e) => e.includes('Misordered timestamp'))).toBe(false)
  })

  it('rejects a declared clock unit that disagrees with its scale', () => {
    const wrongScale = createSampleProfile()
    wrongScale.trace_configuration.timestamp_scale_to_ms = 1
    wrongScale.hash = computeProfileHash(wrongScale)

    const result = parseTraceEvidence(
      [{ cat: 'viz', name: 'DrawFrame', ts: 1_000_000, ph: 'X', pid: 1, tid: 1 }],
      [createCorrelation()],
      wrongScale
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('disagree with timestamp scale'))).toBe(true)
  })

  it('rejects duplicate input IDs', () => {
    const result = parseTraceEvidence(
      [{ cat: 'viz', name: 'DrawFrame', ts: 1_000_000, ph: 'X', pid: 1, tid: 1 }],
      [createCorrelation({ input_id: 'dup-1' }), createCorrelation({ input_id: 'dup-1' })],
      profile
    )
    expect(result.valid).toBe(false)
    expect(result.verdict).toBe('NOT_MEASURED')
    expect(result.errors.some((e) => e.includes('Duplicate input ID detected'))).toBe(true)
  })

  it('rejects a label commit that never observed the dispatched revision', () => {
    const result = parseTraceEvidence(
      [{ cat: 'viz', name: 'DrawFrame', ts: 1_000_000, ph: 'X', pid: 1, tid: 1 }],
      [createCorrelation({ app_revision: 5, canvas_revision: 5, label_commit_app_revision: 4 })],
      profile
    )
    expect(result.valid).toBe(false)
    expect(result.verdict).toBe('NOT_MEASURED')
    expect(result.errors.some((e) => e.includes('predates the dispatched revision'))).toBe(true)
  })

  it('rejects label evidence that moved backwards', () => {
    const result = parseTraceEvidence(
      [{ cat: 'viz', name: 'DrawFrame', ts: 1_000_000, ph: 'X', pid: 1, tid: 1 }],
      [createCorrelation({ label_revision_at_dispatch: 7, label_revision: 3 })],
      profile
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('moved backwards'))).toBe(true)
  })

  it('accepts independent label counters only for the exact presented canvas state', () => {
    // Contract §6: label counter 1 may depict app/canvas 3. This proves only
    // revision 3, not superseded canvases 1/2; their grouping needs separate proof.
    const result = parseTraceEvidence(
      hardwarePresentationTrace('in-1', 3),
      [
        createCorrelation({
          input_id: 'in-1',
          app_revision: 3,
          canvas_revision: 3,
          label_revision_at_dispatch: 0,
          label_revision: 1,
          label_commit_app_revision: 3,
        }),
      ],
      profile
    )
    expect(result.errors).toHaveLength(0)
    expect(result.verdict).toBe('QUALIFIED')
  })

  it('rejects an input whose label overlay never committed', () => {
    const result = parseTraceEvidence(
      [{ cat: 'viz', name: 'DrawFrame', ts: 1_000_000, ph: 'X', pid: 1, tid: 1 }],
      [createCorrelation({ label_revision: null })],
      profile
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('Label overlay never committed'))).toBe(true)
  })

  it('refuses to compare clocks when the mapping is unresolved', () => {
    const noMapping = createSampleProfile()
    noMapping.trace_configuration.clock_mapping = {
      ...RESOLVED_CLOCK_MAPPING,
      trace_to_page_offset_ms: null,
    }
    noMapping.hash = computeProfileHash(noMapping)

    const result = parseTraceEvidence(
      hardwarePresentationTrace('in-1', 1),
      [createCorrelation()],
      noMapping
    )
    expect(result.valid).toBe(false)
    expect(result.verdict).toBe('NOT_MEASURED')
    expect(result.errors.some((e) => e.includes('share no origin'))).toBe(true)
  })
})

describe('Separation of Diagnostics and Presentation (AC2, AC3)', () => {
  const profile = createSampleProfile()

  it('never synthesises an endpoint when no presentation event exists', () => {
    const result = parseTraceEvidence(
      [
        {
          cat: 'blink.user_timing',
          name: 'gurow:app_dispatch:in-1:1',
          ts: 1_000_000,
          ph: 'R',
          pid: 1,
          tid: 1,
        },
      ],
      [createCorrelation({ cpu_work_duration_ms: 4.5, gpu_submit_duration_ms: 1.2 })],
      profile
    )

    expect(result.verdict).toBe('UNSUPPORTED')
    expect(result.chains).toHaveLength(1)
    const chain = result.chains[0]
    expect(chain.presentation_provenance).toBe('missing')
    expect(chain.frame_link).toBe('none')
    // CPU + submit must never be added up into a presentation timestamp.
    expect(chain.presentation_timestamp_ms).toBeNull()
    expect(chain.latency_ms).toBeNull()
    expect(chain.presented_frame_id).toBeNull()
    // The diagnostics survive, but only as diagnostics.
    expect(chain.diagnostics.cpu_duration_ms).toBe(4.5)
    expect(chain.diagnostics.gpu_submit_ms).toBe(1.2)
  })

  it('marks a merely subsequent paint as unrelated rather than qualifying it', () => {
    const trace: TraceEvent[] = [
      {
        cat: 'blink.user_timing',
        name: 'gurow:app_dispatch:in-1:1',
        ts: 1_000_000,
        ph: 'R',
        pid: 1,
        tid: 1,
      },
      {
        cat: 'viz',
        name: 'DisplayScheduler::DrawAndSwap',
        ts: 1_016_000,
        ph: 'X',
        pid: 1,
        tid: 2,
        id: 'swap-1',
        // Hardware flags, but nothing tying it to canvas revision 1.
        args: { flags: 0x06, is_fallback: false },
      },
    ]

    const result = parseTraceEvidence(trace, [createCorrelation()], profile)
    expect(result.verdict).toBe('UNSUPPORTED')
    expect(result.chains[0].frame_link).toBe('temporal_next_paint')
    expect(result.chains[0].presentation_provenance).toBe('unrelated_next_paint')
    expect(result.chains[0].presentation_timestamp_ms).toBeNull()
    expect(result.chains[0].presented_frame_id).toBeNull()
    expect(result.chains[0].latency_ms).toBeNull()
  })

  it('marks fabricated or fallback feedback as unqualified', () => {
    const trace: TraceEvent[] = [
      {
        cat: 'blink.user_timing',
        name: 'gurow:app_dispatch:in-1:1',
        ts: 1_000_000,
        ph: 'R',
        pid: 1,
        tid: 1,
      },
      {
        cat: 'viz',
        name: 'DisplayScheduler::DrawAndSwap',
        ts: 1_015_000,
        ph: 'X',
        pid: 1,
        tid: 2,
        args: { fabricated: true, is_fallback: true, canvas_revision: 1 },
      },
    ]

    const result = parseTraceEvidence(trace, [createCorrelation()], profile)
    expect(result.verdict).toBe('UNSUPPORTED')
    expect(result.chains[0].presentation_provenance).toBe('fabricated')
    expect(result.chains[0].presentation_timestamp_ms).toBeNull()
    expect(result.chains[0].presented_frame_id).toBeNull()
    expect(result.chains[0].latency_ms).toBeNull()
  })

  it('qualifies only a revision-matched chain with hardware feedback', () => {
    const result = parseTraceEvidence(
      hardwarePresentationTrace('in-1', 1),
      [createCorrelation()],
      profile
    )

    expect(result.valid).toBe(true)
    expect(result.verdict).toBe('QUALIFIED')
    expect(result.chains[0].frame_link).toBe('revision_matched')
    expect(result.chains[0].presentation_provenance).toBe('platform_presentation_feedback')
    expect(result.chains[0].presented_frame_id).toBe('swap-7')
    // 1_016_000 us -> 1016 ms page clock (offset 0), input origin 1000 ms.
    expect(result.chains[0].latency_ms).toBe(16)
  })

  for (const defect of ['canvas-only', 'missing-frame', 'blank-frame', 'late-label',
    'missing-label-time', 'new-labels-old-canvas', 'submission-only', 'missing-dispatch',
    'dispatch-after-commit', 'dispatch-after-presentation', 'missing-presentation-time',
    'hw-clock-only', 'hw-completion-only'] as const) {
    it(`withholds public endpoints for ${defect}`, () => {
      const trace = hardwarePresentationTrace('in-1', 1)
      const correlation = createCorrelation()
      const feedback = trace[1]
      if (defect === 'canvas-only') delete feedback.args!.label_revision
      if (defect === 'missing-frame') delete feedback.id
      if (defect === 'blank-frame') feedback.id = ' '
      if (defect === 'late-label') correlation.label_commit_ms = 1017
      if (defect === 'missing-label-time') correlation.label_commit_ms = null
      if (defect === 'new-labels-old-canvas') correlation.label_commit_app_revision = 2
      if (defect === 'submission-only') feedback.name = 'DisplayScheduler::DrawAndSwap'
      if (defect === 'missing-dispatch') trace.shift()
      if (defect === 'dispatch-after-commit') trace[0].ts = 1_003_000
      if (defect === 'dispatch-after-presentation') trace[0].ts = 1_020_000
      if (defect === 'missing-presentation-time') delete feedback.args!.presentation_timestamp
      if (defect === 'hw-clock-only') feedback.args!.flags = 0x02
      if (defect === 'hw-completion-only') feedback.args!.flags = 0x04
      const result = parseTraceEvidence(trace, [correlation], profile)
      expect(result.verdict).not.toBe('QUALIFIED')
      for (const chain of result.chains) {
        expect(chain.presentation_timestamp_ms).toBeNull()
        expect(chain.presented_frame_id).toBeNull()
        expect(chain.latency_ms).toBeNull()
      }
      expect([...result.errors, ...result.reasons].length).toBeGreaterThan(0)
    })
  }

  for (const provenance of ['fabricated', 'unrelated'] as const) {
    it(`cannot pass an 80 ms delay using ${provenance} endpoints`, () => {
      const baseline = hardwarePresentationTrace('in-1', 1)
      if (provenance === 'fabricated') baseline[1].args!.fabricated = true
      else baseline[1].args!.canvas_revision = 99
      const delayed = structuredClone(baseline)
      delayed[1].ts += 80_000
      delayed[1].args!.presentation_timestamp = 1_096_000
      const before = parseTraceEvidence(baseline, [createCorrelation()], profile)
      const after = parseTraceEvidence(delayed, [createCorrelation()], profile)
      const check = verifyControlledDelayShift(before.chains[0].latency_ms, after.chains[0].latency_ms, 80)
      expect(check.status).toBe('NOT_MEASURED')
      expect(check.pass).toBe(false)
      expect(check.shiftMs).toBeNull()
    })
  }

  for (const kind of ['submission', 'fabricated'] as const) {
    it(`selects genuine feedback after an earlier matching ${kind}`, () => {
      const trace = hardwarePresentationTrace('in-1', 1)
      const invalid = structuredClone(trace[1])
      invalid.ts = 1_008_000
      invalid.id = 'invalid-frame'
      invalid.args!.presentation_timestamp = 1_008_000
      if (kind === 'submission') invalid.name = 'DisplayScheduler::DrawAndSwap'
      else invalid.args!.fabricated = true
      trace.splice(1, 0, invalid)
      const result = parseTraceEvidence(trace, [createCorrelation()], profile)
      expect(result.verdict).toBe('QUALIFIED')
      expect(result.chains[0].presented_frame_id).toBe('swap-7')
      expect(result.chains[0].presentation_timestamp_ms).toBe(1016)
    })
  }

  it('selects the first actual coherent presentation even when its feedback arrives later', () => {
    const trace = hardwarePresentationTrace('in-1', 1)
    const earlierPresentation = structuredClone(trace[1])
    earlierPresentation.ts = 1_040_000
    earlierPresentation.id = 'first-presented-frame'
    earlierPresentation.args!.presentation_timestamp = 1_008_000
    trace.push(earlierPresentation)
    const result = parseTraceEvidence(trace, [createCorrelation()], profile)
    expect(result.verdict).toBe('QUALIFIED')
    expect(result.chains[0].presented_frame_id).toBe('first-presented-frame')
    expect(result.chains[0].presentation_timestamp_ms).toBe(1008)
    expect(result.chains[0].latency_ms).toBe(8)
  })

  it('rejects an infinite feedback receipt rather than qualifying its finite endpoint', () => {
    const trace = hardwarePresentationTrace('in-1', 1)
    trace[1].ts = Infinity
    const result = parseTraceEvidence(trace, [createCorrelation()], profile)
    expect(result.valid).toBe(false)
    expect(result.verdict).toBe('NOT_MEASURED')
    expect(result.chains).toEqual([])
    expect(result.errors.some((error) => error.includes('Invalid timestamp'))).toBe(true)
  })

  it('uses hardware presentation time, not later feedback receipt', () => {
    const trace = hardwarePresentationTrace('in-1', 1)
    trace[1].ts = 1_040_000
    const result = parseTraceEvidence(trace, [createCorrelation()], profile)
    expect(result.verdict).toBe('QUALIFIED')
    expect(result.chains[0].presentation_timestamp_ms).toBe(1016)
    expect(result.chains[0].latency_ms).toBe(16)
  })

  it('reports no latency when the pre-dispatch input origin was never observed', () => {
    const result = parseTraceEvidence(
      hardwarePresentationTrace('in-1', 1),
      [createCorrelation({ input_origin_ms: null })],
      profile
    )
    expect(result.verdict).toBe('UNSUPPORTED')
    expect(result.chains[0].latency_ms).toBeNull()
    expect(result.reasons.some((r) => r.includes('no pre-dispatch browser input timestamp'))).toBe(
      true
    )
  })

  it('refuses a negative interval instead of clamping it to zero', () => {
    const trace = hardwarePresentationTrace('in-1', 1)
    const result = parseTraceEvidence(
      trace,
      // Origin after the presentation: the mapping or origin must be wrong.
      [createCorrelation({ input_origin_ms: 5000 })],
      profile
    )
    expect(result.chains[0].latency_ms).toBeNull()
    expect(result.reasons.some((r) => r.includes('negative interval'))).toBe(true)
  })

  it('carries the coalesced group through to the chain (contract §6)', () => {
    const result = parseTraceEvidence(
      hardwarePresentationTrace('in-1', 1),
      [createCorrelation({ coalesced_input_ids: ['in-0', 'in-0b'] })],
      profile
    )
    expect(result.verdict).toBe('QUALIFIED')
    // Each superseded member inherits this latency; the group is never one sample.
    expect(result.chains[0].coalesced_input_ids).toEqual(['in-0', 'in-0b'])
    expect(result.chains[0].latency_ms).toBe(16)
  })

  it('returns NOT_MEASURED when there is nothing to correlate', () => {
    const result = parseTraceEvidence(hardwarePresentationTrace('in-1', 1), [], profile)
    expect(result.verdict).toBe('NOT_MEASURED')
    expect(result.chains).toHaveLength(0)
  })
})

describe('Controlled Delay Shift Verification (AC4)', () => {
  it('passes when 80ms delay shifts the attributed endpoint by ~80ms', () => {
    const check = verifyControlledDelayShift(14.5, 95.2, 80, 25)
    expect(check.status).toBe('PASS')
    expect(check.pass).toBe(true)
    expect(check.shiftMs).toBeCloseTo(80.7, 1)
  })

  it('fails when the delay does not shift the attributed endpoint', () => {
    const check = verifyControlledDelayShift(14.5, 15.0, 80, 25)
    expect(check.status).toBe('FAIL')
    expect(check.pass).toBe(false)
  })

  it('reports NOT_MEASURED rather than a pass when the endpoint is unavailable', () => {
    const missingDelayed = verifyControlledDelayShift(14.5, null, 80, 25)
    expect(missingDelayed.status).toBe('NOT_MEASURED')
    expect(missingDelayed.pass).toBe(false)
    expect(missingDelayed.shiftMs).toBeNull()

    const missingBaseline = verifyControlledDelayShift(null, 95.2, 80, 25)
    expect(missingBaseline.status).toBe('NOT_MEASURED')
    expect(missingBaseline.pass).toBe(false)
  })
})

describe('Qualification Report Generation (AC1, AC4, AC6)', () => {
  const notMeasured: DelayCheckResult = {
    status: 'NOT_MEASURED',
    pass: false,
    shiftMs: null,
    details: 'Attributed endpoint unavailable.',
  }

  it('blocks L3-03 and states optical requirements on an UNSUPPORTED verdict', () => {
    const profile = createSampleProfile()
    const report = generateQualificationReport(profile, ['Wayland feedback is fabricated.'], {
      scenariosTested: ['pan', 'zoom', 'drag'],
      chains: [],
      gpuAdapter: profile.host.gpu_adapter,
      browserVersion: profile.host.browser_version,
      appDelayCheck: notMeasured,
      labelDelayCheck: notMeasured,
      diagnosticShifts: { appDispatchShiftMs: 79.6, labelCommitShiftMs: 82.7 },
    })

    expect(report).toContain('# Qualification Report: UNSUPPORTED Collector Profile')
    expect(report).toContain('**Verdict:** **UNSUPPORTED**')
    expect(report).toContain('L3-03 is **BLOCKED**')
    expect(report).toContain('Optical Acquisition Alternative Protocol')
    expect(report).toContain('240 fps')
    expect(report).toContain('[\\max(0, c - b), d - a]')
    // The source identity the contract requires must be present.
    expect(report).toContain(profile.identity.commit)
    expect(report).toContain(profile.identity.build_hash)
    expect(report).toContain(profile.identity.source_fingerprint)
  })

  it('reports the actual delay-check status instead of asserting verification', () => {
    const profile = createSampleProfile()
    const report = generateQualificationReport(profile, [], {
      scenariosTested: ['pan'],
      chains: [],
      gpuAdapter: profile.host.gpu_adapter,
      browserVersion: profile.host.browser_version,
      appDelayCheck: notMeasured,
      labelDelayCheck: notMeasured,
      diagnosticShifts: { appDispatchShiftMs: null, labelCommitShiftMs: null },
    })

    expect(report).toContain('**NOT_MEASURED**')
    // It must not claim a verification that did not happen.
    expect(report).not.toContain('Controlled delay tests verified that')
  })

  it('does not claim a hardware adapter when the adapter is unknown', () => {
    const unknownAdapter = createSampleProfile()
    unknownAdapter.host.gpu_adapter = UNKNOWN
    unknownAdapter.host.gpu_driver = UNKNOWN
    unknownAdapter.hash = computeProfileHash(unknownAdapter)

    const report = generateQualificationReport(unknownAdapter, [], {
      scenariosTested: ['pan'],
      chains: [],
      gpuAdapter: UNKNOWN,
      browserVersion: unknownAdapter.host.browser_version,
      appDelayCheck: notMeasured,
      labelDelayCheck: notMeasured,
      diagnosticShifts: { appDispatchShiftMs: null, labelCommitShiftMs: null },
    })

    expect(report).toContain('Fallback or unresolved adapter')
    expect(report).not.toContain('Hardware adapter reported by WebGPU')
  })

  it('reports a QUALIFIED verdict without blocking L3-03', () => {
    const qualified = createSampleProfile({ status: 'QUALIFIED', unsupported_reason: undefined })
    qualified.hash = computeProfileHash(qualified)

    const report = generateQualificationReport(qualified, [], {
      scenariosTested: ['pan', 'zoom', 'drag'],
      chains: [],
      gpuAdapter: qualified.host.gpu_adapter,
      browserVersion: qualified.host.browser_version,
      appDelayCheck: { status: 'PASS', pass: true, shiftMs: 80.2, details: 'ok' },
      labelDelayCheck: { status: 'PASS', pass: true, shiftMs: 79.4, details: 'ok' },
      diagnosticShifts: { appDispatchShiftMs: 80, labelCommitShiftMs: 80 },
    })

    expect(report).toContain('# Qualification Report: QUALIFIED Collector Profile')
    expect(report).not.toContain('L3-03 is **BLOCKED**')
    expect(report).toContain('L3-03 may consume this collector')
  })
})

describe('Final qualification decision used by the driver', () => {
  function inputs() {
    const profile = createSampleProfile()
    const parsed = parseTraceEvidence(hardwarePresentationTrace('in-1', 1), [createCorrelation()], profile)
    // Explicit synthetic coherent chains for each interaction, not browser proof.
    parsed.chains = (['pan', 'zoom', 'drag'] as const).map((scenario) => ({
      ...parsed.chains[0], input_id: scenario, scenario,
    }))
    return {
      profile, parsed,
      appDelayCheck: verifyControlledDelayShift(16, 96, 80),
      labelDelayCheck: verifyControlledDelayShift(16, 96, 80),
      invalidRunReasons: [] as string[],
    }
  }

  it('seals QUALIFIED only after every evidence gate passes', () => {
    const result = finalizeQualification(inputs())
    expect(result.profile.status).toBe('QUALIFIED')
    expect(result.failures).toEqual([])
    expect(validateCollectorProfile(result.profile, { requireAcceptanceMode: true }).valid).toBe(true)
  })

  for (const defect of ['profile', 'app-delay', 'label-delay', 'unmeasured-delay',
    'invalid-run', 'missing-scenario', 'parser-invalid'] as const) {
    it(`never seals QUALIFIED for ${defect}`, () => {
      const input = inputs()
      if (defect === 'profile') input.profile.host.gpu_driver = UNKNOWN
      if (defect === 'app-delay') input.appDelayCheck = verifyControlledDelayShift(16, 16, 80)
      if (defect === 'label-delay') input.labelDelayCheck = verifyControlledDelayShift(16, 16, 80)
      if (defect === 'unmeasured-delay') input.labelDelayCheck = verifyControlledDelayShift(16, null, 80)
      if (defect === 'invalid-run') input.invalidRunReasons.push('Device loss during run')
      if (defect === 'missing-scenario') input.parsed.chains.pop()
      if (defect === 'parser-invalid') input.parsed.valid = false
      const result = finalizeQualification(input)
      expect(result.profile.status).toBe('NOT_MEASURED')
      expect(result.failures.length).toBeGreaterThan(0)
      expect(result.reasons.length).toBeGreaterThan(0)
      const { hash, ...sealed } = result.profile
      expect(hash).toBe(computeProfileHash(sealed))
      const report = generateQualificationReport(result.profile, result.reasons, {
        scenariosTested: ['pan', 'zoom', 'drag'], chains: input.parsed.chains,
        gpuAdapter: input.profile.host.gpu_adapter, browserVersion: input.profile.host.browser_version,
        appDelayCheck: result.appDelayCheck, labelDelayCheck: result.labelDelayCheck,
        diagnosticShifts: { appDispatchShiftMs: null, labelCommitShiftMs: null },
      })
      expect(report).toContain('L3-03 is **BLOCKED**')
      for (const reason of result.reasons) expect(report).toContain(reason)
    })
  }

  it('preserves honest unsupported evidence with both delay checks NOT_MEASURED', () => {
    const input = inputs()
    input.parsed.verdict = 'UNSUPPORTED'
    input.parsed.chains = input.parsed.chains.map((chain) => ({
      ...chain, latency_ms: null, presentation_timestamp_ms: null, presented_frame_id: null,
      presentation_provenance: 'missing', frame_link: 'none',
    }))
    input.appDelayCheck = verifyControlledDelayShift(null, null, 80)
    input.labelDelayCheck = verifyControlledDelayShift(null, null, 80)
    const result = finalizeQualification(input)
    expect(result.profile.status).toBe('UNSUPPORTED')
    expect(result.failures).toEqual([])
    expect(result.appDelayCheck.status).toBe('NOT_MEASURED')
    expect(result.labelDelayCheck.status).toBe('NOT_MEASURED')
  })
})

describe('Optical acquisition requirements (AC6)', () => {
  it('states the contract sampling rules the alternate path must satisfy', () => {
    const opt = getOpticalAcquisitionRequirements()
    expect(opt.minimum_capture_fps).toBeGreaterThanOrEqual(240)
    expect(opt.acceptance_sampling.equivalent_120hz_input_count_min).toBe(3420)
    expect(opt.acceptance_sampling.minimum_response_groups).toBe(300)
    expect(opt.acceptance_sampling.warmup_seconds).toBe(10)
  })
})
