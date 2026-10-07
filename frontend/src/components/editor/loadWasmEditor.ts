type EditorWasmModule = typeof import('../../pkg/editor_wasm.js')

let initialization: Promise<EditorWasmModule> | undefined

/** wasm-bindgen caches completed initialization, but not an in-flight call.
 * Share both import and initialization across editors and StrictMode effect replays
 * so no second instance can replace the exports used by live Rust closures.
 */
export function loadWasmEditor(): Promise<EditorWasmModule> {
  initialization ??= (async () => {
    const module = await import('../../pkg/editor_wasm.js')
    await module.default()
    return module
  })().catch(error => {
    initialization = undefined
    throw error
  })
  return initialization
}
