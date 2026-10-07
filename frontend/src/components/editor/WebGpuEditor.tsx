import React, { useRef, useMemo, useEffect, useState } from 'react'
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
import { connectionRejectionMessage, isConnectionRejection } from './connectionRejection'
import { SkillCardOverlay, connectionPointRadius, type ConnectionOverlay, type LabelStatus } from './SkillCardOverlay'
import { cssToLogicalPoint } from './coords'

export interface WebGpuEditorActions {
  createCard: (id: string, title: string, position: Point, size?: Size) => void
  connectSkills: (fromId: string, toId: string) => void
  disconnectSkills: (fromId: string, toId: string) => void
  /** Deletes a card with its connections as one undo step. */
  deleteCard: (id: string) => void
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
  navigation?: React.ReactNode
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
  /** Learning status shown on each card label. */
  labelStatus?: Record<string, LabelStatus>
  /**
   * Navigation only: pan, zoom and select. Card positions and connections stay as
   * loaded (a learner's view of a Coach's shared layout).
   */
  readOnly?: boolean
  /**
   * Positions only: cards can be dragged and the moves undone, but no Skill or
   * connection added or removed (a Coach arranging a published Version's shared layout).
   */
  layoutOnly?: boolean
  /** A card left the document (a deletion, or its redo). */
  onCardDeleted?: (id: string) => void
  /** A deleted card came back (an undo). */
  onCardRestored?: (id: string) => void
  /**
   * A connection dragged from one card's connection point was dropped on another.
   * Apply the same rules as the non-drag action and send the connection; return a
   * message to explain a refusal. Without it, the engine's validation alone decides.
   */
  onConnectionDrop?: (fromId: string, toId: string) => string | null | void
  /** The application's own reason to refuse a connection, so its targets are not highlighted as valid. */
  connectionProblem?: (fromId: string, toId: string) => string | null
}

