# Changelog

## 1.2.1

- Repository publication hardening and release maintenance.

## 1.2.0

- Extract lock management into `lib/locks.js`.
- Keep production lock reclaim fail-closed: only a proven-dead owner is removed automatically. Unparseable lock JSON, unverifiable owners, invalid lease metadata, and expired live leases are reported, not deleted.
- Have `doctor` list lock ID, scope, age, owner state, and reason without changing `pass` for blocking locks.
- Add read-only `grok-worker locks inspect` and exact-id confirmed `grok-worker locks cleanup --id <lockId> --confirm <lockId>`, with audit records and inspect-to-delete race refusal.
- Add full English documentation, lint/type/coverage quality gates, Dependabot, CodeQL, and reproducible GitHub release automation with artifact attestations.
- Add an OIDC-ready manual npm publish workflow. Publishing remains operator-gated until the package's npm trusted publisher is configured.
- Remove two polynomial path-pattern regular expressions and read billing logs through a stable file descriptor to close CodeQL findings.

## 1.1.0

- Add a read-only Grok CLI presence check to `doctor` while preserving the existing Provider-health `pass` field.
- Add Windows CI for Node.js 22 and 24, with deprecations treated as failures.
- Add public hygiene checks, security and contribution guidance, issue forms, and a pull request template.
- Add an English quick start and explicit npm package contents.
- Remove historical private identifiers from public material.
- Make release manifests and archives reproducible from the tagged source commit.
