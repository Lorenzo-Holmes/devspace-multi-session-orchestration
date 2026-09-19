import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import {
  codexCuaElicitationMeta,
  type CodexCuaElicitationParams,
  type CodexCuaElicitationResult,
} from "./codex-cua-bridge.js";
import type { WorkspaceAccessManager } from "./workspace-access.js";
import type { WorkspaceRegistry } from "./workspaces.js";

export const COMPUTER_USE_APPROVAL_URI = "ui://devspace/computer-use-approval-v1.html";

type WaitOutcome = "accepted" | "declined" | "timeout" | "transport_aborted" | "service_closed";
type Approval = {
  id: string;
  identity: string;
  workspaceId: string;
  app: string;
  displayName: string;
  requestMessage: string;
  message: string;
  riskLevel: "low" | "high" | "unknown";
  token: string;
  createdAt: number;
  expiresAt: number;
  revision: number;
  waitStarted: boolean;
  waitDeadlineAt?: number;
  waitOutcome?: WaitOutcome;
  decision?: "accept" | "decline";
  consumed: boolean;
  finish?: (outcome: WaitOutcome) => void;
};

const approvalOutputSchema = {
  approvalId: z.string().uuid(),
  revision: z.number().int().positive(),
  serverNow: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  workspaceId: z.string(),
  app: z.string(),
  displayName: z.string(),
  message: z.string(),
  riskLevel: z.enum(["low", "high", "unknown"]),
  canSubmit: z.boolean(),
  waitStarted: z.boolean(),
  waitActive: z.boolean(),
  waitDeadlineAt: z.number().int().nonnegative().nullable(),
  waitOutcome: z.enum(["accepted", "declined", "timeout", "transport_aborted", "service_closed"]).nullable(),
  decision: z.enum(["accept", "decline"]).nullable(),
  consumed: z.boolean(),
  state: z.enum(["pending", "accepted", "declined", "expired", "closed"]),
  nextAction: z.enum(["wait_once", "wait_already_active", "retry_original_action", "stop"]),
};

export function computerApprovalIdentity(auth: unknown): string {
  const value = auth as { clientId?: string; extra?: Record<string, unknown> } | undefined;
  if (!value?.clientId || value.extra?.devspaceOwnerRef !== "single-user") {
    throw new Error("AUTHENTICATION_REQUIRED: verified OAuth owner required for Computer Use approval.");
  }
  return JSON.stringify([value.extra.devspaceOwnerRef, value.clientId]);
}

/** Human approval presentation for Codex Computer Use app access. This is
 * intentionally separate from Goal decisions and workspace permissions. */
export class ComputerUseApprovals {
  private records = new Map<string, Approval>();
  private approvedSessions = new Map<string, number>();
  private closed = false;
  constructor(private options: { now?: () => number; waitMs?: number; ttlMs?: number; approvalMs?: number } = {}) {
    const waitMs = options.waitMs ?? 45_000;
    const ttlMs = options.ttlMs ?? 5 * 60_000;
    const approvalMs = options.approvalMs ?? 15 * 60_000;
    if (!Number.isFinite(waitMs) || waitMs < 1 || waitMs > 45_000) throw new Error("INVALID_COMPUTER_APPROVAL_WAIT_LIMIT");
    if (!Number.isFinite(ttlMs) || ttlMs < waitMs || ttlMs > 5 * 60_000) throw new Error("INVALID_COMPUTER_APPROVAL_TTL");
    if (!Number.isFinite(approvalMs) || approvalMs < 1 || approvalMs > 15 * 60_000) throw new Error("INVALID_COMPUTER_APPROVAL_SESSION_TTL");
  }

  private now() { return this.options.now?.() ?? Date.now(); }

  prepare(identity: string, workspaceId: string, request: CodexCuaElicitationParams): string {
    if (this.closed) throw new Error("COMPUTER_APPROVAL_SERVICE_CLOSED");
    const { app, displayName, riskLevel } = approvalTarget(request);
    this.prune();
    const existing = [...this.records.values()].find(record =>
      record.identity === identity && record.workspaceId === workspaceId && record.app === app &&
      record.requestMessage === request.message && !record.decision && !record.waitOutcome && this.now() < record.expiresAt,
    );
    if (existing) return existing.id;
    if (this.records.size >= 64) throw new Error("COMPUTER_APPROVAL_LIMIT: wait for pending approvals to expire.");
    const createdAt = this.now();
    const record: Approval = {
      id: randomUUID(), identity, workspaceId, app, displayName,
      requestMessage: request.message,
      message: approvalDisplayMessage(request.message, app, displayName),
      riskLevel,
      token: randomBytes(32).toString("hex"), createdAt,
      expiresAt: createdAt + (this.options.ttlMs ?? 5 * 60_000), revision: 1,
      waitStarted: false, consumed: false,
    };
    this.records.set(record.id, record);
    return record.id;
  }

