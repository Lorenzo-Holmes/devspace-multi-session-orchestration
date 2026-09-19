import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { detectOrchestrationConflicts } from "./orchestration-conflicts.js";
import { deriveOrchestrationHealth } from "./orchestration-health.js";
import { OrchestrationRegistry } from "./orchestration-registry.js";
import { orchestrationSessionStates, type OrchestrationSession } from "./orchestration-store.js";
import { openAiConversationScopeId } from "./request-meta.js";
import { projectKeyForWorkspace } from "./orchestration-scope.js";
import { contentText, resultOutputSchema, textBlock } from "./tool-surfaces/shared.js";
import { LOCAL_STATE_TOOL_ANNOTATIONS, READ_TOOL_ANNOTATIONS, workspaceIdDescription } from "./tool-surfaces/types.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import type { WorkspaceAccessManager } from "./workspace-access.js";

const sessionStateSchema = z.enum(orchestrationSessionStates);

export function registerOrchestrationTools(
  server: McpServer,
  registry: OrchestrationRegistry,
  workspaces: WorkspaceRegistry,
  workspaceAccess: WorkspaceAccessManager,
): void {
  server.registerTool(
    "session_register",
    {
      title: "Register orchestration session",
      description: "Register this worker/chat in DevSpace's durable local orchestration registry. This changes coordination metadata only; it does not start or wake a model, run commands, modify project files, or grant permissions.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        sessionKind: z.string().min(1).max(80).optional(),
        externalSessionId: z.string().min(1).max(300).optional().describe("Optional stable external conversation/thread ID. If omitted, DevSpace uses trusted OpenAI conversation metadata when available."),
        label: z.string().max(200).optional(),
        task: z.string().max(2000).optional(),
        state: sessionStateSchema.optional(),
      },
      outputSchema: resultOutputSchema({ sessionJson: z.string(), reused: z.boolean() }),
      annotations: LOCAL_STATE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, sessionKind, externalSessionId, label, task, state }, { _meta }) => {
      const workspace = readableWorkspace(workspaces, workspaceAccess, workspaceId);
      const projectKey = projectKeyForWorkspace(workspace);
      const trustedConversationId = openAiConversationScopeId(_meta);
      const kind = sessionKind ?? (trustedConversationId ? "chatgpt" : "manual");
      const externalId = externalSessionId ?? trustedConversationId;
      const before = externalId ? registry.list({ projectKey, limit: 500 }).find(
        (item) => item.sessionKind === kind && item.externalSessionId === externalId,
      ) : undefined;
      const session = registry.register({
        projectKey,
        workspaceId: workspace.id,
        workspaceRoot: workspace.root,
        sessionKind: kind,
        externalSessionId: externalId,
        label,
        task,
        state: state ?? "running",
      });
      const reused = Boolean(before && before.id === session.id);
      const result = reused ? `Reused orchestration session ${session.id}.` : `Registered orchestration session ${session.id}.`;
      return { content: [textBlock(result)], structuredContent: { result, sessionJson: JSON.stringify(session), reused } };
    },
  );

  server.registerTool(
    "session_heartbeat",
    {
      title: "Record session heartbeat",
      description: "Record a durable local heartbeat for an orchestration session. A heartbeat is metadata only: it does not prove model liveness, wake a Chat turn, start a model, run commands, or keep a host request alive.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        sessionId: z.string().min(1).max(100),
        note: z.string().max(1000).optional(),
      },
      outputSchema: resultOutputSchema({ sessionJson: z.string() }),
      annotations: LOCAL_STATE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, sessionId, note }) => {
      const scope = scopedSession(registry, workspaces, workspaceAccess, workspaceId, sessionId);
      const session = registry.heartbeat(scope.session.id, { detail: note ? { note } : {} });
      const result = `Recorded local heartbeat for ${session.id}. This does not assert model liveness.`;
      return { content: [textBlock(result)], structuredContent: { result, sessionJson: JSON.stringify(session) } };
    },
  );

  server.registerTool(
    "session_update",
    {
      title: "Update orchestration session metadata",
      description: "Update orchestration state/task/label/file intents only. This never modifies project files, runs processes, merges branches, starts models, or changes workspace permissions.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        sessionId: z.string().min(1).max(100),
        state: sessionStateSchema.optional(),
        task: z.string().max(2000).optional(),
        label: z.string().max(200).optional(),
        fileIntents: z.array(z.object({
          path: z.string().min(1).max(500),
          access: z.enum(["read", "write"]),
        })).max(200).optional(),
      },
      outputSchema: resultOutputSchema({ sessionJson: z.string(), intentsJson: z.string() }),
      annotations: LOCAL_STATE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, sessionId, state, task, label, fileIntents }) => {
      const scope = scopedSession(registry, workspaces, workspaceAccess, workspaceId, sessionId);
      if (state === undefined && task === undefined && label === undefined && fileIntents === undefined) {
        throw new Error("At least one orchestration metadata field is required.");
      }
      let session = scope.session;
      if (state !== undefined || task !== undefined || label !== undefined) {
        session = registry.setState(sessionId, state ?? session.state, { task, label });
      }
      const intents = fileIntents === undefined ? registry.fileIntents(sessionId) : registry.setFileIntents(sessionId, fileIntents);
      const result = `Updated orchestration metadata for ${sessionId}.`;
      return {
        content: [textBlock(result)],
        structuredContent: { result, sessionJson: JSON.stringify(session), intentsJson: JSON.stringify(intents) },
      };
    },
  );

  server.registerTool(
    "session_list",
    {
      title: "List orchestration sessions",
      description: "List durable sessions for the current project scope with derived read-only health. Does not inspect or alter other projects.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        states: z.array(sessionStateSchema).max(orchestrationSessionStates.length).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      outputSchema: resultOutputSchema({ sessionsJson: z.string(), count: z.number().int().nonnegative() }),
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, states, limit }) => {
      const workspace = readableWorkspace(workspaces, workspaceAccess, workspaceId);
      const sessions = registry.list({ projectKey: projectKeyForWorkspace(workspace), states, limit: limit ?? 100 });
      const enriched = sessions.map((session) => ({ session, health: deriveOrchestrationHealth(session) }));
      const result = `${sessions.length} orchestration session(s) in project scope.`;
      return { content: [textBlock(result)], structuredContent: { result, sessionsJson: JSON.stringify(enriched), count: sessions.length } };
    },
  );

  server.registerTool(
    "session_status",
    {
      title: "Read orchestration session status",
      description: "Read one durable session, its derived health, and declared file intents within the current project scope.",
      inputSchema: { workspaceId: z.string().describe(workspaceIdDescription), sessionId: z.string().min(1).max(100) },
      outputSchema: resultOutputSchema({ sessionJson: z.string(), healthJson: z.string(), intentsJson: z.string() }),
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, sessionId }) => {
      const { session } = scopedSession(registry, workspaces, workspaceAccess, workspaceId, sessionId);
      const health = deriveOrchestrationHealth(session);
      const intents = registry.fileIntents(sessionId);
      const result = `${session.id}: ${session.state}; health=${health.primary}.`;
      return { content: [textBlock(result)], structuredContent: { result, sessionJson: JSON.stringify(session), healthJson: JSON.stringify(health), intentsJson: JSON.stringify(intents) } };
    },
  );

  server.registerTool(
    "session_events",
    {
      title: "Read orchestration session events",
      description: "Read bounded append-only orchestration events for one session in the current project scope.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        sessionId: z.string().min(1).max(100),
        limit: z.number().int().min(1).max(500).optional(),
      },
      outputSchema: resultOutputSchema({ eventsJson: z.string(), count: z.number().int().nonnegative() }),
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, sessionId, limit }) => {
      scopedSession(registry, workspaces, workspaceAccess, workspaceId, sessionId);
      const events = registry.events(sessionId, limit ?? 100);
      const result = `${events.length} orchestration event(s) for ${sessionId}.`;
      return { content: [textBlock(result)], structuredContent: { result, eventsJson: JSON.stringify(events), count: events.length } };
    },
  );

  server.registerTool(
    "session_health",
    {
      title: "Analyze orchestration session health",
      description: "Derive observational watchdog health for one session. This tool is strictly read-only and never performs retries, process control, merges, model calls, or permission changes.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        sessionId: z.string().min(1).max(100),
        idleMinutes: z.number().min(0).max(1440).optional(),
        stalledMinutes: z.number().min(0).max(10080).optional(),
        retryLoopCount: z.number().int().min(1).max(100).optional(),
      },
      outputSchema: resultOutputSchema({ healthJson: z.string() }),
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, sessionId, idleMinutes, stalledMinutes, retryLoopCount }) => {
      const { session } = scopedSession(registry, workspaces, workspaceAccess, workspaceId, sessionId);
      const health = deriveOrchestrationHealth(session, new Date(), {
        idleMs: idleMinutes === undefined ? undefined : idleMinutes * 60_000,
        stalledMs: stalledMinutes === undefined ? undefined : stalledMinutes * 60_000,
        retryLoopCount,
      });
      const result = `${sessionId}: health=${health.primary}.`;
      return { content: [textBlock(result)], structuredContent: { result, healthJson: JSON.stringify(health) } };
    },
  );

  server.registerTool(
    "session_conflicts",
    {
      title: "Detect orchestration session conflicts",
      description: "Read deterministic file-intent conflicts among active sessions in the current project scope. Different workspace roots/worktrees are treated as isolated.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        limit: z.number().int().min(1).max(500).optional(),
      },
      outputSchema: resultOutputSchema({ conflictsJson: z.string(), count: z.number().int().nonnegative(), truncated: z.boolean() }),
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, limit }) => {
      const workspace = readableWorkspace(workspaces, workspaceAccess, workspaceId);
      const projectKey = projectKeyForWorkspace(workspace);
      const sessions = registry.list({ projectKey, limit: 500 });
      const intents = sessions.flatMap((session) => registry.fileIntents(session.id));
      const max = limit ?? 100;
      const all = detectOrchestrationConflicts(sessions, intents, Math.min(max + 1, 500));
      const truncated = all.length > max;
      const conflicts = all.slice(0, max);
      const result = `${conflicts.length} orchestration conflict(s) in project scope${truncated ? " (truncated)" : ""}.`;
      return { content: [textBlock(result)], structuredContent: { result, conflictsJson: JSON.stringify(conflicts), count: conflicts.length, truncated } };
    },
  );
}

function readableWorkspace(
  workspaces: WorkspaceRegistry,
  workspaceAccess: WorkspaceAccessManager,
  workspaceId: string,
) {
  const workspace = workspaces.getWorkspace(workspaceId);
  workspaceAccess.assertWorkspaceReadable(workspace);
  return workspace;
}

function scopedSession(
  registry: OrchestrationRegistry,
  workspaces: WorkspaceRegistry,
  workspaceAccess: WorkspaceAccessManager,
  workspaceId: string,
  sessionId: string,
): { session: OrchestrationSession; projectKey: string } {
  const workspace = readableWorkspace(workspaces, workspaceAccess, workspaceId);
  const projectKey = projectKeyForWorkspace(workspace);
  const session = registry.get(sessionId);
  if (session.projectKey !== projectKey) {
    throw new Error("Orchestration session is outside the current project scope.");
  }
  return { session, projectKey };
}
