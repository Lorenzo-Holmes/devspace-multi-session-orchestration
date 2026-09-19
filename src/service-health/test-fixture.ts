import { createServer, type Server } from "node:http";
import { createHash, randomUUID } from "node:crypto";
export interface FixtureOptions {
  token?: string; buildId?: string; serverVersion?: string; sse?: boolean;
  wrongFingerprint?: boolean; wrongRpcId?: boolean; oversized?: boolean;
  status?: number; hang?: boolean; crash?: () => void;
}
export async function mcpFixture(options: FixtureOptions = {}, port = 0): Promise<{ server: Server; origin: string; sessions: Set<string>; calls: string[]; close(): Promise<void> }> {
  const sessions = new Set<string>(), calls: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${options.token ?? "fixture-token"}`) { res.writeHead(401).end(); return; }
    if (options.status) { res.writeHead(options.status).end(); return; }
    if (options.hang) return;
    if (req.url === "/fixture-crash" && options.crash) { res.end("fixture stopping itself"); setImmediate(options.crash); return; }
    if (req.url === "/healthz") { res.end("ok"); return; }
    if (req.method === "DELETE") { sessions.delete(String(req.headers["mcp-session-id"])); res.writeHead(204).end(); return; }
    if (req.url !== "/mcp") { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString()); calls.push(message.method);
    let result: unknown;
    const names = ["devspace_runtime_info", "read_only_fixture"];
    if (message.method === "initialize") {
      const session = randomUUID(); sessions.add(session); res.setHeader("mcp-session-id", session);
      result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
    } else if (!sessions.has(String(req.headers["mcp-session-id"]))) { res.writeHead(404).end(); return; }
    else if (message.method === "notifications/initialized") { res.writeHead(202).end(); return; }
    else if (message.method === "tools/list") result = { tools: names.map(name => ({ name, inputSchema: { type: "object" } })) };
    else if (message.method === "tools/call" && message.params.name === "devspace_runtime_info") result = {
      content: [], structuredContent: { buildId: options.buildId ?? "fixture-build", serverVersion: options.serverVersion ?? "fixture-version",
        toolCatalogCount: names.length, toolCatalogFingerprint: options.wrongFingerprint ? "bad" : createHash("sha256").update(names.sort().join("\n")).digest("hex") } };
    else { res.writeHead(400).end(); return; }
    const data = options.oversized ? JSON.stringify({ padding: "x".repeat(1_100_000) }) : JSON.stringify({ jsonrpc: "2.0", id: options.wrongRpcId ? -1 : message.id, result });
    if (options.sse) { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`event: message\ndata: ${data}\n\n`); }
    else { res.writeHead(200, { "content-type": "application/json" }); res.end(data); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return { server, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, sessions, calls,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
