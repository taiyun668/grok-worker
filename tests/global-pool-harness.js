"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const assert = require("assert");
const childProcess = require("child_process");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "grok-worker-pool-test-"));
process.env.GROK_WORKER_DATA_ROOT = path.join(sandbox, "data");
process.env.GROK_WORKER_PROFILES = path.join(sandbox, "profiles.json");
process.env.GROK_WORKER_APPROVED_PROFILE_ROOT = path.join(sandbox, "profiles");
const provider = require("../lib/provider");

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
    evidence.push({ name, status: "FAIL", error: error.safeMessage || error.message });
  }
}
function mkdir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function write(file, body) { mkdir(path.dirname(file)); fs.writeFileSync(file, body, "utf8"); }
function git(cwd, args) {
  const result = childProcess.spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.strictEqual(result.status, 0, result.stderr);
  return String(result.stdout || "").trim();
}
function runCli(cwd, args) {
  const bin = path.resolve(__dirname, "..", "bin", "grok-worker.js");
  const result = childProcess.spawnSync(process.execPath, [bin, ...args], {
    cwd,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

const repo = path.join(sandbox, "external-project");
mkdir(repo);
git(repo, ["init", "--quiet"]);
git(repo, ["config", "user.email", "pool-test@example.invalid"]);
git(repo, ["config", "user.name", "Pool Test"]);
write(path.join(repo, "README.md"), "# external project\n");
git(repo, ["add", "."]);
git(repo, ["commit", "-m", "baseline", "--quiet"]);

const profileRoot = path.join(sandbox, "profiles");
const profileHome = path.join(profileRoot, "example-account");
mkdir(profileHome);
provider.saveRegistry({
  schemaVersion: 3,
  approvedProfileRoot: profileRoot,
  allowedWorkspaceRoots: [repo],
  profiles: [{
    profileId: "550e8400-e29b-41d4-a716-446655440000",
    alias: "example-account",
    grokHome: profileHome,
    executable: path.join(os.homedir(), ".grok", "bin", "grok.exe"),
    accountLabel: "test-supergrok",
    authReadiness: { oauthReady: true, verifiedAt: new Date().toISOString() },
    identity: { identityStatus: "unknown", source: "cli_probe", value: null, capturedAt: new Date().toISOString(), providerVersion: provider.VERSION },
    sandboxCapability: { flagSupported: true, enforcementSupported: false, platform: "windows", evidence: "Linux/macOS only" },
    modelSnapshot: { models: ["grok-4.6"], reasoning: ["high"], checkedAt: new Date().toISOString(), source: "test" }
  }]
});

test("G10 default registry has no repo-local allowed root", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "..", "lib", "provider.js"), "utf8");
  assert(!/allowedWorkspaceRoots:\s*\[\s*['"]D:\\\\Grok UI['"]\s*\]/.test(source));
});

test("G10 profiles list is secret-free and profileId-addressable", () => {
  const out = runCli(os.homedir(), ["profiles", "list"]);
  const profile = out.profiles.find((item) => item.profileId === "550e8400-e29b-41d4-a716-446655440000");
  assert(profile);
  assert.strictEqual(profile.alias, "example-account");
  assert(!JSON.stringify(out).includes("auth.json"));
});

test("G10 task init works from outside the target project", () => {
  const taskFile = path.join(sandbox, "external-task.json");
  const out = runCli(os.homedir(), [
    "task", "init",
    "--profile", "example-account",
    "--workspace", repo,
    "--stage", "G10",
    "--objective", "Inspect the external project and return a Result Capsule.",
    "--out", taskFile,
    "--real", "denied"
  ]);
  assert.strictEqual(out.taskFile, taskFile);
  const capsule = JSON.parse(fs.readFileSync(taskFile, "utf8"));
  assert.strictEqual(capsule.workspace, repo);
  assert.strictEqual(capsule.realRequestPermission, "denied");
  provider.validateTaskCapsule(capsule, provider.loadRegistry());
});

test("G10 plan is zero-spawn for external capsule", () => {
  const taskFile = path.join(sandbox, "external-task.json");
  const out = runCli(path.dirname(repo), ["plan", "--profile", "example-account", "--task", taskFile]);
  assert.strictEqual(out.spawnCount, 0);
  assert.strictEqual(out.capsule.profile, "example-account");
  assert(out.planTemplate.args.includes("--no-plan"));
  assert(out.planTemplate.args.includes("--no-memory"));
});

test("G10 pool status aggregates usage by immutable profileId", () => {
  provider.recordInvocation("pool-ledger", {
    invocationId: crypto.randomUUID(),
    profileId: "550e8400-e29b-41d4-a716-446655440000",
    profileAlias: "example-account",
    sessionId: "s",
    requestId: "r",
    variant: "main",
    accountIdentitySnapshot: provider.loadRegistry().profiles[0].identity,
    runUsage: { present: true, input_tokens: 4, cache_read_input_tokens: 1, output_tokens: 2, reasoning_tokens: 3, total_tokens: 10, modelUsage: {} },
    quotaSignal: { present: false, usedPercent: null, source: "end_event" }
  });
  const status = runCli(os.homedir(), ["pool", "status"]);
  const profile = status.profiles.find((item) => item.profileId === "550e8400-e29b-41d4-a716-446655440000");
  assert(profile);
  assert.strictEqual(profile.usage.total_tokens, 10);
  assert(status.doctor.pass);
});

test("G10 roots remain explicit and inspectable", () => {
  const list = runCli(os.homedir(), ["roots", "list"]);
  assert(list.allowedWorkspaceRoots.includes(repo));
  const inspected = runCli(os.homedir(), ["roots", "inspect", "--path", repo]);
  assert.strictEqual(inspected.registered, true);
});

test("G10 provider durable defaults independent of GrokUI", () => {
  assert.match(provider.DEFAULT_DATA_ROOT, /GrokWorkerProvider/);
  assert.match(provider.DEFAULT_REGISTRY_PATH, /GrokWorkerProvider/);
  assert.match(provider.DEFAULT_APPROVED_PROFILE_ROOT, /GrokWorkerProvider/);
  assert.doesNotMatch(provider.DEFAULT_DATA_ROOT, /GrokUI[/\\]/);
  assert.doesNotMatch(provider.DEFAULT_REGISTRY_PATH, /GrokUI[/\\]/);
  assert.doesNotMatch(provider.DEFAULT_APPROVED_PROFILE_ROOT, /GrokUI[/\\]/);
  // Harness env isolates process roots from machine GrokUI trees.
  assert.doesNotMatch(provider.DATA_ROOT, /GrokUI[/\\]/);
  assert.doesNotMatch(provider.REGISTRY_PATH, /GrokUI[/\\]/);
  const residues = provider.legacyResidueMeta();
  assert.match(residues.dataRoot, /GrokUI/);
  assert.match(residues.approvedProfileRoot, /GrokUI/);
});

process.stdout.write(`${JSON.stringify({ passed, failed, evidence, sandbox }, null, 2)}\n`);
try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) { /* keep sandbox for failure diagnostics */ }
if (failed) process.exitCode = 1;
