import React from 'react'
import type { GpuStatus } from './types'

interface EditorToolbarProps {
  gpuStatus: GpuStatus
  cardCount: number
}

export const EditorToolbar: React.FC<EditorToolbarProps> = ({
  gpuStatus,
  cardCount,
}) => {
  return (
    <div className="h-12 border-b border-slate-800/80 bg-slate-900/60 px-4 flex items-center justify-between backdrop-blur-sm z-20">
      <div className="flex items-center gap-3">
        <span className="text-xs font-semibold text-slate-300 tracking-wide flex items-center gap-2">
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
      </div>

      <div className="flex items-center gap-2 text-xs text-slate-400">
        <span className="text-[11px] text-slate-500 font-mono">US68 • One card per Skill</span>
      </div>
    </div>
  )
}
