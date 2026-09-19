import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "./db/client.js";
import { CoordinatorStore } from "./coordinator-store.js";
import { OrchestrationCoordinator } from "./orchestration-coordinator.js";
import { OrchestrationStore } from "./orchestration-store.js";
import { OrchestrationRegistry } from "./orchestration-registry.js";

const now = "2026-09-19T01:00:00.000Z";
const future = "2026-09-19T01:10:00.000Z";

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
