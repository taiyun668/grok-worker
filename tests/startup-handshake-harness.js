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
  process.stdout.write(JSON.stringify({type:'heartbeat', requestId:'fake-request'}) + '\\n');
  setInterval(() => {}, 1000);
} else if (mode === 'end-missing-session') {
  process.stdout.write(JSON.stringify({type:'end', requestId:'request-without-session'}) + '\\n');
  process.exit(0);
} else if (mode === 'silent-exit') {
  process.exit(0);
} else {
  setInterval(() => {}, 1000);
}
`;

function spawnFixture(mode, counter, custodyControl = null) {
  if (mode === "spawn-error") {
    return () => {
      counter.count += 1;
      const error = new Error("controlled child could not be created");
      error.code = "ENOENT";
      throw error;
    };
  }
  if (mode === "late-close") {
    return (_command, _args, spawnOptions) => {
      counter.count += 1;
      const { signal: ignoredAbortSignal, ...childOptions } = spawnOptions;
      const child = childProcess.spawn(process.execPath, ["-e", fakeWorkerScript], {
        ...childOptions,
        env: { ...childOptions.env, STARTUP_FIXTURE_MODE: "idle" }
      });
      const exactKill = child.kill.bind(child);
      child.kill = () => false;
      custodyControl.child = child;
      custodyControl.killExactChild = exactKill;
      return child;
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

async function runUnconfirmedCustodyFixture(taskId) {
  const counter = { count: 0 };
  const custodyControl = { child: null, killExactChild: null };
  let error = null;
  try {
    await provider.runTask("worker-1", capsuleFor(taskId), {
      baselineCheckFn: () => {},
      changedFilesFinalStateFn: () => [],
      startupTimeoutMs: 6000,
      timeoutMs: 8000,
      terminationConfirmTimeoutMs: 60,
      spawnWorkerFn: spawnFixture("late-close", counter, custodyControl)
    });
  } catch (caught) { error = caught; }
  assert(error, "unconfirmed child should return a classified custody error");
  const taskDir = path.join(provider.RUNS_ROOT, taskId);
  const runFile = fs.readdirSync(taskDir).find((name) => name.endsWith(".json"));
  assert(runFile, "unconfirmed child must leave a durable TaskRun");
  return {
    error,
    counter,
    custodyControl,
    runFile: path.join(taskDir, runFile),
    taskRun: JSON.parse(fs.readFileSync(path.join(taskDir, runFile), "utf8"))
  };
}

function waitForChildClose(child) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => reject(new Error("late child close timeout")), 10000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
  });
}

async function waitForRun(file, predicate) {
  const deadline = Date.now() + 10000;
  let last = null;
  while (Date.now() < deadline) {
    last = JSON.parse(fs.readFileSync(file, "utf8"));
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`TaskRun recovery timeout: ${JSON.stringify(last)}`);
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
  assert.strictEqual(positive.output.requestObservation, "observed");
  assert.strictEqual(positive.output.realRequests, 1);
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
  assert.strictEqual(noSocket.output.taskRun.startupHandshake.requestObservation, "unknown");
  assert.strictEqual(noSocket.output.requestObservation, "unknown");
  assert.strictEqual(noSocket.output.realRequests, "unknown");
  assert.strictEqual(noSocket.output.taskRun.startupHandshake.termination, "exited");
  assert.strictEqual(noSocket.output.taskRun.startupHandshake.cleanup, "complete");
  assertRunSchemaShape(noSocket.output.taskRun);
  assertChildIdentityIsGone(noSocket.output.taskRun.startupHandshake);
  assert.strictEqual(noSocket.output.taskRun.attempts.length, 1);
  assert.strictEqual(noSocket.output.taskRun.attempts[0].requestObservation, "unknown");
  assert.strictEqual(noSocket.output.result.stopReason, "STARTUP_HANDSHAKE_BLOCKER");
  assert.strictEqual(noSocket.output.result.errorClassification.errorType, "provider_fault");
  assert.strictEqual(noSocket.output.result.errorClassification.note, "startup_handshake_blocker");
  assert(noSocket.output.result.findings.includes("requestObservation=unknown"));
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
  assert.strictEqual(socketWithoutEvent.output.taskRun.startupHandshake.requestObservation, "unknown");
  assert.strictEqual(socketWithoutEvent.output.requestObservation, "unknown");
  assert.strictEqual(socketWithoutEvent.output.realRequests, "unknown");
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

  const invalidEndTaskId = `startup-end-missing-session-${crypto.randomUUID()}`;
  const invalidEnd = await runFixture(invalidEndTaskId, "end-missing-session");
  assertDurableTriplet(invalidEnd.output, invalidEndTaskId);
  assert.strictEqual(invalidEnd.output.taskRun.status, "failed");
  assert.strictEqual(invalidEnd.output.result.status, "failed");
  assert.strictEqual(invalidEnd.output.taskRun.startupHandshake.failureClass, "STARTUP_HANDSHAKE_BLOCKER");
  assert.strictEqual(invalidEnd.output.taskRun.startupHandshake.failureReason, "child_exited_before_first_valid_event");
  assert.strictEqual(invalidEnd.output.taskRun.startupHandshake.requestObservation, "unknown");
  assert.strictEqual(invalidEnd.output.requestObservation, "unknown");
  assert.strictEqual(invalidEnd.output.realRequests, "unknown");
  assert(invalidEnd.output.result.requestId.startsWith("unknown-"));
  assert.strictEqual(invalidEnd.output.ledger.layers.sumRunUsage.invocationsCounted, 0);
  assert.strictEqual(invalidEnd.output.ledger.layers.sumRunUsage.invocationsUnknown, 1);

  const silentTaskId = `startup-silent-exit-${crypto.randomUUID()}`;
  const beforeSilent = new Map(profiles.map((profile) => [
    profile.profileId,
    availability.loadAvailability(provider.DATA_ROOT, profile.profileId, deps).revision
  ]));
  const silentExit = await runFixture(silentTaskId, "silent-exit");
  assertDurableTriplet(silentExit.output, silentTaskId);
  assert.strictEqual(silentExit.output.result.status, "failed");
  assert.strictEqual(silentExit.output.taskRun.status, "failed");
  assert.strictEqual(silentExit.output.taskRun.startupHandshake.requestObservation, "unknown");
  assert.strictEqual(silentExit.output.requestObservation, "unknown");
  assert.strictEqual(silentExit.output.realRequests, "unknown");
  const silentProfile = availability.loadAvailability(provider.DATA_ROOT, silentExit.output.taskRun.finalSelectedProfileId, deps);
  assert.strictEqual(silentProfile.revision, beforeSilent.get(silentExit.output.taskRun.finalSelectedProfileId), "silent exit 0 must not revise availability as success");

  const spawnFailureTaskId = `startup-os-spawn-failure-${crypto.randomUUID()}`;
  const spawnFailure = await runFixture(spawnFailureTaskId, "spawn-error");
  assertDurableTriplet(spawnFailure.output, spawnFailureTaskId);
  assert.strictEqual(spawnFailure.counter.count, 1);
  assert.strictEqual(spawnFailure.output.taskRun.status, "failed");
  assert.strictEqual(spawnFailure.output.taskRun.startupHandshake.failureClass, "OS_SPAWN_FAILED");
  assert.strictEqual(spawnFailure.output.taskRun.startupHandshake.childPid, null);
  assert.strictEqual(spawnFailure.output.taskRun.startupHandshake.requestObservation, "not_observed");
  assert.strictEqual(spawnFailure.output.requestObservation, "not_observed");
  assert.strictEqual(spawnFailure.output.realRequests, 0);
  assert.strictEqual(spawnFailure.output.requestObservation, "not_observed");
  assert.strictEqual(spawnFailure.output.realRequests, 0);
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

  const deniedTask = capsuleFor(`startup-main-error-${crypto.randomUUID()}`);
  deniedTask.realRequestPermission = "denied";
  deniedTask.apiKey = "local-test-secret-marker";
  const deniedTaskPath = path.join(sandbox, "denied-task.json");
  fs.writeFileSync(deniedTaskPath, `${JSON.stringify(deniedTask, null, 2)}\n`, "utf8");
  let capturedMainOutput = "";
  const originalStdoutWrite = process.stdout.write;
  const priorExitCode = process.exitCode;
  process.stdout.write = (chunk) => { capturedMainOutput += String(chunk); return true; };
  try { await provider.main(["run", "--task", deniedTaskPath]); }
  finally {
    process.stdout.write = originalStdoutWrite;
    process.exitCode = priorExitCode;
  }
  const mainError = JSON.parse(capturedMainOutput);
  assert.strictEqual(mainError.requestObservation, "not_observed");
  assert.strictEqual(mainError.realRequests, 0);
  assert(!capturedMainOutput.includes("local-test-secret-marker"));
  assert(!Object.keys(mainError.details || {}).some((key) => /stderr|stdout|prompt|auth|token/i.test(key)));

  const badDataRoot = path.join(sandbox, "not-a-directory-secret-marker");
  fs.writeFileSync(badDataRoot, "fixture", "utf8");
  assert.strictEqual(path.resolve(provider.CURRENT_POINTER_PATH), path.resolve(process.env.GROK_WORKER_CURRENT_JSON));
  const binResult = childProcess.spawnSync(process.execPath, [
    path.join(__dirname, "..", "bin", "grok-worker.js"), "version"
  ], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      GROK_WORKER_DATA_ROOT: badDataRoot,
      GROK_WORKER_PROFILES: path.join(sandbox, "profiles.json"),
      GROK_WORKER_APPROVED_PROFILE_ROOT: profileRoot,
      GROK_WORKER_CURRENT_JSON: path.join(sandbox, "current.json")
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000
  });
  assert.notStrictEqual(binResult.status, 0);
  const binError = JSON.parse(binResult.stdout);
  assert.strictEqual(binError.requestObservation, "unknown");
  assert.strictEqual(binError.realRequests, "unknown");
  assert.strictEqual(binResult.stderr, "");
  assert(!binResult.stdout.includes("not-a-directory-secret-marker"));
  assert.strictEqual(fs.existsSync(path.join(sandbox, "current.json")), false, "bin catch must stay bound to the isolated pointer path");

  const custodyTaskId = `startup-unconfirmed-custody-${crypto.randomUUID()}`;
  const custody = await runUnconfirmedCustodyFixture(custodyTaskId);
  assert.strictEqual(custody.counter.count, 1, "unconfirmed custody must never auto-resend");
  assert.strictEqual(custody.error.code, "STARTUP_CHILD_CUSTODY_UNCONFIRMED");
  assert.strictEqual(custody.error.details.requestObservation, "unknown");
  assert.strictEqual(custody.error.details.realRequests, "unknown");
  assert.strictEqual(custody.error.details.lockCustody, "child");
  assert(Number.isInteger(custody.taskRun.startupHandshake.childPid));
  assert.match(custody.taskRun.startupHandshake.childStartTicks || "", /^\d+$/);
  assert.strictEqual(custody.taskRun.status, "running");
  assert.strictEqual(custody.taskRun.takeoverRequired, true);
  assert.strictEqual(custody.taskRun.attempts.length, 0);
  assert.strictEqual(custody.taskRun.finalResultRef, null);
  assert.strictEqual(custody.taskRun.startupHandshake.cleanup, "retained");
  const retainedProfile = profiles.find((profile) => profile.profileId === custody.taskRun.finalSelectedProfileId);
  const lockRows = () => fs.readdirSync(provider.LOCK_ROOT).filter((name) => name.endsWith(".json"))
    .map((name) => provider._test.readJson(path.join(provider.LOCK_ROOT, name)));
  const profileCustody = lockRows().find((row) => row.scope === "profile" && row.patterns.includes(retainedProfile.grokHome));
  const workspaceCustody = lockRows().find((row) => row.scope === "workspace" && row.root === projectRoot);
  for (const lock of [profileCustody, workspaceCustody]) {
    assert(lock, "profile and workspace exclusivity must both remain held");
    assert.strictEqual(lock.pid, custody.taskRun.startupHandshake.childPid);
    assert.strictEqual(lock.processStartTicks, custody.taskRun.startupHandshake.childStartTicks);
    assert.strictEqual(lock.custodyOwner, "worker-child");
    assert.strictEqual(lock.leaseMs, Number.MAX_SAFE_INTEGER);
  }
  assert.throws(
    () => provider.acquireLock("profile", [retainedProfile.grokHome], projectRoot, 1000),
    (error) => error && error.code === "LOCK_CONFLICT"
  );
  assert.throws(
    () => provider.acquireLock("workspace", capsuleFor(custodyTaskId).allowedFiles, projectRoot, 1000),
    (error) => error && error.code === "LOCK_CONFLICT"
  );
  const custodyChildState = provider._test.inspectRunOwner({
    pid: custody.taskRun.startupHandshake.childPid,
    processStartTicks: custody.taskRun.startupHandshake.childStartTicks,
    capturedAt: custody.taskRun.startupHandshake.osSpawnedAt
  });
  assert.strictEqual(custodyChildState.state, "live");
  custody.custodyControl.killExactChild();
  await waitForChildClose(custody.custodyControl.child);
  const custodyFinal = await waitForRun(custody.runFile, (run) => run.status === "interrupted");
  assert.strictEqual(custodyFinal.takeoverRequired, true);
  assert.strictEqual(custodyFinal.attempts.length, 0);
  assert.strictEqual(custodyFinal.startupHandshake.termination, "exited");
  assert.strictEqual(custodyFinal.startupHandshake.cleanup, "complete");
  assert.strictEqual(fs.existsSync(path.join(provider.TEMP_ROOT, custodyFinal.startupHandshake.invocationId)), false);
  const recoveredProfileLock = provider.acquireLock("profile", [retainedProfile.grokHome], projectRoot, 1000);
  const recoveredWorkspaceLock = provider.acquireLock("workspace", capsuleFor(custodyTaskId).allowedFiles, projectRoot, 1000);
  recoveredWorkspaceLock.release();
  recoveredProfileLock.release();

  process.stdout.write(`${JSON.stringify({
    suite: "startup-handshake",
    passed: 9,
    failed: 0,
    evidence: [
      { name: "positive-control-os-socket-first-byte-valid-event-and-cleanup", status: "PASS" },
      { name: "negative-control-live-child-no-socket-or-stream-is-bounded-and-not-retried", status: "PASS" },
      { name: "negative-control-socket-and-unknown-type-requestId-does-not-unblock", status: "PASS" },
      { name: "negative-control-end-without-session-is-not-terminal-success", status: "PASS" },
      { name: "negative-control-silent-exit-zero-does-not-mark-profile-active", status: "PASS" },
      { name: "negative-control-os-spawn-failure-is-explicit-and-cleans-custody", status: "PASS" },
      { name: "main-errors-carry-observation-and-redact-secret-shaped-input", status: "PASS" },
      { name: "bin-top-level-catch-isolated-and-never-defaults-request-count-to-zero", status: "PASS" },
      { name: "unconfirmed-child-retains-profile-and-workspace-locks-until-late-close", status: "PASS" }
    ],
    realGrokRequests: 0,
    credentialAccess: false
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