  consumeAccepted(identity: string, workspaceId: string, request: CodexCuaElicitationParams): CodexCuaElicitationResult | undefined {
    const { app } = approvalTarget(request);
    this.prune();
    const sessionKey = this.sessionKey(identity, workspaceId, app);
    const sessionExpiresAt = this.approvedSessions.get(sessionKey);
    if (sessionExpiresAt && this.now() < sessionExpiresAt) {
      const sourceRecord = [...this.records.values()].reverse().find(candidate =>
        candidate.identity === identity && candidate.workspaceId === workspaceId && candidate.app === app &&
        candidate.decision === "accept" && !candidate.consumed,
      );
      if (sourceRecord) {
        sourceRecord.consumed = true;
        sourceRecord.revision++;
      }
      return { action: "accept", content: { persist: "session" } };
    }
    if (sessionExpiresAt) this.approvedSessions.delete(sessionKey);
    const record = [...this.records.values()].reverse().find(candidate =>
      candidate.identity === identity && candidate.workspaceId === workspaceId && candidate.app === app &&
      candidate.requestMessage === request.message && candidate.decision === "accept" && !candidate.consumed &&
      this.now() < candidate.expiresAt,
    );
    if (!record) return undefined;
    record.consumed = true;
    record.revision++;
    return { action: "accept", content: { persist: "session" } };
  }

  show(identity: string, workspaceId: string, id: string): CallToolResult {
    const record = this.owned(identity, id);
    if (record.workspaceId !== workspaceId) throw new Error("COMPUTER_APPROVAL_WORKSPACE_MISMATCH");
    return this.result(record);
  }

  async wait(identity: string, workspaceId: string, id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const record = this.owned(identity, id);
    if (record.workspaceId !== workspaceId) throw new Error("COMPUTER_APPROVAL_WORKSPACE_MISMATCH");
    this.tick(record);
    if (record.finish) throw new Error("COMPUTER_APPROVAL_WAIT_IN_PROGRESS");
    if (record.waitOutcome || record.waitStarted || this.now() >= record.expiresAt) return this.view(record);
    if (signal?.aborted) throw new Error("COMPUTER_APPROVAL_WAIT_ABORTED");
    record.waitStarted = true;
    record.waitDeadlineAt = Math.min(this.now() + (this.options.waitMs ?? 45_000), record.expiresAt);
    record.revision++;
    await new Promise<void>(resolve => {
      const finish = (outcome: WaitOutcome) => {
        if (!record.finish) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        delete record.finish;
        record.waitOutcome = outcome;
        record.revision++;
        resolve();
      };
      const aborted = () => finish("transport_aborted");
      const timer = setTimeout(() => finish("timeout"), Math.max(0, record.waitDeadlineAt! - this.now()));
      record.finish = finish;
      signal?.addEventListener("abort", aborted, { once: true });
    });
    return this.view(record);
  }

  submit(identity: string, id: string, token: string, decision: "accept" | "decline"): Record<string, unknown> {
    const record = this.authenticated(identity, id, token);
    this.tick(record);
    if (record.decision) {
      if (record.decision !== decision) throw new Error("COMPUTER_APPROVAL_ALREADY_DECIDED");
      return { ...this.view(record), replayed: true };
    }
    if (this.now() >= record.expiresAt) throw new Error("COMPUTER_APPROVAL_EXPIRED_OR_CLOSED");
    record.decision = decision;
    record.revision++;
    if (decision === "accept") {
      this.approvedSessions.set(
        this.sessionKey(record.identity, record.workspaceId, record.app),
        this.now() + (this.options.approvalMs ?? 15 * 60_000),
      );
    }
    if (record.finish) record.finish(decision === "accept" ? "accepted" : "declined");
    else record.waitOutcome = decision === "accept" ? "accepted" : "declined";
    return { ...this.view(record), replayed: false };
  }

  close() {
    this.closed = true;
    for (const record of this.records.values()) if (record.finish) record.finish("service_closed");
    this.approvedSessions.clear();
  }

