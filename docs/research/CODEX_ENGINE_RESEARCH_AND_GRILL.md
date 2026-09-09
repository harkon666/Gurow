# Research Conclusion — Infinite Canvas Skill Tree Engine

## Project Goal

Build a web application centered around a custom infinite-canvas engine for creating visual skill trees.

The product combines:

- an infinite 2D canvas;
- draggable skill nodes and prerequisite connections;
- todo / kanban boards attached to each skill;
- gamification through XP;
- personal self-directed learning;
- coach / mentor / teacher-managed learning;
- learner progress tracking;
- review-based mastery;
- optional XP-gated access to skills.

The canvas engine must be built in-house for learning purposes. Do not use high-level canvas/editor engines such as React Flow, tldraw, Konva, Fabric, PixiJS, or similar tools to implement the core editor.

Low-level infrastructure libraries are allowed when they solve infrastructure rather than the editor itself.

---

# Core Technical Decision

## Engine Stack

Use:

- **Rust** for the core engine.
- **wgpu** as the graphics abstraction.
- **WebGPU** as the primary browser graphics API.
- **WebAssembly** as the browser target for the Rust engine.
- **WGSL** for shaders.
- **React + TypeScript** for application UI.
- A separate backend for persistence, authentication, authorization, collaboration, review, XP, and progress state.

The goal is not to copy Figma's source stack byte-for-byte.

Figma has publicly documented a C++ / WebAssembly renderer with a WebGPU backend. Rust is nevertheless preferred for this greenfield project because:

1. The project has no legacy C++ codebase.
2. Rust's ownership and borrowing model can eliminate many classes of memory-lifetime bugs at compile time.
3. Cargo provides a cohesive dependency/build workflow.
4. `wgpu` provides a strong WebGPU-oriented Rust ecosystem and can target browser WebAssembly.
5. Rust encourages explicit ownership boundaries that are useful in a stateful editor engine.
6. The purpose is to learn engine architecture and GPU programming, not specifically to become compatible with Figma's internal C++ implementation.

C++ remains a valid alternative and should not be treated as technically inferior. The main trade-off is:

- C++ gives more freedom and has enormous graphics/engine precedent, but requires more discipline around memory lifetime and tooling.
- Rust imposes more constraints up front, particularly for graphs and mutable editor state, but gives stronger memory-safety guarantees in safe code.

Do not claim Rust will automatically outperform C++. Performance must be benchmarked.

---

# Engine Architecture

Use a clear separation between the application and the editor engine.

```text
React / TypeScript Application
        |
        | commands + application events
        v
Rust WebAssembly Engine
        |
        +-- Editor Core
        |     +-- Scene
        |     +-- Camera
        |     +-- Geometry
        |     +-- Selection
        |     +-- Tools
        |     +-- Hit Testing
        |     +-- Commands
        |     +-- Undo / Redo
        |
        +-- Renderer
              +-- wgpu
              +-- WebGPU
              +-- WGSL shaders
```

The engine owns fast-changing editor state.

Examples:

- camera;
- zoom;
- pointer interaction;
- hover state;
- current selection;
- drag state;
- scene geometry;
- temporary connection state;
- rendering resources.

React should own application UI.

Examples:

- toolbars;
- dialogs;
- kanban sidebar;
- skill details;
- task forms;
- coach review UI;
- learner dashboard;
- authentication UI.

Do not mirror every pointer movement through React state.

The communication boundary should be command-oriented.

Examples:

```text
CreateSkill
MoveSelection
DeleteSelection
CreateConnection
SetCamera
RenameSkill
```

The engine can emit events such as:

```text
SkillSelected(skill_id)
SelectionChanged(ids)
DocumentChanged(change_set)
CameraChanged(camera)
```

---

# Ownership Strategy in Rust

Do not design the engine as a web of long-lived Rust references.

Prefer central ownership plus IDs / handles.

Example:

