/**
 * One editor's unaccepted local work, kept in this browser and brought back (ADR 0016,
 * 0024; US77, US78). The session sits between the editor's autosave and the backend:
 * every save answer and save state passes through it, so the work is kept while it
 * differs from the accepted document it was based on. Work found on opening, or put
 * aside after a conflict, is offered for inspection: discarding forgets it, reapplying
 * merges its changes onto the document accepted now and sends that as a new save,
 * which the backend validates and checks against the current revision. A refusal of
 * any kind leaves the work kept.
 *
 * One operation that replaces the editor's document (reapplying, or loading the
 * accepted version after a conflict) runs at a time. While it runs, the editor should not be edited;
 * an edit that still reaches it (a keyboard shortcut, say) is not lost when the
 * reapplied document replaces what the editor shows: it is kept aside as work of its own.
 */
import type { SaveOutcome, SaveState } from './autosave'
import { hasKeptWork, KEPT_WORK_FORMAT, readKeptWork, removeKeptWork, writeKeptWork, type KeptWork, type WorkContext } from './keptWork'

/** The backend's answer to one save, carrying the accepted document `A`. */
export type SaveAnswer<A> =
  | { kind: 'accepted'; accepted: A }
  | { kind: 'stale'; revision: number }
  | { kind: 'refused'; detail: string }
  | { kind: 'failed'; detail: string }

/** How reapplying one piece of kept work went; only `idle` and `working` are not outcomes. */
export type ReapplyStatus =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'refused'; detail: string }
  | { kind: 'stale'; revision: number }
  | { kind: 'failed'; detail: string }

export interface KeptEntry<D> {
  work: KeptWork<D>
  changes: string[]
  status: ReapplyStatus
}

export interface KeptWorkView<D> {
  /** Work offered for reapplying, oldest first. */
  entries: KeptEntry<D>[]
  /** Why records found on opening could not be restored. */
  refused: string[]
  /** The editor's own unaccepted changes. */
  liveChanges: string[]
  /** Reapplying the editor's own work after a conflict. */
  live: ReapplyStatus
  /** A reapplication or load is running: nothing else may be reapplied, discarded or loaded. */
  busy: boolean
}

export interface KeptWorkSessionOptions<D, A> {
  context: WorkContext
  /** The accepted document the editor opened with. */
  initial: { revision: number; work: D }
  storage: Storage | null
  problem: (document: unknown) => string | null
  same: (a: D, b: D) => boolean
  merge: (base: D, mine: D, current: D) => D
  changes: (base: D, mine: D) => string[]
  /** The editor's local document now; null while it cannot be read. */
  build: () => D | null
  read: () => Promise<{ ok: true; revision: number; work: D; accepted: A } | { ok: false; detail: string }>
  save: (work: D, expectedRevision: number) => Promise<SaveAnswer<A>>
  revisionOf: (accepted: A) => number
  /** Shows an accepted document in the editor, discarding what it showed, and restarts autosave from it. */
  show: (accepted: A) => void
  onView: (view: KeptWorkView<D>) => void
  /** An autosave was accepted. */
  onAccepted?: (accepted: A) => void
  newId?: () => string
  now?: () => Date
}

type Attempt<A> =
  | { kind: 'accepted'; accepted: A }
  | { kind: 'refused'; detail: string; current: A }
  | { kind: 'stale'; revision: number }
  | { kind: 'failed'; detail: string }

export class KeptWorkSession<D, A> {
  /** The accepted document local work is based on. */
  private base: { revision: number; work: D }
  /** This editor session's own work; a new id once it is put aside, discarded or accepted. */
  private liveId: string
  private view: KeptWorkView<D> = { entries: [], refused: [], liveChanges: [], live: { kind: 'idle' }, busy: false }
  private closed = false
  private readonly newId: () => string
  private readonly now: () => Date

  constructor(private readonly options: KeptWorkSessionOptions<D, A>) {
    this.base = options.initial
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.now = options.now ?? (() => new Date())
    this.liveId = this.newId()
  }

  current() { return this.view }

