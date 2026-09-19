import { supervisorSummarySchema, supervisorSectionNames, type SupervisorSummary, type SupervisorItem as Item } from "./supervisor-contracts.js";
export { supervisorSummarySchema } from "./supervisor-contracts.js";
import type { OrchestrationV2 } from "./orchestration-v2.js";
import type { OrchestrationSession, OrchestrationEvent } from "./orchestration-store.js";
import type { CoordinatorTask } from "./coordinator-store.js";
import type { WorktreeBinding } from "./orchestration-worktrees.js";
import type { IntegrationRecord } from "./orchestration-integration.js";
import type { HandoffCheckpoint } from "./orchestration-handoff.js";
import type { WatchdogAlert } from "./orchestration-watchdog.js";
import { deriveOrchestrationHealth } from "./orchestration-health.js";
import { detectOrchestrationConflicts, type OrchestrationConflict } from "./orchestration-conflicts.js";

interface SupervisorState {
  project: string; sessions: OrchestrationSession[]; tasks: CoordinatorTask[]; readyTaskIds: string[];
  events: Record<string, OrchestrationEvent[]>; bindings: WorktreeBinding[]; conflicts: OrchestrationConflict[];
  handoffs: HandoffCheckpoint[]; integrations: IntegrationRecord[]; alerts: WatchdogAlert[];
}
const text = (value: unknown, max = 1000) => String(value ?? "").slice(0, max);
const terminal = new Set(["completed", "failed", "abandoned"]);

/** Pure transformation: never scans/writes watchdog state or updates heartbeat/leases. */
export function buildSupervisorSummary(s: SupervisorState, now = new Date()): SupervisorSummary {
  const health = new Map(s.sessions.map(session => [session.id, deriveOrchestrationHealth(session, now)]));
  const ready = new Set(s.readyTaskIds);
  const sessions: Item[] = s.sessions.map(session => ({ id: session.id, title: text(session.label || session.id),
    state: health.get(session.id)!.primary === "healthy" ? session.state : health.get(session.id)!.primary,
    detail: text([session.state, session.task, "activity: " + session.lastActivityAt].filter(Boolean).join(" · ")),
    timeline: (s.events[session.id] ?? []).slice(0, 10).map(e => ({ at: text(e.createdAt, 100), kind: text(e.kind, 100), detail: text(JSON.stringify(e.detail)) })),
  }));
  const tasks: Item[] = s.tasks.map(task => ({ id: task.id, title: text(task.name), state: ready.has(task.id) ? "ready" : task.state,
    detail: text(task.description), timeline: [{ at: task.createdAt, kind: "created", detail: "Task created" },
      { at: task.updatedAt, kind: task.state, detail: text("Current durable revision " + task.revision + (task.ownerSessionId ? "; owner " + task.ownerSessionId : "")) }],
  }));
  const alerts = s.alerts.filter(a => a.state !== "resolved");
  const item = (id: string, title: string, state: string, detail: unknown): Item => ({ id: text(id), title: text(title), state: text(state, 100), detail: text(detail), timeline: [] });
  const section = (key: typeof supervisorSectionNames[number], title: string, items: Item[]) => ({ key, title, total: items.length, items: items.slice(0, 50) });
  const blockedTasks = tasks.filter(task => task.state === "pending" && !ready.has(task.id));
  const attention = sessions.filter(row => ["idle", "stalled", "retry_loop", "unverified_changes", "blocked"].includes(row.state));
  const sections = [
    section("sessions", "Sessions · 会话与健康", sessions), section("tasks", "Tasks · 当前任务", tasks),
    section("readyTasks", "Ready · 可领取任务", tasks.filter(task => ready.has(task.id))),
    section("claimedTasks", "Claimed · 已领取任务", tasks.filter(task => task.state === "claimed")),
    section("blockedTasks", "Blocked · 依赖未完成", blockedTasks),
    section("bindings", "Worktrees · 工作区绑定", s.bindings.map(b => item(b.id, b.taskId, b.status, b.worktreeRoot || "Provisioning"))),
    section("conflicts", "Conflicts · 文件冲突", s.conflicts.map((c, i) => item(String(i), c.pathA + " ↔ " + c.pathB, c.severity, c.sessionA + " / " + c.sessionB))),
    section("handoffs", "Handoffs · 待确认交接", s.handoffs.filter(h => h.state === "pending").map(h => item(h.id, h.summary, h.state, h.nextAction))),
    section("integrations", "Integration · 审查门禁", s.integrations.map(i => item(i.id, i.taskId, i.mergeReady ? "merge_ready" : i.readyReview ? "ready_review" : "blocked", "Snapshot " + (i.checkedAt || "unchecked") + "; " + Object.entries(i.gates).filter(([, v]) => !v).map(([k]) => k).join(", ")))),
    section("alerts", "Alerts · 持久告警", alerts.map(a => item(a.id, a.signal, a.state, a.subjectId))),
    section("needsAttention", "Needs attention · 需要关注", [...attention, ...alerts.map(a => item(a.id, a.signal, a.state, a.subjectId))]),
  ];
  const summary = supervisorSummarySchema.parse({ schemaVersion: 1, project: text(s.project), generatedAt: now.toISOString(),
    truncated: sections.some(section => section.total > 50) || [s.sessions, s.tasks, s.bindings, s.conflicts, s.handoffs, s.integrations, s.alerts].some(rows => rows.length >= 500),
    counts: {
      active: s.sessions.filter(x => !terminal.has(x.state)).length,
      idle: [...health.values()].filter(x => x.signals.includes("idle")).length,
      stalled: [...health.values()].filter(x => x.signals.includes("stalled")).length,
      blocked: s.sessions.filter(x => x.state.startsWith("blocked_")).length + blockedTasks.length,
      readyReview: s.integrations.filter(x => x.readyReview || x.mergeReady).length,
      conflicts: s.conflicts.length, alerts: alerts.length, completed: s.tasks.filter(x => x.state === "completed").length,
    }, sections,
  });
  // A global byte budget also covers multibyte text, beyond per-field/schema limits.
  while (Buffer.byteLength(JSON.stringify(summary)) > 128 * 1024) {
    const largest = summary.sections.filter(x => x.items.length).sort((a, b) => JSON.stringify(b.items).length - JSON.stringify(a.items).length)[0];
    if (!largest) break;
    largest.items.pop(); summary.truncated = true;
  }
  return summary;
}

export function supervisorSummary(v2: OrchestrationV2, project: string, now = new Date()): SupervisorSummary {
  const sessions = v2.sessions.all(project);
  return buildSupervisorSummary({ project, sessions, tasks: v2.coordinator.all(project),
    readyTaskIds: v2.coordinator.readyQueue(project, now).map(task => task.id),
    events: Object.fromEntries(sessions.slice(0, 50).map(session => [session.id, v2.sessions.events(session.id, 10)])),
    bindings: v2.store.all<WorktreeBinding>("worktree_bindings", project), conflicts: detectOrchestrationConflicts(sessions, v2.sessions.fileIntents(), Number.POSITIVE_INFINITY),
    handoffs: v2.store.all<HandoffCheckpoint>("handoff_checkpoints", project), integrations: v2.store.all<IntegrationRecord>("integration_records", project), alerts: v2.store.all<WatchdogAlert>("watchdog_alerts", project),
  }, now);
}