```text
Scene
  owns nodes
  owns edges

Selection
  stores NodeId values

DragState
  stores NodeId values

Edge
  stores from: NodeId
  stores to: NodeId

Undo commands
  store IDs and values required to reverse an operation
```

Avoid storing references to vector elements across operations that may reallocate or delete data.

Consider a generational-handle design when runtime entity identity becomes important.

Keep document IDs separate from runtime handles if necessary.

Do not use `Rc<RefCell<T>>` everywhere simply to bypass the borrow checker. Shared interior mutability is allowed where justified, but architecture should first try to preserve explicit ownership and short-lived borrows.

---

# Infinite Canvas Fundamentals

An infinite canvas is not an infinitely sized framebuffer.

The canvas should only match the visible viewport.

Objects live in **world coordinates**.

The camera maps world coordinates to screen coordinates.

A minimal transform is:

```text
screen = (world - camera_position) * zoom

world = screen / zoom + camera_position
```

Maintain distinct concepts for:

- world coordinates;
- CSS screen coordinates;
- framebuffer coordinates;
- GPU clip-space coordinates.

Do not mix CSS pixels with device-pixel-ratio-scaled framebuffer pixels.

---

# Zoom Behavior

Zoom must be anchored under the cursor.

The world point under the pointer before zooming should remain under that pointer after the zoom.

Conceptually:

```text
anchor_world = camera_position + pointer_screen / old_zoom

new_camera_position =
    anchor_world - pointer_screen / new_zoom
```

Use reasonable min/max zoom limits.

Exact limits are product decisions rather than WebGPU constraints.

---

# Pan Behavior

For a camera represented in world units:

```text
camera_delta = -pointer_screen_delta / zoom
```

Dragging should remain consistent at every zoom level.

---

# Dragging

When a drag begins:

1. transform pointer screen coordinates to world coordinates;
2. record the dragged object's initial world position;
3. record the pointer-to-object offset;
4. move according to world-space pointer changes.

Do not snap the object's origin directly to the pointer, otherwise the node will jump when dragging begins.

One drag gesture should become one undoable command rather than hundreds of commands generated from pointer-move events.

---

# Interaction Model

Implement interaction as an explicit state machine.

Example:

```text
Idle
  -> Pressing
  -> Panning
  -> DraggingNodes
  -> BoxSelecting
  -> Connecting
  -> EditingText
```

Avoid a large collection of unrelated booleans such as:

```text
isDragging
isPanning
isConnecting
isSelecting
```

that can accidentally become active together.

Use browser Pointer Events for mouse / pen / touch interaction at the web adapter layer.

Use pointer capture where appropriate.

Handle cancellation cases.

---

# Scene Model

The learning structure should be represented as a directed acyclic graph (DAG), not assumed to be a strict tree.

One skill may depend on several prerequisite skills.

One prerequisite may be reused by many downstream skills.

Example:

```text
Linear Algebra -------+
                      +--> Qubits --> Quantum Gates
Basic Physics --------+
```

When adding an edge:

```text
A -> B
```

reject it if a path already exists:

```text
B -> ... -> A
```

because that would create a cycle.

Start with an "all prerequisites required" rule.

More complex prerequisite rules can be introduced later.

---

# Hit Testing

Start simple.

For nodes:

- axis-aligned bounding-box tests;
- evaluate candidates in reverse visual order.

For edges:

- point-to-segment or point-to-curve distance;
- define the hit tolerance in screen pixels;
- convert tolerance into world units based on zoom.

Start with linear scanning.

Only introduce a spatial index after profiling proves it is needed.

Possible later structure:

- uniform spatial hash grid;
- custom quadtree;
- another explicit spatial index.

Do not prematurely optimize.

---

# Rendering

WebGPU should render:

- grid;
- skill cards;
- node states;
- prerequisite connectors;
- selection outline;
- connection previews;
- handles;
- lightweight animations.

HTML / React should render:

- dialogs;
- forms;
- kanban board;
- context menus if convenient;
- text input during editing;
- accessibility-oriented alternative views.

