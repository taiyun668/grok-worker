"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const LOCK_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bindHelpers(dependencies = {}) {
  return {
    lockRoot: dependencies.lockRoot,
    auditPath: dependencies.auditPath,
    ensureDir: dependencies.ensureDir || ((dir) => fs.mkdirSync(dir, { recursive: true })),
    readJson: dependencies.readJson || ((file) => JSON.parse(fs.readFileSync(file, "utf8"))),
    atomicWriteJson: dependencies.atomicWriteJson,
    appendJsonLineAtomic: dependencies.appendJsonLineAtomic,
    now: dependencies.now || (() => new Date().toISOString()),
    nowMs: dependencies.nowMs || (() => Date.now()),
    isObject: dependencies.isObject || isObject,
    normalizeCase: dependencies.normalizeCase || ((value) => path.resolve(value).replace(/[\\/]+$/, "").toLowerCase()),
    patternsOverlap: dependencies.patternsOverlap,
    assert: dependencies.assert || ((condition, code, message, details) => {
      if (!condition) {
        const error = Object.assign(new Error(message), { code, details: details || {} });
        throw error;
      }
    }),
    queryProcessStartTicks: dependencies.queryProcessStartTicks,
    signalProcess: dependencies.signalProcess,
    readFileSync: dependencies.readFileSync || ((file) => fs.readFileSync(file)),
    rmSync: dependencies.rmSync || ((file) => fs.rmSync(file, { force: true })),
    renameSync: dependencies.renameSync || ((from, to) => fs.renameSync(from, to)),
    existsSync: dependencies.existsSync || ((file) => fs.existsSync(file)),
    afterInspect: dependencies.afterInspect,
    afterQuarantine: dependencies.afterQuarantine,
    randomUUID: dependencies.randomUUID || (() => crypto.randomUUID())
  };
}

function inspectLockOwner(owner, dependencies = {}) {
  if (!isObject(owner) || !Number.isInteger(owner.pid) || owner.pid <= 0
      || typeof owner.processStartTicks !== "string" || !/^\d+$/.test(owner.processStartTicks)) {
    return { state: "unverifiable", reason: "owner-identity-missing" };
  }

  const signalProcess = dependencies.signalProcess || ((pid) => process.kill(pid, 0));
  try {
    signalProcess(owner.pid);
  } catch (error) {
    if (error && error.code === "ESRCH") return { state: "dead", reason: "owner-pid-absent" };
    return { state: "unverifiable", reason: "owner-liveness-unavailable" };
  }

  const queryStartTicks = dependencies.queryProcessStartTicks;
  let observedStartTicks = null;
  if (typeof queryStartTicks === "function") {
    try { observedStartTicks = queryStartTicks(owner.pid); } catch (_) { /* unverifiable below */ }
  }
  if (!observedStartTicks) return { state: "unverifiable", reason: "owner-start-unavailable" };
  if (String(observedStartTicks) !== owner.processStartTicks) {
    return { state: "dead", reason: "owner-pid-reused", observedStartTicks: String(observedStartTicks) };
  }
  return { state: "live", reason: "owner-identity-live", observedStartTicks: String(observedStartTicks) };
}

function evaluateLease(lock, nowMs = Date.now()) {
  const heartbeatMs = Date.parse(lock && lock.heartbeatAt);
  const leaseMs = lock && lock.leaseMs;
  if (!Number.isFinite(heartbeatMs) || typeof leaseMs !== "number" || !Number.isFinite(leaseMs) || leaseMs <= 0) {
    return { ok: false, fresh: false, ageMs: null, reason: "lock-lease-unparseable" };
  }
  const ageMs = nowMs - heartbeatMs;
  return { ok: true, fresh: ageMs < leaseMs, ageMs, reason: "lock-lease-valid" };
}

function lockAgeMs(lock, nowMs) {
  const heartbeatMs = Date.parse(lock && lock.heartbeatAt);
  if (Number.isFinite(heartbeatMs)) return nowMs - heartbeatMs;
  const acquiredMs = Date.parse(lock && lock.acquiredAt);
  if (Number.isFinite(acquiredMs)) return nowMs - acquiredMs;
  return null;
}

function loadLockRecord(file, helpers) {
  if (!helpers.existsSync(file)) return { parseable: false, missing: true, reason: "lock-missing", value: null };
  try {
    const value = helpers.readJson(file);
    if (!helpers.isObject(value)) {
      return { parseable: false, missing: false, reason: "lock-json-unparseable", value: null };
    }
    return { parseable: true, missing: false, reason: null, value };
  } catch (_) {
    if (!helpers.existsSync(file)) return { parseable: false, missing: true, reason: "lock-missing", value: null };
    return { parseable: false, missing: false, reason: "lock-json-unparseable", value: null };
  }
}

