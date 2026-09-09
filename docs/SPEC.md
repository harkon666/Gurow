## Problem Statement

People learning independently need a private place to organize Skills, choose useful Tasks, and see progress without having to prove every achievement to someone else. A personal motivation tool must let its user decide whether to declare Mastery, leave it unclaimed, or move past a progression gate even when actual proficiency is uncertain.

Coaches need a different assessment contract: explicit learning outcomes, required and optional work, consistent requirements for an enrolled learner, and traceable decisions about submitted evidence. A subject name alone cannot define those requirements; two coaches teaching linear algebra can legitimately choose different outcomes and Tasks. Mixing permission to work, assessed Mastery, and motivational XP would make both modes misleading.

Both groups need a navigable visual Learning Path that remains responsive as its Prerequisite Graph grows, preserves work through reloads and renderer failures, and connects directly to learning activities. Gurow currently contains a React/TypeScript application starter and a small Bun/Hono backend. The editor engine, learning domain, persistence, authorization, and feature tests are not implemented.

## Solution

Provide personal and coached Learning Paths using one vocabulary for Skills, Tasks, Prerequisites, Access, Mastery, and XP, with mode-specific authority and progression rules. Personal users control their declarations and rewards in a private Personal Workspace. Coaches own versioned learning content in a Coach Workspace, invite learners to a particular published Version, and assess immutable Submission Revisions. Optional learning remains optional, corrections preserve history, and current Access is evaluated independently of existing Mastery.

Present each Learning Path as a manually arranged canvas with one card per Skill, accompanied by a keyboard-accessible Skill/Prerequisite list and React learning panels. Build the editor in Rust/Wasm with wgpu/WebGPU rendering, keep learning data separate from editor state, and enforce durable domain rules in the backend with PostgreSQL.

This is the parent specification for the agreed MVP. Delivery begins with two bounded proofs: **P1** establishes the editor, application boundary, recovery, and measured performance; **P2** then establishes the core learning-domain rules against PostgreSQL. The full user-story list defines product behavior, not an instruction to implement every story inside P1. Later product slices use these rules and the evidence from the two proofs.

## User Stories

