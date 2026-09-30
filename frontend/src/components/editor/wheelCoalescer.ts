import type { EditorCommand, Point } from './protocol'

/** The camera commands a wheel event can produce. */
export type WheelCommand = Extract<EditorCommand, { type: 'PanCamera' | 'ZoomAt' }>

/** The wheel event fields the camera mapping reads. */
export interface WheelInput {
  deltaX: number
  deltaY: number
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}

/**
 * Maps one wheel event to its camera command, or null for a no-op.
 *
 * Ctrl/Meta+wheel (and trackpad pinch) zooms about the pointer with the
 * `exp(-deltaY * 0.005)` rule; plain wheel pans, Shift turning vertical wheel
 * travel into horizontal pan.
 */
export function wheelCommand(event: WheelInput, point: Point): WheelCommand | null {
  if (event.ctrlKey || event.metaKey) {
    const factor = Math.exp(-event.deltaY * 0.005)
    return factor === 1 ? null : { type: 'ZoomAt', screen_x: point.x, screen_y: point.y, factor }
  }
  const deltaX = event.shiftKey ? -event.deltaY : -event.deltaX
  const deltaY = event.shiftKey ? 0 : -event.deltaY
  return deltaX === 0 && deltaY === 0 ? null : { type: 'PanCamera', delta_x: deltaX, delta_y: deltaY }
}

/**
 * Accumulates wheel commands so the editor dispatches at most one camera
 * command per animation frame instead of one per wheel event.
 *
 * Pans sum their deltas. Zooms about the same anchor multiply their factors;
 * the engine clamps zoom only once for the merged factor, which differs from
 * per-event clamping only while crossing a zoom limit. A command that cannot
 * merge with the pending one (pan versus zoom, or a moved zoom anchor) is
 * returned by {@link add} so the caller can dispatch the pending command first
 * and keep the original order.
 */
export class WheelCoalescer {
  private pending: WheelCommand | null = null

  /** Queues `command`; returns an earlier command that must be dispatched now. */
  add(command: WheelCommand): WheelCommand | null {
    const pending = this.pending
    if (pending?.type === 'PanCamera' && command.type === 'PanCamera') {
      this.pending = { ...pending, delta_x: pending.delta_x + command.delta_x, delta_y: pending.delta_y + command.delta_y }
      return null
    }
    if (pending?.type === 'ZoomAt' && command.type === 'ZoomAt' &&
        pending.screen_x === command.screen_x && pending.screen_y === command.screen_y) {
      this.pending = { ...pending, factor: pending.factor * command.factor }
      return null
    }
    this.pending = command
    return pending
  }

  /** Removes and returns the merged command for this frame, if any. */
  take(): WheelCommand | null {
    const pending = this.pending
    this.pending = null
    return pending
  }
}