function lockConflict(scope, patterns, root, current, helpers) {
  if (!current || typeof current.scope !== "string" || !Array.isArray(current.patterns)) return true;
  if (scope === "profile" && current.scope === "profile") {
    return patterns.some((a) => current.patterns.some((b) => helpers.normalizeCase(a) === helpers.normalizeCase(b)));
  }
  if (scope === "workspace" && current.scope === "workspace") {
    return helpers.normalizeCase(root) === helpers.normalizeCase(current.root)
      && patterns.some((a) => current.patterns.some((b) => helpers.patternsOverlap(a, b, root)));
  }
  if (scope === "selection" && current.scope === "selection") {
    return patterns.some((a) => current.patterns.some((b) => String(a) === String(b)));
  }
  if (scope === "availability" && current.scope === "availability") {
    return patterns.some((a) => current.patterns.some((b) => helpers.normalizeCase(String(a)) === helpers.normalizeCase(String(b))));
  }
  return false;
}

function lockIdFromFile(file) {
  return path.basename(file, ".json");
}

function describeLock(file, loaded, nowMs, dependencies) {
  const lockId = lockIdFromFile(file);
  if (!loaded.parseable) {
    return {
      lockId,
      recordLockId: null,
      scope: null,
      pid: null,
      processStartTicks: null,
      leaseMs: null,
      heartbeatAt: null,
      acquiredAt: null,
      ageMs: null,
      lease: { ok: false, fresh: false, ageMs: null, reason: loaded.reason },
      ownerState: "unverifiable",
      ownerReason: loaded.reason,
      parseable: false,
      blocking: true,
      reclaimableOnAcquire: false
    };
  }
  const current = loaded.value;
  const owner = inspectLockOwner(current, dependencies);
  const lease = evaluateLease(current, nowMs);
  const ageMs = lockAgeMs(current, nowMs);
  return {
    lockId,
    recordLockId: typeof current.lockId === "string" ? current.lockId : null,
    scope: typeof current.scope === "string" ? current.scope : null,
    pid: Number.isInteger(current.pid) ? current.pid : null,
    processStartTicks: typeof current.processStartTicks === "string" ? current.processStartTicks : null,
    leaseMs: typeof current.leaseMs === "number" ? current.leaseMs : null,
    heartbeatAt: typeof current.heartbeatAt === "string" ? current.heartbeatAt : null,
    acquiredAt: typeof current.acquiredAt === "string" ? current.acquiredAt : null,
    ageMs,
    lease,
    ownerState: owner.state,
    ownerReason: owner.reason,
    observedStartTicks: owner.observedStartTicks || null,
    parseable: true,
    blocking: owner.state !== "dead",
    reclaimableOnAcquire: owner.state === "dead"
  };
}

function inspectLocks(dependencies = {}) {
  const helpers = bindHelpers(dependencies);
  const lockRoot = helpers.lockRoot;
  const nowMs = helpers.nowMs();
  if (typeof lockRoot !== "string" || !lockRoot) {
    return { lockRoot: null, present: false, inspectError: "lock-root-missing", locks: [], blockingCount: 0 };
  }
  if (!helpers.existsSync(lockRoot)) {
    return { lockRoot, present: false, inspectError: null, locks: [], blockingCount: 0 };
  }
  let names;
  try {
    names = fs.readdirSync(lockRoot).filter((item) => item.endsWith(".json"));
  } catch (_) {
    return {
      lockRoot, present: true, inspectError: "lock-root-unreadable", locks: [], blockingCount: 0
    };
  }
  const locks = [];
  for (const name of names) {
    const file = path.join(lockRoot, name);
    const loaded = loadLockRecord(file, helpers);
    if (loaded.missing) continue;
    locks.push(describeLock(file, loaded, nowMs, dependencies));
  }
  return {
    lockRoot,
    present: true,
    inspectError: null,
    locks,
    blockingCount: locks.filter((item) => item.blocking).length
  };
}

function recordCleanupAudit(helpers, record) {
  const payload = { event: "lock-cleanup", at: helpers.now(), ...record };
  let persisted = false;
  if (typeof helpers.appendJsonLineAtomic === "function" && helpers.auditPath) {
    try {
      helpers.appendJsonLineAtomic(helpers.auditPath, payload);
      persisted = true;
    } catch (_) { /* caller reports persistence */ }
  }
  return { auditRecord: payload, auditPath: helpers.auditPath || null, auditPersisted: persisted };
}

