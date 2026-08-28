# Availability Layer v5 — Construction Plan (post-inspect)

> Date: 2026-07-21
> Authority: `AVAILABILITY-LAYER.plan.v5.md` + security skeleton from `GROK-WORKER-PROVIDER.plan.md` (PASS, do not regress).

## Inspection findings (baseline)

| Area | Current state | Gap vs v5 |
|------|---------------|-----------|
| Security skeleton G0–G9 | Present in `lib/provider.js` | Keep; do not weaken |
| `isolatedEnv` G-0 hooks | `GROK_CLAUDE/CURSOR_HOOKS_ENABLED=false` present | Assert in planTemplate/verifyPlanContract (already) |
| Error classification §5 | Only end-event `quotaSignal` | Full 7-class parser + attribution boundary |
| Availability ledger §2.1 | Missing | New `{DATA_ROOT}/availability/{profileId}.json` |
| State machine §3 | Missing | 7 states + deterministic eligibility |
| `runTask` lock order | Releases profile lock before classify (race) | Rewrite with WAL + selection→profile→workspace |
| Task capsule pool mode | `profile` always required | oneOf explicit \| pool + probePolicy + profileIds failover |
| Result capsule | No selectionEvidence/errorClassification | Extend + validateResultCapsule |
| task-run / attempts[] | Missing | WAL + multi-attempt outer record |
| Billing snapshot §8 | Missing | Bounded read of profile `grokHome/logs` |
| Versioned deploy §11 | Missing | `current.json` helper (no service control) |
| Mock suite | G0–G10 only | New `tests/availability-harness.js` |

## Implementation batches

### Batch 1
- `lib/availability.js`: classifyError, availability store (CAS), evaluateEligibility, bootstrap
- Lock scopes: `selection`, `availability`, `profile`, `workspace`
- WAL under `{DATA_ROOT}/runs/{taskId}/{runId}.json`
- Rewrite `runTask` classify-under-profile-lock

### Batch 2
- Schema updates (task / result / command-plan) + `task-run.provider.v5.schema.json`
- Candidate selection + probePolicy (default disabled, zero real request on list/status/plan)
- Failover attempts[] with independent Result Capsules; no silent overwrite

### Batch 3
- Billing period end → nextProbeAt only (never auto-active)
- Version pointer helpers for `%LOCALAPPDATA%\GrokWorkerProvider\current.json`
- Mock fixtures + availability harness (100% mock, zero real Grok)

## Security invariants preserved
- No auth.json read/hash/copy
- No default `.grok`
- No OAuth/login/logout/account switch/service control/git commit-push from provider automation
- No direct production caller exposure of grok.cmd/exe contract
- No touch of `<legacy-consumer-root>` runtime directories

## Residual / INCONCLUSIVE (contract §12)
- Real `execution.stderr` exhaustion payload format not yet observed → parser is conservative; auto-detect-all-future-exhaustion remains **INCONCLUSIVE**.

## Delivered files (construction complete)

| Batch | Deliverable |
|-------|-------------|
| 1 | `lib/availability.js` (classify, state machine, CAS, WAL, eligibility) |
| 1 | `lib/provider.js` runTask rewrite: selection→profile→workspace, classify under profile lock |
| 2 | Schemas: task/result/command-plan + `task-run.provider.v5.schema.json` + `availability.provider.v5.schema.json` |
| 2 | probePolicy, pool/explicit selection, attempts[] failover gate |
| 3 | billing snapshot helper; deploy pointer helpers; fixtures + `tests/availability-harness.js` |
| docs | This file + contract v5 |

### Mock acceptance (`npm run test:v5`)
Covers: 402 attribution, seven-class taxonomy, non-account errors do not touch availability, eligibility thirds, probePolicy default disabled, explicit never replaced, CAS, WAL interrupted recovery, failover gate, billing→nextProbeAt only, UTF-16 normalize regression, bootstrap, lock scopes, result capsule extensions, selection modes, **429 retryable-alone not account-level**, **provider/global health**, **probe self-rescue + maxProbesPerRun**, **deploy pointer validation/roots**, **usage-unknown clarity**, **runTask multi-attempt 402 failover (mock executePlanFn)**, **runTask probe self-rescue**, **concurrent selection reservation + CAS**.

### Audit closure (v5 re-audit items)
1. `runTask` wires `allowProbeSelection` only from `probePolicy.mode=when-no-active` + `probePolicy.realRequestPermission=allowed`; enforces `maxProbesPerRun`.
2. Non-attributable faults write `{DATA_ROOT}/health/provider.json` (never profile availability).
3. `current.json` validated at bootstrap; `dataRoot`/`registryPath` inherited; legacy GrokUI roots preserved when pointer absent; env overrides win.
4. Mock integration harness for multi-attempt Result files, probe self-rescue, concurrent reservation/CAS.
