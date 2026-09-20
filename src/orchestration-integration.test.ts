import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { v2Fixture, exec } from "./test-support/orchestration-v2.js";
import { OrchestrationV2 } from "./orchestration-v2.js";
import { observeValidationTree } from "./integration-merge-probe.js";

async function issueEvidence(f: Awaited<ReturnType<typeof v2Fixture>>, cwd: string) {
  const source = await observeValidationTree(cwd);
  const run = f.sessions.beginTestRun(f.session.id, {
    kind: "test", checkDefinition: "test:fixture", requiresTestCount: false,
    command: "fixture-test", workingDirectory: cwd,
    testedCommit: source.commit, testedTree: source.tree,
    environmentIdentity: "fixture", issuer: "fixture",
  });
  const processSessionId = "fixture:" + run.testRunId;
  f.sessions.bindTestRunProcess(f.session.id, run.testRunId, processSessionId);
  const finished = f.sessions.finishTestRun(f.session.id, processSessionId, {
    exitCode: 0, sourceStable: true, positiveReceipt: true,
  });
  assert.ok(finished.evidence);
  return finished.evidence!;
}

test("integration gates fail closed, collect commit-specific test evidence and preserve review across restart", async t => {
  const f = await v2Fixture(t), binding = await f.v2.bindings.provision(f.workspace, f.lease);
  const created = f.v2.integrations.create(f.projectKey, f.task.id, f.session.id);
  let current = await f.v2.integrations.gate(f.projectKey, created.id, 1);
  assert.equal(current.mergeReady, false);
  assert.equal(current.gates.taskReady, false);
  assert.equal(current.gates.testEvidence, false);
  const cwd = binding.worktreeRoot!;
  await writeFile(join(cwd, "same.txt"), "candidate\n");
  await exec("git", ["add", "."], { cwd });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "candidate"], { cwd });
  const commit = (await exec("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
  const evidence = await issueEvidence(f, cwd);
  f.coordinator.complete(f.lease);
  current = f.v2.integrations.update(f.projectKey, current.id, current.revision, { evidenceIds: [evidence.evidenceId], reviewState: "approved" });
  current = await f.v2.integrations.gate(f.projectKey, current.id, current.revision);
  assert.equal(current.mergeReady, true);
  assert.ok(Object.values(current.gates).every(Boolean));
  assert.throws(() => f.v2.integrations.update(f.projectKey, current.id, 1, {}), /revision conflict/);
  assert.throws(() => f.v2.integrations.get("other", current.id), /project scope/);
  const restart = new OrchestrationV2(f.config, f.sessions, f.coordinator, f.workspaces, f.access);
  try { assert.deepEqual(restart.integrations.get(f.projectKey, current.id), current); } finally { restart.close(); }
  await writeFile(join(cwd, "same.txt"), "uncommitted\n");
  current = await f.v2.integrations.gate(f.projectKey, current.id, current.revision);
  assert.equal(current.mergeReady, false);
  assert.equal(current.integrationWorktreeState, "dirty");
  assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim(), commit);
});

test("integration rejects foreign bindings, invalid refs and unverified evidence", async t => {
  const f = await v2Fixture(t);
  await f.v2.bindings.provision(f.workspace, f.lease);
  assert.throws(() => f.v2.integrations.create("other", f.task.id, f.session.id), /project scope/);
  assert.throws(() => f.v2.integrations.create(f.projectKey, f.task.id, f.session.id, "--help"), /Ref/);
  const valid = f.v2.integrations.create(f.projectKey, f.task.id, f.session.id);
  assert.throws(() => f.v2.integrations.update(f.projectKey, valid.id, valid.revision,
    { evidenceIds: ["evid_00000000000000000000"], reviewState: "approved" }), /execution-issued/);
  assert.throws(() => f.v2.integrations.update(f.projectKey, valid.id, valid.revision,
    { testEvidence: [] } as never), /unrecognized/i);
  const item = f.v2.integrations.create(f.projectKey, f.task.id, f.session.id, "nonexistent");
  const result = await f.v2.integrations.gate(f.projectKey, item.id, item.revision);
  assert.equal(result.gates.candidateAvailable, false);
  assert.equal(result.mergeReady, false);
});
