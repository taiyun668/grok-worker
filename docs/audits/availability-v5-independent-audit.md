# Availability Layer v5 — Independent Audit Report

| Field | Value |
|-------|--------|
| Audit ID | `GROK-WORKER-PROVIDER-V5-REPORT-AUDIT` |
| Task | `grok-worker-5bf7d9b3-b942-4a9b-96ad-6d1aebbc6cda` |
| Authority contract | `docs/contracts/AVAILABILITY-LAYER.plan.v5.md` (2026-07-21) |
| Supporting construction note | `docs/contracts/AVAILABILITY-LAYER.IMPLEMENTATION.v5.md` (non-authority) |
| Auditor posture | Read-only code/schema/fixture/test review; **no** shell, git, OAuth, service control, auth.json access, default `.grok`, or `D:\Grok UI` runtime touch |
| Report date | 2026-07-21 |
| Report path | `docs/audits/availability-v5-independent-audit.md` (sole deliverable) |

---

## 1. Scope

### In scope

- Contract: `docs/contracts/AVAILABILITY-LAYER.plan.v5.md` §§0–14 (state machine, probe authorization, error attribution, WAL/locks, failover, schemas/API, deploy pointer, credential/default-home safety, tests, residual risks).
- Implementation: `lib/availability.js`, `lib/provider.js` (availability integration only: `runTask`, selection, locks, capsules, deploy helpers, pool/bootstrap).
- Schemas: `schemas/availability.provider.v5.schema.json`, `schemas/task-run.provider.v5.schema.json`, `schemas/task-capsule.provider.v3.schema.json`, `schemas/result-capsule.provider.v3.schema.json`, `schemas/command-plan.provider.v3.schema.json`.
- Fixtures: `fixtures/availability/*`.
- Tests: `tests/availability-harness.js`, package scripts `test:v5` / `test:availability`.
- Entry surfaces: `bin/grok-worker.js`, repo `grok-worker.cmd`, README deploy/pool notes (read for §11/§1 alignment only).

### Out of scope

- Live Grok calls, OAuth, account switch, service control, git mutations.
- Reading, copying, or hashing any `auth.json` or default user `.grok` tree.
- `D:\Grok UI` runtime directories and any production credential-bearing profile contents.
- Full re-audit of security skeleton G0–G9 beyond availability-touching invariants (credential, default-home, hooks G-0).
- Execution of harnesses (this audit is static; harness **design** was reviewed).

### Method

Static consistency review: contract requirement → code path → schema → fixture/test coverage. Ratings:

| Rating | Meaning |
|--------|---------|
| **PASS** | Requirement is implemented and aligned with contract intent |
| **WARN** | Partial implementation, missing edge coverage, or acceptable interpretation with residual risk |
| **FAIL** | Material contract gap or unsafe contradiction |

---

## 2. PASS / WARN / FAIL summary table

| Area | Verdict | One-line finding |
|------|---------|------------------|
| State transitions (§3) | **PASS** | Seven states, freeze/cooldown/`reauth_required`, `nextProbeAt`, deterministic eligibility, bootstrap present |
| Probe authorization (§4) | **WARN** | Policy model + defaults correct; `run` never selects `probeEligible`; real maintenance probe path incomplete |
| Error attribution (§5) | **WARN** | Seven-class + profile boundary correct; no independent provider/global health store for non-attributable faults |
| WAL / locks (§6) | **PASS** | WAL + classify-under-profile-lock rewrite; selection→profile→workspace; interrupted recovery |
| Failover / attempts[] (§7) | **PASS** | Clean-402 gate, per-attempt Result refs, no session reuse; usage “unknown” only partially strict |
| Schema / API (§2) | **PASS** | Availability + task-run v5; task/result/command-plan extended; `validateResultCapsule` updated |
| Deploy pointer (§1, §11) | **WARN** | `current.json` helpers exist; immutable release + shim-read-pointer story not fully landed |
| Credential / default-home safety | **PASS** | No auth.json read; default `.grok` blocked; OAuth not auto-executed; G-0 hooks injected |
| Test sufficiency (§10) | **WARN** | Strong unit/fixture mock suite; weak end-to-end `runTask` / multi-attempt / probe self-rescue coverage |
| Residual risks (§12) | **PASS** | Real stderr exhaustion format remains explicitly **INCONCLUSIVE** (no false PASS) |

