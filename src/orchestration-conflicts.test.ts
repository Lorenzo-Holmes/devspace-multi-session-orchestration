import assert from "node:assert/strict";
import test from "node:test";
import { detectOrchestrationConflicts } from "./orchestration-conflicts.js";
import type { OrchestrationFileIntent, OrchestrationSession } from "./orchestration-store.js";

function session(id: string, root: string, projectKey = "project"): OrchestrationSession {
  return {
    id, projectKey, workspaceRoot: root, sessionKind: "chat", state: "running",
    lastActivityAt: "2026-09-19T00:00:00.000Z", consecutiveErrorCount: 0,
    createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z",
  };
}

function intent(sessionId: string, path: string, access: "read" | "write"): OrchestrationFileIntent {
  return { sessionId, path, access, createdAt: "2026-09-19T00:00:00.000Z" };
}

test("conflicts detect exact and parent-child write overlaps deterministically", () => {
  const sessions = [session("b", "C:/project"), session("a", "C:/project")];
  const conflicts = detectOrchestrationConflicts(sessions, [
    intent("a", "src/core", "write"),
    intent("b", "src/core/index.ts", "write"),
    intent("b", "README.md", "read"),
  ]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.sessionA, "a");
  assert.equal(conflicts[0]?.sessionB, "b");
  assert.equal(conflicts[0]?.severity, "high");
  assert.equal(conflicts[0]?.reason, "path_scope_overlap");
});

test("read-read, terminal sessions, different projects and isolated roots do not conflict", () => {
  const sessions = [
    session("a", "C:/project", "p"),
    session("b", "C:/project", "p"),
    session("c", "C:/worktree-c", "p"),
    { ...session("d", "C:/project", "p"), state: "completed" as const },
    session("e", "C:/project", "other"),
  ];
  const intents = sessions.flatMap((item) => [intent(item.id, "src/server.ts", "read")]);
  intents.push(intent("c", "src/server.ts", "write"));
  intents.push(intent("d", "src/server.ts", "write"));
  intents.push(intent("e", "src/server.ts", "write"));
  assert.deepEqual(detectOrchestrationConflicts(sessions, intents), []);
});

test("read-write exact overlap is medium severity", () => {
  const sessions = [session("a", "C:/project"), session("b", "C:/project")];
  const conflicts = detectOrchestrationConflicts(sessions, [
    intent("a", "src/server.ts", "read"),
    intent("b", "src/server.ts", "write"),
  ]);
  assert.equal(conflicts[0]?.severity, "medium");
  assert.equal(conflicts[0]?.reason, "exact_path");
});
