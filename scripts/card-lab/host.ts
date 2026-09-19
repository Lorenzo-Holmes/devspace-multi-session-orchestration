import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

const start = document.getElementById("start") as HTMLButtonElement, fault = document.getElementById("fault") as HTMLInputElement;
const replay = document.getElementById("replay") as HTMLButtonElement, delay = document.getElementById("delay") as HTMLInputElement, early = document.getElementById("early") as HTMLInputElement;
const summary = document.getElementById("summary")!, events = document.getElementById("events")!, slot = document.getElementById("frame-slot")!;
const client = new Client({ name: "Isolated simulated MCP Apps host, NOT ChatGPT", version: "1" }, { capabilities: {} });
let labToken: string, waitMs: number, lastKey: string | undefined, bridge: AppBridge | undefined, iframe: HTMLIFrameElement | undefined;
let runEvents: Record<string, unknown>[] = [], blockedMessages = 0;
function note(event: string, data: unknown = null) { runEvents.push({ at: new Date().toISOString(), event, data }); events.textContent = JSON.stringify({ forbiddenMessageAttempts: blockedMessages, events: runEvents }, null, 2); }
window.addEventListener("message", e => {
  if (e.source !== iframe?.contentWindow) return;
  if (typeof e.data?.method === "string" && ["ui/message", "ui/update-model-context", "sampling/createMessage"].includes(e.data.method)) { blockedMessages++; note("forbidden_host_action", e.data.method); }
});
async function boot() {
  const config = await (await fetch("/lab-config")).json(); labToken = config.labToken; waitMs = config.waitMs;
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", location.href), { requestInit: { headers: { Authorization: `Bearer ${labToken}` } } }));
  summary.textContent = "本地诊断就绪。此客户端未声明 elicitation 表单能力。"; start.disabled = false;
}
function controls(disabled: boolean) { start.disabled = fault.disabled = delay.disabled = early.disabled = disabled; replay.disabled = disabled || !lastKey; }
function runError(e: Error) { summary.textContent = `实验失败：${e.message}`; controls(false); }
start.onclick = () => void run(false).catch(runError);
replay.onclick = () => void run(true).catch(runError);
document.getElementById("stop")!.onclick = () => void fetch("/lab-stop", { method: "POST", headers: { Authorization: `Bearer ${labToken}` } }).then(() => { controls(true); summary.textContent = "已请求停止本次本地实验；没有停止现用服务。"; });
async function run(isReplay: boolean) {
  controls(true); await bridge?.close(); iframe?.remove();
  runEvents = []; blockedMessages = 0;
  const requestKey = isReplay ? lastKey! : crypto.randomUUID(); lastKey = requestKey;
  const shown = CallToolResultSchema.parse(await client.callTool({ name: "chat_card_probe_show", arguments: { requestKey } }));
  if (shown.isError) throw new Error(JSON.stringify(shown.content));
  const shownData = shown.structuredContent as Record<string, unknown>;
  const probeId = String(shownData.probeId);
  note("show_returned_before_wait", { probeId, waitStarted: shownData.waitStarted, replayed: shownData.replayed, nextAction: shownData.nextAction });
  let pendingSubmissions = 0, finished = false;
  const save = () => fetch("/lab-observation", { method: "POST", headers: { Authorization: `Bearer ${labToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ scope: "simulated_mcp_apps_host_not_chatgpt", probeId, blockedMessages, faultInjection: fault.checked, delayInjection: delay.checked, events: runEvents }) });
  const tools = (await client.listTools()).tools, tool = tools.find(t => t.name === "chat_card_probe_show")!;
  const uri = (tool._meta!.ui as { resourceUri: string }).resourceUri;
  const resource = (await client.readResource({ uri })).contents[0];
  if (!("text" in resource)) throw new Error("Missing card HTML");
  iframe = document.createElement("iframe"); iframe.title = "隔离卡片诊断"; iframe.setAttribute("sandbox", "allow-scripts"); slot.replaceChildren(iframe);
  bridge = new AppBridge(client, { name: "LOCAL LAB, not hosted ChatGPT", version: "1" }, { serverTools: {} }, { hostContext: { theme: "light", toolInfo: { tool } } });
  let initialized!: () => void;
  const ready = new Promise<void>(r => { initialized = r; });
  bridge.oninitialized = () => { initialized(); };
  await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
  // Constrain this test frame to its exact diagnostic submission. The official
  // SDK handles the protocol; this callback only applies the lab tool allowlist.
  bridge.oncalltool = async (params, extra) => {
    if (!["chat_card_probe_submit", "chat_card_probe_status"].includes(params.name) || params.arguments?.probeId !== probeId) throw new Error("LAB_TOOL_DENIED");
    const submission = params.name === "chat_card_probe_submit";
    if (submission) pendingSubmissions++;
    try {
      if (submission) note("card_click_reached_simulated_host", params.arguments?.clientTiming ?? null);
      if (submission && fault.checked) { note("simulated_submission_failure"); throw { message: "DIAGNOSTIC_TRANSPORT_ERROR：模拟故障，答案未提交。" }; }
      if (submission && delay.checked) { note("simulated_8000ms_submission_queue"); await new Promise(r => setTimeout(r, 8000)); }
      if (extra.signal.aborted) throw new Error("LAB_REQUEST_ABORTED");
      const r = CallToolResultSchema.parse(await client.callTool(params, undefined, { signal: extra.signal }));
      note(submission ? "card_submission_returned" : "card_status_returned", r.structuredContent ?? { error: true }); return r;
    } finally {
      if (submission) { pendingSubmissions--; if (finished) { await save(); controls(false); } }
    }
  };
  iframe.srcdoc = resource.text;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([ready, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("LAB_UI_INITIALIZATION_TIMEOUT")), 10_000); })]); }
  finally { clearTimeout(timer); }
  await bridge.sendToolInput({ arguments: { requestKey } }); await bridge.sendToolResult(shown);
  note("card_result_delivered_to_app"); summary.textContent = `卡片已交付。本地等待上限 ${waitMs / 1000} 秒；这不是网页宿主限制。`;
  if (shownData.nextAction !== "wait_once") {
    note("historical_replay_no_new_wait", shownData); summary.textContent = "历史测试已重放；没有新建测试或再次等待。"; finished = true; await save(); controls(false); return;
  }
  if (early.checked) await new Promise(r => setTimeout(r, 5000));
  note("single_wait_started");
  const waited = CallToolResultSchema.parse(await client.callTool({ name: "chat_card_probe_wait", arguments: { probeId } }, undefined, { timeout: 55_000 }));
  note("single_wait_returned", waited.structuredContent ?? { error: true });
  const data = waited.structuredContent as Record<string, unknown>;
  summary.textContent = ["answer_received", "answer_already_recorded"].includes(String(data?.waitOutcome)) ? "本地等待已收到选择。真实 Chat 原轮继续：未验证。" : `等待结束：${data?.waitOutcome ?? "未开始"}。没有自动补发消息或再次等待。`;
  finished = true; await save(); if (!pendingSubmissions) controls(false);
}
void boot().catch(e => { summary.textContent = `连接失败：${e.message}`; });
