# Gurow Graphify workflow

The Gurow brain lives at `~/Dev/brain/projects/Gurow`. It contains repository
snapshots and a derived knowledge graph; implementation changes belong in the
original repository. GitHub remains authoritative for current issue status.

## Navigate

1. Run the `status` command of `scripts/graphify_brain.py` with the repository
   and brain paths. Use the Python interpreter recorded in the brain's
   `graphify-out/.graphify_python` for commands that require Graphify.
2. For a current build, run `graphify query "<symbols or concepts>"` from the
   brain directory. Start with vocabulary in the graph, and inspect the
   returned source paths and locations. Use `path` or `explain` to narrow a
   result; a query truncated by its token budget is incomplete.
3. Read the corresponding current repository files before editing. A graph
   relation is a navigation hint. `EXTRACTED` identifies an explicit source
   relation; `INFERRED` and `AMBIGUOUS` require supporting evidence. Spec nodes
   describe requirements, not proof that a feature is implemented.

If status reports source drift, partial publication, missing coverage, or a
pending update, treat the graph as historical. Continue with current source
searches when an update is outside the task; report the limitation.

## Refresh

Use `scripts/graphify_brain.py --help` for the maintenance entry point. The
workflow is prepare, semantic extraction, build, then status:

1. **Prepare** selects the approved source corpus and freezes copies with
   content hashes. Review its included/excluded files and semantic request.
   New approved Markdown/code files are eligible even before a Git commit;
   ignored files, credentials, dependencies and generated outputs stay out.
2. **Extract** each requested document against the frozen snapshot using the
   Graphify skill and its extraction schema. The current agent can perform
   semantic extraction without an external API key. Reuse semantic results
   only for matching source and extraction-prompt hashes. An AST-only update
   does not satisfy pending document coverage.
3. **Build** combines fresh AST extraction and verified semantic fragments,
   preserves all raw relations, and generates the directed query graph,
   health report and visual/report outputs as one identified generation.
   Failed validation leaves the prior published generation available and
   the new generation incomplete.
4. **Verify** source coverage, output hashes, source drift, and the fixed query
   checks. Read several returned locations in their real source files. Only
   a complete verified generation can clear the pending-update marker.

Review warnings for unresolved endpoints and collapsed parallel relations.
Keep `all-relations.json` as the raw evidence; the directed query graph can
collapse several facts between the same pair of nodes. Raw warning counts are
not automatically bugs in Gurow and must not be silently repaired by inventing
nodes or edges. Token usage without host telemetry is unknown, not zero.

## Scope and maintenance

The pipeline's source policy is authoritative for inclusion. Self-contained
`*.issue.md` publication bodies repeat the same contract and are excluded;
canonical L3 execution packets and their manifest provide ticket context.
Source-only anchors for unsupported formats preserve discoverability without
claiming symbol or semantic extraction.

Maintain one generation identity across graph, raw relations, coverage,
diagnostics and build metadata. Preserve backups before publication. Refresh
after a coherent group of source changes; inspect drift again if another
agent is editing the repository concurrently. Avoid bare code-only CLI updates
on this managed brain, because they bypass its generation and coverage checks.
