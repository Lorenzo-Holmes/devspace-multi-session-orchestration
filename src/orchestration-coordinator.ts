import { randomUUID } from "node:crypto";
import {
  CoordinatorStore,
  newCoordinatorTaskId,
  type CoordinatorTask,
} from "./coordinator-store.js";
import { OrchestrationRegistry } from "./orchestration-registry.js";

export class OrchestrationCoordinator {
  private readonly listeners = new Set<(project: string) => void>();
  onChange(listener: (project: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private changed<T extends CoordinatorTask | CoordinatorTask[]>(value: T): T {
    const project = Array.isArray(value) ? value[0]?.projectKey : value.projectKey;
    if (project) for (const listener of this.listeners) { try { listener(project); } catch { /* Best-effort metadata observer. */ } }
    return value;
  }
  constructor(
    private readonly store: CoordinatorStore,
    private readonly sessions: OrchestrationRegistry,
  ) {}

  createPlan(
    projectKey: string,
    specs: Array<{
      name: string;
      description: string;
      priority?: number;
      dependencies?: string[];
    }>,
    now = new Date().toISOString(),
  ): CoordinatorTask[] {
    if (specs.length < 1 || specs.length > 100) {
      throw new Error("Coordinator plans require 1 to 100 tasks.");
    }
    const normalized = specs.map((spec) => ({
      name: spec.name.trim(),
      description: spec.description.trim(),
      priority: Math.max(-100, Math.min(100, spec.priority ?? 0)),
      dependencies: [...new Set((spec.dependencies ?? []).map((name) => name.trim()))],
    }));
    if (normalized.some((task) => !task.name || !task.description)) {
      throw new Error("Coordinator task name and description are required.");
    }
    const names = new Set<string>();
    for (const task of normalized) {
      if (names.has(task.name)) throw new Error("Coordinator task names must be unique.");
      names.add(task.name);
    }
    for (const task of normalized) {
      for (const dependency of task.dependencies) {
        if (!names.has(dependency)) {
          throw new Error("Unknown coordinator dependency: " + dependency);
        }
        if (dependency === task.name) {
          throw new Error("Coordinator tasks cannot depend on themselves.");
        }
      }
    }
    assertAcyclic(normalized);
    const ids = new Map(normalized.map((task) => [task.name, newCoordinatorTaskId()]));
    return this.changed(this.store.createPlan(
      projectKey,
      normalized.map((task) => ({
        id: ids.get(task.name)!,
        name: task.name,
        description: task.description,
        priority: task.priority,
        dependencies: task.dependencies.map((dependency) => ids.get(dependency)!),
      })),
      now,
    ));
  }

  list(projectKey: string): CoordinatorTask[] {
    return this.store.listTasks(projectKey);
  }

  get(taskId: string): CoordinatorTask {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error("Unknown coordinator task: " + taskId);
    return task;
  }

  readyQueue(projectKey: string, now = new Date()): CoordinatorTask[] {
    return this.store.readyTasks(projectKey, now.toISOString());
  }

  claim(input: {
    taskId: string;
    sessionId: string;
    expectedRevision: number;
    leaseMs?: number;
    now?: Date;
  }): CoordinatorTask {
    const now = input.now ?? new Date();
    const task = this.get(input.taskId);
    const session = this.sessions.get(input.sessionId);
    if (session.projectKey !== task.projectKey) {
      throw new Error("Coordinator session and task are in different project scopes.");
    }
    if (["completed", "failed", "abandoned"].includes(session.state)) {
      throw new Error("Terminal sessions cannot claim coordinator tasks.");
    }
    if (!this.dependenciesComplete(task)) {
      throw new Error("Coordinator task dependencies are not complete.");
    }
    if (task.state === "claimed" && task.leaseExpiresAt && Date.parse(task.leaseExpiresAt) > now.getTime()) {
      throw new Error("Coordinator task already has an active lease.");
    }
    if (task.state !== "pending" && task.state !== "claimed") {
      throw new Error("Coordinator task is not claimable.");
    }
    const leaseMs = Math.max(60_000, Math.min(input.leaseMs ?? 10 * 60_000, 60 * 60_000));
    return this.changed(this.store.updateClaim({
      taskId: task.id,
      expectedRevision: input.expectedRevision,
      ownerSessionId: session.id,
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
      now: now.toISOString(),
    }));
  }

  release(input: {
    taskId: string;
    sessionId: string;
    leaseToken: string;
    expectedRevision: number;
    now?: Date;
  }): CoordinatorTask {
    return this.changed(this.store.releaseClaim({
      taskId: input.taskId,
      expectedRevision: input.expectedRevision,
      ownerSessionId: input.sessionId,
      leaseToken: input.leaseToken,
      now: (input.now ?? new Date()).toISOString(),
    }));
  }

  complete(input: {
    taskId: string;
    sessionId: string;
    leaseToken: string;
    expectedRevision: number;
    now?: Date;
  }): CoordinatorTask {
    const task = this.get(input.taskId);
    if (task.leaseExpiresAt && Date.parse(task.leaseExpiresAt) <= (input.now ?? new Date()).getTime()) {
      throw new Error("Coordinator task lease has expired.");
    }
    return this.changed(this.store.completeClaim({
      taskId: input.taskId,
      expectedRevision: input.expectedRevision,
      ownerSessionId: input.sessionId,
      leaseToken: input.leaseToken,
      now: (input.now ?? new Date()).toISOString(),
    }));
  }

  fail(taskId: string, expectedRevision: number, now = new Date()): CoordinatorTask {
    return this.changed(this.store.setTerminalState({
      taskId,
      expectedRevision,
      state: "failed",
      now: now.toISOString(),
    }));
  }

  close(): void {
    this.store.close();
  }

  all(projectKey: string): CoordinatorTask[] { return this.store.allTasks(projectKey); }

  private dependenciesComplete(task: CoordinatorTask): boolean {
    return this.store.dependencyStates(task.id).every((dependency) => dependency.state === "completed");
  }
}

function assertAcyclic(tasks: Array<{ name: string; dependencies: string[] }>): void {
  const graph = new Map(tasks.map((task) => [task.name, task.dependencies]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string) => {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error("Coordinator dependency graph contains a cycle.");
    visiting.add(name);
    for (const dependency of graph.get(name) ?? []) visit(dependency);
    visiting.delete(name);
    visited.add(name);
  };
  for (const task of tasks) visit(task.name);
}
