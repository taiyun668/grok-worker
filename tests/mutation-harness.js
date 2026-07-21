"use strict";

const assert = require("assert");
const provider = require("../lib/provider");

const base = {
  args: ["--no-plan", "--no-memory", "--output-format", "streaming-json", "--prompt-file", "x", "--cwd", "x", "--disallowed-tools", "run_terminal_cmd,Agent", "--no-subagents", "--disable-web-search", "--leader-socket", "x"],
  settings: { permissions: { defaultMode: "dontAsk", allow: ["Read(x)"], deny: ["Edit(**/.git/**)", "Edit(**/.grok/**)", "Edit(**/.claude/**)", "Edit(runtime/**)", "Bash", "MCPTool(*)", "WebFetch(*)", "WebSearch", "Bash(*service*)", "Bash(*taskkill*)", "Bash(git commit *)", "Bash(git push *)", "Bash(*OAuth*)"] } }
};
const capsule = { serviceControlPermission: "denied", gitPermission: "read-only", forbiddenActions: ["OAuth"], policy: { bash: "denied" } };
const mutations = [
  (x) => { x.args = x.args.filter((v) => v !== "--no-plan"); },
  (x) => { x.args = x.args.filter((v) => v !== "run_terminal_cmd,Agent"); },
  (x) => { x.args = x.args.filter((v) => v !== "--no-subagents"); },
  (x) => { x.settings.permissions.defaultMode = "default"; },
  (x) => { x.settings.permissions.deny = x.settings.permissions.deny.filter((v) => !v.includes("service")); },
  (x) => { x.settings.permissions.deny = x.settings.permissions.deny.filter((v) => !v.includes("git commit")); },
  (x) => { x.settings.permissions.deny = x.settings.permissions.deny.filter((v) => !v.includes("OAuth")); }
];
let killed = 0;
for (const mutate of mutations) {
  const candidate = JSON.parse(JSON.stringify(base)); mutate(candidate); let failed = false;
  try { provider.verifyPlanContract(candidate, capsule); } catch (_) { failed = true; }
  assert(failed, "mutation survived enforcement checker"); killed += 1;
}
process.stdout.write(`${JSON.stringify({ status: "PASS", mutationsKilled: killed, total: mutations.length }, null, 2)}\n`);
