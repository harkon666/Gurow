## Parent

https://github.com/harkon666/Gurow/issues/1

## What to build

Provide a minimal Archival action and retained-history view for learning content with progress, reusing the proven personal retention behavior and applying it to existing assessment references. Preserve published coach-mode learning contracts and avoid introducing an undecided restoration or broader Workspace lifecycle policy.

Stage: MVP. Spec coverage: US41, US42, US66, US67.

## Acceptance criteria

- [ ] Attempts to permanently delete learning content with progress history are rejected in favor of Archival; content and historical references remain available to their authorized readers.
- [ ] Archival by itself removes no Task XP contribution and revokes no Mastery, Approval, Submission, or Review; current history remains understandable after reload.
- [ ] Personal content stays owner-only, Enrollment history stays learner/owning-Coach-only, and unsent drafts remain learner-only through archived read paths.
- [ ] Published Version content cannot be removed or rewritten by archival/deletion; removing content from a later editable Draft preserves earlier Versions and Enrollments.
- [ ] The minimal UI reports retained history and honors existing edit permissions without adding archive restoration, account deletion, or ownership-transfer policies.
- [ ] Browser-to-PostgreSQL tests archive a completed personal Task and exercise retained coached evidence, blocked permanent deletion, immutable published content, and privacy.

## Blocked by

- [#18](https://github.com/harkon666/Gurow/issues/18) — Track personal completion, Mastery, rewards, and Access
- [#24](https://github.com/harkon666/Gurow/issues/24) — Review learner work and show the resulting progress
