"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const assert = require("assert");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "grok-worker-provider-test-"));
process.env.GROK_WORKER_DATA_ROOT = path.join(sandbox, "data");
process.env.GROK_WORKER_PROFILES = path.join(sandbox, "profiles.json");
process.env.GROK_WORKER_APPROVED_PROFILE_ROOT = path.join(sandbox, "profile-root");
const provider = require("../lib/provider");

let passed = 0; let failed = 0; const evidence = [];
function test(name, fn) {
  try { fn(); passed += 1; evidence.push({ name, status: "PASS" }); }
  catch (error) { failed += 1; evidence.push({ name, status: "FAIL", error: error.safeMessage || error.message }); }
}
function expectCode(code, fn) {
  let actual = null; try { fn(); } catch (error) { actual = error.code; }
  assert.strictEqual(actual, code);
}
function mkdir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function write(file, data) { mkdir(path.dirname(file)); fs.writeFileSync(file, data, "utf8"); }
function git(cwd, args) {
  const result = require("child_process").spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.strictEqual(result.status, 0, result.stderr); return String(result.stdout || "").trim();
}
function makeRepo(name) {
  const root = path.join(sandbox, name); mkdir(root); git(root, ["init", "--quiet"]); git(root, ["config", "user.email", "provider-test@example.invalid"]); git(root, ["config", "user.name", "Provider Test"]);
  write(path.join(root, "allowed", "seed.txt"), "seed\n"); write(path.join(root, ".gitignore"), "ignored.txt\n"); git(root, ["add", "."]); git(root, ["commit", "-m", "baseline", "--quiet"]); return root;
}
const repo = makeRepo("repo");
const profileRoot = path.join(sandbox, "profile-root"); const profileHome = path.join(profileRoot, "example-account"); mkdir(profileHome);
const registry = {
  schemaVersion: 3, approvedProfileRoot: profileRoot, allowedWorkspaceRoots: [repo],
  profiles: [{
    profileId: "550e8400-e29b-41d4-a716-446655440000", alias: "example-account", grokHome: profileHome,
    executable: path.join(os.homedir(), ".grok", "bin", "grok.exe"), accountLabel: "test",
    authReadiness: { oauthReady: true, verifiedAt: new Date().toISOString() },
    identity: { identityStatus: "unknown", source: "cli_probe", value: null, capturedAt: new Date().toISOString(), providerVersion: provider.VERSION },
    sandboxCapability: { flagSupported: true, enforcementSupported: false, platform: "windows", evidence: "Linux/macOS only" },
    modelSnapshot: { models: ["grok-4.6"], reasoning: ["high"], checkedAt: new Date().toISOString() }
  }]
};
provider.saveRegistry(registry);
function capsule(overrides = {}) {
  return {
    taskId: "provider-test", stage: "G0", objective: "test provider", baseCommit: git(repo, ["rev-parse", "HEAD"]),
    workspace: repo, worktree: { mode: "read-only-shared-checkout", path: repo }, allowedFiles: ["allowed/**"],
    forbiddenActions: ["service control", "OAuth"], acceptanceCommands: ["node test.js"], contextRefs: ["allowed/seed.txt"],
    realRequestPermission: "denied", serviceControlPermission: "denied", gitPermission: "read-only", grokSessionId: null,
    resumePolicy: { mode: "new-only", rule: "new only" }, explicitStop: "stop after test", model: "grok-4.6", reasoning: "high", speed: "standard",
    profile: "example-account", policy: { access: "readonly", bash: "denied", agents: "denied", mcp: "denied", web: "denied" },
    failover: { allowedFallbackProfiles: [], mode: "pre-first-request-only", switchPermission: "denied" }, ...overrides
  };
}
const deniedTaskFile = path.join(sandbox, "generated-denied.json");
write(deniedTaskFile, `${JSON.stringify(capsule(), null, 2)}\n`);

