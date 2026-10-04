import React, { useRef, useMemo, useEffect } from 'react'
import { INITIAL_LEARNING_PATH_FIXTURE } from '../../fixtures/learningPath'
import type { SelectedSkillInfo, GpuStatus } from './types'
import type {
  PrerequisiteConnection,
  SkillCard,
  CameraState,
  Point,
  Size,
} from './protocol'
import { useWasmEditor } from './useWasmEditor'
import { EditorToolbar } from './EditorToolbar'
import { WebGpuEnableHint } from './WebGpuEnableHint'
import { SkillCardOverlay } from './SkillCardOverlay'

export interface WebGpuEditorActions {
  createCard: (id: string, title: string, position: Point, size?: Size) => void
  connectSkills: (fromId: string, toId: string) => void
  disconnectSkills: (fromId: string, toId: string) => void
  exportSnapshot: () => {
    cards: SkillCard[]
    connections: PrerequisiteConnection[]
  } | null
  setCamera: (offset_x: number, offset_y: number, zoom: number) => void
  selectCard: (id: string | null) => void
  recreateRenderer: () => Promise<boolean>
  simulateDeviceLoss: () => void
}

interface WebGpuEditorProps {
  onSelectSkill: (skill: SelectedSkillInfo | null) => void
  onConnectionsChange?: (connections: PrerequisiteConnection[]) => void
  onRejection?: (reason: string | null) => void
  onActionsReady?: (actions: WebGpuEditorActions) => void
  onCreateSkill?: () => void
  initialCards?: Array<{
    id: string
    title: string
    position: Point
    size?: Size
  }>
  initialConnections?: PrerequisiteConnection[]
  initialCamera?: CameraState | null
  onOperationCompleted?: () => void
  onCameraChanged?: (camera: CameraState) => void
  onGpuStatusChange?: (status: GpuStatus) => void
}

export const WebGpuEditor: React.FC<WebGpuEditorProps> = ({
  onSelectSkill,
  onConnectionsChange,
  onRejection,
  onActionsReady,
  onCreateSkill,
  initialCards: customInitialCards,
  initialConnections,
  initialCamera,
  onOperationCompleted,
  onCameraChanged,
  onGpuStatusChange,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const defaultInitialCards = useMemo(
    () =>
      INITIAL_LEARNING_PATH_FIXTURE.skills.map((s) => ({
        id: s.id,
        title: s.title,
        position: { x: s.initialPosition.x, y: s.initialPosition.y },
      })),
    []
  )

  const initialCards = customInitialCards ?? defaultInitialCards

  const {
    labels,
    labelCamera,
    benchmarkRevision,
    connections,
    connectionRejection,
    zoom,
    canUndo,
    canRedo,
    gpuStatus,
    errorMessage,
    recoveryError,
    isRecovering,
    engineError,
    clearEngineError,
    createCard,
    connectSkills,
    disconnectSkills,
    exportSnapshot,
    setCamera,
    selectCard,
    simulateDeviceLoss,
    recreateRenderer,
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
    initialConnections,
    initialCamera,
    onOperationCompleted,
    onCameraChanged,
  })

  useEffect(() => {
    onConnectionsChange?.(connections)
  }, [connections, onConnectionsChange])

  useEffect(() => {
    onRejection?.(connectionRejection)
  }, [connectionRejection, onRejection])

  useEffect(() => {
    onGpuStatusChange?.(gpuStatus)
  }, [gpuStatus, onGpuStatusChange])

  useEffect(() => {
    onActionsReady?.({
      createCard,
      connectSkills,
      disconnectSkills,
      exportSnapshot,
      setCamera,
      selectCard,
      recreateRenderer,
      simulateDeviceLoss,
    })
  }, [
    createCard,
    connectSkills,
    disconnectSkills,
    exportSnapshot,
    setCamera,
    selectCard,
    recreateRenderer,
    simulateDeviceLoss,
    onActionsReady,
  ])

  return (
    <div className="relative flex-1 min-w-0 min-h-[360px] md:min-h-0 flex flex-col h-full overflow-hidden bg-slate-950">
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
        onCreateSkill={onCreateSkill}
        onSimulateFailure={simulateDeviceLoss}
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
        className="relative flex-1 w-full min-h-0 overflow-hidden"
      >
        {/* Notice when WebGPU is unsupported */}
        {gpuStatus === 'unsupported' && (
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
                WebGPU Canvas Unavailable
              </h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                {errorMessage || 'WebGPU is not supported by your current browser environment.'}
              </p>
              <div
                id="canvas-availability-explanation"
                className="text-[11px] text-amber-300 mt-4 bg-amber-500/10 p-2.5 rounded-xl border border-amber-500/20 text-left leading-relaxed"
              >
                <strong>Canvas Availability:</strong> Card positioning remains a canvas operation requiring WebGPU. You can continue navigating all Skills and editing associated Tasks via the keyboard-accessible list.
              </div>
              <WebGpuEnableHint />
            </div>
          </div>
        )}

        {/* Notice when WebGPU renderer encounters an error / device loss */}
        {gpuStatus === 'error' && (
          <div
            id="editor-gpu-error-notice"
            className="absolute inset-0 z-30 flex flex-col items-center justify-center p-8 text-center bg-slate-950/95 backdrop-blur-sm"
          >
            <div className="max-w-md bg-slate-900 border border-red-800/80 rounded-2xl p-6 shadow-2xl">
              <div className="w-12 h-12 rounded-xl bg-red-500/10 text-red-400 border border-red-500/20 flex items-center justify-center mx-auto mb-4">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <h3 className="text-base font-semibold text-red-200 mb-2">
                Renderer Failure / Device Lost
              </h3>
              <p className="text-xs text-slate-300 leading-relaxed mb-4">
                {errorMessage || 'Renderer failure detected. Active document and task edits have been preserved.'}
              </p>

              {/* A lost or unobtainable adapter is usually a local GPU setup issue. */}
              <div className="mb-4">
                <WebGpuEnableHint />
              </div>

              {recoveryError && (
                <div
                  id="recovery-error-banner"
                  className="mb-4 p-2.5 rounded-xl bg-red-950/80 border border-red-800 text-xs text-red-300 text-left"
                >
                  <span className="font-semibold">Recovery Failed:</span> {recoveryError}
                </div>
              )}

              <div className="flex flex-col gap-2">
                <button
                  id="btn-retry-renderer"
                  disabled={isRecovering}
                  onClick={() => recreateRenderer()}
                  className="w-full px-4 py-2.5 text-xs font-semibold rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg cursor-pointer transition-colors flex items-center justify-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  <span>{isRecovering ? 'Recovering Renderer…' : 'Retry Renderer Recreation'}</span>
                </button>
              </div>
              <p className="text-[10px] text-slate-500 mt-3">
                List navigation and Task editing remain available during renderer interruption.
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
        <SkillCardOverlay labels={labels} camera={labelCamera} benchmarkRevision={benchmarkRevision} />
      </div>
    </div>
  )
}
