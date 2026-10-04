/**
 * Opt-in benchmark instrumentation for the P1/T06 measurement contract.
 *
 * Every entry point returns immediately unless a driver has installed
 * `window.__gurowBenchmarkHooks` with `enabled: true` before navigation, so
 * production bundles carry only these guard checks and expose no engine seam.
 *
 * The hooks retain browser event timestamps, synchronous canvas submission,
 * React label commits and subsequent animation-frame callbacks. Contract
 * gurow-p1-v4 calls this an in-app proxy, not a hardware presentation time.
 * Its endpoint is when the resolving rAF callback actually runs, not the rAF
 * timestamp: Chromium stamps a frame when it is issued, so a frame delayed by a
 * busy main thread carries a timestamp from before the delay.
 */

/** The three timed interactions the contract measures. */
export type Scenario = 'pan' | 'zoom' | 'drag'

/** Every scenario, in the order contract §5 runs them. */
export const SCENARIOS = ['pan', 'zoom', 'drag'] as const satisfies readonly Scenario[]

/** A browser input observed before any engine command was issued. */
export interface PendingInput {
  input_id: string
  /** `event.timeStamp`, i.e. the `performance.now()` domain, before dispatch. */
  origin_ms: number
  scenario: Scenario
  /** DOM event type that delivered this input, e.g. `wheel` or `pointermove`. */
  event_type: string
  revision?: number
}

export interface CapturedFrame {
  timestamp_ms: number
  /** `performance.now()` when this rAF callback started, after any main-thread delay. */
  callback_ms: number
  frame_interval_ms: number | null
  canvas_revision: number
  label_app_revision: number
}

export interface CapturedInputSample {
  input_id: string
  origin_ms: number
  revision: number | null
  raw_ms: number
  proxy_ms: number
  unresolved: boolean
}

/** One engine dispatch correlated to the input that caused it. */
export interface DispatchRecord {
  input_id: string
  command_type: string
  scenario: Scenario | null
  /**
   * Origin of the oldest input this dispatch incorporated, per the fixed
   * coalescing rule; null when no observed browser input caused it.
   */
  input_origin_ms: number | null
  /**
   * Inputs superseded into this dispatch, oldest first, excluding the
   * attributed one. Retained so a coalesced input keeps its own origin instead
   * of disappearing behind the input that replaced it (contract §6).
   */
  coalesced_inputs: PendingInput[]
  app_revision: number
  canvas_revision: number
  /** Label revision current when this dispatch ran, before any new commit. */
  label_revision_at_dispatch: number
  /** Label revision of the commit that first observed this dispatch. */
  label_revision: number | null
  /** App revision that commit had observed, used to prove it saw this state. */
  label_commit_app_revision: number | null
  /** Completion of the corresponding DOM geometry commit, not presentation. */
  label_commit_ms: number | null
  cpu_work_ms: number
}

/**
 * One HTML label overlay DOM commit, used to close the label side of the chain.
 *
 * A React commit is not a paint: the browser composites later. The commit time
 * is therefore a lower bound on label visibility and can never stand in for
 * presentation evidence, which must come from the browser trace.
 */
export interface LabelCommitRecord {
  label_revision: number
  app_revision: number
  /** Pre-paint DOM commit completion, AFTER any injected label delay. */
  commit_ms: number
  /** Wall time spent inside the commit, including any injected label delay. */
  commit_duration_ms: number
}

/** A focus or visibility transition observed during a capture window. */
export interface FocusRecord {
  at_ms: number
  focused: boolean
  visible: DocumentVisibilityState
}

/** A `performance.now()` / trace-clock pair used to derive the clock mapping. */
export interface ClockSyncRecord {
  index: number
  page_now_ms: number
}

