#!/usr/bin/env node
// CC Switch usage export adapter for Grok Worker Provider.
// Reads the local usage-ledger (usage-ledger.provider.v4) and writes matching
// rows into CC Switch's proxy_request_logs table so Grok usage shows up in
// its "使用统计" dashboard. Read-only against the ledger; write-only (INSERT
// OR IGNORE, idempotent by request_id) against CC Switch's SQLite DB.
//
// Usage:
//   node export.mjs                 dry-run: print rows + summary, write nothing
//   node export.mjs --write         perform the real insert (auto-backs-up the DB first)
//   node export.mjs --write --db <path>   write to an alternate DB (for copy testing)
//   node export.mjs --skip-providers-row  don't insert the optional grokbuild providers row (D3)
//   node export.mjs --data-root <path>    scan an alternate provider data root instead of the
//                                         one resolved from the live pointer file (used to pull
//                                         in pre-migration history sitting in a legacy-archive
//                                         residue folder; that root must have its own usage/tasks,
//                                         runs/, results/ siblings — same layout as the live root)
//
// Safe to re-run: rows are keyed by request_id = "grok-worker:<invocationId>",
// so INSERT OR IGNORE makes repeated runs a no-op for already-exported invocations.
// This also makes it safe to run against multiple data roots (live + archived) as long as
// invocationIds don't collide across roots (verified true for this provider's residue folders).

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, statSync, copyFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const SKIP_PROVIDERS_ROW = args.includes('--skip-providers-row');
const dbArgIdx = args.indexOf('--db');
const DB_PATH = dbArgIdx !== -1 ? args[dbArgIdx + 1] : path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
const dataRootArgIdx = args.indexOf('--data-root');

const POINTER_PATH = path.join(os.homedir(), 'AppData', 'Local', 'GrokWorkerProvider', 'current.json');

function fail(msg) {
  console.error('FATAL:', msg);
  process.exit(1);
}

// ---- 1. Resolve Grok Worker Provider data root: explicit --data-root wins, else live pointer ----
let DATA_ROOT;
if (dataRootArgIdx !== -1) {
  DATA_ROOT = args[dataRootArgIdx + 1];
} else {
  if (!existsSync(POINTER_PATH)) fail(`pointer file not found: ${POINTER_PATH}`);
  const pointer = JSON.parse(readFileSync(POINTER_PATH, 'utf8'));
  if (!pointer.dataRoot) fail('pointer file missing dataRoot');
  DATA_ROOT = pointer.dataRoot;
}
const LEDGER_ROOT = path.join(DATA_ROOT, 'usage', 'tasks');
const RUNS_ROOT = path.join(DATA_ROOT, 'runs');
const RESULTS_ROOT = path.join(DATA_ROOT, 'results');
if (!existsSync(LEDGER_ROOT)) fail(`ledger root not found: ${LEDGER_ROOT}`);

console.log(`Data root:   ${DATA_ROOT}`);
console.log(`Ledger root: ${LEDGER_ROOT}`);
console.log(`Target DB:   ${DB_PATH}`);
console.log(`Mode:        ${WRITE ? 'WRITE (real insert)' : 'DRY-RUN (no changes)'}`);
console.log('');

// ---- 2. Expected schema (Phase 0.3 guard against silent CC Switch schema drift) ----
const EXPECTED_COLS = [
  'request_id', 'provider_id', 'app_type', 'model', 'request_model', 'pricing_model',
  'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens',
  'input_token_semantics', 'input_cost_usd', 'output_cost_usd', 'cache_read_cost_usd',
  'cache_creation_cost_usd', 'total_cost_usd', 'latency_ms', 'first_token_ms', 'duration_ms',
  'status_code', 'error_message', 'session_id', 'provider_type', 'is_streaming',
  'cost_multiplier', 'created_at', 'data_source'
];

function assertSchema(db) {
  const cols = db.prepare("PRAGMA table_info(proxy_request_logs)").all().map(r => r.name);
  const missing = EXPECTED_COLS.filter(c => !cols.includes(c));
  if (missing.length) {
    fail(`proxy_request_logs schema drift detected. Missing columns: ${missing.join(', ')}. ` +
         `CC Switch may have been updated — re-verify the plan before proceeding.`);
  }
}

// ---- 3. Load pricing for grok-4.5 from CC Switch's own model_pricing table (never hardcode) ----
function loadPricing(db, modelId) {
  const row = db.prepare(
    'SELECT input_cost_per_million, output_cost_per_million, cache_read_cost_per_million, cache_creation_cost_per_million FROM model_pricing WHERE model_id = ?'
  ).get(modelId);
  if (!row) fail(`model_pricing has no entry for '${modelId}' — cannot compute cost.`);
  return {
    input: Number(row.input_cost_per_million),
    output: Number(row.output_cost_per_million),
    cacheRead: Number(row.cache_read_cost_per_million),
    cacheCreation: Number(row.cache_creation_cost_per_million),
  };
}

