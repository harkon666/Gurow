import { describe, expect, it } from 'bun:test'
import { markdownSummary, summarizeTrace, type TraceEvent } from './trace-summary'

const meta = (pid: number, tid: number, name: string): TraceEvent => ({ name: 'thread_name', ph: 'M', pid, tid, ts: 0, args: { name } })
const x = (name: string, ts: number, dur: number, pid = 1, tid = 2): TraceEvent => ({ name, ph: 'X', pid, tid, ts, dur })

describe('diagnostic trace summary', () => {
  it('attributes the page main thread, stage measures and sampled self time', () => {
    const events: TraceEvent[] = [
      meta(1, 2, 'CrRendererMain'), meta(9, 2, 'CrRendererMain'),
      x('RunTask', 1_000_000, 4_000), x('Layout', 1_001_000, 2_000), x('Layout', 1_500_000, 1_000),
      x('RunTask', 1_000_000, 900_000, 9, 2), // another renderer: busier, but without gurow stages
      { name: 'gurow:events-parse', ph: 'b', pid: 1, tid: 2, ts: 1_000_500, id: '0x1' },
      { name: 'gurow:events-parse', ph: 'e', pid: 1, tid: 2, ts: 1_001_500, id: '0x1' },
      { name: 'Profile', ph: 'P', pid: 1, tid: 2, ts: 1_001_900, id: '0x1' },
      { name: 'ProfileChunk', ph: 'P', pid: 1, tid: 7, ts: 1_002_000, id: '0x1', args: { data: {
        cpuProfile: { nodes: [{ id: 1, callFrame: { functionName: 'parse', url: 'http://h/assets/zod.js' } }], samples: [1, 1] },
        timeDeltas: [100, 200] } } },
      x('RunTask', 1_999_000, 1_000),
    ]
    const s = summarizeTrace({ traceEvents: events })
    expect(s.main_thread).toEqual({ pid: 1, tid: 2 })
    expect(s.window_seconds).toBe(1)
    expect(s.events.find(r => r.name === 'Layout')).toMatchObject({ count: 2, total_ms: 3, ms_per_second: 3, max_ms: 2 })
    expect(s.stages).toEqual([{ name: 'gurow:events-parse', count: 1, total_ms: 1, ms_per_second: 1, mean_ms: 1, max_ms: 1 }])
    expect(s.functions[0]).toMatchObject({ name: 'parse [zod.js]', count: 2 })
    expect(markdownSummary('pan', s)).toContain('| gurow:events-parse | 1 | 1 |')
  })

  it('rejects a trace without a renderer main thread', () => {
    expect(() => summarizeTrace([x('RunTask', 1, 1)])).toThrow(/CrRendererMain/)
  })
})
