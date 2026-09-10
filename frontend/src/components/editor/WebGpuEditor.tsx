import React, { useRef, useMemo } from 'react'
import { INITIAL_LEARNING_PATH_FIXTURE } from '../../fixtures/learningPath'
import type { SelectedSkillInfo } from './types'
import { useWasmEditor } from './useWasmEditor'
import { EditorToolbar } from './EditorToolbar'
import { SkillCardOverlay } from './SkillCardOverlay'

interface WebGpuEditorProps {
  onSelectSkill: (skill: SelectedSkillInfo | null) => void
}

export const WebGpuEditor: React.FC<WebGpuEditorProps> = ({
  onSelectSkill,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const initialCards = useMemo(
    () =>
      INITIAL_LEARNING_PATH_FIXTURE.skills.map((s) => ({
        id: s.id,
        title: s.title,
        position: { x: s.initialPosition.x, y: s.initialPosition.y },
      })),
    []
  )

  const {
    labels,
    zoom,
    canUndo,
    canRedo,
    gpuStatus,
    errorMessage,
    engineError,
    clearEngineError,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    undo,
    redo,
    zoomIn,
    zoomOut,
    resetZoom,
  } = useWasmEditor({
    canvasRef,
    containerRef,
    onSelectionChanged: onSelectSkill,
    initialCards,
  })

  return (
    <div className="relative flex-1 flex flex-col h-full overflow-hidden bg-slate-950">
      {/* Top Action Bar */}
      <EditorToolbar
        gpuStatus={gpuStatus}
        cardCount={labels.length}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={undo}
        onRedo={redo}
        zoom={zoom}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onResetZoom={resetZoom}
      />

      {/* Engine Error Toast Banner */}
      {engineError && (
        <div className="absolute top-14 left-4 right-4 z-40 bg-red-950/90 border border-red-800/80 text-red-200 px-4 py-2 rounded-xl text-xs flex items-center justify-between shadow-lg">
          <span>{engineError}</span>
          <button
            onClick={clearEngineError}
            className="text-red-400 hover:text-red-200 ml-4 font-bold cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}

      {/* Canvas & Overlay Container */}
      <div
        ref={containerRef}
        className="relative flex-1 w-full h-full overflow-hidden"
      >
        {/* Notice when WebGPU is unavailable or in error */}
        {(gpuStatus === 'unsupported' || gpuStatus === 'error') && (
          <div
            id="editor-gpu-notice"
            className="absolute inset-0 z-30 flex flex-col items-center justify-center p-8 text-center bg-slate-950/95"
          >
            <div className="max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl">
              <div className="w-12 h-12 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20 flex items-center justify-center mx-auto mb-4">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <h3 className="text-base font-semibold text-slate-100 mb-2">
                WebGPU Canvas Required
              </h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                {errorMessage || 'A browser with WebGPU support is required to render and interact with the canvas editor.'}
              </p>
            </div>
          </div>
        )}

        {/* WebGPU Canvas: receives all pointer interactions directly */}
        <canvas
          id="editor-canvas"
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          className="absolute inset-0 w-full h-full block cursor-pointer touch-none"
        />

        {/* HTML Labels Overlay: positioned from engine output */}
        <SkillCardOverlay labels={labels} />
      </div>
    </div>
  )
}