1. As an Account holder, I want to learn personally, coach in my own context, and learn from another Coach with one Account, so that I can use Gurow without maintaining separate identities for each role.
2. As a personal learner, I want one private Personal Workspace containing my Learning Paths, so that I can organize my learning in one place.
3. As a personal learner, I want my Personal Workspace visible only to me, so that joining a Coach's Learning Path does not expose my private learning.
4. As a Coach, I want a Coach Workspace containing multiple Learning Paths, so that I can manage related teaching activities under one ownership boundary.
5. As an Account holder, I want the active learning context and my authority to be clear, so that I understand which actions I can take.
6. As a Learning Path author, I want to define a learning goal and Skills with assessable outcomes, so that the Path describes abilities to develop.
7. As a Coach, I want to choose Tasks for my own learning outcomes even when another Coach teaches the same subject, so that assessment reflects my Path's design.
8. As a Learning Path author, I want each Task associated with one Skill, so that its purpose and assessment target are clear.
9. As a Learning Path author, I want to copy a Skill with its Tasks into another Path as independent content, so that adapting it does not change the source.
10. As a Learning Path author, I want to copy a Task into another Skill with a separate identity and work history, so that reuse does not mix assessments.
11. As a Learning Path author, I want branching Prerequisites with multiple foundations for a Skill, so that I can represent learning dependencies.
12. As a Learning Path author, I want cycle-creating connections rejected immediately, so that my Prerequisite Graph remains navigable and acyclic.
13. As a learner, I want all of a Skill's Prerequisites evaluated through their current Mastery, so that Access follows the learning requirements.
14. As a learner, I want to see a Locked Skill's title, learning outcome, and lock reason, so that I understand the next requirements.
15. As a learner, I want Access and Mastery displayed as different states, so that permission to start does not imply achievement.
16. As a personal learner, I want to declare Mastery freely without mandatory evidence or review, so that the platform supports my own motivation and judgment.
17. As a personal learner, I want to leave Mastery unclaimed even after completing Tasks, so that activity tracking does not decide my achievement for me.
18. As a personal learner, I want an explicit Access Override without a required reason, so that I can continue past Prerequisites and XP Thresholds when I choose.
19. As a personal learner, I want an Access Override to leave XP and Mastery unchanged, so that permission remains separate from progress records.
20. As a personal learner, I want to set Task rewards and earn XP by marking Tasks complete without mandatory evidence, so that I can configure my own motivation system.
21. As a personal learner, I want repeated completion actions to avoid multiplying a Task's reward, so that my XP reflects its completion state.
22. As a personal learner, I want undoing completion to remove its reward and completing it again to restore the current reward, so that corrections stay consistent.
23. As a personal learner, I want changing a completed Task's reward to adjust its contribution by the difference, so that my current configuration is reflected in XP.
24. As a personal learner, I want Task actions and reward corrections to leave declared Mastery independent, so that motivational scoring does not rewrite my declarations.
25. As a personal learner, I want each Path's XP Thresholds to use only XP from that Path, so that unrelated learning does not determine its progression.
26. As a learner, I want gaining Access to leave my XP unspent, so that thresholds represent accumulated progress rather than a purchase.
27. As a learner, I want current Prerequisite and XP conditions to explain any loss of Access while preserving existing work and valid Mastery, so that progression changes are understandable.
28. As a Coach, I want to designate Optional Skills and Enrichment Tasks, so that learners can explore useful extras without making them mandatory.
29. As a Coach, I want required progression checked before publication, so that learners can complete the required route without optional work or overrides.
30. As a Coach, I want blocked publication to identify affected Skills and unmet requirements, so that I can repair the Path.
31. As a Coach, I want each Skill's Mastery derived from valid Approvals for a nonempty set of Required Tasks, so that achievement has explicit evidence.
32. As a coached learner, I want Mastery awarded when all Required Tasks qualify without another Skill-level sign-off, so that completed assessment produces its result automatically.
33. As a Coach, I want published learning content and rules to remain immutable, so that enrolled learners keep consistent requirements.
34. As a Coach, I want to prepare every content correction, including typos, in a Draft for a new Version, so that edits preserve the existing assessment contract.
35. As a coached learner, I want my Enrollment to remain on the Version I joined, so that later edits do not silently change my Tasks or progress.
36. As a Coach, I want logical Skill and Task identities traceable across Versions without transferring learner progress, so that content continuity does not imply assessment equivalence.
37. As a Coach, I want to invite a particular verified email to one published Version, so that participation is assigned to the intended Account and learning content.
38. As an invited learner, I want acceptance to enroll me only in the offered Version, so that I do not unknowingly join other Paths in the Workspace.
39. As a learner, I want repeated invitations to reuse my Enrollment for that Version, so that they neither reset progress nor create another XP total.
40. As a Coach, I want to close or reopen a published Version to new Enrollments without disrupting existing participation, so that admission and ongoing learning can be managed separately.
41. As a coached learner, I want my progress, XP, Mastery, submitted work, and Review results visible only to me and the owning Coach, so that peers cannot access my records.
42. As a coached learner, I want editable Submission Draft contents private to me, so that I can prepare work before sharing it for Review.
43. As a coached learner, I want to submit text and URLs for one Task, so that I can present written work and externally hosted evidence.
44. As a coached learner, I want one Submission history per Task and Enrollment with immutable sent revisions, so that corrections remain traceable.
45. As a learner and Coach, I want a new revision to supersede earlier undecided revisions, so that Review targets current pending work.
46. As a Coach, I want to approve a specific revision or request changes with feedback, so that the learner receives an explicit assessment and next step.
47. As a coached learner, I want to send corrections as a new revision when I have Access, so that previously submitted evidence remains unchanged.
48. As a coached learner, I want to reuse project evidence through a separate Submission and Review for another Task, so that each outcome is assessed independently.
49. As a coached learner, I want an earlier valid Approval to remain effective when I submit an improved revision, so that further work does not erase an accepted result.
50. As a Coach, I want a new revision to require its own Review even when an earlier one was approved, so that acceptance always identifies the assessed contents.
51. As a Coach, I want to revoke a specific Approval with a recorded reason, so that I can correct an assessment while retaining its history.
52. As a coached learner, I want Mastery reevaluated from remaining valid Approvals after a revocation, so that the current status reflects valid evidence.
53. As a coached learner, I want independently supported Mastery on another Skill retained when a prerequisite loses Mastery, so that a dependency change does not erase valid assessment.
54. As a Coach, I want Task rewards to contribute once while at least one valid Approval remains, so that repeated approved revisions do not inflate XP.
55. As a coached learner, I want the final Approval's revocation to remove its Task reward and a later valid Approval to restore it, so that XP follows valid assessment without duplication.
56. As a Coach, I want XP Thresholds to use only the relevant Enrollment's XP, so that personal learning and other Enrollments do not bypass my Path's requirements.
57. As a Coach, I want to grant an Access Override for one Skill in one Enrollment with a brief reason and automatic audit details, so that I can accommodate an individual learner.
58. As a Coach, I want to revoke that override with a reason while retaining work, XP, and Mastery, so that normal Access rules can resume without erasing history.
59. As a coached learner, I want work sent with valid Access to remain eligible for Review after losing Access, so that legitimate submissions can still contribute to achievement.
60. As a Coach, I want to deactivate an Enrollment with a recorded reason, so that I can stop new learning activity while preserving its records.
61. As a coached learner, I want to deactivate my own Enrollment without a required reason, so that I can stop participating.
62. As a learner and Coach, I want eligible pending revisions reviewable after deactivation while drafts remain private, so that assessment can finish without reopening participation.
63. As a Coach, I want explicit reactivation with a recorded reason to restore the same Enrollment, so that resumption preserves its Version and progress.
64. As a learner, I want repeated invitations and Skill overrides to respect Enrollment Deactivation, so that only the defined reactivation action resumes participation.
65. As a learner, I want my Coach's authority limited to their Workspace and self-approval prevented, so that assessment cannot be performed by an unrelated or self-reviewing actor.
66. As a Learning Path author, I want content with progress history archived instead of permanently deleted, so that evidence and learning records remain traceable.
67. As a learner, I want Archival itself to preserve XP, Mastery, and existing visibility boundaries, so that removing content from active use does not silently erase achievement or expose work.
68. As a Learning Path author, I want one flat, manually positioned card per Skill, so that the canvas directly represents the Path.
69. As a Learning Path author, I want selection, box multiselection, and dragging a selection, so that I can arrange related Skills together.
70. As a canvas user, I want pan and cursor-anchored zoom with mouse or trackpad input, so that I can navigate a large graph predictably.
71. As a Learning Path author, I want to create and delete Prerequisite connections through the editor, so that I can change editable learning dependencies.
72. As a Learning Path author, I want editor undo and redo with one drag represented by one step, so that correcting an arrangement is predictable.
73. As a canvas user, I want card selection to open the correct Skill and Task in the React sidebar, so that navigation leads directly to learning content.
74. As a Coach, I want to update a published Version's shared card positions independently of learning content, so that I can improve readability for existing learners.
75. As a coached learner, I want to navigate the latest shared layout without changing its card positions, so that the Coach and learners refer to the same arrangement.
76. As a canvas user, I want camera state saved locally for my Account and Path context, so that my navigation does not move someone else's view.
77. As a Learning Path author, I want completed edits saved automatically and stale saves rejected while retaining local changes, so that another tab does not silently overwrite my work.
78. As a learner, I want local recovery for drafts and unsaved editor work, so that an interruption does not unnecessarily discard them.
79. As a learner, I want Submission, Review, and XP success reported after backend confirmation, so that the interface reflects durable learning activity.
80. As a canvas user, I want labels aligned with cards while panning, zooming, and dragging, so that I can identify Skills accurately.
81. As a keyboard user, I want a Skill/Prerequisite list leading to Tasks, Submissions, and Reviews even without WebGPU, so that learning activities remain reachable.
82. As a canvas user, I want renderer failure to preserve my document and offer recovery or retry with list navigation, so that GPU failure does not erase my work.
83. As a Learning Path author, I want local save and restore to preserve Skill identities, positions, connections, and associated Task contents, so that the editor and learning panels remain consistent after reload.
84. As a canvas user, I want responsive pan, zoom, and drag on the agreed reference workload, so that a substantial Path remains usable.
85. As a learner and Coach, I want retries and competing requests to preserve one coherent learning history and correct rewards, so that timing does not alter progression or privacy.

