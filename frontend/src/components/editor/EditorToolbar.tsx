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
  onSimulateFailure?: () => void
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
  onSimulateFailure,
}) => {
  return (
    <div className="@container h-12 shrink-0 border-b border-slate-800/80 bg-slate-900/60 px-4 flex items-center justify-between gap-3 backdrop-blur-sm z-20">
      {/*
        Controls keep their intrinsic width (shrink-0 + whitespace-nowrap) so a
        narrow editor column scrolls the group instead of squeezing every label
        into a one-character-per-line sliver.
      */}
      <div className="flex items-center gap-2 min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <span
          id="gpu-status-badge"
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
          WebGPU Rust Editor
        </span>
        <span
          id="editor-card-count"
          className="text-[11px] text-slate-500 bg-slate-800/60 px-2 py-0.5 rounded font-mono shrink-0 whitespace-nowrap"
        >
          {cardCount} cards
        </span>

        {onCreateSkill && (
          <button
            id="editor-add-card-btn"
            onClick={onCreateSkill}
            disabled={gpuStatus !== 'ready'}
            title="Create new Skill card"
            className="px-2 py-1 text-xs rounded font-medium bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 hover:text-white border border-emerald-500/30 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 flex items-center gap-1 shrink-0 whitespace-nowrap transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            <span>+ Skill</span>
          </button>
        )}

        <div className="h-4 w-px bg-slate-800 mx-1 shrink-0" />

        {/* History Controls */}
        <div className="flex items-center gap-1 shrink-0">
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
        </div>

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

        {onSimulateFailure && gpuStatus === 'ready' && (
          <button
            id="btn-simulate-gpu-failure"
            onClick={onSimulateFailure}
            title="Simulate WebGPU Device Loss (AC3 / Testing)"
            className="text-[10px] font-mono px-2 py-1 rounded bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 cursor-pointer transition-colors shrink-0 whitespace-nowrap"
          >
            Simulate GPU Failure
          </button>
        )}
      </div>

      {/*
        Gated on the toolbar's own width, not the viewport: the editor column is
        far narrower than the page, so a viewport breakpoint would show this
        caption and push the real controls out of reach.
      */}
      <div className="hidden @4xl:flex items-center gap-2 text-xs text-slate-400 shrink-0">
        <span className="text-[11px] text-slate-500 font-mono whitespace-nowrap">
          P1/T05 • Renderer Recovery &amp; Prerequisite List
        </span>
      </div>
    </div>
  )
}
