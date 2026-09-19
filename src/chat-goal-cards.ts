import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ChatGoalController, type ChatGoalContext } from "./chat-goal-controller.js";
import type { ChatReply } from "./chat-goal-store.js";

export const CHAT_GOAL_CARD_URI = "ui://devspace/chat-goal-decision-v1.html";
type Outcome = "answer_received" | "answer_already_recorded" | "channel_ready" | "timeout" | "transport_aborted" | "service_closed" | "superseded" | "decision_closed";
type Card = {
  id: string; identity: string; key: string; token: string; kind: "connection" | "decision";
  expiresAt: number; acknowledged: boolean; ctx?: ChatGoalContext; goalRef?: string; decisionId?: string;
  question: string; choices: string[]; revision: number;
  waitStarted: boolean; deadline?: number; outcome?: Outcome; finish?: (outcome: Outcome) => void;
  statusReads?: number;
  answer?: string; action?: "accept" | "cancel"; receiptPhase?: "before_wait" | "during_wait";
  submitting?: Promise<Record<string, unknown>>;
};
const data = (reply: ChatReply) => { if (!reply.ok) throw new Error(reply.error!.message); return reply.data!; };

/** Short-lived presentation mechanics only. Decisions remain in the existing
 * controller journal; tasks remain in original Shrimp. No execution/model loop.
 * Receipts are tied to verified OAuth owner+client, not untrusted host metadata.
 * Chat creates separate MCP sessions for tool and UI calls, so a transport
 * session ID cannot be used as the identity or as proof of a live model turn. */
