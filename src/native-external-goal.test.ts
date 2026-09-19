import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { NativeExternalGoalClient, type ExternalGoalTransport } from "./native-external-goal-client.js";
import { ExternalGoalIntentJournal } from "./native-external-goal-journal.js";
import { EXTERNAL_GOAL_PREFIX as prefix, EXTERNAL_GOAL_PROTOCOL,
  type ExternalCapabilities, type ExternalCommand, type ExternalGoalView } from "./native-external-goal-contracts.js";

const hash = "a".repeat(64);
const binding = { principalRef: "authenticated-test-owner", workspaceRoot: "D:\\external-goal-fixture" };
const ref = { threadId: "native-thread-fixture", goalId: "native-goal-fixture" };
const create: ExternalCommand = { kind: "create", requestKey: "create-1", objective: "Test objective", successCriteria: "Test criteria" };
const baseView: ExternalGoalView = { ref, revision: 1, fence: 0, executionPolicy: "external_only",
  nativeStatus: "paused", externalState: "ready", checkpointRef: null };

/** Deliberately a protocol fixture, not Codex or evidence of native end-to-end execution. */
function fixture(t: TestContext) {
  // Test data stays on the project drive; do not fill the user's system TEMP drive.
  const dir = mkdtempSync(join(fileURLToPath(new URL("../", import.meta.url)), ".native-egp-test-"));
  const path = join(dir, "intent.sqlite");
  const journals = new Set<ExternalGoalIntentJournal>();
  // Register cleanup before loading the native module, so ABI failures leave no fixture directories.
  t.after(() => {
    for (const openJournal of journals) openJournal.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const open = () => { const journal = new ExternalGoalIntentJournal(path, binding); journals.add(journal); return journal; };
  const journal = open();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let authorized = true;
  const capabilities: ExternalCapabilities = {
    protocol: EXTERNAL_GOAL_PROTOCOL, implementation: "codex-native-patched", storeId: "fixture-store",
    runtimeInstanceId: "fixture-runtime", executableSha256: hash, executionPolicy: "external_only",
    nativeGoalPersistence: true, atomicExternalBinding: true, durableExecutionPolicy: true,
    modelDispatchFence: true, revisionCas: true, leaseFencing: true, operationDeduplication: true,
    creationIdentityRecovery: true,
    checkpointPersistence: true, automaticModelTurns: false, implicitResume: false,
  };
  const envelope = () => ({ storeId: capabilities.storeId, runtimeInstanceId: capabilities.runtimeInstanceId });
  let handler = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === `${prefix}capabilities`) return capabilities;
    if (method === `${prefix}status`) return { ...envelope(), view: baseView };
    if (method === `${prefix}operation`) return { ...envelope(), requestKey: params.requestKey,
      requestFingerprint: params.requestFingerprint, state: "applied", createdRef: ref };
    const command = params.command as ExternalCommand;
    return { ...envelope(), requestKey: command.requestKey, requestFingerprint: params.requestFingerprint,
      outcome: "applied", errorCode: null, view: baseView, lease: null };
  };
  const transport: ExternalGoalTransport = {
    identity: { runtimeInstanceId: "fixture-runtime", executableSha256: hash },
    async request(method, params) { calls.push({ method, params }); return handler(method, params); },
  };
  const options = { transport, journal, binding, trustedExecutableSha256: hash,
    authorize: async () => { if (!authorized) throw new Error("WORKSPACE_ACCESS_REVOKED"); } };
  const client = new NativeExternalGoalClient(options);
  t.after(() => {
    assert.ok(calls.every(call => call.method.startsWith(prefix)), "Never fall back to native turn/session/model routes.");
  });
  return { client, journal, transport, capabilities, calls, options, envelope, path, open,
    close: (value: ExternalGoalIntentJournal) => { value.close(); journals.delete(value); },
    setHandler: (fn: typeof handler) => { handler = fn; },
    revoke: () => { authorized = false; },
  };
}

test("requires explicit capability preflight before any mutation", async t => {
  const f = fixture(t);
  await assert.rejects(f.client.mutate(create), /PREFLIGHT_REQUIRED/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.journal.pending(), undefined);
});

