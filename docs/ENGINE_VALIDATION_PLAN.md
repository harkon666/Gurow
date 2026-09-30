# Engine and domain validation plan

This records the accepted testing strategy and initial benchmark targets. These are planned checks, not completed tests or demonstrated product capacity. The agreed scopes and acceptance criteria for P1 and P2 are in [PROTOTYPE_PLAN.md](PROTOTYPE_PLAN.md).

The concrete T06 measurement design is in the [P1 benchmark contract](benchmarks/p1/contract.md), with [L3 execution packets](tickets/t06-l3/README.md). Contract `gurow-p1-v2` ([ADR 0019](adr/0019-measure-p1-responsiveness-with-frame-time-and-an-in-app-latency-proxy.md)) fixes the environment record, workload, in-app metrics, sampling and reporting rules; it replaced the stricter `gurow-p1-v1` presentation-collector/optical design on 2026-09-30. Benchmark execution is still outstanding; the L3 breakdown is published as sub-issues #34–#40. These documents do not establish that P1 has passed.

## Reference environment and workloads

Record the reference device and its CPU, RAM, GPU, operating system, browser, viewport, device pixel ratio, and display refresh rate before measuring. Use a fixed, recorded configuration for comparisons and identify the fixture and interaction sequence used.

The primary workload has 1,000 Skill cards, approximately 200 visible cards, and 2,000 total Prerequisite connections. Record the actual visible card, label, and connection counts during the sequence. Workloads with 100 and 10,000 cards provide comparisons; the 10,000-card case is exploratory rather than a promised capacity target.

For the primary workload during pan, zoom, and drag, the initial targets are:

| Metric | Target |
| --- | --- |
| 95th-percentile frame time | At most 20 ms |
| 95th-percentile input-to-frame latency (in-app proxy) | At most 50 ms |

Report sampling duration, sample count, warm-up treatment, and the measurement method. Frame time comes from animation-frame intervals. Input latency is measured from the input timestamp to the first frame after both canvas and HTML labels committed the input's state, plus one refresh interval as a presentation estimate; report that this proxy does not observe compositor or scanout time, and document other limitations. Failure to meet a target prompts evaluation of label or renderer strategy rather than a claim that the target was achieved.

## Test layers

1. Native Rust tests cover coordinate transforms, interaction behavior, and undo invariants without requiring a browser or renderer. Relevant checks include world/screen round trips, cursor-anchored zoom, drag offsets, and one undo step per drag gesture.
2. Domain tests cover authorization, progression, and prevention of duplicate rewards. Exercise the agreed boundaries for Account roles, Enrollments, revision-specific Reviews, XP corrections, and Mastery independently of canvas rendering.
3. Browser tests exercise the canvas-to-sidebar-to-save-to-restore flow. Renderer validation includes a real browser providing WebGPU; pure logic tests do not substitute for this integration check.

Additional validation should exercise the agreed recovery and visibility rules: stale saves retain local work, renderer failure preserves the CPU-side document, and the keyboard-accessible Skill list remains usable when the canvas is unavailable.

Browser and GPU testing require an additional environment and are more expensive than logic tests alone. Test reports must identify which layers ran and separate actual results from checks that remain planned.

## Prototype gates

P1 must complete its engine-to-sidebar-to-local-restore flow, preserve the document across renderer failure, and pass the primary latency targets before implementation expands to P2. Its save/restore check includes Skill IDs, positions, connections, and separately owned Task contents. Each completed drag is one undo step.

P2 then exercises the Enrollment-to-Review-to-XP/Mastery flow and Approval Revocation against PostgreSQL, including repeated actions, stale revisions, and authorization boundaries. See the prototype plan for expected results. Passing P1 does not establish that these backend rules work.
