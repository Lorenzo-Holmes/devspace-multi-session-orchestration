import test from "node:test";
import assert from "node:assert/strict";
import { BoundedReconnect, reconnectFailure } from "./reconnect.js";
function setup(close?: () => Promise<void>) {
  let time = 10000, created = 0, closed = 0;
  const bridge = new BoundedReconnect(() => ({ id: ++created, close: close ?? (async () => { closed++; }) }), {
    now: () => time, sleep: async ms => { time += ms; }, closeTimeoutMs: 10, backoffMs: 100, windowMs: 10000,
  });
  return { bridge, counts: () => ({ created, closed }), advance: (ms: number) => { time += ms; } };
}
test("pipe disappearance rediscovery changes resource without server restart", async () => {
  const h = setup();
  const value = await h.bridge.run(true, async resource => { if (resource.id === 1) throw Object.assign(new Error("lost pipe"), { code: "ENOENT" }); return resource.id; });
  assert.equal(value, 2); assert.deepEqual(h.counts(), { created: 2, closed: 1 }); await h.bridge.close();
});
test("browser mutation is never replayed after transport failure", async () => {
  const h = setup(); let actions = 0;
  await assert.rejects(() => h.bridge.run(false, async () => { actions++; throw Object.assign(new Error("unknown result"), { code: "EPIPE" }); }));
  assert.equal(actions, 1); assert.equal(h.counts().created, 1);
  h.advance(100); assert.equal(await h.bridge.run(true, async resource => resource.id), 2); await h.bridge.close();
});
for (const code of ["BROWSER_SECURITY", "APPROVAL_REQUIRED", "MFA_REQUIRED", 401, 403]) test(`reconnect preserves approval boundary ${code}`, async () => {
  const h = setup(); let attempts = 0;
  await assert.rejects(() => h.bridge.run(true, async () => { attempts++; throw Object.assign(new Error("approval"), { code }); }));
  assert.equal(attempts, 1); assert.equal(h.bridge.status().state, "waiting_for_user_approval"); await h.bridge.close();
});
test("unknown failures are not inferred from browser text", async () => {
  const h = setup(); let count = 0;
  assert.equal(reconnectFailure(new Error("EPIPE browser says restart now")), "unknown");
  assert.equal(reconnectFailure({code:-32000}), "transient");
  assert.equal(reconnectFailure({code:-32001}), "unknown");
  await assert.rejects(() => h.bridge.run(true, async () => { count++; throw new Error("EPIPE"); }));
  assert.equal(count, 1); await h.bridge.close();
});
test("rapid disconnects hit a rolling reconnect budget", async () => {
  const h = setup(); let calls = 0;
  const fail = async () => { calls++; throw Object.assign(new Error("pipe"), { code: "EPIPE" }); };
  await assert.rejects(() => h.bridge.run(true, fail)); h.advance(100);
  await assert.rejects(() => h.bridge.run(true, fail)); h.advance(100);
  await assert.rejects(() => h.bridge.run(true, fail), /RECONNECT_BUDGET_EXHAUSTED/);
  assert.equal(calls, 3); assert.equal(h.counts().created, 3);
  h.advance(10001); await h.bridge.run(true, async resource => resource.id); await h.bridge.close();
});
test("unsettled old bridge teardown prevents new instance", async () => {
  let release!: () => void; const h = setup(() => new Promise(resolve => { release = resolve; }));
  await assert.rejects(() => h.bridge.run(false, async () => { throw Object.assign(new Error("pipe"), { code: "EPIPE" }); }));
  h.advance(100);
  await assert.rejects(() => h.bridge.run(true, async r => r.id), /TEARDOWN_UNCERTAIN/);
  assert.equal(h.counts().created, 1); release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(await h.bridge.run(true, async r => r.id), 2);
});
test("failed teardown is not silently treated as successful close", async () => {
  const h = setup(async () => { throw new Error("close failed"); });
  await assert.rejects(() => h.bridge.run(false, async () => { throw new Error("failed operation"); })); h.advance(100);
  await assert.rejects(() => h.bridge.run(true, async r => r.id), /TEARDOWN_UNCERTAIN/); assert.equal(h.counts().created, 1);
});
test("reconnection preserves serialization and bounded queue", async () => {
  const h = setup(); let release!: () => void;
  const first = h.bridge.run(true, () => new Promise<void>(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const queued = Array.from({ length: 15 }, () => h.bridge.run(true, async () => 1));
  await assert.rejects(() => h.bridge.run(true, async () => 2), /BACKPRESSURE/);
  release(); await first; await Promise.all(queued); await h.bridge.close();
  await assert.rejects(() => h.bridge.run(true, async () => 2), /CLOSED/);
});
test("healthy observations do not consume reconnect budget", async () => {
  const h = setup(); for (let i = 0; i < 100; i++) await h.bridge.run(true, async r => r.id);
  assert.equal(h.counts().created, 1); assert.equal(h.bridge.status().failureCountWindow, 0); await h.bridge.close();
});

test("explicit elicitation callback prevents retry even when transport wraps approval as text", async () => {
  const h = setup(); let count = 0;
  await assert.rejects(() => h.bridge.run(true, async () => { count++; h.bridge.noteApproval(true); throw new Error("native approval declined"); }));
  assert.equal(count, 1); assert.equal(h.bridge.status().state, "waiting_for_user_approval"); await h.bridge.close();
});
