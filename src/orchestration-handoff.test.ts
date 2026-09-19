import assert from "node:assert/strict";
import test from "node:test";
import { v2Fixture } from "./test-support/orchestration-v2.js";
import { OrchestrationV2 } from "./orchestration-v2.js";

test("handoff is bounded, scoped, restart-safe and acknowledged only by receiver without liveness writes", async t => {
  const f = await v2Fixture(t);
  const receiver = f.sessions.register({ projectKey: f.projectKey, workspaceRoot: f.project });
  const beforeReceiver = f.sessions.get(receiver.id);
  const input = { fromSessionId: f.session.id, toSessionId: receiver.id, taskId: f.task.id, summary: "Implemented task", nextAction: "Review evidence" };
  const record = f.v2.handoffs.create(f.projectKey, input);
  assert.throws(() => f.v2.handoffs.acknowledge(f.projectKey, record.id, f.session.id, 1), /receiver/);
  assert.throws(() => f.v2.handoffs.acknowledge(f.projectKey, record.id, receiver.id, 99), /revision conflict/);
  assert.throws(() => f.v2.handoffs.get("other", record.id), /project scope/);
  assert.throws(() => f.v2.handoffs.create("other", input), /project scope/);
  assert.throws(() => f.v2.handoffs.create(f.projectKey, { ...input, summary: "x".repeat(8001) }));
  assert.throws(() => f.v2.handoffs.create(f.projectKey, { ...input, errors: Array(50).fill("中".repeat(1000)) }), /bound/);
  const restarted = new OrchestrationV2(f.config, f.sessions, f.coordinator, f.workspaces, f.access);
  try {
    assert.deepEqual(restarted.handoffs.get(f.projectKey, record.id), record);
    const ack = restarted.handoffs.acknowledge(f.projectKey, record.id, receiver.id, 1);
    assert.equal(ack.state, "acknowledged");
    assert.deepEqual(restarted.handoffs.acknowledge(f.projectKey, record.id, receiver.id, 1), ack);
  } finally { restarted.close(); }
  assert.deepEqual(f.sessions.get(receiver.id), beforeReceiver);
  assert.deepEqual(f.sessions.events(receiver.id), []);
});