The engine should not try to reimplement the entire browser UI toolkit.

---

# Renderer Design

Keep the renderer behind an abstraction.

Example:

```text
EditorCore
  |
  +--> Renderer
         |
         +--> WgpuRenderer
```

This does not mean implementing multiple renderers now.

It prevents domain/editor logic from becoming tightly coupled to WebGPU objects.

---

# GPU Performance Strategy

Do not optimize before measurement.

Likely useful techniques include:

## Batching

Group compatible draw operations.

Avoid one GPU draw call per node once the scene becomes large.

## Instancing

Skill cards are strong candidates for instanced rendering because many nodes share geometry but differ in:

- transform;
- dimensions;
- colors;
- visual state.

## Culling

Only submit objects relevant to the viewport.

Be careful with edges: an edge may cross the viewport while both endpoints are outside it.

## Level of Detail

At far zoom levels:

- hide unreadable text;
- simplify node visuals;
- reduce expensive decoration.

## Texture Caching

Do not recreate textures every frame.

---

# Text Rendering

Text rendering is its own subsystem.

Do not block the first engine milestone by building an advanced text renderer.

Recommended progression:

### Stage 1

Use browser HTML overlays for text editing and potentially simple labels while proving editor mechanics.

### Stage 2

Rasterize labels and cache them as textures when necessary.

### Stage 3

Investigate SDF / MSDF or another GPU text strategy when scaling and visual quality require it.

Text shaping, fallback fonts, line breaking, caret editing, and international text support should not be underestimated.

---

# JavaScript / WebAssembly Boundary

Avoid crossing the JavaScript <-> WebAssembly boundary excessively for high-frequency updates.

Prefer coarse commands and compact event payloads.

Bad direction:

```text
pointermove
  -> serialize entire scene
  -> JS
  -> React
  -> serialize scene
  -> WASM
```

Preferred direction:

```text
pointer event
  -> engine input
  -> engine updates local transient state
  -> renderer draws

meaningful state change
  -> emit small event to application
```

The ownership of the canvas document must be consciously decided before implementation.

Do not accidentally create two authoritative copies of the same mutable editor document.

---

# Product Domain Architecture

Canvas state and learning progress are separate domains.

Moving a skill node must not change mastery.

Approving a learner's work must not require rewriting the canvas graph.

Separate:

1. curriculum definition;
2. canvas layout;
3. learner progress;
4. submissions;
5. reviews;
6. XP.

---

# Curriculum Model

Useful conceptual entities:

```text
LearningPath
PathVersion
SkillDefinition
PrerequisiteEdge
TaskTemplate
CanvasItem
```

Do not put per-user completion state inside `SkillDefinition`.

A curriculum skill is shared.

Progress belongs to a learner/enrollment.

---

# Learner Progress Model

Useful entities:

```text
Enrollment
TaskInstance
Submission
SubmissionRevision
Review
SkillProgress
XPLedgerEntry
```

This allows one graph to be shared while every learner has independent progress.

---

# Access vs Mastery

This is a critical domain rule.

Keep these separate.

Example:

```text
AccessState:
  LOCKED
  AVAILABLE

MasteryState:
  NOT_STARTED
  IN_PROGRESS
  SUBMITTED
  MASTERED
```

Opening access to a skill does not mean the learner has mastered the skill.

Recommended rule:

```text
can_start_skill =
    prerequisites_satisfied
    AND
    access_policy_satisfied
```

Mastery is decided separately.

---

# XP Model

XP should initially behave as cumulative experience.

Example:

```text
Skill B requires 300 XP.
User reaches 300 XP.
Skill B becomes accessible.
XP remains 300.
```

Do not subtract XP when unlocking skills.

If the product later needs spendable progression, introduce a separate concept such as:

```text
SkillPoints
```

Do not overload one value as both lifetime experience and spendable currency.

XP should affect access, not automatically prove mastery.

