import { stat } from "node:fs/promises";
import type { WorkspaceRegistry, Workspace } from "./workspaces.js";
import type { WorkspaceAccessManager } from "./workspace-access.js";
import type { OrchestrationCoordinator } from "./orchestration-coordinator.js";
import type { OrchestrationRegistry } from "./orchestration-registry.js";
import { projectKeyForWorkspace } from "./orchestration-scope.js";
import { OrchestrationV2Store, type DurableRecord } from "./orchestration-v2-store.js";

export interface WorktreeBinding extends DurableRecord {
  taskId: string;
  sessionId: string;
  workspaceId?: string;
  sourceRoot: string;
  worktreeRoot?: string;
  baseRef: string;
  baseSha?: string;
  ref?: string;
  managed: true;
  dirtySource?: boolean;
  status: "provisioning" | "active" | "cleanup_eligible";
}
export interface ProvisionInput {
  taskId: string; sessionId: string; leaseToken: string; expectedRevision: number; baseRef?: string;
}

export class WorktreeOrchestrator {
  private readonly pending = new Map<string, Promise<WorktreeBinding>>();
  constructor(
    private readonly store: OrchestrationV2Store,
    private readonly coordinator: OrchestrationCoordinator,
    private readonly sessions: OrchestrationRegistry,
    private readonly workspaces: WorkspaceRegistry,
    private readonly access: WorkspaceAccessManager,
  ) {}
  list(projectKey: string, limit = 200, after = ""): WorktreeBinding[] {
    return this.store.list("worktree_bindings", projectKey, limit, after);
  }
  get(projectKey: string, taskId: string): WorktreeBinding | undefined {
    return this.store.get("worktree_bindings", projectKey, taskId);
  }
  async provision(source: Workspace, input: ProvisionInput): Promise<WorktreeBinding> {
    this.access.assertWorkspaceModifiable(source);
    const projectKey = projectKeyForWorkspace(source);
    this.assertLease(projectKey, input);
    if (this.list(projectKey, 500).some(binding => binding.sessionId === input.sessionId && binding.taskId !== input.taskId
      && !["completed", "failed", "cancelled"].includes(this.coordinator.get(binding.taskId).state))) {
      throw new Error("Session already has another active task worktree binding.");
    }
    const current = this.get(projectKey, input.taskId);
    if (current && (current.sessionId !== input.sessionId || (input.baseRef && current.baseRef !== input.baseRef))) {
      throw new Error("Task worktree binding already belongs to another session or base ref.");
    }
    if (current?.workspaceId) {
      if (!(await stat(current.worktreeRoot!)).isDirectory()) throw new Error("Bound worktree is unavailable.");
      this.workspaces.getWorkspace(current.workspaceId);
      this.assertLease(projectKey, input);
      this.sessions.bindWorkspace(input.sessionId, projectKey, current.workspaceId, current.worktreeRoot!);
      return current;
    }
    const running = this.pending.get(input.taskId);
    if (running) return running;
    const operation = this.provisionReserved(source, projectKey, input);
    this.pending.set(input.taskId, operation);
    try { return await operation; } finally { this.pending.delete(input.taskId); }
  }
  private async provisionReserved(source: Workspace, projectKey: string, input: ProvisionInput): Promise<WorktreeBinding> {
    const now = new Date().toISOString();
    const reservation = this.store.transaction(() => this.get(projectKey, input.taskId) ?? this.store.insert<WorktreeBinding>("worktree_bindings", {
      id: input.taskId, taskId: input.taskId, projectKey, sessionId: input.sessionId,
      sourceRoot: source.sourceRoot ?? source.root, baseRef: input.baseRef ?? "HEAD", managed: true,
      status: "provisioning", revision: 1, createdAt: now, updatedAt: now,
    }));
    if (reservation.sessionId !== input.sessionId) throw new Error("Task binding belongs to another session.");
    const { workspace } = await this.workspaces.openWorkspace({
      path: reservation.sourceRoot, mode: "worktree", baseRef: reservation.baseRef,
      managedKey: projectKey + ":" + input.taskId,
    }, { allowedRoots: this.access.workspaceRestoreAllowedRoots(source), accessMode: source.accessMode, accessGrantId: source.accessGrantId });
    // A slow provision must not bypass a changed/expired coordinator lease.
    this.assertLease(projectKey, input);
    if (projectKeyForWorkspace(workspace) !== projectKey) throw new Error("Worktree project scope differs from source; open the repository root before provisioning.");
    const existing = this.get(projectKey, input.taskId)!;
    if (existing.workspaceId) return existing;
    const binding = this.store.update("worktree_bindings", {
      ...existing, workspaceId: workspace.id, worktreeRoot: workspace.root,
      baseSha: workspace.worktree!.baseSha, ref: "detached:" + workspace.worktree!.baseSha,
      dirtySource: workspace.worktree!.dirtySource, status: "active" as const, updatedAt: new Date().toISOString(),
    }, existing.revision);
    this.sessions.bindWorkspace(input.sessionId, projectKey, workspace.id, workspace.root);
    return binding;
  }
  cleanup(projectKey: string, taskId: string, expectedRevision: number): WorktreeBinding {
    const binding = this.get(projectKey, taskId);
    if (!binding) throw new Error("Unknown worktree binding in project scope.");
    const task = this.coordinator.get(taskId);
    if (!["completed", "failed", "cancelled"].includes(task.state)) throw new Error("Active task is not eligible for cleanup.");
    return this.store.update("worktree_bindings", { ...binding, status: "cleanup_eligible" as const, updatedAt: new Date().toISOString() }, expectedRevision);
  }
  private assertLease(projectKey: string, input: ProvisionInput): void {
    const task = this.coordinator.get(input.taskId), session = this.sessions.get(input.sessionId);
    if (task.projectKey !== projectKey || session.projectKey !== projectKey) throw new Error("Task/session outside current project scope.");
    if (task.revision !== input.expectedRevision) throw new Error("Coordinator revision conflict.");
    if (task.state !== "claimed" || task.ownerSessionId !== session.id || task.leaseToken !== input.leaseToken
      || !task.leaseExpiresAt || Date.parse(task.leaseExpiresAt) <= Date.now()
      || ["completed", "failed", "abandoned"].includes(session.state)) throw new Error("Valid task lease for this session is required.");
  }
}
