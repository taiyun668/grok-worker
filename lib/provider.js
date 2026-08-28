"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const childProcess = require("child_process");

const availability = require("./availability");
const doctorChecks = require("./doctor");
const locks = require("./locks");

const VERSION = require("../package.json").version;
const DEFAULT_MODEL = "grok-4.6";
const REQUIRED_TASK_FIELDS = [
  "taskId", "stage", "objective", "baseCommit", "workspace", "worktree",
  "allowedFiles", "forbiddenActions", "acceptanceCommands", "contextRefs",
  "realRequestPermission", "serviceControlPermission", "gitPermission",
  "grokSessionId", "resumePolicy", "explicitStop"
];
const OPTIONAL_TASK_FIELDS = [
  "model", "reasoning", "speed", "profile", "policy", "failover",
  "candidateProfileIds", "probePolicy"
];
const SECRET_KEY = /^(token|accessToken|refreshToken|api.?key|secret|authorization|cookie|authHash|authContent|authJson)$/i;
const SECRET_VALUE = /(bearer\s+[a-z0-9._-]+|xai-[a-z0-9_-]+|authorization\s*[:=]|cookie\s*[:=])/ig;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORTY_HEX = /^[0-9a-f]{40}$/;
const PROVIDER_DIR = path.resolve(__dirname, "..");
const LOCAL_APP_DATA = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
/** Provider-owned home — all active durable defaults live under this tree. */
const PROVIDER_HOME = path.join(LOCAL_APP_DATA, "GrokWorkerProvider");
/** Active defaults (env/pointer override). Fully independent of GrokUI. */
const DEFAULT_DATA_ROOT = path.join(PROVIDER_HOME, "worker-provider");
const DEFAULT_REGISTRY_PATH = path.join(PROVIDER_HOME, "worker-profiles", "profiles.json");
const DEFAULT_APPROVED_PROFILE_ROOT = path.join(PROVIDER_HOME, "codex-grok-workers");
/**
 * Inert historical residues under GrokUI. Never active defaults; never read, copy,
 * hash, move, link, or delete. Surfaced only as documentation when a valid pointer
 * is present — credentials/runtime files stay untouched.
 */
const LEGACY_DATA_ROOT = path.join(LOCAL_APP_DATA, "GrokUI", "worker-provider");
const LEGACY_REGISTRY_PATH = path.join(LOCAL_APP_DATA, "GrokUI", "worker-profiles", "profiles.json");
const LEGACY_APPROVED_PROFILE_ROOT = path.join(LOCAL_APP_DATA, "GrokUI", "codex-grok-workers");
const DEFAULT_GROK_HOME = path.resolve(os.homedir(), ".grok");
const EXECUTABLE = path.join(os.homedir(), ".grok", "bin", "grok.exe");
const CURRENT_POINTER_PATH = process.env.GROK_WORKER_CURRENT_JSON
  || path.join(PROVIDER_HOME, "current.json");

/** Pure metadata: GrokUI locations as historical residues (no filesystem access). */
function legacyResidueMeta() {
  return {
    dataRoot: LEGACY_DATA_ROOT,
    registryPath: LEGACY_REGISTRY_PATH,
    approvedProfileRoot: LEGACY_APPROVED_PROFILE_ROOT,
    note: "Inert historical GrokUI locations; never active defaults; no auth/runtime migration"
  };
}

/**
 * Resolve dataRoot / registryPath / approvedProfileRoot:
 * env wins → validated current.json → Provider-specific defaults under GrokWorkerProvider.
 * Never migrates credentials; never opens legacy GrokUI runtime files.
 */
function resolveRootsFromPointer() {
  const envData = process.env.GROK_WORKER_DATA_ROOT || null;
  const envReg = process.env.GROK_WORKER_PROFILES || null;
  const envApproved = process.env.GROK_WORKER_APPROVED_PROFILE_ROOT || null;
  let pointer = null;
  let pointerError = null;
  if (fs.existsSync(CURRENT_POINTER_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CURRENT_POINTER_PATH, "utf8"));
      const check = availability.validateCurrentPointer(raw);
      if (!check.ok) {
        pointerError = check.reason;
      } else {
        pointer = raw;
      }
    } catch (error) {
      pointerError = error && error.reason ? error.reason : "read-failed";
    }
  }
  const pointerSuppliedRoots = pointer
    && envData === pointer.dataRoot
    && envReg === pointer.registryPath
    && envApproved === pointer.approvedProfileRoot;
  const source = pointerSuppliedRoots
    ? "current.json"
    : ((envData || envReg || envApproved) ? "env" : (pointer ? "current.json" : "provider-default"));
  return {
    dataRoot: envData || (pointer && pointer.dataRoot) || DEFAULT_DATA_ROOT,
    registryPath: envReg || (pointer && pointer.registryPath) || DEFAULT_REGISTRY_PATH,
    approvedProfileRoot: envApproved
      || (pointer && pointer.approvedProfileRoot)
      || DEFAULT_APPROVED_PROFILE_ROOT,
    pointer,
    pointerError,
    source,
    pointerPath: CURRENT_POINTER_PATH,
    // Residues only when a valid pointer is present (inert; never used for I/O).
    legacyResidues: pointer ? legacyResidueMeta() : null
  };
}

const _roots = resolveRootsFromPointer();
let DATA_ROOT = _roots.dataRoot;
let REGISTRY_PATH = _roots.registryPath;
let APPROVED_PROFILE_ROOT = _roots.approvedProfileRoot;
let LEDGER_ROOT = path.join(DATA_ROOT, "usage", "tasks");
let SNAPSHOT_ROOT = path.join(DATA_ROOT, "usage", "profiles");
let RESULT_ROOT = path.join(DATA_ROOT, "results");
let LOCK_ROOT = path.join(DATA_ROOT, "locks");
let TEMP_ROOT = path.join(DATA_ROOT, "temp");
let ROOTS_PATH = path.join(DATA_ROOT, "roots.json");
let AVAILABILITY_ROOT = path.join(DATA_ROOT, "availability");
let RUNS_ROOT = path.join(DATA_ROOT, "runs");
let HEALTH_ROOT = path.join(DATA_ROOT, "health");
let MAINTENANCE_ROOT = path.join(DATA_ROOT, "maintenance");
let DEPLOY_POINTERS_ROOT = path.join(DATA_ROOT, "deploy", "pointers");
let DEPLOY_ROOTS_META = _roots;

function recomputeDerivedRoots() {
  LEDGER_ROOT = path.join(DATA_ROOT, "usage", "tasks");
  SNAPSHOT_ROOT = path.join(DATA_ROOT, "usage", "profiles");
  RESULT_ROOT = path.join(DATA_ROOT, "results");
  LOCK_ROOT = path.join(DATA_ROOT, "locks");
  TEMP_ROOT = path.join(DATA_ROOT, "temp");
  ROOTS_PATH = path.join(DATA_ROOT, "roots.json");
  AVAILABILITY_ROOT = path.join(DATA_ROOT, "availability");
  RUNS_ROOT = path.join(DATA_ROOT, "runs");
  HEALTH_ROOT = path.join(DATA_ROOT, "health");
  MAINTENANCE_ROOT = path.join(DATA_ROOT, "maintenance");
  DEPLOY_POINTERS_ROOT = path.join(DATA_ROOT, "deploy", "pointers");
}

/** Apply pointer/env roots at startup (idempotent; env still wins). */
function applyDeployRoots(options = {}) {
  const resolved = resolveRootsFromPointer();
  if (options.force || resolved.source !== "provider-default" || !process.env.GROK_WORKER_DATA_ROOT) {
    DATA_ROOT = resolved.dataRoot;
    REGISTRY_PATH = resolved.registryPath;
    APPROVED_PROFILE_ROOT = resolved.approvedProfileRoot;
    recomputeDerivedRoots();
  }
  DEPLOY_ROOTS_META = resolved;
  return resolved;
}

function availabilityDeps() {
  return {
    readJson,
    atomicWriteJson,
    ensureDir,
    hasSecretKeys,
    checkNoReparse,
    redactText,
    captureRunOwner,
    inspectRunOwner,
    taskRunTransaction
  };
}

function queryProcessStartTicks(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const probe = spawnCapture("powershell.exe", [
    "-NoProfile",
    "-Command",
    `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`
  ], { env: process.env, timeout: 5000 });
  const ticks = String(probe.stdout || "").trim();
  return probe.status === 0 && /^\d+$/.test(ticks) ? ticks : null;
}

function captureRunOwner() {
  if (captureRunOwner.cached) return clone(captureRunOwner.cached);
  const processStartTicks = queryProcessStartTicks(process.pid);
  assert(
    processStartTicks,
    "RUN_OWNER_IDENTITY_UNAVAILABLE",
    "The Provider cannot prove its process-start identity; refusing to create a running WAL.",
    { pid: process.pid }
  );
  captureRunOwner.cached = { pid: process.pid, processStartTicks, capturedAt: now() };
  return clone(captureRunOwner.cached);
}

function inspectRunOwner(owner) {
  if (!isObject(owner) || !Number.isInteger(owner.pid) || owner.pid <= 0
      || typeof owner.processStartTicks !== "string" || !/^\d+$/.test(owner.processStartTicks)) {
    return { state: "unverifiable", reason: "owner-identity-missing" };
  }
  const observedStartTicks = queryProcessStartTicks(owner.pid);
  if (observedStartTicks) {
    if (observedStartTicks !== owner.processStartTicks) {
      return { state: "dead", reason: "owner-pid-reused", observedStartTicks };
    }
    return { state: "live", reason: "owner-identity-live", observedStartTicks };
  }

  try {
    process.kill(owner.pid, 0);
    return { state: "unverifiable", reason: "owner-start-unavailable" };
  } catch (error) {
    if (error && error.code === "ESRCH") return { state: "dead", reason: "owner-pid-absent" };
    return { state: "unverifiable", reason: "owner-liveness-unavailable" };
  }
}

function taskRunTransaction(walPath, taskRun, options = {}) {
  const root = path.join(TEMP_ROOT, "task-run-transactions");
  ensureDir(root);
  const desiredPath = path.join(root, `${process.pid}.${crypto.randomUUID()}.json`);
  atomicWriteJson(desiredPath, taskRun);
  const args = [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", path.join(PROVIDER_DIR, "lib", "task-run-transaction.ps1"),
    "-WalPath", walPath,
    "-DesiredPath", desiredPath,
    "-ExpectedRevision", String(options.expectedRevision)
  ];
  if (options.expectedStatus) args.push("-ExpectedStatus", String(options.expectedStatus));
  if (options.expectedOwner) {
    args.push("-ExpectedOwnerPid", String(options.expectedOwner.pid));
    args.push("-ExpectedOwnerStartTicks", String(options.expectedOwner.processStartTicks));
  }
  let result;
  try {
    result = spawnCapture("powershell.exe", args, { env: process.env, timeout: 30000 });
  } finally {
    fs.rmSync(desiredPath, { force: true });
  }
  let payload = null;
  try { payload = JSON.parse(String(result.stdout || "").trim()); } catch (_) { /* handled below */ }
  if (result.status !== 0 || !payload || payload.ok !== true || !isObject(payload.record)) {
    const error = new Error(payload && payload.message || "Task-run transaction failed.");
    error.code = payload && payload.code || "TASK_RUN_TRANSACTION_FAILED";
    throw error;
  }
  return payload.record;
}

