# P1/T03 Smoke Test Validation Report

- **Date**: 2026-09-10T03:37:11.353Z
- **Git Commit**: `14c1da1e61b02c3e3ee1c65f47a24d98420f47f1`
- **Source tree**: `18504b3d12af7846fa95f3a1cb474b0636362efa` (clean before build and before publishing evidence)
- **Stage**: P1 (Prototype vertical slice)
- **Ticket**: [P1/T03 / #4](https://github.com/harkon666/Gurow/issues/4)
- **Ticket Status**: **PASSED**
- **Overall P1 Stage Status**: **IN PROGRESS** (T04–T06 remaining)

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
cargo test --manifest-path editor/Cargo.toml --package engine-core

# 2. Run TypeScript typecheck & SDD schema tests
cd frontend
bun run typecheck
bun test

# 3. Build WebAssembly module and frontend bundle
bun run build

# 4. Execute automated WebGPU browser smoke check
bun run smoke-check:t03
```

## Test Layers Executed

1. **Layer 1: Native Rust unit tests** (`cargo test`)
   - CanvasDocument encapsulates graph invariants and connection validation
   - Valid prerequisite connection creation and graph integrity
   - Immediate self-cycle rejection (`A → A`)
   - 2-node cycle rejection (`A → B`, then `B → A`)
   - Multi-node cycle rejection with path explanation (`A → B → C → D`, then `D → A`)
   - Convergent and divergent branching support
   - Non-existent card and duplicate connection protection
   - Disconnection handling
   - Command and event serde roundtrip
2. **Layer 2: TypeScript Protocol Schemas & Invariant Tests** (`bun run typecheck`, `bun test`)
   - Matt Pocock Schema-Driven Development (SDD) Zod validation for `ConnectSkills` and `DisconnectSkills`
   - Boundary validation for `ConnectionCreated`, `ConnectionDeleted`, `ConnectionRejected`, and `ConnectionsUpdated`
   - Single engine authority verification (React holds no duplicate mutable graph)
3. **Layer 3: Browser WebGPU integration test** (`bun run smoke-check:t03`)
   - WebGPU canvas initialization and active drawing
   - Connecting Skill cards via UI and observing WebGPU Bezier connection curve rendering
   - WebGPU curve pixels measured outside all card bounds, with HTML overlay hidden; no-edge negative control must contain zero blue pixels
   - Branching prerequisites verified in UI and engine
   - Cycle-creating edit rejected immediately with user-friendly application feedback
   - Deep equality check verifying 100% of connections and card identities remain unchanged after rejected edit
   - Card-switch regression clicks the connection button and verifies the exact new edge and unchanged unrelated graph data
   - Disconnection action removes edge cleanly

## Recorded Environment

| Parameter | Recorded Value |
|---|---|
| Git Commit SHA | `14c1da1e61b02c3e3ee1c65f47a24d98420f47f1` |
| Viewport | 1280 × 800 CSS px |
| OS & Kernel | `Linux 6.19.9-arch1-1 x86_64` |
| Browser | `Chromium 146.0.7680.164 Arch Linux` |
| Chromium Path | `/usr/bin/chromium` |
| Host GPU Hardware | `00:02.0 VGA compatible controller: Intel Corporation Alder Lake-S [UHD Graphics] (rev 0c)
01:00.0 VGA compatible controller: NVIDIA Corporation AD107M [GeForce RTX 4050 Max-Q / Mobile] (rev a1)` |

## Acceptance Criteria Verification (Verified in T03)

1. **Directed Prerequisite Rendering**: User connected two Skills (`Rust Fundamentals` → `WebGPU Pipeline`) and observed the directed Bezier connection line rendered between cards on the WebGPU canvas, verified via pixel assertion on isolated canvas (470 blue pixels outside cards; no-edge control: 0).
2. **Branching & Multiple Prerequisites**: Convergent branching (`Rust Fundamentals` and `WebGPU Pipeline` both feeding `Ownership & Borrowing`) and divergent branching verified.
3. **Immediate Cycle Rejection & Graph Preservation**: Cycle creation attempt (`Ownership & Borrowing` → `Rust Fundamentals`) was rejected immediately by the Rust engine with detailed path explanation (`Rust Fundamentals → Ownership & Borrowing → Rust Fundamentals`), leaving all previous connections and card identities 100% intact (deep equality asserted).
4. **Target Sanitization on Card Switch**: Switching to Async & Concurrency after choosing it as a target, then clicking As Dependent, creates exactly Async & Concurrency → Rust Fundamentals.
5. **Single Engine Authority**: Connections are owned and validated strictly within the Rust engine `CanvasDocument`; React maintains zero mutable graph authority.
6. **Full Test Layer Coverage**: Native core unit tests, TypeScript SDD schema tests, and end-to-end headless WebGPU browser checks pass.
