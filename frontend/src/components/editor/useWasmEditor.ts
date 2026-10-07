import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import type { WasmEditor } from '../../pkg/editor_wasm'
import { loadWasmEditor } from './loadWasmEditor'
import {
  EditorCommandSchema,
  EditorEventsSchema,
  type EditorCommand,
  type EditorEvent,
  type LabelLayout,
  type Point,
  type PrerequisiteConnection,
  type Size,
  type SkillCard,
  type CameraState,
} from './protocol'
import type { GpuStatus, SelectedSkillInfo } from './types'
import { getCanvasDpr, toCanvasBufferSize, cssToLogicalPoint } from './coords'
import { WheelCoalescer, wheelCommand } from './wheelCoalescer'
import { PointerMoveCoalescer } from './pointerMoveCoalescer'
import {
  applyAppDelay,
  beginInput,
  getBenchmarkHooks,
  recordBenchmarkFrame,
  recordDispatch,
  recordLabelUpdate,
  recordNoOpInput,
  sealBenchmarkCapture,
  traceStage,
  type LabelRevision,
} from './benchmarkHooks'

import { beginGpuAttempt, retireGpuAttempt } from './gpuDeviceCapture'

/**
 * The camera of a freshly created engine (`Camera::default()` in engine-core).
 * A new engine emits no CameraChanged for it, and emitting one on LoadDocument
 * would persist this default as view state before SetCamera restores the saved
 * camera, so the overlay starts each engine from this value instead.
 */
const ENGINE_INITIAL_CAMERA: CameraState = { offset_x: 0, offset_y: 0, zoom: 1 }

interface UseWasmEditorOptions {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  containerRef: React.RefObject<HTMLDivElement | null>
  onSelectionChanged: (selected: SelectedSkillInfo | null) => void
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
  /** Navigation only (a learner's view of a published Version): pan, zoom and select, no edits. */
  readOnly?: boolean
  /** Positions only (a Coach arranging a published Version): drag, undo and redo, no new cards or connection changes. */
  layoutOnly?: boolean
  /** A card left the document (a deletion, or its redo): the application drops its Skill's content. */
  onCardDeleted?: (id: string) => void
  /** A deleted card came back (an undo): the application brings its Skill's content back. */
  onCardRestored?: (id: string) => void
  /**
   * A connection drag was dropped on a card. The application applies its own rules and
   * sends the same ConnectSkills command as the non-drag action; a returned message
   * explains a refusal. Without it, the drop is sent to the engine directly.
   */
  onConnectionDrop?: (fromId: string, toId: string) => string | null | void
}

/** The connection being dragged, mirrored from engine events for highlighting only. */
export interface ConnectionDrag {
  fromId: string
  validTargetIds: string[]
  targetId: string | null
}

/**
 * Connects React controls to the Rust editor through the JSON command/event
 * protocol and mirrors engine labels, selection, history, and diagnostics.
 *
 * The hook owns browser input listeners and persistence coordination; Rust
 * remains the source of truth for the live Canvas Document and camera.
 */
