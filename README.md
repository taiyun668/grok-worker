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
grok-worker pool bootstrap [--frozen <id|alias>,...] [--success <id|alias>,...] [--force]
grok-worker pool refresh [--real allowed]
grok-worker task init --profile <account-alias> --workspace <project-root> --objective <task> --out <capsule.json> --real allowed
grok-worker plan --profile <account-alias> --task <capsule.json>
grok-worker run --profile <account-alias> --task <capsule.json>
grok-worker deploy pointer
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
  change without breaking accounting, and reports local availability eligibility
  with **zero** real Grok requests.
- Availability layer v5 (`lib/availability.js`): frozen pool, error classification,
  probePolicy (default disabled; `when-no-active` + probe `realRequestPermission:allowed`
  enables safe probeEligible self-rescue with `maxProbesPerRun`), task-run WAL,
  multi-attempt failover, provider/global health for non-attributable faults,
  billing snapshot → `nextProbeAt` only. See `docs/contracts/AVAILABILITY-LAYER.plan.v5.md`.
- Deploy pointer: `grok-worker.cmd` / `bin/grok-worker.js` validate
  `%LOCALAPPDATA%\GrokWorkerProvider\current.json` and wire `dataRoot` /
  `registryPath` / `approvedProfileRoot` (env overrides win). Active defaults are
  Provider-owned under `%LOCALAPPDATA%\GrokWorkerProvider\`
  (`worker-provider`, `worker-profiles\profiles.json`, `codex-grok-workers`).
  Legacy `%LOCALAPPDATA%\GrokUI\...` locations are inert historical residues only
  when a valid pointer is present — never active defaults, never read/migrated.
  Release flow: write immutable `releases\<version>`, verify `manifestSha256`,
  atomic-replace `current.json` only.
- Mock suite: `npm run test:v5` (`tests/availability-harness.js`), fixture/mock only
  (includes `runTask` multi-attempt 402 failover, probe self-rescue, concurrent CAS).
- `task init` is a convenience generator for controller-owned Task Capsules; it
  does not grant permission by itself. Real model calls still require the
  capsule field `realRequestPermission: allowed`.
- Write tasks must use controller-created exclusive worktrees or strictly
  mutually exclusive file ownership. Provider profile isolation does not replace
  repository write isolation.
- The stable shim (`grok-worker.cmd`) validates `current.json` each launch and
  defaults durable roots from the pointer (or Provider-specific defaults under
  `GrokWorkerProvider` when the pointer is absent). Callers should depend on
  `grok-worker`, not on `D:\Grok UI\.codex\grok-bridge\provider\...` or a
  specific release folder. The Provider is fully file-system independent of
  Grok UI runtime trees. The stable shim rejects a pointer that omits any one
  of those three roots, rather than silently reviving a historical Grok UI path.

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
npm.cmd test
npm.cmd run test:mutation
npm.cmd run test:global
npm.cmd run test:r8
```

The G8 harness scans the production worker-caller surface and requires it to
submit Provider intent / Task Capsules rather than native Grok process details.
Account and OAuth management remain a separate product boundary; they are not a
worker-run caller.
