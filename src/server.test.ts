import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type ServerConfig, type ToolMode } from "./config.js";
import type { LocalAgentProviderAvailability } from "./local-agent-availability.js";
import { buildLocalAgentProviderStatuses } from "./local-agent-catalog.js";
import type { SubagentsConfig } from "./local-agent-config.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import type { CodexCuaBridge } from "./codex-cua-bridge.js";
import { ComputerUseApprovals } from "./computer-use-approvals.js";
import { OrchestrationRegistry } from "./orchestration-registry.js";
import { OrchestrationStore } from "./orchestration-store.js";
import { CoordinatorStore } from "./coordinator-store.js";
import { OrchestrationCoordinator } from "./orchestration-coordinator.js";
import { OrchestrationV2 } from "./orchestration-v2.js";
import { ORCHESTRATION_V2_TOOLS } from "./orchestration-v2-tools.js";
import { createMcpServer } from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { WorkspaceAccessManager } from "./workspace-access.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

const execFileAsync = promisify(execFile);

test("tool modes expose the expected host-facing tool surface", async (t) => {
  const cases: Array<{
    mode: ToolMode;
    expected: string[];
  }> = [
    {
      mode: "claude",
      expected: [
        "open_workspace",
        "read",
        "list_directory",
        "file_info",
        "batch_read_files",
        "search_files",
        "query_sqlite",
        "session_register",
        "session_heartbeat",
        "session_update",
        "session_list",
        "session_status",
        "session_events",
        "session_health",
        "session_conflicts",
        "coordinator_plan_create",
        "coordinator_task_list",
        "coordinator_task_status",
        "coordinator_ready",
        "coordinator_claim",
        "coordinator_release",
        "coordinator_complete",
        "write",
        "edit",
        "bash",
        "show_changes",
        "request_workspace_access",
        "approve_workspace_access",
        "list_workspace_access",
        "revoke_workspace_access",
        "workspace_access_audit",
        "devspace_runtime_info",
      ],
    },
    {
      mode: "codex",
      expected: [
        "open_workspace",
        "read",
        "list_directory",
        "file_info",
        "batch_read_files",
        "search_files",
        "query_sqlite",
        "session_register",
        "session_heartbeat",
        "session_update",
        "session_list",
        "session_status",
        "session_events",
        "session_health",
        "session_conflicts",
        "coordinator_plan_create",
        "coordinator_task_list",
        "coordinator_task_status",
        "coordinator_ready",
        "coordinator_claim",
        "coordinator_release",
        "coordinator_complete",
        "apply_patch",
        "exec_command",
        "write_stdin",
        "show_changes",
        "request_workspace_access",
        "approve_workspace_access",
        "list_workspace_access",
        "revoke_workspace_access",
        "workspace_access_audit",
        "devspace_runtime_info",
      ],
    },
  ];

  for (const { mode, expected } of cases) {
    await t.test(mode, async (nested) => {
      const context = await fixture(nested, { toolMode: mode, uiEnabled: false });
      const tools = await context.client.listTools();

      assert.ok(!context.client.getInstructions()?.includes("chat_goal_preflight"),"Disabled Chat Goal mode must not advertise a nonexistent tool");

      assert.deepEqual(
        tools.tools.map((tool) => tool.name).sort(),
        [...expected, ...ORCHESTRATION_V2_TOOLS].sort(),
      );
    });
  }
});

test("runtime identity version fields stay schema-stable across future releases", async (t) => {
  const context = await fixture(t);
  const tools = await context.client.listTools();
  const runtime = tools.tools.find((tool) => tool.name === "devspace_runtime_info");
  assert.ok(runtime?.outputSchema);
  const properties = (runtime.outputSchema as any).properties;
  assert.equal(properties?.toolSchemaVersion?.type, "string");
  assert.equal(properties?.serverVersion?.type, "string");
  assert.equal(properties?.toolSchemaVersion?.const, undefined);
  assert.equal(properties?.serverVersion?.const, undefined);

  const first = structuredContent(await context.client.callTool({
    name: "devspace_runtime_info",
    arguments: {},
  }));
  const second = structuredContent(await context.client.callTool({
    name: "devspace_runtime_info",
    arguments: {},
  }));
  assert.equal(first.toolCatalogCount, tools.tools.length);
  assert.match(String(first.toolCatalogFingerprint), /^[a-f0-9]{64}$/);
  assert.equal(second.toolCatalogFingerprint, first.toolCatalogFingerprint);
  assert.doesNotMatch(JSON.stringify(first), /[A-Z]:\\|DEVSPACE_CLIENT_SECRET|refresh_token/i);
});

test("orchestration tools register, heartbeat, monitor and detect conflicts without project mutation", async (t) => {
  const context = await fixture(t);
  const opened = structuredContent(await callOpen(context.client, context.project, "orchestration-tools", "read"));
  const workspaceId = String(opened.workspaceId);
  const workerA = structuredContent(await context.client.callTool({
    name: "session_register",
    arguments: {
      workspaceId,
      sessionKind: "test",
      externalSessionId: "worker-a",
      label: "Worker A",
      task: "Edit server",
      state: "running",
    },
  }));
  const sessionA = JSON.parse(String(workerA.sessionJson)) as { id: string };
  assert.equal(workerA.reused, false);

  const replay = structuredContent(await context.client.callTool({
    name: "session_register",
    arguments: {
      workspaceId,
      sessionKind: "test",
      externalSessionId: "worker-a",
    },
  }));
  assert.equal(JSON.parse(String(replay.sessionJson)).id, sessionA.id);
  assert.equal(replay.reused, true);

  await context.client.callTool({
    name: "session_heartbeat",
    arguments: { workspaceId, sessionId: sessionA.id, note: "still working" },
  });
  await context.client.callTool({
    name: "session_update",
    arguments: {
      workspaceId,
      sessionId: sessionA.id,
      fileIntents: [{ path: "src/server.ts", access: "write" }],
    },
  });

  const workerB = structuredContent(await context.client.callTool({
    name: "session_register",
    arguments: {
      workspaceId,
      sessionKind: "test",
      externalSessionId: "worker-b",
      label: "Worker B",
      state: "running",
    },
  }));
  const sessionB = JSON.parse(String(workerB.sessionJson)) as { id: string };
  await context.client.callTool({
    name: "session_update",
    arguments: {
      workspaceId,
      sessionId: sessionB.id,
      fileIntents: [{ path: "src/server.ts", access: "read" }],
    },
  });

  const listed = structuredContent(await context.client.callTool({
    name: "session_list",
    arguments: { workspaceId },
  }));
  assert.equal(listed.count, 3);
  assert.match(String(listed.sessionsJson), /Worker A/);

  const status = structuredContent(await context.client.callTool({
    name: "session_status",
    arguments: { workspaceId, sessionId: sessionA.id },
  }));
  assert.match(String(status.intentsJson), /src\/server\.ts/);

  const events = structuredContent(await context.client.callTool({
    name: "session_events",
    arguments: { workspaceId, sessionId: sessionA.id, limit: 20 },
  }));
  assert.ok(Number(events.count) >= 2);
  assert.match(String(events.eventsJson), /heartbeat/);

  const health = structuredContent(await context.client.callTool({
    name: "session_health",
    arguments: { workspaceId, sessionId: sessionA.id, idleMinutes: 60, stalledMinutes: 120 },
  }));
  assert.match(String(health.healthJson), /"primary":"healthy"/);

  const conflicts = structuredContent(await context.client.callTool({
    name: "session_conflicts",
    arguments: { workspaceId },
  }));
  assert.equal(conflicts.count, 1);
  assert.match(String(conflicts.conflictsJson), /"severity":"medium"/);
  assert.equal(conflicts.truncated, false);
});

