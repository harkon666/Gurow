# Editor API map

This document is the entry point for the Rust editor API. The editor is a
three-part boundary: `engine-core` owns the live canvas state, `editor-wasm`
adapts commands and events to JavaScript, and the React editor owns learning
payloads, HTML labels, and local persistence.

## Ownership

`EditorState` is the source of truth for the live Canvas Document, camera,
selection, transient pointer interaction, and undo/redo history. It does not
own Task content, Reviews, XP, Mastery, or other authoritative learning data.
Those values stay in the application payload and are joined to the editor
snapshot by stable Skill IDs.

`CanvasDocument` stores `SkillCard` values and directed
`PrerequisiteConnection` edges. `try_add_connection` is the safe write seam:
it checks endpoint existence, duplicate edges, self-cycles, and paths that
would create a cycle. `add_connection` is intentionally lower-level and is
for already-validated data such as a trusted snapshot.

`Camera` defines the coordinate contract. Pointer and viewport commands use
CSS-pixel screen coordinates; cards use world coordinates. `world_to_screen`
and `screen_to_world` are inverse transforms for a fixed camera. `zoom_at`
keeps the world point under the pointer stable, while `pan` and
`clamp_bounds` enforce the finite world range and zoom limits.

## JSON boundary

`EditorCommand` is the complete command vocabulary crossing into Rust.
`EditorState::apply_command` mutates CPU state and returns `EditorEvent` values.
The Wasm adapter parses one JSON command, applies it, renders the resulting
state when a renderer is attached, and serializes the events back to React.
The TypeScript schemas in `frontend/src/components/editor/protocol.ts` are the
consumer-side validation of the same contract.

The event sequence has two useful layers:

1. semantic events such as `SelectionChanged`, `ConnectionRejected`, and
   `HistoryChanged` update React controls;
2. `LabelsUpdated` carries screen-space rectangles for HTML labels, while the
   renderer draws card and connection geometry on the canvas.

The renderer is optional. A headless `WasmEditor` still exercises command,
state, and event behavior. Losing the renderer must preserve the CPU document
and history so the application can keep list navigation and offer recovery.

## Persistence seam

`validateCheckpointIntegrity` verifies that editor card IDs, application Skill
IDs, connections, and Task ownership still agree before a checkpoint is saved
or restored. `saveCheckpoint` and `loadCheckpoint` use an account/path-scoped
key; camera state is stored separately because it is view state rather than
learning content. A malformed or mismatched checkpoint fails closed with
`CheckpointMismatchError`.

## Where to start

- Rust state machine: `editor/crates/engine-core/src/state.rs`
- Canvas and graph invariants: `editor/crates/engine-core/src/document.rs`
- Coordinate transforms: `editor/crates/engine-core/src/geometry.rs`
- JSON command/event types: `editor/crates/engine-core/src/protocol.rs`
- Browser/Wasm adapter: `editor/crates/editor-wasm/src/lib.rs`
- React boundary and input listeners: `frontend/src/components/editor/useWasmEditor.ts`
- Runtime schemas: `frontend/src/components/editor/protocol.ts`
- Local checkpoint validation: `frontend/src/components/editor/checkpoint.ts`

Comments on public Rust functions and exported TypeScript functions describe
the local contract at the implementation site. This map explains how those
functions fit together; it does not replace the acceptance criteria in the
prototype and validation documents.
