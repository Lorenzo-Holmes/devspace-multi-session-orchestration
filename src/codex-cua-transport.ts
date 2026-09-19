import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { readdir, readFile, realpath } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import type { CodexTurnMetadata } from "./request-meta.js";

const JSON_MARKER = "DEVSPACE_CUA_JSON:";

const sidecarManifestSchema = z.object({
  mcpServers: z.object({
    cua_repl: z.object({
      command: z.string().min(1),
      args: z.array(z.string()).min(1),
      env: z.record(z.string(), z.string()).default({}),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

const windowSchema = z.object({
  app: z.string().min(1),
  id: z.number().int().nonnegative(),
  title: z.string().optional(),
}).passthrough();

const screenshotSchema = z.object({
  id: z.string(),
  zIndex: z.number().optional(),
  url: z.string(),
  originX: z.number().optional(),
  originY: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
}).passthrough();

const accessibilitySchema = z.object({
  tree: z.string(),
  focused_element: z.string().optional(),
  selected_text: z.string().optional(),
  selected_elements: z.array(z.string()).optional(),
  document_text: z.string().optional(),
}).passthrough();

const windowStateSchema = z.object({
  window: windowSchema,
  screenshots: z.array(screenshotSchema),
  accessibility: accessibilitySchema.nullable(),
}).passthrough();

const browserTabInfoSchema = z.object({
  id: z.string(),
  providerTabId: z.string().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
}).passthrough();

const browserInfoSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  family: z.string().optional(),
  type: z.enum(["iab", "extension", "cdp"]).optional(),
  profileName: z.string().optional(),
  tabs: z.array(browserTabInfoSchema),
}).passthrough();

const browserInventorySchema = z.object({
  browsers: z.array(browserInfoSchema),
});

const browserObservationSchema = z.object({
  browserId: z.string(),
  requestedTabId: z.string(),
  tab: browserTabInfoSchema,
  accessibilityTree: z.string(),
});

export type CodexCuaWindow = z.infer<typeof windowSchema>;
export type CodexCuaWindowState = z.infer<typeof windowStateSchema>;
export type CodexCuaBrowserInventory = z.infer<typeof browserInventorySchema>;
export type CodexCuaBrowserObservation = z.infer<typeof browserObservationSchema>;

export type CodexCuaElicitationParams = {
  _meta?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  mode?: string;
  message: string;
  requestedSchema?: Record<string, unknown>;
};

export type CodexCuaElicitationResult = {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

export type CodexCuaElicit = (
  params: CodexCuaElicitationParams,
) => Promise<CodexCuaElicitationResult>;

export type CodexCuaAction =
  | { action: "activate_window" }
  | { action: "click_element"; elementIndex: number; clickCount?: number; mouseButton?: "left" | "right" | "middle" }
  | { action: "click"; x: number; y: number; screenshotId?: string; clickCount?: number; mouseButton?: "left" | "right" | "middle" }
  | { action: "double_click_element"; elementIndex: number }
  | { action: "double_click"; x: number; y: number; screenshotId?: string }
  | { action: "right_click_element"; elementIndex: number }
  | { action: "right_click"; x: number; y: number; screenshotId?: string }
  | { action: "scroll"; x: number; y: number; scrollX: number; scrollY: number; screenshotId?: string }
  | { action: "drag"; fromX: number; fromY: number; toX: number; toY: number; screenshotId?: string }
  | { action: "type_text"; text: string }
  | { action: "keypress"; key: string }
  | { action: "set_value"; elementIndex: number; value: string }
  | { action: "secondary_action"; elementIndex: number; actionName: string };

export type CodexCuaBrowserAction =
  | { action: "click_element"; elementIndex: number; clickCount?: number; mouseButton?: "left" | "right" | "middle" }
  | { action: "click"; x: number; y: number; clickCount?: number; mouseButton?: "left" | "right" | "middle" }
  | { action: "scroll_element"; elementIndex: number; direction: "up" | "down" | "left" | "right"; pages?: number }
  | { action: "scroll"; x: number; y: number; direction: "up" | "down" | "left" | "right"; pages?: number }
  | { action: "type_text"; text: string }
  | { action: "keypress"; key: string }
  | { action: "set_value"; elementIndex: number; value: string }
  | { action: "secondary_action"; elementIndex: number; actionName: string }
  | { action: "back" }
  | { action: "forward" }
  | { action: "reload" };

type BridgeResult<T> = {
  value: T;
  images: Array<{ type: "image"; data: string; mimeType: string }>;
};

type SidecarConfig = {
  root: string;
  version: string;
  command: string;
  args: string[];
  env: Record<string, string>;
};

type DirectSkyConfig = {
  clientModule: string;
  transportModule: string;
  helperCommand: string;
  codexCliPath: string;
  codexHome: string;
};

type DirectHelperTransport = {
  close(): Promise<void>;
  request(
    method: string,
    params: Record<string, unknown>,
    options?: {
      codexTurnMetadata?: unknown;
      createElicitation?: (request: unknown) => Promise<CodexCuaElicitationResult>;
    },
  ): Promise<unknown>;
};

export type DirectWindowsClient = {
  readonly target: "windows";
  close(): Promise<void>;
  list_windows(): Promise<unknown>;
  get_window_state(input: Record<string, unknown>): Promise<unknown>;
  activate_window(input: Record<string, unknown>): Promise<void>;
  click(input: Record<string, unknown>): Promise<void>;
  scroll(input: Record<string, unknown>): Promise<void>;
  drag(input: Record<string, unknown>): Promise<void>;
  press_key(input: Record<string, unknown>): Promise<void>;
  type_text(input: Record<string, unknown>): Promise<void>;
  set_value(input: Record<string, unknown>): Promise<void>;
  perform_secondary_action(input: Record<string, unknown>): Promise<void>;
};

export class CodexCuaBridge {
  private client?: Client;
  private transport?: StdioClientTransport;
  private sidecar?: SidecarConfig;
  private directClient?: DirectWindowsClient;
  private directHelper?: DirectHelperTransport;
  private currentElicit?: CodexCuaElicit;
  private operationApprovalCache?: Map<string, CodexCuaElicitationResult>;
  private browserInitialized = false;
  private tail: Promise<unknown> = Promise.resolve();
  private closing = false;

  async available(): Promise<boolean> {
    try {
      const sidecar = await discoverCodexCuaSidecar();
      await discoverDirectSkyConfig(sidecar);
      return true;
    } catch {
      return false;
    }
  }

  async listWindows(elicit?: CodexCuaElicit): Promise<BridgeResult<CodexCuaWindow[]>> {
    return this.runDirect(async (client) => ({
      value: z.array(windowSchema).parse(await client.list_windows()),
      images: [],
    }), elicit);
  }

  async getBrowserState(
    turnMetadata: CodexTurnMetadata,
    elicit?: CodexCuaElicit,
  ): Promise<BridgeResult<CodexCuaBrowserInventory>> {
    const result = await this.runJson(
      [
        "var __devspaceBrowserState = await cua.getState({ emit: false });",
        `nodeRepl.write(${JSON.stringify(JSON_MARKER)} + JSON.stringify({ browsers: __devspaceBrowserState.browsers }));`,
      ].join("\n"),
      browserInventorySchema,
      turnMetadata,
      elicit,
    );
    this.browserInitialized = true;
    return result;
  }

  async getBrowserTabState(
    browserId: string,
    tabId: string,
    turnMetadata: CodexTurnMetadata,
    elicit?: CodexCuaElicit,
  ): Promise<BridgeResult<CodexCuaBrowserObservation>> {
    await this.ensureBrowserInitialized(turnMetadata, elicit);
    return this.runJson(
      browserObservationCode(browserId, tabId),
      browserObservationSchema,
      turnMetadata,
      elicit,
    );
  }

  async browserActAndObserve(
    browserId: string,
    tabId: string,
    action: CodexCuaBrowserAction,
    turnMetadata: CodexTurnMetadata,
    elicit?: CodexCuaElicit,
  ): Promise<BridgeResult<CodexCuaBrowserObservation>> {
    await this.ensureBrowserInitialized(turnMetadata, elicit);
    return this.runJson(
      browserActionCode(browserId, tabId, action),
      browserObservationSchema,
      turnMetadata,
      elicit,
    );
  }

  async getWindowState(
    window: CodexCuaWindow,
    elicit?: CodexCuaElicit,
  ): Promise<BridgeResult<CodexCuaWindowState>> {
    const input = {
      window: windowSchema.parse(window),
      include_screenshot: true,
      include_text: true,
    };
    return this.runDirect(async (client) => {
      const value = windowStateSchema.parse(await client.get_window_state(input));
      return { value, images: await loadOfficialScreenshots(value.screenshots) };
    }, elicit);
  }

  async actAndObserve(
    window: CodexCuaWindow,
    action: CodexCuaAction,
    elicit?: CodexCuaElicit,
  ): Promise<BridgeResult<CodexCuaWindowState>> {
    const parsedWindow = windowSchema.parse(window);
    const observeInput = {
      window: parsedWindow,
      include_screenshot: true,
      include_text: true,
    };
    return this.runDirect(async (client) => {
      await performDirectCodexAction(client, parsedWindow, action);
      const value = windowStateSchema.parse(await client.get_window_state(observeInput));
      return { value, images: await loadOfficialScreenshots(value.screenshots) };
    }, elicit);
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.tail.catch(() => {});
    await this.closeDirectSession();
    const client = this.client;
    this.client = undefined;
    this.transport = undefined;
    this.browserInitialized = false;
    // Recovery must fence replacement creation when teardown cannot be confirmed.
    await client?.close();
  }

  private async ensureBrowserInitialized(
    turnMetadata: CodexTurnMetadata,
    elicit?: CodexCuaElicit,
  ): Promise<void> {
    if (this.browserInitialized && this.client && this.transport) return;
    await this.getBrowserState(turnMetadata, elicit);
  }

  private runDirect<T>(
    operationBody: (client: DirectWindowsClient) => Promise<BridgeResult<T>>,
    elicit?: CodexCuaElicit,
  ): Promise<BridgeResult<T>> {
    if (this.closing) return Promise.reject(new Error("Codex Computer Use bridge is closed."));
    const operation = this.tail.then(async () => {
      const client = await this.ensureDirectConnected();
      this.currentElicit = elicit;
      this.operationApprovalCache = new Map();
      try {
        return await operationBody(client);
      } finally {
        this.currentElicit = undefined;
        this.operationApprovalCache = undefined;
        // The official Windows helper owns a visible Computer Use surface and
        // temporary cursor/overlay state. Do not keep it alive between MCP
        // calls: a manual user close can bypass the helper's normal teardown
        // and leave the Windows cursor hidden. A fresh helper is cheap and
        // DevSpace's app approval session is stored independently, so later
        // observe/computer calls can reconnect without re-authorizing while
        // still getting deterministic native cleanup after every operation.
        await this.closeDirectSession();
      }
    });
    this.tail = operation.catch(() => {});
    return operation;
  }

  private async closeDirectSession(): Promise<void> {
    const client = this.directClient;
    const helper = this.directHelper;
    // Clear references before awaiting close so a failed/slow teardown can
    // never be reused by a later operation.
    this.directClient = undefined;
    this.directHelper = undefined;
    await client?.close().catch(() => {});
    await helper?.close().catch(() => {});
  }

  private async ensureDirectConnected(): Promise<DirectWindowsClient> {
    if (this.directClient && this.directHelper) return this.directClient;
    const sidecar = await discoverCodexCuaSidecar();
    const config = await discoverDirectSkyConfig(sidecar);
    const clientModule = await import(pathToFileURL(config.clientModule).href) as {
      WindowsComputerUseClient: new (args: { transport: { close(): Promise<void>; request(method: string, params: Record<string, unknown>, options?: { codexTurnMetadata?: unknown }): Promise<unknown> } }) => DirectWindowsClient;
    };
    const transportModule = await import(pathToFileURL(config.transportModule).href) as {
      WindowsHelperTransport: new (args: {
        helperCommand: string;
        helperArgs?: string[];
        helperEnv?: Record<string, string | undefined>;
        timeoutMs?: number;
      }) => DirectHelperTransport;
    };
    const helper = new transportModule.WindowsHelperTransport({
      helperCommand: config.helperCommand,
      helperArgs: ["--parent-pid", String(process.pid)],
      helperEnv: {
        CODEX_HOME: config.codexHome,
        CODEX_CLI_PATH: config.codexCliPath,
      },
      timeoutMs: 15_000,
    });
    const approvalAwareTransport = {
      close: () => helper.close(),
      request: (
        method: string,
        params: Record<string, unknown>,
        options: { codexTurnMetadata?: unknown } = {},
      ) => helper.request(method, params, {
        ...options,
        createElicitation: async (request) => this.handleDirectElicitation(request),
      }),
    };
    try {
      const client = new clientModule.WindowsComputerUseClient({ transport: approvalAwareTransport });
      this.directHelper = helper;
      this.directClient = client;
      return client;
    } catch (error) {
      await helper.close().catch(() => {});
      throw error;
    }
  }

  private async handleDirectElicitation(request: unknown): Promise<CodexCuaElicitationResult> {
    if (!request || typeof request !== "object") return { action: "cancel" };
    const raw = request as Record<string, unknown>;
    if (typeof raw.message !== "string") return { action: "cancel" };
    const params = raw as CodexCuaElicitationParams;
    const app = approvalApp(params);
    const cached = app ? this.operationApprovalCache?.get(app) : undefined;
    if (cached?.action === "accept") return cached;
    if (!this.currentElicit) return { action: "cancel" };
    const result = await this.currentElicit(params);
    if (app && result.action === "accept") this.operationApprovalCache?.set(app, result);
    return result;
  }

  private runJson<T>(
    code: string,
    schema: z.ZodType<T>,
    turnMetadata: CodexTurnMetadata,
    elicit?: CodexCuaElicit,
  ): Promise<BridgeResult<T>> {
    if (this.closing) return Promise.reject(new Error("Codex Computer Use bridge is closed."));
    const operation = this.tail.then(async () => {
      await this.ensureConnected();
      this.currentElicit = elicit;
      this.operationApprovalCache = new Map();
      try {
        const raw = CallToolResultSchema.parse(await this.client!.callTool({
          name: "js",
          arguments: { code },
          _meta: {
            "x-codex-turn-metadata": JSON.stringify(turnMetadata),
          },
        }));
        if (raw.isError) {
          throw new Error(extractToolText(raw.content) || "Codex Computer Use sidecar returned an error.");
        }
        const jsonText = extractMarkedJson(raw.content);
        const value = schema.parse(JSON.parse(jsonText));
        const images = raw.content.flatMap((block) =>
          block.type === "image"
            ? [{ type: "image" as const, data: block.data, mimeType: block.mimeType }]
            : [],
        );
        return { value, images };
      } finally {
        this.currentElicit = undefined;
        this.operationApprovalCache = undefined;
      }
    });
    this.tail = operation.catch(() => {});
    return operation;
  }

  private async ensureConnected(): Promise<void> {
    if (this.client && this.transport) return;
    const sidecar = await discoverCodexCuaSidecar();
    const client = new Client(
      { name: "devspace-codex-cua-bridge", version: "1.0.0" },
      { capabilities: { elicitation: { form: {} } } },
    );
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      const params = request.params as CodexCuaElicitationParams;
      const app = approvalApp(params);
      const cached = app ? this.operationApprovalCache?.get(app) : undefined;
      if (cached?.action === "accept") return cached;
      if (!this.currentElicit) return { action: "cancel" };
      const result = await this.currentElicit(params);
      if (app && result.action === "accept") this.operationApprovalCache?.set(app, result);
      return result;
    });
    const transport = new StdioClientTransport({
      command: sidecar.command,
      args: sidecar.args,
      cwd: sidecar.root,
      env: {
        ...process.env,
        ...sidecar.env,
        // Native Windows observe/computer uses the direct @oai/sky helper.
        // Keep the REPL sidecar dedicated to the browser surface so it can
        // provide trusted tab URLs and DOM/accessibility state.
        CUA_REPL_ENABLED_SURFACES: "browser",
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => {});
    // Retain partial connections: the recovery facade retires this entire transport
    // on failure and must be able to confirm cleanup before starting another one.
    this.client = client;
    this.transport = transport;
    this.sidecar = sidecar;
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    if (!tools.some((tool) => tool.name === "js")) {
      throw new Error("Codex unified-computer-use sidecar does not expose the js tool.");
    }
  }
}

function browserObservationCode(browserId: string, tabId: string): string {
  return browserResultCode(browserId, tabId, []);
}

export function browserActionCode(
  browserId: string,
  tabId: string,
  action: CodexCuaBrowserAction,
): string {
  const actionCode = browserActionStatement(action);
  return browserResultCode(browserId, tabId, [actionCode]);
}

function browserResultCode(browserId: string, tabId: string, statements: string[]): string {
  const browser = JSON.stringify(browserId);
  const tab = JSON.stringify(tabId);
  return [
    `var __devspaceBrowserId = ${browser};`,
    `var __devspaceRequestedTabId = ${tab};`,
    "var __devspaceTab = await cua.getTab(__devspaceRequestedTabId, { browser: __devspaceBrowserId });",
    ...statements,
    "var __devspaceView = await __devspaceTab.getAXStateAndScreenshot({ disableDiffing: true, emit: false });",
    "var __devspaceState = await cua.getState({ emit: false });",
    "var __devspaceBrowser = __devspaceState.browsers.find((item) => item.id === __devspaceBrowserId);",
    "var __devspaceTabInfo = __devspaceBrowser?.tabs.find((item) => item.id === __devspaceRequestedTabId || item.providerTabId === __devspaceRequestedTabId);",
    "if (!__devspaceTabInfo) throw new Error('Codex Browser Use tab disappeared while observing it.');",
    "if (__devspaceView.screenshot) nodeRepl.emitImage(__devspaceView.screenshot);",
    `nodeRepl.write(${JSON.stringify(JSON_MARKER)} + JSON.stringify({ browserId: __devspaceBrowserId, requestedTabId: __devspaceRequestedTabId, tab: __devspaceTabInfo, accessibilityTree: __devspaceView.state }));`,
  ].join("\n");
}

function browserActionStatement(action: CodexCuaBrowserAction): string {
  switch (action.action) {
    case "click_element":
      return `await __devspaceTab.click(${action.elementIndex}, ${JSON.stringify({
        mouseButton: action.mouseButton ?? "left",
        clickCount: action.clickCount ?? 1,
      })});`;
    case "click":
      return `await __devspaceTab.click(${JSON.stringify([action.x, action.y])}, ${JSON.stringify({
        mouseButton: action.mouseButton ?? "left",
        clickCount: action.clickCount ?? 1,
      })});`;
    case "scroll_element":
      return `await __devspaceTab.scroll(${action.elementIndex}, ${JSON.stringify(action.direction)}, ${action.pages ?? 1});`;
    case "scroll":
      return `await __devspaceTab.scroll(${JSON.stringify([action.x, action.y])}, ${JSON.stringify(action.direction)}, ${action.pages ?? 1});`;
    case "type_text":
      return `await __devspaceTab.typeText(${JSON.stringify(action.text)});`;
    case "keypress":
      return `await __devspaceTab.pressKey(${JSON.stringify(action.key)});`;
    case "set_value":
      return `await __devspaceTab.setValue(${action.elementIndex}, ${JSON.stringify(action.value)});`;
    case "secondary_action":
      return `await __devspaceTab.performSecondaryAction(${action.elementIndex}, ${JSON.stringify(action.actionName)});`;
    case "back":
      return "await __devspaceTab.back();";
    case "forward":
      return "await __devspaceTab.forward();";
    case "reload":
      return "await __devspaceTab.reload();";
  }
}

export async function discoverCodexCuaSidecar(): Promise<SidecarConfig> {
  if (process.platform !== "win32") throw new Error("Codex Computer Use bridge currently supports Windows only.");
  const base = join(
    homedir(),
    ".codex",
    "plugins",
    "cache",
    "openai-bundled",
    "unified-computer-use",
  );
  const entries = (await readdir(base, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => compareVersionish(b, a));
  for (const version of entries) {
    const root = await realpath(join(base, version)).catch(() => undefined);
    if (!root) continue;
    try {
      const manifest = sidecarManifestSchema.parse(JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")));
      const server = manifest.mcpServers.cua_repl;
      if (!isAbsolute(server.command) || !isAbsolute(server.args[0])) continue;
      const launchPath = await realpath(server.args[0]);
      const rel = relative(root, launchPath);
      if (rel.startsWith("..") || isAbsolute(rel)) continue;
      const pipe = server.env.SKY_CUA_NATIVE_PIPE_DIRECTORY;
      if (!pipe || !/^\\\\\.\\pipe\\codex-computer-use-/i.test(pipe)) continue;
      return {
        root,
        version,
        command: resolve(server.command),
        args: [...server.args],
        env: { ...server.env },
      };
    } catch {
      continue;
    }
  }
  throw new Error("Codex unified-computer-use sidecar with an active Windows native pipe was not found.");
}

export async function discoverDirectSkyConfig(sidecar: SidecarConfig): Promise<DirectSkyConfig> {
  const nodeModulesValue = sidecar.env.NODE_REPL_NODE_MODULE_DIRS;
  const codexCliValue = sidecar.env.CODEX_CLI_PATH;
  const codexHomeValue = sidecar.env.CODEX_HOME;
  if (!nodeModulesValue || !isAbsolute(nodeModulesValue)) {
    throw new Error("Codex Computer Use NODE_REPL_NODE_MODULE_DIRS is unavailable.");
  }
  if (!codexCliValue || !isAbsolute(codexCliValue)) {
    throw new Error("Codex Computer Use CODEX_CLI_PATH is unavailable.");
  }
  if (!codexHomeValue || !isAbsolute(codexHomeValue)) {
    throw new Error("Codex Computer Use CODEX_HOME is unavailable.");
  }
  const nodeModules = await realpath(nodeModulesValue);
  const skyRoot = await realpath(join(nodeModules, "@oai", "sky"));
  const skyRelative = relative(nodeModules, skyRoot);
  if (!skyRelative || skyRelative.startsWith("..") || isAbsolute(skyRelative)) {
    throw new Error("Codex @oai/sky runtime escapes its declared node_modules root.");
  }
  const clientModule = await realpath(join(
    skyRoot,
    "dist",
    "project",
    "cua",
    "sky_js",
    "src",
    "targets",
    "windows",
    "internal",
    "computer_use_client.js",
  ));
  const transportModule = await realpath(join(
    skyRoot,
    "dist",
    "project",
    "cua",
    "sky_js",
    "src",
    "targets",
    "windows",
    "internal",
    "helper_transport.js",
  ));
  const helperCommand = await realpath(join(skyRoot, "bin", "windows", "codex-computer-use.exe"));
  const codexCliPath = await realpath(codexCliValue);
  const codexHome = await realpath(codexHomeValue);
  return { clientModule, transportModule, helperCommand, codexCliPath, codexHome };
}

async function loadOfficialScreenshots(
  screenshots: Array<{ url: string }>,
): Promise<Array<{ type: "image"; data: string; mimeType: string }>> {
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
  for (const screenshot of screenshots) {
    if (screenshot.url.startsWith("data:")) {
      const matched = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(screenshot.url);
      if (matched) images.push({ type: "image", mimeType: matched[1], data: matched[2] });
      continue;
    }
    if (!screenshot.url.startsWith("file:")) continue;
    const path = fileURLToPath(screenshot.url);
    const extension = extname(path).toLowerCase();
    const mimeType = extension === ".jpg" || extension === ".jpeg"
      ? "image/jpeg"
      : extension === ".webp"
        ? "image/webp"
        : "image/png";
    const bytes = await readFile(path);
    images.push({ type: "image", mimeType, data: bytes.toString("base64") });
  }
  return images;
}

export async function performDirectCodexAction(
  client: DirectWindowsClient,
  window: CodexCuaWindow,
  action: CodexCuaAction,
): Promise<void> {
  const parsedWindow = windowSchema.parse(window);
  const base = { window: parsedWindow };
  switch (action.action) {
    case "activate_window":
      await client.activate_window(base);
      return;
    case "click_element":
      await client.click({
        ...base,
        element_index: action.elementIndex,
        click_count: action.clickCount ?? 1,
        mouse_button: action.mouseButton ?? "left",
      });
      return;
    case "double_click_element":
      await client.click({ ...base, element_index: action.elementIndex, click_count: 2, mouse_button: "left" });
      return;
    case "right_click_element":
      await client.click({ ...base, element_index: action.elementIndex, click_count: 1, mouse_button: "right" });
      return;
    case "click":
    case "double_click":
    case "right_click": {
      const clickCount = action.action === "double_click" ? 2 : "clickCount" in action ? action.clickCount ?? 1 : 1;
      const mouseButton = action.action === "right_click" ? "right" : "mouseButton" in action ? action.mouseButton ?? "left" : "left";
      await client.click({
        ...base,
        x: action.x,
        y: action.y,
        ...(action.screenshotId ? { screenshotId: action.screenshotId } : {}),
        click_count: clickCount,
        mouse_button: mouseButton,
      });
      return;
    }
    case "scroll":
      await client.scroll({
        ...base,
        x: action.x,
        y: action.y,
        scrollX: action.scrollX,
        scrollY: action.scrollY,
        ...(action.screenshotId ? { screenshotId: action.screenshotId } : {}),
      });
      return;
    case "drag":
      await client.drag({
        ...base,
        from_x: action.fromX,
        from_y: action.fromY,
        to_x: action.toX,
        to_y: action.toY,
        ...(action.screenshotId ? { screenshotId: action.screenshotId } : {}),
      });
      return;
    case "type_text":
      await client.type_text({ ...base, text: action.text });
      return;
    case "keypress":
      await client.press_key({ ...base, key: action.key });
      return;
    case "set_value":
      await client.set_value({ ...base, element_index: action.elementIndex, value: action.value });
      return;
    case "secondary_action":
      await client.perform_secondary_action({ ...base, element_index: action.elementIndex, action: action.actionName });
  }
}

export function codexCuaActionCode(window: CodexCuaWindow, action: CodexCuaAction): string {
  const w = windowSchema.parse(window);
  const base = { window: w };
  switch (action.action) {
    case "activate_window":
      return `await cua.computer.activate_window(${JSON.stringify(base)})`;
    case "click_element":
      return `await cua.computer.click(${JSON.stringify({
        ...base,
        element_index: action.elementIndex,
        click_count: action.clickCount ?? 1,
        mouse_button: action.mouseButton ?? "left",
      })})`;
    case "double_click_element":
      return `await cua.computer.click(${JSON.stringify({ ...base, element_index: action.elementIndex, click_count: 2, mouse_button: "left" })})`;
    case "right_click_element":
      return `await cua.computer.click(${JSON.stringify({ ...base, element_index: action.elementIndex, click_count: 1, mouse_button: "right" })})`;
    case "click":
    case "double_click":
    case "right_click": {
      const clickCount = action.action === "double_click" ? 2 : "clickCount" in action ? action.clickCount ?? 1 : 1;
      const mouseButton = action.action === "right_click" ? "right" : "mouseButton" in action ? action.mouseButton ?? "left" : "left";
      return `await cua.computer.click(${JSON.stringify({
        ...base,
        x: action.x,
        y: action.y,
        ...(action.screenshotId ? { screenshotId: action.screenshotId } : {}),
        click_count: clickCount,
        mouse_button: mouseButton,
      })})`;
    }
    case "scroll":
      return `await cua.computer.scroll(${JSON.stringify({
        ...base,
        x: action.x,
        y: action.y,
        scrollX: action.scrollX,
        scrollY: action.scrollY,
        ...(action.screenshotId ? { screenshotId: action.screenshotId } : {}),
      })})`;
    case "drag":
      return `await cua.computer.drag(${JSON.stringify({
        ...base,
        from_x: action.fromX,
        from_y: action.fromY,
        to_x: action.toX,
        to_y: action.toY,
        ...(action.screenshotId ? { screenshotId: action.screenshotId } : {}),
      })})`;
    case "type_text":
      return `await cua.computer.type_text(${JSON.stringify({ ...base, text: action.text })})`;
    case "keypress":
      return `await cua.computer.press_key(${JSON.stringify({ ...base, key: action.key })})`;
    case "set_value":
      return `await cua.computer.set_value(${JSON.stringify({ ...base, element_index: action.elementIndex, value: action.value })})`;
    case "secondary_action":
      return `await cua.computer.perform_secondary_action(${JSON.stringify({ ...base, element_index: action.elementIndex, action: action.actionName })})`;
  }
}

function extractMarkedJson(content: Array<{ type: string; [key: string]: unknown }>): string {
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block = content[index];
    if (block.type !== "text" || typeof block.text !== "string") continue;
    const markerIndex = block.text.lastIndexOf(JSON_MARKER);
    if (markerIndex >= 0) return block.text.slice(markerIndex + JSON_MARKER.length).trim();
  }
  throw new Error("Codex Computer Use sidecar returned no structured DevSpace result marker.");
}

function extractToolText(content: Array<{ type: string; [key: string]: unknown }>): string {
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join("\n")
    .trim();
}

function approvalApp(params: CodexCuaElicitationParams): string | undefined {
  const toolParams = codexCuaElicitationMeta(params).tool_params;
  if (!toolParams || typeof toolParams !== "object" || Array.isArray(toolParams)) return undefined;
  const app = Reflect.get(toolParams, "app");
  return typeof app === "string" && app.trim() ? app.trim() : undefined;
}

export function codexCuaElicitationMeta(params: CodexCuaElicitationParams): Record<string, unknown> {
  return {
    ...(params.meta ?? {}),
    ...(params._meta ?? {}),
  };
}

function compareVersionish(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}
