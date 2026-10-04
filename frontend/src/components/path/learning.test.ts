import { describe, expect, it } from 'bun:test'
import { LearningRecords, type LearningOutcome, type LearningView } from './learning'

type Records = { xp: number }
type Action = { kind: string }

/** A backend whose answers the test releases one by one. */
function harness() {
  const calls: { what: 'read' | Action; answer: (outcome: LearningOutcome<Records> | Error) => void }[] = []
  const views: LearningView<Records, Action>[] = []
  const pending = (what: 'read' | Action) => new Promise<LearningOutcome<Records>>((resolve, reject) => {
    calls.push({ what, answer: (outcome) => (outcome instanceof Error ? reject(outcome) : resolve(outcome)) })
  })
  const records = new LearningRecords<Records, Action>({ read: () => pending('read'), send: (action) => pending(action), onView: (view) => views.push(view) })
  return { records, calls, views, last: () => views[views.length - 1], settle: () => new Promise((resolve) => setTimeout(resolve, 0)) }
}
const ok = (xp: number): LearningOutcome<Records> => ({ kind: 'ok', state: { xp } })

describe('personal learning records', () => {
  it('shows only backend-confirmed records: nothing changes while an action is pending or after it fails', async () => {
    const h = harness()
    void h.records.refresh()
    h.calls[0].answer(ok(0))
    await h.settle()
    expect(h.last()).toMatchObject({ records: { xp: 0 }, pending: null, failed: null })
    const done = h.records.perform({ kind: 'complete' })
    expect(h.last()).toMatchObject({ records: { xp: 0 }, pending: { kind: 'complete' } })
    h.calls[1].answer(new Error('Failed to fetch'))
    expect(await done).toBe(false)
    expect(h.last()).toEqual({ records: { xp: 0 }, pending: null, failed: { action: { kind: 'complete' }, detail: 'Failed to fetch' }, loadError: null })
    expect(h.views.some((view) => view.records?.xp !== 0)).toBe(false)
  })

  it('retries the same failed action and then shows the confirmed result', async () => {
    const h = harness()
    void h.records.refresh(); h.calls[0].answer(ok(0)); await h.settle()
    void h.records.perform({ kind: 'reward 50' })
    h.calls[1].answer({ kind: 'failed', detail: 'HTTP 503' })
    await h.settle()
    const retried = h.records.retry()
    expect(h.calls[2].what).toEqual({ kind: 'reward 50' })
    expect(h.last().failed).toBeNull()
    h.calls[2].answer(ok(50))
    expect(await retried).toBe(true)
    expect(h.last()).toMatchObject({ records: { xp: 50 }, pending: null, failed: null })
  })

  it('sends one action at a time', async () => {
    const h = harness()
    void h.records.perform({ kind: 'first' })
    expect(await h.records.perform({ kind: 'second' })).toBe(false)
    expect(h.calls.map((c) => c.what)).toEqual([{ kind: 'first' }])
  })

  it('drops a read answered after a later action, so older records never replace newer ones', async () => {
    const h = harness()
    void h.records.refresh()
    const done = h.records.perform({ kind: 'complete' })
    h.calls[1].answer(ok(20))
    await done
    h.calls[0].answer(ok(0))
    await h.settle()
    expect(h.last().records).toEqual({ xp: 20 })
  })

  it('keeps a confirmed action when a read requested during it answers first', async () => {
    const h = harness()
    const done = h.records.perform({ kind: 'complete' })
    void h.records.refresh()
    // A read sent while the action is in flight may predate its commit, so it waits.
    expect(h.calls.map((c) => c.what)).toEqual([{ kind: 'complete' }])
    h.calls[0].answer(ok(20))
    expect(await done).toBe(true)
    expect(h.last().records).toEqual({ xp: 20 })
    // The deferred read goes out only after the action was confirmed.
    expect(h.calls.map((c) => c.what)).toEqual([{ kind: 'complete' }, 'read'])
    h.calls[1].answer(ok(20))
    await h.settle()
    expect(h.last().records).toEqual({ xp: 20 })
  })

  it('never lets a read that overlapped an action replace its confirmed result', async () => {
    const h = harness()
    const done = h.records.perform({ kind: 'complete' })
    void h.records.refresh()
    // A read already sent now is served before the action commits and so sees XP 0.
    const readBeforeCommit = h.calls.length > 1
    h.calls[0].answer(ok(20))
    await done
    for (const [index, call] of h.calls.slice(1).entries()) call.answer(ok(index === 0 && readBeforeCommit ? 0 : 20))
    await h.settle()
    // Whatever was read, nothing older than the confirmed action was shown after it.
    const afterConfirm = h.views.slice(h.views.findIndex((view) => view.records?.xp === 20))
    expect(afterConfirm.every((view) => view.records?.xp === 20)).toBe(true)
  })

  it('reports a failed read without inventing records, and stops publishing once closed', async () => {
    const h = harness()
    void h.records.refresh()
    h.calls[0].answer({ kind: 'failed', detail: 'HTTP 500' })
    await h.settle()
    expect(h.last()).toMatchObject({ records: null, loadError: 'HTTP 500' })
    void h.records.refresh()
    h.records.close()
    h.calls[1].answer(ok(5))
    await h.settle()
    expect(h.last().records).toBeNull()
  })
})
