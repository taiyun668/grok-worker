#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function finish(value, code = 0) { process.stdout.write(`${JSON.stringify(value)}\n`); process.exitCode = code; }
if (process.env.GROK_WORKER_HOOK_FORCE_FAILURE === "1") process.exit(23);
const policyFile = process.env.GROK_WORKER_POLICY_FILE;
if (!policyFile) finish({ decision: "allow" });
else {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", () => {
    try {
      const event = JSON.parse(raw); const policy = JSON.parse(fs.readFileSync(policyFile, "utf8"));
      const tool = String(event.toolName || event.tool_name || ""); const input = event.toolInput || event.tool_input || {};
      const requested = String(input.file_path || input.path || input.filename || ""); const normalized = path.resolve(requested || policy.worktree).toLowerCase();
      const within = (child, parent) => child === parent || child.startsWith(`${parent}${path.sep}`);
      let decision = "allow"; let reason = "provider-policy-allow";
      if (/bash|run_terminal_cmd/i.test(tool)) { decision = "deny"; reason = "worker-shell-denied"; }
      else if (/edit|write/i.test(tool)) {
        const permanent = policy.permanentDeny.some((root) => within(normalized, root.toLowerCase()));
        const allowed = policy.allowedWriteRoots.some((root) => within(normalized, root.toLowerCase()));
        if (permanent || !allowed) { decision = "deny"; reason = permanent ? "permanent-deny" : "outside-allowed-files"; }
      }
      const record = { at: new Date().toISOString(), tool, path: requested || null, decision, reason };
      if (process.env.GROK_WORKER_AUDIT_FILE) fs.appendFileSync(process.env.GROK_WORKER_AUDIT_FILE, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
      finish(decision === "deny" ? { decision, reason } : { decision });
    } catch (_) {
      process.exitCode = 24;
    }
  });
}
