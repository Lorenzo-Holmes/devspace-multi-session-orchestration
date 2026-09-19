import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import type { Request, Response } from "express";
import * as z from "zod/v4";
import {
  isArtifactDownloadSupportedPlatform,
  registerArtifactTools,
} from "./artifact-tools.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { watchAllowedRoots } from "./config-reloader.js";
import { createLocalAgentClient } from "./local-agent-client.js";
import { registerGoalTools } from "./goal-tools.js";
import type { GoalApi } from "./goal-contracts.js";
import { ChatGoalController } from "./chat-goal-controller.js";
import { registerChatGoalTools } from "./chat-goal-tools.js";
import { ChatCardProbe, registerChatCardProbe } from "./chat-card-probe.js";
import { ChatGoalCards } from "./chat-goal-cards.js";
import { ChatGoalDiagnostics } from "./chat-goal-diagnostics.js";
import {
  createOpenAIIncomingArtifactAdapter,
  type IncomingArtifactAdapter,
} from "./incoming-artifacts.js";
import {
  logEvent,
  requestIp,
  requestPath,
  sessionIdPrefix,
} from "./logger.js";
import { getWorkspaceFileInfo, listWorkspaceDirectory } from "./filesystem-inspection.js";
import { findFilesTool, grepFilesTool, readFileTool } from "./pi-tools.js";
import { observeWindowsDesktop, registerWindowsComputerTools } from "./windows-computer.js";
import { CodexCuaBridge } from "./codex-cua-bridge.js";
import { registerCodexCuaTools } from "./codex-cua-tools.js";
import { ComputerUseApprovals, registerComputerUseApprovalTools } from "./computer-use-approvals.js";
import {
  collectSearchFileMetadata,
  filterSearchResultByExcludedGlobs,
  filterSearchResultByExtensions,
  filterSearchResultByPath,
  orderSearchResultByPaths,
  parseSearchMatches,
} from "./workspace-search.js";
import { querySqliteReadOnly } from "./sqlite-query.js";
import { OrchestrationStore } from "./orchestration-store.js";
import { OrchestrationRegistry } from "./orchestration-registry.js";
import { registerOrchestrationTools } from "./orchestration-tools.js";
import { installOrchestrationTelemetry } from "./orchestration-telemetry.js";
import { CoordinatorStore } from "./coordinator-store.js";
import { OrchestrationCoordinator } from "./orchestration-coordinator.js";
import { registerCoordinatorTools } from "./coordinator-tools.js";
import { OrchestrationV2 } from "./orchestration-v2.js";
import { registerOrchestrationV2Tools } from "./orchestration-v2-tools.js";
import { oauthSupportedScopes, SingleUserOAuthProvider } from "./oauth-provider.js";
import {
  McpSessionRegistry,
  type McpSessionCloseResult,
} from "./mcp-sessions.js";
import { McpToolCatalogRefreshTracker } from "./mcp-tool-catalog-refresh.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { openAiConversationScopeId } from "./request-meta.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { formatPathForPrompt } from "./skills.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { formatAgentsPath, WorkspaceRegistry } from "./workspaces.js";
import { WorkspaceAccessManager } from "./workspace-access.js";
import {
  registerWorkspaceAccessTools,
  workspaceAccessRequestCard,
  workspaceAccessRequestMessage,
} from "./workspace-access-tools.js";
import { AccessDeniedError, assertAllowedPath } from "./roots.js";
import {
  getLocalAgentProviderAvailabilitySnapshot,
} from "./local-agent-availability.js";
import {
  buildLocalAgentCatalog,
  buildLocalAgentProviderStatuses,
  formatLocalAgentProviderStatusSummary,
  type LocalAgentProviderStatus,
} from "./local-agent-catalog.js";
import { getToolSurface } from "./tool-surfaces/index.js";
import {
  contentText,
  logFailedToolResponse,
  logToolCall,
  resultOutputSchema,
  runLoggedToolOperation,
  textBlock,
  workspaceAppDescriptorMeta,
} from "./tool-surfaces/shared.js";
import {
  LOCAL_STATE_TOOL_ANNOTATIONS,
  READ_TOOL_ANNOTATIONS,
  WORKSPACE_APP_URI,
  toolNames,
  workspaceIdDescription,
  type ToolContent,
  type ToolSurface,
} from "./tool-surfaces/types.js";

type Transport = StreamableHTTPServerTransport;
// MCP clients can reconnect without closing the previous transport. Bound stale
// session retention so abandoned MCP servers do not accumulate for the life of the process.
const MCP_SESSION_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MCP_SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1_000;
const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";
const READ_ONLY_RESULT_TEXT_BUDGET = 120_000;
export const DEVSPACE_TOOL_SCHEMA_VERSION = "2026-09-19.4";
const DEVSPACE_MCP_SERVER_VERSION = "0.1.0+tools.20260919.4";
const DEVSPACE_PROCESS_STARTED_AT = new Date().toISOString();

interface RunningServer {
  app: ReturnType<typeof createMcpExpressApp>;
  config: ServerConfig;
  localAgentProviders: LocalAgentProviderStatus[];
  close(): Promise<void>;
}

interface WorkspaceAppManifestEntry {
  file: string;
  css?: string[];
  isEntry?: boolean;
}

type WorkspaceAppManifest = Record<string, WorkspaceAppManifestEntry>;

function capTextResult(text: string, maxChars = READ_ONLY_RESULT_TEXT_BUDGET): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= maxChars) return { text, truncated: false };
  const candidate = text.slice(0, maxChars);
  const lastNewline = candidate.lastIndexOf("\n");
  return {
    text: lastNewline > 0 ? candidate.slice(0, lastNewline) : candidate,
    truncated: true,
  };
}

function toolCatalogSnapshot(server: McpServer): {
  toolCatalogCount: number;
  toolCatalogFingerprint: string;
} {
  const registeredTools = (
    server as unknown as { _registeredTools?: Record<string, unknown> }
  )._registeredTools ?? {};
  const names = Object.keys(registeredTools).sort();
  return {
    toolCatalogCount: names.length,
    toolCatalogFingerprint: createHash("sha256").update(names.join("\n")).digest("hex"),
  };
}

