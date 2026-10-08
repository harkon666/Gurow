## Agent skills

### Codebase navigation

For cross-file code or architecture exploration, read [the Graphify workflow](docs/agents/graphify.md). Check graph freshness, use the Gurow brain to locate sources, and verify findings against the current repository before editing.

### Issue tracker

Publish and retrieve specs and tickets through GitHub Issues for `harkon666/Gurow`. Read [the tracker conventions](docs/agents/issue-tracker.md) before tracker operations.

### Triage labels

Use the canonical triage labels, including `ready-for-agent` for agreed specs. Read [the label mapping](docs/agents/triage-labels.md) when applying triage labels.

### Domain docs

This project uses one domain context. Before domain exploration, specification, or implementation, read [the domain documentation rules](docs/agents/domain.md), the glossary, and relevant ADRs.

### Tests

New behavior comes with tests at the seam that proves it: unit tests for pure domain logic, backend tests against real PostgreSQL for authorization and persistence, and a browser check for user journeys. For a bug, first make a test fail on it. Run `scripts/check.sh quick` while working and `scripts/check.sh full` before committing; report failures and skipped checks as they are. A new browser check uses its own ports and `gurow_<name>_browser_test` database, takes `--skip-build`, and is added to `BROWSER` in `scripts/check.sh` and to [the regression audit](docs/validation/regression-audit.md). The headed P1 performance capture is opt-in (`cd frontend && bun run capture:p1`) and never part of these checks.
