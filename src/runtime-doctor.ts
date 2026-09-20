import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { access, readFile, statfs, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { connect as connectTcp } from "node:net";
import { connect as connectTls } from "node:tls";
import { promisify } from "node:util";
import { satisfies } from "semver";
import { discoverCodexCuaSidecar, discoverDirectSkyConfig } from "./codex-cua-bridge.js";
import type { ServerConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { loadDevspaceFiles } from "./user-config.js";

const exec = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 3_000;

export const diagnosticStatuses = ["pass", "warn", "fail", "unknown", "skipped"] as const;
export type DiagnosticStatus = typeof diagnosticStatuses[number];
export const diagnosticCategories = ["runtime", "mcp", "catalog", "computer", "browser", "windows", "configuration"] as const;
export type DiagnosticCategory = typeof diagnosticCategories[number];
export type DiagnosticSeverity = "info" | "low" | "medium" | "high";

export interface DiagnosticCheck {
  id: string;
  category: DiagnosticCategory;
  status: DiagnosticStatus;
  severity: DiagnosticSeverity;
  summary: string;
  details: string;
  evidence: Record<string, unknown>;
  recommendation: string;
  durationMs: number;
  timestamp: string;
}

export interface DoctorReport {
  schemaVersion: 1;
  generatedAt: string;
  overallStatus: DiagnosticStatus;
  full: boolean;
  category?: DiagnosticCategory;
  readOnly: true;
  checks: DiagnosticCheck[];
}

export interface DoctorOptions {
  full?: boolean;
  category?: DiagnosticCategory;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface DoctorDependencies {
  now(): Date;
  run(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  tcp(host: string, port: number, timeoutMs: number): Promise<void>;
  dns(host: string): Promise<Array<{ address: string; family: number }>>;
  tls(host: string, port: number, timeoutMs: number): Promise<{ authorized: boolean; protocol?: string; validTo?: string }>;
  fetch(url: string, init: RequestInit & { signal: AbortSignal }): Promise<Response>;
  exists(path: string): Promise<boolean>;
  disk(path: string): Promise<{ freeBytes: number; totalBytes: number }>;
  cua(): Promise<{ version: string; trustedRoot: boolean; nativePipeConfigured: boolean; nativePipeReachable: boolean; directRuntime: boolean; runtimeName: string }>;
}

const defaultDependencies: DoctorDependencies = {
  now: () => new Date(),
  run: async (command, args, timeoutMs) => {
    try {
      const result = await exec(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 512 * 1024 });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: number | string };
      return { stdout: String(failure.stdout ?? ""), stderr: String(failure.stderr ?? ""),
        exitCode: typeof failure.code === "number" ? failure.code : 1 };
    }
  },
  tcp: (host, port, timeoutMs) => new Promise<void>((resolveSocket, reject) => {
    const socket = connectTcp({ host, port });
    const timer = setTimeout(() => socket.destroy(new Error("timeout")), timeoutMs);
    socket.once("connect", () => { clearTimeout(timer); socket.end(); resolveSocket(); });
    socket.once("error", error => { clearTimeout(timer); reject(error); });
  }),
  dns: async host => lookup(host, { all: true }),
  tls: (host, port, timeoutMs) => new Promise((resolveTls, reject) => {
    const socket = connectTls({ host, port, servername: host, rejectUnauthorized: true });
    const timer = setTimeout(() => socket.destroy(new Error("timeout")), timeoutMs);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      const certificate = socket.getPeerCertificate();
      const result = { authorized: socket.authorized, protocol: socket.getProtocol() ?? undefined,
        validTo: certificate?.valid_to || undefined };
      socket.end();
      resolveTls(result);
    });
    socket.once("error", error => { clearTimeout(timer); reject(error); });
  }),
  fetch: (url, init) => fetch(url, init),
  exists: path => access(path).then(() => true, () => false),
  disk: async path => {
    const stats = await statfs(path);
    return { freeBytes: Number(stats.bavail) * Number(stats.bsize), totalBytes: Number(stats.blocks) * Number(stats.bsize) };
  },
  cua: async () => {
    const sidecar = await discoverCodexCuaSidecar();
    const direct = await discoverDirectSkyConfig(sidecar);
    const home = await import("node:fs/promises").then(fs => fs.realpath(homedir()));
    const trustedRoot = relative(home, sidecar.root).split(/[\\/]/)[0] === ".codex";
    const pipe = sidecar.env.SKY_CUA_NATIVE_PIPE_DIRECTORY ?? "";
    const nativePipeConfigured = /^\\\\\.\\pipe\\codex-computer-use-/i.test(pipe);
    const nativePipeReachable = nativePipeConfigured ? await access(pipe).then(() => true, () => false) : false;
    return { version: sidecar.version, trustedRoot,
      nativePipeConfigured, nativePipeReachable, directRuntime: Boolean(direct.clientModule && direct.transportModule && direct.helperCommand),
      runtimeName: basename(direct.helperCommand) };
  },
};