---

## 3. State transitions (§3)

| Check | Verdict | Evidence |
|-------|---------|----------|
| Seven durable states | **PASS** | `AVAILABILITY_STATES` in `lib/availability.js`; schema enum matches |
| `quota_exhausted` → `frozen` (scope=quota) | **PASS** | `applyClassificationToAvailability` |
| `reauth_required` → independent state, no auto-probe | **PASS** | `state=reauth_required`, `nextProbeAt=null`, eligibility `excluded` |
| Account-level / Retry-After `rate_limited` → `cooldown` | **PASS** | `scope=rate_limit` + `computeNextProbeAt` |
| Non-account errors do not change durable eligibility transition | **PASS** | `shouldTouchAvailability` / `touched:false` |
| `nextProbeAt` mandatory on freeze/cooldown (`resetAt:null` → backoff) | **PASS** | `computeNextProbeAt` + harness `nextProbeAt-required-on-freeze` |
| Deterministic eligibility §3.3 (incl. expired frozen/cooldown → probeEligible / effective `probe_due`) | **PASS** | `evaluateEligibility` pure function; harness `eligibility-cooldown-and-frozen-expiry` |
| Bootstrap: success→active, controlled 402→frozen, else unknown | **PASS** | `bootstrapAvailability` + CLI `pool bootstrap` |
| Durable write of state `probe_due` | **WARN** | Expiry maps to **effective** `probe_due` at evaluation time without always rewriting durable `state` to `probe_due` — consistent with “选择时求值”, but pool status may show durable `frozen` while `effectiveState=probe_due` |

**Section verdict: PASS** (minor durability presentation WARN does not break eligibility semantics).

---

## 4. Probe authorization (§4)

| Check | Verdict | Evidence |
|-------|---------|----------|
| `probePolicy` shape `mode \| realRequestPermission \| maxProbesPerRun` | **PASS** | Schema `$defs.probePolicy`; `defaultProbePolicy` / `normalizeProbePolicy` |
| Default `disabled` + `realRequestPermission:denied` | **PASS** | Defaults; capsule validation injects default |
| `plan` exposes maintenance probe intent | **PASS** | `planTask` returns `maintenanceProbePlanned` + `probePolicy` |
| Workload `realRequestPermission:allowed` does not alone authorize maintenance probes | **PASS** | Probe plan requires `probePolicy.realRequestPermission===allowed` and mode ≠ `disabled` |
| `profiles list` / `pool status` / `plan` zero real requests | **PASS** | No spawn in those paths; `poolStatus.realRequests: 0` tested |
| Pool self-rescue: no active → optional `probeEligible` under explicit policy | **FAIL** | `selectProfile` supports it only when `allowProbeSelection===true`, but `runTask` / `planTask` **hardcode** `allowProbeSelection: false` — authorized `when-no-active` never selects probe-eligible workers on run |
| `maxProbesPerRun` enforced | **WARN** | Normalized/capped in policy object; **not** enforced in `runTask` attempt loop |
| `after-workload` maintenance probe execution | **WARN** | Sets `maintenanceProbePlanned` only; no post-workload probe invocation path |
| `pool refresh --real allowed` independent real probes | **WARN** | Dry path returns zero requests; authorized path lists probeEligible but **does not spawn** (`realRequests: 0`, “selection-only refresh”) — safer than silent real calls, but incomplete vs contract “可独立触发探针” |
| Per-profile single-flight + global probe frequency + probe capsule shape | **WARN** | Profile lock covers concurrent profile use if probes share `runSingleAttempt`; dedicated probe recipe (`--max-turns 1` etc.) and global frequency cap not implemented as distinct maintenance-probe machinery |

**Section verdict: WARN** (safe-by-default, but **self-rescue on run is effectively disabled** and real maintenance probe execution is stubbed).

