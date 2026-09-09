## Parent

https://github.com/harkon666/Gurow/issues/1

## What to build

Replace fixture-only access at the product entry point with a trusted sign-in flow, persisted Account identity, and the user's private Personal Workspace. Select and record the concrete authentication integration as an implementation choice while keeping new Account lifecycle policies outside this slice.

Stage: MVP. Spec coverage: US01, US02, US03, US05, US65.

## Acceptance criteria

- [ ] A browser sign-in establishes an authenticated Account backed by the chosen identity integration; the backend does not accept a client-supplied fixture Actor as authority.
- [ ] The same Account has exactly one persisted Personal Workspace across repeated sign-ins or concurrent first entry.
- [ ] Only its owner can access the Workspace through UI and backend reads/writes, including after Account switching.
- [ ] Trusted identity exposes verified-email state for the later invitation flow; unverified client input cannot claim a verified address.
- [ ] The application clearly identifies the active personal context without introducing permanent Coach/Learner Account types.
- [ ] An integration check covers sign-in, Workspace entry, reload, and rejection of another Account; record actual provider/configuration prerequisites and distinguish local test evidence from an unverified production integration.

## Blocked by

- [#15](https://github.com/harkon666/Gurow/issues/15) — Preserve progress under competing learning requests and pass P2
