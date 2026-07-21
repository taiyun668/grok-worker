"use strict";

/**
 * GROK-WORKER-PROVIDER Availability Layer v5
 * Independent ledger, state machine, error classification, selection, billing snapshot helpers.
 * Security: metadata only; hasSecretKeys + atomicWriteJson on every durable write.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const AVAILABILITY_SCHEMA_VERSION = 5;
const AVAILABILITY_STATES = Object.freeze([
  "active", "frozen", "cooldown", "probe_due", "manual_hold", "unknown", "reauth_required"
]);
const ERROR_TYPES = Object.freeze([
  "quota_exhausted", "rate_limited", "reauth_required", "model_unavailable",
  "network_fault", "provider_fault", "unknown_failure"
]);
const PROFILE_ATTRIBUTABLE = Object.freeze(new Set([
  "quota_exhausted", "reauth_required", "rate_limited"
]));

const BASE_BACKOFF_MS = 15 * 60 * 1000;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
const JITTER_RATIO = 0.15;
const BILLING_MAX_FILE_BYTES = 2 * 1024 * 1024;
const BILLING_MAX_LINE_CHARS = 32 * 1024;
const BILLING_MAX_LINES_SCAN = 500;
const BILLING_CTX_WHITELIST = Object.freeze([
  "billingPeriodEnd", "periodEnd", "resetAt", "usedPercent", "quotaUsedPercent", "status"
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nowIso(date = new Date()) {
  return date.toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function availabilityDir(dataRoot) {
  return path.join(dataRoot, "availability");
}

function availabilityPath(dataRoot, profileId) {
  return path.join(availabilityDir(dataRoot), `${profileId}.json`);
}

function runsDir(dataRoot, taskId) {
  const safe = String(taskId).replace(/[^a-z0-9_.-]/gi, "_");
  return path.join(dataRoot, "runs", safe);
}

function runWalPath(dataRoot, taskId, runId) {
  return path.join(runsDir(dataRoot, taskId), `${runId}.json`);
}

function emptyAvailability(profileId, overrides = {}) {
  return {
    schemaVersion: AVAILABILITY_SCHEMA_VERSION,
    profileId,
    revision: 0,
    updatedAt: nowIso(),
    evidenceSource: "bootstrap",
    state: "unknown",
    scope: null,
    evidence: {
      errorType: null,
      statusCode: null,
      retryable: null,
      observedAt: null,
      resetAt: null,
      billingHint: null
    },
    nextProbeAt: null,
    lastSelectedAt: null,
    consecutiveFailures: 0,
    ...overrides
  };
}

function validateAvailabilityRecord(record) {
  if (!isObject(record)) return { ok: false, reason: "not-object" };
  if (record.schemaVersion !== AVAILABILITY_SCHEMA_VERSION) return { ok: false, reason: "schema" };
  if (!AVAILABILITY_STATES.includes(record.state)) return { ok: false, reason: "state" };
  if (typeof record.revision !== "number" || record.revision < 0) return { ok: false, reason: "revision" };
  if (!isObject(record.evidence)) return { ok: false, reason: "evidence" };
  return { ok: true };
}

function loadAvailability(dataRoot, profileId, deps) {
  const file = availabilityPath(dataRoot, profileId);
  if (!fs.existsSync(file)) return emptyAvailability(profileId);
  try {
    const record = deps.readJson(file);
    const check = validateAvailabilityRecord(record);
    if (!check.ok) return emptyAvailability(profileId, { evidenceSource: "corrupt-reset", state: "unknown" });
    return record;
  } catch (_) {
    return emptyAvailability(profileId, { evidenceSource: "read-error-reset", state: "unknown" });
  }
}

/**
 * CAS write: only succeeds when expectedRevision matches on-disk revision (or file absent when expected 0).
 */