test("automatic orchestration telemetry records trusted tool activity without explicit session calls", async (t) => {
  const context = await fixture(t, { toolMode: "codex" });
  const conversation = "auto-telemetry-conversation";
  const opened = structuredContent(await callOpen(
    context.client,
    context.project,
    conversation,
    "modify",
  ));
  const workspaceId = String(opened.workspaceId);

  const initial = structuredContent(await context.client.callTool({
    name: "session_list",
    arguments: { workspaceId },
  }));
  const listed = JSON.parse(String(initial.sessionsJson)) as Array<{
    session: {
      id: string;
      sessionKind: string;
      label?: string;
    };
  }>;
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.session.sessionKind, "chatgpt_auto");
  assert.equal(listed[0]?.session.label, "Automatic ChatGPT telemetry");
  const sessionId = listed[0]?.session.id;
  assert.ok(sessionId);

  await writeFile(join(context.project, "seed.txt"), "seed\n");
  await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "seed.txt" },
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);

  const patched = await context.client.callTool({
    name: "apply_patch",
    arguments: {
      workspaceId,
      patch: [
        "*** Begin Patch",
        "*** Add File: auto-telemetry.txt",
        "+automatic telemetry",
        "*** End Patch",
      ].join("\n"),
    },
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);
  assert.notEqual(patched.isError, true);

  const validation = await context.client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      cmd: "node --test --help",
      yieldTimeMs: 10000,
      maxOutputTokens: 2000,
    },
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);
  assert.notEqual(validation.isError, true);

  const failed = await context.client.callTool({
    name: "file_info",
    arguments: { workspaceId, path: "../outside.txt" },
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(failed.isError, true);

  const status = structuredContent(await context.client.callTool({
    name: "session_status",
    arguments: { workspaceId, sessionId },
  }));
  assert.match(String(status.intentsJson), /auto-telemetry\.txt/);

  const events = structuredContent(await context.client.callTool({
    name: "session_events",
    arguments: { workspaceId, sessionId, limit: 100 },
  }));
  const eventJson = String(events.eventsJson);
  assert.match(eventJson, /heartbeat/);
  assert.match(eventJson, /file_change/);
  assert.match(eventJson, /test_run/);
  assert.match(eventJson, /error/);
  assert.match(eventJson, /"passed":true/);

  const parsedStatus = JSON.parse(String(status.sessionJson)) as {
    lastHeartbeatAt?: string;
    lastFileChangeAt?: string;
    lastTestAt?: string;
    lastErrorFingerprint?: string;
  };
  assert.ok(parsedStatus.lastHeartbeatAt);
  assert.ok(parsedStatus.lastFileChangeAt);
  assert.ok(parsedStatus.lastTestAt);
  assert.match(parsedStatus.lastErrorFingerprint ?? "", /^[a-f0-9]{24}$/);
});

