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
/** r8: quota freeze hard cap ≤4h (jitter only downward). */
const QUOTA_MAX_BACKOFF_MS = 4 * 60 * 60 * 1000;
const MIN_PROBE_INTERVAL_MS = QUOTA_MAX_BACKOFF_MS;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX_IN_WINDOW = 4;
const MAINTENANCE_SCHEMA_VERSION = 6;
const JITTER_RATIO = 0.15;
const BILLING_MAX_FILE_BYTES = 2 * 1024 * 1024;
const BILLING_MAX_LINE_CHARS = 32 * 1024;
const BILLING_MAX_LINES_SCAN = 500;
const BILLING_CTX_WHITELIST = Object.freeze([
  "billingPeriodEnd", "periodEnd", "resetAt", "usedPercent", "quotaUsedPercent", "status",
  "creditUsagePercent", "billingPeriodStart"
]);
const BILLING_RECOVERED_PERCENT_THRESHOLD = 95;
const PROBE_PROMPT = "Reply with exactly: grok-availability-ok";
const PROBE_EXPECT = "grok-availability-ok";

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
function writeAvailabilityCas(dataRoot, profileId, nextRecord, expectedRevision, deps, options = {}) {
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
  if (options.preserveTarget === true) {
    if (Number(toWrite.revision) !== expectedRevision + 1 || typeof toWrite.updatedAt !== "string" || !toWrite.updatedAt) {
      return { ok: false, code: "AVAILABILITY_TARGET_INVALID", expectedRevision };
    }
  } else {
    toWrite.revision = expectedRevision + 1;
    toWrite.updatedAt = nowIso();
  }
  deps.atomicWriteJson(file, toWrite);
  return { ok: true, record: toWrite };
}

function computeBackoffMs(consecutiveFailures = 0, maxBackoffMs = MAX_BACKOFF_MS) {
  const cap = Number.isFinite(maxBackoffMs) ? maxBackoffMs : MAX_BACKOFF_MS;
  const exp = Math.min(cap, BASE_BACKOFF_MS * Math.pow(2, Math.max(0, consecutiveFailures)));
  const jitter = exp * JITTER_RATIO * (Math.random() * 2 - 1);
  return Math.max(BASE_BACKOFF_MS, Math.floor(exp + jitter));
}

/**
 * Rate-limit / non-quota nextProbe (v5): may honor far resetAt; backoff cap 24h.
 * Jitter may push slightly past resetAt (v5 behavior preserved).
 */
function computeRateLimitNextProbeAt({ resetAt, consecutiveFailures = 0, now = Date.now() } = {}) {
  if (resetAt) {
    const resetMs = Date.parse(resetAt);
    if (Number.isFinite(resetMs) && resetMs > now) {
      const jitter = Math.floor((resetMs - now) * JITTER_RATIO * Math.random());
      return new Date(resetMs + jitter).toISOString();
    }
  }
  return new Date(now + computeBackoffMs(consecutiveFailures, MAX_BACKOFF_MS)).toISOString();
}

/**
 * r8 quota nextProbe: hard ≤now+4h even when resetAt/billing is days away.
 * Jitter only downward (never past the 4h wall or past resetAt).
 */
function computeQuotaNextProbeAt({ resetAt, consecutiveFailures = 0, now = Date.now() } = {}) {
  const hardCap = now + QUOTA_MAX_BACKOFF_MS;
  if (resetAt) {
    const resetMs = Date.parse(resetAt);
    if (Number.isFinite(resetMs) && resetMs > now) {
      const target = Math.min(resetMs, hardCap);
      const span = Math.max(0, target - now);
      const downJitter = Math.floor(span * JITTER_RATIO * Math.random());
      return new Date(target - downJitter).toISOString();
    }
  }
  const backoff = computeBackoffMs(consecutiveFailures, QUOTA_MAX_BACKOFF_MS);
  const candidate = Math.min(now + backoff, hardCap);
  return new Date(candidate).toISOString();
}

