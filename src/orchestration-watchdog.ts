import { createHash, randomUUID } from "node:crypto";
import type { OrchestrationCoordinator } from "./orchestration-coordinator.js";
import type { OrchestrationRegistry } from "./orchestration-registry.js";
import type { IntegrationManager, IntegrationRecord } from "./orchestration-integration.js";
import { deriveOrchestrationHealth } from "./orchestration-health.js";
import { detectOrchestrationConflicts } from "./orchestration-conflicts.js";
import { OrchestrationV2Store, type DurableRecord } from "./orchestration-v2-store.js";

export type WatchdogSignal = "idle" | "stalled" | "retry_loop" | "unverified_changes" | "conflict" | "lease_expiring" | "lease_expired" | "blocked_user" | "blocked_tool" | "integration_blocked";
export interface WatchdogAlert extends DurableRecord {
  signal: WatchdogSignal; subjectId: string; message: string;
  state: "open" | "acknowledged" | "resolved"; acknowledgedAt?: string; resolvedAt?: string;
  episode?: number; sourceVersion?: string;
}
export class OrchestrationWatchdog {
  constructor(private readonly store: OrchestrationV2Store, private readonly sessions: OrchestrationRegistry,
    private readonly coordinator: OrchestrationCoordinator, private readonly integrations: IntegrationManager) {}
  list(project: string, limit = 200, after = ""): WatchdogAlert[] { return this.store.list("watchdog_alerts", project, limit, after); }
  scan(project: string, now = new Date()): { alerts: WatchdogAlert[]; truncated: boolean;
    inputComplete: boolean; sourceTruncated: boolean; outputTruncated: boolean; reconciliationComplete: boolean; scanGeneration: string } {
    // Reserve one short synchronous reconciliation window. External probes are
    // not permitted inside this transaction; the inputs below are durable DB facts.
    return this.store.transaction(() => {
    const sessions = this.sessions.all(project);
    const tasks = this.coordinator.all(project), integrations = this.store.all<IntegrationRecord>("integration_records", project);
    const version = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const signals: Array<{ signal: WatchdogSignal; subjectId: string; sourceVersion: string }> = [];
    const intentVersions = new Map(sessions.map(session => [session.id,
      [session.fileGeneration ?? session.lastFileChangeAt, this.sessions.latestEvent(session.id, "file_intents")?.id]]));
    for (const session of sessions) {
      if (["completed", "failed", "abandoned"].includes(session.state)) continue;
      for (const signal of deriveOrchestrationHealth(session, now).signals) {
        if (["idle", "stalled", "retry_loop", "unverified_changes"].includes(signal)) signals.push({ signal: signal as WatchdogSignal, subjectId: session.id,
          sourceVersion: version(signal === "unverified_changes" ? [session.fileGeneration, session.lastFileChangeAt]
            : signal === "retry_loop" ? [session.lastErrorFingerprint, this.sessions.latestEvent(session.id, "error")?.id, this.sessions.latestEvent(session.id, "test_run")?.id]
            : session.lastActivityAt) });
      }
      if (session.state === "blocked_user" || session.state === "blocked_tool") signals.push({ signal: session.state, subjectId: session.id,
        sourceVersion: version(this.sessions.latestEvent(session.id, "state_change")?.id ?? session.createdAt) });
    }
    for (const task of tasks) {
      if (task.state !== "claimed" || !task.leaseExpiresAt) continue;
      const left = Date.parse(task.leaseExpiresAt) - now.getTime();
      if (left <= 60000) signals.push({ signal: left <= 0 ? "lease_expired" : "lease_expiring", subjectId: task.id,
        sourceVersion: version([task.revision, task.leaseExpiresAt]) });
    }
    const conflicts = detectOrchestrationConflicts(sessions, this.sessions.fileIntents(), Number.POSITIVE_INFINITY);
    for (const conflict of conflicts) signals.push({ signal: "conflict", subjectId: [conflict.sessionA, conflict.sessionB, conflict.pathA, conflict.pathB].join(":"),
      sourceVersion: version([intentVersions.get(conflict.sessionA), intentVersions.get(conflict.sessionB)]) });
    for (const item of integrations) if (item.checkedAt && !item.readyReview && !item.mergeReady) signals.push({ signal: "integration_blocked", subjectId: item.id,
      sourceVersion: version([item.revision, item.candidateCommit]) });
    const timestamp = now.toISOString(), active = new Set<string>();
      for (const entry of signals) {
        const id = "alert_" + createHash("sha256").update(JSON.stringify([project, entry.signal, entry.subjectId])).digest("hex");
        active.add(id);
        const current = this.store.get<WatchdogAlert>("watchdog_alerts", project, id);
        if (!current) this.store.insert<WatchdogAlert>("watchdog_alerts", {
          id, projectKey: project, ...entry, subjectId: entry.subjectId.slice(0, 1200), message: entry.signal + " requires attention",
          state: "open", episode: 1, revision: 1, createdAt: timestamp, updatedAt: timestamp,
        });
        else if (current.state === "resolved" || current.sourceVersion !== entry.sourceVersion) this.store.update<WatchdogAlert>("watchdog_alerts", {
          ...current, sourceVersion: entry.sourceVersion, episode: (current.episode ?? 1) + 1,
          state: "open", resolvedAt: undefined, acknowledgedAt: undefined, updatedAt: timestamp,
        }, current.revision);
      }
      // No display bound is used for either side of reconciliation.
      for (const alert of this.store.all<WatchdogAlert>("watchdog_alerts", project)) {
        if (!active.has(alert.id) && alert.state !== "resolved") this.store.update<WatchdogAlert>("watchdog_alerts", {
          ...alert, state: "resolved", resolvedAt: timestamp, updatedAt: timestamp,
        }, alert.revision);
      }
      const allAlerts = this.store.all<WatchdogAlert>("watchdog_alerts", project);
      const outputTruncated = allAlerts.length > 200;
      return { alerts: allAlerts.slice(0, 200), truncated: outputTruncated, inputComplete: true,
        sourceTruncated: false, outputTruncated, reconciliationComplete: true, scanGeneration: randomUUID() };
    });
  }
  acknowledge(project: string, id: string, expectedRevision: number): WatchdogAlert {
    const current = this.store.get<WatchdogAlert>("watchdog_alerts", project, id);
    if (!current) throw new Error("Unknown watchdog alert in project scope.");
    if (current.state === "acknowledged") {
      if (current.revision === expectedRevision + 1) return current;
      throw new Error("Alert acknowledgement belongs to a stale revision or episode.");
    }
    if (current.state === "resolved") throw new Error("Resolved alert cannot be acknowledged.");
    const now = new Date().toISOString();
    return this.store.update<WatchdogAlert>("watchdog_alerts", { ...current, state: "acknowledged", acknowledgedAt: now, updatedAt: now }, expectedRevision);
  }
}
