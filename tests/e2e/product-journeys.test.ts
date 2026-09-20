import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { v2Fixture, exec } from "../../src/test-support/orchestration-v2.js";
import { supervisorSummary } from "../../src/orchestration-supervisor.js";
import { OrchestrationV2 } from "../../src/orchestration-v2.js";
import { ProcessSessionManager } from "../../src/process-sessions.js";

async function commit(cwd: string, message: string): Promise<string> {
  await exec("git", ["add", "--all"], { cwd });
  await exec("git", ["-c", "user.name=E2E", "-c", "user.email=e2e@example.test", "commit", "-m", message], { cwd });
  return (await exec("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
}

test("isolated product journey: workspace -> worktree -> edit -> validation -> integration -> handoff -> supervisor", async t => {
  const f = await v2Fixture(t);
  const binding = await f.v2.bindings.provision(f.workspace, f.lease);
  const cwd = binding.worktreeRoot!;
  await writeFile(join(cwd, "same.txt"), "e2e candidate\n");
  const candidate = await commit(cwd, "e2e candidate");

  const validation = f.sessions.recordEvent({ sessionId: f.session.id, kind: "test_run", detail: { passed: true } }).event;
  f.sessions.setState(f.session.id, "ready_review");
  f.coordinator.complete(f.lease);

  let integration = f.v2.integrations.create(f.projectKey, f.task.id, f.session.id);
  integration = f.v2.integrations.update(f.projectKey, integration.id, integration.revision, {
    testEvidence: [{ eventId: validation.id, commit: candidate }], reviewState: "approved",
  });
  integration = await f.v2.integrations.gate(f.projectKey, integration.id, integration.revision);
  assert.equal(integration.mergeReady, true);

  const receiver = f.sessions.register({ projectKey: f.projectKey, workspaceRoot: f.project, state: "running", label: "receiver" });
  let handoff = f.v2.handoffs.create(f.projectKey, {
    fromSessionId: f.session.id, toSessionId: receiver.id, taskId: f.task.id,
    summary: "E2E work completed", filesChanged: ["same.txt"], tests: ["isolated validation"], errors: [], unresolvedItems: [],
    nextAction: "Review integration receipt", branch: "detached", commit: candidate, worktree: cwd,
  });
  handoff = f.v2.handoffs.acknowledge(f.projectKey, handoff.id, receiver.id, handoff.revision);
  assert.equal(handoff.state, "acknowledged");

  const automation = f.v2.automation.poll(f.projectKey);
  assert.equal(typeof automation.truncated, "boolean");
  const summary = supervisorSummary(f.v2, f.projectKey);
  assert.ok(summary.sections.some(section => section.key === "integrations"));
  assert.ok(summary.counts.completed >= 1);

  const restart = new OrchestrationV2(f.config, f.sessions, f.coordinator, f.workspaces, f.access);
  try {
    assert.equal(restart.integrations.get(f.projectKey, integration.id).candidateCommit, candidate);
    assert.equal(restart.handoffs.get(f.projectKey, handoff.id).state, "acknowledged");
  } finally { restart.close(); }
});

test("isolated product journey: coordinator DAG gates dependent work", async t => {
  const f = await v2Fixture(t);
  const [build, publish] = f.coordinator.createPlan(f.projectKey, [
    { name: "e2e-build", description: "Build artifact", priority: 1 },
    { name: "e2e-publish", description: "Publish artifact", dependencies: ["e2e-build"] },
  ]);
  assert.equal(f.coordinator.readyQueue(f.projectKey).some(task => task.id === publish.id), false);
  const worker = f.sessions.register({ projectKey: f.projectKey, workspaceRoot: f.project, state: "running" });
  const claimed = f.coordinator.claim({ taskId: build.id, sessionId: worker.id, expectedRevision: build.revision });
  f.coordinator.complete({ taskId: build.id, sessionId: worker.id, leaseToken: claimed.leaseToken!, expectedRevision: claimed.revision });
  assert.equal(f.coordinator.readyQueue(f.projectKey).some(task => task.id === publish.id), true);
});

test("isolated product journey: two task worktrees remain physically isolated", async t => {
  const f = await v2Fixture(t);
  const first = await f.v2.bindings.provision(f.workspace, f.lease);
  const secondSession = f.sessions.register({ projectKey: f.projectKey, workspaceRoot: f.project, state: "running" });
  const [secondTask] = f.coordinator.createPlan(f.projectKey, [{ name: "e2e-second", description: "parallel task" }]);
  const secondClaim = f.coordinator.claim({ taskId: secondTask.id, sessionId: secondSession.id, expectedRevision: secondTask.revision });
  const second = await f.v2.bindings.provision(f.workspace, {
    taskId: secondTask.id, sessionId: secondSession.id, leaseToken: secondClaim.leaseToken!, expectedRevision: secondClaim.revision,
  });
  assert.notEqual(first.worktreeRoot, second.worktreeRoot);
  await writeFile(join(first.worktreeRoot!, "isolated.txt"), "worker one\n");
  assert.equal(await import("node:fs/promises").then(fs => fs.access(join(second.worktreeRoot!, "isolated.txt")).then(() => true, () => false)), false);
});

test("isolated product journey: long-running process returns a session and later a terminal receipt", async t => {
  const manager = new ProcessSessionManager({ completedSessionTtlMs: 5_000 });
  t.after(() => manager.shutdown());
  const command = `"${process.execPath}" -e "setTimeout(()=>{console.log('E2E_DONE');process.exit(0)},120)"`;
  let snapshot = await manager.start({ workspaceId: "ws_e2e", command, cwd: process.cwd(), yieldTimeMs: 0 });
  assert.equal(snapshot.running, true);
  assert.ok(snapshot.sessionId);
  for (let i = 0; i < 20 && snapshot.running; i++) {
    snapshot = await manager.write({ workspaceId: "ws_e2e", sessionId: snapshot.sessionId!, yieldTimeMs: 250 });
  }
  assert.equal(snapshot.running, false);
  assert.equal(snapshot.exitCode, 0);
  assert.match(snapshot.output, /E2E_DONE/);
});
