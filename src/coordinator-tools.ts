import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OrchestrationCoordinator } from "./orchestration-coordinator.js";
import { OrchestrationRegistry } from "./orchestration-registry.js";
import {
  automaticSessionExternalId,
  projectKeyForWorkspace,
} from "./orchestration-scope.js";
import { openAiConversationScopeId } from "./request-meta.js";
import { resultOutputSchema, textBlock } from "./tool-surfaces/shared.js";
import {
  LOCAL_STATE_TOOL_ANNOTATIONS,
  READ_TOOL_ANNOTATIONS,
  workspaceIdDescription,
} from "./tool-surfaces/types.js";
import type { WorkspaceAccessManager } from "./workspace-access.js";
import type { WorkspaceRegistry } from "./workspaces.js";

export function registerCoordinatorTools(
  server: McpServer,
  coordinator: OrchestrationCoordinator,
  sessions: OrchestrationRegistry,
  workspaces: WorkspaceRegistry,
  workspaceAccess: WorkspaceAccessManager,
): void {
  server.registerTool(
    "coordinator_plan_create",
    {
      title: "Create coordinator task plan",
      description:
        "Create a durable project-scoped task DAG. This only writes DevSpace coordination metadata and never starts workers, models, commands, worktrees, merges, or permission changes.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        tasks: z.array(z.object({
          name: z.string().min(1).max(100),
          description: z.string().min(1).max(4000),
          priority: z.number().int().min(-100).max(100).optional(),
          dependencies: z.array(z.string().min(1).max(100)).max(100).optional(),
        })).min(1).max(100),
      },
      outputSchema: resultOutputSchema({
        tasksJson: z.string(),
        count: z.number().int().nonnegative(),
      }),
      annotations: LOCAL_STATE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, tasks }) => {
      const projectKey = projectScope(workspaces, workspaceAccess, workspaceId);
      const created = coordinator.createPlan(projectKey, tasks);
      const result = "Created coordinator plan with " + created.length + " task(s).";
      return {
        content: [textBlock(result)],
        structuredContent: {
          result,
          tasksJson: JSON.stringify(created),
          count: created.length,
        },
      };
    },
  );

  server.registerTool(
    "coordinator_task_list",
    {
      title: "List coordinator tasks",
      description: "List durable coordinator tasks in the current project scope.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
      },
      outputSchema: resultOutputSchema({
        tasksJson: z.string(),
        count: z.number().int().nonnegative(),
      }),
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId }) => {
      const projectKey = projectScope(workspaces, workspaceAccess, workspaceId);
      const tasks = coordinator.list(projectKey);
      const result = tasks.length + " coordinator task(s) in project scope.";
      return {
        content: [textBlock(result)],
        structuredContent: {
          result,
          tasksJson: JSON.stringify(tasks),
          count: tasks.length,
        },
      };
    },
  );

  server.registerTool(
    "coordinator_task_status",
    {
      title: "Read coordinator task status",
      description: "Read one coordinator task after enforcing current project scope.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        taskId: z.string().min(1).max(100),
      },
      outputSchema: resultOutputSchema({
        taskJson: z.string(),
      }),
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, taskId }) => {
      const projectKey = projectScope(workspaces, workspaceAccess, workspaceId);
      const task = scopedTask(coordinator, projectKey, taskId);
      const result = task.id + ": " + task.state + "; revision=" + task.revision + ".";
      return {
        content: [textBlock(result)],
        structuredContent: { result, taskJson: JSON.stringify(task) },
      };
    },
  );

  server.registerTool(
    "coordinator_ready",
    {
      title: "List ready coordinator tasks",
      description:
        "Read dependency-ready tasks for the current project. Expired claims may re-enter the derived ready queue; no task is claimed by this call.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
      },
      outputSchema: resultOutputSchema({
        tasksJson: z.string(),
        count: z.number().int().nonnegative(),
      }),
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId }) => {
      const projectKey = projectScope(workspaces, workspaceAccess, workspaceId);
      const tasks = coordinator.readyQueue(projectKey);
      const result = tasks.length + " coordinator task(s) ready.";
      return {
        content: [textBlock(result)],
        structuredContent: {
          result,
          tasksJson: JSON.stringify(tasks),
          count: tasks.length,
        },
      };
    },
  );

  server.registerTool(
    "coordinator_claim",
    {
      title: "Claim coordinator task",
      description:
        "Claim one dependency-ready task with a fenced local lease. If sessionId is omitted, DevSpace resolves the trusted current ChatGPT telemetry session. This does not execute the task or start any worker/model.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        taskId: z.string().min(1).max(100),
        expectedRevision: z.number().int().positive(),
        sessionId: z.string().min(1).max(100).optional(),
        leaseMinutes: z.number().int().min(1).max(60).optional(),
      },
      outputSchema: resultOutputSchema({
        taskJson: z.string(),
        leaseToken: z.string(),
      }),
      annotations: LOCAL_STATE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, taskId, expectedRevision, sessionId, leaseMinutes }, { _meta }) => {
      const workspace = readableWorkspace(workspaces, workspaceAccess, workspaceId);
      const projectKey = projectKeyForWorkspace(workspace);
      const task = scopedTask(coordinator, projectKey, taskId);
      const owner = resolveOwnerSession(
        sessions,
        projectKey,
        sessionId,
        openAiConversationScopeId(_meta),
      );
      const claimed = coordinator.claim({
        taskId: task.id,
        sessionId: owner.id,
        expectedRevision,
        leaseMs: leaseMinutes === undefined ? undefined : leaseMinutes * 60_000,
      });
      const result = "Claimed coordinator task " + claimed.id + " for session " + owner.id + ".";
      return {
        content: [textBlock(result)],
        structuredContent: {
          result,
          taskJson: JSON.stringify(claimed),
          leaseToken: claimed.leaseToken!,
        },
      };
    },
  );

  registerLeaseMutationTool(
    server,
    "coordinator_release",
    "Release coordinator task",
    "Release the current fenced task lease back to pending. Changes coordination metadata only.",
    "release",
    coordinator,
    sessions,
    workspaces,
    workspaceAccess,
  );
  registerLeaseMutationTool(
    server,
    "coordinator_complete",
    "Complete coordinator task",
    "Complete the currently leased coordinator task. Requires matching session, lease token and revision; does not merge or execute code.",
    "complete",
    coordinator,
    sessions,
    workspaces,
    workspaceAccess,
  );
}

