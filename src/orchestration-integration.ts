import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import * as z from "zod/v4";
import type { OrchestrationCoordinator } from "./orchestration-coordinator.js";
import type { OrchestrationRegistry } from "./orchestration-registry.js";
import type { WorktreeBinding, WorktreeOrchestrator } from "./orchestration-worktrees.js";
import { detectOrchestrationConflicts } from "./orchestration-conflicts.js";
import { OrchestrationV2Store, type DurableRecord } from "./orchestration-v2-store.js";

const exec = promisify(execFile);
export const integrationUpdateSchema = z.object({
  candidateRef: z.string().min(1).max(200).refine(s => !s.startsWith("-"), "Ref cannot be an option").optional(),
  testEvidence: z.array(z.object({ eventId: z.number().int().positive(), commit: z.string().regex(/^[a-f0-9]{40,64}$/) })).max(50).optional(),
  reviewState: z.enum(["pending", "in_review", "approved", "changes_requested"]).optional(),
});
type IntegrationUpdate = z.infer<typeof integrationUpdateSchema>;
export interface IntegrationRecord extends DurableRecord {
  integrationId: string; taskId: string; sessionId: string; binding: WorktreeBinding;
  candidateRef: string; candidateCommit?: string; diffReady: boolean;
  conflictState: "unknown" | "clean" | "conflict";
  testEvidence: Array<{ eventId: number; commit: string }>;
  integrationWorktreeState: "unchecked" | "clean" | "dirty" | "missing";
  reviewState: "pending" | "in_review" | "approved" | "changes_requested";
  reviewedCommit?: string;
  mergeReady: boolean; readyReview: boolean; gates: Record<string, boolean>; checkedAt?: string;
}

export class IntegrationManager {
  constructor(private readonly store: OrchestrationV2Store, private readonly coordinator: OrchestrationCoordinator,
    private readonly sessions: OrchestrationRegistry, private readonly bindings: WorktreeOrchestrator) {}
  get(project: string, id: string): IntegrationRecord {
    const record = this.store.get<IntegrationRecord>("integration_records", project, id);
    if (!record) throw new Error("Unknown integration in current project scope.");
    return record;
  }
  list(project: string, limit = 200, after = ""): IntegrationRecord[] { return this.store.list("integration_records", project, limit, after); }
  create(project: string, taskId: string, sessionId: string, candidateRef = "HEAD"): IntegrationRecord {
    integrationUpdateSchema.parse({ candidateRef });
    const task = this.coordinator.get(taskId), session = this.sessions.get(sessionId), binding = this.bindings.get(project, taskId);
    if (task.projectKey !== project || session.projectKey !== project || !binding || binding.sessionId !== sessionId
      || !binding.workspaceId) throw new Error("Integration requires a provisioned task/session binding in current project scope.");
    const now = new Date().toISOString(), id = "int_" + randomUUID();
    return this.store.insert("integration_records", {
      id, integrationId: id, projectKey: project, taskId, sessionId, binding, candidateRef,
      diffReady: false, conflictState: "unknown", testEvidence: [], integrationWorktreeState: "unchecked",
      reviewState: "pending", mergeReady: false, readyReview: false, gates: {}, revision: 1, createdAt: now, updatedAt: now,
    });
  }
  update(project: string, id: string, expectedRevision: number, input: IntegrationUpdate): IntegrationRecord {
    const patch = integrationUpdateSchema.parse(input), record = this.get(project, id);
    const evidence = patch.testEvidence ?? record.testEvidence;
    const reviewedCommit = patch.reviewState === "approved" ? evidence[0]?.commit : record.reviewedCommit;
    if (patch.reviewState === "approved" && (!reviewedCommit || evidence.some(e => e.commit !== reviewedCommit))) {
      throw new Error("Review approval requires evidence for one explicit candidate commit.");
    }
    // Any evidence/ref/review edit invalidates the previous gate snapshot.
    return this.store.update("integration_records", { ...record, ...patch, reviewedCommit, mergeReady: false, readyReview: false,
      gates: {}, checkedAt: undefined, updatedAt: new Date().toISOString() }, expectedRevision);
  }
  async gate(project: string, id: string, expectedRevision: number): Promise<IntegrationRecord> {
    const record = this.get(project, id);
    if (record.revision !== expectedRevision) throw new Error("Integration revision conflict.");
    const task = this.coordinator.get(record.taskId), session = this.sessions.get(record.sessionId);
    const root = record.binding.worktreeRoot!;
    const stats = await lstat(root).catch(() => undefined);
    const exists = Boolean(stats?.isDirectory() && !stats.isSymbolicLink());
    let candidateCommit: string | undefined, diffReady = false, clean = false, conflictClean = false, candidateIsHead = false;
    if (exists) {
      try {
        const git = async (...args: string[]) => (await exec("git", args, { cwd: await realpath(root), timeout: 15000, maxBuffer: 1024 * 1024 })).stdout.trim();
        candidateCommit = await git("rev-parse", "--verify", "--end-of-options", record.candidateRef + "^{commit}");
        candidateIsHead = candidateCommit === await git("rev-parse", "HEAD");
        diffReady = (await git("diff", "--name-only", record.binding.baseSha!, candidateCommit, "--")).length > 0;
        clean = (await git("status", "--porcelain=v1")).length === 0;
        conflictClean = (await git("ls-files", "--unmerged")).length === 0;
      } catch { /* Missing commits or inaccessible Git state fail closed. */ }
    }
    const events = this.sessions.events(session.id, 500);
    const latestTest = events.filter(e => e.kind === "test_run").sort((a, b) => b.id - a.id)[0];
    const tests = record.testEvidence.length > 0 && record.testEvidence.every(evidence => {
      const event = events.find(e => e.id === evidence.eventId);
      return evidence.commit === candidateCommit && event?.kind === "test_run" && event.detail.passed === true
        && (!session.lastFileChangeAt || event.createdAt >= session.lastFileChangeAt);
    }) && latestTest?.detail.passed === true;
    const scopedSessions = this.sessions.list({ projectKey: project, limit: 500 });
    const conflicts = detectOrchestrationConflicts(scopedSessions, this.sessions.fileIntents(), 500);
    const overlap = conflicts.some(c => c.severity === "high" && (c.sessionA === session.id || c.sessionB === session.id));
    const gates = {
      taskReady: task.state === "completed" || (task.state === "claimed" && task.ownerSessionId === session.id && session.state === "ready_review" && Date.parse(task.leaseExpiresAt ?? "") > Date.now()),
      candidateAvailable: Boolean(candidateCommit) && candidateIsHead, worktreeExists: exists,
      diffReady, testEvidence: Boolean(tests), conflictScanClean: conflictClean, noHighSeverityOverlap: !overlap && conflicts.length < 500,
      integrationStateValid: clean && record.reviewState !== "changes_requested" && scopedSessions.length < 500,
      reviewApproved: record.reviewState === "approved" && record.reviewedCommit === candidateCommit,
    };
    const readyReview = Object.entries(gates).filter(([key]) => key !== "reviewApproved").every(([, value]) => value);
    const now = new Date().toISOString();
    return this.store.update<IntegrationRecord>("integration_records", { ...record, candidateCommit, diffReady, gates, readyReview,
      mergeReady: readyReview && gates.reviewApproved, conflictState: conflictClean ? "clean" : "conflict",
      integrationWorktreeState: !exists ? "missing" : clean ? "clean" : "dirty", checkedAt: now, updatedAt: now,
    }, expectedRevision);
  }
}