test("coordinator MCP tools enforce DAG readiness and fenced leases", async (t) => {
  const context = await fixture(t, { toolMode: "codex" });
  const conversation = "coordinator-conversation";
  const opened = structuredContent(await callOpen(
    context.client,
    context.project,
    conversation,
    "read",
  ));
  const workspaceId = String(opened.workspaceId);

  const created = structuredContent(await context.client.callTool({
    name: "coordinator_plan_create",
    arguments: {
      workspaceId,
      tasks: [
        { name: "A", description: "First task" },
        { name: "B", description: "Second task", dependencies: ["A"] },
      ],
    },
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]));
  assert.equal(created.count, 2);
  const tasks = JSON.parse(String(created.tasksJson)) as Array<{
    id: string;
    name: string;
    revision: number;
  }>;
  const taskA = tasks.find((task) => task.name === "A")!;
  const taskB = tasks.find((task) => task.name === "B")!;

  const readyBefore = structuredContent(await context.client.callTool({
    name: "coordinator_ready",
    arguments: { workspaceId },
  }));
  assert.equal(readyBefore.count, 1);
  assert.match(String(readyBefore.tasksJson), /"name":"A"/);

  const claimed = structuredContent(await context.client.callTool({
    name: "coordinator_claim",
    arguments: {
      workspaceId,
      taskId: taskA.id,
      expectedRevision: taskA.revision,
    },
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]));
  const claimedTask = JSON.parse(String(claimed.taskJson)) as {
    revision: number;
    state: string;
  };
  assert.equal(claimedTask.state, "claimed");
  assert.match(String(claimed.leaseToken), /^[0-9a-f-]{36}$/i);

  const stale = await context.client.callTool({
    name: "coordinator_release",
    arguments: {
      workspaceId,
      taskId: taskA.id,
      expectedRevision: taskA.revision,
      leaseToken: claimed.leaseToken,
    },
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(stale.isError, true);

  const completed = structuredContent(await context.client.callTool({
    name: "coordinator_complete",
    arguments: {
      workspaceId,
      taskId: taskA.id,
      expectedRevision: claimedTask.revision,
      leaseToken: claimed.leaseToken,
    },
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]));
  assert.match(String(completed.taskJson), /"state":"completed"/);

  const readyAfter = structuredContent(await context.client.callTool({
    name: "coordinator_ready",
    arguments: { workspaceId },
  }));
  assert.equal(readyAfter.count, 1);
  assert.match(String(readyAfter.tasksJson), new RegExp(taskB.id));

  const listed = structuredContent(await context.client.callTool({
    name: "coordinator_task_list",
    arguments: { workspaceId },
  }));
  assert.equal(listed.count, 2);
});

test("orchestration session IDs cannot be read through another project scope", async (t) => {
  const context = await fixture(t, { uiEnabled: true });
  const openedA = structuredContent(await callOpen(context.client, context.project, "scope-a", "read"));
  const created = structuredContent(await context.client.callTool({
    name: "session_register",
    arguments: {
      workspaceId: openedA.workspaceId,
      sessionKind: "test",
      externalSessionId: "scope-worker",
      state: "running",
    },
  }));
  const sessionId = (JSON.parse(String(created.sessionJson)) as { id: string }).id;

  const externalProject = join(dirname(context.project), "orchestration-other-project");
  await mkdir(externalProject, { recursive: true });
  const request = await context.client.callTool({
    name: "request_workspace_access",
    arguments: { path: externalProject, access: "read", reason: "Project-scope test" },
    _meta: { "openai/session": "scope-b" },
  } as Parameters<Client["callTool"]>[0]);
  const pending = structuredContent(request);
  const card = responseCard(request);
  await context.client.callTool({
    name: "approve_workspace_access",
    arguments: {
      requestId: pending.requestId,
      approvalToken: card.approvalToken,
      decision: "session",
    },
    _meta: { "openai/session": "scope-b" },
  } as Parameters<Client["callTool"]>[0]);
  const openedB = structuredContent(await callOpen(context.client, externalProject, "scope-b", "read"));
  const denied = await context.client.callTool({
    name: "session_status",
    arguments: { workspaceId: openedB.workspaceId, sessionId },
  });
  assert.equal(denied.isError, true);
  const text = denied.content as Array<{ type: string; text?: string }>;
  assert.match(text.map((item) => item.text ?? "").join("\n"), /outside the current project scope/i);
});

test("search_files searches names and contents without allowing workspace escape", async (t) => {
  const context = await fixture(t);
  await mkdir(join(context.project, "nested"), { recursive: true });
  await writeFile(join(context.project, "nested", "alpha.txt"), "first line\nNeedle value\nlast line\n");
  const opened = structuredContent(await callOpen(context.client, context.project, "search-files", "read"));
  const workspaceId = String(opened.workspaceId);

  const byName = structuredContent(await context.client.callTool({
    name: "search_files",
    arguments: {
      workspaceId,
      searchType: "name",
      query: "**/*.txt",
      limit: 20,
    },
  }));
  assert.match(String(byName.result), /alpha\.txt/i);
  assert.equal(byName.searchType, "name");
  assert.equal(byName.matchCount, 1);
  assert.match(String(byName.matchesJson), /nested\/alpha\.txt/i);
  assert.match(String(byName.matchesJson), /"sizeBytes":/);
  assert.match(String(byName.matchesJson), /"modifiedAt":/);

  const byContent = structuredContent(await context.client.callTool({
    name: "search_files",
    arguments: {
      workspaceId,
      searchType: "content",
      query: "needle value",
      literal: true,
      ignoreCase: true,
      glob: "**/*.txt",
      context: 1,
      limit: 20,
    },
  }));
  assert.match(String(byContent.result), /alpha\.txt/i);
  assert.match(String(byContent.result), /Needle value/);
  assert.equal(byContent.searchType, "content");
  assert.equal(byContent.matchCount, 1);
  assert.match(String(byContent.matchesJson), /"line":2/);
  assert.match(String(byContent.matchesJson), /Needle value/);

  const escaped = await context.client.callTool({
    name: "search_files",
    arguments: {
      workspaceId,
      searchType: "name",
      query: "**/*",
      path: "..",
    },
  });
  assert.equal(escaped.isError, true);
  const escapedContent = escaped.content as Array<{ type: string; text?: string }>;
  assert.match(
    escapedContent
      .filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n"),
    /outside allowed roots|outside workspace|Path is outside/i,
  );
});

test("search_files merges multiple include globs for content search", async (t) => {
  const context = await fixture(t);
  await writeFile(join(context.project, "alpha.txt"), "shared needle\n");
  await writeFile(join(context.project, "beta.md"), "shared needle\n");
  await writeFile(join(context.project, "gamma.js"), "shared needle\n");
  const opened = structuredContent(await callOpen(context.client, context.project, "search-globs", "read"));
  const response = structuredContent(await context.client.callTool({
    name: "search_files",
    arguments: {
      workspaceId: opened.workspaceId,
      searchType: "content",
      query: "shared needle",
      literal: true,
      includeGlobs: ["**/*.txt", "**/*.md"],
      limit: 20,
    },
  }));
  assert.equal(response.matchCount, 2);
  assert.match(String(response.matchesJson), /alpha\.txt/);
  assert.match(String(response.matchesJson), /beta\.md/);
  assert.doesNotMatch(String(response.matchesJson), /gamma\.js/);
});

test("search_files excludes matching glob paths after search", async (t) => {
  const context = await fixture(t);
  await mkdir(join(context.project, "keep"), { recursive: true });
  await mkdir(join(context.project, "vendor"), { recursive: true });
  await writeFile(join(context.project, "keep", "alpha.txt"), "shared needle\n");
  await writeFile(join(context.project, "vendor", "beta.txt"), "shared needle\n");
  const opened = structuredContent(await callOpen(context.client, context.project, "search-excludes", "read"));
  const response = structuredContent(await context.client.callTool({
    name: "search_files",
    arguments: {
      workspaceId: opened.workspaceId,
      searchType: "content",
      query: "shared needle",
      literal: true,
      includeGlobs: ["**/*.txt"],
      excludeGlobs: ["vendor/**"],
      limit: 20,
    },
  }));
  assert.equal(response.matchCount, 1);
  assert.match(String(response.matchesJson), /keep\/alpha\.txt/);
  assert.doesNotMatch(String(response.matchesJson), /vendor\/beta\.txt/);
});

test("search_files filters extensions case-insensitively", async (t) => {
  const context = await fixture(t);
  await writeFile(join(context.project, "alpha.txt"), "shared needle\n");
  await writeFile(join(context.project, "beta.MD"), "shared needle\n");
  const opened = structuredContent(await callOpen(context.client, context.project, "search-extensions", "read"));
  const response = structuredContent(await context.client.callTool({
    name: "search_files",
    arguments: {
      workspaceId: opened.workspaceId,
      searchType: "content",
      query: "shared needle",
      literal: true,
      extensions: ["md"],
      limit: 20,
    },
  }));
  assert.equal(response.matchCount, 1);
  assert.match(String(response.matchesJson), /beta\.MD/);
  assert.doesNotMatch(String(response.matchesJson), /alpha\.txt/);
});

test("search_files filters results by inclusive file size", async (t) => {
  const context = await fixture(t);
  await mkdir(join(context.project, "nested"), { recursive: true });
  await writeFile(join(context.project, "nested", "small.txt"), "x\n");
  await writeFile(join(context.project, "nested", "large.txt"), "12345678901234567890\n");
  const opened = structuredContent(await callOpen(context.client, context.project, "search-size", "read"));
  const response = structuredContent(await context.client.callTool({
    name: "search_files",
    arguments: {
      workspaceId: opened.workspaceId,
      searchType: "name",
      query: "**/*.txt",
      path: "nested",
      minSizeBytes: 10,
      maxSizeBytes: 30,
      limit: 20,
    },
  }));
  assert.equal(response.matchCount, 1);
  assert.match(String(response.matchesJson), /large\.txt/);
  assert.doesNotMatch(String(response.matchesJson), /small\.txt/);
});

test("search_files filters by inclusive modified-time bounds", async (t) => {
  const context = await fixture(t);
  const oldPath = join(context.project, "old.txt");
  const newPath = join(context.project, "new.txt");
  await writeFile(oldPath, "old\n");
  await writeFile(newPath, "new\n");
  await utimes(oldPath, new Date("2024-01-01T00:00:00.000Z"), new Date("2024-01-01T00:00:00.000Z"));
  await utimes(newPath, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));
  const opened = structuredContent(await callOpen(context.client, context.project, "search-mtime", "read"));
  const response = structuredContent(await context.client.callTool({
    name: "search_files",
    arguments: {
      workspaceId: opened.workspaceId,
      searchType: "name",
      query: "**/*.txt",
      modifiedAfter: "2025-01-01T00:00:00.000Z",
      modifiedBefore: "2026-12-31T23:59:59.999Z",
      limit: 20,
    },
  }));
  assert.equal(response.matchCount, 1);
  assert.match(String(response.matchesJson), /new\.txt/);
  assert.doesNotMatch(String(response.matchesJson), /old\.txt/);
});

test("search_files sorts text and structured matches deterministically", async (t) => {
  const context = await fixture(t);
  await writeFile(join(context.project, "alpha.txt"), "a\n");
  await writeFile(join(context.project, "beta.txt"), "12345678901234567890\n");
  const opened = structuredContent(await callOpen(context.client, context.project, "search-sort", "read"));
  const response = structuredContent(await context.client.callTool({
    name: "search_files",
    arguments: {
      workspaceId: opened.workspaceId,
      searchType: "name",
      query: "**/*.txt",
      sortBy: "size",
      sortOrder: "desc",
      limit: 20,
    },
  }));
  const lines = String(response.result).split(/\r?\n/).filter(Boolean);
  const matches = JSON.parse(String(response.matchesJson)) as Array<{ path: string }>;
  assert.match(lines[0] ?? "", /beta\.txt/);
  assert.match(matches[0]?.path ?? "", /beta\.txt/);
});

test("search_files content mode skips binary files instead of force-decoding them", async (t) => {
  const context = await fixture(t);
  await writeFile(join(context.project, "plain.txt"), "needle in text\n");
  await writeFile(
    join(context.project, "binary.bin"),
    Buffer.from([0, 1, 2, 3, ...Buffer.from("needle in binary"), 0, 255]),
  );
  const opened = structuredContent(await callOpen(context.client, context.project, "search-binary", "read"));
  const response = structuredContent(await context.client.callTool({
    name: "search_files",
    arguments: {
      workspaceId: opened.workspaceId,
      searchType: "content",
      query: "needle",
      literal: true,
      limit: 20,
    },
  }));
  assert.equal(response.matchCount, 1);
  assert.match(String(response.matchesJson), /plain\.txt/);
  assert.doesNotMatch(String(response.matchesJson), /binary\.bin/);
});

test("search_files enforces a text output budget", async (t) => {
  const context = await fixture(t);
  const longLine = `needle ${"x".repeat(600)}`;
  await writeFile(
    join(context.project, "many-matches.txt"),
    Array.from({ length: 350 }, () => longLine).join("\n"),
  );
  const opened = structuredContent(await callOpen(context.client, context.project, "search-budget", "read"));
  const response = structuredContent(await context.client.callTool({
    name: "search_files",
    arguments: {
      workspaceId: opened.workspaceId,
      searchType: "content",
      query: "needle",
      literal: true,
      limit: 500,
    },
  }));
  assert.equal(response.truncated, true);
  assert.ok(String(response.result).length <= 120_000);
  assert.ok(String(response.matchesJson).length <= 180_000);
});

test("read-only filesystem tools reject intermediate links that escape the workspace", async (t) => {
  const context = await fixture(t);
  const outside = join(dirname(context.project), "outside-link-target");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.txt"), "outside secret\n");
  await symlink(
    outside,
    join(context.project, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const opened = structuredContent(await callOpen(context.client, context.project, "symlink-containment", "read"));
  const workspaceId = opened.workspaceId;

  const read = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "escape/secret.txt" },
  });
  assert.equal(read.isError, true);

  const listed = await context.client.callTool({
    name: "list_directory",
    arguments: { workspaceId, path: "escape" },
  });
  assert.equal(listed.isError, true);

  const searched = await context.client.callTool({
    name: "search_files",
    arguments: { workspaceId, searchType: "name", query: "**/*", path: "escape" },
  });
  assert.equal(searched.isError, true);

  const batch = structuredContent(await context.client.callTool({
    name: "batch_read_files",
    arguments: { workspaceId, paths: ["escape/secret.txt"] },
  }));
  assert.equal(batch.errorCount, 1);
  assert.doesNotMatch(String(batch.result), /outside secret/);

  const info = await context.client.callTool({
    name: "file_info",
    arguments: { workspaceId, path: "escape/secret.txt" },
  });
  assert.equal(info.isError, true);
});

