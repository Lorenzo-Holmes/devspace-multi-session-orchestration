import assert from "node:assert/strict";
import { writeFile, rename, unlink, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { IntegrationManager } from "./orchestration-integration.js";
import { probeCandidateMerge, mergeInputsUnchanged, observeValidationTree, type MergeProbeInput } from "./integration-merge-probe.js";
import { v2Fixture, exec } from "./test-support/orchestration-v2.js";

async function commit(cwd: string): Promise<string> {
  await exec("git", ["add", "--all"], { cwd });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "change"], { cwd });
  return (await exec("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
}

async function trustedEvidence(f: Awaited<ReturnType<typeof v2Fixture>>, cwd: string) {
  const source = await observeValidationTree(cwd);
  const run = f.sessions.beginTestRun(f.session.id, {
    kind: "test", checkDefinition: "test:fixture", requiresTestCount: false,
    command: "fixture-test", workingDirectory: cwd, testedCommit: source.commit,
    testedTree: source.tree, environmentIdentity: "fixture", issuer: "fixture",
  });
  const processSessionId = "fixture:" + run.testRunId;
  f.sessions.bindTestRunProcess(f.session.id, run.testRunId, processSessionId);
  const completed = f.sessions.finishTestRun(f.session.id, processSessionId,
    { exitCode: 0, sourceStable: true, positiveReceipt: true });
  assert.ok(completed.evidence);
  return completed.evidence!;
}

for (const scenario of ["same-line", "rename-delete", "delete-modify", "binary", "clean"] as const) {
  test("real isolated merge simulation: " + scenario, async t => {
    const f = await v2Fixture(t);
    if (scenario === "binary") {
      await writeFile(join(f.project, "same.txt"), Buffer.from([0, 1, 2, 3]));
      await commit(f.project);
    }
    const binding = await f.v2.bindings.provision(f.workspace, f.lease), cwd = binding.worktreeRoot!;
    if (scenario === "rename-delete") {
      await rename(join(cwd, "same.txt"), join(cwd, "renamed.txt"));
      await unlink(join(f.project, "same.txt"));
    } else if (scenario === "delete-modify") {
      await unlink(join(cwd, "same.txt"));
      await writeFile(join(f.project, "same.txt"), "target\n");
    } else if (scenario === "binary") {
      await writeFile(join(cwd, "same.txt"), Buffer.from([0, 4, 5, 6]));
      await writeFile(join(f.project, "same.txt"), Buffer.from([0, 7, 8, 9]));
    } else {
      await writeFile(join(cwd, "same.txt"), "candidate\n");
      await writeFile(join(f.project, scenario === "clean" ? "other.txt" : "same.txt"), "target\n");
    }
    const candidate = await commit(cwd), target = await commit(f.project);
    const indexPath = (await exec("git", ["rev-parse", "--path-format=absolute", "--git-path", "index"], { cwd })).stdout.trim();
    const indexBefore = await readFile(indexPath);
    const input: MergeProbeInput = { candidateRoot: cwd, sourceRoot: f.project, candidateRef: "HEAD", targetRef: "HEAD" };
    const result = await probeCandidateMerge(input);
    assert.equal(result.errorCode, undefined);
    assert.equal(result.conflictState, scenario === "clean" ? "clean" : "conflict");
    assert.equal(result.observation?.candidateOid, candidate);
    assert.equal(result.observation?.targetOid, target);
    assert.equal(await mergeInputsUnchanged(input, result.observation), true);
    assert.deepEqual(await readFile(indexPath), indexBefore);
    assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim(), candidate);
    assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: f.project })).stdout.trim(), target);
    assert.equal((await exec("git", ["status", "--porcelain=v1"], { cwd })).stdout.trim(), "");
    // A pristine index is not a claim that these two branches can merge.
    assert.equal((await exec("git", ["ls-files", "--unmerged"], { cwd })).stdout.trim(), "");
  });
}

