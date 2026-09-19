import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import { openAiConversationScopeId } from "./request-meta.js";
import { resultOutputSchema, textBlock, workspaceAppDescriptorMeta } from "./tool-surfaces/shared.js";
import { READ_TOOL_ANNOTATIONS, WORKSPACE_APP_URI } from "./tool-surfaces/types.js";
import {
  type WorkspaceAccessDecision,
  type WorkspaceAccessManager,
  type WorkspaceAccessRequest,
} from "./workspace-access.js";

const accessModeSchema = z.enum(["read", "modify"]);
const accessDecisionSchema = z.enum(["once", "session", "permanent", "deny"]);
const riskSchema = z.enum(["standard", "high"]);

export function workspaceAccessRequestMessage(request: WorkspaceAccessRequest): string {
  return request.status === "already_allowed"
    ? `${request.path} already has ${request.requestedAccess} access. Call open_workspace now.`
    : `User approval is required for ${request.requestedAccess} access to ${request.path}. Wait for the user to choose in the approval card.`;
}

export function workspaceAccessRequestCard(request: WorkspaceAccessRequest) {
  return {
    tool: "request_workspace_access" as const,
    requestId: request.id,
    path: request.path,
    requestedAccess: request.requestedAccess,
    status: request.status,
    risk: request.risk,
    temporaryScopeAvailable: request.temporaryScopeAvailable,
    reason: request.reason,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    approvalToken: request.approvalToken,
  };
}

export function registerWorkspaceAccessTools(
  server: McpServer,
  config: ServerConfig,
  accessManager: WorkspaceAccessManager,
): void {
  registerRequestTool(server, config, accessManager);
  registerApprovalTool(server, config, accessManager);
  registerListTool(server, accessManager);
  registerRevokeTool(server, accessManager);
  registerAuditTool(server, accessManager);
}

function registerRequestTool(
  server: McpServer,
  config: ServerConfig,
  accessManager: WorkspaceAccessManager,
): void {
  registerAppTool(
    server,
    "request_workspace_access",
    {
      title: "Request local folder access",
      description:
        "Create a user-visible approval card for an existing local folder that is outside the current DevSpace roots, or when stronger Modify access is needed. Never claim access was granted until the user approves the card. After approval, retry open_workspace.",
      inputSchema: {
        path: z.string().min(1).describe("Exact absolute path to the existing local folder."),
        access: accessModeSchema.describe(
          "Use read for inspection only, or modify for reading, writing, creating, deleting, renaming, commands, builds, and Blender automation.",
        ),
        reason: z.string().max(500).optional().describe(
          "Short, concrete explanation of why this folder and access level are needed.",
        ),
      },
      outputSchema: {
        result: z.string(),
        requestId: z.string(),
        path: z.string(),
        requestedAccess: accessModeSchema,
        status: z.enum(["pending", "already_allowed"]),
        risk: riskSchema,
        temporaryScopeAvailable: z.boolean(),
        reason: z.string().optional(),
        createdAt: z.string(),
        expiresAt: z.string(),
      },
      ...workspaceAppDescriptorMeta(config),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ path, access, reason }, { _meta }) => {
      const request = await accessManager.requestAccess({
        path,
        access,
        reason,
        conversationScopeId: openAiConversationScopeId(_meta),
      });
      const result = workspaceAccessRequestMessage(request);
      const card = workspaceAccessRequestCard(request);
      const { approvalToken: _approvalToken, tool: _tool, ...publicRequest } = card;

      return {
        content: [textBlock(result)],
        structuredContent: { result, ...publicRequest },
        _meta: {
          card,
        },
      };
    },
  );
}