---

## 5. Error attribution (§5)

| Check | Verdict | Evidence |
|-------|---------|----------|
| In-memory classifier + redacted stderr | **PASS** | `classifyFromExecution` + `redactText` before classify |
| Seven error types | **PASS** | `ERROR_TYPES`; fixtures for 402/429/401/network/unknown + inline model/provider |
| Only attributable types touch profile availability | **PASS** | `quota_exhausted`, `reauth_required`, account-level `rate_limited` |
| Bare/no-evidence 429 does not freeze/cooldown | **PASS** | `stderr-429-no-evidence.txt` → `profileAttributable:false` |
| Unrecognized exit 1 → `unknown_failure`, no freeze | **PASS** | Default branch of `classifyError` |
| Independent provider/global health for non-attributable faults | **FAIL** | Contract requires writing invocation result **and** independent provider/global health; only Result Capsule / classification exist — **no** provider/global health ledger |
| Over-attribution risk on 429 | **WARN** | `accountLevelEvidence` becomes true if `retryable===true` alone (even without account keywords / Retry-After) — may cooldown more aggressively than “账号级证据或可信 Retry-After” |
| Real exhaustion stderr format | **PASS** (honesty) | Conservative parser + synthetic fixture; residual §12 INCONCLUSIVE retained in result residual risks and harness output |

**Section verdict: WARN** (core attribution boundary is correct; missing health plane + 429 edge).

---

## 6. WAL / locks (§6)

| Check | Verdict | Evidence |
|-------|---------|----------|
| WAL path `{DATA_ROOT}/runs/{taskId}/{runId}.json` | **PASS** | `runWalPath` / `emptyTaskRun` / `writeTaskRun` |
| Status `planned → running → completed|failed` | **PASS** | `runTask` |
| Crash recovery: leftover `running` → `interrupted`, no invented success | **PASS** | `recoverInterruptedRuns` on `main` startup; harness |
| Classify + availability CAS while holding profile lock | **PASS** | `runSingleAttempt`: classify + `persistAvailabilityFromOutcome` before lock release |
| Lock scopes `selection` / `availability` / `profile` / `workspace` | **PASS** | `acquireLock` conflict rules |
| Lock order selection → profile → workspace | **PASS** | Selection held until first profile lock acquired, then released |
| Reservation lease covers select→run-lock handoff | **PASS** (as selection lock) | Implemented as task-scoped `selection` lock rather than a separate reservation object — semantically matches lease coverage |
| Concurrent reservation race fixture | **WARN** | Harness proves sequential selection conflict, not multi-process race under load |

**Section verdict: PASS** (addresses contract race at former `runTask` pre-classify unlock).

---

## 7. Failover / attempts[] (§7)

| Check | Verdict | Evidence |
|-------|---------|----------|
| task-run outer record with `attempts[]` | **PASS** | Schema + `emptyTaskRun` + `runTask` updates |
| Independent invocationId + Result path per attempt | **PASS** | `resultPath(taskId, invocationId)`; no overwrite of prior Result files |
| Auto next worker only on clean 402 (no output/tools/changes) | **PASS** | `mayAutoFailoverAttempt` |
| Partial modifications → takeover | **PASS** | `takeoverRequired` |
| No reuse of prior Grok session across accounts | **PASS** | `capsule.grokSessionId = null` before next attempt |
| 402 usage stays unknown, not invented 0 | **WARN** | `runUsage.present=false` when usage missing; `numericUsage` still fills token fields with `0` when object absent/partial — ledger layers skip non-present, but zeroed fields remain on the record |
| Whitelist failover (`allowedFallbackProfileIds` / legacy aliases) | **PASS** | Schema oneOf + `resolveFailoverIds` / `mayFailover` |
| Silent Result overwrite forbidden | **PASS** | Distinct refs; finalResultRef points at last attempt without deleting priors |

**Section verdict: PASS** (usage zero-fill is residual WARN, not a silent success overwrite).

---

## 8. Schema / API (§2)

