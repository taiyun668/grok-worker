# Quick start

`grok-worker` is a Windows-first provider that lets another AI agent invoke Grok CLI under an explicit task, model, permission, and audit contract. It keeps each account in an isolated `GROK_HOME`, selects only eligible profiles, and records a reviewable result for each run. It does not include Grok CLI, provide filesystem write isolation, or report official account quota.

## Requirements

- Windows
- Node.js 22 or 24
- Grok CLI installed at its standard Windows location
- At least one Grok account

## Install

```powershell
git clone https://github.com/taiyun668/grok-worker.git
cd grok-worker
npm install --global .
```

## Onboard and verify a profile

```powershell
grok-worker doctor
grok-worker onboard --profile example-account
grok-worker profiles probe --profile example-account
grok-worker profiles list
```

`onboard` prepares an isolated home but requires the operator to complete the vendor's OAuth flow. A profile is eligible only after a fresh model snapshot includes `grok-4.6`.

## Plan before running

```powershell
grok-worker task init --profile example-account `
  --workspace <project-root> `
  --objective "Describe the bounded task" `
  --out task.json --real allowed

grok-worker plan --profile example-account --task task.json
grok-worker run --profile example-account --task task.json
```

`plan` is a zero-request safety check. A write task still requires an exclusive worktree or documented non-overlapping file ownership.