/** @deprecated Prefer computeQuotaNextProbeAt / computeRateLimitNextProbeAt. Alias keeps rate-limit v5. */
function computeNextProbeAt(opts = {}) {
  return computeRateLimitNextProbeAt(opts);
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

  // rate limited — account-level only with account keywords or credible Retry-After.
  // is_retryable=true alone is NOT account-level evidence (§5; avoids over-attribution).
  const has429 = statusCode === 429 || /\b429\b/.test(text) || /rate.?limit/i.test(lower);
  if (has429) {
    const retryAfterMatch = text.match(/retry-after["\s:=]+(\d+)/i) || text.match(/retry_after["\s:=]+(\d+)/i);
    const accountLevel =
      /account|profile|user.?quota|per-?user/i.test(lower) ||
      Boolean(retryAfterMatch);
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
    next.nextProbeAt = computeQuotaNextProbeAt({
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
    next.nextProbeAt = computeRateLimitNextProbeAt({
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
      record.nextProbeAt = computeQuotaNextProbeAt({ resetAt: null, consecutiveFailures: 1 });
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
 * Safe self-rescue gate: when-no-active + probe realRequestPermission allowed.
 * Workload realRequestPermission alone never authorizes probe selection.
 */
function probeSelfRescueAllowed(probePolicy, options = {}) {
  const policy = normalizeProbePolicy(probePolicy);
  if (policy.mode !== "when-no-active") return false;
  if (policy.realRequestPermission !== "allowed") return false;
  if (options.allowProbeSelection === false) return false;
  const probesUsed = Number(options.probesUsed) || 0;
  const maxProbes = Number.isInteger(options.maxProbesPerRun)
    ? options.maxProbesPerRun
    : policy.maxProbesPerRun;
  if (probesUsed >= maxProbes) return false;
  return true;
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

  const probesUsed = Number(options.probesUsed) || 0;
  const maxProbesPerRun = Number.isInteger(options.maxProbesPerRun)
    ? options.maxProbesPerRun
    : (probePolicy && probePolicy.maxProbesPerRun) || 1;
  const allowProbe = options.allowProbeSelection === true
    && probeSelfRescueAllowed(probePolicy, { allowProbeSelection: true, probesUsed, maxProbesPerRun });

  if (allowProbe && probeEligible.length > 0) {
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
        selectionClass: "probeEligible",
        probesUsedBefore: probesUsed,
        maxProbesPerRun
      }
    };
  }

  const blockedByProbeCap = options.allowProbeSelection === true
    && probePolicy
    && probePolicy.mode === "when-no-active"
    && probePolicy.realRequestPermission === "allowed"
    && probeEligible.length > 0
    && probesUsed >= maxProbesPerRun;

  return {
    ok: false,
    reason: blockedByProbeCap ? "max-probes-per-run-exceeded" : "no-eligible-profile",
    selected: null,
    selectionEvidence: {
      selectionMode: "pool",
      candidateProfileIds: (candidateSets.candidates || []).map((c) => c.profileId),
      skippedReasons,
      finalSelectedProfileId: null,
      maintenanceProbePlanned,
      probesUsed,
      maxProbesPerRun
    }
  };
}

/** WAL / task-run helpers */
function emptyTaskRun(taskId, runId, owner = null) {
  return {
    schemaVersion: 6,
    runId,
    taskId,
    owner: owner ? clone(owner) : null,
    revision: 0,
    status: "planned",
    attempts: [],
    finalSelectedProfileId: null,
    finalResultRef: null,
    takeoverRequired: false,
    probesUsed: 0,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
}

function taskRunError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function writeTaskRun(dataRoot, taskRun, deps) {
  const file = runWalPath(dataRoot, taskRun.taskId, taskRun.runId);
  const expectedRevision = Number(taskRun.revision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw taskRunError("TASK_RUN_REVISION_INVALID", "Task-run revision must be a non-negative integer.");
  }
  if (typeof deps.taskRunTransaction !== "function") {
    throw taskRunError("TASK_RUN_TRANSACTION_UNAVAILABLE", "Task-run transaction authority is unavailable.");
  }
  return deps.taskRunTransaction(file, clone(taskRun), { expectedRevision });
}

function loadTaskRun(dataRoot, taskId, runId, deps) {
  const file = runWalPath(dataRoot, taskId, runId);
  if (!fs.existsSync(file)) return null;
  return deps.readJson(file);
}

/**
 * Crash recovery: mark a running WAL interrupted only after proving that its
 * exact owner process identity no longer exists. Missing/unverifiable identity
 * is fail-closed and leaves the WAL untouched.
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
        const inspection = typeof deps.inspectRunOwner === "function"
          ? deps.inspectRunOwner(run.owner)
          : { state: "unverifiable", reason: "owner-inspector-missing" };
        if (!inspection || inspection.state !== "dead") continue;
        try {
          let latest;
          try {
            latest = deps.readJson(file);
          } catch (_) {
            continue;
          }
          const sameOwner = latest && latest.owner && run.owner
            && latest.owner.pid === run.owner.pid
            && latest.owner.processStartTicks === run.owner.processStartTicks;
          if (!latest || latest.status !== "running" || !sameOwner) continue;
          if (typeof deps.beforeRecoveryCommit === "function") {
            deps.beforeRecoveryCommit({ dataRoot, file, run: clone(latest) });
          }
          latest.status = "interrupted";
          latest.takeoverRequired = true;
          const written = deps.taskRunTransaction(file, latest, {
            expectedRevision: latest.revision,
            expectedStatus: "running",
            expectedOwner: run.owner
          });
          recovered.push({
            taskId: written.taskId,
            runId: written.runId,
            status: "interrupted",
            reason: inspection.reason || "owner-dead"
          });
        } catch (error) {
          if (!error || !["TASK_RUN_CAS_CONFLICT", "TASK_RUN_TERMINAL_CONFLICT"].includes(error.code)) throw error;
        }
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
 * Bounded billing signal from profile-owned logs only (§8 / r8 §4).
 * Never follows reparse/symlink; rebuilds whitelisted object only.
 */
function readBillingSnapshot(profileGrokHome, deps) {
  const logsDir = path.join(profileGrokHome, "logs");
  const empty = {
    present: false,
    billingPeriodEnd: null,
    billingPeriodStart: null,
    creditUsagePercent: null,
    percentState: null,
    source: null,
    note: null,
    ts: null
  };
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
    let descriptor = null;
    try {
      if (deps.checkNoReparse) {
        try {
          deps.checkNoReparse(file, logsDir);
        } catch (_) {
          continue;
        }
      }
      descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size > BILLING_MAX_FILE_BYTES) continue;
      if (deps.checkNoReparse) {
        try {
          deps.checkNoReparse(file, logsDir);
        } catch (_) {
          continue;
        }
      }
      const text = fs.readFileSync(descriptor, "utf8");
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
        const rebuilt = {};
        for (const key of BILLING_CTX_WHITELIST) {
          if (Object.prototype.hasOwnProperty.call(cfg, key)) rebuilt[key] = cfg[key];
        }
        if (deps.hasSecretKeys && deps.hasSecretKeys(rebuilt)) continue;

        let creditUsagePercent = null;
        if (typeof rebuilt.creditUsagePercent === "number" && Number.isFinite(rebuilt.creditUsagePercent)) {
          creditUsagePercent = rebuilt.creditUsagePercent;
        }
        let billingPeriodStart = null;
        if (typeof rebuilt.billingPeriodStart === "string") {
          const startMs = Date.parse(rebuilt.billingPeriodStart);
          if (Number.isFinite(startMs)) billingPeriodStart = new Date(startMs).toISOString();
        }
        const periodEnd = rebuilt.billingPeriodEnd || rebuilt.periodEnd || rebuilt.resetAt || null;
        let periodEndIso = null;
        if (typeof periodEnd === "string" && Number.isFinite(Date.parse(periodEnd))) {
          periodEndIso = new Date(Date.parse(periodEnd)).toISOString();
        }
        const percentState = (creditUsagePercent !== null && creditUsagePercent < BILLING_RECOVERED_PERCENT_THRESHOLD)
          ? "recovered_lt_95"
          : null;
        const candidate = {
          present: Boolean(periodEndIso || billingPeriodStart || creditUsagePercent !== null),
          billingPeriodEnd: periodEndIso,
          billingPeriodStart,
          creditUsagePercent,
          percentState,
          usedPercent: typeof rebuilt.usedPercent === "number" ? rebuilt.usedPercent
            : typeof rebuilt.quotaUsedPercent === "number" ? rebuilt.quotaUsedPercent : null,
          source: path.basename(file),
          ts: Number.isFinite(tsMs) ? new Date(tsMs).toISOString() : null,
          note: "billing only influences nextProbeAt / early-probe eligibility; never grants active"
        };
        if (!best || (candidate.ts && (!best.ts || candidate.ts > best.ts))) best = candidate;
      }
    } catch (_) {
      continue;
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor);
    }
  }
  return best || { ...empty, note: "no-valid-billing-record" };
}

/**
 * Apply billingPeriodEnd to nextProbeAt only — never promote to active.
 * Quota freezes use computeQuotaNextProbeAt (≤4h); cooldown keeps v5 rate-limit path.
 */
function applyBillingToNextProbe(record, billing) {
  if (!billing || !billing.billingPeriodEnd) return { changed: false, record };
  const next = clone(record);
  next.evidence = next.evidence || {};
  next.evidence.billingHint = {
    billingPeriodEnd: billing.billingPeriodEnd,
    billingPeriodStart: billing.billingPeriodStart || null,
    creditUsagePercent: billing.creditUsagePercent != null ? billing.creditUsagePercent : null,
    percentState: billing.percentState || null,
    usedPercent: billing.usedPercent,
    source: billing.source
  };
  if (next.state === "frozen" || next.state === "cooldown") {
    const resetAt = billing.billingPeriodEnd;
    next.evidence.resetAt = resetAt;
    if (next.scope === "quota" || next.state === "frozen") {
      next.nextProbeAt = computeQuotaNextProbeAt({
        resetAt,
        consecutiveFailures: next.consecutiveFailures || 0
      });
    } else {
      next.nextProbeAt = computeRateLimitNextProbeAt({
        resetAt,
        consecutiveFailures: next.consecutiveFailures || 0
      });
    }
    return { changed: true, record: next };
  }
  return { changed: false, record: next };
}

/** Clamp legacy quota nextProbeAt > now+4h down to ≤now+4h (CAS caller). */
function clampQuotaNextProbeAt(record, nowMs = Date.now()) {
  if (!record || record.scope !== "quota") return { changed: false, record };
  if (!record.nextProbeAt) return { changed: false, record };
  const nextMs = Date.parse(record.nextProbeAt);
  if (!Number.isFinite(nextMs)) return { changed: false, record };
  const cap = nowMs + QUOTA_MAX_BACKOFF_MS;
  if (nextMs <= cap) return { changed: false, record };
  const next = clone(record);
  next.nextProbeAt = new Date(cap).toISOString();
  return { changed: true, record: next };
}

// ─── r8 maintenance sidecars / pool-config / rate-window / journal ───

function maintenanceRoot(dataRoot) {
  return path.join(dataRoot, "maintenance");
}

function maintenanceProfilePath(dataRoot, profileId) {
  return path.join(maintenanceRoot(dataRoot), "profiles", `${profileId}.json`);
}

function poolConfigPath(dataRoot) {
  return path.join(maintenanceRoot(dataRoot), "pool-config.json");
}

function rateWindowPath(dataRoot) {
  return path.join(maintenanceRoot(dataRoot), "rate-window.json");
}

function maintenanceRunDir(dataRoot, maintenanceTaskId) {
  const safe = String(maintenanceTaskId).replace(/[^a-z0-9_.-]/gi, "_");
  return path.join(maintenanceRoot(dataRoot), "runs", safe);
}

function maintenanceRunPath(dataRoot, maintenanceTaskId, invocationId) {
  return path.join(maintenanceRunDir(dataRoot, maintenanceTaskId), `${invocationId}.json`);
}

function deployPointersDir(dataRoot) {
  return path.join(dataRoot, "deploy", "pointers");
}

function deployPointerPath(dataRoot, version) {
  const safe = String(version).replace(/[^a-z0-9._+-]/gi, "_");
  return path.join(deployPointersDir(dataRoot), `${safe}.json`);
}

function emptyMaintenanceProfile(profileId, overrides = {}) {
  return {
    schemaVersion: MAINTENANCE_SCHEMA_VERSION,
    profileId,
    revision: 0,
    updatedAt: nowIso(),
    episodeId: null,
    freezeObservedAt: null,
    episodePeriodStart: null,
    earlyBillingProbeConsumed: false,
    consumedBillingSignalId: null,
    lastBillingObservedAt: null,
    lastMaintenanceProbeAt: null,
    minProbeIntervalMs: MIN_PROBE_INTERVAL_MS,
    availabilityRevisionSeen: null,
    availabilityStateSeen: null,
    ...overrides
  };
}

function validateMaintenanceProfile(record) {
  if (!isObject(record)) return { ok: false, reason: "not-object" };
  if (record.schemaVersion !== MAINTENANCE_SCHEMA_VERSION) return { ok: false, reason: "schema" };
  if (typeof record.profileId !== "string") return { ok: false, reason: "profileId" };
  if (typeof record.revision !== "number" || record.revision < 0) return { ok: false, reason: "revision" };
  if (typeof record.earlyBillingProbeConsumed !== "boolean") return { ok: false, reason: "earlyBillingProbeConsumed" };
  if (record.minProbeIntervalMs !== MIN_PROBE_INTERVAL_MS) return { ok: false, reason: "minProbeIntervalMs" };
  return { ok: true };
}

function loadMaintenanceProfile(dataRoot, profileId, deps) {
  const file = maintenanceProfilePath(dataRoot, profileId);
  if (!fs.existsSync(file)) return emptyMaintenanceProfile(profileId);
  try {
    const record = deps.readJson(file);
    const check = validateMaintenanceProfile(record);
    if (!check.ok) return emptyMaintenanceProfile(profileId, { episodeId: null });
    return record;
  } catch (_) {
    return emptyMaintenanceProfile(profileId);
  }
}

function writeMaintenanceProfileCas(dataRoot, profileId, nextRecord, expectedRevision, deps, options = {}) {
  const file = maintenanceProfilePath(dataRoot, profileId);
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
    return { ok: false, code: "SIDECAR_CAS_CONFLICT", currentRevision, expectedRevision };
  }
  const toWrite = clone(nextRecord);
  toWrite.profileId = profileId;
  toWrite.schemaVersion = MAINTENANCE_SCHEMA_VERSION;
  toWrite.minProbeIntervalMs = MIN_PROBE_INTERVAL_MS;
  if (options.preserveTarget === true) {
    if (Number(toWrite.revision) !== expectedRevision + 1 || typeof toWrite.updatedAt !== "string" || !toWrite.updatedAt) {
      return { ok: false, code: "SIDECAR_TARGET_INVALID", expectedRevision };
    }
  } else {
    toWrite.revision = expectedRevision + 1;
    toWrite.updatedAt = nowIso();
  }
  deps.atomicWriteJson(file, toWrite);
  return { ok: true, record: toWrite };
}

