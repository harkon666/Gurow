import { describe, it, expect } from 'bun:test'
import {
  EditorCommandSchema,
  EditorEventSchema,
  EditorEventsSchema,
} from './protocol'


describe('Editor Protocol Schemas (Matt Pocock SDD)', () => {
  describe('EditorCommandSchema validation & serialization', () => {
    it('validates LoadDocument command with optional size', () => {
      const raw = {
        type: 'LoadDocument',
        document: {
          cards: [
            {
              id: 'skill-1',
              title: 'Skill One',
              position: { x: 10, y: 20 },
            },
            {
              id: 'skill-2',
              title: 'Skill Two',
              position: { x: 30, y: 40 },
              size: { width: 180, height: 80 },
            },
          ],
        },
      }
      const parsed = EditorCommandSchema.parse(raw)
      expect(parsed.type).toBe('LoadDocument')
      if (parsed.type === 'LoadDocument') {
        expect(parsed.document.cards.length).toBe(2)
        expect(parsed.document.cards[0].size).toBeUndefined()
        expect(parsed.document.cards[1].size).toEqual({ width: 180, height: 80 })
      }
    })

    it('validates CreateCard command with and without size', () => {
      const withoutSize = {
        type: 'CreateCard' as const,
        id: 'skill-custom-1',
        title: 'Custom Skill',
        position: { x: 100, y: 150 },
      }
      const parsedWithout = EditorCommandSchema.parse(withoutSize)
      expect(parsedWithout).toEqual(withoutSize)

      const withSize = {
        type: 'CreateCard' as const,
        id: 'skill-custom-2',
        title: 'Custom Skill 2',
        position: { x: 200, y: 250 },
        size: { width: 200, height: 90 },
      }
      const parsedWith = EditorCommandSchema.parse(withSize)
      expect(parsedWith).toEqual(withSize)
    })


    it('validates SelectCard command with string id and null', () => {
      const selectOne = EditorCommandSchema.parse({
        type: 'SelectCard',
        id: 'skill-1',
      })
      expect(selectOne).toEqual({ type: 'SelectCard', id: 'skill-1' })

      const deselect = EditorCommandSchema.parse({
        type: 'SelectCard',
        id: null,
      })
      expect(deselect).toEqual({ type: 'SelectCard', id: null })
    })

    it('validates PointerDown command', () => {
      const pointerDown = EditorCommandSchema.parse({
        type: 'PointerDown',
        screen_x: 120.5,
        screen_y: 340.2,
      })
      expect(pointerDown).toEqual({
        type: 'PointerDown',
        screen_x: 120.5,
        screen_y: 340.2,
      })
    })

    it('validates PointerMove command', () => {
      const move = EditorCommandSchema.parse({
        type: 'PointerMove',
        screen_x: 200,
        screen_y: 350,
      })
      expect(move).toEqual({
        type: 'PointerMove',
        screen_x: 200,
        screen_y: 350,
      })
    })

    it('validates PointerUp command', () => {
      const up = EditorCommandSchema.parse({
        type: 'PointerUp',
        screen_x: 200,
        screen_y: 350,
      })
      expect(up).toEqual({
        type: 'PointerUp',
        screen_x: 200,
        screen_y: 350,
      })
    })

    it('validates PanCamera command', () => {
      const pan = EditorCommandSchema.parse({
        type: 'PanCamera',
        delta_x: -25.5,
        delta_y: 40.0,
      })
      expect(pan).toEqual({
        type: 'PanCamera',
        delta_x: -25.5,
        delta_y: 40.0,
      })
    })

    it('validates ZoomAt command', () => {
      const zoomAt = EditorCommandSchema.parse({
        type: 'ZoomAt',
        screen_x: 400,
        screen_y: 300,
        factor: 1.25,
      })
      expect(zoomAt).toEqual({
        type: 'ZoomAt',
        screen_x: 400,
        screen_y: 300,
        factor: 1.25,
      })
    })

    it('validates Undo and Redo commands', () => {
      const undo = EditorCommandSchema.parse({ type: 'Undo' })
      expect(undo).toEqual({ type: 'Undo' })

      const redo = EditorCommandSchema.parse({ type: 'Redo' })
      expect(redo).toEqual({ type: 'Redo' })
    })

    it('validates ResizeViewport command', () => {
      const resize = EditorCommandSchema.parse({
        type: 'ResizeViewport',
        width: 1920,
        height: 1080,
      })
      expect(resize).toEqual({
        type: 'ResizeViewport',
        width: 1920,
        height: 1080,
      })
    })

    it('rejects invalid or unknown commands', () => {
      expect(() =>
        EditorCommandSchema.parse({ type: 'UnknownCommand' })
      ).toThrow()
      expect(() =>
        EditorCommandSchema.parse({ type: 'PointerDown', screen_x: 'invalid' })
      ).toThrow()
    })
  })

  describe('EditorEventSchema and EditorEventsSchema boundary validation', () => {
    it('validates DocumentLoaded event', () => {
      const parsed = EditorEventSchema.parse({ type: 'DocumentLoaded' })
      expect(parsed).toEqual({ type: 'DocumentLoaded' })
    })

    it('validates CardCreated event', () => {
      const event = {
        type: 'CardCreated' as const,
        card: {
          id: 'skill-custom-1',
          title: 'Custom Skill',
          position: { x: 50, y: 60 },
          size: { width: 180, height: 80 },
        },
      }
      const parsed = EditorEventSchema.parse(event)
      expect(parsed).toEqual(event)
    })

    it('validates SelectionChanged event with id/title and with nulls', () => {
      const selChanged = EditorEventSchema.parse({
        type: 'SelectionChanged',
        selected_id: 'skill-1',
        title: 'Skill One',
      })
      expect(selChanged).toEqual({
        type: 'SelectionChanged',
        selected_id: 'skill-1',
        title: 'Skill One',
      })

      const deselected = EditorEventSchema.parse({
        type: 'SelectionChanged',
        selected_id: null,
        title: null,
      })
      expect(deselected).toEqual({
        type: 'SelectionChanged',
        selected_id: null,
        title: null,
      })
    })

    it('validates LabelsUpdated event', () => {
      const event = {
        type: 'LabelsUpdated' as const,
        labels: [
          {
            card_id: 'skill-1',
            title: 'Skill One',
            screen_rect: { x: 10, y: 20, width: 180, height: 80 },
            selected: true,
          },
        ],
      }
      const parsed = EditorEventSchema.parse(event)
      expect(parsed).toEqual(event)
    })


    it('validates GpuError event', () => {
      const gpuErrEvent = EditorEventSchema.parse({
        type: 'GpuError',
        message: 'Renderer error: Surface texture lost',
      })
      expect(gpuErrEvent).toEqual({
        type: 'GpuError',
        message: 'Renderer error: Surface texture lost',
      })
    })

    it('validates Error event', () => {
      const errEvent = EditorEventSchema.parse({
        type: 'Error',
        message: 'Card with id already exists',
      })
      expect(errEvent).toEqual({
        type: 'Error',
        message: 'Card with id already exists',
      })
    })

    it('validates CardMoved event', () => {
      const moved = EditorEventSchema.parse({
        type: 'CardMoved',
        card_id: 'skill-1',
        position: { x: 220, y: 310 },
      })
      expect(moved).toEqual({
        type: 'CardMoved',
        card_id: 'skill-1',
        position: { x: 220, y: 310 },
      })
    })

    it('validates CameraChanged event', () => {
      const camChanged = EditorEventSchema.parse({
        type: 'CameraChanged',
        offset_x: 150.5,
        offset_y: -40.2,
        zoom: 1.5,
      })
      expect(camChanged).toEqual({
        type: 'CameraChanged',
        offset_x: 150.5,
        offset_y: -40.2,
        zoom: 1.5,
      })
    })

    it('validates HistoryChanged event', () => {
      const hist = EditorEventSchema.parse({
        type: 'HistoryChanged',
        can_undo: true,
        can_redo: false,
      })
      expect(hist).toEqual({
        type: 'HistoryChanged',
        can_undo: true,
        can_redo: false,
      })
    })


    it('validates array of serialized events (wire format from Rust serde)', () => {
      const wireJson = JSON.stringify([
        {
          type: 'CardCreated',
          card: {
            id: 'skill-new',
            title: 'New Skill',
            position: { x: 0, y: 0 },
            size: { width: 180, height: 80 },
          },
        },
        {
          type: 'LabelsUpdated',
          labels: [
            {
              card_id: 'skill-new',
              title: 'New Skill',
              screen_rect: { x: 0, y: 0, width: 180, height: 80 },
              selected: false,
            },
          ],
        },
      ])

      const parsedEvents = EditorEventsSchema.parse(JSON.parse(wireJson))
      expect(parsedEvents.length).toBe(2)
      expect(parsedEvents[0].type).toBe('CardCreated')
      expect(parsedEvents[1].type).toBe('LabelsUpdated')
    })

    it('rejects malformed event array', () => {
      expect(() =>
        EditorEventsSchema.parse([{ type: 'BogusEvent' }])
      ).toThrow()
    })

    it('validates ConnectSkills and DisconnectSkills commands', () => {
      const connect = EditorCommandSchema.parse({
        type: 'ConnectSkills',
        from_id: 'skill-1',
        to_id: 'skill-2',
      })
      expect(connect).toEqual({
        type: 'ConnectSkills',
        from_id: 'skill-1',
        to_id: 'skill-2',
      })

      const disconnect = EditorCommandSchema.parse({
        type: 'DisconnectSkills',
        from_id: 'skill-1',
        to_id: 'skill-2',
      })
      expect(disconnect).toEqual({
        type: 'DisconnectSkills',
        from_id: 'skill-1',
        to_id: 'skill-2',
      })
    })

    it('validates ConnectionCreated, ConnectionDeleted, ConnectionRejected, and ConnectionsUpdated events', () => {
      const created = EditorEventSchema.parse({
        type: 'ConnectionCreated',
        from_id: 'skill-a',
        to_id: 'skill-b',
      })
      expect(created).toEqual({
        type: 'ConnectionCreated',
        from_id: 'skill-a',
        to_id: 'skill-b',
      })

      const deleted = EditorEventSchema.parse({
        type: 'ConnectionDeleted',
        from_id: 'skill-a',
        to_id: 'skill-b',
      })
      expect(deleted).toEqual({
        type: 'ConnectionDeleted',
        from_id: 'skill-a',
        to_id: 'skill-b',
      })

      const rejected = EditorEventSchema.parse({
        type: 'ConnectionRejected',
        from_id: 'skill-b',
        to_id: 'skill-a',
        reason: 'Cannot connect: creates a cycle (Skill B → Skill A → Skill B). Prerequisite graph must remain acyclic (DAG).',
      })
      expect(rejected.type).toBe('ConnectionRejected')
      if (rejected.type === 'ConnectionRejected') {
        expect(rejected.reason).toContain('creates a cycle')
      }

      const updated = EditorEventSchema.parse({
        type: 'ConnectionsUpdated',
        connections: [{ from_id: 'skill-a', to_id: 'skill-b' }],
      })
      expect(updated.type).toBe('ConnectionsUpdated')
      if (updated.type === 'ConnectionsUpdated') {
        expect(updated.connections.length).toBe(1)
        expect(updated.connections[0]).toEqual({ from_id: 'skill-a', to_id: 'skill-b' })
      }
    })

    it('validates LoadDocument with connections', () => {
      const loadWithConn = EditorCommandSchema.parse({
        type: 'LoadDocument',
        document: {
          cards: [{ id: 'c1', title: 'Card 1', position: { x: 0, y: 0 } }],
          connections: [{ from_id: 'c1', to_id: 'c2' }],
        },
      })
      expect(loadWithConn.type).toBe('LoadDocument')
      if (loadWithConn.type === 'LoadDocument') {
        expect(loadWithConn.document.connections?.length).toBe(1)
      }
    })
  })
})
