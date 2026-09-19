import assert from "node:assert/strict";
import test from "node:test";
import { v2Fixture } from "./test-support/orchestration-v2.js";
import { OrchestrationV2 } from "./orchestration-v2.js";

test("project memory is explicit, bounded, project scoped and CAS safe across independent connections", async t => {
  const f = await v2Fixture(t);
  assert.equal(f.v2.memory.get(f.projectKey).revision, 0);
  assert.deepEqual(f.v2.store.list("project_memory", f.projectKey), []);
  const first = f.v2.memory.update(f.projectKey, 0, { objective: "Ship V2", frozenDecisions: ["No worker spawn"] });
  assert.equal(first.revision, 1);
  const second = new OrchestrationV2(f.config, f.sessions, f.coordinator, f.workspaces, f.access);
  try {
    assert.deepEqual(second.memory.get(f.projectKey), first);
    const next = second.memory.update(f.projectKey, 1, { completedMilestones: ["Cycle 08"] });
    assert.equal(next.objective, "Ship V2");
    assert.throws(() => f.v2.memory.update(f.projectKey, 1, { objective: "stale" }), /revision conflict/);
    assert.throws(() => f.v2.memory.update(f.projectKey, 0, { objective: "replace" }), /revision conflict/);
    assert.equal(f.v2.memory.get("other").revision, 0);
    assert.throws(() => f.v2.memory.update(f.projectKey, 2, { objective: "x".repeat(8001) }));
    assert.throws(() => f.v2.memory.update(f.projectKey, 2, { knownFailures: Array(101).fill("x") }));
    assert.throws(() => f.v2.memory.update(f.projectKey, 2, {}), /Explicit/);
    assert.deepEqual(f.v2.memory.get(f.projectKey), next);
  } finally { second.close(); }
});
