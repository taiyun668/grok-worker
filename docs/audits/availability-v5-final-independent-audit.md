# Availability Layer v5 — Final Independent Audit

| Field | Value |
|-------|--------|
| Audit ID | `GROK-WORKER-PROVIDER-V5-FINAL-INDEPENDENT-AUDIT` |
| Task | `grok-worker-468dbcd2-7157-415f-b75c-96df45994074` |
| Claimed HEAD | `432b7f1` (workspace tree audited as presented; **git/shell not used** — commit hash not re-verified by this auditor) |
| Authority contract | `docs/contracts/AVAILABILITY-LAYER.plan.v5.md` (2026-07-21) |
| Prior independent audit | `docs/audits/availability-v5-independent-audit.md` (overall **WARN**; listed closure items) |
| Construction note (non-authority) | `docs/contracts/AVAILABILITY-LAYER.IMPLEMENTATION.v5.md` |
| Auditor posture | Read-only static review of code, schemas, fixtures, tests, entry surfaces; **no** shell, git, OAuth, service control, account switch, data deletion, auth.json access, default `.grok` credential read, or `D:\Grok UI` runtime touch |
| Report date | 2026-07-21 |
| Sole deliverable | `docs/audits/availability-v5-final-independent-audit.md` |

---

## 1. Scope and method

### In scope

- Re-verify **formerly WARN/FAIL** areas from the prior independent audit:
  1. Bounded pool self-rescue (`probeEligible` on `run` + `maxProbesPerRun`)
  2. Durable provider/global health for non-attributable faults
  3. Pointer-driven stable shim and dataRoot/registry root loading
  4. `runTask` multi-attempt / probe self-rescue integration coverage
  5. Free-form `forbiddenActions` compilation (no unsafe CLI interpolation)
  6. Security invariants (auth, default home, OAuth, G-0 hooks, secrets, bash/git/service)
- Supporting alignment for state machine, attribution boundary, WAL/locks, failover, usage-unknown, deploy pointer helpers, residual §12 honesty.

### Out of scope

- Live Grok calls; OAuth; account switch; service control; git mutations; deleting data.
- Executing harnesses (shell forbidden) — **test design and assertions reviewed statically**.
- Packaging/installing the global path `%USERPROFILE%\.local\bin\grok-worker.cmd` outside this repository.
- Closing §12 real-stderr exhaustion format (must remain **INCONCLUSIVE**).

### Rating scale

| Rating | Meaning |
|--------|---------|
| **PASS** | Requirement implemented and aligned with contract intent; evidence present in code and/or static test design |
| **WARN** | Partial implementation, incomplete operator path, or residual risk that does not reverse a prior hard FAIL |
| **FAIL** | Material contract contradiction or safety regression |

---

## 2. PASS / WARN / FAIL summary

| Area | Prior (independent audit) | Final verdict | One-line finding |
|------|---------------------------|---------------|------------------|
| Bounded pool self-rescue (§4 run path) | **FAIL** | **PASS** | `runTask` authorizes `probeEligible` only via `probeSelfRescueAllowed`; `maxProbesPerRun` enforced |
| Durable provider/global health (§5) | **FAIL** | **PASS** | `{DATA_ROOT}/health/provider.json` written for non-attributable faults; profile ledger untouched |
| Pointer-driven shim + root loading (§11) | **WARN/FAIL** | **PASS** | Repo `grok-worker.cmd` + `bin/grok-worker.js` validate `current.json`; env wins; legacy roots preserved |
| `runTask` multi-attempt integration tests | **WARN** (missing) | **PASS** | Mock `executePlanFn` tests: 402 failover (2 Results) + probe self-rescue |
| Free-form `forbiddenActions` compilation | (security/contract) | **PASS** | Free-form text not interpolated into `--deny`; wholesale Bash deny + structured service/git rules |
| Security invariants | **PASS** | **PASS** | No auth.json read; default `.grok` blocked; no auto OAuth; G-0 hooks; secret-key writes guarded |
| Maintenance probe spawn (`after-workload` / `pool refresh --real`) | **WARN** | **WARN** | Still selection/planning metadata only; no auto real maintenance probe spawn |
| Immutable release package + SHA switch pipeline | **WARN** | **WARN** | Helpers + validation only; no in-repo packaging pipeline |
| §12 exhaustion stderr format | **INCONCLUSIVE** | **INCONCLUSIVE** | Correctly **not** closed; synthetic fixtures prove parser only |
| **Overall** | **WARN** | **PASS** (with residual WARNs) | Prior hard blockers closed; residual operator/probe-packaging gaps remain explicit |

