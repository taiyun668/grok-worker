"use strict";

const assert = require("assert");
const path = require("path");
const provider = require("../lib/provider");
const availability = require("../lib/availability");

const scratch = path.resolve("C:/maintenance-plan-mutation/scratch");
const profile = { executable: path.join(require("os").homedir(), ".grok", "bin", "grok.exe"), grokHome: "C:/profiles/one" };
const sessionId = "11111111-1111-4111-8111-111111111111";
const socket = path.join(scratch, "leader.sock");
const probe = availability.buildMaintenanceProbeArgs(scratch, sessionId, socket);
const base = {
  executable: profile.executable, args: probe.args,
  env: { GROK_HOME: profile.grokHome, HOME: scratch, USERPROFILE: scratch, LOCALAPPDATA: path.join(scratch, "AppData", "Local"), GROK_CLAUDE_HOOKS_ENABLED: "false", GROK_CURSOR_HOOKS_ENABLED: "false" },
  settings: probe.settings, scratch, cwd: scratch, promptPath: probe.promptPath, socket, sessionId
};
const mutations = [
  (x) => { x.executable = "C:/unverified/grok.exe"; },
  (x) => { x.args = x.args.filter((v) => v !== "--no-plan"); },
  (x) => { x.args = x.args.filter((v) => v !== "--no-memory"); },
  (x) => { x.args[x.args.indexOf("grok-4.6")] = "other-model"; },
  (x) => { x.args[x.args.indexOf("high")] = "low"; },
  (x) => { x.args[x.args.indexOf("1")] = "2"; },
  (x) => { x.settings.permissions.allow.push("Read(**/auth.json)"); },
  (x) => { x.settings.permissions.deny = x.settings.permissions.deny.filter((v) => v !== "Bash"); },
  (x) => { x.env.HOME = "C:/not-isolated"; },
  (x) => { x.env.GROK_CLAUDE_HOOKS_ENABLED = "true"; },
  (x) => { x.args.push("--resume", "old-session"); }
];
let killed = 0;
for (const mutate of mutations) {
  const candidate = JSON.parse(JSON.stringify(base));
  mutate(candidate);
  assert.throws(() => provider.verifyMaintenancePlanContract(candidate, profile), (error) => error && error.code === "MAINTENANCE_PLAN_CONTRACT");
  killed += 1;
}
for (const mutateProfileAndPlan of [
  (candidateProfile, candidatePlan) => { candidateProfile.executable = "C:/unverified/grok.exe"; candidatePlan.executable = candidateProfile.executable; },
  (candidateProfile, candidatePlan) => { candidateProfile.grokHome = path.join(require("os").homedir(), ".grok"); candidatePlan.env.GROK_HOME = candidateProfile.grokHome; }
]) {
  const candidate = JSON.parse(JSON.stringify(base));
  const candidateProfile = JSON.parse(JSON.stringify(profile));
  mutateProfileAndPlan(candidateProfile, candidate);
  assert.throws(() => provider.verifyMaintenancePlanContract(candidate, candidateProfile), (error) => error && error.code === "MAINTENANCE_PLAN_CONTRACT");
  killed += 1;
}
provider.verifyMaintenancePlanContract(base, profile);
process.stdout.write(`${JSON.stringify({ status: "PASS", mutationsKilled: killed, total: killed })}\n`);
