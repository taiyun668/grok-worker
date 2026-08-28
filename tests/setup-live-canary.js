"use strict";

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const provider = require("../lib/provider");

const root = path.join(provider.DATA_ROOT, "canary-repo");
fs.mkdirSync(root, { recursive: true });
function run(command, args) {
  const result = childProcess.spawnSync(command, args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || `${command} failed`));
  return String(result.stdout || "").trim();
}
if (!fs.existsSync(path.join(root, ".git"))) {
  run("git", ["init", "--quiet"]); run("git", ["config", "user.email", "provider-canary@example.invalid"]); run("git", ["config", "user.name", "Provider Canary"]);
  fs.writeFileSync(path.join(root, "README.txt"), "GROK_WORKER_PROVIDER_CANARY\n", "utf8"); run("git", ["add", "README.txt"]); run("git", ["commit", "-m", "canary baseline", "--quiet"]);
}
run("git", ["reset", "--hard", "HEAD"]); run("git", ["clean", "-fdx"]);
provider.rootsCommand("register", root);
const task = {
  taskId: "GROK-WORKER-PROVIDER-LIVE-CANARY", stage: "G8-live-canary",
  objective: "Read README.txt and respond with exactly PROVIDER_CANARY_OK. Do not modify any file.",
  baseCommit: run("git", ["rev-parse", "HEAD"]), workspace: root,
  worktree: { mode: "read-only-shared-checkout", path: root }, allowedFiles: ["README.txt"],
  forbiddenActions: ["service control", "git write", "OAuth", "account switch", "delete data"],
  acceptanceCommands: ["git status --porcelain=v1 --untracked-files=all --ignored"], contextRefs: ["README.txt"],
  realRequestPermission: "allowed", serviceControlPermission: "denied", gitPermission: "read-only", grokSessionId: null,
  resumePolicy: { mode: "new-only", rule: "Never resume an unrelated session." }, explicitStop: "Return PROVIDER_CANARY_OK and stop without edits.",
  model: "grok-4.6", reasoning: "high", speed: "standard", profile: "example-account",
  policy: { access: "readonly", bash: "denied", agents: "denied", mcp: "denied", web: "denied" },
  failover: { allowedFallbackProfiles: [], mode: "pre-first-request-only", switchPermission: "denied" }
};
const file = path.join(provider.DATA_ROOT, "canary.task.json");
fs.writeFileSync(file, `${JSON.stringify(task, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
process.stdout.write(`${file}\n`);