## Implementation Decisions

1. **Delivery order and scope.** Implement P1 first, evaluate its functional and performance gates, and then implement P2. The remaining MVP stories are subsequent product slices. Treat the prototype results as evidence for the chosen architecture; a failed gate requires a fix or an explicit design reassessment before widening implementation. Neither prototype is already built, and this spec does not claim a completed application.

2. **Existing application and new modules.** Retain the React/TypeScript application and Bun/Hono backend as the application starting points. Add a custom Rust editor compiled to Wasm, wgpu/WebGPU rendering with WGSL, browser integration, and PostgreSQL-backed learning behavior. Separate the pure editor core, renderer, browser adapter, React application data/UI, and backend domain/persistence responsibilities. Low-level graphics libraries are allowed; a replacement editor framework is outside the agreed architecture.

3. **Contextual identity and ownership.** One Account supports contextual Coach and Learner roles. Every Account has exactly one owner-only Personal Workspace. Each coach-mode Learning Path belongs to exactly one Coach Workspace; each Coach Workspace has one owning Coach who manages all contained Paths and Reviews. The owner cannot hold a learner Enrollment in any Path in that Workspace during the MVP. Authority is evaluated for the target context and action, rather than a global Coach account type.

4. **Learning definitions and identity constraints.** A Learning Path contains its goal, Skills, Prerequisite Graph, Tasks, and progression rules; there is no additional curriculum container. Each Skill belongs to one Path and each Task to one Skill. Independent reuse copies definitions and assigns new logical IDs, including new IDs for copied Tasks. Logical Skill and Task IDs remain stable across Versions within a Path, with version-specific definitions. Matching IDs never transfer Enrollment progress. Express these ownership and identity constraints in persistence, without prescribing a particular table layout or identifier encoding here.

