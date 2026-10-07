import { applyOps, completionEffects, localColumns, onlyMembershipChanged, sameArrangement, type Board, type BoardColumn, type BoardOp } from './boardModel'

/**
 * Keeps one Task Board's local intents in step with the backend (ADR 0016, 0027, 0028).
 * The board shown is the last accepted board plus the intents not yet accepted; nothing
 * is shown as saved before the backend answers. Each save sends the whole resulting
 * board against the accepted revision, and the accepted board an intent was based on
 * never changes without the owner's decision:
 *
 * - a refused or failed save keeps its intents; Retry sends them again on the same
 *   revision (a lost answer is then accepted without changing anything again);
 * - a stale save, or a newer board read while intents wait to be retried, is a conflict:
 *   the owner reapplies the intents to the newer board or discards them;
 * - an intent that no longer applies (its column was removed elsewhere) is kept and
 *   shown until the owner gives it a new destination or discards it.
 *
 * Only intents never sent yet follow a newer board on their own, and only when that
 * board differs by cards added or removed (this tab's own Task saves, typically). A save
 * waits while the board's Tasks differ from this tab's Tasks for the Skill, so a new or
 * deleted Task reaches the backend before an arrangement relying on it.
 */

export type BoardSaveAnswer<L> =
  | { kind: 'accepted'; board: Board; learning?: L }
  | { kind: 'stale'; current: Board }
  | { kind: 'refused'; detail: string }
  | { kind: 'failed'; detail: string }

export type BoardStatus =
  | { kind: 'saved' }
  | { kind: 'waiting' }
  | { kind: 'saving' }
  | { kind: 'refused'; detail: string }
  | { kind: 'failed'; detail: string }
  | { kind: 'conflict'; current: Board }
  /** Intents that cannot apply to the accepted board; nothing is sent until each is redirected or discarded. */
  | { kind: 'unapplied'; ops: BoardOp[] }

export interface BoardView {
  /** The last accepted board, or null before it is loaded. */
  accepted: Board | null
  /** The board as shown: accepted plus pending intents and this tab's unsaved Tasks. */
  columns: BoardColumn[]
  status: BoardStatus
  pending: number
  loadError: string | null
  /** Tasks this tab still holds that the backend's current board no longer has (deleted or archived elsewhere). */
  goneTaskIds: string[]
  /**
   * `columns` plus the Tasks the backend's board holds that this tab's document does not know yet
   * (added elsewhere): what a save would carry, so consequences shown before one include them.
   */
  boardColumns: BoardColumn[]
}

export interface BoardSyncOptions<L> {
  read: () => Promise<{ ok: true; board: Board } | { ok: false; detail: string }>
  save: (expectedRevision: number, columns: BoardColumn[]) => Promise<BoardSaveAnswer<L>>
  /** This tab's active Task IDs of the Skill, in their document order. */
  localTaskIds: () => string[]
  /** The Skill's Task IDs in the document the backend last accepted from this tab. */
  savedTaskIds: () => string[]
  onView: (view: BoardView) => void
  /** Called with what an accepted save answered. */
  onAccepted?: (learning: L | undefined) => void
  /**
   * Called when the first board is read, and when a board read or chosen in recovery replaces one
   * whose Completion Column held other Tasks: completion may have changed since the records were read.
   */
  onCompletionChanged?: () => void
}

export class BoardSync<L = unknown> {
  private accepted: Board | null = null
  private ops: BoardOp[] = []
  private status: BoardStatus = { kind: 'saved' }
  private loadError: string | null = null
  private inflight = false
  private closed = false
  /** Reads are numbered as issued; `acceptedAt` is the number of reads issued when a save was last accepted. */
  private reads = 0
  private readShown = 0
  private acceptedAt = 0
  /** Counts accepted documents; `boardEpoch` is the count when the accepted board was read or saved. */
  private docEpoch = 0
  private boardEpoch = 0
  /** The `docEpoch` when the conflicting board (`status.current`) was read or answered. */
  private conflictEpoch = 0
  /** A save whose answer was lost: the backend may hold it, so only a backend answer can say "saved" again. */
  private uncertain = false

  constructor(private readonly options: BoardSyncOptions<L>) {}

