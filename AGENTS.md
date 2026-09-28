## Agent skills

### Codebase navigation

For cross-file code or architecture exploration, read [the Graphify workflow](docs/agents/graphify.md). Check graph freshness, use the Gurow brain to locate sources, and verify findings against the current repository before editing.

### Issue tracker

Publish and retrieve specs and tickets through GitHub Issues for `harkon666/Gurow`. Read [the tracker conventions](docs/agents/issue-tracker.md) before tracker operations.

### Triage labels

Use the canonical triage labels, including `ready-for-agent` for agreed specs. Read [the label mapping](docs/agents/triage-labels.md) when applying triage labels.

### Domain docs

This project uses one domain context. Before domain exploration, specification, or implementation, read [the domain documentation rules](docs/agents/domain.md), the glossary, and relevant ADRs.

### Implementation and review harness

When implementing a ticket, fixing review findings, or preparing a review handoff, follow [the harness workflow](docs/agents/harness.md). Resume `.harness/task.json` for the same ticket; pin the ticket/base once, map every acceptance criterion to observable assertions, and run current full checks before claiming readiness for independent review.
