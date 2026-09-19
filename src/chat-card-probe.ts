import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

export const CARD_PROBE_URI = "ui://devspace/chat-card-probe-v2-2.html";
export const CARD_READONLY_URI = "ui://devspace/chat-card-readonly-v1.html";
export const CARD_READONLY_RESULT = Object.freeze({
  diagnosticKind: "readonly_transport_v1", testId: "READONLY-CARD-V1",
  state: "ok", goalCreated: false, probeCreated: false, nextAction: "stop",
});
export const CARD_PROBE_CHOICES = ["BLUE", "GREEN", "CANCEL"] as const;
type Choice = typeof CARD_PROBE_CHOICES[number];
const clientTimingSchema = z.object({
  renderedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  clickedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sentAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  clickElapsedMs: z.number().nonnegative().max(1_200_000),
  sendElapsedMs: z.number().nonnegative().max(1_200_000),
}).strict().refine(v => v.sendElapsedMs >= v.clickElapsedMs, "Send must follow click on the browser monotonic clock");
type ClientTiming = z.infer<typeof clientTimingSchema>;
type WaitOutcome = "answer_received" | "answer_already_recorded" | "timeout" | "transport_aborted" | "service_closed";
type Probe = {
  id: string; owner: string; key: string; token: string; createdAt: number; expiresAt: number; revision: number;
  answer?: Choice; submittedAt?: number; activeWaitAtSubmission?: boolean;
  receiptPhase?: "before_wait" | "during_wait" | "after_wait"; clientTiming?: ClientTiming;
  firstCardSyncAt?: number; uiStatusReads: number;
  waitStarted: boolean; waitStartedAt?: number; waitDeadlineAt?: number; waitEndedAt?: number;
  waitOutcome?: WaitOutcome; waiter?: (outcome: WaitOutcome) => void;
};

/** Bounded, memory-only diagnostic receipts, not Goal state or an execution engine.
 * Registered only by explicit local diagnostics configuration; never a Goal API. */
