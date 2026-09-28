# T06-L3-07 — Review the evidence and decide the P1 gate without hiding failures

Status: approved execution packet, published as [#40](https://github.com/harkon666/Gurow/issues/40); implementation pending. Parent: [#7](https://github.com/harkon666/Gurow/issues/7). Contract: [gurow-p1-v1](../../benchmarks/p1/contract.md).

Executor recommendation: **Strong independent reviewer / integrator**. Blocked by: **T06-L3-06**. Parent coverage: AC1, AC2, AC3, AC4, AC5. User stories: US80, US82, US83, US84.

## Observable outcome

Independently review actual source, measurement validity, functional results and all original criteria, then record a justified PASS/FAIL/NOT_MEASURED decision and bounded follow-up work where needed.

## Scope

Review and decision based on the completed evidence packet. This packet does not prescribe speculative optimizations or authorize changing thresholds. Any measured bottleneck becomes a separate bounded fix task with repro/targeted regression, followed by a new complete source-matched verification series.

## Required inputs

- Canonical #7 and its original five ACs, not only child checklists.
- L3-06 harness packet and all raw/profile/source artifacts.
- Collector qualification and synthetic reducer rejection cases, including preserved unsuccessful attempts.

## Source pointers and file ownership

Pointers were inspected at `0a3b9be96a8ef89ce74a22d011ce7e9ba49e996d`; verify current source before editing. New paths below are proposed implementation locations, not claims they exist.

- `.harness/review.md and raw runs (read)`
- `docs/validation/t06-gate-report.md (new reviewed result)`
- `docs/validation/t06-gate-report.json (new reviewed result)`
- `docs/tickets/t06-l3/README.md (status evidence references only)`

## Acceptance criteria

- [ ] Review Standards and Spec independently in fresh contexts under the repo workflow, including instrumentation, test changes, trace qualification and raw-to-p95 reproducibility.
- [ ] Verify all primary scenarios/runs meet both original thresholds and that real presentation, labels, workload, current source and environment evidence are valid; inspect failed/invalid attempts.
- [ ] Verify AC1 functional paths, AC3 method/environment, AC4 comparisons/diagnostics and AC5 honest failure handling; all planned checks are distinguished from executed evidence.
- [ ] For a failure, record the bottleneck/evidence and issue a separately bounded corrective task or design reassessment. Do not close #7 or unblock #8 while evidence is missing or fails.
- [ ] After any code fix, rerun affected checks plus final full verification on the new source and obtain independent review; do not reuse old PASS samples for changed code.
- [ ] Publish a reviewable decision report with artifact hashes, remaining gaps and review outcomes. Completing this review task can deliver FAIL/NOT_MEASURED; it is never synonymous with P1 PASS. GitHub closure is a separate authorized action.

## Planned verification commands

These commands for new scripts are an implementation contract; they are not available until the owning task creates them. Run from the repository root unless `cd frontend` is shown.

```bash
python3 scripts/harness.py status
python3 scripts/harness.py review
```

## Handoff and escalation

Independent review outcomes, final source-bound evidence report and explicit parent-gate verdict, plus concrete corrective task descriptions if necessary.

Stop/escalate: Any unresolved metric provenance, spec conflict, invalid evidence or architecture question. Keep parent gate blocked and request focused review with raw evidence.

Keep one parent T06 harness baseline once implementation starts. Focused worker checks do not replace parent full verification and independent review. Preserve original criteria and source identity.
