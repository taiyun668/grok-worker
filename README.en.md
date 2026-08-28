# grok-worker

`grok-worker` is a local command-line provider that lets other AI agents invoke Grok CLI as a governed worker. It replaces manual account switching and ad hoc delegation with isolated account homes, policy-constrained task capsules, multi-account selection, and auditable run results. It requires a separately installed Grok CLI and Node.js 22+, is currently verified only on Windows, schedules only `grok-4.6`, and does not provide filesystem write isolation or official quota data.

[中文文档](README.md) · [Condensed English quick start](docs/QUICKSTART.en.md)

It turns Grok CLI into a worker that another AI agent can call under explicit safety constraints: multiple-account rotation, a separate home directory for every account, policy-bound models and permissions, and reviewable evidence for every run.

It has zero runtime dependencies and requires Node.js 22 or later.

---

## What it solves

Anyone using several AI coding CLIs eventually meets the same problem: accounts, quota, isolation, and scheduling are all managed by memory.

For Grok in particular:

- Switching accounts means logging out and back in manually, and logging out affects every caller using that account home.
- Concurrent tasks can share the same credential directory and interfere with one another.
- When another AI agent invokes Grok, nothing inherently prevents it from selecting the wrong model, editing the wrong files, or printing credentials into logs.
- After a run, it can be difficult to prove which account and model were used or what changed.

`grok-worker` brings these concerns into one CLI. Every account is a profile with an isolated `GROK_HOME`; every task declares its contract in a capsule; every run produces a result capsule.

---

## Before you start

This project drives Grok CLI; it does not bundle it. You need:

1. Grok CLI installed: run `npm i -g @xai-official/grok` and verify that `grok --version` works.
2. At least one Grok account. Rotation becomes useful with multiple accounts, but one is enough to begin.
3. Node.js 22 or later.

> `grok-worker doctor` performs a read-only check for the Grok CLI executable and does not run Grok. The `pass` field continues to describe provider health; check `readyForRun` before a real run.

## Install

```powershell
git clone https://github.com/taiyun668/grok-worker.git
cd grok-worker
node bin/grok-worker.js deploy pointer --write
```

`deploy pointer --write` places a stable shim in `%USERPROFILE%\.local\bin\`, after which you can call `grok-worker` directly. Without `--write`, the command is a dry run and changes nothing.

## First use: connect an account

Immediately after installation, `grok-worker profiles list` is empty. This is expected: no account has been connected yet. You must onboard a profile before the later commands have anything to use.

```powershell
grok-worker profiles list                       # empty
grok-worker onboard --profile my-account        # choose an alias such as work or personal
grok-worker profiles probe --profile my-account # discover the models available to this account
grok-worker profiles list                       # the profile now appears
```

`onboard` prepares an independent `GROK_HOME` for the account; authentication remains Grok's own flow. Repeat onboarding with a different alias for each additional account.

After `probe`, confirm that the output includes `grok-4.6`. It is currently the only model the provider schedules. If it is absent, use another account or wait until the account has access.

---

## Shortest working flow

```powershell
grok-worker doctor                              # environment check, including a read-only lock list
grok-worker locks inspect                       # list lock ID, scope, age, and owner state without mutation
grok-worker profiles list                       # list accounts
grok-worker onboard --profile <alias>           # connect one account through Grok's login flow
grok-worker profiles probe --profile <alias>    # discover the account's models

grok-worker task init --profile <alias> `
  --workspace <project-root> `
  --objective "<bounded objective>" `
  --out task.json --real allowed                # create a task capsule

grok-worker plan --profile <alias> --task task.json   # zero-request safety validation
grok-worker run  --profile <alias> --task task.json   # execute the task
```

`plan` sends no requests and consumes no quota. It only decides whether the task is safe to run. Planning before running is the basic operating pattern.

`doctor` and `locks inspect` report a blocking lock's ID, scope, age, owner state, and reason without removing it. Cleanup requires exact confirmation:

```powershell
grok-worker locks cleanup --id <lockId> --confirm <lockId>
```

A proven-live lock cannot be removed. If the file changes between inspection and deletion, cleanup refuses the race and records an audit event.

---

## Companion skill

The `skill/` directory contains operating instructions for AI agents in the Codex and Claude Code skill format.

Without it, another agent receives commands but not the order and constraints under which they are safe. The skill requires that callers:

- never invoke `grok.cmd` or `grok.exe` directly;
- never read, copy, or print credential files;
- give write tasks an exclusive workspace, because isolated `GROK_HOME` directories are not write isolation;
- treat `plan` as a zero-request safety check, not a real run; and
- treat quota attribution as local accounting and report `unknown` when unavailable, never as official quota.

Install it by copying `skill/` into the agent's skill directory. Codex uses `~/.codex/skills/grok-worker-pool`; Claude Code uses `~/.claude/skills/`.

---

## Design principles

**Every predicate needs a negative case.** Failure to match a known failure string is not success. When the provider cannot determine an outcome, it reports unknown rather than assuming success.

**Isolation must be falsifiable.** Every isolation dimension needs a test that fails when that dimension is missing; otherwise a test may accidentally exercise only the single dimension that happened to be correct.

**Process identity is a pair.** Any operation using a process ID also verifies process creation time. Operating systems reuse PIDs, so a PID alone can identify an unrelated process.

**Locks fail closed.** If the owner cannot be determined, the lock is preserved. Production acquisition automatically reclaims only a proven-dead owner. Corrupt JSON, unverifiable owners, invalid lease metadata, and expired leases whose process is still alive are reported rather than deleted. Manual cleanup requires an exact lock ID repeated through `--confirm`.

---

## Boundaries and limitations

- **Platform:** developed and verified on Windows. The entry point is a `.cmd` shim and examples use PowerShell. macOS and Linux are unverified.
- **Model:** currently schedules only `grok-4.6`. This is a deliberate hard constraint in the skill.
- **Quota:** does not fetch official quota numbers. Usage is attributed locally by profile ID; unavailable data is `unknown`.
- **Write isolation:** isolates credentials and account homes, but does not isolate filesystem writes. Concurrent write tasks require an exclusive workspace or non-overlapping file ownership enforced by the caller.

---

## Tests

```powershell
npm ci
npm run quality
```

`quality` runs lint, focused JavaScript type checking, the complete zero-request test suite, public-hygiene checks, and coverage reporting. Individual suites such as `test:mutation`, `test:global`, `test:availability`, and `test:run-recovery` are also available in `package.json`.

---

## Repository layout

```text
bin/         command entry point
lib/         provider implementation
schemas/     task, result, and configuration schemas
tests/       test suites
fixtures/    test fixtures
skill/       operating contract for AI agents
docs/        acceptance records and independent audits
```

The material in `docs/` is not required reading for users. It remains in the repository because it records the incidents and evidence behind the constraints.

---

## License

MIT. See [LICENSE](LICENSE).
