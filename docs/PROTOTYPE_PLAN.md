# Gurow prototype plan

Status: design and prototype scopes agreed through Q82. Implementation and benchmark results are not yet available. The first implementation target is P1; P2 follows after its acceptance criteria pass.

The design baseline is recorded in [CONTEXT.md](../CONTEXT.md) and the [architectural decisions](adr/). The original research remains a source of implementation starting points; the agreed decisions take precedence where the discussion refined it.

## Design outcome

Personal learning is controlled by the user: Mastery is freely declared, Task completion earns configurable XP, and explicit Access Overrides can bypass progression gates. Coach-mode learning uses version-bound Enrollments, revision-specific Reviews, and authorized decisions. Access, Mastery, and XP have separate meanings in both modes.

The custom editor uses Rust/Wasm/wgpu/WebGPU with React application UI. Rust owns the active editor representation; learning-domain data and durable authority remain outside the renderer. The first prototype tests this separation and the HTML-label strategy before building the complete learning application.

## P1: editor engine and application integration

### Hypothesis

A Rust-owned editor can provide the required interactions and work with a React sidebar, HTML labels, and separate application data while meeting the initial latency targets and preserving work across reloads and renderer failure.

### Required vertical slice

1. Initialize the Rust/Wasm/WebGPU path in a real browser and display the canvas.
2. Pan and zoom around the pointer, respecting the initial 10%–400% zoom range and coordinate bounds of -1,000,000 to +1,000,000 on each axis.
3. Create, select, and drag Skill cards with labels positioned from engine data.
4. Create Prerequisite connections and reject cycle-creating connections without changing the valid graph.
5. Selecting a card opens the React sidebar for the correct Skill.
6. Edit one simple Task in the sidebar as application-owned data associated with that Skill.
7. Exercise editor undo/redo, including one undo step for a completed drag gesture.
8. Save locally and reload to restore the editor scene and associated Task data.
9. Provide keyboard navigation through a Skill/Prerequisite list, including when the WebGPU canvas is unavailable.
10. Exercise renderer failure and recovery while preserving the CPU-side document; a failed recovery exposes a retry action and keeps the list available.
11. Run the recorded primary benchmark workload with HTML labels enabled.

P1 uses local prototype fixtures and persistence. Authentication, coach Review, and backend XP processing belong to later integration and P2. A successful P1 does not demonstrate server authorization, PostgreSQL persistence, or the complete product workflow.

The wider MVP interaction set is defined in [ADR 0015](adr/0015-own-live-editor-state-in-rust.md), including box multiselection and deletion. The required P1 slice above is the first acceptance boundary rather than a demand to implement every MVP feature at once.

### State and persistence boundaries

| Data | Live owner | Persistence in P1 |
| --- | --- | --- |
| Skill references, card positions, Prerequisite connections | Rust editor | Versioned editor snapshot |
| Task contents and supporting learning fixture data | TypeScript application | Separate application payload associated with the editor checkpoint |
| Camera position and zoom | Rust editor | Local view state for the account/fixture and Path context |
| Selection, in-progress drag, undo history | Rust editor | Editor session only |
| Authoritative Reviews, XP, Mastery, Enrollments | Backend in the product | Outside P1 |

Restoration must combine a coherent editor checkpoint and its associated application data. Putting Task contents into the engine snapshot merely to make the reload test pass would violate the accepted boundary. Likewise, keeping a second authoritative set of card positions in React would bypass the ownership hypothesis being tested.

The snapshot format version, save-concurrency revision, and Learning Path Version are different concepts. The serialization includes references to learning entities, and the same Prerequisite connections must not become two independently editable persisted graphs. See [ADR 0016](adr/0016-save-editor-snapshots-with-revision-checks.md).

### Acceptance criteria

All required P1 flow steps must work. The following checks make the result reviewable:

| Check | Passing evidence |
| --- | --- |
| Actual rendering path | Rust/Wasm initializes and WebGPU draws the scene in the recorded browser; a list-only fallback is not a substitute for this check |
| Camera and dragging | Pan/zoom/drag behave correctly at the supported limits, zoom preserves the point under the pointer, and beginning a drag preserves the pointer offset |
| Graph validity | A valid edge is accepted; a cycle-creating edge is rejected and leaves the previous graph intact |
| Application boundary | Selecting different cards addresses the correct Skill and its Task; editing the Task does not introduce a second position authority |
| Save and restore | Reload preserves IDs, positions, connections, and Task contents semantically, independent of JSON property order |
| Undo/redo | One undo restores the position before a completed drag, and redo restores the resulting position |
| Labels | HTML labels remain associated and aligned with their cards through selection, dragging, and camera changes |
| Recovery | Exercising renderer failure does not discard the CPU-side document; recovery redraws it, or retry and list navigation remain available |
| Keyboard/list path | The user can select a Skill and reach its sidebar Task through the list when the canvas is unavailable |
| Frame time | On the primary workload, p95 is at most 20 ms during pan/zoom/drag |
| Visible response | On the primary workload, p95 input-to-visible-response latency is at most 50 ms |