export interface BenchmarkHooks {
  enabled: boolean
  app_delay_ms: number
  label_delay_ms: number
  app_revision: number
  canvas_revision: number
  label_revision: number
  /**
   * Inputs observed but not yet incorporated into a dispatch, oldest first.
   *
   * A queue rather than a single slot: when several inputs coalesce into one
   * dispatch, every superseded input must keep its own recorded origin.
   */
  pending_inputs: PendingInput[]
  dispatches: DispatchRecord[]
  label_commits: LabelCommitRecord[]
  clock_syncs: ClockSyncRecord[]
  /** Set by the driver to tag dispatches while a named scenario is active. */
  active_scenario: Scenario | null
  /** Times the injected application delay actually executed. */
  app_delays_applied: number
  /** Times the injected label delay actually executed. */
  label_delays_applied: number
  /**
   * Driver-owned capture window. Null or absent outside a measured window
   * (production, warm-up); every reader treats both the same.
   */
  capture_start_ms?: number | null
  capture_end_ms?: number | null
  drain_end_ms?: number | null
  refresh_hz?: number | null
  inputs?: PendingInput[]
  frames?: CapturedFrame[]
  input_samples?: CapturedInputSample[]
  last_frame_ms?: number
  next_input_index?: number
  /** Highest app revision any committed label geometry has observed. */
  label_committed_app_revision?: number
  /** In-window inputs the editor ignored because they request no change. */
  no_op_inputs?: number
  focus_events?: FocusRecord[]
  /** Installed by the editor: closes the window even if rAF has stopped. */
  seal?: () => void
  /** Diagnostic traces only (#42): record `gurow:*` stage measures. Never set in acceptance runs. */
  trace_stages?: boolean
}

interface CaptureWindow { start: number; end: number; deadline: number; refreshHz: number }

/** The active measured window, or undefined outside one. */
function captureWindow(hooks: BenchmarkHooks): CaptureWindow | undefined {
  const { capture_start_ms: start, capture_end_ms: end, drain_end_ms: deadline, refresh_hz: refreshHz } = hooks
  if (start == null || end == null || deadline == null || !refreshHz) return undefined
  return { start, end, deadline, refreshHz }
}

/**
 * Returns the installed hooks only when instrumentation is switched on.
 *
 * Callers must treat `undefined` as "not benchmarking" and skip all work.
 */
export function getBenchmarkHooks(): BenchmarkHooks | undefined {
  if (typeof window === 'undefined') return undefined
  const hooks = (window as unknown as { __gurowBenchmarkHooks?: BenchmarkHooks })
    .__gurowBenchmarkHooks
  return hooks?.enabled ? hooks : undefined
}

/** Editor stages a diagnostic trace attributes main-thread time to (#42). */
export type TraceStage = 'wasm-dispatch' | 'events-parse' | 'handle-events' | 'labels-render-commit'

/** Records one `gurow:<stage>` performance measure from `startMs` to now, only while a diagnostic trace asks for stages. */
export function traceStage(name: TraceStage, startMs: number): void {
  if (getBenchmarkHooks()?.trace_stages) performance.measure(`gurow:${name}`, { start: startMs, end: performance.now() })
}

function mark(name: string): void {
  if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
    performance.mark(name)
  }
}

/**
 * Records a browser input as the origin of the interaction about to be
 * dispatched, and returns its correlation ID.
 *
 * `event.timeStamp` is read before any engine work so the recorded origin
 * precedes dispatch. The pending input is consumed by the next
 * {@link recordDispatch}; an input that never reaches a dispatch stays
 * queued and is therefore visible as a dropped input in the raw log.
 */
export interface ObservedEvent {
  type?: string
  timeStamp: number
  getCoalescedEvents?: () => Array<{ timeStamp: number }>
  nativeEvent?: { getCoalescedEvents?: () => Array<{ timeStamp: number }> }
}

function inWindow(hooks: BenchmarkHooks, timestamp: number): boolean {
  const capture = captureWindow(hooks)
  return !!capture && timestamp >= capture.start && timestamp < capture.end
}

export function beginInput(event: ObservedEvent, scenario: Scenario): string | undefined {
  const hooks = getBenchmarkHooks()
  if (!hooks) return undefined

  // A trusted pointermove's coalesced list contains the delivering event
  // itself, so it alone lists every original input with its own timestamp.
  // Other events have no list and are one original input each.
  const coalesced = event.nativeEvent?.getCoalescedEvents?.() ?? event.getCoalescedEvents?.()
  const timestamps = coalesced?.length ? coalesced.map(e => e.timeStamp) : [event.timeStamp]
  const eventType = event.type ?? 'unknown'
  let firstId: string | undefined
  for (const timestamp of timestamps) {
    const inputId = `input-${scenario}-${hooks.dispatches.length}-${hooks.pending_inputs.length}-${Math.round(timestamp * 1000)}`
    const input: PendingInput = { input_id: inputId, origin_ms: timestamp, scenario, event_type: eventType }
    hooks.pending_inputs.push(input)
    if (inWindow(hooks, timestamp)) (hooks.inputs ??= []).push(input)
    firstId ??= inputId
    mark(`gurow:input_observed:${inputId}`)
  }
  return firstId
}

