import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { join, resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { CARD_PROBE_URI, CARD_READONLY_URI, CARD_READONLY_RESULT } from "./chat-card-probe.js";
import { COMPUTER_USE_APPROVAL_URI } from "./computer-use-approvals.js";
import { loadConfig } from "./config.js";
import { SqliteOAuthStore } from "./oauth-store.js";
import type { createServer as CreateServer } from "./server.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ORCHESTRATION_V2_TOOLS } from "./orchestration-v2-tools.js";
import { supervisorSummarySchema } from "./supervisor-contracts.js";

const testRoot = process.env.DEVSPACE_CHAT_TEST_ROOT;
const bounded = { skip: !testRoot, timeout: 60_000 };
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const tokenHash = (value: string) => createHash("sha256").update(value).digest("base64url");

test("packaged V2 orchestration tools work through authenticated HTTP and supervisor stays read-only", bounded, async t => {
  const f = await fixture(t, false), auth = await f.authorize(), { client } = await f.connect(auth.token);
  const git = promisify(execFile);
  await git("git", ["init", f.project]);
  await writeFile(join(f.project, "seed.txt"), "source\n");
  await git("git", ["add", "."], { cwd: f.project });
  await git("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"], { cwd: f.project });
  const called = new Set<string>();
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    called.add(name);
    const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
    assert.ok(!result.isError, name + ": " + JSON.stringify(result.content));
    return result.structuredContent!;
  };
  const data = async (name: string, args: Record<string, unknown>) => JSON.parse(String((await call(name, args)).dataJson));
  const tools = (await client.listTools()).tools;
  for (const name of ORCHESTRATION_V2_TOOLS) assert.ok(tools.some(tool => tool.name === name), name);
  const runtime = await call("devspace_runtime_info");
  assert.equal(runtime.toolSchemaVersion, "2026-09-19.4");
  const opened = await call("open_workspace", { path: f.project, access: "modify" });
  const workspaceId = String(opened.workspaceId);
  const owner = JSON.parse(String((await call("session_register", { workspaceId, state: "running" })).sessionJson));
  const plan = await call("coordinator_plan_create", { workspaceId, tasks: [{ name: "candidate", description: "Implement" }, { name: "ready", description: "Waiting for owner" }] });
  const task = JSON.parse(String(plan.tasksJson)).find((item: any) => item.name === "candidate");
  const claim = await call("coordinator_claim", { workspaceId, taskId: task.id, sessionId: owner.id, expectedRevision: task.revision });
  const claimed = JSON.parse(String(claim.taskJson)), lease = { workspaceId, taskId: task.id, sessionId: owner.id, expectedRevision: claimed.revision, leaseToken: claim.leaseToken };
  const binding = await data("worktree_provision", lease);
  assert.deepEqual(await data("worktree_provision", lease), binding);
  assert.equal((await data("worktree_binding_list", { workspaceId })).length, 1);
  const scoped = { workspaceId: binding.workspaceId };
  assert.equal((await data("project_memory_get", scoped)).revision, 0);
  await data("project_memory_update", { ...scoped, expectedRevision: 0, objective: "Explicit V2 objective" });
  assert.equal((await client.callTool({ name: "project_memory_update", arguments: { ...scoped, expectedRevision: 0, objective: "stale" } })).isError, true);
  const receiver = JSON.parse(String((await call("session_register", { ...scoped, state: "queued" })).sessionJson));
  const handoff = await data("handoff_create", { ...scoped, fromSessionId: owner.id, toSessionId: receiver.id, taskId: task.id, summary: "Review candidate", nextAction: "Check diff" });
  await data("handoff_list", scoped); await data("handoff_status", { ...scoped, handoffId: handoff.id });
  await data("handoff_ack", { ...scoped, handoffId: handoff.id, sessionId: receiver.id, expectedRevision: handoff.revision });
  const integration = await data("integration_create", { ...scoped, taskId: task.id, sessionId: owner.id });
  await data("integration_list", scoped); await data("integration_status", { ...scoped, integrationId: integration.id });
  const updated = await data("integration_update", { ...scoped, integrationId: integration.id, expectedRevision: 1, reviewState: "in_review" });
  const gate = await data("integration_gate", { ...scoped, integrationId: integration.id, expectedRevision: updated.revision });
  assert.equal(gate.mergeReady, false);
  await data("watchdog_scan", scoped);
  const alerts = await data("watchdog_alert_list", scoped);
  const alert = alerts.find((item: any) => item.state === "open"); assert.ok(alert);
  await data("watchdog_alert_ack", { ...scoped, alertId: alert.id, expectedRevision: alert.revision });
  const poll = await data("automation_poll", scoped); assert.ok(poll.records.length);
  await data("automation_due_list", scoped);
  await data("automation_ack", { ...scoped, notificationId: poll.records[0].id, expectedRevision: poll.records[0].revision, consumer: "acceptance" });
  const db = new Database(join(f.stateDir, "devspace.sqlite"), { readonly: true });
  try {
    const snapshot = () => JSON.stringify(["workspace_sessions", "orchestration_sessions", "orchestration_events", "coordinator_tasks", "watchdog_alerts"].map(table => db.prepare(`select * from ${table}`).all()));
    const before = snapshot();
    const summary = await call("supervisor_summary", scoped); supervisorSummarySchema.parse(summary.summary);
    assert.equal(snapshot(), before);
    assert.equal((await client.readResource({ uri: "ui://devspace/supervisor-v2.html" })).contents[0].mimeType, "text/html;profile=mcp-app");
    assert.equal((db.prepare("select max(version) as version from devspace_schema_migrations").get() as any).version, 18);
  } finally { db.close(); }
  await call("coordinator_complete", lease);
  const cleanup = await data("worktree_cleanup_status", { ...scoped, taskId: task.id, expectedRevision: binding.revision });
  assert.equal(cleanup.status, "cleanup_eligible");
  assert.equal(await readFile(join(binding.worktreeRoot, "seed.txt"), "utf8").then(s => s.trim()), "source");
  for (const name of ORCHESTRATION_V2_TOOLS) assert.ok(called.has(name), "Unexercised V2 tool: " + name);
  await writeFile(join(f.root, "V2-HTTP-ACCEPTANCE.json"), JSON.stringify({ result: "PASS", tools: ORCHESTRATION_V2_TOOLS, runtime, migration: 18, supervisorReadOnly: true, noModels: true }, null, 2));
  console.log("V2 authenticated acceptance: " + join(f.root, "V2-HTTP-ACCEPTANCE.json"));
});