---

## 3. Formerly FAIL/WARN area A — Bounded pool self-rescue

### Contract anchor

§4: when pool has no `workloadEligible` (active), pool **run** may select `probeEligible` only under explicit `probePolicy` (`mode=when-no-active` + `realRequestPermission=allowed`); workload `realRequestPermission` alone must not authorize probes; `maxProbesPerRun` bounds probes; `plan` / list / status remain zero real request.

### Evidence (code)

| Check | Verdict | Exact locus |
|-------|---------|-------------|
| Self-rescue gate function | **PASS** | `lib/availability.js` `probeSelfRescueAllowed`: requires `mode==="when-no-active"`, `realRequestPermission==="allowed"`, not blocked by `allowProbeSelection===false`, and `probesUsed < maxProbes` |
| `selectProfile` probe path | **PASS** | `lib/availability.js` `selectProfile`: probe pick only if `options.allowProbeSelection===true` **and** `probeSelfRescueAllowed`; returns `selectionClass:"probeEligible"`; cap reason `max-probes-per-run-exceeded` |
| `runTask` wires flag from policy only | **PASS** | `lib/provider.js` `runTask`: `allowProbeSelection = availability.probeSelfRescueAllowed(probePolicy, { allowProbeSelection: true, probesUsed: 0, maxProbesPerRun })` — **not** hardcoded `false` |
| Workload permission does not enable probes | **PASS** | Comment + gate ignore workload `realRequestPermission`; only `capsule.probePolicy` |
| `maxProbesPerRun` on first selection | **PASS** | After probe selection, `probesUsed += 1` and assert `probesUsed <= probePolicy.maxProbesPerRun` |
| `maxProbesPerRun` on failover handoff | **PASS** | Failover loop: if next eligibility is `probeEligible`, break when `!allowProbeSelection \|\| probesUsed >= maxProbesPerRun` |
| `planTask` zero-request + no probe spawn | **PASS** | `planTask` calls `selectProfile(..., { allowProbeSelection: false })`; `spawnCount: 0`; exposes `probeSelfRescueWouldAuthorize` as informative only |
| Default policy disabled | **PASS** | `defaultProbePolicy()` → `mode:"disabled"`, `realRequestPermission:"denied"`, `maxProbesPerRun:1`; capsule defaulting in `validateTaskCapsule` |

### Evidence (tests — static design)

| Test name | File | What it asserts |
|-----------|------|-----------------|
| `probe-self-rescue-when-no-active` | `tests/availability-harness.js` | denied policy → select fails; allowed + no active → selects probeEligible PROFILE_C |
| `max-probes-per-run-enforced` | same | `probesUsed:1` + max 1 → `max-probes-per-run-exceeded`; `probeSelfRescueAllowed` false |
| `runTask-probe-self-rescue` | same | mock `executePlanFn` success on probeEligible; `probesUsed===1`; selectionClass `probeEligible`; success → availability `active` |

### Residual risk (non-blocking)

- Self-rescue runs the **workload** capsule on a probeEligible profile (full attempt), not a dedicated maintenance probe recipe (`--max-turns 1` only). This matches “pool run 自救” more than “maintenance probe”, and is acceptable for the prior FAIL closure.
- `after-workload` still only sets `maintenanceProbePlanned` without post-run probe execution (**WARN**, §4 residual — see §9).

**Section verdict: PASS** (prior run-path FAIL closed).

---

## 4. Formerly FAIL area B — Durable provider/global health

### Contract anchor

§5: non-account / non-attributable faults write invocation result **and** independent provider/global health; **must not** mutate profile availability.

### Evidence (code)

