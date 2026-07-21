# GROK-WORKER-PROVIDER

This directory is the independent Provider v3 implementation governed by
`../GROK-WORKER-PROVIDER.plan.md`. It does not use or modify `../runtime/**`.

## Entry point

```powershell
grok-worker version
grok-worker doctor
grok-worker profiles list
grok-worker onboard --profile <account-alias>
grok-worker profiles probe --profile <account-alias>
grok-worker pool status
grok-worker task init --profile <account-alias> --workspace <project-root> --objective <task> --out <capsule.json> --real allowed
grok-worker plan --profile <account-alias> --task <capsule.json>
grok-worker run --profile <account-alias> --task <capsule.json>
grok-worker usage show --profile <account-alias> --task <taskId>
grok-worker usage export --format json
grok-worker roots list
grok-worker roots register --path <project-root>
grok-worker roots inspect --path <project-root>
```

The installed global shim is `%USERPROFILE%\.local\bin\grok-worker.cmd`, a
directory already present on this machine's `PATH`. Callers submit only a Task
Capsule; native executable paths, isolated homes, leader sockets, and Grok
flags remain Provider-owned.

## Codex-wide worker pool contract

The Provider is a Codex-wide Grok Worker pool entrypoint, not a Grok UI product
runtime feature. Any Codex project or task can use the same shim after its
project root has been explicitly registered:

```powershell
grok-worker roots register --path D:\SomeProject
grok-worker task init --profile <account-alias> --workspace D:\SomeProject --objective "Do the delegated work and return a Result Capsule." --out D:\SomeProject\.codex\grok-task.json --real allowed
grok-worker run --profile <account-alias> --task D:\SomeProject\.codex\grok-task.json
```

For read-only planning or audit work, omit `--real allowed` or pass
`--real denied`, then use `grok-worker plan` to verify argv, environment,
policy, and lock shape without sending a Grok request.

Stable cross-project rules:

- `profiles list` exposes only safe profile metadata and immutable `profileId`.
- `pool status` aggregates usage ledgers by `profileId`, so account aliases can
  change without breaking accounting.
- `task init` is a convenience generator for controller-owned Task Capsules; it
  does not grant permission by itself. Real model calls still require the
  capsule field `realRequestPermission: allowed`.
- Write tasks must use controller-created exclusive worktrees or strictly
  mutually exclusive file ownership. Provider profile isolation does not replace
  repository write isolation.
- The current shim points to this checked-in Provider install path. That is a
  machine-local installation detail; callers should depend on `grok-worker`,
  not on `D:\Grok UI\.codex\grok-bridge\provider\...`.

## Security model

- The Provider never reads, hashes, copies, or serializes `auth.json`.
- Every profile has an immutable UUID `profileId` and an isolated `GROK_HOME`
  below `approvedProfileRoot`. Identity is an optional CLI-probed snapshot and
  never a ledger key.
- Windows has no documented Grok OS sandbox enforcement. The write boundary is
  `dontAsk` plus permanent deny rules, authority-bearing project-config
  preflight, exclusive worktrees for write tasks, profile/workspace locks, and
  final tracked/untracked/ignored evidence.
- Folder trust stays enabled. The Provider never passes `--trust` and never
  sets `GROK_FOLDER_TRUST=0`; target paths in the profile trust store fail.
- Worker shell, subagents, MCP, and web are removed/denied in Provider v1.
  Controller-only acceptance commands are not exposed to the Worker.
- Streaming JSON is parsed in memory. Persistent results retain only redacted
  summaries and whitelisted numeric usage. `runUsage` means server-returned
  usage for that invocation, not official account quota.

## Account onboarding

`grok-worker onboard --profile <alias>` creates an empty isolated profile and
returns the official OAuth command plan. It never copies the default profile.
The login command is deliberately not executed without a separately authorized
interactive OAuth operation. After authentication, run `profiles probe` to set
`authReadiness.oauthReady` and refresh the model capability snapshot.

## Verification

```powershell
node .codex\grok-bridge\provider\tests\provider-harness.js
node .codex\grok-bridge\provider\tests\mutation-harness.js
node .codex\grok-bridge\provider\tests\global-pool-harness.js
node .codex\grok-bridge\provider\tests\setup-live-canary.js
```

The G8 harness scans the production worker-caller surface and requires it to
submit Provider intent / Task Capsules rather than native Grok process details.
Account and OAuth management remain a separate product boundary; they are not a
worker-run caller.
