import { randomUUID } from "node:crypto";
import * as z from "zod/v4";
import type { OrchestrationCoordinator } from "./orchestration-coordinator.js";
import type { OrchestrationRegistry } from "./orchestration-registry.js";
import type { WorktreeBinding, WorktreeOrchestrator } from "./orchestration-worktrees.js";
import { detectOrchestrationConflicts } from "./orchestration-conflicts.js";
import { OrchestrationV2Store, type DurableRecord } from "./orchestration-v2-store.js";
import { MERGE_POLICY, mergeInputsUnchanged, probeCandidateMerge, type MergeProbeInput, type MergeProbeResult } from "./integration-merge-probe.js";

const refSchema = z.string().min(1).max(200).refine(s => !s.startsWith("-") && !/[\x00-\x20\x7f]/.test(s), "Ref cannot be an option or contain whitespace/control characters");
export const integrationUpdateSchema = z.object({
  candidateRef: refSchema.optional(),
  targetRef: refSchema.optional(),
  testEvidence: z.array(z.object({ eventId: z.number().int().positive(), commit: z.string().regex(/^[a-f0-9]{40,64}$/) })).max(50).optional(),
  reviewState: z.enum(["pending", "in_review", "approved", "changes_requested"]).optional(),
});
type IntegrationUpdate = z.infer<typeof integrationUpdateSchema>;
export interface IntegrationRecord extends DurableRecord {
  integrationId: string; taskId: string; sessionId: string; binding: WorktreeBinding;
  candidateRef: string; candidateCommit?: string; diffReady: boolean;
  targetRef?: string; targetCommit?: string; candidateTree?: string; targetTree?: string;
  mergeStrategy?: string; policyRevision?: string; evaluationGeneration?: number;
  evaluationState?: "unchecked" | "running" | "checked" | "stale";
  probeError?: string;
  conflictState: "unknown" | "clean" | "conflict";
  testEvidence: Array<{ eventId: number; commit: string }>;
  integrationWorktreeState: "unchecked" | "clean" | "dirty" | "missing";
  reviewState: "pending" | "in_review" | "approved" | "changes_requested";
  reviewedCommit?: string;
  mergeReady: boolean; readyReview: boolean; gates: Record<string, boolean>; checkedAt?: string;
}