  /** Offers the work this Account kept here for this context, except what the accepted document already holds. */
  open() {
    this.closed = false
    const { storage, context, problem, same, merge } = this.options
    if (!storage) return
    const result = readKeptWork<D>(storage, context, problem)
    const opened = this.base.work
    const pending = result.kept.filter((work) => {
      if (work.id === this.liveId) return false
      if (!same(merge(work.base, work.mine, opened), opened)) return true
      removeKeptWork(storage, context, work.id)
      return false
    })
    this.publish({ entries: pending.map((work) => this.entryOf(work)), refused: result.refused })
  }

  close() { this.closed = true }

  /** Records the editor's local document; it is kept while it differs from the accepted one. */
  remember() {
    const mine = this.options.build()
    if (mine === null) return
    const { storage, context, same, changes } = this.options
    this.publish({ liveChanges: changes(this.base.work, mine) })
    if (!storage) return
    if (same(mine, this.base.work)) return removeKeptWork(storage, context, this.liveId)
    writeKeptWork(storage, this.record(this.liveId, this.base, mine))
  }

  /** Sends one autosave, and bases later local work on what the backend accepted. */
  async autosave(document: D, expectedRevision: number): Promise<SaveOutcome> {
    const answer = await this.save(document, expectedRevision)
    switch (answer.kind) {
      case 'accepted': {
        const revision = this.options.revisionOf(answer.accepted)
        this.base = { revision, work: document }
        this.options.onAccepted?.(answer.accepted)
        return { kind: 'accepted', revision }
      }
      case 'stale': return { kind: 'stale', acceptedRevision: answer.revision }
      case 'refused': return { kind: 'rejected', detail: answer.detail }
      case 'failed': return { kind: 'failed', detail: answer.detail }
    }
  }

  /** Follows autosave: accepted work is forgotten, anything else is kept. */
  saveStateChanged(state: SaveState) {
    if (state.kind === 'saved') this.forgetLive()
    else this.remember()
  }

  /** The editor now shows an accepted document: later local work is based on it. */
  shown(revision: number, work: D) {
    this.base = { revision, work }
  }

  /**
   * After a conflict: reads the accepted document and shows it, with the editor's local
   * work kept aside (offered for reapplying) or discarded. The whole operation holds the
   * session, so nothing is reapplied or discarded while the read is pending. If the
   * document cannot be read, nothing changes and the reason is returned.
   */
  async loadAccepted(keepMine: boolean): Promise<{ kind: 'shown' } | { kind: 'ignored' } | { kind: 'failed'; detail: string }> {
    if (this.view.busy || this.closed) return { kind: 'ignored' }
    this.publish({ busy: true })
    let current: Awaited<ReturnType<KeptWorkSessionOptions<D, A>['read']>>
    try {
      current = await this.options.read()
    } catch {
      current = { ok: false, detail: 'the backend could not be reached' }
    }
    if (this.closed) return { kind: 'ignored' }
    if (!current.ok) {
      this.publish({ busy: false })
      return { kind: 'failed', detail: current.detail }
    }
    // Read only now, so it holds every edit made up to the moment the editor is replaced.
    const mine = this.options.build()
    if (keepMine && mine !== null && !this.options.same(mine, this.base.work)) {
      const work = this.record(this.liveId, this.base, mine)
      if (this.options.storage) writeKeptWork(this.options.storage, work)
      this.publish({ entries: [...this.view.entries, this.entryOf(work)] })
    } else {
      this.forgetLive()
    }
    this.restartLive()
    this.options.show(current.accepted)
    this.publish({ busy: false })
    return { kind: 'shown' }
  }

  /** Reapplies the editor's own work after a conflict; the editor shows the result once it is accepted. */
  async reapplyLive() {
    const mine = this.options.build()
    if (mine === null || this.view.busy || this.closed) return
    this.publish({ busy: true, live: { kind: 'working' } })
    const outcome = await this.attempt(this.base.work, mine)
    if (this.closed) return
    if (outcome.kind !== 'accepted') {
      // The local work stays on screen: the conflict is not resolved.
      return this.publish({ busy: false, live: outcome.kind === 'refused' ? { kind: 'refused', detail: outcome.detail } : outcome })
    }
    this.forgetLive()
    this.restartLive()
    this.replace(mine, outcome.accepted)
    this.publish({ busy: false })
  }

