# Availability Layer v5 — Release Independent Audit

| Field | Value |
|-------|--------|
| Audit ID | `GROK-WORKER-PROVIDER-V5-RELEASE-INDEPENDENT-AUDIT` |
| Task | `grok-worker-e6325b92-9461-4900-abc9-3021912bddb6` |
| Authority contract | `docs/contracts/AVAILABILITY-LAYER.plan.v5.md` (2026-07-21) |
| Supporting construction note (non-authority) | `docs/contracts/AVAILABILITY-LAYER.IMPLEMENTATION.v5.md` |
| Prior independent audit | `docs/audits/availability-v5-independent-audit.md` (overall **WARN**) |
| Prior final independent audit | `docs/audits/availability-v5-final-independent-audit.md` (overall **PASS** with residual WARNs) |
| Auditor posture | Read-only static review of listed code, schemas, fixtures, harnesses, and prior evidence. **No** shell, git, OAuth, service control, account switch, data deletion, auth.json access, default `.grok` credential read, or `D:\Grok UI` runtime touch |
| Report date | 2026-07-21 |
| Sole deliverable | `docs/audits/availability-v5-release-independent-audit.md` |

---

## 1. Scope and method

### In scope (read-only)

| Layer | Paths |
|-------|--------|
| Contract | `docs/contracts/AVAILABILITY-LAYER.plan.v5.md` §§0–14 |
| Implementation | `lib/availability.js`, `lib/provider.js` (availability-touching paths: selection, `runTask`/`planTask`, locks, WAL, health, deploy roots, pool/bootstrap) |
| Schemas | `schemas/availability.provider.v5.schema.json`, `task-run.provider.v5.schema.json`, `task-capsule.provider.v3.schema.json`, `result-capsule.provider.v3.schema.json`, `command-plan.provider.v3.schema.json`, `provider-health.v5.schema.json`, `current-pointer.v5.schema.json` |
| Fixtures / harness | `fixtures/availability/*`, `tests/availability-harness.js`, `package.json` scripts `test:v5` / `test:availability` |
| Entry surfaces | `bin/grok-worker.js`, repo `grok-worker.cmd` |
| Prior evidence | both prior availability v5 audit reports + construction note |

### Out of scope

- Live Grok calls; OAuth; account switch; service control; git mutations; deleting data.
- Executing harnesses (shell forbidden) — **test design and assertions reviewed statically only**.
- Packaging/installing the external global path `%USERPROFILE%\.local\bin\grok-worker.cmd`.
- Closing §12 real-stderr exhaustion format (must remain **INCONCLUSIVE**).
- Full re-audit of security skeleton G0–G9 beyond availability-touching invariants.

### Rating scale

| Rating | Meaning |
|--------|---------|
| **PASS** | Requirement implemented and aligned with contract intent; evidence present in code and/or static test design |
| **WARN** | Partial implementation, incomplete operator path, or residual risk that does not reverse a hard contract FAIL |
| **FAIL** | Material contract contradiction or safety regression |
| **INCONCLUSIVE** | Contract-admitted open item; must not be false-PASS closed |

---

## 2. PASS / WARN / FAIL summary

| Contract area | Verdict | One-line finding |
|---------------|---------|------------------|
| §0 Anchored facts / honesty | **PASS** | 402 semantics, no false stderr-format closure, residual INCONCLUSIVE retained |
| §1 Directory / profile root | **PASS** | Approved profile root preserved; no auth migration; data roots pointer/env/legacy |
| §2 Data model / schemas | **PASS** | Availability ledger, task-run WAL, extended task/result/command-plan schemas |
| §3 State machine / eligibility | **PASS** | 7 states, freeze/cooldown/reauth, `nextProbeAt`, deterministic thirds, bootstrap |
| §4 Candidate selection / probePolicy | **PASS** (residual WARN) | Self-rescue gated; plan/list/status zero-request; maintenance real spawn incomplete |
| §5 Error classification / attribution | **PASS** | 7 classes; profile boundary; provider health plane for non-attributable |
| §6 Locks + WAL / `runTask` rewrite | **PASS** | selection→profile→workspace; classify under profile lock; interrupted recovery |
| §7 Failover / attempts[] | **PASS** | Clean-402 gate; independent Result refs; no session reuse; usage-unknown |
| §8 Billing snapshot | **PASS** | Bounded whitelist; `billingPeriodEnd` → `nextProbeAt` only |
| §9 G-0 env | **PASS** | Compat hooks forced false; plan contract asserts |
| §10 Tests | **PASS** (static design) | Mock harness covers required themes; zero real Grok intent; not executed here |
| §11 Deploy pointer | **PASS** (residual WARN) | In-repo shim + bootstrap validate `current.json`; packaging pipeline incomplete |
| §12 Residual / INCONCLUSIVE | **PASS** (honesty) | Exhaustion auto-detect remains **INCONCLUSIVE**; no false PASS |
| Credential / default-home safety | **PASS** | No auth.json read; default `.grok` blocked; no auto OAuth |
| Free-form `forbiddenActions` | **PASS** | Not CLI-interpolated; wholesale Bash deny |
| **Overall release readiness** | **PASS** | Prior hard blockers remain closed; residual WARNs do not block core pool use |