test("stock runtime method-not-found fails closed without opening a thread", async t => {
  const f = fixture(t);
  f.setHandler(async () => { throw new Error("JSON-RPC -32601 Method not found"); });
  await assert.rejects(f.client.connect(), /EXTERNAL_EXECUTOR_UNAVAILABLE/);
  await assert.rejects(f.client.mutate(create), /PREFLIGHT_REQUIRED/);
  assert.deepEqual(f.calls.map(c => c.method), [`${prefix}capabilities`]);
});

for (const field of ["durableExecutionPolicy", "modelDispatchFence", "atomicExternalBinding", "leaseFencing", "revisionCas", "creationIdentityRecovery"] as const) {
  test(`capability ${field} must be true, not inferred`, async t => {
    const f = fixture(t);
    f.setHandler(async () => ({ ...f.capabilities, [field]: false }));
    await assert.rejects(f.client.connect(), /EXTERNAL_EXECUTOR_UNAVAILABLE/);
    assert.equal(f.calls.length, 1);
  });
}

test("rejects a different executable before network access", t => {
  const f = fixture(t);
  assert.throws(() => new NativeExternalGoalClient({ ...f.options, trustedExecutableSha256: "b".repeat(64) }), /UNTRUSTED_RUNTIME/);
  assert.equal(f.calls.length, 0);
});

test("authorization is rechecked after successful preflight", async t => {
  const f = fixture(t);
  await f.client.connect(); f.revoke();
  await assert.rejects(f.client.mutate(create), /WORKSPACE_ACCESS_REVOKED/);
  await assert.rejects(f.client.status(ref), /WORKSPACE_ACCESS_REVOKED/);
  assert.equal(f.calls.length, 1);
});

test("creates a paused external Goal through the new namespace only", async t => {
  const f = fixture(t);
  await f.client.connect();
  const receipt = await f.client.mutate(create);
  assert.equal(receipt.view?.nativeStatus, "paused");
  assert.equal(f.journal.pending(), undefined);
  assert.deepEqual(f.calls.map(c => c.method), [`${prefix}capabilities`, `${prefix}create`]);
});

test("rejects injected policy fields and traversal evidence before RPC", async t => {
  const f = fixture(t);
  await f.client.connect();
  await assert.rejects(f.client.mutate({ ...create, executorMode: "codex" } as ExternalCommand));
  await assert.rejects(f.client.mutate({ kind: "complete", requestKey: "bad-path", ref,
    expectedRevision: 2, leaseToken: "secret-lease", fence: 1, checkpointRef: "cp",
    evidence: [{ path: "../outside", sha256: hash }] }));
  assert.equal(f.calls.length, 1);
});

test("unknown write outcome is journaled and a second write is never sent", async t => {
  const f = fixture(t); await f.client.connect();
  f.setHandler(async () => { throw new Error("connection lost after request send"); });
  await assert.rejects(f.client.mutate(create), /RECONCILIATION_REQUIRED/);
  assert.equal(f.journal.pending()?.requestKey, create.requestKey);
  await assert.rejects(f.client.mutate({ ...create, requestKey: "must-not-send" }), /RECONCILIATION_REQUIRED/);
  assert.equal(f.calls.length, 2);
});

test("pending write survives closing and reopening the real SQLite journal", async t => {
  const f = fixture(t); await f.client.connect();
  f.setHandler(async () => { throw new Error("lost reply"); });
  await assert.rejects(f.client.mutate(create), /RECONCILIATION_REQUIRED/);
  const before = f.journal.pending(); f.close(f.journal);
  const restartedJournal = f.open();
  const restarted = new NativeExternalGoalClient({ ...f.options, journal: restartedJournal });
  f.setHandler(async (method, params) => method.endsWith("capabilities") ? f.capabilities : {
    ...f.envelope(), requestKey: params.requestKey, requestFingerprint: params.requestFingerprint, state: "applied", createdRef: ref,
  });
  await restarted.connect();
  assert.deepEqual(restartedJournal.pending(), before);
  assert.equal(await restarted.reconcile(), "applied");
  assert.equal(restartedJournal.pending(), undefined);
  assert.equal(f.calls.filter(c => c.method.endsWith("/create")).length, 1);
});