| Check | Verdict | Exact locus |
|-------|---------|-------------|
| Health path | **PASS** | `lib/availability.js` `providerHealthPath` → `{dataRoot}/health/provider.json` |
| Record non-attributable | **PASS** | `recordProviderHealth`: `scope:"provider"`, `status:"degraded"`, event note `"non-attributable; profile availability not modified"`, events ring-buffer slice(-50) |
| Success clears degradation | **PASS** | `markProviderHealthOk` |
| Wire-in under profile lock path | **PASS** | `lib/provider.js` `persistAvailabilityFromOutcome`: if `!applied.touched` and non-zero exit, calls `recordProviderHealth`; success path calls `markProviderHealthOk` |
| Profile boundary preserved | **PASS** | `shouldTouchAvailability` only for quota_exhausted / reauth_required / account-level rate_limited |
| Schema | **PASS** | `schemas/provider-health.v5.schema.json` |
| Pool visibility | **PASS** | `poolStatus()` includes `providerHealth` summary; `realRequests: 0` |

### Evidence (tests)

| Test | Asserts |
|------|---------|
| `provider-health-non-attributable` | network classification does not touch availability; health degraded; mark OK → healthy / consecutive failures 0 |
| `429-retryable-alone-not-account-level` | `is_retryable=true` alone → not account-level (prior over-attribution WARN closed) |

**Section verdict: PASS**.

---

## 5. Formerly WARN/FAIL area C — Pointer-driven stable shim and root loading

### Contract anchor

§1 / §11: fixed shim reads and validates `current.json` each launch; inherits `dataRoot` / `registryPath`; env must not lose four accounts when code moves; credential profiles stay under approved root (no auth migration).

### Evidence (code / entry)

| Check | Verdict | Exact locus |
|-------|---------|-------------|
| Repo shim documents pointer contract | **PASS** | `grok-worker.cmd`: sets `GROK_WORKER_CURRENT_JSON` default to `%LOCALAPPDATA%\GrokWorkerProvider\current.json`; invokes `node "%~dp0bin\grok-worker.js"`; states no auth/OAuth/D:\Grok UI runtime |
| Node bootstrap validates pointer | **PASS** | `bin/grok-worker.js` `applyPointerEnv`: shape validation (`version`, `releasePath`, `dataRoot`, `registryPath`, optional `manifestSha256` 64 hex); invalid → stderr + exit; absent → continue |
| Env wins over pointer | **PASS** | Sets `GROK_WORKER_DATA_ROOT` / `GROK_WORKER_PROFILES` only if env unset |
| Provider root resolution | **PASS** | `lib/provider.js` `resolveRootsFromPointer`: env → validated pointer → `LEGACY_DATA_ROOT` / `LEGACY_REGISTRY_PATH` under GrokUI |
| Re-apply on main | **PASS** | `main` first calls `applyDeployRoots({ force: true })` |
| Pointer helpers + CLI | **PASS** | `buildCurrentPointer` / `validateCurrentPointer` / `readCurrentPointer`; `deploy pointer` read/write |
| Schema | **PASS** | `schemas/current-pointer.v5.schema.json` |
| Doctor check | **PASS** | `deploy-pointer-valid-or-absent` |

### Evidence (tests)

| Test | Asserts |
|------|---------|
| `deploy-pointer-validate-and-roots` | build/validate/read pointer; env source wins in harness |

### Residual risks (WARN, not re-FAIL)

1. **External global shim path** `%USERPROFILE%\.local\bin\grok-worker.cmd` is outside this repo and was **not** inspected here. Repo shim is correct; install-path fidelity is operational residual.
2. **Immutable `releases\<version>` packaging + SHA-256 verify-before-switch** remains helper/validation-level (`requireRelease` / `expectedManifestSha256` options exist); no packaging pipeline in-repo.
3. Invalid pointer fails fast in `bin/grok-worker.js` (good); absent pointer intentionally falls back to legacy GrokUI roots (good for four accounts).

**Section verdict: PASS** for in-repo pointer-driven bootstrap and root loading; packaging/external install remain residual WARN.

---

## 6. Formerly WARN area D — `runTask` multi-attempt integration coverage

### Contract anchor

§7 / §10: independent Result refs per attempt; no silent overwrite; clean-402 failover; mock suite zero real Grok.

