import assert from "node:assert/strict";
import test from "node:test";
import { v2Fixture } from "./test-support/orchestration-v2.js";
import { OrchestrationV2 } from "./orchestration-v2.js";

test("automation poll/ack is idempotent, scoped, restart safe and does not execute coordinator work", async t => {
  const f = await v2Fixture(t);
  f.coordinator.release(f.lease);
  const before = f.coordinator.get(f.task.id), now = new Date();
  const first = f.v2.automation.poll(f.projectKey, 100, "", now);
  assert.deepEqual(f.v2.automation.poll(f.projectKey, 100, "", now), first);
  const due = first.records.find(r => r.kind === "task_ready")!;
  assert.ok(due);
  const ack = f.v2.automation.acknowledge(f.projectKey, due.id, due.revision, "scheduler");
  assert.deepEqual(f.v2.automation.acknowledge(f.projectKey, due.id, due.revision, "scheduler"), ack);
  assert.throws(() => f.v2.automation.acknowledge("other", due.id, 1, "scheduler"), /project scope/);
  assert.equal(f.v2.automation.poll(f.projectKey).records.filter(r => r.id === due.id).length, 0);
  const restart = new OrchestrationV2(f.config, f.sessions, f.coordinator, f.workspaces, f.access);
  try { assert.equal(restart.automation.poll(f.projectKey).records.filter(r => r.id === due.id).length, 0); } finally { restart.close(); }
  assert.deepEqual(f.coordinator.get(f.task.id), before);
});

test("automation emits bounded changed-test/handoff/alert notifications and fences stale acknowledgements", async t => {
  const f = await v2Fixture(t);
  f.sessions.recordEvent({ sessionId: f.session.id, kind: "test_run", detail: { passed: true } });
  f.sessions.setState(f.session.id, "blocked_user");
  f.v2.handoffs.create(f.projectKey, { fromSessionId: f.session.id, summary: "Review", nextAction: "Inspect" });
  const first = f.v2.automation.poll(f.projectKey);
  for (const kind of ["test_state_changed", "watchdog_alert", "handoff_awaiting_ack"]) assert.ok(first.records.some(r => r.kind === kind));
  const event = first.records.find(r => r.kind === "test_state_changed")!;
  f.v2.automation.acknowledge(f.projectKey, event.id, event.revision, "scheduler");
  f.sessions.recordEvent({ sessionId: f.session.id, kind: "test_run", detail: { passed: false } });
  const next = f.v2.automation.poll(f.projectKey).records.find(r => r.id === event.id)!;
  assert.ok(next.revision > event.revision);
  assert.throws(() => f.v2.automation.acknowledge(f.projectKey, next.id, event.revision, "scheduler"), /revision conflict/);
  const page = f.v2.automation.dueList(f.projectKey, 1);
  assert.ok(page.records.length <= 1);
  assert.ok(page.nextCursor);
  assert.deepEqual(f.v2.automation.dueList("other").records, []);
});