/**
 * Open a freeze episode on first quota freeze (or missing episodeId).
 * Re-freeze after 402 keeps the same episode (r8 same-episode rule).
 */
function openOrRefreshFreezeEpisode(sidecar, availabilityRecord, billing, nowMs = Date.now()) {
  const next = clone(sidecar || emptyMaintenanceProfile(availabilityRecord.profileId));
  if (!next.episodeId) {
    next.episodeId = crypto.randomUUID();
    next.freezeObservedAt = (availabilityRecord.evidence && availabilityRecord.evidence.observedAt)
      || nowIso(new Date(nowMs));
    next.episodePeriodStart = (billing && billing.billingPeriodStart) || null;
    next.earlyBillingProbeConsumed = false;
    next.consumedBillingSignalId = null;
  }
  next.availabilityRevisionSeen = availabilityRecord.revision;
  next.availabilityStateSeen = availabilityRecord.state;
  return next;
}

/** Clear episode fields after successful recovery to active. */
function clearFreezeEpisode(sidecar) {
  const next = clone(sidecar || emptyMaintenanceProfile(sidecar && sidecar.profileId || "00000000-0000-4000-8000-000000000000"));
  next.episodeId = null;
  next.freezeObservedAt = null;
  next.episodePeriodStart = null;
  next.earlyBillingProbeConsumed = false;
  next.consumedBillingSignalId = null;
  next.availabilityStateSeen = "active";
  return next;
}

