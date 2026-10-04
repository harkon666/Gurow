/**
 * Summarizes a Chromium performance trace of one benchmark scenario (T06-L3-08 / #42).
 *
 * Diagnostic only: it attributes renderer main-thread time to trace event names
 * and to the opt-in `gurow:*` stage measures, and never produces a gate verdict.
 * Times are inclusive (a FunctionCall inside a RunTask counts in both rows).
 */

export interface TraceEvent {
  name: string; ph: string; pid: number; tid: number; ts: number; dur?: number
  cat?: string; id?: string | number; id2?: { local?: string; global?: string }; args?: Record<string, any>
}
/** Aggregate of one trace event name, stage or sampled function on the renderer main thread. */
export interface TraceRow { name: string; count: number; total_ms: number; ms_per_second: number; mean_ms: number; max_ms: number }
export interface TraceSummary {
  window_seconds: number
  main_thread: { pid: number; tid: number }
  events: TraceRow[]
  stages: TraceRow[]
  /** Sampled self time by function (V8 CPU profiler), main thread only. */
  functions: TraceRow[]
}

/** The page's renderer main thread: the CrRendererMain thread that recorded `gurow:*` stages, else the busiest. */
export function rendererMainThread(events: TraceEvent[]): { pid: number; tid: number } {
  const mains = events.filter(e => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain')
  if (!mains.length) throw new Error('Trace has no CrRendererMain thread')
  const score = (t: TraceEvent) => {
    const own = events.filter(e => e.pid === t.pid && e.tid === t.tid)
    return own.filter(e => e.name.startsWith('gurow:')).length * 1e9 + own.reduce((sum, e) => sum + (e.dur ?? 0), 0)
  }
  const best = mains.reduce((a, b) => (score(b) > score(a) ? b : a))
  return { pid: best.pid, tid: best.tid }
}

function rows(durations: Map<string, number[]>, seconds: number): TraceRow[] {
  return [...durations].map(([name, values]) => {
    const total = values.reduce((a, b) => a + b, 0)
    return { name, count: values.length, total_ms: round(total), ms_per_second: round(total / seconds), mean_ms: round(total / values.length), max_ms: round(Math.max(...values)) }
  }).sort((a, b) => b.total_ms - a.total_ms)
}
const round = (v: number) => Math.round(v * 1000) / 1000

/** Attributes a scenario trace's renderer main-thread time to event names, `gurow:*` stages and sampled functions. */
export function summarizeTrace(trace: { traceEvents: TraceEvent[] } | TraceEvent[]): TraceSummary {
  const events = Array.isArray(trace) ? trace : trace.traceEvents
  const main = rendererMainThread(events)
  const own = events.filter(e => e.pid === main.pid && e.tid === main.tid && e.ph !== 'M')
  const timed = own.filter(e => typeof e.ts === 'number' && e.ts > 0)
  if (!timed.length) throw new Error('Renderer main thread recorded no events')
  const start = Math.min(...timed.map(e => e.ts)), end = Math.max(...timed.map(e => e.ts + (e.dur ?? 0)))
  const seconds = (end - start) / 1e6

  const complete = new Map<string, number[]>()
  for (const e of own) if (e.ph === 'X' && typeof e.dur === 'number') {
    const list = complete.get(e.name) ?? []
    list.push(e.dur / 1000)
    complete.set(e.name, list)
  }
  // performance.measure() is recorded as an async begin/end pair per entry.
  const stages = new Map<string, number[]>(), open = new Map<string, number>()
  for (const e of events.filter(e => e.pid === main.pid && e.name.startsWith('gurow:') && (e.ph === 'b' || e.ph === 'e')).sort((a, b) => a.ts - b.ts)) {
    const key = `${e.name}\0${e.id ?? e.id2?.local ?? e.id2?.global ?? ''}`
    if (e.ph === 'b') open.set(key, e.ts)
    else if (open.has(key)) {
      const list = stages.get(e.name) ?? []
      list.push((e.ts - open.get(key)!) / 1000)
      stages.set(e.name, list)
      open.delete(key)
    }
  }
  return { window_seconds: round(seconds), main_thread: main, events: rows(complete, seconds), stages: rows(stages, seconds), functions: selfTime(events, main, seconds) }
}

interface ProfileNode { id: number; parent?: number; callFrame: { functionName: string; url?: string } }
/**
 * Aggregates V8 sampling-profiler self time on the main thread by function name and script.
 * The `Profile` event is recorded on the profiled thread; its chunks come from the profiler thread with the same id.
 */
function selfTime(events: TraceEvent[], main: { pid: number; tid: number }, seconds: number): TraceRow[] {
  const nodes = new Map<number, ProfileNode>(), times = new Map<string, number[]>()
  const ids = new Set(events.filter(e => e.pid === main.pid && e.tid === main.tid && e.name === 'Profile').map(e => String(e.id)))
  for (const e of events.filter(e => e.pid === main.pid && e.name === 'ProfileChunk' && ids.has(String(e.id)))) {
    const data = e.args?.data
    for (const node of (data?.cpuProfile?.nodes ?? []) as ProfileNode[]) nodes.set(node.id, node)
    const samples: number[] = data?.cpuProfile?.samples ?? [], deltas: number[] = data?.timeDeltas ?? []
    samples.forEach((id, i) => {
      const frame = nodes.get(id)?.callFrame
      const script = frame?.url ? frame.url.split('/').pop() : ''
      const name = `${frame?.functionName || '(anonymous)'}${script ? ` [${script}]` : ''}`
      const list = times.get(name) ?? []
      list.push(Math.max(0, deltas[i + 1] ?? deltas[i] ?? 0) / 1000)
      times.set(name, list)
    })
  }
  return rows(times, seconds)
}

/** Renders one scenario's summary as Markdown tables, `limit` rows each. */
export function markdownSummary(title: string, s: TraceSummary, limit = 20): string {
  const table = (list: TraceRow[]) => ['| Name | Count | Total ms | ms/s | Mean ms | Max ms |', '|---|---:|---:|---:|---:|---:|',
    ...list.slice(0, limit).map(r => `| ${r.name} | ${r.count} | ${r.total_ms} | ${r.ms_per_second} | ${r.mean_ms} | ${r.max_ms} |`)]
  return [`## ${title}`, '', `Renderer main thread over ${s.window_seconds} s (inclusive times; nested events count in every enclosing row).`, '',
    '### Opt-in stages', '', ...(s.stages.length ? table(s.stages) : ['None recorded.']), '', '### Trace events', '', ...table(s.events), '',
    '### Sampled self time by function (count = samples)', '', ...(s.functions.length ? table(s.functions) : ['No CPU profile recorded.']), ''].join('\n')
}
