import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { detectOrchestrationConflicts } from "./orchestration-conflicts.js";
import { deriveOrchestrationHealth } from "./orchestration-health.js";
import { OrchestrationRegistry } from "./orchestration-registry.js";
import { OrchestrationStore } from "./orchestration-store.js";

test("registry restart recovers heartbeat, events, intents, conflicts and stale health", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-orchestration-recovery-"));
  t.after(async () => rm(stateDir, { recursive: true, force: true }));
  const root = join(stateDir, "project");
  const first = new OrchestrationRegistry(new OrchestrationStore(stateDir));
  const a = first.register({
    id: "sess_a", projectKey: "project", workspaceRoot: root, state: "running",
    now: "2026-09-19T00:00:00.000Z",
  });
  const b = first.register({
    id: "sess_b", projectKey: "project", workspaceRoot: root, state: "running",
    now: "2026-09-19T00:00:00.000Z",
  });
  first.heartbeat(a.id, { now: "2026-09-19T00:01:00.000Z" });
  first.recordEvent({
    sessionId: a.id, kind: "file_change", now: "2026-09-19T00:02:00.000Z",
    detail: { path: "src/core/index.ts" },
  });
  first.setFileIntents(a.id, [{ path: "src/core", access: "write" }], "2026-09-19T00:02:00.000Z");
  first.setFileIntents(b.id, [{ path: "src/core/index.ts", access: "read" }], "2026-09-19T00:02:00.000Z");
  first.close();

  const second = new OrchestrationRegistry(new OrchestrationStore(stateDir));
  const restoredA = second.get(a.id);
  assert.equal(restoredA.lastHeartbeatAt, "2026-09-19T00:01:00.000Z");
  assert.equal(restoredA.lastFileChangeAt, "2026-09-19T00:02:00.000Z");
  assert.match(JSON.stringify(second.events(a.id, 20)), /heartbeat/);
  assert.equal(second.fileIntents(a.id)[0]?.path, "src/core");
  const sessions = second.list({ projectKey: "project" });
  const intents = sessions.flatMap((session) => second.fileIntents(session.id));
  const conflicts = detectOrchestrationConflicts(sessions, intents);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.severity, "medium");
  const health = deriveOrchestrationHealth(
    restoredA,
    new Date("2026-09-19T01:00:00.000Z"),
    { idleMs: 10 * 60_000, stalledMs: 30 * 60_000 },
  );
  assert.equal(health.primary, "stalled");
  assert.ok(health.signals.includes("unverified_changes"));
  second.close();
});
