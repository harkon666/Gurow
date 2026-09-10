import { z } from 'zod'

export const PointSchema = z.object({
  x: z.number(),
  y: z.number(),
})

export const SizeSchema = z.object({
  width: z.number(),
  height: z.number(),
})

export const RectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
})

export const LabelLayoutSchema = z.object({
  card_id: z.string(),
  title: z.string(),
  screen_rect: RectSchema,
  selected: z.boolean(),
})

export const SkillCardSchema = z.object({
  id: z.string(),
  title: z.string(),
  position: PointSchema,
  size: SizeSchema,
})

export const PrerequisiteConnectionSchema = z.object({
  from_id: z.string(),
  to_id: z.string(),
})

export const LoadDocumentCommandSchema = z.object({
  type: z.literal('LoadDocument'),
  document: z.object({
    cards: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        position: PointSchema,
        size: SizeSchema.optional(),
      })
    ),
    connections: z.array(PrerequisiteConnectionSchema).optional(),
  }),
})

export const CreateCardCommandSchema = z.object({
  type: z.literal('CreateCard'),
  id: z.string(),
  title: z.string(),
  position: PointSchema,
  size: SizeSchema.optional(),
})

export const SelectCardCommandSchema = z.object({
  type: z.literal('SelectCard'),
  id: z.string().nullable(),
})

export const PointerDownCommandSchema = z.object({
  type: z.literal('PointerDown'),
  screen_x: z.number(),
  screen_y: z.number(),
})

export const PointerMoveCommandSchema = z.object({
  type: z.literal('PointerMove'),
  screen_x: z.number(),
  screen_y: z.number(),
})

export const PointerUpCommandSchema = z.object({
  type: z.literal('PointerUp'),
  screen_x: z.number(),
  screen_y: z.number(),
})

export const PanCameraCommandSchema = z.object({
  type: z.literal('PanCamera'),
  delta_x: z.number(),
  delta_y: z.number(),
})

export const ZoomAtCommandSchema = z.object({
  type: z.literal('ZoomAt'),
  screen_x: z.number(),
  screen_y: z.number(),
  factor: z.number(),
})

export const UndoCommandSchema = z.object({
  type: z.literal('Undo'),
})

export const RedoCommandSchema = z.object({
  type: z.literal('Redo'),
})

export const ResizeViewportCommandSchema = z.object({
  type: z.literal('ResizeViewport'),
  width: z.number(),
  height: z.number(),
})

export const ConnectSkillsCommandSchema = z.object({
  type: z.literal('ConnectSkills'),
  from_id: z.string(),
  to_id: z.string(),
})

export const DisconnectSkillsCommandSchema = z.object({
  type: z.literal('DisconnectSkills'),
  from_id: z.string(),
  to_id: z.string(),
})

export const EditorCommandSchema = z.discriminatedUnion('type', [
  LoadDocumentCommandSchema,
  CreateCardCommandSchema,
  SelectCardCommandSchema,
  PointerDownCommandSchema,
  PointerMoveCommandSchema,
  PointerUpCommandSchema,
  PanCameraCommandSchema,
  ZoomAtCommandSchema,
  UndoCommandSchema,
  RedoCommandSchema,
  ResizeViewportCommandSchema,
  ConnectSkillsCommandSchema,
  DisconnectSkillsCommandSchema,
])

export const DocumentLoadedEventSchema = z.object({
  type: z.literal('DocumentLoaded'),
})

export const CardCreatedEventSchema = z.object({
  type: z.literal('CardCreated'),
  card: SkillCardSchema,
})

export const CardMovedEventSchema = z.object({
  type: z.literal('CardMoved'),
  card_id: z.string(),
  position: PointSchema,
})

export const SelectionChangedEventSchema = z.object({
  type: z.literal('SelectionChanged'),
  selected_id: z.string().nullable(),
  title: z.string().nullable(),
})

export const LabelsUpdatedEventSchema = z.object({
  type: z.literal('LabelsUpdated'),
  labels: z.array(LabelLayoutSchema),
})

export const CameraChangedEventSchema = z.object({
  type: z.literal('CameraChanged'),
  offset_x: z.number(),
  offset_y: z.number(),
  zoom: z.number(),
})

export const HistoryChangedEventSchema = z.object({
  type: z.literal('HistoryChanged'),
  can_undo: z.boolean(),
  can_redo: z.boolean(),
})

export const ConnectionCreatedEventSchema = z.object({
  type: z.literal('ConnectionCreated'),
  from_id: z.string(),
  to_id: z.string(),
})

export const ConnectionDeletedEventSchema = z.object({
  type: z.literal('ConnectionDeleted'),
  from_id: z.string(),
  to_id: z.string(),
})

export const ConnectionRejectedEventSchema = z.object({
  type: z.literal('ConnectionRejected'),
  from_id: z.string(),
  to_id: z.string(),
  reason: z.string(),
})

export const ConnectionsUpdatedEventSchema = z.object({
  type: z.literal('ConnectionsUpdated'),
  connections: z.array(PrerequisiteConnectionSchema),
})

export const GpuErrorEventSchema = z.object({
  type: z.literal('GpuError'),
  message: z.string(),
})

export const ErrorEventSchema = z.object({
  type: z.literal('Error'),
  message: z.string(),
})

export const EditorEventSchema = z.discriminatedUnion('type', [
  DocumentLoadedEventSchema,
  CardCreatedEventSchema,
  CardMovedEventSchema,
  SelectionChangedEventSchema,
  LabelsUpdatedEventSchema,
  CameraChangedEventSchema,
  HistoryChangedEventSchema,
  ConnectionCreatedEventSchema,
  ConnectionDeletedEventSchema,
  ConnectionRejectedEventSchema,
  ConnectionsUpdatedEventSchema,
  GpuErrorEventSchema,
  ErrorEventSchema,
])

export const EditorEventsSchema = z.array(EditorEventSchema)

// Inferred TypeScript types (Matt Pocock SDD pattern)
export type Point = z.infer<typeof PointSchema>
export type Size = z.infer<typeof SizeSchema>
export type Rect = z.infer<typeof RectSchema>
export type LabelLayout = z.infer<typeof LabelLayoutSchema>
export type SkillCard = z.infer<typeof SkillCardSchema>
export type PrerequisiteConnection = z.infer<typeof PrerequisiteConnectionSchema>
export type EditorCommand = z.infer<typeof EditorCommandSchema>
export type EditorEvent = z.infer<typeof EditorEventSchema>