function registerLeaseMutationTool(
  server: McpServer,
  toolName: string,
  title: string,
  description: string,
  operation: "release" | "complete",
  coordinator: OrchestrationCoordinator,
  sessions: OrchestrationRegistry,
  workspaces: WorkspaceRegistry,
  workspaceAccess: WorkspaceAccessManager,
): void {
  server.registerTool(
    toolName,
    {
      title,
      description,
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        taskId: z.string().min(1).max(100),
        expectedRevision: z.number().int().positive(),
        leaseToken: z.string().min(1).max(200),
        sessionId: z.string().min(1).max(100).optional(),
      },
      outputSchema: resultOutputSchema({
        taskJson: z.string(),
      }),
      annotations: LOCAL_STATE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, taskId, expectedRevision, leaseToken, sessionId }, { _meta }) => {
      const workspace = readableWorkspace(workspaces, workspaceAccess, workspaceId);
      const projectKey = projectKeyForWorkspace(workspace);
      scopedTask(coordinator, projectKey, taskId);
      const owner = resolveOwnerSession(
        sessions,
        projectKey,
        sessionId,
        openAiConversationScopeId(_meta),
      );
      const task = operation === "release"
        ? coordinator.release({
            taskId,
            sessionId: owner.id,
            leaseToken,
            expectedRevision,
          })
        : coordinator.complete({
            taskId,
            sessionId: owner.id,
            leaseToken,
            expectedRevision,
          });
      const verb = operation === "release" ? "Released" : "Completed";
      const result = verb + " coordinator task " + task.id + ".";
      return {
        content: [textBlock(result)],
        structuredContent: { result, taskJson: JSON.stringify(task) },
      };
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

function projectScope(
  workspaces: WorkspaceRegistry,
  workspaceAccess: WorkspaceAccessManager,
  workspaceId: string,
): string {
  return projectKeyForWorkspace(readableWorkspace(workspaces, workspaceAccess, workspaceId));
}

function scopedTask(
  coordinator: OrchestrationCoordinator,
  projectKey: string,
  taskId: string,
) {
  const task = coordinator.get(taskId);
  if (task.projectKey !== projectKey) {
    throw new Error("Coordinator task is outside the current project scope.");
  }
  return task;
}

function resolveOwnerSession(
  sessions: OrchestrationRegistry,
  projectKey: string,
  explicitSessionId: string | undefined,
  trustedConversationId: string | undefined,
) {
  if (explicitSessionId) {
    const session = sessions.get(explicitSessionId);
    if (session.projectKey !== projectKey) {
      throw new Error("Coordinator session is outside the current project scope.");
    }
    return session;
  }
  if (!trustedConversationId) {
    throw new Error("sessionId is required when trusted conversation metadata is unavailable.");
  }
  const automaticId = automaticSessionExternalId(projectKey, trustedConversationId);
  const session = sessions.list({ projectKey, limit: 500 }).find(
    (candidate) => (
      candidate.sessionKind === "chatgpt_auto"
      && candidate.externalSessionId === automaticId
    ),
  );
  if (!session) {
    throw new Error("No automatic telemetry session exists for the current conversation.");
  }
  return session;
}
