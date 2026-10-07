import React, { useLayoutEffect, useMemo } from 'react'
import type { CameraState, LabelLayout } from './protocol'
import { cameraToCssTransform } from './coords'
import { recordLabelCommit, traceStage, type LabelRevision } from './benchmarkHooks'

interface SkillCardOverlayProps {
  /** World-space label bounds from the engine. */
  labels: LabelLayout[]
  /** Engine camera from CameraChanged; places every label through one transform. */
  camera: CameraState
  benchmarkRevision?: LabelRevision
  /** Learning status per card, in modes that track it; absent in the P1 editor. */
  status?: Record<string, LabelStatus>
  /** Connection points and drag feedback; absent where connections cannot be edited. */
  connecting?: ConnectionOverlay
}

export interface LabelStatus { locked: boolean; mastered: boolean }

/** What the overlay shows of connection editing; the engine decides every hit. */
export interface ConnectionOverlay {
  /** The card under the pointer, whose connection point is shown. */
  hoveredId: string | null
  /** The connection being dragged, with the targets that accept it. */
  drag: { fromId: string; validTargetIds: ReadonlySet<string>; targetId: string | null } | null
}

/** Matches the engine's connection point (`CONNECTION_HANDLE_RADIUS_PX`, capped for small cards). */
export const CONNECTION_POINT_RADIUS_PX = 9

/** The screen radius of a card's connection point at a zoom, as the engine hit-tests it. */
export function connectionPointRadius(width: number, height: number, zoom: number): number {
  return Math.max(2, Math.min(CONNECTION_POINT_RADIUS_PX, Math.min(width, height) * zoom * 0.25))
}

type TargetState = 'source' | 'valid' | 'invalid' | undefined

export const SkillCardOverlay: React.FC<SkillCardOverlayProps> = ({
  labels,
  camera,
  benchmarkRevision,
  status,
  connecting,
}) => {
  const renderStart = performance.now()
  // Layout effects run after DOM mutation but before the browser may paint.
  // Metadata belongs to these rendered labels, not the latest global counters.
  useLayoutEffect(() => {
    traceStage('labels-render-commit', renderStart)
    recordLabelCommit(benchmarkRevision)
  }, [labels, camera, benchmarkRevision])

  // Panning and zooming change only the camera container's transform; the
  // label elements re-render only when the engine re-sends their bounds.
  const drag = connecting?.drag ?? null
  const hoveredId = connecting?.hoveredId ?? null
  const targetState = (id: string): TargetState => {
    if (!drag) return undefined
    if (id === drag.fromId) return 'source'
    return drag.validTargetIds.has(id) ? 'valid' : 'invalid'
  }
  const labelElements = useMemo(
    () =>
      labels.map((label) => {
        const target = targetState(label.card_id)
        const underPointer = drag?.targetId === label.card_id && target !== 'source'
        return (
        <div
          key={label.card_id}
          id={`card-label-${label.card_id}`}
          // Contract §5 drags the selected centre card, so a driver must be
          // able to find it without reading style classes.
          data-selected={label.selected ? 'true' : 'false'}
          data-connect-target={target}
          data-connect-hover={underPointer ? 'true' : undefined}
          style={{
            position: 'absolute',
            left: `${label.world_rect.x}px`,
            top: `${label.world_rect.y}px`,
            width: `${label.world_rect.width}px`,
            height: `${label.world_rect.height}px`,
          }}
          className={`p-3 flex flex-col justify-between select-none rounded-xl transition-colors duration-150 ${
            target === 'valid'
              ? underPointer ? 'ring-4 ring-emerald-400 bg-emerald-500/15' : 'ring-2 ring-emerald-500/80 bg-emerald-500/5'
              : target === 'invalid'
                ? underPointer ? 'ring-2 ring-red-500/90 bg-red-500/10 opacity-70' : 'opacity-40'
                : label.selected
                  ? 'ring-2 ring-blue-500/80 bg-blue-500/5 shadow-lg shadow-blue-500/10'
                  : ''
          }`}
        >

          <div>
            <div className="flex items-center justify-between gap-1 mb-1">
              <span
                className={`text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded ${
                  label.selected
                    ? 'bg-blue-500/20 text-blue-300 font-semibold'
                    : 'bg-slate-800 text-slate-400'
                }`}
              >
                Skill
              </span>
              {status?.[label.card_id] && (
                <span
                  id={`card-status-${label.card_id}`}
                  data-locked={status[label.card_id].locked}
                  data-mastered={status[label.card_id].mastered}
                  className="flex gap-1 text-[9px] font-mono"
                >
                  {status[label.card_id].locked && <span className="px-1 rounded bg-red-950/70 text-red-300">Locked</span>}
                  {status[label.card_id].mastered && <span className="px-1 rounded bg-violet-950/70 text-violet-300">Mastery</span>}
                </span>
              )}
              {label.selected && (
                <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shadow-[0_0_6px_#60a5fa]" />
              )}
            </div>
            <h3
              className={`text-xs font-semibold leading-snug line-clamp-2 ${
                label.selected ? 'text-white' : 'text-slate-200'
              }`}
            >
              {label.title}
            </h3>
          </div>
          {target === 'invalid' && underPointer && <span className="text-[10px] text-red-200">Cannot connect here</span>}
        </div>
        )
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [labels, status, drag]
  )

  // Only the few shown connection points render, in their own layer, so hovering
  // or zooming never re-renders every label. They keep a constant screen size:
  // the camera transform scales world units, so their world size is divided by the zoom.
  const zoom = camera.zoom
  const pointElements = useMemo(() => {
    if (!connecting) return null
    return labels
      .filter((label) => label.selected || hoveredId === label.card_id || drag?.fromId === label.card_id)
      .map((label) => {
        const radius = connectionPointRadius(label.world_rect.width, label.world_rect.height, zoom) / zoom
        return (
          <div
            key={label.card_id}
            id={`card-connection-point-${label.card_id}`}
            data-card-id={label.card_id}
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: `${label.world_rect.x + label.world_rect.width - radius}px`,
              top: `${label.world_rect.y + label.world_rect.height / 2 - radius}px`,
              width: `${radius * 2}px`,
              height: `${radius * 2}px`,
              borderWidth: `${2 / zoom}px`,
            }}
            className={`rounded-full border-white ${drag?.fromId === label.card_id ? 'bg-emerald-400' : 'bg-blue-500'}`}
          />
        )
      })
  }, [labels, connecting, hoveredId, drag, zoom])

  return (
    <div
      id="labels-overlay"
      // Clip without creating a scroll container: scrollIntoView/find must not
      // move HTML labels independently of the WebGPU camera.
      className="absolute inset-0 pointer-events-none overflow-clip"
    >
      <div
        id="labels-camera"
        className="absolute left-0 top-0"
        style={{ transformOrigin: '0 0', transform: cameraToCssTransform(camera), willChange: 'transform' }}
      >
        {labelElements}
        {pointElements}
      </div>
    </div>
  )
}
