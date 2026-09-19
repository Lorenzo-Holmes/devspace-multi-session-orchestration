import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OrchestrationRegistry } from "./orchestration-registry.js";
import {
  automaticSessionExternalId,
  projectKeyForWorkspace,
} from "./orchestration-scope.js";
import { openAiConversationScopeId } from "./request-meta.js";
import type { WorkspaceRegistry } from "./workspaces.js";

const FILE_MUTATION_TOOLS = new Set([
  "apply_patch",
  "write",
  "edit",
  "download_artifact",
]);

const TELEMETRY_EXCLUDED_PREFIXES = [
  "session_",
  "chat_goal_",
  "chat_card_",
  "worktree_", "integration_", "watchdog_", "handoff_", "project_memory_", "supervisor_", "automation_",
];

export function installOrchestrationTelemetry(
  server: McpServer,
  registry: OrchestrationRegistry,
  workspaces: WorkspaceRegistry,
): void {
  const original = server.registerTool.bind(server) as (
    name: string,
    config: unknown,
    callback: (args: unknown, extra: unknown) => unknown,
  ) => unknown;

  (server as unknown as {
    registerTool: typeof original;
  }).registerTool = (name, config, callback) => original(
    name,
    config,
    async (args: unknown, extra: unknown) => {
      if (TELEMETRY_EXCLUDED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
        return await callback(args, extra);
      }

      const conversationId = trustedConversationId(extra);
      let scope = conversationId
        ? telemetryScopeFromArgs(args, conversationId, registry, workspaces)
        : undefined;

      try {
        const result = await callback(args, extra);
        if (conversationId && !scope) {
          scope = telemetryScopeFromResult(
            result,
            conversationId,
            registry,
            workspaces,
          );
        }
        if (scope) {
          recordObservedToolResult(registry, scope.sessionId, name, args, result);
        }
        return result;
      } catch (error) {
        if (scope) {
          recordObservedError(registry, scope.sessionId, name, error);
        }
        throw error;
      }
    },
  ) as never;
}

function telemetryScopeFromArgs(
  args: unknown,
  conversationId: string,
  registry: OrchestrationRegistry,
  workspaces: WorkspaceRegistry,
): { sessionId: string } | undefined {
  if (!isRecord(args) || typeof args.workspaceId !== "string") return undefined;
  return ensureAutomaticSession(
    args.workspaceId,
    conversationId,
    registry,
    workspaces,
  );
}

function telemetryScopeFromResult(
  result: unknown,
  conversationId: string,
  registry: OrchestrationRegistry,
  workspaces: WorkspaceRegistry,
): { sessionId: string } | undefined {
  if (!isRecord(result) || !isRecord(result.structuredContent)) return undefined;
  const workspaceId = result.structuredContent.workspaceId;
  if (typeof workspaceId !== "string") return undefined;
  return ensureAutomaticSession(
    workspaceId,
    conversationId,
    registry,
    workspaces,
  );
}

function ensureAutomaticSession(
  workspaceId: string,
  conversationId: string,
  registry: OrchestrationRegistry,
  workspaces: WorkspaceRegistry,
): { sessionId: string } | undefined {
  try {
    const workspace = workspaces.getWorkspace(workspaceId);
    const projectKey = projectKeyForWorkspace(workspace);
    const session = registry.register({
      projectKey,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      sessionKind: "chatgpt_auto",
      externalSessionId: automaticSessionExternalId(projectKey, conversationId),
      label: "Automatic ChatGPT telemetry",
      state: "running",
    });
    return { sessionId: session.id };
  } catch {
    return undefined;
  }
}

function recordObservedToolResult(
  registry: OrchestrationRegistry,
  sessionId: string,
  tool: string,
  args: unknown,
  result: unknown,
): void {
  try {
    const failed = isRecord(result) && result.isError === true;
    registry.heartbeat(sessionId, {
      detail: { source: "automatic_tool", tool, failed },
    });

    const command = observedCommand(args);
    if (command && looksLikeValidationCommand(command)) {
      registry.recordEvent({
        sessionId,
        kind: "test_run",
        detail: failed
          ? {
              tool,
              passed: false,
              fingerprint: errorFingerprint(tool, resultText(result)),
            }
          : { tool, passed: true },
      });
      return;
    }

    if (failed) {
      registry.recordEvent({
        sessionId,
        kind: "error",
        detail: {
          tool,
          fingerprint: errorFingerprint(tool, resultText(result)),
        },
      });
      return;
    }

    if (FILE_MUTATION_TOOLS.has(tool)) {
      const paths = observedMutationPaths(tool, args);
      if (paths.length > 0) {
        registry.addFileIntents(
          sessionId,
          paths.map((path) => ({ path, access: "write" as const })),
        );
      }
      registry.recordEvent({
        sessionId,
        kind: "file_change",
        detail: { tool, paths },
      });
    }
  } catch {
    // Telemetry must never change primary tool behavior.
  }
}

function recordObservedError(
  registry: OrchestrationRegistry,
  sessionId: string,
  tool: string,
  error: unknown,
): void {
  try {
    registry.recordEvent({
      sessionId,
      kind: "error",
      detail: {
        tool,
        fingerprint: errorFingerprint(
          tool,
          error instanceof Error ? error.message : String(error),
        ),
      },
    });
  } catch {
    // Telemetry must never change primary tool behavior.
  }
}

function trustedConversationId(extra: unknown): string | undefined {
  if (!isRecord(extra)) return undefined;
  return openAiConversationScopeId(extra._meta);
}

function observedMutationPaths(tool: string, args: unknown): string[] {
  if (!isRecord(args)) return [];
  const candidates = new Set<string>();
  if (typeof args.path === "string") candidates.add(args.path);
  if (typeof args.destinationPath === "string") candidates.add(args.destinationPath);
  if (typeof args.destination === "string") candidates.add(args.destination);
  if (tool === "apply_patch" && typeof args.patch === "string") {
    const pattern = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
    for (const match of args.patch.matchAll(pattern)) {
      if (match[1]) candidates.add(match[1].trim());
    }
  }
  return [...candidates]
    .map((path) => path.replaceAll("\\", "/").replace(/^\.\//, ""))
    .filter((path) => path && path !== ".." && !path.startsWith("../"));
}

function observedCommand(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  if (typeof args.cmd === "string") return args.cmd;
  if (typeof args.command === "string") return args.command;
  return undefined;
}

function looksLikeValidationCommand(command: string): boolean {
  return /(?:^|\s)(?:pytest|jest|vitest|mocha|tsc)(?:\s|$)|node\s+--test(?:\s|$)|tsx(?:\.cmd)?(?:\s+\S+)*\s+--test(?:\s|$)|npm\s+(?:run\s+)?(?:test|build)(?:\s|$)|pnpm\s+(?:run\s+)?(?:test|build)(?:\s|$)|yarn\s+(?:test|build)(?:\s|$)|vite\s+build(?:\s|$)/i.test(command);
}

function errorFingerprint(tool: string, detail: string): string {
  const normalized = detail.replace(/\s+/g, " ").trim().slice(0, 1000);
  return createHash("sha256")
    .update(tool)
    .update("\0")
    .update(normalized)
    .digest("hex")
    .slice(0, 24);
}

function resultText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) return "";
  return result.content
    .filter(isRecord)
    .map((item) => typeof item.text === "string" ? item.text : "")
    .filter(Boolean)
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
