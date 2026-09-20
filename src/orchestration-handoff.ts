import { randomUUID } from "node:crypto";
import * as z from "zod/v4";
import type { OrchestrationRegistry } from "./orchestration-registry.js";
import type { OrchestrationCoordinator } from "./orchestration-coordinator.js";
import type { WorktreeOrchestrator } from "./orchestration-worktrees.js";
import { OrchestrationV2Store, type DurableRecord } from "./orchestration-v2-store.js";

const id = z.string().min(1).max(200);
const notes = z.array(z.string().max(1000)).max(50).default([]);
export const handoffInputSchema = z.object({
  fromSessionId: id, toSessionId: id.optional(), taskId: id.optional(),
  summary: z.string().trim().min(1).max(8000),
  filesChanged: z.array(z.string().max(500)).max(100).default([]),
  tests: notes, errors: notes, unresolvedItems: notes,
  nextAction: z.string().trim().min(1).max(4000),
  branch: z.string().max(200).optional(), commit: z.string().max(100).optional(), worktree: z.string().max(1000).optional(),
});
type HandoffInput = z.infer<typeof handoffInputSchema>;
export interface HandoffCheckpoint extends DurableRecord, HandoffInput {
  handoffId: string; state: "pending" | "acknowledged"; acknowledgedAt?: string; acknowledgedBy?: string;
  senderLogicalSessionId?: string; senderWorkerIncarnationId?: string;
  executionAttemptId?: string; leaseGeneration?: number; bindingGeneration?: number;
}
export class HandoffManager {
  constructor(private readonly store: OrchestrationV2Store, private readonly sessions: OrchestrationRegistry,
    private readonly coordinator: OrchestrationCoordinator, private readonly bindings: WorktreeOrchestrator) {}
  private session(project: string, id: string) {
    const session = this.sessions.get(id);
    if (session.projectKey !== project) throw new Error("Handoff session outside project scope.");
    return session;
  }
  create(project: string, raw: z.input<typeof handoffInputSchema>): HandoffCheckpoint {
    const input = handoffInputSchema.parse(raw);
    if (Buffer.byteLength(JSON.stringify(input)) > 64 * 1024) throw new Error("Handoff payload exceeds 64 KiB bound.");
    const sender = this.session(project, input.fromSessionId);
    if (input.toSessionId) this.session(project, input.toSessionId);
    if (input.toSessionId === input.fromSessionId) throw new Error("Handoff receiver must be a different session.");
    let authority: Pick<HandoffCheckpoint, "executionAttemptId" | "leaseGeneration"> = {};
    if (input.taskId) {
      const task = this.coordinator.get(input.taskId), binding = this.bindings.get(project, input.taskId);
      if (task.projectKey !== project || (task.ownerSessionId !== input.fromSessionId && binding?.sessionId !== input.fromSessionId)) {
        throw new Error("Handoff task is not owned by sender in current project scope.");
      }
      if (!task.attemptId || task.ownerSessionId !== input.fromSessionId
        || !task.ownerWorkerIncarnationId || task.ownerWorkerIncarnationId !== sender.workerIncarnationId
        || (binding && (binding.attemptId !== task.attemptId || binding.leaseGeneration !== task.leaseGeneration
          || binding.workerIncarnationId !== sender.workerIncarnationId))) {
        throw new Error("Handoff execution authority is stale.");
      }
      authority = { executionAttemptId: task.attemptId, leaseGeneration: task.leaseGeneration };
    }
    const id = "handoff_" + randomUUID(), now = new Date().toISOString();
    return this.store.insert<HandoffCheckpoint>("handoff_checkpoints", {
      ...input, ...authority, senderLogicalSessionId: sender.logicalSessionId,
      senderWorkerIncarnationId: sender.workerIncarnationId, bindingGeneration: sender.bindingGeneration,
      id, handoffId: id, projectKey: project, state: "pending", revision: 1, createdAt: now, updatedAt: now,
    });
  }
  get(project: string, id: string): HandoffCheckpoint {
    const record = this.store.get<HandoffCheckpoint>("handoff_checkpoints", project, id);
    if (!record) throw new Error("Unknown handoff in project scope.");
    return record;
  }
  list(project: string, limit = 200, after = ""): HandoffCheckpoint[] { return this.store.list("handoff_checkpoints", project, limit, after); }
  acknowledge(project: string, id: string, receiverId: string, expectedRevision: number): HandoffCheckpoint {
    this.session(project, receiverId);
    const current = this.get(project, id);
    if (current.fromSessionId === receiverId || (current.toSessionId && current.toSessionId !== receiverId)
      || (current.acknowledgedBy && current.acknowledgedBy !== receiverId)) throw new Error("Handoff acknowledgement requires the intended receiver.");
    if (current.state === "acknowledged") return current;
    const sender = this.session(project, current.fromSessionId);
    if (current.senderLogicalSessionId && (sender.logicalSessionId !== current.senderLogicalSessionId
      || sender.workerIncarnationId !== current.senderWorkerIncarnationId
      || sender.bindingGeneration !== current.bindingGeneration)) throw new Error("Handoff sender authority has been superseded.");
    if (current.taskId && current.executionAttemptId) {
      const task = this.coordinator.get(current.taskId);
      if (task.attemptId !== current.executionAttemptId || task.leaseGeneration !== current.leaseGeneration) {
        throw new Error("Handoff execution attempt has been superseded.");
      }
    }
    const now = new Date().toISOString();
    return this.store.update<HandoffCheckpoint>("handoff_checkpoints", {
      ...current, state: "acknowledged", acknowledgedBy: receiverId, acknowledgedAt: now, updatedAt: now,
    }, expectedRevision);
  }
}
