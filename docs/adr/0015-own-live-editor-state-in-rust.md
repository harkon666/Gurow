# Own live editor state in Rust behind a command interface

Rust owns the active Canvas Document and transient editor state: Skill cards, connections, positions, camera, selection, and undo/redo. The React application owns application UI and learning-domain data, while the backend stores durable data and validates domain rules. React does not maintain a second authoritative copy of mutable canvas positions. This keeps interactive editing under one owner, at the cost of requiring an explicit boundary between the engine and application.

The initial Rust/TypeScript interface uses commands and events with defined structures and inspectable JSON payloads. Pointer input uses compact calls; entire-scene transfers are reserved for operations such as loading and saving, rather than each pointer movement. This makes the boundary easier to inspect during debugging, at the cost of serialization overhead that must be measured before introducing a custom binary format.

The MVP uses one card per Skill with a flat structure and manual positioning. Nested groups and automatic layout are deferred, keeping coordinate and connection handling simpler at the cost of users arranging large graphs themselves.

The MVP interaction set includes selection, box multiselection, dragging a selection, pan, cursor-anchored zoom, connection creation, deletion, and undo/redo. Connections use one Bezier-curve style; snapping and cross-Path clipboard operations are deferred. This covers the principal editing operations at the cost of limited precision-layout tools and clipboard-based content transfer.

Initial camera limits are 10% to 400% zoom and coordinates from -1,000,000 to +1,000,000 on each axis. These are bounded prototype parameters to test, allowing a large working space while keeping finite coordinate and zoom limits.

Rust is separated into `engine-core` for documents, interaction, and geometry; `renderer-wgpu` for rendering; and a browser adapter for input and application communication. The core does not depend on DOM or GPU objects, allowing editor logic to be tested without a renderer at the cost of additional module interfaces.

Undo/redo applies to editor operations on documents the user may edit, with one drag gesture represented by one undo step. Reviews, XP, Mastery, and Enrollments use separate domain actions. Undoing an already saved editor change creates a new change that the backend validates again; it does not rewind durable domain history. This keeps editor history scoped to editing, at the cost of the canvas undo command not reversing every kind of action in the application.
