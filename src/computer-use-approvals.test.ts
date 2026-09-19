import assert from "node:assert/strict";
import test from "node:test";
import { ComputerUseApprovals } from "./computer-use-approvals.js";
import type { CodexCuaElicitationParams } from "./codex-cua-bridge.js";

const request: CodexCuaElicitationParams = {
  message: "Allow Codex to use File Explorer?",
  mode: "form",
  requestedSchema: { type: "object", properties: {} },
  _meta: {
    riskLevel: "low",
    tool_params: { app: "explorer.exe" },
    tool_params_display: [{ name: "app", display_name: "App", value: "File Explorer" }],
  },
};

const directHelperRequest: CodexCuaElicitationParams = {
  message: "Allow Codex to use Windows Software Development Kit?",
  meta: {
    codex_approval_kind: "mcp_tool_call",
    connector_id: "computer-use",
    connector_name: "Computer Use",
    persist: ["session", "always"],
    riskLevel: "low",
    tool_params: { app: "explorer.exe" },
    tool_params_display: [{ name: "app", display_name: "App", value: "Windows Software Development Kit" }],
  },
};

const browserOriginRequest: CodexCuaElicitationParams = {
  message: "Allow Browser use to access https://studio.tripo3d.ai?",
  meta: {
    codex_approval_kind: "mcp_tool_call",
    connector_id: "browser-use",
    connector_name: "Browser use",
    riskLevel: "high",
    tool_name: "access_browser_origin",
    tool_params: { origin: "https://studio.tripo3d.ai" },
    origin: "https://studio.tripo3d.ai",
  },
};

test("Computer Use approval is explicit, short-lived, and app/workspace/client bound", async () => {
  let now = 1_000;
  const approvals = new ComputerUseApprovals({ now: () => now, waitMs: 200, ttlMs: 2_000, approvalMs: 500 });
  const identity = "owner-client-a", workspaceId = "ws-a";
  try {
    const approvalId = approvals.prepare(identity, workspaceId, request);
    const shown = approvals.show(identity, workspaceId, approvalId);
    const meta = shown._meta?.computerApproval as { approvalId: string; submitToken: string };
    assert.equal(meta.approvalId, approvalId);
    assert.equal((shown.structuredContent as Record<string, unknown>).displayName, "File Explorer");

    const waiting = approvals.wait(identity, workspaceId, approvalId);
    const submitted = approvals.submit(identity, approvalId, meta.submitToken, "accept");
    assert.equal(submitted.waitOutcome, "accepted");
    const waited = await waiting;
    assert.equal(waited.nextAction, "retry_original_action");

    assert.deepEqual(approvals.consumeAccepted(identity, workspaceId, request), { action: "accept", content: { persist: "session" } });
    assert.deepEqual(approvals.consumeAccepted(identity, workspaceId, request), { action: "accept", content: { persist: "session" } }, "accepted app remains approved within the short session");
    assert.equal(approvals.consumeAccepted("owner-client-b", workspaceId, request), undefined);
    assert.equal(approvals.consumeAccepted(identity, "ws-b", request), undefined);
    now += 501;
    assert.equal(approvals.consumeAccepted(identity, workspaceId, request), undefined, "session approval expires");
  } finally {
    approvals.close();
  }
});

test("Computer Use denial never becomes an accepted helper response", async () => {
  const approvals = new ComputerUseApprovals({ waitMs: 200, ttlMs: 2_000 });
  const identity = "owner-client-a", workspaceId = "ws-a";
  try {
    const approvalId = approvals.prepare(identity, workspaceId, request);
    const shown = approvals.show(identity, workspaceId, approvalId);
    const token = (shown._meta?.computerApproval as { submitToken: string }).submitToken;
    const waiting = approvals.wait(identity, workspaceId, approvalId);
    approvals.submit(identity, approvalId, token, "decline");
    const waited = await waiting;
    assert.equal(waited.waitOutcome, "declined");
    assert.equal(waited.nextAction, "stop");
    assert.equal(approvals.consumeAccepted(identity, workspaceId, request), undefined);
  } finally {
    approvals.close();
  }
});

