import { describe, it, expect } from 'bun:test'
import { INITIAL_LEARNING_PATH_FIXTURE } from '../../fixtures/learningPath'
import {
  cssToLogicalPoint,
  screenToCssRect,
  toCanvasBufferSize,
} from './coords'
import {
  EditorCommandSchema,
  EditorEventSchema,
} from './protocol'

describe('Editor Seams & Coordinate Transformations (ADR-0015, Matt Pocock SDD)', () => {
  it('converts client pointer coordinates to logical engine coordinates without DPR distortion', () => {
    const mockRect = {
      left: 100,
      top: 50,
      width: 800,
      height: 600,
      right: 900,
      bottom: 650,
      x: 100,
      y: 50,
      toJSON: () => {},
    } as DOMRect

    const pt = cssToLogicalPoint(250, 180, mockRect)
    expect(pt).toEqual({ x: 150, y: 130 })
  })

  it('maps engine screen rect directly to CSS overlay rect', () => {
    const engineRect = { x: 80, y: 100, width: 180, height: 80 }
    const cssRect = screenToCssRect(engineRect)
    expect(cssRect).toEqual({
      left: 80,
      top: 100,
      width: 180,
      height: 80,
    })
  })

  it('computes physical canvas buffer dimensions with DPR scaling', () => {
    const buffer1x = toCanvasBufferSize(800, 600, 1.0)
    expect(buffer1x).toEqual({ width: 800, height: 600 })

    const buffer2x = toCanvasBufferSize(800, 600, 2.0)
    expect(buffer2x).toEqual({ width: 1600, height: 1200 })

    const buffer15x = toCanvasBufferSize(800, 600, 1.5)
    expect(buffer15x).toEqual({ width: 1200, height: 900 })
  })

  it('maps all initial learning path fixture skills to valid engine LoadDocument payload', () => {
    const initialCards = INITIAL_LEARNING_PATH_FIXTURE.skills.map((s) => ({
      id: s.id,
      title: s.title,
      position: { x: s.initialPosition.x, y: s.initialPosition.y },
    }))

    const cmd = EditorCommandSchema.parse({
      type: 'LoadDocument',
      document: { cards: initialCards },
    })

    expect(cmd.type).toBe('LoadDocument')
    if (cmd.type === 'LoadDocument') {
      expect(cmd.document.cards.length).toBe(INITIAL_LEARNING_PATH_FIXTURE.skills.length)
      expect(cmd.document.cards[0].id).toBe('skill-rust-basics')
      expect(cmd.document.cards[0].position).toEqual({ x: 80, y: 100 })
    }
  })

  it('ensures selection events strictly adhere to engine schema without React authority', () => {
    const selEvent = EditorEventSchema.parse({
      type: 'SelectionChanged',
      selected_id: 'skill-wgpu-pipeline',
      title: 'WebGPU Pipeline',
    })

    expect(selEvent.type).toBe('SelectionChanged')
    if (selEvent.type === 'SelectionChanged') {
      expect(selEvent.selected_id).toBe('skill-wgpu-pipeline')
      expect(selEvent.title).toBe('WebGPU Pipeline')
    }
  })
})
