import { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { cardPresentation, cardSnapshot, cardSnapshotDiagnostic, type CardSnapshot } from "../../src/chat-card-view.js";

const app = new App({ name: "isolated-chat-card-probe", version: "2" }, {}, { autoResize: false });
const status = document.getElementById("status")!, choices = document.getElementById("choices")!;
const identity = document.getElementById("identity")!, timing = document.getElementById("timing")!, syncNote = document.getElementById("sync-note")!;
const choicePrompt = document.getElementById("choice-prompt")!;
let card: { probeId: string; submitToken: string; expiresAt: number } | undefined;
let snapshot: CardSnapshot | undefined, snapshotAt = 0, renderedAt = 0, renderedMono = 0;
let busy = false, attempted = false, synced = false, lockedError = "";
let reads = 0, generation = 0, syncBusy = false, finalSyncScheduled = false;
let syncTimer: ReturnType<typeof setTimeout> | undefined, paintTimer: ReturnType<typeof setInterval> | undefined;
let browserTiming: Record<string, unknown> = {};
const buttons: HTMLButtonElement[] = [];
let receivedInitialResult = false;
const initialResultTimer = setTimeout(() => {
  if (receivedInitialResult) return;
  lockedError = "15 秒内未收到有效工具结果；本次显示未确认。请保留工具错误详情，不重复点击。";
  paint();
}, 15_000);
const pollDelays = [2000, 3000, 5000, 10000]; // At most five start snapshots + one final snapshot.

function errorText(e: unknown) {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e && typeof e.message === "string") return e.message;
  return "卡片通道返回非文本错误；结果未确认。请保留此状态，不反复点击。";
}
function stopQueries() { clearTimeout(syncTimer); }
function paint() {
  const presentation = snapshot && cardPresentation(snapshot, performance.now() - snapshotAt);
  const lifetimeEnded = renderedMono > 0 && performance.now() - renderedMono >= 60_000;
  if (lifetimeEnded) { stopQueries(); clearInterval(paintTimer); }
  status.textContent = lockedError || (busy ? "已点击，正在等待提交回执；请勿重复点击。"
    : !synced ? "正在核对当前测试状态；按钮暂时锁定。"
      : lifetimeEnded && !snapshot?.waitOutcome && snapshot?.state === "pending" ? "本卡片的 60 秒观察窗口已结束；已锁定，不自动重新测试。"
        : presentation?.text ?? "正在连接诊断宿主…");
  status.classList.toggle("error", Boolean(lockedError));
  for (const button of buttons) button.disabled = busy || attempted || !synced || Boolean(lockedError) || lifetimeEnded || !presentation?.canSubmit;
  choicePrompt.textContent = lockedError ? "卡片数据校验失败，当前无法选择。" : !snapshot ? "正在接收本次测试数据，请稍候。" : attempted || snapshot.state !== "pending" || snapshot.waitOutcome ? "本次操作已结束或已提交，无需再次选择。" : "请选择一个测试标记。";
  syncNote.textContent = `界面状态查询 ${reads}/6 次；有界查询不延长原等待，也不发送聊天消息。不能据此承诺免用量。`;
  timing.textContent = JSON.stringify({ serverReceipt: snapshot, browserObservation: browserTiming,
    clockNote: "浏览器时间由客户端自报，只用于诊断；不能跨时钟相减断言网络延迟。界面收到回执不等于网页模型继续。" }, null, 2);
}
function accept(r: CallToolResult, at: number) {
  if (r.isError) throw new Error(r.content.filter(c => c.type === "text").map(c => c.text).join("\n") || "诊断请求失败");
  const next = cardSnapshot(r.structuredContent, card!.probeId);
  // A status request sent before a click may return after its submission receipt.
  if (!snapshot || next.revision > snapshot.revision || (next.revision === snapshot.revision && next.serverNow >= snapshot.serverNow)) {
    snapshot = next; snapshotAt = at;
  }
  synced = true; paint();
}
function scheduleSync(delay: number, final = false) {
  if (final) finalSyncScheduled = true;
  stopQueries(); syncTimer = setTimeout(() => void sync(final), delay);
}
async function sync(final = false) {
  if (!card || reads >= 6 || syncBusy || busy || lockedError || performance.now() - renderedMono >= 60_000) return;
  const current = generation, at = performance.now(); reads++; syncBusy = true; paint();
  try {
    const r = await app.callServerTool({ name: "chat_card_probe_status", arguments: { probeId: card.probeId, submitToken: card.submitToken } }, { timeout: 8000 });
    if (current !== generation) return;
    accept(r, at); browserTiming.lastStatusResponseAt = Date.now();
    if (snapshot!.state !== "pending" || snapshot!.waitOutcome || attempted) return;
    if (snapshot!.waitActive && !finalSyncScheduled) {
      const remaining = cardPresentation(snapshot!, performance.now() - snapshotAt).remainingMs;
      scheduleSync(remaining + (performance.now() - at) + 250, true);
    } else if (!final && !snapshot!.waitActive && reads <= pollDelays.length) scheduleSync(pollDelays[reads - 1]);
  } catch (e) { if (current === generation && !attempted) { lockedError = `${errorText(e)} 状态未确认，已停止自动查询。`; stopQueries(); } }
  finally { if (current === generation) { syncBusy = false; paint(); } }
}
for (const [label, answer] of [["蓝色标记", "BLUE"], ["绿色标记", "GREEN"], ["取消诊断", "CANCEL"]]) {
  const button = document.createElement("button"); button.textContent = label; button.disabled = true;
  button.addEventListener("click", () => void submit(answer)); choices.append(button); buttons.push(button);
}
app.ontoolresult = (r: CallToolResult) => {
  if (r.structuredContent?.diagnosticKind === "readonly_transport_v1") {
    receivedInitialResult = true; clearTimeout(initialResultTimer);
    stopQueries(); clearInterval(paintTimer); choices.replaceChildren();
    const v = r.structuredContent;
    const valid = !r.isError && v.testId === "READONLY-CARD-V1" && v.state === "ok"
      && v.goalCreated === false && v.probeCreated === false && v.nextAction === "stop";
    identity.textContent = valid ? "READONLY-CARD-V1 · 已收到工具结果" : "只读诊断结果校验失败";
    choicePrompt.textContent = "只读显示测试，无需点击。";
    status.textContent = valid ? "工具结果已传入卡片。未创建测试记录或目标。" : "结果字段不符，显示未确认。";
    status.classList.toggle("error", !valid);
    syncNote.textContent = "此卡片不调用任何工具，不发送聊天消息；不代表等待或目标执行已通过。";
    timing.textContent = JSON.stringify({ valid, diagnosticKind: v.diagnosticKind, testId: v.testId }, null, 2);
    return;
  }
  const incoming = r._meta?.probe as typeof card;
  if (!incoming?.probeId || !incoming.submitToken) return;
  receivedInitialResult = true; clearTimeout(initialResultTimer);
  if (card?.probeId === incoming.probeId) return; // Host re-delivery is not a new observation budget.
  generation++; stopQueries(); clearInterval(paintTimer);
  card = incoming; snapshot = undefined; reads = 0; busy = attempted = synced = syncBusy = finalSyncScheduled = false; lockedError = "";
  renderedAt = Date.now(); renderedMono = performance.now(); browserTiming = { renderedAt, initialSnapshotShape: cardSnapshotDiagnostic(r.structuredContent, incoming.probeId) };
  identity.textContent = `${r.structuredContent?.replayed === true ? "重复请求／历史测试" : "本次新测试"} · ${incoming.probeId}`;
  try { snapshot = cardSnapshot(r.structuredContent, incoming.probeId); snapshotAt = performance.now(); }
  catch (e) { lockedError = errorText(e); paint(); return; }
  paintTimer = setInterval(paint, 250); paint(); void sync();
};
async function submit(answer: string) {
  if (!card || !snapshot || busy || attempted || !synced || lockedError || performance.now() - renderedMono >= 60_000 || !cardPresentation(snapshot, performance.now() - snapshotAt).canSubmit) return;
  const current = generation, clickedAt = Date.now(), clickElapsedMs = performance.now() - renderedMono;
  attempted = true; busy = true; stopQueries();
  const clientTiming = { renderedAt, clickedAt, sentAt: Date.now(), clickElapsedMs, sendElapsedMs: performance.now() - renderedMono };
  browserTiming = { ...browserTiming, ...clientTiming }; paint();
  try {
    const at = performance.now();
    const r = await app.callServerTool({ name: "chat_card_probe_submit", arguments: { probeId: card.probeId, submitToken: card.submitToken, answer, clientTiming } }, { timeout: 10_000 });
    if (current !== generation) return;
    browserTiming.responseReceivedAt = Date.now(); browserTiming.responseElapsedMs = performance.now() - renderedMono;
    accept(r, at);
    if (!["answered", "cancelled"].includes(snapshot!.state)) throw new Error("提交回执格式不符，尚未确认成功。");
  } catch (e) { if (current === generation) { lockedError = `${errorText(e)} 提交结果未确认，按钮保持锁定；没有自动重试。`; browserTiming.errorObservedAt = Date.now(); } }
  finally { if (current === generation) { busy = false; paint(); } }
}
window.addEventListener("pagehide", () => { stopQueries(); clearInterval(paintTimer); });
void app.connect().catch(e => { lockedError = errorText(e); paint(); });