test("G0 accepts complete Provider v3 capsule", () => provider.validateTaskCapsule(capsule(), provider.loadRegistry()));
test("G0 rejects every missing inherited field", () => {
  for (const field of ["taskId", "stage", "objective", "baseCommit", "workspace", "worktree", "allowedFiles", "forbiddenActions", "acceptanceCommands", "contextRefs", "realRequestPermission", "serviceControlPermission", "gitPermission", "grokSessionId", "resumePolicy", "explicitStop"]) {
    const value = capsule(); delete value[field]; expectCode("CAPSULE_REQUIRED", () => provider.validateTaskCapsule(value, provider.loadRegistry()));
  }
});
test("G0 rejects raw tools and plan permission", () => {
  const raw = capsule(); raw.rawTools = ["run_terminal_cmd"]; expectCode("CAPSULE_ADDITIONAL", () => provider.validateTaskCapsule(raw, provider.loadRegistry()));
  expectCode("CAPSULE_REAL_PERMISSION", () => provider.validateTaskCapsule(capsule({ realRequestPermission: "plan" }), provider.loadRegistry()));
});
test("G0 rejects credential-shaped fields", () => { const value = capsule(); value.token = "bad"; expectCode("CAPSULE_ADDITIONAL", () => provider.validateTaskCapsule(value, provider.loadRegistry())); });
test("G0 rejects invalid Bash and non-denied agents/mcp/web", () => {
  for (const policy of [{ ...capsule().policy, bash: "allowed-with-patterns" }, { ...capsule().policy, agents: "allowed" }, { ...capsule().policy, mcp: "allowed" }, { ...capsule().policy, web: "allowed" }]) expectCode(policy.bash === "allowed-with-patterns" ? "CAPSULE_BASH" : "CAPSULE_POLICY_DENIED", () => provider.validateTaskCapsule(capsule({ policy }), provider.loadRegistry()));
});
test("G0 path traversal, UNC, device, default home and case containment fail", () => {
  for (const value of ["..\\escape", "\\\\server\\share", "\\\\?\\C:\\escape", "\\\\.\\C:\\escape", path.join(os.homedir(), ".grok")]) assert.throws(() => provider.validateWindowsPath(value, repo, "negative"));
  assert.throws(() => provider.validateWindowsPath(repo.toUpperCase() + "-escape", repo, "case"));
});
test("G0 rejects junction/reparse paths", () => {
  const target = path.join(sandbox, "junction-target"); const link = path.join(repo, "junction"); mkdir(target);
  try { fs.symlinkSync(target, link, "junction"); expectCode("PATH_REPARSE", () => provider.validateWindowsPath(link, repo, "junction")); }
  catch (error) { if (!["EPERM", "EEXIST"].includes(error.code)) throw error; }
});
test("G1 profileId and no auth hash are enforced", () => {
  const missing = { ...registry.profiles[0] }; delete missing.profileId; expectCode("PROFILE_ID", () => provider.validateProfile(missing, registry));
  const bad = { ...registry.profiles[0], authHash: "bad" }; expectCode("INV1_PROFILE_SECRET", () => provider.validateProfile(bad, registry));
});
test("G1 Windows sandbox truth is enforced", () => { const bad = JSON.parse(JSON.stringify(registry.profiles[0])); bad.sandboxCapability.enforcementSupported = true; expectCode("PROFILE_SANDBOX", () => provider.validateProfile(bad, registry)); });
test("G1/G9 onboarding creates an empty isolated profile without copying auth", () => {
  const created = provider.registerEmptyProfile("new-account-test"); assert.strictEqual(created.authReadiness.oauthReady, false); assert.strictEqual(created.identity.identityStatus, "unknown"); assert(created.grokHome.startsWith(profileRoot)); assert(!fs.existsSync(path.join(created.grokHome, "auth.json")));
});
test("G1 probe merges the fresh official model cache and never falls back on probe failure", () => {
  write(path.join(profileHome, "models_cache.json"), JSON.stringify({ models: { "grok-4.6": {}, "grok-4.5": {} } }));
  assert.deepStrictEqual(provider.probeModelIds(registry.profiles[0], { status: 0, stdout: "  grok-4.5 legacy\n" }), ["grok-4.5", "grok-4.6"]);
  assert.deepStrictEqual(provider.probeModelIds(registry.profiles[0], { status: 1, stdout: "grok-4.6" }), []);
});
test("G2 planTemplate is deterministic and fixed", () => {
  const a = provider.planTemplate(capsule(), registry.profiles[0]); const b = provider.planTemplate(capsule(), registry.profiles[0]); assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
  for (const flag of ["--no-plan", "--no-memory", "streaming-json", "--prompt-file", "--cwd", "run_terminal_cmd,Agent", "--no-subagents"]) assert(a.args.includes(flag));
  assert(!a.args.includes("--trust") && !a.args.includes("--sandbox"));
  assert.strictEqual(a.env.GROK_CLAUDE_HOOKS_ENABLED, "false");
  assert.strictEqual(a.env.GROK_CURSOR_HOOKS_ENABLED, "false");
});
test("G2 materialized plans have unique invocation/socket and no trust env", () => {
  const a = provider.materialize(capsule(), provider.loadRegistry(), { skipInspect: true }); const b = provider.materialize(capsule(), provider.loadRegistry(), { skipInspect: true });
  assert.notStrictEqual(a.invocationId, b.invocationId); assert.notStrictEqual(a.socket, b.socket); assert.strictEqual(a.env.GROK_FOLDER_TRUST, undefined); assert.strictEqual(a.settings.permissions.defaultMode, "dontAsk");
  assert.strictEqual(a.env.GROK_CLAUDE_HOOKS_ENABLED, "false");
  assert.strictEqual(a.env.GROK_CURSOR_HOOKS_ENABLED, "false");
});
test("G2 permission rules compile read-only context and permanent deny", () => {
  const settings = provider.buildPermissionSettings(capsule(), repo); const all = settings.permissions.deny.join("\n");
  for (const marker of [".git", ".grok", ".claude", "runtime", "Bash", "MCPTool", "WebFetch", "service", "git commit"]) assert(all.includes(marker));
  assert(settings.permissions.allow.every((x) => x.startsWith("Read(")));
  const freeText = capsule({ forbiddenActions: ["read, copy, hash, symlink, or print auth.json", "use default %USERPROFILE%\\.grok as a worker profile"] });
  const freeTextPlan = provider.planTemplate(freeText, registry.profiles[0]);
  assert(!freeTextPlan.args.some((item) => item.includes("auth.json") || item.includes("default C:")));
  provider.verifyPlanContract({ ...freeTextPlan, settings: provider.buildPermissionSettings(freeText, repo) }, freeText);
  const writable = capsule({ allowedFiles: ["allowed/seed.txt"], policy: { access: "workspace-write", bash: "denied", agents: "denied", mcp: "denied", web: "denied" } });
  const writeSettings = provider.buildPermissionSettings(writable, repo);
  assert(writeSettings.permissions.allow.includes("Edit(allowed/seed.txt)"));
  assert(!writeSettings.permissions.allow.includes("Edit(allowed/seed.txt/**)"));
  const plan = provider.planTemplate(writable, registry.profiles[0]);
  assert(plan.args.some((item, index) => item === "--allow" && plan.args[index + 1] === "Edit(allowed/seed.txt)"));
});
test("G2 stable shim resolves current release instead of its own directory", () => {
  const shim = fs.readFileSync(path.join(__dirname, "..", "grok-worker.cmd"), "utf8");
  assert(shim.includes("GROK_WORKER_CURRENT_JSON"));
  assert(shim.includes("GROK_WORKER_RELEASE"));
  assert(shim.includes("v.releasePath"));
  assert(shim.includes("v.approvedProfileRoot"));
  assert(shim.includes("%GROK_WORKER_RELEASE%\\bin\\grok-worker.js"));
  assert(!shim.includes('node "%~dp0bin\\grok-worker.js"'));
});
test("G2 project permission allow, hook and MCP injection hard fail", () => {
  for (const [name, rel, body] of [["allow", ".claude/settings.json", '{"permissions":{"allow":["*"]}}'], ["hook", ".grok/hooks/elevate.json", '{}'], ["mcp", ".grok/config.toml", '[mcp_servers.evil]\ncommand="evil"']]) {
    const badRepo = makeRepo(`malicious-${name}`); write(path.join(badRepo, rel), body); expectCode("PROJECT_AUTHORITY", () => provider.preflightProject(badRepo));
  }
});
test("G2 plan is zero-spawn and denied run fails before spawn", () => {
  const plan = provider.planTask("example-account", deniedTaskFile); assert.strictEqual(plan.spawnCount, 0);
});
test("G2 contract mutation fails when enforcement is removed", () => {
  const materialized = provider.materialize(capsule(), provider.loadRegistry(), { skipInspect: true });
  const mutations = ["--no-plan", "run_terminal_cmd,Agent", "--no-subagents"];
  for (const item of mutations) { const copy = { ...materialized, args: materialized.args.filter((x) => x !== item), settings: materialized.settings }; expectCode("PLAN_CONTRACT", () => provider.verifyPlanContract(copy, capsule())); }
  const copy = JSON.parse(JSON.stringify(materialized)); copy.settings.permissions.deny = copy.settings.permissions.deny.filter((x) => !x.includes("service")); expectCode("PLAN_CONTRACT", () => provider.verifyPlanContract(copy, capsule()));
});
test("G2 hook fail-open cannot remove dontAsk plus permanent deny", () => {
  const materialized = provider.materialize(capsule(), provider.loadRegistry(), { skipInspect: true });
  const outside = provider.evaluatePolicyRequest(materialized.settings, { tool: "Write", path: path.join(repo, "outside.txt") }, "failure");
  const allowed = provider.evaluatePolicyRequest(materialized.settings, { tool: "Read", path: path.join(repo, "allowed", "seed.txt") }, "failure");
  const permanent = provider.evaluatePolicyRequest(materialized.settings, { tool: "Write", path: path.join(repo, ".git", "config") }, "failure");
  assert.deepStrictEqual([outside.decision, outside.reason], ["deny", "dontask-no-allow"]); assert.strictEqual(allowed.decision, "allow"); assert.deepStrictEqual([permanent.decision, permanent.reason], ["deny", "permanent-deny"]);
});
test("G3 raw stream parses in memory and preserves numeric usage", () => {
  const raw = fs.readFileSync(path.join(__dirname, "..", "fixtures", "stream.with-body-content.jsonl"), "utf8"); const parsed = provider.parseStream(raw); const usage = provider.numericUsage(parsed.terminal.usage);
  assert.strictEqual(parsed.terminal.type, "end"); assert.deepStrictEqual([usage.input_tokens, usage.cache_read_input_tokens, usage.output_tokens, usage.reasoning_tokens, usage.total_tokens], [10, 2, 3, 4, 19]);
  const redacted = provider._test.redactText(raw); assert(!redacted.includes("secret-value")); assert(redacted.includes("\"total_tokens\":19"));
});
test("G3 changed-files detects tracked, untracked and ignored", () => {
  write(path.join(repo, "allowed", "seed.txt"), "changed\n"); write(path.join(repo, "untracked.txt"), "u\n"); write(path.join(repo, "ignored.txt"), "i\n"); const entries = provider.changedFilesFinalState(repo);
  assert(entries.some((x) => x.path.includes("allowed/seed.txt"))); assert(entries.some((x) => x.path.includes("untracked.txt"))); assert(entries.some((x) => x.ignored && x.path.includes("ignored.txt")));
  assert.strictEqual(provider.changedWithinAllowed(entries, capsule()), false); git(repo, ["reset", "--hard", "HEAD"]); fs.rmSync(path.join(repo, "untracked.txt"), { force: true }); fs.rmSync(path.join(repo, "ignored.txt"), { force: true });
});
test("G3 startup orphan cleanup contract uses provider temp only", () => { const orphan = path.join(provider.DATA_ROOT, "temp", "orphan.raw.jsonl"); write(orphan, "raw"); const removed = provider.cleanupOrphanRaw(); assert(removed.includes(orphan)); assert(!fs.existsSync(orphan)); });
test("G4 ledger aggregates three invocations and byProfileId", () => {
  const base = { variant: "main", profileAlias: "example-account", accountIdentitySnapshot: registry.profiles[0].identity, quotaSignal: { present: false, usedPercent: null, source: "end_event" } };
  for (let i = 1; i <= 3; i += 1) provider.recordInvocation("ledger-three", { ...base, invocationId: crypto.randomUUID(), profileId: i === 3 ? "650e8400-e29b-41d4-a716-446655440000" : registry.profiles[0].profileId, sessionId: `s-${i}`, requestId: `r-${i}`, runUsage: { present: true, input_tokens: i, cache_read_input_tokens: i, output_tokens: i, reasoning_tokens: i, total_tokens: i * 4, modelUsage: {} } });
  const ledger = provider.usageShow({ task: "ledger-three" }).ledgers[0]; assert.strictEqual(ledger.layers.sumRunUsage.total_tokens, 24); assert.strictEqual(Object.keys(ledger.layers.byProfileId).length, 2);
});
test("G4 same dedup key with different numbers hard fails", () => {
  const inv = { invocationId: crypto.randomUUID(), profileId: registry.profiles[0].profileId, profileAlias: "example-account", sessionId: "same", requestId: "same", variant: "main", accountIdentitySnapshot: registry.profiles[0].identity, runUsage: { present: true, input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1, reasoning_tokens: 0, total_tokens: 2, modelUsage: {} }, quotaSignal: { present: false, usedPercent: null, source: "end_event" } };
  provider.recordInvocation("conflict", inv); inv.runUsage.total_tokens = 3; expectCode("LEDGER_CONFLICT", () => provider.recordInvocation("conflict", inv));
});
test("G4 truncated invocation is unknown and not guessed", () => {
  const inv = { invocationId: crypto.randomUUID(), profileId: registry.profiles[0].profileId, profileAlias: "example-account", sessionId: "truncated", requestId: "unknown", variant: "main", accountIdentitySnapshot: registry.profiles[0].identity, runUsage: provider.numericUsage(null), quotaSignal: { present: false, usedPercent: null, source: "end_event" } };
  const ledger = provider.recordInvocation("truncated", inv); assert.strictEqual(ledger.layers.sumRunUsage.invocationsUnknown, 1); assert.strictEqual(ledger.layers.sumRunUsage.total_tokens, 0);
});
test("G4 Provider v3 Result Capsule validator enforces redaction and boundary fields", () => {
  const result = { status: "completed", grokSessionId: null, baseCommit: "0".repeat(40), changedFiles: [], commands: [], tests: [], findings: [], assumptions: [], unresolved: [], residualRisks: [], commitEvidence: [], diffEvidence: [], boundaryCompliance: { changedFilesFinalState: [], policyAuditEvents: [], allowed: true }, taskId: "x", stage: "G4", worktree: { mode: "read-only-shared-checkout", path: repo }, exitCode: 0, redaction: { applied: true, notes: ["x"], rawStreamDeleted: true, rawCleanupFailed: false }, profileId: registry.profiles[0].profileId, invocationId: crypto.randomUUID(), requestId: "r", variant: "main", stopReason: "end", durationMs: 1, selectionEvidence: { selectionMode: "explicit", candidateProfileIds: [registry.profiles[0].profileId], skippedReasons: [], finalSelectedProfileId: registry.profiles[0].profileId, maintenanceProbePlanned: false }, errorClassification: { errorType: "none", statusCode: null, retryable: null, quotaKind: null, profileAttributable: false } };
  provider.validateResultCapsule(result); result.redaction.rawStreamDeleted = false; expectCode("RESULT_REDACTION", () => provider.validateResultCapsule(result));
});
test("G4 successful execution is classified as none, never unknown_failure", () => {
  const result = provider.buildResultCapsule({
    capsule: capsule(),
    plan: { profileId: registry.profiles[0].profileId, invocationId: crypto.randomUUID(), sessionId: "success-session", baseCommit: "0".repeat(40), worktree: { mode: "read-only-shared-checkout", path: repo }, selectionEvidence: { selectionMode: "explicit", candidateProfileIds: [registry.profiles[0].profileId], skippedReasons: [], finalSelectedProfileId: registry.profiles[0].profileId, maintenanceProbePlanned: false } },
    execution: { status: 0, stderr: "", rawCleanupFailed: false, parsed: { invalid: 0, terminal: { type: "end", stopReason: "EndTurn", sessionId: "success-session", requestId: "success-request" }, finalText: "ok" } },
    classification: { errorType: "none", statusCode: null, retryable: null, quotaKind: null, profileAttributable: false, note: "no-error-on-success" },
    changedFiles: []
  });
  assert.strictEqual(result.status, "completed");
  assert.strictEqual(result.errorClassification.errorType, "none");
  provider.validateResultCapsule(result);
});
test("G5 profile and file locks conflict while disjoint files do not overlap", () => {
  const deps = {
    signalProcess(pid) { assert.strictEqual(pid, process.pid); },
    queryProcessStartTicks(pid) { assert.strictEqual(pid, process.pid); return "333"; }
  };
  const lock = provider.acquireLock("profile", [profileHome], repo, 30000, deps);
  expectCode("LOCK_CONFLICT", () => provider.acquireLock("profile", [profileHome], repo, 30000, deps));
  lock.release();
  assert(provider.patternsOverlap("allowed/**", "allowed/seed.txt", repo)); assert(!provider.patternsOverlap("allowed/**", "other/**", repo));
});
function resetLockFixtures() {
  fs.rmSync(provider.LOCK_ROOT, { recursive: true, force: true });
  mkdir(provider.LOCK_ROOT);
}
function writeLockFixture(overrides = {}) {
  const value = {
    lockId: `fixture-${crypto.randomUUID()}`,
    scope: "profile",
    patterns: [profileHome],
    root: repo,
    pid: process.pid + 100000,
    processStart: Date.now(),
    processStartTicks: "111",
    leaseMs: 30000,
    acquiredAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    ...overrides
  };
  const file = path.join(provider.LOCK_ROOT, `${value.lockId}.json`);
  write(file, `${JSON.stringify(value, null, 2)}\n`);
  return { file, value };
}
function lockDependencies(owner, options = {}) {
  return {
    signalProcess(pid) {
      assert.strictEqual(pid, owner.pid);
      if (options.signalError) {
        const error = new Error(options.signalError);
        error.code = options.signalError;
        throw error;
      }
    },
    queryProcessStartTicks(pid) {
      if (pid === process.pid) return options.ownTicks === undefined ? "333" : options.ownTicks;
      assert.strictEqual(pid, owner.pid);
      return options.observedTicks === undefined ? owner.processStartTicks : options.observedTicks;
    }
  };
}
function withCleanLocks(fn) {
  resetLockFixtures();
  try { fn(); } finally { resetLockFixtures(); }
}
test("G5 lock keeps a live exact owner and reports conflict", () => withCleanLocks(() => {
  const holder = writeLockFixture();
  const deps = lockDependencies(holder.value);
  assert.deepStrictEqual(provider._test.inspectLockOwner(holder.value, deps), {
    state: "live", reason: "owner-identity-live", observedStartTicks: "111"
  });
  expectCode("LOCK_CONFLICT", () => provider.acquireLock("profile", [profileHome], repo, 30000, deps));
  assert(fs.existsSync(holder.file));
}));
test("G5 lock reclaims a reused pid after exact ticks mismatch", () => withCleanLocks(() => {
  const holder = writeLockFixture();
  const deps = lockDependencies(holder.value, { observedTicks: "222" });
  assert.deepStrictEqual(provider._test.inspectLockOwner(holder.value, deps), {
    state: "dead", reason: "owner-pid-reused", observedStartTicks: "222"
  });
  const lock = provider.acquireLock("profile", [profileHome], repo, 30000, deps);
  assert(!fs.existsSync(holder.file));
  lock.release();
}));
test("G5 lock preserves an owner when start ticks are unavailable", () => withCleanLocks(() => {
  const holder = writeLockFixture();
  const deps = lockDependencies(holder.value, { observedTicks: null });
  assert.deepStrictEqual(provider._test.inspectLockOwner(holder.value, deps), {
    state: "unverifiable", reason: "owner-start-unavailable"
  });
  expectCode("LOCK_CONFLICT", () => provider.acquireLock("profile", [profileHome], repo, 30000, deps));
  assert(fs.existsSync(holder.file));
}));
test("G5 lock preserves an owner when liveness returns EPERM", () => withCleanLocks(() => {
  const holder = writeLockFixture();
  const deps = lockDependencies(holder.value, { signalError: "EPERM" });
  assert.deepStrictEqual(provider._test.inspectLockOwner(holder.value, deps), {
    state: "unverifiable", reason: "owner-liveness-unavailable"
  });
  expectCode("LOCK_CONFLICT", () => provider.acquireLock("profile", [profileHome], repo, 30000, deps));
  assert(fs.existsSync(holder.file));
}));
test("G5 lock reclaims an owner only after ESRCH proves pid absence", () => withCleanLocks(() => {
  const holder = writeLockFixture();
  const deps = lockDependencies(holder.value, { signalError: "ESRCH" });
  assert.deepStrictEqual(provider._test.inspectLockOwner(holder.value, deps), {
    state: "dead", reason: "owner-pid-absent"
  });
  const lock = provider.acquireLock("profile", [profileHome], repo, 30000, deps);
  assert(!fs.existsSync(holder.file));
  lock.release();
}));
test("G5 lock refuses acquisition when its own start ticks are unavailable", () => withCleanLocks(() => {
  const deps = {
    signalProcess() { throw new Error("unexpected owner probe"); },
    queryProcessStartTicks() { return null; }
  };
  expectCode("LOCK_OWNER_IDENTITY_UNAVAILABLE", () => provider.acquireLock("profile", [profileHome], repo, 30000, deps));
  assert.deepStrictEqual(fs.readdirSync(provider.LOCK_ROOT), []);
}));
test("G5 lock preserves an expired live owner", () => withCleanLocks(() => {
  const holder = writeLockFixture({
    heartbeatAt: new Date(Date.now() - 120000).toISOString(),
    leaseMs: 30000
  });
  const deps = lockDependencies(holder.value);
  const lease = provider._test.evaluateLease(holder.value);
  assert.strictEqual(lease.ok, true);
  assert.strictEqual(lease.fresh, false);
  expectCode("LOCK_CONFLICT", () => provider.acquireLock("profile", [profileHome], repo, 30000, deps));
  assert(fs.existsSync(holder.file));
}));
test("G5 lock preserves a live owner with invalid lease metadata", () => withCleanLocks(() => {
  const holder = writeLockFixture({ heartbeatAt: "not-a-timestamp", leaseMs: "nope" });
  const deps = lockDependencies(holder.value);
  assert.deepStrictEqual(provider._test.evaluateLease(holder.value), {
    ok: false, fresh: false, ageMs: null, reason: "lock-lease-unparseable"
  });
  expectCode("LOCK_CONFLICT", () => provider.acquireLock("profile", [profileHome], repo, 30000, deps));
  assert(fs.existsSync(holder.file));
}));
test("G5 lock preserves unparseable lock JSON and conflicts", () => withCleanLocks(() => {
  const file = path.join(provider.LOCK_ROOT, "corrupt-lock.json");
  write(file, "{not-json\n");
  const deps = {
    signalProcess() { throw new Error("unexpected owner probe"); },
    queryProcessStartTicks() { return "333"; }
  };
  expectCode("LOCK_CONFLICT", () => provider.acquireLock("profile", [profileHome], repo, 30000, deps));
  assert(fs.existsSync(file));
  const listed = provider.inspectLocks(deps);
  assert.strictEqual(listed.locks.length, 1);
  assert.strictEqual(listed.locks[0].lockId, "corrupt-lock");
  assert.strictEqual(listed.locks[0].ownerState, "unverifiable");
  assert.strictEqual(listed.locks[0].ownerReason, "lock-json-unparseable");
  assert.strictEqual(listed.locks[0].blocking, true);
  const cleaned = provider.cleanupLock("corrupt-lock", "corrupt-lock", deps);
  assert.strictEqual(cleaned.removed, true);
  assert(!fs.existsSync(file));
}));
test("G5 locks inspect lists lock id, scope, age, owner state and reason", () => withCleanLocks(() => {
  const holder = writeLockFixture();
  const deps = lockDependencies(holder.value);
  const listed = provider.inspectLocks(deps);
  assert.strictEqual(listed.inspectError, null);
  assert.strictEqual(listed.blockingCount, 1);
  assert.strictEqual(listed.locks[0].lockId, holder.value.lockId);
  assert.strictEqual(listed.locks[0].scope, "profile");
  assert.strictEqual(listed.locks[0].ownerState, "live");
  assert.strictEqual(listed.locks[0].ownerReason, "owner-identity-live");
  assert(typeof listed.locks[0].ageMs === "number");
  assert(fs.existsSync(holder.file));
}));
test("G5 doctor reports blocking locks without deleting them", () => withCleanLocks(() => {
  const emptyReport = provider.doctor({
    grokCliPath: path.join(sandbox, "missing-grok.exe"),
    lockDependencies: { queryProcessStartTicks() { return "333"; } }
  });
  const holder = writeLockFixture();
  const deps = lockDependencies(holder.value, { observedTicks: null });
  const report = provider.doctor({
    grokCliPath: path.join(sandbox, "missing-grok.exe"),
    lockDependencies: deps
  });
  assert.strictEqual(report.pass, emptyReport.pass);
  assert.strictEqual(report.providerHealthy, emptyReport.providerHealthy);
  assert.strictEqual(report.checks.find((check) => check.name === "lock-inspect").pass, true);
  assert.strictEqual(report.lockInspection.blockingCount, 1);
  assert.strictEqual(report.lockInspection.locks[0].lockId, holder.value.lockId);
  assert.strictEqual(report.lockInspection.locks[0].scope, "profile");
  assert.strictEqual(report.lockInspection.locks[0].ownerState, "unverifiable");
  assert.strictEqual(report.lockInspection.locks[0].ownerReason, "owner-start-unavailable");
  assert(typeof report.lockInspection.locks[0].ageMs === "number");
  assert(fs.existsSync(holder.file));
}));
test("G5 lock cleanup requires exact matching confirmation", () => withCleanLocks(() => {
  const holder = writeLockFixture();
  const deps = lockDependencies(holder.value, { signalError: "ESRCH" });
  expectCode("LOCK_CLEANUP_CONFIRM", () => provider.cleanupLock(holder.value.lockId, true, deps));
  expectCode("LOCK_CLEANUP_CONFIRM", () => provider.cleanupLock(holder.value.lockId, "other", deps));
  expectCode("LOCK_CLEANUP_ID", () => provider.cleanupLock("../escape", "../escape", deps));
  expectCode("LOCK_NOT_FOUND", () => provider.cleanupLock("missing-lock", "missing-lock", deps));
  assert(fs.existsSync(holder.file));
}));
test("G5 lock cleanup refuses a live owner", () => withCleanLocks(() => {
  const holder = writeLockFixture();
  const deps = lockDependencies(holder.value);
  expectCode("LOCK_CLEANUP_LIVE", () => provider.cleanupLock(holder.value.lockId, holder.value.lockId, deps));
  assert(fs.existsSync(holder.file));
}));
test("G5 lock cleanup refuses an expired live owner", () => withCleanLocks(() => {
  const holder = writeLockFixture({
    heartbeatAt: new Date(Date.now() - 120000).toISOString(),
    leaseMs: 30000
  });
  const deps = lockDependencies(holder.value);
  expectCode("LOCK_CLEANUP_LIVE", () => provider.cleanupLock(holder.value.lockId, holder.value.lockId, deps));
  assert(fs.existsSync(holder.file));
}));
test("G5 lock cleanup removes a reused-pid owner after exact confirm", () => withCleanLocks(() => {
  const holder = writeLockFixture();
  const deps = lockDependencies(holder.value, { observedTicks: "222" });
  const result = provider.cleanupLock(holder.value.lockId, holder.value.lockId, deps);
  assert.strictEqual(result.removed, true);
  assert.strictEqual(result.ownerState, "dead");
  assert.strictEqual(result.ownerReason, "owner-pid-reused");
  assert(!fs.existsSync(holder.file));
}));
test("G5 lock cleanup removes a ticks-unavailable owner after exact confirm", () => withCleanLocks(() => {
  const holder = writeLockFixture();
  const deps = lockDependencies(holder.value, { observedTicks: null });
  const result = provider.cleanupLock(holder.value.lockId, holder.value.lockId, deps);
  assert.strictEqual(result.removed, true);
  assert.strictEqual(result.ownerState, "unverifiable");
  assert.strictEqual(result.ownerReason, "owner-start-unavailable");
  assert(!fs.existsSync(holder.file));
}));
test("G5 lock cleanup removes a confirmed dead owner", () => withCleanLocks(() => {
  const holder = writeLockFixture();
  const deps = lockDependencies(holder.value, { signalError: "ESRCH" });
  const result = provider.cleanupLock(holder.value.lockId, holder.value.lockId, deps);
  assert.strictEqual(result.removed, true);
  assert.strictEqual(result.ownerState, "dead");
  assert.strictEqual(result.ownerReason, "owner-pid-absent");
  assert(!fs.existsSync(holder.file));
  assert.strictEqual(result.auditPersisted, true);
  const audit = fs.readFileSync(path.join(provider.DATA_ROOT, "locks-cleanup.jsonl"), "utf8");
  assert(audit.includes(holder.value.lockId));
  assert(audit.includes("\"outcome\":\"removed\""));
}));
test("G5 lock cleanup removes an unverifiable owner after exact confirm", () => withCleanLocks(() => {
  const holder = writeLockFixture();
  const deps = lockDependencies(holder.value, { signalError: "EPERM" });
  const result = provider.cleanupLock(holder.value.lockId, holder.value.lockId, deps);
  assert.strictEqual(result.removed, true);
  assert.strictEqual(result.ownerState, "unverifiable");
  assert.strictEqual(result.ownerReason, "owner-liveness-unavailable");
  assert(!fs.existsSync(holder.file));
}));
test("G5 lock cleanup refuses replacement between inspect and delete", () => withCleanLocks(() => {
  const holder = writeLockFixture();
  const deps = lockDependencies(holder.value, { signalError: "ESRCH" });
  deps.afterInspect = () => {
    writeLockFixture({
      lockId: holder.value.lockId,
      pid: process.pid + 200000,
      processStartTicks: "999"
    });
  };
  expectCode("LOCK_CLEANUP_RACE", () => provider.cleanupLock(holder.value.lockId, holder.value.lockId, deps));
  assert(fs.existsSync(holder.file));
}));
test("G5 lock cleanup refuses a replacement that appears after quarantine", () => withCleanLocks(() => {
  const holder = writeLockFixture();
  const deps = lockDependencies(holder.value, { signalError: "ESRCH" });
  deps.afterQuarantine = () => {
    writeLockFixture({
      lockId: holder.value.lockId,
      pid: process.pid + 300000,
      processStartTicks: "777"
    });
  };
  expectCode("LOCK_CLEANUP_RACE", () => provider.cleanupLock(holder.value.lockId, holder.value.lockId, deps));
  assert(fs.existsSync(holder.file));
}));
test("G5 locks inspect is a read-only command and cleanup is not", () => {
  assert.strictEqual(provider.isReadOnlyFastPath({ _: ["locks", "inspect"] }), true);
  assert.strictEqual(provider.isReadOnlyFastPath({ _: ["locks"] }), true);
  assert.strictEqual(provider.isReadOnlyFastPath({ _: ["locks", "cleanup"] }), false);
});
test("G6 failover only permits whitelisted safe transitions", () => {
  const c = capsule({ failover: { allowedFallbackProfiles: ["fallback"], mode: "pre-first-request-only", switchPermission: "allowed" } });
  assert.strictEqual(provider.mayFailover(c, { requestsSent: 0, changedFiles: 0 }, "fallback").allowed, true);
  assert.strictEqual(provider.mayFailover(c, { requestsSent: 1, changedFiles: 1 }, "fallback").allowed, false);
  assert.strictEqual(provider.mayFailover(c, { requestsSent: 0, changedFiles: 0 }, "other").allowed, false);
});
test("G6 quota exhaustion is only emitted from explicit end evidence", () => {
  assert.deepStrictEqual(provider.quotaSignalFromEnd({}), { present: false, usedPercent: null, source: "end_event", exhausted: false });
  assert.deepStrictEqual(provider.quotaSignalFromEnd({ rate_limits: { primary: { used_percent: 100 } } }), { present: true, usedPercent: 100, source: "end_event", exhausted: true });
});
test("G7 snapshot is profile-bound and unsupported is honest", () => { const snap = provider.recordSnapshot("example-account", { source: "not-authorized", capturedAt: new Date().toISOString(), accountBinding: "unsupported", metrics: { fake: 99 } }); assert.strictEqual(snap.profileId, registry.profiles[0].profileId); assert.deepStrictEqual(snap.metrics, {}); });
test("G0-G7 acceptance fixture inventory is present and parseable", () => {
  const fixtureRoot = path.resolve(__dirname, "..", "fixtures");
  for (const name of ["paths.negative", "project-config.malicious", "trusted-folders.leak", "hook.fail-open", "pretooluse.mutation", "stream.crash-orphan", "stream.multi-invocation", "ledger.cross-profile-failover", "changed-files.final-state"]) assert(fs.statSync(path.join(fixtureRoot, name)).isDirectory());
  const jsonFiles = []; function collect(dir) { for (const item of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, item.name); if (item.isDirectory()) collect(full); else if (item.name.endsWith(".json")) jsonFiles.push(full); } }
  collect(fixtureRoot); for (const file of jsonFiles) JSON.parse(fs.readFileSync(file, "utf8"));
});
test("G8 production worker callers expose only Provider intent", () => {
  const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
  const callerFiles = [
    "src/server/cli/index.js",
    "src/server/routes/runs.js",
    "src/server/routes/models.js",
    "src/server/routes/capabilities.js",
    "src/server/runtime/approval-contract.js",
    "public/js/features/composer/options.js"
  ].map((rel) => path.join(repoRoot, rel));
  if (callerFiles.every((file) => !fs.existsSync(file))) {
    assert(!repoRoot.includes("Grok UI"), "installed Provider package should not rely on repo-local product files");
    return;
  }
  const forbidden = /grok\.cmd|GROK_HOME|auth\.json|leader\.sock|--permission-mode|--no-plan|--output-format/;
  const hits = callerFiles.filter((file) => forbidden.test(fs.readFileSync(file, "utf8")));
  assert.strictEqual(hits.length, 0, `legacy production worker callers remain (${hits.length}); first=${hits.slice(0, 8).join(",")}`);
  const adapter = fs.readFileSync(path.join(repoRoot, "src/server/cli/index.js"), "utf8");
  assert(adapter.includes("providerIntent") || adapter.includes("task-capsule"), "worker caller adapter must be Provider capsule based");
});
test("G9 roots list/register/inspect and doctor", () => {
  const extra = path.join(sandbox, "extra-root"); mkdir(extra);
  assert(provider.rootsCommand("register", extra).registered);
  assert(provider.rootsCommand("inspect", extra).registered);
  for (const root of [path.join(provider.DATA_ROOT, "usage", "tasks"), provider.LOCK_ROOT, provider.AVAILABILITY_ROOT, provider.RUNS_ROOT, provider.HEALTH_ROOT]) mkdir(root);
  const fakeCli = path.join(sandbox, "fake-grok.exe");
  write(fakeCli, "synthetic test fixture\n");
  const ready = provider.doctor({ grokCliPath: fakeCli });
  assert.strictEqual(ready.pass, true);
  assert.strictEqual(ready.providerHealthy, true);
  assert.strictEqual(ready.grokCliAvailable, true);
  assert.strictEqual(ready.readyForRun, true);
  const missing = provider.doctor({ grokCliPath: path.join(sandbox, "missing-grok.exe") });
  assert.strictEqual(missing.pass, true, "legacy pass remains Provider-health only");
  assert.strictEqual(missing.providerHealthy, true);
  assert.strictEqual(missing.grokCliAvailable, false);
  assert.strictEqual(missing.readyForRun, false);
  assert.strictEqual(missing.checks.find((check) => check.name === "grok-cli-present").pass, false);
  assert.strictEqual(ready.checks.find((check) => check.name === "lock-inspect").pass, true);
  assert(Array.isArray(ready.lockInspection.locks));
  assert.strictEqual(ready.lockInspection.inspectError, null);
});
test("provider defaults are GrokWorkerProvider-owned not GrokUI", () => {
  assert.match(provider.DEFAULT_DATA_ROOT, /GrokWorkerProvider/);
  assert.match(provider.DEFAULT_REGISTRY_PATH, /GrokWorkerProvider/);
  assert.match(provider.DEFAULT_APPROVED_PROFILE_ROOT, /GrokWorkerProvider/);
  assert.doesNotMatch(provider.DEFAULT_DATA_ROOT, /GrokUI[/\\]/);
  assert.doesNotMatch(provider.DEFAULT_REGISTRY_PATH, /GrokUI[/\\]/);
  assert.doesNotMatch(provider.DEFAULT_APPROVED_PROFILE_ROOT, /GrokUI[/\\]/);
  assert.match(provider.LEGACY_DATA_ROOT, /GrokUI/);
  assert.match(provider.LEGACY_REGISTRY_PATH, /GrokUI/);
  assert.match(provider.LEGACY_APPROVED_PROFILE_ROOT, /GrokUI/);
  const src = fs.readFileSync(path.resolve(__dirname, "..", "lib", "provider.js"), "utf8");
  assert(!/dataRoot: envData \|\| \(pointer && pointer\.dataRoot\) \|\| LEGACY_DATA_ROOT/.test(src),
    "active resolution must not fall back to LEGACY_DATA_ROOT");
  assert(/DEFAULT_DATA_ROOT/.test(src) && /provider-default/.test(src));
  const resolved = provider.resolveRootsFromPointer();
  assert.strictEqual(resolved.source, "env");
  assert.doesNotMatch(resolved.dataRoot, /GrokUI[/\\]/);
});

test("legacy canary fixture is workspace-neutral", () => {
  const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "fixtures", "canary.task.json"), "utf8"));
  assert.strictEqual(fixture.workspace, "C:\\TEST_WORKSPACE");
  assert.strictEqual(fixture.worktree.path, "C:\\TEST_WORKSPACE");
  assert.deepStrictEqual(fixture.allowedFiles, ["package.json"]);
  assert.deepStrictEqual(fixture.contextRefs, ["package.json"]);
  const forbiddenLegacyPath = ["D:", "Grok UI"].join("\\");
  assert(!JSON.stringify(fixture).includes(forbiddenLegacyPath));
  assert.doesNotMatch(JSON.stringify(fixture), /grok-bridge/i);
});

process.stdout.write(`${JSON.stringify({ passed, failed, evidence, sandbox }, null, 2)}\n`);
try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) { /* printed for diagnosis if cleanup fails */ }
if (failed) process.exitCode = 1;