### Evidence (tests — static design)

| Test | File | Assertions reviewed |
|------|------|---------------------|
| `runTask-multi-attempt-402-failover` | `tests/availability-harness.js` | Two attempts; first `quota_exhausted` PROFILE_A; second PROFILE_B completed; distinct `resultRef` and `invocationId`; both Result files exist on disk; taskRun `completed` |
| `runTask-probe-self-rescue` | same | See §3 |
| `concurrent-reservation-and-cas` | same | selection lock conflict on same taskId; CAS second writer `AVAILABILITY_CAS_CONFLICT` |
| Mock surface | same | `executePlanFn` injection; `skipInspect` / `baselineCheckFn` / empty `changedFilesFinalStateFn`; harness footer `realGrokRequests: 0` |

### Evidence (code)

| Check | Verdict | Exact locus |
|-------|---------|-------------|
| WAL + attempts[] | **PASS** | `emptyTaskRun` / `writeTaskRun` / `runTask` updates `attempts`, `finalResultRef`, `probesUsed` |
| Distinct Result paths | **PASS** | `resultPath(taskId, invocationId)` per attempt |
| Failover gate | **PASS** | `mayAutoFailoverAttempt` clean 402 only; partial → `takeoverRequired` |
| Session not reused | **PASS** | `capsule.grokSessionId = null` before next attempt |
| Classify under profile lock | **PASS** | `runSingleAttempt`: classify + `persistAvailabilityFromOutcome` before lock release |
| Usage unknown on missing | **PASS** | `numericUsage(null)` → `present:false`, `unknown:true`, token fields `null` (prior zero-fill WARN closed for absent payloads) |

### Residual

- Concurrent selection test is **single-process sequential lock conflict**, not multi-process load race (**WARN**, same residual as prior audit).
- Harness not executed in this audit (shell forbidden) — design review only.

**Section verdict: PASS** for integration coverage design closing the prior gap.

---

## 7. Free-form `forbiddenActions` compilation

### Requirement (security + D5 plan)

`forbiddenActions` must compile safely into tool filtering / permission rules / PreToolUse posture without injecting free-form human prose into Grok CLI `--deny` grammar (which would break safe workspace-write invocations).

### Evidence (code)

| Check | Verdict | Exact locus |
|-------|---------|-------------|
| Structured denies | **PASS** | `buildPermissionSettings`: always denies `Bash`, MCP, WebFetch/WebSearch, permanent path markers; service/git structured extras when permissions denied/read-only |
| Free-form **not** interpolated | **PASS** | Explicit comment: free-form values must never be interpolated into `--deny`; enforcement is whole-tool Bash deny + dontAsk + path isolation |
| Plan contract | **PASS** | `verifyPlanContract`: `assert(deny.includes("Bash"), ..., "forbiddenActions are enforced through the whole-tool Bash deny, not free-form CLI interpolation.")` |
| Prompt audit trail | **PASS** | `promptFor` includes `Forbidden actions: ${capsule.forbiddenActions.join(", ")}` as human contract text only |
| Capsule still requires non-empty array | **PASS** | `validateTaskCapsule` array validation |

### Evidence (tests)

| Test | File | Asserts |
|------|------|---------|
| G2 free-text forbiddenActions | `tests/provider-harness.js` | free-form strings containing `auth.json` / default `.grok` path **do not** appear in `planTemplate.args`; `verifyPlanContract` still passes with Bash deny |
| Mutation checker (service/git/no-plan) | `tests/provider-harness.js` + `tests/mutation-harness.js` | Removing structured enforcement fails `verifyPlanContract` |

### Residual note

- `tests/mutation-harness.js` seeds a synthetic deny entry `Bash(*OAuth*)` and mutates it; production `buildPermissionSettings` does **not** emit per-phrase OAuth deny tokens (by design). The free-form compilation authority is the provider-harness free-text case + wholesale Bash deny, not per-string CLI patterns. Residual: mutation suite seed is slightly **drifted** from production deny generation (low severity; does not reintroduce free-form interpolation).

**Section verdict: PASS**.

---

## 8. Security invariants (no regression)