function billingSignalId(profileId, episodeId, billingPeriodStart, percentState) {
  const material = [
    String(profileId || ""),
    String(episodeId || ""),
    String(billingPeriodStart || ""),
    String(percentState || "")
  ].join("|");
  return crypto.createHash("sha256").update(material).digest("hex");
}

/**
 * Early billing probe gate (r8 §5). Never grants active.
 * Requires: billing.ts > freezeObservedAt, billingPeriodStart > episodePeriodStart,
 * billing.ts > lastBillingObservedAt, earlyBillingProbeConsumed === false, percentState recovered_lt_95.
 */
function evaluateEarlyBillingProbe(sidecar, billing) {
  if (!sidecar || !billing) {
    return { eligible: false, reason: "missing-input", billingSignalId: null };
  }
  if (sidecar.earlyBillingProbeConsumed === true) {
    return { eligible: false, reason: "already-consumed", billingSignalId: null };
  }
  if (billing.percentState !== "recovered_lt_95") {
    return { eligible: false, reason: "percent-not-recovered", billingSignalId: null };
  }
  if (!billing.ts || !sidecar.freezeObservedAt) {
    return { eligible: false, reason: "missing-timestamps", billingSignalId: null };
  }
  const ts = Date.parse(billing.ts);
  const freezeAt = Date.parse(sidecar.freezeObservedAt);
  if (!Number.isFinite(ts) || !Number.isFinite(freezeAt) || !(ts > freezeAt)) {
    return { eligible: false, reason: "ts-not-after-freeze", billingSignalId: null };
  }
  if (!billing.billingPeriodStart) {
    return { eligible: false, reason: "billingPeriodStart-missing", billingSignalId: null };
  }
  const periodStart = Date.parse(billing.billingPeriodStart);
  if (!Number.isFinite(periodStart)) {
    return { eligible: false, reason: "billingPeriodStart-invalid", billingSignalId: null };
  }
  if (sidecar.episodePeriodStart) {
    const episodeStart = Date.parse(sidecar.episodePeriodStart);
    if (!Number.isFinite(episodeStart) || !(periodStart > episodeStart)) {
      return { eligible: false, reason: "billingPeriodStart-not-newer-than-episode", billingSignalId: null };
    }
  }
  if (sidecar.lastBillingObservedAt) {
    const water = Date.parse(sidecar.lastBillingObservedAt);
    if (Number.isFinite(water) && !(ts > water)) {
      return { eligible: false, reason: "ts-not-after-watermark", billingSignalId: null };
    }
  }
  const signalId = billingSignalId(
    sidecar.profileId,
    sidecar.episodeId,
    billing.billingPeriodStart,
    billing.percentState
  );
  return { eligible: true, reason: "early-billing-hit", billingSignalId: signalId };
}

function defaultPoolConfig() {
  return {
    schemaVersion: MAINTENANCE_SCHEMA_VERSION,
    revision: 0,
    updatedAt: nowIso(),
    autoProbe: {
      enabled: false,
      scope: "quota",
      quotaMaxBackoffMs: QUOTA_MAX_BACKOFF_MS,
      globalMaxProbesPerHour: RATE_MAX_IN_WINDOW,
      maxProbesPerTick: 2,
      minProbeIntervalMs: MIN_PROBE_INTERVAL_MS
    },
    authorization: {
      realRequestPermission: "denied",
      authorizationScope: "quota-maintenance-probe",
      authorizedProfileIds: [],
      authorizedAt: null,
      revokedAt: null
    },
    auditLog: []
  };
}

function validatePoolConfig(value) {
  if (!isObject(value)) return { ok: false, reason: "not-object" };
  if (value.schemaVersion !== MAINTENANCE_SCHEMA_VERSION) return { ok: false, reason: "schemaVersion" };
  if (typeof value.revision !== "number" || value.revision < 0) return { ok: false, reason: "revision" };
  if (!isObject(value.autoProbe)) return { ok: false, reason: "autoProbe" };
  if (value.autoProbe.scope !== "quota") return { ok: false, reason: "autoProbe.scope" };
  if (value.autoProbe.quotaMaxBackoffMs !== QUOTA_MAX_BACKOFF_MS) return { ok: false, reason: "quotaMaxBackoffMs" };
  if (value.autoProbe.globalMaxProbesPerHour !== RATE_MAX_IN_WINDOW) return { ok: false, reason: "globalMaxProbesPerHour" };
  if (value.autoProbe.maxProbesPerTick !== 2) return { ok: false, reason: "maxProbesPerTick" };
  if (value.autoProbe.minProbeIntervalMs !== MIN_PROBE_INTERVAL_MS) return { ok: false, reason: "minProbeIntervalMs" };
  if (typeof value.autoProbe.enabled !== "boolean") return { ok: false, reason: "autoProbe.enabled" };
  if (!isObject(value.authorization)) return { ok: false, reason: "authorization" };
  const auth = value.authorization;
  if (!["allowed", "denied"].includes(auth.realRequestPermission)) return { ok: false, reason: "realRequestPermission" };
  if (auth.authorizationScope !== "quota-maintenance-probe") return { ok: false, reason: "authorizationScope" };
  if (!Array.isArray(auth.authorizedProfileIds)) return { ok: false, reason: "authorizedProfileIds" };
  if (auth.realRequestPermission === "allowed") {
    if (typeof auth.authorizedAt !== "string" || !auth.authorizedAt) {
      return { ok: false, reason: "authorizedAt-required" };
    }
    if (auth.authorizedProfileIds.length < 1) {
      return { ok: false, reason: "authorizedProfileIds-min" };
    }
  }
  if (!Array.isArray(value.auditLog)) return { ok: false, reason: "auditLog" };
  return { ok: true };
}

function loadPoolConfig(dataRoot, deps) {
  const file = poolConfigPath(dataRoot);
  if (!fs.existsSync(file)) return { present: false, config: null, valid: true };
  try {
    const value = deps.readJson(file);
    const check = validatePoolConfig(value);
    if (!check.ok) return { present: true, config: value, valid: false, reason: check.reason };
    return { present: true, config: value, valid: true };
  } catch (error) {
    return { present: true, config: null, valid: false, reason: error && error.message || "read-failed" };
  }
}