5. **Prerequisite invariants.** Both modes use a directed acyclic graph, allowing branching and multiple Prerequisites with ALL semantics. Each Prerequisite is satisfied by current Mastery of its source Skill. Connections stay within one Learning Path and, in coach mode, one Version. Reject cycle-creating edits immediately, leaving the previous valid graph unchanged. Backend validation still protects authoritative content writes.

6. **Optional work and publication.** A Coach may designate Optional Skills and Enrichment Tasks. An Optional Skill cannot be a Prerequisite for a required Skill. Before publishing a Version, establish that every required Skill can be completed through Required Tasks on required Skills alone. Include both Mastery dependencies and XP Thresholds in this validation; locked work cannot pay for its own unlock, and optional work or Access Overrides cannot rescue a blocked required route. Explain rejected publication with the affected Skills and unmet requirements. Drafts may be incomplete; an empty Required Task set never grants coach-mode Mastery.

7. **Versions, admission, and layout.** All published learning content and rules are immutable, including typo corrections. Content changes produce a new Draft and published Version. Existing Enrollments remain pinned to their original Version; new Versions serve new Enrollments. A Coach may independently close or reopen a published Version to new Enrollments. Each Version has a shared Canvas Layout whose positions the Coach may change without altering learning content; learners see the latest layout on reopening and may pan, zoom, and select, but cannot reposition cards.

8. **Enrollment contract and uniqueness.** Invitations identify exactly one published Version and one email address. Acceptance requires the Account's matching verified email. Enforce at most one Enrollment per Account and Version, including under retries and competing acceptances. Repeated invitations retain the existing Enrollment and progress, and never reactivate an inactive Enrollment. Closure blocks creation of new Enrollments from unaccepted invitations while retaining existing participation under its current status.

9. **Separate Access, Mastery, and XP.** Access permits starting Tasks and submitting work. Current Prerequisites and any XP Threshold continue to apply after a Skill has been opened or started. A Locked Skill remains visible with its title, outcome, and lock reason. Gaining Access does not spend XP or award Mastery. Losing Access preserves existing work and independently valid Mastery. Coach-mode Access additionally requires an active Enrollment.

10. **Personal Mastery and override.** Personal users may declare Mastery or leave it unclaimed regardless of actual proficiency, without mandatory evidence or Review. Completing Tasks does not automatically declare Mastery; declaring Mastery grants no XP. An explicit personal Access Override waives both Prerequisites and the XP Threshold for one Skill without requiring a reason, changing score, or marking other Skills mastered.

11. **Personal XP and corrections.** The user sets Task rewards; a complete Task contributes its current configured reward and an incomplete Task contributes zero. Repeated actions do not multiply the contribution. Undoing completion removes the reward; completing again restores the current reward. Editing a completed reward from 20 to 50 records a +30 correction; a later undo removes 50 and a later completion restores 50. An incomplete Task still contributes zero when its reward changes. Corrections do not change personal Mastery. Access checks use only current XP from the same personal Learning Path; a decrease can relock work unless an Access Override applies.