| Check | Verdict | Evidence |
|-------|---------|----------|
| Availability record ledger schema v5 | **PASS** | `availability.provider.v5.schema.json` + CAS fields |
| task-capsule explicit \| pool `oneOf` | **PASS** | Schema + `validateTaskCapsule` mixed-mode reject |
| `candidateProfileIds` = UUID profileId | **PASS** | Schema + runtime UUID checks |
| `allowedFallbackProfileIds` upgrade, no mix with aliases | **PASS** | Schema + validation |
| `probePolicy` on capsule | **PASS** | Schema + defaults |
| Result: `profileId`, `selectionEvidence`, `errorClassification` | **PASS** | Schema required; `buildResultCapsule` / `validateResultCapsule` |
| command-plan: selectionMode, candidates, skippedReasons, maintenanceProbePlanned | **PASS** | Schema required fields; `materialize` / `planTask` |
| task-run.provider.v5.schema.json | **PASS** | Matches contract fields |
| Success path `errorClassification.errorType` | **WARN** | Uses `unknown_failure` + `note: no-error-on-success` rather than a dedicated “none”; validator special-cases note — works, slightly awkward vs taxonomy purity |

**Section verdict: PASS**.

---

## 9. Deploy pointer (§1, §11)

| Check | Verdict | Evidence |
|-------|---------|----------|
| Pointer fields version/releasePath/previousVersion/dataRoot/registryPath/schemaVersions/manifestSha256 | **PASS** | `buildCurrentPointer` / `readCurrentPointer` |
| Path `%LOCALAPPDATA%\GrokWorkerProvider\current.json` | **PASS** | `CURRENT_POINTER_PATH` (overridable via env) |
| CLI `deploy pointer` | **PASS** | `main` branch |
| Immutable `releases\<version>` package + SHA-256 verify-before-switch | **WARN** | Helpers only; no release packaging/verification pipeline in-repo |
| Fixed global shim reads/validates `current.json` every launch | **FAIL** | Repo `grok-worker.cmd` invokes local `bin\grok-worker.js` directly; no pointer read. README still describes shim as install-path oriented |
| New install inherits old dataRoot/registryPath from pointer | **WARN** | Pointer can **record** paths; default `DATA_ROOT` remains `...\GrokUI\worker-provider` unless env/pointer wiring is applied at process start — not auto-loaded from `current.json` on every command |
| Credential profiles remain under approved codex-grok-workers root | **PASS** | `APPROVED_PROFILE_ROOT` unchanged; no auth migration |

**Section verdict: WARN** (pointer API present; §11 single-pointer atomic deploy not fully operationalized).

---

## 10. Credential / default-home safety

| Check | Verdict | Evidence |
|-------|---------|----------|
| Refuse `auth.json` reads | **PASS** | `readJson` basename guard; harness `security-invariants-no-auth-read` |
| No default user `.grok` as profile home | **PASS** | `validateWindowsPath` / `validateProfile` / doctor check |
| No OAuth/login/logout/account switch automation in availability paths | **PASS** | `onboard` returns planned command only; availability bootstrap never touches auth |
| G-0: isolated env disables Claude/Cursor compat hooks | **PASS** | `isolatedEnv`; `planTemplate`/`verifyPlanContract`; doctor check; harness |
| Availability writes metadata-only + secret key scan | **PASS** | `atomicWriteJson` + `hasSecretKeys`; billing whitelist rebuild |
| Billing reads profile-owned logs only, skip symlink/reparse | **PASS** | `readBillingSnapshot` bounds + optional `checkNoReparse` |
| `billingPeriodEnd` only affects `nextProbeAt`, never grants `active` | **PASS** | `applyBillingToNextProbe`; harness |

**Section verdict: PASS**.

---

## 11. Test sufficiency (§10)

