import { describe, expect, it } from 'bun:test'
import { Autosave, type SaveOutcome, type SaveState } from './autosave'

/** A manual clock and a backend whose answers the test releases one by one. */
function harness(startRevision = 3) {
  const timers: { run: () => void; cancelled: boolean }[] = []
  const sent: { doc: number; expectedRevision: number; answer: (outcome: SaveOutcome | Error) => void }[] = []
  const states: SaveState[] = []
  let local = 0
  let ready = true
  const autosave = new Autosave<number>({
    revision: startRevision,
    delayMs: 400,
    build: () => (ready ? local : null),
    send: (doc, expectedRevision) => new Promise((resolve, reject) => {
      sent.push({ doc, expectedRevision, answer: (outcome) => (outcome instanceof Error ? reject(outcome) : resolve(outcome)) })
    }),
    onState: (state) => states.push(state),
    setTimer: (run) => { const timer = { run, cancelled: false }; timers.push(timer); return timer },
    clearTimer: (timer) => { (timer as { cancelled: boolean }).cancelled = true },
  })
  return {
    autosave, sent, states,
    edit(value: number) { local = value; autosave.edit() },
    setReady(value: boolean) { ready = value },
    /** Fires every pending debounce timer. */
    elapse() { for (const timer of timers.splice(0)) if (!timer.cancelled) timer.run() },
    settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
    last: () => states[states.length - 1],
  }
}

describe('Path autosave', () => {
  it('combines nearby edits into one save based on the accepted revision', async () => {
    const h = harness(3)
    h.edit(1); h.edit(2); h.edit(3)
    expect(h.last()).toEqual({ kind: 'dirty', revision: 3 })
    expect(h.sent).toHaveLength(0)
    h.elapse()
    expect(h.sent.map((s) => [s.doc, s.expectedRevision])).toEqual([[3, 3]])
    expect(h.last()).toEqual({ kind: 'saving', revision: 3 })
    h.sent[0].answer({ kind: 'accepted', revision: 4 })
    await h.settle()
    expect(h.last()).toEqual({ kind: 'saved', revision: 4 })
    // The next save is based on the revision the backend accepted.
    h.edit(4); h.elapse()
    expect(h.sent[1].expectedRevision).toBe(4)
  })

  it('sends edits made during a save next, without claiming them saved early', async () => {
    const h = harness(1)
    h.edit(1); h.elapse()
    h.edit(2)
    h.elapse()
    expect(h.sent).toHaveLength(1)
    h.sent[0].answer({ kind: 'accepted', revision: 2 })
    await h.settle()
    expect(h.last()).toEqual({ kind: 'dirty', revision: 2 })
    expect(h.states.some((s) => s.kind === 'saved')).toBe(false)
    h.elapse()
    expect(h.sent.map((s) => [s.doc, s.expectedRevision])).toEqual([[1, 1], [2, 2]])
    h.sent[1].answer({ kind: 'accepted', revision: 3 })
    await h.settle()
    expect(h.last()).toEqual({ kind: 'saved', revision: 3 })
  })

  it('stops after a stale save and keeps later edits local', async () => {
    const h = harness(5)
    h.edit(1); h.elapse()
    h.sent[0].answer({ kind: 'stale', acceptedRevision: 6 })
    await h.settle()
    expect(h.last()).toEqual({ kind: 'conflict', revision: 5, acceptedRevision: 6 })
    h.edit(2); h.elapse(); h.autosave.retry()
    expect(h.sent).toHaveLength(1)
    expect(h.last().kind).toBe('conflict')
    // Discarding the local work starts again from the accepted document.
    h.autosave.reset(6)
    expect(h.last()).toEqual({ kind: 'saved', revision: 6 })
    h.edit(3); h.elapse()
    expect(h.sent[1].expectedRevision).toBe(6)
  })

  it('reports failed and rejected saves without ever claiming them saved, and retries', async () => {
    const h = harness(2)
    h.edit(1); h.elapse()
    h.sent[0].answer(new Error('Failed to fetch'))
    await h.settle()
    expect(h.last()).toEqual({ kind: 'failed', revision: 2, detail: 'Failed to fetch' })
    h.autosave.retry()
    expect(h.sent.map((s) => s.expectedRevision)).toEqual([2, 2])
    h.sent[1].answer({ kind: 'rejected', detail: 'the Prerequisites form a cycle' })
    await h.settle()
    expect(h.last()).toEqual({ kind: 'rejected', revision: 2, detail: 'the Prerequisites form a cycle' })
    expect(h.states.some((s) => s.kind === 'saved')).toBe(false)
    h.edit(2); h.elapse()
    h.sent[2].answer({ kind: 'accepted', revision: 3 })
    await h.settle()
    expect(h.last()).toEqual({ kind: 'saved', revision: 3 })
  })

  it('waits until the local document can be read, and ignores a save made stale by a reset', async () => {
    const h = harness(1)
    h.setReady(false)
    h.edit(1); h.elapse()
    expect(h.sent).toHaveLength(0)
    h.setReady(true); h.elapse()
    expect(h.sent).toHaveLength(1)
    h.autosave.reset(7)
    h.sent[0].answer({ kind: 'accepted', revision: 2 })
    await h.settle()
    expect(h.last()).toEqual({ kind: 'saved', revision: 7 })
    h.edit(2); h.elapse()
    expect(h.sent[1].expectedRevision).toBe(7)
  })

  it('sends a pending edit when the editor closes, and nothing when there is none', async () => {
    const h = harness(4)
    h.autosave.close()
    expect(h.sent).toHaveLength(0)
    const g = harness(4)
    g.edit(9)
    g.autosave.close()
    expect(g.sent.map((s) => [s.doc, s.expectedRevision])).toEqual([[9, 4]])
    g.edit(10); g.elapse()
    expect(g.sent).toHaveLength(1)
  })

  it('leaving during a save sends the later edits after it, on the revision that save is accepted at', async () => {
    const h = harness(4)
    h.edit(1); h.elapse()
    h.edit(2); h.edit(3)
    const told = h.states.length
    h.autosave.close()
    h.setReady(false) // the editor is gone: the document can no longer be read
    expect(h.sent).toHaveLength(1)
    h.sent[0].answer({ kind: 'accepted', revision: 5 })
    await h.settle()
    expect(h.sent.map((s) => [s.doc, s.expectedRevision])).toEqual([[1, 4], [3, 5]])
    h.sent[1].answer({ kind: 'accepted', revision: 6 })
    await h.settle()
    expect(h.sent).toHaveLength(2)
    // The closed editor is no longer told anything.
    expect(h.states).toHaveLength(told)
  })

  it('leaving during a save that turns out stale sends nothing more', async () => {
    const h = harness(4)
    h.edit(1); h.elapse()
    h.edit(2)
    h.autosave.close()
    h.sent[0].answer({ kind: 'stale', acceptedRevision: 5 })
    await h.settle()
    expect(h.sent).toHaveLength(1)
  })

  it('leaving after a failed save sends the unsaved document again, and nothing once it is accepted', async () => {
    const h = harness(4)
    h.edit(1); h.elapse()
    h.sent[0].answer({ kind: 'failed', detail: 'offline' })
    await h.settle()
    h.autosave.close()
    expect(h.sent.map((s) => [s.doc, s.expectedRevision])).toEqual([[1, 4], [1, 4]])
    const g = harness(4)
    g.edit(1); g.elapse()
    g.sent[0].answer({ kind: 'accepted', revision: 5 })
    await g.settle()
    g.autosave.close()
    expect(g.sent).toHaveLength(1)
  })
})
