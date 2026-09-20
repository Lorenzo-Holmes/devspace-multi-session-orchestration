import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProcessSessionManager } from "../../src/process-sessions.js";
import { loadConfig } from "../../src/config.js";
import { writeTestDevspaceConfig } from "../../src/test-support/config.test.js";
import { WorkspaceRegistry } from "../../src/workspaces.js";
import { SqliteWorkspaceStore } from "../../src/workspace-store.js";

test("chaos: a non-zero child process is reported as a failure receipt, not a running process", async t => {
  const manager = new ProcessSessionManager();
  t.after(() => manager.shutdown());
  const snapshot = await manager.start({ workspaceId: "ws_chaos", cwd: process.cwd(),
    command: `"${process.execPath}" -e "process.exit(7)"`, yieldTimeMs: 5_000 });
  assert.equal(snapshot.running, false);
  assert.equal(snapshot.exitCode, 7);
});

test("chaos: a real loopback port conflict is distinguishable as EADDRINUSE", async t => {
  const first = createServer();
  await new Promise<void>((resolve, reject) => { first.once("error", reject); first.listen(0, "127.0.0.1", resolve); });
  t.after(() => first.close());
  const address = first.address();
  assert.ok(address && typeof address === "object");
  const second = createServer();
  const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
    second.once("error", resolve); second.listen(address.port, "127.0.0.1");
  });
  second.close();
  assert.equal(error.code, "EADDRINUSE");
});

test("chaos: invalid configuration remains a hard parse failure", async t => {
  const root = await mkdtemp(join(tmpdir(), "devspace-chaos-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const env = writeTestDevspaceConfig(configDir);
  await writeFile(join(configDir, "config.jsonc"), JSON.stringify({ server: { port: -1 } }));
  assert.throws(() => loadConfig(env));
});

test("chaos: reproduce missing persisted workspace restoration without existence verification", async t => {
  const root = await mkdtemp(join(tmpdir(), "devspace-chaos-workspace-")), project = join(root, "project");
  await mkdir(project);
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = loadConfig(writeTestDevspaceConfig(join(root, "config"), {
    workspaces: { allowedRoots: [root], worktreeRoot: join(root, "trees") }, storage: { stateDir: join(root, "state") },
  }));
  const store = new SqliteWorkspaceStore(config.stateDir);
  const registry = new WorkspaceRegistry(config, store);
  const opened = await registry.openWorkspace(project);
  await rm(project, { recursive: true, force: true });
  const restarted = new WorkspaceRegistry(config, store);
  const restored = restarted.getWorkspace(opened.workspace.id);
  assert.equal(restored.root, project);
  await assert.rejects(stat(restored.root), /ENOENT/);
  store.close();
});
