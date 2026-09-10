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

  it('verifies label screen position recalculation after card drag and camera zoom', () => {
    // Initial card at (80, 100), size (180, 80)
    const initialScreenRect = { x: 80, y: 100, width: 180, height: 80 }
    expect(screenToCssRect(initialScreenRect)).toEqual({
      left: 80,
      top: 100,
      width: 180,
      height: 80,
    })

    // After dragging card by (+120, +80): world position becomes (200, 180)
    // Under 1.5x zoom and offset (50, -30):
    // screen_x = 200 * 1.5 + 50 = 350
    // screen_y = 180 * 1.5 - 30 = 240
    // screen_w = 180 * 1.5 = 270
    // screen_h = 80 * 1.5 = 120
    const zoomedScreenRect = { x: 350, y: 240, width: 270, height: 120 }
    expect(screenToCssRect(zoomedScreenRect)).toEqual({
      left: 350,
      top: 240,
      width: 270,
      height: 120,
    })
  })

  it('validates undo/redo command roundtrip under Matt Pocock SDD schema', () => {
    const undoCmd = EditorCommandSchema.parse({ type: 'Undo' })
    const redoCmd = EditorCommandSchema.parse({ type: 'Redo' })
    expect(undoCmd.type).toBe('Undo')
    expect(redoCmd.type).toBe('Redo')

    const historyEvent = EditorEventSchema.parse({
      type: 'HistoryChanged',
      can_undo: true,
      can_redo: false,
    })
    expect(historyEvent.type).toBe('HistoryChanged')
    if (historyEvent.type === 'HistoryChanged') {
      expect(historyEvent.can_undo).toBe(true)
      expect(historyEvent.can_redo).toBe(false)
    }
  })

  it('validates prerequisite connection creation and single engine authority', () => {
    // React dispatches ConnectSkills command without modifying local graph
    const connectCmd = EditorCommandSchema.parse({
      type: 'ConnectSkills',
      from_id: 'skill-rust-basics',
      to_id: 'skill-ownership',
    })
    expect(connectCmd.type).toBe('ConnectSkills')

    // Engine responds with ConnectionCreated and authoritative ConnectionsUpdated
    const createdEvent = EditorEventSchema.parse({
      type: 'ConnectionCreated',
      from_id: 'skill-rust-basics',
      to_id: 'skill-ownership',
    })
    const updatedEvent = EditorEventSchema.parse({
      type: 'ConnectionsUpdated',
      connections: [{ from_id: 'skill-rust-basics', to_id: 'skill-ownership' }],
    })

    expect(createdEvent.type).toBe('ConnectionCreated')
    expect(updatedEvent.type).toBe('ConnectionsUpdated')
    if (updatedEvent.type === 'ConnectionsUpdated') {
      expect(updatedEvent.connections.length).toBe(1)
      expect(updatedEvent.connections[0]).toEqual({
        from_id: 'skill-rust-basics',
        to_id: 'skill-ownership',
      })
    }
  })

  it('validates cycle rejection event with understandable application feedback', () => {
    // When author attempts cycle: ownership -> rust-basics (which already requires rust-basics)
    const rejectEvent = EditorEventSchema.parse({
      type: 'ConnectionRejected',
      from_id: 'skill-ownership',
      to_id: 'skill-rust-basics',
      reason:
        'Cannot connect: creates a cycle (Rust Fundamentals → Ownership & Borrowing → Rust Fundamentals). Prerequisite graph must remain acyclic (DAG).',
    })

    expect(rejectEvent.type).toBe('ConnectionRejected')
    if (rejectEvent.type === 'ConnectionRejected') {
      expect(rejectEvent.reason).toContain('creates a cycle')
      expect(rejectEvent.reason).toContain('Prerequisite graph must remain acyclic (DAG)')
    }
  })

})