function writePoolConfigCas(dataRoot, nextConfig, expectedRevision, deps) {
  const file = poolConfigPath(dataRoot);
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
    return { ok: false, code: "POOL_CONFIG_CAS_CONFLICT", currentRevision, expectedRevision };
  }
  const toWrite = clone(nextConfig);
  toWrite.schemaVersion = MAINTENANCE_SCHEMA_VERSION;
  toWrite.revision = expectedRevision + 1;
  toWrite.updatedAt = nowIso();
  const check = validatePoolConfig(toWrite);
  if (!check.ok) return { ok: false, code: "POOL_CONFIG_INVALID", reason: check.reason };
  deps.atomicWriteJson(file, toWrite);
  return { ok: true, config: toWrite };
}

function emptyRateWindow() {
  return {
    schemaVersion: MAINTENANCE_SCHEMA_VERSION,
    requests: [],
    windowMs: RATE_WINDOW_MS,
    maxInWindow: RATE_MAX_IN_WINDOW,
    revision: 0
  };
}

function validateRateWindow(value) {
  if (!isObject(value)) return { ok: false, reason: "not-object" };
  if (value.schemaVersion !== MAINTENANCE_SCHEMA_VERSION) return { ok: false, reason: "schema" };
  if (!Array.isArray(value.requests)) return { ok: false, reason: "requests" };
  if (value.windowMs !== RATE_WINDOW_MS) return { ok: false, reason: "windowMs" };
  if (value.maxInWindow !== RATE_MAX_IN_WINDOW) return { ok: false, reason: "maxInWindow" };
  if (typeof value.revision !== "number" || value.revision < 0) return { ok: false, reason: "revision" };
  return { ok: true };
}

function loadRateWindow(dataRoot, deps) {
  const file = rateWindowPath(dataRoot);
  if (!fs.existsSync(file)) return emptyRateWindow();
  try {
    const value = deps.readJson(file);
    const check = validateRateWindow(value);
    if (!check.ok) return { ...emptyRateWindow(), _corrupt: true, _reason: check.reason };
    return value;
  } catch (_) {
    return { ...emptyRateWindow(), _corrupt: true, _reason: "read-failed" };
  }
}

/**
 * Strict sliding window ≤4/rolling 1h.
 * Clock rollback (now < latest ts): refuse append.
 * Corrupt window: fail-closed (treat full).
 * Reserved slots are never rolled back on crash.
 */
function tryReserveRateSlot(dataRoot, deps, nowMs = Date.now()) {
  const file = rateWindowPath(dataRoot);
  deps.ensureDir(path.dirname(file));
  const current = loadRateWindow(dataRoot, deps);
  if (current._corrupt) {
    return { ok: false, reason: "rate-window-corrupt-fail-closed", window: current };
  }
  const cutoff = nowMs - RATE_WINDOW_MS;
  const kept = (current.requests || []).filter((ts) => {
    const ms = Date.parse(ts);
    return Number.isFinite(ms) && ms >= cutoff;
  });
  if (kept.length > 0) {
    const latest = Math.max(...kept.map((ts) => Date.parse(ts)));
    if (Number.isFinite(latest) && nowMs < latest) {
      return { ok: false, reason: "clock-rollback", window: current };
    }
  }
  if (kept.length >= RATE_MAX_IN_WINDOW) {
    return { ok: false, reason: "rate-window-full", window: { ...current, requests: kept } };
  }
  const slotTs = new Date(nowMs).toISOString();
  const next = {
    schemaVersion: MAINTENANCE_SCHEMA_VERSION,
    requests: kept.concat([slotTs]),
    windowMs: RATE_WINDOW_MS,
    maxInWindow: RATE_MAX_IN_WINDOW,
    revision: (Number(current.revision) || 0) + 1
  };
  let diskRevision = 0;
  if (fs.existsSync(file)) {
    try {
      diskRevision = Number(deps.readJson(file).revision) || 0;
    } catch (_) {
      return { ok: false, reason: "rate-window-corrupt-fail-closed" };
    }
  }
  if (diskRevision !== (Number(current.revision) || 0)) {
    return { ok: false, reason: "rate-window-cas-conflict" };
  }
  deps.atomicWriteJson(file, next);
  return { ok: true, tokenSlotTs: slotTs, window: next };
}

function emptyMaintenanceRun(fields = {}) {
  return {
    schemaVersion: MAINTENANCE_SCHEMA_VERSION,
    maintenanceTaskId: fields.maintenanceTaskId || "",
    maintenanceInvocationId: fields.maintenanceInvocationId || "",
    profileId: fields.profileId || "",
    operation: fields.operation || "start-probe",
    phase: fields.phase || "intent",
    status: fields.status || "planned",
    availabilityBefore: fields.availabilityBefore != null ? fields.availabilityBefore : null,
    availabilityTarget: fields.availabilityTarget != null ? fields.availabilityTarget : null,
    sidecarBefore: fields.sidecarBefore != null ? fields.sidecarBefore : null,
    sidecarTarget: fields.sidecarTarget != null ? fields.sidecarTarget : null,
    tokenSlotTs: fields.tokenSlotTs != null ? fields.tokenSlotTs : null,
    billingSignalId: fields.billingSignalId != null ? fields.billingSignalId : null,
    resultRef: fields.resultRef != null ? fields.resultRef : null,
    ledgerRef: fields.ledgerRef != null ? fields.ledgerRef : null,
    requestStartedAt: fields.requestStartedAt != null ? fields.requestStartedAt : null,
    slotFailure: fields.slotFailure != null ? fields.slotFailure : null,
    createdAt: fields.createdAt || nowIso(),
    updatedAt: fields.updatedAt || nowIso()
  };
}

function writeMaintenanceRun(dataRoot, journal, deps) {
  const file = maintenanceRunPath(dataRoot, journal.maintenanceTaskId, journal.maintenanceInvocationId);
  deps.ensureDir(path.dirname(file));
  const next = clone(journal);
  next.schemaVersion = MAINTENANCE_SCHEMA_VERSION;
  next.updatedAt = nowIso();
  deps.atomicWriteJson(file, next);
  return next;
}

function loadMaintenanceRun(dataRoot, maintenanceTaskId, invocationId, deps) {
  const file = maintenanceRunPath(dataRoot, maintenanceTaskId, invocationId);
  if (!fs.existsSync(file)) return null;
  return deps.readJson(file);
}

function deepEqualJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Three-state file recovery: compare current/before/target.
 * current==before → not written → forward-write target via CAS
 * current==target → already written
 * neither → third-party advance → conservative interrupt
 */
function threeStateFilePlan(current, before, target) {
  if (deepEqualJson(current, target)) return { action: "done" };
  if (deepEqualJson(current, before)) return { action: "forward" };
  return { action: "interrupt", reason: "third-party-advance" };
}

