import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CARD_PROBE_URI, CARD_READONLY_URI, CARD_READONLY_RESULT, ChatCardProbe, registerChatCardProbe } from "./chat-card-probe.js";

const payload = (p: ChatCardProbe) => p.create("owner", "one")._meta!.probe as { probeId: string; submitToken: string };

test("card diagnostic separates immediate rendering, one bounded wait, and token-protected app submission", async () => {
  const p = new ChatCardProbe(), server = new McpServer({ name: "probe-test", version: "1" });
  const client = new Client({ name: "deterministic, not hosted Chat", version: "1" }, { capabilities: {} });
  registerChatCardProbe(server, p, "<h1>Diagnostic</h1>");
  const [a, b] = InMemoryTransport.createLinkedPair(), send = b.send.bind(b);
  b.send = (msg, options) => send(msg, { ...options, authInfo: { token: "isolated-test", clientId: "test", scopes: [], extra: { devspaceOwnerRef: "owner" } } });
  await server.connect(a); await client.connect(b);
  try {
    const listed = (await client.listTools()).tools;
    assert.equal(listed.length, 6); assert.equal(server.server.getClientCapabilities()?.elicitation, undefined);
    for (const name of ["chat_card_probe_view", "diagnostic_ping"]) {
      assert.equal(listed.find(t => t.name === name)!.annotations!.readOnlyHint, true);
      for (let repeat = 0; repeat < 2; repeat++) {
        const control = await client.callTool({ name, arguments: {} });
        assert.deepEqual(control.structuredContent, CARD_READONLY_RESULT);
        assert.equal(control._meta, undefined);
        assert.deepEqual(p.snapshot(), [], "Read-only controls must not create diagnostic state");
      }
    }
    assert.equal((await client.readResource({ uri: CARD_READONLY_URI })).contents[0].mimeType, "text/html;profile=mcp-app");
    const show = listed.find(t => t.name === "chat_card_probe_show")!;
    assert.equal((show._meta!.ui as any).resourceUri, CARD_PROBE_URI);
    assert.deepEqual((show._meta!.ui as any).visibility, ["model", "app"]);
    for (const name of ["chat_card_probe_submit", "chat_card_probe_status"]) {
      const tool = listed.find(t => t.name === name)!;
      assert.deepEqual((tool._meta!.ui as any).visibility, ["app"]);
      assert.equal((tool._meta!.ui as any).resourceUri, undefined, `${name} must not render or associate a template`);
      assert.equal(tool._meta!["ui/resourceUri"], undefined);
      assert.equal(tool._meta!["openai/outputTemplate"], undefined);
    }
    const shown = await client.callTool({ name: "chat_card_probe_show", arguments: { requestKey: "one" } });
    const privateCard = shown._meta!.probe as { probeId: string; submitToken: string };
    assert.equal((shown.structuredContent as Record<string, unknown>).waitStarted, false);
    assert.ok(!JSON.stringify(shown.content).includes(privateCard.submitToken));
    assert.ok(!JSON.stringify(shown.structuredContent).includes(privateCard.submitToken));
    const html = await client.readResource({ uri: CARD_PROBE_URI });
    assert.equal(html.contents[0].mimeType, "text/html;profile=mcp-app");
    const denied = await client.callTool({ name: "chat_card_probe_submit", arguments: { ...privateCard, submitToken: "x".repeat(64), answer: "BLUE" } });
    assert.equal(denied.isError, true); assert.equal(p.snapshot()[0].answer, null);
    const waiting = client.callTool({ name: "chat_card_probe_wait", arguments: { probeId: privateCard.probeId } });
    for (let i = 0; i < 100 && !p.snapshot()[0].waitActive; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(p.snapshot()[0].waitActive, true);
    const answer = await client.callTool({ name: "chat_card_probe_submit", arguments: { ...privateCard, answer: "BLUE" } });
    assert.notEqual(answer.isError, true);
    const received = await waiting;
    const receipt = received.structuredContent as Record<string, unknown>;
    assert.equal(receipt.answer, "BLUE");
    assert.equal(receipt.waitOutcome, "answer_received");
    assert.equal(receipt.activeWaitAtSubmission, true);
    assert.equal(receipt.sameTurnContinuation, "unverified");
    assert.equal(receipt.followUpMessagesSent, 0);
  } finally { p.close(); await client.close(); await server.close(); }
});

test("card diagnostic rejects unauthenticated calls and resources, including spoofed owner metadata", async () => {
  const p = new ChatCardProbe(), server = new McpServer({ name: "untrusted", version: "1" }), client = new Client({ name: "untrusted", version: "1" });
  registerChatCardProbe(server, p, "<h1>Diagnostic</h1>");
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  try {
    const r = await client.callTool({ name: "chat_card_probe_show", arguments: { requestKey: "one" }, _meta: { devspaceOwnerRef: "owner" } });
    assert.equal(r.isError, true); assert.match(JSON.stringify(r.content), /AUTHENTICATION_REQUIRED/);
    await assert.rejects(client.readResource({ uri: CARD_PROBE_URI }), /AUTHENTICATION_REQUIRED/);
    await assert.rejects(client.readResource({ uri: CARD_READONLY_URI }), /AUTHENTICATION_REQUIRED/);
    for (const name of ["chat_card_probe_view", "diagnostic_ping"]) {
      const denied = await client.callTool({ name, arguments: {}, _meta: { devspaceOwnerRef: "owner" } });
      assert.equal(denied.isError, true);
      assert.match(JSON.stringify(denied.content), /AUTHENTICATION_REQUIRED/);
    }
    assert.deepEqual(p.snapshot(), []);
  } finally { p.close(); await client.close(); await server.close(); }
});

test("card diagnostic deduplicates creation and same answers; prevents cross-owner and changed answers", async () => {
  const p = new ChatCardProbe(), card = payload(p);
  assert.deepEqual(payload(p), card);
  assert.throws(() => p.submit("other-owner", card.probeId, card.submitToken, "BLUE"), /PROBE_NOT_FOUND/);
  await assert.rejects(p.wait("other-owner", card.probeId), /PROBE_NOT_FOUND/);
  const answer = p.submit("owner", card.probeId, card.submitToken, "GREEN");
  assert.equal(answer.activeWaitAtSubmission, false);
  assert.equal(p.submit("owner", card.probeId, card.submitToken, "GREEN").replayed, true);
  assert.throws(() => p.submit("owner", card.probeId, card.submitToken, "BLUE"), /ANSWER_ALREADY_RECORDED/);
  assert.equal(answer.receiptPhase, "before_wait");
  assert.equal((await p.wait("owner", card.probeId)).waitOutcome, "answer_already_recorded");
});

test("only one wait is allowed; timeout does not auto-repeat or invent a choice", async () => {
  const p = new ChatCardProbe({ waitMs: 20 }), card = payload(p);
  const waiting = p.wait("owner", card.probeId);
  await assert.rejects(p.wait("owner", card.probeId), /WAIT_IN_PROGRESS/);
  const timedOut = await waiting;
  assert.equal(timedOut.waitOutcome, "timeout"); assert.equal(timedOut.answer, null);
  const again = await p.wait("owner", card.probeId);
  assert.deepEqual({ ...again, serverNow: 0 }, { ...timedOut, serverNow: 0 });
  const late = p.submit("owner", card.probeId, card.submitToken, "BLUE");
  assert.equal(late.activeWaitAtSubmission, false); assert.equal(late.waitOutcome, "timeout");
  assert.equal(late.sameTurnContinuation, "unverified");
});

test("fresh IDs and historical replays cannot be confused with a fresh wait", async () => {
  const p = new ChatCardProbe({ waitMs: 5 });
  const first = p.create("owner", "one"), card = first._meta!.probe as { probeId: string; submitToken: string };
  assert.equal(first.structuredContent!.replayed, false); assert.equal(first.structuredContent!.nextAction, "wait_once");
  assert.equal(p.create("owner", "one").structuredContent!.replayed, true);
  const wait = p.wait("owner", card.probeId);
  assert.equal(p.create("owner", "one").structuredContent!.nextAction, "wait_already_active");
  await wait;
  const history = p.create("owner", "one");
  assert.equal(history.structuredContent!.nextAction, "read_history_only");
  assert.match(JSON.stringify(history.content), /HISTORICAL RESULT ONLY/);
  assert.doesNotMatch(JSON.stringify(history.content), /Next call chat_card_probe_wait/);
  assert.notEqual(p.create("owner", "new-key").structuredContent!.probeId, card.probeId); p.close();
});

test("deadline is authoritative even before its queued timer runs; browser time cannot revive wait", async () => {
  let now = 1000;
  const p = new ChatCardProbe({ now: () => now, waitMs: 45 }), card = payload(p);
  const waiting = p.wait("owner", card.probeId); now = 1045;
  const browser = { renderedAt: 10, clickedAt: 20, sentAt: 30, clickElapsedMs: 10, sendElapsedMs: 20 };
  const late = p.submit("owner", card.probeId, card.submitToken, "BLUE", browser);
  assert.equal(late.activeWaitAtSubmission, false); assert.equal(late.receiptPhase, "after_wait");
  assert.equal(late.waitOutcome, "timeout"); assert.equal(late.waitDeadlineAt, 1045);
  assert.equal(late.submittedAt, 1045); assert.equal(late.clientTimingTrust, "untrusted_browser_report");
  assert.equal((await waiting).waitOutcome, "timeout");
  assert.equal((await p.wait("owner", card.probeId)).revision, late.revision); p.close();
});

test("timeline records early, active and late separately without cross-clock latency inference", async () => {
  let now = 5000; const events: unknown[] = [];
  const p = new ChatCardProbe({ now: () => now, onEvent: (event, data) => events.push({ event, data }) }), card = payload(p);
  const synced = p.status("owner", card.probeId, card.submitToken);
  assert.equal(synced.firstCardSyncAt, 5000); assert.equal(synced.waitStarted, false);
  now = 5100; const wait = p.wait("owner", card.probeId); now = 5200;
  const r = p.submit("owner", card.probeId, card.submitToken, "GREEN", { renderedAt: 999999, clickedAt: 1, sentAt: 1, clickElapsedMs: 20, sendElapsedMs: 21 });
  assert.equal(r.receiptPhase, "during_wait"); assert.equal(r.waitStartedAt, 5100);
  assert.equal(r.waitEndedAt, 5200); assert.equal(r.submittedAt, 5200);
  assert.equal((await wait).activeWaitAtSubmission, true);
  assert.ok(!JSON.stringify(events).includes(card.submitToken)); assert.doesNotMatch(JSON.stringify(events), /"owner"|"requestKey"|networkLatency/);
  assert.equal(p.submit("owner", card.probeId, card.submitToken, "GREEN").clientTiming?.renderedAt, 999999); p.close();
});

test("app lifecycle reads are authenticated, bounded, and cannot start or extend a wait", async () => {
  let now = 1;
  const p = new ChatCardProbe({ now: () => now, ttlMs: 100 }), card = payload(p);
  assert.throws(() => p.status("other", card.probeId, card.submitToken), /PROBE_NOT_FOUND/);
  assert.throws(() => p.status("owner", card.probeId, "x".repeat(64)), /INVALID_CARD_TOKEN/);
  for (let i = 0; i < 32; i++) { now++; const r = p.status("owner", card.probeId, card.submitToken); assert.equal(r.expiresAt, 101); assert.equal(r.waitStarted, false); }
  assert.throws(() => p.status("owner", card.probeId, card.submitToken), /STATUS_READ_LIMIT/);
  assert.equal(p.snapshot()[0].answer, null); p.close();
});

test("malformed browser telemetry and logging failure do not grant choices or control wait", () => {
  const p = new ChatCardProbe({ onEvent: () => { throw new Error("logger failed"); } }), card = payload(p);
  assert.throws(() => p.submit("owner", card.probeId, card.submitToken, "BLUE", { renderedAt: 1, clickedAt: 2, sentAt: 3, clickElapsedMs: 20, sendElapsedMs: 10 }));
  assert.equal(p.snapshot()[0].answer, null);
  assert.equal(p.submit("owner", card.probeId, card.submitToken, "BLUE").receiptPhase, "before_wait"); p.close();
});

test("abort, service close and cancellation release waits without granting any permission", async () => {
  for (const mode of ["abort", "close", "cancel"]) {
    const p = new ChatCardProbe(), card = payload(p), abort = new AbortController();
    const waiting = p.wait("owner", card.probeId, abort.signal);
    if (mode === "abort") abort.abort(); else if (mode === "close") p.close(); else p.submit("owner", card.probeId, card.submitToken, "CANCEL");
    const r = await waiting;
    assert.equal(r.waitActive, false); assert.equal(r.goalCreated, false);
    assert.equal(r.waitOutcome, mode === "abort" ? "transport_aborted" : mode === "close" ? "service_closed" : "answer_received");
    assert.equal(r.answer, mode === "cancel" ? "CANCEL" : null);
  }
});

test("expired cards and receipts lost by isolated service restart cannot answer a new probe", async () => {
  let now = 100;
  const p = new ChatCardProbe({ now: () => now, ttlMs: 100 }), card = payload(p); now += 101;
  assert.throws(() => p.submit("owner", card.probeId, card.submitToken, "BLUE"), /PROBE_EXPIRED/);
  assert.equal((await p.wait("owner", card.probeId)).state, "expired");
  assert.equal(p.create("owner", "one").structuredContent!.state, "expired");
  const restarted = new ChatCardProbe();
  assert.throws(() => restarted.submit("owner", card.probeId, card.submitToken, "BLUE"), /PROBE_NOT_FOUND/);
});

test("diagnostics have explicit capacity and wait bounds", () => {
  const p = new ChatCardProbe();
  for (let i = 0; i < 32; i++) p.create("owner", String(i));
  assert.throws(() => p.create("owner", "overflow"), /PROBE_LIMIT/);
  assert.throws(() => new ChatCardProbe({ waitMs: 50_001 }), /INVALID_WAIT_LIMIT/);
});

test("diagnostic implementation cannot invoke models or generic work", async () => {
  const source = await readFile(new URL("chat-card-probe.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+["'][^"']*(?:child_process|chat-goal-controller|codex|openai|local-agent|fs)[^"']*["']/);
  assert.doesNotMatch(source, /sendFollowUpMessage|sampling\/createMessage|create_thread/);
});

test("closed diagnostics reject creation and late submissions without restarting waits", async () => {
  const p = new ChatCardProbe(), card = payload(p); p.close(); p.close();
  assert.throws(() => p.create("owner", "new"), /PROBE_SERVICE_CLOSED/);
  assert.throws(() => p.submit("owner", card.probeId, card.submitToken, "BLUE"), /PROBE_SERVICE_CLOSED/);
  await assert.rejects(p.wait("owner", card.probeId), /PROBE_SERVICE_CLOSED/);
  assert.equal(p.snapshot()[0].answer, null);
});
