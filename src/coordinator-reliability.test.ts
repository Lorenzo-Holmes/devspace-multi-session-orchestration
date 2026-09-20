import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { openDatabase } from "./db/client.js";
import { CoordinatorStore } from "./coordinator-store.js";
import { OrchestrationCoordinator } from "./orchestration-coordinator.js";
import { OrchestrationStore } from "./orchestration-store.js";
import { OrchestrationRegistry } from "./orchestration-registry.js";

const now = "2026-09-19T01:00:00.000Z";
const future = "2026-09-19T01:10:00.000Z";
const exec = promisify(execFile);

for (const historyCount of [500, 1000, 5000]) {
  test(`ready scheduling sees pending and expired tasks beyond ${historyCount} history rows`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "devspace-ready-sql-"));
    const sessions = new OrchestrationRegistry(new OrchestrationStore(dir));
    const store = new CoordinatorStore(dir);
    const db = openDatabase(dir);
    t.after(async () => { db.close(); store.close(); sessions.close(); await rm(dir, { recursive: true, force: true }); });
    const coordinator = new OrchestrationCoordinator(store, sessions);
    const owner = sessions.register({ projectKey: "p", workspaceRoot: dir, state: "running" });
    db.sqlite.transaction(() => {
      const insert = db.sqlite.prepare(`insert into coordinator_tasks
        (id, project_key, name, description, state, priority, revision, created_at, updated_at)
        values (?, 'p', ?, 'fixture', 'completed', 100, 1, ?, ?)`);
      for (let i = 0; i < historyCount; i++) insert.run(`history-${i}`, `history-${i}`, now, now);
    }).immediate();
    const tasks = store.createPlan("p", [
      { id: "pending-a", name: "a", description: "eligible", priority: 0, dependencies: [] },
      { id: "pending-b", name: "b", description: "eligible", priority: 0, dependencies: [] },
      { id: "expired", name: "expired", description: "expired lease", priority: 1, dependencies: [] },
      { id: "blocked", name: "blocked", description: "dependency is pending", priority: 99, dependencies: ["pending-a"] },
    ], now);
    store.updateClaim({ taskId: "expired", expectedRevision: 1, ownerSessionId: owner.id,
      leaseToken: "old-token", leaseExpiresAt: now, now: "2026-09-19T00:50:00.000Z" });
    assert.equal(store.listTasks("p").length, 500, "UI history remains bounded");
    const ready = coordinator.readyQueue("p", new Date(now));
    assert.deepEqual(ready.map(task => task.id), ["expired", "pending-a", "pending-b"]);
    assert.deepEqual(coordinator.readyQueue("other", new Date(now)), []);
    assert.equal(tasks.length, 4);
    assert.deepEqual(coordinator.readyQueue("p", new Date(now)).map(task => task.id), ready.map(task => task.id));
  });
}

test("SQL claim guards reject active leases, wrong-project owners, terminal tasks and expired completion", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "devspace-lease-sql-"));
  const sessions = new OrchestrationRegistry(new OrchestrationStore(dir));
  const store = new CoordinatorStore(dir);
  t.after(async () => { store.close(); sessions.close(); await rm(dir, { recursive: true, force: true }); });
  const owner = sessions.register({ projectKey: "p", workspaceRoot: dir, state: "running" });
  const other = sessions.register({ projectKey: "other", workspaceRoot: dir, state: "running" });
  store.createPlan("p", [{ id: "task", name: "task", description: "test", priority: 0, dependencies: [] }], now);
  const claim = { taskId: "task", expectedRevision: 1, ownerSessionId: owner.id, leaseToken: "first", leaseExpiresAt: future, now };
  assert.throws(() => store.updateClaim({ ...claim, ownerSessionId: other.id }), /revision conflict/);
  const claimed = store.updateClaim(claim);
  assert.throws(() => store.updateClaim({ ...claim, expectedRevision: claimed.revision, leaseToken: "second" }), /revision conflict/);
  assert.throws(() => store.completeClaim({ taskId: "task", expectedRevision: claimed.revision,
    ownerSessionId: owner.id, leaseToken: "first", now: future }), /lease or revision/);
  assert.throws(() => store.releaseClaim({ taskId: "task", expectedRevision: claimed.revision,
    ownerSessionId: owner.id, leaseToken: "first", now: future }), /lease or revision/);
  const reclaimed = store.updateClaim({ ...claim, expectedRevision: claimed.revision, leaseToken: "second",
    now: future, leaseExpiresAt: "2026-09-19T01:20:00.000Z" });
  assert.throws(() => store.completeClaim({ taskId: "task", expectedRevision: reclaimed.revision,
    ownerSessionId: owner.id, leaseToken: "first", now: future }), /lease or revision/);
  const completed = store.completeClaim({ taskId: "task", expectedRevision: reclaimed.revision,
    ownerSessionId: owner.id, leaseToken: "second", now: future });
  assert.throws(() => store.updateClaim({ ...claim, expectedRevision: completed.revision }), /revision conflict/);
});

test("two independent Node processes cannot create two current execution attempts", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "devspace-multiprocess-claim-"));
  const sessions = new OrchestrationRegistry(new OrchestrationStore(dir));
  const store = new CoordinatorStore(dir);
  const ownerA = sessions.register({ id: "process-owner-a", projectKey: "p", workspaceRoot: dir, state: "running" });
  const ownerB = sessions.register({ id: "process-owner-b", projectKey: "p", workspaceRoot: dir, state: "running" });
  store.createPlan("p", [{ id: "task", name: "task", description: "race", priority: 0, dependencies: [] }], now);
  store.close(); sessions.close();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const child = join(import.meta.dirname, "test-support", "coordinator-claim-child.ts");
  const invoke = (sessionId: string) => exec(process.execPath, ["--import", "tsx", child, dir, "task", sessionId, now],
    { timeout: 20_000, windowsHide: true, maxBuffer: 256 * 1024 })
    .then(result => ({ exitCode: 0, stdout: result.stdout }), error => ({
      exitCode: typeof error?.code === "number" ? error.code : -1,
      stdout: String(error?.stdout ?? ""),
    }));
  const [a, b] = await Promise.all([invoke(ownerA.id), invoke(ownerB.id)]);
  const receipts = [a, b].map(result => ({ ...result,
    receipt: JSON.parse(result.stdout.trim()) as { ok: boolean; attemptId?: string } }));
  assert.equal(receipts.filter(result => result.receipt.ok).length, 1);
  assert.equal(receipts.filter(result => !result.receipt.ok).length, 1);

  const reopenedSessions = new OrchestrationRegistry(new OrchestrationStore(dir));
  const reopenedStore = new CoordinatorStore(dir);
  try {
    const task = reopenedStore.getTask("task")!;
    assert.equal(task.state, "claimed");
    assert.equal(task.leaseGeneration, 1);
    assert.ok(task.attemptId);
    assert.ok(task.ownerWorkerIncarnationId);
    assert.equal([ownerA.id, ownerB.id].includes(task.ownerSessionId!), true);
    assert.equal(receipts.some(result => result.receipt.attemptId === task.attemptId), true);
  } finally { reopenedStore.close(); reopenedSessions.close(); }
});
