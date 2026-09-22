"use strict";

// Controlled child-process tests for Provider startup supervision.
// The child is Node itself; no Grok executable, account, credential, or model call is used.

const assert = require("assert");
const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "grok-worker-startup-handshake-"));
const profileRoot = path.join(sandbox, "profiles");
const projectRoot = path.join(sandbox, "project");
fs.mkdirSync(profileRoot, { recursive: true });
fs.mkdirSync(projectRoot, { recursive: true });
process.env.GROK_WORKER_DATA_ROOT = path.join(sandbox, "data");
process.env.GROK_WORKER_PROFILES = path.join(sandbox, "profiles.json");
process.env.GROK_WORKER_APPROVED_PROFILE_ROOT = profileRoot;
process.env.GROK_WORKER_CURRENT_JSON = path.join(sandbox, "current.json");

const provider = require("../lib/provider");
const availability = require("../lib/availability");
const runSchema = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "schemas", "task-run.provider.v6.schema.json"), "utf8"));

const profileIds = [
  "550e8400-e29b-41d4-a716-446655440011",
  "550e8400-e29b-41d4-a716-446655440012"
];
const profiles = profileIds.map((profileId, index) => {
  const grokHome = path.join(profileRoot, `worker-${index + 1}`);
  fs.mkdirSync(grokHome, { recursive: true });
  return {
    profileId,
    alias: `worker-${index + 1}`,
    grokHome,
    executable: path.join(os.homedir(), ".grok", "bin", "grok.exe"),
    accountLabel: `fixture-${index + 1}`,
    authReadiness: { oauthReady: true, verifiedAt: new Date().toISOString() },
    identity: {
      identityStatus: "unknown",
      source: "cli_probe",
      value: null,
      capturedAt: new Date().toISOString(),
      providerVersion: provider.VERSION
    },
    sandboxCapability: {
      flagSupported: true,
      enforcementSupported: false,
      platform: "windows",
      evidence: "Controlled harness; no OS sandbox claim"
    },
    modelSnapshot: {
      models: ["grok-4.6"],
      reasoning: ["high"],
      checkedAt: new Date().toISOString()
    }
  };
});
provider.saveRegistry({
  schemaVersion: 3,
  approvedProfileRoot: profileRoot,
  allowedWorkspaceRoots: [projectRoot],
  profiles
});

const deps = provider._test.availabilityDeps();
for (const [index, profile] of profiles.entries()) {
  const current = availability.loadAvailability(provider.DATA_ROOT, profile.profileId, deps);
  const active = availability.markActive(current);
  active.lastSelectedAt = index === 0 ? "2020-01-01T00:00:00.000Z" : "2020-01-02T00:00:00.000Z";
  availability.writeAvailabilityCas(provider.DATA_ROOT, profile.profileId, active, current.revision, deps);
}

const capsuleFor = (taskId) => ({
  taskId,
  stage: "startup-handshake-test",
  objective: "Verify bounded Provider process startup with a local fake child.",
  baseCommit: "0".repeat(40),
  workspace: projectRoot,
  worktree: { mode: "read-only-shared-checkout", path: projectRoot },
  allowedFiles: ["."],
  forbiddenActions: ["real model calls", "credential access", "account switching"],
  acceptanceCommands: ["controller verifies the Result Capsule"],
  contextRefs: ["."],
  realRequestPermission: "allowed",
  serviceControlPermission: "denied",
  gitPermission: "read-only",
  grokSessionId: null,
  resumePolicy: { mode: "new-only", rule: "Do not resume a prior session." },
  explicitStop: "Return the controlled result and stop.",
  model: "grok-4.6",
  reasoning: "high",
  speed: "standard",
  policy: { access: "readonly", bash: "denied", agents: "denied", mcp: "denied", web: "denied" },
  candidateProfileIds: profileIds,
  failover: {
    allowedFallbackProfileIds: [profileIds[1]],
    mode: "pre-first-request-only",
    switchPermission: "allowed"
  },
  probePolicy: availability.defaultProbePolicy()
});