for (const state of ["pending", "notFound"] as const) {
  test(`reconciliation ${state} keeps the write fence and waits only once`, async t => {
    const f = fixture(t); await f.client.connect();
    f.setHandler(async () => { throw new Error("lost reply"); });
    await assert.rejects(f.client.mutate(create));
    f.setHandler(async (_method, params) => ({ ...f.envelope(), requestKey: params.requestKey,
      requestFingerprint: params.requestFingerprint, state, createdRef: null }));
    assert.equal(await f.client.reconcile(), state);
    assert.ok(f.journal.pending());
    await assert.rejects(f.client.mutate({ ...create, requestKey: "another" }), /RECONCILIATION_REQUIRED/);
    assert.equal(f.calls.filter(c => c.method.endsWith("/operation")).length, 1);
  });
}

test("incorrect receipt fingerprint never settles a pending write", async t => {
  const f = fixture(t); await f.client.connect();
  f.setHandler(async () => ({ ...f.envelope(), requestKey: create.requestKey,
    requestFingerprint: "b".repeat(64), outcome: "applied", errorCode: null, view: baseView, lease: null }));
  await assert.rejects(f.client.mutate(create), /RECONCILIATION_REQUIRED/);
  assert.ok(f.journal.pending());
  await assert.rejects(f.client.status(ref), /PREFLIGHT_REQUIRED/);
});

test("reconnect cannot silently switch the persisted native store", async t => {
  const f = fixture(t); await f.client.connect();
  f.capabilities.storeId = "different-store";
  const second = new NativeExternalGoalClient(f.options);
  await assert.rejects(second.connect(), /EXTERNAL_EXECUTOR_UNAVAILABLE/);
});

test("status response from another Goal invalidates the session", async t => {
  const f = fixture(t); await f.client.connect();
  f.setHandler(async () => ({ ...f.envelope(), view: { ...baseView, ref: { ...ref, goalId: "other" } } }));
  await assert.rejects(f.client.status(ref), /NATIVE_PROTOCOL_VIOLATION/);
  await assert.rejects(f.client.mutate(create), /PREFLIGHT_REQUIRED/);
});

test("a replacement transport requires a new client and preflight", async t => {
  const f = fixture(t); await f.client.connect();
  f.transport.identity.runtimeInstanceId = "new-runtime";
  await assert.rejects(f.client.status(ref), /NATIVE_PROTOCOL_VIOLATION/);
  assert.equal(f.calls.length, 1);
});

test("claim must atomically advance revision and return matching fencing generation", async t => {
  const f = fixture(t); await f.client.connect();
  f.setHandler(async (_method, params) => ({ ...f.envelope(), requestKey: (params.command as ExternalCommand).requestKey,
    requestFingerprint: params.requestFingerprint, outcome: "applied", errorCode: null,
    view: { ...baseView, revision: 2, fence: 1, nativeStatus: "active", externalState: "leased" },
    lease: { token: "server-private-lease", fence: 1, expiresAt: "2026-09-10T10:00:00.000Z" } }));
  const receipt = await f.client.mutate({ kind: "claim", ref, expectedRevision: 1, requestKey: "claim", leaseDurationSeconds: 60 });
  assert.equal(receipt.lease?.fence, 1);
  assert.equal(f.journal.pending(), undefined);
});

test("a claim that does not advance revision is uncertain, never successful", async t => {
  const f = fixture(t); await f.client.connect();
  f.setHandler(async (_method, params) => ({ ...f.envelope(), requestKey: "claim", requestFingerprint: params.requestFingerprint,
    outcome: "applied", errorCode: null, view: { ...baseView, fence: 1, nativeStatus: "active", externalState: "leased" },
    lease: { token: "private-lease", fence: 1, expiresAt: "2026-09-10T10:00:00.000Z" } }));
  await assert.rejects(f.client.mutate({ kind: "claim", ref, expectedRevision: 1, requestKey: "claim", leaseDurationSeconds: 60 }), /RECONCILIATION_REQUIRED/);
  assert.ok(f.journal.pending());
});

