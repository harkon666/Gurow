import { useState, useEffect, useRef, useCallback } from 'react'
import type { WasmEditor } from '../../pkg/editor_wasm'
import {
  EditorCommandSchema,
  EditorEventsSchema,
  type EditorCommand,
  type EditorEvent,
  type LabelLayout,
  type Point,
  type Size,
} from './protocol'
import type { GpuStatus, SelectedSkillInfo } from './types'
import { getCanvasDpr, toCanvasBufferSize, cssToLogicalPoint } from './coords'

interface UseWasmEditorOptions {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  containerRef: React.RefObject<HTMLDivElement | null>
  onSelectionChanged: (selected: SelectedSkillInfo | null) => void
  initialCards: Array<{
    id: string
    title: string
    position: Point
    size?: Size
  }>
}

export function useWasmEditor({
  canvasRef,
  containerRef,
  onSelectionChanged,
  initialCards,
}: UseWasmEditorOptions) {
  const editorRef = useRef<WasmEditor | null>(null)
  const [labels, setLabels] = useState<LabelLayout[]>([])
  const [gpuStatus, setGpuStatus] = useState<GpuStatus>('initializing')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [engineError, setEngineError] = useState<string | null>(null)

  const onSelectionChangedRef = useRef(onSelectionChanged)
  onSelectionChangedRef.current = onSelectionChanged

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
        case 'LabelsUpdated':
          setLabels(event.labels)
          break
        case 'GpuError':
          setGpuStatus('error')
          setErrorMessage(event.message)
          setEngineError(event.message)
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
      const validatedCmd = EditorCommandSchema.parse(cmd)
      const eventsJson = editor.dispatch_command(JSON.stringify(validatedCmd))
      const parsedEvents = EditorEventsSchema.parse(JSON.parse(eventsJson))
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

      if (!('gpu' in navigator) || !(navigator as any).gpu) {
        setGpuStatus('unsupported')
        setErrorMessage(
          'WebGPU is not supported by your current browser environment.'
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

        const wasmModule = await import('../../pkg/editor_wasm.js')
        await wasmModule.default()

        if (!active) return

        const editor = await wasmModule.WasmEditor.create(canvas)
        if (!active) {
          editor.free()
          return
        }

        editorRef.current = editor

        // Seed engine with initial fixture cards once; pure Rust EditorState owns positions (ADR-0015)
        dispatchInternal(editor, {
          type: 'LoadDocument',
          document: { cards: initialCards },
        })

        // Configure engine viewport with logical CSS dimensions
        dispatchInternal(editor, {
          type: 'ResizeViewport',
          width: cssWidth,
          height: cssHeight,
        })

        setGpuStatus('ready')
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('WebGPU editor initialization failed:', err)
        if (editorRef.current) {
          try {
            editorRef.current.free()
          } catch {
            // ignore cleanup errors
          }
          editorRef.current = null
        }
        if (active) {
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
  }, [canvasRef, containerRef, dispatchInternal, initialCards])

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

  // Canvas pointer down handler
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current
      if (!canvas || !editorRef.current) return

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

  return {
    labels,
    gpuStatus,
    errorMessage,
    engineError,
    clearEngineError: () => setEngineError(null),
    dispatch,
    handlePointerDown,
  }
}