| Invariant | Verdict | Evidence |
|-----------|---------|----------|
| Refuse `auth.json` reads | **PASS** | `readJson` basename guard `INV1_AUTH_READ_FORBIDDEN`; harness `security-invariants-no-auth-read` |
| No default user `.grok` as profile home | **PASS** | `validateWindowsPath` / `validateProfile` `INV2_DEFAULT_HOME`; doctor `default-home-forbidden` |
| No auto OAuth / login / logout / account switch | **PASS** | `onboard` returns planned command only; availability bootstrap never touches auth; no spawn of login in availability paths |
| No service control from provider automation | **PASS** | Capsule defaults `serviceControlPermission:"denied"`; deny rules for service/taskkill; task init defaults |
| G-0 compat hooks off | **PASS** | `isolatedEnv` sets `GROK_CLAUDE_HOOKS_ENABLED=false` / `GROK_CURSOR_HOOKS_ENABLED=false`; plan contract asserts; harness G-0 test |
| Secret-shaped keys blocked on durable writes | **PASS** | `hasSecretKeys` + `atomicWriteJson` |
| Billing bounded, whitelist, no symlink | **PASS** | `readBillingSnapshot` size/line caps; reparse skip; `billingPeriodEnd` → `nextProbeAt` only |
| Profiles under approved root | **PASS** | `APPROVED_PROFILE_ROOT`; `validateProfile` path bound |
| Plan never spawns | **PASS** | `planTask` `spawnCount: 0` |
| `run` requires `realRequestPermission=allowed` | **PASS** | hard assert before spawn |
| Mock suite zero real Grok intent | **PASS** | harness footer `realGrokRequests: 0` |

**Section verdict: PASS** — no security regression found in reviewed availability-touching paths.

---

## 9. Supporting areas (reconfirm; not prior hard blockers)

| Area | Verdict | Notes |
|------|---------|-------|
| State machine §3 (7 states, eligibility thirds, bootstrap) | **PASS** | Unchanged solid core; durable state may remain `frozen` while effective `probe_due` at eval time (presentation residual) |
| Error taxonomy §5 (7 classes, attribution boundary) | **PASS** | 429 retryable-alone no longer account-level |
| WAL / locks §6 | **PASS** | selection→profile→workspace; classify under profile lock; interrupted recovery |
| Failover §7 | **PASS** | gate + attempts[] + no silent Result overwrite |
| Schemas §2 | **PASS** | availability, task-run, health, pointer, extended task/result/command-plan |
| Usage unknown | **PASS** | `numericUsage` null fields when absent |
| Success `errorClassification` | **WARN** (low) | still `unknown_failure` + `note:"no-error-on-success"` special case in validator |
| Maintenance probe execution / `pool refresh --real` | **WARN** | `poolRefresh` authorized path still `realRequests: 0`, selection-only note; after-workload not executed post-run |
| Release packaging pipeline | **WARN** | helpers only |
| §12 real exhaustion stderr | **INCONCLUSIVE** | harness `inconclusive` array + contract honesty retained — **no false PASS** |

---

## 10. Prior audit closure matrix

