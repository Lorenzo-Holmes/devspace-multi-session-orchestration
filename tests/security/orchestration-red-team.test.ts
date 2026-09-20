import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { v2Fixture, exec } from "../../src/test-support/orchestration-v2.js";
import { writeFileTool } from "../../src/pi-tools.js";
import { installOrchestrationTelemetry } from "../../src/orchestration-telemetry.js";

async function candidateCommit(cwd: string): Promise<string> {
  await writeFile(join(cwd, "same.txt"), "security candidate\n");
  await exec("git", ["add", "--all"], { cwd });
  await exec("git", ["-c", "user.name=Security", "-c", "user.email=security@example.test", "commit", "-m", "security candidate"], { cwd });
  return (await exec("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
}

test("SEC-001 reproduction: running/help-like validation telemetry can be attached to an explicit commit on main", async t => {
  const f = await v2Fixture(t);
  let wrapped: ((args: unknown, extra: unknown) => Promise<unknown>) | undefined;
  const fakeServer = {
    registerTool(_name: string, _config: unknown, callback: (args: unknown, extra: unknown) => unknown) {
      wrapped = async (args, extra) => await callback(args, extra);
      return {};
    },
  };
  installOrchestrationTelemetry(fakeServer as never, f.sessions, f.workspaces);
  fakeServer.registerTool("exec_command", {}, async () => ({
    isError: false, structuredContent: { running: true },
    content: [{ type: "text", text: "Process running" }],
  }));
  await wrapped!({ workspaceId: f.workspace.id, cmd: "node --test --help" }, { _meta: { "openai/session": "security-chat" } });
  const automatic = f.sessions.list({ projectKey: f.projectKey, limit: 20 }).find(item => item.sessionKind === "chatgpt_auto");
  assert.ok(automatic);
  const event = f.sessions.events(automatic.id, 20).find(item => item.kind === "test_run");
  assert.ok(event);
  assert.equal(event.detail.passed, true);

  const [task] = f.coordinator.createPlan(f.projectKey, [{ name: "security-auto", description: "security telemetry task" }]);
  const claimed = f.coordinator.claim({ taskId: task.id, sessionId: automatic.id, expectedRevision: task.revision });
  const lease = { taskId: task.id, sessionId: automatic.id, leaseToken: claimed.leaseToken!, expectedRevision: claimed.revision };
  const binding = await f.v2.bindings.provision(f.workspace, lease);
  const commit = await candidateCommit(binding.worktreeRoot!);
  f.coordinator.complete(lease);
  let integration = f.v2.integrations.create(f.projectKey, task.id, automatic.id);
  integration = f.v2.integrations.update(f.projectKey, integration.id, integration.revision, {
    testEvidence: [{ eventId: event.id, commit }], reviewState: "approved",
  });
  integration = await f.v2.integrations.gate(f.projectKey, integration.id, integration.revision);
  assert.equal(integration.gates.testEvidence, true);
  assert.equal(integration.mergeReady, true);
});

test("SEC-002 reproduction: Claude-compatible write follows an in-workspace junction outside the workspace on main", async t => {
  const root = await mkdtemp(join(tmpdir(), "devspace-sec-junction-"));
  const workspace = join(root, "workspace"), outside = join(root, "outside");
  await mkdir(workspace); await mkdir(outside);
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(outside, join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
  const response = await writeFileTool({ path: "escape/written.txt", content: "escaped\n" }, { cwd: workspace, root: workspace });
  assert.notEqual(response.isError, true);
  assert.equal(await readFile(join(outside, "written.txt"), "utf8"), "escaped\n");
});

test("SEC-003 reproduction: a handoff remains acknowledgeable after sender loses the task lease", async t => {
  const f = await v2Fixture(t);
  const receiver = f.sessions.register({ projectKey: f.projectKey, workspaceRoot: f.project, state: "running" });
  const record = f.v2.handoffs.create(f.projectKey, {
    fromSessionId: f.session.id, toSessionId: receiver.id, taskId: f.task.id,
    summary: "security stale handoff", nextAction: "review",
  });
  const released = f.coordinator.release(f.lease);
  const newOwner = f.sessions.register({ projectKey: f.projectKey, workspaceRoot: f.project, state: "running" });
  const reclaimed = f.coordinator.claim({ taskId: f.task.id, sessionId: newOwner.id, expectedRevision: released.revision });
  assert.equal(reclaimed.ownerSessionId, newOwner.id);
  const acknowledged = f.v2.handoffs.acknowledge(f.projectKey, record.id, receiver.id, record.revision);
  assert.equal(acknowledged.state, "acknowledged");
});

test("project scoping, wrong receiver and stale lease fail closed", async t => {
  const f = await v2Fixture(t);
  const binding = await f.v2.bindings.provision(f.workspace, f.lease);
  assert.ok(binding.worktreeRoot);
  const integration = f.v2.integrations.create(f.projectKey, f.task.id, f.session.id);
  assert.throws(() => f.v2.integrations.get("other-project", integration.id), /project scope/i);

  const receiver = f.sessions.register({ projectKey: f.projectKey, workspaceRoot: f.project, state: "running" });
  const attacker = f.sessions.register({ projectKey: f.projectKey, workspaceRoot: f.project, state: "running" });
  const handoff = f.v2.handoffs.create(f.projectKey, {
    fromSessionId: f.session.id, toSessionId: receiver.id, taskId: f.task.id, summary: "scoped", nextAction: "review",
  });
  assert.throws(() => f.v2.handoffs.get("other-project", handoff.id), /project scope/i);
  assert.throws(() => f.v2.handoffs.acknowledge(f.projectKey, handoff.id, attacker.id, handoff.revision), /receiver/i);

  const released = f.coordinator.release(f.lease);
  assert.throws(() => f.coordinator.complete(f.lease), /lease|revision/i);
  assert.equal(released.state, "pending");
});

test("bounded handoff payload rejects resource-amplification input", async t => {
  const f = await v2Fixture(t);
  assert.throws(() => f.v2.handoffs.create(f.projectKey, {
    fromSessionId: f.session.id, taskId: f.task.id,
    summary: "x".repeat(8_001), nextAction: "review",
  }));
  assert.equal(await access(join(f.project, "unexpected-security-output")).then(() => true, () => false), false);
});
