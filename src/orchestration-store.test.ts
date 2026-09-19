import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OrchestrationStore } from "./orchestration-store.js";

test("orchestration store persists sessions, events and file intents across restart", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-orchestration-store-"));
  t.after(async () => rm(stateDir, { recursive: true, force: true }));
  const first = new OrchestrationStore(stateDir);
  const session = first.createSession({
    id: "sess_test",
    projectKey: "project-a",
    workspaceRoot: join(stateDir, "project"),
    workspaceId: "ws_test",
    sessionKind: "chat",
    externalSessionId: "chat-a",
    state: "running",
    task: "Implement registry",
    now: "2026-09-19T00:00:00.000Z",
  });
  first.appendEvent({
    sessionId: session.id,
    kind: "tool_call",
    detail: { tool: "read" },
    createdAt: "2026-09-19T00:01:00.000Z",
  });
  first.replaceFileIntents(session.id, [
    { path: "src/server.ts", access: "write" },
    { path: "src/server.ts", access: "write" },
    { path: "src/config.ts", access: "read" },
  ], "2026-09-19T00:02:00.000Z");
  first.close();

  const second = new OrchestrationStore(stateDir);
  assert.equal(second.getSession(session.id)?.task, "Implement registry");
  assert.deepEqual(second.listEvents(session.id, 10)[0]?.detail, { tool: "read" });
  assert.deepEqual(
    second.listFileIntents(session.id).map((intent) => [intent.path, intent.access]),
    [["src/config.ts", "read"], ["src/server.ts", "write"]],
  );
  second.close();
});
