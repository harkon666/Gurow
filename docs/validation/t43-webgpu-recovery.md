# T06-L3-09 / GitHub #43 — WebGPU failure recovery and Linux surface diagnosis

Issue: https://github.com/harkon666/Gurow/issues/43. Review baseline: `999538a42c629d04489910cb48d5aaefecc3e812`. Diagnostic date: 2026-10-02. This report does **not** qualify P1 performance; the `gurow-p1-v4` protocol, workloads, thresholds, latency endpoint, and measurement rules are unchanged.

## Observed failure and cause boundary

On the reference host (Hyprland 0.56.2 / Wayland, NVIDIA GeForce RTX 4050 Laptop GPU, NVIDIA 610.57.04, Chromium 152.0.7977.82), native Wayland with `--enable-features=Vulkan --use-gl=angle --ozone-platform=wayland` selects WebGPU adapter vendor `nvidia`, architecture `lovelace`. The app's canvas is configured with `rgba8unorm`, `opaque`, and usage `16` (`RENDER_ATTACHMENT`).

The first failure is not an editor pipeline or shader error:

```text
Requested allocation size (1024000) is smaller than the image requires (1228800).
    at ImportMemory (../../third_party/dawn/src/dawn/native/vulkan/external_memory/MemoryServiceImplementationOpaqueFD.cpp:132)
```

It cascades through `[Invalid Texture].CreateView`, invalid `BeginRenderPass`, and invalid `Queue.Submit`. The old application still displays `WebGPU Rust Editor` and HTML labels because `get_current_texture()` returns an invalid texture through its successful result; asynchronous validation errors only warn to the console.

A minimal JavaScript WebGPU canvas (300×200, preferred format, render-attachment-only usage, opaque alpha, one clear pass), with **no Rust/wgpu, editor shaders, geometry, or buffers**, fails in the same Dawn memory-import routine:

```text
Requested allocation size (286720) is smaller than the image requires (311296).
```