function writeAvailabilityCas(dataRoot, profileId, nextRecord, expectedRevision, deps) {
  const file = availabilityPath(dataRoot, profileId);
  deps.ensureDir(path.dirname(file));
  let currentRevision = 0;
  if (fs.existsSync(file)) {
    try {
      const current = deps.readJson(file);
      currentRevision = Number(current.revision) || 0;
    } catch (_) {
      currentRevision = -1;
    }
  }
  if (currentRevision !== expectedRevision) {
    return { ok: false, code: "AVAILABILITY_CAS_CONFLICT", currentRevision, expectedRevision };
  }
  const toWrite = clone(nextRecord);
  toWrite.profileId = profileId;
  toWrite.schemaVersion = AVAILABILITY_SCHEMA_VERSION;
  toWrite.revision = expectedRevision + 1;
  toWrite.updatedAt = nowIso();
  deps.atomicWriteJson(file, toWrite);
  return { ok: true, record: toWrite };
}

function computeBackoffMs(consecutiveFailures = 0) {
  const exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, Math.max(0, consecutiveFailures)));
  const jitter = exp * JITTER_RATIO * (Math.random() * 2 - 1);
  return Math.max(BASE_BACKOFF_MS, Math.floor(exp + jitter));
}

function computeNextProbeAt({ resetAt, consecutiveFailures = 0, now = Date.now() } = {}) {
  if (resetAt) {
    const resetMs = Date.parse(resetAt);
    if (Number.isFinite(resetMs) && resetMs > now) {
      const jitter = Math.floor((resetMs - now) * JITTER_RATIO * Math.random());
      return new Date(resetMs + jitter).toISOString();
    }
  }
  return new Date(now + computeBackoffMs(consecutiveFailures)).toISOString();
}

/**
 * Deterministic local progression (§3.3). Pure function of record + now.
 * Returns { eligibility: workloadEligible|probeEligible|excluded, effectiveState, reason }
 */
function evaluateEligibility(record, nowMs = Date.now()) {
  const state = record && record.state ? record.state : "unknown";
  const nextProbeAt = record && record.nextProbeAt ? Date.parse(record.nextProbeAt) : null;

  if (state === "active") {
    return { eligibility: "workloadEligible", effectiveState: "active", reason: "active" };
  }
  if (state === "unknown") {
    return { eligibility: "probeEligible", effectiveState: "unknown", reason: "unknown-needs-probe" };
  }
  if (state === "reauth_required" || state === "manual_hold") {
    return { eligibility: "excluded", effectiveState: state, reason: state };
  }
  if (state === "probe_due") {
    return { eligibility: "probeEligible", effectiveState: "probe_due", reason: "probe-due" };
  }
  if (state === "frozen" || state === "cooldown") {
    if (nextProbeAt !== null && Number.isFinite(nextProbeAt) && nowMs >= nextProbeAt) {
      return { eligibility: "probeEligible", effectiveState: "probe_due", reason: `${state}-expired` };
    }
    return { eligibility: "excluded", effectiveState: state, reason: `${state}-not-due` };
  }
  return { eligibility: "excluded", effectiveState: state, reason: "unrecognized-state" };
}

/**
 * Conservative in-memory classifier (§5). Uses redacted stderr text only.
 * Synthetic fixtures prove parser behavior; real exhaust payload format remains INCONCLUSIVE.
 */
