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
}

export interface LabelStatus { locked: boolean; mastered: boolean }

export const SkillCardOverlay: React.FC<SkillCardOverlayProps> = ({
  labels,
  camera,
  benchmarkRevision,
  status,
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
  const labelElements = useMemo(
    () =>
      labels.map((label) => (
        <div
          key={label.card_id}
          id={`card-label-${label.card_id}`}
          // Contract §5 drags the selected centre card, so a driver must be
          // able to find it without reading style classes.
          data-selected={label.selected ? 'true' : 'false'}
          style={{
            position: 'absolute',
            left: `${label.world_rect.x}px`,
            top: `${label.world_rect.y}px`,
            width: `${label.world_rect.width}px`,
            height: `${label.world_rect.height}px`,
          }}
          className={`p-3 flex flex-col justify-between select-none rounded-xl transition-colors duration-150 ${
            label.selected
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

        </div>
      )),
    [labels, status]
  )

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
      </div>
    </div>
  )
}