export function useWasmEditor({
  canvasRef,
  containerRef,
  onSelectionChanged,
  initialCards,
  initialConnections,
  initialCamera,
  onOperationCompleted,
  onCameraChanged,
  readOnly = false,
  layoutOnly = false,
  onCardDeleted,
  onCardRestored,
  onConnectionDrop,
}: UseWasmEditorOptions) {
  const editorRef = useRef<WasmEditor | null>(null)
  const activeDeviceRef = useRef<any>(null)
  const gpuAttemptRef = useRef<number | null>(null)
  const deviceObservationRef = useRef<{
    device: any
    failure: string | null
    checking: boolean
    removeListener: () => void
  } | null>(null)
  const rendererSetupRef = useRef(true)
  // One automatic attempt until a healthy renderer handles fresh user input.
  // A replacement that immediately fails must never start a recreation loop.
  const automaticRecoveryArmedRef = useRef(true)
  const gpuFailureRef = useRef<(message: string) => void>(() => {})
  const recoveryInFlightRef = useRef(false)
  const recoverRef = useRef<(() => Promise<boolean>) | null>(null)
  const [isRecovering, setIsRecovering] = useState(false)
  // Labels and the camera that places them commit together, so one revision
  // covers both whether a dispatch moved cards, the camera, or both.
  const [{ labels, labelCamera, benchmarkRevision }, setLabelState] = useState<{
    labels: LabelLayout[]
    labelCamera: CameraState
    benchmarkRevision?: LabelRevision
  }>({ labels: [], labelCamera: ENGINE_INITIAL_CAMERA })
  // Mirrors the engine's selection for display only; Rust owns it.
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [connections, setConnections] = useState<PrerequisiteConnection[]>([])
  const [connectionRejection, setConnectionRejection] = useState<string | null>(null)
  // Mirrors the engine's connection gesture and selected connection for display only.
  const [connectionDrag, setConnectionDrag] = useState<ConnectionDrag | null>(null)
  const connectionDragRef = useRef<ConnectionDrag | null>(null)
  const [selectedConnection, setSelectedConnection] = useState<PrerequisiteConnection | null>(null)
  const [zoom, setZoom] = useState<number>(1.0)
  const [canUndo, setCanUndo] = useState<boolean>(false)
  const [canRedo, setCanRedo] = useState<boolean>(false)
  const [gpuStatus, setGpuStatus] = useState<GpuStatus>('initializing')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
  const [engineError, setEngineError] = useState<string | null>(null)

  // Wheel events are merged into at most one camera command per animation
  // frame; flushWheelRef is assigned once dispatch exists.
  const flushWheelRef = useRef<() => void>(() => {})
  // Drag pointer moves are merged the same way: the latest position per frame.
  const flushPointerMoveRef = useRef<() => void>(() => {})

  // The driver installs the hooks before navigation. The rAF loop exists only
  // for opt-in benchmark pages, never as an extra production render loop. It
  // flushes pending wheel input first, as the editor's own frame callback
  // would in the same frame, so the frame it records includes that work.
  useEffect(() => {
    const hooks = getBenchmarkHooks()
    if (!hooks) return
    hooks.seal = sealBenchmarkCapture
    let frame = 0
    const tick = (timestamp: number) => {
      // The endpoint is when this callback starts, read before its own work.
      const callbackMs = performance.now()
      flushWheelRef.current()
      flushPointerMoveRef.current()
      recordBenchmarkFrame(timestamp, callbackMs)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [])

  const retireDevice = useCallback(() => {
    const device = activeDeviceRef.current
    retireGpuAttempt(gpuAttemptRef.current)
    gpuAttemptRef.current = null
    deviceObservationRef.current?.removeListener()
    deviceObservationRef.current = null
    if ((window as any).__gurowActiveDevice === device) {
      ;(window as any).__gurowActiveDevice = null
    }
    activeDeviceRef.current = null
    // Release old GPU allocations as well as listeners. Its lost promise is
    // harmless after clearing the observation identity above.
    device?.destroy()
  }, [])

  // Browser errors can arrive after render() returned Ok, with no later input.
  // Scopes cover only creation/attachment, never the timed command/render path.
  useEffect(() => {
    let listening = true
    const handleDeviceCreated = (e: any) => {
      const device = e.detail?.device
      if (!device || e.detail?.attempt !== gpuAttemptRef.current || activeDeviceRef.current === device) return
      // One device per owned attempt. Never retire the active device in response
      // to an arrival event; replacement is initiated by the owner explicitly.
      if (activeDeviceRef.current) { device.destroy(); return }
      activeDeviceRef.current = device
      ;(window as any).__gurowActiveDevice = device
      const fail = (message: string) => {
        if (!listening || deviceObservationRef.current !== observation) return
        observation.failure ??= message
        if (!observation.checking && !rendererSetupRef.current) gpuFailureRef.current(message)
      }
      const uncaptured = (event: any) => {
        fail(`WebGPU ${event.error?.constructor?.name || 'device error'}: ${event.error?.message || 'Unknown GPU error'}`)
      }
      const observation = {
        device, failure: null as string | null, checking: true,
        removeListener: () => device.removeEventListener('uncapturederror', uncaptured),
      }
      deviceObservationRef.current = observation
      device.addEventListener('uncapturederror', uncaptured)
      device.pushErrorScope('out-of-memory')
      device.pushErrorScope('internal')
      device.pushErrorScope('validation')
      device.lost?.then((info: any) => {
        fail(`WebGPU device lost: ${info?.message || info?.reason || 'Unknown reason'}`)
      })
    }
    window.addEventListener('gurow:gpu-device-created', handleDeviceCreated)
    return () => {
      listening = false
      window.removeEventListener('gurow:gpu-device-created', handleDeviceCreated)
      retireDevice()
    }
  }, [retireDevice])

  const checkRendererSetup = useCallback(async () => {
    const observation = deviceObservationRef.current
    if (!observation) throw new Error('WebGPU device was not observed during renderer setup.')
    // Pop all scopes immediately (LIFO), then await their results. This neither
    // waits for queue completion nor reads back pixels.
    const results = await Promise.all([
      observation.device.popErrorScope(), observation.device.popErrorScope(), observation.device.popErrorScope(),
    ])
    observation.checking = false
    if (deviceObservationRef.current !== observation) throw new Error('Renderer device was retired during setup.')
    const failure = observation.failure || results.find(error => error)?.message
    if (failure) throw new Error(failure)
  }, [])

  const onSelectionChangedRef = useRef(onSelectionChanged)
  onSelectionChangedRef.current = onSelectionChanged

  const onOperationCompletedRef = useRef(onOperationCompleted)
  onOperationCompletedRef.current = onOperationCompleted

  const onCameraChangedRef = useRef(onCameraChanged)
  onCameraChangedRef.current = onCameraChanged

  const onCardDeletedRef = useRef(onCardDeleted)
  onCardDeletedRef.current = onCardDeleted
  const onCardRestoredRef = useRef(onCardRestored)
  onCardRestoredRef.current = onCardRestored
  const onConnectionDropRef = useRef(onConnectionDrop)
  onConnectionDropRef.current = onConnectionDrop
  // Set once dispatch exists: a drop is proposed through the same command as the non-drag action.
  const connectDropRef = useRef<(fromId: string, toId: string) => void>(() => {})

  // Kept in sync on every render, like the callback refs above. The initial
  // document usually arrives after this component has already mounted, so a ref
  // frozen at first render would make the engine load an empty document and
  // never recover, leaving the canvas blank with "0 cards".
  const initialCardsRef = useRef(initialCards)
  initialCardsRef.current = initialCards
  const initialConnectionsRef = useRef(initialConnections)
  initialConnectionsRef.current = initialConnections
  const initialCameraRef = useRef(initialCamera)
  initialCameraRef.current = initialCamera

  const handleEvents = useCallback((events: EditorEvent[], appRevision: number | undefined) => {
    let nextLabels: LabelLayout[] | undefined
    let nextCamera: CameraState | undefined
    let drop: { from: string; to: string } | undefined
    const showDrag = (drag: ConnectionDrag | null) => {
      connectionDragRef.current = drag
      setConnectionDrag(drag)
    }
    for (const event of events) {
      switch (event.type) {
        case 'SelectionChanged':
          setSelectedIds(event.selected_ids)
          if (event.selected_id && event.title) {
            onSelectionChangedRef.current({
              id: event.selected_id,
              title: event.title,
            })
          } else {
            onSelectionChangedRef.current(null)
          }
          break
        case 'CardCreated':
          onOperationCompletedRef.current?.()
          break
        // Before the HistoryChanged that follows, so the save it triggers carries the application change too.
        case 'CardDeleted':
          onCardDeletedRef.current?.(event.card_id)
          break
        case 'CardRestored':
          onCardRestoredRef.current?.(event.card_id)
          break
        case 'LabelsUpdated':
          nextLabels = event.labels
          break
        case 'ConnectionsUpdated':
          setConnections(event.connections)
          break
        case 'ConnectionCreated':
        case 'ConnectionDeleted':
          setConnectionRejection(null)
          onOperationCompletedRef.current?.()
          break
        case 'ConnectionRejected':
          setConnectionRejection(event.reason)
          setEngineError(event.reason)
          break
        case 'ConnectionDragStarted':
          showDrag({ fromId: event.from_id, validTargetIds: event.valid_target_ids, targetId: event.from_id })
          break
        case 'ConnectionDragTargetChanged':
          if (connectionDragRef.current) showDrag({ ...connectionDragRef.current, targetId: event.target_id })
          break
        case 'ConnectionDragEnded':
          showDrag(null)
          if (event.dropped_on) drop = { from: event.from_id, to: event.dropped_on }
          break
        case 'ConnectionSelected':
          setSelectedConnection(event.connection)
          break
        case 'CameraChanged':
          nextCamera = { offset_x: event.offset_x, offset_y: event.offset_y, zoom: event.zoom }
          setZoom(event.zoom)
          onCameraChangedRef.current?.({
            offset_x: event.offset_x,
            offset_y: event.offset_y,
            zoom: event.zoom,
          })
          break
        case 'HistoryChanged':
          setCanUndo(event.can_undo)
          setCanRedo(event.can_redo)
          if (event.can_undo || event.can_redo) {
            onOperationCompletedRef.current?.()
          }
          break
        case 'GpuError':
          setGpuStatus('error')
          setErrorMessage(event.message)
          setEngineError(event.message)
          editorRef.current?.simulate_device_loss()
          retireDevice()
          if (!rendererSetupRef.current && !recoveryInFlightRef.current && automaticRecoveryArmedRef.current) {
            automaticRecoveryArmedRef.current = false
            void recoverRef.current?.()
          } else if (!rendererSetupRef.current && !recoveryInFlightRef.current) {
            setRecoveryError('Renderer failed again. Retry when the GPU is available, or continue using the Skill list.')
          }
          break
        case 'Error':
          setEngineError(event.message)
          break
        default:
          break
      }
    }
    if (nextLabels || nextCamera) {
      const benchmarkRevision = recordLabelUpdate(appRevision)
      setLabelState(previous => ({
        labels: nextLabels ?? previous.labels,
        labelCamera: nextCamera ?? previous.labelCamera,
        benchmarkRevision,
      }))
    }
    // After this dispatch's events, so the proposal is its own validated command.
    if (drop) {
      const handler = onConnectionDropRef.current
      if (!handler) connectDropRef.current(drop.from, drop.to)
      else {
        const refusal = handler(drop.from, drop.to)
        if (refusal) setEngineError(refusal)
      }
    }
  }, [retireDevice])

  gpuFailureRef.current = (message: string) => {
    const editor = editorRef.current
    if (!editor) return
    const events = EditorEventsSchema.parse(JSON.parse(editor.report_renderer_error(message)))
    handleEvents(events, undefined)
  }

  // Single consolidated command dispatch helper (Matt Pocock SDD)
  const dispatchInternal = useCallback(
    (editor: WasmEditor, cmd: EditorCommand) => {
      // The injected delay must sit inside the measured interval, so it runs
      // after t0: cpu_work_ms then shows that the injection actually executed.
      const t0 = performance.now()
      applyAppDelay()
      const validatedCmd = EditorCommandSchema.parse(cmd)
      const commandJson = JSON.stringify(validatedCmd)
      const tWasm = performance.now()
      const eventsJson = editor.dispatch_command(commandJson)
      const tParse = performance.now()
      traceStage('wasm-dispatch', tWasm)
      const parsedEvents = EditorEventsSchema.parse(JSON.parse(eventsJson))
      traceStage('events-parse', tParse)
      const appRevision = recordDispatch(cmd.type, performance.now() - t0)
      const tHandle = performance.now()
      handleEvents(parsedEvents, appRevision)
      traceStage('handle-events', tHandle)
      return parsedEvents
    },
    [handleEvents]
  )

  const dispatch = useCallback(
    (cmd: EditorCommand) => {
      const editor = editorRef.current
      if (!editor) {
        return
      }

      try {
        if (!rendererSetupRef.current && !recoveryInFlightRef.current && editor.is_renderer_active()) {
          automaticRecoveryArmedRef.current = true
        }
        dispatchInternal(editor, cmd)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        setEngineError(message)
      }
    },
    [dispatchInternal]
  )

  // Mark only an actual successful application, and include engine identity:
  // a remounted engine has not loaded anything, even with identical props.
  const loadedDocumentRef = useRef<{
    editor: WasmEditor
    cards: typeof initialCards
    connections: typeof initialConnections
  } | null>(null)
  const loadedCameraRef = useRef<{ editor: WasmEditor; camera: typeof initialCamera } | null>(null)

  const applyInitialDocument = useCallback((editor: WasmEditor) => {
    const cards = initialCardsRef.current
    const connections = initialConnectionsRef.current
    const previous = loadedDocumentRef.current
    const changed = previous?.editor !== editor || previous.cards !== cards || previous.connections !== connections
    if (changed) {
      const events = dispatchInternal(editor, {
        type: 'LoadDocument', document: { cards: cards ?? [], connections: connections ?? [] },
      })
      if (events.some(event => event.type === 'Error')) return
      loadedDocumentRef.current = { editor, cards, connections }
    }
    // The camera is the viewer's own navigation, not part of the document (ADR 0016): it is
    // restored on a new engine or when the given camera changes, never because the cards were
    // replaced (LoadDocument keeps the camera), which would undo the viewer's pan and zoom.
    const camera = initialCameraRef.current
    if (camera && (loadedCameraRef.current?.editor !== editor || loadedCameraRef.current.camera !== camera)) {
      const events = dispatchInternal(editor, { type: 'SetCamera', ...camera })
      if (!events.some(event => event.type === 'Error')) loadedCameraRef.current = { editor, camera }
    }
  }, [dispatchInternal])

  const readOnlyRef = useRef(readOnly)
  readOnlyRef.current = readOnly
  const layoutOnlyRef = useRef(layoutOnly)
  layoutOnlyRef.current = layoutOnly

  const initializeEditor = useCallback((editor: WasmEditor) => {
    editorRef.current = editor
    // Before any document or input reaches the engine, so no edit is ever possible in a read-only view.
    if (readOnlyRef.current) dispatchInternal(editor, { type: 'SetReadOnly', read_only: true })
    if (layoutOnlyRef.current) dispatchInternal(editor, { type: 'SetLayoutOnly', layout_only: true })
    // A new engine starts at its default camera; labels must not keep the old one.
    setLabelState(previous => ({ ...previous, labelCamera: ENGINE_INITIAL_CAMERA }))
    // Establish the viewport before restoring camera, in GPU and CPU paths.
    dispatchInternal(editor, {
      type: 'ResizeViewport',
      width: containerRef.current?.clientWidth || 800,
      height: containerRef.current?.clientHeight || 600,
    })
    applyInitialDocument(editor)
  }, [containerRef, dispatchInternal, applyInitialDocument])

  // Initialize WebGPU & Wasm
  useEffect(() => {
    let active = true

    async function init() {
      if (typeof window === 'undefined') return

      const wasmModule = await loadWasmEditor()
      if (!active) return

      if (!('gpu' in navigator) || !(navigator as any).gpu) {
        // Create headless CPU editor state so document and task navigation remain fully functional (AC2)
        const headlessEditor = wasmModule.WasmEditor.create_headless()
        if (!active) {
          headlessEditor.free()
          return
        }
        initializeEditor(headlessEditor)

        setGpuStatus('unsupported')
        setErrorMessage(
          'WebGPU is not supported by your current browser environment. Card positioning remains a canvas operation, but Skills and Tasks remain fully usable via the list.'
        )
        return
      }

      try {
        const canvas = canvasRef.current
        const container = containerRef.current
        if (!canvas || !container) return

        const cssWidth = container.clientWidth || 800
        const cssHeight = container.clientHeight || 600
        const dpr = getCanvasDpr()
        const bufferSize = toCanvasBufferSize(cssWidth, cssHeight, dpr)
        canvas.width = bufferSize.width
        canvas.height = bufferSize.height

        const attempt = beginGpuAttempt()
        gpuAttemptRef.current = attempt
        const editor = await wasmModule.WasmEditor.create(canvas, attempt)
        if (!active) {
          editor.free()
          return
        }

        initializeEditor(editor)
        await checkRendererSetup()
        if (!active) return
        rendererSetupRef.current = false

        setGpuStatus('ready')
        if (typeof window !== 'undefined') {
          ;(window as unknown as { __gurowEditorReady?: boolean }).__gurowEditorReady = true
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('WebGPU editor initialization failed:', err)
        if (active) {
          // If creation completed, retain that same CPU state/history. Otherwise
          // initialize a CPU editor so late document data and the list still work.
          if (!editorRef.current) {
            const fallbackEditor = wasmModule.WasmEditor.create_headless()
            initializeEditor(fallbackEditor)
          }
          gpuFailureRef.current(msg)
          rendererSetupRef.current = false
          automaticRecoveryArmedRef.current = false
          setRecoveryError(`Renderer initialization failed: ${msg}`)
        }
      }
    }

    void init().catch((err: unknown) => {
      if (!active) return
      // A module/CPU startup failure is not merely a renderer failure: without
      // an engine, keep editing disabled rather than reporting a usable fallback.
      setEngineError(`Editor initialization failed: ${err instanceof Error ? err.message : String(err)}`)
    })

    return () => {
      active = false
      retireDevice()
      if (editorRef.current) {
        try {
          editorRef.current.free()
        } catch {
          // ignore cleanup errors
        }
        editorRef.current = null
      }
    }
    // `initialCards` is deliberately NOT a dependency. Re-running this effect
    // tears down an initialisation that may still be in flight, which
    // wasm-bindgen reports as "FnOnce called more than once" and leaves the
    // editor dead with an empty canvas. The document is applied by the effect
    // below instead.
  }, [canvasRef, containerRef, initializeEditor, checkRendererSetup, retireDevice])

  // Late data uses the same application path without recreating the renderer.
  // LoadDocument clears Rust history; skipping already-applied identities is
  // what preserves edits/undo, not LoadDocument itself.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    try {
      applyInitialDocument(editor)
    } catch (err: unknown) {
      setEngineError(err instanceof Error ? err.message : String(err))
    }
  }, [initialCards, initialConnections, initialCamera, gpuStatus, applyInitialDocument])

  // ResizeObserver: keeps canvas buffer and engine logical viewport synchronized
  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const cssWidth = entry.contentRect.width
        const cssHeight = entry.contentRect.height
        const dpr = getCanvasDpr()
        const bufferSize = toCanvasBufferSize(cssWidth, cssHeight, dpr)

        if (bufferSize.width > 0 && bufferSize.height > 0 && editorRef.current) {
          canvas.width = bufferSize.width
          canvas.height = bufferSize.height
          dispatch({
            type: 'ResizeViewport',
            width: cssWidth,
            height: cssHeight,
          })
        }
      }
    })

    observer.observe(container)
    return () => observer.disconnect()
  }, [containerRef, canvasRef, dispatch])

  // Canvas pointer handlers with pointer capture for dragging
  const isPointerDownRef = useRef(false)
  // A fast pointer can report several moves per frame; each would otherwise
  // run a full command and render. Dispatch only the latest one per frame.
  const pointerMoves = useMemo(
    () => new PointerMoveCoalescer(point => dispatch({ type: 'PointerMove', screen_x: point.x, screen_y: point.y })),
    [dispatch]
  )
  const flushPointerMove = useCallback(() => pointerMoves.flush(), [pointerMoves])
  flushPointerMoveRef.current = flushPointerMove
  useEffect(() => () => pointerMoves.dispose(), [pointerMoves])

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current
      if (!canvas || !editorRef.current) return

      // Input merged earlier this frame precedes the press it came before.
      flushWheelRef.current()
      flushPointerMove()
      isPointerDownRef.current = true
      beginInput(e, 'drag')
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        // ignore in test or unsupported environments
      }

      const rect = canvas.getBoundingClientRect()
      const logicalPt = cssToLogicalPoint(e.clientX, e.clientY, rect)

      dispatch({
        type: 'PointerDown',
        screen_x: logicalPt.x,
        screen_y: logicalPt.y,
        shift_key: e.shiftKey,
      })
    },
    [canvasRef, dispatch, flushPointerMove]
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isPointerDownRef.current) return
      const canvas = canvasRef.current
      if (!canvas || !editorRef.current) return

      beginInput(e, 'drag')
      const rect = canvas.getBoundingClientRect()
      pointerMoves.add(cssToLogicalPoint(e.clientX, e.clientY, rect))
    },
    [canvasRef, pointerMoves]
  )

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isPointerDownRef.current) return
      isPointerDownRef.current = false
      flushWheelRef.current()
      // The release lands where the last merged move left the card.
      flushPointerMove()
      const canvas = canvasRef.current
      if (!canvas || !editorRef.current) return

      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        // ignore
      }

      const rect = canvas.getBoundingClientRect()
      const logicalPt = cssToLogicalPoint(e.clientX, e.clientY, rect)

      dispatch({
        type: 'PointerUp',
        screen_x: logicalPt.x,
        screen_y: logicalPt.y,
      })
    },
    [canvasRef, dispatch, flushPointerMove]
  )

  /** A cancelled pointer (lost capture, a system gesture) completes nothing. */
  const handlePointerCancel = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isPointerDownRef.current) return
      isPointerDownRef.current = false
      flushPointerMove()
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        // ignore
      }
      dispatch({ type: 'CancelInteraction' })
    },
    [dispatch, flushPointerMove]
  )

  // Native non-passive wheel listener for cursor-anchored zoom & trackpad pan.
  // The handler only accumulates; one merged camera command per animation frame
  // keeps a fast wheel from queueing a full render per event.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const wheels = new WheelCoalescer()
    let frame = 0
    const flush = () => {
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      const command = wheels.take()
      if (command) dispatch(command)
    }
    flushWheelRef.current = flush

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (!editorRef.current) return

      const rect = canvas.getBoundingClientRect()
      const command = wheelCommand(e, cssToLogicalPoint(e.clientX, e.clientY, rect))
      if (!command) {
        recordNoOpInput(e)
        return
      }
      // Dispatch an unmergeable earlier command before observing this input,
      // so the input is attributed to the command that carries its effect.
      const earlier = wheels.add(command)
      if (earlier) dispatch(earlier)
      beginInput(e, command.type === 'ZoomAt' ? 'zoom' : 'pan')
      frame ||= requestAnimationFrame(flush)
    }

    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      canvas.removeEventListener('wheel', onWheel)
      if (frame) cancelAnimationFrame(frame)
      flushWheelRef.current = () => {}
    }
  }, [canvasRef, dispatch])

  // Keyboard shortcuts for Undo and Redo
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Escape abandons a connection drag wherever focus is.
      if (e.key === 'Escape' && connectionDragRef.current) {
        e.preventDefault()
        e.stopPropagation()
        isPointerDownRef.current = false
        dispatch({ type: 'CancelInteraction' })
        return
      }
      if (readOnlyRef.current || ['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) {
        return
      }

      const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform)
      const modKey = isMac ? e.metaKey : e.ctrlKey

      if (modKey && !e.altKey) {
        if (e.key === 'z' || e.key === 'Z') {
          if (e.shiftKey) {
            e.preventDefault()
            dispatch({ type: 'Redo' })
          } else {
            e.preventDefault()
            dispatch({ type: 'Undo' })
          }
        } else if (e.key === 'y' || e.key === 'Y') {
          e.preventDefault()
          dispatch({ type: 'Redo' })
        }
      }
    }

    // Capture phase: a temporary panel's Escape must not also close it mid-drag.
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [dispatch])

  const undo = useCallback(() => dispatch({ type: 'Undo' }), [dispatch])
  const redo = useCallback(() => dispatch({ type: 'Redo' }), [dispatch])

  const zoomIn = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    dispatch({
      type: 'ZoomAt',
      screen_x: rect.width / 2,
      screen_y: rect.height / 2,
      factor: 1.25,
    })
  }, [canvasRef, dispatch])

  const zoomOut = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    dispatch({
      type: 'ZoomAt',
      screen_x: rect.width / 2,
      screen_y: rect.height / 2,
      factor: 0.8,
    })
  }, [canvasRef, dispatch])

  const resetZoom = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || zoom === 0) return
    const rect = canvas.getBoundingClientRect()
    dispatch({
      type: 'ZoomAt',
      screen_x: rect.width / 2,
      screen_y: rect.height / 2,
      factor: 1.0 / zoom,
    })
  }, [canvasRef, dispatch, zoom])

  const connectSkills = useCallback(
    (fromId: string, toId: string) => {
      dispatch({
        type: 'ConnectSkills',
        from_id: fromId,
        to_id: toId,
      })
    },
    [dispatch]
  )

  const disconnectSkills = useCallback(
    (fromId: string, toId: string) => {
      dispatch({
        type: 'DisconnectSkills',
        from_id: fromId,
        to_id: toId,
      })
    },
    [dispatch]
  )

  connectDropRef.current = connectSkills

  const selectConnection = useCallback(
    (connection: PrerequisiteConnection | null) => dispatch({ type: 'SelectConnection', connection }),
    [dispatch]
  )

  const deleteCard = useCallback((id: string) => dispatch({ type: 'DeleteCard', id }), [dispatch])

  const exportSnapshot = useCallback((): {
    cards: SkillCard[]
    connections: PrerequisiteConnection[]
  } | null => {
    const editor = editorRef.current
    if (!editor) return null

    const events = dispatchInternal(editor, { type: 'ExportSnapshot' })
    const snapshotEvent = events.find((e) => e.type === 'SnapshotExported')
    if (snapshotEvent && snapshotEvent.type === 'SnapshotExported') {
      return snapshotEvent.document
    }
    return null
  }, [dispatchInternal])

  const createCard = useCallback(
    (id: string, title: string, position: Point, size?: Size) => {
      dispatch({
        type: 'CreateCard',
        id,
        title,
        position,
        size,
      })
    },
    [dispatch]
  )

  const setCamera = useCallback(
    (offset_x: number, offset_y: number, zoom: number) => {
      dispatch({
        type: 'SetCamera',
        offset_x,
        offset_y,
        zoom,
      })
    },
    [dispatch]
  )

  const selectCard = useCallback(
    (id: string | null) => {
      dispatch({
        type: 'SelectCard',
        id: id ?? null,
      })
    },
    [dispatch]
  )

  const simulateDeviceLoss = useCallback(() => {
    const device = activeDeviceRef.current || (window as any).__gurowActiveDevice
    if (device && typeof device.destroy === 'function') {
      try {
        device.destroy()
        return
      } catch (err) {
        console.warn('Could not call device.destroy():', err)
      }
    }
    if (editorRef.current) {
      editorRef.current.simulate_device_loss()
    }
    setGpuStatus('error')
    setErrorMessage('Renderer failure simulated (GPU device loss). Document and tasks preserved.')
  }, [])

  const recreateRenderer = useCallback(async (): Promise<boolean> => {
    // Serialize automatic and user-triggered attempts, including rapid clicks.
    if (recoveryInFlightRef.current) return false
    const editor = editorRef.current
    const canvas = canvasRef.current
    if (!editor || !canvas) {
      setRecoveryError('Editor or canvas reference is not available.')
      return false
    }

    recoveryInFlightRef.current = true
    rendererSetupRef.current = true
    automaticRecoveryArmedRef.current = false
    retireDevice()
    editor.simulate_device_loss()
    setIsRecovering(true)
    setRecoveryError(null)
    try {
      const wasmModule = await loadWasmEditor()
      if (editorRef.current !== editor) return false
      // Asynchronously build renderer without borrowing editor (Spec 1: prevents unsafe aliasing)
      const attempt = beginGpuAttempt()
      gpuAttemptRef.current = attempt
      const handle = await wasmModule.create_renderer_handle(canvas, attempt)
      if (editorRef.current !== editor) {
        handle.free()
        return false
      }
      // Synchronously attach renderer and redraw current document state (including recovery edits)
      editor.attach_renderer(handle, canvas)

      // Sync viewport dimensions after recreation, still inside setup scopes.
      const container = containerRef.current
      if (container) {
        const cssWidth = container.clientWidth || 800
        const cssHeight = container.clientHeight || 600
        dispatchInternal(editor, {
          type: 'ResizeViewport',
          width: cssWidth,
          height: cssHeight,
        })
      }
      await checkRendererSetup()
      if (editorRef.current !== editor) return false
      setGpuStatus('ready')
      setErrorMessage(null)
      setRecoveryError(null)
      setEngineError(null)
      return true
    } catch (err: unknown) {
      if (editorRef.current !== editor) return false
      const msg = err instanceof Error ? err.message : String(err)
      console.error('Renderer recreation failed:', err)
      gpuFailureRef.current(msg)
      setRecoveryError(`Renderer recovery failed: ${msg}`)
      return false
    } finally {
      recoveryInFlightRef.current = false
      rendererSetupRef.current = false
      if (editorRef.current === editor) setIsRecovering(false)
    }
  }, [canvasRef, containerRef, dispatchInternal, checkRendererSetup, retireDevice])
  recoverRef.current = recreateRenderer

  return {
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
    clearConnectionRejection: () => setConnectionRejection(null),
    zoom,
    canUndo,
    canRedo,
    gpuStatus,
    errorMessage,
    recoveryError,
    isRecovering,
    clearRecoveryError: () => setRecoveryError(null),
    engineError,
    clearEngineError: () => setEngineError(null),
    dispatch,
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
  }
}
