import assert from "node:assert/strict";
import test from "node:test";
import { deriveOrchestrationHealth } from "./orchestration-health.js";
import { identifyValidationCommand } from "./orchestration-validation.js";
import { v2Fixture } from "./test-support/orchestration-v2.js";

const commit = "1".repeat(40);
const tree = "2".repeat(40);

test("validation command classification rejects help and keyword false positives", async () => {
  assert.equal(await identifyValidationCommand("node --test --help", process.cwd()), undefined);
  assert.equal(await identifyValidationCommand("echo test build typecheck", process.cwd()), undefined);
  assert.equal(await identifyValidationCommand("node -e \"console.log('test')\"", process.cwd()), undefined);
  const direct = await identifyValidationCommand("node --test src/example.test.ts", process.cwd());
  assert.equal(direct?.kind, "test");
  assert.equal(direct?.requiresTestCount, true);
  const packageTest = await identifyValidationCommand("pnpm test", process.cwd());
  assert.equal(packageTest?.kind, "test");
  assert.match(packageTest?.checkDefinition ?? "", /^test:sha256:/);
});

test("TestRun lifecycle is fail-closed and only a completed successful run issues evidence", async t => {
  const f = await v2Fixture(t);
  const begin = () => f.sessions.beginTestRun(f.session.id, {
    kind: "test", checkDefinition: "test:fixture", requiresTestCount: false,
    command: "fixture-test", workingDirectory: f.project, testedCommit: commit, testedTree: tree,
    environmentIdentity: "fixture", issuer: "fixture",
  });
  const finish = (run: ReturnType<typeof begin>, input: Parameters<typeof f.sessions.finishTestRun>[2]) => {
    const processId = "fixture:" + run.testRunId;
    const running = f.sessions.bindTestRunProcess(f.session.id, run.testRunId, processId);
    assert.equal(running.status, "running");
    return f.sessions.finishTestRun(f.session.id, processId, input);
  };

  for (const [name, input, status] of [
    ["exit1", { exitCode: 1, sourceStable: true, positiveReceipt: true }, "failed"],
    ["signal", { exitCode: 0, signal: "SIGTERM", sourceStable: true, positiveReceipt: true }, "failed"],
    ["timeout", { exitCode: 0, timedOut: true, sourceStable: true, positiveReceipt: true }, "failed"],
    ["cancel", { exitCode: 0, cancelled: true, sourceStable: true, positiveReceipt: true }, "cancelled"],
    ["no-receipt", { exitCode: 0, sourceStable: true, positiveReceipt: false }, "unknown"],
    ["source-moved", { exitCode: 0, sourceStable: false, positiveReceipt: true }, "unknown"],
  ] as const) {
    const result = finish(begin(), input);
    assert.equal(result.run.status, status, name);
    assert.equal(result.evidence, undefined, name);
  }

  const passed = finish(begin(), { exitCode: 0, sourceStable: true, positiveReceipt: true });
  assert.equal(passed.run.status, "passed");
  assert.equal(passed.run.trustLevel, "execution_observed");
  assert.ok(passed.evidence);
  assert.equal(passed.evidence?.testedCommit, commit);
  assert.equal(passed.evidence?.testedTree, tree);
  assert.equal(f.sessions.evidence(f.projectKey, f.session.id, passed.evidence!.evidenceId)?.testRunId, passed.run.testRunId);
});

test("failed or caller-declared tests cannot clear unverified changes; trusted success can", async t => {
  const f = await v2Fixture(t);
  f.sessions.recordEvent({ sessionId: f.session.id, kind: "file_change", detail: { paths: ["same.txt"] } });
  f.sessions.recordEvent({ sessionId: f.session.id, kind: "test_run", detail: { passed: true } });
  let session = f.sessions.get(f.session.id);
  assert.equal(session.lastSuccessfulValidationAt, undefined);
  assert.ok(deriveOrchestrationHealth(session, new Date(), { idleMs: 1e12, stalledMs: 2e12 }).signals.includes("unverified_changes"));

  const failed = f.sessions.beginTestRun(f.session.id, {
    kind: "test", checkDefinition: "test:fixture", requiresTestCount: false,
    command: "fixture-test", workingDirectory: f.project, testedCommit: commit, testedTree: tree,
    environmentIdentity: "fixture", issuer: "fixture",
  });
  const failedPid = "fixture:" + failed.testRunId;
  f.sessions.bindTestRunProcess(f.session.id, failed.testRunId, failedPid);
  f.sessions.finishTestRun(f.session.id, failedPid, { exitCode: 1, sourceStable: true, positiveReceipt: true });
  session = f.sessions.get(f.session.id);
  assert.ok(deriveOrchestrationHealth(session, new Date(), { idleMs: 1e12, stalledMs: 2e12 }).signals.includes("unverified_changes"));
  assert.ok(session.lastValidationFailureAt);

  const successful = f.sessions.beginTestRun(f.session.id, {
    kind: "test", checkDefinition: "test:fixture", requiresTestCount: false,
    command: "fixture-test", workingDirectory: f.project, testedCommit: commit, testedTree: tree,
    environmentIdentity: "fixture", issuer: "fixture",
  });
  const successPid = "fixture:" + successful.testRunId;
  f.sessions.bindTestRunProcess(f.session.id, successful.testRunId, successPid);
  f.sessions.finishTestRun(f.session.id, successPid, { exitCode: 0, sourceStable: true, positiveReceipt: true });
  session = f.sessions.get(f.session.id);
  assert.equal(session.lastValidatedFileGeneration, session.fileGeneration);
  assert.equal(deriveOrchestrationHealth(session, new Date(), { idleMs: 1e12, stalledMs: 2e12 }).signals.includes("unverified_changes"), false);
});