function resolveLockFile(lockRoot, lockId, helpers) {
  helpers.assert(
    typeof lockId === "string" && LOCK_ID_PATTERN.test(lockId),
    "LOCK_CLEANUP_ID",
    "Cleanup requires an exact lock id with no path characters.",
    { lockId: typeof lockId === "string" ? lockId : null }
  );
  const root = path.resolve(lockRoot);
  const file = path.resolve(root, `${lockId}.json`);
  helpers.assert(
    path.dirname(file) === root && path.basename(file) === `${lockId}.json`,
    "LOCK_CLEANUP_ID",
    "Cleanup lock path escaped the lock root.",
    { lockId }
  );
  return file;
}

function sameBytes(left, right) {
  const a = Buffer.isBuffer(left) ? left : Buffer.from(left);
  const b = Buffer.isBuffer(right) ? right : Buffer.from(right);
  return a.length === b.length && a.equals(b);
}

function refuseCleanup(helpers, code, message, details) {
  const audit = recordCleanupAudit(helpers, {
    outcome: code,
    lockId: details && details.lockId || null,
    ownerState: details && details.ownerState || null,
    ownerReason: details && details.ownerReason || null
  });
  helpers.assert(false, code, message, { ...details, audit });
}

function cleanupLock(lockId, confirmation, dependencies = {}) {
  const helpers = bindHelpers(dependencies);
  helpers.assert(
    typeof helpers.lockRoot === "string" && helpers.lockRoot,
    "LOCK_ROOT",
    "Lock root is required."
  );
  helpers.assert(
    typeof lockId === "string" && typeof confirmation === "string" && confirmation === lockId,
    "LOCK_CLEANUP_CONFIRM",
    "Cleanup requires --id and --confirm to be the exact same lock id.",
    { lockId: typeof lockId === "string" ? lockId : null }
  );
  const file = resolveLockFile(helpers.lockRoot, lockId, helpers);
  if (!helpers.existsSync(file)) {
    refuseCleanup(helpers, "LOCK_NOT_FOUND", "No lock file exists for that exact lock id.", { lockId });
  }

  let firstRaw;
  try {
    firstRaw = helpers.readFileSync(file);
  } catch (_) {
    refuseCleanup(helpers, "LOCK_NOT_FOUND", "No lock file exists for that exact lock id.", { lockId });
  }

  const loaded = loadLockRecord(file, helpers);
  const inspection = describeLock(file, loaded.missing
    ? { parseable: false, missing: false, reason: "lock-json-unparseable", value: null }
    : loaded, helpers.nowMs(), dependencies);
  if (inspection.ownerState === "live") {
    refuseCleanup(helpers, "LOCK_CLEANUP_LIVE", "Refusing to remove a lock whose owner is still live.", {
      lockId, ownerState: inspection.ownerState, ownerReason: inspection.ownerReason
    });
  }

  if (typeof helpers.afterInspect === "function") helpers.afterInspect(file, inspection);

  const authorizedAudit = recordCleanupAudit(helpers, {
    outcome: "authorized",
    lockId,
    ownerState: inspection.ownerState,
    ownerReason: inspection.ownerReason,
    parseable: inspection.parseable
  });
  helpers.assert(
    authorizedAudit.auditPersisted,
    "LOCK_CLEANUP_AUDIT",
    "Refusing cleanup because the authorization audit could not be persisted.",
    { lockId, auditPath: authorizedAudit.auditPath }
  );

  const quarantineRoot = path.join(helpers.lockRoot, ".cleanup-quarantine");
  helpers.ensureDir(quarantineRoot);
  const quarantinedFile = path.join(quarantineRoot, `${lockId}.${helpers.randomUUID()}.json`);
  try {
    helpers.renameSync(file, quarantinedFile);
  } catch (_) {
    refuseCleanup(helpers, "LOCK_CLEANUP_RACE", "Lock file changed between inspect and cleanup.", {
      lockId, ownerState: inspection.ownerState, ownerReason: inspection.ownerReason
    });
  }

  if (typeof helpers.afterQuarantine === "function") helpers.afterQuarantine(file, quarantinedFile, inspection);
  let quarantinedRaw;
  try { quarantinedRaw = helpers.readFileSync(quarantinedFile); } catch (_) { quarantinedRaw = null; }
  if (!quarantinedRaw || !sameBytes(firstRaw, quarantinedRaw)) {
    try {
      if (!helpers.existsSync(file) && helpers.existsSync(quarantinedFile)) {
        helpers.renameSync(quarantinedFile, file);
      }
    } catch (_) { /* preserve both paths for manual inspection */ }
    refuseCleanup(helpers, "LOCK_CLEANUP_RACE", "Lock file changed between inspect and cleanup.", {
      lockId, ownerState: inspection.ownerState, ownerReason: inspection.ownerReason,
      quarantinePreserved: helpers.existsSync(quarantinedFile)
    });
  }

  if (helpers.existsSync(file)) {
    helpers.rmSync(quarantinedFile);
    refuseCleanup(helpers, "LOCK_CLEANUP_RACE", "A replacement lock appeared during cleanup.", {
      lockId, ownerState: inspection.ownerState, ownerReason: inspection.ownerReason
    });
  }

  const reloaded = loadLockRecord(quarantinedFile, helpers);
  const reinspection = describeLock(quarantinedFile, reloaded.missing
    ? { parseable: false, missing: false, reason: "lock-json-unparseable", value: null }
    : reloaded, helpers.nowMs(), dependencies);
  if (reinspection.ownerState === "live") {
    try {
      if (!helpers.existsSync(file)) helpers.renameSync(quarantinedFile, file);
    } catch (_) { /* refusal details preserve the quarantine state */ }
    refuseCleanup(helpers, "LOCK_CLEANUP_LIVE", "Refusing to remove a lock whose owner is still live.", {
      lockId, ownerState: reinspection.ownerState, ownerReason: reinspection.ownerReason,
      quarantinePreserved: helpers.existsSync(quarantinedFile)
    });
  }

  helpers.rmSync(quarantinedFile);
  const audit = recordCleanupAudit(helpers, {
    outcome: "removed",
    lockId,
    ownerState: reinspection.ownerState,
    ownerReason: reinspection.ownerReason,
    parseable: reinspection.parseable
  });
  return {
    removed: true,
    lockId,
    ownerState: reinspection.ownerState,
    ownerReason: reinspection.ownerReason,
    parseable: reinspection.parseable,
    ...audit
  };
}

