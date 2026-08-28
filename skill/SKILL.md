---
name: grok-worker-pool
description: Use when Codex should call, delegate to, or coordinate Grok CLI workers or multiple Grok accounts/profiles, including Grok worker, Grok CLI, multi-Grok agents, saving Codex quota, worker failover, usage accounting, or Provider Task/Result Capsules.
---

# Grok Worker Pool

Use the machine-global `grok-worker` command as the only production path. It is a stable shim at `%USERPROFILE%\.local\bin\grok-worker.cmd`, resolved through `%LOCALAPPDATA%\GrokWorkerProvider\current.json` to an immutable release. Install it with `grok-worker deploy pointer` from a checkout of this repository; that checkout is the authoritative source. Never call a provider copy that lives inside another tool's runtime directory as a caller, and never edit such a copy in place.

## Hard boundaries

- Never call `grok.cmd` or `grok.exe` directly for a worker task.
- Never read, copy, hash, print, or link `auth.json`; never use `%USERPROFILE%\.grok` as a worker home.
- Do not login/logout, switch accounts, update Grok, clear memory, delete sessions/worktrees, control services, or commit/push unless that action is separately authorized.
- `grok-4.6` is the only model this skill may dispatch. `grok-4.5` and every other model are forbidden even when explicitly present in a profile snapshot, capsule, fallback, continuation, or caller-supplied command. Never downgrade, translate, or retry with another model.
- Use `high` reasoning and `speed: "standard"` unless the task explicitly requires a different supported reasoning or speed setting. Provider plans must include `--no-plan --no-memory`; do not invoke Grok plan mode.
- Before `run`, require the selected profile's fresh model snapshot to include `grok-4.6`. If it does not, refresh the profile through `grok-worker profiles probe`; if 4.6 is still absent, stop with a Provider capability blocker. A snapshot may advertise other models, but their presence never authorizes their selection.
- Treat `plan` as a zero-request safety check, never as token usage or a real worker run.
- A write task needs an exclusive worktree or documented non-overlapping file ownership. Isolated `GROK_HOME` is not write isolation.
- Do not claim official quota from local token totals. Provider usage is local attribution by immutable `profileId`; missing usage is `unknown`.

## Before the first delegation on a new machine

This provider drives the Grok CLI but does not contain it. On a machine that has
never run it, check these in order and stop with a clear message rather than
improvising:

1. **Is the Grok CLI installed?** Run `grok-worker doctor` and require
   `grokCliAvailable: true` and `readyForRun: true`. The check is read-only:
   it confirms the configured executable file exists without spawning Grok or
   consuming quota. The backward-compatible `pass` field still describes only
   provider health, so it is not sufficient by itself.
2. **Does any profile exist?** `grok-worker profiles list` returns an empty
   `profiles` array on a fresh install. That is expected, not a fault.
   **Do not attempt `task init`, `plan`, or `run` with no profile.**
   Onboarding requires a human to complete a vendor login, so ask the operator
   to run it rather than guessing an alias:

   ```powershell
   grok-worker onboard --profile <alias-chosen-by-operator>
   grok-worker profiles probe --profile <alias>
   ```

3. **Does the chosen profile advertise `grok-4.6`?** If `probe` does not list
   it, stop with a Provider capability blocker. Never substitute another model.

Only after all three hold does the delegation flow below apply.

## Start every delegation

```powershell
grok-worker version
grok-worker doctor
grok-worker profiles list
grok-worker pool status
grok-worker roots inspect --path <project-root>
```

Register only the intended project root if necessary:

```powershell
grok-worker roots register --path <project-root>
```

Use `profiles list` to choose only an OAuth-ready profile whose model snapshot includes `grok-4.6`. Account-named aliases are human selectors; `profileId` is the stable accounting and pool-selection key.

## Mandatory dispatch and fallback ladder

Classify every attempt before choosing a fallback. Report one of these exact classes:

1. `provider_preflight_failed`: the Provider rejected the capsule, root, baseline, policy, or worktree before a model request.
2. `worker_request_failed`: a real Grok request started but failed for quota, authentication, model, network, or another classified cause.
3. `worker_completed`: Grok returned a Result Capsule.
4. `controller_only`: the action inherently requires controller-owned browser, service, Git integration, credential, or final-gate coordination.