---

## 3. Requirement-by-requirement evidence

### 3.1 §2.1 Availability ledger

| Check | Verdict | Evidence |
|-------|---------|----------|
| Path `{DATA_ROOT}/availability/{profileId}.json` | **PASS** | `lib/availability.js` `availabilityPath` |
| Fields: schemaVersion, revision, updatedAt, evidenceSource, state, scope, evidence, nextProbeAt, lastSelectedAt | **PASS** | `emptyAvailability`; schema `availability.provider.v5.schema.json` |
| 7 states enum | **PASS** | `AVAILABILITY_STATES`; schema enum matches |
| CAS revision anti-stale | **PASS** | `writeAvailabilityCas`; harness `cas-rejects-stale-revision` |
| Secret-key + atomic write | **PASS** | `deps.atomicWriteJson` → provider `hasSecretKeys` + `atomicWriteJson` |

### 3.2 §2.2–2.5 Schemas / API surface

| Check | Verdict | Evidence |
|-------|---------|----------|
| Task capsule explicit \| pool `oneOf` | **PASS** | `task-capsule.provider.v3.schema.json`; `validateTaskCapsule` rejects mix / missing either |
| Pool candidates = immutable profileId UUID | **PASS** | Schema UUID items + runtime `UUID.test` |
| Failover `allowedFallbackProfileIds` vs alias list exclusive | **PASS** | Schema oneOf + validation mix reject |
| `probePolicy` shape | **PASS** | Schema `$defs.probePolicy`; `defaultProbePolicy` / `normalizeProbePolicy` |
| Result requires `profileId`, `selectionEvidence`, `errorClassification` | **PASS** | Result schema required; `buildResultCapsule` / `validateResultCapsule` |
| Success classification | **PASS** | Success path sets `errorType:"none"` + `note:"no-error-on-success"` (cleaner than prior `unknown_failure` special-case) |
| command-plan selection metadata | **PASS** | Schema required: `selectionMode`, `candidateProfileIds`, `skippedReasons`, `maintenanceProbePlanned`; `materialize` / `planTask` |
| task-run WAL schema | **PASS** | `task-run.provider.v5.schema.json`: runId, status enum, attempts[], finalSelectedProfileId, finalResultRef, takeoverRequired |

### 3.3 §3 State machine

| Check | Verdict | Evidence |
|-------|---------|----------|
| `quota_exhausted` → `frozen` (scope=quota) | **PASS** | `applyClassificationToAvailability` |
| `reauth_required` independent; no auto-probe | **PASS** | `state=reauth_required`, `nextProbeAt=null`, eligibility `excluded` |
| Account-level / Retry-After `rate_limited` → `cooldown` | **PASS** | scope `rate_limit` + `computeNextProbeAt`; account keywords or Retry-After only |
| Non-account errors do not transition durable eligibility | **PASS** | `shouldTouchAvailability` / `touched:false` |
| `nextProbeAt` mandatory on freeze/cooldown (`resetAt:null` → backoff) | **PASS** | `computeNextProbeAt` + harness `nextProbeAt-required-on-freeze` |
| Deterministic eligibility §3.3 (incl. expired → effective `probe_due`) | **PASS** | pure `evaluateEligibility`; harness `eligibility-cooldown-and-frozen-expiry` |
| Bootstrap success→active / controlled 402→frozen / else unknown | **PASS** | `bootstrapAvailability` + CLI `pool bootstrap` |
| Durable rewrite of state to literal `probe_due` | **WARN** | Expiry yields **effective** `probe_due` at evaluation without always rewriting durable `state` — matches “选择时求值”; pool status may show durable `frozen` + effective probe |