// ---- 4. Read-only pass to open the DB just for schema+pricing checks ----
const roDb = new DatabaseSync(DB_PATH, { readOnly: true });
assertSchema(roDb);
const PRICING = loadPricing(roDb, 'grok-4.5');
roDb.close();
console.log(`Pricing (grok-4.5): input=$${PRICING.input}/M output=$${PRICING.output}/M cache_read=$${PRICING.cacheRead}/M`);
console.log('');

// ---- 5. Helpers to recover timestamp + duration for an invocation ----
// Returns { ts: <unix seconds|null>, runDurationMs: <number|null> } by matching
// this invocationId against runs/<taskId>/*.json attempts[].
function findRunInfo(taskId, invocationId) {
  const dir = path.join(RUNS_ROOT, taskId);
  if (!existsSync(dir)) return { ts: null, runDurationMs: null };
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const run = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
      const attempts = Array.isArray(run.attempts) ? run.attempts : [];
      if (attempts.some(a => a.invocationId === invocationId)) {
        const iso = run.updatedAt || run.createdAt;
        const ts = iso ? Math.floor(Date.parse(iso) / 1000) : null;
        let runDurationMs = null;
        if (run.createdAt && run.updatedAt) {
          const d = Date.parse(run.updatedAt) - Date.parse(run.createdAt);
          if (Number.isFinite(d) && d >= 0) runDurationMs = d;
        }
        return { ts, runDurationMs };
      }
    } catch { /* ignore unreadable run file */ }
  }
  return { ts: null, runDurationMs: null };
}

// Result capsule's own durationMs, when the provider actually populates it
// (observed to be null across all current capsules — kept as a preferred
// source in case a future provider version fills it in).
function findCapsuleDurationMs(taskId, invocationId) {
  const f = path.join(RESULTS_ROOT, taskId, `${invocationId}.json`);
  if (!existsSync(f)) return null;
  try {
    const capsule = JSON.parse(readFileSync(f, 'utf8'));
    return typeof capsule.durationMs === 'number' ? capsule.durationMs : null;
  } catch { return null; }
}

// ---- 6. Walk ledgers, build rows ----
const ledgerFiles = readdirSync(LEDGER_ROOT).filter(f => f.endsWith('.json'));
console.log(`Found ${ledgerFiles.length} ledger file(s).`);

const rows = [];
let skippedUnknown = 0;
let checksumMismatches = 0;

for (const file of ledgerFiles) {
  const fullPath = path.join(LEDGER_ROOT, file);
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(fullPath, 'utf8'));
  } catch (e) {
    console.warn(`WARN: failed to parse ${file}: ${e.message}`);
    continue;
  }
  const taskId = ledger.taskId;
  const invocations = Array.isArray(ledger.invocations) ? ledger.invocations : [];

  for (const inv of invocations) {
    const u = inv.runUsage;
    if (!u || u.present !== true) { skippedUnknown++; continue; } // never invent 0s for unknown/absent usage

    const input_tokens = u.input_tokens || 0;
    const cache_read_tokens = u.cache_read_input_tokens || 0;
    const reasoning_tokens = u.reasoning_tokens || 0;
    const output_tokens = (u.output_tokens || 0) + reasoning_tokens; // D1: reasoning folded into output

    // self-check against ledger's own total_tokens.
    // NOTE: the ledger's total_tokens definition EXCLUDES reasoning_tokens
    // (verified: input + cache_read + output == total_tokens, reasoning is
    // tracked separately). Reasoning is still folded into our own
    // output_tokens column per D1 (CC Switch has no reasoning column) — that
    // remapping is intentional and does not indicate a data problem.
    const ledgerSumCheck = input_tokens + cache_read_tokens + (u.output_tokens || 0);
    if (typeof u.total_tokens === 'number' && ledgerSumCheck !== u.total_tokens) {
      checksumMismatches++;
      console.warn(`WARN: token sum mismatch for invocation ${inv.invocationId}: computed=${ledgerSumCheck} ledger.total_tokens=${u.total_tokens}`);
    }

    const input_cost = (input_tokens / 1e6) * PRICING.input;
    const output_cost = (output_tokens / 1e6) * PRICING.output; // includes reasoning per D1
    const cache_read_cost = (cache_read_tokens / 1e6) * PRICING.cacheRead;
    const cache_creation_cost = 0;
    const total_cost = input_cost + output_cost + cache_read_cost + cache_creation_cost;

    const runInfo = findRunInfo(taskId, inv.invocationId);
    const ts = runInfo.ts
      ?? (inv.accountIdentitySnapshot && inv.accountIdentitySnapshot.capturedAt ? Math.floor(Date.parse(inv.accountIdentitySnapshot.capturedAt) / 1000) : null)
      ?? Math.floor(statSync(fullPath).mtimeMs / 1000);

    // Prefer the capsule's own durationMs (provider-reported, currently always
    // null in observed data); fall back to run createdAt->updatedAt span
    // (includes any queueing/retry time, so it's an upper-bound estimate, not
    // pure model latency — still far more informative than a hardcoded 0).
    const durationMs = findCapsuleDurationMs(taskId, inv.invocationId) ?? runInfo.runDurationMs;

    rows.push({
      request_id: `grok-worker:${inv.invocationId}`,
      provider_id: 'grok-worker',
      app_type: 'grokbuild',
      model: 'grok-4.5',
      request_model: 'grok-4.5',
      pricing_model: 'grok-4.5',
      input_tokens,
      output_tokens,
      cache_read_tokens,
      cache_creation_tokens: 0,
      input_token_semantics: 0,
      input_cost_usd: input_cost.toFixed(6),
      output_cost_usd: output_cost.toFixed(6),
      cache_read_cost_usd: cache_read_cost.toFixed(6),
      cache_creation_cost_usd: '0',
      total_cost_usd: total_cost.toFixed(6),
      latency_ms: durationMs ?? 0,
      first_token_ms: null,
      duration_ms: durationMs,
      status_code: 200,
      error_message: null,
      session_id: inv.sessionId || null,
      provider_type: 'grok_worker',
      is_streaming: 1,
      cost_multiplier: '1.0',
      created_at: ts,
      data_source: 'grok_worker',
    });
  }
}