Avoid progression deadlocks where a locked node requires XP that can only be obtained from tasks inside that locked node.

---

# Personal Mode

In personal mode:

- user owns/edit the learning graph;
- user defines tasks;
- user can self-review;
- user can manually unlock/override based on configured rules;
- mastery should be identifiable as self-reviewed where useful.

This mode is intentionally flexible.

---

# Coach / Mentor / Teacher Mode

In coach mode:

- coach controls curriculum structure;
- coach defines or edits tasks;
- learners complete tasks;
- learners submit evidence;
- coach reviews submissions;
- learner cannot approve their own submission;
- learner progress is visible to the coach;
- mastery can be coach-reviewed;
- XP can unlock access according to class rules;
- coach review can be a requirement for mastery.

Suggested kanban flow:

```text
TODO
  -> DOING
  -> SUBMITTED
  -> APPROVED

SUBMITTED
  -> CHANGES_REQUESTED
  -> DOING
```

Status transitions must be authorized on the server.

Hiding a button in the client is not authorization.

---

# Review Model

A submission should be versioned.

A coach review must point to the exact revision that was reviewed.

Example:

```text
Submission
  |
  +-- Revision 1
  +-- Revision 2
  +-- Revision 3

Review
  -> Revision 2
```

If the learner modifies the answer afterward, the prior approval must not silently approve the new content.

---

# XP Integrity

XP awards should be server-authoritative and idempotent.

The client should request domain actions such as:

```text
ApproveSubmission(submission_id, revision, operation_id)
```

rather than:

```text
SetXP(500)
SetMastered(true)
```

The server decides:

- whether the actor has permission;
- whether the revision is current;
- whether a reward has already been granted;
- whether mastery conditions are met.

Use a ledger rather than only storing a mutable XP total.

Example:

```text
XPLedgerEntry
  id
  enrollment_id
  source_type
  source_id
  amount
  created_at
```

Use unique constraints / idempotency rules so retrying a request cannot grant XP twice.

---

# Authorization

Authorization must be server-side and deny-by-default.

Examples:

- learner cannot approve their own task in coach mode;
- coach cannot review learners outside their authorized class/workspace;
- learner cannot modify curriculum structure in coach mode;
- changing an API payload manually must not bypass permissions.

---

# Curriculum Versioning

Treat curriculum content as versioned.

Suggested model:

```text
Draft
  -> Published Version
  -> Enrollments
```

Meaningful changes such as:

- prerequisite changes;
- task changes;
- XP rules;
- mastery requirements;

should create a new curriculum version or an explicit migration.

Pure visual layout edits can follow a different policy.

---

# Collaboration

Do not begin by implementing Figma-style real-time collaborative editing.

Coach mode does not require multiplayer canvas editing.

Initial collaboration can use:

- HTTP APIs;
- persisted version/revision numbers;
- polling;
- optionally SSE / WebSocket later.

For document mutations, consider:

```text
expected_revision
```

The server can reject stale edits instead of blindly overwriting newer state.

CRDT technology should only be introduced if concurrent editing becomes a proven requirement.

---

# Persistence

Use:

- PostgreSQL for server persistence.
- Browser local persistence such as IndexedDB for local snapshots / offline work if needed.

The server remains authoritative for:

- reviews;
- permissions;
- XP;
- learner mastery in coach mode.

Offline state must not be able to forge reviewed progress.

---

# Backend

A practical initial backend choice is:

- TypeScript / Node.js;
- PostgreSQL.

This keeps the product/backend layer accessible while Rust is reserved for the engine.

Rust on the backend can be evaluated later but should not be forced into the MVP simply because the engine uses Rust.

---

# Testing

Testing should cover several independent layers.

## Engine Math Tests

Test:

- screen -> world;
- world -> screen;
- zoom anchor invariance;
- drag offset;
- camera movement;
- edge geometry;
- hit tolerance.

## Domain Tests

Test:

- prerequisite cycle rejection;
- locked/available transitions;
- mastery transitions;
- XP threshold behavior;
- no XP double-award;
- correct curriculum version behavior.

## Authorization Tests

Test:

- learner cannot self-approve in coach mode;
- coach A cannot review class B;
- forged requests cannot grant XP;
- unauthorized graph edits are rejected.

## Interaction Tests

Test:

- selection;
- multiselect;
- drag;
- pan;
- zoom;
- box select;
- connection tool;
- delete;
- undo;
- redo.

## Performance Benchmarks

Create controlled scenes such as:

```text
100 nodes
1,000 nodes
10,000 nodes
```

These are test workloads, not promised capacity targets.

Measure:

- frame time;
- worst-frame spikes;
- visible object count;
- number of draw calls;
- CPU culling time;
- hit-testing time;
- GPU upload volume;
- memory usage;
- Wasm download size;
- initialization time.

Do not optimize based only on total node count; visible nodes and edge complexity matter.

---

# Development Sequence

Do not start with the full product.

## Milestone 0 — Toolchain

Prove:

```text
Rust -> WASM -> Browser -> wgpu -> WebGPU -> triangle/quad
```

## Milestone 1 — Camera

Implement:

- resize;
- world/screen transforms;
- pan;
- cursor-anchored zoom;
- grid.

## Milestone 2 — Scene

Implement:

- node storage;
- card rendering;
- edge rendering;
- selection;
- hit testing.

## Milestone 3 — Editing

Implement:

- node creation;
- dragging;
- deletion;
- connections;
- box selection;
- command system;
- undo/redo.

## Milestone 4 — Persistence

Implement:

- document serialization;
- save/load;
- schema version.

## Milestone 5 — React Integration

Implement:

- canvas host;
- toolbar;
- skill selection event;
- skill sidebar;
- HTML text editing overlay.

## Milestone 6 — Personal Learning

Implement one vertical slice:

```text
create skill
-> create prerequisite
-> create task
-> complete task
-> self-review
-> earn XP
-> unlock downstream skill
```

## Milestone 7 — Coach Mode

Implement:

```text
coach creates curriculum
-> learner enrolls
-> learner completes task
-> learner submits evidence
-> coach reviews
-> XP awarded once
-> mastery updates
-> downstream access updates
```

## Milestone 8 — Performance

Profile first.

Then evaluate:

- batching;
- instancing;
- spatial indexing;
- culling;
- level of detail;
- text caching;
- worker architecture.

---

# What Not To Build Yet

Explicitly postpone:

- CRDT multiplayer editing;
- WebGPU/WebGL dual renderer;
- sophisticated text editor;
- MSDF text;
- plugin system;
- automatic graph layout;
- Rust backend migration;
- physics animation system;
- massive node-count optimization;
- user-generated scripting;
- mobile editor parity.

These are later decisions.

---

# Architectural Principles

1. **Build a product-specific engine, not a universal Figma clone.**
2. **Keep editor core independent from React.**
3. **Keep learning domain independent from renderer details.**
4. **Keep authorization and XP server-authoritative.**
5. **Use IDs/handles instead of long-lived object references.**
6. **Use explicit commands for editor mutations.**
7. **One user gesture should map to one semantic undo operation.**
8. **Profile before introducing complex optimization.**
9. **Do not introduce realtime collaboration until product requirements justify it.**
10. **Do not let the UI become a second authoritative copy of engine state.**
11. **Do not treat XP unlock as proof of mastery.**
12. **Design the DAG rules and review rules before allowing arbitrary customization.**

---

# Decisions That Still Need To Be Grilled

The following topics are intentionally not finalized and should be discussed before serious implementation:

## Product / Domain

- What exactly is a "Skill"?
- Can one skill exist in multiple learning paths?
- Can users clone another person's learning path?
- Is a task reusable across skills?
- Can coach mode have multiple coaches?
- Can learners propose nodes/tasks?
- What counts as submission evidence?
- Is mastery binary or scored?
- Can mastery expire?
- What does a coach override mean?
- Are prerequisite overrides recorded?
- How is personal XP separated from course XP?
- Can XP policy vary per learning path?
- Can a coach retroactively change XP?
- Does editing a published curriculum affect current learners?
- What happens when prerequisites change after learners have progressed?