**Section verdict: PASS** (presentation residual only).

### 3.4 §4 Candidate selection and probe authorization

| Check | Verdict | Evidence |
|-------|---------|----------|
| `workloadEligible` = active only | **PASS** | `evaluateEligibility` + `buildCandidateSets` |
| `probeEligible` = unknown or due frozen/cooldown | **PASS** | same |
| `excluded` = not-due / reauth / manual_hold | **PASS** | same |
| Default `probePolicy` disabled + denied | **PASS** | `defaultProbePolicy()`; capsule default inject |
| Workload `realRequestPermission` alone does not authorize probes | **PASS** | `probeSelfRescueAllowed` uses only `probePolicy`; `runTask` comments + wiring |
| Plan shows maintenance intent; zero spawn | **PASS** | `planTask` → `maintenanceProbePlanned`, `spawnCount:0`, `allowProbeSelection:false` |
| `profiles list` / `pool status` zero real requests | **PASS** | no spawn; `poolStatus.realRequests:0` |
| Pool self-rescue when no active under explicit policy | **PASS** | `runTask` sets `allowProbeSelection` via `probeSelfRescueAllowed`; `selectProfile` probe path; harness `probe-self-rescue-when-no-active` + `runTask-probe-self-rescue` |
| `maxProbesPerRun` enforced | **PASS** | select gate + first selection increment + failover probe handoff cap; harness `max-probes-per-run-enforced` |
| Explicit profile never pool-replaced | **PASS** | `selectProfile` forced branch; harness `explicit-profile-never-replaced` |
| Dedicated maintenance probe recipe (`--max-turns 1` independent capsule) | **WARN** | Self-rescue runs **workload** capsule on probeEligible profile, not a separate maintenance recipe |
| `after-workload` execution | **WARN** | Flag/planning only (`maintenanceProbePlanned`); no post-run probe spawn |
| `pool refresh --real allowed` independent real probes | **WARN** | Authorized path returns `realRequests:0`, selection-only note; defers to separate `profiles probe` |

**Section verdict: PASS** for safe defaults + bounded self-rescue; residual **WARN** for incomplete maintenance-probe auto-execution (does not re-open prior hard FAIL).

### 3.5 §5 Error classification and attribution boundary

| Check | Verdict | Evidence |
|-------|---------|----------|
| In-memory classify + redacted stderr | **PASS** | `classifyFromExecution` + `redactText` before classify |
| Seven error types | **PASS** | `ERROR_TYPES`; fixtures + harness `classify-seven-types` |
| Only attributable types touch profile availability | **PASS** | quota / reauth / account-level rate_limited |
| Bare / no-evidence 429 does not freeze | **PASS** | `stderr-429-no-evidence.txt`; `profileAttributable:false` |
| `is_retryable=true` alone is not account-level | **PASS** | classifier comment + harness `429-retryable-alone-not-account-level` |
| Unrecognized exit 1 → `unknown_failure`, no freeze | **PASS** | default branch of `classifyError` |
| Independent provider/global health for non-attributable | **PASS** | `{DATA_ROOT}/health/provider.json` via `recordProviderHealth`; `persistAvailabilityFromOutcome` wires when `!touched`; schema `provider-health.v5.schema.json` |
| Real exhaustion stderr format closed? | **INCONCLUSIVE** | Correctly **not** closed; synthetic fixture only; Result residualRisks + harness `inconclusive[]` |

**Section verdict: PASS** (+ honest INCONCLUSIVE).

### 3.6 §6 Execution / locks / WAL

| Check | Verdict | Evidence |
|-------|---------|----------|
| WAL path `{DATA_ROOT}/runs/{taskId}/{runId}.json` | **PASS** | `runWalPath` / `emptyTaskRun` / `writeTaskRun` |
| Status planned → running → completed\|failed | **PASS** | `runTask` |
| Crash recovery: running → interrupted; no invented success | **PASS** | `recoverInterruptedRuns` on `main`; harness `wal-crash-recovery-interrupted` |
| Classify + availability CAS while holding profile lock | **PASS** | `runSingleAttempt`: classify + `persistAvailabilityFromOutcome` before lock release |
| Lock scopes selection / availability / profile / workspace | **PASS** | `acquireLock` conflict rules |
| Lock order selection → profile → workspace | **PASS** | selection held until `onProfileLockAcquired`, then released |
| Reservation lease covers select→run handoff | **PASS** | task-scoped selection lock covers handoff |