export class ChatGoalCards {
  private records = new Map<string, Card>();
  private closed = false;
  private operations = new Set<Promise<unknown>>();
  constructor(private controller: ChatGoalController, private options: {
    now?: () => number; waitMs?: number; onEvent?: (event: string, value: Record<string, unknown>) => void;
  } = {}) {
    if (!Number.isFinite(options.waitMs ?? 45_000) || (options.waitMs ?? 45_000) < 1 || (options.waitMs ?? 45_000) > 45_000) throw new Error("INVALID_WAIT_LIMIT");
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private owned(identity: string, id: string) {
    if (this.closed) throw new Error("CARD_SERVICE_CLOSED: reconnect after the service is available.");
    const card = this.records.get(id);
    if (!card || card.identity !== identity) throw new Error("CARD_NOT_FOUND: no card for this authenticated client; do not repeat effects.");
    return card;
  }
  private authenticated(identity: string, id: string, token: string) {
    const card = this.owned(identity, id), actual = Buffer.from(token), expected = Buffer.from(card.token);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("INVALID_CARD_TOKEN: use the original app-only card.");
    return card;
  }
  private emit(event: string, c: Card) {
    try { this.options.onEvent?.(event, { cardId: c.id, kind: c.kind, goalRef: c.goalRef ?? null, decisionId: c.decisionId ?? null,
      serverNow: this.now(), revision: c.revision, waitOutcome: c.outcome ?? null, receiptPhase: c.receiptPhase ?? null }); } catch { /* Logging cannot authorize or reject a decision. */ }
  }
  private settle(c: Card, outcome: Outcome) {
    if (c.finish) c.finish(outcome);
    else if (!c.outcome) { c.outcome = outcome; c.revision++; this.emit("closed", c); }
  }
  private tick(c: Card) {
    if (c.finish && this.now() >= c.deadline!) this.settle(c, "timeout");
  }
  private view(c: Card): Record<string, unknown> {
    this.tick(c);
    const expired = this.now() >= c.expiresAt;
    const canSubmit = c.kind === "decision" && !expired && !c.outcome && !c.action && !c.submitting;
    return { cardId: c.id, kind: c.kind, revision: c.revision, serverNow: this.now(), expiresAt: c.expiresAt,
      goalRef: c.goalRef ?? null, decisionId: c.decisionId ?? null, question: c.question, choices: c.choices,
      acknowledged: c.acknowledged, canSubmit, waitStarted: c.waitStarted, waitActive: Boolean(c.finish),
      waitDeadlineAt: c.deadline ?? null, waitOutcome: c.outcome ?? null, answer: c.receiptPhase ? c.answer ?? null : null,
      activeWaitAtSubmission: c.receiptPhase ? c.receiptPhase === "during_wait" : null, receiptPhase: c.receiptPhase ?? null,
      state: expired ? "expired" : c.receiptPhase ? "answered" : c.outcome ? "closed" : "pending",
      nextAction: c.kind === "connection" && c.acknowledged && !expired ? "use_card_channel"
        : c.action === "accept" && ["answer_received","answer_already_recorded"].includes(c.outcome??"") ? "read_goal_status_then_continue_if_ready"
        : c.outcome || expired ? "read_status_then_stop" : c.finish ? "wait_already_active" : "wait_once",
      sameTurnContinuation: "unverified", chatUsageAccounting: "unknown_host_controlled", additionalModelCalls: 0, followUpMessagesSent: 0 };
  }
  private result(c: Card): CallToolResult {
    return { content: [{ type: "text", text: "Use the returned nextAction. Wait once while this host request is active. Do not answer for the user, repeat an ended wait, or send a follow-up message. This card grants no filesystem/process permissions." }],
      structuredContent: { ok: true, data: this.view(c) },
      _meta: { goalCard: { cardId: c.id, submitToken: c.token, kind: c.kind } } };
  }
  private add(c: Card) {
    for (const [id, old] of this.records) if (this.now() >= old.expiresAt && !old.finish && !old.submitting) this.records.delete(id);
    if (this.records.size >= 128) throw new Error("CARD_LIMIT: wait for expired presentations to clear; do not automatically restart services.");
    this.records.set(c.id, c); this.emit("created", c); return this.result(c);
  }
  connect(identity: string, requestKey: string) {
    if (this.closed) throw new Error("CARD_SERVICE_CLOSED");
    const old = [...this.records.values()].find(c => c.identity === identity && c.kind === "connection" && c.key === requestKey);
    if (old) return this.result(old);
    if (this.closed) throw new Error("CARD_SERVICE_CLOSED");
    return this.add({ id: randomUUID(), identity, key: requestKey, token: randomBytes(32).toString("hex"), kind: "connection",
      expiresAt: this.now() + 15 * 60_000, acknowledged: false, question: "正在核对卡片返回通道，无需点击。", choices: [], revision: 1, waitStarted: false });
  }
  verified(identity: string, id?: string): boolean {
    if (!id || this.closed) return false;
    const c = this.records.get(id);
    return Boolean(c && c.identity === identity && c.kind === "connection" && c.acknowledged && this.now() < c.expiresAt && c.outcome === "channel_ready");
  }
  async show(ctx: ChatGoalContext, identity: string, goalRef: string, key: string) {
    const state = data(await this.controller.status(ctx, goalRef));
    const d = state.decision as { id: string; state: string; question: string; choices: string[]; expiresAt: number } | null;
    if (state.state !== "waiting_for_user" || d?.state !== "pending" || d.expiresAt <= this.now()) throw new Error("PENDING_DECISION_REQUIRED: inspect status; no question was created or reopened.");
    const old = [...this.records.values()].find(c => c.identity === identity && c.kind === "decision" && c.key === key);
    if (old) {
      if (old.goalRef !== goalRef || old.decisionId !== d.id) throw new Error("REQUEST_KEY_CONFLICT: presentation key belongs to another decision.");
      return this.result(old);
    }
    for (const c of this.records.values()) if (c.goalRef === goalRef && c.decisionId === d.id) {
      if (c.submitting) throw new Error("DECISION_SUBMITTING: inspect the pending submission; do not replace it.");
      this.settle(c, "superseded");
    }
    return this.add({ id: randomUUID(), identity, key, token: randomBytes(32).toString("hex"), kind: "decision",
      expiresAt: d.expiresAt, acknowledged: false, ctx, goalRef, decisionId: d.id, question: d.question, choices: d.choices,
      revision: 1, waitStarted: false });
  }
  private async current(c: Card) {
    if (!c.ctx) return undefined;
    const state = data(await this.controller.status(c.ctx, c.goalRef));
    const d = state.decision as { id: string; state: string } | null;
    if ((state.state !== "waiting_for_user" || d?.id !== c.decisionId || d?.state !== "pending") && !c.action) this.settle(c, "decision_closed");
    return state;
  }
  async status(identity: string, id: string, token: string):Promise<Record<string,unknown>> {
    const c = this.authenticated(identity, id, token);
    if((c.statusReads??0)>=32)throw new Error("CARD_STATUS_LIMIT: stop automatic reads; no deadline was extended.");
    c.statusReads=(c.statusReads??0)+1;
    const goal = await this.current(c); this.tick(c);
    if (!c.acknowledged && !c.outcome && this.now() < c.expiresAt) {
      c.acknowledged = true; c.revision++; this.emit("card_received", c);
      if (c.kind === "connection") this.settle(c, "channel_ready");
    }
    return { ...this.view(c), ...(goal ? { goal } : {}) };
  }
  async wait(identity: string, id: string, signal?: AbortSignal):Promise<Record<string,unknown>> {
    const c = this.owned(identity, id);
    await this.current(c); this.tick(c);
    if (c.finish) throw new Error("WAIT_IN_PROGRESS: do not open another wait.");
    if (c.outcome || c.waitStarted || this.now() >= c.expiresAt) return { ...this.view(c), ...(c.ctx ? { goal: await this.current(c) } : {}) };
    if (signal?.aborted) throw new Error("WAIT_ABORTED: no wait was started.");
    c.waitStarted = true; c.deadline = Math.min(this.now() + (this.options.waitMs ?? 45_000), c.expiresAt); c.revision++;
    await new Promise<void>(resolve => {
      const finish = (outcome: Outcome) => {
        if (!c.finish) return;
        clearTimeout(timer); signal?.removeEventListener("abort", aborted);
        delete c.finish; c.outcome = outcome; c.revision++; this.emit("wait_ended", c); resolve();
      };
      const aborted = () => finish("transport_aborted");
      const timer = setTimeout(() => finish("timeout"), Math.max(0, c.deadline! - this.now()));
      c.finish = finish; signal?.addEventListener("abort", aborted, { once: true }); this.emit("wait_started", c);
    });
    // A response after timeout must not command automatic task continuation,
    // even if another explicitly requested presentation later gets an answer.
    return { ...this.view(c), ...(c.ctx ? { goal: await this.current(c) } : {}) };
  }
  async submit(identity: string, id: string, token: string, action: "accept" | "cancel", answer?: string):Promise<Record<string,unknown>> {
    const c = this.authenticated(identity, id, token);
    if (c.kind !== "decision") throw new Error("NOT_A_DECISION: connection cards grant no business choice.");
    if (action === "accept" ? !answer || !c.choices.includes(answer) : answer !== undefined) throw new Error("INVALID_DECISION: select a displayed choice or cancel.");
    if (c.action && (c.action !== action || c.answer !== answer)) throw new Error("ANSWER_ALREADY_RECORDED");
    if (c.submitting) return c.submitting;
    if (c.action) { await this.current(c); return { ...this.view(c), replayed: true }; }
    await this.current(c); this.tick(c);
    // Another submission may have acquired this card during the status read.
    if (c.action) {
      if (c.action !== action || c.answer !== answer) throw new Error("ANSWER_ALREADY_RECORDED");
      return c.submitting ?? { ...this.view(c), replayed: true };
    }
    if (this.now() >= c.expiresAt || c.outcome) throw new Error("CARD_WAIT_ENDED: this card cannot accept a late answer. The pending decision must be explicitly re-presented in a new user request.");
    // Set the in-flight flag before asynchronous authorization/persistence. A
    // second submission cannot replace a first choice while it is committing.
    c.action = action; c.answer = answer;
    const phase = c.finish ? "during_wait" : "before_wait";
    const operation = (async () => {
      const submissionContext={...c.ctx!,authorize:async()=>{
        await c.ctx!.authorize();this.tick(c);
        if(this.closed||c.outcome||this.now()>=c.expiresAt)throw new Error("CARD_WAIT_ENDED: submission was not committed before the current authorization/deadline check.");
      }};
      const reply = await this.controller.resolveDecision(submissionContext, c.goalRef!, c.decisionId!, { action, answer });
      if (!reply.ok) { delete c.action; delete c.answer; this.settle(c, "decision_closed"); throw new Error(reply.error!.message); }
      c.receiptPhase = phase; c.revision++; this.emit("answer_committed", c);
      this.settle(c, phase === "during_wait" ? "answer_received" : "answer_already_recorded");
      return { ...this.view(c), goal: reply.data, replayed: false };
    })();
    c.submitting = operation; this.operations.add(operation);
    try { return await operation; } finally { delete c.submitting; this.operations.delete(operation); }
  }
  async close() {
    this.closed = true;
    for (const c of this.records.values()) if (c.finish) this.settle(c, "service_closed");
    await Promise.allSettled(this.operations);
  }
}