export class ChatCardProbe {
  private probes = new Map<string, Probe>();
  private closed = false;
  constructor(private options: { now?: () => number; waitMs?: number; ttlMs?: number; onEvent?: (event: string, data: Record<string, unknown>) => void } = {}) {
    if (!Number.isFinite(options.waitMs ?? 45_000) || (options.waitMs ?? 45_000) > 50_000 || (options.waitMs ?? 45_000) < 1) throw new Error("INVALID_WAIT_LIMIT");
    if (!Number.isFinite(options.ttlMs ?? 600_000) || (options.ttlMs ?? 600_000) < 1 || (options.ttlMs ?? 600_000) > 600_000) throw new Error("INVALID_TTL_LIMIT");
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private assertOpen() { if (this.closed) throw new Error("PROBE_SERVICE_CLOSED: this diagnostic service has stopped."); }
  private owned(owner: string, id: string) {
    this.assertOpen();
    const p = this.probes.get(id);
    if (!p || p.owner !== owner) throw new Error("PROBE_NOT_FOUND: no probe for this verified owner.");
    return p;
  }
  private view(p: Probe) {
    // Timer dispatch can be delayed. The server deadline, not the presence of
    // a callback in the event queue, decides whether an answer reached a wait.
    if (p.waiter && this.now() >= p.waitDeadlineAt!) p.waiter("timeout");
    return {
      probeId: p.id, diagnosticVersion: 2, diagnosticOnly: true, goalCreated: false,
      revision: p.revision, serverNow: this.now(), createdAt: p.createdAt,
      state: p.answer ? (p.answer === "CANCEL" ? "cancelled" : "answered") : this.now() >= p.expiresAt ? "expired" : "pending",
      expiresAt: p.expiresAt, answer: p.answer ?? null, submittedAt: p.submittedAt ?? null,
      activeWaitAtSubmission: p.activeWaitAtSubmission ?? null,
      waitStarted: p.waitStarted, waitActive: Boolean(p.waiter), waitOutcome: p.waitOutcome ?? null,
      waitStartedAt: p.waitStartedAt ?? null, waitDeadlineAt: p.waitDeadlineAt ?? null, waitEndedAt: p.waitEndedAt ?? null,
      nextAction: p.waiter ? "wait_already_active" : !p.waitStarted && !p.answer && this.now() < p.expiresAt ? "wait_once" : "read_history_only",
      receiptPhase: p.receiptPhase ?? null, firstCardSyncAt: p.firstCardSyncAt ?? null, uiStatusReads: p.uiStatusReads,
      clientTiming: p.clientTiming ? { ...p.clientTiming } : null, clientTimingTrust: "untrusted_browser_report",
      sameTurnContinuation: "unverified", chatUsageAccounting: "unknown_host_controlled",
      additionalModelCalls: 0, followUpMessagesSent: 0,
    };
  }
  private emit(event: string, p: Probe) {
    // Whitelisted view never includes OAuth credentials, owner, requestKey or
    // the app token. Observability must not decide whether a receipt succeeds.
    try { this.options.onEvent?.(event, this.view(p)); } catch { /* diagnostic logging only */ }
  }
  private authenticated(owner: string, id: string, token: string) {
    const p = this.owned(owner, id), supplied = Buffer.from(token), expected = Buffer.from(p.token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("INVALID_CARD_TOKEN: use this probe's own app card.");
    return p;
  }
  create(owner: string, key: string): CallToolResult {
    this.assertOpen();
    let p = [...this.probes.values()].find(p => p.owner === owner && p.key === key);
    const replayed = Boolean(p);
    if (!p) {
      if (this.probes.size >= 32) throw new Error("PROBE_LIMIT: restart only this isolated diagnostic service to clear receipts.");
      const createdAt = this.now();
      p = { id: randomUUID(), owner, key, token: randomBytes(32).toString("hex"), createdAt, expiresAt: createdAt + (this.options.ttlMs ?? 600_000), revision: 1, uiStatusReads: 0, waitStarted: false };
      this.probes.set(p.id, p);
    }
    const data = this.view(p);
    this.emit(replayed ? "show_replayed" : "created", p);
    const instruction = data.nextAction === "wait_once"
      ? "Next call chat_card_probe_wait exactly once with probeId, without sending a final answer or another Chat message first."
      : data.nextAction === "wait_already_active" ? "An existing wait is active. Do not start a second wait."
        : "HISTORICAL RESULT ONLY: this requestKey was already used or expired. Do not call wait again or automatically create a new test.";
    return {
      content: [{ type: "text", text: `DIAGNOSTIC ONLY. ${replayed ? "Idempotent replay, not a newly created test. " : "New test. "}${instruction} Do not answer for the user. A tool receipt does not prove the original Chat turn continued. No Goal, files, commands or permissions are involved.` }],
      structuredContent: { ...data, replayed },
      // Host must keep tool result _meta out of model context. The app-only tool
      // and unpredictable token do NOT grant filesystem, process or Goal rights.
      _meta: { probe: { probeId: p.id, submitToken: p.token, expiresAt: p.expiresAt, choices: CARD_PROBE_CHOICES } },
    };
  }
  async wait(owner: string, id: string, signal?: AbortSignal) {
    const p = this.owned(owner, id);
    this.view(p);
    if (p.waiter) throw new Error("WAIT_IN_PROGRESS: a bounded wait already owns this probe.");
    if (this.now() >= p.expiresAt || p.waitStarted) return this.view(p);
    if (signal?.aborted) throw new Error("WAIT_ABORTED: no new wait was started.");
    p.waitStarted = true; p.waitStartedAt = this.now(); p.revision++;
    if (p.answer) {
      p.waitOutcome = "answer_already_recorded"; p.waitEndedAt = this.now();
      this.emit("wait_read_early_answer", p); return this.view(p);
    }
    p.waitDeadlineAt = Math.min(p.waitStartedAt + (this.options.waitMs ?? 45_000), p.expiresAt);
    await new Promise<void>(resolve => {
      const finish = (outcome: WaitOutcome) => {
        if (!p.waiter) return;
        clearTimeout(timer); signal?.removeEventListener("abort", aborted);
        delete p.waiter; p.waitOutcome = outcome; p.waitEndedAt = this.now(); p.revision++;
        this.emit("wait_ended", p); resolve();
      };
      const aborted = () => finish("transport_aborted");
      const timer = setTimeout(() => finish("timeout"), Math.max(0, p.waitDeadlineAt! - this.now()));
      p.waiter = finish;
      signal?.addEventListener("abort", aborted, { once: true });
      this.emit("wait_started", p);
    });
    return this.view(p);
  }
  status(owner: string, id: string, token: string) {
    const p = this.authenticated(owner, id, token);
    if (p.uiStatusReads >= 32) throw new Error("STATUS_READ_LIMIT: stop automatic UI queries; no wait was extended.");
    p.uiStatusReads++;
    if (p.firstCardSyncAt === undefined) { p.firstCardSyncAt = this.now(); this.emit("first_card_sync", p); }
    return this.view(p);
  }
  submit(owner: string, id: string, token: string, answer: Choice, timing?: ClientTiming) {
    const p = this.authenticated(owner, id, token);
    const clientTiming = timing === undefined ? undefined : clientTimingSchema.parse(timing);
    if (!CARD_PROBE_CHOICES.includes(answer)) throw new Error("INVALID_CHOICE");
    this.view(p);
    if (this.now() >= p.expiresAt) throw new Error("PROBE_EXPIRED: no new answer was accepted.");
    if (p.answer) {
      if (p.answer !== answer) throw new Error("ANSWER_ALREADY_RECORDED: cannot replace a previous choice.");
      return { ...this.view(p), replayed: true };
    }
    const receivedAt = this.now();
    if (p.waiter && receivedAt >= p.waitDeadlineAt!) p.waiter("timeout");
    p.answer = answer; p.submittedAt = receivedAt; p.activeWaitAtSubmission = Boolean(p.waiter);
    p.receiptPhase = p.waiter ? "during_wait" : p.waitStarted ? "after_wait" : "before_wait";
    p.clientTiming = clientTiming; p.revision++;
    this.emit("answer_received_at_server", p);
    p.waiter?.("answer_received");
    return { ...this.view(p), replayed: false };
  }
  snapshot() { return [...this.probes.values()].map(p => this.view(p)); }
  close() {
    if (this.closed) return;
    this.closed = true;
    // Finish pending test waits without selecting a business answer.
    for (const p of this.probes.values()) p.waiter?.("service_closed");
  }
}

function owner(auth: unknown) {
  const a = auth as { clientId?: string; extra?: Record<string, unknown> } | undefined;
  if (!a?.clientId || typeof a.extra?.devspaceOwnerRef !== "string") throw new Error("AUTHENTICATION_REQUIRED: verified owner required.");
  return a.extra.devspaceOwnerRef;
}
const result = (data: Record<string, unknown>): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
const failure = (e: unknown): CallToolResult => ({ isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : "PROBE_FAILED" }] });
const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const outputSchema = {
  probeId: z.string().uuid(), diagnosticVersion: z.literal(2), diagnosticOnly: z.literal(true), goalCreated: z.literal(false),
  revision: z.number().int(), serverNow: z.number().int(), createdAt: z.number().int(),
  state: z.enum(["pending", "answered", "cancelled", "expired"]), expiresAt: z.number().int(),
  answer: z.enum(CARD_PROBE_CHOICES).nullable(), submittedAt: z.number().int().nullable(),
  activeWaitAtSubmission: z.boolean().nullable(), waitStarted: z.boolean(), waitActive: z.boolean(),
  waitOutcome: z.enum(["answer_received", "answer_already_recorded", "timeout", "transport_aborted", "service_closed"]).nullable(),
  waitStartedAt: z.number().int().nullable(), waitDeadlineAt: z.number().int().nullable(), waitEndedAt: z.number().int().nullable(),
  nextAction: z.enum(["wait_once", "wait_already_active", "read_history_only"]),
  receiptPhase: z.enum(["before_wait", "during_wait", "after_wait"]).nullable(),
  firstCardSyncAt: z.number().int().nullable(), uiStatusReads: z.number().int(),
  clientTiming: clientTimingSchema.nullable(), clientTimingTrust: z.literal("untrusted_browser_report"),
  sameTurnContinuation: z.literal("unverified"), chatUsageAccounting: z.literal("unknown_host_controlled"),
  additionalModelCalls: z.literal(0), followUpMessagesSent: z.literal(0), replayed: z.boolean().optional(),
};