12. **Coach Mastery.** A Skill requires a nonempty set of Required Tasks. Mastery is awarded automatically when every Required Task has at least one valid Approval within the learner's Enrollment, with no separate Skill-level sign-off. Enrichment Tasks do not block Mastery. Revoking an Approval triggers reevaluation from remaining valid Approvals; retain Mastery if requirements still hold, otherwise revoke it while preserving award history. Loss of prerequisite Mastery may change dependent Access but does not automatically revoke dependent Mastery supported by its own valid evidence.

13. **Submission identity, privacy, and revision transitions.** Enforce at most one Submission per Task and Enrollment, containing successive immutable Submission Revisions. Editable, saved Submission Draft contents are visible only to the learner. Sending captures a revision; a newer revision supersedes earlier revisions of the same Submission that have no Review decision. A superseded pending revision cannot receive a decision. The same project evidence for another Task requires a separate Submission and Review; Approval does not transfer between Tasks.

14. **Evidence boundary and Review outcomes.** MVP evidence consists of text and URLs. Revision immutability freezes the submitted text and URLs, not content hosted at the destination. Where stable evidence is needed, the Coach requests version-specific links or important content copied into the Submission. Review identifies exactly one revision and has one of two outcomes: Approval or Changes Requested. Changes Requested requires feedback, and corrections require a new revision sent with valid Access.

15. **Existing Approvals and correction history.** A learner with Access may send a new revision after Approval. Existing valid Approvals continue supporting their Task and Mastery; the new revision is independently reviewed and does not inherit Approval. Only an authorized Coach may explicitly revoke a particular Approval, with a mandatory recorded reason. Keep the original decision and correction history. Work sent with valid Access remains reviewable and potentially contributes to XP/Mastery after Access is lost, provided its pending revision has not been superseded.

16. **Coach XP contribution.** A Task's coach-configured reward contributes once to an Enrollment while at least one of its submitted revisions has valid Approval; otherwise it contributes zero. Additional approved revisions never multiply it. Revocation of the last valid Approval records removal of that reward; a later valid Approval records restoration without duplication. Thresholds use current XP from that Enrollment only, excluding personal XP and other Enrollments. Falling below a threshold can relock an already started Skill while preserving work, eligible Reviews, and independently supported Mastery.

17. **Coach Access Overrides.** A Coach may waive both Prerequisites and the XP Threshold for one Skill and Enrollment. Grant and revocation require a brief reason and an automatic record containing the action, Coach, learner, Enrollment, Skill, and time. The action does not change XP, Mastery, or another Enrollment's rules. Revocation restores ordinary Access evaluation and retains history. An override never bypasses Enrollment Deactivation.

18. **Enrollment lifecycle.** The owning Coach may deactivate an Enrollment with a recorded reason; its learner may self-deactivate without a required reason. Inactivity prevents new Task starts and new Submissions or revisions. Eligible, unsuperseded work sent while active and with valid Access remains reviewable, and its Approval can still affect XP and Mastery. Deactivation itself removes no XP, Approval, or Mastery. Only the owning Coach may explicitly reactivate with a recorded reason, retaining the same Version and progress and reevaluating current Access.

19. **Visibility and Archival.** An Enrollment's progress, XP, Mastery, submitted work, and Review results are visible only to its learner and the owning Coach. Unsent Submission Draft contents remain learner-only, including after deactivation or Archival. Permanent learning-content deletion is allowed only without progress history; otherwise archive it while retaining Submissions, Reviews, XP, Mastery, and references under their existing visibility rules. Archival itself does not remove XP or revoke Mastery and cannot mutate a published Version. Local recovery obeys the same Account and Workspace boundaries.

20. **Durable domain operations.** Backend authority covers learning content writes, publication, invitations/Enrollments, Task completion/reward corrections, Submission sending, Review, Approval Revocation, and Access Overrides. Inputs must identify the relevant learning context and, where applicable, exact content or Submission revision; derive acting authority from the trusted request identity. Reject unauthorized or stale operations without partial learning effects. Preserve the specified uniqueness and idempotent reward outcomes under retries and concurrent requests. Persistence must keep decisions, reward corrections, and resulting learning state coherent; concrete transaction design, routes, and request encoding are implementation choices.

21. **Editor state ownership and interface.** Rust owns the active Canvas Document, cards, connections, positions, camera, selection, and undo/redo. React owns application UI and learning-domain data; it does not keep another authoritative set of card positions. Use defined command/event structures with inspectable JSON initially. Pointer input uses compact calls; entire-scene transfer belongs to operations such as load/save rather than each pointer movement. Measure boundary costs before introducing a binary protocol.

