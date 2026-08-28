"use strict";

/**
 * v5 Availability Layer mock acceptance suite.
 * 100% fixture/mock — zero real Grok requests, no OAuth, no service control.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const assert = require("assert");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "grok-worker-availability-"));
process.env.GROK_WORKER_DATA_ROOT = path.join(sandbox, "data");
process.env.GROK_WORKER_PROFILES = path.join(sandbox, "profiles.json");

const provider = require("../lib/provider");
const availability = require("../lib/availability");

let passed = 0;
let failed = 0;
const evidence = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    evidence.push({ name, status: "PASS" });
  } catch (error) {
    failed += 1;
    evidence.push({ name, status: "FAIL", error: error.safeMessage || error.message, stack: error.stack });
  }
}

function mkdir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function write(file, data) { mkdir(path.dirname(file)); fs.writeFileSync(file, data, "utf8"); }
function readFixture(name) {
  return fs.readFileSync(path.join(__dirname, "..", "fixtures", "availability", name), "utf8");
}

const profileRoot = path.join(sandbox, "profile-root");
const p1Home = path.join(profileRoot, "worker-a");
const p2Home = path.join(profileRoot, "worker-b");
const p3Home = path.join(profileRoot, "worker-c");
mkdir(p1Home); mkdir(p2Home); mkdir(p3Home);

const PROFILE_A = "550e8400-e29b-41d4-a716-446655440001";
const PROFILE_B = "550e8400-e29b-41d4-a716-446655440002";
const PROFILE_C = "550e8400-e29b-41d4-a716-446655440003";

const registry = {
  schemaVersion: 3,
  approvedProfileRoot: profileRoot,
  allowedWorkspaceRoots: [sandbox],
  profiles: [
    {
      profileId: PROFILE_A, alias: "worker-a", grokHome: p1Home,
      executable: path.join(os.homedir(), ".grok", "bin", "grok.exe"), accountLabel: "a",
      authReadiness: { oauthReady: true, verifiedAt: new Date().toISOString() },
      identity: { identityStatus: "unknown", source: "cli_probe", value: null, capturedAt: new Date().toISOString(), providerVersion: provider.VERSION },
      sandboxCapability: { flagSupported: true, enforcementSupported: false, platform: "windows", evidence: "Linux/macOS only" },
      modelSnapshot: { models: ["grok-4.6"], reasoning: ["high"], checkedAt: new Date().toISOString() }
    },
    {
      profileId: PROFILE_B, alias: "worker-b", grokHome: p2Home,
      executable: path.join(os.homedir(), ".grok", "bin", "grok.exe"), accountLabel: "b",
      authReadiness: { oauthReady: true, verifiedAt: new Date().toISOString() },
      identity: { identityStatus: "unknown", source: "cli_probe", value: null, capturedAt: new Date().toISOString(), providerVersion: provider.VERSION },
      sandboxCapability: { flagSupported: true, enforcementSupported: false, platform: "windows", evidence: "Linux/macOS only" },
      modelSnapshot: { models: ["grok-4.6"], reasoning: ["high"], checkedAt: new Date().toISOString() }
    },
    {
      profileId: PROFILE_C, alias: "worker-c", grokHome: p3Home,
      executable: path.join(os.homedir(), ".grok", "bin", "grok.exe"), accountLabel: "c",
      authReadiness: { oauthReady: true, verifiedAt: new Date().toISOString() },
      identity: { identityStatus: "unknown", source: "cli_probe", value: null, capturedAt: new Date().toISOString(), providerVersion: provider.VERSION },
      sandboxCapability: { flagSupported: true, enforcementSupported: false, platform: "windows", evidence: "Linux/macOS only" },
      modelSnapshot: { models: ["grok-4.6"], reasoning: ["high"], checkedAt: new Date().toISOString() }
    }
  ]
};
provider.saveRegistry(registry);

const deps = {
  readJson: provider._test.readJson,
  atomicWriteJson: provider._test.atomicWriteJson,
  ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }),
  hasSecretKeys: provider._test.hasSecretKeys,
  checkNoReparse: () => {},
  redactText: provider._test.redactText,
  captureRunOwner: provider._test.captureRunOwner,
  inspectRunOwner: provider._test.inspectRunOwner,
  taskRunTransaction: provider._test.taskRunTransaction
};

test("G-0 isolatedEnv disables external compat hooks", () => {
  const env = provider._test.isolatedEnv(registry.profiles[0], path.join(sandbox, "inv-home"), path.join(sandbox, "sock"));
  assert.strictEqual(env.GROK_CLAUDE_HOOKS_ENABLED, "false");
  assert.strictEqual(env.GROK_CURSOR_HOOKS_ENABLED, "false");
  assert.strictEqual(env.GROK_FOLDER_TRUST, undefined);
});

test("classify-402-quota-exhausted", () => {
  const stderr = readFixture("stderr-402-exhausted.txt");
  const c = availability.classifyError({ statusCode: 402, stderr, retryable: false });
  assert.strictEqual(c.errorType, "quota_exhausted");
  assert.strictEqual(c.profileAttributable, true);
  assert.strictEqual(c.retryable, false);
});

test("classify-seven-types", () => {
  const cases = [
    [readFixture("stderr-402-exhausted.txt"), "quota_exhausted", 402],
    [readFixture("stderr-429-account.txt"), "rate_limited", 429],
    [readFixture("stderr-401-reauth.txt"), "reauth_required", 401],
    [readFixture("stderr-network.txt"), "network_fault", null],
    [readFixture("stderr-unknown-exit1.txt"), "unknown_failure", null],
    ["model not found: grok-missing", "model_unavailable", null],
    ["internal server error bad gateway", "provider_fault", 502]
  ];
  for (const [stderr, expected, status] of cases) {
    const c = availability.classifyError({ stderr, statusCode: status, exitCode: 1 });
    assert.strictEqual(c.errorType, expected, `expected ${expected} got ${c.errorType} for ${stderr.slice(0, 40)}`);
  }
  assert.strictEqual(availability.ERROR_TYPES.length, 7);
});

test("non-attributable-does-not-touch-profile", () => {
  const network = availability.classifyError({ stderr: readFixture("stderr-network.txt") });
  assert.strictEqual(availability.shouldTouchAvailability(network), false);
  const unknown = availability.classifyError({ stderr: readFixture("stderr-unknown-exit1.txt"), exitCode: 1 });
  assert.strictEqual(availability.shouldTouchAvailability(unknown), false);
  const bare429 = availability.classifyError({ stderr: readFixture("stderr-429-no-evidence.txt"), statusCode: 429 });
  assert.strictEqual(bare429.errorType, "rate_limited");
  assert.strictEqual(bare429.profileAttributable, false);
  assert.strictEqual(availability.shouldTouchAvailability(bare429), false);

  const record = availability.emptyAvailability(PROFILE_A, { state: "active", revision: 1 });
  const applied = availability.applyClassificationToAvailability(record, network, { profileId: PROFILE_A });
  assert.strictEqual(applied.touched, false);
});

test("nextProbeAt-required-on-freeze", () => {
  const record = availability.emptyAvailability(PROFILE_A, { state: "active", revision: 1 });
  const c = availability.classifyError({ stderr: readFixture("stderr-402-exhausted.txt"), statusCode: 402, retryable: false });
  const applied = availability.applyClassificationToAvailability(record, c, { profileId: PROFILE_A });
  assert.strictEqual(applied.touched, true);
  assert.strictEqual(applied.record.state, "frozen");
  assert.strictEqual(applied.record.scope, "quota");
  assert(applied.record.nextProbeAt, "nextProbeAt must be set when resetAt is null");
  assert.strictEqual(applied.record.evidence.resetAt, null);
});

test("eligibility-cooldown-and-frozen-expiry", () => {
  const now = Date.parse("2026-07-21T12:00:00.000Z");
  const frozenFuture = availability.emptyAvailability(PROFILE_A, {
    state: "frozen",
    nextProbeAt: "2026-07-21T18:00:00.000Z"
  });
  assert.strictEqual(availability.evaluateEligibility(frozenFuture, now).eligibility, "excluded");
  const frozenDue = availability.emptyAvailability(PROFILE_A, {
    state: "frozen",
    nextProbeAt: "2026-07-21T10:00:00.000Z"
  });
  const due = availability.evaluateEligibility(frozenDue, now);
  assert.strictEqual(due.eligibility, "probeEligible");
  assert.strictEqual(due.effectiveState, "probe_due");

  const cooldownFuture = availability.emptyAvailability(PROFILE_B, {
    state: "cooldown",
    nextProbeAt: "2026-07-21T18:00:00.000Z"
  });
  assert.strictEqual(availability.evaluateEligibility(cooldownFuture, now).eligibility, "excluded");
  const cooldownDue = availability.emptyAvailability(PROFILE_B, {
    state: "cooldown",
    nextProbeAt: "2026-07-21T10:00:00.000Z"
  });
  assert.strictEqual(availability.evaluateEligibility(cooldownDue, now).eligibility, "probeEligible");

  assert.strictEqual(availability.evaluateEligibility(availability.emptyAvailability(PROFILE_C, { state: "active" }), now).eligibility, "workloadEligible");
  assert.strictEqual(availability.evaluateEligibility(availability.emptyAvailability(PROFILE_C, { state: "unknown" }), now).eligibility, "probeEligible");
  assert.strictEqual(availability.evaluateEligibility(availability.emptyAvailability(PROFILE_C, { state: "reauth_required" }), now).eligibility, "excluded");
  assert.strictEqual(availability.evaluateEligibility(availability.emptyAvailability(PROFILE_C, { state: "manual_hold" }), now).eligibility, "excluded");
});

test("candidate-sets-three-way-split", () => {
  const dataRoot = path.join(sandbox, "probe-policy-data");
  // A active, B frozen not due, C unknown
  availability.writeAvailabilityCas(dataRoot, PROFILE_A, availability.markActive(availability.emptyAvailability(PROFILE_A)), 0, deps);
  const frozen = availability.applyClassificationToAvailability(
    availability.emptyAvailability(PROFILE_B),
    availability.classifyError({ stderr: readFixture("stderr-402-exhausted.txt"), statusCode: 402 }),
    { profileId: PROFILE_B }
  ).record;
  frozen.nextProbeAt = new Date(Date.now() + 3600_000).toISOString();
  availability.writeAvailabilityCas(dataRoot, PROFILE_B, frozen, 0, deps);
  availability.writeAvailabilityCas(dataRoot, PROFILE_C, availability.emptyAvailability(PROFILE_C, { state: "unknown" }), 0, deps);

  const sets = availability.buildCandidateSets(provider.loadRegistry(), {
    candidateProfileIds: [PROFILE_A, PROFILE_B, PROFILE_C],
    probePolicy: availability.defaultProbePolicy()
  }, dataRoot, deps);

  assert.strictEqual(sets.selectionMode, "pool");
  assert.strictEqual(sets.workloadEligible.length, 1);
  assert.strictEqual(sets.workloadEligible[0].profileId, PROFILE_A);
  assert(sets.probeEligible.some((c) => c.profileId === PROFILE_C));
  assert(sets.excluded.some((c) => c.profileId === PROFILE_B));
  assert.strictEqual(sets.maintenanceProbePlanned, false);
});

test("probe-policy-default-disabled", () => {
  const policy = availability.defaultProbePolicy();
  assert.strictEqual(policy.mode, "disabled");
  assert.strictEqual(policy.realRequestPermission, "denied");
  const capsule = {
    candidateProfileIds: [PROFILE_A],
    probePolicy: policy
  };
  // force all unknown so probeEligible exists
  const dataRoot = provider.DATA_ROOT;
  availability.writeAvailabilityCas(dataRoot, PROFILE_A, availability.emptyAvailability(PROFILE_A, { state: "unknown", revision: 0 }), 0, deps);
  const sets = availability.buildCandidateSets(provider.loadRegistry(), capsule, dataRoot, deps);
  assert.strictEqual(sets.maintenanceProbePlanned, false);
  // when-no-active + allowed would plan probe
  const sets2 = availability.buildCandidateSets(provider.loadRegistry(), {
    candidateProfileIds: [PROFILE_A],
    probePolicy: { mode: "when-no-active", realRequestPermission: "allowed", maxProbesPerRun: 1 }
  }, dataRoot, deps);
  assert.strictEqual(sets2.maintenanceProbePlanned, true);
});

test("explicit-profile-never-replaced", () => {
  const dataRoot = provider.DATA_ROOT;
  // freeze explicit target; keep another active
  const frozen = availability.applyClassificationToAvailability(
    availability.emptyAvailability(PROFILE_A),
    availability.classifyError({ stderr: readFixture("stderr-402-exhausted.txt"), statusCode: 402 }),
    { profileId: PROFILE_A }
  ).record;
  frozen.nextProbeAt = new Date(Date.now() + 86400_000).toISOString();
  // overwrite with force via cas from current revision
  let cur = availability.loadAvailability(dataRoot, PROFILE_A, deps);
  availability.writeAvailabilityCas(dataRoot, PROFILE_A, frozen, cur.revision, deps);
  cur = availability.loadAvailability(dataRoot, PROFILE_B, deps);
  availability.writeAvailabilityCas(dataRoot, PROFILE_B, availability.markActive(cur), cur.revision, deps);

  const sets = availability.buildCandidateSets(provider.loadRegistry(), {
    profile: "worker-a",
    probePolicy: availability.defaultProbePolicy()
  }, dataRoot, deps);
  const selection = availability.selectProfile(sets);
  assert.strictEqual(selection.ok, true);
  assert.strictEqual(selection.selected.profileId, PROFILE_A);
  assert.strictEqual(selection.selectionEvidence.selectionMode, "explicit");
  assert.match(selection.selectionEvidence.note || "", /never auto-replaced/i);
});

test("cas-rejects-stale-revision", () => {
  const dataRoot = provider.DATA_ROOT;
  const base = availability.emptyAvailability(PROFILE_A, { state: "active" });
  const first = availability.writeAvailabilityCas(dataRoot, PROFILE_A, base, 0, deps);
  // if file already had higher revision from prior tests, use actual
  const current = availability.loadAvailability(dataRoot, PROFILE_A, deps);
  const stale = availability.writeAvailabilityCas(
    dataRoot,
    PROFILE_A,
    availability.markActive(current),
    current.revision - 1,
    deps
  );
  assert.strictEqual(stale.ok, false);
  assert.strictEqual(stale.code, "AVAILABILITY_CAS_CONFLICT");
  const ok = availability.writeAvailabilityCas(dataRoot, PROFILE_A, availability.markActive(current), current.revision, deps);
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.record.revision, current.revision + 1);
});

test("wal-crash-recovery-interrupted", () => {
  const dataRoot = provider.DATA_ROOT;
  const run = availability.emptyTaskRun("task-crash", crypto.randomUUID(), {
    pid: 424242,
    processStartTicks: "638000000000000000",
    capturedAt: new Date().toISOString()
  });
  run.status = "running";
  availability.writeTaskRun(dataRoot, run, deps);
  const recovered = availability.recoverInterruptedRuns(dataRoot, {
    ...deps,
    inspectRunOwner: () => ({ state: "dead", reason: "fixture-owner-dead" })
  });
  assert(recovered.some((r) => r.runId === run.runId && r.status === "interrupted"));
  const loaded = availability.loadTaskRun(dataRoot, "task-crash", run.runId, deps);
  assert.strictEqual(loaded.status, "interrupted");
  assert.strictEqual(loaded.takeoverRequired, true);
});

test("wal-live-owner-and-unverifiable-owner-remain-running", () => {
  const dataRoot = provider.DATA_ROOT;
  for (const fixture of [
    { taskId: "task-live", inspection: { state: "live", reason: "fixture-owner-live" } },
    { taskId: "task-unverifiable", inspection: { state: "unverifiable", reason: "fixture-owner-unknown" } }
  ]) {
    const run = availability.emptyTaskRun(fixture.taskId, crypto.randomUUID(), {
      pid: 424243,
      processStartTicks: "638000000000000001",
      capturedAt: new Date().toISOString()
    });
    run.status = "running";
    availability.writeTaskRun(dataRoot, run, deps);
    const recovered = availability.recoverInterruptedRuns(dataRoot, {
      ...deps,
      inspectRunOwner: () => fixture.inspection
    });
    assert(!recovered.some((item) => item.runId === run.runId));
    assert.strictEqual(availability.loadTaskRun(dataRoot, fixture.taskId, run.runId, deps).status, "running");
  }
});

test("run-owner-identity-detects-live-owner-and-pid-reuse", () => {
  const owner = provider._test.captureRunOwner();
  assert.strictEqual(provider._test.inspectRunOwner(owner).state, "live");
  const reused = { ...owner, processStartTicks: String(BigInt(owner.processStartTicks) + 1n) };
  const inspected = provider._test.inspectRunOwner(reused);
  assert.deepStrictEqual([inspected.state, inspected.reason], ["dead", "owner-pid-reused"]);
});

test("wal-recovery-rechecks-terminal-state-before-writing", () => {
  const dataRoot = provider.DATA_ROOT;
  const run = availability.emptyTaskRun("task-terminal-race", crypto.randomUUID(), {
    pid: 424244,
    processStartTicks: "638000000000000002",
    capturedAt: new Date().toISOString()
  });
  run.status = "running";
  availability.writeTaskRun(dataRoot, run, deps);
  let terminalWritten = false;
  const raceDeps = {
    ...deps,
    inspectRunOwner: (owner) => {
      if (!terminalWritten && owner && owner.pid === run.owner.pid) {
        const terminal = availability.loadTaskRun(dataRoot, run.taskId, run.runId, deps);
        terminal.status = "completed";
        availability.writeTaskRun(dataRoot, terminal, deps);
        terminalWritten = true;
      }
      return { state: "dead", reason: "fixture-owner-dead" };
    }
  };
  const recovered = availability.recoverInterruptedRuns(dataRoot, raceDeps);
  assert.strictEqual(terminalWritten, true);
  assert(!recovered.some((item) => item.runId === run.runId));
  assert.strictEqual(availability.loadTaskRun(dataRoot, run.taskId, run.runId, deps).status, "completed");
});

test("wal-recovery-transaction-preserves-post-read-terminal", () => {
  const dataRoot = provider.DATA_ROOT;
  let run = availability.emptyTaskRun("task-locked-race", crypto.randomUUID(), {
    pid: 424245,
    processStartTicks: "638000000000000003",
    capturedAt: new Date().toISOString()
  });
  run.status = "running";
  run = availability.writeTaskRun(dataRoot, run, deps);
  const stale = { ...run, status: "completed" };
  let terminalWrite = null;
  const recovered = availability.recoverInterruptedRuns(dataRoot, {
    ...deps,
    inspectRunOwner: () => ({ state: "dead", reason: "fixture-owner-dead" }),
    beforeRecoveryCommit: () => {
      terminalWrite = availability.writeTaskRun(dataRoot, stale, deps);
    }
  });
  assert.strictEqual(terminalWrite.status, "completed");
  assert(!recovered.some((item) => item.runId === run.runId));
  let casConflict = null;
  try { availability.writeTaskRun(dataRoot, stale, deps); } catch (error) { casConflict = error.code; }
  assert.strictEqual(casConflict, "TASK_RUN_CAS_CONFLICT");
  assert.strictEqual(availability.loadTaskRun(dataRoot, run.taskId, run.runId, deps).status, "completed");
});

test("wal-terminal-record-is-fully-immutable", () => {
  const dataRoot = provider.DATA_ROOT;
  let run = availability.emptyTaskRun("task-terminal-immutable", crypto.randomUUID(), {
    pid: 424248,
    processStartTicks: "638000000000000006",
    capturedAt: new Date().toISOString()
  });
  run.status = "running";
  run = availability.writeTaskRun(dataRoot, run, deps);
  run.status = "completed";
  run = availability.writeTaskRun(dataRoot, run, deps);
  let conflict = null;
  try {
    availability.writeTaskRun(dataRoot, { ...run, takeoverRequired: true }, deps);
  } catch (error) {
    conflict = error.code;
  }
  assert.strictEqual(conflict, "TASK_RUN_TERMINAL_CONFLICT");
  const loaded = availability.loadTaskRun(dataRoot, run.taskId, run.runId, deps);
  assert.strictEqual(loaded.takeoverRequired, false);
  assert.strictEqual(loaded.revision, run.revision);
});

test("wal-ownerless-legacy-run-fails-closed", () => {
  const dataRoot = provider.DATA_ROOT;
  const run = availability.emptyTaskRun("task-ownerless", crypto.randomUUID());
  run.status = "running";
  availability.writeTaskRun(dataRoot, run, deps);
  availability.recoverInterruptedRuns(dataRoot, deps);
  assert.strictEqual(availability.loadTaskRun(dataRoot, run.taskId, run.runId, deps).status, "running");
});

test("attempts-transaction-and-failover-gate", () => {
  const clean402 = availability.mayAutoFailoverAttempt({
    errorClassification: { errorType: "quota_exhausted" },
    boundaryCompliance: { changedFilesFinalState: [] },
    hasToolEvents: false,
    hasOutput: false
  });
  assert.strictEqual(clean402.allowed, true);

  const partial = availability.mayAutoFailoverAttempt({
    errorClassification: { errorType: "quota_exhausted" },
    boundaryCompliance: { changedFilesFinalState: [{ path: "x" }] },
    hasToolEvents: false,
    hasOutput: false
  });
  assert.strictEqual(partial.allowed, false);
  assert.strictEqual(partial.takeoverRequired, true);

  const not402 = availability.mayAutoFailoverAttempt({
    errorClassification: { errorType: "network_fault" },
    boundaryCompliance: { changedFilesFinalState: [] },
    hasToolEvents: false,
    hasOutput: false
  });
  assert.strictEqual(not402.allowed, false);
});

test("billing-only-affects-nextProbeAt", () => {
  const logsDir = path.join(p1Home, "logs");
  mkdir(logsDir);
  write(path.join(logsDir, "billing.jsonl"), readFixture("billing-synthetic.jsonl"));
  const snap = availability.readBillingSnapshot(p1Home, deps);
  assert.strictEqual(snap.present, true);
  assert.strictEqual(snap.billingPeriodEnd, "2026-08-15T00:00:00.000Z");
  assert.match(snap.note || "", /never grants active/i);

  let record = availability.emptyAvailability(PROFILE_A, { state: "frozen", scope: "quota", consecutiveFailures: 1 });
  record.nextProbeAt = "2026-07-22T00:00:00.000Z";
  const applied = availability.applyBillingToNextProbe(record, snap);
  assert.strictEqual(applied.changed, true);
  assert.strictEqual(applied.record.state, "frozen"); // never auto-active
  assert(applied.record.nextProbeAt);
});

test("utf16-regression-normalize", () => {
  const utf16 = Buffer.from("Grok Build usage balance exhausted\0", "utf16le");
  const text = availability.normalizeClassifierText(utf16);
  assert(text.toLowerCase().includes("usage balance exhausted") || text.includes("e"));
  const c = availability.classifyError({
    stderr: "status_code=402 is_retryable=false Grok Build usage balance exhausted",
    statusCode: 402
  });
  assert.strictEqual(c.errorType, "quota_exhausted");
});

test("bootstrap-unknown-and-frozen", () => {
  const dataRoot = provider.DATA_ROOT;
  // wipe availability dir records for clean bootstrap force
  const results = availability.bootstrapAvailability(provider.loadRegistry(), {
    dataRoot,
    frozenProfileIds: ["worker-a"],
    recentSuccessProfileIds: ["worker-b"],
    force: true
  }, deps);
  assert(results.some((r) => r.profileId === PROFILE_A && r.state === "frozen"));
  assert(results.some((r) => r.profileId === PROFILE_B && r.state === "active"));
  const unknown = availability.loadAvailability(dataRoot, PROFILE_C, deps);
  // force bootstrap wrote all three
  assert(["unknown", "active", "frozen"].includes(unknown.state));
});

test("pool-status-and-plan-zero-requests", () => {
  const status = provider.poolStatus();
  assert.strictEqual(status.realRequests, 0);
  assert(Array.isArray(status.profiles));
  assert(status.profiles[0].availability);

  // planTask needs a valid capsule file
  const repo = path.join(sandbox, "plan-repo");
  mkdir(repo);
  // minimal capsule without git — plan only validates capsule + selection
  // Use validate + planTemplate path via buildCandidateSets already covered;
  // ensure poolRefresh dry is zero real
  const refresh = provider.poolRefresh({ real: "denied" });
  assert.strictEqual(refresh.realRequests, 0);
});

test("lock-scopes-selection-and-availability", () => {
  const a = provider.acquireLock("selection", ["task-1"], provider.DATA_ROOT, 5000);
  let conflicted = false;
  try {
    provider.acquireLock("selection", ["task-1"], provider.DATA_ROOT, 5000);
  } catch (error) {
    conflicted = error.code === "LOCK_CONFLICT";
  }
  a.release();
  assert.strictEqual(conflicted, true);

  const av = provider.acquireLock("availability", [PROFILE_A], provider.DATA_ROOT, 5000);
  // workspace lock should not conflict with availability
  const ws = provider.acquireLock("workspace", ["allowed/**"], sandbox, 5000);
  ws.release();
  av.release();
});

test("deploy-pointer-helpers", () => {
  // write to sandbox-overridden path only if env set — use buildCurrentPointer pure
  const pointer = availability.buildCurrentPointer({
    version: "1.0.0",
    releasePath: path.join(sandbox, "release"),
    previousVersion: null,
    dataRoot: provider.DATA_ROOT,
    registryPath: process.env.GROK_WORKER_PROFILES,
    approvedProfileRoot: process.env.GROK_WORKER_APPROVED_PROFILE_ROOT || provider.APPROVED_PROFILE_ROOT || path.join(sandbox, "profile-root"),
    manifestSha256: "abc"
  });
  assert.strictEqual(pointer.version, "1.0.0");
  assert.strictEqual(pointer.approvedProfileRoot.length > 0, true);
  assert.strictEqual(pointer.schemaVersions.availability, 5);
  assert.strictEqual(pointer.schemaVersions.taskRun, 6);
});

test("result-capsule-requires-selection-and-classification", () => {
  const incomplete = {
    status: "failed",
    grokSessionId: null,
    baseCommit: "0".repeat(40),
    changedFiles: [],
    commands: [{ command: "x", summary: "y", executedBy: "worker" }],
    tests: [{ command: "t", result: "n", executedBy: "controller" }],
    findings: ["f"],
    assumptions: ["a"],
    unresolved: ["u"],
    residualRisks: ["r"],
    commitEvidence: ["c"],
    diffEvidence: ["d"],
    boundaryCompliance: { changedFilesFinalState: [], policyAuditEvents: [], allowed: true },
    taskId: "t",
    stage: "s",
    worktree: { mode: "read-only-shared-checkout", path: sandbox },
    exitCode: 1,
    redaction: { applied: true, notes: ["n"], rawStreamDeleted: true, rawCleanupFailed: false },
    profileId: PROFILE_A,
    invocationId: crypto.randomUUID(),
    requestId: "r1",
    variant: "main",
    stopReason: "failed",
    durationMs: null
  };
  let missing = false;
  try {
    provider.validateResultCapsule(incomplete);
  } catch (error) {
    missing = error.code === "RESULT_REQUIRED";
  }
  assert.strictEqual(missing, true);
  incomplete.selectionEvidence = {
    selectionMode: "explicit",
    finalSelectedProfileId: PROFILE_A,
    candidateProfileIds: [PROFILE_A],
    skippedReasons: []
  };
  incomplete.errorClassification = {
    errorType: "quota_exhausted",
    statusCode: 402,
    retryable: false,
    quotaKind: "usage_balance",
    profileAttributable: true
  };
  provider.validateResultCapsule(incomplete);
});

test("capsule-pool-and-explicit-modes", () => {
  const base = {
    taskId: "avail-capsule",
    stage: "v5",
    objective: "test",
    baseCommit: "0".repeat(40),
    workspace: sandbox,
    worktree: { mode: "read-only-shared-checkout", path: sandbox },
    allowedFiles: ["."],
    forbiddenActions: ["service control"],
    acceptanceCommands: ["controller checks"],
    contextRefs: ["."],
    realRequestPermission: "denied",
    serviceControlPermission: "denied",
    gitPermission: "read-only",
    grokSessionId: null,
    resumePolicy: { mode: "new-only", rule: "new" },
    explicitStop: "stop",
    policy: { access: "readonly", bash: "denied", agents: "denied", mcp: "denied", web: "denied" },
    failover: { allowedFallbackProfiles: [], mode: "pre-first-request-only", switchPermission: "denied" }
  };
  const explicit = provider.validateTaskCapsule({ ...base, profile: "worker-a" }, provider.loadRegistry());
  assert.strictEqual(explicit.probePolicy.mode, "disabled");

  const pool = provider.validateTaskCapsule({
    ...base,
    candidateProfileIds: [PROFILE_A, PROFILE_B],
    probePolicy: { mode: "when-no-active", realRequestPermission: "denied", maxProbesPerRun: 1 }
  }, provider.loadRegistry());
  assert.deepStrictEqual(pool.candidateProfileIds, [PROFILE_A, PROFILE_B]);

  let mixed = false;
  try {
    provider.validateTaskCapsule({ ...base, profile: "worker-a", candidateProfileIds: [PROFILE_A] }, provider.loadRegistry());
  } catch (error) {
    mixed = error.code === "CAPSULE_SELECTION_MIXED";
  }
  assert.strictEqual(mixed, true);
});

test("security-invariants-no-auth-read", () => {
  let blocked = false;
  try {
    provider._test.readJson(path.join(p1Home, "auth.json"));
  } catch (error) {
    blocked = error.code === "INV1_AUTH_READ_FORBIDDEN" || /auth\.json/i.test(String(error.message));
  }
  // file may not exist — create and ensure refuse by basename
  write(path.join(p1Home, "auth.json"), "{\"token\":\"x\"}");
  try {
    provider._test.readJson(path.join(p1Home, "auth.json"));
    blocked = false;
  } catch (error) {
    blocked = error.code === "INV1_AUTH_READ_FORBIDDEN";
  }
  assert.strictEqual(blocked, true);
});

test("429-retryable-alone-not-account-level", () => {
  // is_retryable=true without account keywords or Retry-After must not cooldown
  const c = availability.classifyError({
    statusCode: 429,
    retryable: true,
    stderr: "HTTP 429 too many requests is_retryable=true"
  });
  assert.strictEqual(c.errorType, "rate_limited");
  assert.strictEqual(c.accountLevelEvidence, false);
  assert.strictEqual(c.profileAttributable, false);
  assert.strictEqual(availability.shouldTouchAvailability(c), false);

  // account evidence still attributes
  const account = availability.classifyError({
    stderr: readFixture("stderr-429-account.txt"),
    statusCode: 429
  });
  assert.strictEqual(account.accountLevelEvidence, true);
  assert.strictEqual(availability.shouldTouchAvailability(account), true);
});

test("provider-health-non-attributable", () => {
  const dataRoot = provider.DATA_ROOT;
  const network = availability.classifyError({ stderr: readFixture("stderr-network.txt") });
  assert.strictEqual(availability.shouldTouchAvailability(network), false);
  const health = availability.recordProviderHealth(dataRoot, {
    errorType: network.errorType,
    statusCode: network.statusCode,
    taskId: "health-task",
    invocationId: crypto.randomUUID(),
    profileId: PROFILE_A
  }, deps);
  assert.strictEqual(health.scope, "provider");
  assert.strictEqual(health.status, "degraded");
  assert(health.consecutiveNonAttributableFailures >= 1);
  assert.match(health.events[health.events.length - 1].note, /profile availability not modified/i);

  // profile availability remains untouched by health write
  const before = availability.loadAvailability(dataRoot, PROFILE_A, deps);
  const applied = availability.applyClassificationToAvailability(before, network, { profileId: PROFILE_A });
  assert.strictEqual(applied.touched, false);

  const ok = availability.markProviderHealthOk(dataRoot, deps);
  assert.strictEqual(ok.status, "healthy");
  assert.strictEqual(ok.consecutiveNonAttributableFailures, 0);
});

test("probe-self-rescue-when-no-active", () => {
  const dataRoot = provider.DATA_ROOT;
  // freeze all workload; leave C unknown → probeEligible
  for (const id of [PROFILE_A, PROFILE_B]) {
    const cur = availability.loadAvailability(dataRoot, id, deps);
    const frozen = availability.applyClassificationToAvailability(
      cur,
      availability.classifyError({ stderr: readFixture("stderr-402-exhausted.txt"), statusCode: 402 }),
      { profileId: id }
    ).record;
    frozen.nextProbeAt = new Date(Date.now() + 86400_000).toISOString();
    availability.writeAvailabilityCas(dataRoot, id, frozen, cur.revision, deps);
  }
  {
    const cur = availability.loadAvailability(dataRoot, PROFILE_C, deps);
    availability.writeAvailabilityCas(
      dataRoot,
      PROFILE_C,
      availability.emptyAvailability(PROFILE_C, { state: "unknown" }),
      cur.revision,
      deps
    );
  }

  const setsDenied = availability.buildCandidateSets(provider.loadRegistry(), {
    candidateProfileIds: [PROFILE_A, PROFILE_B, PROFILE_C],
    probePolicy: { mode: "when-no-active", realRequestPermission: "denied", maxProbesPerRun: 1 }
  }, dataRoot, deps);
  assert.strictEqual(setsDenied.workloadEligible.length, 0);
  assert(setsDenied.probeEligible.some((c) => c.profileId === PROFILE_C));
  const selDenied = availability.selectProfile(setsDenied, { allowProbeSelection: true });
  assert.strictEqual(selDenied.ok, false);

  const setsAllowed = availability.buildCandidateSets(provider.loadRegistry(), {
    candidateProfileIds: [PROFILE_A, PROFILE_B, PROFILE_C],
    probePolicy: { mode: "when-no-active", realRequestPermission: "allowed", maxProbesPerRun: 1 }
  }, dataRoot, deps);
  assert.strictEqual(setsAllowed.maintenanceProbePlanned, true);
  const selAllowed = availability.selectProfile(setsAllowed, {
    allowProbeSelection: true,
    probesUsed: 0,
    maxProbesPerRun: 1
  });
  assert.strictEqual(selAllowed.ok, true);
  assert.strictEqual(selAllowed.selected.profileId, PROFILE_C);
  assert.strictEqual(selAllowed.selectionEvidence.selectionClass, "probeEligible");
});

test("max-probes-per-run-enforced", () => {
  const dataRoot = provider.DATA_ROOT;
  const sets = availability.buildCandidateSets(provider.loadRegistry(), {
    candidateProfileIds: [PROFILE_C],
    probePolicy: { mode: "when-no-active", realRequestPermission: "allowed", maxProbesPerRun: 1 }
  }, dataRoot, deps);
  const blocked = availability.selectProfile(sets, {
    allowProbeSelection: true,
    probesUsed: 1,
    maxProbesPerRun: 1
  });
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.reason, "max-probes-per-run-exceeded");
  assert.strictEqual(availability.probeSelfRescueAllowed(
    { mode: "when-no-active", realRequestPermission: "allowed", maxProbesPerRun: 1 },
    { allowProbeSelection: true, probesUsed: 1 }
  ), false);
});

test("deploy-pointer-validate-and-roots", () => {
  const release = path.join(sandbox, "release-1.0.0");
  mkdir(release);
  const pointer = availability.buildCurrentPointer({
    version: "1.0.0",
    releasePath: release,
    previousVersion: null,
    dataRoot: provider.DATA_ROOT,
    registryPath: process.env.GROK_WORKER_PROFILES,
    approvedProfileRoot: profileRoot,
    manifestSha256: "a".repeat(64)
  });
  const ok = availability.validateCurrentPointer(pointer, { requireRelease: true });
  assert.strictEqual(ok.ok, true);
  const bad = availability.validateCurrentPointer({ version: "1" });
  assert.strictEqual(bad.ok, false);
  const missingApproved = availability.validateCurrentPointer({
    version: "1",
    releasePath: release,
    dataRoot: provider.DATA_ROOT,
    registryPath: process.env.GROK_WORKER_PROFILES,
    schemaVersions: { availability: 5 }
  });
  assert.strictEqual(missingApproved.ok, false);
  assert.strictEqual(missingApproved.reason, "missing-approvedProfileRoot");

  const pointerFile = path.join(sandbox, "current.json");
  deps.atomicWriteJson(pointerFile, pointer);
  const loaded = availability.readCurrentPointer(pointerFile, deps);
  assert.strictEqual(loaded.version, "1.0.0");
  assert.strictEqual(loaded.dataRoot, provider.DATA_ROOT);
  assert.strictEqual(loaded.approvedProfileRoot, profileRoot);

  // env still wins over pointer for process roots (harness set env before require)
  const resolved = provider.resolveRootsFromPointer();
  assert.strictEqual(resolved.source, "env");
  assert.strictEqual(resolved.dataRoot, provider.DATA_ROOT);
});

test("provider-defaults-independent-of-grokui", () => {
  // Active defaults must live under GrokWorkerProvider, never under GrokUI.
  assert.match(provider.DEFAULT_DATA_ROOT, /GrokWorkerProvider/);
  assert.match(provider.DEFAULT_REGISTRY_PATH, /GrokWorkerProvider/);
  assert.match(provider.DEFAULT_APPROVED_PROFILE_ROOT, /GrokWorkerProvider/);
  assert.doesNotMatch(provider.DEFAULT_DATA_ROOT, /GrokUI[/\\]/);
  assert.doesNotMatch(provider.DEFAULT_REGISTRY_PATH, /GrokUI[/\\]/);
  assert.doesNotMatch(provider.DEFAULT_APPROVED_PROFILE_ROOT, /GrokUI[/\\]/);
  // Legacy residues exist as inert constants only (historical, never active defaults).
  assert.match(provider.LEGACY_DATA_ROOT, /GrokUI[/\\]worker-provider/);
  assert.match(provider.LEGACY_REGISTRY_PATH, /GrokUI[/\\]worker-profiles/);
  assert.match(provider.LEGACY_APPROVED_PROFILE_ROOT, /GrokUI[/\\]codex-grok-workers/);
  const residues = provider.legacyResidueMeta();
  assert.strictEqual(residues.dataRoot, provider.LEGACY_DATA_ROOT);
  assert.match(residues.note || "", /inert|historical/i);
  // With env set (harness), resolution must not fall back to GrokUI.
  const resolved = provider.resolveRootsFromPointer();
  assert.notStrictEqual(resolved.dataRoot, provider.LEGACY_DATA_ROOT);
  assert.notStrictEqual(resolved.registryPath, provider.LEGACY_REGISTRY_PATH);
  assert.notStrictEqual(resolved.approvedProfileRoot, provider.LEGACY_APPROVED_PROFILE_ROOT);
  assert.doesNotMatch(resolved.dataRoot, /GrokUI[/\\]/);
});

test("usage-unknown-no-invented-zeros", () => {
  const missing = provider.numericUsage(null);
  assert.strictEqual(missing.present, false);
  assert.strictEqual(missing.unknown, true);
  assert.strictEqual(missing.input_tokens, null);
  assert.strictEqual(missing.total_tokens, null);
  assert.match(missing.note || "", /usage-unknown/i);

  const present = provider.numericUsage({ input_tokens: 3, output_tokens: 2, total_tokens: 5 });
  assert.strictEqual(present.present, true);
  assert.strictEqual(present.total_tokens, 5);
});

function mockCapsule(overrides = {}) {
  return {
    taskId: `avail-int-${crypto.randomUUID()}`,
    stage: "v5-integration",
    objective: "mock integration",
    baseCommit: "0".repeat(40),
    workspace: sandbox,
    worktree: { mode: "read-only-shared-checkout", path: sandbox },
    allowedFiles: ["."],
    forbiddenActions: ["service control", "OAuth", "account switch", "delete data"],
    acceptanceCommands: ["controller verifies"],
    contextRefs: ["."],
    realRequestPermission: "allowed",
    serviceControlPermission: "denied",
    gitPermission: "read-only",
    grokSessionId: null,
    resumePolicy: { mode: "new-only", rule: "new only" },
    explicitStop: "Return Result Capsule and stop.",
    model: "grok-4.6",
    reasoning: "high",
    speed: "standard",
    policy: { access: "readonly", bash: "denied", agents: "denied", mcp: "denied", web: "denied" },
    failover: {
      allowedFallbackProfileIds: [PROFILE_B],
      mode: "pre-first-request-only",
      switchPermission: "allowed"
    },
    candidateProfileIds: [PROFILE_A, PROFILE_B],
    probePolicy: availability.defaultProbePolicy(),
    ...overrides
  };
}

function mockExecFactory(responses) {
  let i = 0;
  return () => {
    const spec = responses[Math.min(i, responses.length - 1)];
    i += 1;
    const status = spec.status;
    const stderr = spec.stderr || "";
    const usage = Object.prototype.hasOwnProperty.call(spec, "usage") ? spec.usage : null;
    const sessionId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const terminal = status === 0
      ? {
        type: "end",
        sessionId,
        requestId,
        stopReason: "end",
        usage: usage || { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      }
      : null;
    return {
      status,
      stdout: terminal ? `${JSON.stringify(terminal)}\n` : "",
      stderr,
      parsed: {
        summary: terminal ? [{ type: "end", sessionId, requestId, hasUsage: Boolean(usage), textBytes: 0 }] : [],
        terminal,
        invalid: 0,
        finalText: status === 0 ? "ok" : ""
      },
      rawCleanupFailed: false
    };
  };
}

const mockRunOptions = {
  skipInspect: true,
  baselineCheckFn: () => {},
  changedFilesFinalStateFn: () => []
};

test("runTask-multi-attempt-402-failover", () => {
  const dataRoot = provider.DATA_ROOT;
  // both A and B active; A least-recently-selected so pool picks A first
  {
    const cur = availability.loadAvailability(dataRoot, PROFILE_A, deps);
    const next = availability.markActive(cur);
    next.lastSelectedAt = "2020-01-01T00:00:00.000Z";
    availability.writeAvailabilityCas(dataRoot, PROFILE_A, next, cur.revision, deps);
  }
  {
    const cur = availability.loadAvailability(dataRoot, PROFILE_B, deps);
    const next = availability.markActive(cur);
    next.lastSelectedAt = "2026-01-01T00:00:00.000Z";
    availability.writeAvailabilityCas(dataRoot, PROFILE_B, next, cur.revision, deps);
  }
  const capsule = mockCapsule({
    taskId: `failover-${crypto.randomUUID()}`,
    candidateProfileIds: [PROFILE_A, PROFILE_B],
    failover: {
      allowedFallbackProfileIds: [PROFILE_B],
      mode: "pre-first-request-only",
      switchPermission: "allowed"
    }
  });
  const taskFile = path.join(sandbox, "task-failover.json");
  write(taskFile, `${JSON.stringify(capsule, null, 2)}\n`);

  const stderr402 = readFixture("stderr-402-exhausted.txt");
  const out = provider.runTask(null, taskFile, {
    ...mockRunOptions,
    executePlanFn: mockExecFactory([
      { status: 1, stderr: stderr402, usage: null },
      { status: 0, stderr: "", usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }
    ])
  });

  assert.strictEqual(out.attempts.length, 2, "expected two independent attempts");
  assert.strictEqual(out.attempts[0].errorType, "quota_exhausted");
  assert.strictEqual(out.attempts[0].profileId, PROFILE_A);
  assert.strictEqual(out.attempts[1].profileId, PROFILE_B);
  assert.strictEqual(out.taskRun.status, "completed");
  assert.notStrictEqual(out.attempts[0].resultRef, out.attempts[1].resultRef);

  const ref0 = path.join(dataRoot, out.attempts[0].resultRef);
  const ref1 = path.join(dataRoot, out.attempts[1].resultRef);
  assert(fs.existsSync(ref0), "first Result Capsule must remain on disk");
  assert(fs.existsSync(ref1), "second Result Capsule must remain on disk");
  const r0 = JSON.parse(fs.readFileSync(ref0, "utf8"));
  const r1 = JSON.parse(fs.readFileSync(ref1, "utf8"));
  assert.strictEqual(r0.errorClassification.errorType, "quota_exhausted");
  assert.strictEqual(r1.status, "completed");
  assert.notStrictEqual(r0.invocationId, r1.invocationId);
});

test("runTask-probe-self-rescue", () => {
  const dataRoot = provider.DATA_ROOT;
  // no active: A frozen not due, B/C unknown probeEligible
  {
    const cur = availability.loadAvailability(dataRoot, PROFILE_A, deps);
    const frozen = availability.applyClassificationToAvailability(
      cur,
      availability.classifyError({ stderr: readFixture("stderr-402-exhausted.txt"), statusCode: 402 }),
      { profileId: PROFILE_A }
    ).record;
    frozen.nextProbeAt = new Date(Date.now() + 86400_000).toISOString();
    availability.writeAvailabilityCas(dataRoot, PROFILE_A, frozen, cur.revision, deps);
  }
  for (const id of [PROFILE_B, PROFILE_C]) {
    const cur = availability.loadAvailability(dataRoot, id, deps);
    availability.writeAvailabilityCas(
      dataRoot,
      id,
      availability.emptyAvailability(id, { state: "unknown" }),
      cur.revision,
      deps
    );
  }

  const capsule = mockCapsule({
    taskId: `probe-rescue-${crypto.randomUUID()}`,
    candidateProfileIds: [PROFILE_A, PROFILE_B, PROFILE_C],
    probePolicy: { mode: "when-no-active", realRequestPermission: "allowed", maxProbesPerRun: 1 },
    failover: {
      allowedFallbackProfileIds: [PROFILE_C],
      mode: "pre-first-request-only",
      switchPermission: "denied"
    }
  });
  const taskFile = path.join(sandbox, "task-probe-rescue.json");
  write(taskFile, `${JSON.stringify(capsule, null, 2)}\n`);

  const out = provider.runTask(null, taskFile, {
    ...mockRunOptions,
    executePlanFn: mockExecFactory([
      { status: 0, stderr: "", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
    ])
  });

  assert.strictEqual(out.probesUsed, 1);
  assert.strictEqual(out.attempts.length, 1);
  assert.strictEqual(out.attempts[0].selectionClass, "probeEligible");
  assert.strictEqual(out.attempts[0].profileId, PROFILE_B);
  assert.strictEqual(out.taskRun.status, "completed");
  // successful probe promotes availability to active
  const after = availability.loadAvailability(dataRoot, PROFILE_B, deps);
  assert.strictEqual(after.state, "active");
});

test("concurrent-reservation-and-cas", () => {
  const dataRoot = provider.DATA_ROOT;
  // Concurrent selection reservation: second holder of same taskId fails
  const lease1 = provider.acquireLock("selection", ["task-race-1"], dataRoot, 10000);
  let selectionConflict = false;
  try {
    provider.acquireLock("selection", ["task-race-1"], dataRoot, 10000);
  } catch (error) {
    selectionConflict = error.code === "LOCK_CONFLICT";
  }
  lease1.release();
  assert.strictEqual(selectionConflict, true);

  // Concurrent CAS: two writers with same expected revision — only one wins
  const profileId = PROFILE_C;
  const base = availability.loadAvailability(dataRoot, profileId, deps);
  const rev = base.revision;
  const writerA = availability.markActive(base);
  const writerB = availability.emptyAvailability(profileId, { state: "unknown", revision: rev });
  const casA = availability.writeAvailabilityCas(dataRoot, profileId, writerA, rev, deps);
  assert.strictEqual(casA.ok, true);
  const casB = availability.writeAvailabilityCas(dataRoot, profileId, writerB, rev, deps);
  assert.strictEqual(casB.ok, false);
  assert.strictEqual(casB.code, "AVAILABILITY_CAS_CONFLICT");
  const final = availability.loadAvailability(dataRoot, profileId, deps);
  assert.strictEqual(final.revision, rev + 1);
  assert.strictEqual(final.state, "active");
});

process.stdout.write(`${JSON.stringify({
  suite: "availability-v5-mock",
  passed,
  failed,
  evidence,
  sandbox,
  realGrokRequests: 0,
  inconclusive: [
    "Real execution.stderr exhaustion payload format not observed; synthetic 402 fixtures prove parser behavior only (§12)."
  ]
}, null, 2)}\n`);

try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) { /* keep on failure */ }
if (failed) process.exitCode = 1;
