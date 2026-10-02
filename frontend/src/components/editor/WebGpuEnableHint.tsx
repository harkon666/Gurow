/** Browser guidance shared by unsupported and failed WebGPU initialization. */
export function WebGpuEnableHint() {
  return (
    <div
      id="canvas-enable-webgpu-hint"
      className="text-[11px] text-slate-400 mt-3 bg-slate-950/60 p-2.5 rounded-xl border border-slate-800 text-left leading-relaxed"
    >
      <strong className="text-slate-300">WebGPU unavailable:</strong> use a browser with WebGPU
      support and check that hardware acceleration is enabled. In Chromium, inspect{' '}
      <code className="text-emerald-300">chrome://gpu</code> for GPU status and diagnostics.
      On Linux/NVIDIA, native Wayland may fail to render even when WebGPU is available;
      use the documented Chromium XWayland configuration. The Skill list and Tasks remain usable.
    </div>
  )
}