test("list_directory returns bounded structured entries for read-only workspaces", async (t) => {
  const context = await fixture(t);
  await mkdir(join(context.project, "nested"), { recursive: true });
  await writeFile(join(context.project, "nested", "alpha.txt"), "alpha\n");
  await writeFile(join(context.project, "nested", "beta.txt"), "beta\n");
  const opened = structuredContent(await callOpen(context.client, context.project, "list-directory", "read"));
  const response = await context.client.callTool({
    name: "list_directory",
    arguments: {
      workspaceId: opened.workspaceId,
      path: "nested",
      limit: 1,
    },
  });
  const data = structuredContent(response);
  assert.equal(data.path, "nested");
  assert.equal(data.entryCount, 1);
  assert.equal(data.truncated, true);
  assert.match(String(data.entriesJson), /alpha\.txt/);
  assert.match(String(data.result), /\[file\] nested\/alpha\.txt/);
});

test("file_info reports file metadata and rejects traversal outside the workspace", async (t) => {
  const context = await fixture(t);
  await writeFile(join(context.project, "alpha.txt"), "alpha\n");
  const opened = structuredContent(await callOpen(context.client, context.project, "file-info", "read"));
  const ok = structuredContent(await context.client.callTool({
    name: "file_info",
    arguments: { workspaceId: opened.workspaceId, path: "alpha.txt" },
  }));
  assert.equal(ok.kind, "file");
  assert.equal(ok.sizeBytes, 6);
  assert.match(String(ok.infoJson), /"modifiedAt"/);

  const escaped = await context.client.callTool({
    name: "file_info",
    arguments: { workspaceId: opened.workspaceId, path: "../outside.txt" },
  });
  assert.equal(escaped.isError, true);
});

