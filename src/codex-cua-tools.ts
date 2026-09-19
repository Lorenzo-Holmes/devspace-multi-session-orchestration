import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import {
  CodexCuaBridge,
  codexCuaElicitationMeta,
  type CodexCuaAction,
  type CodexCuaBrowserAction,
  type CodexCuaElicit,
  type CodexCuaElicitationParams,
  type CodexCuaElicitationResult,
  type CodexCuaWindow,
  type CodexCuaWindowState,
} from "./codex-cua-bridge.js";
import { codexTurnMetadataFromRequest } from "./request-meta.js";
import type { WorkspaceAccessManager } from "./workspace-access.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import { ComputerUseApprovals, computerApprovalIdentity } from "./computer-use-approvals.js";
import { logToolCall } from "./tool-surfaces/shared.js";
import {
  READ_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  workspaceIdDescription,
} from "./tool-surfaces/types.js";

const windowSchema = z.object({
  app: z.string().min(1),
  id: z.number().int().nonnegative(),
  title: z.string().optional(),
});

const mouseButtonSchema = z.enum(["left", "right", "middle"]);

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("activate_window") }),
  z.object({
    action: z.literal("click_element"),
    elementIndex: z.number().int().nonnegative(),
    clickCount: z.number().int().min(1).max(3).optional(),
    mouseButton: mouseButtonSchema.optional(),
  }),
  z.object({
    action: z.literal("double_click_element"),
    elementIndex: z.number().int().nonnegative(),
  }),
  z.object({
    action: z.literal("right_click_element"),
    elementIndex: z.number().int().nonnegative(),
  }),
  z.object({
    action: z.literal("click"),
    x: z.number().finite(),
    y: z.number().finite(),
    screenshotId: z.string().min(1).optional(),
    clickCount: z.number().int().min(1).max(3).optional(),
    mouseButton: mouseButtonSchema.optional(),
  }),
  z.object({
    action: z.literal("double_click"),
    x: z.number().finite(),
    y: z.number().finite(),
    screenshotId: z.string().min(1).optional(),
  }),
  z.object({
    action: z.literal("right_click"),
    x: z.number().finite(),
    y: z.number().finite(),
    screenshotId: z.string().min(1).optional(),
  }),
  z.object({
    action: z.literal("scroll"),
    x: z.number().finite(),
    y: z.number().finite(),
    scrollX: z.number().finite(),
    scrollY: z.number().finite(),
    screenshotId: z.string().min(1).optional(),
  }),
  z.object({
    action: z.literal("drag"),
    fromX: z.number().finite(),
    fromY: z.number().finite(),
    toX: z.number().finite(),
    toY: z.number().finite(),
    screenshotId: z.string().min(1).optional(),
  }),
  z.object({ action: z.literal("type_text"), text: z.string().max(4000) }),
  z.object({ action: z.literal("keypress"), key: z.string().min(1).max(100) }),
  z.object({
    action: z.literal("set_value"),
    elementIndex: z.number().int().nonnegative(),
    value: z.string().max(4000),
  }),
  z.object({
    action: z.literal("secondary_action"),
    elementIndex: z.number().int().nonnegative(),
    actionName: z.string().min(1).max(200),
  }),
]);

const browserActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("click_element"),
    elementIndex: z.number().int().nonnegative(),
    clickCount: z.number().int().min(1).max(3).optional(),
    mouseButton: mouseButtonSchema.optional(),
  }),
  z.object({
    action: z.literal("click"),
    x: z.number().finite(),
    y: z.number().finite(),
    clickCount: z.number().int().min(1).max(3).optional(),
    mouseButton: mouseButtonSchema.optional(),
  }),
  z.object({
    action: z.literal("scroll_element"),
    elementIndex: z.number().int().nonnegative(),
    direction: z.enum(["up", "down", "left", "right"]),
    pages: z.number().int().min(1).max(10).optional(),
  }),
  z.object({
    action: z.literal("scroll"),
    x: z.number().finite(),
    y: z.number().finite(),
    direction: z.enum(["up", "down", "left", "right"]),
    pages: z.number().int().min(1).max(10).optional(),
  }),
  z.object({ action: z.literal("type_text"), text: z.string().max(4000) }),
  z.object({ action: z.literal("keypress"), key: z.string().min(1).max(100) }),
  z.object({
    action: z.literal("set_value"),
    elementIndex: z.number().int().nonnegative(),
    value: z.string().max(4000),
  }),
  z.object({
    action: z.literal("secondary_action"),
    elementIndex: z.number().int().nonnegative(),
    actionName: z.string().min(1).max(200),
  }),
  z.object({ action: z.literal("back") }),
  z.object({ action: z.literal("forward") }),
  z.object({ action: z.literal("reload") }),
]);

