import { describe, expect, it } from 'bun:test'
import type { Point } from './protocol'
import { PointerMoveCoalescer } from './pointerMoveCoalescer'

/** A manual frame clock: `tick()` runs the callbacks scheduled for the next frame. */
function frames() {
  let next = 1
  const queued = new Map<number, () => void>()
  return {
    schedule: (callback: () => void) => { queued.set(next, callback); return next++ },
    cancel: (handle: number) => { queued.delete(handle) },
    tick: () => { const due = [...queued.values()]; queued.clear(); due.forEach(run => run()) },
    get scheduled() { return queued.size },
  }
}

describe('one drag move per frame', () => {
  it('dispatches only the latest of several moves in one frame', () => {
    const clock = frames(), moves: Point[] = []
    const pointer = new PointerMoveCoalescer(p => moves.push(p), clock.schedule, clock.cancel)
    pointer.add({ x: 1, y: 1 }); pointer.add({ x: 2, y: 3 }); pointer.add({ x: 5, y: 8 })
    expect(moves).toEqual([])
    expect(clock.scheduled).toBe(1)
    clock.tick()
    expect(moves).toEqual([{ x: 5, y: 8 }])
    clock.tick()
    expect(moves).toHaveLength(1)
  })

  it('flushes a pending move immediately, before a release, and cancels its frame', () => {
    const clock = frames(), moves: Point[] = []
    const pointer = new PointerMoveCoalescer(p => moves.push(p), clock.schedule, clock.cancel)
    pointer.add({ x: 4, y: 4 })
    pointer.flush()
    expect(moves).toEqual([{ x: 4, y: 4 }])
    expect(clock.scheduled).toBe(0)
    pointer.flush()
    clock.tick()
    expect(moves).toHaveLength(1)
  })

  it('schedules a new frame for moves after a flush, and dispose drops a pending move', () => {
    const clock = frames(), moves: Point[] = []
    const pointer = new PointerMoveCoalescer(p => moves.push(p), clock.schedule, clock.cancel)
    pointer.add({ x: 1, y: 0 }); clock.tick()
    pointer.add({ x: 2, y: 0 }); clock.tick()
    expect(moves).toEqual([{ x: 1, y: 0 }, { x: 2, y: 0 }])
    pointer.add({ x: 3, y: 0 }); pointer.dispose(); clock.tick()
    expect(moves).toHaveLength(2)
  })
})
