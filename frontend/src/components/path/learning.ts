/**
 * The owner's learning records for one personal Path: Task completion, rewards,
 * Mastery declarations, XP Thresholds and Access Overrides. Each action goes to the
 * backend, and the records shown are only ever the state the backend returned
 * (US79): a pending or failed action never changes them. Every backend action is
 * idempotent, so retrying one whose answer was lost cannot multiply a reward.
 */

/** What the backend answered to one read or action. */
export type LearningOutcome<S> =
  | { kind: 'ok'; state: S }
  | { kind: 'failed'; detail: string }

export interface LearningView<S, A> {
  /** The last backend-confirmed records, or null before the first read succeeds. */
  records: S | null
  /** The action awaiting the backend; others wait until it is answered. */
  pending: A | null
  /** The last action the backend did not confirm; it changed nothing shown. */
  failed: { action: A; detail: string } | null
  loadError: string | null
}

export interface LearningRecordsOptions<S, A> {
  read: () => Promise<LearningOutcome<S>>
  send: (action: A) => Promise<LearningOutcome<S>>
  onView: (view: LearningView<S, A>) => void
}

export class LearningRecords<S, A> {
  private view: LearningView<S, A> = { records: null, pending: null, failed: null, loadError: null }
  /** Requests are numbered as issued; an answer older than the one shown is dropped. */
  private issued = 0
  private shown = 0
  private closed = false
  /**
   * A read requested while an action is in flight. The backend may serve it before
   * or after the action commits, so it is sent once the action is answered instead:
   * by then it can only see the action's result.
   */
  private readAfterAction = false

  constructor(private readonly options: LearningRecordsOptions<S, A>) {}

  current() { return this.view }

  /** Reads the records again, e.g. after a document save added Skills or Tasks. */
  async refresh() {
    if (this.view.pending !== null) {
      this.readAfterAction = true
      return
    }
    const ticket = ++this.issued
    const outcome = await this.settle(this.options.read())
    if (this.closed) return
    if (outcome.kind === 'ok') this.apply(ticket, outcome.state, {})
    else if (ticket > this.shown) this.publish({ loadError: outcome.detail })
  }

  /** Sends one action; returns whether the backend confirmed it. */
  async perform(action: A): Promise<boolean> {
    if (this.closed || this.view.pending !== null) return false
    const ticket = ++this.issued
    this.publish({ pending: action, failed: null })
    const outcome = await this.settle(this.options.send(action))
    if (this.closed) return false
    if (outcome.kind === 'ok') this.apply(ticket, outcome.state, { pending: null })
    else this.publish({ pending: null, failed: { action, detail: outcome.detail } })
    if (this.readAfterAction) {
      this.readAfterAction = false
      void this.refresh()
    }
    return outcome.kind === 'ok'
  }

  /** Sends the failed action again, unchanged. */
  retry() {
    const failed = this.view.failed
    return failed ? this.perform(failed.action) : Promise.resolve(false)
  }

  dismiss() { this.publish({ failed: null }) }

  close() { this.closed = true }

  private apply(ticket: number, records: S, rest: Partial<LearningView<S, A>>) {
    if (ticket < this.shown) return this.publish(rest)
    this.shown = ticket
    this.publish({ ...rest, records, loadError: null })
  }

  private async settle(request: Promise<LearningOutcome<S>>): Promise<LearningOutcome<S>> {
    try {
      return await request
    } catch (error) {
      return { kind: 'failed', detail: error instanceof Error ? error.message : String(error) }
    }
  }

  private publish(change: Partial<LearningView<S, A>>) {
    if (this.closed) return
    this.view = { ...this.view, ...change }
    this.options.onView(this.view)
  }
}
