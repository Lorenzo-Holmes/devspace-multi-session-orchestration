import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { openDatabase } from "./db/client.js";
import { OrchestrationStore } from "./orchestration-store.js";
import { OrchestrationRegistry } from "./orchestration-registry.js";
import { recordObservedToolResult } from "./orchestration-telemetry.js";

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "devspace-session-cas-"));
  const first = new OrchestrationStore(dir);
  const second = new OrchestrationStore(dir);
  const registry = new OrchestrationRegistry(first);
  const db = openDatabase(dir);
  t.after(async () => { db.close(); second.close(); registry.close(); await rm(dir, { recursive: true, force: true }); });
  const session = registry.register({ projectKey: "p", workspaceRoot: dir, state: "running" });
  return { dir, first, second, registry, db, session };
}

test("session CAS rejects a stale second connection and terminal revival", async (t) => {
  const f = await fixture(t);
  const stale = f.second.getSession(f.session.id)!;
  f.registry.setState(f.session.id, "completed");
  assert.throws(() => f.second.updateSession(f.session.id, { state: "running" }, undefined, stale.revision), /revision conflict/);
  assert.throws(() => f.second.updateSession(f.session.id, { state: "running" }), /cannot revive/);
  assert.equal(f.registry.get(f.session.id).state, "completed");
});

test("required state-change event failure rolls back its state update", async (t) => {
  const f = await fixture(t);
  f.db.sqlite.exec(`create trigger reject_test_state_event before insert on orchestration_events
    when new.kind = 'state_change' begin select raise(abort, 'injected event failure'); end`);
  const before = f.registry.get(f.session.id);
  assert.throws(() => f.registry.setState(f.session.id, "completed"), /injected event failure/);
  assert.deepEqual(f.registry.get(f.session.id), before);
});

test("late heartbeat cannot move durable activity backwards", async (t) => {
  const f = await fixture(t);
  f.registry.heartbeat(f.session.id, { now: "2030-01-01T00:02:00.000Z" });
  const after = f.registry.heartbeat(f.session.id, { now: "2030-01-01T00:01:00.000Z" });
  assert.equal(after.lastHeartbeatAt, "2030-01-01T00:02:00.000Z");
  assert.equal(after.lastActivityAt, "2030-01-01T00:02:00.000Z");
});

test("file intents normalize and deduplicate before their capacity check", async (t) => {
  const f = await fixture(t);
  const intents = Array.from({ length: 200 }, (_, i) => ({ path: `src/file-${i}.ts`, access: "write" as const }));
  f.registry.setFileIntents(f.session.id, intents);
  assert.equal(f.registry.addFileIntents(f.session.id, [{ path: "./src/./file-0.ts", access: "write" }]).length, 200);
  assert.throws(() => f.registry.addFileIntents(f.session.id, [{ path: "new.ts", access: "write" }]), /At most 200/);
  for (const path of ["src/../../escape", "C:\\outside", "C:relative-drive", "bad\0name"]) {
    assert.throws(() => f.registry.setFileIntents(f.session.id, [{ path, access: "write" }]), /workspace-relative/);
  }
});

test("real mutation survives full intents and retains move/partial-write receipts", async (t) => {
  const f = await fixture(t);
  f.registry.setFileIntents(f.session.id, Array.from({ length: 200 }, (_, i) => ({ path: `existing-${i}`, access: "write" as const })));
  recordObservedToolResult(f.registry, f.session.id, "apply_patch", { patch: "ignored argument path" }, {
    isError: true,
    structuredContent: { files: [{ path: join(f.dir, "new.ts"), previousPath: "old.ts", operation: "move" }] },
  });
  const events = f.registry.events(f.session.id, 20);
  const mutation = events.find(event => event.kind === "file_change")!;
  assert.ok(mutation);
  assert.deepEqual(mutation.detail.paths, ["new.ts", "old.ts"]);
  assert.equal(mutation.detail.partial, true);
  assert.ok(events.some(event => event.kind === "file_intents_projection_failed"));
  assert.equal(f.registry.get(f.session.id).fileGeneration, 1);
  assert.equal(f.registry.fileIntents(f.session.id).length, 200);
});

test("migration restart is idempotent and durable revisions survive reopen", async (t) => {
  const f = await fixture(t);
  f.registry.heartbeat(f.session.id);
  const reopened = new OrchestrationStore(f.dir);
  try { assert.equal(reopened.getSession(f.session.id)?.revision, f.registry.get(f.session.id).revision); }
  finally { reopened.close(); }
  const rows = f.db.sqlite.prepare("select count(*) as count from devspace_schema_migrations where version = 19").get() as { count: number };
  assert.equal(rows.count, 1);
});