  private owned(identity: string, id: string) {
    if (this.closed) throw new Error("COMPUTER_APPROVAL_SERVICE_CLOSED");
    const record = this.records.get(id);
    if (!record || record.identity !== identity) throw new Error("COMPUTER_APPROVAL_NOT_FOUND");
    return record;
  }

  private authenticated(identity: string, id: string, token: string) {
    const record = this.owned(identity, id);
    const actual = Buffer.from(token), expected = Buffer.from(record.token);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("INVALID_COMPUTER_APPROVAL_TOKEN");
    return record;
  }

  private tick(record: Approval) {
    if (record.finish && this.now() >= record.waitDeadlineAt!) record.finish("timeout");
  }

  private prune() {
    for (const [id, record] of this.records) {
      if (this.now() >= record.expiresAt && !record.finish) this.records.delete(id);
    }
    for (const [key, expiresAt] of this.approvedSessions) {
      if (this.now() >= expiresAt) this.approvedSessions.delete(key);
    }
  }

  private sessionKey(identity: string, workspaceId: string, app: string) {
    return JSON.stringify([identity, workspaceId, app]);
  }

  private view(record: Approval): Record<string, unknown> {
    this.tick(record);
    const expired = this.now() >= record.expiresAt;
    const state = expired ? "expired" : record.decision === "accept" ? "accepted" : record.decision === "decline" ? "declined" : record.waitOutcome && record.waitOutcome !== "timeout" ? "closed" : "pending";
    const nextAction = record.waitOutcome === "accepted" && !record.consumed ? "retry_original_action"
      : record.waitOutcome || expired ? "stop"
        : record.finish ? "wait_already_active" : "wait_once";
    return {
      approvalId: record.id, revision: record.revision, serverNow: this.now(), createdAt: record.createdAt,
      expiresAt: record.expiresAt, workspaceId: record.workspaceId, app: record.app, displayName: record.displayName,
      message: record.message, riskLevel: record.riskLevel,
      canSubmit: !expired && !record.decision && (!record.waitOutcome || record.waitOutcome === "timeout"),
      waitStarted: record.waitStarted, waitActive: Boolean(record.finish), waitDeadlineAt: record.waitDeadlineAt ?? null,
      waitOutcome: record.waitOutcome ?? null, decision: record.decision ?? null, consumed: record.consumed,
      state, nextAction,
    };
  }

  private result(record: Approval): CallToolResult {
    const view = this.view(record);
    return {
      content: [{ type: "text", text: "Computer Use app approval requires the user's card choice. Call computer_approval_wait exactly once while this Chat request remains active. Retry the original observe/computer call only after nextAction=retry_original_action." }],
      structuredContent: view,
      _meta: { computerApproval: { approvalId: record.id, submitToken: record.token } },
    };
  }
}

