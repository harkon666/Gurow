import React from 'react'
import type { GpuStatus } from './types'

interface EditorToolbarProps {
  gpuStatus: GpuStatus
  cardCount: number
  canUndo?: boolean
  canRedo?: boolean
  onUndo?: () => void
  onRedo?: () => void
  zoom?: number
  onZoomIn?: () => void
  onZoomOut?: () => void
  onResetZoom?: () => void
  onCreateSkill?: () => void
  navigation?: React.ReactNode
  /** A navigation-only canvas: no history controls, and a note on who arranges the cards. */
  readOnly?: boolean
  /** A positions-only canvas: history controls stay, with a note that content stays as published. */
  layoutOnly?: boolean
}

export const EditorToolbar: React.FC<EditorToolbarProps> = ({
  gpuStatus,
  cardCount,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  zoom = 1.0,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  onCreateSkill,
  navigation,
  readOnly = false,
  layoutOnly = false,
}) => {
  return (
    <div className="@container min-h-12 shrink-0 border-b border-slate-800/80 bg-slate-900/60 px-3 py-2 flex items-center justify-between gap-3 backdrop-blur-sm z-20">
      {/*
        Controls keep their intrinsic width (shrink-0 + whitespace-nowrap) so a
        narrow editor column scrolls the group instead of squeezing every label
        into a one-character-per-line sliver.
      */}
      <div className="flex flex-wrap items-center gap-2 min-w-0 flex-1">
        {navigation}
        <span
          id="gpu-status-badge"
          data-status={gpuStatus}
          aria-label={`Canvas ${gpuStatus === 'ready' ? 'ready' : gpuStatus === 'initializing' ? 'loading' : 'unavailable'}`}
          className="text-xs font-semibold text-slate-300 tracking-wide flex items-center gap-2 shrink-0 whitespace-nowrap"
        >
          <span
            className={`w-2 h-2 rounded-full ${
              gpuStatus === 'ready'
                ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]'
                : gpuStatus === 'initializing'
                ? 'bg-amber-400 animate-pulse'
                : 'bg-red-400'
            }`}
          />
          Canvas
        </span>
        <span
          id="editor-card-count"
          className="text-[11px] text-slate-500 bg-slate-800/60 px-2 py-0.5 rounded font-mono shrink-0 whitespace-nowrap"
        >
          {cardCount} Skills
        </span>

        {onCreateSkill && (
          <button
            id="editor-add-card-btn"
            onClick={onCreateSkill}
            disabled={gpuStatus === 'initializing'}
            title="Create new Skill card"
            className="px-2 py-1 text-xs rounded font-medium bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 hover:text-white border border-emerald-500/30 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 flex items-center gap-1 shrink-0 whitespace-nowrap transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            <span>Add Skill</span>
          </button>
        )}

        <div className="h-4 w-px bg-slate-800 mx-1 shrink-0" />

        {readOnly && (
          <span
            id="editor-read-only-badge"
            title="You can pan, zoom and select. The Coach arranges the cards."
            className="text-[11px] text-slate-300 bg-slate-800/60 border border-slate-700/60 px-2 py-0.5 rounded shrink-0 whitespace-nowrap"
          >
            View only · layout by the Coach
          </span>
        )}

        {layoutOnly && (
          <span
            id="editor-layout-only-badge"
            title="Drag cards to rearrange them. Skills, Tasks and Prerequisites stay as published."
            className="text-[11px] text-sky-200 bg-sky-950/40 border border-sky-800/60 px-2 py-0.5 rounded shrink-0 whitespace-nowrap"
          >
            Layout only · content stays as published
          </span>
        )}

        {!readOnly && (
          <span
            id="editor-multiselect-hint"
            title="Hold Shift and drag across the empty canvas to select several Skills, then drag one of them to move them together."
            className="hidden xl:inline text-[11px] text-slate-500 shrink-0 whitespace-nowrap"
          >
            Shift+drag selects several
          </span>
        )}

        {/* History Controls */}
        {!readOnly && <div className="flex items-center gap-1 shrink-0">
          <button
            id="editor-undo-btn"
            onClick={onUndo}
            disabled={!canUndo}
            title="Undo (Ctrl+Z)"
            className={`px-2 py-1 text-xs rounded font-medium flex items-center gap-1 shrink-0 whitespace-nowrap transition-colors ${
              canUndo
                ? 'bg-slate-800 text-slate-200 hover:bg-slate-700 hover:text-white cursor-pointer'
                : 'bg-slate-900/50 text-slate-600 cursor-not-allowed'
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a5 5 0 015 5v2m-15-7l4-4m-4 4l4 4" />
            </svg>
            <span>Undo</span>
          </button>
          <button
            id="editor-redo-btn"
            onClick={onRedo}
            disabled={!canRedo}
            title="Redo (Ctrl+Y)"
            className={`px-2 py-1 text-xs rounded font-medium flex items-center gap-1 shrink-0 whitespace-nowrap transition-colors ${
              canRedo
                ? 'bg-slate-800 text-slate-200 hover:bg-slate-700 hover:text-white cursor-pointer'
                : 'bg-slate-900/50 text-slate-600 cursor-not-allowed'
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 10H11a5 5 0 00-5 5v2m15-7l-4-4m4 4l-4 4" />
            </svg>
            <span>Redo</span>
          </button>
        </div>}

        <div className="h-4 w-px bg-slate-800 mx-1 shrink-0" />

        {/* Zoom Controls */}
        <div className="flex items-center gap-1 bg-slate-800/40 rounded-lg p-0.5 border border-slate-800/60 shrink-0">
          <button
            id="editor-zoom-out-btn"
            onClick={onZoomOut}
            title="Zoom Out"
            className="w-6 h-6 shrink-0 flex items-center justify-center text-slate-400 hover:text-slate-200 hover:bg-slate-700/50 rounded cursor-pointer transition-colors"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
            </svg>
          </button>
          <span
            id="editor-zoom-label"
            className="text-[11px] font-mono text-slate-300 px-1.5 min-w-[40px] shrink-0 text-center select-none whitespace-nowrap"
          >
            {Math.round(zoom * 100)}%
          </span>
          <button
            id="editor-zoom-in-btn"
            onClick={onZoomIn}
            title="Zoom In"
            className="w-6 h-6 shrink-0 flex items-center justify-center text-slate-400 hover:text-slate-200 hover:bg-slate-700/50 rounded cursor-pointer transition-colors"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
          <button
            id="editor-zoom-reset-btn"
            onClick={onResetZoom}
            title="Reset Zoom (100%)"
            className="text-[10px] font-mono text-slate-400 hover:text-slate-200 hover:bg-slate-700/50 px-1.5 py-0.5 rounded cursor-pointer transition-colors ml-0.5 shrink-0 whitespace-nowrap"
          >
            1:1
          </button>
        </div>


      </div>


    </div>
  )
}