test("handoff must revoke the old lease at the saved checkpoint", async t => {
  const f = fixture(t); await f.client.connect();
  f.setHandler(async (_method, params) => ({ ...f.envelope(), requestKey: "handoff", requestFingerprint: params.requestFingerprint,
    outcome: "applied", errorCode: null, view: { ...baseView, revision: 4, fence: 1, checkpointRef: "checkpoint-1", externalState: "handoff" }, lease: null }));
  await assert.rejects(f.client.mutate({ kind: "handoff", ref, expectedRevision: 3, requestKey: "handoff",
    leaseToken: "secret-lease", fence: 1, checkpointRef: "checkpoint-1" }), /RECONCILIATION_REQUIRED/);
});

test("a server rejection settles the request without granting a lease", async t => {
  const f = fixture(t); await f.client.connect();
  f.setHandler(async (_method, params) => ({ ...f.envelope(), requestKey: create.requestKey,
    requestFingerprint: params.requestFingerprint, outcome: "rejected", errorCode: "WORKSPACE_BUSY", view: null, lease: null }));
  assert.equal((await f.client.mutate(create)).outcome, "rejected");
  assert.equal(f.journal.pending(), undefined);
});

test("completed request keys cannot be silently replayed or changed", async t => {
  const f = fixture(t); await f.client.connect(); await f.client.mutate(create);
  await assert.rejects(f.client.mutate(create), /OPERATION_ALREADY_RECORDED/);
  await assert.rejects(f.client.mutate({ ...create, objective: "Different work" }), /REQUEST_KEY_CONFLICT/);
  assert.equal(f.calls.length, 2);
});

test("SQLite enforces one pending intent across two client connections", t => {
  const f = fixture(t); const second = f.open();
  f.journal.begin({ requestKey: "one", fingerprint: hash, method: `${prefix}create` });
  assert.equal(second.pending()?.requestKey, "one");
  assert.throws(() => second.begin({ requestKey: "two", fingerprint: hash, method: `${prefix}create` }), /RECONCILIATION_REQUIRED/);
});

test("a journal cannot be attached to another authenticated principal", t => {
  const f = fixture(t);
  assert.throws(() => new NativeExternalGoalClient({ ...f.options, binding: { ...binding, principalRef: "other" } }), /JOURNAL_BINDING_MISMATCH/);
});

test("intent storage contains fingerprints only, not lease tokens or command bodies", async t => {
  const f = fixture(t); await f.client.connect();
  f.setHandler(async () => { throw new Error("lost reply"); });
  await assert.rejects(f.client.mutate({ kind: "checkpoint", ref, expectedRevision: 2, requestKey: "checkpoint",
    leaseToken: "DO-NOT-PERSIST-THIS-TOKEN", fence: 1, summary: "DO-NOT-PERSIST-THIS-SUMMARY", nextAction: "next", evidence: [] }));
  const db = new Database(f.path, { readonly: true });
  try {
    const stored = JSON.stringify(db.prepare("SELECT * FROM external_goal_intents").all());
    assert.ok(!stored.includes("DO-NOT-PERSIST"));
    assert.ok(!stored.includes("leaseToken"));
  } finally { db.close(); }
});

test("single client refuses concurrent mutation while awaiting its first reply", async t => {
  const f = fixture(t); await f.client.connect();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.setHandler(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); throw new Error("lost reply"); });
  const pending = f.client.mutate(create);
  await started;
  await assert.rejects(f.client.mutate({ ...create, requestKey: "two" }), /OPERATION_IN_FLIGHT/);
  release();
  await assert.rejects(pending, /RECONCILIATION_REQUIRED/);
  assert.equal(f.calls.length, 2);
});

test("malformed status invalidates preflight rather than silently trusting the runtime", async t => {
  const f = fixture(t); await f.client.connect();
  f.setHandler(async () => ({ view: "unvalidated" }));
  await assert.rejects(f.client.status(ref), /NATIVE_STATUS_UNAVAILABLE/);
  await assert.rejects(f.client.mutate(create), /PREFLIGHT_REQUIRED/);
});