export function registerComputerUseApprovalTools(
  server: McpServer,
  approvals: ComputerUseApprovals,
  html: string,
  workspaces: WorkspaceRegistry,
  workspaceAccess: WorkspaceAccessManager,
  scope = "devspace",
) {
  const securitySchemes = [{ type: "oauth2", scopes: [scope] }];
  const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const viewMeta = { securitySchemes, ui: { resourceUri: COMPUTER_USE_APPROVAL_URI, visibility: ["model", "app"] } };
  const appMeta = { securitySchemes, ui: { visibility: ["app"] } };
  const failure = (error: unknown): CallToolResult => ({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "COMPUTER_APPROVAL_FAILED" }] });

  registerAppResource(server, "Computer Use app approval", COMPUTER_USE_APPROVAL_URI, {
    description: "Explicit short-lived session approval card for Codex Computer Use app access.",
  }, async (uri, extra) => {
    computerApprovalIdentity(extra.authInfo);
    return { contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: html, _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } } }] };
  });

  registerAppTool(server, "computer_approval_show", {
    title: "Show Codex Computer Use app approval",
    description: "Show the exact pending Codex Computer Use app approval created by a failed observe/computer call. Then call computer_approval_wait exactly once. This cannot create a new app request or approve for the user. Allow creates only a short in-memory session for this OAuth client, workspace, and app.",
    inputSchema: { workspaceId: z.string(), approvalId: z.string().uuid() },
    outputSchema: approvalOutputSchema,
    annotations: readAnnotations,
    _meta: viewMeta,
  }, async (args, extra) => {
    try {
      const workspace = workspaces.getWorkspace(args.workspaceId);
      workspaceAccess.assertWorkspaceReadable(workspace);
      return approvals.show(computerApprovalIdentity(extra.authInfo), args.workspaceId, args.approvalId);
    } catch (error) { return failure(error); }
  });

  server.registerTool("computer_approval_wait", {
    title: "Wait once for Codex Computer Use app approval",
    description: "Wait once, at most 45 seconds, for the user's Computer Use approval card choice. Only nextAction=retry_original_action permits retrying the original observe/computer call. Timeout/decline means stop.",
    inputSchema: { workspaceId: z.string(), approvalId: z.string().uuid() },
    outputSchema: approvalOutputSchema,
    annotations: { ...writeAnnotations, idempotentHint: false },
    _meta: { securitySchemes },
  }, async (args, extra) => {
    try {
      const workspace = workspaces.getWorkspace(args.workspaceId);
      workspaceAccess.assertWorkspaceReadable(workspace);
      const data = await approvals.wait(computerApprovalIdentity(extra.authInfo), args.workspaceId, args.approvalId, extra.signal);
      return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
    } catch (error) { return failure(error); }
  });

  registerAppTool(server, "computer_approval_submit", {
    title: "Submit the user's Computer Use app approval",
    description: "App-only. Records the user's explicit Allow/Deny choice for one pending Codex Computer Use app request. Allow creates only a short in-memory session bound to the authenticated OAuth client, workspace, and app; it is not persisted to disk or Windows settings.",
    inputSchema: { approvalId: z.string().uuid(), submitToken: z.string().length(64), decision: z.enum(["accept", "decline"]) },
    outputSchema: approvalOutputSchema,
    annotations: writeAnnotations,
    _meta: appMeta,
  }, async (args, extra) => {
    try {
      const data = approvals.submit(computerApprovalIdentity(extra.authInfo), args.approvalId, args.submitToken, args.decision);
      return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
    } catch (error) { return failure(error); }
  });
}

function approvalTarget(request: CodexCuaElicitationParams) {
  const meta = codexCuaElicitationMeta(request);
  const toolParams = meta.tool_params;
  const toolParamRecord = toolParams && typeof toolParams === "object" && !Array.isArray(toolParams)
    ? toolParams as Record<string, unknown>
    : undefined;
  const reportedApp = typeof toolParamRecord?.app === "string" ? toolParamRecord.app : undefined;
  const browserOrigin = typeof meta.origin === "string"
    ? meta.origin
    : typeof toolParamRecord?.origin === "string"
      ? toolParamRecord.origin
      : undefined;
  const browserTool = typeof meta.tool_name === "string" ? meta.tool_name : undefined;
  // Browser Use approvals do not carry tool_params.app. Scope their temporary
  // approval sessions to the concrete browser operation + origin instead of
  // collapsing every browser prompt into one "unknown-app" session.
  const app = reportedApp
    ?? (browserOrigin || browserTool
      ? `browser:${browserTool ?? "access"}:${browserOrigin ?? "unknown-origin"}`
      : "unknown-app");
  const rows = Array.isArray(meta.tool_params_display) ? meta.tool_params_display : [];
  const displayRow = rows.find(row => row && typeof row === "object" && (row as Record<string, unknown>).name === "app");
  const reportedDisplayName = displayRow && typeof (displayRow as Record<string, unknown>).value === "string"
    ? String((displayRow as Record<string, unknown>).value)
    : browserOrigin
      ? `Browser access to ${browserOrigin}`
      : app;
  const displayName = canonicalAppDisplayName(app) ?? reportedDisplayName;
  const riskLevel = meta.riskLevel === "low" || meta.riskLevel === "high" ? meta.riskLevel : "unknown";
  return { app, displayName, riskLevel } as const;
}

function canonicalAppDisplayName(app: string): string | undefined {
  const normalized = app.trim().replaceAll("/", "\\").toLowerCase();
  const base = normalized.split("\\").at(-1) ?? normalized;
  if (base === "explorer.exe") return "File Explorer";
  if (base === "msedge.exe" || base === "msedge") return "Microsoft Edge";
  if (base === "chrome.exe" || base === "chrome") return "Google Chrome";
  return undefined;
}

function approvalDisplayMessage(source: string, app: string, displayName: string): string {
  if (canonicalAppDisplayName(app)) return `Allow Codex to use ${displayName}?`;
  return source;
}
