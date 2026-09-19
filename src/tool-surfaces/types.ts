import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProcessSessionManager } from "../process-sessions.js";
import type { ServerConfig } from "../config.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import type { WorkspaceAccessManager } from "../workspace-access.js";

export const WORKSPACE_APP_URI = "ui://devspace/workspace-app.html";

export const toolNames = {
  openWorkspace: "open_workspace",
  read: "read",
  listDirectory: "list_directory",
  fileInfo: "file_info",
  batchReadFiles: "batch_read_files",
  searchFiles: "search_files",
  querySqlite: "query_sqlite",
  sessionRegister: "session_register",
  sessionHeartbeat: "session_heartbeat",
  sessionUpdate: "session_update",
  sessionList: "session_list",
  sessionStatus: "session_status",
  sessionEvents: "session_events",
  sessionHealth: "session_health",
  sessionConflicts: "session_conflicts",
  coordinatorPlanCreate: "coordinator_plan_create",
  coordinatorTaskList: "coordinator_task_list",
  coordinatorTaskStatus: "coordinator_task_status",
  coordinatorReady: "coordinator_ready",
  coordinatorClaim: "coordinator_claim",
  coordinatorRelease: "coordinator_release",
  coordinatorComplete: "coordinator_complete",
  write: "write",
  edit: "edit",
  shell: "bash",
} as const;

export const workspaceIdDescription =
  "Workspace to use. Reuse the current project's workspaceId.";

export const READ_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const LOCAL_STATE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

export const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

export const EDIT_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

export const SHELL_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolLogFields {
  tool: string;
  workspaceId?: string;
  path?: string;
  workingDirectory?: string;
  command?: string;
  commandLength?: number;
  success: boolean;
  durationMs: number;
  error?: string;
}

export interface DiffStats {
  additions: number;
  removals: number;
}

export interface ToolDefinitionMeta extends Record<string, unknown> {
  ui: {
    resourceUri: string;
    visibility: ["model", "app"];
  };
  "openai/outputTemplate": string;
  "openai/widgetAccessible": true;
}

export type EmptyToolDefinitionMeta = Record<string, unknown> & {
  "ui/resourceUri"?: string;
};

export interface ToolWidgetDescriptorMeta {
  _meta: ToolDefinitionMeta | EmptyToolDefinitionMeta;
}

export interface ToolRegistrationContext {
  server: McpServer;
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  processSessions: ProcessSessionManager;
  workspaceAccess: WorkspaceAccessManager;
}

export interface ToolInstructionContext {
  agents: string;
  skills: string;
}

export interface ToolSurface {
  register(context: ToolRegistrationContext): void;
  instructions(context: ToolInstructionContext): string;
}