for (const mutation of ["task", "session", "binding", "target", "candidate", "review"] as const) {
  test("asynchronous integration cannot publish stale " + mutation + " state", async t => {
    const f = await v2Fixture(t), binding = await f.v2.bindings.provision(f.workspace, f.lease);
    const cwd = binding.worktreeRoot!;
    await writeFile(join(cwd, "same.txt"), "candidate\n");
    await commit(cwd);
    let reached!: () => void, release!: () => void;
    const barrier = new Promise<void>(resolve => { reached = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const manager = new IntegrationManager(f.v2.store, f.coordinator, f.sessions, f.v2.bindings, async input => {
      const result = await probeCandidateMerge(input);
      reached();
      await wait;
      return result;
    });
    const record = manager.create(f.projectKey, f.task.id, f.session.id);
    const pending = manager.gate(f.projectKey, record.id, record.revision);
    await barrier;
    const reserved = manager.get(f.projectKey, record.id);
    assert.equal(reserved.evaluationState, "running");
    assert.equal(reserved.mergeReady, false);
    if (mutation === "task") f.coordinator.release(f.lease);
    if (mutation === "session") f.sessions.heartbeat(f.session.id);
    if (mutation === "binding") f.v2.store.update("worktree_bindings", { ...binding, dirtySource: true }, binding.revision);
    if (mutation === "target") { await writeFile(join(f.project, "target.txt"), "advance\n"); await commit(f.project); }
    if (mutation === "candidate") { await writeFile(join(cwd, "candidate.txt"), "advance\n"); await commit(cwd); }
    if (mutation === "review") manager.update(f.projectKey, record.id, reserved.revision, { reviewState: "changes_requested" });
    release();
    if (mutation === "review") {
      await assert.rejects(pending, /evaluation stale/);
      assert.equal(manager.get(f.projectKey, record.id).reviewState, "changes_requested");
    } else {
      const result = await pending;
      assert.equal(result.evaluationState, "stale");
      assert.equal(result.gates.evaluationFresh, false);
      assert.equal(result.mergeReady, false);
    }
  });
}

test("integration obtains trusted evidence by scoped ID beyond the event display prefix", async t => {
  const f = await v2Fixture(t), binding = await f.v2.bindings.provision(f.workspace, f.lease);
  await writeFile(join(binding.worktreeRoot!, "same.txt"), "candidate\n");
  const candidate = await commit(binding.worktreeRoot!);
  const evidence = await trustedEvidence(f, binding.worktreeRoot!);
  const event = f.sessions.latestEvent(f.session.id, "test_run")!;
  for (let i = 0; i < 501; i++) f.sessions.heartbeat(f.session.id);
  assert.equal(f.sessions.events(f.session.id, 500).some(item => item.id === event.id), false);
  assert.equal(f.sessions.event(f.session.id, event.id)?.id, event.id);
  const other = f.sessions.register({ projectKey: "other", workspaceRoot: f.project, state: "running" });
  assert.equal(f.sessions.evidence("other", other.id, evidence.evidenceId), undefined);
  f.coordinator.complete(f.lease);
  let record = f.v2.integrations.create(f.projectKey, f.task.id, f.session.id);
  record = f.v2.integrations.update(f.projectKey, record.id, record.revision,
    { evidenceIds: [evidence.evidenceId], reviewState: "approved" });
  record = await f.v2.integrations.gate(f.projectKey, record.id, record.revision);
  assert.equal(record.gates.testEvidence, true);
  assert.equal(record.mergeReady, true);
  assert.equal(evidence.testedCommit, candidate);
});

test("evidence for commit A cannot validate later candidate B", async t => {
  const f = await v2Fixture(t), binding = await f.v2.bindings.provision(f.workspace, f.lease);
  const cwd = binding.worktreeRoot!;
  await writeFile(join(cwd, "same.txt"), "candidate-a\n");
  await commit(cwd);
  const evidence = await trustedEvidence(f, cwd);
  await writeFile(join(cwd, "same.txt"), "candidate-b\n");
  await commit(cwd);
  f.coordinator.complete(f.lease);
  let record = f.v2.integrations.create(f.projectKey, f.task.id, f.session.id);
  record = f.v2.integrations.update(f.projectKey, record.id, record.revision,
    { evidenceIds: [evidence.evidenceId], reviewState: "approved" });
  record = await f.v2.integrations.gate(f.projectKey, record.id, record.revision);
  assert.equal(record.gates.testEvidence, false);
  assert.equal(record.mergeReady, false);
});

test("custom merge commands are not executed by the isolated simulation", async t => {
  const f = await v2Fixture(t), binding = await f.v2.bindings.provision(f.workspace, f.lease);
  await exec("git", ["config", "merge.custom.driver", "unavailable-command-for-test"], { cwd: f.project });
  const result = await probeCandidateMerge({ candidateRoot: binding.worktreeRoot!, sourceRoot: f.project, candidateRef: "HEAD", targetRef: "HEAD" });
  assert.equal(result.conflictState, "unknown");
  assert.equal(result.errorCode, "unsupported_merge_policy");
});

for (const source of ["fsmonitor", "filter"] as const) {
  test("merge observations do not execute repository " + source + " helpers", async t => {
    const f = await v2Fixture(t), binding = await f.v2.bindings.provision(f.workspace, f.lease);
    const marker = join(f.root, "unexpected-helper-execution"), script = join(f.root, "helper.cjs");
    await writeFile(script, "require('node:fs').writeFileSync(" + JSON.stringify(marker) + ", 'executed'); process.exit(1);\n");
    const command = '"' + process.execPath + '" "' + script + '"';
    await exec("git", ["config", source === "fsmonitor" ? "core.fsmonitor" : "filter.custom.clean", command], { cwd: f.project });
    if (source === "filter") await writeFile(join(f.project, ".gitattributes"), "* filter=custom\n");
    const result = await probeCandidateMerge({ candidateRoot: binding.worktreeRoot!, sourceRoot: f.project, candidateRef: "HEAD", targetRef: "HEAD" });
    assert.equal(result.conflictState, source === "filter" ? "unknown" : "clean");
    assert.equal(await access(marker).then(() => true, () => false), false);
  });
}

test("late project overlap is not hidden behind 1001 historical sessions", async t => {
  const f = await v2Fixture(t), binding = await f.v2.bindings.provision(f.workspace, f.lease);
  for (let index = 0; index < 1001; index++) {
    f.sessions.register({ id: "history_" + String(index).padStart(5, "0"), projectKey: f.projectKey, workspaceRoot: f.project, state: "completed" });
  }
  const peer = f.sessions.register({ id: "zz_active_peer", projectKey: f.projectKey, workspaceRoot: binding.worktreeRoot!, state: "running" });
  f.sessions.setFileIntents(f.session.id, [{ path: "same.txt", access: "write" }]);
  f.sessions.setFileIntents(peer.id, [{ path: "same.txt", access: "write" }]);
  const record = f.v2.integrations.create(f.projectKey, f.task.id, f.session.id);
  const result = await f.v2.integrations.gate(f.projectKey, record.id, record.revision);
  assert.equal(result.gates.noHighSeverityOverlap, false);
  assert.equal(result.mergeReady, false);
});

test("an installed but unused source filter does not block ordinary repositories", async t => {
  const f = await v2Fixture(t), binding = await f.v2.bindings.provision(f.workspace, f.lease);
  await exec("git", ["config", "filter.unused.clean", "unavailable-unused-helper"], { cwd: f.project });
  const result = await probeCandidateMerge({ candidateRoot: binding.worktreeRoot!, sourceRoot: f.project, candidateRef: "HEAD", targetRef: "HEAD" });
  assert.equal(result.conflictState, "clean");
});
