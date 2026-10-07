import { z } from 'zod'

/** Shared JSON contract for Rust/React editor coordinates and commands/events. */
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

/** World-space card bounds; the overlay applies the camera from CameraChanged as one transform. */
export const LabelLayoutSchema = z.object({
  card_id: z.string(),
  title: z.string(),
  world_rect: RectSchema,
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

/** With `shift_key` on the empty canvas, the press draws a selection box instead of panning. */
export const PointerDownCommandSchema = z.object({
  type: z.literal('PointerDown'),
  screen_x: z.number(),
  screen_y: z.number(),
  shift_key: z.boolean().optional(),
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

/** Deletes a card with its connections as one undo step; the application decides whether the Skill may go. */
export const DeleteCardCommandSchema = z.object({
  type: z.literal('DeleteCard'),
  id: z.string(),
})

export const ExportSnapshotCommandSchema = z.object({
  type: z.literal('ExportSnapshot'),
})

export const SetCameraCommandSchema = z.object({
  type: z.literal('SetCamera'),
  offset_x: z.number(),
  offset_y: z.number(),
  zoom: z.number(),
})

/** Ends the gesture in progress without completing it (Escape, a cancelled pointer). */
export const CancelInteractionCommandSchema = z.object({
  type: z.literal('CancelInteraction'),
})

/** Selects one connection (or none) for deletion. */
export const SelectConnectionCommandSchema = z.object({
  type: z.literal('SelectConnection'),
  connection: PrerequisiteConnectionSchema.nullable(),
})

/** A read-only canvas pans, zooms and selects, but refuses edits to its document. */
export const SetReadOnlyCommandSchema = z.object({
  type: z.literal('SetReadOnly'),
  read_only: z.boolean(),
})

/** A layout-only canvas also moves cards (and undoes moves), but refuses new cards and connection changes. */
export const SetLayoutOnlyCommandSchema = z.object({
  type: z.literal('SetLayoutOnly'),
  layout_only: z.boolean(),
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
  DeleteCardCommandSchema,
  ExportSnapshotCommandSchema,
  SetCameraCommandSchema,
  SetReadOnlyCommandSchema,
  SetLayoutOnlyCommandSchema,
  CancelInteractionCommandSchema,
  SelectConnectionCommandSchema,
])

/** Events emitted by the editor engine after a command has been applied. */
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

/** A card left the document (a deletion or its redo), with its connections. */
export const CardDeletedEventSchema = z.object({
  type: z.literal('CardDeleted'),
  card_id: z.string(),
})

/** A deleted card came back (the undo of a deletion), with its connections. */
export const CardRestoredEventSchema = z.object({
  type: z.literal('CardRestored'),
  card_id: z.string(),
})

/** `selected_id` names the selected Skill when exactly one is selected; `selected_ids` lists every selected Skill. */
export const SelectionChangedEventSchema = z.object({
  type: z.literal('SelectionChanged'),
  selected_id: z.string().nullable(),
  title: z.string().nullable(),
  selected_ids: z.array(z.string()),
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

/** A drag from `from_id`'s connection point began; the graph accepts `valid_target_ids` as targets. */
export const ConnectionDragStartedEventSchema = z.object({
  type: z.literal('ConnectionDragStarted'),
  from_id: z.string(),
  valid_target_ids: z.array(z.string()),
})

export const ConnectionDragTargetChangedEventSchema = z.object({
  type: z.literal('ConnectionDragTargetChanged'),
  target_id: z.string().nullable(),
})

/** A drop only proposes `from_id` → `dropped_on`; null when cancelled or dropped on the empty canvas. */
export const ConnectionDragEndedEventSchema = z.object({
  type: z.literal('ConnectionDragEnded'),
  from_id: z.string(),
  dropped_on: z.string().nullable(),
})

export const ConnectionSelectedEventSchema = z.object({
  type: z.literal('ConnectionSelected'),
  connection: PrerequisiteConnectionSchema.nullable(),
})

export const SnapshotExportedEventSchema = z.object({
  type: z.literal('SnapshotExported'),
  document: z.object({
    cards: z.array(SkillCardSchema),
    connections: z.array(PrerequisiteConnectionSchema),
  }),
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
  CardDeletedEventSchema,
  CardRestoredEventSchema,
  SelectionChangedEventSchema,
  LabelsUpdatedEventSchema,
  CameraChangedEventSchema,
  HistoryChangedEventSchema,
  ConnectionCreatedEventSchema,
  ConnectionDeletedEventSchema,
  ConnectionRejectedEventSchema,
  ConnectionsUpdatedEventSchema,
  ConnectionDragStartedEventSchema,
  ConnectionDragTargetChangedEventSchema,
  ConnectionDragEndedEventSchema,
  ConnectionSelectedEventSchema,
  SnapshotExportedEventSchema,
  GpuErrorEventSchema,
  ErrorEventSchema,
])

export const EditorEventsSchema = z.array(EditorEventSchema)

// Checkpoint & Application Payload Schemas (ADR-0016, Matt Pocock SDD pattern)
export const EditorSnapshotSchema = z.object({
  format_version: z.literal(1),
  revision: z.number().int().nonnegative(),
  cards: z.array(SkillCardSchema),
  connections: z.array(PrerequisiteConnectionSchema),
})

export const TaskPayloadSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  required: z.boolean(),
})

export const SkillPayloadSchema = z.object({
  id: z.string(),
  outcome: z.string(),
  tasks: z.array(TaskPayloadSchema),
})

export const ApplicationPayloadSchema = z.object({
  learning_path_id: z.string(),
  skills: z.array(SkillPayloadSchema),
})

export const LearningPathCheckpointSchema = z.object({
  version: z.literal(1),
  saved_at: z.string(),
  editor: EditorSnapshotSchema,
  application: ApplicationPayloadSchema,
})

export const CameraStateSchema = z.object({
  offset_x: z.number(),
  offset_y: z.number(),
  zoom: z.number(),
})

// Inferred TypeScript types (Matt Pocock SDD pattern)
export type Point = z.infer<typeof PointSchema>
export type Size = z.infer<typeof SizeSchema>
export type Rect = z.infer<typeof RectSchema>
export type LabelLayout = z.infer<typeof LabelLayoutSchema>
export type SkillCard = z.infer<typeof SkillCardSchema>
export type PrerequisiteConnection = z.infer<typeof PrerequisiteConnectionSchema>
export type EditorCommand = z.infer<typeof EditorCommandSchema>
export type EditorEvent = z.infer<typeof EditorEventSchema>
export type EditorSnapshot = z.infer<typeof EditorSnapshotSchema>
export type TaskPayload = z.infer<typeof TaskPayloadSchema>
export type SkillPayload = z.infer<typeof SkillPayloadSchema>
export type ApplicationPayload = z.infer<typeof ApplicationPayloadSchema>
export type LearningPathCheckpoint = z.infer<typeof LearningPathCheckpointSchema>
export type CameraState = z.infer<typeof CameraStateSchema>