function stripRuntimeNoise(record) {
  if (!record || typeof record !== "object") return record;
  return clone(record);
}

function stripSidecarNoise(record) {
  if (!record || typeof record !== "object") return record;
  return clone(record);
}

/**
 * Startup reconciliation for maintenance/runs (r8 §7).
 * Never replays probes; never grants active from journal alone.
 */
function reconcileMaintenanceRuns(dataRoot, deps) {
  const root = path.join(maintenanceRoot(dataRoot), "runs");
  if (!fs.existsSync(root)) return [];
  const outcomes = [];
  for (const taskDir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!taskDir.isDirectory()) continue;
    const dir = path.join(root, taskDir.name);
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      const file = path.join(dir, name);
      let journal;
      try {
        journal = deps.readJson(file);
      } catch (_) {
        continue;
      }
      if (!journal || journal.schemaVersion !== MAINTENANCE_SCHEMA_VERSION) continue;
      if (journal.status === "completed" || journal.status === "interrupted" || journal.status === "failed") {
        continue;
      }
      if (journal.requestStartedAt && !journal.resultRef) {
        journal.status = "interrupted";
        journal.phase = "finalized";
        journal.updatedAt = nowIso();
        deps.atomicWriteJson(file, journal);
        outcomes.push({
          maintenanceInvocationId: journal.maintenanceInvocationId,
          profileId: journal.profileId,
          status: "interrupted",
          reason: "request-started-no-replay"
        });
        continue;
      }
      if (journal.phase === "finalized") continue;

      const profileId = journal.profileId;
      const availCurrent = loadAvailability(dataRoot, profileId, deps);
      const sideCurrent = loadMaintenanceProfile(dataRoot, profileId, deps);

      const availPlan = threeStateFilePlan(
        stripRuntimeNoise(availCurrent),
        stripRuntimeNoise(journal.availabilityBefore),
        stripRuntimeNoise(journal.availabilityTarget)
      );
      const sidePlan = threeStateFilePlan(
        stripSidecarNoise(sideCurrent),
        stripSidecarNoise(journal.sidecarBefore),
        stripSidecarNoise(journal.sidecarTarget)
      );

      if (availPlan.action === "interrupt" || sidePlan.action === "interrupt") {
        journal.status = "interrupted";
        journal.phase = journal.phase === "intent" ? "intent" : journal.phase;
        journal.updatedAt = nowIso();
        deps.atomicWriteJson(file, journal);
        outcomes.push({
          maintenanceInvocationId: journal.maintenanceInvocationId,
          profileId,
          status: "interrupted",
          reason: availPlan.reason || sidePlan.reason || "third-party-advance"
        });
        continue;
      }

      if (availPlan.action === "forward" && journal.availabilityTarget) {
        const expected = journal.availabilityBefore && Number.isFinite(Number(journal.availabilityBefore.revision))
          ? Number(journal.availabilityBefore.revision)
          : 0;
        const cas = writeAvailabilityCas(dataRoot, profileId, journal.availabilityTarget, expected, deps, { preserveTarget: true });
        if (!cas.ok) {
          journal.status = "interrupted";
          journal.updatedAt = nowIso();
          deps.atomicWriteJson(file, journal);
          outcomes.push({
            maintenanceInvocationId: journal.maintenanceInvocationId,
            profileId,
            status: "interrupted",
            reason: "availability-cas-conflict-on-reconcile"
          });
          continue;
        }
        journal.phase = "availability-committed";
      } else if (availPlan.action === "done" && journal.phase === "intent") {
        journal.phase = "availability-committed";
      }

      if (sidePlan.action === "forward" && journal.sidecarTarget) {
        const expected = journal.sidecarBefore && Number.isFinite(Number(journal.sidecarBefore.revision))
          ? Number(journal.sidecarBefore.revision)
          : 0;
        const cas = writeMaintenanceProfileCas(dataRoot, profileId, journal.sidecarTarget, expected, deps, { preserveTarget: true });
        if (!cas.ok) {
          journal.status = "interrupted";
          journal.updatedAt = nowIso();
          deps.atomicWriteJson(file, journal);
          outcomes.push({
            maintenanceInvocationId: journal.maintenanceInvocationId,
            profileId,
            status: "interrupted",
            reason: "sidecar-cas-conflict-on-reconcile"
          });
          continue;
        }
        journal.phase = "sidecar-committed";
      } else if (sidePlan.action === "done" && journal.phase === "availability-committed") {
        journal.phase = "sidecar-committed";
      }

      if (journal.phase === "sidecar-committed" || journal.phase === "availability-committed") {
        const availNow = loadAvailability(dataRoot, profileId, deps);
        const sideNow = loadMaintenanceProfile(dataRoot, profileId, deps);
        const aDone = threeStateFilePlan(
          stripRuntimeNoise(availNow),
          stripRuntimeNoise(journal.availabilityBefore),
          stripRuntimeNoise(journal.availabilityTarget)
        ).action === "done";
        const sDone = threeStateFilePlan(
          stripSidecarNoise(sideNow),
          stripSidecarNoise(journal.sidecarBefore),
          stripSidecarNoise(journal.sidecarTarget)
        ).action === "done";
        if (aDone && sDone) {
          journal.status = "interrupted";
          journal.phase = "finalized";
          journal.updatedAt = nowIso();
          deps.atomicWriteJson(file, journal);
          outcomes.push({
            maintenanceInvocationId: journal.maintenanceInvocationId,
            profileId,
            status: "interrupted",
            reason: "post-sidecar-no-replay"
          });
          continue;
        }
      }

      if (journal.phase === "intent" && availPlan.action === "done" && sidePlan.action === "done") {
        journal.status = "interrupted";
        journal.phase = "finalized";
        journal.updatedAt = nowIso();
        deps.atomicWriteJson(file, journal);
        outcomes.push({
          maintenanceInvocationId: journal.maintenanceInvocationId,
          profileId,
          status: "interrupted",
          reason: "intent-no-progress-discard"
        });
        continue;
      }

      journal.updatedAt = nowIso();
      deps.atomicWriteJson(file, journal);
      outcomes.push({
        maintenanceInvocationId: journal.maintenanceInvocationId,
        profileId,
        status: journal.status,
        phase: journal.phase,
        reason: "reconciled"
      });
    }
  }
  return outcomes;
}

/**
 * Maintenance candidates (r8 §8):
 * authorized ∩ scope=quota ∩ (frozen-due | probe_due).
 * Exclude unknown, cooldown, reauth_required, manual_hold, unauthorized.
 * Sort nextProbeAt → lastMaintenanceProbeAt → profileId; take maxProbesPerTick.
 */
