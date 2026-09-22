"use strict";

/**
 * Process-level regression for live-run recovery. Zero Grok requests.
 * A holder process writes a running WAL with its PID/start identity. Concurrent
 * status and maintenance CLI processes must preserve it. Only after the holder
 * exits may maintenance recover it to interrupted/takeoverRequired.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const assert = require("assert");
const childProcess = require("child_process");
const STALE_STARTUP_AT = "2000-01-01T00:00:00.000Z";

function mkdir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function writeJson(file, value) {
  mkdir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

function applyRoots(dataRoot, registryPath, approvedRoot) {
  process.env.GROK_WORKER_DATA_ROOT = dataRoot;
  process.env.GROK_WORKER_PROFILES = registryPath;
  process.env.GROK_WORKER_APPROVED_PROFILE_ROOT = approvedRoot;
}

async function holderMain(args) {
  const [dataRoot, registryPath, approvedRoot, taskId, runId, childPidArg, childStartTicksArg] = args;
  applyRoots(dataRoot, registryPath, approvedRoot);
  const provider = require("../lib/provider");
  const availability = require("../lib/availability");
  const deps = provider._test.availabilityDeps();
  const owner = provider._test.captureRunOwner();
  const run = availability.emptyTaskRun(taskId, runId, owner);
  run.status = "running";
  const retainedChild = childPidArg && childStartTicksArg
    ? { pid: Number(childPidArg), processStartTicks: childStartTicksArg }
    : null;
  const invocationRoot = path.join(dataRoot, "temp", runId);
  if (retainedChild) {
    mkdir(invocationRoot);
    fs.writeFileSync(path.join(invocationRoot, "task.prompt.txt"), "controlled retained invocation", "utf8");
  }
  run.startupHandshake = {
    invocationId: runId,
    phase: retainedChild ? "startup_failed" : "materializing",
    startedAt: STALE_STARTUP_AT,
    lastProgressAt: STALE_STARTUP_AT,
    socketPath: path.join(invocationRoot, "leader.sock"),
    childPid: retainedChild ? retainedChild.pid : null,
    childStartTicks: retainedChild ? retainedChild.processStartTicks : null,
    osSpawnedAt: retainedChild ? new Date().toISOString() : null,
    socketObservedAt: null,
    firstStdoutByteAt: null,
    firstValidEventAt: null,
    requestObservation: retainedChild ? "unknown" : "not_observed",
    failureClass: retainedChild ? "STARTUP_HANDSHAKE_BLOCKER" : null,
    failureReason: retainedChild ? "controlled-unconfirmed-child" : null,
    termination: retainedChild ? "unconfirmed" : "not_required",
    cleanup: retainedChild ? "retained" : "pending"
  };
  availability.writeTaskRun(dataRoot, run, deps);
  if (process.send) process.send({ type: "ready", owner });
  setInterval(() => {}, 1000);
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("holder-ready-timeout")), 15000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`holder-exited-before-ready:${code}`));
    });
    child.on("message", (message) => {
      if (message && message.type === "ready") {
        clearTimeout(timer);
        resolve(message);
      }
    });
  });
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("holder-exit-timeout")), 15000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

function runCli(root, env, args) {
  const result = childProcess.spawnSync(process.execPath, [path.join(root, "bin", "grok-worker.js"), ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000
  });
  assert.strictEqual(result.status, 0, String(result.stderr || result.stdout || "CLI failed"));
  const parsed = JSON.parse(String(result.stdout || "{}"));
  if (args.join(" ") === "pool maintenance tick") assert.strictEqual(parsed.realRequests, 0);
  return parsed;
}

function runCliAsync(root, env, args) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, [path.join(root, "bin", "grok-worker.js"), ...args], {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI timeout: ${args.join(" ")}`)); }, 30000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr || stdout || `CLI exit ${code}`));
      try {
        const parsed = JSON.parse(stdout || "{}");
        if (args.join(" ") === "pool maintenance tick") assert.strictEqual(parsed.realRequests, 0);
        resolve(parsed);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function runTaskRunTransactionAsync(root, env, options) {
  const args = [
    "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", path.join(root, "lib", "task-run-transaction.ps1"),
    "-WalPath", options.walPath,
    "-DesiredPath", options.desiredPath,
    "-ExpectedRevision", String(options.expectedRevision)
  ];
  if (options.holdMilliseconds) {
    args.push("-TestHoldAfterReadMilliseconds", String(options.holdMilliseconds));
    args.push("-TestReadyPath", options.readyPath);
  }
  const child = childProcess.spawn("powershell.exe", args, {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  const completion = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("task-run-transaction-timeout")); }, 30000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      let payload = null;
      try { payload = JSON.parse(stdout.trim() || "{}"); } catch (_) { /* asserted by caller */ }
      resolve({ code, stdout, stderr, payload });
    });
  });
  return { child, completion };
}

