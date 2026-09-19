import { createHash } from "node:crypto";
import type { OrchestrationCoordinator } from "./orchestration-coordinator.js";
import type { OrchestrationRegistry } from "./orchestration-registry.js";
import type { IntegrationManager } from "./orchestration-integration.js";
import { deriveOrchestrationHealth } from "./orchestration-health.js";
import { detectOrchestrationConflicts } from "./orchestration-conflicts.js";
import { OrchestrationV2Store, type DurableRecord } from "./orchestration-v2-store.js";

export type WatchdogSignal = "idle" | "stalled" | "retry_loop" | "unverified_changes" | "conflict" | "lease_expiring" | "lease_expired" | "blocked_user" | "blocked_tool" | "integration_blocked";
export interface WatchdogAlert extends DurableRecord {
  signal: WatchdogSignal; subjectId: string; message: string;
  state: "open" | "acknowledged" | "resolved"; acknowledgedAt?: string; resolvedAt?: string;
}
export class OrchestrationWatchdog {
  constructor(private readonly store: OrchestrationV2Store, private readonly sessions: OrchestrationRegistry,
    private readonly coordinator: OrchestrationCoordinator, private readonly integrations: IntegrationManager) {}
  list(project: string, limit = 200, after = ""): WatchdogAlert[] { return this.store.list("watchdog_alerts", project, limit, after); }
  scan(project: string, now = new Date()): { alerts: WatchdogAlert[]; truncated: boolean } {
    const sessions = this.sessions.list({ projectKey: project, limit: 500 });
    const tasks = this.coordinator.list(project), integrations = this.integrations.list(project, 500);
    const signals: Array<{ signal: WatchdogSignal; subjectId: string }> = [];
    for (const session of sessions) {
      if (["completed", "failed", "abandoned"].includes(session.state)) continue;
      for (const signal of deriveOrchestrationHealth(session, now).signals) {
        if (["idle", "stalled", "retry_loop", "unverified_changes"].includes(signal)) signals.push({ signal: signal as WatchdogSignal, subjectId: session.id });
      }
      if (session.state === "blocked_user" || session.state === "blocked_tool") signals.push({ signal: session.state, subjectId: session.id });
    }
    for (const task of tasks) {
      if (task.state !== "claimed" || !task.leaseExpiresAt) continue;
      const left = Date.parse(task.leaseExpiresAt) - now.getTime();
      if (left <= 60000) signals.push({ signal: left <= 0 ? "lease_expired" : "lease_expiring", subjectId: task.id });
    }
    const conflicts = detectOrchestrationConflicts(sessions, this.sessions.fileIntents(), 500);
    for (const conflict of conflicts) signals.push({ signal: "conflict", subjectId: [conflict.sessionA, conflict.sessionB, conflict.pathA, conflict.pathB].join(":") });
    for (const item of integrations) if (item.checkedAt && !item.readyReview && !item.mergeReady) signals.push({ signal: "integration_blocked", subjectId: item.id });
    const truncated = sessions.length >= 500 || tasks.length >= 500 || integrations.length >= 500 || conflicts.length >= 500 || signals.length > 500;
    const timestamp = now.toISOString(), active = new Set<string>();
    return this.store.transaction(() => {
      for (const entry of signals.slice(0, 500)) {
        const id = "alert_" + createHash("sha256").update(JSON.stringify([project, entry.signal, entry.subjectId])).digest("hex");
        active.add(id);
        const current = this.store.get<WatchdogAlert>("watchdog_alerts", project, id);
        if (!current) this.store.insert<WatchdogAlert>("watchdog_alerts", {
          id, projectKey: project, ...entry, subjectId: entry.subjectId.slice(0, 1200), message: entry.signal + " requires attention",
          state: "open", revision: 1, createdAt: timestamp, updatedAt: timestamp,
        });
        else if (current.state === "resolved") this.store.update<WatchdogAlert>("watchdog_alerts", {
          ...current, state: "open", resolvedAt: undefined, acknowledgedAt: undefined, updatedAt: timestamp,
        }, current.revision);
      }
      // Partial scans never clear alerts whose subjects may be outside the bounded window.
      if (!truncated) for (const alert of this.list(project, 500)) {
        if (!active.has(alert.id) && alert.state !== "resolved") this.store.update<WatchdogAlert>("watchdog_alerts", {
          ...alert, state: "resolved", resolvedAt: timestamp, updatedAt: timestamp,
        }, alert.revision);
      }
      return { alerts: this.list(project, 200), truncated };
    });
  }
  acknowledge(project: string, id: string, expectedRevision: number): WatchdogAlert {
    const current = this.store.get<WatchdogAlert>("watchdog_alerts", project, id);
    if (!current) throw new Error("Unknown watchdog alert in project scope.");
    if (current.state === "acknowledged") return current;
    if (current.state === "resolved") throw new Error("Resolved alert cannot be acknowledged.");
    const now = new Date().toISOString();
    return this.store.update<WatchdogAlert>("watchdog_alerts", { ...current, state: "acknowledged", acknowledgedAt: now, updatedAt: now }, expectedRevision);
  }
}