test("transport rebinding during a write leaves the durable request unresolved", async t => {
  const f = fixture(t); await f.client.connect();
  f.setHandler(async (_method, params) => {
    f.transport.identity.runtimeInstanceId = "replacement";
    return { ...f.envelope(), requestKey: create.requestKey, requestFingerprint: params.requestFingerprint,
      outcome: "applied", errorCode: null, view: baseView, lease: null };
  });
  await assert.rejects(f.client.mutate(create), /RECONCILIATION_REQUIRED/);
  assert.ok(f.journal.pending());
});

test("original transport error is retained as a cause, not guessed or retried", async t => {
  const f = fixture(t); const original = new Error("fixture transport failure");
  f.setHandler(async () => { throw original; });
  await assert.rejects(f.client.connect(), error => error instanceof Error && error.cause === original);
  assert.equal(f.calls.length, 1);
});

test("lost create reply recovers the original identity durably without recreating a Goal", async t => {
  const f = fixture(t); await f.client.connect();
  f.setHandler(async () => { throw new Error("lost create reply"); });
  await assert.rejects(f.client.mutate(create), /RECONCILIATION_REQUIRED/);
  f.setHandler(async (method, params) => method.endsWith("capabilities") ? f.capabilities : {
    ...f.envelope(), requestKey: params.requestKey, requestFingerprint: params.requestFingerprint,
    state: "applied", createdRef: ref,
  });
  assert.equal(await f.client.reconcile(), "applied");
  assert.deepEqual(await f.client.createdGoalRef(create.requestKey), ref);
  assert.equal(f.journal.pending(), undefined);
  f.close(f.journal);
  const reopened = f.open();
  const recovered = new NativeExternalGoalClient({ ...f.options, journal: reopened });
  await recovered.connect();
  assert.deepEqual(await recovered.createdGoalRef(create.requestKey), ref);
  assert.equal(f.calls.filter(call => call.method.endsWith("/create")).length, 1);
  f.revoke();
  await assert.rejects(recovered.createdGoalRef(create.requestKey), /WORKSPACE_ACCESS_REVOKED/);
});

test("an applied create without its native identity remains unresolved", async t => {
  const f = fixture(t); await f.client.connect();
  f.setHandler(async () => { throw new Error("lost reply"); });
  await assert.rejects(f.client.mutate(create));
  f.setHandler(async (_method, params) => ({ ...f.envelope(), requestKey: params.requestKey,
    requestFingerprint: params.requestFingerprint, state: "applied", createdRef: null }));
  await assert.rejects(f.client.reconcile(), /NATIVE_PROTOCOL_VIOLATION/);
  assert.ok(f.journal.pending());
  assert.equal(f.journal.createdRef(create.requestKey), null);
});

test("a rejected create cannot invent a native identity receipt", async t => {
  const f = fixture(t); await f.client.connect();
  f.setHandler(async () => { throw new Error("lost reply"); });
  await assert.rejects(f.client.mutate(create));
  f.setHandler(async (_method, params) => ({ ...f.envelope(), requestKey: params.requestKey,
    requestFingerprint: params.requestFingerprint, state: "rejected", createdRef: ref }));
  await assert.rejects(f.client.reconcile(), /NATIVE_PROTOCOL_VIOLATION/);
  assert.ok(f.journal.pending());
});

test("duplicate native create identity rolls back local settlement and preserves the write fence", async t => {
  const f = fixture(t); await f.client.connect(); await f.client.mutate(create);
  await assert.rejects(f.client.mutate({ ...create, requestKey: "must-not-reuse-native-identity" }), /RECONCILIATION_REQUIRED/);
  assert.equal(f.journal.pending()?.requestKey, "must-not-reuse-native-identity");
  assert.equal(f.journal.createdRef("must-not-reuse-native-identity"), null);
  assert.deepEqual(f.journal.createdRef(create.requestKey), ref);
});
