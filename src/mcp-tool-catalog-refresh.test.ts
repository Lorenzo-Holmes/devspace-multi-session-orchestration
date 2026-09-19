import assert from "node:assert/strict";
import test from "node:test";
import { McpToolCatalogRefreshTracker } from "./mcp-tool-catalog-refresh.js";

test("tool catalog refresh sends once per MCP session", async () => {
  const tracker = new McpToolCatalogRefreshTracker();
  let calls = 0;
  const sender = { sendToolListChanged: async () => { calls += 1; } };

  assert.equal(await tracker.notifyOnce("session-a", sender), "sent");
  assert.equal(await tracker.notifyOnce("session-a", sender), "already_sent");
  assert.equal(calls, 1);

  assert.equal(await tracker.notifyOnce("session-b", sender), "sent");
  assert.equal(calls, 2);
});

test("failed catalog refresh can retry and removal starts a fresh lifecycle", async () => {
  const tracker = new McpToolCatalogRefreshTracker();
  let calls = 0;
  const sender = {
    sendToolListChanged: async () => {
      calls += 1;
      if (calls === 1) throw new Error("simulated stream failure");
    },
  };

  await assert.rejects(() => tracker.notifyOnce("session-a", sender), /simulated stream failure/);
  assert.equal(await tracker.notifyOnce("session-a", sender), "sent");
  assert.equal(calls, 2);

  tracker.remove("session-a");
  assert.equal(await tracker.notifyOnce("session-a", sender), "sent");
  assert.equal(calls, 3);
});
