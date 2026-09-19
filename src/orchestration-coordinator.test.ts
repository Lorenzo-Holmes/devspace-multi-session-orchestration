import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CoordinatorStore } from "./coordinator-store.js";
import { OrchestrationCoordinator } from "./orchestration-coordinator.js";
import { OrchestrationRegistry } from "./orchestration-registry.js";
import { OrchestrationStore } from "./orchestration-store.js";

test("coordinator persists DAG readiness and fenced leases across restart", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-coordinator-"));
  t.after(async () => rm(stateDir, { recursive: true, force: true }));
  const sessions = new OrchestrationRegistry(new OrchestrationStore(stateDir));
  const session = sessions.register({
    id: "sess_coord",
    projectKey: "project",
    workspaceRoot: join(stateDir, "project"),
    state: "running",
  });
  const first = new OrchestrationCoordinator(new CoordinatorStore(stateDir), sessions);
  const plan = first.createPlan("project", [
    { name: "A", description: "First task" },
    { name: "B", description: "Second task", dependencies: ["A"] },
  ], "2026-09-19T00:00:00.000Z");
  const taskA = plan.find((task) => task.name === "A")!;
  const taskB = plan.find((task) => task.name === "B")!;
  assert.deepEqual(first.readyQueue("project", new Date("2026-09-19T00:00:01.000Z")).map((task) => task.name), ["A"]);
  const claimed = first.claim({
    taskId: taskA.id,
    sessionId: session.id,
    expectedRevision: taskA.revision,
    now: new Date("2026-09-19T00:01:00.000Z"),
  });
  assert.equal(claimed.state, "claimed");
  assert.ok(claimed.leaseToken);
  assert.throws(() => first.claim({
    taskId: taskA.id,
    sessionId: session.id,
    expectedRevision: claimed.revision,
    now: new Date("2026-09-19T00:02:00.000Z"),
  }), /active lease/);
  const completed = first.complete({
    taskId: taskA.id,
    sessionId: session.id,
    leaseToken: claimed.leaseToken!,
    expectedRevision: claimed.revision,
    now: new Date("2026-09-19T00:03:00.000Z"),
  });
  assert.equal(completed.state, "completed");
  first.close();

  const second = new OrchestrationCoordinator(new CoordinatorStore(stateDir), sessions);
  assert.deepEqual(second.readyQueue("project", new Date("2026-09-19T00:04:00.000Z")).map((task) => task.name), ["B"]);
  const restoredB = second.get(taskB.id);
  assert.equal(restoredB.revision, 1);
  assert.throws(() => second.claim({
    taskId: restoredB.id,
    sessionId: session.id,
    expectedRevision: 99,
    now: new Date("2026-09-19T00:05:00.000Z"),
  }), /revision conflict/);
  second.close();
  sessions.close();
});

test("coordinator rejects unknown dependencies and cycles", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-coordinator-dag-"));
  t.after(async () => rm(stateDir, { recursive: true, force: true }));
  const sessions = new OrchestrationRegistry(new OrchestrationStore(stateDir));
  const coordinator = new OrchestrationCoordinator(new CoordinatorStore(stateDir), sessions);
  assert.throws(() => coordinator.createPlan("p", [
    { name: "A", description: "A", dependencies: ["missing"] },
  ]), /Unknown coordinator dependency/);
  assert.throws(() => coordinator.createPlan("p", [
    { name: "A", description: "A", dependencies: ["B"] },
    { name: "B", description: "B", dependencies: ["A"] },
  ]), /contains a cycle/);
  coordinator.close();
  sessions.close();
});
