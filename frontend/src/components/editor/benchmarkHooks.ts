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
 * queued and is therefore visible as a dropped input in the raw log.
 */
export function beginInput(
  event: { timeStamp: number },
  scenario: Scenario
): string | undefined {
  const hooks = getBenchmarkHooks()
  if (!hooks) return undefined

  const inputId =
    `input-${scenario}-${hooks.dispatches.length}-${hooks.pending_inputs.length}-` +
    `${Math.round(event.timeStamp * 1000)}`
  hooks.pending_inputs.push({
    input_id: inputId,
    origin_ms: event.timeStamp,
    scenario,
  })
  mark(`gurow:input_observed:${inputId}`)
  return inputId
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
  for (const dispatch of hooks.dispatches) {
    if (dispatch.label_revision === null && dispatch.app_revision <= commit.app_revision) {
      dispatch.label_revision = commit.label_revision
      dispatch.label_commit_app_revision = commit.app_revision
      dispatch.label_commit_ms = commit.commit_ms
    }
  }
  mark(`gurow:labels_committed:${commit.label_revision}`)
}