async function serverFactory(): Promise<typeof CreateServer> {
  const candidate = process.env.DEVSPACE_CARD_TEST_SERVER_ENTRY;
  if (candidate) {
    const rel = relative("D:/DevSpace-Goal-PoC/.poc/replan-v1/releases", resolve(candidate));
    assert.ok(rel && !rel.startsWith("..") && !rel.includes(":"), "Candidate must remain in isolated releases");
    assert.match(candidate.replaceAll("\\", "/"), /\/dist\/server\.js$/);
    return (await import(pathToFileURL(candidate).href)).createServer;
  }
  return (await import(process.env.DEVSPACE_CHAT_TEST_DIST === "1" ? "../dist/server.js" : "./server.js")).createServer;
}

async function fixture(t: TestContext, enabled: boolean, toolMode: "claude" | "codex" = "codex", computerUseEnabled = false) {
  const rel = relative("D:/DevSpace-Goal-PoC", resolve(testRoot!));
  assert.ok(rel && !rel.startsWith("..") && !rel.includes(":"));
  await mkdir(testRoot!, { recursive: true });
  const root = await mkdtemp(join(testRoot!, "card-http-")), project = join(root, "project"), stateDir = join(root, "state");
  await mkdir(project);
  const http = createHttpServer();
  await new Promise<void>((done, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", done); });
  const port = (http.address() as { port: number }).port, origin = `http://127.0.0.1:${port}`, resource = `${origin}/mcp`;
  const clients: Client[] = [];
  let service: ReturnType<typeof CreateServer> | undefined;
  t.after(async () => {
    await Promise.allSettled(clients.map(c => c.close()));
    await service?.close();
    await new Promise<void>((done, reject) => { http.close(e => e ? reject(e) : done()); http.closeAllConnections(); });
  });
  const env = writeTestDevspaceConfig(join(root, "config"), {
    server: { host: "127.0.0.1", port, publicBaseUrl: origin },
    workspaces: { allowedRoots: [project], worktreeRoot: join(root, "worktrees") }, storage: { stateDir },
    tools: { mode: toolMode }, ui: { enabled: true }, skills: { enabled: false }, logging: { level: "silent" },
    subagents: { enabled: false, providers: [] }, goals: { enabled: false }, diagnostics: { chatCard: enabled },
    chatGoals: { enabled: true, shrimpEntryPoint: "D:/DevSpace-Goal-PoC/dist/index.js", dataRoot: "D:/AgentState/_poc/shrimp/chat-goals-tests" },
    oauth: { scopes: ["devspace", "diagnostic-unused"] },
  });
  if (computerUseEnabled) env.DEVSPACE_COMPUTER_USE = "1";
  const config = loadConfig(env), createServer = await serverFactory();
  assert.equal(config.chatCardProbeEnabled, enabled);
  service = createServer(config); http.on("request", service.app);

  async function authorize(scope = "devspace") {
    const redirect = "http://127.0.0.1/callback";
    const reg = await fetch(`${origin}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      client_name: "Isolated card OAuth acceptance; no model", redirect_uris: [redirect], token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    }) });
    assert.equal(reg.status, 201); const { client_id } = await reg.json() as { client_id: string };
    const verifier = randomUUID() + randomUUID(), challenge = createHash("sha256").update(verifier).digest("base64url");
    const auth = await fetch(`${origin}/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({
      client_id, response_type: "code", redirect_uri: redirect, scope, resource, code_challenge: challenge,
      code_challenge_method: "S256", owner_token: config.oauth.ownerToken,
    }) });
    assert.equal(auth.status, 302);
    const code = new URL(auth.headers.get("location")!).searchParams.get("code")!;
    const exchange = await fetch(`${origin}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({
      client_id, grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier, resource,
    }) });
    assert.equal(exchange.status, 200);
    const tokens = await exchange.json() as { access_token: string };
    return { token: tokens.access_token, clientId: client_id };
  }
  async function connect(token: string, captureToolListChanged = false) {
    const client = new Client({ name: "Deterministic card test; NOT hosted ChatGPT", version: "1" }, { capabilities: {} });
    let resolveToolListChanged: (() => void) | undefined;
    const toolListChanged = captureToolListChanged
      ? new Promise<void>((resolve) => { resolveToolListChanged = resolve; })
      : undefined;
    if (captureToolListChanged) {
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        resolveToolListChanged?.();
      });
    }
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    await client.connect(transport); return { client, transport, toolListChanged };
  }
  async function raw(sessionId: string, method: string, params: object, token?: string) {
    return fetch(resource, { method: "POST", headers: { "content-type": "application/json", Accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }), signal: AbortSignal.timeout(5000) });
  }
  function goalCounts() {
    const db = new Database(join(stateDir, "devspace.sqlite"), { readonly: true, fileMustExist: true });
    try { return ["chat_goal_bindings", "chat_goal_requests", "managed_goal_bindings"].map(table => db.prepare(`select count(*) as n from ${table}`).get()); }
    finally { db.close(); }
  }
  return { root, project, stateDir, config, createServer, origin, resource, authorize, connect, raw, goalCounts, stopService: () => service!.close() };
}

test("card diagnostic is default-off and cannot be enabled through MCP arguments or metadata", bounded, async t => {
  const f = await fixture(t, false), auth = await f.authorize(), { client } = await f.connect(auth.token);
  assert.ok(!(await client.listTools()).tools.some(x => x.name.startsWith("chat_card_probe_")));
  assert.ok(!(await client.listResources()).resources.some(x => x.uri === CARD_PROBE_URI));
  assert.ok(!(await client.listTools()).tools.some(x => x.name === "diagnostic_ping"));
  await assert.rejects(client.readResource({ uri: CARD_READONLY_URI }));
  const denied = await client.callTool({ name: "chat_card_probe_show", arguments: { requestKey: "one", diagnostics: { chatCard: true } }, _meta: { diagnostics: { chatCard: true } } });
  assert.equal(denied.isError, true);
  await assert.rejects(client.readResource({ uri: CARD_PROBE_URI }));
  assert.ok(!client.getInstructions()?.includes("chat_card_probe_show"));
  for (const incompatible of [{ uiEnabled: false }, { subagents: { enabled: true, providers: [] } }, { goals: { enabled: true, shrimpEntryPoint: "unused", dataRoot: "unused" }, chatGoals: undefined }]) {
    assert.throws(() => f.createServer({ ...f.config, ...incompatible, chatCardProbeEnabled: true }), /requires/);
  }
});

test("OAuth discovery advertises offline_access for durable ChatGPT refresh tokens", bounded, async t => {
  const f = await fixture(t, false);
  const response = await fetch(`${f.origin}/.well-known/oauth-authorization-server`);
  assert.equal(response.status, 200);
  const metadata = await response.json() as { scopes_supported?: string[]; grant_types_supported?: string[] };
  assert.ok(metadata.scopes_supported?.includes("devspace"));
  assert.ok(metadata.scopes_supported?.includes("offline_access"));
  assert.ok(metadata.grant_types_supported?.includes("refresh_token"));
});

test("packaged Computer Use approval tools and app-only submit metadata are available over HTTP", bounded, async t => {
  const f = await fixture(t, false, "codex", true), auth = await f.authorize(), { client } = await f.connect(auth.token);
  const tools = (await client.listTools()).tools;
  for (const name of ["observe", "computer", "computer_approval_show", "computer_approval_wait", "computer_approval_submit"]) {
    assert.ok(tools.some(tool => tool.name === name), `${name} should be in the raw MCP tool list`);
  }
  const show = tools.find(tool => tool.name === "computer_approval_show")!;
  const submit = tools.find(tool => tool.name === "computer_approval_submit")!;
  assert.deepEqual((show._meta?.ui as any)?.visibility, ["model", "app"]);
  assert.deepEqual((submit._meta?.ui as any)?.visibility, ["app"]);
  const resource = await client.readResource({ uri: COMPUTER_USE_APPROVAL_URI });
  assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
});

test("streamable HTTP emits tools/list_changed after the standalone SSE channel is live", bounded, async t => {
  const f = await fixture(t, false), auth = await f.authorize();
  const { client, toolListChanged } = await f.connect(auth.token, true);
  assert.ok(toolListChanged);
  await Promise.race([
    toolListChanged,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("tools/list_changed was not received")), 5_000)),
  ]);
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes("devspace_runtime_info"));
});

test("authenticated production-path card works across MCP sessions while the Goal gate stays blocked", bounded, async t => {
  const f = await fixture(t, true), auth = await f.authorize(), { client } = await f.connect(auth.token);
  const before = f.goalCounts();
  const tools = (await client.listTools()).tools, diagnosticTools = tools.filter(x => x.name.startsWith("chat_card_probe_"));
  assert.equal(diagnosticTools.length, 5);
  for (const name of ["chat_card_probe_view", "diagnostic_ping"]) {
    const control = CallToolResultSchema.parse(await client.callTool({ name, arguments: {} }));
    assert.deepEqual(control.structuredContent, CARD_READONLY_RESULT);
    assert.equal(control._meta, undefined);
    assert.deepEqual(f.goalCounts(), before);
  }
  assert.equal((await client.readResource({ uri: CARD_READONLY_URI })).contents[0].mimeType, "text/html;profile=mcp-app");
  for (const tool of diagnosticTools) {
    assert.ok(tool.outputSchema); assert.deepEqual(tool._meta?.securitySchemes, [{ type: "oauth2", scopes: ["devspace"] }]);
  }
  const templateTools = diagnosticTools.filter(tool => {
    const ui = tool._meta?.ui as { resourceUri?: string } | undefined;
    return ui?.resourceUri || tool._meta?.["ui/resourceUri"] || tool._meta?.["openai/outputTemplate"];
  });
  assert.deepEqual(templateTools.map(tool => tool.name), ["chat_card_probe_view", "chat_card_probe_show"], "Only display tools associate their templates");
  assert.deepEqual((templateTools[0]._meta!.ui as any).visibility, ["model", "app"]);
  assert.deepEqual((diagnosticTools.find(x => x.name === "chat_card_probe_submit")!._meta!.ui as any).visibility, ["app"]);
  const preflight = CallToolResultSchema.parse(await client.callTool({ name: "chat_goal_preflight", arguments: {} }));
  assert.equal((preflight.structuredContent as any).data.status, "blocked");
  assert.equal((preflight.structuredContent as any).data.canCreateOrClaim, false);
  const shown = CallToolResultSchema.parse(await client.callTool({ name: "chat_card_probe_show", arguments: { requestKey: "one" }, _meta: { devspaceOwnerRef: "untrusted-not-an-owner" } }));
  assert.ok(!shown.isError); assert.equal(shown.structuredContent!.waitStarted, false);
  const card = shown._meta!.probe as { probeId: string; submitToken: string };
  assert.ok(!JSON.stringify(shown.content).includes(card.submitToken)); assert.ok(!JSON.stringify(shown.structuredContent).includes(card.submitToken));
  const resource = (await client.readResource({ uri: CARD_PROBE_URI })).contents[0];
  assert.ok("text" in resource); assert.equal(resource.mimeType, "text/html;profile=mcp-app");
  const cardHtml = resource.text as string;
  assert.match(cardHtml, /卡片通道诊断/); assert.ok(!cardHtml.includes("<!--CARD_SCRIPT-->"));
  assert.ok(!cardHtml.includes(card.submitToken)); assert.ok(!cardHtml.includes(auth.token));
  const waiting = client.callTool({ name: "chat_card_probe_wait", arguments: { probeId: card.probeId } });
  // A second authenticated session models hosts that route app tool calls over
  // a different MCP transport. It is not a second model invocation.
  const appSession = await f.connect(auth.token);
  const current = CallToolResultSchema.parse(await appSession.client.callTool({ name: "chat_card_probe_show", arguments: { requestKey: "one" } }));
  assert.equal(current.structuredContent!.waitActive, true);
  assert.equal(current.structuredContent!.replayed, true);
  const status = CallToolResultSchema.parse(await appSession.client.callTool({ name: "chat_card_probe_status", arguments: card }));
  assert.equal(status.structuredContent!.waitActive, true); assert.ok(status.structuredContent!.waitDeadlineAt);
  assert.deepEqual((diagnosticTools.find(x => x.name === "chat_card_probe_status")!._meta!.ui as any).visibility, ["app"]);
  const invalid = await appSession.client.callTool({ name: "chat_card_probe_submit", arguments: { ...card, submitToken: "x".repeat(64), answer: "BLUE" } });
  assert.equal(invalid.isError, true);
  const answered = CallToolResultSchema.parse(await appSession.client.callTool({ name: "chat_card_probe_submit", arguments: { ...card, answer: "BLUE", clientTiming: { renderedAt: 1, clickedAt: 2, sentAt: 3, clickElapsedMs: 1, sendElapsedMs: 2 } } }));
  assert.ok(!answered.isError);
  const receipt = CallToolResultSchema.parse(await waiting);
  assert.equal(receipt.structuredContent!.answer, "BLUE"); assert.equal(receipt.structuredContent!.activeWaitAtSubmission, true);
  assert.equal(receipt.structuredContent!.sameTurnContinuation, "unverified");
  assert.equal(receipt.structuredContent!.receiptPhase, "during_wait");
  assert.equal(receipt.structuredContent!.clientTimingTrust, "untrusted_browser_report");
  const replay = CallToolResultSchema.parse(await appSession.client.callTool({ name: "chat_card_probe_submit", arguments: { ...card, answer: "BLUE" } }));
  assert.equal(replay.structuredContent!.replayed, true);
  assert.deepEqual(f.goalCounts(), before); assert.deepEqual(await readdir(f.project), []);
  const report = { result: "PASS_ISOLATED_DEVSPACE_OAUTH", hostedChatAcceptance: "NOT_RUN", quota: "UNVERIFIED",
    scope: "Packaged DevSpace server + existing OAuth + official deterministic MCP Client; not a hosted Chat model or browser click",
    serverEntry: process.env.DEVSPACE_CARD_TEST_SERVER_ENTRY ?? "isolated dist/server.js", diagnosticToolNames: diagnosticTools.map(x => x.name),
    htmlSha256: hash(cardHtml), templateTools: templateTools.map(tool => tool.name), appOnlyToolsDoNotAssociateTemplates: true,
    sharedAcrossMcpSessions: true, goalGate: "blocked", goalRecordsUnchanged: true, projectUnchanged: true,
    extraModelExecutors: 0, followUpChatMessages: 0, receipt: receipt.structuredContent };
  await writeFile(join(f.root, "CARD-HTTP-ACCEPTANCE.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(`Authenticated card evidence: ${join(f.root, "CARD-HTTP-ACCEPTANCE.json")}`);
});

test("card tools and resource require valid unexpired scoped OAuth on every HTTP request", bounded, async t => {
  const f = await fixture(t, true, "claude"), auth = await f.authorize(), { client, transport } = await f.connect(auth.token);
  const shown = CallToolResultSchema.parse(await client.callTool({ name: "chat_card_probe_show", arguments: { requestKey: "auth-test" } }));
  const card = shown._meta!.probe as { probeId: string; submitToken: string };
  const insufficient = await f.authorize("diagnostic-unused");
  const store = new SqliteOAuthStore(f.stateDir);
  const expiredToken = randomUUID(), wrongResourceToken = randomUUID();
  try {
    // Synthetic negative records are written only into this fresh isolated DB.
    store.saveAccessToken(tokenHash(expiredToken), { clientId: auth.clientId, scopes: ["devspace"], resource: f.resource, expiresAt: 1 });
    store.saveAccessToken(tokenHash(wrongResourceToken), { clientId: auth.clientId, scopes: ["devspace"], resource: `${f.origin}/not-mcp`, expiresAt: Math.floor(Date.now() / 1000) + 60 });
  } finally { store.close(); }
  const cases = [
    { name: "missing", token: undefined, status: 401 }, { name: "invalid", token: randomUUID(), status: 401 },
    { name: "expired", token: expiredToken, status: 401 }, { name: "wrong_scope", token: insufficient.token, status: 403 },
    { name: "wrong_resource", token: wrongResourceToken, status: 401 },
  ];
  for (const c of cases) for (const request of [
    { method: "tools/call", params: { name: "chat_card_probe_view", arguments: {} } },
    { method: "tools/call", params: { name: "diagnostic_ping", arguments: {} } },
    { method: "resources/read", params: { uri: CARD_READONLY_URI } },
    { method: "tools/call", params: { name: "chat_card_probe_submit", arguments: { ...card, answer: "GREEN" }, _meta: { devspaceOwnerRef: "single-user" } } },
    { method: "tools/call", params: { name: "chat_card_probe_status", arguments: card } },
    { method: "resources/read", params: { uri: CARD_PROBE_URI, _meta: { devspaceOwnerRef: "single-user" } } },
  ]) {
    const response = await f.raw(transport.sessionId!, request.method, request.params, c.token);
    assert.equal(response.status, c.status, `${c.name}: ${request.method}`); await response.arrayBuffer();
  }
  const untouched = CallToolResultSchema.parse(await client.callTool({ name: "chat_card_probe_show", arguments: { requestKey: "auth-test" } }));
  assert.equal(untouched.structuredContent!.answer, null);
  const revoke = await fetch(`${f.origin}/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: auth.clientId, token: auth.token, token_type_hint: "access_token" }) });
  assert.equal(revoke.status, 200); await revoke.arrayBuffer();
  const revoked = await f.raw(transport.sessionId!, "resources/read", { uri: CARD_PROBE_URI }, auth.token);
  assert.equal(revoked.status, 401); await revoked.arrayBuffer();
  assert.deepEqual(await readdir(f.project), []);
  const report = { result: "PASS_AUTH_NEGATIVE_CASES", hostedChatAcceptance: "NOT_RUN", cases: cases.map(({name,status}) => ({name,status,toolsAndResources: true})),
    revokedTokenRejected: true, forgedMetadataDoesNotAuthenticate: true, deniedAnswerRemainsNull: true,
    scope: "Existing single-user OAuth implementation in fresh isolated DB; no production credentials or multi-tenant claim" };
  await writeFile(join(f.root, "CARD-AUTH-ACCEPTANCE.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(`Card OAuth rejection evidence: ${join(f.root, "CARD-AUTH-ACCEPTANCE.json")}`);
});
