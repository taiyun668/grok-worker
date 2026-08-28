"use strict";

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const provider = require("../lib/provider");
const root = path.join(provider.DATA_ROOT, "write-canary-repo"); fs.mkdirSync(root, { recursive: true });
function run(command, args) { const result = childProcess.spawnSync(command, args, { cwd: root, encoding: "utf8", windowsHide: true }); if (result.status !== 0) throw new Error(String(result.stderr || result.stdout)); return String(result.stdout || "").trim(); }
if (!fs.existsSync(path.join(root, ".git"))) { run("git", ["init", "--quiet"]); run("git", ["config", "user.email", "provider-canary@example.invalid"]); run("git", ["config", "user.name", "Provider Canary"]); fs.writeFileSync(path.join(root, "allowed.txt"), "PENDING\n", "utf8"); run("git", ["add", "allowed.txt"]); run("git", ["commit", "-m", "write canary baseline", "--quiet"]); }
run("git", ["reset", "--hard", "HEAD"]); run("git", ["clean", "-fdx"]); provider.rootsCommand("register", root);
const task = {
  taskId: "GROK-WORKER-WRITE-CANARY", stage: "G2-write-canary", objective: "Immediately use the Edit/Write file tool to replace the complete contents of allowed.txt with exactly PROVIDER_WRITE_OK followed by a newline. Do not touch any other file.",
  baseCommit: run("git", ["rev-parse", "HEAD"]), workspace: root, worktree: { mode: "exclusive-worktree", path: root }, allowedFiles: ["allowed.txt"],
  forbiddenActions: ["service control", "git write", "OAuth", "account switch", "delete data"], acceptanceCommands: ["Get-Content allowed.txt"], contextRefs: ["allowed.txt"],
  realRequestPermission: "allowed", serviceControlPermission: "denied", gitPermission: "read-only", grokSessionId: null, resumePolicy: { mode: "new-only", rule: "Never resume." }, explicitStop: "Stop after allowed.txt is updated.",
  model: "grok-4.6", reasoning: "high", speed: "standard", profile: "example-account", policy: { access: "workspace-write", bash: "denied", agents: "denied", mcp: "denied", web: "denied" }, failover: { allowedFallbackProfiles: [], mode: "pre-first-request-only", switchPermission: "denied" }
};
const file = path.join(provider.DATA_ROOT, "write-canary.task.json"); fs.writeFileSync(file, `${JSON.stringify(task, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); process.stdout.write(`${file}\n`);