test("batch_read_files returns multiple text files and isolates per-file errors", async (t) => {
  const context = await fixture(t);
  await writeFile(join(context.project, "alpha.txt"), "alpha\nsecond\n");
  await writeFile(join(context.project, "beta.txt"), "beta\n");
  const opened = structuredContent(await callOpen(context.client, context.project, "batch-read", "read"));
  const response = structuredContent(await context.client.callTool({
    name: "batch_read_files",
    arguments: {
      workspaceId: opened.workspaceId,
      paths: ["alpha.txt", "missing.txt", "beta.txt"],
      limit: 1,
    },
  }));
  assert.equal(response.fileCount, 3);
  assert.equal(response.errorCount, 1);
  assert.equal(response.truncated, false);
  assert.match(String(response.filesJson), /alpha/);
  assert.match(String(response.filesJson), /missing\.txt/);
  assert.match(String(response.filesJson), /beta/);
});

test("batch_read_files enforces an aggregate output budget", async (t) => {
  const context = await fixture(t);
  const paths: string[] = [];
  for (let index = 0; index < 20; index++) {
    const name = `bulk-${index}.txt`;
    paths.push(name);
    await writeFile(
      join(context.project, name),
      Array.from({ length: 20 }, () => "x".repeat(1000)).join("\n"),
    );
  }
  const opened = structuredContent(await callOpen(context.client, context.project, "batch-budget", "read"));
  const response = structuredContent(await context.client.callTool({
    name: "batch_read_files",
    arguments: { workspaceId: opened.workspaceId, paths, limit: 20 },
  }));
  assert.equal(response.fileCount, 20);
  assert.equal(response.truncated, true);
  assert.ok(String(response.result).length <= 125_000);
  assert.ok(String(response.filesJson).length <= 130_000);
});

test("Computer Use exposes native desktop and trusted browser Codex CUA tools when the bridge is available", async (t) => {
  const context = await fixture(t, {
    computerUseEnabled: true,
    codexCua: {} as CodexCuaBridge,
  });
  const tools = await context.client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  assert.ok(names.includes("observe"));
  assert.ok(names.includes("computer"));
  assert.ok(names.includes("browser_state"));
  assert.ok(names.includes("browser_observe"));
  assert.ok(names.includes("browser_action"));

  const observe = tools.tools.find((tool) => tool.name === "observe");
  const computer = tools.tools.find((tool) => tool.name === "computer");
  const browserState = tools.tools.find((tool) => tool.name === "browser_state");
  const browserObserve = tools.tools.find((tool) => tool.name === "browser_observe");
  const browserAction = tools.tools.find((tool) => tool.name === "browser_action");
  assert.equal(observe?.annotations?.readOnlyHint, true);
  assert.equal(computer?.annotations?.readOnlyHint, false);
  assert.equal(browserState?.annotations?.readOnlyHint, true);
  assert.equal(browserObserve?.annotations?.readOnlyHint, true);
  assert.equal(browserAction?.annotations?.readOnlyHint, false);
  assert.equal(browserState?.annotations?.openWorldHint, true);
  assert.equal(browserAction?.annotations?.openWorldHint, true);
  assert.match(computer?.description ?? "", /elementIndex/i);
  assert.match(observe?.description ?? "", /accessibility tree/i);
  assert.match(browserState?.description ?? "", /trusted tab IDs/i);
  assert.match(browserObserve?.description ?? "", /trusted current tab URL/i);
});