| Prior blocker (#15 closure list) | Status at this audit | Evidence summary |
|----------------------------------|----------------------|------------------|
| 1 Probe self-rescue + `maxProbesPerRun` | **CLOSED / PASS** | `probeSelfRescueAllowed` + `runTask` wiring + unit/integration tests |
| 2 Provider/global health | **CLOSED / PASS** | `health/provider.json` + persist path + schema + test |
| 3 `current.json` shim + roots | **CLOSED / PASS** (in-repo) | `bin/grok-worker.js` + `grok-worker.cmd` + `resolveRootsFromPointer` |
| 4 Mock integration multi-attempt / self-rescue / CAS | **CLOSED / PASS** | three harness tests with mock executor / locks / CAS |
| + 429 retryable-alone | **CLOSED / PASS** | classifier + test |
| + usage-unknown zeros | **CLOSED / PASS** | `numericUsage` + test |
| Exhaustion auto-detect | **Still INCONCLUSIVE** | Correct — not closable without natural stderr sample |

---

## 11. Residual risks (explicit)

### Contract-admitted (must remain open)

1. **INCONCLUSIVE** — real `execution.stderr` exhaustion payload format not observed. Synthetic `fixtures/availability/stderr-402-exhausted.txt` proves parser behavior only. Auto-detect-all-future-exhaustion **not** closed. **No false PASS.**
2. Official reset time not reliably available from headless CLI → `resetAt:null` + backoff `nextProbeAt` (implemented).
3. `unified.jsonl` remains auxiliary; billing is bounded whitelist snapshot only.

### Operational / incomplete (WARN)

| Risk | Severity | Notes |
|------|----------|-------|
| Maintenance probe real execution incomplete | Medium | `after-workload` flag-only; `pool refresh --real allowed` selection-only (`realRequests:0`) |
| External global shim install path not verified | Low–Medium | Outside repo; operators must ensure install shim matches repo contract |
| Release SHA packaging pipeline incomplete | Low–Medium | Atomic pointer replace is the intended switch; packaging not automated here |
| Multi-process reservation race under load | Low | Harness is single-process lock conflict |
| Success Result `errorType: unknown_failure` + note | Low | Validator special-case; slightly awkward taxonomy purity |
| Mutation harness OAuth deny seed drift | Low | Free-form design uses wholesale Bash deny |

---

## 12. What this audit did **not** do

- Did not run `npm run test:v5` / any shell command (forbidden by task).
- Did not modify implementation, schemas, fixtures, task files, registry, runtime data, or Git.
- Did not perform OAuth, service control, account switch, or delete data.
- Did not read any production `auth.json` or default `.grok` credentials.
- Did not touch `D:\Grok UI` runtime directories.
- Did not cryptographically verify commit `432b7f1` (no git).

---

## 13. Final verdict

### Overall: **PASS** — formerly hard WARN/FAIL blockers for Availability Layer v5 are closed in the reviewed tree

**PASS means (for this final independent audit):**

1. Pool **run** can self-rescue via `probeEligible` only under explicit `probePolicy`, with `maxProbesPerRun` enforcement.
2. Non-attributable faults have a durable independent health plane and do not mutate profile availability.
3. In-repo stable entry validates `current.json` and inherits `dataRoot`/`registryPath` (env wins; legacy roots preserved).
4. Mock integration coverage exists for multi-attempt 402 failover and probe self-rescue (static review).
5. Free-form `forbiddenActions` are not unsafe CLI-interpolated; Bash is denied wholesale.
6. Security skeleton invariants hold in reviewed paths.
7. §12 exhaustion detection remains honestly **INCONCLUSIVE**.

**PASS does not mean:**

- Full maintenance-probe auto-execution / `pool refresh` real spawn is complete (**WARN** residual).
- Release packaging pipeline is automated (**WARN** residual).
- Harnesses were executed in this session.
- Git HEAD hash was re-verified.

### Stop

**Explicit stop.** Sole file written: `docs/audits/availability-v5-final-independent-audit.md`. No further actions.

---

## 14. Result Capsule (factual)

```
status: completed
taskId: grok-worker-468dbcd2-7157-415f-b75c-96df45994074
stage: GROK-WORKER-PROVIDER-V5-FINAL-INDEPENDENT-AUDIT
claimedHead: 432b7f1 (unverified by git; workspace tree reviewed)
overallVerdict: PASS
priorOverall: WARN
closedBlockers:
  - pool-self-rescue-on-run + maxProbesPerRun
  - durable-provider-global-health
  - pointer-driven-shim-and-root-loading (in-repo)
  - runTask multi-attempt + probe self-rescue integration tests
  - free-form forbiddenActions safe compilation
  - security invariants (no regression found)
residualWarn:
  - maintenance-probe-execution / pool-refresh-real-spawn incomplete
  - release packaging SHA pipeline incomplete
  - external global shim path not inspected
residualInconclusive:
  - real execution.stderr exhaustion payload format (§12)
changedFiles: [docs/audits/availability-v5-final-independent-audit.md]
forbiddenActionsHonored: [service control, OAuth, account switch, delete data]
explicitStop: Write only docs/audits/availability-v5-final-independent-audit.md, return Result Capsule, and stop.
```

---

*End of final independent audit. Stop.*
