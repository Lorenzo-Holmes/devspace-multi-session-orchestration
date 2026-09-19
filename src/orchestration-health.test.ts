import assert from "node:assert/strict";
import test from "node:test";
import { deriveOrchestrationHealth } from "./orchestration-health.js";
import type { OrchestrationSession } from "./orchestration-store.js";

function session(patch: Partial<OrchestrationSession> = {}): OrchestrationSession {
  return {
    id: "sess_health",
    projectKey: "project",
    workspaceRoot: "C:/project",
    sessionKind: "chat",
    state: "running",
    lastActivityAt: "2026-09-19T03:50:00.000Z",
    consecutiveErrorCount: 0,
    createdAt: "2026-09-19T03:00:00.000Z",
    updatedAt: "2026-09-19T03:50:00.000Z",
    ...patch,
  };
}

test("health derives idle and stalled from persisted activity without mutation", () => {
  const now = new Date("2026-09-19T04:00:00.000Z");
  assert.equal(deriveOrchestrationHealth(session(), now).primary, "idle");
  assert.equal(
    deriveOrchestrationHealth(session({ lastActivityAt: "2026-09-19T03:20:00.000Z" }), now).primary,
    "stalled",
  );
});

test("health prioritizes terminal, retry loops and blocked states deterministically", () => {
  const now = new Date("2026-09-19T04:00:00.000Z");
  assert.equal(deriveOrchestrationHealth(session({ state: "completed" }), now).primary, "terminal");
  assert.equal(
    deriveOrchestrationHealth(session({ consecutiveErrorCount: 3 }), now).primary,
    "retry_loop",
  );
  assert.equal(
    deriveOrchestrationHealth(session({ state: "blocked_user" }), now).primary,
    "blocked",
  );
});

test("health flags file changes newer than the latest test", () => {
  const now = new Date("2026-09-19T04:00:00.000Z");
  const dirty = deriveOrchestrationHealth(session({
    lastActivityAt: "2026-09-19T03:59:00.000Z",
    lastFileChangeAt: "2026-09-19T03:58:00.000Z",
    lastTestAt: "2026-09-19T03:57:00.000Z",
  }), now);
  assert.equal(dirty.primary, "unverified_changes");
  const verified = deriveOrchestrationHealth(session({
    lastActivityAt: "2026-09-19T03:59:00.000Z",
    lastFileChangeAt: "2026-09-19T03:57:00.000Z",
    lastTestAt: "2026-09-19T03:58:00.000Z",
  }), now);
  assert.equal(verified.primary, "healthy");
});
