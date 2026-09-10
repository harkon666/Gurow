# P1/T01 Smoke Test Validation Report

- **Date**: 2026-09-10T02:28:28.868Z
- **Git Commit**: `16f60f550264bab571d7956615a3a1d09c5a629c`
- **Source tree**: `9bbc4d5a291ac63ee2cd7c56eaa91f50f84adbeb` (clean before build and before publishing evidence)
- **Stage**: P1 (Prototype vertical slice)
- **Ticket**: [P1/T01 / #2](https://github.com/harkon666/Gurow/issues/2)
- **Ticket Status**: **PASSED**
- **Overall P1 Stage Status**: **IN PROGRESS** (T02–T06 remaining)

## Build & Run Procedure

### Prerequisites
- **Bun**: v1.3+ (`curl -fsSL https://bun.sh/install | bash`)
- **Rust & Cargo**: with `wasm32-unknown-unknown` target (`rustup target add wasm32-unknown-unknown`)
- **wasm-pack**: installed via cargo or invoked through bunx
- **Chromium**: Chromium or Google Chrome binary in `PATH` or pointed to by `PUPPETEER_EXECUTABLE_PATH`
- **Python 3 with Pillow**: required for pixel inspection (`pip install Pillow`)

### Commands
```bash
# 1. Run native Rust engine tests
cargo test --manifest-path editor/Cargo.toml

# 2. Run TypeScript typecheck & SDD schema tests
cd frontend
bun run typecheck
bun test

# 3. Build WebAssembly module and frontend bundle
bun run build

# 4. Execute automated WebGPU browser smoke check
bun run smoke-check
```

## Test Layers Executed

1. **Layer 1: Native Rust unit tests** (`cargo test`)
   - Document and card creation invariants
   - World ↔ screen coordinate roundtrips
   - Hit testing and selection logic with `SelectionChange` struct
   - JSON protocol command/event serialization for all variants including `GpuError`
   - Card query with selection status (`cards_with_selection`)
2. **Layer 2: TypeScript Protocol Schemas & Invariant Tests** (`bun run typecheck`, `bun test`)
   - Matt Pocock Schema-Driven Development (SDD) Zod validation for commands and events
   - Wire-format roundtrip verification for commands and events
   - Coordinate transformations between logical CSS pixels and canvas buffer
   - Single selection authority invariants without React position store
3. **Layer 3: Browser WebGPU integration test** (`bun run smoke-check`)
   - Headless Chromium WebGPU initialization and dynamic canvas pixel verification
   - Initial Learning Path fixture loaded into Rust engine and HTML label overlays rendered
   - Canvas hit-testing on multiple cards updating React detail panel with authoritative ID and Title
   - Glossary alignment verified: non-required tasks verified labeled as "Enrichment Task" per `CONTEXT.md`

## Recorded Environment

| Parameter | Recorded Value |
|---|---|
| Git Commit SHA | `16f60f550264bab571d7956615a3a1d09c5a629c` |
| Viewport | 1280 × 800 CSS px; primary DPR 1; additional DPR 1.5 and 2 |
| OS & Kernel | `Linux 6.19.9-arch1-1 x86_64` |
| Browser | `Chromium 146.0.7680.164 Arch Linux` |
| Chromium Path | `/usr/bin/chromium` |
| Host GPU Hardware | `00:02.0 VGA compatible controller: Intel Corporation Alder Lake-S [UHD Graphics] (rev 0c)
01:00.0 VGA compatible controller: NVIDIA Corporation AD107M [GeForce RTX 4050 Max-Q / Mobile] (rev a1)` |
| WebGPU Adapter Vendor | `google` |
| WebGPU Architecture | `swiftshader` |
| Adapter Classification | **SwiftShader (Software Fallback via ANGLE)** |

> [!NOTE]
> Renderer adapter observed at its actual request: **SwiftShader (Software Fallback via ANGLE)**. Host hardware does not identify the adapter used; this run makes no hardware performance claim.

## Acceptance Evidence (Verified in T01)

1. **WebGPU Initialization & Active Draw**: Canvas initialized with WebGPU and actively drew scene geometry. Pixel inspection verified shader clear color (88.8% of canvas, asserted >= 40.0%) and card quad fills (7.0% of canvas, asserted >= 3.0%), dynamically cropped from canvas bounding rect and supporting both linear and sRGB adapters.
2. **Hit Testing & Selection**: Click events delivered directly to `#editor-canvas` triggered pointer event dispatch to the Rust engine, executing engine-side hit-testing to select `skill-rust-basics` and `skill-wgpu-pipeline`.
3. **DPR and Selection Pixels**: At DPR 1, 1.5, and 2, before and after resizing, backing dimensions match CSS × DPR, label IDs exactly match the fixture, and GPU highlight moves between Skills with HTML overlays hidden.
4. **React Panel Sync**: Panel displayed Skill ID and Title from engine selection events, and Learning Outcome from the React learning fixture; React maintains zero canvas card positions (ADR-0015).
5. **Glossary Term Alignment**: Non-required tasks verified labeled as "Enrichment Task" in the React detail panel per CONTEXT.md.
6. **Typed Protocol Boundary**: Commands and events validated at runtime using Zod schemas per Matt Pocock SDD pattern, with typed `GpuError` handling.

## Planned Checks Remaining for Later P1 Tickets (Not Run in T01)

- **T02**: Pan, zoom around pointer (0.1–4.0x limits), dragging cards with pointer offset preservation, and 1 undo step per drag.
- **T03**: Create prerequisite connections and reject cycle-creating edges.
- **T04**: Edit Task in sidebar as application-owned data and restore complete local scene upon reload.
- **T05**: GPU device loss recovery preserving CPU-side document; fallback list task access.
- **T06**: Performance benchmark on primary workload (1,000 cards, 2,000 connections; p95 frame time <= 20ms, latency <= 50ms).