test("Computer Use approval rejects cross-client access and invalid card tokens", () => {
  const approvals = new ComputerUseApprovals({ waitMs: 100, ttlMs: 1_000 });
  try {
    const approvalId = approvals.prepare("owner-a", "ws-a", request);
    const shown = approvals.show("owner-a", "ws-a", approvalId);
    const token = (shown._meta?.computerApproval as { submitToken: string }).submitToken;
    assert.throws(() => approvals.show("owner-b", "ws-a", approvalId), /NOT_FOUND/);
    assert.throws(() => approvals.show("owner-a", "ws-b", approvalId), /WORKSPACE_MISMATCH/);
    assert.throws(() => approvals.submit("owner-a", approvalId, "0".repeat(64), "accept"), /INVALID_COMPUTER_APPROVAL_TOKEN/);
    assert.equal(approvals.submit("owner-a", approvalId, token, "accept").waitOutcome, "accepted");
  } finally {
    approvals.close();
  }
});

test("Computer Use approval wait is bounded and timeout cannot authorize", async () => {
  const approvals = new ComputerUseApprovals({ waitMs: 5, ttlMs: 100 });
  try {
    const approvalId = approvals.prepare("owner-a", "ws-a", request);
    const waited = await approvals.wait("owner-a", "ws-a", approvalId);
    assert.equal(waited.waitOutcome, "timeout");
    assert.equal(waited.nextAction, "stop");
    assert.equal(approvals.consumeAccepted("owner-a", "ws-a", request), undefined);
  } finally {
    approvals.close();
  }
});

test("direct helper meta shape resolves explorer.exe and ignores the misleading upstream display label", () => {
  const approvals = new ComputerUseApprovals({ waitMs: 100, ttlMs: 1_000 });
  try {
    const approvalId = approvals.prepare("owner-a", "ws-a", directHelperRequest);
    const shown = approvals.show("owner-a", "ws-a", approvalId);
    const view = shown.structuredContent as Record<string, unknown>;
    assert.equal(view.app, "explorer.exe");
    assert.equal(view.displayName, "File Explorer");
    assert.equal(view.message, "Allow Codex to use File Explorer?");
    assert.equal(view.riskLevel, "low");
  } finally {
    approvals.close();
  }
});

test("browser approvals are scoped to their operation and origin instead of unknown-app", () => {
  const approvals = new ComputerUseApprovals({ waitMs: 100, ttlMs: 1_000 });
  try {
    const approvalId = approvals.prepare("owner-a", "ws-a", browserOriginRequest);
    const shown = approvals.show("owner-a", "ws-a", approvalId);
    const view = shown.structuredContent as Record<string, unknown>;
    assert.equal(
      view.app,
      "browser:access_browser_origin:https://studio.tripo3d.ai",
    );
    assert.equal(view.displayName, "Browser access to https://studio.tripo3d.ai");
    assert.equal(view.message, browserOriginRequest.message);
  } finally {
    approvals.close();
  }
});

test("explicit approval submitted after the bounded wait timeout still authorizes the short session within TTL", async () => {
  let now = 1_000;
  const approvals = new ComputerUseApprovals({ now: () => now, waitMs: 5, ttlMs: 100, approvalMs: 50 });
  try {
    const approvalId = approvals.prepare("owner-a", "ws-a", directHelperRequest);
    const shown = approvals.show("owner-a", "ws-a", approvalId);
    const token = (shown._meta?.computerApproval as { submitToken: string }).submitToken;
    const waiting = approvals.wait("owner-a", "ws-a", approvalId);
    now += 6;
    await new Promise(resolve => setTimeout(resolve, 10));
    const waited = await waiting;
    assert.equal(waited.waitOutcome, "timeout");
    assert.equal(waited.nextAction, "stop");
    assert.equal(waited.canSubmit, true, "bounded model wait timeout does not close the human approval card");
    assert.equal(waited.state, "pending", "approval remains pending until the overall card TTL expires");
    assert.equal(approvals.consumeAccepted("owner-a", "ws-a", directHelperRequest), undefined);

    const submitted = approvals.submit("owner-a", approvalId, token, "accept");
    assert.equal(submitted.waitOutcome, "accepted");
    assert.equal(submitted.decision, "accept");
    assert.deepEqual(
      approvals.consumeAccepted("owner-a", "ws-a", directHelperRequest),
      { action: "accept", content: { persist: "session" } },
    );
  } finally {
    approvals.close();
  }
});

test("Computer Use approval defaults to a five-minute card TTL", () => {
  let now = 50_000;
  const approvals = new ComputerUseApprovals({ now: () => now });
  try {
    const approvalId = approvals.prepare("owner-a", "ws-a", request);
    const shown = approvals.show("owner-a", "ws-a", approvalId);
    const view = shown.structuredContent as Record<string, unknown>;
    assert.equal(view.createdAt, now);
    assert.equal(view.expiresAt, now + 5 * 60_000);
  } finally {
    approvals.close();
  }
});