22. **Engine modules and geometry.** The pure editor core owns documents, interaction, and geometry without DOM or GPU dependencies. The wgpu renderer owns graphics, and a browser adapter translates input and application communication. Research starting points are central ownership through IDs, an explicit interaction state machine, distinct world/CSS/framebuffer coordinates, CPU bounding-box and curve-distance hit tests, and linear scanning before profiling justifies an index. These starting points are not measured results or a fixed low-level API contract.

23. **Canvas interactions.** Use one flat card per Skill, manual layout, selection, box multiselection, dragging a selection, pan, cursor-anchored zoom, connection creation, deletion, and undo/redo. Connections initially use one Bezier style. Initial parameters are 10%–400% zoom and world bounds of -1,000,000 to +1,000,000 on each axis, to be exercised in P1. Editing operations obey content ownership, version immutability, graph validity, and retention rules.

24. **Undo and view state.** One completed drag gesture is one undo step. Undo/redo applies to editable editor documents, while Reviews, XP, Mastery, and Enrollments use domain actions. Undoing a saved edit produces a new backend-validated change rather than rewinding durable history. Save camera state locally per Account and Path context. Selection, in-progress dragging, and undo history are session-only; shared Canvas Layout excludes personal navigation state.

25. **Rendering, navigation, and recovery.** Render card geometry, connections, grid, and selection with WebGPU. Position HTML labels from engine data and edit text through React. Target desktop/laptop mouse, trackpad, and keyboard use in a WebGPU-capable browser. Also provide a keyboard-accessible Skill/Prerequisite list leading to Tasks, Submissions, and Reviews when the canvas is unavailable; card positioning still uses the canvas. Preserve the CPU-side document on device loss or renderer failure, attempt renderer recreation, and expose retry and list navigation if recovery fails.

26. **Snapshots and concurrency.** An editor snapshot contains a format version, Skill references, positions, and connections. Task contents, Submissions, XP, and Mastery remain separately owned and persisted. Prerequisite connections have one authoritative persistence source, not two independently maintained graphs. Distinguish serialization format version, expected save revision, and Learning Path Version. Autosave after completed operations, combining nearby changes; reject stale expected revisions while retaining local work for recovery. A layout save cannot overwrite learning records or mutate published content.

27. **Online behavior and local recovery.** Prioritize online use with local recovery for drafts and unsaved editor changes. Submission, Review, and XP changes are successful only after backend confirmation. Restore coherent editor and associated application state without mixing owners. P1 uses local fixtures and checkpoints; that proof does not establish backend persistence, production authentication, or full offline learning.

28. **P1 required flow.** Initialize real Rust/Wasm/WebGPU rendering; pan and zoom; create, select, and drag Skill cards; create connections and reject cycles; select a card and edit one simple associated Task through the React sidebar; exercise editor undo/redo; save locally and reload. Include aligned HTML labels, keyboard/list selection to the Task, renderer-failure recovery, and the primary benchmark. Restored state must preserve IDs, positions, connections, and separately owned Task contents. Box multiselection and the rest of the full MVP interaction surface need not expand this first acceptance boundary.

29. **P2 required flow.** After P1 passes, use a small backend and PostgreSQL with controlled actor/content fixtures to exercise Enrollment → Submission → Approval → XP/Mastery → Approval Revocation. Include duplicate operations, stale revisions, unauthorized actions, privacy boundaries, and relevant lifecycle effects. A full production Coach dashboard and authentication-provider integration are not required to test these rules. Keep fixture identity explicitly separate from production authentication.

30. **P1 performance contract.** The primary workload is 1,000 cards, approximately 200 visible cards, and 2,000 total connections. During pan/zoom/drag, require p95 frame time at most 20 ms and p95 input-to-visible-response latency at most 50 ms on a recorded reference environment. Include HTML labels and report actual visible card, label, and connection counts. Use 100-card and 10,000-card workloads for comparisons; 10,000 is exploratory, not promised capacity. Both functional checks and measured targets must pass before P1 is complete.

## Testing Decisions

1. **Test seams already agreed.** Use the highest useful public boundary for each proof: browser-visible editor/application behavior for P1, and backend request/response behavior backed by real PostgreSQL for P2. Add focused native tests through the pure editor core's public commands and outputs for geometric and interaction invariants. These are the P1/P2 and native-core boundaries accepted during design. Prefer existing application boundaries over exposing internal helpers solely for tests.

