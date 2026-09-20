import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { WorktreeBinding } from "./orchestration-worktrees.js";
import { v2Fixture, exec } from "./test-support/orchestration-v2.js";

test("logical session identity survives workspace rebinding while worker incarnation is independently fenced", async t => {
  const f = await v2Fixture(t);
  const before = f.sessions.get(f.session.id);
  const binding = await f.v2.bindings.provision(f.workspace, f.lease);
  const inWorktree = f.sessions.get(f.session.id);
  assert.equal(inWorktree.logicalSessionId, before.logicalSessionId);
  assert.notEqual(inWorktree.workspaceRoot, before.workspaceRoot);
  assert.ok((inWorktree.bindingGeneration ?? 0) > (before.bindingGeneration ?? 0));

  f.sessions.bindWorkspace(f.session.id, f.projectKey, f.workspace.id, f.workspace.root);
  const backAtSource = f.sessions.get(f.session.id);
  assert.equal(backAtSource.logicalSessionId, before.logicalSessionId);
  assert.equal(backAtSource.workspaceRoot, f.workspace.root);
  assert.ok((backAtSource.bindingGeneration ?? 0) > (inWorktree.bindingGeneration ?? 0));

  const restarted = f.sessions.restartWorker(f.session.id);
  assert.equal(restarted.logicalSessionId, before.logicalSessionId);
  assert.notEqual(restarted.workerIncarnationId, before.workerIncarnationId);
  assert.equal(restarted.incarnation, (before.incarnation ?? 1) + 1);
  assert.equal(binding.attemptId, f.coordinator.get(f.task.id).attemptId);
});

test("old worker cannot complete an active execution attempt after worker restart", async t => {
  const f = await v2Fixture(t);
  const claimed = f.coordinator.get(f.task.id);
  assert.ok(claimed.attemptId);
  assert.ok(claimed.ownerWorkerIncarnationId);
  f.sessions.restartWorker(f.session.id);
  assert.throws(() => f.coordinator.complete(f.lease), /older worker incarnation|no longer owned/i);
  assert.equal(f.coordinator.get(f.task.id).state, "claimed");
});

test("released and reclaimed task gets a new attempt and old validation cannot issue evidence", async t => {
  const f = await v2Fixture(t);
  const old = f.coordinator.get(f.task.id);
  const run = f.sessions.beginTestRun(f.session.id, {
    kind: "test", checkDefinition: "test:fixture", requiresTestCount: false,
    command: "node --test fixture.test.js", workingDirectory: f.project,
    testedCommit: "a".repeat(40), testedTree: "b".repeat(40), environmentIdentity: "fixture", issuer: "fixture",
  });
  assert.equal(run.attemptId, old.attemptId);
  f.sessions.bindTestRunProcess(f.session.id, run.testRunId, "proc_old_attempt");
  const released = f.coordinator.release(f.lease);
  const reclaimed = f.coordinator.claim({ taskId: released.id, sessionId: f.session.id, expectedRevision: released.revision });
  assert.notEqual(reclaimed.attemptId, old.attemptId);
  assert.equal(reclaimed.leaseGeneration, old.leaseGeneration + 1);
  const finished = f.sessions.finishTestRun(f.session.id, "proc_old_attempt", {
    exitCode: 0, sourceStable: true, positiveReceipt: true,
  });
  assert.equal(finished.run.status, "unknown");
  assert.equal(finished.evidence, undefined);
});

