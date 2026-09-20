import { randomUUID } from "node:crypto";
import { openDatabase, type DatabaseHandle } from "./db/client.js";

export const coordinatorTaskStates = [
  "pending",
  "claimed",
  "completed",
  "failed",
  "cancelled",
] as const;

export type CoordinatorTaskState = (typeof coordinatorTaskStates)[number];

export interface CoordinatorTask {
  id: string;
  projectKey: string;
  name: string;
  description: string;
  state: CoordinatorTaskState;
  priority: number;
  revision: number;
  ownerSessionId?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  attemptId?: string;
  leaseGeneration: number;
  ownerWorkerIncarnationId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  dependencies: string[];
}

interface TaskRow {
  id: string;
  project_key: string;
  name: string;
  description: string;
  state: string;
  priority: number;
  revision: number;
  owner_session_id: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  attempt_id: string | null;
  lease_generation: number;
  owner_worker_incarnation_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface DependencyRow {
  task_id: string;
  depends_on_task_id: string;
}

export class CoordinatorStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  createPlan(
    projectKey: string,
    tasks: Array<{
      id: string;
      name: string;
      description: string;
      priority: number;
      dependencies: string[];
    }>,
    now: string,
  ): CoordinatorTask[] {
    const insertTask = this.database.sqlite.prepare(
      "insert into coordinator_tasks (id, project_key, name, description, state, priority, revision, created_at, updated_at) values (?, ?, ?, ?, 'pending', ?, 1, ?, ?)",
    );
    const insertDependency = this.database.sqlite.prepare(
      "insert into coordinator_task_dependencies (task_id, depends_on_task_id) values (?, ?)",
    );
    const tx = this.database.sqlite.transaction(() => {
      for (const task of tasks) {
        insertTask.run(
          task.id,
          projectKey,
          task.name,
          task.description,
          task.priority,
          now,
          now,
        );
      }
      for (const task of tasks) {
        for (const dependency of task.dependencies) {
          insertDependency.run(task.id, dependency);
        }
      }
    });
    tx.immediate();
    return tasks.map((task) => this.getTask(task.id)!);
  }

  getTask(taskId: string): CoordinatorTask | undefined {
    const row = this.database.sqlite
      .prepare("select * from coordinator_tasks where id = ?")
      .get(taskId) as TaskRow | undefined;
    return row ? this.taskFromRow(row) : undefined;
  }

  listTasks(projectKey: string, limit = 500): CoordinatorTask[] {
    const bounded = Math.max(1, Math.min(limit, 500));
    const rows = this.database.sqlite.prepare(
      "select * from coordinator_tasks where project_key = ? order by priority desc, created_at asc, id asc limit ?",
    ).all(projectKey, bounded) as TaskRow[];
    return rows.map((row) => this.taskFromRow(row));
  }

  /** Scheduling is not a page of history. Filter eligibility before ordering. */
  readyTasks(projectKey: string, now: string): CoordinatorTask[] {
    if (!Number.isFinite(Date.parse(now))) throw new Error("Invalid coordinator clock.");
    const rows = this.database.sqlite.prepare(`
      select task.* from coordinator_tasks task
      where task.project_key = ?
        and (task.state = 'pending' or
          (task.state = 'claimed' and julianday(task.lease_expires_at) <= julianday(?)))
        and not exists (
          select 1 from coordinator_task_dependencies dep
          left join coordinator_tasks parent on parent.id = dep.depends_on_task_id
          where dep.task_id = task.id and
            (parent.id is null or parent.project_key <> task.project_key or parent.state <> 'completed')
        )
      order by task.priority desc, task.created_at asc, task.id asc
    `).all(projectKey, now) as TaskRow[];
    return rows.map((row) => this.taskFromRow(row));
  }

  updateClaim(input: {
    taskId: string;
    expectedRevision: number;
    ownerSessionId: string;
    leaseToken: string;
    leaseExpiresAt: string;
    attemptId?: string;
    ownerWorkerIncarnationId?: string;
    now: string;
  }): CoordinatorTask {
    const attemptId = input.attemptId ?? "attempt_" + randomUUID().replaceAll("-", "").slice(0, 20);
    const workerIncarnationId = input.ownerWorkerIncarnationId ?? (this.database.sqlite.prepare(
      "select worker_incarnation_id from orchestration_sessions where id = ?",
    ).get(input.ownerSessionId) as { worker_incarnation_id: string | null } | undefined)?.worker_incarnation_id;
    if (!workerIncarnationId) throw new Error("Coordinator claim requires a durable worker incarnation.");
    const result = this.database.sqlite.prepare(
      `update coordinator_tasks set state = 'claimed', owner_session_id = ?, lease_token = ?, lease_expires_at = ?,
       attempt_id = ?, lease_generation = lease_generation + 1, owner_worker_incarnation_id = ?, revision = revision + 1, updated_at = ?
       where id = ? and revision = ?
         and (state = 'pending' or (state = 'claimed' and julianday(lease_expires_at) <= julianday(?)))
         and exists (select 1 from orchestration_sessions owner where owner.id = ?
           and owner.project_key = coordinator_tasks.project_key and owner.state not in ('completed', 'failed', 'abandoned'))
         and not exists (select 1 from coordinator_task_dependencies dep
           left join coordinator_tasks parent on parent.id = dep.depends_on_task_id
           where dep.task_id = coordinator_tasks.id and
             (parent.id is null or parent.project_key <> coordinator_tasks.project_key or parent.state <> 'completed'))`,
    ).run(
      input.ownerSessionId,
      input.leaseToken,
      input.leaseExpiresAt,
      attemptId,
      workerIncarnationId,
      input.now,
      input.taskId,
      input.expectedRevision,
      input.now,
      input.ownerSessionId,
    );
    if (result.changes !== 1) throw new Error("Coordinator task revision conflict.");
    return this.getTask(input.taskId)!;
  }