export const WebGpuEditor: React.FC<WebGpuEditorProps> = ({
  onSelectSkill,
  onConnectionsChange,
  onRejection,
  onActionsReady,
  onCreateSkill,
  navigation,
  initialCards: customInitialCards,
  initialConnections,
  initialCamera,
  onOperationCompleted,
  onCameraChanged,
  onGpuStatusChange,
  labelStatus,
  readOnly = false,
  layoutOnly = false,
  onCardDeleted,
  onCardRestored,
  onConnectionDrop,
  connectionProblem,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // A selection event on pointer-down must not open a modal in the middle of a drag.
  const gesture = useRef<{ x: number; y: number; moved: boolean; open: boolean } | null>(null)
  const latestSelection = useRef<SelectedSkillInfo | null>(null)

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
    selectedIds,
    connections,
    connectionDrag,
    connectionDragRef,
    selectedConnection,
    selectConnection,
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
    deleteCard,
    exportSnapshot,
    setCamera,
    selectCard,
    simulateDeviceLoss,
    recreateRenderer,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
    undo,
    redo,
    zoomIn,
    zoomOut,
    resetZoom,
  } = useWasmEditor({
    canvasRef,
    containerRef,
    onSelectionChanged: (skill) => {
      latestSelection.current = skill
      if (!gesture.current) onSelectSkill(skill)
    },
    initialCards,
    initialConnections,
    initialCamera,
    onOperationCompleted,
    onCameraChanged,
    readOnly,
    layoutOnly,
    onCardDeleted,
    onCardRestored,
    onConnectionDrop,
  })

  // Connections are edited only where Skills are: not in a learner's or a published layout's view.
  const editsConnections = !readOnly && !layoutOnly && gpuStatus === 'ready'
  const [hover, setHover] = useState<{ id: string | null; onPoint: boolean }>({ id: null, onPoint: false })
  /** Which card, and whether its connection point, lies under the pointer; mirrors the engine's hit test for display. */
  const hoverAt = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current
    if (!canvas) return { id: null, onPoint: false }
    const screen = cssToLogicalPoint(clientX, clientY, canvas.getBoundingClientRect())
    const { offset_x, offset_y, zoom: z } = labelCamera
    const wx = (screen.x - offset_x) / z, wy = (screen.y - offset_y) / z
    // Front to back, as the engine resolves a press: a card body hides the points behind it.
    for (let i = labels.length - 1; i >= 0; i--) {
      const { x, y, width, height } = labels[i].world_rect
      const px = (x + width) * z + offset_x, py = (y + height / 2) * z + offset_y
      if (Math.hypot(screen.x - px, screen.y - py) <= connectionPointRadius(width, height, z)) return { id: labels[i].card_id, onPoint: true }
      if (wx >= x && wx <= x + width && wy >= y && wy <= y + height) return { id: labels[i].card_id, onPoint: false }
    }
    return { id: null, onPoint: false }
  }
  const drag = useMemo(() => {
    if (!connectionDrag) return null
    const valid = connectionDrag.validTargetIds.filter((id) => !connectionProblem?.(connectionDrag.fromId, id))
    return { fromId: connectionDrag.fromId, validTargetIds: new Set(valid), targetId: connectionDrag.targetId }
    // connectionProblem reads the application's rules at the press; the drag is short.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionDrag])
  const connecting = useMemo<ConnectionOverlay | undefined>(
    () => (editsConnections ? { hoveredId: hover.id, drag } : undefined),
    [editsConnections, hover.id, drag]
  )
  const titleOf = (id: string) => labels.find((label) => label.card_id === id)?.title ?? 'a Skill'
  const deleteSelectedConnection = () => {
    if (selectedConnection) disconnectSkills(selectedConnection.from_id, selectedConnection.to_id)
  }

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
      deleteCard,
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
    deleteCard,
    exportSnapshot,
    setCamera,
    selectCard,
    recreateRenderer,
    simulateDeviceLoss,
    onActionsReady,
  ])

  useEffect(() => {
    const testWindow = window as Window & {
      __GUROW_TESTING__?: boolean
      __GUROW_EDITOR_TEST__?: { simulateDeviceLoss: () => void }
    }
    if (testWindow.__GUROW_TESTING__ !== true && new URLSearchParams(window.location.search).get('editorTest') !== '1') return
    const hook = { simulateDeviceLoss }
    testWindow.__GUROW_EDITOR_TEST__ = hook
    return () => {
      if (testWindow.__GUROW_EDITOR_TEST__ === hook) delete testWindow.__GUROW_EDITOR_TEST__
    }
  }, [simulateDeviceLoss])

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
        onCreateSkill={readOnly || layoutOnly ? undefined : onCreateSkill}
        navigation={navigation}
        readOnly={readOnly}
        layoutOnly={layoutOnly}
      />

      {/* Engine Error Toast Banner */}
      {engineError && (
        <div id="editor-error-toast" role="alert" className="absolute top-14 left-4 right-4 z-40 bg-red-950/90 border border-red-800/80 text-red-200 px-4 py-2 rounded-xl text-xs flex items-center justify-between shadow-lg">
          <span>{engineError === connectionRejection || isConnectionRejection(engineError)
            ? connectionRejectionMessage(engineError, labels.map((label) => ({ id: label.card_id, title: label.title })))
            : engineError}</span>
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
            className="absolute inset-0 z-30 flex flex-col items-center overflow-y-auto p-4 md:p-8 text-center bg-slate-950/95"
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
                <strong>Canvas Availability:</strong> {readOnly || layoutOnly
                  ? 'The canvas needs WebGPU. You can continue navigating all Skills, their Prerequisites and Tasks via the keyboard-accessible list.'
                  : 'Card positioning remains a canvas operation requiring WebGPU. You can continue navigating all Skills and editing associated Tasks via the keyboard-accessible list.'}
              </div>
              <WebGpuEnableHint />
            </div>
          </div>
        )}

        {/* Notice when WebGPU renderer encounters an error / device loss */}
        {gpuStatus === 'error' && (
          <div
            id="editor-gpu-error-notice"
            className="absolute inset-0 z-30 flex flex-col items-center overflow-y-auto p-4 md:p-8 text-center bg-slate-950/95 backdrop-blur-sm"
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
          data-read-only={readOnly}
          data-layout-only={layoutOnly}
          ref={canvasRef}
          tabIndex={0}
          aria-label="Learning Path canvas. Use Skill list to browse with the keyboard."
          data-hover-connection-point={hover.onPoint ? 'true' : 'false'}
          onPointerDown={(event) => {
            gesture.current = { x: event.clientX, y: event.clientY, moved: false, open: event.button === 0 && !event.shiftKey }
            handlePointerDown(event)
            // A press on a connection point starts a connection, never opens the Skill.
            if (connectionDragRef.current) gesture.current.open = false
          }}
          onPointerMove={(event) => {
            const current = gesture.current
            if (current && Math.hypot(event.clientX - current.x, event.clientY - current.y) > 3) current.moved = true
            if (!current && editsConnections) {
              const next = hoverAt(event.clientX, event.clientY)
              if (next.id !== hover.id || next.onPoint !== hover.onPoint) setHover(next)
            }
            handlePointerMove(event)
          }}
          onPointerLeave={() => { if (!gesture.current && hover.id) setHover({ id: null, onPoint: false }) }}
          onKeyDown={(event) => {
            if (!selectedConnection) return
            if (event.key === 'Escape') {
              event.preventDefault()
              selectConnection(null)
            } else if (editsConnections && (event.key === 'Delete' || event.key === 'Backspace')) {
              event.preventDefault()
              deleteSelectedConnection()
            }
          }}
          onPointerUp={(event) => {
            const current = gesture.current
            handlePointerUp(event)
            gesture.current = null
            if (current?.open && !current.moved) onSelectSkill(latestSelection.current)
          }}
          onPointerCancel={(event) => { handlePointerCancel(event); gesture.current = null }}
          className={`absolute inset-0 w-full h-full block touch-none ${connectionDrag || hover.onPoint ? 'cursor-crosshair' : 'cursor-pointer'}`}
        />

        {/* A multiselection opens no single Skill; say what a drag will move. */}
        {selectedIds.length > 1 && (
          <div
            id="canvas-selection-count"
            data-count={selectedIds.length}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 pointer-events-none text-[11px] text-blue-100 bg-blue-950/80 border border-blue-800/70 px-2.5 py-1 rounded-lg shadow"
          >
            {selectedIds.length} Skills selected{readOnly ? '' : ' · drag one to move them together'}
          </div>
        )}

        {connectionDrag && (
          <div
            id="connection-drag-hint"
            role="status"
            className="absolute top-3 left-1/2 -translate-x-1/2 z-20 pointer-events-none text-[11px] text-emerald-100 bg-emerald-950/85 border border-emerald-800/70 px-2.5 py-1 rounded-lg shadow"
          >
            Drop on a highlighted Skill to make “{titleOf(connectionDrag.fromId)}” its prerequisite · Esc cancels
          </div>
        )}

        {/* The selected connection, with its deletion where connections are editable. */}
        {selectedConnection && (
          <div
            id="selected-connection-bar"
            data-from-id={selectedConnection.from_id}
            data-to-id={selectedConnection.to_id}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 text-[11px] text-amber-100 bg-slate-900/95 border border-amber-700/70 px-3 py-1.5 rounded-lg shadow"
          >
            <span id="selected-connection-label">
              Prerequisite: “{titleOf(selectedConnection.from_id)}” → “{titleOf(selectedConnection.to_id)}”
            </span>
            {editsConnections && (
              <button
                id="btn-delete-connection"
                onClick={deleteSelectedConnection}
                className="rounded border border-red-700/70 bg-red-950/60 px-2 py-0.5 text-red-200 hover:bg-red-900/70"
              >
                Delete connection
              </button>
            )}
            <button
              id="btn-deselect-connection"
              aria-label="Deselect connection"
              onClick={() => selectConnection(null)}
              className="text-slate-400 hover:text-slate-200 px-1"
            >
              ✕
            </button>
          </div>
        )}

        {/* HTML Labels Overlay: positioned from engine output */}
        <SkillCardOverlay labels={labels} camera={labelCamera} benchmarkRevision={benchmarkRevision} status={labelStatus} connecting={connecting} />
      </div>
    </div>
  )
}
