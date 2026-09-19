import assert from "node:assert/strict";
import test from "node:test";
import { v2Fixture } from "./test-support/orchestration-v2.js";
import { buildSupervisorSummary, supervisorSummary, supervisorSummarySchema } from "./orchestration-supervisor.js";
import { renderSupervisor } from "./supervisor-view.js";

test("supervisor summary is schema-valid, read-only, scoped and renders escaped expandable timelines", async t => {
  const f = await v2Fixture(t);
  f.sessions.recordEvent({ sessionId: f.session.id, kind: "file_change", detail: { path: "<script>alert(1)</script>" } });
  const before = JSON.stringify({ sessions: f.sessions.list(), events: f.sessions.events(f.session.id), tasks: f.coordinator.list(f.projectKey), alerts: f.v2.watchdog.list(f.projectKey) });
  const now = new Date(), a = supervisorSummary(f.v2, f.projectKey, now), b = supervisorSummary(f.v2, f.projectKey, now);
  assert.deepEqual(a, b);
  assert.deepEqual(supervisorSummarySchema.parse(a), a);
  assert.equal(a.sections.length, 11);
  const html = renderSupervisor(a);
  assert.match(html, /<details>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|<button|onclick/);
  assert.equal(before, JSON.stringify({ sessions: f.sessions.list(), events: f.sessions.events(f.session.id), tasks: f.coordinator.list(f.projectKey), alerts: f.v2.watchdog.list(f.projectKey) }));
  assert.equal(supervisorSummary(f.v2, "other").counts.active, 0);
});

test("supervisor applies row, timeline, field and global byte bounds", () => {
  const now = new Date().toISOString();
  const sessions = Array.from({ length: 501 }, (_, i) => ({ id: String(i), projectKey: "p", workspaceRoot: "p", sessionKind: "test", label: "中".repeat(5000), state: "running" as const, consecutiveErrorCount: 0, lastActivityAt: now, createdAt: now, updatedAt: now }));
  const events = Object.fromEntries(sessions.map(s => [s.id, Array.from({ length: 50 }, (_, i) => ({ id: i, sessionId: s.id, kind: "event", detail: { text: "中".repeat(5000) }, createdAt: now }))]));
  const summary = buildSupervisorSummary({ project: "p", sessions, events, tasks: [], readyTaskIds: [], bindings: [], conflicts: [], handoffs: [], integrations: [], alerts: [] });
  assert.equal(summary.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) <= 128 * 1024);
  assert.ok(summary.sections.every(s => s.items.length <= 50 && s.items.every(i => i.timeline.length <= 10)));
  assert.throws(() => renderSupervisor({ schemaVersion: 9 }));
});