export function registerChatCardProbe(server: McpServer, probe: ChatCardProbe, cardHtml: string, scope = "devspace") {
  const securitySchemes = [{ type: "oauth2", scopes: [scope] }];
  // Independent read-only controls. Never create a probe, token, waiter, or Goal.
  // They retain the same authentication boundary as the existing diagnostics.
  const readonlySchema = {
    diagnosticKind: z.literal("readonly_transport_v1"), testId: z.literal("READONLY-CARD-V1"),
    state: z.literal("ok"), goalCreated: z.literal(false), probeCreated: z.literal(false), nextAction: z.literal("stop"),
  };
  const readonlyHandler = async (_args: unknown, extra: { authInfo?: unknown }) => {
    try { owner(extra.authInfo); return result({ ...CARD_READONLY_RESULT }); } catch (e) { return failure(e); }
  };
  registerAppResource(server, "Read-only Chat card diagnostic", CARD_READONLY_URI, {
    description: "Read-only diagnostic display. No choices, probe, token or execution.",
    _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
  }, async (uri, extra) => {
    owner(extra.authInfo);
    return { contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: cardHtml,
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } } }] };
  });
  registerAppTool(server, "chat_card_probe_view", {
    title: "View a read-only diagnostic card",
    description: "Read-only transport and display diagnostic. Returns a fixed test marker. Creates no probe, Goal, token or wait. Do not call wait after this result. This does not test or grant approval, execution, or model continuation.",
    inputSchema: {}, outputSchema: readonlySchema, annotations: { ...annotations, readOnlyHint: true },
    _meta: { securitySchemes, ui: { resourceUri: CARD_READONLY_URI, visibility: ["model", "app"] } },
  }, readonlyHandler);
  server.registerTool("diagnostic_ping", {
    title: "Read a fixed diagnostic marker without UI",
    description: "Read-only transport control. Returns the same fixed marker as chat_card_probe_view without rendering UI or creating any state. Report the result and stop.",
    inputSchema: {}, outputSchema: readonlySchema, annotations: { ...annotations, readOnlyHint: true },
    _meta: { securitySchemes },
  }, readonlyHandler);
  registerAppResource(server, "Chat card diagnostic", CARD_PROBE_URI, {
    description: "Authenticated diagnostic card; no workspace, Goal or permission effects.",
    _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
  }, async (uri, extra) => {
    owner(extra.authInfo);
    return { contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: cardHtml, _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } } }] };
  });
  registerAppTool(server, "chat_card_probe_show", {
    title: "Show an isolated Chat card diagnostic",
    description: "Diagnostic only; no Goal or execution. For a NEW user-requested test generate a fresh UUID requestKey. Reuse a key only to safely retry the SAME uncertain call; it returns the old probe, never a fresh test. Follow nextAction: wait_once means call wait once during the same still-active host request; read_history_only means report history and stop. Never send a follow-up message or answer for the user.",
    inputSchema: { requestKey: z.string().min(1).max(80) }, outputSchema, annotations,
    _meta: { securitySchemes, ui: { resourceUri: CARD_PROBE_URI, visibility: ["model", "app"] } },
  }, async (args, extra) => { try { return probe.create(owner(extra.authInfo), args.requestKey); } catch (e) { return failure(e); } });
  server.registerTool("chat_card_probe_wait", {
    title: "Wait once for the already-visible diagnostic card",
    description: "Call once after show returned nextAction=wait_once. Wait up to 45 seconds, or return a choice recorded before wait. The tool returning a card does not prove that the host has rendered it. This is not a heartbeat or model-resume API. On timeout/abort, report the boundary and stop; never poll, repeat a completed wait, or send another Chat message.",
    inputSchema: { probeId: z.string().uuid() }, outputSchema, annotations: { ...annotations, idempotentHint: false },
    _meta: { securitySchemes },
  }, async (args, extra) => { try { return result(await probe.wait(owner(extra.authInfo), args.probeId, extra.signal)); } catch (e) { return failure(e); } });
  registerAppTool(server, "chat_card_probe_status", {
    title: "Read diagnostic card lifecycle",
    description: "App-only bounded status lookup, never a wait, model call, or resume. Requires this card's token; does not extend any deadline. At most 32 lookups per probe.",
    inputSchema: { probeId: z.string().uuid(), submitToken: z.string().length(64) }, outputSchema,
    annotations: { ...annotations, readOnlyHint: true },
    // App-only data tools must not associate/re-render the display template.
    _meta: { securitySchemes, ui: { visibility: ["app"] } },
  }, async (args, extra) => { try { return result(probe.status(owner(extra.authInfo), args.probeId, args.submitToken)); } catch (e) { return failure(e); } });
  registerAppTool(server, "chat_card_probe_submit", {
    title: "Submit a diagnostic card choice",
    description: "App-only diagnostic receipt. Requires the secret sent solely to the card. Never use this for permissions or Goal decisions.",
    inputSchema: { probeId: z.string().uuid(), submitToken: z.string().length(64), answer: z.enum(CARD_PROBE_CHOICES), clientTiming: clientTimingSchema.optional() }, outputSchema, annotations,
    _meta: { securitySchemes, ui: { visibility: ["app"] } },
  }, async (args, extra) => { try { return result(probe.submit(owner(extra.authInfo), args.probeId, args.submitToken, args.answer, args.clientTiming)); } catch (e) { return failure(e); } });
}
