import * as z from "zod/v4";
import { timestampSchema } from "./policy.js";

const sourceSchema = z.strictObject({
  kind: z.enum(["host", "server", "browser"]),
  reference: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}(?![\s\S])/),
});
const signalSchema = z.strictObject({
  kind: z.enum(["conversation_age_ms", "turn_count", "tool_call_count", "tool_output_bytes", "host_context_length_error"]),
  value: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  observedAtMs: timestampSchema,
  source: sourceSchema,
}).superRefine((signal, ctx) => {
  if (signal.kind === "host_context_length_error"
    && (signal.source.kind !== "host" || signal.value !== 1)) {
    ctx.addIssue({ code: "custom", message: "Context-length errors require an explicit host observation with value 1." });
  }
});
export type ContextSignal = z.infer<typeof signalSchema>;
export type ContextPressure = {
  level: "low" | "moderate" | "high" | "rollover_recommended" | "critical" | "unknown";
  confidence: "none" | "low" | "moderate" | "high";
  signals: ContextSignal[];
  discardedSignalCount: number;
  reason: string;
};

/** Observations must be collected for ONE current project/session/epoch by the caller.
 * These are heuristic workload signals, never actual context-window percentages.
 */
export function detectContextPressure(rawSignals: unknown, nowMs: number, maxAgeMs = 300_000): ContextPressure {
  timestampSchema.parse(nowMs);
  z.number().int().min(1).max(3_600_000).parse(maxAgeMs);
  const parsed = z.array(signalSchema).max(64).parse(rawSignals);
  const latest = new Map<ContextSignal["kind"], ContextSignal>();
  for (const signal of parsed) {
    if (signal.observedAtMs > nowMs || nowMs - signal.observedAtMs > maxAgeMs) continue;
    const previous = latest.get(signal.kind);
    // A contradictory simultaneous observation cannot amplify pressure; use the lower value.
    if (!previous || previous.observedAtMs < signal.observedAtMs
      || (previous.observedAtMs === signal.observedAtMs && previous.value > signal.value)) {
      latest.set(signal.kind, signal);
    }
  }
  const signals = [...latest.values()].sort((a, b) => a.kind.localeCompare(b.kind));
  const base = { signals, discardedSignalCount: parsed.length - signals.length };
  if (!signals.length) return { ...base, level: "unknown", confidence: "none", reason: "no_fresh_observation" };
  if (latest.has("host_context_length_error")) {
    return { ...base, level: "critical", confidence: "high", reason: "explicit_host_context_length_error" };
  }
  const value = (kind: ContextSignal["kind"]) => latest.get(kind)?.value ?? 0;
  const high = [value("turn_count") >= 120, value("tool_call_count") >= 400,
    value("tool_output_bytes") >= 2 * 1024 * 1024].filter(Boolean).length;
  if (high >= 2) return { ...base, level: "rollover_recommended", confidence: "moderate", reason: "corroborating_volume_signals" };
  if (high === 1) return { ...base, level: "high", confidence: "low", reason: "single_volume_signal" };
  const moderate = value("turn_count") >= 60 || value("tool_call_count") >= 200
    || value("tool_output_bytes") >= 1024 * 1024 || value("conversation_age_ms") >= 2 * 60 * 60_000;
  return { ...base, level: moderate ? "moderate" : "low", confidence: "low",
    reason: moderate ? "heuristic_workload" : "low_observed_workload" };
}

export type ErrorClassification = {
  category: "context_pressure" | "host_transient" | "network_transient" | "browser_security"
    | "authentication" | "permission" | "unknown";
  action: "rollover_candidate" | "retry_existing" | "waiting_user_approval" | "observe";
};
const errorSchema = z.strictObject({
  source: z.enum(["host", "browser", "network", "unknown"]),
  code: z.string().min(1).max(100).optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
});

/** Accept structured adapter codes, NEVER classify by searching untrusted logs/messages. */
export function classifyContinuationError(raw: unknown): ErrorClassification {
  const result = errorSchema.safeParse(raw);
  if (!result.success) return { category: "unknown", action: "observe" };
  const { source, httpStatus } = result.data;
  const code = result.data.code?.toLowerCase();
  if (["security_check_unavailable", "auto_review_failure", "security_denied", "browser_security_temporary_failure"].includes(code ?? "")) {
    return { category: "browser_security", action: "waiting_user_approval" };
  }
  if (httpStatus === 401 || ["login_required", "mfa_required", "oauth_consent_required", "security_key_required",
    "totp_required", "email_verification_required"].includes(code ?? "")) {
    return { category: "authentication", action: "waiting_user_approval" };
  }
  if (httpStatus === 403 || ["origin_permission_required", "computer_use_approval_required", "host_consent_required"].includes(code ?? "")) {
    return { category: "permission", action: "waiting_user_approval" };
  }
  if (["econnreset", "etimedout", "enotfound", "ws_disconnect"].includes(code ?? "")) {
    return { category: "network_transient", action: "retry_existing" };
  }
  if ((httpStatus !== undefined && (httpStatus >= 500 || [408, 429].includes(httpStatus)))
    || code === "temporary_browser_error") return { category: "host_transient", action: "retry_existing" };
  if (source === "host" && ["context_length_exceeded", "context_window_exceeded"].includes(code ?? "")) {
    return { category: "context_pressure", action: "rollover_candidate" };
  }
  return { category: "unknown", action: "observe" };
}
