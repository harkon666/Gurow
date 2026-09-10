# P1/T04 Smoke Test Validation Report

- **Date**: 2026-09-10T05:15:23.425Z
- **Git Commit**: `244d068acd5b2288774bbc9721e78548a79ed912`
- **Source tree**: `20a507fdfd69b823ca342be8c25a38666a958dc8`
- **Stage**: P1 (Prototype vertical slice)
- **Ticket**: [P1/T04 / #5](https://github.com/harkon666/Gurow/issues/5)
- **Ticket Status**: **PASSED**
- **Overall P1 Stage Status**: **IN PROGRESS** (T05–T06 remaining)

## Build & Run Procedure

### Prerequisites
- **Bun**: v1.3+
- **Rust & Cargo**: with `wasm32-unknown-unknown` target
- **wasm-pack**: installed via cargo or invoked through bunx
- **Chromium**: with WebGPU enabled
- **Python 3 with Pillow**: required for verification

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
bun run smoke-check:t04
```

## Acceptance Criteria Verification (Verified in T04)

1. **AC 1: Skill Selection & Task Editing without Engine Contamination**
   - Selecting a Skill card opens the associated Task in the React sidebar.
   - Task editing (title, description, required toggle) updates application-owned state without putting Task contents into the Rust engine snapshot or card boundaries.
2. **AC 2: Coherent Checkpoint Envelope**
   - Local checkpoint carries `version: 1`, `saved_at` timestamp, `editor` snapshot (`format_version: 1`, revision, cards, connections), and separate `application` payload (learning_path_id, skills, tasks).
3. **AC 3: Semantic Restoration & Mismatch Rejection**
   - Reload restores all card IDs, titles and geometry in the HTML overlay, the complete graph, and edited Task title, description, and required flag.
   - Foreign `learning_path_id` checkpoints are rejected fast with `CheckpointMismatchError`.
   - Orphan cards missing from the application payload are rejected fast with `CheckpointMismatchError` and prevented from rendering on the canvas.
   - Guarded shared save function prevents task edits or canvas operations from overwriting rejected checkpoints, preserving corrupted drafts for recovery per ADR-0016.
4. **AC 4: Local Persistence & Session-Only Invariants**
   - Completed operations (card creation, connection, drag, task edits) trigger automatic local save.
   - Camera state is saved locally scoped to Account and Path context.
   - Selection and undo/redo history are verified to reset on reload. Reload during an in-progress drag is not exercised by this script.
5. **AC 5: Observable Browser Flow**
   - Complete browser flow exercised in automated headless Chromium:
     - **Create**: Card creation via toolbar, dynamic label mounting, and task binding.
     - **Connect**: Prerequisite DAG connection between skills.
     - **Drag**: Card translation with observable coordinate changes.
     - **Undo/Redo**: Actual execution of Undo (restoring pre-drag coordinates) and Redo (restoring dragged coordinates).
     - **Task Edit**: Title, description, and required toggle edits verified in application payload.
     - **Save**: Local checkpoint envelope verified in `localStorage`.
     - **Reload**: Full browser reload with exact identity, position, and connection assertions.
     - **Mismatch Rejection**: Foreign path rejection, orphan card rejection, and recovery preservation verified.

## Executed Test Validations (docs/ENGINE_VALIDATION_PLAN.md:28)
- [x] Skill creation disabled during delayed Wasm initialization; subsequent Task save succeeds
- [x] Initial skill selection and task display in React sidebar
- [x] Task title, description, and required flag toggling (Required <-> Enrichment)
- [x] Zero task content in Rust engine snapshot boundary check
- [x] Card creation via toolbar (+ Skill), dynamic label overlay mounting, and initial task binding
- [x] Two newly created Skills can connect and display their titles; full graph restored after reload
- [x] Card drag with observable coordinate verification
- [x] Actual Undo command execution moving card back to pre-drag coordinates
- [x] Actual Redo command execution restoring card to dragged coordinates
- [x] Camera zoom and offset restoration observed through label geometry and zoom indicator
- [x] Full browser reload comparing live card IDs, titles, geometry, complete graph and edited Task fields
- [x] Reset of session-only state across reload (selection null, undo/redo disabled)
- [x] Fast-fail CheckpointMismatchError rejection for foreign learning_path_id payloads
- [x] Fast-fail CheckpointMismatchError rejection for orphan card mismatches
- [x] Shared save guard preventing corrupted/rejected checkpoint overwrite during task edits (ADR-0016 recovery preservation)
- [x] Reset Scene recovery operation restoring clean fixture
