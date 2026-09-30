import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import {
  applyAppDelay, beginInput, recordDispatch, recordLabelUpdate, recordLabelCommit,
  recordBenchmarkFrame, recordNoOpInput, sealBenchmarkCapture,
  type BenchmarkHooks,
} from './benchmarkHooks'

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
let clock: ReturnType<typeof spyOn> | undefined

afterEach(() => {
  clock?.mockRestore()
  clock = undefined
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

function install(enabled = true): BenchmarkHooks {
  const hooks: BenchmarkHooks = {
    enabled, app_delay_ms: 0, label_delay_ms: 80, app_revision: 0,
    canvas_revision: 0, label_revision: 0, pending_inputs: [],
    dispatches: [], label_commits: [], clock_syncs: [], active_scenario: null,
    app_delays_applied: 0, label_delays_applied: 0,
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true, value: { __gurowBenchmarkHooks: hooks },
  })
  return hooks
}

// Supplemental deterministic time-boundary tests. Browser integration lives in
// scripts/editor-lifecycle-check.ts; no React/engine/own-module mocks here.
describe('benchmark DOM commit evidence', () => {
  it('records completion after injected delay, not its start', () => {
    const hooks = install()
    const app = recordDispatch('PanCamera', 1)
    const labels = recordLabelUpdate(app)
    // commit start, delay start, loop boundary, completion (performance domain).
    const times = [100, 101, 180, 181, 182]
    clock = spyOn(performance, 'now').mockImplementation(() => {
      const time = times.shift()
      if (time === undefined) throw new Error('unexpected clock read')
      return time
    })
    recordLabelCommit(labels)
    expect(hooks.label_commits).toEqual([{
      label_revision: 1, app_revision: 1, commit_ms: 182, commit_duration_ms: 82,
    }])
    expect(hooks.dispatches[0].label_commit_ms).toBe(182)
    expect(times).toEqual([])
  })

  it('correlates only supplied geometry revisions despite newer global counters', () => {
    const hooks = install()
    hooks.label_delay_ms = 0
    const firstApp = recordDispatch('PanCamera', 1)
    const firstLabels = recordLabelUpdate(firstApp)
    const secondApp = recordDispatch('ZoomAt', 1)
    const secondLabels = recordLabelUpdate(secondApp)
    recordDispatch('ExportSnapshot', 1)
    let now = 10
    clock = spyOn(performance, 'now').mockImplementation(() => now++)
    recordLabelCommit(firstLabels)
    expect(hooks.label_commits[0]).toEqual({
      app_revision: 1, label_revision: 1, commit_ms: 11, commit_duration_ms: 1,
    })
    expect(hooks.dispatches.map(d => d.label_commit_ms)).toEqual([11, null, null])
    recordLabelCommit(secondLabels)
    expect(hooks.label_commits[1]).toEqual({
      app_revision: 2, label_revision: 2, commit_ms: 13, commit_duration_ms: 1,
    })
    expect(hooks.dispatches.map(d => d.label_commit_app_revision)).toEqual([1, 2, null])
    expect(hooks.dispatches.map(d => d.label_commit_ms)).toEqual([11, 13, null])
  })

  it('does no timing work without opt-in or geometry metadata', () => {
    const hooks = install(false)
    clock = spyOn(performance, 'now').mockImplementation(() => { throw new Error('production clock read') })
    expect(recordDispatch('PanCamera', 1)).toBeUndefined()
    expect(recordLabelUpdate(1)).toBeUndefined()
    recordLabelCommit({ app_revision: 1, label_revision: 1 })
    hooks.enabled = true
    recordLabelCommit(undefined)
    expect(hooks.dispatches).toEqual([])
    expect(hooks.label_commits).toEqual([])
  })
})

// Contract §6 fixes the coalescing rule in the collector, so a superseded input
// must keep its own origin instead of vanishing behind the one that replaced it.
describe('input coalescing evidence', () => {
  it('attributes a coalesced dispatch to the oldest input and retains the rest', () => {
    const hooks = install()
    const first = beginInput({ timeStamp: 100 }, 'pan')!
    const second = beginInput({ timeStamp: 116 }, 'pan')!
    expect(hooks.pending_inputs).toHaveLength(2)

    recordDispatch('PanCamera', 1)
    const dispatch = hooks.dispatches[0]
    expect(dispatch.input_id).toBe(first)
    expect(dispatch.input_origin_ms).toBe(100)
    expect(dispatch.coalesced_inputs.map(input => input.input_id)).toEqual([second])
    expect(dispatch.coalesced_inputs[0].origin_ms).toBe(116)
    // The queue is drained, so the next dispatch cannot reuse a consumed input.
    expect(hooks.pending_inputs).toEqual([])
  })

  it('distinguishes an input-caused dispatch from an application-internal one', () => {
    const hooks = install()
    beginInput({ timeStamp: 50 }, 'zoom')
    recordDispatch('ZoomAt', 1)
    recordDispatch('ResizeViewport', 1)
    expect(hooks.dispatches.map(d => d.input_origin_ms)).toEqual([50, null])
    expect(hooks.dispatches.map(d => d.scenario)).toEqual(['zoom', null])
  })
})

describe('v3 in-app input-to-frame proxy', () => {
  function window100to200(hooks: BenchmarkHooks) {
    hooks.label_delay_ms = 0
    hooks.capture_start_ms = 100
    hooks.capture_end_ms = 200
    hooks.drain_end_ms = 2200
    hooks.refresh_hz = 60
  }
  const commitLabels = (appRevision: number) => recordLabelCommit(recordLabelUpdate(appRevision))

  it('charges each coalesced original timestamp at the first frame after both commits', () => {
    const hooks = install()
    window100to200(hooks)
    // Chromium's coalesced list includes the delivering event itself.
    beginInput({ type: 'pointermove', timeStamp: 110, nativeEvent: { getCoalescedEvents: () => [{ timeStamp: 105 }, { timeStamp: 108 }, { timeStamp: 110 }] } }, 'drag')
    expect(hooks.inputs?.map(input => [input.origin_ms, input.event_type])).toEqual([[105, 'pointermove'], [108, 'pointermove'], [110, 'pointermove']])
    recordDispatch('PointerMove', 2)
    recordBenchmarkFrame(120, 120)
    expect(hooks.input_samples ?? []).toHaveLength(0)
    commitLabels(1)
    recordBenchmarkFrame(130, 130)
    expect(hooks.input_samples?.map(sample => sample.raw_ms)).toEqual([25, 22, 20])
    expect(hooks.input_samples?.[0].proxy_ms).toBeCloseTo(25 + 1000 / 60)
    expect(hooks.frames?.map(frame => frame.frame_interval_ms)).toEqual([null, 10])
    expect(hooks.input_samples?.every(sample => !sample.unresolved && sample.revision === 1)).toBe(true)
  })

  it('ends latency when the resolving callback runs, not at its earlier rAF timestamp', () => {
    const hooks = install()
    window100to200(hooks)
    beginInput({ type: 'wheel', timeStamp: 110 }, 'pan')
    recordDispatch('PanCamera', 1)
    // An 80 ms label commit blocks the main thread; Chromium had already
    // stamped the next frame at 120, but its callback only runs at 206.
    clock = spyOn(performance, 'now').mockReturnValue(205)
    commitLabels(1)
    recordBenchmarkFrame(120, 206)
    expect(hooks.input_samples?.map(sample => sample.raw_ms)).toEqual([96])
    expect(hooks.frames?.map(frame => [frame.timestamp_ms, frame.callback_ms])).toEqual([[120, 206]])
  })

  it('collects no input outside a measured window, even when the driver clears it with null', () => {
    const hooks = install()
    Object.assign(hooks, { capture_start_ms: null, capture_end_ms: null, drain_end_ms: null, refresh_hz: 60 })
    beginInput({ type: 'wheel', timeStamp: 5 }, 'pan')
    recordDispatch('PanCamera', 1)
    recordBenchmarkFrame(10, 10)
    sealBenchmarkCapture()
    expect(hooks.inputs ?? []).toEqual([])
    expect(hooks.frames ?? []).toEqual([])
    expect(hooks.input_samples ?? []).toEqual([])
  })

  it('counts a no-op input without letting it hold back later inputs', () => {
    const hooks = install()
    window100to200(hooks)
    recordNoOpInput({ type: 'wheel', timeStamp: 105 })
    recordNoOpInput({ type: 'wheel', timeStamp: 250 })
    beginInput({ type: 'wheel', timeStamp: 110 }, 'pan')
    recordDispatch('PanCamera', 1)
    commitLabels(1)
    recordBenchmarkFrame(130, 130)
    expect(hooks.no_op_inputs).toBe(1)
    expect(hooks.pending_inputs).toEqual([])
    expect(hooks.input_samples?.map(sample => sample.unresolved)).toEqual([false])
  })

  it('retains the open frame stall and charges unresolved input until drain deadline', () => {
    const hooks = install()
    window100to200(hooks)
    recordBenchmarkFrame(110, 110)
    beginInput({ type: 'wheel', timeStamp: 150 }, 'pan')
    recordDispatch('PanCamera', 1)
    recordBenchmarkFrame(210, 210)
    expect(hooks.frames?.at(-1)?.frame_interval_ms).toBe(90)
    sealBenchmarkCapture()
    sealBenchmarkCapture()
    expect(hooks.input_samples).toEqual([{
      input_id: hooks.inputs![0].input_id, origin_ms: 150, revision: 1,
      raw_ms: 2050, proxy_ms: 2050 + 1000 / 60, unresolved: true,
    }])
  })

  it('seals a window whose rAF stopped mid-run at the window end and drain deadline', () => {
    const hooks = install()
    window100to200(hooks)
    recordBenchmarkFrame(104, 104)
    beginInput({ type: 'wheel', timeStamp: 120 }, 'pan')
    sealBenchmarkCapture()
    expect(hooks.frames?.map(frame => [frame.timestamp_ms, frame.frame_interval_ms])).toEqual([[104, null], [200, 96]])
    expect(hooks.input_samples?.map(sample => [sample.raw_ms, sample.revision, sample.unresolved])).toEqual([[2080, null, true]])
  })
})

describe('injected application delay', () => {
  it('delays only a dispatch caused by an observed browser input (AC4)', () => {
    const hooks = install()
    hooks.app_delay_ms = 80
    clock = spyOn(performance, 'now').mockImplementation(() => {
      throw new Error('untimed dispatch must not busy-wait')
    })
    // No pending input: a viewport resize or persistence write is not the
    // interaction under test and must not be slowed down.
    applyAppDelay()
    expect(hooks.app_delays_applied).toBe(0)
  })

  it('records that the delay actually executed inside the dispatch', () => {
    const hooks = install()
    hooks.app_delay_ms = 80
    beginInput({ timeStamp: 10 }, 'pan')
    const times = [0, 0, 80]
    clock = spyOn(performance, 'now').mockImplementation(() => {
      const time = times.shift()
      if (time === undefined) throw new Error('unexpected clock read')
      return time
    })
    applyAppDelay()
    expect(hooks.app_delays_applied).toBe(1)
    expect(times).toEqual([])
  })
})