/**
 * Counts an input the editor ignores because it requests no change, such as a
 * zero-travel wheel event. It never joins the dispatch queue, so it cannot hold
 * back later inputs, and is excluded from latency by this fixed rule.
 */
export function recordNoOpInput(event: ObservedEvent): void {
  const hooks = getBenchmarkHooks()
  if (hooks && inWindow(hooks, event.timeStamp)) hooks.no_op_inputs = (hooks.no_op_inputs ?? 0) + 1
}

/**
 * Busy-waits the configured fault-injection delay inside the dispatch.
 *
 * A busy loop is used deliberately: it must occupy the same task as the
 * dispatch so the injected delay lands inside the measured interval.
 *
 * Only a dispatch caused by an observed browser input is delayed. AC4 shifts the
 * endpoint of the interaction under test; delaying viewport resizes, document
 * loads or persistence would slow the whole application instead.
 */
export function applyAppDelay(): void {
  const hooks = getBenchmarkHooks()
  if (!hooks || !(hooks.app_delay_ms > 0) || hooks.pending_inputs.length === 0) return
  const start = performance.now()
  while (performance.now() - start < hooks.app_delay_ms) {
    // Intentional busy wait; see doc comment.
  }
  hooks.app_delays_applied += 1
}

/** Busy-waits the label fault-injection delay in the pre-paint layout phase. */
export function applyLabelDelay(): void {
  const hooks = getBenchmarkHooks()
  if (!hooks || !(hooks.label_delay_ms > 0)) return
  const start = performance.now()
  while (performance.now() - start < hooks.label_delay_ms) {
    // Intentional busy wait; see doc comment.
  }
  hooks.label_delays_applied += 1
}

/**
 * Records one engine dispatch, consuming every input it incorporated.
 *
 * Coalescing rule `gurow-coalescing-v1`, fixed here in the collector rather
 * than left to a report reducer (contract §6): the dispatch is attributed to the
 * oldest unconsumed input, and every superseded input is retained so it can
 * carry that same conservative oldest-to-presentation latency.
 *
 * The canvas revision equals the app revision because
 * `render_and_serialize_events` applies the document change and invokes the
 * renderer in the same synchronous call. Label revisions advance separately and
 * are attached later by {@link recordLabelCommit}.
 */
export function recordDispatch(commandType: string, cpuWorkMs: number): number | undefined {
  const hooks = getBenchmarkHooks()
  if (!hooks) return

  hooks.app_revision += 1
  hooks.canvas_revision = hooks.app_revision

  const pending = hooks.pending_inputs
  hooks.pending_inputs = []
  for (const input of pending) input.revision = hooks.app_revision
  const attributed = pending[0]

  const inputId = attributed?.input_id ?? `dispatch-${hooks.app_revision}`
  hooks.dispatches.push({
    input_id: inputId,
    command_type: commandType,
    scenario: attributed?.scenario ?? hooks.active_scenario ?? null,
    input_origin_ms: attributed?.origin_ms ?? null,
    coalesced_inputs: pending.slice(1),
    app_revision: hooks.app_revision,
    canvas_revision: hooks.canvas_revision,
    label_revision_at_dispatch: hooks.label_revision,
    label_revision: null,
    label_commit_app_revision: null,
    label_commit_ms: null,
    cpu_work_ms: cpuWorkMs,
  })
  mark(`gurow:app_dispatch:${inputId}:${hooks.app_revision}`)
  return hooks.app_revision
}

/** Metadata travels atomically with the label geometry through React batching. */
export interface LabelRevision {
  label_revision: number
  app_revision: number
}

/** Advances and captures the revision of this specific engine label output. */
export function recordLabelUpdate(appRevision: number | undefined): LabelRevision | undefined {
  const hooks = getBenchmarkHooks()
  if (!hooks || appRevision === undefined) return
  hooks.label_revision += 1
  mark(`gurow:labels_updated:${hooks.label_revision}`)
  return { label_revision: hooks.label_revision, app_revision: appRevision }
}

/**
 * Records that the HTML label overlay committed to the DOM, closing the label
 * side of the chain for every dispatch still awaiting one.
 *
 * This is a commit, not a paint; see {@link LabelCommitRecord}.
 */
