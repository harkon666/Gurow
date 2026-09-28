import { useState, useEffect, useRef, useCallback } from 'react'
import type { WasmEditor } from '../../pkg/editor_wasm'
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
import {
  applyAppDelay,
  beginInput,
  recordDispatch,
  recordLabelUpdate,
} from './benchmarkHooks'

// Install WebGPU device hook to observe real hardware/software device loss (ADR-0017 / Spec 2)
if (typeof window !== 'undefined') {
  const setupDeviceCapture = () => {
    if ('GPUAdapter' in window && (window as any).GPUAdapter?.prototype) {
      const proto = (window as any).GPUAdapter.prototype
      if (!proto.__gurowWrapped) {
        const origRequestDevice = proto.requestDevice
        proto.requestDevice = async function (...args: any[]) {
          const device = await origRequestDevice.apply(this, args)
          window.dispatchEvent(new CustomEvent('gurow:gpu-device-created', { detail: { device } }))
          return device
        }
        proto.__gurowWrapped = true
      }
    }
    if ('navigator' in window && (navigator as any).gpu) {
      const origRequestAdapter = (navigator as any).gpu.requestAdapter
      if (origRequestAdapter && !(navigator as any).gpu.__gurowWrapped) {
        (navigator as any).gpu.requestAdapter = async function (...args: any[]) {
          const adapter = await origRequestAdapter.apply(this, args)
          if (adapter && !adapter.__gurowWrapped) {
            const origReqDevice = adapter.requestDevice
            adapter.requestDevice = async function (...devArgs: any[]) {
              const device = await origReqDevice.apply(this, devArgs)
              window.dispatchEvent(new CustomEvent('gurow:gpu-device-created', { detail: { device } }))
              return device
            }
            adapter.__gurowWrapped = true
          }
          return adapter
        }
        ;(navigator as any).gpu.__gurowWrapped = true
      }
    }
  }
  setupDeviceCapture()
}

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
}: UseWasmEditorOptions) {
  const editorRef = useRef<WasmEditor | null>(null)
  const activeDeviceRef = useRef<any>(null)
  const recoveryInFlightRef = useRef(false)
  const recoverRef = useRef<(() => Promise<boolean>) | null>(null)
  const [isRecovering, setIsRecovering] = useState(false)
  const [labels, setLabels] = useState<LabelLayout[]>([])
  const [connections, setConnections] = useState<PrerequisiteConnection[]>([])
  const [connectionRejection, setConnectionRejection] = useState<string | null>(null)
  const [zoom, setZoom] = useState<number>(1.0)
  const [canUndo, setCanUndo] = useState<boolean>(false)
  const [canRedo, setCanRedo] = useState<boolean>(false)
  const [gpuStatus, setGpuStatus] = useState<GpuStatus>('initializing')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
  const [engineError, setEngineError] = useState<string | null>(null)

  // Listen for created GPUDevices and attach real device.lost handlers (Spec 2)
  useEffect(() => {
    let listening = true
    const handleDeviceCreated = (e: any) => {
      const device = e.detail?.device
      if (!device) return
      activeDeviceRef.current = device
      ;(window as any).__gurowActiveDevice = device

      device.lost?.then((info: any) => {
        if (listening && activeDeviceRef.current === device) {
          activeDeviceRef.current = null
          const reason = info?.reason || 'destroyed'
          const msg = info?.message || `WebGPU device lost (${reason})`
          console.warn('Real WebGPU device lost:', msg)
          if (editorRef.current) {
            editorRef.current.simulate_device_loss()
          }
          setGpuStatus('error')
          setErrorMessage(`WebGPU device lost: ${msg}. Document and tasks preserved.`)
          void recoverRef.current?.()
        }
      })
    }

    window.addEventListener('gurow:gpu-device-created', handleDeviceCreated)
    return () => {
      listening = false
      window.removeEventListener('gurow:gpu-device-created', handleDeviceCreated)
    }
  }, [])

  const onSelectionChangedRef = useRef(onSelectionChanged)
  onSelectionChangedRef.current = onSelectionChanged

  const onOperationCompletedRef = useRef(onOperationCompleted)
  onOperationCompletedRef.current = onOperationCompleted

  const onCameraChangedRef = useRef(onCameraChanged)
  onCameraChangedRef.current = onCameraChanged

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

  const handleEvents = useCallback((events: EditorEvent[]) => {
    for (const event of events) {
      switch (event.type) {
        case 'SelectionChanged':
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
        case 'LabelsUpdated':
          recordLabelUpdate()
          setLabels(event.labels)
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
        case 'CameraChanged':
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
          if (!recoveryInFlightRef.current) {
            editorRef.current?.simulate_device_loss()
            void recoverRef.current?.()
          }
          break
        case 'Error':
          setEngineError(event.message)
          break
        default:
          break
      }
    }
  }, [])

  // Single consolidated command dispatch helper (Matt Pocock SDD)
  const dispatchInternal = useCallback(
    (editor: WasmEditor, cmd: EditorCommand) => {
      applyAppDelay()
      const t0 = performance.now()
      const validatedCmd = EditorCommandSchema.parse(cmd)
      const eventsJson = editor.dispatch_command(JSON.stringify(validatedCmd))
      const parsedEvents = EditorEventsSchema.parse(JSON.parse(eventsJson))
      recordDispatch(cmd.type, performance.now() - t0)
      handleEvents(parsedEvents)
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
        dispatchInternal(editor, cmd)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        setEngineError(message)
      }
    },
    [dispatchInternal]
  )

  // Initialize WebGPU & Wasm
  useEffect(() => {
    let active = true

    async function init() {
      if (typeof window === 'undefined') return

      const wasmModule = await import('../../pkg/editor_wasm.js')
      await wasmModule.default()
      if (!active) return

      if (!('gpu' in navigator) || !(navigator as any).gpu) {
        // Create headless CPU editor state so document and task navigation remain fully functional (AC2)
        const headlessEditor = wasmModule.WasmEditor.create_headless()
        if (!active) {
          headlessEditor.free()
          return
        }
        editorRef.current = headlessEditor

        dispatchInternal(headlessEditor, {
          type: 'LoadDocument',
          document: {
            cards: initialCardsRef.current ?? [],
            connections: initialConnectionsRef.current ?? [],
          },
        })

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

        const editor = await wasmModule.WasmEditor.create(canvas)
        if (!active) {
          editor.free()
          return
        }

        editorRef.current = editor

        // Seed engine with initial or restored document; pure Rust EditorState owns positions (ADR-0015)
        dispatchInternal(editor, {
          type: 'LoadDocument',
          document: {
            cards: initialCardsRef.current ?? [],
            connections: initialConnectionsRef.current ?? [],
          },
        })

        // Configure engine viewport with logical CSS dimensions
        dispatchInternal(editor, {
          type: 'ResizeViewport',
          width: cssWidth,
          height: cssHeight,
        })

        // Restore camera state if provided
        if (initialCameraRef.current) {
          dispatchInternal(editor, {
            type: 'SetCamera',
            offset_x: initialCameraRef.current.offset_x,
            offset_y: initialCameraRef.current.offset_y,
            zoom: initialCameraRef.current.zoom,
          })
        }

        setGpuStatus('ready')
        if (typeof window !== 'undefined') {
          ;(window as unknown as { __gurowEditorReady?: boolean }).__gurowEditorReady = true
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('WebGPU editor initialization failed:', err)
        if (active) {
          // Fallback to headless CPU editor state on WebGPU initialization failure
          try {
            const fallbackEditor = wasmModule.WasmEditor.create_headless()
            editorRef.current = fallbackEditor
            dispatchInternal(fallbackEditor, {
              type: 'LoadDocument',
              document: {
                cards: initialCardsRef.current ?? [],
                connections: initialConnectionsRef.current ?? [],
              },
            })
          } catch {
            // ignore fallback errors
          }
          setGpuStatus('error')
          setErrorMessage(msg)
        }
      }
    }

    init()

    return () => {
      active = false
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
  }, [canvasRef, containerRef, dispatchInternal])

  // The initial document is usually fetched after this component mounts. Load
  // it into the existing engine rather than recreating the engine, so the
  // renderer and history survive and initialisation is never re-entered.
  // Seeded with the mount-time values because the init effect already loads
  // those, so this only fires for data that arrives later.
  const loadedDocumentRef = useRef<{
    cards: typeof initialCards
    connections: typeof initialConnections
  }>({ cards: initialCards, connections: initialConnections })

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return

    const previous = loadedDocumentRef.current
    if (previous.cards === initialCards && previous.connections === initialConnections) {
      return
    }
    loadedDocumentRef.current = { cards: initialCards, connections: initialConnections }

    dispatch({
      type: 'LoadDocument',
      document: {
        cards: initialCards ?? [],
        connections: initialConnections ?? [],
      },
    })

    if (initialCameraRef.current) {
      dispatch({
        type: 'SetCamera',
        offset_x: initialCameraRef.current.offset_x,
        offset_y: initialCameraRef.current.offset_y,
        zoom: initialCameraRef.current.zoom,
      })
    }
  }, [initialCards, initialConnections, gpuStatus, dispatch])

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

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current
      if (!canvas || !editorRef.current) return

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
      })
    },
    [canvasRef, dispatch]
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isPointerDownRef.current) return
      const canvas = canvasRef.current
      if (!canvas || !editorRef.current) return

      beginInput(e, 'drag')
      const rect = canvas.getBoundingClientRect()
      const logicalPt = cssToLogicalPoint(e.clientX, e.clientY, rect)

      dispatch({
        type: 'PointerMove',
        screen_x: logicalPt.x,
        screen_y: logicalPt.y,
      })
    },
    [canvasRef, dispatch]
  )

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isPointerDownRef.current) return
      isPointerDownRef.current = false
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
    [canvasRef, dispatch]
  )

  // Native non-passive wheel listener for cursor-anchored zoom & trackpad pan
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (!editorRef.current) return

      beginInput(e, e.ctrlKey || e.metaKey ? 'zoom' : 'pan')
      const rect = canvas.getBoundingClientRect()
      const logicalPt = cssToLogicalPoint(e.clientX, e.clientY, rect)

      if (e.ctrlKey || e.metaKey) {
        // Cursor-anchored zoom via pinch-to-zoom or Ctrl+wheel
        const factor = Math.exp(-e.deltaY * 0.005)
        dispatch({
          type: 'ZoomAt',
          screen_x: logicalPt.x,
          screen_y: logicalPt.y,
          factor,
        })
      } else {
        // Trackpad 2-finger scroll or wheel pan
        const deltaX = e.shiftKey ? -e.deltaY : -e.deltaX
        const deltaY = e.shiftKey ? 0 : -e.deltaY
        if (Math.abs(deltaX) > 0 || Math.abs(deltaY) > 0) {
          dispatch({
            type: 'PanCamera',
            delta_x: deltaX,
            delta_y: deltaY,
          })
        }
      }
    }

    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [canvasRef, dispatch])

  // Keyboard shortcuts for Undo and Redo
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) {
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

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
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
    setIsRecovering(true)
    setRecoveryError(null)
    try {
      const wasmModule = await import('../../pkg/editor_wasm.js')
      // Asynchronously build renderer without borrowing editor (Spec 1: prevents unsafe aliasing)
      const handle = await wasmModule.create_renderer_handle(canvas)
      if (editorRef.current !== editor) {
        handle.free()
        return false
      }
      // Synchronously attach renderer and redraw current document state (including recovery edits)
      editor.attach_renderer(handle, canvas)

      setGpuStatus('ready')
      setErrorMessage(null)
      setRecoveryError(null)
      setEngineError(null)

      // Sync viewport dimensions after recreation
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
      return true
    } catch (err: unknown) {
      if (editorRef.current !== editor) return false
      const msg = err instanceof Error ? err.message : String(err)
      console.error('Renderer recreation failed:', err)
      setGpuStatus('error')
      setRecoveryError(`Renderer recovery failed: ${msg}`)
      return false
    } finally {
      recoveryInFlightRef.current = false
      if (editorRef.current === editor) setIsRecovering(false)
    }
  }, [canvasRef, containerRef, dispatchInternal])
  recoverRef.current = recreateRenderer

  return {
    labels,
    connections,
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
  }
}