export class IntegrationManager {
  constructor(private readonly store: OrchestrationV2Store, private readonly coordinator: OrchestrationCoordinator,
    private readonly sessions: OrchestrationRegistry, private readonly bindings: WorktreeOrchestrator,
    private readonly probe: (input: MergeProbeInput) => Promise<MergeProbeResult> = probeCandidateMerge) {}
  get(project: string, id: string): IntegrationRecord {
    const record = this.store.get<IntegrationRecord>("integration_records", project, id);
    if (!record) throw new Error("Unknown integration in current project scope.");
    return record;
  }
  list(project: string, limit = 200, after = ""): IntegrationRecord[] { return this.store.list("integration_records", project, limit, after); }
  create(project: string, taskId: string, sessionId: string, candidateRef = "HEAD", targetRef = "HEAD"): IntegrationRecord {
    integrationUpdateSchema.parse({ candidateRef, targetRef });
    const task = this.coordinator.get(taskId), session = this.sessions.get(sessionId), binding = this.bindings.get(project, taskId);
    if (task.projectKey !== project || session.projectKey !== project || !binding || binding.sessionId !== sessionId
      || !binding.workspaceId) throw new Error("Integration requires a provisioned task/session binding in current project scope.");
    const now = new Date().toISOString(), id = "int_" + randomUUID();
    return this.store.insert("integration_records", {
      id, integrationId: id, projectKey: project, taskId, sessionId, binding, candidateRef, targetRef,
      evaluationGeneration: 0, evaluationState: "unchecked", policyRevision: MERGE_POLICY, mergeStrategy: "ort",
      diffReady: false, conflictState: "unknown", testEvidence: [], integrationWorktreeState: "unchecked",
      reviewState: "pending", mergeReady: false, readyReview: false, gates: {}, revision: 1, createdAt: now, updatedAt: now,
    });
  }
  update(project: string, id: string, expectedRevision: number, input: IntegrationUpdate): IntegrationRecord {
    const patch = integrationUpdateSchema.parse(input), record = this.get(project, id);
    const evidence = patch.testEvidence ?? record.testEvidence;
    const refsChanged = (patch.candidateRef !== undefined && patch.candidateRef !== record.candidateRef)
      || (patch.targetRef !== undefined && patch.targetRef !== (record.targetRef ?? "HEAD"));
    const reviewedCommit = patch.reviewState === "approved" ? evidence[0]?.commit : refsChanged ? undefined : record.reviewedCommit;
    if (patch.reviewState === "approved" && (!reviewedCommit || evidence.some(e => e.commit !== reviewedCommit))) {
      throw new Error("Review approval requires evidence for one explicit candidate commit.");
    }
    // Any evidence/ref/review edit invalidates the previous gate snapshot.
    return this.store.update("integration_records", { ...record, ...patch, reviewedCommit, mergeReady: false, readyReview: false,
      reviewState: refsChanged && patch.reviewState !== "approved" ? "pending" : patch.reviewState ?? record.reviewState,
      evaluationGeneration: (record.evaluationGeneration ?? 0) + 1, evaluationState: "unchecked",
      gates: {}, checkedAt: undefined, updatedAt: new Date().toISOString() }, expectedRevision);
  }
  async gate(project: string, id: string, expectedRevision: number): Promise<IntegrationRecord> {
    // Reserve and invalidate any previous success before awaiting Git. A crash
    // therefore leaves a non-authoritative 'running' observation, never old green.
    const capture = this.store.transaction(() => {
      const current = this.get(project, id);
      if (current.revision !== expectedRevision) throw new Error("Integration revision conflict.");
      const task = this.coordinator.get(current.taskId), session = this.sessions.get(current.sessionId);
      const binding = this.bindings.get(project, current.taskId);
      if (task.projectKey !== project || session.projectKey !== project || !binding
        || binding.sessionId !== session.id || !binding.workspaceId || !binding.worktreeRoot) {
        throw new Error("Integration requires a current binding in project scope.");
      }
      const record = this.store.update<IntegrationRecord>("integration_records", { ...current, binding,
        targetRef: current.targetRef ?? "HEAD", policyRevision: MERGE_POLICY, mergeStrategy: "ort",
        evaluationGeneration: (current.evaluationGeneration ?? 0) + 1, evaluationState: "running",
        readyReview: false, mergeReady: false, gates: {}, checkedAt: undefined, probeError: undefined,
        updatedAt: new Date().toISOString(),
      }, expectedRevision);
      return { record, task, session, binding };
    });
    const { record, binding } = capture;
    const input: MergeProbeInput = { candidateRoot: binding.worktreeRoot!, sourceRoot: binding.sourceRoot,
      candidateRef: record.candidateRef, targetRef: record.targetRef! };
    let probe: MergeProbeResult;
    try { probe = await this.probe(input); }
    catch { probe = { conflictState: "unknown", diffReady: false, policy: MERGE_POLICY, errorCode: "git_probe_failed" }; }
    const refsStable = await mergeInputsUnchanged(input, probe.observation);
    // This immediate transaction excludes competing database writers. The
    // separate store handles read the same database while no external work awaits.
    return this.store.transaction(() => {
      const current = this.get(project, id);
      if (current.revision !== record.revision || current.evaluationGeneration !== record.evaluationGeneration) {
        throw new Error("Integration evaluation stale: review generation changed.");
      }
      const task = this.coordinator.get(record.taskId), session = this.sessions.get(record.sessionId);
      const currentBinding = this.bindings.get(project, record.taskId);
      const stateStable = JSON.stringify(task) === JSON.stringify(capture.task)
        && JSON.stringify(session) === JSON.stringify(capture.session)
        && JSON.stringify(currentBinding) === JSON.stringify(binding);
      const observation = probe.observation, candidateCommit = observation?.candidateOid;
      const clean = observation?.candidateStatus === "";
      const currentBindingValid = currentBinding?.status === "active" && currentBinding.workspaceId === session.workspaceId;
      // Legacy event evidence is retained for compatibility here, not promoted
      // into execution-issued evidence. The A1/A2 trust boundary remains separate.
      const latestTest = this.sessions.latestEvent(session.id, "test_run");
      const tests = record.testEvidence.length > 0 && record.testEvidence.every(evidence => {
        const event = this.sessions.event(session.id, evidence.eventId);
        return evidence.commit === candidateCommit && event?.kind === "test_run" && event.detail.passed === true
          && (!session.lastFileChangeAt || event.createdAt >= session.lastFileChangeAt);
      }) && latestTest?.detail.passed === true;
      const scopedSessions = this.sessions.all(project);
      const ids = new Set(scopedSessions.map(s => s.id));
      const conflicts = detectOrchestrationConflicts(scopedSessions,
        this.sessions.fileIntents().filter(intent => ids.has(intent.sessionId)), Number.POSITIVE_INFINITY);
      const overlap = conflicts.some(c => c.severity === "high" && (c.sessionA === session.id || c.sessionB === session.id));
      const fresh = stateStable && refsStable && probe.policy === record.policyRevision;
      const gates = {
        evaluationFresh: fresh,
        taskReady: task.state === "completed" || (task.state === "claimed" && task.ownerSessionId === session.id
          && session.state === "ready_review" && Date.parse(task.leaseExpiresAt ?? "") > Date.now()),
        candidateAvailable: Boolean(candidateCommit) && candidateCommit === observation?.candidateHead,
        targetAvailable: Boolean(observation?.targetOid), worktreeExists: Boolean(observation),
        diffReady: probe.diffReady, testEvidence: Boolean(tests), conflictScanClean: probe.conflictState === "clean",
        noHighSeverityOverlap: !overlap,
        integrationStateValid: clean && observation?.targetStatus === "" && currentBindingValid && record.reviewState !== "changes_requested",
        reviewApproved: record.reviewState === "approved" && record.reviewedCommit === candidateCommit,
      };
      const readyReview = Object.entries(gates).filter(([key]) => key !== "reviewApproved").every(([, value]) => value);
      const now = new Date().toISOString();
      this.store.update<IntegrationRecord>("integration_records", { ...record, candidateCommit,
        targetCommit: observation?.targetOid, candidateTree: observation?.candidateTree, targetTree: observation?.targetTree,
        diffReady: probe.diffReady, gates, readyReview, mergeReady: readyReview && gates.reviewApproved,
        evaluationState: fresh ? "checked" : "stale", probeError: probe.errorCode,
        conflictState: fresh ? probe.conflictState : "unknown",
        integrationWorktreeState: !observation ? "missing" : clean ? "clean" : "dirty", checkedAt: now, updatedAt: now,
      }, record.revision);
      // Return the persisted representation, including JSON's omission of
      // undefined optional fields, so restart and immediate responses agree.
      return this.get(project, id);
    });
  }
}