## Canvas / Engine

- Who is authoritative for document state: Rust engine or TypeScript application?
- How are stable document IDs generated?
- What runtime handle strategy should be used?
- Which scene representation is best for iteration and rendering?
- How should z-order work?
- How should nested/grouped nodes work, if at all?
- Are edges straight, orthogonal, Bézier, or configurable?
- Is auto-layout a core requirement or later feature?
- What coordinate limits are acceptable?
- What are min/max zoom values?
- How should snapping work?
- What is the keyboard interaction model?
- What accessibility alternative exists to spatial canvas interaction?
- What is the initial text-rendering strategy?
- What exact boundary exists between Rust and TypeScript?
- What data crosses Wasm every frame?
- Should WebGPU initialization live entirely in Rust or partly in JS?
- How should GPU device loss be recovered?

## Persistence / Sync

- What is the serialized document schema?
- Is canvas layout versioned separately from curriculum semantics?
- How are migrations performed?
- How are stale writes handled?
- Is offline editing supported initially?
- What happens if two coach sessions edit the same curriculum?
- When would realtime collaboration become justified?

## Performance

- What hardware/browser constitutes the minimum target?
- What is the acceptable frame-time budget?
- What is the realistic target node count?
- How many visible nodes should remain interactive?
- At what zoom level should labels disappear?
- When should a spatial index be introduced?
- Which metrics determine whether optimization is successful?

---

# Recommended First Vertical Slice

Before building the application, prove this workflow:

```text
Open page
  ->
WebGPU canvas initializes
  ->
User pans and zooms
  ->
User drags a "Skill" component from a palette
  ->
Node is created at the correct world coordinate
  ->
User creates another node
  ->
User connects A -> B
  ->
User clicks A
  ->
React sidebar opens
  ->
User adds a todo item
  ->
Document saves
  ->
Reload browser
  ->
Canvas and task state restore correctly
```

After this works, build the complete personal learning loop.

After the personal loop works, implement coach review and server-authoritative XP.

---

# Instruction To Coding Agent

Do not immediately scaffold the entire application.

Before implementation:

1. inspect the repository;
2. read this document;
3. identify decisions already fixed versus decisions still open;
4. challenge unresolved assumptions;
5. establish canonical domain terminology;
6. record hard-to-reverse architectural decisions as ADRs;
7. produce the smallest vertical prototype that can validate the architecture.

Do not substitute a library for the canvas engine merely to finish faster.

The objective of this project includes learning graphics/editor-engine fundamentals.


---

# Prompt — Grill With Docs for the Infinite Canvas Skill Tree Project

Use the `grill-with-docs` workflow for this repository.

Read `RESEARCH_CONCLUSION.md` before asking anything.

This is a greenfield product and engine. I want you to stress-test the plan before implementation, not rush into scaffolding code.

## Context

I am building a gamified learning application with a custom infinite-canvas skill-tree editor.

A learner should be able to visually construct a learning path such as:

```text
Basic Physics -----+
                   +--> Qubits --> Quantum Gates
Linear Algebra ----+
```

Clicking a skill opens an application sidebar containing tasks / a kanban-like workflow.

There are two major modes.

### Personal mode

The user:

- creates their own skill graph;
- defines their own tasks;
- manages their own progress;
- may self-review;
- can earn cumulative XP;
- can unlock skills according to configured prerequisite / XP rules.

### Coach / Mentor / Teacher mode

The coach:

- owns or manages the curriculum;
- defines the skill graph and tasks;
- invites learners;
- sees learner progress;
- reviews learner submissions;
- controls coach-reviewed mastery.

Learners:

- work through tasks;
- submit evidence;
- earn XP through authorized actions;
- unlock skills according to curriculum rules.