test("browser_state forwards real ChatGPT MCP scope as Codex Browser Use turn metadata", async (t) => {
  const observedMetadata: Array<Record<string, unknown>> = [];
  const bridge = {
    getBrowserState: async (metadata: Record<string, unknown>) => {
      observedMetadata.push(metadata);
      return {
        value: {
          browsers: [{
            id: "2",
            name: "Chrome",
            family: "chrome",
            type: "extension",
            tabs: [{
              id: "625079855",
              title: "Tripo Studio",
              url: "https://studio.tripo3d.ai/zh",
            }],
          }],
        },
        images: [],
      };
    },
  } as unknown as CodexCuaBridge;
  const context = await fixture(t, {
    computerUseEnabled: true,
    codexCua: bridge,
  });
  const opened = structuredContent(await callOpen(context.client, context.project, "browser-chat-session"));
  const result = await context.client.callTool({
    name: "browser_state",
    arguments: { workspaceId: opened.workspaceId },
    _meta: { "openai/session": "browser-chat-session" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(result.isError, undefined);
  assert.equal(observedMetadata.length, 1);
  assert.equal(observedMetadata[0]?.session_id, "browser-chat-session");
  assert.match(String(observedMetadata[0]?.turn_id), /^\d+$/);
  assert.equal(observedMetadata[0]?.devspace_transport, "mcp");
  const data = structuredContent(result);
  assert.match(String(data.browsersJson), /studio\.tripo3d\.ai/);
});

test("Computer Use approval card tools expose model presentation and app-only submission surfaces", async (t) => {
  const approvals = new ComputerUseApprovals({ waitMs: 100, ttlMs: 1_000 });
  t.after(() => approvals.close());
  const context = await fixture(t, {
    computerUseEnabled: true,
    codexCua: {} as CodexCuaBridge,
    computerApprovals: approvals,
  });
  const tools = (await context.client.listTools()).tools;
  const show = tools.find((tool) => tool.name === "computer_approval_show");
  const wait = tools.find((tool) => tool.name === "computer_approval_wait");
  const submit = tools.find((tool) => tool.name === "computer_approval_submit");
  assert.ok(show);
  assert.ok(wait);
  assert.ok(submit);
  assert.equal(show.annotations?.readOnlyHint, true);
  assert.equal(wait.annotations?.readOnlyHint, false);
  assert.equal(submit.annotations?.readOnlyHint, false);
  assert.deepEqual((show._meta as any)?.ui?.visibility, ["model", "app"]);
  assert.deepEqual((submit._meta as any)?.ui?.visibility, ["app"]);
  assert.equal(wait.annotations?.destructiveHint, false);
});

test("UI metadata is limited to workspace, aggregate review and read-only supervisor", async (t) => {
  for (const uiEnabled of [true, false]) {
    await t.test(uiEnabled ? "enabled" : "disabled", async (nested) => {
      const context = await fixture(nested, { toolMode: "claude", uiEnabled });
      const tools = await context.client.listTools();
      const toolsWithUi = tools.tools
        .filter((tool) => Boolean((tool._meta as {
          ui?: { resourceUri?: string };
        } | undefined)?.ui?.resourceUri))
        .map((tool) => tool.name)
        .sort();

      assert.deepEqual(
        toolsWithUi,
        uiEnabled
          ? [
              "approve_workspace_access",
              "open_workspace",
              "request_workspace_access",
              "show_changes",
              "supervisor_summary",
            ]
          : [],
      );
      for (const tool of tools.tools.filter((candidate) =>
        Boolean((candidate._meta as {
          ui?: { resourceUri?: string };
        } | undefined)?.ui?.resourceUri),
      )) {
        const meta = tool._meta as {
          ui?: { visibility?: string[] };
          "openai/widgetAccessible"?: boolean;
        };
        assert.deepEqual(
          meta.ui?.visibility,
          tool.name === "approve_workspace_access" ? ["app"] : ["model", "app"],
        );
        assert.equal(meta["openai/widgetAccessible"], true);
      }
      const approvalTool = tools.tools.find((tool) => tool.name === "approve_workspace_access");
      const approvalUi = (approvalTool?._meta as {
        ui?: { resourceUri?: string; visibility?: string[] };
      } | undefined)?.ui;
      const visibility = approvalUi?.visibility;
      assert.deepEqual(visibility, uiEnabled ? ["app"] : undefined);
      assert.equal(
        approvalUi?.resourceUri,
        uiEnabled ? "ui://devspace/workspace-app.html" : undefined,
      );
      assert.equal(
        (approvalTool?._meta as { "openai/visibility"?: string } | undefined)?.[
          "openai/visibility"
        ],
        uiEnabled ? "private" : undefined,
      );
      assert.equal(
        (approvalTool?._meta as { "openai/widgetAccessible"?: boolean } | undefined)?.[
          "openai/widgetAccessible"
        ],
        uiEnabled ? true : undefined,
      );
      assert.equal(approvalTool?.annotations?.readOnlyHint, false);
      assert.equal(approvalTool?.annotations?.destructiveHint, false);
    });
  }
});

test("open_workspace reports aggregate review availability", async (t) => {
  const plain = await fixture(t);
  const gitWorkspace = await fixture(t, { git: true });

  const plainReview = structuredContent(await callOpen(plain.client, plain.project, "plain")).review;
  const gitReview = structuredContent(await callOpen(gitWorkspace.client, gitWorkspace.project, "git")).review;

  assert.equal((plainReview as { available: boolean }).available, false);
  assert.deepEqual(gitReview, { available: true });
});

test("show_changes keeps model output compact and preserves the rich review card", async (t) => {
  const context = await fixture(t, { git: true, uiEnabled: false });
  const opened = structuredContent(
    await callOpen(context.client, context.project, "review"),
  );
  const workspaceId = opened.workspaceId;
  assert.equal(typeof workspaceId, "string");

  await writeFile(join(context.project, "README.md"), "goodbye\n");
  const review = await context.client.callTool({
    name: "show_changes",
    arguments: { workspaceId },
  });
  const structured = structuredContent(review);
  assert.equal((review._meta as Record<string, unknown> | undefined)?.tool, undefined);

  assert.equal(structured.workspaceId, workspaceId);
  assert.match(structured.reviewRef as string, /^[0-9a-f]{40,64}$/);
  assert.equal("summary" in structured, false);
  assert.equal("files" in structured, false);
  assert.equal("patch" in structured, false);

  const card = responseCard(review);
  assert.deepEqual(card.summary, {
    files: 1,
    additions: 1,
    removals: 1,
  });
  assert.deepEqual(card.files, [
    {
      path: "README.md",
      type: "change",
      additions: 1,
      removals: 1,
    },
  ]);
  assert.match(
    ((card.payload as { patch?: string } | undefined)?.patch) ?? "",
    /-hello\n\+goodbye/,
  );

  const tools = await context.client.listTools();
  const outputProperties = tools.tools.find((tool) => tool.name === "show_changes")
    ?.outputSchema?.properties;
  assert.ok(outputProperties && "workspaceId" in outputProperties);
  assert.ok(outputProperties && "reviewRef" in outputProperties);
  assert.equal(outputProperties && "summary" in outputProperties, false);
  assert.equal(outputProperties && "files" in outputProperties, false);
  assert.equal(outputProperties && "patch" in outputProperties, false);
  const inputProperties = tools.tools.find((tool) => tool.name === "show_changes")
    ?.inputSchema?.properties;
  assert.equal(inputProperties && "reviewRef" in inputProperties, false);
});

test("show_changes can reopen a historical review without advancing the checkpoint", async (t) => {
  const context = await fixture(t, { git: true });
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "review-history"),
  ).workspaceId;
  assert.equal(typeof workspaceId, "string");

  await writeFile(join(context.project, "README.md"), "first\n");
  const first = structuredContent(await context.client.callTool({
    name: "show_changes",
    arguments: { workspaceId },
  }));
  const reviewRef = first.reviewRef;
  assert.equal(typeof reviewRef, "string");

  await writeFile(join(context.project, "README.md"), "second\n");
  const reopened = await context.client.callTool({
    name: "show_changes",
    arguments: { workspaceId },
    _meta: { "devspace/reviewRef": reviewRef },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(structuredContent(reopened).reviewRef, reviewRef);
  assert.match(
    (((responseCard(reopened).payload as { patch?: string } | undefined)?.patch) ?? ""),
    /\+first/,
  );

  const current = await context.client.callTool({
    name: "show_changes",
    arguments: { workspaceId },
  });
  assert.match(
    (((responseCard(current).payload as { patch?: string } | undefined)?.patch) ?? ""),
    /-first\n\+second/,
  );
});

test("open_workspace keeps lifecycle flags out of model output and preserves complete card metadata", async (t) => {
  const providerNote = "available";
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true, note: providerNote }],
  });
  const first = await callOpen(context.client, context.project, "chat-1");
  const repeated = await callOpen(context.client, context.project, "chat-1");
  assert.equal((first._meta as Record<string, unknown> | undefined)?.tool, undefined);
  assert.equal((repeated._meta as Record<string, unknown> | undefined)?.tool, undefined);

  const tools = await context.client.listTools();
  const openTool = tools.tools.find((tool) => tool.name === "open_workspace");
  const outputProperties = (openTool?.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  const inputRequired = (openTool?.inputSchema as { required?: string[] } | undefined)?.required ?? [];
  assert.ok(inputRequired.includes("path"));
  assert.ok(inputRequired.includes("access"));
  assert.equal(outputProperties && "workspaceReused" in outputProperties, false);
  assert.equal(outputProperties && "includeBootstrapContext" in outputProperties, false);
  const providerSchema = outputProperties?.agentProviders as {
    items?: { properties?: Record<string, unknown> };
  } | undefined;
  assert.ok(providerSchema?.items?.properties?.note);

  const firstStructured = structuredContent(first);
  assert.equal(firstStructured.workspaceId, structuredContent(repeated).workspaceId);
  assert.ok(Array.isArray(firstStructured.agentsFiles));
  assert.ok(Array.isArray(firstStructured.availableAgentsFiles));
  assert.ok(Array.isArray(firstStructured.skills));
  assert.ok(Array.isArray(firstStructured.agentProviders));
  assert.equal(
    (firstStructured.agentProviders as Array<Record<string, unknown>>)[0]?.id,
    "codex",
  );
  assert.equal(
    (firstStructured.agentProviders as Array<Record<string, unknown>>)[0]?.note,
    providerNote,
  );
  assert.ok(Array.isArray(firstStructured.agents));
  assert.ok(Array.isArray(firstStructured.skillDiagnostics));
  assert.equal("workspaceReused" in firstStructured, false);
  assert.equal("includeBootstrapContext" in firstStructured, false);

  const repeatedStructured = structuredContent(repeated);
  assert.equal(repeatedStructured.agentsFiles, undefined);
  assert.equal(repeatedStructured.availableAgentsFiles, undefined);
  assert.equal(repeatedStructured.skills, undefined);
  assert.equal(repeatedStructured.agentProviders, undefined);
  assert.equal(repeatedStructured.agents, undefined);
  assert.equal(repeatedStructured.skillDiagnostics, undefined);
  assert.equal("workspaceReused" in repeatedStructured, false);
  assert.equal("includeBootstrapContext" in repeatedStructured, false);

  const card = responseCard(repeated);
  assert.equal(card.workspaceReused, true);
  assert.equal(card.includeBootstrapContext, false);
  assert.ok(Array.isArray(card.agentsFiles));
  assert.ok(Array.isArray(card.availableAgentsFiles));
  assert.ok(Array.isArray(card.skills));
  assert.ok(Array.isArray(card.agentProviders));
  assert.equal(
    (card.agentProviders as Array<Record<string, unknown>>)[0]?.note,
    providerNote,
  );
  assert.ok(Array.isArray(card.agents));
});

