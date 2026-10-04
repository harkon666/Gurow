/**
 * Autosave of a personal Path document after completed edits (ADR 0016). Nearby
 * edits are combined into one save, every save carries the revision it was based
 * on, and only a backend acceptance counts as saved. A stale save stops autosave:
 * the local work stays on screen, unsaved, until the owner discards it.
 */

/** What the backend answered to one save. */
export type SaveOutcome =
  | { kind: 'accepted'; revision: number }
  | { kind: 'stale'; acceptedRevision: number }
  | { kind: 'rejected'; detail: string }
  | { kind: 'failed'; detail: string }

/** What the owner is told; only `saved` claims the local document is durable. */
export type SaveState =
  | { kind: 'saved'; revision: number }
  | { kind: 'dirty'; revision: number }
  | { kind: 'saving'; revision: number }
  | { kind: 'conflict'; revision: number; acceptedRevision: number }
  | { kind: 'rejected'; revision: number; detail: string }
  | { kind: 'failed'; revision: number; detail: string }

export interface AutosaveOptions<D> {
  /** The accepted revision the local document starts from. */
  revision: number
  delayMs: number
  /** The current local document, or null while it cannot be read yet. */
  build: () => D | null
  send: (document: D, expectedRevision: number) => Promise<SaveOutcome>
  onState: (state: SaveState) => void
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

export class Autosave<D> {
  private revision: number
  /** Counts completed edits; a save carries the generation its document was built at. */
  private generation = 0
  /** Edits up to this generation are accepted by the backend (or were discarded by a reset). */
  private acceptedGeneration = 0
  /** Advances on reset, so a save still in flight from before it is ignored. */
  private epoch = 0
  private timer: unknown = null
  private inFlight: { generation: number } | null = null
  private halted = false
  private closed = false
  /** The local document at close, read while it still could be; sent once the save in flight settles. */
  private closingDocument: { document: D; generation: number } | null = null
  private state: SaveState
  private readonly setTimer: (run: () => void, ms: number) => unknown
  private readonly clearTimer: (timer: unknown) => void

  constructor(private readonly options: AutosaveOptions<D>) {
    this.revision = options.revision
    this.state = { kind: 'saved', revision: options.revision }
    this.setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms))
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  }

  get current(): SaveState {
    return this.state
  }

  /** Records a completed edit. After a conflict, the edit stays local and is not sent. */
  edit() {
    if (this.closed) return
    this.generation++
    if (this.halted || this.inFlight) return
    this.publish({ kind: 'dirty', revision: this.revision })
    this.schedule()
  }

  /** Sends now, for example after a failed save. Does nothing after a conflict. */
  retry() {
    if (this.halted || this.closed) return
    this.cancelTimer()
    void this.flush()
  }

  /** Starts over from an accepted document, discarding any unsaved local edits. */
  reset(revision: number) {
    this.cancelTimer()
    this.revision = revision
    this.halted = false
    this.epoch++
    this.acceptedGeneration = this.generation
    this.publish({ kind: 'saved', revision })
  }

  /**
   * Leaving the editor. Every edit not yet carried by a save, whether it waits for
   * its delay or was made while a save was in flight, is read now (the document
   * cannot be read after the editor is gone) and sent after that save, on the
   * revision it is accepted at. After a conflict nothing more is sent. The owner is
   * no longer told about the outcome.
   */
  close() {
    if (this.closed) return
    this.cancelTimer()
    const carried = this.inFlight?.generation ?? this.acceptedGeneration
    if (!this.halted && this.generation !== carried) {
      const document = this.options.build()
      if (document !== null) this.closingDocument = { document, generation: this.generation }
    }
    this.closed = true
    if (!this.inFlight) void this.sendClosingDocument()
  }

  private schedule() {
    this.cancelTimer()
    this.timer = this.setTimer(() => {
      this.timer = null
      void this.flush()
    }, this.options.delayMs)
  }

  private cancelTimer() {
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
  }

  async flush() {
    if (this.inFlight || this.halted || this.closed) return
    const document = this.options.build()
    if (document === null) return this.schedule()
    await this.send(document, this.generation)
  }

  private async sendClosingDocument() {
    const pending = this.closingDocument
    this.closingDocument = null
    if (pending) await this.send(pending.document, pending.generation)
  }

  private async send(document: D, generation: number) {
    const epoch = this.epoch
    const basedOn = this.revision
    this.inFlight = { generation }
    this.publish({ kind: 'saving', revision: basedOn })
    let outcome: SaveOutcome
    try {
      outcome = await this.options.send(document, basedOn)
    } catch (error) {
      outcome = { kind: 'failed', detail: error instanceof Error ? error.message : String(error) }
    }
    this.inFlight = null
    // A reset while the save was in flight discarded the edits it carried.
    if (this.epoch !== epoch) return
    switch (outcome.kind) {
      case 'accepted':
        this.revision = outcome.revision
        this.acceptedGeneration = generation
        if (this.generation === generation) this.publish({ kind: 'saved', revision: outcome.revision })
        break
      case 'stale':
        this.halted = true
        this.closingDocument = null
        return this.publish({ kind: 'conflict', revision: basedOn, acceptedRevision: outcome.acceptedRevision })
      case 'rejected':
        this.publish({ kind: 'rejected', revision: basedOn, detail: outcome.detail })
        break
      case 'failed':
        this.publish({ kind: 'failed', revision: basedOn, detail: outcome.detail })
        break
    }
    if (this.closed) return this.sendClosingDocument()
    // Edits made while the save was in flight are sent next, on the newest accepted revision.
    if (this.generation !== generation) {
      this.publish({ kind: 'dirty', revision: this.revision })
      this.schedule()
    }
  }

  private publish(state: SaveState) {
    this.state = state
    if (!this.closed) this.options.onState(state)
  }
}
