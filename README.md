# Gurow

Gurow is an interactive learning path editor and progression platform built with Rust, WebAssembly, WebGPU, and React.

## System Architecture

- **Editor Engine (`editor/`)**: Pure Rust core (`engine-core`) owning documents, camera, and selection; `renderer-wgpu` providing high-performance WebGPU rendering; `editor-wasm` exposing command/event protocol to the browser.
- **Frontend (`frontend/`)**: TanStack React Start application with HTML label overlays positioned over WebGPU canvas quads and sidebar domain panels.
- **Backend (`backend/`)**: Bun and Hono learning domain service.

## Prerequisites

To build and run the WebGPU editor and its test suites:

- **Bun** (v1.3+): [https://bun.sh](https://bun.sh)
- **Rust & Cargo** (stable): with target `wasm32-unknown-unknown`
  ```bash
  rustup target add wasm32-unknown-unknown
  ```
- **wasm-pack**: installed via cargo (`cargo install wasm-pack`) or executed via `bunx`
- **Chromium / Google Chrome**: modern browser with WebGPU support
- **Python 3 with Pillow**: required for headless browser pixel verification
  ```bash
  pip install Pillow
  ```

## Development & Testing Workflow

### 1. Engine Unit Tests
Run native Rust unit tests covering coordinate roundtrips, hit testing, selection, and protocol serialization:
```bash
cargo test --manifest-path editor/Cargo.toml
```

### 2. Frontend Protocol & Invariant Tests
Typecheck and test TypeScript protocol schemas (Matt Pocock SDD pattern) and coordinate transformations:
```bash
cd frontend
bun run typecheck
bun test
```

### 3. Build Production Bundle
Compile the Rust/Wasm module and build the frontend:
```bash
cd frontend
bun run build
```

### 4. Automated WebGPU Browser Smoke Check
Execute the headless Chromium browser smoke check verifying real WebGPU rendering, canvas hit testing, and React detail panel integration:
```bash
cd frontend
bun run smoke-check
```
Validation artifacts and reports are saved to `docs/validation/`.

### Agent implementation harness

Use [the harness guide](docs/HARNESS.md) to pin a GitHub ticket, map its acceptance
criteria to tests, run quick/full checks, and prepare an independent review packet.
Run `python3 scripts/harness.py --help` from the repository root.

### T01 scope and evidence

T01 proves card rendering and selection. ADR-0017 remains the required P1/MVP
architecture: the keyboard-accessible Skill/Prerequisite list, Task access when
WebGPU is unavailable, document-preserving renderer recovery, and retry are
scheduled in T05. The current canvas-unavailable notice is temporary and does
not satisfy those requirements. P1 cannot pass until that path is implemented
and validated; no ADR requirement is removed by this delivery sequence.

The smoke check must start from a clean, committed source tree. It builds that
source and records its commit and tree IDs; commit the generated evidence in a
separate follow-up commit. The report's source SHA intentionally identifies the
code tested, rather than the later commit containing the report. The check
verifies DPR 1, 1.5, and 2, exactly one card per fixture Skill, and GPU selection
highlight movement with HTML overlays hidden. Adapter information comes from
the renderer's own adapter. Software WebGPU is valid T01 integration evidence;
it does not establish hardware performance or the T06 latency gate.
