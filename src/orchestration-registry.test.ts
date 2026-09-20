import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OrchestrationRegistry } from "./orchestration-registry.js";
import { OrchestrationStore } from "./orchestration-store.js";

test("registry enforces explicit transitions and terminal sessions cannot revive", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-orchestration-registry-"));
  t.after(async () => rm(stateDir, { recursive: true, force: true }));
  const registry = new OrchestrationRegistry(new OrchestrationStore(stateDir));
  const session = registry.register({
    id: "sess_registry",
    projectKey: " project-a ",
    workspaceRoot: join(stateDir, "project"),
    label: " Worker A ",
    task: " Implement registry ",
    now: "2026-09-19T01:00:00.000Z",
  });
  assert.equal(session.projectKey, "project-a");
  assert.equal(session.label, "Worker A");
  assert.equal(session.state, "queued");
  assert.equal(registry.setState(session.id, "running", { now: "2026-09-19T01:01:00.000Z" }).state, "running");
  assert.equal(registry.setState(session.id, "waiting_test", { now: "2026-09-19T01:02:00.000Z" }).state, "waiting_test");
  assert.equal(registry.setState(session.id, "ready_review", { now: "2026-09-19T01:03:00.000Z" }).state, "ready_review");
  assert.equal(registry.setState(session.id, "completed", { now: "2026-09-19T01:04:00.000Z" }).state, "completed");
  assert.throws(() => registry.setState(session.id, "running"), /Invalid orchestration session transition/);
  assert.equal(registry.setState(session.id, "completed").state, "completed");
  assert.equal(registry.list({ projectKey: "project-a" }).length, 1);
  registry.close();
});

test("heartbeat and events update durable activity signals without changing session state", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-orchestration-heartbeat-"));
  t.after(async () => rm(stateDir, { recursive: true, force: true }));
  const registry = new OrchestrationRegistry(new OrchestrationStore(stateDir));
  const session = registry.register({
    id: "sess_heartbeat",
    projectKey: "project-b",
    workspaceRoot: join(stateDir, "project"),
    state: "running",
    now: "2026-09-19T02:00:00.000Z",
  });
  const heartbeat = registry.heartbeat(session.id, {
    now: "2026-09-19T02:01:00.000Z",
    detail: { source: "tool" },
  });
  assert.equal(heartbeat.state, "running");
  assert.equal(heartbeat.lastHeartbeatAt, "2026-09-19T02:01:00.000Z");
  const changed = registry.recordEvent({
    sessionId: session.id,
    kind: "file_change",
    now: "2026-09-19T02:02:00.000Z",
    detail: { path: "src/a.ts" },
  }).session;
  assert.equal(changed.lastFileChangeAt, "2026-09-19T02:02:00.000Z");
  registry.recordEvent({
    sessionId: session.id,
    kind: "error",
    now: "2026-09-19T02:03:00.000Z",
    detail: { fingerprint: "E_TEST" },
  });
  const repeated = registry.recordEvent({
    sessionId: session.id,
    kind: "error",
    now: "2026-09-19T02:04:00.000Z",
    detail: { fingerprint: "E_TEST" },
  }).session;
  assert.equal(repeated.consecutiveErrorCount, 2);
  const tested = registry.recordEvent({
    sessionId: session.id,
    kind: "test_run",
    now: "2026-09-19T02:05:00.000Z",
    detail: { passed: true },
  }).session;
  assert.equal(tested.lastTestAttemptAt, "2026-09-19T02:05:00.000Z");
  assert.equal(tested.lastTestAt, undefined, "caller-declared test success is not trusted validation");
  assert.equal(tested.consecutiveErrorCount, 2, "untrusted test events cannot clear durable failures");
  assert.equal(registry.events(session.id, 10).length, 5);
  registry.close();
});

test("external registration is idempotent and file intents reject path escape", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-orchestration-identity-"));
  t.after(async () => rm(stateDir, { recursive: true, force: true }));
  const registry = new OrchestrationRegistry(new OrchestrationStore(stateDir));
  const first = registry.register({
    projectKey: "project", workspaceRoot: join(stateDir, "project"),
    sessionKind: "chatgpt", externalSessionId: "conversation-1",
  });
  const second = registry.register({
    projectKey: "project", workspaceRoot: join(stateDir, "project"),
    sessionKind: "chatgpt", externalSessionId: "conversation-1",
  });
  assert.equal(second.id, first.id);
  assert.throws(
    () => registry.setFileIntents(first.id, [{ path: "../outside.ts", access: "write" }]),
    /workspace-relative paths/,
  );
  registry.close();
});