function classifyError(input = {}) {
  const statusCode = Number.isFinite(Number(input.statusCode)) ? Number(input.statusCode) : null;
  const exitCode = Number.isFinite(Number(input.exitCode)) ? Number(input.exitCode) : null;
  const retryableHint = typeof input.retryable === "boolean" ? input.retryable : null;
  const raw = `${input.stderr || ""}\n${input.stdout || ""}\n${input.message || ""}`;
  const text = String(raw);
  const lower = text.toLowerCase();

  const parseRetryable = () => {
    if (retryableHint !== null) return retryableHint;
    const m = text.match(/is_retryable\s*[=:]\s*(true|false)/i) || text.match(/"is_retryable"\s*:\s*(true|false)/i);
    if (m) return m[1].toLowerCase() === "true";
    return null;
  };
  const retryable = parseRetryable();

  // quota_exhausted: status 402 + non-retryable + balance/exhausted language
  if (
    statusCode === 402 ||
    /status[_\s-]?code["\s:=]+402/i.test(text) ||
    (/\b402\b/.test(text) && /usage balance exhausted|quota.?exhaust|credit.?exhaust|subscription.?exhaust/i.test(text))
  ) {
    const looksExhausted = /usage balance exhausted|quota|credit|subscription|billing/i.test(text) || statusCode === 402;
    if (looksExhausted && retryable !== true) {
      return {
        errorType: "quota_exhausted",
        statusCode: statusCode || 402,
        retryable: false,
        quotaKind: "usage_balance",
        profileAttributable: true,
        accountLevelEvidence: true
      };
    }
  }

  // reauth
  if (
    statusCode === 401 ||
    /unauthorized|reauth|login required|not authenticated|oauth.*(expired|required)|invalid.?session/i.test(lower)
  ) {
    return {
      errorType: "reauth_required",
      statusCode: statusCode || 401,
      retryable: false,
      quotaKind: null,
      profileAttributable: true,
      accountLevelEvidence: true
    };
  }

  // rate limited
  const has429 = statusCode === 429 || /\b429\b/.test(text) || /rate.?limit/i.test(lower);
  if (has429) {
    const retryAfterMatch = text.match(/retry-after["\s:=]+(\d+)/i) || text.match(/retry_after["\s:=]+(\d+)/i);
    const accountLevel =
      /account|profile|user.?quota|per-?user/i.test(lower) ||
      Boolean(retryAfterMatch) ||
      retryable === true;
    return {
      errorType: "rate_limited",
      statusCode: statusCode || 429,
      retryable: retryable !== false,
      quotaKind: "rate_limit",
      profileAttributable: accountLevel,
      accountLevelEvidence: accountLevel,
      retryAfterSeconds: retryAfterMatch ? Number(retryAfterMatch[1]) : null
    };
  }

  if (/model.?not.?found|model.?unavailable|unsupported.?model|unknown model/i.test(lower)) {
    return {
      errorType: "model_unavailable",
      statusCode,
      retryable: false,
      quotaKind: null,
      profileAttributable: false,
      accountLevelEvidence: false
    };
  }

  if (/econnreset|etimedout|enotfound|socket hang up|network|dns|tls|certificate|fetch failed/i.test(lower)) {
    return {
      errorType: "network_fault",
      statusCode,
      retryable: true,
      quotaKind: null,
      profileAttributable: false,
      accountLevelEvidence: false
    };
  }

  if (/internal server error|service unavailable|bad gateway|provider.?fault|5\d\d/.test(lower) && statusCode >= 500) {
    return {
      errorType: "provider_fault",
      statusCode,
      retryable: true,
      quotaKind: null,
      profileAttributable: false,
      accountLevelEvidence: false
    };
  }

  // Unrecognized exit 1 → unknown_failure, never freeze
  return {
    errorType: "unknown_failure",
    statusCode: statusCode || (exitCode === 1 ? 1 : null),
    retryable: null,
    quotaKind: null,
    profileAttributable: false,
    accountLevelEvidence: false
  };
}

function shouldTouchAvailability(classification) {
  if (!classification || !classification.profileAttributable) return false;
  if (classification.errorType === "quota_exhausted") return true;
  if (classification.errorType === "reauth_required") return true;
  if (classification.errorType === "rate_limited" && classification.accountLevelEvidence) return true;
  return false;
}

function applyClassificationToAvailability(record, classification, options = {}) {
  const next = clone(record || emptyAvailability(options.profileId || "unknown"));
  const observedAt = options.observedAt || nowIso();
  next.evidence = {
    errorType: classification.errorType,
    statusCode: classification.statusCode,
    retryable: classification.retryable,
    observedAt,
    resetAt: options.resetAt !== undefined ? options.resetAt : (next.evidence && next.evidence.resetAt) || null,
    billingHint: options.billingHint !== undefined ? options.billingHint : (next.evidence && next.evidence.billingHint) || null
  };
  next.evidenceSource = options.evidenceSource || "classification";

  if (!shouldTouchAvailability(classification)) {
    return { touched: false, record: next, reason: "non-attributable" };
  }

  if (classification.errorType === "quota_exhausted") {
    next.state = "frozen";
    next.scope = "quota";
    next.consecutiveFailures = (Number(next.consecutiveFailures) || 0) + 1;
    next.nextProbeAt = computeNextProbeAt({
      resetAt: next.evidence.resetAt,
      consecutiveFailures: next.consecutiveFailures
    });
    return { touched: true, record: next, reason: "quota_exhausted→frozen" };
  }
  if (classification.errorType === "reauth_required") {
    next.state = "reauth_required";
    next.scope = "auth";
    next.nextProbeAt = null; // never auto-probe
    return { touched: true, record: next, reason: "reauth_required" };
  }
  if (classification.errorType === "rate_limited") {
    next.state = "cooldown";
    next.scope = "rate_limit";
    next.consecutiveFailures = (Number(next.consecutiveFailures) || 0) + 1;
    let resetAt = next.evidence.resetAt;
    if (!resetAt && classification.retryAfterSeconds) {
      resetAt = new Date(Date.now() + classification.retryAfterSeconds * 1000).toISOString();
      next.evidence.resetAt = resetAt;
    }
    next.nextProbeAt = computeNextProbeAt({
      resetAt,
      consecutiveFailures: next.consecutiveFailures
    });
    return { touched: true, record: next, reason: "rate_limited→cooldown" };
  }
  return { touched: false, record: next, reason: "no-transition" };
}

function markActive(record, options = {}) {
  const next = clone(record);
  next.state = "active";
  next.scope = null;
  next.consecutiveFailures = 0;
  next.nextProbeAt = null;
  next.evidenceSource = options.evidenceSource || "success";
  next.evidence = {
    errorType: null,
    statusCode: null,
    retryable: null,
    observedAt: options.observedAt || nowIso(),
    resetAt: null,
    billingHint: next.evidence && next.evidence.billingHint || null
  };
  return next;
}

function markSelected(record) {
  const next = clone(record);
  next.lastSelectedAt = nowIso();
  return next;
}

/**
 * Bootstrap from controlled historical evidence (§3.4).
 * Does not read auth; only profile metadata + optional result success stamps + explicit frozen list.
 */
function bootstrapAvailability(registry, options = {}, deps) {
  const dataRoot = options.dataRoot;
  const results = [];
  const frozenIds = new Set(options.frozenProfileIds || []);
  const successIds = new Set(options.recentSuccessProfileIds || []);

  for (const profile of registry.profiles || []) {
    const existingPath = availabilityPath(dataRoot, profile.profileId);
    if (fs.existsSync(existingPath) && !options.force) {
      results.push({ profileId: profile.profileId, action: "skip-existing" });
      continue;
    }
    let record = emptyAvailability(profile.profileId);
    if (frozenIds.has(profile.profileId) || frozenIds.has(profile.alias)) {
      record.state = "frozen";
      record.scope = "quota";
      record.evidenceSource = "controlled-historical-402";
      record.evidence = {
        errorType: "quota_exhausted",
        statusCode: 402,
        retryable: false,
        observedAt: options.frozenObservedAt || nowIso(),
        resetAt: null,
        billingHint: null
      };
      record.nextProbeAt = computeNextProbeAt({ resetAt: null, consecutiveFailures: 1 });
    } else if (successIds.has(profile.profileId) || successIds.has(profile.alias)) {
      record = markActive(record, { evidenceSource: "recent-success-capsule" });
    } else {
      record.state = "unknown";
      record.evidenceSource = "bootstrap-no-evidence";
    }
    deps.atomicWriteJson(availabilityPath(dataRoot, profile.profileId), {
      ...record,
      revision: 1,
      updatedAt: nowIso()
    });
    results.push({ profileId: profile.profileId, action: "bootstrapped", state: record.state });
  }
  return results;
}

function defaultProbePolicy() {
  return {
    mode: "disabled",
    realRequestPermission: "denied",
    maxProbesPerRun: 1
  };
}

function normalizeProbePolicy(input) {
  const base = defaultProbePolicy();
  if (!input || typeof input !== "object") return base;
  const mode = ["disabled", "when-no-active", "after-workload"].includes(input.mode) ? input.mode : "disabled";
  const realRequestPermission = ["allowed", "denied"].includes(input.realRequestPermission)
    ? input.realRequestPermission
    : "denied";
  const maxProbesPerRun = Number.isInteger(input.maxProbesPerRun) && input.maxProbesPerRun >= 0
    ? Math.min(input.maxProbesPerRun, 3)
    : 1;
  return { mode, realRequestPermission, maxProbesPerRun };
}

/**
 * Build candidate sets for pool or explicit selection (§4).
 */
function buildCandidateSets(registry, capsule, dataRoot, deps, nowMs = Date.now()) {
  const probePolicy = normalizeProbePolicy(capsule.probePolicy);
  const selectionMode = capsule.candidateProfileIds && capsule.candidateProfileIds.length
    ? "pool"
    : "explicit";

  let candidates = [];
  if (selectionMode === "pool") {
    for (const id of capsule.candidateProfileIds) {
      const profile = registry.profiles.find((p) => p.profileId === id);
      if (!profile) {
        candidates.push({ profileId: id, alias: null, missing: true, eligibility: "excluded", reason: "not-registered" });
        continue;
      }
      const record = loadAvailability(dataRoot, profile.profileId, deps);
      const evalResult = evaluateEligibility(record, nowMs);
      candidates.push({
        profileId: profile.profileId,
        alias: profile.alias,
        missing: false,
        record,
        ...evalResult
      });
    }
  } else {
    const alias = capsule.profile;
    const profile = registry.profiles.find((p) => p.alias === alias || p.profileId === alias);
    if (!profile) {
      return {
        selectionMode,
        probePolicy,
        workloadEligible: [],
        probeEligible: [],
        excluded: [],
        skippedReasons: [{ profileId: null, reason: "explicit-profile-missing" }],
        maintenanceProbePlanned: false
      };
    }
    const record = loadAvailability(dataRoot, profile.profileId, deps);
    const evalResult = evaluateEligibility(record, nowMs);
    // Explicit profile is never replaced by pool selection; eligibility only informs warnings.
    candidates.push({
      profileId: profile.profileId,
      alias: profile.alias,
      missing: false,
      record,
      ...evalResult,
      forced: true
    });
  }

  const workloadEligible = candidates.filter((c) => !c.missing && c.eligibility === "workloadEligible");
  const probeEligible = candidates.filter((c) => !c.missing && c.eligibility === "probeEligible");
  const excluded = candidates.filter((c) => c.missing || c.eligibility === "excluded");
  const skippedReasons = excluded.map((c) => ({
    profileId: c.profileId,
    alias: c.alias || null,
    reason: c.reason || c.eligibility
  }));

  let maintenanceProbePlanned = false;
  if (probePolicy.mode !== "disabled" && probePolicy.realRequestPermission === "allowed") {
    if (probePolicy.mode === "when-no-active" && workloadEligible.length === 0 && probeEligible.length > 0) {
      maintenanceProbePlanned = true;
    }
    if (probePolicy.mode === "after-workload") {
      maintenanceProbePlanned = probeEligible.length > 0;
    }
  }

  return {
    selectionMode,
    probePolicy,
    candidates,
    workloadEligible,
    probeEligible,
    excluded,
    skippedReasons,
    maintenanceProbePlanned
  };
}

/**
 * Select next profile under selection policy. Explicit never auto-replaced.
 */
function selectProfile(candidateSets, options = {}) {
  const { selectionMode, workloadEligible, probeEligible, probePolicy, skippedReasons, maintenanceProbePlanned } = candidateSets;

  if (selectionMode === "explicit") {
    const forced = (candidateSets.candidates || []).find((c) => c.forced);
    if (!forced || forced.missing) {
      return {
        ok: false,
        reason: "explicit-profile-unavailable",
        selected: null,
        selectionEvidence: { selectionMode, skippedReasons, maintenanceProbePlanned }
      };
    }
    return {
      ok: true,
      selected: forced,
      selectionEvidence: {
        selectionMode: "explicit",
        candidateProfileIds: [forced.profileId],
        skippedReasons,
        finalSelectedProfileId: forced.profileId,
        maintenanceProbePlanned: false,
        note: "explicit profile is never auto-replaced"
      }
    };
  }

  // pool: prefer active workload; optionally probe when authorized and no active
  if (workloadEligible.length > 0) {
    // least-recently-selected among active
    const sorted = workloadEligible.slice().sort((a, b) => {
      const ta = a.record && a.record.lastSelectedAt ? Date.parse(a.record.lastSelectedAt) : 0;
      const tb = b.record && b.record.lastSelectedAt ? Date.parse(b.record.lastSelectedAt) : 0;
      return ta - tb;
    });
    const pick = sorted[0];
    return {
      ok: true,
      selected: pick,
      selectionEvidence: {
        selectionMode: "pool",
        candidateProfileIds: (candidateSets.candidates || []).map((c) => c.profileId),
        skippedReasons,
        finalSelectedProfileId: pick.profileId,
        maintenanceProbePlanned,
        selectionClass: "workloadEligible"
      }
    };
  }

  if (
    probePolicy.mode === "when-no-active" &&
    probePolicy.realRequestPermission === "allowed" &&
    probeEligible.length > 0 &&
    options.allowProbeSelection
  ) {
    const pick = probeEligible[0];
    return {
      ok: true,
      selected: pick,
      selectionEvidence: {
        selectionMode: "pool",
        candidateProfileIds: (candidateSets.candidates || []).map((c) => c.profileId),
        skippedReasons,
        finalSelectedProfileId: pick.profileId,
        maintenanceProbePlanned: true,
        selectionClass: "probeEligible"
      }
    };
  }

  return {
    ok: false,
    reason: "no-eligible-profile",
    selected: null,
    selectionEvidence: {
      selectionMode: "pool",
      candidateProfileIds: (candidateSets.candidates || []).map((c) => c.profileId),
      skippedReasons,
      finalSelectedProfileId: null,
      maintenanceProbePlanned
    }
  };
}

/** WAL / task-run helpers */
function emptyTaskRun(taskId, runId) {
  return {
    schemaVersion: 5,
    runId,
    taskId,
    status: "planned",
    attempts: [],
    finalSelectedProfileId: null,
    finalResultRef: null,
    takeoverRequired: false,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
}

function writeTaskRun(dataRoot, taskRun, deps) {
  const file = runWalPath(dataRoot, taskRun.taskId, taskRun.runId);
  deps.ensureDir(path.dirname(file));
  const next = clone(taskRun);
  next.updatedAt = nowIso();
  deps.atomicWriteJson(file, next);
  return next;
}

function loadTaskRun(dataRoot, taskId, runId, deps) {
  const file = runWalPath(dataRoot, taskId, runId);
  if (!fs.existsSync(file)) return null;
  return deps.readJson(file);
}

/**
 * Crash recovery: mark leftover running WAL as interrupted; never invent success.
 */
function recoverInterruptedRuns(dataRoot, deps) {
  const root = path.join(dataRoot, "runs");
  if (!fs.existsSync(root)) return [];
  const recovered = [];
  for (const taskDir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!taskDir.isDirectory()) continue;
    const dir = path.join(root, taskDir.name);
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      const file = path.join(dir, name);
      let run;
      try {
        run = deps.readJson(file);
      } catch (_) {
        continue;
      }
      if (run && run.status === "running") {
        run.status = "interrupted";
        run.takeoverRequired = true;
        run.updatedAt = nowIso();
        deps.atomicWriteJson(file, run);
        recovered.push({ taskId: run.taskId, runId: run.runId, status: "interrupted" });
      }
    }
  }
  return recovered;
}

