import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import {
  recordDispatch, recordLabelUpdate, recordLabelCommit, type BenchmarkHooks,
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
    canvas_revision: 0, label_revision: 0, pending_input: null,
    dispatches: [], label_commits: [], clock_syncs: [], active_scenario: null,
    raf_intervals_ms: [],
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
