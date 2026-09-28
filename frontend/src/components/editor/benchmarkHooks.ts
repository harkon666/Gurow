/**
 * Opt-in benchmark instrumentation for the P1/T06 measurement contract.
 *
 * Every entry point returns immediately unless a driver has installed
 * `window.__gurowBenchmarkHooks` with `enabled: true` before navigation, so
 * production bundles carry only these guard checks and expose no engine seam.
 *
 * The hooks record the *pre-dispatch* browser input timestamp as the origin of
 * each interaction, because contract gurow-p1-v1 forbids beginning a latency
 * measurement at handler entry or after `dispatch_command`.
 */

/** A browser input observed before any engine command was issued. */
export interface PendingInput {
  input_id: string
  /** `event.timeStamp`, i.e. the `performance.now()` domain, before dispatch. */
  origin_ms: number
  scenario: 'pan' | 'zoom' | 'drag'
}

/** One engine dispatch correlated to the input that caused it. */
export interface DispatchRecord {
  input_id: string
  command_type: string
  scenario: 'pan' | 'zoom' | 'drag' | null
  /** Null when this dispatch was not caused by an observed browser input. */
  input_origin_ms: number | null
  app_revision: number
  canvas_revision: number
  /** Label revision current when this dispatch ran, before any new commit. */
  label_revision_at_dispatch: number
  /** Label revision of the commit that first observed this dispatch. */
  label_revision: number | null
  /** App revision that commit had observed, used to prove it saw this state. */
  label_commit_app_revision: number | null
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
  commit_ms: number
  /** Wall time spent inside the commit, including any injected label delay. */
  commit_duration_ms: number
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
  pending_input: PendingInput | null
  dispatches: DispatchRecord[]
  label_commits: LabelCommitRecord[]
  clock_syncs: ClockSyncRecord[]
  /** Set by the driver to tag dispatches while a named scenario is active. */
  active_scenario: 'pan' | 'zoom' | 'drag' | null
  raf_intervals_ms: number[]
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
 * unconsumed and is therefore visible as a dropped input in the raw log.
 */
export function beginInput(
  event: { timeStamp: number },
  scenario: 'pan' | 'zoom' | 'drag'
): string | undefined {
  const hooks = getBenchmarkHooks()
  if (!hooks) return undefined

  const inputId = `input-${scenario}-${hooks.dispatches.length}-${Math.round(event.timeStamp * 1000)}`
  hooks.pending_input = {
    input_id: inputId,
    origin_ms: event.timeStamp,
    scenario,
  }
  mark(`gurow:input_observed:${inputId}`)
  return inputId
}

/**
 * Busy-waits the configured fault-injection delay before the engine runs.
 *
 * A busy loop is used deliberately: it must occupy the same task as the
 * dispatch so the injected delay lands inside the measured interval.
 */
export function applyAppDelay(): void {
  const hooks = getBenchmarkHooks()
  if (!hooks || !(hooks.app_delay_ms > 0)) return
  const start = performance.now()
  while (performance.now() - start < hooks.app_delay_ms) {
    // Intentional busy wait; see doc comment.
  }
}

/** Busy-waits the configured label fault-injection delay during label paint. */
export function applyLabelDelay(): void {
  const hooks = getBenchmarkHooks()
  if (!hooks || !(hooks.label_delay_ms > 0)) return
  const start = performance.now()
  while (performance.now() - start < hooks.label_delay_ms) {
    // Intentional busy wait; see doc comment.
  }
}

/**
 * Records one engine dispatch, consuming the pending input that caused it.
 *
 * The canvas revision equals the app revision because
 * `render_and_serialize_events` applies the document change and invokes the
 * renderer in the same synchronous call. Label revisions advance separately and
 * are attached later by {@link recordLabelPaint}.
 */
export function recordDispatch(commandType: string, cpuWorkMs: number): void {
  const hooks = getBenchmarkHooks()
  if (!hooks) return

  hooks.app_revision += 1
  hooks.canvas_revision = hooks.app_revision

  const pending = hooks.pending_input
  hooks.pending_input = null

  const inputId = pending?.input_id ?? `dispatch-${hooks.app_revision}`
  hooks.dispatches.push({
    input_id: inputId,
    command_type: commandType,
    scenario: pending?.scenario ?? hooks.active_scenario ?? null,
    input_origin_ms: pending?.origin_ms ?? null,
    app_revision: hooks.app_revision,
    canvas_revision: hooks.canvas_revision,
    label_revision_at_dispatch: hooks.label_revision,
    label_revision: null,
    label_commit_app_revision: null,
    cpu_work_ms: cpuWorkMs,
  })
  mark(`gurow:app_dispatch:${inputId}:${hooks.app_revision}`)
}

/** Advances the label revision when the engine emits new label geometry. */
export function recordLabelUpdate(): void {
  const hooks = getBenchmarkHooks()
  if (!hooks) return
  hooks.label_revision += 1
  mark(`gurow:labels_updated:${hooks.label_revision}`)
}

/**
 * Records that the HTML label overlay committed to the DOM, closing the label
 * side of the chain for every dispatch still awaiting one.
 *
 * This is a commit, not a paint; see {@link LabelCommitRecord}.
 */
export function recordLabelCommit(): void {
  const hooks = getBenchmarkHooks()
  if (!hooks) return

  const commitStart = performance.now()
  applyLabelDelay()

  const commit: LabelCommitRecord = {
    label_revision: hooks.label_revision,
    app_revision: hooks.app_revision,
    commit_ms: commitStart,
    commit_duration_ms: performance.now() - commitStart,
  }
  hooks.label_commits.push(commit)
  for (const dispatch of hooks.dispatches) {
    if (dispatch.label_revision === null && dispatch.app_revision <= commit.app_revision) {
      dispatch.label_revision = commit.label_revision
      dispatch.label_commit_app_revision = commit.app_revision
    }
  }
  mark(`gurow:labels_committed:${commit.label_revision}`)
}