  releaseClaim(input: {
    taskId: string;
    expectedRevision: number;
    ownerSessionId: string;
    leaseToken: string;
    now: string;
  }): CoordinatorTask {
    const result = this.database.sqlite.prepare(
      `update coordinator_tasks set state = 'pending', owner_session_id = null, lease_token = null, lease_expires_at = null,
       attempt_id = null, owner_worker_incarnation_id = null, revision = revision + 1, updated_at = ?
       where id = ? and revision = ? and state = 'claimed' and owner_session_id = ? and lease_token = ?
         and julianday(lease_expires_at) > julianday(?)
         and owner_worker_incarnation_id = (select worker_incarnation_id from orchestration_sessions where id = ?)`,
    ).run(
      input.now,
      input.taskId,
      input.expectedRevision,
      input.ownerSessionId,
      input.leaseToken,
      input.now,
      input.ownerSessionId,
    );
    if (result.changes !== 1) throw new Error("Coordinator lease or revision mismatch.");
    return this.getTask(input.taskId)!;
  }

  completeClaim(input: {
    taskId: string;
    expectedRevision: number;
    ownerSessionId: string;
    leaseToken: string;
    now: string;
  }): CoordinatorTask {
    const result = this.database.sqlite.prepare(
      `update coordinator_tasks set state = 'completed', owner_session_id = null, lease_token = null, lease_expires_at = null,
       completed_at = ?, revision = revision + 1, updated_at = ?
       where id = ? and revision = ? and state = 'claimed' and owner_session_id = ? and lease_token = ?
         and julianday(lease_expires_at) > julianday(?)
         and owner_worker_incarnation_id = (select worker_incarnation_id from orchestration_sessions where id = ?)`,
    ).run(
      input.now,
      input.now,
      input.taskId,
      input.expectedRevision,
      input.ownerSessionId,
      input.leaseToken,
      input.now,
      input.ownerSessionId,
    );
    if (result.changes !== 1) throw new Error("Coordinator lease or revision mismatch.");
    return this.getTask(input.taskId)!;
  }

  setTerminalState(input: {
    taskId: string;
    expectedRevision: number;
    state: "failed" | "cancelled";
    now: string;
  }): CoordinatorTask {
    const result = this.database.sqlite.prepare(
      "update coordinator_tasks set state = ?, owner_session_id = null, lease_token = null, lease_expires_at = null, revision = revision + 1, updated_at = ? where id = ? and revision = ? and state not in ('completed', 'failed', 'cancelled')",
    ).run(input.state, input.now, input.taskId, input.expectedRevision);
    if (result.changes !== 1) throw new Error("Coordinator task revision conflict or terminal task.");
    return this.getTask(input.taskId)!;
  }

  dependencyStates(taskId: string): Array<{ id: string; state: CoordinatorTaskState }> {
    const rows = this.database.sqlite.prepare(
      "select parent.id, parent.state from coordinator_task_dependencies dep join coordinator_tasks parent on parent.id = dep.depends_on_task_id where dep.task_id = ? order by parent.id asc",
    ).all(taskId) as Array<{ id: string; state: string }>;
    return rows.map((row) => ({
      id: row.id,
      state: assertTaskState(row.state),
    }));
  }

  close(): void {
    this.database.close();
  }

  allTasks(projectKey: string): CoordinatorTask[] {
    const rows = this.database.sqlite.prepare("select * from coordinator_tasks where project_key = ? order by priority desc, created_at asc, id asc")
      .all(projectKey) as TaskRow[];
    return rows.map(row => this.taskFromRow(row));
  }

  private taskFromRow(row: TaskRow): CoordinatorTask {
    const dependencies = this.database.sqlite.prepare(
      "select task_id, depends_on_task_id from coordinator_task_dependencies where task_id = ? order by depends_on_task_id asc",
    ).all(row.id) as DependencyRow[];
    return {
      id: row.id,
      projectKey: row.project_key,
      name: row.name,
      description: row.description,
      state: assertTaskState(row.state),
      priority: row.priority,
      revision: row.revision,
      ownerSessionId: row.owner_session_id ?? undefined,
      leaseToken: row.lease_token ?? undefined,
      leaseExpiresAt: row.lease_expires_at ?? undefined,
      attemptId: row.attempt_id ?? undefined,
      leaseGeneration: row.lease_generation,
      ownerWorkerIncarnationId: row.owner_worker_incarnation_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at ?? undefined,
      dependencies: dependencies.map((dependency) => dependency.depends_on_task_id),
    };
  }
}

export function newCoordinatorTaskId(): string {
  return "ctask_" + randomUUID().replaceAll("-", "").slice(0, 16);
}

function assertTaskState(value: string): CoordinatorTaskState {
  if (!coordinatorTaskStates.includes(value as CoordinatorTaskState)) {
    throw new Error("Invalid coordinator task state: " + value);
  }
  return value as CoordinatorTaskState;
}
