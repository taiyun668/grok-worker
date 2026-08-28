"use strict";

const fs = require("fs");
const path = require("path");

function isFile(file) {
  if (typeof file !== "string" || file.length === 0) return false;
  try { return fs.statSync(file).isFile(); } catch (_) { return false; }
}

function buildDoctorReport(options) {
  const {
    version, registry, defaultGrokHome, grokCliPath, normalizeCase,
    isolatedEnv, approvedProfileRoot, tempRoot, roots,
    deployPointerValid, metadata, lockInspection
  } = options;

  const inspection = lockInspection || { inspectError: null, locks: [], blockingCount: 0 };
  const providerChecks = [
    { name: "registry-v3", pass: registry.schemaVersion === 3 },
    {
      name: "default-home-forbidden",
      pass: registry.profiles.every((profile) => normalizeCase(profile.grokHome) !== normalizeCase(defaultGrokHome))
    },
    {
      name: "windows-sandbox-truth",
      pass: registry.profiles.every((profile) => profile.sandboxCapability.enforcementSupported === false)
    },
    ...roots.map((root) => ({ name: root.name, pass: fs.existsSync(root.path) })),
    {
      name: "compat-hooks-isolated-env",
      pass: (() => {
        const env = isolatedEnv(
          registry.profiles[0] || { grokHome: path.join(approvedProfileRoot, "_doctor") },
          path.join(tempRoot, "doctor-home"),
          path.join(tempRoot, "doctor.sock")
        );
        return env.GROK_CLAUDE_HOOKS_ENABLED === "false"
          && env.GROK_CURSOR_HOOKS_ENABLED === "false"
          && env.GROK_FOLDER_TRUST === undefined;
      })()
    },
    { name: "deploy-pointer-valid-or-absent", pass: deployPointerValid() },
    { name: "lock-inspect", pass: inspection.inspectError == null }
  ];
  const runtimeChecks = [{ name: "grok-cli-present", pass: isFile(grokCliPath) }];
  const providerHealthy = providerChecks.every((check) => check.pass);
  const grokCliAvailable = runtimeChecks[0].pass;

  return {
    version,
    // Backward compatible: pass continues to describe Provider health only.
    pass: providerHealthy,
    providerHealthy,
    grokCliAvailable,
    readyForRun: providerHealthy && grokCliAvailable,
    checks: [...providerChecks, ...runtimeChecks],
    ...metadata,
    lockInspection: inspection
  };
}

module.exports = { buildDoctorReport, isFile };
