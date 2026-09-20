import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OrchestrationRegistry } from "./orchestration-registry.js";
import {
  automaticSessionExternalId,
  projectKeyForWorkspace,
} from "./orchestration-scope.js";
import { openAiConversationScopeId } from "./request-meta.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import { observeValidationTree } from "./integration-merge-probe.js";
import { hasPositiveValidationReceipt, identifyValidationCommand } from "./orchestration-validation.js";

const TELEMETRY_ISSUER = "devspace-observed:" + randomUUID();

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
      const pendingValidation = scope
        ? await beginObservedValidation(registry, workspaces, scope.sessionId, name, args)
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
          await finishObservedValidation(registry, workspaces, scope.sessionId, name, args, result, pendingValidation);
          recordObservedToolResult(registry, scope.sessionId, name, args, result);
        }
        return result;
      } catch (error) {
        if (scope) {
          if (pendingValidation) {
            try { registry.finishUnboundTestRun(scope.sessionId, pendingValidation.testRunId, "tool_callback_failed"); } catch { /* no authority is inferred */ }
          }
          recordObservedError(registry, scope.sessionId, name, error, args);
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

interface PendingValidation {
  testRunId: string;
}

async function beginObservedValidation(
  registry: OrchestrationRegistry,
  workspaces: WorkspaceRegistry,
  sessionId: string,
  tool: string,
  args: unknown,
): Promise<PendingValidation | undefined> {
  if (tool !== "exec_command" || !isRecord(args) || typeof args.workspaceId !== "string") return undefined;
  const command = observedCommand(args);
  if (!command) return undefined;
  try {
    const workspace = workspaces.getWorkspace(args.workspaceId);
    const cwd = workspaces.resolveWorkingDirectory(workspace,
      typeof args.workingDirectory === "string" ? args.workingDirectory : undefined);
    const definition = await identifyValidationCommand(command, cwd);
    if (!definition) return undefined;
    const source = await observeValidationTree(workspace.root).catch(() => undefined);
    const environmentIdentity = createHash("sha256").update(JSON.stringify({
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      executable: process.execPath,
      path: process.env.PATH ?? process.env.Path ?? "",
    })).digest("hex");
    const run = registry.beginTestRun(sessionId, {
      kind: definition.kind,
      checkDefinition: definition.checkDefinition,
      requiresTestCount: definition.requiresTestCount,
      command,
      workingDirectory: cwd,
      testedCommit: source?.commit,
      testedTree: source?.tree,
      environmentIdentity,
      issuer: TELEMETRY_ISSUER,
    });
    return { testRunId: run.testRunId };
  } catch {
    return undefined;
  }
}

async function finishObservedValidation(
  registry: OrchestrationRegistry,
  workspaces: WorkspaceRegistry,
  sessionId: string,
  tool: string,
  args: unknown,
  result: unknown,
  pending?: PendingValidation,
): Promise<void> {
  try {
    const observation = processObservation(result);
    let run = pending ? undefined : observation.processSessionId
      ? registry.testRunByProcess(sessionId, observation.processSessionId)
      : undefined;
    if (tool === "exec_command" && pending) {
      if (!observation.processSessionId) {
        registry.finishUnboundTestRun(sessionId, pending.testRunId, "process_identity_missing");
        return;
      }
      run = registry.bindTestRunProcess(sessionId, pending.testRunId, observation.processSessionId);
    }
    if (!run || observation.running || !observation.processSessionId) return;
    const session = registry.get(sessionId);
    const after = await observeValidationTree(session.workspaceRoot).catch(() => undefined);
    const sourceStable = Boolean(after && run.testedCommit === after.commit && run.testedTree === after.tree);
    const definition = { kind: run.kind, checkDefinition: run.checkDefinition, requiresTestCount: run.requiresTestCount };
    const positiveReceipt = hasPositiveValidationReceipt(definition, resultText(result));
    registry.finishTestRun(sessionId, observation.processSessionId, {
      exitCode: observation.exitCode,
      signal: observation.signal,
      cancelled: observation.cancelled,
      timedOut: observation.timedOut,
      sourceStable,
      positiveReceipt,
      reason: isRecord(result) && result.isError === true ? "tool_error_result" : undefined,
    });
  } catch {
    // Validation telemetry is fail-closed and cannot change primary tool behavior.
  }
}

function processObservation(result: unknown): {
  processSessionId?: string; running: boolean; exitCode?: number; signal?: string; cancelled: boolean; timedOut: boolean;
} {
  if (!isRecord(result) || !isRecord(result.structuredContent)) {
    return { running: false, cancelled: false, timedOut: false };
  }
  const content = result.structuredContent;
  return {
    processSessionId: typeof content.processSessionId === "string" ? content.processSessionId : undefined,
    running: content.running === true,
    exitCode: typeof content.exitCode === "number" ? content.exitCode : undefined,
    signal: typeof content.signal === "string" ? content.signal : undefined,
    cancelled: content.cancelled === true,
    timedOut: content.timedOut === true,
  };
}

export function recordObservedToolResult(
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

    if (FILE_MUTATION_TOOLS.has(tool)) {
      const facts = observedMutationFacts(result);
      const paths = observedMutationPaths(tool, args, result, registry.get(sessionId).workspaceRoot);
      // Mutation is a fact about the tool result. Intents are a bounded advisory
      // projection and are not allowed to suppress this durable observation.
      if (!failed || facts.length > 0) {
        registry.recordEvent({
          sessionId, kind: "file_change",
          detail: { tool, paths, facts, provenance: facts.length ? "tool_result" : "successful_tool_arguments", partial: failed },
        });
        try {
          if (paths.length) registry.addFileIntents(sessionId, paths.map((path) => ({ path, access: "write" as const })));
        } catch (error) {
          registry.recordEvent({ sessionId, kind: "file_intents_projection_failed",
            detail: { tool, observedPathCount: paths.length, message: error instanceof Error ? error.message : String(error) } });
        }
      }
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

  } catch {
    // Telemetry must never change primary tool behavior.
  }
}

function recordObservedError(
  registry: OrchestrationRegistry,
  sessionId: string,
  tool: string,
  error: unknown,
  args?: unknown,
): void {
  try {
    if (FILE_MUTATION_TOOLS.has(tool)) {
      registry.recordEvent({ sessionId, kind: "file_change", detail: {
        tool, mutationState: "uncertain", paths: observedMutationPaths(tool, args),
        reason: "A mutating tool threw without a complete mutation receipt; do not assume no write occurred.",
      } });
    }
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

function observedMutationFacts(result: unknown): Array<{ path: string; previousPath?: string; operation?: string }> {
  if (!isRecord(result) || !isRecord(result.structuredContent) || !Array.isArray(result.structuredContent.files)) return [];
  return result.structuredContent.files.filter(isRecord).flatMap((file) => typeof file.path === "string"
    ? [{ path: file.path, previousPath: typeof file.previousPath === "string" ? file.previousPath : undefined,
      operation: typeof file.operation === "string" ? file.operation : undefined }] : []);
}

function observedMutationPaths(tool: string, args: unknown, result?: unknown, root?: string): string[] {
  const candidates = new Set<string>();
  const facts = observedMutationFacts(result);
  for (const fact of facts) {
    candidates.add(fact.path);
    if (fact.previousPath) candidates.add(fact.previousPath);
  }
  if (facts.length > 0) return [...candidates].map(path => root && isAbsolute(path) ? relative(root, path) : path)
    .map(path => path.replaceAll("\\", "/").replace(/^\.\//, ""));
  if (!isRecord(args)) return [];
  if (typeof args.path === "string") candidates.add(args.path);
  if (typeof args.destinationPath === "string") candidates.add(args.destinationPath);
  if (typeof args.destination === "string") candidates.add(args.destination);
  if (tool === "apply_patch" && typeof args.patch === "string") {
    const pattern = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm;
    for (const match of args.patch.matchAll(pattern)) {
      if (match[1]) candidates.add(match[1].trim());
    }
  }
  return [...candidates]
    .map(path => root && isAbsolute(path) ? relative(root, path) : path)
    .map((path) => path.replaceAll("\\", "/").replace(/^\.\//, ""))
    .filter((path) => path && path !== ".." && !path.startsWith("../"));
}

function observedCommand(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  if (typeof args.cmd === "string") return args.cmd;
  if (typeof args.command === "string") return args.command;
  return undefined;
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
