# P1/T02 Smoke Test Validation Report

- **Date**: 2026-09-10T03:08:42.223Z
- **Git Commit**: `7c23c16272a698ae9de225f03929da877b2d7e1f`
- **Source tree**: `fd9321421a12528f1d3551cac068fb4245379180`
- **Stage**: P1 (Prototype vertical slice)
- **Ticket**: [P1/T02 / #3](https://github.com/harkon666/Gurow/issues/3)
- **Ticket Status**: **PASSED**
- **Overall P1 Stage Status**: **IN PROGRESS** (T03–T06 remaining)

## Build & Run Procedure

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
bun run smoke-check:t02
```

## Acceptance Evidence (Verified in T02)

1. **Card Dragging with 2-Axis Offset Preservation**:
   - Dragging a card preserves the initial pointer-to-card world offset across both horizontal and vertical axes (dx=+140px, dy=+80px verified at 1.0x; dx=+60px, dy=+40px verified at 128% zoom).
   - Card positions owned strictly by pure Rust `EditorState`.
2. **Actual WebGPU Canvas Visual Pixel Assertions**:
   - Canvas output inspected via Python Pillow with HTML labels overlay hidden to verify pure WebGPU rendering.
   - Initial position: verified card quad at (80, 100) with `100.0%` card pixels.
   - Dragged position: verified card quad moved to (220, 180) with `100.0%` card pixels, and initial position vacated to clear color with `100.0%` clear pixels.
   - Undone position: verified card quad returned to (80, 100) with `100.0%` card pixels, and dragged position cleared with `100.0%` clear pixels.
   - Redone position: verified card quad re-rendered at (220, 180) with `100.0%` card pixels.
3. **One Completed Drag = Exactly One Undo Step**:
   - Verified that dragging generates exactly one undo step on pointer up.
   - Both horizontal and vertical coordinates revert to starting values on Undo, and re-advance on Redo.
4. **Undo During Active Drag (Bug Fix & Regression Guard)**:
   - Verified that triggering Undo while a drag gesture is in flight cancels the active gesture, restores the starting position, and does not corrupt the undo/redo history or allow subsequent pointer release to clobber the document.
5. **Cursor-Anchored Wheel Zoom & 2-Axis Canvas Pan**:
   - Wheel zoom with `ctrlKey` preserves the card-relative point under the cursor on both axes (tested scaling to 128%; errors 0.027px and 0.008px).
   - Label positions asserted during pointer movement for pan and drag at 100% and 128%; no wait for geometry animations.
   - Pan drag exercises horizontal (+50px) and vertical (+20px) camera offsets. Native tests cover zoom/world limits; non-Ctrl wheel-pan and GPU alignment during camera changes are not independently asserted here.
6. **Typed Protocol Boundary (Matt Pocock SDD)**:
   - All commands (`PointerMove`, `PointerUp`, `PanCamera`, `ZoomAt`, `Undo`, `Redo`) and events (`CardMoved`, `CameraChanged`, `HistoryChanged`) validated at runtime via Zod schemas and Rust `serde` structs.