**Section verdict: PASS**.

### 3.7 §7 Multi-worker failover / attempts[]

| Check | Verdict | Evidence |
|-------|---------|----------|
| Outer task-run with `attempts[]` | **PASS** | schema + `runTask` updates |
| Independent invocationId + Result path per attempt | **PASS** | `resultPath(taskId, invocationId)`; harness multi-attempt both files retained |
| Auto next worker only on clean 402 | **PASS** | `mayAutoFailoverAttempt` |
| Partial modifications → takeover | **PASS** | `takeoverRequired` on gate |
| No prior Grok session reuse across accounts | **PASS** | `capsule.grokSessionId = null` before next attempt |
| 402 usage unknown, not invented 0 | **PASS** | `numericUsage(null)` → null tokens + `unknown:true`; quota path forces unknown |
| No silent Result overwrite | **PASS** | distinct refs; prior files kept |

**Section verdict: PASS**.

### 3.8 §8 Billing

| Check | Verdict | Evidence |
|-------|---------|----------|
| Profile-owned logs only; skip symlink/reparse | **PASS** | `readBillingSnapshot` |
| Size / line / scan caps | **PASS** | BILLING_MAX_* constants |
| Whitelist rebuild of config keys | **PASS** | `BILLING_CTX_WHITELIST` |
| `billingPeriodEnd` only influences `nextProbeAt` | **PASS** | `applyBillingToNextProbe`; harness `billing-only-affects-nextProbeAt` |
| Never grants `active` | **PASS** | no markActive in billing path |

**Section verdict: PASS**.

### 3.9 §9 G-0 environment

| Check | Verdict | Evidence |
|-------|---------|----------|
| Process-local hooks disabled | **PASS** | `isolatedEnv`: `GROK_CLAUDE_HOOKS_ENABLED=false`, `GROK_CURSOR_HOOKS_ENABLED=false` |
| planTemplate / verifyPlanContract assert | **PASS** | template env + contract assert |
| No user/system env mutation | **PASS** | clone of process.env for child only |
| Harness / doctor | **PASS** | `G-0 isolatedEnv...` test; doctor `compat-hooks-isolated-env` |

**Section verdict: PASS**.

### 3.10 §10 Tests (static design review)

| Theme | Covered? | Locus |
|-------|----------|--------|
| 402 attribution | Yes | fixtures + classify tests |
| Seven-class taxonomy | Yes | `classify-seven-types` |
| Non-account no profile touch | Yes | network / unknown / bare 429 |
| Candidate thirds + expiry | Yes | eligibility + candidate-sets |
| probePolicy default disabled | Yes | |
| Explicit never replaced | Yes | |
| CAS stale | Yes | |
| WAL interrupted | Yes | |
| Failover gate + multi-attempt Results | Yes | unit gate + `runTask-multi-attempt-402-failover` |
| Probe self-rescue + maxProbes | Yes | unit + `runTask-probe-self-rescue` |
| Provider health | Yes | |
| Deploy pointer / roots | Yes | |
| Usage unknown | Yes | |
| UTF-16 regression | Yes | |
| Bootstrap | Yes | |
| Concurrent selection reservation + CAS | Yes | single-process sequential |
| Zero real Grok | Design intent | harness footer `realGrokRequests: 0` |
| §12 INCONCLUSIVE declared | Yes | harness `inconclusive` array |

**Section verdict: PASS** for design sufficiency relative to contract §10 mock suite. **Not executed** in this audit (shell forbidden). Multi-process load race remains residual **WARN**.

### 3.11 §1 / §11 Deploy and stable entry