export function recordLabelCommit(revision: LabelRevision | undefined): void {
  const hooks = getBenchmarkHooks()
  if (!hooks || !revision) return

  const commitStart = performance.now()
  applyLabelDelay()
  const commitEnd = performance.now()

  const commit: LabelCommitRecord = {
    ...revision,
    commit_ms: commitEnd,
    commit_duration_ms: commitEnd - commitStart,
  }
  hooks.label_commits.push(commit)
  hooks.label_committed_app_revision = Math.max(hooks.label_committed_app_revision ?? 0, commit.app_revision)
  for (const dispatch of hooks.dispatches) {
    if (dispatch.label_revision === null && dispatch.app_revision <= commit.app_revision) {
      dispatch.label_revision = commit.label_revision
      dispatch.label_commit_app_revision = commit.app_revision
      dispatch.label_commit_ms = commit.commit_ms
    }
  }
  mark(`gurow:labels_committed:${commit.label_revision}`)
}

/** Keeps a stall still open at the active-window boundary in the distribution. */
function closeOpenStall(hooks: BenchmarkHooks, end: number): void {
  if (hooks.last_frame_ms === undefined || hooks.last_frame_ms >= end) return
  ;(hooks.frames ??= []).push({ timestamp_ms: end, callback_ms: end, frame_interval_ms: end - hooks.last_frame_ms,
    canvas_revision: hooks.canvas_revision, label_app_revision: hooks.label_committed_app_revision ?? 0 })
  hooks.last_frame_ms = end
}

function recordSample(hooks: BenchmarkHooks, input: PendingInput, endpoint: number, refreshHz: number, unresolved: boolean): void {
  const raw = Math.max(0, endpoint - input.origin_ms)
  ;(hooks.input_samples ??= []).push({ input_id: input.input_id, origin_ms: input.origin_ms,
    revision: input.revision ?? null, raw_ms: raw, proxy_ms: raw + 1000 / refreshHz, unresolved })
}

/**
 * Called by the editor's opt-in rAF loop after any frame-aligned editor work.
 * An input resolves at the first callback that runs after both its canvas
 * submission and its label commit, read live at callback time, and its endpoint
 * is `callbackMs`, when that callback started. Frame intervals use the rAF
 * timestamps. rAF is NOT presentation.
 */
export function recordBenchmarkFrame(timestamp: number, callbackMs = performance.now()): void {
  const hooks = getBenchmarkHooks()
  const capture = hooks && captureWindow(hooks)
  if (!hooks || !capture || timestamp < capture.start) return
  if (timestamp > capture.deadline) {
    sealBenchmarkCapture()
    return
  }
  if (timestamp < capture.end) {
    const previous = hooks.last_frame_ms
    ;(hooks.frames ??= []).push({
      timestamp_ms: timestamp,
      callback_ms: callbackMs,
      frame_interval_ms: previous === undefined ? null : timestamp - previous,
      canvas_revision: hooks.canvas_revision,
      label_app_revision: hooks.label_committed_app_revision ?? 0,
    })
    hooks.last_frame_ms = timestamp
  } else {
    closeOpenStall(hooks, capture.end)
  }
  const labelRevision = hooks.label_committed_app_revision ?? 0
  const inputs = hooks.inputs ?? []
  let index = hooks.next_input_index ?? 0
  while (index < inputs.length) {
    const input = inputs[index]
    if (input.revision === undefined || hooks.canvas_revision < input.revision || labelRevision < input.revision) break
    recordSample(hooks, input, callbackMs, capture.refreshHz, false)
    index++
  }
  hooks.next_input_index = index
  if (timestamp === capture.deadline) sealBenchmarkCapture()
}

/**
 * Closes the capture: keeps an open stall at the window end and charges every
 * still-unresolved original input to the fixed drain deadline. Idempotent, and
 * callable by the driver when rAF has stopped (for example, an occluded window).
 */
export function sealBenchmarkCapture(): void {
  const hooks = getBenchmarkHooks()
  const capture = hooks && captureWindow(hooks)
  if (!hooks || !capture) return
  closeOpenStall(hooks, capture.end)
  const inputs = hooks.inputs ?? []
  for (let i = hooks.next_input_index ?? 0; i < inputs.length; i++) {
    recordSample(hooks, inputs[i], capture.deadline, capture.refreshHz, true)
  }
  hooks.next_input_index = inputs.length
}
