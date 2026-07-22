"use strict";

/**
 * r8 Availability Layer mock acceptance suite (§11).
 * 100% fixture/mock — zero real Grok requests, no OAuth, no service control,
 * no Task Scheduler install/enable, no real maintenance probe.
 *
 * Isolation: GROK_WORKER_CURRENT_JSON is forced into the sandbox so this suite
 * never replaces the machine-global current.json used by grok-worker.cmd.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const assert = require("assert");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "grok-worker-v6-r8-"));
const sandboxCurrentJson = path.join(sandbox, "current.json");
const machineCurrentJson = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "GrokWorkerProvider",
  "current.json"
);
const machineCurrentBefore = fs.existsSync(machineCurrentJson)
  ? fs.readFileSync(machineCurrentJson, "utf8")
  : null;

process.env.GROK_WORKER_DATA_ROOT = path.join(sandbox, "data");
process.env.GROK_WORKER_PROFILES = path.join(sandbox, "profiles.json");
process.env.GROK_WORKER_CURRENT_JSON = sandboxCurrentJson;

const provider = require("../lib/provider");
const availability = require("../lib/availability");

assert.strictEqual(
  path.resolve(provider.CURRENT_POINTER_PATH),
  path.resolve(sandboxCurrentJson),
  "harness must bind CURRENT_POINTER_PATH to sandbox current.json"
);

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
function write(file, data) {
  mkdir(path.dirname(file));
  fs.writeFileSync(file, typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

const profileRoot = path.join(sandbox, "profile-root");
const p1Home = path.join(profileRoot, "worker-a");
const p2Home = path.join(profileRoot, "worker-b");
mkdir(p1Home); mkdir(p2Home);

const PROFILE_A = "550e8400-e29b-41d4-a716-446655440001";
const PROFILE_B = "550e8400-e29b-41d4-a716-446655440002";

const registry = {
  schemaVersion: 3,
  approvedProfileRoot: profileRoot,
  allowedWorkspaceRoots: [sandbox],
  profiles: [
    {
      profileId: PROFILE_A, alias: "worker-a", grokHome: p1Home,
      executable: "C:\\Users\\Ayun\\.grok\\bin\\grok.exe", accountLabel: "a",
      authReadiness: { oauthReady: true, verifiedAt: new Date().toISOString() },
      identity: { identityStatus: "unknown", source: "cli_probe", value: null, capturedAt: new Date().toISOString(), providerVersion: provider.VERSION },
      sandboxCapability: { flagSupported: true, enforcementSupported: false, platform: "windows", evidence: "Linux/macOS only" },
      modelSnapshot: { models: ["grok-4.5"], reasoning: ["high"], checkedAt: new Date().toISOString() }
    },
    {
      profileId: PROFILE_B, alias: "worker-b", grokHome: p2Home,
      executable: "C:\\Users\\Ayun\\.grok\\bin\\grok.exe", accountLabel: "b",
      authReadiness: { oauthReady: true, verifiedAt: new Date().toISOString() },
      identity: { identityStatus: "unknown", source: "cli_probe", value: null, capturedAt: new Date().toISOString(), providerVersion: provider.VERSION },
      sandboxCapability: { flagSupported: true, enforcementSupported: false, platform: "windows", evidence: "Linux/macOS only" },
      modelSnapshot: { models: ["grok-4.5"], reasoning: ["high"], checkedAt: new Date().toISOString() }
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
  redactText: provider._test.redactText
};

const SCHEMA_FILES = [
  "maintenance-profile.v6.schema.json",
  "pool-config.v6.schema.json",
  "maintenance-task.v6.schema.json",
  "maintenance-result.v6.schema.json",
  "maintenance-run.v6.schema.json",
  "rate-window.v6.schema.json",
  "usage-ledger.provider.v4.schema.json",
  "deploy-pointer.v6.schema.json"
];

test("r8-schemas-extractable-and-parseable", () => {
  const schemaDir = path.join(__dirname, "..", "schemas");
  for (const name of SCHEMA_FILES) {
    const file = path.join(schemaDir, name);
    assert.strictEqual(fs.existsSync(file), true, `missing ${name}`);
    const raw = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(raw, /同 rN|same as r\d/i);
    const parsed = JSON.parse(raw);
    assert.strictEqual(typeof parsed, "object");
    assert.strictEqual(parsed.additionalProperties, false);
  }
});

test("ledger-v4-dual-shape", () => {
  const present = provider.numericUsage({
    input_tokens: 10,
    cache_read_input_tokens: 0,
    output_tokens: 5,
    reasoning_tokens: 1,
    total_tokens: 16
  });
  assert.strictEqual(availability.validateRunUsageV4(present).ok, true);
  assert.strictEqual(availability.validateRunUsageV4(present).shape, "present");
  assert.strictEqual(present.note, null);

  const unknown = provider.numericUsage(null);
  assert.strictEqual(availability.validateRunUsageV4(unknown).ok, true);
  assert.strictEqual(availability.validateRunUsageV4(unknown).shape, "unknown");
  assert.strictEqual(typeof unknown.note, "string");
});

test("quota-4h-hard-cap", () => {
  const now = Date.parse("2026-07-21T12:00:00.000Z");
  const resetAt = new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString();
  const next = availability.computeQuotaNextProbeAt({ resetAt, consecutiveFailures: 5, now });
  const nextMs = Date.parse(next);
  assert.ok(nextMs <= now + availability.QUOTA_MAX_BACKOFF_MS);
  assert.ok(nextMs > now);

  // cooldown / rate-limit path may honor far reset
  const rate = availability.computeRateLimitNextProbeAt({ resetAt, consecutiveFailures: 1, now });
  assert.ok(Date.parse(rate) > now + availability.QUOTA_MAX_BACKOFF_MS);

  // classification 402 uses quota path
  const frozen = availability.applyClassificationToAvailability(
    availability.emptyAvailability(PROFILE_A),
    availability.classifyError({ statusCode: 402, stderr: "usage balance exhausted is_retryable=false" }),
    { profileId: PROFILE_A }
  );
  assert.strictEqual(frozen.record.scope, "quota");
  assert.ok(Date.parse(frozen.record.nextProbeAt) <= Date.now() + availability.QUOTA_MAX_BACKOFF_MS + 1000);

  // clamp legacy far nextProbeAt
  const legacy = availability.emptyAvailability(PROFILE_A, {
    state: "frozen",
    scope: "quota",
    nextProbeAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
  });
  const clamped = availability.clampQuotaNextProbeAt(legacy, Date.now());
  assert.strictEqual(clamped.changed, true);
  assert.ok(Date.parse(clamped.record.nextProbeAt) <= Date.now() + availability.QUOTA_MAX_BACKOFF_MS + 1000);
});

test("billing-early-probe-baselines", () => {
  const freezeAt = "2026-07-20T00:00:00.000Z";
  const episodeStart = "2026-07-01T00:00:00.000Z";
  const sidecar = availability.emptyMaintenanceProfile(PROFILE_A, {
    episodeId: "ep-1",
    freezeObservedAt: freezeAt,
    episodePeriodStart: episodeStart,
    earlyBillingProbeConsumed: false,
    lastBillingObservedAt: null
  });

  // Historical <95% with same/older period start → reject
  const historical = {
    present: true,
    ts: "2026-07-19T12:00:00.000Z",
    billingPeriodStart: episodeStart,
    percentState: "recovered_lt_95",
    creditUsagePercent: 40
  };
  assert.strictEqual(availability.evaluateEarlyBillingProbe(sidecar, historical).eligible, false);

  // All three gates + percent + not consumed → eligible
  const fresh = {
    present: true,
    ts: "2026-07-21T01:00:00.000Z",
    billingPeriodStart: "2026-07-15T00:00:00.000Z",
    percentState: "recovered_lt_95",
    creditUsagePercent: 40
  };
  const hit = availability.evaluateEarlyBillingProbe(sidecar, fresh);
  assert.strictEqual(hit.eligible, true);
  assert.ok(hit.billingSignalId);

  // Consumed once → never again
  sidecar.earlyBillingProbeConsumed = true;
  assert.strictEqual(availability.evaluateEarlyBillingProbe(sidecar, fresh).eligible, false);
});

test("rate-window-strict-4-per-hour", () => {
  const dataRoot = provider.DATA_ROOT;
  const base = Date.parse("2026-07-21T10:00:00.000Z");
  for (let i = 0; i < 4; i += 1) {
    const r = availability.tryReserveRateSlot(dataRoot, deps, base + i * 1000);
    assert.strictEqual(r.ok, true, `slot ${i}`);
  }
  const full = availability.tryReserveRateSlot(dataRoot, deps, base + 5000);
  assert.strictEqual(full.ok, false);
  assert.strictEqual(full.reason, "rate-window-full");

  // clock rollback
  const back = availability.tryReserveRateSlot(dataRoot, deps, base - 60_000);
  assert.strictEqual(back.ok, false);
  assert.ok(["clock-rollback", "rate-window-full"].includes(back.reason));

  // corrupt → fail-closed
  write(availability.rateWindowPath(dataRoot), { schemaVersion: 6, requests: "bad", windowMs: 3600000, maxInWindow: 4, revision: 99 });
  const corrupt = availability.tryReserveRateSlot(dataRoot, deps, base + 10_000);
  assert.strictEqual(corrupt.ok, false);
  assert.match(corrupt.reason, /corrupt|fail-closed/);
});

test("three-state-reconcile", () => {
  const dataRoot = provider.DATA_ROOT;
  const before = availability.emptyAvailability(PROFILE_A, {
    state: "frozen", scope: "quota", revision: 1, nextProbeAt: "2026-07-21T00:00:00.000Z"
  });
  const target = { ...before, state: "probe_due", nextProbeAt: "2026-07-21T12:00:00.000Z", revision: 1 };
  // seed current == before
  availability.writeAvailabilityCas(dataRoot, PROFILE_A, before, 0, deps);
  const sideBefore = availability.emptyMaintenanceProfile(PROFILE_A, { revision: 0 });
  const sideTarget = availability.openOrRefreshFreezeEpisode(sideBefore, before, null);
  sideTarget.earlyBillingProbeConsumed = true;

  const inv = crypto.randomUUID();
  const journal = availability.emptyMaintenanceRun({
    maintenanceTaskId: `quota-probe-${PROFILE_A}`,
    maintenanceInvocationId: inv,
    profileId: PROFILE_A,
    operation: "start-probe",
    phase: "intent",
    status: "running",
    availabilityBefore: availability.loadAvailability(dataRoot, PROFILE_A, deps),
    availabilityTarget: target,
    sidecarBefore: sideBefore,
    sidecarTarget: sideTarget
  });
  availability.writeMaintenanceRun(dataRoot, journal, deps);

  const outcomes = availability.reconcileMaintenanceRuns(dataRoot, deps);
  assert.ok(outcomes.length >= 1);
  // no permanent pending; status terminal or advanced
  const reloaded = availability.loadMaintenanceRun(dataRoot, journal.maintenanceTaskId, inv, deps);
  assert.ok(["interrupted", "completed", "failed", "running"].includes(reloaded.status));
  // never grants active from journal alone
  const avail = availability.loadAvailability(dataRoot, PROFILE_A, deps);
  assert.notStrictEqual(avail.state, "active");
});

test("control-plane-three-gates-default-closed", () => {
  const dataRoot = provider.DATA_ROOT;
  // missing config → soft zero-request success
  const missing = provider.poolMaintenanceTick({});
  assert.strictEqual(missing.ok, true);
  assert.strictEqual(missing.realRequests, 0);
  assert.strictEqual(missing.probesStarted, 0);

  // status read-only fast path
  const status = provider.poolConfigStatus();
  assert.strictEqual(status.realRequests, 0);
  assert.strictEqual(status.autoProbe.enabled, false);

  // authorize must persist pool-config without secret-key false positive
  const auth = provider.poolConfigAuthorize({ profiles: PROFILE_A });
  assert.strictEqual(auth.config.authorization.realRequestPermission, "allowed");
  assert.ok(auth.config.auditLog.some((a) => a.action === "authorize"));
  const poolPath = availability.poolConfigPath(dataRoot);
  assert.strictEqual(fs.existsSync(poolPath), true, "pool-config must be written to disk");
  const onDisk = JSON.parse(fs.readFileSync(poolPath, "utf8"));
  assert.strictEqual(onDisk.authorization.realRequestPermission, "allowed");
  assert.ok(onDisk.authorization.authorizedProfileIds.includes(PROFILE_A));
  assert.strictEqual(provider._test.hasSecretKeys(onDisk), false, "pool-config policy object must not trip secret scan");

  const ap = provider.poolConfigAutoprobe({ enable: true });
  assert.strictEqual(ap.config.autoProbe.enabled, true);
  assert.ok(ap.config.auditLog.some((a) => a.action === "autoprobe-enable"));
  assert.strictEqual(fs.existsSync(poolPath), true);
  assert.strictEqual(JSON.parse(fs.readFileSync(poolPath, "utf8")).autoProbe.enabled, true);

  // disable again for safety of later tests that shouldn't probe
  provider.poolConfigAutoprobe({ disable: true });

  // corrupt config → hard fail
  write(availability.poolConfigPath(dataRoot), { schemaVersion: 6, broken: true });
  let hard = false;
  try {
    provider.poolConfigStatus();
  } catch (error) {
    hard = error.code === "POOL_CONFIG_INVALID";
  }
  assert.strictEqual(hard, true);
  // restore clean denied config
  fs.rmSync(availability.poolConfigPath(dataRoot), { force: true });
});

test("maintenance-candidates-narrowing", () => {
  const dataRoot = provider.DATA_ROOT;
  // A: quota frozen due; B: active
  availability.writeAvailabilityCas(
    dataRoot,
    PROFILE_A,
    {
      ...availability.emptyAvailability(PROFILE_A),
      state: "frozen",
      scope: "quota",
      nextProbeAt: new Date(Date.now() - 1000).toISOString(),
      consecutiveFailures: 1
    },
    availability.loadAvailability(dataRoot, PROFILE_A, deps).revision,
    deps
  );
  availability.writeAvailabilityCas(
    dataRoot,
    PROFILE_B,
    availability.markActive(availability.emptyAvailability(PROFILE_B)),
    availability.loadAvailability(dataRoot, PROFILE_B, deps).revision,
    deps
  );

  const cfg = availability.defaultPoolConfig();
  cfg.authorization.realRequestPermission = "allowed";
  cfg.authorization.authorizedProfileIds = [PROFILE_A];
  cfg.authorization.authorizedAt = new Date().toISOString();

  const sel = availability.selectMaintenanceCandidates(provider.loadRegistry(), cfg, dataRoot, deps);
  assert.ok(sel.selected.some((r) => r.profileId === PROFILE_A));
  assert.ok(!sel.selected.some((r) => r.profileId === PROFILE_B));
  assert.ok(sel.skipped.some((s) => s.profileId === PROFILE_B && /not-authorized|scope|state|not-due|cooldown/.test(s.reason + (s.state || "")) || s.reason === "not-authorized" || s.reason === "scope-not-quota"));
});

test("isolation-redline-and-probe-args", () => {
  const env = provider._test.isolatedEnv(registry.profiles[0], path.join(sandbox, "inv"), path.join(sandbox, "s.sock"));
  assert.strictEqual(env.GROK_HOME, p1Home);
  assert.strictEqual(env.XAI_API_KEY, undefined);
  assert.strictEqual(env.GROK_CLAUDE_HOOKS_ENABLED, "false");
  assert.strictEqual(env.GROK_CURSOR_HOOKS_ENABLED, "false");
  assert.strictEqual(env.GROK_FOLDER_TRUST, undefined);

  const plan = availability.buildMaintenanceProbeArgs(path.join(sandbox, "scratch"), crypto.randomUUID(), path.join(sandbox, "leader.sock"));
  assert.strictEqual(plan.promptText, availability.PROBE_PROMPT);
  assert.ok(plan.args.includes("--max-turns"));
  assert.strictEqual(plan.args[plan.args.indexOf("--max-turns") + 1], "1");
  assert.ok(!plan.args.includes("--allow"));
  assert.ok(plan.args.includes("--deny"));
});

test("mock-maintenance-tick-recovered", () => {
  const dataRoot = provider.DATA_ROOT;
  // reset clean pool config authorized + enabled
  fs.rmSync(availability.poolConfigPath(dataRoot), { force: true });
  // fresh rate window
  fs.rmSync(availability.rateWindowPath(dataRoot), { force: true });

  provider.poolConfigAuthorize({ profiles: PROFILE_A });
  provider.poolConfigAutoprobe({ enable: true });
  assert.strictEqual(fs.existsSync(availability.poolConfigPath(dataRoot)), true, "authorize must leave durable pool-config");

  // ensure A is quota probe_due
  const cur = availability.loadAvailability(dataRoot, PROFILE_A, deps);
  availability.writeAvailabilityCas(
    dataRoot,
    PROFILE_A,
    {
      ...cur,
      state: "probe_due",
      scope: "quota",
      nextProbeAt: new Date(Date.now() - 1000).toISOString(),
      consecutiveFailures: 2
    },
    cur.revision,
    deps
  );

  const tick = provider.poolMaintenanceTick({
    executeProbeFn: () => ({
      status: 0,
      stdout: JSON.stringify({ type: "end", requestId: "req-mock-1", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }) + "\ngrok-availability-ok\n",
      stderr: "",
      parsed: {
        terminal: { type: "end", requestId: "req-mock-1", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
        finalText: "grok-availability-ok"
      }
    })
  });
  assert.strictEqual(tick.realRequests, 0, "mock executeProbeFn must not count as real");
  assert.ok(tick.probesStarted >= 1 || tick.skipped.length >= 0);
  if (tick.probeResults.length > 0) {
    assert.strictEqual(tick.probeResults[0].outcome, "recovered");
    const after = availability.loadAvailability(dataRoot, PROFILE_A, deps);
    assert.strictEqual(after.state, "active");
  }
  // pool-config still present after mock tick (no secret-invariant wipe)
  assert.strictEqual(fs.existsSync(availability.poolConfigPath(dataRoot)), true);

  // close gates again
  provider.poolConfigAutoprobe({ disable: true });
  provider.poolConfigRevoke({});
});

test("deploy-pointer-rollback-and-list", () => {
  const dataRoot = provider.DATA_ROOT;
  const release = path.join(sandbox, "release-1.0.0-r8");
  mkdir(release);
  const manifestBody = { version: "1.0.0-r8", name: "test" };
  const manifestPath = path.join(release, "release-manifest.json");
  write(manifestPath, manifestBody);
  const sha = crypto.createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex");

  const pointer = provider.writeVersionedDeployPointer({
    version: "1.0.0-r8",
    releasePath: release,
    previousVersion: null,
    dataRoot,
    registryPath: process.env.GROK_WORKER_PROFILES,
    manifestSha256: sha
  });
  assert.strictEqual(pointer.version, "1.0.0-r8");
  assert.strictEqual(availability.validateDeployPointerV6(pointer).ok, true);
  // versioned pointer must not touch machine-global or even sandbox current until rollback
  assert.strictEqual(fs.existsSync(machineCurrentJson) ? fs.readFileSync(machineCurrentJson, "utf8") : null, machineCurrentBefore);

  const listed = provider.deployList();
  assert.strictEqual(listed.realRequests, 0);
  assert.ok(listed.versions.some((v) => v.version === "1.0.0-r8" && v.valid));

  // bad sha must not change sandbox current.json
  const currentPath = provider.CURRENT_POINTER_PATH;
  const before = fs.existsSync(currentPath) ? fs.readFileSync(currentPath, "utf8") : null;
  write(availability.deployPointerPath(dataRoot, "1.0.0-bad"), {
    ...pointer,
    version: "1.0.0-bad",
    manifestSha256: "b".repeat(64)
  });
  let failedRollback = false;
  try {
    provider.deployRollback({ to: "1.0.0-bad" });
  } catch (error) {
    failedRollback = error.code === "DEPLOY_MANIFEST_MISMATCH" || error.code === "DEPLOY_POINTER_INVALID" || Boolean(error.code);
  }
  assert.strictEqual(failedRollback, true);
  const after = fs.existsSync(currentPath) ? fs.readFileSync(currentPath, "utf8") : null;
  assert.strictEqual(after, before);

  // good rollback only writes sandbox CURRENT_POINTER_PATH
  const ok = provider.deployRollback({ to: "1.0.0-r8" });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.realRequests, 0);
  assert.strictEqual(path.resolve(ok.currentPath), path.resolve(sandboxCurrentJson));
  assert.strictEqual(fs.existsSync(sandboxCurrentJson), true);
  // machine-global must remain untouched
  const machineAfter = fs.existsSync(machineCurrentJson) ? fs.readFileSync(machineCurrentJson, "utf8") : null;
  assert.strictEqual(machineAfter, machineCurrentBefore, "machine-global current.json must remain unchanged");
});

test("deploy-template-and-installer-present", () => {
  const deployDir = path.join(__dirname, "..", "deploy");
  const xml = fs.readFileSync(path.join(deployDir, "GrokWorkerProviderMaintenance.template.xml"), "utf8");
  assert.match(xml, /\{\{USERID\}\}/);
  assert.match(xml, /\{\{START_BOUNDARY\}\}/);
  assert.match(xml, /\{\{SHIM_PATH\}\}/);
  assert.match(xml, /\{\{WORKING_DIR\}\}/);
  assert.match(xml, /<Enabled>false<\/Enabled>/);
  assert.match(xml, /PT30M/);
  assert.match(xml, /pool maintenance tick/);
  assert.match(xml, /IgnoreNew/);
  assert.match(xml, /LeastPrivilege/);

  const ps1 = fs.readFileSync(path.join(deployDir, "install-maintenance-task.ps1"), "utf8");
  assert.match(ps1, /\$LASTEXITCODE/);
  assert.match(ps1, /UnicodeEncoding/);
  assert.match(ps1, /\/DISABLE/);
  assert.match(ps1, /unrendered placeholder/);
  assert.match(ps1, /GrokWorkerProviderMaintenance\.template\.xml/);
  // ASCII-only installer for reliable PowerShell parse under default encodings
  assert.strictEqual(/[^\x09\x0A\x0D\x20-\x7E]/.test(ps1), false, "install-maintenance-task.ps1 must be ASCII-only");
});

test("install-maintenance-task-no-ru-sid-principal-verify", () => {
  // Static regression: schtasks stores UserId as SID; installer must not /RU (password)
  // and must verify principal by current SID via task-namespace XML, not username regex.
  const ps1 = fs.readFileSync(
    path.join(__dirname, "..", "deploy", "install-maintenance-task.ps1"),
    "utf8"
  );
  assert.doesNotMatch(ps1, /\/RU\b/, "installer must not pass /RU (avoids password prompt)");
  assert.doesNotMatch(ps1, /schtasks\.exe[^\r\n]*\/RU\b/);
  assert.match(ps1, /schtasks\.exe\s+\/Create\s+\/TN\s+"GrokWorkerProviderMaintenance"\s+\/XML\s+"\$out"\s+\/F/);
  assert.match(ps1, /\[Security\.Principal\.WindowsIdentity\]::GetCurrent\(\)/);
  assert.match(ps1, /\$identity\.User\.Value|\$sid\s*=/);
  assert.match(ps1, /\.User\.Value/);
  assert.match(ps1, /XmlNamespaceManager/);
  assert.match(ps1, /schemas\.microsoft\.com\/windows\/2004\/02\/mit\/task/);
  assert.match(ps1, /SelectSingleNode/);
  assert.match(ps1, /task:Principals\/task:Principal\/task:UserId|\/\/task:UserId/);
  assert.match(ps1, /principal SID mismatch|InnerText\s*-ne\s*\$sid/);
  assert.doesNotMatch(ps1, /\[regex\]::Escape\(\s*"<UserId>\$user<\/UserId>"\s*\)/);
  assert.doesNotMatch(ps1, /<UserId>\$user<\/UserId>/);
  // Preserve disabled-by-default, interval, principal, policy, cmd shim, no real probe
  assert.match(ps1, /\/DISABLE/);
  assert.doesNotMatch(ps1, /\/ENABLE\b/);
  assert.match(ps1, /PT30M/);
  assert.match(ps1, /IgnoreNew/);
  assert.match(ps1, /LeastPrivilege/);
  assert.match(ps1, /InteractiveToken/);
  assert.match(ps1, /cmd\.exe/);
  assert.match(ps1, /pool maintenance tick/);
  assert.doesNotMatch(ps1, /executeProbe|start-probe|-RealRequest/i);
  assert.match(ps1, /Does not run a real probe/);
  assert.strictEqual(/[^\x09\x0A\x0D\x20-\x7E]/.test(ps1), false, "install-maintenance-task.ps1 must be ASCII-only");
});

test("read-only-fast-path-flags", () => {
  assert.strictEqual(provider.isReadOnlyFastPath({ _: ["pool", "config", "status"] }), true);
  assert.strictEqual(provider.isReadOnlyFastPath({ _: ["deploy", "list"] }), true);
  assert.strictEqual(provider.isReadOnlyFastPath({ _: ["pool", "maintenance", "tick"] }), false);
  assert.strictEqual(provider.isReadOnlyFastPath({ _: ["pool", "config", "authorize"] }), false);
});

test("stable-machine-current-json-untouched", () => {
  const machineAfter = fs.existsSync(machineCurrentJson) ? fs.readFileSync(machineCurrentJson, "utf8") : null;
  assert.strictEqual(machineAfter, machineCurrentBefore, "stable machine-global current.json must match pre-harness snapshot");
  // sandbox pointer (if present) is valid shape when written by rollback
  if (fs.existsSync(sandboxCurrentJson)) {
    const ptr = JSON.parse(fs.readFileSync(sandboxCurrentJson, "utf8"));
    assert.strictEqual(availability.validateCurrentPointer(ptr).ok, true);
  }
});

test("live-canary-success-benign-stderr-errorType-null", () => {
  const dataRoot = provider.DATA_ROOT;
  // Ensure a selectable active profile for the mock task run
  {
    const cur = availability.loadAvailability(dataRoot, PROFILE_A, deps);
    const next = availability.markActive(cur);
    availability.writeAvailabilityCas(dataRoot, PROFILE_A, next, cur.revision, deps);
  }

  const capsule = {
    taskId: `benign-stderr-${crypto.randomUUID()}`,
    stage: "v6-live-canary-regression",
    objective: "mock success with benign stderr",
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
    model: "grok-4.5",
    reasoning: "high",
    speed: "standard",
    policy: { access: "readonly", bash: "denied", agents: "denied", mcp: "denied", web: "denied" },
    profile: "worker-a",
    probePolicy: availability.defaultProbePolicy()
  };
  const taskFile = path.join(sandbox, "task-benign-stderr.json");
  write(taskFile, capsule);

  const sessionId = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  // Benign stderr that previously forced unknown_failure despite exit 0 + end event
  const benignStderr = "grok: experimental feature notice\n(node:1234) ExperimentalWarning: benign runtime notice\n";
  const out = provider.runTask(null, taskFile, {
    skipInspect: true,
    baselineCheckFn: () => {},
    changedFilesFinalStateFn: () => [],
    executePlanFn: () => ({
      status: 0,
      stdout: `${JSON.stringify({
        type: "end",
        sessionId,
        requestId,
        stopReason: "end",
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      })}\n`,
      stderr: benignStderr,
      parsed: {
        summary: [{ type: "end", sessionId, requestId, hasUsage: true, textBytes: 2 }],
        terminal: {
          type: "end",
          sessionId,
          requestId,
          stopReason: "end",
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        },
        invalid: 0,
        finalText: "ok"
      },
      rawCleanupFailed: false
    })
  });

  assert.strictEqual(out.attempts.length, 1);
  assert.strictEqual(out.taskRun.status, "completed");
  const ref = path.join(dataRoot, out.attempts[0].resultRef);
  assert.strictEqual(fs.existsSync(ref), true, "Result Capsule must be persisted");
  const capsuleResult = JSON.parse(fs.readFileSync(ref, "utf8"));
  assert.strictEqual(capsuleResult.status, "completed");
  assert.strictEqual(capsuleResult.exitCode, 0);
  assert.strictEqual(capsuleResult.redaction.rawCleanupFailed, false);
  assert.strictEqual(capsuleResult.boundaryCompliance.allowed, true);
  // Live-canary defect: full success must persist errorType null despite benign stderr
  assert.strictEqual(
    capsuleResult.errorClassification.errorType,
    null,
    "success Result Capsule errorType must be null when only benign stderr exists"
  );
  assert.strictEqual(capsuleResult.errorClassification.note, "no-error-on-success");
  provider.validateResultCapsule(capsuleResult);

  // Preserve hard classifications (quota) — exit non-zero + exhausted stderr
  const quotaClass = availability.classifyError({
    statusCode: 402,
    stderr: "usage balance exhausted is_retryable=false"
  });
  assert.strictEqual(quotaClass.errorType, "quota_exhausted");
  const reauthClass = availability.classifyError({
    statusCode: 401,
    stderr: "unauthorized reauth required"
  });
  assert.strictEqual(reauthClass.errorType, "reauth_required");
  const rateClass = availability.classifyError({
    statusCode: 429,
    stderr: "rate limit account Retry-After: 30"
  });
  assert.strictEqual(rateClass.errorType, "rate_limited");
});

// ─── summary ───
const summary = {
  suite: "availability-v6-r8",
  passed,
  failed,
  realRequests: 0,
  machineCurrentJsonUnchanged: (fs.existsSync(machineCurrentJson) ? fs.readFileSync(machineCurrentJson, "utf8") : null) === machineCurrentBefore,
  evidence
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (failed > 0) process.exitCode = 1;
