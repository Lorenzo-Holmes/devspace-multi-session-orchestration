import test from "node:test";
import assert from "node:assert/strict";
import { Result } from "better-result";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import type { LocalAgentRuntime, LocalAgentDriver } from "./local-agent-runtime.js";

test("Goal hold survives both idle thresholds; ordinary sessions still expire", async () => {
  let now = 0, closed = 0;
  const released: string[] = [];
  const runtime: LocalAgentRuntime = {
    provider: "codex", isAlive: () => closed === 0,
    close: async () => { closed++; }, releaseSession: async id => { released.push(id); },
    run: async () => Result.ok({ provider: "codex", providerSessionId: "ordinary", finalResponse: "done", items: [] }),
  };
  const driver: LocalAgentDriver = { provider: "codex", runtimeKey: () => "test", idleTimeoutMs: 300000, createRuntime: async () => Result.ok(runtime) };
  const pool = new LocalAgentRuntimePool({ now: () => now });
  const context = { agentId: "goal", provider: "codex" as const, workspaceRoot: "/isolated" };
  try {
    const acquired = await pool.hold(driver, context);
    if (acquired.isErr()) throw acquired.error;
    const hold = acquired.value;
    await hold.bindSession("goal-thread");
    await hold.bindSession("goal-thread");
    await pool.run(driver, context, { prompt: "ordinary", workspaceRoot: "/isolated" });
    now = 600001;
    await pool.evictIdle();
    assert.equal(closed, 0);
    assert.deepEqual(released, ["ordinary"]);
    hold.release(); hold.release();
    await assert.rejects(hold.bindSession("late"));
    now += 300001;
    await pool.evictIdle();
    assert.equal(closed, 1);
    assert.deepEqual(released, ["ordinary", "goal-thread"]);
  } finally { await pool.close(); }
});

test("shutdown terminates a held runtime without waiting for a browser", async () => {
  let closed = false;
  const runtime: LocalAgentRuntime = { provider: "codex", isAlive: () => !closed, close: async () => { closed = true; }, releaseSession: async () => {}, run: async () => { throw new Error("not used"); } };
  const pool = new LocalAgentRuntimePool();
  const driver: LocalAgentDriver = { provider: "codex", runtimeKey: () => "held", createRuntime: async () => Result.ok(runtime) };
  const h = await pool.hold(driver, { agentId: "goal", provider: "codex", workspaceRoot: "/isolated" });
  await pool.close();
  assert.equal(closed, true);
  if (h.isOk()) h.value.release();
  assert.ok((await pool.hold(driver, { agentId: "goal", provider: "codex", workspaceRoot: "/isolated" })).isErr());
});