| Contract fixture/theme | Covered? | Notes |
|------------------------|----------|-------|
| 402 attribution | Yes | Fixture + classify test |
| Seven-class taxonomy | Yes | Fixture/inline cases |
| Non-account errors no profile touch | Yes | Network/unknown/bare 429 |
| Candidate thirds + cooldown/frozen expiry | Yes | Eligibility + `buildCandidateSets` |
| probePolicy default disabled | Yes | |
| Explicit never replaced | Yes | |
| CAS stale revision | Yes | |
| WAL interrupted recovery | Yes | |
| Failover gate (clean 402 vs partial) | Yes | Gate unit only |
| attempts[] no silent overwrite | Partial | Gate unit; **no** multi-attempt `runTask` with mocked executor writing two Result files |
| Billing → nextProbeAt only | Yes | Synthetic jsonl |
| UTF-16 normalize regression | Yes | |
| Bootstrap | Yes | |
| Lock scopes | Yes | Sequential conflict |
| Result capsule extensions | Yes | |
| Selection modes | Yes | |
| Reservation multi-holder race | Weak | Single-process conflict only |
| `runTask` classify-under-lock e2e | **Missing** | No mock `executePlanFn` integration in harness |
| Probe self-rescue on run | **Missing** | Would currently fail by design (`allowProbeSelection:false`) |
| Live canary opt-in isolation | N/A static | Live setup scripts exist separately; mock suite correctly zeros real requests |

**Harness design notes**

- `npm run test:v5` → `tests/availability-harness.js`: 100% fixture/mock intent is clear and correct.
- `fixtures/availability/cases.json` lists `attempts-transaction-no-overwrite` while harness test name is `attempts-transaction-and-failover-gate` — documentation drift only.
- Harness declares residual INCONCLUSIVE for real stderr exhaustion format — aligned with §12.

**Section verdict: WARN** (mock unit coverage is solid for the layer library; integration gaps remain for the rewritten `runTask` transaction).

---

## 12. Residual risks (contract §12 + newly observed)

### Contract-admitted (must stay open)

1. **INCONCLUSIVE — real `execution.stderr` exhaustion payload**  
   Synthetic `stderr-402-exhausted.txt` proves parser behavior only. Auto-detect-all-future-exhaustion is **not** closed. Implementation correctly documents this in Result residual risks and harness output. **No false PASS.**

2. Official reset time not reliably available from headless CLI → default `resetAt:null` + exponential backoff probe schedule. Implemented.

3. `unified.jsonl` remains auxiliary; billing path is bounded, whitelist-only, synthetic-fixture-backed.

### Newly observed residual risks

| Risk | Severity | Notes |
|------|----------|-------|
| Pool cannot self-rescue via authorized probeEligible on `run` | Medium | `allowProbeSelection` permanently false in production paths |
| No provider/global health channel | Medium | Non-attributable outages leave no durable health signal beyond per-invocation Result |
| Deploy pointer not bootstrapping process roots | Medium | Multi-version atomic switch incomplete; risk of dual roots if partially adopted |
| 429 over-attribution when `is_retryable=true` only | Low–Medium | May cooldown without strong account evidence |
| `numericUsage` zero defaults | Low | `present:false` mitigates ledger sums; still noisy |
| Maintenance probe / `pool refresh --real` incomplete | Medium | Operators may believe probes run when only selection metadata is returned |
| Success Result uses `errorType: unknown_failure` + note | Low | Schema/validator special case; confusing to consumers |

---

## 13. Detailed requirement trace (selected anchors)

| Contract anchor | Implementation locus | Audit note |
|-----------------|----------------------|------------|
| §2.1 availability ledger | `DATA_ROOT/availability/{profileId}.json` + CAS | PASS |
| §2.5 task-run | `schemas/task-run.provider.v5.schema.json` + WAL writers | PASS |
| §3.3 eligibility | `evaluateEligibility` | PASS |
| §4.2 probePolicy default disabled | `defaultProbePolicy` + capsule defaulting | PASS |
| §4 pool self-rescue | `selectProfile` + **disabled caller flag** | FAIL path |
| §5 attribution boundary | `shouldTouchAvailability` | PASS |
| §5 provider/global health | — | FAIL missing |
| §6 lock race fix | `runSingleAttempt` order | PASS |
| §7 failover gate | `mayAutoFailoverAttempt` | PASS |
| §8 billing | `readBillingSnapshot` / `applyBillingToNextProbe` | PASS |
| §9 G-0 hooks | `isolatedEnv` + plan contract | PASS |
| §11 current.json | helpers + CLI; incomplete shim/release | WARN |
| §12 INCONCLUSIVE | docs + harness + residualRisks | PASS honesty |