test("reserved worktree recovers the immutable base after source HEAD advances", async t => {
  const f = await v2Fixture(t);
  const task = f.coordinator.get(f.task.id), session = f.sessions.get(f.session.id);
  const prepared = await f.workspaces.prepareWorktree(f.project, "HEAD", f.access.workspaceRestoreAllowedRoots(f.workspace), f.projectKey + ":" + f.task.id);
  const now = new Date().toISOString();
  f.v2.store.insert<WorktreeBinding>("worktree_bindings", {
    id: f.task.id, taskId: f.task.id, projectKey: f.projectKey, sessionId: f.session.id,
    sourceRoot: prepared.sourceRoot, baseRef: prepared.baseRef, baseOid: prepared.baseSha,
    expectedWorktreePath: prepared.path, dirtySource: prepared.dirtySource,
    operationId: "wtop_fixture", attemptId: task.attemptId, leaseGeneration: task.leaseGeneration,
    workerIncarnationId: session.workerIncarnationId, operationPhase: "reserved",
    managed: true, status: "provisioning", revision: 1, createdAt: now, updatedAt: now,
  });
  await writeFile(join(f.project, "later.txt"), "later\n");
  await exec("git", ["add", "."], { cwd: f.project });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "later"], { cwd: f.project });
  const binding = await f.v2.bindings.provision(f.workspace, f.lease);
  assert.equal(binding.baseSha, prepared.baseSha);
  assert.equal(binding.baseOid, prepared.baseSha);
  assert.equal(binding.operationPhase, "binding_active");
  assert.equal(await readFile(join(binding.worktreeRoot!, "same.txt"), "utf8"), "base\n");
  assert.equal(await readFile(join(binding.worktreeRoot!, "later.txt"), "utf8").then(() => true, () => false), false);
});

test("git-created and workspace-registered crash recovery reuses the same managed workspace", async t => {
  const f = await v2Fixture(t);
  const task = f.coordinator.get(f.task.id), session = f.sessions.get(f.session.id);
  const prepared = await f.workspaces.prepareWorktree(f.project, "HEAD", f.access.workspaceRestoreAllowedRoots(f.workspace), f.projectKey + ":" + f.task.id);
  await f.workspaces.materializeWorktree(prepared);
  const opened = await f.workspaces.openWorkspace({ path: f.project, mode: "worktree", baseRef: "HEAD",
    managedKey: f.projectKey + ":" + f.task.id, preparedWorktree: prepared },
  { allowedRoots: f.access.workspaceRestoreAllowedRoots(f.workspace), accessMode: "modify" });
  const now = new Date().toISOString();
  f.v2.store.insert<WorktreeBinding>("worktree_bindings", {
    id: f.task.id, taskId: f.task.id, projectKey: f.projectKey, sessionId: f.session.id,
    sourceRoot: prepared.sourceRoot, baseRef: prepared.baseRef, baseOid: prepared.baseSha,
    expectedWorktreePath: prepared.path, dirtySource: prepared.dirtySource,
    operationId: "wtop_registered_fixture", attemptId: task.attemptId, leaseGeneration: task.leaseGeneration,
    workerIncarnationId: session.workerIncarnationId, operationPhase: "git_created",
    managed: true, status: "provisioning", revision: 1, createdAt: now, updatedAt: now,
  });
  const binding = await f.v2.bindings.provision(f.workspace, f.lease);
  assert.equal(binding.workspaceId, opened.workspace.id);
  assert.equal(binding.operationPhase, "binding_active");
});

test("uncertain pre-existing managed worktree is quarantined and never deleted", async t => {
  const f = await v2Fixture(t);
  const task = f.coordinator.get(f.task.id), session = f.sessions.get(f.session.id);
  const prepared = await f.workspaces.prepareWorktree(f.project, "HEAD", f.access.workspaceRestoreAllowedRoots(f.workspace), f.projectKey + ":" + f.task.id);
  await mkdir(prepared.path, { recursive: true });
  await writeFile(join(prepared.path, "keep.txt"), "keep\n");
  const now = new Date().toISOString();
  f.v2.store.insert<WorktreeBinding>("worktree_bindings", {
    id: f.task.id, taskId: f.task.id, projectKey: f.projectKey, sessionId: f.session.id,
    sourceRoot: prepared.sourceRoot, baseRef: prepared.baseRef, baseOid: prepared.baseSha,
    expectedWorktreePath: prepared.path, dirtySource: prepared.dirtySource,
    operationId: "wtop_uncertain_fixture", attemptId: task.attemptId, leaseGeneration: task.leaseGeneration,
    workerIncarnationId: session.workerIncarnationId, operationPhase: "reserved",
    managed: true, status: "provisioning", revision: 1, createdAt: now, updatedAt: now,
  });
  await assert.rejects(f.v2.bindings.provision(f.workspace, f.lease));
  const binding = f.v2.bindings.get(f.projectKey, f.task.id)!;
  assert.equal(binding.operationPhase, "quarantined");
  assert.equal(await readFile(join(prepared.path, "keep.txt"), "utf8"), "keep\n");
});
