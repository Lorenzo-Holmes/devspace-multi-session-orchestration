import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OrchestrationV2 } from "./orchestration-v2.js";
import { projectKeyForWorkspace } from "./orchestration-scope.js";
import { LOCAL_STATE_TOOL_ANNOTATIONS, READ_TOOL_ANNOTATIONS } from "./tool-surfaces/types.js";
import { resultOutputSchema, textBlock } from "./tool-surfaces/shared.js";
import { integrationUpdateSchema } from "./orchestration-integration.js";
import { handoffInputSchema } from "./orchestration-handoff.js";
import { memoryPatchSchema } from "./orchestration-memory.js";
import { readFile } from "node:fs/promises";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { supervisorSummary, supervisorSummarySchema } from "./orchestration-supervisor.js";

export const ORCHESTRATION_V2_TOOLS = ["worktree_provision", "worktree_binding_list", "worktree_cleanup_status",
  "integration_create", "integration_status", "integration_list", "integration_update", "integration_gate",
  "watchdog_scan", "watchdog_alert_list", "watchdog_alert_ack",
  "handoff_create", "handoff_list", "handoff_status", "handoff_ack",
  "project_memory_get", "project_memory_update", "supervisor_summary",
  "automation_due_list", "automation_poll", "automation_ack"];
const id = z.string().min(1).max(200);
const revision = z.number().int().positive();
const page = { limit: z.number().int().min(1).max(200).default(100), after: z.string().max(200).default("") };