const outputSchema = {
  backend: z.literal("codex_cua"),
  phase: z.enum(["window_list", "window_state", "action_result"]),
  result: z.string(),
  windowsJson: z.string(),
  windowJson: z.string().optional(),
  accessibilityTree: z.string().optional(),
  screenshotId: z.string().optional(),
};

const browserInventoryOutputSchema = {
  backend: z.literal("codex_cua_browser"),
  result: z.string(),
  browsersJson: z.string(),
};

const browserObservationOutputSchema = {
  backend: z.literal("codex_cua_browser"),
  phase: z.enum(["tab_state", "action_result"]),
  result: z.string(),
  browserId: z.string(),
  requestedTabId: z.string(),
  tabJson: z.string(),
  accessibilityTree: z.string(),
};

const BROWSER_READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const BROWSER_ACTION_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

export function registerCodexCuaTools(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  workspaceAccess: WorkspaceAccessManager,
  bridge: CodexCuaBridge,
  approvals?: ComputerUseApprovals,
): void {
  if (!config.computerUseEnabled || process.platform !== "win32") return;

  server.registerTool(
    "observe",
    {
      title: "Observe Windows desktop with Codex Computer Use",
      description:
        "Use the bundled Codex unified-computer-use runtime for Windows. Omit window to list current top-level windows. Then pass one exact {app,id} window from that list to receive its fresh accessibility tree and screenshot. Prefer accessibility element indices over pixel coordinates. First access to an app preserves Codex's own user-approval requirement.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        window: windowSchema.optional().describe(
          "Exact window object previously returned by observe. Omit on the first observation to list windows.",
        ),
      },
      outputSchema,
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, window }, extra) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      workspaceAccess.assertWorkspaceReadable(workspace);
      const elicit = createOuterElicitor(server, extra, approvals, workspaceId);
      if (!window) {
        const observed = await bridge.listWindows(elicit);
        const browserInventory = await bridge.getBrowserState(
          requireBrowserTurnMetadata(extra),
          elicit,
        );
        const browserWindows = browserInventory.value.browsers.flatMap((browser) =>
          browser.tabs.map((tab) => codexBrowserWindowAlias(browser.id, tab.id, browser.name, tab.title, tab.url)),
        );
        const windows = [...observed.value, ...browserWindows];
        const windowsJson = JSON.stringify(windows);
        const result = `Codex Computer Use returned ${observed.value.length} top-level Windows window(s) and ${browserWindows.length} trusted Browser Use tab alias(es). Browser aliases have app names beginning with codex-browser-use: and must be observed through this same tool before acting.`;
        logToolCall(config, {
          tool: "observe",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content: [{ type: "text" as const, text: `${result}\nWindows: ${windowsJson}` }],
          structuredContent: {
            backend: "codex_cua" as const,
            phase: "window_list" as const,
            result,
            windowsJson,
          },
        };
      }
      const browserTarget = parseCodexBrowserWindowAlias(window);
      if (browserTarget) {
        const observed = await bridge.getBrowserTabState(
          browserTarget.browserId,
          browserTarget.tabId,
          requireBrowserTurnMetadata(extra),
          elicit,
        );
        logToolCall(config, {
          tool: "observe",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return browserCompatibilityObservationResult("window_state", window, observed.value, observed.images);
      }
      const observed = await bridge.getWindowState(window, elicit);
      logToolCall(config, {
        tool: "observe",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return observationResult("window_state", observed.value, observed.images);
    },
  );

  server.registerTool(
    "computer",
    {
      title: "Control Windows with Codex Computer Use",
      description:
        "Control one exact Windows window through the bundled Codex unified-computer-use runtime. Use a fresh window state from observe. Prefer click_element/double_click_element/right_click_element with an accessibility elementIndex from that state. Coordinate actions should include the fresh screenshotId when available. The tool performs one requested action and then captures a new accessibility state and screenshot before reporting success.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        window: windowSchema.describe("Exact window object from the latest observe window list/state."),
        action: actionSchema,
      },
      outputSchema,
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, window, action }, extra) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      workspaceAccess.assertWorkspaceModifiable(workspace);
      const browserTarget = parseCodexBrowserWindowAlias(window);
      if (browserTarget) {
        const elicit = createOuterElicitor(server, extra, approvals, workspaceId);
        const browserAction = codexBrowserActionFromDesktop(action as CodexCuaAction);
        const observed = browserAction
          ? await bridge.browserActAndObserve(
              browserTarget.browserId,
              browserTarget.tabId,
              browserAction,
              requireBrowserTurnMetadata(extra),
              elicit,
            )
          : await bridge.getBrowserTabState(
              browserTarget.browserId,
              browserTarget.tabId,
              requireBrowserTurnMetadata(extra),
              elicit,
            );
        logToolCall(config, {
          tool: "computer",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return browserCompatibilityObservationResult("action_result", window, observed.value, observed.images);
      }
      const observed = await bridge.actAndObserve(
        window as CodexCuaWindow,
        action as CodexCuaAction,
        createOuterElicitor(server, extra, approvals, workspaceId),
      );
      logToolCall(config, {
        tool: "computer",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return observationResult("action_result", observed.value, observed.images);
    },
  );

  server.registerTool(
    "browser_state",
    {
      title: "List trusted Codex Browser Use tabs",
      description:
        "List browser sessions and tabs through Codex Browser Use, including trusted tab IDs, titles and URLs. Use this for browser work instead of observing a Chrome/Edge window through desktop Computer Use. This is read-only and does not open or navigate a tab.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
      },
      outputSchema: browserInventoryOutputSchema,
      annotations: BROWSER_READ_ANNOTATIONS,
    },
    async ({ workspaceId }, extra) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      workspaceAccess.assertWorkspaceReadable(workspace);
      const metadata = requireBrowserTurnMetadata(extra);
      const observed = await bridge.getBrowserState(
        metadata,
        createOuterElicitor(server, extra, approvals, workspaceId),
      );
      const browsersJson = JSON.stringify(observed.value.browsers);
      const result = `Codex Browser Use returned ${observed.value.browsers.length} browser session(s). Select an exact browser id and tab id from this result before observing or acting.`;
      logToolCall(config, {
        tool: "browser_state",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content: [{ type: "text" as const, text: `${result}\nBrowsers: ${browsersJson}` }],
        structuredContent: {
          backend: "codex_cua_browser" as const,
          result,
          browsersJson,
        },
      };
    },
  );

  server.registerTool(
    "browser_observe",
    {
      title: "Observe one trusted browser tab with Codex Browser Use",
      description:
        "Observe one exact browser tab returned by browser_state through Codex Browser Use. Returns a fresh accessibility tree, screenshot and trusted current tab URL. Call browser_state first, then reuse its exact browserId/tabId. Prefer accessibility element indices from this fresh state.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        browserId: z.string().min(1).describe("Exact browser id returned by browser_state."),
        tabId: z.string().min(1).describe("Exact tab id or providerTabId returned by browser_state."),
      },
      outputSchema: browserObservationOutputSchema,
      annotations: BROWSER_READ_ANNOTATIONS,
    },
    async ({ workspaceId, browserId, tabId }, extra) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      workspaceAccess.assertWorkspaceReadable(workspace);
      const observed = await bridge.getBrowserTabState(
        browserId,
        tabId,
        requireBrowserTurnMetadata(extra),
        createOuterElicitor(server, extra, approvals, workspaceId),
      );
      logToolCall(config, {
        tool: "browser_observe",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return browserObservationResult("tab_state", observed.value, observed.images);
    },
  );

  server.registerTool(
    "browser_action",
    {
      title: "Control one trusted browser tab with Codex Browser Use",
      description:
        "Perform one bounded action on an exact browser tab previously returned by browser_state/browser_observe, then return a fresh accessibility tree, screenshot and trusted current URL. Use element indices from the latest browser_observe/action result when possible. Browser Use keeps its own URL/origin safety checks and user confirmation requirements.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        browserId: z.string().min(1).describe("Exact browser id returned by browser_state."),
        tabId: z.string().min(1).describe("Exact tab id or providerTabId returned by browser_state."),
        action: browserActionSchema,
      },
      outputSchema: browserObservationOutputSchema,
      annotations: BROWSER_ACTION_ANNOTATIONS,
    },
    async ({ workspaceId, browserId, tabId, action }, extra) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      workspaceAccess.assertWorkspaceModifiable(workspace);
      const observed = await bridge.browserActAndObserve(
        browserId,
        tabId,
        action as CodexCuaBrowserAction,
        requireBrowserTurnMetadata(extra),
        createOuterElicitor(server, extra, approvals, workspaceId),
      );
      logToolCall(config, {
        tool: "browser_action",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return browserObservationResult("action_result", observed.value, observed.images);
    },
  );
}

const CODEX_BROWSER_WINDOW_PREFIX = "codex-browser-use:";

export function codexBrowserWindowAlias(
  browserId: string,
  tabId: string,
  browserName?: string,
  title?: string,
  url?: string,
): CodexCuaWindow {
  const numericTabId = Number(tabId);
  const id = Number.isSafeInteger(numericTabId) && numericTabId >= 0
    ? numericTabId
    : stableAliasId(`${browserId}:${tabId}`);
  const label = [
    `[Browser Use:${browserName ?? browserId}]`,
    title ?? tabId,
    url,
  ].filter(Boolean).join(" — ");
  return {
    app: `${CODEX_BROWSER_WINDOW_PREFIX}${encodeURIComponent(browserId)}/${encodeURIComponent(tabId)}`,
    id,
    title: label,
  };
}

export function parseCodexBrowserWindowAlias(
  window: { app: string; id: number },
): { browserId: string; tabId: string } | undefined {
  if (!window.app.startsWith(CODEX_BROWSER_WINDOW_PREFIX)) return undefined;
  const encoded = window.app.slice(CODEX_BROWSER_WINDOW_PREFIX.length);
  const separator = encoded.indexOf("/");
  if (separator <= 0 || separator === encoded.length - 1) {
    throw new Error("CODEX_CUA_BROWSER_ALIAS_INVALID: observe the trusted browser alias again instead of guessing it.");
  }
  const browserId = decodeURIComponent(encoded.slice(0, separator));
  const tabId = decodeURIComponent(encoded.slice(separator + 1));
  const expected = codexBrowserWindowAlias(browserId, tabId).id;
  if (window.id !== expected) {
    throw new Error("CODEX_CUA_BROWSER_ALIAS_STALE: browser alias identity changed; call observe again.");
  }
  return { browserId, tabId };
}

export function codexBrowserActionFromDesktop(
  action: CodexCuaAction,
): CodexCuaBrowserAction | undefined {
  switch (action.action) {
    case "activate_window":
      // Browser aliases are already exact tab bindings. A fresh observation is
      // the compatible equivalent; do not invent a separate focus primitive.
      return undefined;
    case "click_element":
      return {
        action: "click_element",
        elementIndex: action.elementIndex,
        ...(action.clickCount ? { clickCount: action.clickCount } : {}),
        ...(action.mouseButton ? { mouseButton: action.mouseButton } : {}),
      };
    case "double_click_element":
      return { action: "click_element", elementIndex: action.elementIndex, clickCount: 2 };
    case "right_click_element":
      return { action: "click_element", elementIndex: action.elementIndex, mouseButton: "right" };
    case "click":
      return {
        action: "click",
        x: action.x,
        y: action.y,
        ...(action.clickCount ? { clickCount: action.clickCount } : {}),
        ...(action.mouseButton ? { mouseButton: action.mouseButton } : {}),
      };
    case "double_click":
      return { action: "click", x: action.x, y: action.y, clickCount: 2 };
    case "right_click":
      return { action: "click", x: action.x, y: action.y, mouseButton: "right" };
    case "scroll": {
      const vertical = Math.abs(action.scrollY) >= Math.abs(action.scrollX);
      const delta = vertical ? action.scrollY : action.scrollX;
      if (delta === 0) return undefined;
      const direction = vertical
        ? (delta > 0 ? "down" : "up")
        : (delta > 0 ? "right" : "left");
      return {
        action: "scroll",
        x: action.x,
        y: action.y,
        direction,
        pages: Math.max(1, Math.min(10, Math.ceil(Math.abs(delta) / 600))),
      };
    }
    case "drag":
      throw new Error("CODEX_CUA_BROWSER_ACTION_UNSUPPORTED: Browser Use compatibility aliases do not support drag through the desktop schema; use a refreshed browser_action tool catalog for drag-specific browser workflows.");
    case "type_text":
      return { action: "type_text", text: action.text };
    case "keypress":
      return { action: "keypress", key: action.key };
    case "set_value":
      return { action: "set_value", elementIndex: action.elementIndex, value: action.value };
    case "secondary_action":
      return { action: "secondary_action", elementIndex: action.elementIndex, actionName: action.actionName };
  }
}

function stableAliasId(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function browserCompatibilityObservationResult(
  phase: "window_state" | "action_result",
  window: CodexCuaWindow,
  state: {
    browserId: string;
    requestedTabId: string;
    tab: { id: string; providerTabId?: string; title?: string; url?: string; [key: string]: unknown };
    accessibilityTree: string;
  },
  images: Array<{ type: "image"; data: string; mimeType: string }>,
) {
  const windowJson = JSON.stringify(window);
  const windowsJson = JSON.stringify([window]);
  const result = [
    `Codex Browser Use ${phase === "action_result" ? "completed the compatibility action and refreshed" : "captured"} trusted tab ${state.tab.title ?? state.tab.id}.`,
    state.tab.url ? `Trusted current URL: ${state.tab.url}.` : "No current URL was returned.",
    "Fresh accessibility tree is included. Prefer elementIndex actions over coordinates.",
  ].join(" ");
  return {
    content: [
      { type: "text" as const, text: `${result}\nWindow alias: ${windowJson}\nTab: ${JSON.stringify(state.tab)}\nAccessibility:\n${state.accessibilityTree}` },
      ...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
    ],
    structuredContent: {
      backend: "codex_cua" as const,
      phase,
      result,
      windowsJson,
      windowJson,
      accessibilityTree: state.accessibilityTree,
    },
  };
}

function observationResult(
  phase: "window_state" | "action_result",
  state: CodexCuaWindowState,
  images: Array<{ type: "image"; data: string; mimeType: string }>,
) {
  const windowJson = JSON.stringify(state.window);
  const windowsJson = JSON.stringify([state.window]);
  const screenshotId = state.screenshots[0]?.id;
  const accessibilityTree = state.accessibility?.tree;
  const result = [
    `Codex Computer Use ${phase === "action_result" ? "completed the action and refreshed" : "captured"} window ${state.window.title ?? state.window.id}.`,
    screenshotId ? `Fresh screenshotId: ${screenshotId}.` : "No screenshotId was returned.",
    accessibilityTree ? "Fresh accessibility tree is included." : "No accessibility tree was returned.",
  ].join(" ");
  return {
    content: [
      { type: "text" as const, text: `${result}\nWindow: ${windowJson}${accessibilityTree ? `\nAccessibility:\n${accessibilityTree}` : ""}` },
      ...images.map((image) => ({
        type: "image" as const,
        data: image.data,
        mimeType: image.mimeType,
      })),
    ],
    structuredContent: {
      backend: "codex_cua" as const,
      phase,
      result,
      windowsJson,
      windowJson,
      ...(accessibilityTree ? { accessibilityTree } : {}),
      ...(screenshotId ? { screenshotId } : {}),
    },
  };
}

function browserObservationResult(
  phase: "tab_state" | "action_result",
  state: {
    browserId: string;
    requestedTabId: string;
    tab: { id: string; providerTabId?: string; title?: string; url?: string; [key: string]: unknown };
    accessibilityTree: string;
  },
  images: Array<{ type: "image"; data: string; mimeType: string }>,
) {
  const tabJson = JSON.stringify(state.tab);
  const result = [
    `Codex Browser Use ${phase === "action_result" ? "completed the action and refreshed" : "captured"} tab ${state.tab.title ?? state.tab.id}.`,
    state.tab.url ? `Trusted current URL: ${state.tab.url}.` : "No current URL was returned.",
    "Fresh accessibility tree is included.",
  ].join(" ");
  return {
    content: [
      { type: "text" as const, text: `${result}\nTab: ${tabJson}\nAccessibility:\n${state.accessibilityTree}` },
      ...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
    ],
    structuredContent: {
      backend: "codex_cua_browser" as const,
      phase,
      result,
      browserId: state.browserId,
      requestedTabId: state.requestedTabId,
      tabJson,
      accessibilityTree: state.accessibilityTree,
    },
  };
}

function requireBrowserTurnMetadata(extra: {
  _meta?: Record<string, unknown>;
  sessionId?: string;
  requestId?: string | number;
  requestInfo?: { headers: Record<string, string | string[] | undefined> };
}) {
  const metadata = codexTurnMetadataFromRequest({
    meta: extra._meta,
    headers: extra.requestInfo?.headers,
    transportSessionId: extra.sessionId,
    requestId: extra.requestId,
  });
  if (!metadata) {
    throw new Error(
      "CODEX_CUA_BROWSER_TURN_METADATA_UNAVAILABLE: Browser Use requires a real host conversation/session scope and request id. DevSpace will not fabricate them.",
    );
  }
  return metadata;
}

function createOuterElicitor(
  server: McpServer,
  extra: {
    signal?: AbortSignal;
    requestId?: string | number;
    authInfo?: unknown;
    _meta?: Record<string, unknown>;
    sessionId?: string;
    requestInfo?: { headers: Record<string, string | string[] | undefined> };
  },
  approvals?: ComputerUseApprovals,
  workspaceId?: string,
): CodexCuaElicit {
  return async (params: CodexCuaElicitationParams): Promise<CodexCuaElicitationResult> => {
    if (!server.server.getClientCapabilities()?.elicitation?.form) {
      if (approvals && workspaceId) {
        const identity = computerApprovalIdentity(extra.authInfo);
        const accepted = approvals.consumeAccepted(identity, workspaceId, params);
        if (accepted) return accepted;
        const approvalId = approvals.prepare(identity, workspaceId, params);
        throw new Error(
          `CODEX_CUA_APPROVAL_CARD_REQUIRED: approvalId=${approvalId}. Call computer_approval_show with workspaceId=${workspaceId} and this approvalId, then call computer_approval_wait exactly once. Retry the original observe/computer call only if wait returns nextAction=retry_original_action.`,
        );
      }
      throw new Error(
        `CODEX_CUA_APPROVAL_TRANSPORT_UNAVAILABLE: ${params.message} The current MCP host does not expose form elicitation required by Codex Computer Use app approval. Do not fall back to a blind desktop click.`,
      );
    }
    const request = {
      mode: "form" as const,
      message: params.message,
      requestedSchema: params.requestedSchema ?? { type: "object", properties: {} },
      ...(Object.keys(codexCuaElicitationMeta(params)).length > 0
        ? { _meta: codexCuaElicitationMeta(params) }
        : {}),
    };
    const response = await server.server.elicitInput(
      request as never,
      {
        timeout: 60_000,
        signal: extra.signal,
        relatedRequestId: extra.requestId,
      } as never,
    );
    return response as CodexCuaElicitationResult;
  };
}