const fakeWorkerScript = `
const fs = require('fs');
const mode = process.env.STARTUP_FIXTURE_MODE;
if (mode === 'valid-stream') {
  fs.writeFileSync(process.env.GROK_LEADER_SOCKET, 'controlled fixture socket');
  process.stdout.write(JSON.stringify({type:'text', data:'controlled'}) + '\\n');
  process.stdout.write(JSON.stringify({type:'end', sessionId:'fixture-session', requestId:'fixture-request', usage:{input_tokens:2, output_tokens:1, total_tokens:3}}) + '\\n');
  process.exit(0);
} else if (mode === 'socket-invalid-stream') {
  fs.writeFileSync(process.env.GROK_LEADER_SOCKET, 'controlled fixture socket');
  process.stdout.write('not-a-json-event\\n');
  setInterval(() => {}, 1000);
} else {
  setInterval(() => {}, 1000);
}
`;

function spawnFixture(mode, counter) {
  if (mode === "spawn-error") {
    return () => {
      counter.count += 1;
      const error = new Error("controlled child could not be created");
      error.code = "ENOENT";
      throw error;
    };
  }
  return (_command, _args, spawnOptions) => {
    counter.count += 1;
    return childProcess.spawn(process.execPath, ["-e", fakeWorkerScript], {
      ...spawnOptions,
      env: { ...spawnOptions.env, STARTUP_FIXTURE_MODE: mode }
    });
  };
}

async function runFixture(taskId, mode, startupTimeoutMs = 6000) {
  const counter = { count: 0 };
  const output = await provider.runTask("worker-1", capsuleFor(taskId), {
    baselineCheckFn: () => {},
    changedFilesFinalStateFn: () => [],
    startupTimeoutMs,
    timeoutMs: 8000,
    spawnWorkerFn: spawnFixture(mode, counter)
  });
  return { output, counter };
}

function assertRunSchemaShape(run) {
  const allowed = new Set(Object.keys(runSchema.properties));
  for (const required of runSchema.required) assert(Object.prototype.hasOwnProperty.call(run, required), `TaskRun missing schema field ${required}`);
  for (const key of Object.keys(run)) assert(allowed.has(key), `TaskRun field ${key} is not declared in the v6 schema`);
  if (run.startupHandshake !== null) {
    const handshakeSchema = runSchema.properties.startupHandshake.oneOf.find((entry) => entry.type === "object");
    for (const required of handshakeSchema.required) assert(Object.prototype.hasOwnProperty.call(run.startupHandshake, required), `startupHandshake missing ${required}`);
    for (const [field, definition] of Object.entries(handshakeSchema.properties)) {
      if (definition.enum) assert(definition.enum.includes(run.startupHandshake[field]), `startupHandshake.${field} is outside its schema enum`);
    }
  }
  const requestObservationEnum = runSchema.properties.attempts.items.properties.requestObservation.enum;
  for (const attempt of run.attempts) {
    if (attempt.requestObservation !== undefined) assert(requestObservationEnum.includes(attempt.requestObservation));
  }
}

function assertChildIdentityIsGone(handshake) {
  assert(Number.isInteger(handshake.childPid));
  assert.match(handshake.childStartTicks || "", /^\d+$/, "stalled child must persist an exact start identity");
  const state = provider._test.inspectRunOwner({
    pid: handshake.childPid,
    processStartTicks: handshake.childStartTicks,
    capturedAt: handshake.osSpawnedAt
  });
  assert.strictEqual(state.state, "dead", `exact child identity still appears live: ${JSON.stringify(state)}`);
}

function assertDurableTriplet(output, taskId) {
  const walPath = path.join(provider.RUNS_ROOT, taskId, `${output.taskRun.runId}.json`);
  const persistedRun = JSON.parse(fs.readFileSync(walPath, "utf8"));
  const resultFile = path.join(provider.DATA_ROOT, ...output.taskRun.finalResultRef.split("/"));
  const ledgerFile = path.join(provider.DATA_ROOT, "usage", "tasks", `${taskId.replace(/[^a-z0-9_.-]/gi, "_")}.json`);
  const persistedResult = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  const persistedLedger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
  assert.deepStrictEqual(persistedRun, output.taskRun, "returned TaskRun must match its committed WAL");
  assert.deepStrictEqual(persistedResult, output.result, "returned Result must match its durable Result Capsule");
  assert.deepStrictEqual(persistedLedger, output.ledger, "returned usage must match its durable ledger");
}

