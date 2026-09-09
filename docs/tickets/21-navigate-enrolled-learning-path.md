## Parent

https://github.com/harkon666/Gurow/issues/1

## What to build

Give an enrolled learner a complete read/navigation path from their Enrollment to its pinned Skills and Tasks through the canvas or keyboard list. Display current XP, Mastery, Access, and lock reasons using server-authoritative state while retaining Coach control of card positions.

Stage: MVP. Spec coverage: US05, US13, US14, US15, US35, US41, US56, US68, US75, US76, US81.

## Acceptance criteria

- [ ] The learner opens the Version joined by their Enrollment, sees its Skill outcomes and Tasks, and never silently switches to newer learning content.
- [ ] Current Access, Mastery, and Enrollment-local XP are distinct; Locked Skills show title, outcome, and lock reason while existing learning history remains reachable.
- [ ] Learners can pan, zoom, and select but cannot change card positions or published content through either UI or backend requests.
- [ ] Keyboard Skill/Prerequisite navigation reaches the same Task details when WebGPU is unavailable, with local camera state isolated by Account and Path context.
- [ ] Enrollment records are visible only to the learner and owning Coach; peer and cross-Workspace requests fail without exposing private data.
- [ ] Browser-to-backend tests use actual enrolled Accounts to cover pinned content, readonly navigation, lock display, keyboard fallback, and privacy.

## Blocked by

- [#21](https://github.com/harkon666/Gurow/issues/21) — Invite verified learners and control new Enrollments
