/** Own device capture by renderer attempt, not by whichever editor is mounted
 * when an asynchronous request happens to finish. Only the adapter request's
 * synchronous construction/poll stack carries context; never an entire await.
 */
interface CaptureState {
  requestAttempt?: number
  nextAttempt: number
  liveAttempts: Set<number>
}
// The installed wrapper and setters must share the same state after Vite HMR.
const freshState = (): CaptureState => ({ nextAttempt: 0, liveAttempts: new Set() })
const state: CaptureState = typeof window === 'undefined' ? freshState()
  : ((window as any).__gurowGpuCaptureState ??= freshState())

export function beginGpuAttempt(): number {
  const attempt = ++state.nextAttempt
  state.liveAttempts.add(attempt)
  return attempt
}

export function retireGpuAttempt(attempt: number | null): void {
  if (attempt !== null) state.liveAttempts.delete(attempt)
}

if (typeof window !== 'undefined') {
  // Called by the Wasm bridge around construction/poll of request_adapter.
  // Restoring the previous value also makes nested synchronous requests safe.
  ;(window as any).__gurowSetGpuAttempt = (attempt?: number) => {
    const previous = state.requestAttempt
    state.requestAttempt = attempt
    return previous
  }
  const gpu = (navigator as any).gpu
  if (gpu && !gpu.__gurowOwnedCapture) {
    const requestAdapter = gpu.requestAdapter
    gpu.requestAdapter = async function (...args: any[]) {
      const attempt = state.requestAttempt
      const adapter = await requestAdapter.apply(this, args)
      // Same-page unrelated WebGPU users must never be captured or scoped.
      if (adapter && attempt !== undefined) {
        const requestDevice = adapter.requestDevice
        adapter.requestDevice = async function (...deviceArgs: any[]) {
          const device = await requestDevice.apply(this, deviceArgs)
          if (!state.liveAttempts.has(attempt)) {
            // Release only this canceled attempt's device, never the current
            // editor's device. Do not emit an adoption event for stale work.
            device.destroy()
          } else {
            window.dispatchEvent(new CustomEvent('gurow:gpu-device-created', { detail: { device, attempt } }))
          }
          return device
        }
      }
      return adapter
    }
    gpu.__gurowOwnedCapture = true
  }
}