test("open_workspace refreshes provider availability for each catalog", async (t) => {
  let available = false;
  const context = await fixture(t, {
    localAgentProviders: () => [{ name: "codex", available }],
  });

  const unavailable = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  assert.deepEqual(unavailable.agentProviders, []);
  assert.deepEqual(unavailable.agents, []);

  available = true;
  const usable = structuredContent(await callOpen(context.client, context.project, "chat-2"));
  assert.equal(
    (usable.agentProviders as Array<Record<string, unknown>>)[0]?.id,
    "codex",
  );
  assert.equal(
    (usable.agents as Array<Record<string, unknown>>)[0]?.name,
    "reviewer",
  );
});

test("open_workspace omits providers disabled by configuration", async (t) => {
  const context = await fixture(t, {
    localAgentProviders: [
      { name: "codex", available: true },
      { name: "claude", available: true },
    ],
    subagents: {
      enabled: true,
      providers: [
        { id: "codex", enabled: true },
        { id: "claude", enabled: false },
      ],
    },
  });

  const opened = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  assert.deepEqual(
    (opened.agentProviders as Array<Record<string, unknown>>).map((provider) => provider.id),
    ["codex"],
  );
});

test("open_workspace scopes checkout reuse to OpenAI session metadata", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const repeated = await callOpen(context.client, context.project, "chat-1");
  const otherSession = await callOpen(context.client, context.project, "chat-2");
  const unscoped = await callOpen(context.client, context.project);

  assert.equal(structuredContent(repeated).workspaceId, structuredContent(first).workspaceId);
  assert.equal(structuredContent(repeated).agentsFiles, undefined);
  assert.notEqual(structuredContent(otherSession).workspaceId, structuredContent(first).workspaceId);
  assert.notEqual(structuredContent(unscoped).workspaceId, structuredContent(first).workspaceId);
  assert.ok(Array.isArray(structuredContent(otherSession).agentsFiles));
  assert.ok(Array.isArray(structuredContent(unscoped).agentsFiles));
});

test("every host-facing tool declares a complete safety annotation set", async (t) => {
  for (const toolMode of ["claude", "codex"] as const) {
    await t.test(toolMode, async (nested) => {
      const context = await fixture(nested, { toolMode, uiEnabled: true });
      const tools = await context.client.listTools();

      for (const tool of tools.tools) {
        assert.equal(
          typeof tool.annotations?.readOnlyHint,
          "boolean",
          `${tool.name} must declare readOnlyHint`,
        );
        assert.equal(
          typeof tool.annotations?.destructiveHint,
          "boolean",
          `${tool.name} must declare destructiveHint`,
        );
        assert.equal(
          typeof tool.annotations?.openWorldHint,
          "boolean",
          `${tool.name} must declare openWorldHint`,
        );
      }
    });
  }
});