async function waitForFile(file) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await delay(20);
  }
  throw new Error(`ready-file-timeout:${file}`);
}

async function waitForDeadOwner(provider, owner) {
  const deadline = Date.now() + 10000;
  let last = null;
  while (Date.now() < deadline) {
    last = provider._test.inspectRunOwner(owner);
    if (last.state === "dead") return last;
    await delay(50);
  }
  throw new Error(`owner-death-not-observable:${JSON.stringify(last)}`);
}

async function parentMain() {
  const root = path.resolve(__dirname, "..");
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "grok-worker-run-recovery-"));
  const dataRoot = path.join(sandbox, "data");
  const registryPath = path.join(sandbox, "profiles.json");
  const approvedRoot = path.join(sandbox, "profiles");
  const taskId = `live-recovery-${crypto.randomUUID()}`;
  const runId = crypto.randomUUID();
  const wal = path.join(dataRoot, "runs", taskId, `${runId}.json`);
  mkdir(approvedRoot);
  writeJson(registryPath, {
    schemaVersion: 3,
    approvedProfileRoot: approvedRoot,
    allowedWorkspaceRoots: [],
    profiles: []
  });
  const env = {
    ...process.env,
    GROK_WORKER_DATA_ROOT: dataRoot,
    GROK_WORKER_PROFILES: registryPath,
    GROK_WORKER_APPROVED_PROFILE_ROOT: approvedRoot
  };
  applyRoots(dataRoot, registryPath, approvedRoot);
  const provider = require("../lib/provider");
  const child = childProcess.fork(__filename, ["--holder", dataRoot, registryPath, approvedRoot, taskId, runId], {
    cwd: root,
    env,
    silent: true
  });
  let custodyWorker = null;
  let custodyHolder = null;

  try {
    const ready = await waitForReady(child);
    assert.strictEqual(readJson(wal).status, "running");
    const staleStartupBeforeMaintenance = readJson(wal).startupHandshake;

    await Promise.all([
      runCliAsync(root, env, ["pool", "status"]),
      runCliAsync(root, env, ["doctor"]),
      runCliAsync(root, env, ["pool", "maintenance", "tick"])
    ]);
    runCli(root, env, ["pool", "status"]);
    const whileLive = readJson(wal);
    assert.strictEqual(whileLive.status, "running");
    assert.strictEqual(whileLive.takeoverRequired, false);
    assert.deepStrictEqual(whileLive.owner, ready.owner);
    assert.strictEqual(whileLive.attempts.length, 0, "zero attempts remain pre-request evidence");
    assert.deepStrictEqual(whileLive.startupHandshake, staleStartupBeforeMaintenance);
    assert.strictEqual(whileLive.startupHandshake.lastProgressAt, STALE_STARTUP_AT, "stale progress must not be refreshed into a false liveness signal");
    assert.strictEqual(whileLive.startupHandshake.requestObservation, "not_observed");
    assert.strictEqual(fs.readdirSync(path.dirname(wal)).filter((name) => name.endsWith(".json")).length, 1, "live stale run must not create an automatic resend");

    child.kill();
    await waitForExit(child);
    await waitForDeadOwner(provider, ready.owner);
    const deadMaintenance = runCli(root, env, ["pool", "maintenance", "tick"]);
    const afterDeath = readJson(wal);
    assert.strictEqual(afterDeath.status, "interrupted", JSON.stringify({ deadMaintenance, afterDeath }));
    assert.strictEqual(afterDeath.takeoverRequired, true);
    assert.strictEqual(afterDeath.attempts.length, 0);
    assert.strictEqual(afterDeath.startupHandshake.lastProgressAt, STALE_STARTUP_AT);
    assert.strictEqual(fs.readdirSync(path.dirname(wal)).filter((name) => name.endsWith(".json")).length, 1, "dead-owner recovery records interruption without issuing a replacement run");

    const custodyTaskId = `dead-owner-live-child-${crypto.randomUUID()}`;
    const custodyRunId = crypto.randomUUID();
    const custodyWal = path.join(dataRoot, "runs", custodyTaskId, `${custodyRunId}.json`);
    custodyWorker = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: root,
      env,
      windowsHide: true,
      stdio: "ignore"
    });
    await waitForSpawn(custodyWorker);
    const custodyChildTicks = provider._test.queryProcessStartTicks(custodyWorker.pid);
    assert.match(custodyChildTicks || "", /^\d+$/);
    custodyHolder = childProcess.fork(__filename, [
      "--holder", dataRoot, registryPath, approvedRoot,
      custodyTaskId, custodyRunId,
      String(custodyWorker.pid), custodyChildTicks
    ], { cwd: root, env, silent: true });
    const custodyReady = await waitForReady(custodyHolder);
    assert.strictEqual(readJson(custodyWal).owner.pid, custodyReady.owner.pid);
    runCli(root, env, ["pool", "maintenance", "tick"]);
    assert.strictEqual(readJson(custodyWal).status, "running", "live child custody must preserve a run while its Provider owner is alive");

    custodyHolder.kill();
    await waitForExit(custodyHolder);
    await waitForDeadOwner(provider, custodyReady.owner);
    runCli(root, env, ["pool", "maintenance", "tick"]);
    const providerDeadChildLive = readJson(custodyWal);
    assert.strictEqual(providerDeadChildLive.status, "running", "dead Provider owner cannot release a still-live child custody lock");
    assert.strictEqual(providerDeadChildLive.takeoverRequired, false);
    assert.strictEqual(providerDeadChildLive.attempts.length, 0);
    assert.strictEqual(providerDeadChildLive.startupHandshake.cleanup, "retained");
    assert(fs.existsSync(path.join(dataRoot, "temp", custodyRunId, "task.prompt.txt")));

    custodyWorker.kill();
    await waitForExit(custodyWorker);
    runCli(root, env, ["pool", "maintenance", "tick"]);
    const childDeadRecovered = readJson(custodyWal);
    assert.strictEqual(childDeadRecovered.status, "interrupted");
    assert.strictEqual(childDeadRecovered.takeoverRequired, true);
    assert.strictEqual(childDeadRecovered.attempts.length, 0);
    assert.strictEqual(childDeadRecovered.startupHandshake.termination, "exited");
    assert.strictEqual(childDeadRecovered.startupHandshake.cleanup, "complete");
    assert.strictEqual(fs.existsSync(path.join(dataRoot, "temp", custodyRunId)), false, "Provider owner recovery removes invocation custody only after child identity is dead");
    assert.strictEqual(fs.readdirSync(path.dirname(custodyWal)).filter((name) => name.endsWith(".json")).length, 1, "child custody recovery does not issue a replacement run");

    const aliasTaskId = `alias-recovery-${crypto.randomUUID()}`;
    const aliasRunId = crypto.randomUUID();
    const aliasWal = path.join(dataRoot, "runs", aliasTaskId, `${aliasRunId}.json`);
    const aliasWalExtended = `\\\\?\\${aliasWal}`;
    const aliasReady = path.join(sandbox, "alias-first-read.ready");
    const initialAliasRun = {
      schemaVersion: 6,
      taskId: aliasTaskId,
      runId: aliasRunId,
      status: "running",
      takeoverRequired: false,
      owner: ready.owner,
      revision: 7,
      updatedAt: new Date().toISOString(),
      writer: "initial"
    };
    writeJson(aliasWal, initialAliasRun);
    const desiredFirst = path.join(sandbox, "alias-desired-first.json");
    const desiredSecond = path.join(sandbox, "alias-desired-second.json");
    writeJson(desiredFirst, { ...initialAliasRun, writer: "normal-hold" });
    writeJson(desiredSecond, { ...initialAliasRun, writer: "extended-contender" });
    const transactionEnv = { ...env, GROK_WORKER_PROVIDER_TEST_MODE: "1" };
    const first = runTaskRunTransactionAsync(root, transactionEnv, {
      walPath: aliasWal,
      desiredPath: desiredFirst,
      expectedRevision: 7,
      holdMilliseconds: 1500,
      readyPath: aliasReady
    });
    await waitForFile(aliasReady);
    const second = runTaskRunTransactionAsync(root, transactionEnv, {
      walPath: aliasWalExtended,
      desiredPath: desiredSecond,
      expectedRevision: 7
    });
    const [firstResult, secondResult] = await Promise.all([first.completion, second.completion]);
    assert.strictEqual(firstResult.code, 0, firstResult.stderr || firstResult.stdout);
    assert.strictEqual(firstResult.payload && firstResult.payload.ok, true);
    assert.strictEqual(secondResult.code, 2, secondResult.stderr || secondResult.stdout);
    assert.strictEqual(secondResult.payload && secondResult.payload.code, "TASK_RUN_CAS_CONFLICT");
    const aliasFinal = readJson(aliasWal);
    assert.strictEqual(aliasFinal.revision, 8);
    assert.strictEqual(aliasFinal.writer, "normal-hold");

    const junctionRoot = path.join(sandbox, "junction-alias");
    const junctionTargetOne = path.join(sandbox, "junction-target-one");
    const junctionTargetTwo = path.join(sandbox, "junction-target-two");
    mkdir(junctionTargetOne);
    mkdir(junctionTargetTwo);
    fs.symlinkSync(junctionTargetOne, junctionRoot, "junction");
    const junctionLeaf = "retargeted-run.json";
    const junctionWal = path.join(junctionRoot, junctionLeaf);
    const targetOneWal = path.join(junctionTargetOne, junctionLeaf);
    const targetTwoWal = path.join(junctionTargetTwo, junctionLeaf);
    const junctionInitial = {
      schemaVersion: 6,
      taskId: `junction-recovery-${crypto.randomUUID()}`,
      runId: crypto.randomUUID(),
      status: "running",
      takeoverRequired: false,
      owner: ready.owner,
      revision: 11,
      updatedAt: new Date().toISOString(),
      writer: "initial"
    };
    writeJson(targetOneWal, junctionInitial);
    writeJson(targetTwoWal, junctionInitial);
    const junctionDesiredFirst = path.join(sandbox, "junction-desired-first.json");
    const junctionDesiredSecond = path.join(sandbox, "junction-desired-second.json");
    const junctionReady = path.join(sandbox, "junction-first-read.ready");
    writeJson(junctionDesiredFirst, { ...junctionInitial, writer: "resolved-target-one" });
    writeJson(junctionDesiredSecond, { ...junctionInitial, writer: "direct-target-two" });
    const junctionFirst = runTaskRunTransactionAsync(root, transactionEnv, {
      walPath: junctionWal,
      desiredPath: junctionDesiredFirst,
      expectedRevision: 11,
      holdMilliseconds: 1500,
      readyPath: junctionReady
    });
    await waitForFile(junctionReady);
    fs.unlinkSync(junctionRoot);
    fs.symlinkSync(junctionTargetTwo, junctionRoot, "junction");
    const junctionSecond = runTaskRunTransactionAsync(root, transactionEnv, {
      walPath: targetTwoWal,
      desiredPath: junctionDesiredSecond,
      expectedRevision: 11
    });
    const [junctionFirstResult, junctionSecondResult] = await Promise.all([
      junctionFirst.completion,
      junctionSecond.completion
    ]);
    assert.strictEqual(junctionFirstResult.code, 0, junctionFirstResult.stderr || junctionFirstResult.stdout);
    assert.strictEqual(junctionSecondResult.code, 0, junctionSecondResult.stderr || junctionSecondResult.stdout);
    assert.strictEqual(readJson(targetOneWal).revision, 12);
    assert.strictEqual(readJson(targetOneWal).writer, "resolved-target-one");
    assert.strictEqual(readJson(targetTwoWal).revision, 12);
    assert.strictEqual(readJson(targetTwoWal).writer, "direct-target-two");

    process.stdout.write(`${JSON.stringify({
      suite: "run-recovery-concurrency",
      passed: 6,
      failed: 0,
      evidence: [
        { name: "live-holder-survives-concurrent-status-doctor-and-maintenance", status: "PASS" },
        { name: "stale-startup-wal-live-idle-owner-is-preserved-without-resend", status: "PASS" },
        { name: "dead-holder-recovers-to-interrupted", status: "PASS" },
        { name: "dead-provider-owner-remains-running-until-exact-worker-child-dies", status: "PASS" },
        { name: "normal-and-extended-wal-paths-share-one-machine-mutex", status: "PASS" },
        { name: "junction-retarget-cannot-change-the-locked-wal-object", status: "PASS" }
      ],
      realGrokRequests: 0
    }, null, 2)}\n`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    if (custodyHolder && custodyHolder.exitCode === null && custodyHolder.signalCode === null) custodyHolder.kill();
    if (custodyWorker && custodyWorker.exitCode === null && custodyWorker.signalCode === null) custodyWorker.kill();
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) { /* retain only on OS cleanup failure */ }
  }
}

if (process.argv[2] === "--holder") {
  holderMain(process.argv.slice(3)).catch((error) => {
    if (process.send) process.send({ type: "error", message: error.message });
    process.exitCode = 1;
  });
} else {
  parentMain().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