function elapsed(started: number): number { return Math.max(0, Math.round(performance.now() - started)); }

function makeCheck(input: Omit<DiagnosticCheck, "durationMs" | "timestamp">, started: number, deps: DoctorDependencies): DiagnosticCheck {
  return { ...input, durationMs: elapsed(started), timestamp: deps.now().toISOString() };
}

async function checked(
  id: string, category: DiagnosticCategory, operation: () => Promise<Omit<DiagnosticCheck, "id" | "category" | "durationMs" | "timestamp">>,
  deps: DoctorDependencies,
): Promise<DiagnosticCheck> {
  const started = performance.now();
  try { return makeCheck({ id, category, ...(await operation()) }, started, deps); }
  catch (error) {
    return makeCheck({ id, category, status: "unknown", severity: "medium", summary: `${id} could not be verified`,
      details: safeMessage(error), evidence: {}, recommendation: "Inspect this layer directly; UNKNOWN is not treated as PASS." }, started, deps);
  }
}

function safeMessage(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function localHost(host: string): string { return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host; }
function localMcpUrl(host: string, port: number): URL {
  const target = localHost(host);
  const formatted = target.includes(":") && !target.startsWith("[") ? `[${target}]` : target;
  return new URL(`http://${formatted}:${port}/mcp`);
}

function overall(checks: DiagnosticCheck[]): DiagnosticStatus {
  if (checks.some(check => check.status === "fail")) return "fail";
  if (checks.some(check => check.status === "unknown")) return "unknown";
  if (checks.some(check => check.status === "warn")) return "warn";
  if (checks.length && checks.every(check => check.status === "skipped")) return "skipped";
  return "pass";
}

export async function runRuntimeDoctor(options: DoctorOptions = {}, dependencies: Partial<DoctorDependencies> = {}): Promise<DoctorReport> {
  const deps: DoctorDependencies = { ...defaultDependencies, ...dependencies };
  const timeoutMs = Math.max(250, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 15_000));
  const env = options.env ?? process.env;
  const files = loadDevspaceFiles(env);
  let config: ServerConfig | undefined;
  let configError: unknown;
  try { config = loadConfig(env); } catch (error) { configError = error; }
  const include = (category: DiagnosticCategory) => !options.category || options.category === category;
  const checks: DiagnosticCheck[] = [];

  if (include("configuration")) {
    const authAvailable = files.authExists || Boolean(env.DEVSPACE_OAUTH_OWNER_TOKEN?.trim());
    checks.push(await checked("configuration.files", "configuration", async () => ({
      status: files.configExists && authAvailable ? "pass" : "fail",
      severity: files.configExists && authAvailable ? "info" : "high",
      summary: files.configExists && authAvailable ? "DevSpace configuration and authentication source are present" : "DevSpace configuration is incomplete",
      details: configError ? safeMessage(configError) : "Configuration parsed successfully.",
      evidence: { configExists: files.configExists, authSource: files.authExists ? "auth-file" : authAvailable ? "environment" : "missing", configDirectory: files.dir },
      recommendation: files.configExists && authAvailable ? "No action required." : "Run `devspace init` or provide the configured owner-token environment source, then re-run Doctor.",
    }), deps));
  }

  if (include("runtime")) {
    checks.push(await checked("runtime.process", "runtime", async () => {
      const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version?: string; engines?: { node?: string } };
      const range = packageJson.engines?.node ?? "unknown";
      const supported = range !== "unknown" && satisfies(process.versions.node, range);
      return { status: supported ? "pass" : "fail", severity: supported ? "info" : "high",
        summary: supported ? "Current Node runtime satisfies the package engine" : "Current Node runtime is outside the package engine",
        details: `Doctor PID ${process.pid}; current process start is derived from uptime and does not identify another server process.`,
        evidence: { pid: process.pid, processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
          executable: process.execPath, entrypoint: process.argv[1] ?? null, node: process.version, nodeAbi: process.versions.modules,
          packageVersion: packageJson.version ?? "unknown", nodeEngine: range, buildId: env.DEVSPACE_BUILD_ID?.trim() || "source",
          releasePointer: env.DEVSPACE_RELEASE_POINTER?.trim() || null },
        recommendation: supported ? "No action required." : `Use a Node version matching ${range}.` };
    }, deps));
  }

  if (include("mcp")) {
    checks.push(await checked("mcp.local-port", "mcp", async () => {
      if (!config) return { status: "unknown" as const, severity: "medium" as const, summary: "Local MCP endpoint cannot be derived",
        details: safeMessage(configError), evidence: {}, recommendation: "Fix configuration first." };
      const host = localHost(config.host);
      try {
        await deps.tcp(host, config.port, timeoutMs);
        return { status: "pass" as const, severity: "info" as const, summary: "Local MCP TCP listener is reachable",
          details: "This confirms a listener only; it is not proof of MCP protocol or process identity.",
          evidence: { host, port: config.port }, recommendation: "Use the protocol check to distinguish server from protocol/authentication issues." };
      } catch (error) {
        return { status: "fail" as const, severity: "high" as const, summary: "Local MCP TCP listener is unreachable",
          details: safeMessage(error), evidence: { host, port: config.port }, recommendation: "Check whether DevSpace is running and whether the configured port is correct." };
      }
    }, deps));
    checks.push(await checked("mcp.local-protocol", "mcp", async () => {
      if (!options.full) return { status: "skipped" as const, severity: "info" as const, summary: "Local MCP initialize probe skipped in standard mode",
        details: "Use `devspace doctor --full` for a bounded no-credential protocol probe.", evidence: {}, recommendation: "Run --full when protocol-layer diagnosis is needed." };
      if (!config) return { status: "unknown" as const, severity: "medium" as const, summary: "Local MCP protocol endpoint cannot be derived",
        details: safeMessage(configError), evidence: {}, recommendation: "Fix configuration first." };
      const url = localMcpUrl(config.host, config.port);
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await deps.fetch(url.toString(), { method: "POST", redirect: "manual", signal: controller.signal,
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "devspace-doctor", version: "1" } } }) });
        if (response.status === 401 || response.status === 403) return { status: "pass" as const, severity: "info" as const,
          summary: "Local MCP protocol endpoint is reachable and enforces authentication",
          details: "No OAuth credential was sent. Authentication enforcement is expected and does not authorize this Doctor run.",
          evidence: { httpStatus: response.status, url: redactUrl(url) }, recommendation: "If the public route still fails, investigate tunnel/TLS rather than the local MCP listener." };
        if (response.ok) return { status: "pass" as const, severity: "info" as const, summary: "Local MCP initialize endpoint responded successfully",
          details: "This is protocol reachability only, not process identity or host-catalog freshness.", evidence: { httpStatus: response.status, url: redactUrl(url) },
          recommendation: "Use authenticated `devspace_runtime_info` for active runtime identity/catalog verification." };
        return { status: "warn" as const, severity: "medium" as const, summary: "Local MCP endpoint answered with an unexpected status",
          details: `HTTP ${response.status}`, evidence: { httpStatus: response.status, url: redactUrl(url) }, recommendation: "Inspect local MCP middleware and server logs." };
      } catch (error) {
        return { status: "fail" as const, severity: "high" as const, summary: "Local MCP protocol probe failed",
          details: safeMessage(error), evidence: { url: redactUrl(url) }, recommendation: "Check the local listener/server before debugging the public tunnel." };
      } finally { clearTimeout(timer); }
    }, deps));
    checks.push(await checked("mcp.public-dns", "mcp", async () => {
      const raw = config?.publicBaseUrl ?? files.config.server.publicBaseUrl;
      if (!raw) return { status: "skipped" as const, severity: "info" as const, summary: "No public MCP URL is configured",
        details: "Fixed-domain DNS cannot be checked without a publicBaseUrl.", evidence: {}, recommendation: "Configure publicBaseUrl if ChatGPT should reach this host." };
      const url = new URL(raw);
      try {
        const rows = await deps.dns(url.hostname);
        return { status: rows.length ? "pass" as const : "unknown" as const, severity: rows.length ? "info" as const : "medium" as const,
          summary: rows.length ? "Public MCP hostname resolves" : "Public MCP DNS returned no address",
          details: `Resolved ${rows.length} address record(s).`, evidence: { hostname: url.hostname, families: [...new Set(rows.map(row => row.family))] },
          recommendation: rows.length ? "No DNS action required." : "Check the fixed-domain DNS record." };
      } catch (error) {
        return { status: "fail" as const, severity: "high" as const, summary: "Public MCP hostname does not resolve",
          details: safeMessage(error), evidence: { hostname: url.hostname }, recommendation: "Repair DNS before debugging MCP authentication or tools." };
      }
    }, deps));
    checks.push(await checked("mcp.public-tls", "mcp", async () => {
      const raw = config?.publicBaseUrl ?? files.config.server.publicBaseUrl;
      if (!raw) return { status: "skipped" as const, severity: "info" as const, summary: "Public TLS check skipped",
        details: "No publicBaseUrl is configured.", evidence: {}, recommendation: "Configure a public URL first." };
      const url = new URL(raw);
      if (url.protocol !== "https:") return { status: "warn" as const, severity: "medium" as const, summary: "Public MCP URL is not HTTPS",
        details: `Configured scheme is ${url.protocol}`, evidence: { hostname: url.hostname, protocol: url.protocol }, recommendation: "Use HTTPS for a remote ChatGPT MCP endpoint." };
      try {
        const result = await deps.tls(url.hostname, Number(url.port || 443), timeoutMs);
        return { status: result.authorized ? "pass" as const : "fail" as const, severity: result.authorized ? "info" as const : "high" as const,
          summary: result.authorized ? "Public TLS certificate is accepted" : "Public TLS certificate is not authorized",
          details: "TLS was checked without sending OAuth credentials.", evidence: { hostname: url.hostname, protocol: result.protocol, validTo: result.validTo },
          recommendation: result.authorized ? "No TLS action required." : "Repair the public certificate or tunnel TLS configuration." };
      } catch (error) {
        return { status: "fail" as const, severity: "high" as const, summary: "Public TLS handshake failed",
          details: safeMessage(error), evidence: { hostname: url.hostname }, recommendation: "Check tunnel availability, certificate and SNI routing." };
      }
    }, deps));
    checks.push(await checked("mcp.public-route", "mcp", async () => {
      const raw = config?.publicBaseUrl ?? files.config.server.publicBaseUrl;
      if (!raw) return { status: "skipped" as const, severity: "info" as const, summary: "Public route check skipped", details: "No publicBaseUrl is configured.", evidence: {}, recommendation: "Configure a public URL first." };
      const url = new URL("/.well-known/oauth-authorization-server", raw);
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await deps.fetch(url.toString(), { method: "GET", redirect: "manual", signal: controller.signal });
        const status = response.status;
        return { status: status >= 200 && status < 400 ? "pass" as const : "warn" as const,
          severity: status >= 200 && status < 400 ? "info" as const : "medium" as const,
          summary: status >= 200 && status < 400 ? "Public tunnel reaches DevSpace OAuth discovery" : "Public host answered but OAuth discovery is unexpected",
          details: "The probe sends no Authorization header and does not perform OAuth.", evidence: { url: redactUrl(url), httpStatus: status },
          recommendation: status >= 200 && status < 400 ? "Continue with authenticated MCP/tool-catalog checks from the host." : "Check reverse-proxy/tunnel routing to DevSpace." };
      } catch (error) {
        return { status: "fail" as const, severity: "high" as const, summary: "Public tunnel route is unreachable",
          details: safeMessage(error), evidence: { url: redactUrl(url) }, recommendation: "Check tunnel process, origin target and firewall." };
      } finally { clearTimeout(timer); }
    }, deps));
    checks.push(await checked("mcp.public-protocol", "mcp", async () => {
      if (!options.full) return { status: "skipped" as const, severity: "info" as const, summary: "Anonymous MCP protocol probe skipped in standard mode",
        details: "Use `devspace doctor --full` for a no-credential initialize probe.", evidence: {}, recommendation: "Run --full when endpoint-layer diagnosis is needed." };
      const raw = config?.publicBaseUrl ?? files.config.server.publicBaseUrl;
      if (!raw) return { status: "skipped" as const, severity: "info" as const, summary: "MCP protocol probe skipped", details: "No public URL is configured.", evidence: {}, recommendation: "Configure publicBaseUrl first." };
      const url = new URL("/mcp", raw);
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await deps.fetch(url.toString(), { method: "POST", redirect: "manual", signal: controller.signal,
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "devspace-doctor", version: "1" } } }) });
        if (response.status === 401 || response.status === 403) return { status: "warn" as const, severity: "info" as const,
          summary: "MCP endpoint is reachable and requires authentication", details: "Doctor intentionally does not perform OAuth, so authenticated initialize/tools-list remain unverified.",
          evidence: { httpStatus: response.status, url: redactUrl(url) }, recommendation: "Use `devspace_runtime_info` from an authenticated ChatGPT connection to verify server identity and catalog." };
        if (response.ok) return { status: "pass" as const, severity: "info" as const, summary: "Anonymous MCP initialize endpoint responded successfully",
          details: "This proves protocol reachability only; it does not prove the ChatGPT host catalog is current.", evidence: { httpStatus: response.status, url: redactUrl(url) }, recommendation: "Compare the authenticated runtime catalog with the host snapshot." };
        return { status: "warn" as const, severity: "medium" as const, summary: "MCP endpoint answered with an unexpected HTTP status",
          details: `HTTP ${response.status}`, evidence: { httpStatus: response.status, url: redactUrl(url) }, recommendation: "Inspect DevSpace/tunnel logs and OAuth middleware." };
      } catch (error) {
        return { status: "fail" as const, severity: "high" as const, summary: "MCP initialize probe could not reach the endpoint",
          details: safeMessage(error), evidence: { url: redactUrl(url) }, recommendation: "Resolve DNS/TLS/tunnel issues before MCP protocol debugging." };
      } finally { clearTimeout(timer); }
    }, deps));
  }

  if (include("catalog")) {
    checks.push(await checked("catalog.freshness", "catalog", async () => ({
      status: "unknown", severity: "medium", summary: "Host tool-catalog freshness cannot be proven from the local CLI alone",
      details: "The server exposes tool count/schema/fingerprint through authenticated `devspace_runtime_info`, but Doctor will not perform OAuth or trust a caller-supplied host snapshot.",
      evidence: { localToolSchemaExpectation: "read via devspace_runtime_info", hostSnapshotAvailable: false },
      recommendation: "In ChatGPT call `devspace_runtime_info`; compare buildId, toolSchemaVersion, toolCatalogCount and toolCatalogFingerprint with the host tool catalog. A mismatch confirms/potentially indicates a stale host catalog.",
    }), deps));
  }

  if (include("computer")) {
    checks.push(await checked("computer.cua-runtime", "computer", async () => {
      if (process.platform !== "win32") return { status: "skipped" as const, severity: "info" as const, summary: "Codex Computer Use Windows runtime check skipped",
        details: `Platform is ${process.platform}.`, evidence: { platform: process.platform }, recommendation: "Run this check on the Windows DevSpace host." };
      if (!config?.computerUseEnabled) return { status: "skipped" as const, severity: "info" as const, summary: "Computer Use is disabled in DevSpace configuration",
        details: "No runtime launch or approval was attempted.", evidence: { enabled: false }, recommendation: "Enable Computer Use only if needed." };
      try {
        const cua = await deps.cua();
        const layoutHealthy = cua.trustedRoot && cua.nativePipeConfigured && cua.directRuntime;
        const status = !layoutHealthy ? "warn" as const : cua.nativePipeReachable ? "pass" as const : "unknown" as const;
        return { status, severity: status === "pass" ? "info" as const : "medium" as const,
          summary: status === "pass" ? "Trusted Codex Computer Use runtime and native pipe are discoverable"
            : status === "unknown" ? "Trusted Computer Use layout exists but active native-pipe reachability is not confirmed"
              : "Codex Computer Use runtime discovery is incomplete",
          details: "Discovery validates trusted bundled paths and existing pipe state only; it does not launch a helper, authorize an app or control the desktop.", evidence: cua,
          recommendation: status === "pass" ? "No runtime-layout action required."
            : status === "unknown" ? "Start/use the official Codex CUA runtime normally, then re-run Doctor; do not substitute an arbitrary helper path."
              : "Repair the official Codex unified-computer-use installation/runtime before using desktop Computer Use." };
      } catch (error) {
        return { status: "fail" as const, severity: "high" as const, summary: "Trusted Codex Computer Use runtime is unavailable",
          details: safeMessage(error), evidence: { enabled: true }, recommendation: "Check the official bundled CUA runtime, trusted root and native pipe. Do not substitute an arbitrary helper path." };
      }
    }, deps));
  }

  if (include("browser")) {
    checks.push(await checked("browser.installation", "browser", async () => {
      if (process.platform !== "win32") return { status: "skipped" as const, severity: "info" as const, summary: "Windows browser installation check skipped",
        details: `Platform is ${process.platform}.`, evidence: {}, recommendation: "Run on the Windows host." };
      const candidates = [
        env.PROGRAMFILES ? join(env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe") : "",
        env["PROGRAMFILES(X86)"] ? join(env["PROGRAMFILES(X86)"]!, "Microsoft", "Edge", "Application", "msedge.exe") : "",
        env.PROGRAMFILES ? join(env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe") : "",
        env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : "",
      ].filter(Boolean);
      const found: string[] = [];
      for (const path of candidates) if (await deps.exists(path)) found.push(basename(path));
      return { status: found.length ? "pass" as const : "warn" as const, severity: found.length ? "info" as const : "medium" as const,
        summary: found.length ? "A supported Windows browser executable is present" : "No Edge/Chrome executable was found in standard locations",
        details: "Executable presence does not prove Browser Use attachment, extension session, providerTabId, authentication or trusted-origin state.",
        evidence: { browsers: [...new Set(found)] }, recommendation: found.length ? "Use Browser Use itself to verify attachment/security state." : "Install or repair Edge/Chrome if Browser Use is required." };
    }, deps));
    checks.push(await checked("browser.attachment", "browser", async () => ({
      status: "unknown", severity: "medium", summary: "Browser Use attachment and origin security are not probed by Doctor",
      details: "A safe determination requires trusted Browser Use state (browserId/tabId/providerTabId/current URL). Doctor does not launch a browser, attach a tab, or answer an approval prompt.",
      evidence: { visible: "unknown", attached: "unknown", securityBlocked: "unknown", authRequired: "unknown" },
      recommendation: "From an authorized ChatGPT turn call `browser_state`, then inspect the exact returned browser/tab and trusted URL. If approval is requested, the user must decide it.",
    }), deps));
  }

  if (include("windows")) {
    checks.push(await checked("windows.toolchain", "windows", async () => {
      const probes = process.platform === "win32"
        ? [["git", ["--version"]], ["pnpm", ["--version"]], ["powershell.exe", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"]], ["pwsh.exe", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"]]] as const
        : [["git", ["--version"]], ["pnpm", ["--version"]]] as const;
      const evidence: Record<string, unknown> = {};
      let missing = 0;
      for (const [command, args] of probes) {
        const result = await deps.run(command, [...args], timeoutMs);
        const key = command.replace(/\.exe$/i, "");
        evidence[key] = result.exitCode === 0 ? redactText(result.stdout.trim()).slice(0, 200) : "unavailable";
        if (result.exitCode !== 0 && (key === "git" || key === "pnpm" || key === "powershell")) missing++;
      }
      return { status: missing ? "warn" as const : "pass" as const, severity: missing ? "medium" as const : "info" as const,
        summary: missing ? "One or more required host tools are unavailable" : "Core host command-line tools are available",
        details: "PowerShell 7 is optional; Windows PowerShell, Git and pnpm are the primary compatibility probes here.", evidence,
        recommendation: missing ? "Install/repair the unavailable required tool and ensure it is on PATH." : "No toolchain action required." };
    }, deps));
    checks.push(await checked("windows.powershell-hash", "windows", async () => {
      if (process.platform !== "win32") return { status: "skipped" as const, severity: "info" as const, summary: "PowerShell module check skipped",
        details: "Not running on Windows.", evidence: {}, recommendation: "Run on the Windows host." };
      const result = await deps.run("powershell.exe", ["-NoProfile", "-Command", "Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop; (Get-Command Get-FileHash).Name"], timeoutMs);
      return { status: result.exitCode === 0 && /Get-FileHash/i.test(result.stdout) ? "pass" as const : "fail" as const,
        severity: result.exitCode === 0 ? "info" as const : "medium" as const, summary: result.exitCode === 0 ? "Microsoft.PowerShell.Utility and Get-FileHash are available" : "PowerShell hashing support is unavailable",
        details: redactText((result.stdout || result.stderr).trim()).slice(0, 500), evidence: { exitCode: result.exitCode },
        recommendation: result.exitCode === 0 ? "No action required." : "Repair Microsoft.PowerShell.Utility / Windows PowerShell before release verification." };
    }, deps));
    checks.push(await checked("windows.disk", "windows", async () => {
      const target = config?.stateDir ?? files.dir;
      const disk = await deps.disk(target);
      const ratio = disk.totalBytes > 0 ? disk.freeBytes / disk.totalBytes : 0;
      const low = disk.freeBytes < 2 * 1024 ** 3 || ratio < 0.05;
      return { status: low ? "warn" as const : "pass" as const, severity: low ? "medium" as const : "info" as const,
        summary: low ? "DevSpace state volume is low on free space" : "DevSpace state volume has usable free space",
        details: "Disk check is read-only and uses the state/config volume.", evidence: { freeBytes: disk.freeBytes, totalBytes: disk.totalBytes, freePercent: Math.round(ratio * 10_000) / 100 },
        recommendation: low ? "Free disk space before large builds, worktrees or recovery journals." : "No action required." };
    }, deps));
    checks.push(await checked("windows.long-paths", "windows", async () => {
      if (process.platform !== "win32") return { status: "skipped" as const, severity: "info" as const, summary: "Windows long-path policy check skipped", details: "Not running on Windows.", evidence: {}, recommendation: "Run on Windows." };
      const result = await deps.run("reg.exe", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem", "/v", "LongPathsEnabled"], timeoutMs);
      const enabled = /LongPathsEnabled\s+REG_DWORD\s+0x1/i.test(result.stdout);
      return { status: enabled ? "pass" as const : result.exitCode === 0 ? "warn" as const : "unknown" as const,
        severity: enabled ? "info" as const : "low" as const, summary: enabled ? "Windows long paths are enabled" : "Windows long-path support is not confirmed",
        details: result.exitCode === 0 ? redactText(result.stdout.trim()).slice(0, 400) : redactText(result.stderr.trim()).slice(0, 400), evidence: { registryQueryExitCode: result.exitCode },
        recommendation: enabled ? "No action required." : "Enable Windows long paths if deep worktrees or dependency paths fail." };
    }, deps));
  }

  const report: DoctorReport = { schemaVersion: 1, generatedAt: deps.now().toISOString(), overallStatus: overall(checks),
    full: Boolean(options.full), category: options.category, readOnly: true, checks };
  return redactDoctorReport(report);
}

function redactUrl(url: URL): string {
  const safe = new URL(url.toString());
  safe.username = ""; safe.password = ""; safe.search = ""; safe.hash = "";
  return safe.toString();
}

const secretKey = /(?:token|secret|password|passwd|cookie|authorization|credential|private.?key|mfa|otp|owner.?token)/i;
export function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:access_token|refresh_token|token|code|password|secret)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[REDACTED]@")
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]");
}

