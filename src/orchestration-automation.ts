import { createHash } from "node:crypto";
import type { OrchestrationV2 } from "./orchestration-v2.js";
import type { DurableRecord } from "./orchestration-v2-store.js";

export type AutomationKind = "task_ready" | "integration_ready" | "watchdog_alert" | "stalled_session" | "conflict_requires_attention" | "handoff_awaiting_ack" | "test_state_changed";
export interface AutomationDueWork extends DurableRecord {
  kind: AutomationKind; subjectId: string; sourceVersion: string;
  summary: string; state: "due" | "acknowledged" | "resolved"; acknowledgedAt?: string; acknowledgedBy?: string;
}
export class AutomationHooks {
  constructor(private readonly v2: OrchestrationV2) {}
  dueList(project: string, limit = 100, after = "") {
    const records = this.v2.store.list<AutomationDueWork>("automation_due_work", project, limit, after);
    return { records: records.filter(record => record.state === "due"), nextCursor: records.length === limit ? records.at(-1)!.id : undefined };
  }
  poll(project: string, limit = 100, after = "", now = new Date()) {
    const scan = this.v2.watchdog.scan(project, now);
    const alerts = this.v2.watchdog.list(project, 500), integrations = this.v2.integrations.list(project, 500);
    const handoffs = this.v2.handoffs.list(project, 500), sessions = this.v2.sessions.list({ projectKey: project, limit: 500 });
    const ready = this.v2.coordinator.readyQueue(project, now);
    const candidates: Array<Pick<AutomationDueWork, "kind" | "subjectId" | "sourceVersion" | "summary">> = [];
    for (const task of ready) candidates.push({ kind: "task_ready", subjectId: task.id, sourceVersion: "ready", summary: task.name.slice(0, 500) });
    for (const item of integrations) if (item.readyReview || item.mergeReady) candidates.push({ kind: "integration_ready", subjectId: item.id, sourceVersion: item.candidateCommit ?? "", summary: "Integration snapshot ready for review; recheck gate before action." });
    for (const item of handoffs) if (item.state === "pending") candidates.push({ kind: "handoff_awaiting_ack", subjectId: item.id, sourceVersion: "pending", summary: item.summary.slice(0, 500) });
    for (const item of alerts) if (item.state === "open") candidates.push({
      kind: item.signal === "stalled" ? "stalled_session" : item.signal === "conflict" ? "conflict_requires_attention" : "watchdog_alert",
      subjectId: item.id, sourceVersion: "open", summary: item.signal + ": " + item.subjectId.slice(0, 400),
    });
    for (const session of sessions) {
      const event = this.v2.sessions.events(session.id, 500).find(e => e.kind === "test_run");
      if (event) candidates.push({ kind: "test_state_changed", subjectId: session.id, sourceVersion: String(event.id), summary: event.detail.passed === true ? "Latest test passed" : "Latest test failed or is unverified" });
    }
    const truncated = scan.truncated || [alerts, integrations, handoffs, sessions, ready].some(rows => rows.length >= 500) || candidates.length > 500;
    const active = new Set<string>(), timestamp = now.toISOString();
    this.v2.store.transaction(() => {
      for (const candidate of candidates.slice(0, 500)) {
        const id = "due_" + createHash("sha256").update(JSON.stringify([project, candidate.kind, candidate.subjectId])).digest("hex");
        active.add(id);
        const current = this.v2.store.get<AutomationDueWork>("automation_due_work", project, id);
        if (!current) this.v2.store.insert<AutomationDueWork>("automation_due_work", {
          ...candidate, id, projectKey: project, state: "due", revision: 1, createdAt: timestamp, updatedAt: timestamp,
        });
        else if (current.state === "resolved" || current.sourceVersion !== candidate.sourceVersion) this.v2.store.update<AutomationDueWork>("automation_due_work", {
          ...current, ...candidate, state: "due", acknowledgedAt: undefined, acknowledgedBy: undefined, updatedAt: timestamp,
        }, current.revision);
      }
      if (!truncated) for (const current of this.v2.store.list<AutomationDueWork>("automation_due_work", project, 500)) {
        if (!active.has(current.id) && current.state !== "resolved") this.v2.store.update<AutomationDueWork>("automation_due_work", {
          ...current, state: "resolved", updatedAt: timestamp,
        }, current.revision);
      }
    });
    return { ...this.dueList(project, limit, after), truncated };
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
