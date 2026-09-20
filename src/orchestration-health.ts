import type { OrchestrationSession } from "./orchestration-store.js";

export type OrchestrationHealthPrimary =
  | "healthy"
  | "idle"
  | "stalled"
  | "blocked"
  | "retry_loop"
  | "unverified_changes"
  | "terminal";

export interface OrchestrationHealth {
  sessionId: string;
  primary: OrchestrationHealthPrimary;
  signals: OrchestrationHealthPrimary[];
  activityAgeMs: number;
  heartbeatAgeMs?: number;
  thresholds: { idleMs: number; stalledMs: number; retryLoopCount: number };
}

export interface OrchestrationHealthThresholds {
  idleMs?: number;
  stalledMs?: number;
  retryLoopCount?: number;
}

const terminalStates = new Set(["completed", "failed", "abandoned"]);

export function deriveOrchestrationHealth(
  session: OrchestrationSession,
  now = new Date(),
  thresholds: OrchestrationHealthThresholds = {},
): OrchestrationHealth {
  const idleMs = thresholds.idleMs ?? 10 * 60_000;
  const stalledMs = thresholds.stalledMs ?? 30 * 60_000;
  const retryLoopCount = thresholds.retryLoopCount ?? 3;
  if (idleMs < 0 || stalledMs < idleMs || retryLoopCount < 1) {
    throw new Error("Invalid orchestration health thresholds.");
  }
  const nowMs = now.getTime();
  const activityAgeMs = Math.max(0, nowMs - Date.parse(session.lastActivityAt));
  const heartbeatAgeMs = session.lastHeartbeatAt
    ? Math.max(0, nowMs - Date.parse(session.lastHeartbeatAt))
    : undefined;
  const signals: OrchestrationHealthPrimary[] = [];

  if (terminalStates.has(session.state)) signals.push("terminal");
  if (session.consecutiveErrorCount >= retryLoopCount) signals.push("retry_loop");
  if (session.state === "blocked_user" || session.state === "blocked_tool") signals.push("blocked");
  if (!terminalStates.has(session.state) && activityAgeMs >= stalledMs) signals.push("stalled");
  else if (!terminalStates.has(session.state) && activityAgeMs >= idleMs) signals.push("idle");

  if (session.lastFileChangeAt) {
    const fileMs = Date.parse(session.lastFileChangeAt);
    const validationMs = session.lastSuccessfulValidationAt
      ? Date.parse(session.lastSuccessfulValidationAt)
      : session.lastTestAt ? Date.parse(session.lastTestAt) : Number.NEGATIVE_INFINITY;
    const generationDirty = (session.fileGeneration ?? 0) > (session.lastValidatedFileGeneration ?? 0);
    if (generationDirty || fileMs > validationMs) signals.push("unverified_changes");
  }

  const primary = choosePrimary(signals);
  return {
    sessionId: session.id,
    primary,
    signals: [...new Set(signals)],
    activityAgeMs,
    heartbeatAgeMs,
    thresholds: { idleMs, stalledMs, retryLoopCount },
  };
}

function choosePrimary(signals: OrchestrationHealthPrimary[]): OrchestrationHealthPrimary {
  for (const candidate of [
    "terminal",
    "retry_loop",
    "blocked",
    "stalled",
    "unverified_changes",
    "idle",
  ] as const) {
    if (signals.includes(candidate)) return candidate;
  }
  return "healthy";
}
