## What changed

Describe the user-visible behavior and the exact files changed.

## Safety boundary

State whether the change can perform real requests, OAuth, service control, git mutation, or writes outside a temporary sandbox. Confirm that no credentials, account identifiers, or local machine paths are included.

## Verification

- [ ] `npm run test:ci`
- [ ] Positive case covered
- [ ] Reverse/fail-closed case covered
- [ ] Documentation updated when behavior or compatibility changed
