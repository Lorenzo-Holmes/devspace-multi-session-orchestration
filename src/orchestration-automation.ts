import { createHash, randomUUID } from "node:crypto";
import type { OrchestrationV2 } from "./orchestration-v2.js";
import type { DurableRecord } from "./orchestration-v2-store.js";
import type { WatchdogAlert } from "./orchestration-watchdog.js";
import type { IntegrationRecord } from "./orchestration-integration.js";
import type { HandoffCheckpoint } from "./orchestration-handoff.js";

export type AutomationKind = "task_ready" | "integration_ready" | "watchdog_alert" | "stalled_session" | "conflict_requires_attention" | "handoff_awaiting_ack" | "test_state_changed";
export interface AutomationDueWork extends DurableRecord {
  kind: AutomationKind; subjectId: string; sourceVersion: string;
  summary: string; state: "due" | "acknowledged" | "resolved"; acknowledgedAt?: string; acknowledgedBy?: string;
  episodeId?: string; deliveryId?: string;
}
export class AutomationHooks {
  constructor(private readonly v2: OrchestrationV2) {}
  dueList(project: string, limit = 100, after = "") {
    const bounded = Math.max(1, Math.min(limit, 500));
    const records = this.v2.store.listInState<AutomationDueWork>("automation_due_work", project, "due", bounded, after);
    return { records, nextCursor: records.length === bounded ? records.at(-1)!.id : undefined };
  }
  poll(project: string, limit = 100, after = "", now = new Date()) {
    return this.v2.store.transaction(() => {
    const scan = this.v2.watchdog.scan(project, now);
    const alerts = this.v2.store.all<WatchdogAlert>("watchdog_alerts", project), integrations = this.v2.store.all<IntegrationRecord>("integration_records", project);
    const handoffs = this.v2.store.all<HandoffCheckpoint>("handoff_checkpoints", project), sessions = this.v2.sessions.all(project);
    const ready = this.v2.coordinator.readyQueue(project, now);
    const candidates: Array<Pick<AutomationDueWork, "kind" | "subjectId" | "sourceVersion" | "summary">> = [];
    for (const task of ready) candidates.push({ kind: "task_ready", subjectId: task.id, sourceVersion: String(task.revision), summary: task.name.slice(0, 500) });
    for (const item of integrations) if (item.readyReview || item.mergeReady) candidates.push({ kind: "integration_ready", subjectId: item.id, sourceVersion: `${item.revision}:${item.candidateCommit ?? ""}`, summary: "Integration snapshot ready for review; recheck gate before action." });
    for (const item of handoffs) if (item.state === "pending") candidates.push({ kind: "handoff_awaiting_ack", subjectId: item.id, sourceVersion: String(item.revision), summary: item.summary.slice(0, 500) });
    for (const item of alerts) if (item.state === "open") candidates.push({
      kind: item.signal === "stalled" ? "stalled_session" : item.signal === "conflict" ? "conflict_requires_attention" : "watchdog_alert",
      subjectId: item.id, sourceVersion: String(item.episode ?? item.revision), summary: item.signal + ": " + item.subjectId.slice(0, 400),
    });
    for (const session of sessions) {
      const event = this.v2.sessions.latestEvent(session.id, "test_run");
      if (event) candidates.push({ kind: "test_state_changed", subjectId: session.id, sourceVersion: String(event.id), summary: "Latest test observation changed; this notification is not trusted execution evidence." });
    }
    const inputComplete = scan.inputComplete;
    const active = new Set<string>(), timestamp = now.toISOString();
      for (const candidate of candidates) {
        const id = "due_" + createHash("sha256").update(JSON.stringify([project, candidate.kind, candidate.subjectId])).digest("hex");
        active.add(id);
        const current = this.v2.store.get<AutomationDueWork>("automation_due_work", project, id);
        const episodeId = createHash("sha256").update(JSON.stringify([project, candidate.kind, candidate.subjectId, candidate.sourceVersion])).digest("hex");
        if (!current) this.v2.store.insert<AutomationDueWork>("automation_due_work", {
          ...candidate, id, episodeId, deliveryId: randomUUID(), projectKey: project, state: "due", revision: 1, createdAt: timestamp, updatedAt: timestamp,
        });
        else if (current.state === "resolved" || current.sourceVersion !== candidate.sourceVersion) this.v2.store.update<AutomationDueWork>("automation_due_work", {
          ...current, ...candidate, episodeId, deliveryId: randomUUID(), state: "due", acknowledgedAt: undefined, acknowledgedBy: undefined, updatedAt: timestamp,
        }, current.revision);
      }
      if (inputComplete) for (const current of this.v2.store.all<AutomationDueWork>("automation_due_work", project)) {
        if (!active.has(current.id) && current.state !== "resolved") this.v2.store.update<AutomationDueWork>("automation_due_work", {
          ...current, state: "resolved", updatedAt: timestamp,
        }, current.revision);
      }
    const output = this.dueList(project, limit, after);
    return { ...output, truncated: Boolean(output.nextCursor) || !inputComplete, inputComplete,
      sourceTruncated: !inputComplete, outputTruncated: Boolean(output.nextCursor), reconciliationComplete: inputComplete };
    });
  }
  acknowledge(project: string, id: string, expectedRevision: number, consumer: string): AutomationDueWork {
    if (!consumer.trim() || consumer.length > 100) throw new Error("A bounded scheduler consumer name is required.");
    const current = this.v2.store.get<AutomationDueWork>("automation_due_work", project, id);
    if (!current) throw new Error("Unknown automation record in project scope.");
    if (current.state === "acknowledged" && current.revision === expectedRevision + 1 && current.acknowledgedBy === consumer) return current;
    if (current.state !== "due") throw new Error("Automation record is no longer due.");
    const now = new Date().toISOString();
    return this.v2.store.update<AutomationDueWork>("automation_due_work", {
      ...current, state: "acknowledged", acknowledgedAt: now, acknowledgedBy: consumer, updatedAt: now,
    }, expectedRevision);
  }
}
