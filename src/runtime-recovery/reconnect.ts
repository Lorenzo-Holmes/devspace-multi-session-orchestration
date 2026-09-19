import { setTimeout as delay } from "node:timers/promises";
export type ReconnectState = "ready" | "degraded" | "recovering" | "waiting_for_user_approval" | "paused_needs_attention" | "closed";
export interface ReconnectHooks { now(): number; sleep(ms: number): Promise<void>; closeTimeoutMs: number; windowMs: number; maxFailures: number; backoffMs: number; maxQueue: number }
export class ReconnectBlocked extends Error {
  constructor(readonly code: string, readonly retryAfterMs = 0) { super(code); }
}
export function reconnectFailure(error: unknown): "transient" | "approval" | "unknown" {
  const code = error && typeof error === "object" ? Reflect.get(error, "code") : undefined;
  // SDK v1 ConnectionClosed is -32000; do not infer disconnect from text.
  if ([-32000, "EPIPE", "ECONNRESET", "ECONNREFUSED", "ENOENT", "ERR_STREAM_DESTROYED"].includes(code)) return "transient";
  if ([-32042, 401, 403, "BROWSER_SECURITY", "APPROVAL_REQUIRED", "AUTHENTICATION_REQUIRED", "MFA_REQUIRED"].includes(code)) return "approval";
  // No inference from arbitrary tool text, browser content, or an error message substring.
  return "unknown";
}
export class BoundedReconnect<T extends { close(): Promise<void> }> {
  private resource?: T;
  private tail: Promise<unknown> = Promise.resolve();
  private pendingClose?: Promise<void>;
  private closeFailed = false;
  private failures: number[] = [];
  private queued = 0;
  private closed = false;
  private approvalPending = false;
  private state: ReconnectState = "ready";
  private generation = 0;
  private notBefore = 0;
  private readonly hooks: ReconnectHooks;
  constructor(private readonly factory: () => T, hooks: Partial<ReconnectHooks> = {}) {
    this.hooks = { now: Date.now, sleep: delay, closeTimeoutMs: 1500, windowMs: 60000, maxFailures: 3, backoffMs: 500, maxQueue: 16, ...hooks };
    for (const k of ["closeTimeoutMs", "windowMs", "maxFailures", "backoffMs", "maxQueue"] as const) {
      if (!Number.isSafeInteger(this.hooks[k]) || this.hooks[k] < 1 || this.hooks[k] > 600000) throw new Error("INVALID_RECONNECT_POLICY");
    }
  }
  noteApproval(pending: boolean): void {
    this.approvalPending = pending;
    if (pending && !this.closed) this.state = "waiting_for_user_approval";
  }
  status(): { state: ReconnectState; generation: number; failureCountWindow: number; retryAfterMs: number; teardownPending: boolean } {
    return { state: this.state, generation: this.generation, failureCountWindow: this.failures.filter(t => t > this.hooks.now() - this.hooks.windowMs).length,
      retryAfterMs: Math.max(0, this.notBefore - this.hooks.now()), teardownPending: !!this.pendingClose || this.closeFailed };
  }
  run<R>(readOnly: boolean, operation: (resource: T) => Promise<R>): Promise<R> {
    if (this.closed) return Promise.reject(new ReconnectBlocked("RECONNECT_CLOSED"));
    if (this.queued >= this.hooks.maxQueue) return Promise.reject(new ReconnectBlocked("RECONNECT_BACKPRESSURE"));
    this.queued++;
    const task = this.tail.then(async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        this.assertAvailable();
        if (!this.resource) { this.resource = this.factory(); this.generation++; }
        try {
          this.approvalPending = false;
          const result = await operation(this.resource); this.state = "ready"; return result;
        } catch (error) {
          const kind = this.approvalPending ? "approval" : reconnectFailure(error);
          this.failures.push(this.hooks.now()); this.failures = this.failures.slice(-this.hooks.maxFailures);
          this.notBefore = this.hooks.now() + this.hooks.backoffMs;
          this.state = kind === "approval" ? "waiting_for_user_approval" : "degraded";
          await this.retire();
          // Mutations are NEVER replayed: their outcome may be unknown even when transport failed.
          // Unknown/security failures are returned without a discovery retry or a desktop workaround.
          if (!readOnly || kind !== "transient" || attempt !== 0) throw error;
          this.state = "recovering"; await this.hooks.sleep(this.hooks.backoffMs);
        }
      }
      throw new ReconnectBlocked("RECONNECT_EXHAUSTED");
    });
    this.tail = task.catch(() => {});
    return task.finally(() => { this.queued--; });
  }
  private assertAvailable(): void {
    if (this.closed) throw new ReconnectBlocked("RECONNECT_CLOSED");
    if (this.pendingClose || this.closeFailed) throw new ReconnectBlocked("RECONNECT_TEARDOWN_UNCERTAIN");
    this.failures = this.failures.filter(t => t > this.hooks.now() - this.hooks.windowMs);
    if (this.failures.length >= this.hooks.maxFailures) { this.state = "paused_needs_attention"; throw new ReconnectBlocked("RECONNECT_BUDGET_EXHAUSTED", this.hooks.windowMs); }
    if (this.hooks.now() < this.notBefore) throw new ReconnectBlocked("RECONNECT_BACKOFF", this.notBefore - this.hooks.now());
  }
  private async retire(): Promise<void> {
    const resource = this.resource; this.resource = undefined;
    if (!resource) return;
    const closing = Promise.resolve().then(() => resource.close());
    const settled = closing.then(() => { this.pendingClose = undefined; }, () => { this.closeFailed = true; this.pendingClose = undefined; });
    this.pendingClose = settled;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([settled, new Promise<void>(resolve => { timer = setTimeout(resolve, this.hooks.closeTimeoutMs); })]);
    if (timer) clearTimeout(timer);
    // An unresolved teardown is fenced. Never spawn a replacement while an old bridge may remain active.
  }
  async close(): Promise<void> {
    this.closed = true; this.state = "closed";
    await this.tail.catch(() => {}); await this.retire();
  }
}