Never describe `provider_preflight_failed` as a Grok failure, quota failure, or reason to consume Codex construction capacity. Fix the dispatch packaging and retry the same Grok task first.

For `DIRTY_BASELINE` or equivalent write-isolation rejection:

1. Preserve the current checkout; do not clean, reset, stash, delete ignored state, or weaken Provider policy.
2. Record the rejected workspace, base commit, dirty-path summary, and `realRequests` count.
3. If worktree creation is authorized, create a clean exclusive worktree from the intended base commit in a controller-owned neutral location. Do not place it under `.grok`, `.claude`, Provider runtime, or another task's worktree.
4. Run `roots inspect` for the new path and register only that exact root if necessary.
5. Regenerate the Task Capsule with the clean worktree as `workspace`, the same intended `baseCommit`, precise file ownership, and the original stop and permission boundaries.
6. Run `plan`, verify the contract, then run the Grok task again. Do not bypass `grok-worker`.
7. If worktree creation is not authorized, report the missing authority as a dispatch blocker. Do not silently take over implementation.

For a Grok-first workflow, use this fallback order:

1. Retry a remediable Provider preflight failure with corrected packaging.
2. On explicit quota exhaustion, use another eligible Grok profile only when the pool capsule permits fallback and prior-attempt state is safe to continue.
3. On a proven Grok capability mismatch, narrow or split the remaining work and retry Grok when practical.
4. Use a lower-cost Codex construction thread only when the task's governing plan explicitly permits it and the eligible Grok routes are genuinely unavailable or unsuitable.
5. Let the controller implement product code only as the last resort after the preceding routes are exhausted, or when the action is `controller_only`.

Do not create a Codex subagent for ordinary implementation merely because a Grok run was rejected before model execution. A separate Codex task remains appropriate for required independent audit, but audit independence is not a substitute for Grok-first construction.

## Capsule and execution

For an ordinary explicit task, create then inspect a capsule. The model argument is fixed and must not be parameterized:

```powershell
grok-worker task init --profile <alias> --workspace <project-root> --objective "<objective>" --out <capsule.json> --real allowed --model grok-4.6 --reasoning high --access readonly
$skillRoot = Join-Path $env:USERPROFILE '.codex\skills\grok-worker-pool'
python (Join-Path $skillRoot 'scripts\assert_grok46.py') --capsule <capsule.json>
grok-worker plan --profile <alias> --task <capsule.json> | Tee-Object -FilePath <plan.json>
python (Join-Path $skillRoot 'scripts\assert_grok46.py') --capsule <capsule.json> --plan <plan.json>
grok-worker run --profile <alias> --task <capsule.json>
grok-worker usage show --profile <alias> --task <taskId>
```

The two validator calls are mandatory machine gates. Any nonzero result is `provider_preflight_failed`: do not call `run`, do not edit the capsule to another model, and do not bypass the validator. Before `run`, also confirm the plan has exactly one `--model grok-4.6`, the intended workspace/profile, isolated `GROK_HOME`, `--no-plan`, `--no-memory`, precise allow rules, permanent `.git/.grok/.claude/runtime` denies, and no unexpected authority.

For a write task, change `--access` to `workspace-write`, then narrow `allowedFiles`, `contextRefs`, stage, acceptance commands, and explicit stop in the generated JSON before running. `forbiddenActions` stays as auditable human contract text; never turn natural-language entries into native CLI rule syntax yourself. Provider enforces write isolation through `dontAsk`, whole-tool Bash denial, permanent path denials, and its policy hook.

The full editable starting point is [references/task-capsule-template.json](references/task-capsule-template.json). Use a pool capsule only after validating its `candidateProfileIds` and `allowedFallbackProfileIds` against the current registry; never mix aliases and IDs in one failover field.

## Availability and failover

