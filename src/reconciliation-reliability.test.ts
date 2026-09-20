import assert from "node:assert/strict";
import test from "node:test";
import { v2Fixture } from "./test-support/orchestration-v2.js";
import { AutomationHooks, type AutomationDueWork } from "./orchestration-automation.js";
import type { WatchdogAlert } from "./orchestration-watchdog.js";
import { OrchestrationV2Store, type DurableRecord, type V2Table } from "./orchestration-v2-store.js";

for (const count of [501, 1001, 5000]) {
  test(`watchdog reconciles all ${count} historical alerts while its display remains bounded`, async (t) => {
    const f = await v2Fixture(t);
    const timestamp = new Date().toISOString();
    f.v2.store.transaction(() => {
      for (let i = 0; i < count; i++) f.v2.store.insert<WatchdogAlert>("watchdog_alerts", {
        id: `history-${String(i).padStart(6, "0")}`, projectKey: f.projectKey, revision: 1,
        signal: "blocked_tool", subjectId: `gone-${i}`, message: "historical fixture",
        state: "open", episode: 1, sourceVersion: "old", createdAt: timestamp, updatedAt: timestamp,
      });
    });
    const scan = f.v2.watchdog.scan(f.projectKey);
    assert.equal(scan.inputComplete, true);
    assert.equal(scan.sourceTruncated, false);
    assert.equal(scan.reconciliationComplete, true);
    assert.equal(scan.outputTruncated, true);
    assert.equal(scan.alerts.length, 200);
    assert.equal(f.v2.store.all<WatchdogAlert>("watchdog_alerts", f.projectKey)
      .filter(alert => alert.id.startsWith("history-") && alert.state === "resolved").length, count);
  });
}

test("ready -> claimed -> ready between polls creates a new delivery and fences the old ack", async (t) => {
  const f = await v2Fixture(t);
  const automation = new AutomationHooks(f.v2);
  f.coordinator.release(f.lease);
  const first = automation.poll(f.projectKey).records.find(row => row.kind === "task_ready" && row.subjectId === f.task.id)!;
  assert.ok(first);
  automation.acknowledge(f.projectKey, first.id, first.revision, "fixture");
  const task = f.coordinator.get(f.task.id);
  const claimed = f.coordinator.claim({ taskId: task.id, sessionId: f.session.id, expectedRevision: task.revision });
  f.coordinator.release({ taskId: task.id, sessionId: f.session.id, leaseToken: claimed.leaseToken!, expectedRevision: claimed.revision });
  const next = automation.poll(f.projectKey).records.find(row => row.id === first.id)!;
  assert.ok(next);
  assert.notEqual(next.episodeId, first.episodeId);
  assert.notEqual(next.deliveryId, first.deliveryId);
  assert.throws(() => automation.acknowledge(f.projectKey, first.id, first.revision, "fixture"), /revision conflict/);
  assert.equal(automation.acknowledge(f.projectKey, next.id, next.revision, "fixture").state, "acknowledged");
});

test("an acknowledged blocked alert reopens after a complete state cycle between scans", async (t) => {
  const f = await v2Fixture(t);
  f.sessions.setState(f.session.id, "blocked_tool");
  const first = f.v2.watchdog.scan(f.projectKey).alerts.find(row => row.signal === "blocked_tool")!;
  f.v2.watchdog.acknowledge(f.projectKey, first.id, first.revision);
  f.sessions.setState(f.session.id, "running");
  f.sessions.setState(f.session.id, "blocked_tool");
  const next = f.v2.watchdog.scan(f.projectKey).alerts.find(row => row.id === first.id)!;
  assert.equal(next.state, "open");
  assert.equal(next.episode, 2);
  assert.throws(() => f.v2.watchdog.acknowledge(f.projectKey, first.id, first.revision), /revision conflict/);
});

test("due selection and latest event queries do not page through unrelated history", async (t) => {
  const f = await v2Fixture(t);
  const automation = new AutomationHooks(f.v2);
  const timestamp = new Date().toISOString();
  f.v2.store.transaction(() => {
    for (let i = 0; i < 1001; i++) f.v2.store.insert<AutomationDueWork>("automation_due_work", {
      id: `a-${String(i).padStart(6, "0")}`, projectKey: f.projectKey, revision: 1,
      kind: "task_ready", subjectId: `old-${i}`, sourceVersion: "1", summary: "fixture",
      state: "acknowledged", createdAt: timestamp, updatedAt: timestamp,
    });
    f.v2.store.insert<AutomationDueWork>("automation_due_work", {
      id: "z-current", projectKey: f.projectKey, revision: 1, kind: "task_ready", subjectId: "current",
      sourceVersion: "1", summary: "fixture", state: "due", createdAt: timestamp, updatedAt: timestamp,
    });
  });
  assert.deepEqual(automation.dueList(f.projectKey).records.map(row => row.id), ["z-current"]);
  const observation = f.sessions.recordEvent({ sessionId: f.session.id, kind: "test_run", detail: { passed: false } }).event;
  for (let i = 0; i < 501; i++) f.sessions.heartbeat(f.session.id);
  assert.equal(f.sessions.latestEvent(f.session.id, "test_run")?.id, observation.id);
});

test("V2 notifications are after-commit only and rollback discards notifications", async (t) => {
  const f = await v2Fixture(t);
  const other = new OrchestrationV2Store(f.config.stateDir);
  try {
  let notifications = 0;
  let observerSawCommittedData = false;
  f.v2.store.onChange = (table, project) => {
    notifications++;
    observerSawCommittedData = Boolean(other.get(table, project, "committed"));
  };
  const row: DurableRecord = { id: "rolled-back", projectKey: f.projectKey, revision: 1, createdAt: "now", updatedAt: "now" };
  assert.throws(() => f.v2.store.transaction(() => {
    f.v2.store.insert("project_memory", row);
    throw new Error("injected rollback");
  }), /injected rollback/);
  assert.equal(notifications, 0);
  assert.equal(f.v2.store.get("project_memory", f.projectKey, row.id), undefined);
  f.v2.store.transaction(() => f.v2.store.insert("project_memory", { ...row, id: "committed" }));
  assert.equal(notifications, 1);
  assert.equal(observerSawCommittedData, true, "observer sees committed data through another connection");
  assert.throws(() => f.v2.store.all("watchdog_alerts; drop table project_memory" as V2Table, f.projectKey), /Unknown orchestration table/);
  } finally {
    f.v2.store.onChange = undefined;
    other.close();
  }
});