function acquireLock(scope, patterns, root, leaseMs = 30000, dependencies = {}) {
  const helpers = bindHelpers(dependencies);
  helpers.assert(typeof helpers.lockRoot === "string" && helpers.lockRoot, "LOCK_ROOT", "Lock root is required.");
  helpers.assert(typeof helpers.atomicWriteJson === "function", "LOCK_WRITE", "atomicWriteJson is required to acquire a lock.");
  helpers.ensureDir(helpers.lockRoot);
  const lockId = crypto.createHash("sha256").update(`${scope}|${patterns.slice().sort().join("|")}|${crypto.randomUUID()}`).digest("hex");
  const file = path.join(helpers.lockRoot, `${lockId}.json`);
  const processStart = Date.now() - Math.floor(process.uptime() * 1000);
  for (const name of fs.readdirSync(helpers.lockRoot).filter((item) => item.endsWith(".json"))) {
    const otherFile = path.join(helpers.lockRoot, name);
    const loaded = loadLockRecord(otherFile, helpers);
    if (loaded.missing) continue;
    if (!loaded.parseable) {
      helpers.assert(false, "LOCK_CONFLICT", "Lock file is unparseable; refusing to acquire.", {
        scope, patterns, holder: lockIdFromFile(otherFile), ownerState: "unverifiable", ownerReason: "lock-json-unparseable"
      });
    }
    const current = loaded.value;
    const owner = inspectLockOwner(current, dependencies);
    // Production reclaim is only for an owner proven dead. Expired live leases,
    // unverifiable owners, and invalid heartbeat/lease metadata stay in place.
    if (owner.state === "dead") {
      helpers.rmSync(otherFile);
      continue;
    }
    const conflict = lockConflict(scope, patterns, root, current, helpers);
    helpers.assert(!conflict, "LOCK_CONFLICT", "Lock is held by a live or unverifiable lease.", {
      scope, patterns, holder: current.lockId, ownerState: owner.state, ownerReason: owner.reason
    });
  }
  const queryStartTicks = dependencies.queryProcessStartTicks;
  let ownProcessStartTicks = null;
  if (typeof queryStartTicks === "function") {
    try { ownProcessStartTicks = queryStartTicks(process.pid); } catch (_) { /* fail closed below */ }
  }
  helpers.assert(
    typeof ownProcessStartTicks === "string" && /^\d+$/.test(ownProcessStartTicks),
    "LOCK_OWNER_IDENTITY_UNAVAILABLE",
    "The Provider cannot prove its process-start identity; refusing to acquire a lock.",
    { pid: process.pid }
  );
  const value = {
    lockId, scope, patterns, root, pid: process.pid, processStart,
    processStartTicks: ownProcessStartTicks,
    leaseMs, acquiredAt: helpers.now(), heartbeatAt: helpers.now()
  };
  helpers.atomicWriteJson(file, value);
  return {
    value,
    heartbeat() { value.heartbeatAt = helpers.now(); helpers.atomicWriteJson(file, value); },
    release() { fs.rmSync(file, { force: true }); }
  };
}

module.exports = {
  inspectLockOwner,
  evaluateLease,
  inspectLocks,
  cleanupLock,
  acquireLock
};
