# T06-L3-09 — Report a WebGPU canvas that silently renders nothing, and make it render on native Wayland

Status: approved execution packet, published as [#43](https://github.com/harkon666/Gurow/issues/43); implementation pending. Parent: [#7](https://github.com/harkon666/Gurow/issues/7). Contract: [gurow-p1-v4](../../benchmarks/p1/contract.md).

Executor recommendation: **Strong model with WebGPU/wgpu experience; independent review**. Blocked by: **none**. Parent coverage: AC1, AC5. User stories: US80, US82.

## Observable outcome

On the reference host (Hyprland/Wayland, NVIDIA RTX 4050, driver 610.57.04, Chromium 152), Chromium on native Wayland with `--enable-features=Vulkan --use-gl=angle` selects the NVIDIA adapter, but every frame logs `[Invalid Texture] … CreateView` → `BeginRenderPass` → invalid `Submit`. The canvas stays black (0,0,0), with only the HTML labels visible. The editor reports no renderer failure, so the user gets neither a picture nor the ADR 0017 recovery path. With `--use-angle=vulkan` on native Wayland the whole window is blank. Only ANGLE-on-Vulkan through XWayland (`--ozone-platform=x11`) draws the canvas (flag trial, 2026-09-30). After this task, a canvas that cannot render is reported through the existing renderer-failure path, and the native-Wayland configuration is either made to render or documented as unsupported with evidence.

## Scope

In the browser, `wgpu::Surface::get_current_texture()` returns `Ok` with an invalid texture, and the WebGPU validation error only reaches the uncaptured-error handler, which logs a console warning. `renderer.render()` therefore succeeds and no `GpuError` event is emitted. Route such failures (uncaptured device errors, or an invalid current texture detected by an error scope) to the existing `GpuError` → recovery/retry → list-navigation path. Investigate why the current texture is invalid on native Wayland (surface configuration, format, alpha mode or usage; Chromium/Dawn limitation) and fix it in the app if possible. Do not change the benchmark contract, and do not suppress real errors.

## Required inputs

- Flag-trial evidence: the grim screenshots and console logs from 2026-09-30 (reproduce them if unavailable), and `frontend/scripts/benchmark/run.ts` headed flags with their comment.
- ADR 0017 (renderer failure preserves the document, reports, offers retry, keeps the list) and the T05 recovery checks.

## Source pointers and file ownership

Verify current source before editing.

- `editor/crates/renderer-wgpu/src/pipeline.rs` — surface configuration and `get_current_texture` handling.
- `editor/crates/editor-wasm/src/lib.rs` — `render_and_serialize_events`, device creation, `GpuError` emission.
- `frontend/src/components/editor/useWasmEditor.ts` — `GpuError` handling and recovery.
- `frontend/scripts/t05-smoke-check.ts`, `frontend/scripts/editor-lifecycle-check.ts` — existing recovery assertions to extend.

## Acceptance criteria

- [ ] A WebGPU validation or device error raised while rendering (including an invalid current texture) produces a `GpuError` and enters the existing recovery path: document preserved, failure reported, retry offered, list navigation usable.
- [ ] A browser test fails on the current behavior by forcing such an error (for example an injected invalid texture or an error scope in a test hook) and passes after the fix; the existing T05 recovery checks still pass.
- [ ] Record the root cause of the invalid texture on native Wayland with evidence; if an application-side surface change fixes it, the canvas visibly renders there (screenshot shows the clear color and card geometry) with no WebGPU console errors.
- [ ] If it is a browser/driver limitation, document the supported configuration (currently XWayland) and the user-visible message; do not claim native Wayland support.
- [ ] Full harness checks pass and an independent Standards/Spec review is requested before handoff.

## Planned verification commands

```bash
python3 scripts/harness.py check
cd frontend && bun run scripts/t05-smoke-check.ts --check-only
```

## Handoff and escalation

The failure-surfacing change with its failing-then-passing browser test, root-cause evidence for native Wayland, and either a visible native-Wayland screenshot or a documented unsupported configuration.

Stop/escalate: The fix needs changes in wgpu or Chromium, or conflicts with ADR 0017's recovery behavior. Report the evidence and request a decision.

Keep one parent T06 harness baseline once implementation starts. Focused worker checks do not replace parent full verification and independent review. Preserve original criteria and source identity.
