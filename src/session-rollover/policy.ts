import * as z from "zod/v4";

/** Preparatory, side-effect-free policy only. No reservation, scheduler or authority. */
export const rolloverPolicySchema = z.strictObject({
  enabled: z.boolean().default(false),
  mode: z.enum(["automatic", "manual", "recommended"]).default("automatic"),
  recoveryEnabled: z.boolean().default(false),
  maxRolloversPerLogicalSession: z.number().int().min(1).max(100).default(6),
  maxConsecutiveRecoveryFailures: z.number().int().min(1).max(10).default(2),
  minIntervalMinutes: z.number().int().min(1).max(1440).default(15),
  cooldownMinutes: z.number().int().min(1).max(1440).default(30),
  safePointTimeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
  bootstrapTimeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
  takeoverTimeoutMs: z.number().int().min(1000).max(600_000).default(60_000),
});
export type RolloverPolicy = z.infer<typeof rolloverPolicySchema>;
export const timestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const historySchema = z.strictObject({
  // These MUST come from scoped durable records once reliability integration exists.
  rolloverCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  consecutiveRecoveryFailures: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  activeAttempt: z.boolean(),
  lastStartedAtMs: timestampSchema.optional(),
  lastFailureAtMs: timestampSchema.optional(),
});
export type PolicyHistory = z.infer<typeof historySchema>;
const triggerSchema = z.enum(["none", "context_pressure", "confirmed_conversation_failure", "manual"]);
export type RolloverTrigger = z.infer<typeof triggerSchema>;
export type PolicyDecision = {
  status: "eligible" | "disabled" | "not_triggered" | "manual_only" | "recommended_only"
    | "recovery_disabled" | "coalesced" | "limit_reached" | "paused_needs_attention"
    | "cooldown" | "invalid_observation";
  eligible: boolean;
  advisoryOnly: true;
  retryAfterMs?: number;
};

/** An eligible result is NOT permission to open a chat or commit takeover. */
export function evaluateRolloverPolicy(
  rawPolicy: unknown, rawHistory: unknown, rawTrigger: unknown, nowMs: number,
): PolicyDecision {
  const policy = rolloverPolicySchema.parse(rawPolicy);
  const history = historySchema.safeParse(rawHistory);
  const trigger = triggerSchema.safeParse(rawTrigger);
  const answer = (status: PolicyDecision["status"], retryAfterMs?: number): PolicyDecision => ({
    status, eligible: status === "eligible", advisoryOnly: true,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
  if (!policy.enabled) return answer("disabled");
  if (!timestampSchema.safeParse(nowMs).success || !history.success || !trigger.success) {
    return answer("invalid_observation");
  }
  const h = history.data;
  if ([h.lastStartedAtMs, h.lastFailureAtMs].some(at => at !== undefined && at > nowMs)
    || (h.rolloverCount > 0 && h.lastStartedAtMs === undefined)
    || (h.consecutiveRecoveryFailures > 0 && h.lastFailureAtMs === undefined)) {
    return answer("invalid_observation");
  }
  // An unresolved attempt must be reconciled, never replaced by another one.
  if (h.activeAttempt) return answer("coalesced");
  if (h.consecutiveRecoveryFailures >= policy.maxConsecutiveRecoveryFailures) {
    return answer("paused_needs_attention");
  }
  if (h.rolloverCount >= policy.maxRolloversPerLogicalSession) return answer("limit_reached");
  if (trigger.data === "none") return answer("not_triggered");
  if (policy.mode === "recommended") return answer("recommended_only");
  if (policy.mode === "manual" && trigger.data !== "manual") return answer("manual_only");
  if (trigger.data === "confirmed_conversation_failure" && !policy.recoveryEnabled) {
    return answer("recovery_disabled");
  }
  const interval = h.lastStartedAtMs === undefined ? 0
    : policy.minIntervalMinutes * 60_000 - (nowMs - h.lastStartedAtMs);
  const cooldown = h.lastFailureAtMs === undefined ? 0
    : policy.cooldownMinutes * 60_000 - (nowMs - h.lastFailureAtMs);
  const remaining = Math.max(0, interval, cooldown);
  return remaining > 0 ? answer("cooldown", remaining) : answer("eligible");
}