2. **Good-test standard.** Exercise observable outcomes, accepted/rejected operations, restored data, and visibility. Avoid tests coupled to React internals, private Rust structures, shader implementation, SQL statement order, or mocked calculations that merely repeat the implementation. Drive domain scenarios through the same behavior boundary used by the application; isolated tests can supplement but cannot prove persistence concurrency or actual rendering.

3. **Existing prior art.** Repository inspection found a React application starter, an exported Hono application with a greeting endpoint, and no feature test suites, test scripts, Rust crate, or database integration. Reuse the browser application and backend request boundaries; establish the new native-core and PostgreSQL test harnesses as part of their respective proofs. A test framework or browser runner has not been selected by this spec.

4. **P1 integration acceptance.** In a real WebGPU-capable browser, exercise rendering → card creation/selection/dragging → connection editing → sidebar Task editing → undo/redo → local save → reload. Assert correct Skill/Task association and semantic preservation of IDs, positions, connections, and Task contents; JSON property order is irrelevant. A list-only fallback or mocked renderer cannot satisfy the real rendering check.

5. **Core invariants.** Test world/screen round trips, cursor-anchored zoom, preserved drag offsets, initial coordinate/zoom limits, valid-edge acceptance, unchanged graph on cycle rejection, and one undo step per completed drag with redo restoring its result. Prefer commands and public state/output queries over reaching into private geometry storage.

6. **Recovery and keyboard behavior.** Exercise GPU device loss or renderer failure. Confirm the CPU-side document survives, renderer recreation can redraw it, and failed recovery leaves retry and list navigation usable. Check labels remain aligned during camera and card movement. Verify keyboard selection reaches the correct Skill and its Task without WebGPU; the broader MVP list must also reach Submissions and Reviews when those features exist.

7. **Performance evidence.** Record CPU, RAM, GPU, operating system, browser, viewport, device pixel ratio, display refresh rate, fixture, and interaction sequence. Report warm-up handling, sampling duration/count, actual visible counts, and measurement method. Distinguish event-processing/render-submission time from a visibly presented response and document limitations. Apply the agreed 20 ms and 50 ms p95 gates to the primary workload; record comparison workloads and report initialization time, memory, draw calls, and upload volume as diagnostics with no invented pass thresholds.

8. **P2 reference scenario.** Use a published Path with required Skills A and B. A has a Required Task worth 20 XP; B requires Mastery of A and 20 Enrollment XP and has its own Required Task. Initially B is locked. Approving A's Task grants one 20-XP contribution, awards Mastery of A, and opens B without spending XP. Revoking A's final valid Approval removes the contribution, reevaluates Mastery, and relocks B under ordinary rules while retaining history. If B already has independently valid Mastery, that Mastery remains.

9. **Submission and Review races.** Demonstrate one Submission per Task/Enrollment, immutable sent contents, and rejection of a decision against a superseded pending revision. Test the public result of competing revision sends and Review decisions according to which operation became authoritative first. A new revision after Approval preserves the earlier Approval; approving additional revisions never multiplies the reward. Revoking one of multiple valid Approvals retains the contribution until the last is revoked.

10. **PostgreSQL-backed integrity.** Run repeated and competing Enrollment, reward-producing, and correction operations through the backend and read back their effects. Establish one Enrollment per Account/Version, one Submission per Task/Enrollment, correct Task contributions, and preserved decision history. Failed or unauthorized actions must not leave partial XP/Mastery effects. Calculation-only tests and mock databases are insufficient evidence for this gate.

11. **Lifecycle and Access.** Test current Prerequisites, XP Thresholds, and scoped Access Overrides, including loss of Access after work starts. Coach and learner deactivation both block new work; an override or invitation cannot reactivate participation. Previously eligible, unsuperseded revisions remain reviewable and can affect XP/Mastery while inactive. Coach reactivation with a reason retains Version and progress and reevaluates Access. Verify required reasons and automatic override audit details at the public behavior boundary.

12. **Authority and privacy.** Test the owning learner, owning Coach, a peer, another Workspace's Coach, and an unrelated Account. Reject unauthorized reads and mutations, self-Enrollment in an owned Coach Workspace, self-approval, and Coach access to unsent drafts. Verify Personal Workspace privacy and retention of draft privacy after deactivation/Archival. Production invitation integration must enforce the matching verified email and closed-Version rule; controlled P2 fixtures do not prove email delivery or provider integration.

