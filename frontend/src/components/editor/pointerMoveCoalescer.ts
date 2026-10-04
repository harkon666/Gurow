import type { Point } from './protocol'

/** Requests a callback before the next frame and returns its handle (`requestAnimationFrame`). */
export type FrameScheduler = (callback: () => void) => number

/**
 * Merges drag pointer moves so the editor dispatches at most one `PointerMove`
 * per animation frame instead of one full command and render per event.
 *
 * Only the latest position matters for a drag. {@link flush} dispatches the
 * pending move immediately; callers flush before a press or release so the
 * release lands where the last move left the card and one completed drag
 * remains one undo step.
 */
export class PointerMoveCoalescer {
  private pending: Point | null = null
  private frame = 0

  constructor(
    private readonly dispatchMove: (point: Point) => void,
    private readonly schedule: FrameScheduler = (callback) => requestAnimationFrame(callback),
    private readonly cancel: (handle: number) => void = (handle) => cancelAnimationFrame(handle),
  ) {}

  /** Replaces any pending move with `point` and schedules one dispatch for the next frame. */
  add(point: Point): void {
    this.pending = point
    this.frame ||= this.schedule(() => this.flush())
  }

  /** Dispatches the pending move now, if any, and cancels its scheduled frame. */
  flush(): void {
    if (this.frame) this.cancel(this.frame)
    this.frame = 0
    const point = this.pending
    this.pending = null
    if (point) this.dispatchMove(point)
  }

  /** Drops the pending move without dispatching it. */
  dispose(): void {
    if (this.frame) this.cancel(this.frame)
    this.frame = 0
    this.pending = null
  }
}