async function main() {
  const positiveTaskId = `startup-positive-${crypto.randomUUID()}`;
  const positive = await runFixture(positiveTaskId, "valid-stream", 10000);
  assertDurableTriplet(positive.output, positiveTaskId);
  assert.strictEqual(positive.output.taskRun.status, "completed");
  assert.strictEqual(positive.counter.count, 1);
  assert.strictEqual(positive.output.attempts.length, 1);
  assert.strictEqual(positive.output.attempts[0].requestObservation, "observed");
  assert.strictEqual(positive.output.taskRun.startupHandshake.phase, "process_exited");
  assert(positive.output.taskRun.startupHandshake.osSpawnedAt);
  assert(positive.output.taskRun.startupHandshake.socketObservedAt);
  assert(positive.output.taskRun.startupHandshake.firstStdoutByteAt);
  assert(positive.output.taskRun.startupHandshake.firstValidEventAt);
  assert.strictEqual(positive.output.taskRun.startupHandshake.cleanup, "complete");
  assertRunSchemaShape(positive.output.taskRun);
  assert.strictEqual(positive.output.result.status, "completed");
  assert.strictEqual(positive.output.ledger.layers.sumRunUsage.invocationsCounted, 1);
  assert(!fs.existsSync(positive.output.taskRun.startupHandshake.socketPath));

  const noSocketTaskId = `startup-no-socket-${crypto.randomUUID()}`;
  const noSocket = await runFixture(noSocketTaskId, "idle");
  assertDurableTriplet(noSocket.output, noSocketTaskId);
  assert.strictEqual(noSocket.counter.count, 1, "startup failure must not auto-resend to a fallback profile");
  assert.strictEqual(noSocket.output.taskRun.status, "failed");
  assert.strictEqual(noSocket.output.taskRun.startupHandshake.failureClass, "STARTUP_HANDSHAKE_BLOCKER");
  assert.strictEqual(noSocket.output.taskRun.startupHandshake.failureReason, "child_alive_no_socket_or_stdout");
  assert.strictEqual(noSocket.output.taskRun.startupHandshake.socketObservedAt, null);
  assert.strictEqual(noSocket.output.taskRun.startupHandshake.firstStdoutByteAt, null);
  assert.strictEqual(noSocket.output.taskRun.startupHandshake.firstValidEventAt, null);
  assert.strictEqual(noSocket.output.taskRun.startupHandshake.requestObservation, "not_observed");
  assert.strictEqual(noSocket.output.taskRun.startupHandshake.termination, "exited");
  assert.strictEqual(noSocket.output.taskRun.startupHandshake.cleanup, "complete");
  assertRunSchemaShape(noSocket.output.taskRun);
  assertChildIdentityIsGone(noSocket.output.taskRun.startupHandshake);
  assert.strictEqual(noSocket.output.taskRun.attempts.length, 1);
  assert.strictEqual(noSocket.output.taskRun.attempts[0].requestObservation, "not_observed");
  assert.strictEqual(noSocket.output.result.stopReason, "STARTUP_HANDSHAKE_BLOCKER");
  assert.strictEqual(noSocket.output.result.errorClassification.errorType, "provider_fault");
  assert.strictEqual(noSocket.output.result.errorClassification.note, "startup_handshake_blocker");
  assert(noSocket.output.result.findings.includes("requestObservation=not_observed"));
  assert.strictEqual(noSocket.output.ledger.layers.sumRunUsage.invocationsCounted, 0);
  assert.strictEqual(noSocket.output.ledger.layers.sumRunUsage.invocationsUnknown, 1);
  const noSocketAvailability = availability.loadAvailability(
    provider.DATA_ROOT,
    noSocket.output.taskRun.finalSelectedProfileId,
    deps
  );
  assert.strictEqual(noSocketAvailability.state, "active", "local startup failure must not freeze an account profile");
  assert(!fs.existsSync(noSocket.output.taskRun.startupHandshake.socketPath));

  const socketNoEventTaskId = `startup-socket-no-event-${crypto.randomUUID()}`;
  const socketWithoutEvent = await runFixture(socketNoEventTaskId, "socket-invalid-stream");
  assertDurableTriplet(socketWithoutEvent.output, socketNoEventTaskId);
  assert.strictEqual(socketWithoutEvent.counter.count, 1);
  assert.strictEqual(socketWithoutEvent.output.taskRun.status, "failed");
  assert.strictEqual(socketWithoutEvent.output.taskRun.startupHandshake.failureClass, "STARTUP_HANDSHAKE_BLOCKER");
  assert.strictEqual(socketWithoutEvent.output.taskRun.startupHandshake.failureReason, "socket_present_no_first_valid_event");
  assert(socketWithoutEvent.output.taskRun.startupHandshake.socketObservedAt);
  assert(socketWithoutEvent.output.taskRun.startupHandshake.firstStdoutByteAt);
  assert.strictEqual(socketWithoutEvent.output.taskRun.startupHandshake.firstValidEventAt, null);
  assert.strictEqual(socketWithoutEvent.output.taskRun.startupHandshake.requestObservation, "not_observed");
  assert.strictEqual(socketWithoutEvent.output.taskRun.startupHandshake.cleanup, "complete");
  assertRunSchemaShape(socketWithoutEvent.output.taskRun);
  assertChildIdentityIsGone(socketWithoutEvent.output.taskRun.startupHandshake);
  assert.strictEqual(socketWithoutEvent.output.ledger.layers.sumRunUsage.invocationsUnknown, 1);
  const socketWithoutEventAvailability = availability.loadAvailability(
    provider.DATA_ROOT,
    socketWithoutEvent.output.taskRun.finalSelectedProfileId,
    deps
  );
  assert.strictEqual(socketWithoutEventAvailability.state, "active", "malformed startup output must not freeze an account profile");
  assert(!fs.existsSync(socketWithoutEvent.output.taskRun.startupHandshake.socketPath));

  const spawnFailureTaskId = `startup-os-spawn-failure-${crypto.randomUUID()}`;
  const spawnFailure = await runFixture(spawnFailureTaskId, "spawn-error");
  assertDurableTriplet(spawnFailure.output, spawnFailureTaskId);
  assert.strictEqual(spawnFailure.counter.count, 1);
  assert.strictEqual(spawnFailure.output.taskRun.status, "failed");
  assert.strictEqual(spawnFailure.output.taskRun.startupHandshake.failureClass, "OS_SPAWN_FAILED");
  assert.strictEqual(spawnFailure.output.taskRun.startupHandshake.childPid, null);
  assert.strictEqual(spawnFailure.output.taskRun.startupHandshake.requestObservation, "not_observed");
  assert.strictEqual(spawnFailure.output.taskRun.startupHandshake.termination, "not_required");
  assert.strictEqual(spawnFailure.output.taskRun.startupHandshake.cleanup, "complete");
  assert.strictEqual(spawnFailure.output.result.stopReason, "OS_SPAWN_FAILED");
  assert.strictEqual(spawnFailure.output.ledger.layers.sumRunUsage.invocationsUnknown, 1);
  assert.strictEqual(spawnFailure.output.ledger.layers.sumRunUsage.invocationsCounted, 0);
  assert.strictEqual(availability.loadAvailability(
    provider.DATA_ROOT,
    spawnFailure.output.taskRun.finalSelectedProfileId,
    deps
  ).state, "active", "OS spawn failure must not freeze an account profile");

  process.stdout.write(`${JSON.stringify({
    suite: "startup-handshake",
    passed: 4,
    failed: 0,
    evidence: [
      { name: "positive-control-os-socket-first-byte-valid-event-and-cleanup", status: "PASS" },
      { name: "negative-control-live-child-no-socket-or-stream-is-bounded-and-not-retried", status: "PASS" },
      { name: "negative-control-socket-and-bytes-without-valid-event-is-bounded", status: "PASS" },
      { name: "negative-control-os-spawn-failure-is-explicit-and-cleans-custody", status: "PASS" }
    ],
    realGrokRequests: 0,
    credentialAccess: false
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