/**
 * Failover gate: only when clear 402 + no output + no tool events + empty changedFilesFinalState.
 */
function mayAutoFailoverAttempt(resultLike) {
  const classification = resultLike.errorClassification || {};
  if (classification.errorType !== "quota_exhausted") return { allowed: false, reason: "not-quota-exhausted" };
  const changes = (resultLike.boundaryCompliance && resultLike.boundaryCompliance.changedFilesFinalState) || resultLike.changedFilesFinalState || [];
  if (Array.isArray(changes) && changes.length > 0) {
    return { allowed: false, reason: "partial-modifications", takeoverRequired: true };
  }
  if (resultLike.hasToolEvents) return { allowed: false, reason: "tool-events-present", takeoverRequired: true };
  if (resultLike.hasOutput) return { allowed: false, reason: "output-present", takeoverRequired: true };
  return { allowed: true, reason: "clean-quota-exhausted" };
}

/**
 * Bounded billing signal from profile-owned logs only (§8).
 * Never follows reparse/symlink; rebuilds whitelisted object only.
 */
function readBillingSnapshot(profileGrokHome, deps) {
  const logsDir = path.join(profileGrokHome, "logs");
  const empty = { present: false, billingPeriodEnd: null, source: null, note: null };
  if (!fs.existsSync(logsDir)) return { ...empty, note: "no-logs-dir" };

  let entries;
  try {
    entries = fs.readdirSync(logsDir, { withFileTypes: true });
  } catch (_) {
    return { ...empty, note: "logs-unreadable" };
  }

  const candidates = entries
    .filter((e) => e.isFile() && /\.(jsonl|log|json)$/i.test(e.name))
    .map((e) => path.join(logsDir, e.name));

  let best = null;
  for (const file of candidates) {
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) continue;
      if (stat.size > BILLING_MAX_FILE_BYTES) continue;
      // refuse if any ancestor under logs is a symlink beyond file check already done
      if (deps.checkNoReparse) {
        try {
          deps.checkNoReparse(file, logsDir);
        } catch (_) {
          continue;
        }
      }
      const text = fs.readFileSync(file, "utf8");
      const lines = text.split(/\r?\n/).slice(-BILLING_MAX_LINES_SCAN);
      for (const line of lines) {
        if (!line || line.length > BILLING_MAX_LINE_CHARS) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch (_) {
          continue;
        }
        if (!isObject(event)) continue;
        const ts = event.ts || event.timestamp || event.time || event.observedAt;
        const tsMs = ts ? Date.parse(ts) : NaN;
        const cfg = isObject(event.ctx) && isObject(event.ctx.config) ? event.ctx.config
          : isObject(event.config) ? event.config
            : isObject(event.ctx) ? event.ctx
              : null;
        if (!cfg) continue;
        // rebuild whitelist-only object (keys only, never secret values)
        const rebuilt = {};
        for (const key of BILLING_CTX_WHITELIST) {
          if (Object.prototype.hasOwnProperty.call(cfg, key)) rebuilt[key] = cfg[key];
        }
        if (deps.hasSecretKeys && deps.hasSecretKeys(rebuilt)) continue;
        const periodEnd = rebuilt.billingPeriodEnd || rebuilt.periodEnd || rebuilt.resetAt || null;
        const candidate = {
          present: Boolean(periodEnd),
          billingPeriodEnd: periodEnd,
          usedPercent: typeof rebuilt.usedPercent === "number" ? rebuilt.usedPercent
            : typeof rebuilt.quotaUsedPercent === "number" ? rebuilt.quotaUsedPercent : null,
          source: path.basename(file),
          ts: Number.isFinite(tsMs) ? new Date(tsMs).toISOString() : null,
          note: "billingPeriodEnd only influences nextProbeAt; never grants active"
        };
        if (!best || (candidate.ts && (!best.ts || candidate.ts > best.ts))) best = candidate;
      }
    } catch (_) {
      continue;
    }
  }
  return best || { ...empty, note: "no-valid-billing-record" };
}

