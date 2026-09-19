import { createHash } from "node:crypto";
import type { Health } from "../runtime-lifecycle/contracts.js";

class ProbeFailure extends Error { constructor(readonly reason: Health["reason"]) { super(reason); } }
const MAX_BYTES = 1_048_576;
async function responseValue(response: Response, id: number): Promise<Record<string, unknown>> {
  if ([401, 403].includes(response.status)) throw new ProbeFailure("authentication");
  if (!response.ok) throw new ProbeFailure(response.status >= 500 ? "network_transient" : "unknown");
  const reader = response.body?.getReader();
  if (!reader) throw new ProbeFailure("unknown");
  const decoder = new TextDecoder(); let text = ""; let bytes = 0;
  const sse = response.headers.get("content-type")?.includes("text/event-stream");
  try {
    while (true) {
      const item = await reader.read();
      if (item.value) { bytes += item.value.byteLength; if (bytes > MAX_BYTES) throw new ProbeFailure("unknown"); text += decoder.decode(item.value, { stream: true }); }
      if (sse) {
        text = text.replaceAll("\r\n", "\n");
        let end: number;
        while ((end = text.indexOf("\n\n")) !== -1) {
          const packet = text.slice(0, end); text = text.slice(end + 2);
          const data = packet.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (!data) continue;
          const value = JSON.parse(data) as Record<string, unknown>;
          if (value.id === id) return value;
        }
      }
      if (item.done) {
        if (sse) throw new ProbeFailure("unknown");
        const value = JSON.parse(text + decoder.decode()) as Record<string, unknown>;
        if (value.id !== id) throw new ProbeFailure("unknown"); return value;
      }
    }
  } finally { await reader.cancel().catch(() => {}); }
}
export interface McpProbeInput { origin: string; token?: string; expectedBuildId: string; expectedServerVersion: string; timeoutMs: number; processAlive: boolean; portListening: boolean }
// Uses an already-approved bearer credential. NEVER registers OAuth clients,
// exchanges owner tokens, approves elicitation, calls workspace tools or retries mutations.
export async function probeMcp(input: McpProbeInput): Promise<Health> {
  const started = performance.now(); let session: string | undefined;
  const base: Health = { status: "degraded", reason: "network_transient", processAlive: input.processAlive, portListening: input.portListening, mcpReady: false };
  if (!input.token) return { ...base, status: "blocked", reason: "authentication" };
  if (!input.processAlive || !input.portListening) return base;
  const abort = AbortSignal.timeout(Math.min(30_000, Math.max(100, input.timeoutMs)));
  const headers = (): Record<string, string> => ({ authorization: `Bearer ${input.token}`, "content-type": "application/json", accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-03-26", ...(session ? { "mcp-session-id": session } : {}) });
  const rpc = async (method: string, params: unknown, id: number): Promise<Record<string, unknown>> => {
    const response = await fetch(new URL("/mcp", input.origin), { method: "POST", redirect: "error", signal: abort, headers: headers(), body: JSON.stringify({ jsonrpc: "2.0", method, params, id }) });
    if (method === "initialize") session = response.headers.get("mcp-session-id") ?? undefined;
    const value = await responseValue(response, id);
    if (value.error || !value.result || typeof value.result !== "object") throw new ProbeFailure("unknown");
    return value.result as Record<string, unknown>;
  };
  try {
    const http = await fetch(new URL("/healthz", input.origin), { redirect: "error", signal: abort, headers: { authorization: `Bearer ${input.token}` } });
    await http.body?.cancel();
    if ([401, 403].includes(http.status)) throw new ProbeFailure("authentication");
    if (http.status !== 200) throw new ProbeFailure("network_transient");
    const initialized = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "DevSpace read-only runtime health", version: "1" } }, 1);
    if (initialized.protocolVersion !== "2025-03-26") throw new ProbeFailure("unknown");
    const notification = await fetch(new URL("/mcp", input.origin), { method: "POST", redirect: "error", signal: abort, headers: headers(), body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    await notification.body?.cancel();
    if (![200, 202, 204].includes(notification.status)) throw new ProbeFailure([401, 403].includes(notification.status) ? "authentication" : "unknown");
    const names: string[] = []; let cursor: string | undefined;
    for (let page = 0; page < 8; page++) {
      const result = await rpc("tools/list", cursor ? { cursor } : {}, 2 + page);
      if (!Array.isArray(result.tools)) throw new ProbeFailure("unknown");
      for (const item of result.tools) {
        if (!item || typeof item.name !== "string" || item.name.length > 256) throw new ProbeFailure("unknown"); names.push(item.name);
      }
      if (names.length > 1024 || new Set(names).size !== names.length) throw new ProbeFailure("unknown");
      if (!result.nextCursor) { cursor = undefined; break; }
      if (typeof result.nextCursor !== "string" || result.nextCursor === cursor || result.nextCursor.length > 4096) throw new ProbeFailure("unknown");
      cursor = result.nextCursor;
    }
    if (cursor || !names.includes("devspace_runtime_info")) throw new ProbeFailure("unknown");
    const tool = await rpc("tools/call", { name: "devspace_runtime_info", arguments: {} }, 20);
    if (tool.isError) throw new ProbeFailure("unknown");
    const info = tool.structuredContent as Record<string, unknown> | undefined;
    if (!info || info.buildId !== input.expectedBuildId || info.serverVersion !== input.expectedServerVersion) throw new ProbeFailure("release_changed");
    const expectedFingerprint = createHash("sha256").update(names.sort().join("\n")).digest("hex");
    if (info.toolCatalogCount !== names.length || info.toolCatalogFingerprint !== expectedFingerprint) throw new ProbeFailure("unknown");
    return { ...base, status: "healthy", reason: "ready", mcpReady: true, buildId: input.expectedBuildId, serverVersion: input.expectedServerVersion, toolCount: names.length, latencyMs: performance.now() - started };
  } catch (e) {
    const reason = e instanceof ProbeFailure ? e.reason : (abort.aborted || e instanceof TypeError ? "network_transient" : "unknown");
    return { ...base, status: ["authentication", "release_changed", "unknown"].includes(reason) ? "blocked" : "degraded", reason, latencyMs: performance.now() - started };
  } finally {
    if (session) await fetch(new URL("/mcp", input.origin), { method: "DELETE", redirect: "error", signal: AbortSignal.timeout(1_000), headers: headers() })
      .then(async response => { await response.body?.cancel(); }).catch(() => {});
  }
}