  /** Reapplies one piece of kept work; the editor must hold no unaccepted work of its own. */
  async reapply(id: string) {
    const entry = this.view.entries.find((e) => e.work.id === id)
    if (!entry || this.view.busy || this.closed) return
    const { storage, context } = this.options
    // Reapplied or discarded in another tab meanwhile.
    if (storage && !hasKeptWork(storage, context, id)) return this.drop(id)
    const shown = this.options.build()
    this.publish({ busy: true })
    this.setStatus(id, { kind: 'working' })
    const outcome = await this.attempt(entry.work.base, entry.work.mine)
    if (this.closed) return
    if (outcome.kind === 'accepted') {
      this.drop(id)
      this.replace(shown, outcome.accepted)
    } else if (outcome.kind === 'refused') {
      // The editor held nothing unaccepted: it shows the version the changes were refused against.
      this.replace(shown, outcome.current)
      this.setStatus(id, { kind: 'refused', detail: outcome.detail })
    } else {
      this.setStatus(id, outcome)
    }
    this.publish({ busy: false })
  }

  discard(id: string) {
    if (this.view.busy) return
    this.drop(id)
  }

  dismissRefused() { this.publish({ refused: [] }) }

  /**
   * Shows an accepted document in place of `before`, what the editor showed when the
   * reapplication started. Edits made since are kept as work of their own, based on
   * `before`, so replacing the editor's document never loses them.
   */
  private replace(before: D | null, accepted: A) {
    const after = this.options.build()
    this.options.show(accepted)
    if (before === null || after === null || this.options.same(before, after)) return
    const work = this.record(this.newId(), { revision: this.options.revisionOf(accepted), work: before }, after)
    if (this.options.storage) writeKeptWork(this.options.storage, work)
    this.publish({ entries: [...this.view.entries, this.entryOf(work)] })
  }

  /**
   * Reads the accepted document, merges the changes onto it and saves that as a new,
   * validated save. A refusal carries the accepted document it was checked against.
   */
  private async attempt(from: D, mine: D): Promise<Attempt<A>> {
    const { read, merge, same, problem } = this.options
    let current: Awaited<ReturnType<typeof read>>
    try {
      current = await read()
    } catch {
      current = { ok: false, detail: 'the backend could not be reached' }
    }
    if (!current.ok) return { kind: 'failed', detail: `could not load the saved version (${current.detail})` }
    const merged = merge(from, mine, current.work)
    if (same(merged, current.work)) return { kind: 'accepted', accepted: current.accepted }
    const reason = problem(merged)
    if (reason) return { kind: 'refused', detail: reason, current: current.accepted }
    const answer = await this.save(merged, current.revision)
    return answer.kind === 'refused' ? { ...answer, current: current.accepted } : answer
  }

  private async save(document: D, expectedRevision: number): Promise<SaveAnswer<A>> {
    try {
      return await this.options.save(document, expectedRevision)
    } catch {
      return { kind: 'failed', detail: 'the backend could not be reached' }
    }
  }

  private forgetLive() {
    if (this.options.storage) removeKeptWork(this.options.storage, this.options.context, this.liveId)
    this.publish({ liveChanges: [], live: { kind: 'idle' } })
  }

  /** Starts the editor's own work over: what was kept for it stays where it is. */
  private restartLive() {
    this.liveId = this.newId()
    this.publish({ liveChanges: [], live: { kind: 'idle' } })
  }

  private drop(id: string) {
    if (this.options.storage) removeKeptWork(this.options.storage, this.options.context, id)
    this.publish({ entries: this.view.entries.filter((entry) => entry.work.id !== id) })
  }

  private setStatus(id: string, status: ReapplyStatus) {
    this.publish({ entries: this.view.entries.map((entry) => (entry.work.id === id ? { ...entry, status } : entry)) })
  }

  private record(id: string, from: { revision: number; work: D }, mine: D): KeptWork<D> {
    return { format: KEPT_WORK_FORMAT, id, context: this.options.context, baseRevision: from.revision, base: from.work, mine, editedAt: this.now().toISOString() }
  }

  private entryOf(work: KeptWork<D>): KeptEntry<D> {
    return { work, changes: this.options.changes(work.base, work.mine), status: { kind: 'idle' } }
  }

  private publish(change: Partial<KeptWorkView<D>>) {
    this.view = { ...this.view, ...change }
    if (!this.closed) this.options.onView(this.view)
  }
}