/**
 * Apply billingPeriodEnd to nextProbeAt only — never promote to active.
 */
function applyBillingToNextProbe(record, billing) {
  if (!billing || !billing.billingPeriodEnd) return { changed: false, record };
  const next = clone(record);
  next.evidence = next.evidence || {};
  next.evidence.billingHint = {
    billingPeriodEnd: billing.billingPeriodEnd,
    usedPercent: billing.usedPercent,
    source: billing.source
  };
  if (next.state === "frozen" || next.state === "cooldown") {
    const resetAt = billing.billingPeriodEnd;
    next.evidence.resetAt = resetAt;
    next.nextProbeAt = computeNextProbeAt({
      resetAt,
      consecutiveFailures: next.consecutiveFailures || 0
    });
    return { changed: true, record: next };
  }
  return { changed: false, record: next };
}

/** Versioned deployment pointer helpers (§11) — no service control. */
function buildCurrentPointer(meta) {
  return {
    version: meta.version,
    releasePath: meta.releasePath,
    previousVersion: meta.previousVersion || null,
    dataRoot: meta.dataRoot,
    registryPath: meta.registryPath,
    schemaVersions: meta.schemaVersions || {
      taskCapsule: 3,
      resultCapsule: 3,
      taskRun: 5,
      availability: 5
    },
    manifestSha256: meta.manifestSha256 || null,
    updatedAt: nowIso()
  };
}

