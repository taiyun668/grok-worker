#!/usr/bin/env node
"use strict";

/**
 * Stable entry bootstrap.
 * - Validates %LOCALAPPDATA%\GrokWorkerProvider\current.json when present
 * - Wires GROK_WORKER_DATA_ROOT / GROK_WORKER_PROFILES / GROK_WORKER_APPROVED_PROFILE_ROOT
 *   from pointer (env wins)
 * - Defaults (when pointer absent) are Provider-owned under GrokWorkerProvider —
 *   not GrokUI. Legacy GrokUI locations are inert historical residues only.
 * - Never reads auth.json; never touches default user .grok credentials;
 *   never opens old GrokUI runtime files.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

function pointerPath() {
  return process.env.GROK_WORKER_CURRENT_JSON
    || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "GrokWorkerProvider", "current.json");
}

function validatePointerShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "not-object";
  for (const field of ["version", "releasePath", "dataRoot", "registryPath", "approvedProfileRoot"]) {
    if (typeof value[field] !== "string" || !value[field]) return `missing-${field}`;
  }
  if (value.manifestSha256 != null) {
    if (typeof value.manifestSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(value.manifestSha256)) {
      return "manifestSha256-format";
    }
  }
  return null;
}

function applyPointerEnv() {
  // A complete process-local root triple is an explicit test/deployment override.
  // Do not parse an unrelated machine pointer in that case.
  if (process.env.GROK_WORKER_DATA_ROOT && process.env.GROK_WORKER_PROFILES
      && process.env.GROK_WORKER_APPROVED_PROFILE_ROOT) {
    return {
      source: "env",
      path: null,
      dataRoot: process.env.GROK_WORKER_DATA_ROOT,
      registryPath: process.env.GROK_WORKER_PROFILES,
      approvedProfileRoot: process.env.GROK_WORKER_APPROVED_PROFILE_ROOT
    };
  }
  const file = pointerPath();
  if (!fs.existsSync(file)) {
    return { source: "no-pointer", path: file };
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    process.stderr.write(`CURRENT_POINTER_INVALID: unreadable ${file}\n`);
    process.exitCode = 1;
    return { source: "invalid", path: file, fatal: true };
  }
  const reason = validatePointerShape(raw);
  if (reason) {
    process.stderr.write(`CURRENT_POINTER_INVALID: ${reason} (${file})\n`);
    process.exitCode = 1;
    return { source: "invalid", path: file, reason, fatal: true };
  }
  // Env overrides always win; pointer only fills missing durable roots.
  if (!process.env.GROK_WORKER_DATA_ROOT && raw.dataRoot) {
    process.env.GROK_WORKER_DATA_ROOT = raw.dataRoot;
  }
  if (!process.env.GROK_WORKER_PROFILES && raw.registryPath) {
    process.env.GROK_WORKER_PROFILES = raw.registryPath;
  }
  if (!process.env.GROK_WORKER_APPROVED_PROFILE_ROOT && raw.approvedProfileRoot) {
    process.env.GROK_WORKER_APPROVED_PROFILE_ROOT = raw.approvedProfileRoot;
  }
  return {
    source: "current.json",
    path: file,
    version: raw.version,
    releasePath: raw.releasePath,
    dataRoot: process.env.GROK_WORKER_DATA_ROOT || raw.dataRoot,
    registryPath: process.env.GROK_WORKER_PROFILES || raw.registryPath,
    approvedProfileRoot: process.env.GROK_WORKER_APPROVED_PROFILE_ROOT || raw.approvedProfileRoot
  };
}

const deploy = applyPointerEnv();
if (deploy.fatal) {
  process.exit(process.exitCode || 1);
}

const { main } = require("../lib/provider");

main(process.argv.slice(2)).catch((error) => {
  const safe = error && error.safeMessage ? error.safeMessage : "grok-worker failed";
  process.stderr.write(`${safe}\n`);
  process.exitCode = Number.isInteger(error && error.exitCode) ? error.exitCode : 1;
});