XP unlock and skill mastery are separate concepts.

## Current technical direction

The current direction is:

```text
Rust
  -> WebAssembly
  -> wgpu
  -> WebGPU
  -> WGSL

React + TypeScript
  -> application UI

Backend
  -> application/domain persistence
  -> authentication
  -> authorization
  -> reviews
  -> XP
  -> learner progress

PostgreSQL
  -> durable domain storage
```

The canvas/editor engine must be built in-house.

Do NOT solve the project by replacing it with:

- React Flow;
- tldraw;
- Konva;
- Fabric;
- PixiJS;
- another high-level canvas/editor engine.

Low-level libraries such as `wgpu`, WebAssembly tooling, serialization libraries, test frameworks, database drivers, and similar infrastructure are allowed.

The objective includes learning how editor engines actually work.

## How I want you to grill me

Interview me relentlessly about the design until we have a shared understanding.

Ask **exactly one substantive question at a time**.

Wait for my response before continuing.

For every question:

1. explain why the decision matters;
2. give your recommended answer;
3. give the main trade-off of your recommendation;
4. ask me to accept, reject, or modify it.

Do not dump a giant questionnaire.

Walk the decision tree in dependency order.

If a question can be answered by inspecting the repository or existing docs, inspect them instead of asking me.

Challenge vague language.

If I use two words that appear to mean the same thing, force us to choose canonical terminology.

If I use one word for two different concepts, point that out.

## Documentation behavior

Maintain a `CONTEXT.md` glossary as terminology becomes settled.

Only write a term once we actually agree on its meaning.

Keep `CONTEXT.md` focused on domain vocabulary and invariant concepts, not implementation tutorials.

Create ADRs under:

```text
docs/adr/
```

but only for decisions that are:

1. hard or expensive to reverse;
2. non-obvious or surprising without context;
3. the result of a real trade-off.

Do NOT make an ADR for every answer.

Examples of decisions that may deserve ADRs:

- Rust as the engine language;
- engine owns transient editor state;
- WebGPU-first rendering strategy;
- DAG rather than strict tree;
- separation of mastery from access;
- server-authoritative review and XP;
- document versioning strategy;
- Wasm boundary architecture;

but you must decide whether each really warrants an ADR after the discussion.

## Topics that must eventually be resolved

Do not ask all of these immediately.

Use them as branches in the design tree.

### Domain model

Resolve precise meanings for:

- Skill;
- Learning Path;
- Curriculum;
- Skill Tree;
- Graph;
- Prerequisite;
- Task;
- Submission;
- Submission Revision;
- Review;
- Mastery;
- Access;
- Unlock;
- XP;
- Enrollment;
- Coach;
- Learner;
- Personal Workspace;
- Coach Workspace.

Determine whether "Skill Tree" is merely the UI/product term while the underlying domain structure is a DAG.

### Progression

Resolve:

- prerequisite semantics;
- all-vs-any prerequisite policy;
- XP thresholds;
- mastery conditions;
- personal self-review;
- coach review;
- manual overrides;
- whether overrides are audited;
- whether XP is global, per workspace, or per learning path;
- whether XP can ever be removed;
- whether mastery can be revoked or expire;
- what happens when curriculum changes after progress exists.

### Coach mode

Resolve:

- roles and permissions;
- one coach vs multiple coaches;
- learner invitations/enrollment;
- submission evidence;
- review lifecycle;
- changes requested;
- approval;
- grading vs binary mastery;
- coach queues;
- visibility boundaries;
- server-side authorization rules.

### Canvas engine

Resolve:

- authoritative editor state;
- scene representation;
- node IDs;
- runtime handles;
- ownership model;
- edge model;
- z-order;
- interaction state machine;
- hit testing;
- selection;
- multiselect;
- pan;
- cursor-anchored zoom;
- drag;
- connection creation;
- undo/redo;
- copy/paste;
- serialization;
- coordinate bounds;
- snapping;
- text strategy;
- GPU device-loss behavior;
- accessibility representation.