test("folder access requires a human-card token and enforces read-only workspaces", async (t) => {
  const context = await fixture(t, { toolMode: "claude", uiEnabled: true });
  const externalProject = join(dirname(context.project), "external-project");
  await mkdir(externalProject, { recursive: true });

  const request = await context.client.callTool({
    name: "request_workspace_access",
    arguments: {
      path: externalProject,
      access: "read",
      reason: "Inspect this separate project",
    },
    _meta: { "openai/session": "chat-access" },
  } as Parameters<Client["callTool"]>[0]);
  const publicRequest = structuredContent(request);
  assert.equal(publicRequest.status, "pending");
  assert.equal(JSON.stringify(publicRequest).includes("approvalToken"), false);
  const card = responseCard(request);
  assert.equal(card.tool, "request_workspace_access");
  assert.match(card.approvalToken as string, /^[A-Za-z0-9_-]{40,}$/);

  const decision = await context.client.callTool({
    name: "approve_workspace_access",
    arguments: {
      requestId: publicRequest.requestId,
      approvalToken: card.approvalToken,
      decision: "session",
    },
    _meta: { "openai/session": "chat-access" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(structuredContent(decision).status, "approved");

  const upgradeRequest = await callOpen(
    context.client,
    externalProject,
    "chat-access",
  );
  const upgradeCard = responseCard(upgradeRequest);
  assert.equal(upgradeCard.status, "pending");
  assert.equal(upgradeCard.requestedAccess, "modify");

  const opened = structuredContent(
    await callOpen(context.client, externalProject, "chat-access", "read"),
  );
  assert.equal(opened.accessMode, "read");
  const deniedWrite = await context.client.callTool({
    name: "write",
    arguments: {
      workspaceId: opened.workspaceId,
      path: "blocked.txt",
      content: "must not be written",
    },
  });
  assert.equal(deniedWrite.isError, true);
  const deniedContent = deniedWrite.content as Array<{ type: string; text?: string }>;
  assert.match(
    deniedContent
      .filter((item): item is { type: "text"; text: string } => (
        item.type === "text" && typeof item.text === "string"
      ))
      .map((item) => item.text)
      .join("\n"),
    /read-only/i,
  );
});

test("open_workspace automatically returns a permission card for an outside folder", async (t) => {
  const context = await fixture(t, { uiEnabled: true });
  const externalProject = join(dirname(context.project), "automatic-access-project");
  await mkdir(externalProject, { recursive: true });

  const requested = await callOpen(context.client, externalProject, "chat-auto-access");
  assert.equal(requested.isError, undefined);
  assert.equal(structuredContent(requested).status, "pending");
  const card = responseCard(requested);
  assert.equal(card.tool, "request_workspace_access");
  assert.equal(card.status, "pending");
  assert.equal(card.path, externalProject);
  assert.equal(card.requestedAccess, "modify");
  assert.match(card.approvalToken as string, /^[A-Za-z0-9_-]{40,}$/);

  const decision = await context.client.callTool({
    name: "approve_workspace_access",
    arguments: {
      requestId: card.requestId,
      approvalToken: card.approvalToken,
      decision: "session",
    },
    _meta: { "openai/session": "chat-auto-access" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(structuredContent(decision).status, "approved");

  const opened = structuredContent(
    await callOpen(context.client, externalProject, "chat-auto-access"),
  );
  assert.equal(opened.root, externalProject);
  assert.equal(opened.accessMode, "modify");
});

interface ServerFixture {
  client: Client;
  project: string;
}

async function fixture(
  t: TestContext,
  options: {
    git?: boolean;
    localAgentProviders?: LocalAgentProviderAvailability[] | (() => LocalAgentProviderAvailability[]);
    subagents?: SubagentsConfig;
    toolMode?: ToolMode;
    uiEnabled?: boolean;
    computerUseEnabled?: boolean;
    codexCua?: CodexCuaBridge;
    computerApprovals?: ComputerUseApprovals;
  } = {},
): Promise<ServerFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-server-test-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const stateDir = join(root, ".state");

  await mkdir(join(project, ".devspace", "agents"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(project, "AGENTS.md"), "project instructions\n");
  await writeFile(join(project, ".devspace", "agents", "reviewer.md"), [
    "---",
    "name: reviewer",
    "description: Reviews project changes.",
    "provider: codex",
    "---",
    "Review changes.",
  ].join("\n"));

  if (options.git) {
    await writeFile(join(project, "README.md"), "hello\n");
    await git(project, ["init"]);
    await git(project, ["config", "user.email", "devspace@example.com"]);
    await git(project, ["config", "user.name", "DevSpace Test"]);
    await git(project, ["add", "."]);
    await git(project, ["commit", "-m", "Initial commit"]);
  }

  const initialProviderAvailability = typeof options.localAgentProviders === "function"
    ? options.localAgentProviders()
    : options.localAgentProviders ?? [];
  const loadedConfig = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
    server: { port: 1 },
    workspaces: { allowedRoots: [project], worktreeRoot: join(root, ".worktrees") },
    storage: { stateDir },
    skills: { agentDir },
    subagents: { enabled: options.localAgentProviders !== undefined, providers: [] },
  }));
  const modeConfig: ServerConfig = {
    ...loadedConfig,
    toolMode: options.toolMode ?? loadedConfig.toolMode,
    uiEnabled: options.uiEnabled ?? loadedConfig.uiEnabled,
    computerUseEnabled: options.computerUseEnabled ?? loadedConfig.computerUseEnabled,
  };
  const config: ServerConfig = options.localAgentProviders
    ? {
        ...modeConfig,
        subagents: options.subagents ?? {
          enabled: true,
          providers: initialProviderAvailability.map((provider) => ({
            id: provider.name,
            enabled: true,
          })),
        },
      }
    : modeConfig;
  const resolveProviderAvailability: () => LocalAgentProviderAvailability[] =
    typeof options.localAgentProviders === "function"
      ? options.localAgentProviders
      : () => initialProviderAvailability;
  const resolveLocalAgentProviders = () => buildLocalAgentProviderStatuses(
    config.subagents,
    resolveProviderAvailability(),
  );
  const store = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, store);
  const orchestration = new OrchestrationRegistry(new OrchestrationStore(stateDir));
  const coordinator = new OrchestrationCoordinator(
    new CoordinatorStore(stateDir),
    orchestration,
  );
  const workspaceAccess = new WorkspaceAccessManager(config, {
    persistAllowedRoots: (roots) => {
      config.allowedRoots.splice(0, config.allowedRoots.length, ...roots);
    },
  });
  const orchestrationV2 = new OrchestrationV2(config, orchestration, coordinator, workspaces, workspaceAccess);
  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    resolveLocalAgentProviders,
    [],
    workspaceAccess,
    undefined,
    undefined,
    undefined,
    undefined,
    options.codexCua,
    options.computerApprovals ? { service: options.computerApprovals, html: "<!doctype html><html></html>", scope: "devspace" } : undefined,
    orchestration,
    coordinator,
    orchestrationV2,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devspace-test-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close();
    await server.close();
    orchestrationV2.close();
    coordinator.close();
    orchestration.close();
    workspaceAccess.close();
    store.close();
  };

  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  return { client, project };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function callOpen(
  client: Client,
  path: string,
  conversationScopeId?: string,
  access?: "read" | "modify",
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const explicitAccess=access ?? "modify";
  const params = {
    name: "open_workspace",
    arguments: { path, access: explicitAccess },
    ...(conversationScopeId
      ? { _meta: { "openai/session": conversationScopeId } }
      : {}),
  } as Parameters<Client["callTool"]>[0];
  return client.callTool(params);
}

function structuredContent(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

function responseCard(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const metadata = result._meta;
  assert.ok(metadata && typeof metadata === "object");
  const card = (metadata as Record<string, unknown>).card;
  assert.ok(card && typeof card === "object");
  return card as Record<string, unknown>;
}
