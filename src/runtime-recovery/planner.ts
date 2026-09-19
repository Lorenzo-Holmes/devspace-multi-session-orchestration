import type { Failure, RestartPolicy, RuntimeSlot, RuntimeSnapshot } from "../runtime-lifecycle/contracts.js";
export interface RecoveryDecision { action: "no_action" | "retry" | "reconnect" | "restart_component" | "restart_runtime" | "blocked" | "wait_user" | "pause"; reason: string; delayMs: number; remainingComponent: number; remainingGlobal: number }
export function planRecovery(s: RuntimeSnapshot, slot: RuntimeSlot, failure: Failure, policy: RestartPolicy, now: number, random = 0.5): RecoveryDecision {
  const remainingComponent = Math.max(0, policy.maxRestartsPerWindow - slot.restarts.filter(t => t > now - policy.windowMs).length);
  const remainingGlobal = Math.max(0, policy.maxGlobalRestartsPerWindow - s.globalRestarts.filter(t => t.at > now - policy.windowMs).length);
  const result = (action: RecoveryDecision["action"], reason: string, delayMs = 0): RecoveryDecision => ({ action, reason, delayMs, remainingComponent, remainingGlobal });
  if (s.control.mode !== "run") return result("no_action", "INTENTIONAL_PAUSE_OR_STOP");
  if (failure === "browser_security" || failure === "authentication") return result("wait_user", "WAITING_FOR_USER_APPROVAL");
  if (failure === "port_conflict") return result("blocked", "BLOCKED_PORT_CONFLICT");
  if (failure === "config_failure") return result("blocked", "BLOCKED_CONFIG");
  if (failure === "resource_exhaustion") return result("blocked", "BLOCKED_RESOURCE_EXHAUSTION");
  if (failure === "identity_uncertain" || failure === "unknown" || failure === "release_changed") return result("blocked", failure.toUpperCase());
  if (!policy.enabled) return result("no_action", "RECOVERY_DISABLED");
  if (now < s.resumeUntil) return result("retry", "RESUME_RECONCILIATION", s.resumeUntil - now);
  if (failure === "network_transient") return result("retry", "NETWORK_TRANSIENT", policy.maxBackoffMs);
  if (failure === "cua_disconnect" || failure === "browser_disconnect") return result("reconnect", "EXTERNAL_RUNTIME_REDISCOVERY", policy.initialBackoffMs);
  if (slot.ownership !== "managed_by_devspace") return result("no_action", "EXTERNAL_COMPONENT");
  if (!remainingComponent || !remainingGlobal) return result("pause", "CRASH_LOOP");
  if (now < slot.notBefore) return result("retry", "BACKOFF", slot.notBefore - now);
  const jitter = 0.75 + Math.min(1, Math.max(0, random)) * 0.5;
  const delayMs = Math.max(policy.pollMs, Math.min(policy.maxBackoffMs, Math.floor(policy.initialBackoffMs * 2 ** Math.min(slot.failures, 16) * jitter)));
  return result(slot.component === "server" ? "restart_runtime" : "restart_component", "APPROVED_COMPONENT_RESTART", delayMs);
}

// Read-only planning from the last committed observation; it does not run probes or reserve budget.
export function planSnapshot(s: RuntimeSnapshot, slot: RuntimeSlot, policy: RestartPolicy): RecoveryDecision {
  const base = planRecovery(s, slot, "process_crash", policy, s.policyTime);
  const decision = (action: RecoveryDecision["action"], reason: string): RecoveryDecision => ({ ...base, action, reason, delayMs: 0 });
  if (s.control.mode !== "run") return decision("no_action", "INTENTIONAL_PAUSE_OR_STOP");
  if (slot.state === "paused_needs_attention") return decision("pause", slot.blockedReason ?? "CRASH_LOOP");
  if (slot.state === "blocked") return decision(slot.blockedReason === "WAITING_FOR_USER_APPROVAL" ? "wait_user" : "blocked", slot.blockedReason ?? "UNKNOWN");
  if (slot.state === "healthy") return decision("no_action", "LAST_OBSERVATION_HEALTHY");
  if (slot.identity || slot.ticket) return decision("retry", "RECONCILE_EXISTING_RUNTIME_FIRST");
  return planRecovery(s, slot, slot.component === "server" ? "process_crash" : "tunnel_failure", policy, s.policyTime);
}