function serverInstructions(
  config: ServerConfig,
  toolSurface: ToolSurface,
): string {
  const chatGoalInstruction = config.chatGoals?.enabled
    ? "Only enter the Chat Goal control flow when the user explicitly asks to create, continue, resume, or operate a Goal. Ordinary workspace opening, file search, directory listing, metadata inspection, file reads, and batch reads do not require chat_goal_preflight or a Goal card handshake. For Chat Goals, call chat_goal_preflight before opening a workspace or doing goal work. If it requires a card channel, call chat_goal_card_connect then chat_goal_card_ready once; only a real channel_ready result permits using its cardId as cardChannelId for preflight/create/next/ask_card. Do not create/claim before form capability or card acknowledgement passes. For card business questions call chat_goal_ask_card then chat_goal_wait_decision once, let the user choose, and continue only on an accepted decision while the host request is still active. Timeout/disconnect means stop, not automatic re-presentation. Never omit a required card, answer for the user, or claim free quota. Use only the current Chat model, never Codex or another model. Finish the finite Goal and stop. "
    : "";
  const cardDiagnosticInstruction = config.chatCardProbeEnabled
    ? "Card diagnostics are separate from Goal work and require no workspace. Only when explicitly asked for a NEW diagnostic, use a fresh UUID requestKey for chat_card_probe_show; reusing a key replays the SAME test. Call chat_card_probe_wait once only if nextAction=wait_once while the same host request remains active; let the user choose on the card. Historical results do not restart waits. Never send another Chat message, poll to keep the model alive, answer for the user, or treat a diagnostic receipt as Goal approval. On timeout report the boundary and stop. "
    : "";
  const artifactInstruction =
    config.artifactsEnabled && isArtifactDownloadSupportedPlatform()
      ? " When the user supplies or generates a file that is not present on the DevSpace host, use download_artifact with its native file value, the existing workspace ID, and a suitable relative destination path chosen from the user's request and project structure. The tool refuses to overwrite an existing destination and returns the normalized workspace-relative path. Use normal workspace tools when explicit inspection, replacement, movement, renaming, or deletion is needed. Do not recreate binary files with write/edit calls or place signed URLs, native file objects, base64 content, or invented host paths in shell commands or logs."
      : "";
  const showChangesInstruction =
    " If the turn successfully modifies files by creating, editing, overwriting, deleting, moving, or applying patches, call show_changes exactly once for that workspace after the final related file change and before your final response so the user can inspect the aggregate diff for that turn. Do not call it after every individual file change.";
  const skills = config.skillsEnabled
    ? `When ${toolNames.openWorkspace} returns available skills and a task matches a skill, use ${toolNames.read} to read that skill's path before proceeding. Skill paths may be outside the workspace, but ${toolNames.read} only permits advertised SKILL.md files and files under already-loaded skill directories. `
    : "";
  const agents = `Follow instructions returned by ${toolNames.openWorkspace}. Before working under a path listed in availableAgentsFiles, use ${toolNames.read} to inspect that instruction file and follow it. `;
  const common = `Use DevSpace for coding work. Call ${toolNames.openWorkspace} once for each project folder or isolated worktree, then keep using its workspaceId. During continued work in the same project or worktree, do not call ${toolNames.openWorkspace} again. Open another workspace only when changing projects, switching checkout/worktree mode, creating another isolated worktree, or when the current workspaceId is rejected. When ${toolNames.openWorkspace} receives an existing folder outside approved roots or requests stronger access than the active grant, it automatically returns an interactive permission card. Wait for the user to decide; never claim approval or retry until the card reports success. Use request_workspace_access when an already-open read-only workspace needs stronger access. After approval, retry ${toolNames.openWorkspace} with the approved access level. Use list_workspace_access to inspect grants, revoke_workspace_access to remove an exact grant, and workspace_access_audit to review permission events. Use ${toolNames.searchFiles} for workspace filename/content search instead of shell grep/find commands. Use ${toolNames.querySqlite} for SELECT, WITH, EXPLAIN, and read-only PRAGMA queries instead of a shell command; it is enforced read-only by the server. For explicit multi-session coordination, register each worker with ${toolNames.sessionRegister}, keep durable local activity metadata with ${toolNames.sessionHeartbeat}/${toolNames.sessionUpdate}, and use ${toolNames.sessionList}/${toolNames.sessionStatus}/${toolNames.sessionEvents}/${toolNames.sessionHealth}/${toolNames.sessionConflicts} for monitoring. A session heartbeat is only persisted metadata; it never proves a Chat/model is live and never wakes or starts one. V1 monitoring is observational and must not be described as automatic cross-Chat spawning, background model execution, retries, merging, process control, or permission escalation.`;

  return `${chatGoalInstruction}${cardDiagnosticInstruction}${common} ${toolSurface.instructions({ agents, skills })}${artifactInstruction}${showChangesInstruction}`;
}

function formatVisibleAgent(agent: {
  name: string;
  provider: string;
  model?: string;
  effort?: string;
}): string {
  const model = agent.model ? `, model ${agent.model}` : "";
  const effort = agent.effort ? `, effort ${agent.effort}` : "";
  return `${agent.name} (${agent.provider}${model}${effort})`;
}

function formatAvailableAgentProvider(provider: {
  id: string;
  model?: string;
  effort?: string;
  note?: string;
}): string {
  const details = [
    provider.model ? `model ${provider.model}` : undefined,
    provider.effort ? `effort ${provider.effort}` : undefined,
    provider.note,
  ].filter(Boolean).join(", ");
  return `${provider.id}${details ? ` (${details})` : ""}`;
}

const workspaceSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
});

const workspaceAgentsFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const workspaceLocalAgentOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
});

const workspaceLocalAgentProviderOutputSchema = z.object({
  id: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  note: z.string().optional(),
});

const workspaceAvailableAgentsFileOutputSchema = z.object({
  path: z.string(),
});

const openWorkspaceOutputSchema: z.ZodRawShape = {
  outcome: z.enum(["workspace_opened", "permission_required"]),
  result: z.string().optional(),
  workspaceId: z.string().optional(),
  root: z.string().optional(),
  mode: z.enum(["checkout", "worktree"]).optional(),
  sourceRoot: z.string().optional(),
  worktree: z
    .object({
      path: z.string(),
      baseRef: z.string(),
      baseSha: z.string(),
      dirtySource: z.boolean(),
      detached: z.boolean(),
      managed: z.boolean(),
    })
    .optional(),
  agentsFiles: z.array(workspaceAgentsFileOutputSchema).optional(),
  availableAgentsFiles: z.array(workspaceAvailableAgentsFileOutputSchema).optional(),
  skills: z.array(workspaceSkillOutputSchema).optional(),
  agentProviders: z.array(workspaceLocalAgentProviderOutputSchema).optional(),
  agents: z.array(workspaceLocalAgentOutputSchema).optional(),
  skillDiagnostics: z.array(z.unknown()).optional(),
  review: z.discriminatedUnion("available", [
    z.object({ available: z.literal(true) }),
    z.object({
      available: z.literal(false),
      reason: z.string(),
    }),
  ]).optional(),
  instruction: z.string().optional(),
  accessMode: z.enum(["read", "modify"]).optional(),
  requestId: z.string().optional(),
  path: z.string().optional(),
  requestedAccess: z.enum(["read", "modify"]).optional(),
  status: z.enum(["pending", "already_allowed"]).optional(),
  risk: z.enum(["standard", "high"]).optional(),
  temporaryScopeAvailable: z.boolean().optional(),
  reason: z.string().optional(),
  createdAt: z.string().optional(),
  expiresAt: z.string().optional(),
};

function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function requestLogFields(req: Request, config: ServerConfig): Record<string, unknown> {
  return {
    ip: requestIp(req, config.logging.trustProxy),
    host: req.header("host"),
    userAgent: req.header("user-agent"),
    origin: req.header("origin"),
    referer: req.header("referer"),
    contentLength: req.header("content-length"),
  };
}

function assetBaseUrl(config: ServerConfig): string {
  return `${config.publicBaseUrl.replace(/\/+$/, "")}/mcp-app-assets`;
}

function uiManifestUrl(): URL {
  return new URL("../dist/ui/.vite/manifest.json", import.meta.url);
}

function readWorkspaceAppManifest(): WorkspaceAppManifest {
  return JSON.parse(readFileSync(uiManifestUrl(), "utf8")) as WorkspaceAppManifest;
}

function getWorkspaceAppManifestEntry(): WorkspaceAppManifestEntry {
  const manifest = readWorkspaceAppManifest();
  const entry = manifest[WORKSPACE_APP_MANIFEST_ENTRY];

  if (!entry?.file) {
    throw new Error(`Missing ${WORKSPACE_APP_MANIFEST_ENTRY} in UI manifest.`);
  }

  return entry;
}

function assetUrl(baseUrl: string, assetPath: string): string {
  return `${baseUrl}/${assetPath.replace(/^\/+/, "")}`;
}

