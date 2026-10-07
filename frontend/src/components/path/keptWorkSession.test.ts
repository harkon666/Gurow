import { describe, expect, it } from 'bun:test'
import { keptWorkKey, layoutChanges, layoutWorkProblem, readKeptWork, reapplyLayout, sameLayoutWork, type LayoutWork, type WorkContext } from './keptWork'
import { KeptWorkSession, type KeptWorkView, type SaveAnswer } from './keptWorkSession'

class MemoryStorage implements Storage {
  private items = new Map<string, string>()
  get length() { return this.items.size }
  clear() { this.items.clear() }
  getItem(key: string) { return this.items.get(key) ?? null }
  key(index: number) { return [...this.items.keys()][index] ?? null }
  removeItem(key: string) { this.items.delete(key) }
  setItem(key: string, value: string) { this.items.set(key, value) }
}

/** A deferred backend answer the test releases when it chooses. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

type Accepted = { revision: number; cards: LayoutWork }
const at = (vectors: number, matrices: number): LayoutWork => [{ id: 'vec', position: { x: vectors, y: 0 } }, { id: 'mat', position: { x: matrices, y: 0 } }]
const context: WorkContext = { accountId: 'carla', kind: 'layout', pathId: 'p', versionId: 'v1' }
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * A session over a layout editor: `local` is what the canvas shows, `backend` the
 * accepted layout. Reads answer at once; saves wait until the test releases them.
 */
function harness(storage = new MemoryStorage()) {
  let local = at(0, 100)
  const backend: Accepted = { revision: 1, cards: at(0, 100) }
  const saves: { cards: LayoutWork; expectedRevision: number; answer: ReturnType<typeof deferred<SaveAnswer<Accepted>>> }[] = []
  const shown: number[] = []
  const views: KeptWorkView<LayoutWork>[] = []
  /** Reads waiting for the test to release them; reads answer at once while `holdReads` is off. */
  const reads: (() => void)[] = []
  let holdReads = false
  const session: KeptWorkSession<LayoutWork, Accepted> = new KeptWorkSession<LayoutWork, Accepted>({
    context,
    initial: { revision: 1, work: at(0, 100) },
    storage,
    problem: layoutWorkProblem,
    same: sameLayoutWork,
    merge: reapplyLayout,
    changes: (base, mine) => layoutChanges(base, mine, new Map([['vec', 'Vectors'], ['mat', 'Matrices']])),
    build: () => structuredClone(local),
    read: async () => {
      if (holdReads) await new Promise<void>((release) => reads.push(release))
      return { ok: true, revision: backend.revision, work: structuredClone(backend.cards), accepted: structuredClone(backend) }
    },
    save: (cards, expectedRevision) => {
      const answer = deferred<SaveAnswer<Accepted>>()
      saves.push({ cards, expectedRevision, answer })
      return answer.promise
    },
    revisionOf: (accepted) => accepted.revision,
    show: (accepted) => {
      shown.push(accepted.revision)
      local = structuredClone(accepted.cards)
      session.shown(accepted.revision, structuredClone(accepted.cards))
      // The editor restarts autosave from the shown document, which reports it saved.
      session.saveStateChanged({ kind: 'saved', revision: accepted.revision })
    },
    onView: (view) => views.push(view),
  })
  session.open()
  return {
    session, storage, backend, saves, shown, reads,
    holdReads(on: boolean) { holdReads = on },
    edit(cards: LayoutWork) { local = cards; session.remember() },
    local: () => local,
    view: () => session.current(),
    kept: () => readKeptWork<LayoutWork>(storage, context, layoutWorkProblem).kept,
    /** The backend accepts save `i` as its next revision, and answers it. */
    accept(i: number) {
      const save = saves[i]
      backend.revision++
      backend.cards = structuredClone(save.cards)
      save.answer.resolve({ kind: 'accepted', accepted: structuredClone(backend) })
    },
  }
}