function selectMaintenanceCandidates(registry, poolConfig, dataRoot, deps, nowMs = Date.now()) {
  const authIds = new Set(
    (poolConfig.authorization && poolConfig.authorization.authorizedProfileIds) || []
  );
  const maxTick = (poolConfig.autoProbe && poolConfig.autoProbe.maxProbesPerTick) || 2;
  const minInterval = (poolConfig.autoProbe && poolConfig.autoProbe.minProbeIntervalMs) || MIN_PROBE_INTERVAL_MS;
  const rows = [];
  const skipped = [];
  for (const profile of registry.profiles || []) {
    if (!authIds.has(profile.profileId)) {
      skipped.push({ profileId: profile.profileId, reason: "not-authorized" });
      continue;
    }
    const record = loadAvailability(dataRoot, profile.profileId, deps);
    if (record.scope !== "quota") {
      skipped.push({ profileId: profile.profileId, reason: "scope-not-quota", state: record.state });
      continue;
    }
    if (record.state === "unknown" || record.state === "reauth_required" || record.state === "manual_hold") {
      skipped.push({ profileId: profile.profileId, reason: `excluded-state:${record.state}` });
      continue;
    }
    if (record.state === "cooldown") {
      skipped.push({ profileId: profile.profileId, reason: "cooldown-excluded" });
      continue;
    }
    const eligibility = evaluateEligibility(record, nowMs);
    const due = (record.state === "frozen" && eligibility.eligibility === "probeEligible")
      || record.state === "probe_due"
      || eligibility.effectiveState === "probe_due";
    if (!due) {
      skipped.push({ profileId: profile.profileId, reason: eligibility.reason || "not-due" });
      continue;
    }
    const sidecar = loadMaintenanceProfile(dataRoot, profile.profileId, deps);
    if (sidecar.lastMaintenanceProbeAt) {
      const last = Date.parse(sidecar.lastMaintenanceProbeAt);
      if (Number.isFinite(last) && nowMs - last < minInterval) {
        skipped.push({ profileId: profile.profileId, reason: "min-probe-interval" });
        continue;
      }
    }
    rows.push({
      profileId: profile.profileId,
      alias: profile.alias,
      profile,
      record,
      sidecar,
      nextProbeAt: record.nextProbeAt,
      lastMaintenanceProbeAt: sidecar.lastMaintenanceProbeAt
    });
  }
  rows.sort((a, b) => {
    const na = a.nextProbeAt ? Date.parse(a.nextProbeAt) : 0;
    const nb = b.nextProbeAt ? Date.parse(b.nextProbeAt) : 0;
    if (na !== nb) return na - nb;
    const la = a.lastMaintenanceProbeAt ? Date.parse(a.lastMaintenanceProbeAt) : 0;
    const lb = b.lastMaintenanceProbeAt ? Date.parse(b.lastMaintenanceProbeAt) : 0;
    if (la !== lb) return la - lb;
    return String(a.profileId).localeCompare(String(b.profileId));
  });
  return {
    selected: rows.slice(0, maxTick),
    skipped,
    scanned: (registry.profiles || []).length
  };
}

function buildMaintenanceProbeArgs(scratchDir, sessionId, socketPath) {
  const promptPath = path.join(scratchDir, "probe.prompt.txt");
  return {
    promptPath,
    promptText: PROBE_PROMPT,
    expect: PROBE_EXPECT,
    args: [
      "--no-plan", "--no-memory", "--output-format", "streaming-json",
      "--prompt-file", promptPath,
      "--cwd", scratchDir,
      "--model", "grok-4.6",
      "--reasoning-effort", "high",
      "--disallowed-tools", "run_terminal_cmd,Agent",
      "--no-subagents", "--disable-web-search",
      "--max-turns", "1",
      "--session-id", sessionId,
      "--leader-socket", socketPath,
      "--deny", "Bash",
      "--deny", "MCPTool(*)",
      "--deny", "WebFetch(*)",
      "--deny", "WebSearch"
    ],
    settings: {
      permissions: {
        defaultMode: "dontAsk",
        allow: [],
        deny: ["Bash", "MCPTool(*)", "WebFetch(*)", "WebSearch"]
      }
    }
  };
}

function validateDeployPointerV6(value) {
  if (!isObject(value)) return { ok: false, reason: "not-object" };
  for (const field of ["version", "releasePath", "dataRoot", "registryPath", "approvedProfileRoot", "manifestSha256", "updatedAt"]) {
    if (typeof value[field] !== "string" || !value[field]) {
      return { ok: false, reason: `missing-${field}` };
    }
  }
  if (value.previousVersion != null && typeof value.previousVersion !== "string") {
    return { ok: false, reason: "previousVersion-type" };
  }
  if (!isObject(value.schemaVersions)) return { ok: false, reason: "schemaVersions" };
  return { ok: true };
}

function validateRunUsageV4(usage) {
  if (!isObject(usage)) return { ok: false, reason: "not-object" };
  if (usage.present === true && usage.unknown === false && usage.note === null) {
    for (const k of ["input_tokens", "cache_read_input_tokens", "output_tokens", "reasoning_tokens", "total_tokens"]) {
      if (typeof usage[k] !== "number") return { ok: false, reason: `present-missing-${k}` };
    }
    if (!isObject(usage.modelUsage)) return { ok: false, reason: "modelUsage" };
    return { ok: true, shape: "present" };
  }
  if (usage.present === false && usage.unknown === true && typeof usage.note === "string") {
    for (const k of ["input_tokens", "cache_read_input_tokens", "output_tokens", "reasoning_tokens", "total_tokens"]) {
      if (usage[k] !== null) return { ok: false, reason: `unknown-non-null-${k}` };
    }
    if (!isObject(usage.modelUsage)) return { ok: false, reason: "modelUsage" };
    return { ok: true, shape: "unknown" };
  }
  return { ok: false, reason: "shape-mismatch" };
}

/** Versioned deployment pointer helpers (§11) — no service control. */
function buildCurrentPointer(meta) {
  return {
    version: meta.version,
    releasePath: meta.releasePath,
    previousVersion: meta.previousVersion || null,
    dataRoot: meta.dataRoot,
    registryPath: meta.registryPath,
    approvedProfileRoot: meta.approvedProfileRoot,
    schemaVersions: meta.schemaVersions || {
      taskCapsule: 3,
      resultCapsule: 3,
      taskRun: 6,
      availability: 5,
      usageLedger: 4,
      maintenance: 6,
      poolConfig: 6
    },
    manifestSha256: meta.manifestSha256 || null,
    updatedAt: nowIso()
  };
}

/**
 * Validate current.json shape. Does not read auth or touch credentials.
 * Requires Provider-owned dataRoot, registryPath, and approvedProfileRoot.
 * releasePath existence and optional SHA-256 are checked when options.requireRelease=true.
 */