The primary workload is 1,000 cards, approximately 200 visible cards, and 2,000 total connections. The reference environment, interaction sequence, visible counts, and measurement method must be reported as specified in [ENGINE_VALIDATION_PLAN.md](ENGINE_VALIDATION_PLAN.md). Workloads with 100 and 10,000 cards are comparisons; the latter is exploratory rather than a release-capacity promise.

Functional success without the performance results is not full P1 acceptance. If a required check fails, fix the prototype or reassess the relevant design choice before widening implementation. Changes to the agreed targets should be recorded explicitly, rather than reported as if the original targets passed.

## P2: learning-domain backend with PostgreSQL

### Hypothesis and scope

The accepted Enrollment, Submission, Review, XP, and Mastery rules can be enforced independently of canvas rendering, including retries, stale revisions, and unauthorized requests.

Use a small backend and PostgreSQL with controlled actor and content fixtures. The central flow is Enrollment → Submission → Approval → XP/Mastery → Approval Revocation. A full coach dashboard and a combined production application are not required for this proof. The identity fixture used by tests must be distinguished from a production authentication-provider integration.

One useful fixture is a published Path with two required Skills: A has a required Task worth 20 XP; B requires Mastery of A and 20 Enrollment XP and has its own required Task. Before A is approved, B is locked. Approval of A's Task grants its one reward, produces Mastery of A, and opens B. Revoking the last valid Approval removes that contribution and reevaluates Mastery and dependent Access.

### Acceptance evidence

| Case | Expected result under the agreed rules |
| --- | --- |
| Repeated invitation acceptance | One Enrollment for the Account and Version; existing progress is retained and inactive participation is not silently reactivated |
| Repeated Submission sends/revisions | One Submission per Task and Enrollment with the appropriate immutable revisions |
| Repeated reward-producing action | A Task never contributes more than its configured reward within the Enrollment |
| Stale Review decision | A decision against a superseded pending revision is rejected without awarding XP or Mastery |
| New revision after Approval | Earlier valid Approval continues to support the Task until explicitly revoked; the new revision has its own Review state |
| Approval Revocation | The final valid Approval's removal corrects XP and reevaluates Mastery; history is preserved |
| Enrollment deactivation | New work is blocked, existing history remains readable within its visibility rules, and eligible prior submissions remain reviewable |
| Authority and privacy | Unauthorized mutations and reads are rejected, including peer data, another Workspace's data, self-approval, and Coach access to unsent learner drafts |

Use domain tests for the personal reward correction as well: a completed Task changing from 20 to 50 contributes a recorded +30 correction; undoing completion removes 50; completing it again restores 50 without multiplying it. Archival by itself retains the existing contribution and Mastery.

PostgreSQL-backed integration results must demonstrate the intended effects under repeated or competing requests. Tests of calculation functions alone do not establish safe persistence under concurrency. Record the actual tests and outcomes before declaring the backend proof successful.

## Risks the prototypes must investigate

| Risk or limit | Evidence or follow-up |
| --- | --- |
| HTML-label cost and alignment at scale | P1 exercises labels on the primary workload and records their visible count; reconsider the label strategy if it fails |
| JSON boundary overhead or excessive updates | Measure messages, payload sizes, and interaction timing before replacing the initial interface with a binary format |
| WebGPU startup, device availability, and recovery | Test a real WebGPU browser and the separate failure/list paths; the exact reference device remains to be recorded |
| Split editor/application state becoming inconsistent | The P1 save/restore check must preserve the graph and Task association without duplicating authority |
| Stale writes and review/reward races | P2 and persistence integration tests must exercise actual rejected writes and repeated actions |
| Privacy leakage through drafts, local recovery, or archives | Apply the agreed visibility boundaries to each storage and read path, not only to the visible UI |
| External evidence can change or disappear | The agreed snapshot guarantee covers submitted text and URLs; use version-specific references or copied evidence where needed |
| Retained history and personal reward edits can surprise users | Keep archival separate from score correction, and make recorded corrections and current Access understandable |

## Implementation starting points and remaining follow-ups

The supplied research supports central scene ownership through IDs, an explicit interaction state machine, distinct world/CSS/framebuffer coordinates, CPU bounding-box and curve-distance hit testing, and linear scanning before a measured need for an index. These are conservative starting points for implementation rather than measured performance results. Low-level graphics infrastructure is allowed; replacing the editor with a high-level editor library remains outside the agreed direction.

Concrete package versions, GPU buffer and curve-tessellation choices, anti-aliasing, tracing details, local-storage schema mechanics, and the exact reference device are implementation follow-ups. Record initialization time, memory use, draw calls, and upload volume alongside the accepted latency gates; no pass thresholds for those additional diagnostics have been agreed yet.

Production authentication/email delivery, invitation expiry policy, detailed archive presentation and restoration, and broader account or Workspace lifecycle changes are outside the two narrow proofs. No time-based Mastery expiry has been agreed; prototypes exercise the explicitly defined correction and revocation rules. Product-facing wording such as "Skill Tree" may be refined in the UI while the domain continues to use Prerequisite Graph.

The next implementation step is P1. Expanding into the complete application follows measured evidence and a separate implementation scope, rather than treating approval of this plan as completion of the software.
