import { describe, expect, it } from 'bun:test'
import { WheelCoalescer, wheelCommand } from './wheelCoalescer'

const wheel = (deltaX: number, deltaY: number, keys: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {}) =>
  ({ deltaX, deltaY, shiftKey: false, ctrlKey: false, metaKey: false, ...keys })
const at = { x: 400, y: 300 }

describe('wheel to camera command', () => {
  it('pans opposite to wheel travel and turns Shift+wheel into horizontal pan', () => {
    expect(wheelCommand(wheel(3, -4), at)).toEqual({ type: 'PanCamera', delta_x: -3, delta_y: 4 })
    expect(wheelCommand(wheel(0, 5, { shiftKey: true }), at)).toEqual({ type: 'PanCamera', delta_x: -5, delta_y: 0 })
  })

  it('zooms about the pointer with the exponential rule for Ctrl or Meta', () => {
    const zoom = wheelCommand(wheel(0, -2, { ctrlKey: true }), at)
    expect(zoom).toEqual({ type: 'ZoomAt', screen_x: 400, screen_y: 300, factor: Math.exp(0.01) })
    expect(wheelCommand(wheel(0, -2, { metaKey: true }), at)?.type).toBe('ZoomAt')
  })

  it('reports a zero-travel wheel event as a no-op', () => {
    expect(wheelCommand(wheel(0, 0), at)).toBeNull()
    expect(wheelCommand(wheel(7, 0, { ctrlKey: true }), at)).toBeNull()
  })
})

describe('one camera command per frame', () => {
  it('sums pan deltas until the frame takes them', () => {
    const wheels = new WheelCoalescer()
    expect(wheels.add({ type: 'PanCamera', delta_x: 2, delta_y: 1 })).toBeNull()
    expect(wheels.add({ type: 'PanCamera', delta_x: -5, delta_y: 3 })).toBeNull()
    expect(wheels.take()).toEqual({ type: 'PanCamera', delta_x: -3, delta_y: 4 })
    expect(wheels.take()).toBeNull()
  })

  it('multiplies zoom factors about an unchanged anchor', () => {
    const wheels = new WheelCoalescer()
    wheels.add({ type: 'ZoomAt', screen_x: 10, screen_y: 20, factor: 1.01 })
    wheels.add({ type: 'ZoomAt', screen_x: 10, screen_y: 20, factor: 0.5 })
    expect(wheels.take()).toEqual({ type: 'ZoomAt', screen_x: 10, screen_y: 20, factor: 1.01 * 0.5 })
  })

  it('hands back the pending command when the next one cannot merge, preserving order', () => {
    const wheels = new WheelCoalescer()
    const first = { type: 'ZoomAt', screen_x: 10, screen_y: 20, factor: 1.01 } as const
    wheels.add(first)
    expect(wheels.add({ type: 'ZoomAt', screen_x: 11, screen_y: 20, factor: 1.02 })).toEqual(first)
    const pan = { type: 'PanCamera', delta_x: 1, delta_y: 0 } as const
    expect(wheels.add(pan)).toEqual({ type: 'ZoomAt', screen_x: 11, screen_y: 20, factor: 1.02 })
    expect(wheels.take()).toEqual(pan)
  })
})