  view(): BoardView {
    if (!this.accepted) return { accepted: null, columns: [], status: this.status, pending: this.ops.length, loadError: this.loadError, goneTaskIds: [], boardColumns: [] }
    const { pending, gone, foreign } = this.membership()
    const localIds = this.options.localTaskIds()
    const columns = localColumns(this.accepted.columns, this.ops, localIds, pending)
    const boardColumns = foreign.length === 0 ? columns : localColumns(this.accepted.columns, this.ops, [...localIds, ...foreign], pending)
    return { accepted: this.accepted, columns, status: this.status, pending: this.ops.length, loadError: this.loadError, goneTaskIds: gone, boardColumns }
  }

  /** The document the backend accepted from this tab changed: a board read before it may miss its Tasks. */
  documentAccepted() { this.docEpoch++ }

  /**
   * Compares this tab's Tasks with the accepted board. A Task the board lacks is on its way
   * when this tab created it and has not saved it, or saved it after the board was read;
   * otherwise it was deleted or archived elsewhere and this tab's document is out of date.
   * The board waits for Tasks on their way, and for Tasks deleted here that the backend
   * still holds; Tasks gone elsewhere, or added elsewhere (`foreign`), do not hold it back.
   */
  private membership() {
    const local = new Set(this.options.localTaskIds())
    const saved = new Set(this.options.savedTaskIds())
    const held = new Set(this.accepted!.columns.flatMap((column) => column.taskIds))
    const fresh = this.boardEpoch >= this.docEpoch
    const missing = [...local].filter((id) => !held.has(id))
    const pending = new Set(missing.filter((id) => !saved.has(id) || !fresh))
    const gone = missing.filter((id) => !pending.has(id))
    const absent = [...held].filter((id) => !local.has(id))
    const deletedHere = absent.filter((id) => saved.has(id) || !fresh)
    const foreign = absent.filter((id) => !deletedHere.includes(id))
    return { pending, gone, foreign, settled: pending.size === 0 && deletedHere.length === 0 }
  }

  /**
   * Reads the board again. Without pending intents it simply becomes the accepted board.
   * With them, a newer board replaces the base only for intents never sent and only for
   * added or removed cards; otherwise the owner decides, as after a stale save.
   */
  async refresh() {
    if (this.inflight || this.closed) return
    const ticket = ++this.reads
    const epoch = this.docEpoch
    const result = await this.options.read()
    if (this.closed || this.inflight) return
    // A read issued before an accepted save, older than a read already shown, or holding an older
    // revision than the accepted board may predate it: it never takes the board back.
    if (ticket <= this.acceptedAt || ticket < this.readShown) return
    if (result.ok && this.accepted && result.board.revision < this.accepted.revision) return
    this.readShown = ticket
    if (!result.ok) {
      this.loadError = result.detail
      return this.publish()
    }
    this.loadError = null
    const board = result.board
    if (this.status.kind === 'conflict') return this.conflict(board, epoch)
    const unchanged = this.accepted !== null && board.revision === this.accepted.revision
    const followable = this.status.kind === 'saved' || this.status.kind === 'waiting'
    if (this.ops.length > 0 && !unchanged && !(followable && this.accepted && onlyMembershipChanged(this.accepted.columns, board.columns))) {
      return this.conflict(board, epoch)
    }
    this.adopt(board, epoch)
    this.kick()
  }

  /** A newer board awaits the owner's decision; `epoch` says which of this tab's documents it was read after. */
  private conflict(current: Board, epoch: number) {
    this.status = { kind: 'conflict', current }
    this.conflictEpoch = epoch
    this.publish()
  }

  /**
   * Makes a board the backend holds the accepted one, with the document epoch it was read
   * after. The first board may show completion made elsewhere after this tab read its learning
   * records, and one whose Completion Column holds other Tasks than before changed completion
   * elsewhere (or in a lost save): either way the learning records are read again.
   */
  private adopt(board: Board, epoch: number) {
    const before = this.accepted
    this.accepted = board
    this.boardEpoch = epoch
    if (!before || completionEffects(before.columns, board.columns).length > 0) this.options.onCompletionChanged?.()
  }

  /** Records one intent. It is saved as soon as the board can be saved; after a refusal or failure, with the next Retry. */
  perform(op: BoardOp) {
    if (!this.accepted || this.closed) return
    this.ops.push(op)
    this.kick()
  }