---

## 14. Final verdict

### Overall: **WARN — core availability v5 is implementable and largely aligned; not full contract PASS**

**What is solid enough for cautious core-pool use (as §12 allows):**

- Independent availability ledger with CAS and seven states.
- Deterministic eligibility including cooldown/frozen expiry → probeEligible.
- Conservative seven-class classifier with correct **profile** attribution boundary for the main 402/401/bare-429 cases.
- `runTask` lock/WAL rewrite that classifies and persists availability **under profile lock**.
- Schema surface for pool/explicit selection, probePolicy, selectionEvidence, errorClassification, task-run attempts.
- Credential / default-home / G-0 hook safety invariants preserved in reviewed paths.
- Mock harness with zero real Grok intent and honest INCONCLUSIVE residual.

**What blocks a clean PASS:**

1. **Probe authorization incomplete in the run path** — authorized probeEligible self-rescue never fires (`allowProbeSelection: false`); real maintenance probes / `pool refresh --real allowed` do not perform real probes.
2. **§5 provider/global health plane missing** for non-attributable failures.
3. **§11 deploy** is helper-level only: fixed shim does not validate/switch via `current.json`; process does not load dataRoot/registryPath from pointer by default.
4. **Test gap** on multi-attempt `runTask` transaction and probe self-rescue e2e.

### Recommended closure criteria (for a future re-audit, not executed here)

1. Wire `allowProbeSelection` from `probePolicy` (and only then) so `when-no-active` + `realRequestPermission:allowed` can select probeEligible on pool run; enforce `maxProbesPerRun`.
2. Implement or explicitly scope-narrow “provider/global health” durable records for non-attributable faults.
3. Make global shim read/validate `current.json`; default DATA_ROOT/registry from pointer; document release SHA flow.
4. Add harness e2e: mocked `executePlanFn` 402 → second attempt Result; probe self-rescue; CAS under concurrent selection.
5. Keep exhaustion auto-detect **INCONCLUSIVE** until a natural real stderr sample is captured.

---

## 15. Closure implementation note (2026-07-21, task GROK-WORKER-PROVIDER-V5-AUDIT-FIX)

Implemented without weakening security (no auth.json, no default `.grok`, no OAuth/service/git mutations):

| # | Closure | Implementation |
|---|---------|----------------|
| 1 | Probe self-rescue + `maxProbesPerRun` | `probeSelfRescueAllowed`; `runTask` sets `allowProbeSelection` only from probePolicy; attempt loop counts probeEligible; plan remains zero-request |
| 2 | Provider/global health | `{DATA_ROOT}/health/provider.json` via `recordProviderHealth` / `markProviderHealthOk`; non-attributable path in `persistAvailabilityFromOutcome` |
| 3 | `current.json` shim + roots | `bin/grok-worker.js` + `grok-worker.cmd` validate pointer; `resolveRootsFromPointer` / `applyDeployRoots`; legacy GrokUI roots preserved; env wins |
| 4 | Mock integration | `tests/availability-harness.js`: multi-attempt 402 failover, probe self-rescue, concurrent reservation/CAS |
| + | 429 attribution | `is_retryable=true` alone no longer sets account-level evidence |
| + | usage-unknown | `numericUsage(null)` returns `present:false`, `unknown:true`, null token fields |

Exhaustion auto-detect remains **INCONCLUSIVE** (§12).

### Auditor sign-off

| Item | Statement |
|------|-----------|
| False PASS on §12 exhaustion detection? | **No** |
| Auth/default-home safety regression found in reviewed availability paths? | **No** |
| Sole file modified by this audit task? | `docs/audits/availability-v5-independent-audit.md` |
| Final rating | **WARN** |

---

*End of independent audit report.*
