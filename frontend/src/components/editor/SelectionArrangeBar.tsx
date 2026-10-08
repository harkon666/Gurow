import React from 'react'
import type { Arrangement } from './protocol'

interface SelectionArrangeBarProps {
  /** How many Skills are selected; distribution needs three. */
  count: number
  onArrange: (arrangement: Arrangement) => void
}

/** Icon strokes on a 16×16 grid: a guide line and the card bars it lines up. */
const ACTIONS: { arrangement: Arrangement; label: string; icon: React.ReactNode; minimum: number }[] = [
  { arrangement: 'AlignLeft', label: 'Align left', minimum: 2, icon: <><path d="M2 1v14" /><rect x="4" y="3" width="9" height="3" /><rect x="4" y="10" width="5" height="3" /></> },
  { arrangement: 'AlignCenter', label: 'Align centers horizontally', minimum: 2, icon: <><path d="M8 1v14" /><rect x="3" y="3" width="10" height="3" /><rect x="5" y="10" width="6" height="3" /></> },
  { arrangement: 'AlignRight', label: 'Align right', minimum: 2, icon: <><path d="M14 1v14" /><rect x="3" y="3" width="9" height="3" /><rect x="7" y="10" width="5" height="3" /></> },
  { arrangement: 'AlignTop', label: 'Align top', minimum: 2, icon: <><path d="M1 2h14" /><rect x="3" y="4" width="3" height="9" /><rect x="10" y="4" width="3" height="5" /></> },
  { arrangement: 'AlignMiddle', label: 'Align centers vertically', minimum: 2, icon: <><path d="M1 8h14" /><rect x="3" y="3" width="3" height="10" /><rect x="10" y="5" width="3" height="6" /></> },
  { arrangement: 'AlignBottom', label: 'Align bottom', minimum: 2, icon: <><path d="M1 14h14" /><rect x="3" y="3" width="3" height="9" /><rect x="10" y="7" width="3" height="5" /></> },
  { arrangement: 'DistributeHorizontally', label: 'Space evenly horizontally', minimum: 3, icon: <><path d="M1 2v12M15 2v12" /><rect x="6.5" y="4" width="3" height="8" /></> },
  { arrangement: 'DistributeVertically', label: 'Space evenly vertically', minimum: 3, icon: <><path d="M2 1h12M2 15h12" /><rect x="4" y="6.5" width="8" height="3" /></> },
]

/** Aligns or spaces out a multiselection; each action is one undo step in the engine. */
export const SelectionArrangeBar: React.FC<SelectionArrangeBarProps> = ({ count, onArrange }) => (
  <div
    id="canvas-arrange-bar"
    role="toolbar"
    aria-label="Arrange selected Skills"
    className="absolute bottom-11 left-1/2 -translate-x-1/2 z-20 flex items-center gap-0.5 bg-gray-900/90 border border-gray-700 rounded-lg p-1 shadow-lg"
  >
    {ACTIONS.map(({ arrangement, label, icon, minimum }, i) => (
      <React.Fragment key={arrangement}>
        {i === 6 && <span className="w-px h-5 bg-gray-700 mx-0.5" aria-hidden="true" />}
        <button
          type="button"
          data-arrangement={arrangement}
          title={count < minimum ? `${label} (select ${minimum} or more)` : label}
          aria-label={label}
          disabled={count < minimum}
          // Keep focus on the canvas, so the arrow keys still move the selection.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onArrange(arrangement)}
          className="p-1.5 rounded text-gray-300 hover:text-white hover:bg-gray-700 disabled:opacity-35 disabled:hover:bg-transparent disabled:cursor-not-allowed"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
            {icon}
          </svg>
        </button>
      </React.Fragment>
    ))}
  </div>
)
