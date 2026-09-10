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
}) => {
  return (
    <div className="h-12 border-b border-slate-800/80 bg-slate-900/60 px-4 flex items-center justify-between backdrop-blur-sm z-20">
      <div className="flex items-center gap-3">
        <span
          id="gpu-status-badge"
          className="text-xs font-semibold text-slate-300 tracking-wide flex items-center gap-2"
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
          className="text-[11px] text-slate-500 bg-slate-800/60 px-2 py-0.5 rounded font-mono"
        >
          {cardCount} cards
        </span>

        {onCreateSkill && (
          <button
            id="editor-add-card-btn"
            onClick={onCreateSkill}
            disabled={gpuStatus !== 'ready'}
            title="Create new Skill card"
            className="px-2 py-1 text-xs rounded font-medium bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 hover:text-white border border-emerald-500/30 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 flex items-center gap-1 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            <span>+ Skill</span>
          </button>
        )}

        <div className="h-4 w-px bg-slate-800 mx-1" />

        {/* History Controls */}
        <div className="flex items-center gap-1">
          <button
            id="editor-undo-btn"
            onClick={onUndo}
            disabled={!canUndo}
            title="Undo (Ctrl+Z)"
            className={`px-2 py-1 text-xs rounded font-medium flex items-center gap-1 transition-colors ${
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
            className={`px-2 py-1 text-xs rounded font-medium flex items-center gap-1 transition-colors ${
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

        <div className="h-4 w-px bg-slate-800 mx-1" />

        {/* Zoom Controls */}
        <div className="flex items-center gap-1 bg-slate-800/40 rounded-lg p-0.5 border border-slate-800/60">
          <button
            id="editor-zoom-out-btn"
            onClick={onZoomOut}
            title="Zoom Out"
            className="w-6 h-6 flex items-center justify-center text-slate-400 hover:text-slate-200 hover:bg-slate-700/50 rounded cursor-pointer transition-colors"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
            </svg>
          </button>
          <span
            id="editor-zoom-label"
            className="text-[11px] font-mono text-slate-300 px-1.5 min-w-[40px] text-center select-none"
          >
            {Math.round(zoom * 100)}%
          </span>
          <button
            id="editor-zoom-in-btn"
            onClick={onZoomIn}
            title="Zoom In"
            className="w-6 h-6 flex items-center justify-center text-slate-400 hover:text-slate-200 hover:bg-slate-700/50 rounded cursor-pointer transition-colors"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
          <button
            id="editor-zoom-reset-btn"
            onClick={onResetZoom}
            title="Reset Zoom (100%)"
            className="text-[10px] font-mono text-slate-400 hover:text-slate-200 hover:bg-slate-700/50 px-1.5 py-0.5 rounded cursor-pointer transition-colors ml-0.5"
          >
            1:1
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs text-slate-400">
        <span className="text-[11px] text-slate-500 font-mono">P1/T03 • Prerequisite DAG & Connections</span>
      </div>
    </div>
  )
}
