# Save editor snapshots with revision checks and local recovery

Editor snapshots are saved after completed editing operations, such as releasing a card after dragging, with nearby changes combined. Each save carries the revision on which the edit was based. The backend rejects stale saves rather than silently overwriting newer state, and the application preserves the unsaved local changes for recovery. This avoids silent lost updates between tabs, at the cost of occasional conflicts requiring user action.

Editor saves remain subject to the existing separation between learning content, Canvas Layout, and learner progress. A snapshot cannot bypass the immutability of published learning content or overwrite review and XP records through a layout save.

An editor snapshot contains a format version, Skill references, card positions, and connections. Tasks, Submissions, XP, and Mastery are stored separately. Connections represent the same Prerequisites in the Learning Path definition and have one authoritative persistence source, rather than an independently maintained second prerequisite graph. Loading the editor therefore combines its canvas representation with learning-domain data. The serialization format version, concurrency revision, and Learning Path Version identify different things and must remain distinct.

Camera position is saved locally per Account and Path context, so one user's navigation does not change another user's view. Selection, in-progress drag state, and undo history last only for the editor session. This keeps view state separate from shared Canvas Layout, at the cost of camera state not automatically following the user between devices and undo history being lost on page reload.

The MVP prioritizes online use, with local persistence for recovering drafts and editor changes not yet saved. Submissions, Reviews, and XP changes count as successful only after backend confirmation. This permits recovery of local work at the cost of domain activity not being fully completable without a connection. Local recovery must respect the same Account and Workspace visibility boundaries as the corresponding data.