function workspaceAppHtml(config: ServerConfig): string {
  const baseUrl = assetBaseUrl(config);
  const entry = getWorkspaceAppManifestEntry();
  const stylesheets = (entry.css ?? [])
    .map(
      (stylesheet) =>
        `    <link rel="stylesheet" crossorigin href="${assetUrl(baseUrl, stylesheet)}" />`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DevSpace Workspace</title>
    <script type="module" crossorigin src="${assetUrl(baseUrl, entry.file)}"></script>
${stylesheets}
  </head>
  <body>
    <main id="app" class="shell">
      <section class="empty">Waiting for a tool result.</section>
    </main>
  </body>
</html>`;
}

function appCsp(config: ServerConfig): {
  resourceDomains: string[];
  connectDomains: string[];
} {
  const publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  return {
    resourceDomains: [publicBaseUrl],
    connectDomains: [publicBaseUrl],
  };
}

function uiBuildDirectory(): string {
  return fileURLToPath(new URL("../dist/ui", import.meta.url));
}

function setAssetHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

async function assertWorkspaceAppAssets(): Promise<void> {
  const entry = getWorkspaceAppManifestEntry();
  const candidates = [entry.file, ...(entry.css ?? [])].map(
    (assetPath) => new URL(`../dist/ui/${assetPath}`, import.meta.url),
  );

  for (const candidate of candidates) {
    await access(candidate);
  }
}

export function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessSessionManager,
  resolveLocalAgentProviders: () => LocalAgentProviderStatus[],
  incomingArtifactAdapters: readonly IncomingArtifactAdapter[],
  workspaceAccess: WorkspaceAccessManager,
  goalApi?: GoalApi,
  chatGoals?: ChatGoalController,
  cardDiagnostic?: { probe: ChatCardProbe; html: string },
  goalCards?: { service: ChatGoalCards; html: string; scope:string },
  codexCua?: CodexCuaBridge,
  computerApprovals?: { service: ComputerUseApprovals; html: string; scope: string },
  orchestration?: OrchestrationRegistry,
  coordinator?: OrchestrationCoordinator,
  orchestrationV2?: OrchestrationV2,
): McpServer {
  if (config.chatGoals?.enabled && (config.goals?.enabled || config.subagents.enabled)) {
    throw new Error("Chat Goals preview requires native Goals and local subagents disabled.");
  }
  const toolSurface = getToolSurface(config.toolMode);
  const server = new McpServer(
    {
      name: "devspace",
      title: "DevSpace",
      version: DEVSPACE_MCP_SERVER_VERSION,
      description:
        "Coding tools for project workspaces. Open each project or worktree once, then reuse its workspaceId.",
    },
    {
      instructions: serverInstructions(config, toolSurface),
    },
  );
  if (orchestration) {
    installOrchestrationTelemetry(server, orchestration, workspaces);
  }

  registerAppResource(
    server,
    "DevSpace Diff Card",
    WORKSPACE_APP_URI,
    {
      description: "Interactive card for viewing DevSpace file diffs.",
      _meta: {
        ui: {
          csp: appCsp(config),
        },
      },
    },
    async () => {
      await assertWorkspaceAppAssets();
      return {
        contents: [
          {
            uri: WORKSPACE_APP_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: workspaceAppHtml(config),
            _meta: {
              ui: {
                csp: appCsp(config),
              },
            },
          },
        ],
      };
    },
  );

  registerWorkspaceAccessTools(server, config, workspaceAccess);
  if (orchestrationV2) registerOrchestrationV2Tools(server, orchestrationV2, config.uiEnabled);
  if (orchestration) {
    registerOrchestrationTools(server, orchestration, workspaces, workspaceAccess);
  }
  if (orchestration && coordinator) {
    registerCoordinatorTools(
      server,
      coordinator,
      orchestration,
      workspaces,
      workspaceAccess,
    );
  }
  server.registerTool(
    "devspace_runtime_info",
    {
      title: "Read DevSpace runtime identity",
      description:
        "Read-only runtime identity for diagnosing stale MCP tool catalogs. Returns the active DevSpace build ID, tool-schema version, MCP server version, process start time, and a count plus SHA-256 fingerprint of the server's current host-facing tool names. It does not return the tool-name list, paths, secrets, or credentials and creates no workspace, permission, Goal, process, or file change.",
      inputSchema: {},
      outputSchema: {
        buildId: z.string(),
        toolSchemaVersion: z.string(),
        serverVersion: z.string(),
        processStartedAt: z.string(),
        toolCatalogCount: z.number().int().nonnegative(),
        toolCatalogFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        nextAction: z.literal("compare_with_host_tool_catalog"),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async () => {
      const data = {
        buildId: process.env.DEVSPACE_BUILD_ID?.trim() || "source",
        toolSchemaVersion: DEVSPACE_TOOL_SCHEMA_VERSION,
        serverVersion: DEVSPACE_MCP_SERVER_VERSION,
        processStartedAt: DEVSPACE_PROCESS_STARTED_AT,
        ...toolCatalogSnapshot(server),
        nextAction: "compare_with_host_tool_catalog" as const,
      };
      return {
        content: [textBlock(JSON.stringify(data))],
        structuredContent: data,
      };
    },
  );
  if (codexCua) registerCodexCuaTools(server, config, workspaces, workspaceAccess, codexCua, computerApprovals?.service);
  else registerWindowsComputerTools(server, config, workspaces, workspaceAccess);
  if (computerApprovals) {
    registerComputerUseApprovalTools(server, computerApprovals.service, computerApprovals.html, workspaces, workspaceAccess, computerApprovals.scope);
  }
  if(config.goals?.enabled)registerGoalTools(server,goalApi??createLocalAgentClient(config),workspaces,workspaceAccess);
  if(config.chatGoals?.enabled) {
    if (!chatGoals) throw new Error("Chat Goal controller is not initialized.");
    registerChatGoalTools(server,chatGoals,workspaces,workspaceAccess,goalCards);
  }
  if (config.chatCardProbeEnabled) {
    assertCardDiagnosticConfig(config);
    if (!cardDiagnostic) throw new Error("Card diagnostic is not initialized.");
    registerChatCardProbe(server, cardDiagnostic.probe, cardDiagnostic.html, config.oauth.scopes[0] ?? "devspace");
  }

  registerAppTool(
    server,
    "open_workspace",
    {
      title: "Open workspace",
      description:
        "Open an existing project directory or isolated worktree when no usable workspaceId exists. The caller must explicitly choose read or modify access. If the existing directory is outside approved roots, this call automatically shows the user a permission card instead of failing. During continued work, reuse the existing workspaceId instead of calling this tool again. By default this uses the actual checkout; set mode=\"worktree\" for isolated or parallel work.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute path, or a leading-tilde home path such as ~/project, to an existing project directory. Outside roots trigger an approval card.",
          ),
        access: z
          .enum(["read", "modify"])
          .describe(
            "Explicit access level for this workspace: read for inspection only, or modify for file changes, commands, builds, and other project mutations.",
          ),
        mode: z
          .enum(["checkout", "worktree"])
          .optional()
          .describe(
            "Defaults to checkout, which works in the actual directory. Use worktree for isolated or parallel Git work.",
          ),
        baseRef: z
          .string()
          .optional()
          .describe("Git ref to base a worktree on. Only used with mode=\"worktree\". Defaults to HEAD."),
      },
      outputSchema: openWorkspaceOutputSchema,
      ...workspaceAppDescriptorMeta(config),
      annotations: LOCAL_STATE_TOOL_ANNOTATIONS,
    },
    async ({ path, access: requestedAccess, mode, baseRef }, { _meta }) => {
      const startedAt = performance.now();
      const conversationScopeId = openAiConversationScopeId(_meta);
      let authorization;
      try {
        authorization = await workspaceAccess.authorizeWorkspacePath(
          path,
          conversationScopeId,
          requestedAccess,
        );
      } catch (error) {
        if (!(error instanceof AccessDeniedError)) throw error;

        try {
          const request = await workspaceAccess.requestAccess({
            path,
            access: requestedAccess,
            reason: "Open this folder as a DevSpace workspace.",
            conversationScopeId,
          });
          const result = workspaceAccessRequestMessage(request);
          const card = workspaceAccessRequestCard(request);
          const { approvalToken: _approvalToken, tool: _tool, ...publicRequest } = card;
          logToolCall(config, {
            tool: "open_workspace",
            path: request.path,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
          });
          return {
            content: [textBlock(result)],
            structuredContent: {
              outcome: "permission_required" as const,
              result,
              ...publicRequest,
            },
            _meta: { card },
          };
        } catch {
          throw error;
        }
      }
      let opened: Awaited<ReturnType<WorkspaceRegistry["openWorkspace"]>>;
      try {
        opened = await workspaces.openWorkspace(
          { path: authorization.path, mode, baseRef },
          {
            conversationScopeId,
            allowedRoots: [...config.allowedRoots, authorization.root],
            accessMode: authorization.access,
            accessGrantId: authorization.grantId,
          },
        );
      } catch (error) {
        workspaceAccess.releaseOnceAuthorization(authorization);
        throw error;
      }
      const {
        workspace,
        agentsFiles,
        availableAgentsFiles,
        workspaceReused,
        includeBootstrapContext,
      } = opened;
      const review = await reviewCheckpoints.initializeWorkspace({
        workspaceId: workspace.id,
        root: workspace.root,
      });
      const cardSkills = workspace.skills
        .filter((skill) => !skill.disableModelInvocation)
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: formatPathForPrompt(skill.filePath),
        }));
      const agentCatalog = buildLocalAgentCatalog(
        config.subagents,
        workspace.agentProfiles,
        resolveLocalAgentProviders(),
      );
      const cardAgentProviders = agentCatalog.providers
        .filter((provider) => provider.usable)
        .map((provider) => ({
          id: provider.id,
          model: provider.model,
          effort: provider.effort,
          note: provider.note,
        }));
      const cardAgents = agentCatalog.profiles;
      const cardAgentsFiles = agentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
        content: file.content,
      }));
      const cardAvailableAgentsFiles = availableAgentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
      }));
      const visibleSkills = includeBootstrapContext ? cardSkills : [];
      const visibleAgentProviders = includeBootstrapContext ? cardAgentProviders : [];
      const visibleAgents = includeBootstrapContext ? cardAgents : [];
      const loadedAgentsFiles = includeBootstrapContext ? cardAgentsFiles : [];
      const availableAgentsFileOutputs = includeBootstrapContext ? cardAvailableAgentsFiles : [];
      const cardInstruction = config.skillsEnabled
        ? "Use this workspaceId for subsequent work in this project. Keep reusing it while working in this project. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file. When a task matches an available skill in skills, read its path before proceeding."
        : "Use this workspaceId for subsequent work in this project. Keep reusing it while working in this project. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file.";
      const baseInstruction = workspaceReused
        ? [
            `Workspace already open as ${workspace.id}.`,
            "Continue with this workspaceId.",
            "Keep following the project instructions, nested instruction files, skills, agent profiles, and diagnostics already provided for this workspace.",
          ].join("\n\n")
        : workspace.mode === "worktree"
          ? "Use this workspaceId for subsequent work in this isolated worktree. Keep reusing it while working in this worktree. Follow the project instructions, nested instruction files, skills, agent profiles, and diagnostics returned for it."
          : cardInstruction;
      const computerCompatibilityInstruction = config.computerUseEnabled && process.platform === "win32"
        ? "Computer Use is enabled through the bundled Codex unified-computer-use runtime. For browser tabs, use browser_state first, select an exact browserId/tabId with its trusted URL, then use browser_observe/browser_action; do not inspect Chrome or Edge as a generic desktop window for ordinary browser work. If this Chat has a frozen tool schema without browser_state/browser_observe/browser_action, observe may return trusted aliases whose app begins codex-browser-use:; those aliases are the supported compatibility route through the same Browser Use origin checks. Never invent or edit an alias. For native Windows apps, use observe without a window first to list top-level windows, then observe the exact returned {app,id} window. Prefer accessibility element indices over pixel coordinates. Browser and desktop actions return fresh state after acting. Preserve Codex's app/origin approval prompts and never answer them for the user. If neither the required CUA tool nor a trusted browser alias is available, report that the tool catalog is stale rather than silently downgrading to legacy control."
        : "";
      const instruction = [baseInstruction, computerCompatibilityInstruction].filter(Boolean).join("\n\n");
      const resultContent: ToolContent[] = [
        {
          type: "text" as const,
          text: [
            workspaceReused
              ? `Workspace already open as ${workspace.id}.`
              : workspace.mode === "worktree"
                ? `Opened isolated worktree workspace ${workspace.id}.`
                : `Opened workspace ${workspace.id}.`,
            `Root: ${workspace.root}`,
            `Mode: ${workspace.mode}`,
            loadedAgentsFiles.length > 0
              ? `Loaded project instructions: ${loadedAgentsFiles.map((file) => file.path).join(", ")}`
              : undefined,
            availableAgentsFileOutputs.length > 0
              ? `Available nested instructions: ${availableAgentsFileOutputs.map((file) => file.path).join(", ")}`
              : undefined,
            visibleSkills.length > 0
              ? `Available skills: ${visibleSkills.map((skill) => skill.name).join(", ")}`
              : undefined,
            visibleAgentProviders.length > 0
              ? `Available subagent providers: ${visibleAgentProviders.map(formatAvailableAgentProvider).join(", ")}`
              : undefined,
            visibleAgents.length > 0
              ? `Available subagent profiles: ${visibleAgents.map(formatVisibleAgent).join(", ")}`
              : undefined,
            `Access: ${workspace.accessMode}`,
            instruction,
          ].filter(Boolean).join("\n"),
        },
      ];
      logToolCall(config, {
        tool: "open_workspace",
        workspaceId: workspace.id,
        path: workspace.root,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: resultContent,
        _meta: {
          card: {
            workspaceId: workspace.id,
            root: workspace.root,
            path: workspace.root,
            mode: workspace.mode,
            workspaceReused,
            includeBootstrapContext,
            sourceRoot: workspace.sourceRoot,
            worktree: workspace.worktree,
            agentsFiles: cardAgentsFiles,
            availableAgentsFiles: cardAvailableAgentsFiles,
            skills: cardSkills,
            agentProviders: cardAgentProviders,
            agents: cardAgents,
            review,
            instruction: cardInstruction,
            accessMode: workspace.accessMode,
            summary: {
              mode: workspace.mode,
              agentsFiles: cardAgentsFiles.length,
              availableAgentsFiles: cardAvailableAgentsFiles.length,
              skills: cardSkills.length,
              agentProviders: cardAgentProviders.length,
              agents: cardAgents.length,
            },
          },
        },
        structuredContent: {
          outcome: "workspace_opened" as const,
          workspaceId: workspace.id,
          root: workspace.root,
          mode: workspace.mode,
          sourceRoot: workspace.sourceRoot,
          worktree: workspace.worktree,
          review,
          ...(includeBootstrapContext
            ? {
                agentsFiles: loadedAgentsFiles,
                availableAgentsFiles: availableAgentsFileOutputs,
                skills: visibleSkills,
                agentProviders: visibleAgentProviders,
                agents: visibleAgents,
                skillDiagnostics: workspace.skillDiagnostics,
              }
            : {}),
          instruction,
          accessMode: workspace.accessMode,
        },
      };
    },
  );

  server.registerTool(
    toolNames.read,
    {
      title: "Read file",
      description:
        [
          "Read a file in a workspace. Use this for file inspection instead of shell commands like cat or sed.",
          "Use this tool to inspect relevant AGENTS.md or CLAUDE.md files listed by open_workspace before working in nested directories.",
          config.skillsEnabled
            ? "If available skills were returned and a task matches one, read that skill's path before proceeding. Skill paths may be outside the workspace; only advertised SKILL.md files and files under already-loaded skill directories are readable."
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      inputSchema: {
        workspaceId: z
          .string()
          .describe(workspaceIdDescription),
        path: z
          .string()
          .describe(
            config.skillsEnabled
              ? "File path to read, relative to the workspace root. May also be an advertised skill path from open_workspace skills."
              : "File path to read, relative to the workspace root.",
          ),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed line number to start reading from."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of lines to read."),
      },
      outputSchema: resultOutputSchema(),
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      if (config.computerUseEnabled && process.platform === "win32" && input.path === "@desktop") {
        const observed = await observeWindowsDesktop(config, workspaces, workspaceAccess, workspaceId);
        const text = observed.content.find((item) => item.type === "text");
        const result = text?.type === "text" ? text.text : observed.structuredContent.result;
        logToolCall(config, {
          tool: toolNames.read,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content: observed.content,
          structuredContent: { result },
        };
      }
      const workspace = workspaces.getWorkspace(workspaceId);
      workspaceAccess.assertWorkspaceReadable(workspace);
      const readPath = workspaces.resolveReadPath(workspace, input.path);
      const response = await readFileTool(
        { ...input, path: readPath.absolutePath },
        {
          cwd: workspace.root,
          root: workspace.root,
          readRoots: readPath.readRoots,
        },
      );

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.read,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }
      workspaces.markReadPathLoaded(workspace, readPath);

      logToolCall(config, {
        tool: toolNames.read,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );

  server.registerTool(
    toolNames.listDirectory,
    {
      title: "List directory",
      description:
        "List one directory inside the current workspace without using shell commands. Results are name-sorted, bounded, and include entry kind, size, and modification time. Symlinks are reported as links and are not followed while listing entries.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        path: z
          .string()
          .optional()
          .describe("Workspace-relative directory to list. Defaults to the workspace root."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximum entries to return. Defaults to 200."),
      },
      outputSchema: resultOutputSchema({
        path: z.string(),
        entriesJson: z.string(),
        entryCount: z.number().int().nonnegative(),
        truncated: z.boolean(),
      }),
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, path, limit }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      workspaceAccess.assertWorkspaceReadable(workspace);
      const listing = await runLoggedToolOperation(
        config,
        { tool: toolNames.listDirectory, workspaceId, path: path ?? "." },
        startedAt,
        () => listWorkspaceDirectory(workspace.root, path ?? ".", limit ?? 200),
      );
      const renderedEntries: typeof listing.entries = [];
      const renderedLines: string[] = [];
      let renderedChars = 0;
      for (const entry of listing.entries) {
        const suffix = entry.kind === "directory" ? "/" : "";
        const line = `[${entry.kind}] ${entry.path}${suffix} (${entry.sizeBytes} bytes, ${entry.modifiedAt})`;
        const addedChars = line.length + (renderedLines.length === 0 ? 0 : 1);
        if (renderedChars + addedChars > READ_ONLY_RESULT_TEXT_BUDGET) break;
        renderedEntries.push(entry);
        renderedLines.push(line);
        renderedChars += addedChars;
      }
      const outputTruncated = listing.truncated || renderedEntries.length < listing.entries.length;
      const result = renderedEntries.length === 0
        ? `${listing.path}: empty directory`
        : renderedLines.join("\n");
      return {
        content: [textBlock(result)],
        structuredContent: {
          result,
          path: listing.path,
          entriesJson: JSON.stringify(renderedEntries),
          entryCount: renderedEntries.length,
          truncated: outputTruncated,
        },
      };
    },
  );

  server.registerTool(
    toolNames.fileInfo,
    {
      title: "File info",
      description:
        "Read metadata for one file, directory, or symlink inside the current workspace without shell commands. Symlink objects are reported without following the final link; non-symlink targets must resolve inside the workspace root.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        path: z.string().min(1).describe("Workspace-relative path to inspect."),
      },
      outputSchema: resultOutputSchema({
        infoJson: z.string(),
        kind: z.enum(["file", "directory", "symlink", "other"]),
        sizeBytes: z.number().nonnegative(),
      }),
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, path }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      workspaceAccess.assertWorkspaceReadable(workspace);
      const info = await runLoggedToolOperation(
        config,
        { tool: toolNames.fileInfo, workspaceId, path },
        startedAt,
        () => getWorkspaceFileInfo(workspace.root, path),
      );
      const result = `${info.kind} ${info.path} (${info.sizeBytes} bytes, modified ${info.modifiedAt})`;
      return {
        content: [textBlock(result)],
        structuredContent: {
          result,
          infoJson: JSON.stringify(info),
          kind: info.kind,
          sizeBytes: info.sizeBytes,
        },
      };
    },
  );

  server.registerTool(
    toolNames.batchReadFiles,
    {
      title: "Batch read files",
      description:
        "Read several workspace text files in one bounded call. Each path is validated with the same read-path rules as read; per-file failures are reported without aborting other files.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        paths: z
          .array(z.string().min(1))
          .min(1)
          .max(20)
          .describe("One to twenty workspace-relative file paths."),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Optional 1-indexed starting line applied to every file."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximum lines per file. Defaults to 200."),
      },
      outputSchema: resultOutputSchema({
        filesJson: z.string(),
        fileCount: z.number().int().nonnegative(),
        errorCount: z.number().int().nonnegative(),
        truncated: z.boolean(),
      }),
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, paths, offset, limit }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      workspaceAccess.assertWorkspaceReadable(workspace);
      const fileLimit = limit ?? 200;
      const files = [] as Array<{
        path: string;
        result?: string;
        error?: string;
        truncated?: boolean;
      }>;
      let remainingChars = READ_ONLY_RESULT_TEXT_BUDGET;
      let truncated = false;
      for (const path of paths) {
        if (remainingChars <= 0) {
          files.push({ path, result: "", truncated: true });
          truncated = true;
          continue;
        }
        try {
          const readPath = workspaces.resolveReadPath(workspace, path);
          const response = await readFileTool(
            { path: readPath.absolutePath, offset, limit: fileLimit },
            {
              cwd: workspace.root,
              root: workspace.root,
              readRoots: readPath.readRoots,
            },
          );
          if (response.isError) {
            files.push({ path, error: contentText(response.content) || "Read failed." });
            continue;
          }
          const text = contentText(response.content);
          const capped = capTextResult(text, remainingChars);
          files.push({ path, result: capped.text, truncated: capped.truncated });
          remainingChars -= capped.text.length;
          truncated ||= capped.truncated;
          workspaces.markReadPathLoaded(workspace, readPath);
        } catch (error) {
          files.push({ path, error: error instanceof Error ? error.message : String(error) });
        }
      }
      const errorCount = files.filter((file) => file.error).length;
      const result = files.map((file) => file.error
        ? `### ${file.path}\nERROR: ${file.error}`
        : `### ${file.path}\n${file.result ?? ""}`,
      ).join("\n\n");
      logToolCall(config, {
        tool: toolNames.batchReadFiles,
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content: [textBlock(result)],
        structuredContent: {
          result,
          filesJson: JSON.stringify(files),
          fileCount: files.length,
          errorCount,
          truncated,
        },
      };
    },
  );

  server.registerTool(
    toolNames.searchFiles,
    {
      title: "Search workspace files",
      description:
        "Search filenames or file contents inside the current workspace without shell commands. Filename mode accepts a glob pattern. Content mode accepts a regular expression by default or a literal string when literal=true and relies on the underlying read-only search engine's binary suppression rather than force-decoding binary files. The optional path is workspace-relative and cannot escape the workspace root.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        searchType: z
          .enum(["name", "content"])
          .describe("name searches paths using a glob; content searches text inside files."),
        query: z
          .string()
          .min(1)
          .max(16_000)
          .describe("Glob pattern for name search, or regex/literal text for content search."),
        path: z
          .string()
          .optional()
          .describe("Workspace-relative directory or file to search. Defaults to the workspace root."),
        glob: z
          .string()
          .optional()
          .describe("Optional file glob filter for content search, for example **/*.ts."),
        includeGlobs: z
          .array(z.string().min(1).max(500))
          .min(1)
          .max(10)
          .optional()
          .describe("Optional list of one to ten include globs for content search. When present, this takes precedence over glob and duplicate output lines are merged."),
        excludeGlobs: z
          .array(z.string().min(1).max(500))
          .max(20)
          .optional()
          .describe("Optional list of up to twenty glob patterns to remove from name or content results after searching."),
        extensions: z
          .array(z.string().min(1).max(50))
          .min(1)
          .max(20)
          .optional()
          .describe("Optional case-insensitive extension filter, for example [\"ts\", \".tsx\"]. Applied after include/exclude path filters."),
        minSizeBytes: z
          .number()
          .int()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER)
          .optional()
          .describe("Optional minimum file size in bytes, inclusive."),
        maxSizeBytes: z
          .number()
          .int()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER)
          .optional()
          .describe("Optional maximum file size in bytes, inclusive."),
        modifiedAfter: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe("Optional ISO 8601 timestamp; keep files modified on or after this instant."),
        modifiedBefore: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe("Optional ISO 8601 timestamp; keep files modified on or before this instant."),
        sortBy: z
          .enum(["path", "modified", "size"])
          .optional()
          .describe("Optional deterministic result ordering by normalized path, modification time, or file size."),
        sortOrder: z
          .enum(["asc", "desc"])
          .optional()
          .describe("Sort direction when sortBy is set. Defaults to asc."),
        ignoreCase: z
          .boolean()
          .optional()
          .describe("Ignore case for content search. Defaults to false."),
        literal: z
          .boolean()
          .optional()
          .describe("Treat content query as literal text instead of a regular expression."),
        context: z
          .number()
          .int()
          .min(0)
          .max(20)
          .optional()
          .describe("Context lines around each content match. Defaults to 0."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximum matching paths or content matches. Defaults to 100."),
      },
      outputSchema: resultOutputSchema({
        searchType: z.enum(["name", "content"]),
        matchesJson: z.string(),
        matchCount: z.number().int().nonnegative(),
        truncated: z.boolean(),
      }),
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async ({
      workspaceId,
      searchType,
      query,
      path,
      glob,
      includeGlobs,
      excludeGlobs,
      extensions,
      minSizeBytes,
      maxSizeBytes,
      modifiedAfter,
      modifiedBefore,
      sortBy,
      sortOrder,
      ignoreCase,
      literal,
      context,
      limit,
    }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      workspaceAccess.assertWorkspaceReadable(workspace);
      if (
        minSizeBytes !== undefined
        && maxSizeBytes !== undefined
        && minSizeBytes > maxSizeBytes
      ) {
        throw new Error("minSizeBytes must be less than or equal to maxSizeBytes.");
      }
      const modifiedAfterMs = modifiedAfter === undefined ? undefined : Date.parse(modifiedAfter);
      const modifiedBeforeMs = modifiedBefore === undefined ? undefined : Date.parse(modifiedBefore);
      if (
        modifiedAfterMs !== undefined
        && modifiedBeforeMs !== undefined
        && modifiedAfterMs > modifiedBeforeMs
      ) {
        throw new Error("modifiedAfter must be less than or equal to modifiedBefore.");
      }
      const effectiveLimit = limit ?? 100;
      const responses = searchType === "name"
        ? [await findFilesTool(
            { pattern: query, path: path ?? ".", limit: effectiveLimit },
            { cwd: workspace.root, root: workspace.root },
          )]
        : await Promise.all((includeGlobs?.length ? includeGlobs : [glob]).map((selectedGlob) =>
            grepFilesTool(
              {
                pattern: query,
                path: path ?? ".",
                glob: selectedGlob,
                ignoreCase,
                literal,
                context: context ?? 0,
                limit: effectiveLimit,
              },
              { cwd: workspace.root, root: workspace.root },
            ),
          ));

      const failedResponse = responses.find((response) => response.isError);
      if (failedResponse) {
        logFailedToolResponse(
          config,
          { tool: toolNames.searchFiles, workspaceId, path: path ?? "." },
          failedResponse.content,
          startedAt,
        );
        return failedResponse;
      }

      const resultLines: string[] = [];
      const seenLines = new Set<string>();
      for (const response of responses) {
        for (const line of contentText(response.content).split(/\r?\n/)) {
          if (!line || seenLines.has(line)) continue;
          seenLines.add(line);
          resultLines.push(line);
        }
      }
      const unfilteredResult = resultLines.join("\n");
      const excludedResult = filterSearchResultByExcludedGlobs(
        searchType,
        unfilteredResult,
        excludeGlobs ?? [],
      );
      let result = filterSearchResultByExtensions(
        searchType,
        excludedResult,
        extensions ?? [],
      );
      let metadata: Awaited<ReturnType<typeof collectSearchFileMetadata>> | undefined;
      if (
        minSizeBytes !== undefined
        || maxSizeBytes !== undefined
        || modifiedAfterMs !== undefined
        || modifiedBeforeMs !== undefined
      ) {
        const candidatePaths = parseSearchMatches(searchType, result).map((match) => match.path);
        const collectedMetadata = await collectSearchFileMetadata(
          workspace.root,
          path ?? ".",
          candidatePaths,
        );
        metadata = collectedMetadata;
        result = filterSearchResultByPath(searchType, result, (candidatePath) => {
          const file = collectedMetadata.get(candidatePath);
          if (!file) return false;
          if (minSizeBytes !== undefined && file.sizeBytes < minSizeBytes) return false;
          if (maxSizeBytes !== undefined && file.sizeBytes > maxSizeBytes) return false;
          if (modifiedAfterMs !== undefined && file.modifiedMs < modifiedAfterMs) return false;
          if (modifiedBeforeMs !== undefined && file.modifiedMs > modifiedBeforeMs) return false;
          return true;
        });
      }
      let matches = parseSearchMatches(searchType, result);
      if (sortBy) {
        const uniquePaths = [...new Set(matches.map((match) => match.path))];
        if ((sortBy === "modified" || sortBy === "size") && !metadata) {
          metadata = await collectSearchFileMetadata(
            workspace.root,
            path ?? ".",
            uniquePaths,
          );
        }
        const direction = (sortOrder ?? "asc") === "asc" ? 1 : -1;
        uniquePaths.sort((left, right) => {
          let compared = 0;
          if (sortBy === "path") {
            compared = left.localeCompare(right, undefined, { sensitivity: "base" });
          } else {
            const leftMeta = metadata?.get(left);
            const rightMeta = metadata?.get(right);
            const leftValue = sortBy === "size" ? leftMeta?.sizeBytes : leftMeta?.modifiedMs;
            const rightValue = sortBy === "size" ? rightMeta?.sizeBytes : rightMeta?.modifiedMs;
            if (leftValue === undefined && rightValue !== undefined) return 1;
            if (leftValue !== undefined && rightValue === undefined) return -1;
            if (leftValue !== undefined && rightValue !== undefined) {
              compared = leftValue - rightValue;
            }
            if (compared === 0) {
              compared = left.localeCompare(right, undefined, { sensitivity: "base" });
            }
          }
          return compared * direction;
        });
        result = orderSearchResultByPaths(searchType, result, uniquePaths);
        matches = parseSearchMatches(searchType, result);
      }
      const cappedResult = capTextResult(result);
      result = cappedResult.text;
      matches = parseSearchMatches(searchType, result);
      const resultPaths = [...new Set(matches.map((match) => match.path))];
      if (!metadata && resultPaths.length > 0) {
        metadata = await collectSearchFileMetadata(
          workspace.root,
          path ?? ".",
          resultPaths,
        );
      }
      const enrichedMatches = matches.map((match) => {
        const file = metadata?.get(match.path);
        return file
          ? {
              ...match,
              sizeBytes: file.sizeBytes,
              modifiedAt: file.modifiedAt,
            }
          : match;
      });
      const truncated = cappedResult.truncated || responses.some((response) => {
        const details = response.details as {
          resultLimitReached?: number;
          matchLimitReached?: number;
          truncation?: unknown;
          linesTruncated?: boolean;
        } | undefined;
        return Boolean(
          details?.resultLimitReached
            || details?.matchLimitReached
            || details?.truncation
            || details?.linesTruncated,
        );
      });
      logToolCall(config, {
        tool: toolNames.searchFiles,
        workspaceId,
        path: path ?? ".",
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content: [textBlock(result)],
        structuredContent: {
          result,
          searchType,
          matchesJson: JSON.stringify(enrichedMatches),
          matchCount: enrichedMatches.length,
          truncated,
        },
      };
    },
  );

  server.registerTool(
    toolNames.querySqlite,
    {
      title: "Query SQLite read-only",
      description:
        "Run one row-returning, read-only SQLite statement against a database inside the current workspace. Use for SELECT, WITH, EXPLAIN, and read-only PRAGMA inspection instead of exec_command or bash. The database is opened read-only and modifying statements are rejected.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        path: z.string().describe("Database path relative to the workspace root."),
        sql: z.string().min(1).max(64_000).describe("One read-only SQL statement."),
        parameters: z
          .array(z.union([z.string(), z.number(), z.null()]))
          .max(200)
          .optional()
          .describe("Optional positional parameters for question-mark placeholders."),
        maxRows: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximum returned rows. Defaults to 100."),
      },
      outputSchema: resultOutputSchema({
        columns: z.array(z.string()),
        rowsJson: z.string(),
        rowCount: z.number().int().nonnegative(),
        truncated: z.boolean(),
      }),
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, path, sql, parameters, maxRows }) => {
      const startedAt = performance.now();
      const queried = await runLoggedToolOperation(
        config,
        { tool: toolNames.querySqlite, workspaceId, path },
        startedAt,
        async () => {
          const workspace = workspaces.getWorkspace(workspaceId);
          workspaceAccess.assertWorkspaceReadable(workspace);
          const requestedPath = workspaces.resolvePath(workspace, path);
          const [databasePath, workspaceRoot] = await Promise.all([
            realpath(requestedPath),
            realpath(workspace.root),
          ]);
          assertAllowedPath(databasePath, [workspaceRoot]);
          return querySqliteReadOnly(
            databasePath,
            sql,
            parameters ?? [],
            maxRows ?? 100,
          );
        },
      );
      const rowsJson = JSON.stringify(queried.rows);
      const result = `Returned ${queried.rows.length} SQLite row(s)${queried.truncated ? " (truncated)" : ""}.`;
      return {
        content: [textBlock(`${result}\n${rowsJson}`)],
        structuredContent: {
          result,
          columns: queried.columns,
          rowsJson,
          rowCount: queried.rows.length,
          truncated: queried.truncated,
        },
      };
    },
  );

  toolSurface.register({
    server,
    config,
    workspaces,
    processSessions,
    workspaceAccess,
  });

  registerAppTool(
    server,
    "show_changes",
    {
      title: "Show changes",
      description:
        "Show the changes made in this turn for an open workspace. Call this once after the final related file change and before your final response so the user can review the combined diff. Do not call it after each individual file change.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
      },
      outputSchema: resultOutputSchema({
        workspaceId: z.string(),
        reviewRef: z.string().regex(/^[0-9a-f]{40,64}$/),
      }),
      ...workspaceAppDescriptorMeta(config),
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId }, { _meta }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      workspaceAccess.assertWorkspaceReadable(workspace);
      const reviewRef = typeof _meta?.["devspace/reviewRef"] === "string"
        ? _meta["devspace/reviewRef"]
        : undefined;
      const review = reviewRef
        ? await reviewCheckpoints.reviewByRef({
            workspaceId,
            root: workspace.root,
            reviewRef,
          })
        : await reviewCheckpoints.reviewChanges({
            workspaceId,
            root: workspace.root,
            markReviewed: true,
          });

      const content = [textBlock(review.result)];
      logToolCall(config, {
        tool: "show_changes",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        _meta: {
          card: {
            workspaceId,
            summary: review.summary,
            files: review.files,
            payload: {
              patch: review.patch,
            },
          },
        },
        structuredContent: {
          workspaceId,
          reviewRef: review.reviewRef,
          result: contentText(content),
        },
      };
    },
  );

  if (config.artifactsEnabled && isArtifactDownloadSupportedPlatform()) {
    registerArtifactTools(server, {
      config,
      workspaces,
      workspaceAccess,
      incomingArtifactAdapters,
    });
  }

  return server;
}