// ---- 7. Summary ----
const totalTokens = rows.reduce((s, r) => s + r.input_tokens + r.output_tokens + r.cache_read_tokens, 0);
const totalCost = rows.reduce((s, r) => s + Number(r.total_cost_usd), 0);
console.log('');
console.log('=== Summary ===');
console.log(`Rows to export:        ${rows.length}`);
console.log(`Skipped (unknown/absent usage): ${skippedUnknown}`);
console.log(`Token-sum mismatches:  ${checksumMismatches}`);
console.log(`Total tokens:          ${totalTokens.toLocaleString()}`);
console.log(`Total cost (USD):      $${totalCost.toFixed(4)}`);
console.log('');

if (!WRITE) {
  console.log('=== DRY-RUN rows ===');
  for (const r of rows) console.log(JSON.stringify(r));
  console.log('');
  console.log('Dry-run complete. Re-run with --write to insert into the real DB.');
  process.exit(0);
}

// ---- 8. Real write path ----
if (!existsSync(DB_PATH)) fail(`DB not found: ${DB_PATH}`);

// Auto-backup before touching the live DB — ONE per calendar day, not one per
// run. This script is designed to run frequently (e.g. every minute via a
// scheduled task); a per-run backup would copy the ~34MB DB file 1440x/day
// and fill the disk. Daily granularity plus retention pruning keeps this
// bounded regardless of run frequency.
const BACKUP_RETENTION_DAYS = 30;
const todayStamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
const dbDir = path.dirname(DB_PATH);
const dbBase = path.basename(DB_PATH);
const backupPath = path.join(dbDir, `${dbBase}.bak-${todayStamp}`);
if (!existsSync(backupPath)) {
  copyFileSync(DB_PATH, backupPath);
  console.log(`Backed up DB to: ${backupPath}`);
} else {
  console.log(`Daily backup already exists, skipped: ${backupPath}`);
}
// Prune backups older than the retention window.
const backupPrefix = `${dbBase}.bak-`;
const existingBackups = readdirSync(dbDir)
  .filter(f => f.startsWith(backupPrefix))
  .sort(); // lexicographic == chronological for YYYY-MM-DD suffix
if (existingBackups.length > BACKUP_RETENTION_DAYS) {
  for (const old of existingBackups.slice(0, existingBackups.length - BACKUP_RETENTION_DAYS)) {
    try { unlinkSync(path.join(dbDir, old)); console.log(`Pruned old backup: ${old}`); } catch { /* best-effort */ }
  }
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout=5000;');
assertSchema(db);

const insertCols = Object.keys(rows[0] ?? {});
let inserted = 0;
if (rows.length) {
  const placeholders = insertCols.map(c => '@' + c).join(',');
  const stmt = db.prepare(`INSERT OR IGNORE INTO proxy_request_logs (${insertCols.join(',')}) VALUES (${placeholders})`);
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const info = stmt.run(r);
      if (info.changes) inserted++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    fail(`insert failed, rolled back: ${e.message}`);
  }
}
console.log(`Inserted ${inserted} new row(s) (${rows.length - inserted} already present, skipped by PK).`);

// ---- 9. Optional D3: register a providers row for Provider 统计 ----
if (!SKIP_PROVIDERS_ROW) {
  const existing = db.prepare("SELECT 1 FROM providers WHERE id = ? AND app_type = ?").get('grok-worker', 'grokbuild');
  if (!existing) {
    db.prepare(
      `INSERT INTO providers (id, app_type, name, settings_config, category, created_at, sort_index, meta, is_current, in_failover_queue)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('grok-worker', 'grokbuild', 'Grok Worker', '{}', 'custom', Date.now(), 0, '{}', 0, 0);
    console.log("Registered 'grok-worker' provider row under app_type=grokbuild.");
  } else {
    console.log("providers row for grok-worker/grokbuild already exists, skipped.");
  }
}

db.close();
console.log('');
console.log('Done. Open CC Switch -> 设置 -> 使用统计 -> 筛来源=grokbuild to verify.');
