# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `harkon666/Gurow`. Use the `gh` CLI with an explicit `--repo harkon666/Gurow` argument. Publishing a spec means creating a GitHub issue; a local spec document is its editable source.

The agreed MVP parent spec is [issue #1](https://github.com/harkon666/Gurow/issues/1), with its local source in [SPEC.md](../SPEC.md). Read it when scoping implementation tickets, including the P1-to-P2 delivery gates.

The approved implementation tickets are indexed in [the ticket breakdown](../tickets/README.md), with GitHub issue links and native blockers. Use that index when choosing available work; a ticket can start when all its blocking issues are complete.

Before creating an issue, check existing issues for the same work. For multiline issue bodies and comments, write the exact Markdown to a file and pass it using `--body-file`. Read the published issue back to verify its body and labels.

Fetch a relevant ticket with `gh issue view <number> --repo harkon666/Gurow --comments`, including its labels when assessing status. Apply the mapping in [triage-labels.md](triage-labels.md).

**PRs as a request surface: no.**