function readCurrentPointer(pointerPath, deps) {
  if (!fs.existsSync(pointerPath)) return null;
  const value = deps.readJson(pointerPath);
  if (!isObject(value) || !value.version || !value.releasePath || !value.dataRoot) {
    throw new Error("CURRENT_POINTER_INVALID");
  }
  return value;
}

/**
 * UTF-16 LE regression guard for stderr classification input.
 * Provider always uses utf8 spawn encoding; this normalizes accidental UTF-16 buffers.
 */
function normalizeClassifierText(input) {
  if (Buffer.isBuffer(input)) {
    if (input.length >= 2 && input[0] === 0xff && input[1] === 0xfe) {
      return input.toString("utf16le");
    }
    // detect sparse nulls typical of UTF-16LE misread as latin1
    const sample = input.slice(0, Math.min(input.length, 64));
    let nulls = 0;
    for (let i = 1; i < sample.length; i += 2) if (sample[i] === 0) nulls += 1;
    if (nulls > sample.length / 4) return input.toString("utf16le");
    return input.toString("utf8");
  }
  const text = String(input || "");
  if (text.includes("\u0000")) {
    try {
      return Buffer.from(text, "binary").toString("utf16le").replace(/\u0000/g, "");
    } catch (_) {
      return text.replace(/\u0000/g, "");
    }
  }
  return text;
}