| Check | Verdict | Evidence |
|-------|---------|----------|
| Pointer path `%LOCALAPPDATA%\GrokWorkerProvider\current.json` | **PASS** | env override `GROK_WORKER_CURRENT_JSON`; `CURRENT_POINTER_PATH` |
| Pointer fields version / releasePath / previousVersion / dataRoot / registryPath / schemaVersions / manifestSha256 | **PASS** | `buildCurrentPointer` + `current-pointer.v5.schema.json` |
| Repo `grok-worker.cmd` reads+validates pointer each launch | **PASS** | Requires pointer; validates `releasePath\bin\grok-worker.js` exists; launches **release** Node entry (not repo-local fallback) |
| `bin/grok-worker.js` applies pointer env (env wins) | **PASS** | `applyPointerEnv`; invalid pointer fails fast; absent continues |
| Provider root resolution env → pointer → legacy | **PASS** | `resolveRootsFromPointer`; legacy `GrokUI` data/registry roots preserved |
| Four credential profiles stay under approved root; no auth copy | **PASS** | `APPROVED_PROFILE_ROOT`; no auth migration code |
| Immutable release package + SHA-256 verify-before-switch pipeline | **WARN** | Helpers + optional `requireRelease` / `expectedManifestSha256`; cmd checks releasePath entry exists; **no** in-repo packaging/manifest generation pipeline |
| External install path `%USERPROFILE%\.local\bin\grok-worker.cmd` | **WARN** | Outside repo; not inspected |

**Section verdict: PASS** for in-repo pointer-driven release entry and root inheritance; packaging automation + external install fidelity remain residual **WARN**.

### 3.12 Security invariants (availability-touching)

| Invariant | Verdict | Evidence |
|-----------|---------|----------|
| Refuse `auth.json` reads | **PASS** | `readJson` basename guard; harness `security-invariants-no-auth-read` |
| No default user `.grok` as profile home | **PASS** | `INV2_DEFAULT_HOME`; doctor check |
| No auto OAuth / login / logout / account switch | **PASS** | availability bootstrap metadata-only; reauth excluded from auto-probe |
| No service control from provider automation | **PASS** | defaults denied; structured deny rules |
| Free-form `forbiddenActions` not unsafe CLI-interpolated | **PASS** | `buildPermissionSettings` comment + wholesale Bash deny; `verifyPlanContract` asserts Bash deny |
| Secret-shaped keys blocked on durable writes | **PASS** | `hasSecretKeys` + `atomicWriteJson` |
| Plan never spawns | **PASS** | `planTask.spawnCount:0` |
| `run` requires `realRequestPermission=allowed` | **PASS** | hard assert before spawn |

**Section verdict: PASS**.

---

## 4. Prior audit closure matrix

| Prior item | First independent | Final independent | This release re-check |
|------------|-------------------|-------------------|------------------------|
| Pool self-rescue on run + `maxProbesPerRun` | **FAIL** | **PASS** | **PASS** — still wired in `runTask` + tests |
| Durable provider/global health | **FAIL** | **PASS** | **PASS** — health path + persist wiring intact |
| Pointer-driven shim + roots | **WARN/FAIL** | **PASS** (in-repo) | **PASS** — cmd is release-path driven; node bootstrap inherits roots |
| `runTask` multi-attempt / self-rescue integration | **WARN** missing | **PASS** | **PASS** — mock tests present (static) |
| 429 retryable-alone over-attribution | **WARN** | **PASS** | **PASS** |
| Usage invented zeros | **WARN** | **PASS** | **PASS** — null tokens when absent |
| Free-form forbiddenActions | n/a | **PASS** | **PASS** |
| Maintenance probe real spawn | **WARN** | **WARN** | **WARN** — unchanged residual |
| Release packaging pipeline | **WARN** | **WARN** | **WARN** — helpers/cmd only |
| §12 exhaustion stderr format | **INCONCLUSIVE** | **INCONCLUSIVE** | **INCONCLUSIVE** — correctly open |

No prior hard FAIL has reopened in the reviewed tree.

---

## 5. Residual risks (explicit)

### Contract-admitted (must remain open)

1. **INCONCLUSIVE** — real `execution.stderr` exhaustion payload format not observed. Synthetic `fixtures/availability/stderr-402-exhausted.txt` proves parser behavior only. Auto-detect-all-future-exhaustion is **not** closed. **No false PASS.**
2. Official reset time not reliably available from headless CLI → `resetAt:null` + exponential backoff `nextProbeAt` (implemented).
3. `unified.jsonl` remains auxiliary; billing is bounded whitelist snapshot only.

### Operational / incomplete (WARN — non-blocking for core pool)