export interface CreateServerOptions {
  goalApi?: GoalApi;
  incomingArtifactAdapters?: readonly IncomingArtifactAdapter[];
}

function assertCardDiagnosticConfig(config: ServerConfig) {
  if (config.chatCardProbeEnabled && (!config.uiEnabled || config.goals?.enabled || config.subagents.enabled)) {
    throw new Error("Card diagnostic requires UI enabled and native Goals and local subagents disabled.");
  }
}

export function createServer(
  config = loadConfig(),
  options: CreateServerOptions = {},
): RunningServer {
  if (config.chatGoals?.enabled && (config.goals?.enabled || config.subagents.enabled)) {
    throw new Error("Chat Goals preview requires native Goals and local subagents disabled.");
  }
  assertCardDiagnosticConfig(config);
  const goalCardHtml=config.chatGoals?.enabled&&config.uiEnabled
    ?readFileSync(new URL("../dist/chat-goal-decision.html",import.meta.url),"utf8"):undefined;
  const computerApprovalHtml=config.computerUseEnabled&&config.uiEnabled&&process.platform==="win32"
    ?readFileSync(new URL("../dist/computer-use-approval.html",import.meta.url),"utf8"):undefined;
  // Load only the packaged static resource, before opening any local state.
  // No runtime resource paths or feature switches are accepted from the model.
  const cardDiagnostic = config.chatCardProbeEnabled ? {
    probe: new ChatCardProbe({ onEvent: (event, data) => {
      if (config.logging.toolCalls) logEvent(config.logging, "info", `chat_card_${event}`, data);
    } }),
    html: readFileSync(new URL("../dist/chat-card-probe.html", import.meta.url), "utf8"),
  } : undefined;
  const incomingArtifactAdapters = options.incomingArtifactAdapters
    ?? [createOpenAIIncomingArtifactAdapter()];
  const allowedHosts = config.allowedHosts.includes("*")
    ? undefined
    : Array.from(new Set([config.host, ...config.allowedHosts]));
  const app = createMcpExpressApp({
    host: config.host,
    ...(allowedHosts ? { allowedHosts } : {}),
  });
  const transports = new McpSessionRegistry<Transport>();
  const sessionServers = new Map<string, McpServer>();
  const toolCatalogRefresh = new McpToolCatalogRefreshTracker();
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "devspace"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const workspaceAccess = new WorkspaceAccessManager(config);
  const orchestration = new OrchestrationRegistry(new OrchestrationStore(config.stateDir));
  const coordinator = new OrchestrationCoordinator(
    new CoordinatorStore(config.stateDir),
    orchestration,
  );
  const workspaces = new WorkspaceRegistry(
    config,
    workspaceStore,
    (session) => workspaceAccess.workspaceRestoreAllowedRoots(session),
  );
  const chatGoals = config.chatGoals?.enabled ? new ChatGoalController({stateDir:config.stateDir,config:config.chatGoals}) : undefined;
  const orchestrationV2 = new OrchestrationV2(config, orchestration, coordinator, workspaces, workspaceAccess);
  const chatGoalDiagnostics=chatGoals?new ChatGoalDiagnostics(fields=>{
    if(config.logging.toolCalls)logEvent(config.logging,"info","chat_goal_call",fields);
  }):undefined;
  const goalCards=chatGoals&&goalCardHtml?{
    service:new ChatGoalCards(chatGoals,{onEvent:(event,data)=>{
      if(config.logging.toolCalls)logEvent(config.logging,"info",`chat_goal_card_${event}`,data);
    }}),html:goalCardHtml,scope:config.oauth.scopes[0]??"devspace",
  }:undefined;
  const configReloader = watchAllowedRoots(config);
  const reviewCheckpoints = createReviewCheckpointManager();
  const processSessions = new ProcessSessionManager();
  const codexCua = config.computerUseEnabled && process.platform === "win32"
    ? new CodexCuaBridge()
    : undefined;
  const computerApprovals = codexCua && computerApprovalHtml ? {
    service: new ComputerUseApprovals(),
    html: computerApprovalHtml,
    scope: config.oauth.scopes[0] ?? "devspace",
  } : undefined;
  const localAgentProviders = buildLocalAgentProviderStatuses(
    config.subagents,
    getLocalAgentProviderAvailabilitySnapshot(),
  );
  const resolveLocalAgentProviders = () => buildLocalAgentProviderStatuses(
    config.subagents,
    getLocalAgentProviderAvailabilitySnapshot(),
  );

  const logSessionCloseResults = (
    reason: "idle_timeout" | "server_shutdown",
    results: McpSessionCloseResult[],
  ) => {
    for (const result of results) {
      sessionServers.delete(result.sessionId);
      toolCatalogRefresh.remove(result.sessionId);
      if (result.error) {
        logEvent(config.logging, "warn", "mcp_session_close_failed", {
          reason,
          sessionIdPrefix: sessionIdPrefix(result.sessionId),
          error:
            result.error instanceof Error
              ? result.error.message
              : String(result.error),
        });
        continue;
      }

      logEvent(config.logging, "info", "mcp_session_closed", {
        reason,
        sessionIdPrefix: sessionIdPrefix(result.sessionId),
      });
    }
  };

  const sessionCleanupTimer = setInterval(() => {
    void transports
      .closeIdle(MCP_SESSION_IDLE_TIMEOUT_MS)
      .then((results) => logSessionCloseResults("idle_timeout", results));
  }, MCP_SESSION_CLEANUP_INTERVAL_MS);
  sessionCleanupTimer.unref();

  if (config.logging.trustProxy) {
    // The managed Cloudflare Tunnel connects to this listener from the local
    // machine. Trust only that loopback hop, never arbitrary remote proxies.
    app.set("trust proxy", "loopback");
  }

  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    res.locals.requestId = requestId;

    res.on("finish", () => {
      const path = requestPath(req);
      if (!config.logging.requests) return;
      if (!config.logging.assets && path.startsWith("/mcp-app-assets")) return;

      logEvent(config.logging, "info", "http_request", {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        ...requestLogFields(req, config),
      });
    });

    next();
  });

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(config.publicBaseUrl),
      baseUrl: new URL(config.publicBaseUrl),
      resourceServerUrl,
      scopesSupported: oauthSupportedScopes(config.oauth.scopes),
      resourceName: "DevSpace",
    }),
  );

  app.options("/mcp-app-assets/{*asset}", (_req, res) => {
    setAssetHeaders(res);
    res.sendStatus(204);
  });

  app.use(
    "/mcp-app-assets",
    express.static(uiBuildDirectory(), {
      immutable: true,
      maxAge: "1y",
      fallthrough: false,
      setHeaders: setAssetHeaders,
    }),
  );

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "devspace" });
  });

  if(chatGoalDiagnostics)app.use("/mcp",chatGoalDiagnostics.middleware);
  app.all("/mcp", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const sessionId = req.header("mcp-session-id");
    const initializeRequest = req.method === "POST" && isInitializeRequest(req.body);

    await new Promise<void>((resolve, reject) => {
      bearerAuth(req, res, (error?: unknown) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (res.headersSent) return;

    if (!req.auth?.resource || !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resourceServerUrl })) {
      logEvent(config.logging, "warn", "auth_denied", {
        requestId,
        method: req.method,
        path: requestPath(req),
        reason: "invalid_oauth_resource",
        ...requestLogFields(req, config),
      });
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    logEvent(config.logging, "debug", "mcp_request", {
      requestId,
      method: req.method,
      sessionIdPresent: Boolean(sessionId),
      sessionIdPrefix: sessionIdPrefix(sessionId),
      isInitialize: initializeRequest,
    });

    try {
      let transport: Transport | undefined;
      let sessionServer: McpServer | undefined;

      if (sessionId) {
        transport = transports.get(sessionId);
        sessionServer = sessionServers.get(sessionId);
        if (!transport) {
          sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
          return;
        }
      } else if (initializeRequest) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (transport) transports.register(newSessionId, transport);
            if (sessionServer) sessionServers.set(newSessionId, sessionServer);
            logEvent(config.logging, "info", "mcp_session_created", {
              requestId,
              sessionIdPrefix: sessionIdPrefix(newSessionId),
              ...requestLogFields(req, config),
            });
          },
        });

        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId && transports.remove(closedSessionId)) {
            sessionServers.delete(closedSessionId);
            toolCatalogRefresh.remove(closedSessionId);
            logEvent(config.logging, "info", "mcp_session_closed", {
              reason: "transport_close",
              sessionIdPrefix: sessionIdPrefix(closedSessionId),
            });
          }
        };

        sessionServer = createMcpServer(
          config,
          workspaces,
          reviewCheckpoints,
          processSessions,
          resolveLocalAgentProviders,
          incomingArtifactAdapters,
          workspaceAccess,
          options.goalApi,
          chatGoals,
          cardDiagnostic,
          goalCards,
          codexCua,
          computerApprovals,
          orchestration,
          coordinator,
          orchestrationV2,
        );
        chatGoalDiagnostics?.observeTransport(transport);
        await sessionServer.connect(transport);
      } else {
        sendJsonRpcError(res, 400, -32000, "No valid MCP session");
        return;
      }

      const handlingRequest = transport.handleRequest(req, res, req.body);

      // A valid Streamable HTTP GET remains open for the lifetime of the SSE
      // stream, so code after awaiting handleRequest cannot notify that stream.
      // Start a bounded watcher concurrently and send once Express has emitted
      // the SSE response headers, which means the transport has installed its
      // standalone server-to-client stream.
      if (req.method === "GET" && sessionId && sessionServer) {
        const startedAt = Date.now();
        const notifyWhenStreamReady = () => {
          if (!res.headersSent) {
            if (Date.now() - startedAt < 2_000 && !res.writableEnded) {
              const retry = setTimeout(notifyWhenStreamReady, 10);
              retry.unref();
            }
            return;
          }
          void toolCatalogRefresh.notifyOnce(sessionId, sessionServer!.server)
            .then((refreshResult) => {
              if (refreshResult !== "sent") return;
              logEvent(config.logging, "info", "mcp_tool_catalog_refresh_sent", {
                requestId,
                sessionIdPrefix: sessionIdPrefix(sessionId),
                toolSchemaVersion: DEVSPACE_TOOL_SCHEMA_VERSION,
              });
            })
            .catch((error) => {
              logEvent(config.logging, "warn", "mcp_tool_catalog_refresh_failed", {
                requestId,
                sessionIdPrefix: sessionIdPrefix(sessionId),
                error: error instanceof Error ? error.message : String(error),
              });
            });
        };
        const initialCheck = setTimeout(notifyWhenStreamReady, 0);
        initialCheck.unref();
      }

      await handlingRequest;
    } catch (error) {
      logEvent(config.logging, "error", "mcp_request_error", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  });

  let closePromise: Promise<void> | undefined;
  return {
    app,
    config,
    localAgentProviders,
    close: () => {
      closePromise ??= (async () => {
        clearInterval(sessionCleanupTimer);
        cardDiagnostic?.probe.close();
        await goalCards?.service.close();
        const results = await transports.closeAll();
        logSessionCloseResults("server_shutdown", results);
        sessionServers.clear();
        toolCatalogRefresh.clear();
        processSessions.shutdown();
        computerApprovals?.service.close();
        await codexCua?.close();
        await chatGoals?.close();
        configReloader.close();
        workspaceAccess.close();
        orchestrationV2.close();
        coordinator.close();
        orchestration.close();
        oauthProvider.close();
        workspaceStore.close?.();
      })();
      return closePromise;
    },
  };
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;

  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const entrypointPath = await realpath(process.argv[1]);
  return modulePath === entrypointPath;
}

if (await isMainModule()) {
  const { app, config, close, localAgentProviders } = createServer();
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(
      `devspace listening on http://${config.host}:${config.port}/mcp`,
    );
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log("auth: oauth owner-token flow required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    console.log(`request logging: ${config.logging.requests ? "enabled" : "disabled"}`);
    console.log(`asset logging: ${config.logging.assets ? "enabled" : "disabled"}`);
    console.log(`trust proxy: ${config.logging.trustProxy ? "enabled" : "disabled"}`);
    const artifactDownloadStatus = !config.artifactsEnabled
      ? "disabled"
      : isArtifactDownloadSupportedPlatform()
        ? "enabled"
        : `unsupported on ${process.platform}`;
    console.log(`native artifact download: ${artifactDownloadStatus}`);
    console.log(`subagent providers: ${formatLocalAgentProviderStatusSummary(localAgentProviders)}`);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownHttpServer(httpServer, close);
    process.exit(0);
  };
  const handleShutdown = () => {
    void shutdown().catch((error) => {
      console.error("devspace shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}