class ProviderError extends Error {
  constructor(code, safeMessage, details = {}, exitCode = 1) {
    super(safeMessage);
    this.name = "ProviderError";
    this.code = code;
    this.safeMessage = `${code}: ${safeMessage}`;
    this.details = details;
    this.exitCode = exitCode;
  }
}

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function now() { return new Date().toISOString(); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function normalizeCase(value) {
  const resolved = path.resolve(value);
  let end = resolved.length;
  while (end > 0 && (resolved[end - 1] === "\\" || resolved[end - 1] === "/")) end -= 1;
  return resolved.slice(0, end).toLowerCase();
}
function within(child, parent) {
  const c = normalizeCase(child); const p = normalizeCase(parent);
  return c === p || c.startsWith(`${p}${path.sep}`.toLowerCase());
}
function assert(condition, code, message, details) {
  if (!condition) throw new ProviderError(code, message, details);
}
function hasSecretKeys(value, trail = []) {
  if (Array.isArray(value)) return value.some((v, i) => hasSecretKeys(v, trail.concat(String(i))));
  if (!isObject(value)) return false;
  return Object.entries(value).some(([key, item]) => {
    if (SECRET_KEY.test(key)) {
      // Pool-config standing authorization is a non-secret policy object
      // (realRequestPermission / authorizedProfileIds). Credential strings and
      // nested secret-shaped keys remain forbidden — no-secret invariant held.
      if (/^authorization$/i.test(key) && isObject(item) && !Array.isArray(item)) {
        return hasSecretKeys(item, trail.concat(key));
      }
      return true;
    }
    return hasSecretKeys(item, trail.concat(key));
  });
}
function redactText(value) {
  return String(value || "").replace(SECRET_VALUE, "[REDACTED]").replace(/[A-Za-z0-9+/]{48,}={0,2}/g, "[REDACTED_BLOB]");
}
function readJson(file) {
  assert(!/auth\.json$/i.test(path.basename(file)), "INV1_AUTH_READ_FORBIDDEN", "Provider refuses to read auth.json.");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function fsyncDir(dir) {
  try { const fd = fs.openSync(dir, "r"); fs.fsyncSync(fd); fs.closeSync(fd); } catch (_) { /* Windows may reject directory fsync. */ }
}
function atomicWriteJson(file, value) {
  ensureDir(path.dirname(file));
  assert(!hasSecretKeys(value), "INV1_SECRET_FIELD", "Registry and ledger objects may not contain credential-shaped keys.", { file });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file); fsyncDir(path.dirname(file));
}
function appendJsonLineAtomic(file, value) {
  assert(!hasSecretKeys(value), "INV1_SECRET_FIELD", "Persistent records may not contain credential-shaped keys.", { file });
  ensureDir(path.dirname(file));
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${existing}${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.renameSync(temp, file);
}

function checkNoReparse(target, stopAt) {
  let current = path.resolve(target);
  const stop = path.resolve(stopAt || path.parse(current).root);
  while (within(current, stop)) {
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      assert(!stat.isSymbolicLink(), "PATH_REPARSE", "Symlink or junction paths are forbidden.", { path: current });
    }
    if (normalizeCase(current) === normalizeCase(stop)) break;
    const next = path.dirname(current); if (next === current) break; current = next;
  }
}
function validateWindowsPath(raw, allowedRoot, field) {
  assert(typeof raw === "string" && raw.length > 0, "PATH_REQUIRED", `${field} must be a non-empty path.`);
  assert(!/^(\\\\|\\\\\?\\|\\\\\.\\)/.test(raw), "PATH_NAMESPACE", `${field} may not use UNC or device namespaces.`, { field });
  assert(!raw.split(/[\\/]/).includes(".."), "PATH_TRAVERSAL", `${field} may not contain '..'.`, { field });
  const resolved = path.resolve(raw);
  const defaultHome = normalizeCase(DEFAULT_GROK_HOME);
  const candidate = normalizeCase(resolved);
  assert(!(candidate === defaultHome || candidate.startsWith(`${defaultHome}${path.sep}`) || defaultHome.startsWith(`${candidate}${path.sep}`)), "PATH_DEFAULT_GROK_HOME", `${field} may not be the default .grok path or a dangerous parent/child.`);
  if (allowedRoot) assert(within(resolved, allowedRoot), "PATH_OUTSIDE_ROOT", `${field} is outside its approved root.`, { resolved, allowedRoot });
  checkNoReparse(resolved, allowedRoot || path.parse(resolved).root);
  return resolved;
}
function expandPattern(pattern, root) {
  const raw = path.isAbsolute(pattern) ? pattern : path.join(root, pattern);
  const globIndex = raw.indexOf("**");
  if (globIndex === -1) return path.resolve(raw);
  let end = globIndex;
  while (end > 0 && (raw[end - 1] === "\\" || raw[end - 1] === "/")) end -= 1;
  return path.resolve(raw.slice(0, end));
}
function patternsOverlap(a, b, root) {
  const pa = normalizeCase(expandPattern(a, root)); const pb = normalizeCase(expandPattern(b, root));
  return pa === pb || pa.startsWith(`${pb}${path.sep}`) || pb.startsWith(`${pa}${path.sep}`);
}

function validateTaskCapsule(input, registry) {
  assert(isObject(input), "CAPSULE_TYPE", "Task Capsule must be an object.");
  for (const field of REQUIRED_TASK_FIELDS) assert(Object.prototype.hasOwnProperty.call(input, field), "CAPSULE_REQUIRED", `Task Capsule is missing required field '${field}'.`);
  const allowedKeys = new Set(REQUIRED_TASK_FIELDS.concat(OPTIONAL_TASK_FIELDS));
  for (const key of Object.keys(input)) assert(allowedKeys.has(key), "CAPSULE_ADDITIONAL", `Task Capsule contains unsupported field '${key}'.`);
  assert(!hasSecretKeys(input), "INV1_SECRET_FIELD", "Task Capsule contains credential-shaped fields.");
  for (const field of ["taskId", "stage", "objective", "workspace", "explicitStop"]) assert(typeof input[field] === "string" && input[field].trim(), "CAPSULE_STRING", `${field} must be non-empty.`);
  assert(FORTY_HEX.test(input.baseCommit), "CAPSULE_BASE", "baseCommit must be forty lowercase hex characters.");
  for (const field of ["allowedFiles", "forbiddenActions", "acceptanceCommands", "contextRefs"]) assert(Array.isArray(input[field]) && input[field].length > 0 && input[field].every((x) => typeof x === "string" && x.trim()), "CAPSULE_ARRAY", `${field} must be a non-empty string array.`);
  assert(["allowed", "denied"].includes(input.realRequestPermission), "CAPSULE_REAL_PERMISSION", "realRequestPermission must be allowed or denied.");
  assert(["allowed", "denied"].includes(input.serviceControlPermission), "CAPSULE_SERVICE_PERMISSION", "serviceControlPermission must be allowed or denied.");
  assert(["read-only", "worktree-files-only", "worktree-local-commit", "worktree-local-commit-and-push"].includes(input.gitPermission), "CAPSULE_GIT_PERMISSION", "gitPermission is invalid.");
  assert(isObject(input.worktree) && ["exclusive-worktree", "exclusive-files", "read-only-shared-checkout", "shared-checkout-mutually-exclusive-files"].includes(input.worktree.mode), "CAPSULE_WORKTREE", "worktree is invalid.");
  assert(isObject(input.resumePolicy) && typeof input.resumePolicy.mode === "string" && typeof input.resumePolicy.rule === "string", "CAPSULE_RESUME", "resumePolicy is invalid.");
  assert(input.grokSessionId === null || (typeof input.grokSessionId === "string" && input.grokSessionId.trim()), "CAPSULE_SESSION", "grokSessionId must be null or non-empty.");
  assert(isObject(input.policy), "CAPSULE_POLICY", "Provider policy is required.");
  assert(["readonly", "workspace-write"].includes(input.policy.access), "CAPSULE_ACCESS", "policy.access is invalid.");
  assert(["denied", "controller-only"].includes(input.policy.bash), "CAPSULE_BASH", "policy.bash must be denied or controller-only.");
  for (const field of ["agents", "mcp", "web"]) assert(input.policy[field] === "denied", "CAPSULE_POLICY_DENIED", `policy.${field} only accepts denied in Provider v1.`);
  if (input.policy.access === "workspace-write") assert(input.worktree.mode === "exclusive-worktree", "INV7_EXCLUSIVE_WORKTREE", "workspace-write requires exclusive-worktree.");

  const hasPool = Array.isArray(input.candidateProfileIds) && input.candidateProfileIds.length > 0;
  const hasExplicit = typeof input.profile === "string" && input.profile.trim().length > 0;
  assert(hasPool || hasExplicit, "CAPSULE_SELECTION", "Task Capsule requires either profile (explicit) or candidateProfileIds (pool).");
  assert(!(hasPool && hasExplicit), "CAPSULE_SELECTION_MIXED", "Task Capsule may not mix profile alias with candidateProfileIds pool mode.");

  if (hasPool) {
    assert(input.candidateProfileIds.every((id) => typeof id === "string" && UUID.test(id)), "CAPSULE_CANDIDATE_IDS", "candidateProfileIds must be immutable profileId UUIDs.");
    for (const id of input.candidateProfileIds) {
      assert(registry.profiles.some((item) => item.profileId === id), "PROFILE_NOT_FOUND", `Pool candidate profileId '${id}' is not registered.`);
    }
  } else {
    const profileAlias = input.profile;
    const profile = registry.profiles.find((item) => item.alias === profileAlias);
    assert(profile, "PROFILE_NOT_FOUND", `Profile '${profileAlias}' is not registered.`);
  }

  if (input.probePolicy !== undefined) {
    assert(isObject(input.probePolicy), "CAPSULE_PROBE_POLICY", "probePolicy must be an object.");
    assert(["disabled", "when-no-active", "after-workload"].includes(input.probePolicy.mode || "disabled"), "CAPSULE_PROBE_MODE", "probePolicy.mode is invalid.");
    assert(["allowed", "denied", undefined].includes(input.probePolicy.realRequestPermission), "CAPSULE_PROBE_PERMISSION", "probePolicy.realRequestPermission is invalid.");
  }

  const roots = registry.allowedWorkspaceRoots || [];
  const workspace = validateWindowsPath(input.workspace, null, "workspace");
  assert(roots.some((root) => within(workspace, root)), "WORKSPACE_NOT_REGISTERED", "workspace is outside registered roots.", { workspace });
  const worktree = validateWindowsPath(input.worktree.path, null, "worktree.path");
  assert(roots.some((root) => within(worktree, root)), "WORKTREE_NOT_REGISTERED", "worktree is outside registered roots.", { worktree });
  for (const item of input.allowedFiles) validateWindowsPath(expandPattern(item, worktree), worktree, "allowedFiles");
  for (const item of input.contextRefs) validateWindowsPath(expandPattern(item, workspace), workspace, "contextRefs");
  if (input.failover) {
    assert(isObject(input.failover), "CAPSULE_FAILOVER", "failover is invalid.");
    const hasLegacy = Array.isArray(input.failover.allowedFallbackProfiles);
    const hasIds = Array.isArray(input.failover.allowedFallbackProfileIds);
    assert(hasLegacy || hasIds, "CAPSULE_FAILOVER", "failover requires allowedFallbackProfiles or allowedFallbackProfileIds.");
    assert(!(hasLegacy && hasIds), "CAPSULE_FAILOVER_MIXED", "failover must not mix alias allowedFallbackProfiles with allowedFallbackProfileIds.");
    if (hasIds) {
      assert(input.failover.allowedFallbackProfileIds.every((id) => typeof id === "string" && UUID.test(id)), "CAPSULE_FAILOVER_IDS", "allowedFallbackProfileIds must be profileId UUIDs.");
    }
    assert(["pre-first-request-only", "controller-continuation"].includes(input.failover.mode), "CAPSULE_FAILOVER_MODE", "failover.mode is invalid.");
    assert(["allowed", "denied"].includes(input.failover.switchPermission), "CAPSULE_FAILOVER_PERMISSION", "failover.switchPermission is invalid.");
  }
  const out = clone(input);
  if (!out.probePolicy) out.probePolicy = availability.defaultProbePolicy();
  else out.probePolicy = availability.normalizeProbePolicy(out.probePolicy);
  return out;
}

function defaultRegistry() {
  return { schemaVersion: 3, approvedProfileRoot: APPROVED_PROFILE_ROOT, allowedWorkspaceRoots: [], profiles: [] };
}
function loadRegistry() {
  const registry = fs.existsSync(REGISTRY_PATH) ? readJson(REGISTRY_PATH) : defaultRegistry();
  assert(registry.schemaVersion === 3 && Array.isArray(registry.profiles), "REGISTRY_SCHEMA", "profiles.json must use schemaVersion 3.");
  validateWindowsPath(registry.approvedProfileRoot, path.dirname(registry.approvedProfileRoot), "approvedProfileRoot");
  for (const profile of registry.profiles) validateProfile(profile, registry);
  return registry;
}
function validateProfile(profile, registry) {
  assert(isObject(profile) && UUID.test(profile.profileId), "PROFILE_ID", "Every profile requires an immutable UUID profileId.");
  assert(typeof profile.alias === "string" && profile.alias, "PROFILE_ALIAS", "Every profile requires an alias.");
  assert(!hasSecretKeys(profile), "INV1_PROFILE_SECRET", "Profile metadata may not contain credentials or auth hashes.");
  validateWindowsPath(profile.grokHome, registry.approvedProfileRoot, "grokHome");
  assert(normalizeCase(profile.grokHome) !== normalizeCase(DEFAULT_GROK_HOME), "INV2_DEFAULT_HOME", "Default user .grok is forbidden.");
  assert(typeof profile.executable === "string" && normalizeCase(profile.executable) === normalizeCase(EXECUTABLE), "PROFILE_EXECUTABLE", "Profile executable must be the Provider-verified Grok CLI.");
  assert(isObject(profile.authReadiness) && typeof profile.authReadiness.oauthReady === "boolean", "PROFILE_AUTH_READINESS", "authReadiness.oauthReady is required.");
  assert(isObject(profile.identity) && ["verified", "unknown", "unverified"].includes(profile.identity.identityStatus), "PROFILE_IDENTITY", "identity status is invalid.");
  assert(isObject(profile.sandboxCapability) && profile.sandboxCapability.platform === "windows" && profile.sandboxCapability.enforcementSupported === false, "PROFILE_SANDBOX", "Windows profiles must truthfully report no OS sandbox enforcement.");
  return profile;
}
function saveRegistry(registry) { for (const profile of registry.profiles) validateProfile(profile, registry); atomicWriteJson(REGISTRY_PATH, registry); }

function spawnCapture(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, { cwd: options.cwd, env: options.env, encoding: "utf8", windowsHide: true, timeout: options.timeout || 30000, maxBuffer: 16 * 1024 * 1024 });
  // Keep only the OS error code, never the raw error text: result capsules may be
  // retained for auditing and must not become an accidental prompt/credential log.
  const code = result.error && typeof result.error.code === "string" && /^[A-Z0-9_]{2,32}$/.test(result.error.code)
    ? result.error.code
    : null;
  return { status: result.status, signal: result.signal, stdout: String(result.stdout || ""), stderr: String(result.stderr || ""), error: result.error ? String(result.error.message || result.error) : null, errorCode: code };
}
function isolatedEnv(profile, invocationHome, socketPath) {
  const env = { ...process.env };
  delete env.XAI_API_KEY; delete env.GROK_FOLDER_TRUST; delete env.GROK_SANDBOX;
  env.GROK_HOME = profile.grokHome;
  env.HOME = invocationHome;
  env.USERPROFILE = invocationHome;
  env.LOCALAPPDATA = path.join(invocationHome, "AppData", "Local");
  env.GROK_LEADER_SOCKET = socketPath;
  // These compatibility integrations can otherwise inject external authority
  // before the Provider's own dontAsk/deny policy is evaluated.  Keep the
  // override process-local to this isolated worker invocation.
  env.GROK_CLAUDE_HOOKS_ENABLED = "false";
  env.GROK_CURSOR_HOOKS_ENABLED = "false";
  return env;
}
function ensureProviderHook(profile) {
  const hookDir = path.join(profile.grokHome, "hooks"); ensureDir(hookDir);
  const hookConfig = path.join(hookDir, "grok-worker-provider.json");
  const command = `node "${path.join(PROVIDER_DIR, "lib", "hook-boundary.js")}"`;
  const content = { hooks: { PreToolUse: [{ matcher: "Edit|Write|Bash|run_terminal_cmd", hooks: [{ type: "command", command, timeout: 5 }] }] } };
  atomicWriteJson(hookConfig, content); return hookConfig;
}
function modelIdsFromText(text) {
  const clean = String(text || "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  return Array.from(new Set(clean.match(/\bgrok-[a-z0-9][a-z0-9._-]*/ig) || []));
}
function modelIdsFromCache(profile) {
  try {
    const cache = readJson(path.join(profile.grokHome, "models_cache.json"));
    if (!cache || !cache.models || typeof cache.models !== "object" || Array.isArray(cache.models)) return [];
    return Object.keys(cache.models).filter((model) => /^grok-[a-z0-9][a-z0-9._-]*$/i.test(model));
  } catch (_) {
    return [];
  }
}
function probeModelIds(profile, result) {
  if (!result || result.status !== 0) return [];
  return Array.from(new Set([...modelIdsFromText(result.stdout), ...modelIdsFromCache(profile)]));
}
function probeProfile(alias, registry = loadRegistry()) {
  const profile = registry.profiles.find((item) => item.alias === alias);
  assert(profile, "PROFILE_NOT_FOUND", `Profile '${alias}' is not registered.`);
  const probeHome = path.join(DATA_ROOT, "probes", crypto.randomUUID()); ensureDir(probeHome);
  const socket = path.join(probeHome, "leader.sock");
  const result = spawnCapture(profile.executable, ["models", "--leader-socket", socket], { cwd: process.cwd(), env: isolatedEnv(profile, probeHome, socket), timeout: 30000 });
  const models = probeModelIds(profile, result);
  profile.authReadiness = { oauthReady: result.status === 0, verifiedAt: now() };
  profile.identity = { identityStatus: "unknown", source: "cli_probe", value: null, capturedAt: now(), providerVersion: VERSION };
  profile.modelSnapshot = { models, reasoning: ["none", "minimal", "low", "medium", "high", "xhigh", "max"], checkedAt: now(), source: result.status === 0 ? "grok models + models_cache" : "probe_failed" };
  saveRegistry(registry);
  try { fs.rmSync(probeHome, { recursive: true, force: true }); } catch (_) { /* best effort non-raw probe cleanup */ }
  return { profileId: profile.profileId, alias: profile.alias, oauthReady: profile.authReadiness.oauthReady, identity: profile.identity, modelSnapshot: profile.modelSnapshot, status: result.status, stderr: redactText(result.stderr) };
}
function ensureDefaultProfile() {
  const registry = loadRegistry();
  // A pool is controller-owned. Never recreate historical/default accounts
  // simply because a caller invokes the CLI after a deliberate reset.
  ensureDir(registry.approvedProfileRoot || APPROVED_PROFILE_ROOT);
  return registry;
}
function registerEmptyProfile(alias) {
  assert(typeof alias === "string" && /^[a-z0-9][a-z0-9._-]{1,63}$/i.test(alias), "PROFILE_ALIAS", "Profile alias is invalid.");
  const registry = loadRegistry();
  const existing = registry.profiles.find((item) => item.alias === alias); if (existing) { ensureDir(existing.grokHome); return existing; }
  const grokHome = validateWindowsPath(path.join(registry.approvedProfileRoot, alias), registry.approvedProfileRoot, "grokHome"); ensureDir(grokHome);
  const profile = {
    profileId: crypto.randomUUID(), alias, grokHome, executable: EXECUTABLE, accountLabel: alias,
    authReadiness: { oauthReady: false, verifiedAt: now() },
    identity: { identityStatus: "unknown", source: "cli_probe", value: null, capturedAt: now(), providerVersion: VERSION },
    sandboxCapability: { flagSupported: true, enforcementSupported: false, platform: "windows", evidence: "~/.grok/docs/user-guide/18-sandbox.md Platform Support: Linux/macOS only" },
    modelSnapshot: { models: [DEFAULT_MODEL], reasoning: ["high"], checkedAt: now(), source: "unprobed" }
  };
  registry.profiles.push(profile); saveRegistry(registry); return profile;
}

function listAuthorityFiles(worktree) {
  const candidates = [
    path.join(worktree, ".grok", "config.toml"), path.join(worktree, ".grok", "lsp.json"),
    path.join(worktree, ".claude", "settings.json"), path.join(worktree, ".claude", "settings.local.json"),
    path.join(worktree, ".cursor", "mcp.json"), path.join(worktree, ".claude.json")
  ];
  const hookDir = path.join(worktree, ".grok", "hooks");
  if (fs.existsSync(hookDir)) candidates.push(...fs.readdirSync(hookDir).map((name) => path.join(hookDir, name)));
  return candidates.filter((file) => fs.existsSync(file));
}
function preflightProject(worktree) {
  const findings = [];
  for (const file of listAuthorityFiles(worktree)) {
    const text = fs.readFileSync(file, "utf8");
    if (/settings(?:\.local)?\.json$/i.test(file) || /\.grok[\\/]hooks/i.test(file) || /mcp|plugin|folder[_-]?trust|\[permission\]|allow\s*=|lsp/i.test(text) || /mcp|lsp/i.test(file)) findings.push({ file, reason: "authority-bearing project configuration" });
  }
  assert(findings.length === 0, "PROJECT_AUTHORITY", "Project contains authority-bearing configuration; hash cannot authorize it.", { findings });
  return { pass: true, findings: [] };
}
function readTrustStore(profile, worktree) {
  const trust = path.join(profile.grokHome, "trusted_folders.toml");
  if (!fs.existsSync(trust)) return { path: trust, empty: true, targetTrusted: false };
  const text = fs.readFileSync(trust, "utf8");
  const target = normalizeCase(worktree).replace(/\\/g, "/");
  const normalizedText = text.toLowerCase().replace(/\\/g, "/");
  return { path: trust, empty: text.trim().length === 0, targetTrusted: normalizedText.includes(target) };
}
function inspectEffective(profile, worktree, invocationHome, socket) {
  const result = spawnCapture(profile.executable, ["inspect", "--json", "--leader-socket", socket], { cwd: worktree, env: isolatedEnv(profile, invocationHome, socket), timeout: 30000 });
  assert(result.status === 0, "INSPECT_FAILED", "grok inspect --json failed; effective authority is unresolved.", { status: result.status, stderr: redactText(result.stderr) });
  let parsed; try { parsed = JSON.parse(result.stdout); } catch (_) { throw new ProviderError("INSPECT_UNKNOWN", "grok inspect --json returned unparseable authority; refusing to run."); }
  const permissionSources = parsed.permissions && Array.isArray(parsed.permissions.sources) ? parsed.permissions.sources : [];
  const compatCells = parsed.externalCompat && Array.isArray(parsed.externalCompat.cells) ? parsed.externalCompat.cells : [];
  const hookCompatUnsafe = compatCells.filter((cell) => ["claude", "cursor"].includes(cell.vendor) && cell.surface === "hooks" && cell.enabled !== false);
  const suspicious = [];
  if (Array.isArray(parsed.hooks)) {
    const expectedHook = path.join(PROVIDER_DIR, "lib", "hook-boundary.js").replace(/\\/g, "/").toLowerCase();
    const foreignHooks = parsed.hooks.filter((hook) => String(hook && hook.target || "").replace(/\\/g, "/").toLowerCase().includes(expectedHook) === false);
    if (foreignHooks.length) suspicious.push("hooks");
  }
  if (Array.isArray(parsed.mcpServers) && parsed.mcpServers.length) suspicious.push("mcpServers");
  if (Array.isArray(parsed.plugins) && parsed.plugins.length) suspicious.push("plugins");
  if (Array.isArray(parsed.lspServers) && parsed.lspServers.length) suspicious.push("lspServers");
  if (permissionSources.length || (parsed.permissions && parsed.permissions.loaded > 0)) suspicious.push("permissionSources");
  if (hookCompatUnsafe.length) suspicious.push("externalCompatHooks");
  assert(suspicious.length === 0, "INSPECT_AUTHORITY", "Effective config contains unresolved or unauthorized authority.", { suspicious });
  return { pass: true, digest: crypto.createHash("sha256").update(result.stdout).digest("hex") };
}

function permissionRuleTargets(item, root) {
  const raw = String(item);
  const resolved = path.resolve(root, raw).replace(/\\/g, "/");
  const hasGlob = /[*?[\]]/.test(raw);
  let directory = false;
  try { directory = !hasGlob && fs.statSync(path.resolve(root, raw)).isDirectory(); } catch {}
  const absolute = directory ? `${resolved}/**` : resolved;
  if (path.isAbsolute(raw)) return [absolute];
  const relative = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  return Array.from(new Set([absolute, directory ? `${relative}/**` : relative]));
}
function buildPermissionSettings(capsule, worktree) {
  const readRules = capsule.contextRefs.flatMap((item) => permissionRuleTargets(item, capsule.workspace).map((target) => `Read(${target})`));
  const writeRules = capsule.policy.access === "workspace-write" ? capsule.allowedFiles.flatMap((item) => {
    return permissionRuleTargets(item, worktree).flatMap((target) => [`Read(${target})`, `Edit(${target})`, `Write(${target})`]);
  }) : capsule.allowedFiles.flatMap((item) => permissionRuleTargets(item, worktree).map((target) => `Read(${target})`));
  const deny = ["Edit(**/.git/**)", "Write(**/.git/**)", "Edit(**/.grok/**)", "Write(**/.grok/**)", "Edit(**/.claude/**)", "Write(**/.claude/**)", `Edit(${PROVIDER_DIR.replace(/\\/g, "/")}/runtime/**)`, `Write(${PROVIDER_DIR.replace(/\\/g, "/")}/runtime/**)`, "Bash", "MCPTool(*)", "WebFetch(*)", "WebSearch"];
  if (capsule.serviceControlPermission === "denied") deny.push("Bash(*service*)", "Bash(*taskkill*)", "Bash(*Stop-Process*)");
  if (capsule.gitPermission === "read-only") deny.push("Bash(git add *)", "Bash(git commit *)", "Bash(git push *)", "Bash(git reset *)", "Bash(git checkout *)", "Bash(git clean *)", "Bash(git worktree *)");
  // `forbiddenActions` is an auditable human/Task-Capsule contract. It is not
  // a Grok CLI grammar: free-form values (for example paths or comma lists)
  // must never be interpolated into --deny, which would make the native CLI
  // reject a safe workspace-write invocation. Bash is denied wholesale above;
  // dontAsk plus permanent path denies remain the write-isolation authority.
  return { permissions: { defaultMode: "dontAsk", allow: Array.from(new Set(readRules.concat(writeRules))), deny: Array.from(new Set(deny)) } };
}
function evaluatePolicyRequest(settings, request, hookOutcome = "failure") {
  const audit = { at: now(), tool: request.tool, path: request.path || null, hookOutcome, decision: null, reason: null };
  if (hookOutcome === "deny") { audit.decision = "deny"; audit.reason = "pretooluse-explicit-deny"; return audit; }
  const normalized = String(request.path || "").replace(/\\/g, "/").toLowerCase();
  const permanent = ["/.git/", "/.grok/", "/.claude/", "/runtime/"];
  if (["Edit", "Write"].includes(request.tool) && permanent.some((marker) => `/${normalized}/`.includes(marker))) { audit.decision = "deny"; audit.reason = "permanent-deny"; return audit; }
  const allow = settings.permissions.allow || [];
  const allowed = allow.some((rule) => {
    const match = rule.match(/^(Read|Edit|Write)\((.*?)(?:\/\*\*)?\)$/); if (!match || match[1] !== request.tool) return false;
    const prefix = match[2].replace(/\\/g, "/").toLowerCase(); return normalized === prefix || normalized.startsWith(`${prefix}/`);
  });
  if (allowed) { audit.decision = "allow"; audit.reason = hookOutcome === "failure" ? "hook-fail-open-then-explicit-allow" : "explicit-allow"; return audit; }
  audit.decision = "deny"; audit.reason = settings.permissions.defaultMode === "dontAsk" ? "dontask-no-allow" : "prompt-required"; return audit;
}
function planTemplate(capsule, profile) {
  const settings = buildPermissionSettings(capsule, capsule.worktree.path);
  const args = ["--no-plan", "--no-memory", "--output-format", "streaming-json", "--prompt-file", "<PROMPT_FILE>", "--cwd", "<WORKTREE>", "--model", capsule.model || DEFAULT_MODEL, "--reasoning-effort", capsule.reasoning || "high", "--disallowed-tools", "run_terminal_cmd,Agent", "--no-subagents", "--disable-web-search", "--leader-socket", "<LEADER_SOCKET>"];
  for (const rule of settings.permissions.allow) args.push("--allow", rule);
  for (const rule of settings.permissions.deny) args.push("--deny", rule);
  if (capsule.grokSessionId && /resume/i.test(capsule.resumePolicy.mode)) args.push("--resume", "<SESSION_ID>"); else args.push("--session-id", "<SESSION_ID>");
  return { schemaVersion: 3, executable: profile.executable, args, env: { GROK_HOME: "<PROFILE_HOME>", HOME: "<INVOCATION_HOME>", USERPROFILE: "<INVOCATION_HOME>", LOCALAPPDATA: "<INVOCATION_LOCALAPPDATA>", GROK_CLAUDE_HOOKS_ENABLED: "false", GROK_CURSOR_HOOKS_ENABLED: "false" }, invariants: { noPlan: true, noMemory: true, streamingJson: true, terminalDenied: true, subagentsDenied: true, folderTrustEnabled: true, trustFlagAbsent: true, windowsSandboxEnforcement: false, compatHooksDisabled: true } };
}
function verifyPlanContract(plan, capsule) {
  const args = plan.args || (plan.planTemplate && plan.planTemplate.args) || [];
  const joined = args.join("\u0000");
  for (const required of ["--no-plan", "--no-memory", "--output-format", "streaming-json", "--prompt-file", "--cwd", "--disallowed-tools", "run_terminal_cmd,Agent", "--no-subagents", "--disable-web-search", "--leader-socket"]) assert(args.includes(required), "PLAN_CONTRACT", `Invocation plan is missing '${required}'.`);
  assert(!args.includes("--trust") && !args.includes("--sandbox") && !joined.includes("GROK_FOLDER_TRUST"), "PLAN_CONTRACT", "Invocation plan contains a forbidden trust or sandbox assumption.");
  const env = plan.env || (plan.planTemplate && plan.planTemplate.env) || {};
  assert(env.GROK_CLAUDE_HOOKS_ENABLED === "false" && env.GROK_CURSOR_HOOKS_ENABLED === "false", "PLAN_CONTRACT", "Invocation plan must disable external compatibility hooks in the child process.");
  const settings = plan.settings || {};
  assert(settings.permissions && settings.permissions.defaultMode === "dontAsk", "PLAN_CONTRACT", "dontAsk must be configured in isolated settings.json.");
  const deny = settings.permissions.deny || [];
  for (const marker of [".git", ".grok", ".claude", "runtime", "Bash", "MCPTool", "WebFetch", "WebSearch"]) assert(deny.some((rule) => rule.includes(marker)), "PLAN_CONTRACT", `Deny policy is missing '${marker}'.`);
  if (capsule) {
    for (const rule of settings.permissions.allow || []) assert(args.some((item, index) => item === "--allow" && args[index + 1] === rule), "PLAN_CONTRACT", `CLI allow rule is missing '${rule}'.`);
    for (const rule of deny) assert(args.some((item, index) => item === "--deny" && args[index + 1] === rule), "PLAN_CONTRACT", `CLI deny rule is missing '${rule}'.`);
    if (capsule.serviceControlPermission === "denied") assert(deny.some((rule) => /service/i.test(rule)) && deny.some((rule) => /taskkill/i.test(rule)), "PLAN_CONTRACT", "serviceControlPermission enforcement is missing.");
    if (capsule.gitPermission === "read-only") assert(deny.some((rule) => /git commit/i.test(rule)) && deny.some((rule) => /git push/i.test(rule)), "PLAN_CONTRACT", "gitPermission enforcement is missing.");
    assert(deny.includes("Bash"), "PLAN_CONTRACT", "forbiddenActions are enforced through the whole-tool Bash deny, not free-form CLI interpolation.");
    assert(capsule.policy.bash === "denied" || capsule.policy.bash === "controller-only", "PLAN_CONTRACT", "Worker Bash policy is not closed.");
  }
  return true;
}

/** Maintenance has no task capsule, so validate its exact concrete boundary. */
function isDefaultGrokPath(value) {
  if (typeof value !== "string" || !value) return false;
  const candidate = normalizeCase(value);
  const defaultHome = normalizeCase(DEFAULT_GROK_HOME);
  return candidate === defaultHome || candidate.startsWith(`${defaultHome}${path.sep}`) || defaultHome.startsWith(`${candidate}${path.sep}`);
}

function verifyMaintenancePlanContract(plan, profile) {
  const args = plan && plan.args || [];
  const env = plan && plan.env || {};
  const settings = plan && plan.settings || {};
  const scratch = plan && plan.scratch;
  const indexOf = (flag) => args.indexOf(flag);
  const valueOf = (flag) => { const index = indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
  const requireValue = (flag, expected) => assert(indexOf(flag) >= 0 && valueOf(flag) === expected, "MAINTENANCE_PLAN_CONTRACT", `Maintenance plan must contain '${flag} ${expected}'.`);
  assert(profile && typeof profile.executable === "string" && normalizeCase(profile.executable) === normalizeCase(EXECUTABLE), "MAINTENANCE_PLAN_CONTRACT", "Maintenance profile has no Provider-verified CLI.");
  assert(plan.executable === profile.executable && normalizeCase(plan.executable) === normalizeCase(EXECUTABLE), "MAINTENANCE_PLAN_CONTRACT", "Maintenance executable is not the Provider-verified CLI.");
  assert(typeof profile.grokHome === "string" && profile.grokHome && !isDefaultGrokPath(profile.grokHome), "MAINTENANCE_PLAN_CONTRACT", "Maintenance profile GROK_HOME must not be the default .grok path.");
  assert(typeof scratch === "string" && scratch && plan.cwd === scratch, "MAINTENANCE_PLAN_CONTRACT", "Maintenance cwd must be its scratch root.");
  for (const flag of ["--no-plan", "--no-memory", "--no-subagents", "--disable-web-search"]) assert(args.includes(flag), "MAINTENANCE_PLAN_CONTRACT", `Maintenance plan is missing '${flag}'.`);
  requireValue("--output-format", "streaming-json"); requireValue("--model", DEFAULT_MODEL); requireValue("--reasoning-effort", "high"); requireValue("--max-turns", "1"); requireValue("--cwd", scratch);
  assert(valueOf("--prompt-file") === plan.promptPath && String(plan.promptPath).startsWith(scratch), "MAINTENANCE_PLAN_CONTRACT", "Maintenance prompt must stay under scratch.");
  assert(valueOf("--leader-socket") === plan.socket && String(plan.socket).startsWith(scratch), "MAINTENANCE_PLAN_CONTRACT", "Maintenance socket must stay under scratch.");
  assert(valueOf("--session-id") === plan.sessionId && !args.includes("--resume"), "MAINTENANCE_PLAN_CONTRACT", "Maintenance must use one new session and never resume.");
  assert(!args.includes("--allow") && !args.join("\u0000").includes("auth.json"), "MAINTENANCE_PLAN_CONTRACT", "Maintenance must not allow tools or name auth.json.");
  const permissions = settings.permissions || {};
  assert(permissions.defaultMode === "dontAsk" && Array.isArray(permissions.allow) && permissions.allow.length === 0, "MAINTENANCE_PLAN_CONTRACT", "Maintenance permissions must be dontAsk with no allows.");
  const deny = permissions.deny || [];
  for (const marker of ["Bash", "MCPTool(*)", "WebFetch(*)", "WebSearch"]) {
    assert(deny.includes(marker), "MAINTENANCE_PLAN_CONTRACT", `Maintenance deny is missing '${marker}'.`);
    assert(args.some((item, index) => item === "--deny" && args[index + 1] === marker), "MAINTENANCE_PLAN_CONTRACT", `Maintenance argv deny is missing '${marker}'.`);
  }
  assert(env.GROK_HOME === profile.grokHome && !isDefaultGrokPath(env.GROK_HOME) && env.GROK_HOME !== process.env.GROK_HOME, "MAINTENANCE_PLAN_CONTRACT", "Maintenance GROK_HOME is not the isolated profile home.");
  assert(env.HOME === scratch && env.USERPROFILE === scratch && typeof env.LOCALAPPDATA === "string" && env.LOCALAPPDATA.startsWith(scratch), "MAINTENANCE_PLAN_CONTRACT", "Maintenance home variables are not scratch-isolated.");
  assert(env.XAI_API_KEY === undefined && env.GROK_FOLDER_TRUST === undefined && env.GROK_SANDBOX === undefined, "MAINTENANCE_PLAN_CONTRACT", "Maintenance inherited a forbidden environment override.");
  assert(env.GROK_CLAUDE_HOOKS_ENABLED === "false" && env.GROK_CURSOR_HOOKS_ENABLED === "false", "MAINTENANCE_PLAN_CONTRACT", "Maintenance compatibility hooks must be disabled.");
  return true;
}
function resolveProfileForCapsule(capsule, registry, options = {}) {
  if (options.profileId) {
    const byId = registry.profiles.find((item) => item.profileId === options.profileId);
    assert(byId, "PROFILE_NOT_FOUND", `Profile id '${options.profileId}' is not registered.`);
    return byId;
  }
  if (capsule.profile) {
    const byAlias = registry.profiles.find((item) => item.alias === capsule.profile);
    assert(byAlias, "PROFILE_NOT_FOUND", `Profile '${capsule.profile}' is not registered.`);
    return byAlias;
  }
  throw new ProviderError("CAPSULE_PROFILE", "No profile selected for materialization.");
}

function materialize(capsule, registry = loadRegistry(), options = {}) {
  capsule = validateTaskCapsule(capsule, registry);
  const profile = resolveProfileForCapsule(capsule, registry, options);
  validateProfile(profile, registry); preflightProject(capsule.worktree.path);
  const model = capsule.model || DEFAULT_MODEL; const reasoning = capsule.reasoning || "high";
  const snapshot = profile.modelSnapshot || {};
  assert(Array.isArray(snapshot.models) && snapshot.models.includes(model), "MODEL_STALE", "Requested model is not in the latest capability snapshot.", { model });
  assert(!snapshot.reasoning || snapshot.reasoning.includes(reasoning), "REASONING_STALE", "Requested reasoning is not in the latest capability snapshot.", { reasoning });
  const invocationId = options.invocationId || crypto.randomUUID();
  const invocationRoot = path.join(TEMP_ROOT, invocationId); const invocationHome = path.join(invocationRoot, "home");
  const promptPath = path.join(invocationRoot, "task.prompt.txt"); const socket = path.join(invocationRoot, "leader.sock");
  const auditPath = path.join(invocationRoot, "policy-audit.jsonl"); const policyPath = path.join(invocationRoot, "policy.json");
  ensureDir(path.join(invocationHome, ".claude")); ensureDir(path.join(invocationHome, "AppData", "Local"));
  ensureProviderHook(profile);
  const trust = readTrustStore(profile, capsule.worktree.path);
  assert(!trust.targetTrusted, "TRUST_LEAK", "Target project is trusted in this profile; Provider requires default-untrusted execution.", { trustPath: trust.path });
  const settings = buildPermissionSettings(capsule, capsule.worktree.path);
  atomicWriteJson(path.join(invocationHome, ".claude", "settings.json"), settings);
  atomicWriteJson(policyPath, {
    worktree: path.resolve(capsule.worktree.path),
    allowedWriteRoots: capsule.policy.access === "workspace-write" ? capsule.allowedFiles.map((item) => expandPattern(item, capsule.worktree.path)) : [],
    permanentDeny: [path.join(capsule.worktree.path, ".git"), path.join(capsule.worktree.path, ".grok"), path.join(capsule.worktree.path, ".claude"), path.join(PROVIDER_DIR, "runtime")]
  });
  const config = "[compat.claude]\nhooks = false\n\n[compat.cursor]\nhooks = false\n";
  fs.writeFileSync(path.join(invocationHome, "config.toml"), config, { encoding: "utf8", mode: 0o600 });
  const sessionId = capsule.grokSessionId || crypto.randomUUID();
  const template = planTemplate(capsule, profile);
  const args = template.args.map((item) => ({ "<PROMPT_FILE>": promptPath, "<WORKTREE>": capsule.worktree.path, "<LEADER_SOCKET>": socket, "<SESSION_ID>": sessionId }[item] || item));
  assert(!args.includes("--trust") && !args.includes("--sandbox"), "PLAN_UNSAFE_FLAG", "Provider plan contains a forbidden trust/sandbox assumption.");
  const env = isolatedEnv(profile, invocationHome, socket);
  env.GROK_WORKER_POLICY_FILE = policyPath; env.GROK_WORKER_AUDIT_FILE = auditPath;
  assert(env.GROK_FOLDER_TRUST === undefined, "PLAN_TRUST_DISABLED", "GROK_FOLDER_TRUST must remain unset.");
  verifyPlanContract({ args, settings, env }, capsule);
  if (!options.skipInspect) inspectEffective(profile, capsule.worktree.path, invocationHome, socket);
  const selectionMode = Array.isArray(capsule.candidateProfileIds) && capsule.candidateProfileIds.length ? "pool" : "explicit";
  return {
    schemaVersion: 3,
    invocationId,
    createdAt: now(),
    profileId: profile.profileId,
    profileAlias: profile.alias,
    accountIdentitySnapshot: clone(profile.identity),
    planTemplate: template,
    executable: profile.executable,
    args,
    env,
    cwd: capsule.worktree.path,
    promptPath,
    invocationRoot,
    invocationHome,
    socket,
    sessionId,
    settings,
    trust,
    capsule,
    policyPath,
    auditPath,
    selectionMode,
    candidateProfileIds: selectionMode === "pool" ? capsule.candidateProfileIds.slice() : [profile.profileId],
    skippedReasons: options.skippedReasons || [],
    maintenanceProbePlanned: options.maintenanceProbePlanned === true
  };
}

function promptFor(capsule) {
  return [
    `Task ${capsule.taskId} (${capsule.stage})`, capsule.objective,
    `Allowed files: ${capsule.allowedFiles.join(", ")}`,
    `Forbidden actions: ${capsule.forbiddenActions.join(", ")}`,
    `Stop: ${capsule.explicitStop}`,
    "Follow the repository facts and edit only explicitly allowed files. Never run shell commands. Return a concise completion summary."
  ].join("\n\n");
}
function numericUsage(value) {
  // Missing usage stays unknown — never invent 0 token counts for absent payloads (402/unknown).
  if (!isObject(value)) {
    return {
      present: false,
      unknown: true,
      input_tokens: null,
      cache_read_input_tokens: null,
      output_tokens: null,
      reasoning_tokens: null,
      total_tokens: null,
      modelUsage: {},
      note: "usage-unknown"
    };
  }
  const get = (key) => Number.isFinite(Number(value[key])) ? Number(value[key]) : null;
  const input_tokens = get("input_tokens");
  const cache_read_input_tokens = get("cache_read_input_tokens");
  const output_tokens = get("output_tokens");
  const reasoning_tokens = get("reasoning_tokens");
  let total_tokens = get("total_tokens");
  const anyNumeric = [input_tokens, cache_read_input_tokens, output_tokens, reasoning_tokens, total_tokens]
    .some((n) => n !== null);
  if (!anyNumeric) {
    return {
      present: false,
      unknown: true,
      input_tokens: null,
      cache_read_input_tokens: null,
      output_tokens: null,
      reasoning_tokens: null,
      total_tokens: null,
      modelUsage: {},
      note: "usage-unknown"
    };
  }
  if (total_tokens === null) {
    total_tokens = (input_tokens || 0) + (cache_read_input_tokens || 0) + (output_tokens || 0) + (reasoning_tokens || 0);
  }
  return {
    present: true,
    unknown: false,
    input_tokens: input_tokens === null ? 0 : input_tokens,
    cache_read_input_tokens: cache_read_input_tokens === null ? 0 : cache_read_input_tokens,
    output_tokens: output_tokens === null ? 0 : output_tokens,
    reasoning_tokens: reasoning_tokens === null ? 0 : reasoning_tokens,
    total_tokens,
    modelUsage: isObject(value.modelUsage)
      ? Object.fromEntries(Object.entries(value.modelUsage).map(([k, v]) => [k, { modelCalls: Number(v && v.modelCalls) || 0 }]))
      : {},
    note: null
  };
}
function parseStream(text) {
  const summary = []; let terminal = null; let invalid = 0; let finalText = "";
  for (const line of String(text || "").split(/\r?\n/).filter(Boolean)) {
    let event; try { event = JSON.parse(line); } catch (_) { invalid += 1; continue; }
    const type = String(event.type || "unknown");
    if (type === "text" && typeof event.data === "string") finalText += event.data;
    summary.push({ type, sessionId: typeof event.sessionId === "string" ? event.sessionId : null, requestId: typeof event.requestId === "string" ? event.requestId : null, hasUsage: Boolean(event.usage), textBytes: typeof event.data === "string" ? Buffer.byteLength(event.data) : 0 });
    if (type === "end") terminal = event;
  }
  return { summary, terminal, invalid, finalText };
}
function readPolicyAudit(file) {
  if (typeof file !== "string" || file.length === 0 || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => {
    try { const event = JSON.parse(line); return { at: event.at, tool: String(event.tool || "unknown"), path: event.path ? path.basename(String(event.path)) : null, decision: event.decision, reason: event.reason }; }
    catch (_) { return { at: now(), tool: "unknown", path: null, decision: "audit-parse-failed", reason: "malformed-provider-hook-audit" }; }
  });
}
function gitOutput(cwd, args) { return spawnCapture("git", args, { cwd, env: process.env, timeout: 30000 }); }
function changedFilesFinalState(worktree) {
  const status = gitOutput(worktree, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored"]);
  assert(status.status === 0, "GIT_STATUS", "Unable to collect changed-files final state.");
  return status.stdout.split(/\r?\n/).filter(Boolean).map((line) => ({ code: line.slice(0, 2), path: line.slice(3).trim().replace(/^"|"$/g, ""), ignored: line.startsWith("!!") }));
}
function changedWithinAllowed(entries, capsule) {
  const root = capsule.worktree.path;
  return entries.every((entry) => capsule.allowedFiles.some((pattern) => within(path.join(root, entry.path), expandPattern(pattern, root))));
}
function baselineCheck(capsule) {
  const head = gitOutput(capsule.worktree.path, ["rev-parse", "HEAD"]);
  assert(head.status === 0 && head.stdout.trim() === capsule.baseCommit, "BASE_COMMIT_DRIFT", "worktree HEAD differs from baseCommit.", { expected: capsule.baseCommit, actual: head.stdout.trim() });
  if (capsule.policy.access === "workspace-write") {
    const dirty = changedFilesFinalState(capsule.worktree.path);
    assert(dirty.length === 0, "DIRTY_BASELINE", "workspace-write requires a clean exclusive-worktree baseline.", { dirty });
  }
}
function executePlan(plan, options = {}) {
  const timeoutMs = options.timeoutMs || 30 * 60 * 1000;
  fs.writeFileSync(plan.promptPath, promptFor(plan.capsule), { encoding: "utf8", mode: 0o600 });
  const result = spawnCapture(plan.executable, plan.args, { cwd: plan.cwd, env: plan.env, timeout: timeoutMs });
  const parsed = parseStream(result.stdout); let rawCleanupFailed = false;
  try { fs.rmSync(plan.promptPath, { force: true }); } catch (_) { rawCleanupFailed = true; }
  return { ...result, parsed, rawCleanupFailed };
}
function ledgerPath(taskId) { return path.join(LEDGER_ROOT, `${taskId.replace(/[^a-z0-9_.-]/gi, "_")}.json`); }
function emptyLedger(taskId) { return { taskId, invocations: [], dedupKey: "invocation.profileId+sessionId+requestId", layers: { sumRunUsage: { total_tokens: 0, byType: { input: 0, cache_read: 0, output: 0, reasoning: 0 }, invocationsCounted: 0, invocationsUnknown: 0 }, byProfileId: {}, profileUsageSnapshotRefs: {}, localEstimate: { present: false, note: "replay_suspected", value: null } } }; }
function usageFingerprint(usage) { return JSON.stringify([usage.present, usage.input_tokens, usage.cache_read_input_tokens, usage.output_tokens, usage.reasoning_tokens, usage.total_tokens, usage.modelUsage]); }
function rebuildLayers(ledger) {
  const sum = { total_tokens: 0, byType: { input: 0, cache_read: 0, output: 0, reasoning: 0 }, invocationsCounted: 0, invocationsUnknown: 0 }; const by = {};
  for (const inv of ledger.invocations) {
    const u = inv.runUsage; if (!by[inv.profileId]) by[inv.profileId] = { total_tokens: 0, invocationsCounted: 0, invocationsUnknown: 0 };
    if (!u.present) { sum.invocationsUnknown += 1; by[inv.profileId].invocationsUnknown += 1; continue; }
    sum.invocationsCounted += 1; by[inv.profileId].invocationsCounted += 1; sum.total_tokens += u.total_tokens; by[inv.profileId].total_tokens += u.total_tokens;
    sum.byType.input += u.input_tokens; sum.byType.cache_read += u.cache_read_input_tokens; sum.byType.output += u.output_tokens; sum.byType.reasoning += u.reasoning_tokens;
  }
  ledger.layers.sumRunUsage = sum; ledger.layers.byProfileId = by;
  for (const id of Object.keys(by)) ledger.layers.profileUsageSnapshotRefs[id] = { store: path.relative(DATA_ROOT, path.join(SNAPSHOT_ROOT, id, "snapshots.jsonl")).replace(/\\/g, "/"), latestCapturedAt: null, accountBinding: null };
  return ledger;
}
function recordInvocation(taskId, invocation) {
  const file = ledgerPath(taskId); const ledger = fs.existsSync(file) ? readJson(file) : emptyLedger(taskId);
  const key = `${invocation.profileId}|${invocation.sessionId}|${invocation.requestId}`;
  const existing = ledger.invocations.find((item) => `${item.profileId}|${item.sessionId}|${item.requestId}` === key);
  if (existing) assert(usageFingerprint(existing.runUsage) === usageFingerprint(invocation.runUsage), "LEDGER_CONFLICT", "Same dedup key has different numeric usage; refusing silent deduplication.", { key });
  else ledger.invocations.push(invocation);
  rebuildLayers(ledger); atomicWriteJson(file, ledger); return ledger;
}
function quotaSignalFromEnd(terminal) {
  if (!isObject(terminal)) return { present: false, usedPercent: null, source: "end_event", exhausted: false };
  const primary = terminal.rate_limits && terminal.rate_limits.primary;
  const candidate = primary || terminal.rate_limits || terminal.quota || null;
  if (!isObject(candidate)) return { present: false, usedPercent: null, source: "end_event", exhausted: false };
  const raw = candidate.used_percent !== undefined ? candidate.used_percent : candidate.usedPercent;
  const usedPercent = Number.isFinite(Number(raw)) ? Number(raw) : null;
  const exhausted = usedPercent !== null ? usedPercent >= 100 : /quota|credit|subscription|rate.?limit/i.test(String(candidate.status || candidate.reason || "")) && /exhaust|limit|deplet|insufficient/i.test(String(candidate.status || candidate.reason || ""));
  return { present: true, usedPercent, source: "end_event", exhausted };
}
function resultPath(taskId, invocationId) { return path.join(RESULT_ROOT, taskId.replace(/[^a-z0-9_.-]/gi, "_"), `${invocationId}.json`); }

function buildResultCapsule({ capsule, plan, execution, classification, selectionEvidence, quotaSignal, changedFiles }) {
  const terminal = execution.parsed.terminal || {};
  const sessionId = terminal.sessionId || plan.sessionId;
  const requestId = terminal.requestId || `unknown-${plan.invocationId}`;
  const changes = Array.isArray(changedFiles) ? changedFiles : changedFilesFinalState(capsule.worktree.path);
  const boundaryOk = changedWithinAllowed(changes, capsule);
  const policyAuditEvents = readPolicyAudit(plan.auditPath);
  const terminalSucceeded = terminal.type === "end" && !/cancel|fail|error|interrupt/i.test(String(terminal.stopReason || ""));
  const hardFailType = classification && ["quota_exhausted", "reauth_required", "rate_limited", "model_unavailable", "network_fault", "provider_fault"].includes(classification.errorType)
    && classification.note !== "no-error-on-success";
  let finalStatus = "failed";
  if (execution.status === 0 && execution.parsed.invalid === 0 && terminalSucceeded && boundaryOk && !execution.rawCleanupFailed && !hardFailType) {
    finalStatus = "completed";
  }
  const textDigest = crypto.createHash("sha256").update(execution.parsed.finalText || "").digest("hex");
  const stopReason = (classification && classification.errorType === "quota_exhausted" && classification.note !== "no-error-on-success")
    ? "profile_exhausted"
    : (quotaSignal && quotaSignal.exhausted)
      ? "profile_exhausted"
      : (terminal.stopReason || (finalStatus === "completed" ? "end_event" : "failed"));
  return {
    status: finalStatus,
    grokSessionId: sessionId,
    baseCommit: capsule.baseCommit,
    changedFiles: changes.map((x) => x.path),
    commands: [{ command: "grok-worker run", summary: "Native isolated Grok Worker invocation", executedBy: "worker" }],
    tests: capsule.acceptanceCommands.map((command) => ({ command, result: "not-run-by-worker", executedBy: "controller" })),
    findings: [
      terminal.type === "end" ? "terminal end event observed" : "terminal end event missing",
      `finalTextSha256=${textDigest}`,
      `permissionDeniedMentioned=${/denied|permission|not allowed|cannot|can't/i.test(execution.parsed.finalText || "")}`,
      `spawnErrorCode=${execution.errorCode || "none"}`,
      `spawnSignal=${execution.signal || "none"}`,
      classification ? `errorType=${classification.errorType}` : "errorType=none"
    ],
    assumptions: ["Windows sandbox enforcement is unavailable; policy controls are authoritative."],
    unresolved: finalStatus === "completed" ? [] : ["Invocation or boundary verification failed."],
    residualRisks: [
      "Server-side quota remains shared by account even with local profile isolation.",
      "execution.stderr exhaustion payload format remains INCONCLUSIVE until naturally observed."
    ],
    commitEvidence: ["Provider performed no Git commit."],
    diffEvidence: [`changedFilesFinalState=${changes.length}`],
    boundaryCompliance: { changedFilesFinalState: changes, policyAuditEvents, allowed: boundaryOk },
    taskId: capsule.taskId,
    stage: capsule.stage,
    worktree: capsule.worktree,
    exitCode: execution.status === null ? 1 : execution.status,
    redaction: {
      applied: true,
      notes: ["Raw streaming-json was parsed in memory and was not archived.", "execution.stderr was redacted before classification persistence."],
      rawStreamDeleted: true,
      rawCleanupFailed: execution.rawCleanupFailed
    },
    profileId: plan.profileId,
    invocationId: plan.invocationId,
    requestId,
    variant: capsule.grokSessionId ? "resume" : "main",
    stopReason,
    durationMs: null,
    selectionEvidence: selectionEvidence || {
      selectionMode: plan.selectionMode || "explicit",
      candidateProfileIds: plan.candidateProfileIds || [plan.profileId],
      skippedReasons: plan.skippedReasons || [],
      finalSelectedProfileId: plan.profileId,
      maintenanceProbePlanned: plan.maintenanceProbePlanned === true
    },
    errorClassification: classification || {
      errorType: "unknown_failure",
      statusCode: null,
      retryable: null,
      quotaKind: null,
      profileAttributable: false
    }
  };
}

function persistAvailabilityFromOutcome(profile, classification, executionStatus, context = {}) {
  const deps = availabilityDeps();
  const current = availability.loadAvailability(DATA_ROOT, profile.profileId, deps);
  let nextRecord = current;
  let touched = false;
  let reason = "none";
  let providerHealth = null;

  if (executionStatus === 0 && (!classification || !availability.shouldTouchAvailability(classification))) {
    nextRecord = availability.markActive(current, { evidenceSource: "successful-invocation" });
    touched = true;
    reason = "success→active";
    providerHealth = availability.markProviderHealthOk(DATA_ROOT, deps);
  } else if (classification) {
    const applied = availability.applyClassificationToAvailability(current, classification, {
      profileId: profile.profileId,
      evidenceSource: "execution-classification"
    });
    nextRecord = applied.record;
    touched = applied.touched;
    reason = applied.reason;
    // Optional billing influence on nextProbeAt only
    if (touched && (nextRecord.state === "frozen" || nextRecord.state === "cooldown")) {
      const billing = availability.readBillingSnapshot(profile.grokHome, deps);
      const withBilling = availability.applyBillingToNextProbe(nextRecord, billing);
      nextRecord = withBilling.record;
    }
    // Non-attributable faults: independent provider/global health only (§5)
    if (!applied.touched && classification.errorType && executionStatus !== 0) {
      providerHealth = availability.recordProviderHealth(DATA_ROOT, {
        errorType: classification.errorType,
        statusCode: classification.statusCode,
        taskId: context.taskId || null,
        invocationId: context.invocationId || null,
        profileId: profile.profileId
      }, deps);
      reason = `${reason}+provider-health`;
    }
  }

  if (!touched && executionStatus === 0) {
    nextRecord = availability.markActive(current, { evidenceSource: "successful-invocation" });
    touched = true;
    reason = "success→active";
    providerHealth = availability.markProviderHealthOk(DATA_ROOT, deps);
  }

  if (touched) {
    nextRecord = availability.markSelected(nextRecord);
    const cas = availability.writeAvailabilityCas(DATA_ROOT, profile.profileId, nextRecord, current.revision, deps);
    return { cas, reason, record: cas.ok ? cas.record : current, providerHealth };
  }
  return { cas: { ok: true, skipped: true }, reason, record: current, providerHealth };
}

function runSingleAttempt(capsule, registry, profile, selectionEvidence, options = {}) {
  const profileLock = acquireLock("profile", [profile.grokHome], capsule.worktree.path, 60 * 60 * 1000);
  if (typeof options.onProfileLockAcquired === "function") {
    try { options.onProfileLockAcquired(); } catch (_) { /* selection release best-effort */ }
  }
  let fileLock;
  let plan;
  let execution;
  let result;
  let classification;
  let healthOutcome = null;
  try {
    fileLock = acquireLock("workspace", capsule.allowedFiles, capsule.worktree.path, 60 * 60 * 1000);
    plan = materialize(capsule, registry, {
      ...options,
      profileId: profile.profileId,
      skippedReasons: selectionEvidence.skippedReasons || [],
      maintenanceProbePlanned: selectionEvidence.maintenanceProbePlanned === true,
      // Mock integration may skip live inspect; production never sets this unless tests inject.
      skipInspect: options.skipInspect === true || typeof options.executePlanFn === "function"
    });
    execution = options.executePlanFn
      ? options.executePlanFn(plan, options)
      : executePlan(plan, options);

    // Still holding profile lock: classify + write availability (CAS)
    const redactedStderr = redactText(execution.stderr || "");
    classification = availability.classifyFromExecution(
      { status: execution.status, stderr: redactedStderr, stdout: "" },
      { redactText }
    );
    // Full structural success: clear soft/unknown classification even when benign stderr
    // exists. Preserve hard quota/reauth/rate-limit (and other hard-fail) classifications.
    const parsedEarly = execution.parsed || {};
    const terminalEarly = parsedEarly.terminal || {};
    const terminalSucceededEarly = terminalEarly.type === "end"
      && !/cancel|fail|error|interrupt/i.test(String(terminalEarly.stopReason || ""));
    const streamValidEarly = Number(parsedEarly.invalid || 0) === 0;
    const hardPreserveTypes = [
      "quota_exhausted", "reauth_required", "rate_limited",
      "model_unavailable", "network_fault", "provider_fault"
    ];
    const hardPreserve = classification && hardPreserveTypes.includes(classification.errorType);
    if (
      execution.status === 0
      && streamValidEarly
      && terminalSucceededEarly
      && !execution.rawCleanupFailed
      && !hardPreserve
    ) {
      classification = {
        errorType: null,
        statusCode: null,
        retryable: null,
        quotaKind: null,
        profileAttributable: false,
        accountLevelEvidence: false
      };
    }
    healthOutcome = persistAvailabilityFromOutcome(profile, classification, execution.status, {
      taskId: capsule.taskId,
      invocationId: plan.invocationId
    });
  } finally {
    if (fileLock) fileLock.release();
    profileLock.release();
  }

  const terminal = execution.parsed.terminal || {};
  const sessionId = terminal.sessionId || plan.sessionId;
  const requestId = terminal.requestId || `unknown-${plan.invocationId}`;
  const runUsage = numericUsage(terminal.usage);
  // 402 / quota exhausted must keep usage unknown, never invent 0
  if (classification && classification.errorType === "quota_exhausted") {
    if (!runUsage.present) {
      runUsage.present = false;
      runUsage.unknown = true;
      runUsage.note = "usage-unknown";
      runUsage.input_tokens = null;
      runUsage.cache_read_input_tokens = null;
      runUsage.output_tokens = null;
      runUsage.reasoning_tokens = null;
      runUsage.total_tokens = null;
    }
  }
  const quotaSignal = quotaSignalFromEnd(terminal);
  if (classification && classification.errorType === "quota_exhausted") {
    quotaSignal.exhausted = true;
    quotaSignal.present = true;
  }

  const normalizedClassification = classification && classification.errorType
    ? {
      errorType: classification.errorType,
      statusCode: classification.statusCode,
      retryable: classification.retryable,
      quotaKind: classification.quotaKind,
      profileAttributable: classification.profileAttributable === true
    }
    : {
      errorType: "unknown_failure",
      statusCode: null,
      retryable: null,
      quotaKind: null,
      profileAttributable: false
    };

  // Full success path: persist errorType null (not unknown_failure) even with benign stderr.
  const terminalSucceeded = terminal.type === "end"
    && !/cancel|fail|error|interrupt/i.test(String(terminal.stopReason || ""));
  const streamValid = Number((execution.parsed && execution.parsed.invalid) || 0) === 0;
  const structuralSuccess = execution.status === 0
    && streamValid
    && terminalSucceeded
    && !execution.rawCleanupFailed;
  const resultClassification = (structuralSuccess && (!classification || !classification.errorType))
    ? {
      errorType: null,
      statusCode: null,
      retryable: null,
      quotaKind: null,
      profileAttributable: false,
      note: "no-error-on-success"
    }
    : normalizedClassification;

  const changedFiles = typeof options.changedFilesFinalStateFn === "function"
    ? options.changedFilesFinalStateFn(capsule.worktree.path)
    : undefined;

  result = buildResultCapsule({
    capsule,
    plan,
    execution,
    classification: resultClassification,
    selectionEvidence: {
      ...selectionEvidence,
      finalSelectedProfileId: plan.profileId
    },
    quotaSignal,
    changedFiles
  });
  // Boundary is known only after buildResultCapsule: completed success keeps errorType null.
  if (structuralSuccess && (!classification || !classification.errorType)) {
    result.status = result.boundaryCompliance.allowed && !execution.rawCleanupFailed ? "completed" : "failed";
    result.stopReason = result.status === "completed" ? "end_event" : result.stopReason;
    if (result.status === "completed") {
      result.errorClassification = {
        errorType: null,
        statusCode: null,
        retryable: null,
        quotaKind: null,
        profileAttributable: false,
        note: "no-error-on-success"
      };
    }
  }

  const inv = {
    invocationId: plan.invocationId,
    sessionId,
    requestId,
    variant: result.variant,
    profileId: plan.profileId,
    profileAlias: plan.profileAlias,
    accountIdentitySnapshot: plan.accountIdentitySnapshot,
    runUsage,
    quotaSignal
  };
  validateResultCapsule(result);
  const ledger = recordInvocation(capsule.taskId, inv);
  const ref = resultPath(capsule.taskId, plan.invocationId);
  atomicWriteJson(ref, result);
  try {
    fs.rmSync(plan.invocationRoot, { recursive: true, force: true });
  } catch (_) {
    result.redaction.rawCleanupFailed = true;
    result.status = "failed";
    atomicWriteJson(ref, result);
  }
  return {
    result,
    ledger,
    plan,
    classification: resultClassification,
    hasOutput: Boolean(execution.parsed.finalText),
    hasToolEvents: (execution.parsed.summary || []).some((e) => /tool|function/i.test(String(e.type || ""))),
    healthOutcome
  };
}

function resolveFailoverIds(capsule, registry) {
  if (!capsule.failover || capsule.failover.switchPermission !== "allowed") return [];
  if (Array.isArray(capsule.failover.allowedFallbackProfileIds)) {
    return capsule.failover.allowedFallbackProfileIds.slice();
  }
  if (Array.isArray(capsule.failover.allowedFallbackProfiles)) {
    return capsule.failover.allowedFallbackProfiles.map((alias) => {
      const p = registry.profiles.find((x) => x.alias === alias);
      return p ? p.profileId : null;
    }).filter(Boolean);
  }
  return [];
}

function runTask(alias, taskFile, options = {}) {
  const registry = loadRegistry();
  const input = typeof taskFile === "string"
    ? readJson(path.resolve(taskFile))
    : (isObject(taskFile) ? clone(taskFile) : null);
  assert(input, "TASK_INPUT", "run requires a task capsule file path or object.");
  if (!input.profile && !input.candidateProfileIds && alias) input.profile = alias;
  const capsule = validateTaskCapsule(input, registry);
  assert(capsule.realRequestPermission === "allowed", "REAL_REQUEST_DENIED", "run requires realRequestPermission=allowed and fails before spawn.");
  if (typeof options.baselineCheckFn === "function") options.baselineCheckFn(capsule);
  else baselineCheck(capsule);

  const deps = availabilityDeps();
  const runId = options.runId || crypto.randomUUID();
  const runOwner = options.runOwner || captureRunOwner();
  let taskRun = availability.emptyTaskRun(capsule.taskId, runId, runOwner);
  taskRun = availability.writeTaskRun(DATA_ROOT, taskRun, deps);

  const probePolicy = availability.normalizeProbePolicy(capsule.probePolicy);
  // Self-rescue only when explicit probePolicy authorizes when-no-active probes.
  // Workload realRequestPermission alone never enables probeEligible selection.
  const allowProbeSelection = availability.probeSelfRescueAllowed(probePolicy, {
    allowProbeSelection: true,
    probesUsed: 0,
    maxProbesPerRun: probePolicy.maxProbesPerRun
  });
  let probesUsed = 0;

  // 1–2: selection lock → choose profile + reservation; WAL → running
  // Lock order: selection → profile → workspace (release selection only after profile reserved).
  const selectionLock = acquireLock("selection", [capsule.taskId], DATA_ROOT, 5 * 60 * 1000);
  let selectionEvidence;
  let selectedProfile;
  try {
    const candidateSets = availability.buildCandidateSets(registry, capsule, DATA_ROOT, deps);
    const selection = availability.selectProfile(candidateSets, {
      allowProbeSelection,
      probesUsed,
      maxProbesPerRun: probePolicy.maxProbesPerRun
    });
    assert(selection.ok, "NO_ELIGIBLE_PROFILE", selection.reason || "No eligible profile for run.", selection.selectionEvidence || {});
    selectedProfile = registry.profiles.find((p) => p.profileId === selection.selected.profileId);
    assert(selectedProfile, "PROFILE_NOT_FOUND", "Selected profile missing from registry.");
    selectionEvidence = selection.selectionEvidence;
    if (selectionEvidence.selectionClass === "probeEligible") {
      probesUsed += 1;
      assert(
        probesUsed <= probePolicy.maxProbesPerRun,
        "MAX_PROBES_PER_RUN",
        "maxProbesPerRun exceeded for probe self-rescue.",
        { probesUsed, maxProbesPerRun: probePolicy.maxProbesPerRun }
      );
    }
    taskRun.status = "running";
    taskRun.finalSelectedProfileId = selectedProfile.profileId;
    taskRun = availability.writeTaskRun(DATA_ROOT, taskRun, deps);
  } catch (error) {
    selectionLock.release();
    taskRun.status = "failed";
    taskRun = availability.writeTaskRun(DATA_ROOT, taskRun, deps);
    throw error;
  }

  const attempts = [];
  const tried = new Set();
  let currentProfile = selectedProfile;
  let currentSelectionClass = selectionEvidence.selectionClass || "workloadEligible";
  let finalAttempt = null;
  let takeoverRequired = false;
  const fallbackIds = resolveFailoverIds(capsule, registry);
  let selectionHeld = true;

  while (currentProfile && !tried.has(currentProfile.profileId)) {
    tried.add(currentProfile.profileId);
    // Hand off: keep selection until first profile lock inside attempt, then release.
    const attempt = runSingleAttempt(capsule, registry, currentProfile, {
      ...selectionEvidence,
      finalSelectedProfileId: currentProfile.profileId,
      attemptIndex: attempts.length,
      selectionClass: currentSelectionClass,
      probesUsed
    }, {
      ...options,
      onProfileLockAcquired: () => {
        if (selectionHeld) {
          selectionLock.release();
          selectionHeld = false;
        }
      }
    });
    finalAttempt = attempt;
    const resultRef = resultPath(capsule.taskId, attempt.result.invocationId);
    attempts.push({
      invocationId: attempt.result.invocationId,
      profileId: attempt.result.profileId,
      resultRef: path.relative(DATA_ROOT, resultRef).replace(/\\/g, "/"),
      status: attempt.result.status,
      errorType: attempt.classification && attempt.classification.errorType || null,
      selectionClass: currentSelectionClass
    });
    taskRun.attempts = attempts.slice();
    taskRun.finalSelectedProfileId = currentProfile.profileId;
    taskRun.finalResultRef = attempts[attempts.length - 1].resultRef;
    taskRun = availability.writeTaskRun(DATA_ROOT, taskRun, deps);

    if (attempt.result.status === "completed") break;

    const failoverGate = availability.mayAutoFailoverAttempt({
      errorClassification: attempt.classification,
      boundaryCompliance: attempt.result.boundaryCompliance,
      hasToolEvents: attempt.hasToolEvents,
      hasOutput: attempt.hasOutput
    });
    if (!failoverGate.allowed) {
      if (failoverGate.takeoverRequired) takeoverRequired = true;
      break;
    }
    // only auto next worker when capsule failover whitelist allows and clean 402
    const may = mayFailover(capsule, {
      requestsSent: attempts.length,
      changedFiles: (attempt.result.boundaryCompliance.changedFilesFinalState || []).length,
      controllerContinuation: false,
      lastVerifiedPoint: null
    }, currentProfile.alias);
    // For profileId whitelist path, check ids
    const idAllowed = fallbackIds.includes(currentProfile.profileId)
      ? false // current already used
      : fallbackIds.some((id) => !tried.has(id));
    const aliasAllowed = may.allowed;
    if (!idAllowed && !aliasAllowed) break;
    if (capsule.failover && capsule.failover.mode === "controller-continuation") {
      takeoverRequired = true;
      break;
    }
    const nextId = fallbackIds.find((id) => !tried.has(id));
    let nextProfile = null;
    if (!nextId) {
      // legacy alias list
      if (capsule.failover && Array.isArray(capsule.failover.allowedFallbackProfiles)) {
        const nextAlias = capsule.failover.allowedFallbackProfiles.find((a) => {
          const p = registry.profiles.find((x) => x.alias === a);
          return p && !tried.has(p.profileId);
        });
        if (!nextAlias) break;
        nextProfile = registry.profiles.find((x) => x.alias === nextAlias);
      } else break;
    } else {
      nextProfile = registry.profiles.find((x) => x.profileId === nextId);
    }
    if (!nextProfile) break;

    // If next worker is only probeEligible (no active), enforce maxProbesPerRun.
    const nextRecord = availability.loadAvailability(DATA_ROOT, nextProfile.profileId, deps);
    const nextElig = availability.evaluateEligibility(nextRecord);
    if (nextElig.eligibility === "excluded") break;
    if (nextElig.eligibility === "probeEligible") {
      if (!allowProbeSelection || probesUsed >= probePolicy.maxProbesPerRun) break;
      probesUsed += 1;
      currentSelectionClass = "probeEligible";
    } else {
      currentSelectionClass = "workloadEligible";
    }
    currentProfile = nextProfile;
    // never reuse prior Grok session across failover accounts
    capsule.grokSessionId = null;
  }

  if (selectionHeld) {
    selectionLock.release();
    selectionHeld = false;
  }

  taskRun.status = finalAttempt && finalAttempt.result.status === "completed" ? "completed" : "failed";
  taskRun.takeoverRequired = takeoverRequired;
  taskRun.attempts = attempts;
  taskRun.probesUsed = probesUsed;
  if (finalAttempt) {
    taskRun.finalSelectedProfileId = finalAttempt.result.profileId;
    taskRun.finalResultRef = attempts.length ? attempts[attempts.length - 1].resultRef : null;
  }
  taskRun = availability.writeTaskRun(DATA_ROOT, taskRun, deps);

  return {
    result: finalAttempt ? finalAttempt.result : null,
    ledger: finalAttempt ? finalAttempt.ledger : null,
    taskRun,
    attempts,
    probesUsed
  };
}

function planTask(alias, taskFile) {
  const registry = loadRegistry();
  const input = readJson(path.resolve(taskFile));
  if (!input.profile && !input.candidateProfileIds && alias) input.profile = alias;
  const capsule = validateTaskCapsule(input, registry);
  const deps = availabilityDeps();
  const candidateSets = availability.buildCandidateSets(registry, capsule, DATA_ROOT, deps);
  // plan is always zero real requests — never authorize probe selection here.
  const selection = availability.selectProfile(candidateSets, { allowProbeSelection: false });
  const profile = selection.ok
    ? registry.profiles.find((x) => x.profileId === selection.selected.profileId)
    : (capsule.profile ? registry.profiles.find((x) => x.alias === capsule.profile) : registry.profiles[0]);
  assert(profile, "PROFILE_NOT_FOUND", "No profile available for plan.");
  const template = planTemplate(capsule, profile);
  return {
    spawnCount: 0,
    planTemplate: template,
    selectionMode: candidateSets.selectionMode,
    candidateProfileIds: candidateSets.candidates.map((c) => c.profileId),
    skippedReasons: candidateSets.skippedReasons,
    maintenanceProbePlanned: candidateSets.maintenanceProbePlanned,
    probePolicy: candidateSets.probePolicy,
    // Informative only: would run authorize self-rescue under these flags
    probeSelfRescueWouldAuthorize: availability.probeSelfRescueAllowed(candidateSets.probePolicy, {
      allowProbeSelection: true,
      probesUsed: 0
    }) && candidateSets.workloadEligible.length === 0 && candidateSets.probeEligible.length > 0,
    capsule: {
      taskId: capsule.taskId,
      stage: capsule.stage,
      profile: capsule.profile || null,
      candidateProfileIds: capsule.candidateProfileIds || null
    }
  };
}

function lockHelperDeps(extra = {}) {
  return {
    lockRoot: LOCK_ROOT,
    auditPath: path.join(DATA_ROOT, "locks-cleanup.jsonl"),
    ensureDir,
    readJson,
    atomicWriteJson,
    appendJsonLineAtomic,
    now,
    nowMs: () => Date.now(),
    isObject,
    normalizeCase,
    patternsOverlap,
    assert,
    queryProcessStartTicks,
    ...extra
  };
}

function inspectLockOwner(owner, dependencies = {}) {
  return locks.inspectLockOwner(owner, lockHelperDeps(dependencies));
}

function acquireLock(scope, patterns, root, leaseMs = 30000, dependencies = {}) {
  return locks.acquireLock(scope, patterns, root, leaseMs, lockHelperDeps(dependencies));
}

function inspectLocks(dependencies = {}) {
  return locks.inspectLocks(lockHelperDeps(dependencies));
}

function cleanupLock(lockId, confirmation, dependencies = {}) {
  return locks.cleanupLock(lockId, confirmation, lockHelperDeps(dependencies));
}

function mayFailover(capsule, state, fallback) {
  if (!capsule.failover || capsule.failover.switchPermission !== "allowed") {
    return { allowed: false, reason: "not-whitelisted" };
  }
  const aliasList = Array.isArray(capsule.failover.allowedFallbackProfiles)
    ? capsule.failover.allowedFallbackProfiles
    : [];
  const idList = Array.isArray(capsule.failover.allowedFallbackProfileIds)
    ? capsule.failover.allowedFallbackProfileIds
    : [];
  const aliasOk = aliasList.includes(fallback);
  // fallback may be alias; id path checked by caller
  if (!aliasOk && idList.length === 0) return { allowed: false, reason: "not-whitelisted" };
  if (!aliasOk && idList.length > 0 && !UUID.test(fallback) && !aliasList.length) {
    // allow when using id-based list and caller already validated id membership
  } else if (!aliasOk && aliasList.length) {
    return { allowed: false, reason: "not-whitelisted" };
  }
  if (capsule.failover.mode === "pre-first-request-only") {
    // attempts already counted as requests; allow sequential clean failover only with zero file changes
    return {
      allowed: state.changedFiles === 0,
      reason: state.changedFiles === 0 ? "clean-failover" : "partial-run"
    };
  }
  if (capsule.failover.mode === "controller-continuation") {
    return {
      allowed: Boolean(state.controllerContinuation && state.lastVerifiedPoint),
      reason: state.controllerContinuation ? "controller-continuation" : "missing-continuation"
    };
  }
  return { allowed: false, reason: "invalid-mode" };
}
function recordSnapshot(alias, snapshot) {
  const registry = loadRegistry(); const profile = registry.profiles.find((x) => x.alias === alias); assert(profile, "PROFILE_NOT_FOUND", "Profile not found.");
  const allowedStatus = ["verified", "mismatch", "unbound", "unsupported"];
  assert(isObject(snapshot) && allowedStatus.includes(snapshot.accountBinding), "SNAPSHOT_BINDING", "Snapshot requires an honest accountBinding.");
  if (snapshot.accountBinding !== "verified") snapshot = { source: snapshot.source || "manual", capturedAt: snapshot.capturedAt || now(), accountBinding: snapshot.accountBinding, profileId: profile.profileId, status: snapshot.accountBinding, metrics: {} };
  else snapshot = { source: snapshot.source, capturedAt: snapshot.capturedAt || now(), accountBinding: "verified", profileId: profile.profileId, status: "captured", metrics: snapshot.metrics || {} };
  assert(Object.values(snapshot.metrics).every((v) => typeof v === "number" || v === null), "SNAPSHOT_NUMERIC", "Official snapshot metrics must be numeric or null.");
  appendJsonLineAtomic(path.join(SNAPSHOT_ROOT, profile.profileId, "snapshots.jsonl"), snapshot); return snapshot;
}
function profileList() {
  const registry = loadRegistry();
  return {
    approvedProfileRoot: registry.approvedProfileRoot,
    profiles: registry.profiles.map((profile) => ({
      profileId: profile.profileId,
      alias: profile.alias,
      accountLabel: profile.accountLabel || profile.alias,
      oauthReady: profile.authReadiness && profile.authReadiness.oauthReady === true,
      identityStatus: profile.identity && profile.identity.identityStatus || "unknown",
      models: Array.isArray(profile.modelSnapshot && profile.modelSnapshot.models) ? profile.modelSnapshot.models : [],
      checkedAt: profile.modelSnapshot && profile.modelSnapshot.checkedAt || null
    }))
  };
}
function usageShow(filters = {}) {
  ensureDir(LEDGER_ROOT); const ledgers = fs.readdirSync(LEDGER_ROOT, { withFileTypes: true }).filter((x) => x.isFile() && x.name.endsWith(".json")).map((x) => readJson(path.join(LEDGER_ROOT, x.name)));
  const filtered = ledgers.filter((ledger) => !filters.task || ledger.taskId === filters.task).map((ledger) => {
    if (!filters.profile) return ledger;
    const registry = loadRegistry(); const profile = registry.profiles.find((x) => x.alias === filters.profile || x.profileId === filters.profile); if (!profile) return null;
    const copy = clone(ledger); copy.invocations = copy.invocations.filter((x) => x.profileId === profile.profileId); return rebuildLayers(copy);
  }).filter(Boolean);
  return { note: "runUsage is server-returned usage for each invocation; it is not official account quota.", ledgers: filtered };
}
function rootsCommand(action, value) {
  const registry = loadRegistry();
  if (action === "register") { const resolved = validateWindowsPath(value, null, "root"); if (!registry.allowedWorkspaceRoots.some((x) => normalizeCase(x) === normalizeCase(resolved))) registry.allowedWorkspaceRoots.push(resolved); saveRegistry(registry); return { registered: resolved }; }
  if (action === "inspect") { const resolved = validateWindowsPath(value, null, "root"); return { path: resolved, registered: registry.allowedWorkspaceRoots.some((x) => within(resolved, x)), reparseFree: true }; }
  return { allowedWorkspaceRoots: registry.allowedWorkspaceRoots };
}
function poolStatus() {
  // Zero real Grok requests — local ledger + availability metadata only.
  const registry = loadRegistry();
  const ledgers = usageShow({}).ledgers;
  const usageByProfileId = {};
  for (const ledger of ledgers) {
    for (const [profileId, summary] of Object.entries(ledger.layers && ledger.layers.byProfileId || {})) {
      const current = usageByProfileId[profileId] || { total_tokens: 0, invocationsCounted: 0, invocationsUnknown: 0 };
      current.total_tokens += summary.total_tokens || 0;
      current.invocationsCounted += summary.invocationsCounted || 0;
      current.invocationsUnknown += summary.invocationsUnknown || 0;
      usageByProfileId[profileId] = current;
    }
  }
  const deps = availabilityDeps();
  const baseProfiles = profileList().profiles.map((profile) => ({
    ...profile,
    usage: usageByProfileId[profile.profileId] || { total_tokens: 0, invocationsCounted: 0, invocationsUnknown: 0 }
  }));
  const health = availability.loadProviderHealth(DATA_ROOT, deps);
  return {
    providerVersion: VERSION,
    registryPath: REGISTRY_PATH,
    dataRoot: DATA_ROOT,
    approvedProfileRoot: registry.approvedProfileRoot,
    profiles: availability.poolStatusEnrichment(baseProfiles, DATA_ROOT, deps),
    providerHealth: {
      status: health.status,
      consecutiveNonAttributableFailures: health.consecutiveNonAttributableFailures,
      lastError: health.lastError,
      updatedAt: health.updatedAt
    },
    deploy: {
      pointerPath: CURRENT_POINTER_PATH,
      rootsSource: DEPLOY_ROOTS_META && DEPLOY_ROOTS_META.source,
      pointerVersion: DEPLOY_ROOTS_META && DEPLOY_ROOTS_META.pointer && DEPLOY_ROOTS_META.pointer.version || null
    },
    roots: registry.allowedWorkspaceRoots.slice(),
    doctor: doctor(),
    realRequests: 0
  };
}

function bootstrapAvailabilityCommand(options = {}) {
  const registry = loadRegistry();
  return availability.bootstrapAvailability(registry, {
    dataRoot: DATA_ROOT,
    frozenProfileIds: options.frozenProfileIds || [],
    recentSuccessProfileIds: options.recentSuccessProfileIds || [],
    force: options.force === true
  }, availabilityDeps());
}

function poolRefresh(options = {}) {
  // Maintenance probe only when probePolicy.realRequestPermission=allowed explicitly.
  const real = options.real === "allowed" || options.realRequestPermission === "allowed";
  if (!real) {
    return {
      refreshed: false,
      realRequests: 0,
      note: "pool refresh default is dry; pass --real allowed to authorize maintenance probes",
      probePolicy: availability.defaultProbePolicy()
    };
  }
  // Live probe path is opt-in and still uses isolatedEnv; not invoked by mock suite.
  const registry = loadRegistry();
  const deps = availabilityDeps();
  const results = [];
  for (const profile of registry.profiles) {
    const record = availability.loadAvailability(DATA_ROOT, profile.profileId, deps);
    const eligibility = availability.evaluateEligibility(record);
    if (eligibility.eligibility !== "probeEligible") {
      results.push({ profileId: profile.profileId, skipped: true, reason: eligibility.reason });
      continue;
    }
    results.push({
      profileId: profile.profileId,
      skipped: false,
      note: "caller must use profiles probe / controlled canary; provider does not auto-spawn here without explicit profile probe command",
      eligibility: eligibility.eligibility
    });
  }
  return { refreshed: true, realAuthorized: true, realRequests: 0, results, note: "selection-only refresh; use profiles probe under separate explicit authorization for real models probe" };
}

function readDeployPointer() {
  const rootMeta = {
    dataRoot: DATA_ROOT,
    registryPath: REGISTRY_PATH,
    approvedProfileRoot: APPROVED_PROFILE_ROOT,
    source: DEPLOY_ROOTS_META && DEPLOY_ROOTS_META.source
  };
  try {
    const pointer = availability.readCurrentPointer(CURRENT_POINTER_PATH, { readJson });
    if (!pointer) {
      return {
        present: false,
        path: CURRENT_POINTER_PATH,
        roots: rootMeta,
        note: "No current.json; using env or Provider defaults under LOCALAPPDATA\\GrokWorkerProvider"
      };
    }
    const validation = availability.validateCurrentPointer(pointer, { requireRelease: false });
    return {
      present: true,
      path: CURRENT_POINTER_PATH,
      pointer,
      validation,
      roots: rootMeta,
      legacyResidues: DEPLOY_ROOTS_META && DEPLOY_ROOTS_META.legacyResidues || legacyResidueMeta(),
      note: "Pointer validated; dataRoot/registryPath/approvedProfileRoot are Provider-owned and pointer-driven; GrokUI paths are inert residues only"
    };
  } catch (error) {
    return {
      error: "CURRENT_POINTER_INVALID",
      path: CURRENT_POINTER_PATH,
      reason: error && error.reason || String(error.message || error),
      roots: rootMeta
    };
  }
}

function writeDeployPointer(meta) {
  const pointer = availability.buildCurrentPointer({
    version: meta.version || VERSION,
    releasePath: meta.releasePath || PROVIDER_DIR,
    previousVersion: meta.previousVersion || null,
    dataRoot: meta.dataRoot || DATA_ROOT,
    registryPath: meta.registryPath || REGISTRY_PATH,
    approvedProfileRoot: meta.approvedProfileRoot || APPROVED_PROFILE_ROOT,
    schemaVersions: meta.schemaVersions,
    manifestSha256: meta.manifestSha256 || null
  });
  const check = availability.validateCurrentPointer(pointer);
  assert(check.ok, "CURRENT_POINTER_INVALID", `Deploy pointer invalid: ${check.reason}`);
  ensureDir(path.dirname(CURRENT_POINTER_PATH));
  atomicWriteJson(CURRENT_POINTER_PATH, pointer);
  // Also persist versioned pointer under DATA_ROOT/deploy/pointers when sha present
  if (pointer.manifestSha256) {
    try {
      const versioned = {
        ...pointer,
        previousVersion: pointer.previousVersion,
        manifestSha256: pointer.manifestSha256,
        updatedAt: pointer.updatedAt || now()
      };
      const v6 = availability.validateDeployPointerV6(versioned);
      if (v6.ok) {
        ensureDir(DEPLOY_POINTERS_ROOT);
        atomicWriteJson(availability.deployPointerPath(DATA_ROOT, pointer.version), versioned);
      }
    } catch (_) { /* best-effort versioned pointer */ }
  }
  return pointer;
}

function poolConfigStatus() {
  const deps = availabilityDeps();
  const loaded = availability.loadPoolConfig(DATA_ROOT, deps);
  if (!loaded.present) {
    return {
      present: false,
      autoProbe: { enabled: false },
      authorization: { realRequestPermission: "denied", authorizedProfileIds: [] },
      auditSummary: [],
      realRequests: 0,
      note: "pool-config missing; treated as autoProbe.enabled=false"
    };
  }
  if (!loaded.valid) {
    throw new ProviderError("POOL_CONFIG_INVALID", `pool-config invalid: ${loaded.reason}`, { reason: loaded.reason }, 2);
  }
  const cfg = loaded.config;
  return {
    present: true,
    valid: true,
    revision: cfg.revision,
    updatedAt: cfg.updatedAt,
    autoProbe: cfg.autoProbe,
    authorization: {
      realRequestPermission: cfg.authorization.realRequestPermission,
      authorizationScope: cfg.authorization.authorizationScope,
      authorizedProfileIds: cfg.authorization.authorizedProfileIds.slice(),
      authorizedAt: cfg.authorization.authorizedAt,
      revokedAt: cfg.authorization.revokedAt
    },
    auditSummary: (cfg.auditLog || []).slice(-20),
    realRequests: 0
  };
}

function poolConfigAuthorize(options = {}) {
  const deps = availabilityDeps();
  const raw = options.profiles || options.profile || "";
  const ids = String(raw).split(/[;,]/).map((x) => x.trim()).filter(Boolean);
  assert(ids.length > 0, "POOL_CONFIG_PROFILES", "authorize requires --profiles <id;id>");
  for (const id of ids) {
    assert(UUID.test(id), "POOL_CONFIG_PROFILE_ID", `authorized profileId must be uuid: ${id}`);
  }
  const loaded = availability.loadPoolConfig(DATA_ROOT, deps);
  if (loaded.present && !loaded.valid) {
    throw new ProviderError("POOL_CONFIG_INVALID", `pool-config corrupt/invalid: ${loaded.reason}`, { reason: loaded.reason }, 2);
  }
  const base = loaded.present ? clone(loaded.config) : availability.defaultPoolConfig();
  const expected = loaded.present ? Number(base.revision) || 0 : 0;
  base.authorization = {
    realRequestPermission: "allowed",
    authorizationScope: "quota-maintenance-probe",
    authorizedProfileIds: Array.from(new Set(ids)),
    authorizedAt: now(),
    revokedAt: null
  };
  base.auditLog = (base.auditLog || []).concat([{
    at: now(),
    action: "authorize",
    actorNote: options.actorNote || "pool config authorize"
  }]);
  const cas = availability.writePoolConfigCas(DATA_ROOT, base, expected, deps);
  assert(cas.ok, cas.code || "POOL_CONFIG_CAS", "Failed to write pool-config authorize");
  return { ok: true, config: cas.config, realRequests: 0, path: availability.poolConfigPath(DATA_ROOT) };
}

function poolConfigRevoke(options = {}) {
  const deps = availabilityDeps();
  const loaded = availability.loadPoolConfig(DATA_ROOT, deps);
  if (loaded.present && !loaded.valid) {
    throw new ProviderError("POOL_CONFIG_INVALID", `pool-config corrupt/invalid: ${loaded.reason}`, { reason: loaded.reason }, 2);
  }
  const base = loaded.present ? clone(loaded.config) : availability.defaultPoolConfig();
  const expected = loaded.present ? Number(base.revision) || 0 : 0;
  base.authorization = {
    realRequestPermission: "denied",
    authorizationScope: "quota-maintenance-probe",
    authorizedProfileIds: [],
    authorizedAt: base.authorization && base.authorization.authorizedAt || null,
    revokedAt: now()
  };
  base.auditLog = (base.auditLog || []).concat([{
    at: now(),
    action: "revoke",
    actorNote: options.actorNote || "pool config revoke"
  }]);
  const cas = availability.writePoolConfigCas(DATA_ROOT, base, expected, deps);
  assert(cas.ok, cas.code || "POOL_CONFIG_CAS", "Failed to write pool-config revoke");
  return { ok: true, config: cas.config, realRequests: 0 };
}

function poolConfigAutoprobe(options = {}) {
  const enable = options.enable === true || options.enable === "true"
    || options._action === "enable";
  const disable = options.disable === true || options.disable === "true"
    || options._action === "disable";
  assert(enable !== disable, "POOL_CONFIG_AUTOPROBE", "autoprobe requires exactly one of --enable|--disable");
  const deps = availabilityDeps();
  const loaded = availability.loadPoolConfig(DATA_ROOT, deps);
  if (loaded.present && !loaded.valid) {
    throw new ProviderError("POOL_CONFIG_INVALID", `pool-config corrupt/invalid: ${loaded.reason}`, { reason: loaded.reason }, 2);
  }
  const base = loaded.present ? clone(loaded.config) : availability.defaultPoolConfig();
  const expected = loaded.present ? Number(base.revision) || 0 : 0;
  base.autoProbe = {
    ...base.autoProbe,
    enabled: enable
  };
  base.auditLog = (base.auditLog || []).concat([{
    at: now(),
    action: enable ? "autoprobe-enable" : "autoprobe-disable",
    actorNote: options.actorNote || `pool config autoprobe ${enable ? "enable" : "disable"}`
  }]);
  const cas = availability.writePoolConfigCas(DATA_ROOT, base, expected, deps);
  assert(cas.ok, cas.code || "POOL_CONFIG_CAS", "Failed to write pool-config autoprobe");
  return { ok: true, config: cas.config, realRequests: 0 };
}

/**
 * Migrate legacy quota nextProbeAt > now+4h (r8 §5). Zero real requests.
 */
function migrateQuotaNextProbeCaps(deps, nowMs = Date.now()) {
  const registry = loadRegistry();
  const results = [];
  for (const profile of registry.profiles || []) {
    const current = availability.loadAvailability(DATA_ROOT, profile.profileId, deps);
    const clamped = availability.clampQuotaNextProbeAt(current, nowMs);
    if (!clamped.changed) continue;
    const cas = availability.writeAvailabilityCas(
      DATA_ROOT, profile.profileId, clamped.record, current.revision, deps
    );
    results.push({
      profileId: profile.profileId,
      ok: cas.ok,
      nextProbeAt: cas.ok ? cas.record.nextProbeAt : current.nextProbeAt
    });
  }
  return results;
}

/**
 * Build availability + sidecar targets for a maintenance probe start (pre-spawn).
 * Early billing may set nextProbeAt=now (probe_due) but never grants active.
 */
function buildMaintenanceProbeTargets(profile, record, sidecar, options = {}) {
  const nowMs = options.nowMs || Date.now();
  const transactionAt = options.transactionAt || new Date(nowMs).toISOString();
  const billing = options.billing || null;
  const early = options.early || { eligible: false };
  let availTarget = clone(record);
  let sideTarget = availability.openOrRefreshFreezeEpisode(sidecar, record, billing, nowMs);

  if (early.eligible) {
    availTarget.state = "probe_due";
    availTarget.nextProbeAt = new Date(nowMs).toISOString();
    sideTarget.earlyBillingProbeConsumed = true;
    sideTarget.consumedBillingSignalId = early.billingSignalId;
    if (billing && billing.ts) sideTarget.lastBillingObservedAt = billing.ts;
  }

  availTarget.revision = record.revision + 1;
  availTarget.updatedAt = transactionAt;
  sideTarget.revision = sidecar.revision + 1;
  sideTarget.updatedAt = transactionAt;
  sideTarget.lastMaintenanceProbeAt = transactionAt;
  sideTarget.availabilityRevisionSeen = record.revision + 1;
  sideTarget.availabilityStateSeen = availTarget.state;
  return { availabilityTarget: availTarget, sidecarTarget: sideTarget };
}

/**
 * Apply probe outcome to availability (post-spawn). Reuses classifyError.
 * Success requires end+requestId+exit0+expectedResponseMatched → active.
 */
function applyMaintenanceProbeOutcome(record, classification, execution, options = {}) {
  const expectedMatched = options.expectedResponseMatched === true;
  const end = options.end === true;
  const requestId = options.requestId || null;
  const exitCode = execution && execution.status;

  if (exitCode === 0 && end && requestId && expectedMatched) {
    return {
      outcome: "recovered",
      record: availability.markActive(record, { evidenceSource: "maintenance-probe-success" }),
      classification: null
    };
  }
  if (!classification) {
    return { outcome: "inconclusive", record, classification: null };
  }
  if (classification.errorType === "quota_exhausted") {
    const applied = availability.applyClassificationToAvailability(record, classification, {
      profileId: record.profileId,
      evidenceSource: "maintenance-probe-402"
    });
    return { outcome: "still-exhausted", record: applied.record, classification };
  }
  if (classification.errorType === "reauth_required") {
    const applied = availability.applyClassificationToAvailability(record, classification, {
      profileId: record.profileId,
      evidenceSource: "maintenance-probe-401"
    });
    return { outcome: "reauth", record: applied.record, classification };
  }
  if (classification.errorType === "rate_limited" && classification.accountLevelEvidence) {
    const applied = availability.applyClassificationToAvailability(record, classification, {
      profileId: record.profileId,
      evidenceSource: "maintenance-probe-429"
    });
    return { outcome: "cooldown", record: applied.record, classification };
  }
  if (classification.errorType === "model_unavailable") {
    return { outcome: "no-op", record, classification };
  }
  return { outcome: "inconclusive", record, classification, providerHealthOnly: true };
}

/**
 * Execute one maintenance probe under isolatedEnv. Default path never runs without
 * standing authorization. Tests inject executeProbeFn for 100% mock.
 */
function executeMaintenanceProbe(profile, options = {}) {
  const invocationId = options.invocationId || crypto.randomUUID();
  const scratch = path.join(TEMP_ROOT, "maintenance", invocationId);
  ensureDir(scratch);
  const socket = path.join(scratch, "leader.sock");
  const sessionId = crypto.randomUUID();
  const probePlan = availability.buildMaintenanceProbeArgs(scratch, sessionId, socket);
  fs.writeFileSync(probePlan.promptPath, probePlan.promptText, { encoding: "utf8", mode: 0o600 });
  const env = isolatedEnv(profile, scratch, socket);
  verifyMaintenancePlanContract({
    executable: profile.executable, args: probePlan.args, env, settings: probePlan.settings,
    scratch, cwd: scratch, promptPath: probePlan.promptPath, socket, sessionId
  }, profile);
  assert(env.GROK_HOME === profile.grokHome, "PROBE_ISOLATION", "GROK_HOME must be profile.grokHome");
  assert(env.XAI_API_KEY === undefined, "PROBE_ISOLATION", "XAI_API_KEY must be stripped");
  assert(env.GROK_CLAUDE_HOOKS_ENABLED === "false", "PROBE_ISOLATION", "hooks must be disabled");
  assert(!probePlan.args.includes("--allow"), "PROBE_PLAN", "probe must not use bare --allow");
  assert(probePlan.args.includes("--max-turns") && probePlan.args[probePlan.args.indexOf("--max-turns") + 1] === "1", "PROBE_PLAN", "max-turns 1 required");

  let execution;
  if (typeof options.executeProbeFn === "function") {
    execution = options.executeProbeFn({
      profile, scratch, socket, sessionId, env, args: probePlan.args, promptPath: probePlan.promptPath
    });
  } else {
    execution = spawnCapture(profile.executable, probePlan.args, {
      cwd: scratch,
      env,
      timeout: options.timeoutMs || 120000
    });
    execution.parsed = parseStream(execution.stdout);
  }
  if (!execution.parsed) execution.parsed = parseStream(execution.stdout || "");

  const terminal = execution.parsed.terminal || null;
  const end = Boolean(terminal && (terminal.type === "end" || terminal));
  const requestId = terminal && terminal.requestId ? String(terminal.requestId) : null;
  const finalText = execution.parsed.finalText || "";
  const expectedResponseMatched = finalText.includes(availability.PROBE_EXPECT)
    || String(execution.stdout || "").includes(availability.PROBE_EXPECT);

  let classification = availability.classifyFromExecution(
    { status: execution.status, stderr: redactText(execution.stderr || ""), stdout: "" },
    { redactText }
  );
  if (execution.status === 0 && expectedResponseMatched && end && requestId) {
    classification = {
      errorType: null, statusCode: null, retryable: null, quotaKind: null,
      profileAttributable: false, accountLevelEvidence: false
    };
  }

  const runUsage = numericUsage(terminal && terminal.usage);
  let rawCleanup = "not-created";
  let rawCleanupFailed = false;
  try {
    if (fs.existsSync(probePlan.promptPath)) {
      fs.rmSync(probePlan.promptPath, { force: true });
      rawCleanup = "deleted";
    }
  } catch (_) {
    rawCleanup = "failed";
    rawCleanupFailed = true;
  }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) { /* best effort */ }

  return {
    invocationId,
    execution,
    classification,
    end: Boolean(end && terminal),
    requestId,
    exitCode: execution.status,
    expectedResponseMatched,
    usage: runUsage,
    rawCleanup,
    rawCleanupFailed,
    sessionId
  };
}

/**
 * pool maintenance tick — r8 automatic early-reset maintenance.
 * Default: mock-safe (gates closed → zero requests, exit 0 if config missing).
 */
function poolMaintenanceTick(options = {}) {
  const deps = availabilityDeps();
  const nowMs = options.nowMs || Date.now();
  const summary = {
    scanned: 0,
    billingEarlyHits: 0,
    probesStarted: 0,
    probeResults: [],
    slotsUsed: 0,
    skipped: [],
    migrations: [],
    reconciliations: [],
    realRequests: 0,
    gates: {}
  };

  const loaded = availability.loadPoolConfig(DATA_ROOT, deps);
  if (!loaded.present) {
    return {
      ...summary,
      ok: true,
      exitHint: 0,
      note: "pool-config missing; treated as enabled:false; zero requests"
    };
  }
  if (!loaded.valid) {
    throw new ProviderError(
      "POOL_CONFIG_INVALID",
      `pool-config corrupt/invalid: ${loaded.reason}`,
      { reason: loaded.reason },
      2
    );
  }
  const config = loaded.config;
  summary.gates = {
    autoProbeEnabled: config.autoProbe.enabled === true,
    realRequestPermission: config.authorization.realRequestPermission,
    authorizedCount: (config.authorization.authorizedProfileIds || []).length
  };

  if (config.autoProbe.enabled !== true) {
    return {
      ...summary,
      ok: true,
      exitHint: 0,
      note: "autoProbe.enabled=false; zero requests",
      skipped: [{ reason: "autoProbe-disabled" }]
    };
  }
  if (config.authorization.realRequestPermission !== "allowed") {
    throw new ProviderError(
      "MAINTENANCE_AUTH_DENIED",
      "autoProbe enabled but realRequestPermission is not allowed",
      { realRequestPermission: config.authorization.realRequestPermission },
      2
    );
  }
  if (!config.authorization.authorizedProfileIds || config.authorization.authorizedProfileIds.length < 1) {
    throw new ProviderError(
      "MAINTENANCE_AUTH_EMPTY",
      "autoProbe enabled but authorizedProfileIds is empty",
      {},
      2
    );
  }

  const schedulerLock = acquireLock("scheduler", ["maintenance-tick"], DATA_ROOT, 15 * 60 * 1000);
  try {
    summary.reconciliations = availability.reconcileMaintenanceRuns(DATA_ROOT, deps);
    summary.migrations = migrateQuotaNextProbeCaps(deps, nowMs);

    const registry = loadRegistry();
    const selection = availability.selectMaintenanceCandidates(registry, config, DATA_ROOT, deps, nowMs);
    summary.scanned = selection.scanned;
    summary.skipped = selection.skipped.slice();

    for (const candidate of selection.selected) {
      const profile = candidate.profile;
      let profileLock;
      let rateLock;
      try {
        profileLock = acquireLock("profile", [profile.grokHome], profile.grokHome, 15 * 60 * 1000);
        rateLock = acquireLock("rate-window", ["global"], DATA_ROOT, 15 * 60 * 1000);

        const record = availability.loadAvailability(DATA_ROOT, profile.profileId, deps);
        let sidecar = availability.loadMaintenanceProfile(DATA_ROOT, profile.profileId, deps);
        const billing = availability.readBillingSnapshot(profile.grokHome, deps);
        if (record.state === "frozen" && record.scope === "quota") {
          sidecar = availability.openOrRefreshFreezeEpisode(sidecar, record, billing, nowMs);
        }
        const early = availability.evaluateEarlyBillingProbe(sidecar, billing);
        if (early.eligible) summary.billingEarlyHits += 1;

        const targets = buildMaintenanceProbeTargets(profile, record, sidecar, {
          nowMs, billing, early
        });

        const maintenanceTaskId = `quota-probe-${profile.profileId}`;
        const invocationId = crypto.randomUUID();
        let journal = availability.emptyMaintenanceRun({
          maintenanceTaskId,
          maintenanceInvocationId: invocationId,
          profileId: profile.profileId,
          operation: "start-probe",
          phase: "intent",
          status: "running",
          availabilityBefore: clone(record),
          availabilityTarget: targets.availabilityTarget,
          sidecarBefore: clone(sidecar),
          sidecarTarget: targets.sidecarTarget,
          tokenSlotTs: null,
          billingSignalId: early.billingSignalId || null
        });
        journal = availability.writeMaintenanceRun(DATA_ROOT, journal, deps);

        const slot = availability.tryReserveRateSlot(DATA_ROOT, deps, nowMs);
        if (!slot.ok) {
          journal.status = "failed";
          journal.slotFailure = slot.reason;
          availability.writeMaintenanceRun(DATA_ROOT, journal, deps);
          summary.skipped.push({ profileId: profile.profileId, reason: slot.reason });
          continue;
        }
        summary.slotsUsed += 1;
        journal.tokenSlotTs = slot.tokenSlotTs;
        journal = availability.writeMaintenanceRun(DATA_ROOT, journal, deps);

        const availCas = availability.writeAvailabilityCas(
          DATA_ROOT, profile.profileId, targets.availabilityTarget, record.revision, deps, { preserveTarget: true }
        );
        if (!availCas.ok) {
          journal.status = "interrupted";
          journal.phase = "intent";
          availability.writeMaintenanceRun(DATA_ROOT, journal, deps);
          summary.skipped.push({ profileId: profile.profileId, reason: "availability-cas-conflict" });
          continue;
        }
        journal.phase = "availability-committed";
        journal = availability.writeMaintenanceRun(DATA_ROOT, journal, deps);

        const sideCas = availability.writeMaintenanceProfileCas(
          DATA_ROOT, profile.profileId, targets.sidecarTarget, sidecar.revision, deps, { preserveTarget: true }
        );
        if (!sideCas.ok) {
          journal.status = "interrupted";
          journal.phase = "availability-committed";
          availability.writeMaintenanceRun(DATA_ROOT, journal, deps);
          summary.skipped.push({ profileId: profile.profileId, reason: "sidecar-cas-conflict" });
          continue;
        }
        journal.phase = "sidecar-committed";
        journal.sidecarTarget = sideCas.record;
        journal = availability.writeMaintenanceRun(DATA_ROOT, journal, deps);

        // This durable edge is the no-replay boundary. Recovery may finish a
        // pre-spawn transaction, but it must never manufacture a second call.
        journal.requestStartedAt = new Date(nowMs).toISOString();
        journal.phase = "request-started";
        journal = availability.writeMaintenanceRun(DATA_ROOT, journal, deps);
        summary.probesStarted += 1;
        summary.realRequests += typeof options.executeProbeFn === "function" ? 0 : 1;
        const probe = executeMaintenanceProbe(profile, {
          invocationId,
          executeProbeFn: options.executeProbeFn,
          timeoutMs: options.timeoutMs || 120000
        });

        const postRecord = availability.loadAvailability(DATA_ROOT, profile.profileId, deps);
        const outcome = applyMaintenanceProbeOutcome(postRecord, probe.classification, probe.execution, {
          expectedResponseMatched: probe.expectedResponseMatched,
          end: probe.end,
          requestId: probe.requestId
        });

        const ledgerTaskId = maintenanceTaskId;
        recordInvocation(ledgerTaskId, {
          invocationId,
          sessionId: probe.sessionId,
          requestId: probe.requestId || `unknown-${invocationId}`,
          variant: "maintenance-quota-probe",
          profileId: profile.profileId,
          profileAlias: profile.alias,
          accountIdentitySnapshot: clone(profile.identity || {}),
          runUsage: probe.usage,
          quotaSignal: {
            outcome: outcome.outcome,
            errorType: probe.classification && probe.classification.errorType || null
          }
        });

        const result = {
          maintenanceInvocationId: invocationId,
          profileId: profile.profileId,
          outcome: outcome.outcome,
          errorClassification: probe.classification && probe.classification.errorType
            ? {
              errorType: probe.classification.errorType,
              statusCode: probe.classification.statusCode,
              retryable: probe.classification.retryable,
              quotaKind: probe.classification.quotaKind,
              profileAttributable: probe.classification.profileAttributable
            }
            : null,
          end: probe.end,
          requestId: probe.requestId,
          exitCode: probe.exitCode,
          expectedResponseMatched: probe.expectedResponseMatched,
          usage: probe.usage,
          redaction: {
            applied: true,
            rawStreamDeleted: probe.rawCleanup === "deleted",
            rawCleanupFailed: probe.rawCleanupFailed
          },
          rawCleanup: probe.rawCleanup,
          walFinalState: "completed"
        };
        const resultFile = path.join(RESULT_ROOT, "maintenance", profile.profileId, `${invocationId}.json`);
        ensureDir(path.dirname(resultFile));
        atomicWriteJson(resultFile, result);

        // Results and usage are durable before classification changes either
        // availability file. The outcome itself gets a second full intent.
        if (outcome.providerHealthOnly && probe.classification) {
          availability.recordProviderHealth(DATA_ROOT, {
            errorType: probe.classification.errorType,
            statusCode: probe.classification.statusCode,
            taskId: maintenanceTaskId,
            invocationId,
            profileId: profile.profileId
          }, deps);
        } else if (outcome.record && outcome.outcome !== "no-op" && outcome.outcome !== "inconclusive") {
          const availabilityBefore = availability.loadAvailability(DATA_ROOT, profile.profileId, deps);
          const sidecarBefore = availability.loadMaintenanceProfile(DATA_ROOT, profile.profileId, deps);
          const transactionAt = new Date(nowMs).toISOString();
          const availabilityTarget = clone(outcome.record);
          availabilityTarget.revision = availabilityBefore.revision + 1;
          availabilityTarget.updatedAt = transactionAt;
          let sidecarTarget = outcome.outcome === "recovered"
            ? availability.clearFreezeEpisode(sidecarBefore)
            : clone(sidecarBefore);
          sidecarTarget.revision = sidecarBefore.revision + 1;
          sidecarTarget.updatedAt = transactionAt;
          sidecarTarget.availabilityRevisionSeen = availabilityTarget.revision;
          sidecarTarget.availabilityStateSeen = availabilityTarget.state;
          const resultTransaction = availability.emptyMaintenanceRun({
            maintenanceTaskId,
            maintenanceInvocationId: crypto.randomUUID(),
            profileId: profile.profileId,
            operation: outcome.outcome === "recovered" ? "activate" : "freeze",
            phase: "intent",
            status: "running",
            availabilityBefore,
            availabilityTarget,
            sidecarBefore,
            sidecarTarget,
            resultRef: resultFile,
            ledgerRef: ledgerPath(ledgerTaskId)
          });
          let resultJournal = availability.writeMaintenanceRun(DATA_ROOT, resultTransaction, deps);
          const resultAvailabilityCas = availability.writeAvailabilityCas(DATA_ROOT, profile.profileId, availabilityTarget, availabilityBefore.revision, deps, { preserveTarget: true });
          if (!resultAvailabilityCas.ok) {
            resultJournal.status = "interrupted";
            availability.writeMaintenanceRun(DATA_ROOT, resultJournal, deps);
          } else {
            resultJournal.phase = "availability-committed";
            resultJournal = availability.writeMaintenanceRun(DATA_ROOT, resultJournal, deps);
            const resultSidecarCas = availability.writeMaintenanceProfileCas(DATA_ROOT, profile.profileId, sidecarTarget, sidecarBefore.revision, deps, { preserveTarget: true });
            if (!resultSidecarCas.ok) {
              resultJournal.status = "interrupted";
              availability.writeMaintenanceRun(DATA_ROOT, resultJournal, deps);
            } else {
              resultJournal.phase = "sidecar-committed";
              resultJournal = availability.writeMaintenanceRun(DATA_ROOT, resultJournal, deps);
              resultJournal.phase = "finalized";
              resultJournal.status = "completed";
              resultJournal = availability.writeMaintenanceRun(DATA_ROOT, resultJournal, deps);
            }
          }
        }

        journal.phase = "finalized";
        journal.status = "completed";
        journal.resultRef = resultFile;
        journal.ledgerRef = ledgerPath(ledgerTaskId);
        availability.writeMaintenanceRun(DATA_ROOT, journal, deps);

        summary.probeResults.push({
          profileId: profile.profileId,
          outcome: outcome.outcome,
          earlyBilling: early.eligible,
          invocationId
        });
      } catch (error) {
        summary.skipped.push({
          profileId: profile.profileId,
          reason: error && error.code || "probe-error",
          message: error && error.safeMessage || error.message
        });
      } finally {
        if (rateLock) rateLock.release();
        if (profileLock) profileLock.release();
      }
    }
  } finally {
    schedulerLock.release();
  }

  return { ...summary, ok: true, exitHint: 0 };
}

function deployList() {
  ensureDir(DEPLOY_POINTERS_ROOT);
  const versions = [];
  if (fs.existsSync(DEPLOY_POINTERS_ROOT)) {
    for (const name of fs.readdirSync(DEPLOY_POINTERS_ROOT).filter((n) => n.endsWith(".json"))) {
      try {
        const value = readJson(path.join(DEPLOY_POINTERS_ROOT, name));
        const check = availability.validateDeployPointerV6(value);
        versions.push({
          version: value.version,
          file: name,
          valid: check.ok,
          releasePath: value.releasePath,
          previousVersion: value.previousVersion,
          updatedAt: value.updatedAt
        });
      } catch (_) {
        versions.push({ file: name, valid: false });
      }
    }
  }
  let current = null;
  try {
    current = availability.readCurrentPointer(CURRENT_POINTER_PATH, { readJson });
  } catch (_) {
    current = null;
  }
  return {
    pointersRoot: DEPLOY_POINTERS_ROOT,
    currentVersion: current && current.version || null,
    versions,
    realRequests: 0
  };
}

function deployRollback(options = {}) {
  const toVersion = options.to || options.version;
  assert(toVersion, "DEPLOY_ROLLBACK_VERSION", "deploy rollback requires --to <version>");
  const pointerFile = availability.deployPointerPath(DATA_ROOT, toVersion);
  assert(fs.existsSync(pointerFile), "DEPLOY_POINTER_MISSING", `No deploy pointer for version ${toVersion}`, { pointerFile });
  const pointer = readJson(pointerFile);
  const shape = availability.validateDeployPointerV6(pointer);
  assert(shape.ok, "DEPLOY_POINTER_INVALID", `Deploy pointer invalid: ${shape.reason}`);
  assert(fs.existsSync(pointer.releasePath), "DEPLOY_RELEASE_MISSING", "releasePath does not exist", {
    releasePath: pointer.releasePath
  });
  const manifestPath = path.join(pointer.releasePath, "release-manifest.json");
  assert(fs.existsSync(manifestPath), "DEPLOY_MANIFEST_MISSING", "release-manifest.json missing in releasePath");
  const manifest = readJson(manifestPath);
  const manifestSha = typeof manifest.sha256 === "string"
    ? manifest.sha256
    : (typeof manifest.manifestSha256 === "string" ? manifest.manifestSha256 : null);
  let fileSha = manifestSha;
  if (!fileSha) {
    const body = fs.readFileSync(manifestPath);
    fileSha = crypto.createHash("sha256").update(body).digest("hex");
  }
  assert(
    pointer.manifestSha256
      && fileSha
      && pointer.manifestSha256.toLowerCase() === String(fileSha).toLowerCase(),
    "DEPLOY_MANIFEST_MISMATCH",
    "manifestSha256 does not match release-manifest.json",
    { pointerSha: pointer.manifestSha256, fileSha }
  );
  ensureDir(path.dirname(CURRENT_POINTER_PATH));
  const currentPayload = {
    version: pointer.version,
    releasePath: pointer.releasePath,
    previousVersion: pointer.previousVersion,
    dataRoot: pointer.dataRoot,
    registryPath: pointer.registryPath,
    approvedProfileRoot: pointer.approvedProfileRoot || APPROVED_PROFILE_ROOT,
    schemaVersions: pointer.schemaVersions,
    manifestSha256: pointer.manifestSha256,
    updatedAt: now()
  };
  const check = availability.validateCurrentPointer(currentPayload);
  assert(check.ok, "CURRENT_POINTER_INVALID", `Rollback target invalid as current: ${check.reason}`);
  atomicWriteJson(CURRENT_POINTER_PATH, currentPayload);
  applyDeployRoots({ force: true });
  return {
    ok: true,
    rolledBackTo: pointer.version,
    currentPath: CURRENT_POINTER_PATH,
    pointer: currentPayload,
    realRequests: 0,
    note: "Rollback wrote current.json atomically; disable maintenance task before rollback in production"
  };
}

/**
 * Persist a versioned deploy pointer (and optionally backfill). Used by release tooling / tests.
 * Does not write machine-global current.json — only DATA_ROOT/deploy/pointers.
 */
function writeVersionedDeployPointer(meta) {
  const pointer = availability.buildCurrentPointer({
    version: meta.version,
    releasePath: meta.releasePath,
    previousVersion: meta.previousVersion || null,
    dataRoot: meta.dataRoot || DATA_ROOT,
    registryPath: meta.registryPath || REGISTRY_PATH,
    approvedProfileRoot: meta.approvedProfileRoot || APPROVED_PROFILE_ROOT,
    schemaVersions: meta.schemaVersions,
    manifestSha256: meta.manifestSha256
  });
  assert(pointer.manifestSha256, "DEPLOY_POINTER_SHA", "manifestSha256 is required for versioned pointer");
  const v6 = {
    ...pointer,
    previousVersion: pointer.previousVersion,
    manifestSha256: pointer.manifestSha256,
    updatedAt: pointer.updatedAt || now()
  };
  const check = availability.validateDeployPointerV6(v6);
  assert(check.ok, "DEPLOY_POINTER_INVALID", check.reason);
  ensureDir(DEPLOY_POINTERS_ROOT);
  atomicWriteJson(availability.deployPointerPath(DATA_ROOT, pointer.version), v6);
  return v6;
}

function taskInit(args = {}) {
  const registry = loadRegistry();
  const profileAlias = args.profile || (registry.profiles[0] && registry.profiles[0].alias);
  assert(profileAlias, "PROFILE_REQUIRED", "task init requires a registered profile.");
  const profile = registry.profiles.find((item) => item.alias === profileAlias || item.profileId === profileAlias);
  assert(profile, "PROFILE_NOT_FOUND", `Profile '${profileAlias}' is not registered.`);
  const workspace = validateWindowsPath(args.workspace || process.cwd(), null, "workspace");
  assert(registry.allowedWorkspaceRoots.some((root) => within(workspace, root)), "WORKSPACE_NOT_REGISTERED", "workspace is outside registered roots.", { workspace });
  const head = gitOutput(workspace, ["rev-parse", "HEAD"]);
  const baseCommit = head.status === 0 && FORTY_HEX.test(head.stdout.trim()) ? head.stdout.trim() : "0".repeat(40);
  const taskId = args.taskId || `grok-worker-${crypto.randomUUID()}`;
  const access = args.access === "workspace-write" ? "workspace-write" : "readonly";
  const allowed = args.allowed ? String(args.allowed).split(";").map((item) => item.trim()).filter(Boolean) : [access === "workspace-write" ? "**/*" : "."];
  const contextRefs = args.context ? String(args.context).split(";").map((item) => item.trim()).filter(Boolean) : ["."];
  const capsule = {
    taskId,
    stage: args.stage || "codex-worker",
    objective: args.objective || "Complete the delegated Codex worker task and return a concise Result Capsule.",
    baseCommit,
    workspace,
    worktree: { mode: access === "workspace-write" ? "exclusive-worktree" : "read-only-shared-checkout", path: workspace },
    allowedFiles: allowed,
    forbiddenActions: ["service control", "OAuth", "account switch", "delete data"],
    acceptanceCommands: ["controller verifies Result Capsule and usage ledger"],
    contextRefs,
    realRequestPermission: args.real === "allowed" || args.realRequestPermission === "allowed" ? "allowed" : "denied",
    serviceControlPermission: "denied",
    gitPermission: "read-only",
    grokSessionId: null,
    resumePolicy: { mode: "new-only", rule: "Never resume an unrelated session." },
    explicitStop: args.stop || "Return Result Capsule and stop.",
    model: args.model || DEFAULT_MODEL,
    reasoning: args.reasoning || "high",
    speed: "standard",
    profile: profile.alias,
    policy: { access, bash: "denied", agents: "denied", mcp: "denied", web: "denied" },
    failover: { allowedFallbackProfiles: [], mode: "pre-first-request-only", switchPermission: "denied" }
  };
  const validated = validateTaskCapsule(capsule, registry);
  if (args.out) {
    const out = path.resolve(args.out);
    ensureDir(path.dirname(out));
    fs.writeFileSync(out, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return { taskFile: out, capsule: { taskId: validated.taskId, profile: validated.profile, workspace: validated.workspace, access } };
  }
  return { capsule: validated };
}
function doctor(options = {}) {
  const registry = loadRegistry();
  const lockInspection = inspectLocks(options.lockDependencies || {});
  return doctorChecks.buildDoctorReport({
    version: VERSION,
    registry,
    defaultGrokHome: DEFAULT_GROK_HOME,
    grokCliPath: options.grokCliPath || EXECUTABLE,
    normalizeCase,
    isolatedEnv,
    approvedProfileRoot: APPROVED_PROFILE_ROOT,
    tempRoot: TEMP_ROOT,
    lockInspection,
    roots: [
      { name: "ledger-root", path: LEDGER_ROOT },
      { name: "lock-root", path: LOCK_ROOT },
      { name: "availability-root", path: AVAILABILITY_ROOT },
      { name: "runs-wal-root", path: RUNS_ROOT },
      { name: "health-root", path: HEALTH_ROOT }
    ],
    deployPointerValid: () => {
      // A complete process-local root triple is an explicit deployment/test
      // override.  In that mode an unrelated machine pointer is deliberately
      // not consulted, so its historical shape cannot invalidate the caller.
      if (DEPLOY_ROOTS_META && DEPLOY_ROOTS_META.source === "env") return true;
      if (!fs.existsSync(CURRENT_POINTER_PATH)) return true;
      try {
        availability.readCurrentPointer(CURRENT_POINTER_PATH, { readJson });
        return true;
      } catch (_) {
        return false;
      }
    },
    metadata: {
    registryPath: REGISTRY_PATH,
    dataRoot: DATA_ROOT,
    approvedProfileRoot: APPROVED_PROFILE_ROOT,
    deployRootsSource: DEPLOY_ROOTS_META && DEPLOY_ROOTS_META.source,
    legacyResidues: DEPLOY_ROOTS_META && DEPLOY_ROOTS_META.legacyResidues || null
    }
  });
}
function validateResultCapsule(result) {
  const required = [
    "status", "grokSessionId", "baseCommit", "changedFiles", "commands", "tests", "findings",
    "assumptions", "unresolved", "residualRisks", "commitEvidence", "diffEvidence", "boundaryCompliance",
    "taskId", "stage", "worktree", "exitCode", "redaction", "profileId", "invocationId", "requestId",
    "variant", "stopReason", "durationMs", "selectionEvidence", "errorClassification"
  ];
  for (const field of required) assert(Object.prototype.hasOwnProperty.call(result, field), "RESULT_REQUIRED", `Result Capsule is missing '${field}'.`);
  assert(["completed", "partial", "failed", "blocked"].includes(result.status), "RESULT_STATUS", "Result status is invalid.");
  assert(UUID.test(result.profileId) && UUID.test(result.invocationId), "RESULT_ID", "Result profileId/invocationId is invalid.");
  assert(isObject(result.boundaryCompliance) && Array.isArray(result.boundaryCompliance.changedFilesFinalState) && Array.isArray(result.boundaryCompliance.policyAuditEvents) && typeof result.boundaryCompliance.allowed === "boolean", "RESULT_BOUNDARY", "Result boundaryCompliance is invalid.");
  assert(isObject(result.redaction) && result.redaction.rawStreamDeleted === true && typeof result.redaction.rawCleanupFailed === "boolean", "RESULT_REDACTION", "Result redaction contract is invalid.");
  if (result.redaction.rawCleanupFailed) assert(result.status === "failed", "RESULT_CLEANUP", "raw cleanup failure must hard-fail the Result Capsule.");
  assert(isObject(result.selectionEvidence), "RESULT_SELECTION", "selectionEvidence is required.");
  assert(isObject(result.errorClassification), "RESULT_ERROR_CLASS", "errorClassification is required.");
  const resultErrorType = result.errorClassification.errorType;
  assert(
    resultErrorType === null || typeof resultErrorType === "string",
    "RESULT_ERROR_CLASS",
    "errorClassification is required."
  );
  const allowedTypes = availability.ERROR_TYPES.concat(["none"]);
  assert(
    resultErrorType === null
      || allowedTypes.includes(resultErrorType)
      || result.errorClassification.note === "no-error-on-success",
    "RESULT_ERROR_TYPE",
    "errorClassification.errorType is invalid."
  );
  return result;
}
function cleanupOrphanRaw() {
  ensureDir(TEMP_ROOT); const removed = [];
  for (const item of fs.readdirSync(TEMP_ROOT, { withFileTypes: true })) {
    if (item.isFile() && /\.raw(?:\.[^.]+)?\.jsonl$/i.test(item.name)) { const file = path.join(TEMP_ROOT, item.name); fs.rmSync(file, { force: true }); removed.push(file); }
  }
  return removed;
}

function parseArgs(args) {
  const out = { _: [] }; for (let i = 0; i < args.length; i += 1) { const token = args[i]; if (token.startsWith("--")) { const key = token.slice(2); const next = args[i + 1]; if (next && !next.startsWith("--")) { out[key] = next; i += 1; } else out[key] = true; } else out._.push(token); } return out;
}
function isReadOnlyFastPath(args) {
  const command = args._[0] || "help";
  const sub = args._[1];
  const sub2 = args._[2];
  if (command === "version" || command === "doctor" || command === "help" || !args._[0]) return true;
  if (command === "locks" && (sub === "inspect" || !sub)) return true;
  if (command === "profiles" && (sub === "list" || !sub)) return true;
  if (command === "pool" && sub === "status") return true;
  if (command === "pool" && sub === "config" && sub2 === "status") return true;
  if (command === "deploy" && sub === "list") return true;
  if (command === "deploy" && sub === "pointer" && !args.write) return true;
  return false;
}

async function main(argv) {
  // Re-resolve deploy roots on every launch (shim validates current.json).
  applyDeployRoots({ force: true });
  const args = parseArgs(argv);
  const command = args._[0] || "help";
  const readOnly = isReadOnlyFastPath(args);

  if (!readOnly) {
    ensureDir(DATA_ROOT);
    ensureDir(TEMP_ROOT);
    ensureDir(LEDGER_ROOT);
    ensureDir(RESULT_ROOT);
    ensureDir(LOCK_ROOT);
    ensureDir(AVAILABILITY_ROOT);
    ensureDir(RUNS_ROOT);
    ensureDir(HEALTH_ROOT);
    ensureDir(MAINTENANCE_ROOT);
    cleanupOrphanRaw();
    availability.recoverInterruptedRuns(DATA_ROOT, availabilityDeps());
    availability.reconcileMaintenanceRuns(DATA_ROOT, availabilityDeps());
    ensureDefaultProfile();
  }

  let output;
  try {
    if (command === "version") output = { name: "grok-worker", version: VERSION };
    else if (command === "doctor") output = doctor();
    else if (command === "locks" && (args._[1] === "inspect" || !args._[1])) output = inspectLocks();
    else if (command === "locks" && args._[1] === "cleanup") {
      output = cleanupLock(args.id || args["lock-id"], args.confirm);
    }
    else if (command === "profiles" && (args._[1] === "list" || !args._[1])) output = profileList();
    else if (command === "profiles" && args._[1] === "probe") output = probeProfile(args.profile);
    else if (command === "pool" && args._[1] === "status") output = poolStatus();
    else if (command === "pool" && args._[1] === "refresh") output = poolRefresh({ real: args.real });
    else if (command === "pool" && args._[1] === "bootstrap") {
      output = bootstrapAvailabilityCommand({
        frozenProfileIds: args.frozen ? String(args.frozen).split(",").map((x) => x.trim()).filter(Boolean) : [],
        recentSuccessProfileIds: args.success ? String(args.success).split(",").map((x) => x.trim()).filter(Boolean) : [],
        force: args.force === true
      });
    }
    else if (command === "pool" && args._[1] === "config" && args._[2] === "status") output = poolConfigStatus();
    else if (command === "pool" && args._[1] === "config" && args._[2] === "authorize") {
      output = poolConfigAuthorize({ profiles: args.profiles, actorNote: args.note });
    }
    else if (command === "pool" && args._[1] === "config" && args._[2] === "revoke") {
      output = poolConfigRevoke({ actorNote: args.note });
    }
    else if (command === "pool" && args._[1] === "config" && args._[2] === "autoprobe") {
      output = poolConfigAutoprobe({
        enable: args.enable === true,
        disable: args.disable === true,
        actorNote: args.note
      });
    }
    else if (command === "pool" && args._[1] === "maintenance" && args._[2] === "tick") {
      output = poolMaintenanceTick({});
    }
    else if (command === "task" && args._[1] === "init") output = taskInit(args);
    else if (command === "plan") output = planTask(args.profile, args.task);
    else if (command === "run") output = runTask(args.profile, args.task, { timeoutMs: args.timeout ? Number(args.timeout) : undefined });
    else if (command === "usage" && args._[1] === "show") output = usageShow({ profile: args.profile, task: args.task });
    else if (command === "usage" && args._[1] === "export") output = usageShow({});
    else if (command === "usage-snapshot") output = recordSnapshot(args.profile, args.file ? readJson(path.resolve(args.file)) : { source: "not-authorized", accountBinding: "unsupported", capturedAt: now() });
    else if (command === "roots") output = rootsCommand(args._[1] || "list", args.path);
    else if (command === "deploy" && args._[1] === "pointer") output = args.write ? writeDeployPointer(args) : readDeployPointer();
    else if (command === "deploy" && args._[1] === "list") output = deployList();
    else if (command === "deploy" && args._[1] === "rollback") output = deployRollback({ to: args.to });
    else if (command === "onboard") {
      const profile = registerEmptyProfile(args.profile);
      output = {
        profileId: profile.profileId,
        profile: profile.alias,
        grokHome: profile.grokHome,
        status: "requires-explicit-oauth",
        commandPlanned: [profile.executable, "login", "--oauth"],
        authReadiness: profile.authReadiness,
        note: "Provider never copies or reads default auth; execute official OAuth only under separate explicit authorization with process-local GROK_HOME. OAuth success does not grant availability active without a subsequent real probe."
      };
    }
    else {
      output = {
        usage: [
          "grok-worker onboard --profile <alias>",
          "grok-worker profiles list",
          "grok-worker profiles probe --profile <alias>",
          "grok-worker pool status",
          "grok-worker pool refresh [--real allowed]",
          "grok-worker pool bootstrap [--frozen id|alias,...] [--success id|alias,...] [--force]",
          "grok-worker pool config status",
          "grok-worker pool config authorize --profiles <id;id>",
          "grok-worker pool config revoke",
          "grok-worker pool config autoprobe --enable|--disable",
          "grok-worker pool maintenance tick",
          "grok-worker roots list|register|inspect --path <workspace>",
          "grok-worker task init --profile <alias> --workspace <project> --objective <text> --out <capsule.json> [--real allowed|denied] [--access readonly|workspace-write]",
          "grok-worker plan --profile <alias> --task <capsule>",
          "grok-worker run --profile <alias> --task <capsule>",
          "grok-worker usage show [--profile <alias>] [--task <id>]",
          "grok-worker usage export --format json",
          "grok-worker usage-snapshot --profile <alias> [--file <snapshot>]",
          "grok-worker deploy pointer [--write]",
          "grok-worker deploy list",
          "grok-worker deploy rollback --to <version>",
          "grok-worker doctor",
          "grok-worker locks inspect",
          "grok-worker locks cleanup --id <lockId> --confirm <lockId>",
          "grok-worker version"
        ]
      };
    }
  } catch (error) {
    if (error && error.name === "ProviderError") {
      process.stdout.write(`${JSON.stringify({
        error: error.code,
        message: error.safeMessage,
        details: error.details || {},
        realRequests: 0
      }, null, 2)}\n`);
      process.exitCode = error.exitCode || 1;
      return;
    }
    throw error;
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (output && typeof output.exitHint === "number" && output.exitHint !== 0) {
    process.exitCode = output.exitHint;
  }
}

module.exports = {
  VERSION, ProviderError, PROVIDER_DIR, PROVIDER_HOME,
  DEFAULT_DATA_ROOT, DEFAULT_REGISTRY_PATH, DEFAULT_APPROVED_PROFILE_ROOT,
  LEGACY_DATA_ROOT, LEGACY_REGISTRY_PATH, LEGACY_APPROVED_PROFILE_ROOT,
  CURRENT_POINTER_PATH,
  get APPROVED_PROFILE_ROOT() { return APPROVED_PROFILE_ROOT; },
  get DATA_ROOT() { return DATA_ROOT; },
  get REGISTRY_PATH() { return REGISTRY_PATH; },
  get AVAILABILITY_ROOT() { return AVAILABILITY_ROOT; },
  get RUNS_ROOT() { return RUNS_ROOT; },
  get HEALTH_ROOT() { return HEALTH_ROOT; },
  get MAINTENANCE_ROOT() { return MAINTENANCE_ROOT; },
  get DEPLOY_POINTERS_ROOT() { return DEPLOY_POINTERS_ROOT; },
  get LOCK_ROOT() { return LOCK_ROOT; },
  get RESULT_ROOT() { return RESULT_ROOT; },
  get TEMP_ROOT() { return TEMP_ROOT; },
  validateWindowsPath, validateTaskCapsule, validateProfile, loadRegistry, saveRegistry,
  ensureDefaultProfile, registerEmptyProfile, probeProfile, probeModelIds, modelIdsFromText, modelIdsFromCache, ensureProviderHook, preflightProject, buildPermissionSettings, evaluatePolicyRequest,
  planTemplate, materialize, planTask, parseStream, numericUsage, recordInvocation,
  verifyPlanContract, verifyMaintenancePlanContract, readPolicyAudit,
  rebuildLayers, changedFilesFinalState, changedWithinAllowed, acquireLock, inspectLocks, cleanupLock, patternsOverlap,
  mayFailover, quotaSignalFromEnd, recordSnapshot, profileList, usageShow, poolStatus, taskInit, runTask, doctor, rootsCommand, validateResultCapsule, cleanupOrphanRaw, main,
  bootstrapAvailabilityCommand, poolRefresh, readDeployPointer, writeDeployPointer,
  poolConfigStatus, poolConfigAuthorize, poolConfigRevoke, poolConfigAutoprobe,
  poolMaintenanceTick, deployList, deployRollback, writeVersionedDeployPointer,
  executeMaintenanceProbe, applyMaintenanceProbeOutcome, migrateQuotaNextProbeCaps,
  buildResultCapsule, persistAvailabilityFromOutcome, runSingleAttempt,
  applyDeployRoots, resolveRootsFromPointer, legacyResidueMeta, isReadOnlyFastPath,
  availability,
  _test: {
    atomicWriteJson, redactText, readJson, hasSecretKeys, emptyLedger, usageFingerprint,
    isolatedEnv, readTrustStore, inspectEffective, spawnCapture, availabilityDeps,
    queryProcessStartTicks, captureRunOwner, inspectRunOwner, inspectLockOwner, evaluateLease: locks.evaluateLease, taskRunTransaction,
    buildMaintenanceProbeTargets
  }
};
