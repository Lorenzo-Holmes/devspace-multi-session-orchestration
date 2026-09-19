import assert from "node:assert/strict";
import test from "node:test";
import { v2Fixture } from "./test-support/orchestration-v2.js";
import { OrchestrationV2 } from "./orchestration-v2.js";

test("watchdog detects event-driven blocked/retry/change/conflict signals and deduplicates durable ack", async t => {
  const f = await v2Fixture(t);
  f.sessions.setState(f.session.id, "blocked_tool");
  assert.ok(f.v2.watchdog.list(f.projectKey).some(a => a.signal === "blocked_tool"));
  f.sessions.recordEvent({ sessionId: f.session.id, kind: "file_change" });
  for (let i = 0; i < 3; i++) f.sessions.recordEvent({ sessionId: f.session.id, kind: "error", detail: { fingerprint: "same" } });
  const peer = f.sessions.register({ projectKey: f.projectKey, workspaceRoot: f.project, state: "running" });
  f.sessions.setFileIntents(f.session.id, [{ path: "same.txt", access: "write" }]);
  f.sessions.setFileIntents(peer.id, [{ path: "same.txt", access: "write" }]);
  const scan = f.v2.watchdog.scan(f.projectKey);
  for (const signal of ["blocked_tool", "retry_loop", "unverified_changes", "conflict"]) assert.ok(scan.alerts.some(a => a.signal === signal && a.state === "open"), signal);
  assert.deepEqual(f.v2.watchdog.scan(f.projectKey).alerts, scan.alerts);
  const alert = scan.alerts.find(a => a.signal === "blocked_tool")!;
  const ack = f.v2.watchdog.acknowledge(f.projectKey, alert.id, alert.revision);
  assert.deepEqual(f.v2.watchdog.acknowledge(f.projectKey, alert.id, alert.revision), ack);
  assert.throws(() => f.v2.watchdog.acknowledge("other", alert.id, alert.revision), /project scope/);
  const restart = new OrchestrationV2(f.config, f.sessions, f.coordinator, f.workspaces, f.access);
  try { assert.deepEqual(restart.watchdog.list(f.projectKey), f.v2.watchdog.list(f.projectKey)); } finally { restart.close(); }
  f.sessions.setState(f.session.id, "running");
  assert.equal(f.v2.watchdog.list(f.projectKey).find(a => a.id === alert.id)?.state, "resolved");
  f.sessions.setState(f.session.id, "blocked_tool");
  assert.equal(f.v2.watchdog.list(f.projectKey).find(a => a.id === alert.id)?.state, "open");
});

test("watchdog derives idle/stalled/lease signals without recovery or heartbeat writes", async t => {
  const f = await v2Fixture(t), original = f.sessions.get(f.session.id);
  const expiry = Date.parse(f.claimed.leaseExpiresAt!);
  assert.ok(f.v2.watchdog.scan(f.projectKey, new Date(expiry - 1000)).alerts.some(a => a.signal === "lease_expiring"));
  const later = f.v2.watchdog.scan(f.projectKey, new Date(expiry + 35 * 60000));
  assert.ok(later.alerts.some(a => a.signal === "lease_expired" && a.state === "open"));
  assert.ok(later.alerts.some(a => a.signal === "stalled" && a.state === "open"));
  assert.deepEqual(f.sessions.get(f.session.id), original);
  assert.deepEqual(f.coordinator.get(f.task.id), f.claimed);
  assert.deepEqual(f.v2.watchdog.scan("other").alerts, []);
});