function classifyFromExecution(execution = {}, options = {}) {
  const stderr = normalizeClassifierText(options.redactText
    ? options.redactText(execution.stderr || "")
    : (execution.stderr || ""));
  const stdout = options.redactText
    ? options.redactText(execution.stdout || "")
    : (execution.stdout || "");
  // Prefer structured status from stderr JSON snippets when present
  let statusCode = options.statusCode;
  if (statusCode == null) {
    const m = stderr.match(/"status_code"\s*:\s*(\d+)/) || stderr.match(/status_code["\s:=]+(\d+)/i);
    if (m) statusCode = Number(m[1]);
  }
  let retryable = options.retryable;
  if (retryable == null) {
    const m = stderr.match(/"is_retryable"\s*:\s*(true|false)/i);
    if (m) retryable = m[1].toLowerCase() === "true";
  }
  return classifyError({
    statusCode,
    exitCode: execution.status,
    retryable,
    stderr,
    stdout,
    message: options.message
  });
}

function poolStatusEnrichment(profiles, dataRoot, deps, nowMs = Date.now()) {
  return profiles.map((profile) => {
    const record = loadAvailability(dataRoot, profile.profileId, deps);
    const eligibility = evaluateEligibility(record, nowMs);
    return {
      ...profile,
      availability: {
        state: record.state,
        effectiveState: eligibility.effectiveState,
        eligibility: eligibility.eligibility,
        scope: record.scope,
        nextProbeAt: record.nextProbeAt,
        lastSelectedAt: record.lastSelectedAt,
        revision: record.revision
      }
    };
  });
}

module.exports = {
  AVAILABILITY_SCHEMA_VERSION,
  AVAILABILITY_STATES,
  ERROR_TYPES,
  PROFILE_ATTRIBUTABLE,
  emptyAvailability,
  validateAvailabilityRecord,
  availabilityPath,
  availabilityDir,
  runWalPath,
  loadAvailability,
  writeAvailabilityCas,
  computeBackoffMs,
  computeNextProbeAt,
  evaluateEligibility,
  classifyError,
  classifyFromExecution,
  shouldTouchAvailability,
  applyClassificationToAvailability,
  markActive,
  markSelected,
  bootstrapAvailability,
  defaultProbePolicy,
  normalizeProbePolicy,
  buildCandidateSets,
  selectProfile,
  emptyTaskRun,
  writeTaskRun,
  loadTaskRun,
  recoverInterruptedRuns,
  mayAutoFailoverAttempt,
  readBillingSnapshot,
  applyBillingToNextProbe,
  buildCurrentPointer,
  readCurrentPointer,
  normalizeClassifierText,
  poolStatusEnrichment
};