  /** Sends the pending intents if nothing is in flight, nothing awaits the owner, and the backend holds this tab's Tasks. */
  kick() {
    if (this.closed || this.inflight || !this.accepted) return this.publish()
    if (this.status.kind === 'conflict' || this.status.kind === 'refused' || this.status.kind === 'failed') return this.publish()
    if (this.ops.length === 0 && !this.uncertain) {
      this.status = { kind: 'saved' }
      return this.publish()
    }
    const { pending, settled } = this.membership()
    const result = applyOps(this.accepted.columns, this.ops, pending)
    if (result.dropped.length > 0) {
      this.status = { kind: 'unapplied', ops: result.dropped }
      return this.publish()
    }
    if (result.waiting.length > 0 || !settled) {
      this.status = { kind: 'waiting' }
      return this.publish()
    }
    // After a lost answer, even an arrangement equal to the accepted board is sent: the backend may hold the lost
    // save, and only its answer (accepted unchanged, or stale with the board it holds) can say which.
    if (sameArrangement(result.columns, this.accepted.columns) && !this.uncertain) {
      this.ops = []
      this.status = { kind: 'saved' }
      return this.publish()
    }
    void this.send(this.accepted.revision, result.columns, [...this.ops])
  }

  /** Sends one save; its answer acknowledges exactly the intents it carried, whatever was added or forgotten meanwhile. */
  private async send(expectedRevision: number, columns: BoardColumn[], carried: BoardOp[]) {
    const epoch = this.docEpoch
    this.inflight = true
    this.status = { kind: 'saving' }
    this.publish()
    let answer: BoardSaveAnswer<L>
    try {
      answer = await this.options.save(expectedRevision, columns)
    } catch {
      answer = { kind: 'failed', detail: 'the backend could not be reached' }
    }
    this.inflight = false
    if (this.closed) return
    switch (answer.kind) {
      case 'accepted': {
        this.acceptedAt = this.reads
        this.accepted = answer.board
        this.boardEpoch = epoch
        this.uncertain = false
        const acknowledged = new Set(carried)
        this.ops = this.ops.filter((op) => !acknowledged.has(op))
        this.status = { kind: 'saved' }
        this.options.onAccepted?.(answer.learning)
        return this.kick()
      }
      case 'stale':
        this.uncertain = false
        return this.conflict(answer.current, epoch)
      case 'refused':
      case 'failed':
        // A refusal is the backend's answer; a failure may have been committed without one.
        this.uncertain = answer.kind === 'failed'
        this.status = { kind: answer.kind, detail: answer.detail }
        return this.publish()
    }
  }

  /** Sends the kept intents again, on the revision they were based on. */
  retry() {
    if (this.status.kind !== 'refused' && this.status.kind !== 'failed') return
    this.status = { kind: 'waiting' }
    this.kick()
  }

  /**
   * Drops every pending intent; after a conflict, shows the newer board. After a lost
   * answer the accepted board is confirmed with the backend before it is called saved.
   */
  discard() {
    if (this.inflight) return
    if (this.status.kind === 'conflict') this.adopt(this.status.current, this.conflictEpoch)
    this.ops = []
    this.status = { kind: 'waiting' }
    this.kick()
  }

  /** After a conflict: applies the pending intents to the newer board and saves the result. */
  reapply() {
    if (this.status.kind !== 'conflict' || this.inflight) return
    this.adopt(this.status.current, this.conflictEpoch)
    this.status = { kind: 'waiting' }
    this.kick()
  }

  /** Gives an intent that no longer applies a new destination column. */
  redirect(op: BoardOp, columnId: string, columnName: string) {
    if (this.status.kind !== 'unapplied' || op.kind !== 'move') return
    this.ops = this.ops.map((o) => (o === op ? { ...op, columnId, columnName, index: Number.MAX_SAFE_INTEGER } : o))
    this.status = { kind: 'waiting' }
    this.kick()
  }

  /**
   * Drops the intents about a Task this tab removed (deleted before or after its save, or
   * archived): the owner's removal decides them. Intents about other Tasks stay.
   */
  forgetTask(taskId: string) {
    const before = this.ops.length
    this.ops = this.ops.filter((op) => op.kind !== 'move' || op.taskId !== taskId)
    if (this.status.kind === 'unapplied') {
      const ops = this.status.ops.filter((op) => op.kind !== 'move' || op.taskId !== taskId)
      this.status = ops.length > 0 ? { kind: 'unapplied', ops } : { kind: 'waiting' }
    }
    if (this.ops.length !== before) this.kick()
  }

  /** Drops only the intents that no longer apply, keeping and saving the others. */
  discardUnapplied() {
    if (this.status.kind !== 'unapplied') return
    const dropped = new Set(this.status.ops)
    this.ops = this.ops.filter((op) => !dropped.has(op))
    this.status = { kind: 'waiting' }
    this.kick()
  }

  close() { this.closed = true }

  private publish() {
    if (!this.closed) this.options.onView(this.view())
  }
}
