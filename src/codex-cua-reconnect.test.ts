import test from "node:test";
import assert from "node:assert/strict";
import { CodexCuaBridge } from "./codex-cua-bridge.js";
import { CodexCuaBridge as Transport } from "./codex-cua-transport.js";
import type { CodexTurnMetadata } from "./request-meta.js";
const metadata = {} as CodexTurnMetadata;
test("production CUA facade rediscovery uses a fresh trusted transport on read failure", async () => {
  let created = 0, closed = 0, now = 1000;
  const bridge = new CodexCuaBridge(() => {
    const id = ++created;
    return { getBrowserState: async () => {
      if (id === 1) throw Object.assign(new Error("connection closed"), {code:-32000});
      return {value:{browsers:[]},images:[]};
    }, close: async () => { closed++; } } as unknown as Transport;
  }, {now:()=>now,sleep:async ms=>{now+=ms;}});
  assert.deepEqual((await bridge.getBrowserState(metadata)).value.browsers, []);
  assert.equal(created, 2); assert.equal(closed, 1); await bridge.close();
});
test("production facade never replays a browser action", async () => {
  let called = 0, closed = 0;
  const bridge = new CodexCuaBridge(() => ({ browserActAndObserve: async () => {
    called++; throw Object.assign(new Error("unknown action result"), {code:-32000});
  }, close:async()=>{closed++;} }) as unknown as Transport);
  await assert.rejects(()=>bridge.browserActAndObserve("browser","tab",{action:"reload"},metadata));
  assert.equal(called,1); assert.equal(closed,1); await bridge.close();
});
test("production facade does not retry security approval failure", async () => {
  let called=0;
  const bridge=new CodexCuaBridge(()=>({getBrowserState:async()=>{called++;throw Object.assign(new Error("approval required"),{code:"BROWSER_SECURITY"});},close:async()=>{}}) as unknown as Transport);
  await assert.rejects(()=>bridge.getBrowserState(metadata));
  assert.equal(called,1);assert.equal(bridge.runtimeRecoveryStatus().state,"waiting_for_user_approval");await bridge.close();
});

test("transport teardown errors propagate and cached browser references are cleared", async () => {
  const transport = new Transport();
  const internal = transport as unknown as { client: unknown; transport: unknown; browserInitialized: boolean };
  internal.client = { close: async () => { throw new Error("unconfirmed teardown"); } };
  internal.transport = {}; internal.browserInitialized = true;
  await assert.rejects(() => transport.close(), /unconfirmed teardown/);
  assert.equal(internal.client, undefined); assert.equal(internal.transport, undefined);
  assert.equal(internal.browserInitialized, false);
});
test("existing elicitation decline is retained as an approval boundary despite untyped error", async () => {
  let calls = 0;
  const bridge = new CodexCuaBridge(() => ({getBrowserState: async (_meta: unknown, elicit: (p: {message:string}) => Promise<unknown>) => {
    calls++; await elicit({message:"Browser approval"}); throw new Error("legacy bridge error");
  },close:async()=>{}}) as unknown as Transport);
  await assert.rejects(() => bridge.getBrowserState(metadata, async () => ({action:"decline"})));
  assert.equal(calls,1); assert.equal(bridge.runtimeRecoveryStatus().state,"waiting_for_user_approval");
  await bridge.close();
});