This independently isolates the failing boundary to Chromium/Dawn's external-memory Vulkan canvas interop on this browser/driver/compositor combination, rather than the editor's Rust surface/pipeline implementation. The current [upstream Dawn implementation](https://raw.githubusercontent.com/google/dawn/main/src/dawn/native/vulkan/external_memory/MemoryServiceImplementationOpaqueFD.cpp) calls `GetImageMemoryRequirements` and rejects imports when `requirements.size > importParams.allocationSize`, matching the recorded error. That upstream source is explanatory, not a claim that its `main` revision exactly matches Chromium 152. We do not identify whether the originating allocation mismatch is specifically a Chromium allocator bug or a NVIDIA driver bug; that requires upstream investigation. No wgpu/Chromium/driver patch was made.

GPU memory at diagnosis was 6,141 MiB total, 3 MiB used, 5,797 MiB free (as reported by `nvidia-smi`); this is not evidence of a memory-capacity limit. An initial X11 **GL** trial produced out-of-memory/device-loss and repeated recovery; it is not the supported ANGLE-on-Vulkan configuration and is not presented as success.

## Controlled configuration trials

All captures used the existing application production route and a headed hardware browser, not a headless substitute. The diagnostic script does not hide HTML labels or replace the app renderer. Its subsequent raw-canvas probe is a separate minimization, not benchmark instrumentation.

| Configuration | GPU evidence | Compositor evidence | Conclusion |
| --- | --- | --- | --- |
| Native Wayland, Vulkan + ANGLE GL, current app surface | Undersized opaque-FD import; invalid texture/render pass/submit | No shader clear/card pixels | Unsupported on this host |
| Same, `alphaMode: premultiplied` | Same undersized import | No shader clear/card pixels | Alpha change does not fix it |
| Same, `bgra8unorm` surface | Same undersized import; additional expected app pipeline-format mismatch | No shader clear/card pixels | Format change does not fix the import; not a proposed app patch |
| XWayland, ANGLE-on-Vulkan | App uncaptured errors empty; minimal raw clear's validation scope null/errors empty | Clear color and card fill/borders present | Supported tested configuration |
| Native Wayland, ANGLE-on-Vulkan | App/raw WebGPU errors empty | Whole browser not presented normally; no shader clear/card pixels | Unsupported, despite lack of GPU validation errors |

The BGRA trial overrides `GPUCanvasContext.configure` in the diagnostic browser only; the existing RGBA render pipeline was not rewritten to BGRA, so its additional format-mismatch error must not be confused with the original external-memory-import error. There is no source surface-configuration change. Default `rgba8unorm` was already tested; usage was already the minimal `RENDER_ATTACHMENT`. The bare-canvas reproduction rules out connection buffers, card shader logic, HTML overlays, and app document size as the cause of the original import failure.

## Supported launch configuration and limitations

On this host the tested supported path is:

```bash
chromium \
  --enable-unsafe-webgpu \
  --enable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE \
  --use-angle=vulkan \
  --ozone-platform=x11 \
  http://localhost:3000
```

Use a separate browser profile so an existing Chromium process does not absorb and ignore new process flags. The diagnostic automation also uses `--no-sandbox` and `--disable-dev-shm-usage`; disabling the sandbox is an automation setting, **not** a recommendation for normal browsing. `GDK_SCALE=1` was used for the XWayland child process; record actual DPR when performing later P1 runs.

Native Wayland is **not claimed supported** for this reference environment. App code cannot reliably detect a compositor that silently fails to present the entire browser while WebGPU reports success, as observed with native ANGLE-on-Vulkan. The recovery fix covers actual WebGPU device/validation failures; it does not promise to detect compositor-only blankness. List navigation is the recovery route when the UI itself is presented; a browser whose entire window fails to present must be restarted in the supported configuration.

## Evidence and reproduction

Reproduction (production build required, compositor/browser available):

```bash
cd frontend
bun run scripts/wayland-gpu-diagnostic.ts wayland-default wayland-bgra wayland-premultiplied xwayland-vulkan wayland-vulkan
```

The script launches one browser variant at a time, captures actual surface configs, adapter identity, uncaptured/scoped errors, status/labels, flags, build hash, CDP screenshot and **browser-window-only** `grim` compositor screenshot. It does not change desktop configuration. An F11 key is sent before capture, but fullscreen was not established by the window manager; the recorded window/canvas bounds are authoritative. These small diagnostic windows do not satisfy the primary P1 workload/viewport contract and were not used to claim performance.

Historical baseline JSON has incomplete launch-flag provenance: Puppeteer mutated the caller's `args` array while merging `--enable-features`, so that flag is missing from its recorded `flags`. The configurations above describe the diagnostic launch code, not reconstructed historical process arguments. Those historical JSON files are retained unchanged. The final recapture preserves requested flags using a copied array, records actual Chromium child-process arguments, and asserts that all requested features are present; use final metadata for complete launch provenance. `sourceCommit` records uncommitted HEAD, not a final release commit; `buildHash` identifies the production output and the harness input fingerprint identifies the working-tree source.

Baseline artifacts are under `.harness/t43/platform/` and `.harness/t43/platform-fullscreen/`. A retained summary is [t43-platform-baseline.json](t43-platform-baseline.json); compositor screenshots are [supported XWayland](artifacts/t43-xwayland-vulkan.png), [native Wayland before the fix](artifacts/t43-native-wayland-baseline.png), and [native Wayland with ANGLE Vulkan](artifacts/t43-native-wayland-vulkan.png). The latter's window screenshots are 931×1125 physical pixels. Exact pixel counts obtained with Pillow (not inferred from CDP):

| Screenshot | Clear `(18,20,28)` | Card border `(61,71,97)` | Card fill `(27,35,47)` |
| --- | ---: | ---: | ---: |
| `wayland-default-screen.png` | 0 | 0 | 0 |
| `xwayland-vulkan-screen.png` | 280752 | 924 | 26727 |
| `wayland-vulkan-screen.png` | 0 | 0 | 0 |

These values correspond to `pipeline.rs` clear color and `shader.wgsl` card colors; they provide a reproducible geometry check beyond the presence of HTML labels. Screenshot image-inspection App discovery was unavailable (MCode host authentication required); no image-model inspection is claimed. Pixel computation and captured raw errors are the checks performed.

## Recovery and regression checks

`WasmEditor.report_renderer_error` emits a serialized `EditorEvent::GpuError` and discards only the failed renderer, not CPU document/selection/history. The React browser adapter observes real uncaptured validation/device errors as well as device loss, deduplicates device capture, retires listeners/identities/allocations, and uses error scopes for initial creation and renderer attachment. It does not add scopes, readbacks, or queue-completion waits to normal command rendering or benchmark timing. A failed replacement cannot keep recreating itself; explicit retry remains available. A healthy renderer processing fresh user input rearms one automatic recovery attempt.

Independent review additionally reproduced an ownership race: a genuine delayed `requestDevice` completion from an unmounted editor could destroy and replace the healthy remounted editor's device. The fix passes an optional attempt identity through the Wasm factories and scopes it around actual adapter-request construction and synchronous future polls, restoring context before any await. The adapter's device-request closure retains this identity across asynchronous completion. Only the current live attempt can adopt a device; canceled attempts destroy only their own returned device and unrelated same-page WebGPU requests are not observed. The global diagnostic device reference is not the ownership authority.

`bun run scripts/gpu-error-check.ts --ownership-only` reproduced the failure before this correction (`gpu-ownership-red.log`: healthy replacement destroyed) and passes afterward (`gpu-ownership-green.log`). Both release timings are covered: after replacement readiness and while replacement setup remains pending. Each also checks unrelated-device isolation and genuine device-loss recovery afterward. These scenarios run automatically in the integrated T43 harness entrypoint; the integrated correction log is `.harness/t43/gpu-error-ownership-green.log`. Initial review passes were superseded by the confirmed race; final independent reviews must use the corrected inputs.

The browser regression forces a real invalid `MapRead|Storage` buffer usage, waits for the browser's actual uncaptured error, and supplies a destroyed current canvas texture to make the next renderer attachment fail. A test-only `queue.onSubmittedWorkDone` ensures delivery of the injected error without another application input; this wait is absent from production code. It asserts the serialized `GpuError`, bounded automatic/explicit retries, never-ready initial invalid texture, CPU positions/connections and undo/redo retention, keyboard selection, fixture draft retention, successful later retry, and bounded replacement after real device destruction. Retired devices are destroyed: the stale-activity assertion proves isolation, not delivery of another uncaptured error from an already-destroyed device.

```bash
cd frontend
# Expected RED: replay the pinned pre-fix hook without reverting source files.
GPU_ERROR_BASELINE=999538a42c629d04489910cb48d5aaefecc3e812 bun run scripts/gpu-error-check.ts
# Expected GREEN: current hook and real Wasm bridge.
bun run scripts/gpu-error-check.ts
cd ..
python3 scripts/harness.py check
python3 scripts/harness.py review
```

Recorded red log `.harness/t43/gpu-error-red.log` shows genuine WebGPU validation followed by a 5-second timeout for `#editor-gpu-error-notice` (exit 1). Green log `.harness/t43/gpu-error-green.log` records all three validation/device-loss/initial-texture scenarios passing (exit 0). Baseline replay changes only the old hook, not the entire historical build, and therefore establishes the missing browser-to-recovery behavior rather than claiming a full historical release checkout. The draft assertion uses fixture-owned React state; production Task/persistence coverage remains in the existing T05 browser check.

The final capture was refreshed after the ownership correction under `.harness/t43/platform-reviewed/`, with preserved requested flags and actual launch arguments. Both retained screenshots are 931×1125 physical pixels. Final XWayland pixel counts are 280,752 clear, 924 border, and 26,727 fill; final native recovery has zero of each. These are functional/compositor checks, not benchmark measurements.

The final rebuilt **production application** was also driven on the hardware reference host: see [t43-platform-final.json](t43-platform-final.json), [native failure/retry screenshot](artifacts/t43-native-wayland-recovery.png), and [supported final XWayland screenshot](artifacts/t43-xwayland-final.png). Native Wayland reports `Renderer Failure / Device Lost`, the actual undersized-allocation error, `Recovery Failed`, and `Retry Renderer Recreation`, rather than silently accepting its invalid surface. Keyboard Home/End selects `skill-rust-basics` then `skill-concurrency` and opens associated Tasks. An explicit retry fails on the same platform error but retains four labels, selection, and an enabled retry button. This is a real production-route check, complementary to the focused fixture.

The visible guidance says: “On Linux/NVIDIA, native Wayland may fail to render even when WebGPU is available; use the documented Chromium XWayland configuration. The Skill list and Tasks remain usable.” The page additionally reports the actual renderer/recovery failure; the guidance does not replace or suppress it. During final native startup, the diagnosis's **uncaptured** error array is empty because setup errors are captured by the new scope and displayed in the failure notice; this must not be mistaken for an error-free native renderer. The separate blank-origin raw WebGPU probe still reports the same Dawn validation error without any app hooks or Wasm loaded. Final XWayland has no app GPU error notice, no uncaptured errors, and no raw scoped errors.

The full harness covers Python harness tests, frontend typecheck/unit tests, Rust tests, production build, benchmark collector tests, T04 browser checks, T05 production recovery/persistence checks, lifecycle checks, and the new T43 regression. Current command results and input hash live in `.harness/full.json`; `python3 scripts/harness.py status` must report current PASS with zero AC gaps before review. Independent Standards and Spec review outcomes are retained in `.harness/t43/` with the handoff packet. No P1 measurement PASS or native-Wayland support is implied by these functional checks.
