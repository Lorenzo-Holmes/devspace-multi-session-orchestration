import { createHash } from "node:crypto";

export const lifecycleStates = ["starting", "healthy", "degraded", "recovering", "stopping", "stopped", "crashed", "blocked", "paused_needs_attention"] as const;
export type LifecycleState = typeof lifecycleStates[number];
export type Component = "server" | "tunnel";
export type Ownership = "managed_by_devspace" | "external";
export type Failure = "process_crash" | "startup_failure" | "port_conflict" | "network_transient" | "tunnel_failure" | "cua_disconnect" | "browser_disconnect" | "browser_security" | "authentication" | "config_failure" | "resource_exhaustion" | "identity_uncertain" | "release_changed" | "unknown";
export type IdentityState = "active" | "absent" | "reused" | "uncertain";
export interface ProcessIdentity { pid: number; processStartTime: string; executable: string }
export interface RuntimeIdentity extends ProcessIdentity {
  runtimeId: string; generation: number; entrypoint: string; buildId: string;
  serverVersion: string; rootId: string; createdAt: number;
}
export type ProcessObservation = { kind: "observed"; identity: ProcessIdentity } | { kind: "absent" | "uncertain" };
export function sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && a.processStartTime === b.processStartTime && a.executable === b.executable;
}
export function identityState(expected: ProcessIdentity, observed: ProcessObservation): IdentityState {
  return observed.kind === "observed" ? (sameProcess(expected, observed.identity) ? "active" : "reused") : observed.kind;
}
export function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export interface Health {
  status: "healthy" | "degraded" | "blocked";
  reason: Failure | "ready";
  processAlive: boolean; portListening: boolean; mcpReady: boolean;
  buildId?: string; serverVersion?: string; toolCount?: number;
  latencyMs?: number;
}
export interface RestartPolicy {
  enabled: boolean; windowMs: number; maxRestartsPerWindow: number;
  maxGlobalRestartsPerWindow: number; initialBackoffMs: number; maxBackoffMs: number;
  healthyResetMs: number; healthTimeoutMs: number; stopTimeoutMs: number;
  pollMs: number; resumeThresholdMs: number; resumeGraceMs: number;
  eventLimit: number; attemptLimit: number;
}
export const defaultPolicy: Readonly<RestartPolicy> = Object.freeze({
  enabled: false, windowMs: 600_000, maxRestartsPerWindow: 4, maxGlobalRestartsPerWindow: 8,
  initialBackoffMs: 2_000, maxBackoffMs: 60_000, healthyResetMs: 300_000,
  healthTimeoutMs: 30_000, stopTimeoutMs: 15_000, pollMs: 2_000,
  resumeThresholdMs: 30_000, resumeGraceMs: 15_000, eventLimit: 256, attemptLimit: 32,
});
export function parsePolicy(raw: unknown): RestartPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("BLOCKED_CONFIG: runtimeRecovery must be an object");
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!(key in defaultPolicy)) throw new Error(`BLOCKED_CONFIG: unknown policy key ${key}`);
  const result = { ...defaultPolicy, ...input } as RestartPolicy;
  if (typeof result.enabled !== "boolean") throw new Error("BLOCKED_CONFIG: enabled must be boolean");
  for (const [key, value] of Object.entries(result)) {
    if (key === "enabled") continue;
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 86_400_000) throw new Error(`BLOCKED_CONFIG: invalid ${key}`);
  }
  if (result.pollMs < 100 || result.pollMs > 60_000 || result.initialBackoffMs < result.pollMs || result.maxBackoffMs < result.initialBackoffMs
    || result.maxRestartsPerWindow > 64 || result.maxGlobalRestartsPerWindow > 128
    || result.maxGlobalRestartsPerWindow < result.maxRestartsPerWindow
    || result.resumeThresholdMs < 2 * result.pollMs || result.eventLimit > 4096 || result.attemptLimit > 256
    || result.healthTimeoutMs < result.pollMs || result.stopTimeoutMs < result.pollMs
    || result.healthyResetMs < 2 * result.pollMs
    || result.windowMs < result.maxBackoffMs * result.maxRestartsPerWindow + result.healthTimeoutMs) throw new Error("BLOCKED_CONFIG: inconsistent policy bounds");
  return result;
}
export type RecoveryPhase = "detected" | "classified" | "reserved" | "quiescing" | "starting" | "waiting_health" | "healthy" | "failed" | "blocked" | "completed";
export interface RecoveryAttempt {
  recoveryId: string; runtimeId: string; generation: number; component: Component;
  reason: Failure; phase: RecoveryPhase; attemptNumber: number; startedAt: number;
  updatedAt: number; completedAt?: number; lastError?: string; expectedBuildId: string;
  oldPid?: number; newPid?: number; healthStatus?: Health["status"];
  detectLatencyMs?: number; restartLatencyMs?: number; healthReadyLatencyMs?: number;
}
export interface LaunchTicket {
  runtimeId: string; generation: number; token: string; reservedAt: number;
  holder?: ProcessIdentity; nativeLaunchStarted?: boolean;
}
export interface RuntimeSlot {
  component: Component; ownership: Ownership; state: LifecycleState;
  identity?: RuntimeIdentity; ticket?: LaunchTicket; currentRecovery?: RecoveryAttempt;
  restarts: number[]; failures: number; notBefore: number; healthySince?: number;
  lastHealthyAt?: number; lastCrashAt?: number; unhealthySince?: number;
  health?: Health; blockedReason?: string; stopRequested?: boolean;
  stopStartedAt?: number; forceAttempted?: boolean; restartAfterStop?: boolean;
  adoptedEpoch?: number; acknowledgedRestart: number; previousPid?: number; detectLatencyMs?: number;
  lastExit?: { at: number; code: number | null; signal: string | null; uptimeMs: number; intentional: boolean };
}
export interface RuntimeEvent {
  at: number; event: string; component: Component | "supervisor";
  runtimeId?: string; generation: number; recoveryId?: string; reason?: string;
}
export interface Owner { token: string; epoch: number; identity: ProcessIdentity; acquiredAt: number; heartbeatAt: number }
export interface RuntimeSnapshot {
  schemaVersion: 1; rootId: string; revision: number; runtimeGeneration: number;
  ownerEpoch: number; owner?: Owner; runtimeState: LifecycleState;
  cleanShutdown: boolean; control: { mode: "run" | "pause" | "stop" | "upgrade"; restart: number };
  policyTime: number; lastWall?: number; lastMono?: number; resumeUntil: number;
  slots: Record<Component, RuntimeSlot>; globalRestarts: Array<{ component: Component; at: number }>;
  events: RuntimeEvent[]; attempts: RecoveryAttempt[];
}
export function initialSnapshot(rootId: string, tunnelOwnership: Ownership): RuntimeSnapshot {
  const slot = (component: Component, ownership: Ownership): RuntimeSlot => ({ component, ownership, state: "stopped", restarts: [], failures: 0, notBefore: 0, acknowledgedRestart: 0 });
  return { schemaVersion: 1, rootId, revision: 0, runtimeGeneration: 0, ownerEpoch: 0,
    runtimeState: "stopped", cleanShutdown: true, control: { mode: "run", restart: 0 },
    policyTime: 0, resumeUntil: 0, slots: { server: slot("server", "managed_by_devspace"), tunnel: slot("tunnel", tunnelOwnership) },
    globalRestarts: [], events: [], attempts: [] };
}
export function event(s: RuntimeSnapshot, component: RuntimeEvent["component"], name: string, at: number, reason?: string): void {
  const slot = component === "supervisor" ? undefined : s.slots[component];
  s.events.push({ at, event: name, component, generation: slot?.identity?.generation ?? slot?.ticket?.generation ?? s.runtimeGeneration,
    runtimeId: slot?.identity?.runtimeId ?? slot?.ticket?.runtimeId, recoveryId: slot?.currentRecovery?.recoveryId, reason });
}
export function finishAttempt(s: RuntimeSnapshot, slot: RuntimeSlot, at: number, phase: "completed" | "failed" | "blocked", error?: string): void {
  const attempt = slot.currentRecovery;
  if (!attempt || attempt.completedAt !== undefined) return;
  attempt.phase = phase; attempt.updatedAt = at; attempt.completedAt = at; attempt.lastError = error;
  s.attempts.push(structuredClone(attempt));
}
export function boundedSnapshot(s: RuntimeSnapshot, policy: RestartPolicy): void {
  s.events = s.events.slice(-policy.eventLimit); s.attempts = s.attempts.slice(-policy.attemptLimit);
  s.globalRestarts = s.globalRestarts.filter(x => x.at > s.policyTime - policy.windowMs).slice(-128);
  for (const slot of Object.values(s.slots)) slot.restarts = slot.restarts.filter(t => t > s.policyTime - policy.windowMs).slice(-64);
}
export function publicStatus(s: RuntimeSnapshot, policy: RestartPolicy): Record<string, unknown> {
  return { runtimeState: s.runtimeState, runtimeGeneration: s.runtimeGeneration, cleanShutdown: s.cleanShutdown,
    recoveryEnabled: policy.enabled, recoveryMode: s.control.mode,
    lastHealthyAt: s.slots.server.lastHealthyAt, lastCrashAt: s.slots.server.lastCrashAt,
    restartCountWindow: s.globalRestarts.filter(x => x.at > s.policyTime - policy.windowMs).length,
    currentRecovery: s.slots.server.currentRecovery, blockedReason: s.slots.server.blockedReason,
    managedComponents: Object.values(s.slots).map(slot => ({ component: slot.component, ownership: slot.ownership,
      state: slot.state, runtimeId: slot.identity?.runtimeId, pid: slot.identity?.pid, health: slot.health,
      blockedReason: slot.blockedReason, restartCountWindow: slot.restarts.length })), events: s.events };
}
