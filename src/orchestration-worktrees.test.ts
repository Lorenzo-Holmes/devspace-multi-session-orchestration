import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { v2Fixture } from "./test-support/orchestration-v2.js";
import { OrchestrationV2 } from "./orchestration-v2.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { detectOrchestrationConflicts } from "./orchestration-conflicts.js";

test("worktree provisioning is idempotent, restart safe, preserves dirty source and never deletes", async t => {
  const f = await v2Fixture(t);
  await writeFile(join(f.project, "same.txt"), "dirty source\n");
  const [a, concurrent] = await Promise.all([f.v2.bindings.provision(f.workspace, f.lease), f.v2.bindings.provision(f.workspace, f.lease)]);
  assert.deepEqual(a, concurrent);
  assert.equal(a.dirtySource, true);
  assert.equal(await readFile(join(f.project, "same.txt"), "utf8"), "dirty source\n");
  assert.equal(await readFile(join(a.worktreeRoot!, "same.txt"), "utf8"), "base\n");
  const repeats = await Promise.all([f.v2.bindings.provision(f.workspace, f.lease), f.v2.bindings.provision(f.workspace, f.lease)]);
  assert.deepEqual(repeats, [a, a]);
  const restarted = new OrchestrationV2(f.config, f.sessions, f.coordinator, new WorkspaceRegistry(f.config, f.store), f.access);
  try { assert.deepEqual(await restarted.bindings.provision(f.workspace, f.lease), a); } finally { restarted.close(); }
  f.coordinator.complete(f.lease);
  const cleanup = f.v2.bindings.cleanup(f.projectKey, f.task.id, a.revision);
  assert.equal(cleanup.status, "cleanup_eligible");
  assert.ok((await stat(a.worktreeRoot!)).isDirectory());
});

test("worktree provision rejects wrong project, owner, token, revision and expired lease", async t => {
  const f = await v2Fixture(t);
  await assert.rejects(f.v2.bindings.provision({ ...f.workspace, root: f.root }, f.lease), /project scope/);
  const other = f.sessions.register({ projectKey: f.projectKey, workspaceRoot: f.project, state: "running" });
  await assert.rejects(f.v2.bindings.provision(f.workspace, { ...f.lease, sessionId: other.id }), /Valid task lease/);
  await assert.rejects(f.v2.bindings.provision(f.workspace, { ...f.lease, leaseToken: "wrong" }), /Valid task lease/);
  await assert.rejects(f.v2.bindings.provision(f.workspace, { ...f.lease, expectedRevision: 99 }), /revision conflict/);
  f.coordinator.release(f.lease);
  await assert.rejects(f.v2.bindings.provision(f.workspace, { ...f.lease, expectedRevision: 3 }), /Valid task lease/);
  const expired = f.coordinator.claim({ taskId: f.task.id, sessionId: f.session.id, expectedRevision: 3, now: new Date(Date.now() - 3600000) });
  await assert.rejects(f.v2.bindings.provision(f.workspace, { ...f.lease, expectedRevision: expired.revision, leaseToken: expired.leaseToken! }), /Valid task lease/);
});

test("different managed worktrees isolate the same relative path without false conflicts", async t => {
  const f = await v2Fixture(t);
  const a = await f.v2.bindings.provision(f.workspace, f.lease);
  const owner = f.sessions.register({ projectKey: f.projectKey, workspaceRoot: f.project, state: "running" });
  const [task] = f.coordinator.createPlan(f.projectKey, [{ name: "second", description: "second worker" }]);
  const lease = f.coordinator.claim({ taskId: task.id, sessionId: owner.id, expectedRevision: 1 });
  const b = await f.v2.bindings.provision(f.workspace, { taskId: task.id, sessionId: owner.id, expectedRevision: lease.revision, leaseToken: lease.leaseToken! });
  const sa = f.sessions.get(f.session.id), sb = f.sessions.get(owner.id);
  f.sessions.setFileIntents(sa.id, [{ path: "same.txt", access: "write" }]);
  f.sessions.setFileIntents(sb.id, [{ path: "same.txt", access: "write" }]);
  await writeFile(join(a.worktreeRoot!, "same.txt"), "worker a");
  assert.equal(await readFile(join(b.worktreeRoot!, "same.txt"), "utf8"), "base\n");
  assert.deepEqual(detectOrchestrationConflicts([sa, sb], f.sessions.fileIntents()), []);
});
