import { describe, it, expect } from 'bun:test'
import {
  EditorCommandSchema,
  EditorEventSchema,
  EditorEventsSchema,
  type EditorCommand,
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

    it('validates the selection arrangement commands', () => {
      for (const command of [
        { type: 'SelectAll' },
        { type: 'NudgeSelection', delta_x: -10, delta_y: 50 },
        { type: 'ArrangeSelection', arrangement: 'DistributeVertically' },
      ] satisfies EditorCommand[]) {
        expect(EditorCommandSchema.parse(command)).toEqual(command)
      }
      expect(() => EditorCommandSchema.parse({ type: 'ArrangeSelection', arrangement: 'Shuffle' })).toThrow()
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
      // Shift on the empty canvas draws a selection box instead of panning.
      const boxStart = EditorCommandSchema.parse({ type: 'PointerDown', screen_x: 1, screen_y: 2, shift_key: true })
      expect(boxStart).toEqual({ type: 'PointerDown', screen_x: 1, screen_y: 2, shift_key: true })
      expect(() => EditorCommandSchema.parse({ type: 'PointerDown', screen_x: 1, screen_y: 2, shift_key: 'yes' })).toThrow()
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

    it('validates DeleteCard and the deletion and restoration events', () => {
      expect(EditorCommandSchema.parse({ type: 'DeleteCard', id: 'skill-1' })).toEqual({ type: 'DeleteCard', id: 'skill-1' })
      expect(() => EditorCommandSchema.parse({ type: 'DeleteCard' })).toThrow()
      expect(EditorEventSchema.parse({ type: 'CardDeleted', card_id: 'skill-1' })).toEqual({ type: 'CardDeleted', card_id: 'skill-1' })
      expect(EditorEventSchema.parse({ type: 'CardRestored', card_id: 'skill-1' })).toEqual({ type: 'CardRestored', card_id: 'skill-1' })
      expect(() => EditorEventSchema.parse({ type: 'CardRestored', id: 'skill-1' })).toThrow()
    })

    it('validates SelectionChanged event with id/title, with nulls and for a multiselection', () => {
      const selChanged = EditorEventSchema.parse({
        type: 'SelectionChanged',
        selected_id: 'skill-1',
        title: 'Skill One',
        selected_ids: ['skill-1'],
      })
      expect(selChanged).toEqual({
        type: 'SelectionChanged',
        selected_id: 'skill-1',
        title: 'Skill One',
        selected_ids: ['skill-1'],
      })

      const deselected = EditorEventSchema.parse({
        type: 'SelectionChanged',
        selected_id: null,
        title: null,
        selected_ids: [],
      })
      expect(deselected).toEqual({
        type: 'SelectionChanged',
        selected_id: null,
        title: null,
        selected_ids: [],
      })

      // Several selected Skills open none of them; the list says which are selected.
      const several = EditorEventSchema.parse({
        type: 'SelectionChanged',
        selected_id: null,
        title: null,
        selected_ids: ['skill-1', 'skill-2'],
      })
      expect(several.type === 'SelectionChanged' && several.selected_ids).toEqual(['skill-1', 'skill-2'])
      expect(() => EditorEventSchema.parse({ type: 'SelectionChanged', selected_id: null, title: null })).toThrow()
    })

    it('validates LabelsUpdated event', () => {
      const event = {
        type: 'LabelsUpdated' as const,
        labels: [
          {
            card_id: 'skill-1',
            title: 'Skill One',
            world_rect: { x: 10, y: 20, width: 180, height: 80 },
            selected: true,
          },
        ],
      }
      const parsed = EditorEventSchema.parse(event)
      expect(parsed).toEqual(event)
      // A camera-dependent screen rectangle is no longer part of the label protocol.
      const { world_rect, ...rest } = event.labels[0]
      expect(() => EditorEventSchema.parse({ ...event, labels: [{ ...rest, screen_rect: world_rect }] })).toThrow()
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
              world_rect: { x: 0, y: 0, width: 180, height: 80 },
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

    it('validates connection gesture commands and events (UX02)', () => {
      expect(EditorCommandSchema.parse({ type: 'CancelInteraction' })).toEqual({ type: 'CancelInteraction' })
      expect(EditorCommandSchema.parse({ type: 'SelectConnection', connection: { from_id: 'a', to_id: 'b' } }))
        .toEqual({ type: 'SelectConnection', connection: { from_id: 'a', to_id: 'b' } })
      expect(EditorCommandSchema.parse({ type: 'SelectConnection', connection: null })).toEqual({ type: 'SelectConnection', connection: null })
      expect(() => EditorCommandSchema.parse({ type: 'SelectConnection' })).toThrow()

      const events = EditorEventsSchema.parse([
        { type: 'ConnectionDragStarted', from_id: 'a', valid_target_ids: ['b', 'c'] },
        { type: 'ConnectionDragTargetChanged', target_id: null },
        { type: 'ConnectionDragEnded', from_id: 'a', dropped_on: 'c' },
        { type: 'ConnectionDragEnded', from_id: 'a', dropped_on: null },
        { type: 'ConnectionSelected', connection: { from_id: 'a', to_id: 'c' } },
        { type: 'ConnectionSelected', connection: null },
      ])
      expect(events.map((event) => event.type)).toEqual([
        'ConnectionDragStarted', 'ConnectionDragTargetChanged', 'ConnectionDragEnded', 'ConnectionDragEnded', 'ConnectionSelected', 'ConnectionSelected',
      ])
      expect(() => EditorEventSchema.parse({ type: 'ConnectionDragEnded', from_id: 'a' })).toThrow()
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

    it('validates ExportSnapshot and SetCamera commands', () => {
      const exportCmd = EditorCommandSchema.parse({
        type: 'ExportSnapshot',
      })
      expect(exportCmd).toEqual({ type: 'ExportSnapshot' })

      const setCam = EditorCommandSchema.parse({
        type: 'SetCamera',
        offset_x: 120,
        offset_y: -45,
        zoom: 1.25,
      })
      expect(setCam).toEqual({
        type: 'SetCamera',
        offset_x: 120,
        offset_y: -45,
        zoom: 1.25,
      })
    })

    it('validates the SetReadOnly command and rejects a non-boolean flag', () => {
      expect(EditorCommandSchema.parse({ type: 'SetReadOnly', read_only: true })).toEqual({ type: 'SetReadOnly', read_only: true })
      expect(() => EditorCommandSchema.parse({ type: 'SetReadOnly', read_only: 'yes' })).toThrow()
      expect(() => EditorCommandSchema.parse({ type: 'SetReadOnly' })).toThrow()
    })

    it('validates the SetLayoutOnly command and rejects a non-boolean flag', () => {
      expect(EditorCommandSchema.parse({ type: 'SetLayoutOnly', layout_only: true })).toEqual({ type: 'SetLayoutOnly', layout_only: true })
      expect(() => EditorCommandSchema.parse({ type: 'SetLayoutOnly', layout_only: 1 })).toThrow()
      expect(() => EditorCommandSchema.parse({ type: 'SetLayoutOnly' })).toThrow()
    })

    it('validates SnapshotExported event', () => {
      const snapshotEvent = EditorEventSchema.parse({
        type: 'SnapshotExported',
        document: {
          cards: [
            {
              id: 'skill-1',
              title: 'Skill One',
              position: { x: 10, y: 20 },
              size: { width: 180, height: 80 },
            },
          ],
          connections: [{ from_id: 'skill-1', to_id: 'skill-2' }],
        },
      })
      expect(snapshotEvent.type).toBe('SnapshotExported')
      if (snapshotEvent.type === 'SnapshotExported') {
        expect(snapshotEvent.document.cards.length).toBe(1)
        expect(snapshotEvent.document.connections.length).toBe(1)
      }
    })
  })

  describe('Checkpoint & Application Payload Schemas (Matt Pocock SDD)', () => {
    it('validates complete LearningPathCheckpointSchema roundtrip', () => {
      const checkpoint = {
        version: 1 as const,
        saved_at: '2026-09-10T10:00:00.000Z',
        editor: {
          format_version: 1 as const,
          revision: 4,
          cards: [
            {
              id: 'skill-a',
              title: 'Skill A',
              position: { x: 100, y: 150 },
              size: { width: 180, height: 80 },
            },
          ],
          connections: [],
        },
        application: {
          learning_path_id: 'lp-test',
          skills: [
            {
              id: 'skill-a',
              outcome: 'Understand A',
              tasks: [
                {
                  id: 'task-1',
                  title: 'Task 1',
                  description: 'Do Task 1',
                  required: true,
                },
              ],
            },
          ],
        },
      }

      const { LearningPathCheckpointSchema } = require('./protocol')
      const parsed = LearningPathCheckpointSchema.parse(checkpoint)
      expect(parsed).toEqual(checkpoint)
    })
  })
})
