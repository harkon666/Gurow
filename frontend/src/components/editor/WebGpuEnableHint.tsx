/**
 * Explains how to obtain a hardware WebGPU adapter locally.
 *
 * Shown on both failure paths, because the two look different to the code but
 * identical to the person looking at the screen: `unsupported` covers a browser
 * with no WebGPU at all, while `error` covers an adapter that could not be
 * acquired or a device that was lost.
 *
 * The advice is specific to a switchable-graphics Linux laptop, where Chromium
 * defaults either return no adapter or silently select SwiftShader.
 */
export function WebGpuEnableHint() {
  return (
    <div
      id="canvas-enable-webgpu-hint"
      className="text-[11px] text-slate-400 mt-3 bg-slate-950/60 p-2.5 rounded-xl border border-slate-800 text-left leading-relaxed"
    >
      <strong className="text-slate-300">Enabling WebGPU locally:</strong> on a Linux laptop with
      switchable graphics, Chromium needs both a Vulkan backend and discrete GPU offload. Run{' '}
      <code className="text-emerald-300">bun run dev:webgpu</code> from{' '}
      <code className="text-emerald-300">frontend/</code> to launch a correctly configured browser.
      Enabling only <code>chrome://flags/#enable-unsafe-webgpu</code> selects the SwiftShader
      software renderer, which runs but is not hardware accelerated.
    </div>
  )
}