13. **Personal correction scenario.** Test independent personal Mastery, explicit override, optional evidence, and Path-local XP. A completed Task changing from 20 to 50 contributes a recorded +30 correction; undoing completion removes 50, completing again restores 50, and repeated actions do not multiply it. An incomplete Task contributes zero when its reward changes. Threshold reevaluation may change Access, but these actions never automatically change declared Mastery.

14. **Required progression and immutable versions.** When the authoring/publication slice is implemented, test that only Required Tasks on required Skills can fund the required route, no Skill funds its own unlock, cycles and cross-Path dependencies fail, and empty Required Task sets never yield Mastery. Include a blocked route with only 60 reachable required XP and a next requirement of 100, even if optional work offers the difference. Verify that typo edits require a new Version, shared position changes do not, old Enrollments remain pinned, and independent copies receive distinct identities without inherited progress.

15. **Save conflicts and retention.** At backend persistence integration, exercise two saves based on the same expected revision: stale state must not overwrite accepted state, and the application must retain the rejected local work. Verify layout saves cannot modify learning history or immutable published content. Test that content with history is archived rather than permanently deleted and that Archival alone preserves XP/Mastery and visibility.

16. **Completion evidence.** P1 passes only when its required flow, semantic restoration, one-drag undo behavior, renderer recovery, and measured primary performance targets all pass. P2 requires actual PostgreSQL-backed results for its core flow, duplication/race handling, and authority checks, plus the personal reward-correction behavior. Record which checks ran, which failed, and which belong to later MVP slices. Passing a prototype does not establish that all product stories or production integrations are complete.

## Out of Scope

- Realtime multiplayer, collaborative editing, and a default CRDT architecture.
- Replacing the custom engine with React Flow, tldraw, Konva, Fabric, PixiJS, or another editor framework.
- Mobile/touch canvas interaction and a WebGL renderer for the MVP.
- Nested canvas groups, automatic layout, snapping, cross-Path clipboard operations, and multiple connection styles.
- Learner-specific shared-layout variants, cross-device camera synchronization, and undo-history restoration after reload.
- Cross-Path or cross-Version Prerequisites, enrollment/progress migration, shared mutable Skill/Task definitions across Paths, and separate fresh attempts within the same Account/Version.
- Multiple Coaches in one Coach Workspace, personal-workspace sharing, peer review, peer work visibility, leaderboards, and coach-mode self-approval.
- Direct file uploads, automatic archiving of external evidence, numeric grades, permanent Review rejection, and parallel Submission attempt threads for one Task/Enrollment.
- Mandatory evidence or verified proficiency for personal Mastery, automatic personal Mastery from completion, XP spending on unlock, and a separate spendable currency.
- Full offline Submission/Review/XP completion and a complete production learning application inside either narrow prototype.
- A custom binary engine protocol, advanced GPU text subsystem, spatial index, or other optimization without evidence that the initial approach needs it.
- A promise that 10,000 cards is supported product capacity; only the primary workload has agreed performance gates.

## Further Notes

- This spec synthesizes the research and the accepted design decisions through Q82. It preserves the domain glossary and ADRs 0001–0018. The personal-mode freedom, optional coached work, and different Task designs for the same subject are deliberate product choices.
- The published spec is self-contained so it can guide work even before local design documents are committed. Maintain consistency with the glossary, ADRs, prototype plan, and validation plan when a later decision changes behavior.
- A `ready-for-agent` label means work can begin with P1 under the stated sequence. It does not mean either prototype has passed, nor that all MVP stories should be implemented in that first proof. Break subsequent implementation into separately reviewable slices without changing these invariants.
- The reference device, concrete package versions, GPU buffers and curve tessellation, anti-aliasing, tracing, local-storage mechanics, API route names, and physical database schema remain implementation choices. Record measurements before drawing performance conclusions.
- Production authentication and email delivery are later integrations. Invitation expiry, detailed archive presentation/restoration, broader Account/Workspace lifecycle policies, and time-based Mastery expiry were not decided. The prototypes exercise the specified explicit correction and revocation rules; they must not introduce those unsettled product policies silently.
- Principal open risks are HTML-label cost/alignment, browser/GPU startup and recovery, consistency across editor/application persistence, stale writes and reward races, privacy through recovery/archive paths, and external evidence that can change or disappear. The two prototypes provide evidence for the technical risks; submitted text/URL immutability remains the accepted limit for external evidence.