| Risk | Severity | Notes |
|------|----------|-------|
| Maintenance probe real execution incomplete | Medium | `after-workload` flag-only; `pool refresh --real allowed` selection-only (`realRequests:0`) |
| Self-rescue ≠ dedicated maintenance recipe | Low–Medium | Workload capsule on probeEligible; not separate `--max-turns 1` probe capsule/usage plane |
| External global shim install path not verified | Low–Medium | Outside repo |
| Release SHA packaging pipeline incomplete | Low–Medium | Atomic pointer replace is the switch; packaging not automated in-repo |
| Durable `probe_due` presentation | Low | Effective state at eval time; durable may remain frozen/cooldown |
| Multi-process reservation under load | Low | Harness is single-process sequential conflict |
| Harnesses not executed this session | Low | Static design review only; shell forbidden |
| Post-OAuth reauth recovery operator workflow | Low | No automatic models→availability-probe chain; correctly never auto-active from OAuth alone |

---

## 6. What this audit did **not** do

- Did not run `npm run test:v5` / any shell command (forbidden by task).
- Did not modify implementation, schemas, fixtures, credentials, services, Git, or runtime data.
- Did not perform OAuth, service control, account switch, or delete data.
- Did not read any production `auth.json` or default `.grok` credentials.
- Did not touch `D:\Grok UI` runtime directories.
- Did not verify external install shim path or compute git HEAD.

---

## 7. Final verdict

### Overall: **PASS** — Availability Layer v5 is release-ready for core pool use under the contract

**PASS means (for this release independent audit):**

1. Independent ledger, 7-state machine, deterministic eligibility, and bootstrap align with §2–§3.
2. Probe authorization is explicit and default-disabled; pool **run** self-rescue is policy-gated with `maxProbesPerRun`.
3. Error taxonomy + attribution boundary hold; non-attributable faults use independent provider health and do not mutate profile availability.
4. `runTask` lock/WAL rewrite eliminates pre-classify unlock race; failover attempts[] keep independent Results.
5. G-0 hooks, credential/default-home safety, and free-form forbiddenActions hygiene hold.
6. In-repo stable entry validates `current.json` and can launch from immutable `releasePath`; data/registry roots inherit without credential migration.
7. Mock harness design covers contract §10 themes and honestly retains §12 **INCONCLUSIVE**.
8. Prior hard WARN/FAIL blockers from the first independent audit remain closed.

**PASS does not mean:**

- Full maintenance-probe auto-execution / `pool refresh` real spawn is complete (**WARN**).
- Release packaging + SHA pipeline is automated (**WARN**).
- External global shim path was inspected (**WARN**).
- Harnesses were executed in this session.
- Real exhaustion stderr format is known (**INCONCLUSIVE** by contract).

Contract §12 permits core pool use with residual INCONCLUSIVE on universal exhaustion auto-detect. This release audit agrees.

### Stop

**Explicit stop.** Sole file written: `docs/audits/availability-v5-release-independent-audit.md`. No further actions.

---

## 8. Result Capsule (factual)

```
status: completed
taskId: grok-worker-e6325b92-9461-4900-abc9-3021912bddb6
stage: GROK-WORKER-PROVIDER-V5-RELEASE-INDEPENDENT-AUDIT
authority: docs/contracts/AVAILABILITY-LAYER.plan.v5.md
overallVerdict: PASS
priorIndependent: WARN
priorFinal: PASS
hardFailReopened: none
sectionVerdicts:
  stateMachine: PASS
  probeAuthorization: PASS
  errorAttribution: PASS
  walLocks: PASS
  failoverAttempts: PASS
  schemasApi: PASS
  billing: PASS
  g0Env: PASS
  testsDesign: PASS
  deployPointer: PASS
  securityInvariants: PASS
  residualSection12: INCONCLUSIVE (honest; not false-PASS)
residualWarn:
  - maintenance-probe-execution / pool-refresh-real-spawn incomplete
  - self-rescue uses workload capsule not dedicated maintenance recipe
  - release packaging SHA pipeline incomplete
  - external global shim path not inspected
residualInconclusive:
  - real execution.stderr exhaustion payload format (§12)
changedFiles: [docs/audits/availability-v5-release-independent-audit.md]
forbiddenActionsHonored: [service control, OAuth, account switch, delete data, no shell, no implementation edits]
explicitStop: Write only docs/audits/availability-v5-release-independent-audit.md, return Result Capsule, and stop.
```

---

*End of release independent audit. Stop.*