function redactValue(value: unknown, key = ""): unknown {
  if (secretKey.test(key)) return value == null ? value : "[REDACTED]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(item => redactValue(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([child, item]) => [child, redactValue(item, child)]));
  return value;
}

export function redactDoctorReport(report: DoctorReport): DoctorReport {
  return redactValue(report) as DoctorReport;
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [`DevSpace Doctor — ${report.overallStatus.toUpperCase()}`, `Generated: ${report.generatedAt}`, `Mode: ${report.full ? "full" : "standard"}${report.category ? ` · category=${report.category}` : ""}`, ""];
  for (const check of report.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.id} — ${check.summary}`);
    if (check.details) lines.push(`  ${check.details}`);
    if (check.recommendation) lines.push(`  Next: ${check.recommendation}`);
  }
  return lines.join("\n");
}

export async function writeDoctorSupportBundle(report: DoctorReport, directory = process.cwd()): Promise<string> {
  const safe = redactDoctorReport(report);
  const stamp = safe.generatedAt.replace(/[:.]/g, "-");
  const path = resolve(directory, `devspace-support-${stamp}.json`);
  await writeFile(path, JSON.stringify({ kind: "devspace-doctor-support-bundle", report: safe }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return path;
}

export function parseDoctorArgs(args: string[]): { options: DoctorOptions; json: boolean; supportBundle: boolean } {
  const options: DoctorOptions = {};
  let json = false, supportBundle = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--full") options.full = true;
    else if (arg === "--json") json = true;
    else if (arg === "--support-bundle") supportBundle = true;
    else if (arg === "--category") {
      const category = args[++index];
      if (!diagnosticCategories.includes(category as DiagnosticCategory)) throw new Error(`Unknown Doctor category: ${category ?? "missing"}`);
      options.category = category as DiagnosticCategory;
    } else throw new Error(`Unknown doctor option: ${arg}`);
  }
  return { options, json, supportBundle };
}

export function doctorReportFingerprint(report: DoctorReport): string {
  return createHash("sha256").update(JSON.stringify(redactDoctorReport(report))).digest("hex");
}