export function registerOrchestrationV2Tools(server: McpServer, v2: OrchestrationV2, uiEnabled = true): void {
  const register = <S extends z.ZodRawShape>(name: string, description: string, schema: S, readOnly: boolean,
    handler: (project: string, args: z.output<z.ZodObject<S>>, workspaceId: string) => unknown | Promise<unknown>) => {
    const inputSchema: z.ZodRawShape = { workspaceId: id, ...schema };
    server.registerTool(name, {
      title: name.replaceAll("_", " "), description,
      inputSchema,
      outputSchema: resultOutputSchema({ dataJson: z.string() }),
      annotations: readOnly ? READ_TOOL_ANNOTATIONS : LOCAL_STATE_TOOL_ANNOTATIONS,
    }, async (args) => {
      const workspace = v2.workspaces.getWorkspace(z.object({ workspaceId: id }).parse(args).workspaceId, { touch: !readOnly });
      v2.access.assertWorkspaceReadable(workspace);
      const data = await handler(projectKeyForWorkspace(workspace), z.object(schema).parse(args), workspace.id);
      const dataJson = JSON.stringify(data);
      if (Buffer.byteLength(dataJson) > 256 * 1024) throw new Error("Result exceeds 256 KiB output bound; reduce list limit and follow the last record id as cursor.");
      const result = name + " completed.";
      return { content: [textBlock(result)], structuredContent: { result, dataJson } };
    });
  };
  register("worktree_provision", "Provision or recover one managed worktree for a valid fenced coordinator lease. Reuses WorkspaceRegistry; preserves dirty source, never deletes, resets, cleans, stashes or merges.",
    { taskId: id, sessionId: id, leaseToken: id, expectedRevision: revision, baseRef: z.string().min(1).max(200).optional() }, false,
    (_p, a, w) => v2.bindings.provision(v2.workspaces.getWorkspace(w), a));
  register("worktree_binding_list", "Read durable project worktree bindings, with bounded cursor pagination.", page, true,
    (p, a) => v2.bindings.list(p, a.limit, a.after));
  register("worktree_cleanup_status", "Record cleanup eligibility for a terminal task. No files or worktrees are deleted.",
    { taskId: id, expectedRevision: revision }, false, (p, a) => v2.bindings.cleanup(p, a.taskId, a.expectedRevision));
  register("integration_create", "Create durable review metadata for a task worktree. Never merges, rebases, cherry-picks or pushes.",
    { taskId: id, sessionId: id, candidateRef: integrationUpdateSchema.shape.candidateRef, targetRef: integrationUpdateSchema.shape.targetRef }, false,
    (p, a) => v2.integrations.create(p, a.taskId, a.sessionId, a.candidateRef, a.targetRef));
  register("integration_status", "Read the last integration gate snapshot; checkedAt identifies its freshness.", { integrationId: id }, true,
    (p, a) => v2.integrations.get(p, a.integrationId));
  register("integration_list", "List project integration records with bounded cursor pagination.", page, true,
    (p, a) => v2.integrations.list(p, a.limit, a.after));
  register("integration_update", "CAS update of explicit review/evidence metadata. Evidence IDs must refer to execution-issued validation evidence in the bound session; callers cannot pair arbitrary events with commits. Invalidates previous gates.",
    { integrationId: id, expectedRevision: revision, ...integrationUpdateSchema.shape }, false,
    (p, a) => v2.integrations.update(p, a.integrationId, a.expectedRevision, a));
  register("integration_gate", "Read actual Git state and evaluate gates; persist the review snapshot only. No project writes or Git integration operations.",
    { integrationId: id, expectedRevision: revision }, false, (p, a) => v2.integrations.gate(p, a.integrationId, a.expectedRevision));
  register("watchdog_scan", "Compute and persist deduplicated alerts from durable state. Never calls models, retries, kills, merges, edits project files or changes permissions.", {}, false,
    p => v2.watchdog.scan(p));
  register("watchdog_alert_list", "Read durable project watchdog alerts with cursor pagination.", page, true,
    (p, a) => v2.watchdog.list(p, a.limit, a.after));
  register("watchdog_alert_ack", "Idempotently acknowledge a durable alert using revision CAS. No repair actions.",
    { alertId: id, expectedRevision: revision }, false, (p, a) => v2.watchdog.acknowledge(p, a.alertId, a.expectedRevision));
  register("handoff_create", "Persist a bounded project handoff checkpoint. No message is sent to another conversation and this is not proof a worker is alive.",
    handoffInputSchema.shape, false, (p, a) => v2.handoffs.create(p, a));
  register("handoff_list", "Read project handoff checkpoints with cursor pagination.", page, true, (p, a) => v2.handoffs.list(p, a.limit, a.after));
  register("handoff_status", "Read one scoped handoff checkpoint.", { handoffId: id }, true, (p, a) => v2.handoffs.get(p, a.handoffId));
  register("handoff_ack", "Receiver acknowledgement with revision CAS and idempotent replay. Updates handoff metadata only.",
    { handoffId: id, sessionId: id, expectedRevision: revision }, false,
    (p, a) => v2.handoffs.acknowledge(p, a.handoffId, a.sessionId, a.expectedRevision));
  register("project_memory_get", "Read explicit project objective and memory. Missing records return revision 0 without creating state.", {}, true, p => v2.memory.get(p));
  register("project_memory_update", "CAS update of explicitly supplied project state only. Use expectedRevision 0 to create; no inference from private chats or personal data.",
    { expectedRevision: z.number().int().nonnegative(), ...memoryPatchSchema.shape }, false,
    (p, a) => v2.memory.update(p, a.expectedRevision, a));
  register("automation_due_list", "Read durable due notifications without scanning or execution. Follow nextCursor even when a filtered page is empty.", page, true,
    (p, a) => v2.automation.dueList(p, a.limit, a.after));
  register("automation_poll", "Idempotently reconcile bounded due notifications from project state for an external scheduler. No model, ChatGPT, thread, task execution or repair is started. Follow nextCursor; repeat later on truncated input.", page, false,
    (p, a) => v2.automation.poll(p, a.limit, a.after));
  register("automation_ack", "Acknowledge one delivered notification with revision CAS and consumer identity. Retry the same acknowledgement after an uncertain response.",
    { notificationId: id, expectedRevision: revision, consumer: z.string().trim().min(1).max(100) }, false,
    (p, a) => v2.automation.acknowledge(p, a.notificationId, a.expectedRevision, a.consumer));
  const uri = "ui://devspace/supervisor-v2.html";
  if (uiEnabled) registerAppResource(server, "DevSpace Supervisor", uri, { description: "Read-only project supervision with expandable timelines." }, async () => ({
    contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: await readFile(new URL("../dist/supervisor.html", import.meta.url), "utf8"),
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } } }],
  }));
  server.registerTool("supervisor_summary", {
    title: "Read project supervisor dashboard", description: "Read a bounded project snapshot and expandable session/task timelines. Does not update heartbeat, scan alerts, claim tasks, merge, retry, kill, spawn workers, edit files or grant permissions. Counts cover at most 500 records per collection; truncated signals partial output.",
    inputSchema: { workspaceId: id }, outputSchema: resultOutputSchema({ summary: supervisorSummarySchema }),
    annotations: READ_TOOL_ANNOTATIONS, _meta: uiEnabled ? { ui: { resourceUri: uri, visibility: ["model", "app"] }, "openai/widgetAccessible": true, "openai/outputTemplate": uri } : undefined,
  }, async ({ workspaceId }) => {
    const workspace = v2.workspaces.getWorkspace(workspaceId, { touch: false });
    v2.access.assertWorkspaceReadable(workspace);
    const summary = supervisorSummary(v2, projectKeyForWorkspace(workspace));
    const result = "Read-only supervisor snapshot.";
    return { content: [textBlock(result)], structuredContent: { result, summary } };
  });
}