describe('kept work session', () => {
  it('keeps an edit made while reapplied work is being saved, instead of replacing it with the reapplied document', async () => {
    const h = harness()
    // A conflict: the owner moved Matrices on revision 1 while another tab saved Vectors as revision 2.
    h.edit(at(0, 300))
    h.backend.revision = 2
    h.backend.cards = at(50, 100)
    const reapplying = h.session.reapplyLive()
    await settle()
    expect(h.view().busy).toBe(true)
    expect(h.saves.map((s) => [s.cards, s.expectedRevision])).toEqual([[at(50, 300), 2]])
    // An edit reaches the editor while the save is pending (a keyboard shortcut, say).
    h.edit(at(0, 400))
    h.accept(0)
    await reapplying
    // The accepted reapplication is shown, and the later edit is kept, not lost.
    expect(h.shown).toEqual([3])
    expect(h.local()).toEqual(at(50, 300))
    expect(h.view().busy).toBe(false)
    expect(h.view().entries.map((e) => e.changes)).toEqual([['Moved the card “Matrices”']])
    const kept = h.kept()
    expect(kept).toHaveLength(1)
    expect(kept[0].base).toEqual(at(0, 300))
    expect(kept[0].mine).toEqual(at(0, 400))
    // Reapplied later, it builds on what was accepted.
    void h.session.reapply(kept[0].id)
    await settle()
    expect(h.saves[1].cards).toEqual(at(50, 400))
    expect(h.saves[1].expectedRevision).toBe(3)
  })

  it('keeps an edit that reaches the editor while an archival is pending, instead of replacing it with the answered document', async () => {
    const h = harness()
    const archival = deferred<{ ok: true; accepted: Accepted }>()
    const accepting = h.session.accept(() => archival.promise)
    expect(h.view().busy).toBe(true)
    // Nothing else runs meanwhile.
    expect(await h.session.accept(async () => ({ ok: true, accepted: { revision: 9, cards: at(9, 9) } }))).toEqual({ kind: 'ignored' })
    await h.session.reapplyLive()
    expect(h.saves).toEqual([])
    // An edit still reaches the editor (a keyboard shortcut, say) before the answer.
    h.edit(at(0, 400))
    archival.resolve({ ok: true, accepted: { revision: 2, cards: at(0, 100) } })
    expect(await accepting).toEqual({ kind: 'shown' })
    expect(h.shown).toEqual([2])
    expect(h.local()).toEqual(at(0, 100))
    expect(h.view().busy).toBe(false)
    expect(h.view().entries.map((e) => e.changes)).toEqual([['Moved the card “Matrices”']])
    const kept = h.kept()
    expect(kept).toHaveLength(1)
    expect([kept[0].base, kept[0].mine, kept[0].baseRevision]).toEqual([at(0, 100), at(0, 400), 2])
  })

  it('changes nothing when an archival fails, and starts none while a reapplication holds the session', async () => {
    const h = harness()
    expect(await h.session.accept(async () => ({ ok: false, detail: 'refused' }))).toEqual({ kind: 'failed', detail: 'refused' })
    expect(await h.session.accept(async () => { throw new Error('offline') })).toEqual({ kind: 'failed', detail: 'the backend could not be reached' })
    expect([h.shown, h.local(), h.view().busy, h.kept()]).toEqual([[], at(0, 100), false, []])
    h.edit(at(0, 300))
    h.backend.revision = 2
    const reapplying = h.session.reapplyLive()
    await settle()
    let ran = false
    expect(await h.session.accept(async () => { ran = true; return { ok: true, accepted: { revision: 5, cards: at(5, 5) } } })).toEqual({ kind: 'ignored' })
    expect(ran).toBe(false)
    h.accept(0)
    await reapplying
    expect(h.shown).toEqual([3])
  })

  it('forgets the editor\'s work once its reapplication is accepted with nothing edited meanwhile', async () => {
    const h = harness()
    h.edit(at(0, 300))
    expect(h.kept()).toHaveLength(1)
    h.backend.revision = 2
    const reapplying = h.session.reapplyLive()
    await settle()
    h.accept(0)
    await reapplying
    expect(h.kept()).toHaveLength(0)
    expect(h.view().entries).toEqual([])
  })

  it('runs one reapplication at a time, so an older answer never replaces a newer accepted document', async () => {
    const storage = new MemoryStorage()
    // Two pieces of work kept from earlier sessions, both based on revision 1.
    for (const [id, cards] of [['a', at(10, 100)], ['b', at(0, 200)]] as const) {
      storage.setItem(keptWorkKey(context, id), JSON.stringify({ format: 1, id, context, baseRevision: 1, base: at(0, 100), mine: cards, editedAt: `2026-10-0${id === 'a' ? 5 : 6}T10:00:00.000Z` }))
    }
    const h = harness(storage)
    expect(h.view().entries.map((e) => e.work.id)).toEqual(['a', 'b'])
    const first = h.session.reapply('a')
    await settle()
    // While the first is pending, nothing else is reapplied, discarded or put aside.
    await h.session.reapply('b')
    h.session.discard('b')
    expect(h.saves).toHaveLength(1)
    expect(h.view().entries.map((e) => [e.work.id, e.status.kind])).toEqual([['a', 'working'], ['b', 'idle']])
    h.accept(0)
    await first
    expect(h.shown).toEqual([2])
    // The second then builds on the first's accepted revision.
    const second = h.session.reapply('b')
    await settle()
    expect(h.saves[1].expectedRevision).toBe(2)
    expect(h.saves[1].cards).toEqual(at(10, 200))
    h.accept(1)
    await second
    expect(h.shown).toEqual([2, 3])
    expect(h.view().entries).toEqual([])
    expect(h.kept()).toHaveLength(0)
  })

  it('keeps the work and the editor\'s document when the reapplied save is stale or fails', async () => {
    const h = harness()
    h.edit(at(0, 300))
    h.backend.revision = 2
    const reapplying = h.session.reapplyLive()
    await settle()
    h.saves[0].answer.resolve({ kind: 'stale', revision: 3 })
    await reapplying
    expect(h.view().live).toEqual({ kind: 'stale', revision: 3 })
    expect(h.shown).toEqual([])
    expect(h.local()).toEqual(at(0, 300))
    expect(h.kept().map((k) => k.mine)).toEqual([at(0, 300)])
  })

  it('maps autosave answers and bases later work on what was accepted', async () => {
    const h = harness()
    h.edit(at(0, 300))
    const saving = h.session.autosave(at(0, 300), 1)
    h.accept(0)
    expect(await saving).toEqual({ kind: 'accepted', revision: 2 })
    h.session.saveStateChanged({ kind: 'saved', revision: 2 })
    expect(h.kept()).toHaveLength(0)
    // A further edit is kept against the accepted revision 2.
    h.edit(at(0, 350))
    h.session.saveStateChanged({ kind: 'dirty', revision: 2 })
    expect(h.kept().map((k) => [k.baseRevision, k.base])).toEqual([[2, at(0, 300)]])
    const stale = h.session.autosave(at(0, 350), 2)
    h.saves[1].answer.resolve({ kind: 'stale', revision: 3 })
    expect(await stale).toEqual({ kind: 'stale', acceptedRevision: 3 })
    const refused = h.session.autosave(at(0, 350), 2)
    h.saves[2].answer.resolve({ kind: 'refused', detail: 'no' })
    expect(await refused).toEqual({ kind: 'rejected', detail: 'no' })
  })

  it('holds the session while the saved version loads, so a reapplication cannot start and the kept work is never forgotten', async () => {
    const h = harness()
    // A conflict: the owner moved Matrices on revision 1 while another tab saved Vectors as revision 2.
    h.edit(at(0, 300))
    h.backend.revision = 2
    h.backend.cards = at(50, 100)
    h.holdReads(true)
    const loading = h.session.loadAccepted(true)
    await settle()
    expect(h.view().busy).toBe(true)
    // Reapplying, discarding or loading again while the read is pending does nothing.
    await h.session.reapplyLive()
    expect(await h.session.loadAccepted(false)).toEqual({ kind: 'ignored' })
    expect(h.reads).toHaveLength(1)
    expect(h.saves).toHaveLength(0)
    expect(h.view().live).toEqual({ kind: 'idle' })
    h.reads[0]()
    expect(await loading).toEqual({ kind: 'shown' })
    expect(h.shown).toEqual([2])
    expect(h.local()).toEqual(at(50, 100))
    // The work is kept aside, in storage and offered, although the editor now reports saved.
    expect(h.kept().map((k) => [k.baseRevision, k.mine])).toEqual([[1, at(0, 300)]])
    expect(h.view().entries.map((e) => e.changes)).toEqual([['Moved the card “Matrices”']])
    expect(h.view().busy).toBe(false)
  })

  it('refuses to load the saved version while a reapplication is pending, and keeps the work when that save is stale', async () => {
    const h = harness()
    h.edit(at(0, 300))
    h.backend.revision = 2
    const reapplying = h.session.reapplyLive()
    await settle()
    expect(await h.session.loadAccepted(true)).toEqual({ kind: 'ignored' })
    h.saves[0].answer.resolve({ kind: 'stale', revision: 3 })
    await reapplying
    expect(h.shown).toEqual([])
    expect(h.local()).toEqual(at(0, 300))
    expect(h.kept().map((k) => k.mine)).toEqual([at(0, 300)])
  })

  it('changes nothing when the load is answered after the editor closed', async () => {
    const h = harness()
    h.edit(at(0, 300))
    h.holdReads(true)
    const loading = h.session.loadAccepted(false)
    await settle()
    h.session.close()
    h.reads[0]()
    expect(await loading).toEqual({ kind: 'ignored' })
    expect(h.shown).toEqual([])
    expect(h.kept().map((k) => k.mine)).toEqual([at(0, 300)])
  })
})