### Rust / WebAssembly architecture

Resolve:

- crate boundaries;
- what lives in `engine-core`;
- what lives in `renderer-wgpu`;
- what lives in the browser adapter;
- what React is allowed to own;
- what data crosses the Wasm boundary;
- whether the document lives primarily in Rust or TypeScript;
- how commands/events are encoded;
- serialization format;
- error propagation;
- panic handling;
- tracing/debugging;
- browser build tooling;
- test strategy.

### WebGPU renderer

Resolve:

- render passes;
- node/card geometry;
- connector geometry;
- grid rendering;
- instancing;
- batching;
- uniforms/storage buffers;
- viewport culling;
- level of detail;
- texture caching;
- text rendering;
- anti-aliasing strategy;
- picking strategy;
- when CPU hit testing should become spatially indexed.

Do not prematurely optimize.

### Persistence

Resolve:

- document schema;
- schema versions;
- curriculum versioning;
- layout versioning;
- PostgreSQL entities;
- save granularity;
- conflict detection;
- optimistic concurrency;
- local storage / IndexedDB;
- offline support;
- migrations.

### Collaboration

Start with the assumption that realtime multiplayer editing is NOT required for MVP.

Challenge that assumption only if product requirements prove otherwise.

Do not introduce CRDTs merely because the canvas resembles Figma.

### Performance

Before selecting optimizations, establish measurable budgets.

Discuss:

- target device/browser;
- acceptable interaction latency;
- frame-time budget;
- target total node count;
- target visible node count;
- edge count;
- Wasm initialization;
- memory;
- GPU uploads;
- draw calls.

Treat numbers such as 1,000 or 10,000 nodes as benchmark workloads until validated, not promised production capacity.

## Important architectural invariants to challenge but not casually discard

Current research suggests these principles:

```text
Editor engine != learning domain.

Canvas layout != learner progress.

Access != mastery.

XP != mastery.

Learner progress != curriculum definition.

React UI != authoritative transient engine state.

Client approval != authorized review.

One pointermove != one undo command.

Coach mode != realtime multiplayer editor.

Infinite canvas != infinitely large framebuffer.
```

You may challenge any of them, but only with a concrete architectural reason.

## Sequence

Start at the highest-leverage unresolved decision.

Do not begin with implementation detail such as folder naming unless a larger architectural decision depends on it.

A useful dependency order is roughly:

```text
Product semantics
    ↓
Domain invariants
    ↓
Authority / ownership boundaries
    ↓
Document model
    ↓
Engine architecture
    ↓
Rust/Wasm boundary
    ↓
Renderer architecture
    ↓
Persistence
    ↓
Interaction details
    ↓
Performance optimizations
```

You may alter the order if the repository reveals a better dependency chain.

## When the grill is complete

Do NOT immediately build the full app.

When we have resolved the important design branches:

1. ensure `CONTEXT.md` reflects canonical terminology;
2. ensure only genuinely load-bearing decisions have ADRs;
3. summarize unresolved risks;
4. propose the smallest prototype that can falsify our riskiest assumptions;
5. define measurable acceptance criteria for that prototype.

The initial prototype should probably prove something close to:

```text
Rust/WASM/WebGPU initializes
-> canvas displays
-> camera pans
-> cursor-anchored zoom works
-> skill card can be created
-> card can be dragged
-> card can be selected
-> prerequisite connection can be created
-> selecting card emits event to React
-> React sidebar opens
-> document can serialize and restore
```

But grill this prototype definition too rather than blindly accepting it.

## First action

1. Inspect the repository.
2. Read `RESEARCH_CONCLUSION.md`.
3. Read any existing `CONTEXT.md`, `CONTEXT-MAP.md`, and ADRs.
4. Determine the single highest-leverage unresolved design question.
5. Ask me only that question, together with your recommended answer and its trade-off.

Do not write implementation code yet.
