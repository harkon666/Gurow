import React, { useLayoutEffect } from 'react'
import type { LabelLayout } from './protocol'
import { screenToCssRect } from './coords'
import { recordLabelCommit, type LabelRevision } from './benchmarkHooks'

interface SkillCardOverlayProps {
  labels: LabelLayout[]
  benchmarkRevision?: LabelRevision
}

export const SkillCardOverlay: React.FC<SkillCardOverlayProps> = ({
  labels,
  benchmarkRevision,
}) => {
  // Layout effects run after DOM mutation but before the browser may paint.
  // Metadata belongs to these rendered labels, not the latest global counters.
  useLayoutEffect(() => {
    recordLabelCommit(benchmarkRevision)
  }, [labels, benchmarkRevision])

  return (
    <div
      id="labels-overlay"
      className="absolute inset-0 pointer-events-none overflow-hidden"
    >
      {labels.map((label) => {
        const cssRect = screenToCssRect(label.screen_rect)

        return (
          <div
            key={label.card_id}
            id={`card-label-${label.card_id}`}
            style={{
              position: 'absolute',
              left: `${cssRect.left}px`,
              top: `${cssRect.top}px`,
              width: `${cssRect.width}px`,
              height: `${cssRect.height}px`,
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

            <span className="text-[10px] text-slate-500 font-mono truncate">
              {label.card_id}
            </span>
          </div>
        )
      })}
    </div>
  )
}
