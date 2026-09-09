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