function validateCurrentPointer(value, options = {}) {
  if (!isObject(value)) return { ok: false, reason: "not-object" };
  for (const field of ["version", "releasePath", "dataRoot", "registryPath", "approvedProfileRoot"]) {
    if (typeof value[field] !== "string" || !value[field]) {
      return { ok: false, reason: `missing-${field}` };
    }
  }
  if (value.previousVersion != null && typeof value.previousVersion !== "string") {
    return { ok: false, reason: "previousVersion-type" };
  }
  if (!isObject(value.schemaVersions)) {
    return { ok: false, reason: "schemaVersions" };
  }
  if (value.manifestSha256 != null) {
    if (typeof value.manifestSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(value.manifestSha256)) {
      return { ok: false, reason: "manifestSha256-format" };
    }
  }
  if (options.requireRelease) {
    if (!fs.existsSync(value.releasePath)) {
      return { ok: false, reason: "releasePath-missing" };
    }
    if (options.expectedManifestSha256) {
      if (!value.manifestSha256 || value.manifestSha256.toLowerCase() !== String(options.expectedManifestSha256).toLowerCase()) {
        return { ok: false, reason: "manifestSha256-mismatch" };
      }
    }
  }
  return { ok: true };
}

function readCurrentPointer(pointerPath, deps, options = {}) {
  if (!fs.existsSync(pointerPath)) return null;
  const value = deps.readJson(pointerPath);
  const check = validateCurrentPointer(value, options);
  if (!check.ok) {
    const err = new Error("CURRENT_POINTER_INVALID");
    err.code = "CURRENT_POINTER_INVALID";
    err.reason = check.reason;
    throw err;
  }
  return value;
}

/**
 * Independent provider/global health plane (§5).
 * Non-attributable faults write here; profile availability is never modified.
 */
function providerHealthPath(dataRoot) {
  return path.join(dataRoot, "health", "provider.json");
}

function emptyProviderHealth() {
  return {
    schemaVersion: AVAILABILITY_SCHEMA_VERSION,
    scope: "provider",
    status: "healthy",
    updatedAt: nowIso(),
    consecutiveNonAttributableFailures: 0,
    lastError: null,
    events: []
  };
}

function loadProviderHealth(dataRoot, deps) {
  const file = providerHealthPath(dataRoot);
  if (!fs.existsSync(file)) return emptyProviderHealth();
  try {
    const record = deps.readJson(file);
    if (!isObject(record) || record.schemaVersion !== AVAILABILITY_SCHEMA_VERSION) {
      return emptyProviderHealth();
    }
    return record;
  } catch (_) {
    return emptyProviderHealth();
  }
}

function recordProviderHealth(dataRoot, event, deps) {
  const file = providerHealthPath(dataRoot);
  deps.ensureDir(path.dirname(file));
  const current = loadProviderHealth(dataRoot, deps);
  const observedAt = event.observedAt || nowIso();
  const entry = {
    errorType: event.errorType || "unknown_failure",
    statusCode: event.statusCode != null ? event.statusCode : null,
    observedAt,
    taskId: event.taskId || null,
    invocationId: event.invocationId || null,
    profileIdContext: event.profileId || null,
    note: "non-attributable; profile availability not modified"
  };
  const next = {
    schemaVersion: AVAILABILITY_SCHEMA_VERSION,
    scope: "provider",
    status: "degraded",
    updatedAt: observedAt,
    consecutiveNonAttributableFailures: (Number(current.consecutiveNonAttributableFailures) || 0) + 1,
    lastError: {
      errorType: entry.errorType,
      statusCode: entry.statusCode,
      observedAt
    },
    events: (Array.isArray(current.events) ? current.events : []).concat([entry]).slice(-50)
  };
  deps.atomicWriteJson(file, next);
  return next;
}

function markProviderHealthOk(dataRoot, deps) {
  const file = providerHealthPath(dataRoot);
  deps.ensureDir(path.dirname(file));
  const current = loadProviderHealth(dataRoot, deps);
  if (current.status === "healthy" && current.consecutiveNonAttributableFailures === 0) {
    return current;
  }
  const next = {
    ...current,
    status: "healthy",
    consecutiveNonAttributableFailures: 0,
    updatedAt: nowIso(),
    lastError: null,
    events: Array.isArray(current.events) ? current.events.slice(-50) : []
  };
  deps.atomicWriteJson(file, next);
  return next;
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
  QUOTA_MAX_BACKOFF_MS,
  MIN_PROBE_INTERVAL_MS,
  RATE_WINDOW_MS,
  RATE_MAX_IN_WINDOW,
  MAINTENANCE_SCHEMA_VERSION,
  BILLING_CTX_WHITELIST,
  BILLING_RECOVERED_PERCENT_THRESHOLD,
  PROBE_PROMPT,
  PROBE_EXPECT,
  emptyAvailability,
  validateAvailabilityRecord,
  availabilityPath,
  availabilityDir,
  runWalPath,
  loadAvailability,
  writeAvailabilityCas,
  computeBackoffMs,
  computeNextProbeAt,
  computeQuotaNextProbeAt,
  computeRateLimitNextProbeAt,
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
  probeSelfRescueAllowed,
  buildCandidateSets,
  selectProfile,
  emptyTaskRun,
  writeTaskRun,
  loadTaskRun,
  recoverInterruptedRuns,
  mayAutoFailoverAttempt,
  readBillingSnapshot,
  applyBillingToNextProbe,
  clampQuotaNextProbeAt,
  maintenanceRoot,
  maintenanceProfilePath,
  poolConfigPath,
  rateWindowPath,
  maintenanceRunDir,
  maintenanceRunPath,
  deployPointersDir,
  deployPointerPath,
  emptyMaintenanceProfile,
  validateMaintenanceProfile,
  loadMaintenanceProfile,
  writeMaintenanceProfileCas,
  openOrRefreshFreezeEpisode,
  clearFreezeEpisode,
  billingSignalId,
  evaluateEarlyBillingProbe,
  defaultPoolConfig,
  validatePoolConfig,
  loadPoolConfig,
  writePoolConfigCas,
  emptyRateWindow,
  validateRateWindow,
  loadRateWindow,
  tryReserveRateSlot,
  emptyMaintenanceRun,
  writeMaintenanceRun,
  loadMaintenanceRun,
  threeStateFilePlan,
  reconcileMaintenanceRuns,
  selectMaintenanceCandidates,
  buildMaintenanceProbeArgs,
  validateDeployPointerV6,
  validateRunUsageV4,
  buildCurrentPointer,
  validateCurrentPointer,
  readCurrentPointer,
  providerHealthPath,
  emptyProviderHealth,
  loadProviderHealth,
  recordProviderHealth,
  markProviderHealthOk,
  normalizeClassifierText,
  poolStatusEnrichment
};
