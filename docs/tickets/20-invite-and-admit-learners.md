## Parent

https://github.com/harkon666/Gurow/issues/1

## What to build

From a published Path, let the owning Coach send an Invitation to a particular email and let the matching verified Account accept it in the application. Connect real invitation delivery and identity to the proven Enrollment contract, and provide admission closure/reopening for that Version.

Stage: MVP. Spec coverage: US37, US38, US39, US40, US64, US65.

## Acceptance criteria

- [ ] The Coach addresses an Invitation to one email and one published Version, with a usable delivery-and-acceptance flow through the selected email integration.
- [ ] Only a trusted Account with the matching verified email can accept, creating participation only in the offered Version.
- [ ] Repeated acceptance reuses the existing Enrollment and progress, while inactive participation remains inactive and owner Enrollment in an owned Coach Workspace is rejected.
- [ ] Closure blocks new Enrollment creation from pending invitations; reopening permits it, and existing Enrollments keep their current status throughout.
- [ ] The UI shows backend-confirmed acceptance or the relevant admission/identity failure, without introducing an unagreed invitation-expiry policy.
- [ ] Integration evidence covers delivery to the acceptance flow, verified identity, retries, closed admission, and unrelated-Account rejection; record any external setup still required rather than claiming it worked.

## Blocked by

- [#20](https://github.com/harkon666/Gurow/issues/20) — Publish a completable Version and preserve its learning contract
