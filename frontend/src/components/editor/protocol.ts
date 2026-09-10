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

export const ResizeViewportCommandSchema = z.object({
  type: z.literal('ResizeViewport'),
  width: z.number(),
  height: z.number(),
})

export const EditorCommandSchema = z.discriminatedUnion('type', [
  LoadDocumentCommandSchema,
  CreateCardCommandSchema,
  SelectCardCommandSchema,
  PointerDownCommandSchema,
  ResizeViewportCommandSchema,
])

export const DocumentLoadedEventSchema = z.object({
  type: z.literal('DocumentLoaded'),
})

export const CardCreatedEventSchema = z.object({
  type: z.literal('CardCreated'),
  card: SkillCardSchema,
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
  SelectionChangedEventSchema,
  LabelsUpdatedEventSchema,
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
export type EditorCommand = z.infer<typeof EditorCommandSchema>
export type EditorEvent = z.infer<typeof EditorEventSchema>
