import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import {
  applyAppDelay, beginInput, recordDispatch, recordLabelUpdate, recordLabelCommit,
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