- `pool status` is the source for local eligibility: `active` is workload-eligible; `unknown` or an expired frozen/cooldown state can be probe-eligible; `reauth_required` and manual holds are excluded.
- Explicit `profile` tasks are never silently switched. Pool candidates can be selected only when the capsule explicitly permits them.
- A real workload request does not authorize a maintenance probe. Set `probePolicy.mode: "when-no-active"`, `probePolicy.realRequestPermission: "allowed"`, and a bounded `maxProbesPerRun` only when the controller explicitly authorizes pool self-rescue.
- Treat only explicit Provider/Grok quota evidence as profile exhaustion. `quota_exhausted` may freeze that profile; unauthenticated, network, provider, or unknown faults must stay in provider/global health and must not freeze an account.
- If a clean first attempt has explicit quota exhaustion and the capsule permits fallback, use the next eligible profile. If changes exist, a run has begun, or evidence is ambiguous, inspect the Result Capsule and create a continuation or take over; never silently overwrite a prior Result or reuse its session across accounts.
- If every eligible profile is unavailable, take over from the last verified point. Never copy authentication or auto-switch a user account.

## Result review

Require a Result Capsule before accepting completion. Verify:

- status, profileId/alias, session/request IDs, selected profile evidence, attempt records, and explicit stop;
- `changedFilesFinalState` including tracked, untracked, and ignored files;
- boundary compliance, raw-stream cleanup, commands/tests actually run, and residual risk;
- usage ledger by profileId, with absent values still `unknown`;
- quota classification only where backed by explicit evidence.

Independent review must reproduce behavior or inspect current artifacts; construction self-report, a checker name, fixture presence, or a screenshot file is not acceptance.

## Bounded wait and state-split hard gate

- Wait in bounded observation windows. Do not emit periodic “still running” commentary when the foreground state, WAL, policy activity, and workspace evidence are unchanged.
- Report only a new policy/tool activity, a terminal Result Capsule, an explicit error, or a stale-progress escalation threshold. Use 5 minutes without new policy activity as the first read-only reconciliation threshold and 10 minutes as the controller-escalation threshold unless the task capsule sets a shorter bound.
- At each threshold, reconcile four sources read-only: foreground command state, the exact task/run WAL, the expected Result Capsule path, and current policy-audit/worktree evidence. Do not call `run` during reconciliation.
- Invoke the machine gate during reconciliation; a nonzero exit blocks waiting/resend progression:

```powershell
$skillRoot = Join-Path $env:USERPROFILE '.codex\skills\grok-worker-pool'
python (Join-Path $skillRoot 'scripts\assert_run_state.py') --wal <task-run-wal.json> --foreground <inProgress|completed|failed|unknown> --data-root <provider-data-root> --last-progress-at <rfc3339> [--has-policy-activity] [--has-workspace-changes]
```

- `foreground=inProgress` while the WAL is `interrupted`, `failed`, or `completed`, or any other incompatible combination, is `PROVIDER_CONTROLLER_STATE_SPLIT`. Stop repeated waiting commentary and perform read-only reconciliation immediately.
- Never accept completion without a Result Capsule whose task/run/attempt identity and final file boundary match the dispatched capsule. A terminal-looking foreground line or WAL field alone is not completion.
- If any tool/policy events or workspace modifications exist, never auto-resend, auto-failover, or recreate the task. Preserve the worktree and escalate from the last verified point.
- An ownerless or otherwise unverifiable `running` WAL is not permission to interrupt or resend. Treat it as takeover-required evidence and require explicit reconciliation.

## Troubleshooting

- If a run appears to use no tokens, first confirm it was not `plan`, then inspect the Result and ledger. Do not infer quota from zero/unknown local usage.
- If a task fails before model output, label it `provider_preflight_failed`, retain the Result Capsule, verify `realRequests`, and inspect provider/global health. Repair the capsule/root/worktree before considering Codex fallback. Do not freeze the account without account-attributable evidence.
- If a project is rejected, use `roots inspect` and register only that project root. For `DIRTY_BASELINE`, follow the mandatory clean-exclusive-worktree procedure above; do not clean the user's current checkout or take over merely to avoid the gate.
- If the stable command fails, run `grok-worker doctor`; do not bypass it with a direct CLI call. The pointer can be rolled back by atomically switching `current.json`, not by editing credentials or legacy runtime.