function registerApprovalTool(
  server: McpServer,
  config: ServerConfig,
  accessManager: WorkspaceAccessManager,
): void {
  registerAppTool(
    server,
    "approve_workspace_access",
    {
      title: "Apply folder access decision",
      description:
        "Token-protected endpoint used by the DevSpace approval card. Do not call this directly: approval requires the one-time secret that is delivered only to the user-visible card.",
      inputSchema: {
        requestId: z.string().min(1),
        approvalToken: z.string().min(32),
        decision: accessDecisionSchema,
        confirmHighRisk: z.boolean().optional(),
      },
      outputSchema: {
        result: z.string(),
        requestId: z.string(),
        status: z.enum(["approved", "denied"]),
        path: z.string(),
        access: accessModeSchema,
        decision: accessDecisionSchema,
        grantId: z.string().optional(),
        expiresAt: z.string().optional(),
      },
      // This endpoint is callable only by the approval app from this MCP server.
      // It shares that app's resource URI as required by MCP Apps visibility
      // scoping. The opaque one-time token remains the authoritative server-side
      // proof of the user's card decision.
      _meta: config.uiEnabled
        ? {
            ui: {
              resourceUri: WORKSPACE_APP_URI,
              visibility: ["app"],
            },
            "openai/outputTemplate": WORKSPACE_APP_URI,
            "openai/visibility": "private",
            "openai/widgetAccessible": true,
          }
        : {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ requestId, approvalToken, decision, confirmHighRisk }, { _meta }) => {
      const approved = await accessManager.decideRequest({
        requestId,
        approvalToken,
        decision: decision as WorkspaceAccessDecision,
        confirmHighRisk,
        conversationScopeId: openAiConversationScopeId(_meta),
      });
      return {
        content: [textBlock(approved.message)],
        structuredContent: {
          result: approved.message,
          requestId,
          status: approved.status,
          path: approved.path,
          access: approved.access,
          decision: approved.decision,
          grantId: approved.grantId,
          expiresAt: approved.expiresAt,
        },
        _meta: {
          card: {
            tool: "approve_workspace_access",
            requestId,
            status: approved.status,
            path: approved.path,
            requestedAccess: approved.access,
            decision: approved.decision,
            message: approved.message,
          },
        },
      };
    },
  );
}

function registerListTool(server: McpServer, accessManager: WorkspaceAccessManager): void {
  server.registerTool(
    "list_workspace_access",
    {
      title: "List local folder access",
      description:
        "List DevSpace folder grants visible to this conversation, including configured roots and their access levels.",
      inputSchema: {},
      outputSchema: resultOutputSchema({
        grants: z.array(z.object({
          id: z.string(),
          path: z.string(),
          access: accessModeSchema,
          scope: z.enum(["configured", "once", "session", "permanent"]),
          expiresAt: z.string().optional(),
          createdAt: z.string(),
          active: z.boolean(),
          source: z.enum(["config", "approval"]),
        })),
      }),
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async (_input, { _meta }) => {
      const grants = accessManager.listGrants(openAiConversationScopeId(_meta)).map((grant) => ({
        id: grant.id,
        path: grant.path,
        access: grant.access,
        scope: grant.scope,
        expiresAt: grant.expiresAt,
        createdAt: grant.createdAt,
        active: grant.active,
        source: grant.source,
      }));
      const result = grants.length === 0
        ? "DevSpace has no approved folder roots."
        : `DevSpace has ${grants.filter((grant) => grant.active).length} active folder grant(s).`;
      return {
        content: [textBlock(result)],
        structuredContent: { result, grants },
      };
    },
  );
}

function registerRevokeTool(server: McpServer, accessManager: WorkspaceAccessManager): void {
  server.registerTool(
    "revoke_workspace_access",
    {
      title: "Revoke local folder access",
      description:
        "Remove the exact folder from DevSpace configuration and revoke approval grants for it. This does not delete or modify project files.",
      inputSchema: {
        path: z.string().min(1).describe("Exact folder path shown by list_workspace_access."),
      },
      outputSchema: resultOutputSchema({
        path: z.string(),
        revokedGrantCount: z.number().int().nonnegative(),
        removedFromConfig: z.boolean(),
        inheritedAccess: accessModeSchema.optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path }) => {
      const revoked = await accessManager.revokePath(path);
      const inherited = revoked.inheritedAccess
        ? ` The folder remains covered by a broader ${revoked.inheritedAccess} root.`
        : "";
      const result = `Revoked DevSpace access entries for ${revoked.path}.${inherited}`;
      return {
        content: [textBlock(result)],
        structuredContent: { result, ...revoked },
      };
    },
  );
}

function registerAuditTool(server: McpServer, accessManager: WorkspaceAccessManager): void {
  server.registerTool(
    "workspace_access_audit",
    {
      title: "Review folder access audit",
      description: "Show recent DevSpace folder permission requests, decisions, uses, and revocations.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional(),
      },
      outputSchema: resultOutputSchema({
        events: z.array(z.object({
          id: z.string(),
          event: z.string(),
          requestId: z.string().optional(),
          grantId: z.string().optional(),
          path: z.string(),
          access: accessModeSchema.optional(),
          scope: z.enum(["configured", "once", "session", "permanent", "deny"]).optional(),
          detail: z.string().optional(),
          createdAt: z.string(),
        })),
      }),
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async ({ limit }) => {
      const events = accessManager.listAudit(limit ?? 50);
      const result = `Returned ${events.length} workspace-access audit event(s).`;
      return {
        content: [textBlock(result)],
        structuredContent: { result, events },
      };
    },
  );
}
