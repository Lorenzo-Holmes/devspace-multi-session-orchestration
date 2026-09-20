import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { openDatabase, type DatabaseHandle } from "./db/client.js";

export const orchestrationSessionStates = [
  "queued",
  "running",
  "blocked_user",
  "blocked_tool",
  "waiting_test",
  "ready_review",
  "completed",
  "failed",
  "abandoned",
] as const;

export type OrchestrationSessionState = (typeof orchestrationSessionStates)[number];
export type OrchestrationFileAccess = "read" | "write";

export interface OrchestrationSession {
  id: string;
  /** Present for persisted sessions; optional only for legacy in-memory fixtures. */
  logicalSessionId?: string;
  /** Present for persisted sessions; optional only for legacy in-memory fixtures. */
  workerIncarnationId?: string;
  projectKey: string;
  workspaceId?: string;
  workspaceRoot: string;
  sessionKind: string;
  externalSessionId?: string;
  label?: string;
  state: OrchestrationSessionState;
  task?: string;
  lastHeartbeatAt?: string;
  lastActivityAt: string;
  lastTestAt?: string;
  lastTestAttemptAt?: string;
  lastSuccessfulValidationAt?: string;
  lastValidationFailureAt?: string;
  lastValidatedCommit?: string;
  lastValidatedTree?: string;
  lastValidatedFileGeneration?: number;
  revision?: number;
  incarnation?: number;
  bindingGeneration?: number;
  fileGeneration?: number;
  lastFileChangeAt?: string;
  lastErrorFingerprint?: string;
  consecutiveErrorCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface OrchestrationEvent {
  id: number;
  sessionId: string;
  kind: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface OrchestrationFileIntent {
  sessionId: string;
  path: string;
  access: OrchestrationFileAccess;
  createdAt: string;
}

interface SessionRow {
  id: string;
  logical_session_id: string | null;
  worker_incarnation_id: string | null;
  project_key: string;
  workspace_id: string | null;
  workspace_root: string;
  session_kind: string;
  external_session_id: string | null;
  label: string | null;
  state: string;
  task: string | null;
  last_heartbeat_at: string | null;
  last_activity_at: string;
  last_test_at: string | null;
  last_test_attempt_at: string | null;
  last_successful_validation_at: string | null;
  last_validation_failure_at: string | null;
  last_validated_commit: string | null;
  last_validated_tree: string | null;
  last_validated_file_generation: number | null;
  revision: number;
  incarnation: number;
  binding_generation: number;
  file_generation: number;
  last_file_change_at: string | null;
  last_error_fingerprint: string | null;
  consecutive_error_count: number;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: number;
  session_id: string;
  kind: string;
  detail_json: string;
  created_at: string;
}

interface IntentRow {
  session_id: string;
  path: string;
  access: string;
  created_at: string;
}

export type OrchestrationTestRunStatus = "started" | "running" | "passed" | "failed" | "cancelled" | "unknown";
export interface OrchestrationTestRun {
  testRunId: string;
  attemptId: string;
  executionTaskId?: string;
  leaseGeneration?: number;
  processSessionId?: string;
  projectKey: string;
  sessionId: string;
  kind: "test" | "build" | "typecheck";
  checkDefinition: string;
  requiresTestCount: boolean;
  command: string;
  workingDirectory: string;
  testedCommit?: string;
  testedTree?: string;
  environmentIdentity: string;
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  signal?: string;
  status: OrchestrationTestRunStatus;
  issuer: string;
  trustLevel: "unverified" | "execution_observed";
  sessionRevision: number;
  workerIncarnation: number;
  bindingGeneration: number;
  fileGeneration: number;
  revision: number;
  reason?: string;
  evidenceId?: string;
}

export interface OrchestrationExecutionEvidence {
  evidenceId: string;
  testRunId: string;
  attemptId: string;
  executionTaskId?: string;
  leaseGeneration?: number;
  projectKey: string;
  sessionId: string;
  testedCommit: string;
  testedTree: string;
  checkDefinition: string;
  environmentIdentity: string;
  exitStatus: 0;
  startedAt: string;
  completedAt: string;
  issuer: string;
  trustLevel: "execution_observed";
  workerIncarnation: number;
  bindingGeneration: number;
  fileGeneration: number;
}

export class OrchestrationStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  createSession(input: {
    projectKey: string;
    workspaceId?: string;
    workspaceRoot: string;
    sessionKind?: string;
    externalSessionId?: string;
    label?: string;
    state?: OrchestrationSessionState;
    task?: string;
    id?: string;
    now?: string;
  }): OrchestrationSession {
    const now = input.now ?? new Date().toISOString();
    const id = input.id ?? "sess_" + randomUUID().replaceAll("-", "").slice(0, 12);
    const session: OrchestrationSession = {
      id,
      logicalSessionId: "logical_" + id,
      workerIncarnationId: "worker_" + randomUUID().replaceAll("-", "").slice(0, 20),
      projectKey: input.projectKey,
      workspaceId: input.workspaceId,
      workspaceRoot: resolve(input.workspaceRoot),
      sessionKind: input.sessionKind ?? "chat",
      externalSessionId: input.externalSessionId,
      label: input.label,
      state: input.state ?? "queued",
      task: input.task,
      lastActivityAt: now,
      consecutiveErrorCount: 0,
      revision: 1,
      incarnation: 1,
      bindingGeneration: 1,
      fileGeneration: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.database.sqlite.prepare(
      `insert into orchestration_sessions (id, logical_session_id, worker_incarnation_id, project_key, workspace_id, workspace_root,
       session_kind, external_session_id, label, state, task, last_activity_at, consecutive_error_count, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      session.id,
      session.logicalSessionId,
      session.workerIncarnationId,
      session.projectKey,
      session.workspaceId ?? null,
      session.workspaceRoot,
      session.sessionKind,
      session.externalSessionId ?? null,
      session.label ?? null,
      session.state,
      session.task ?? null,
      session.lastActivityAt,
      session.consecutiveErrorCount,
      session.createdAt,
      session.updatedAt,
    );
    return session;
  }

  advanceWorkerIncarnation(id: string, expectedRevision: number, now = new Date().toISOString()): OrchestrationSession {
    const workerIncarnationId = "worker_" + randomUUID().replaceAll("-", "").slice(0, 20);
    const result = this.database.sqlite.prepare(`update orchestration_sessions
      set incarnation = incarnation + 1, worker_incarnation_id = ?, revision = revision + 1,
          last_activity_at = ?, updated_at = ?
      where id = ? and revision = ? and state not in ('completed','failed','abandoned')`)
      .run(workerIncarnationId, now, now, id, expectedRevision);
    if (result.changes !== 1) throw new Error("Session worker incarnation conflict or terminal session.");
    return this.getSession(id)!;
  }

  currentExecutionAttempt(sessionId: string): { attemptId: string; leaseGeneration: number; taskId: string; workerIncarnationId: string } | undefined {
    const rows = this.database.sqlite.prepare(`select id, attempt_id, lease_generation, owner_worker_incarnation_id
      from coordinator_tasks where owner_session_id = ? and state = 'claimed'
        and attempt_id is not null and owner_worker_incarnation_id is not null
        and julianday(lease_expires_at) > julianday('now') order by id`).all(sessionId) as Array<{
          id: string; attempt_id: string; lease_generation: number; owner_worker_incarnation_id: string;
        }>;
    if (rows.length > 1) throw new Error("Session has multiple active execution attempts.");
    const row = rows[0];
    return row ? { attemptId: row.attempt_id, leaseGeneration: row.lease_generation, taskId: row.id,
      workerIncarnationId: row.owner_worker_incarnation_id } : undefined;
  }

  getSession(id: string): OrchestrationSession | undefined {
    const row = this.database.sqlite.prepare(
      "select * from orchestration_sessions where id = ?"
    ).get(id) as SessionRow | undefined;
    return row ? sessionFromRow(row) : undefined;
  }

  bindWorkspace(sessionId: string, workspaceId: string, workspaceRoot: string): OrchestrationSession {
    return this.database.sqlite.transaction(() => {
      const session = this.getSession(sessionId);
      if (!session) throw new Error("Unknown orchestration session.");
      if (session.workspaceId === workspaceId && session.workspaceRoot === resolve(workspaceRoot)) return session;
      // Intents refer to the previous physical workspace and must not migrate with the owner.
      this.database.sqlite.prepare("delete from orchestration_file_intents where session_id = ?").run(sessionId);
      this.database.sqlite.prepare("update orchestration_sessions set workspace_id = ?, workspace_root = ?, binding_generation = binding_generation + 1, revision = revision + 1 where id = ?")
        .run(workspaceId, resolve(workspaceRoot), sessionId);
      return this.getSession(sessionId)!;
    }).immediate();
  }

  getByExternalSessionId(
    sessionKind: string,
    externalSessionId: string,
  ): OrchestrationSession | undefined {
    const row = this.database.sqlite.prepare(
      "select * from orchestration_sessions where session_kind = ? and external_session_id = ? limit 1"
    ).get(sessionKind, externalSessionId) as SessionRow | undefined;
    return row ? sessionFromRow(row) : undefined;
  }

  listSessions(filter: {
    projectKey?: string;
    workspaceRoot?: string;
    states?: readonly OrchestrationSessionState[];
    limit?: number;
  } = {}): OrchestrationSession[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.projectKey) {
      where.push("project_key = ?");
      params.push(filter.projectKey);
    }
    if (filter.workspaceRoot) {
      where.push("workspace_root = ?");
      params.push(resolve(filter.workspaceRoot));
    }
    if (filter.states?.length) {
      where.push("state in (" + filter.states.map(() => "?").join(",") + ")");
      params.push(...filter.states);
    }
    const limit = Math.max(1, Math.min(filter.limit ?? 100, 500));
    params.push(limit);
    const sql =
      "select * from orchestration_sessions " +
      (where.length ? "where " + where.join(" and ") + " " : "") +
      "order by updated_at desc, id asc limit ?";
    const rows = this.database.sqlite.prepare(sql).all(...params) as SessionRow[];
    return rows.map(sessionFromRow);
  }

  updateSession(
    id: string,
    patch: Partial<Omit<OrchestrationSession, "id" | "createdAt" | "projectKey" | "workspaceRoot">>,
    now = new Date().toISOString(),
    expectedRevision?: number,
  ): OrchestrationSession {
    const current = this.getSession(id);
    if (!current) throw new Error("Unknown orchestration session: " + id);
    if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new Error("Session revision conflict.");
    if (["completed", "failed", "abandoned"].includes(current.state) && patch.state && patch.state !== current.state) {
      throw new Error("Terminal orchestration session cannot revive.");
    }
    const updated: OrchestrationSession = { ...current, ...patch, updatedAt: now };
    // A delayed heartbeat must never move durable activity backwards.
    for (const key of ["lastHeartbeatAt", "lastActivityAt", "lastFileChangeAt", "lastTestAt", "lastTestAttemptAt",
      "lastSuccessfulValidationAt", "lastValidationFailureAt", "updatedAt"] as const) {
      if (current[key] && (!updated[key] || Date.parse(updated[key]!) < Date.parse(current[key]!))) updated[key] = current[key]!;
    }
    const result = this.database.sqlite.prepare(
      `update orchestration_sessions set workspace_id = ?, session_kind = ?, external_session_id = ?, label = ?, state = ?, task = ?, last_heartbeat_at = ?, last_activity_at = ?, last_test_at = ?,
       last_test_attempt_at = ?, last_successful_validation_at = ?, last_validation_failure_at = ?, last_validated_commit = ?, last_validated_tree = ?, last_validated_file_generation = ?,
       last_file_change_at = ?, last_error_fingerprint = ?, consecutive_error_count = ?, updated_at = ?, file_generation = ?, revision = revision + 1
       where id = ? and revision = ? and incarnation = ?`
    ).run(
      updated.workspaceId ?? null,
      updated.sessionKind,
      updated.externalSessionId ?? null,
      updated.label ?? null,
      updated.state,
      updated.task ?? null,
      updated.lastHeartbeatAt ?? null,
      updated.lastActivityAt,
      updated.lastTestAt ?? null,
      updated.lastTestAttemptAt ?? null,
      updated.lastSuccessfulValidationAt ?? null,
      updated.lastValidationFailureAt ?? null,
      updated.lastValidatedCommit ?? null,
      updated.lastValidatedTree ?? null,
      updated.lastValidatedFileGeneration ?? null,
      updated.lastFileChangeAt ?? null,
      updated.lastErrorFingerprint ?? null,
      updated.consecutiveErrorCount,
      updated.updatedAt,
      updated.fileGeneration ?? 0,
      id,
      current.revision,
      current.incarnation,
    );
    if (result.changes !== 1) throw new Error("Session revision or incarnation conflict.");
    return this.getSession(id)!;
  }

  /** State and its required event must use this same connection and transaction. */
  transaction<T>(operation: () => T): T { return this.database.sqlite.transaction(operation).immediate(); }

  appendEvent(input: {
    sessionId: string;
    kind: string;
    detail?: Record<string, unknown>;
    createdAt?: string;
  }): OrchestrationEvent {
    if (!this.getSession(input.sessionId)) {
      throw new Error("Unknown orchestration session: " + input.sessionId);
    }
    const createdAt = input.createdAt ?? new Date().toISOString();
    const detail = input.detail ?? {};
    const result = this.database.sqlite.prepare(
      "insert into orchestration_events (session_id, kind, detail_json, created_at) values (?, ?, ?, ?)"
    ).run(input.sessionId, input.kind, JSON.stringify(detail), createdAt);
    return {
      id: Number(result.lastInsertRowid),
      sessionId: input.sessionId,
      kind: input.kind,
      detail,
      createdAt,
    };
  }

  listEvents(sessionId: string, limit = 100): OrchestrationEvent[] {
    const bounded = Math.max(1, Math.min(limit, 500));
    const rows = this.database.sqlite.prepare(
      "select * from orchestration_events where session_id = ? order by id desc limit ?"
    ).all(sessionId, bounded) as EventRow[];
    return rows.map(eventFromRow);
  }

  replaceFileIntents(
    sessionId: string,
    intents: Array<{ path: string; access: OrchestrationFileAccess }>,
    createdAt = new Date().toISOString(),
  ): OrchestrationFileIntent[] {
    if (!this.getSession(sessionId)) {
      throw new Error("Unknown orchestration session: " + sessionId);
    }
    const unique = new Map<string, { path: string; access: OrchestrationFileAccess }>();
    for (const intent of intents) {
      const normalized = normalizeIntentPath(intent.path);
      unique.set(intent.access + "\u0000" + normalized, { ...intent, path: normalized });
    }
    const tx = this.database.sqlite.transaction(() => {
      this.database.sqlite.prepare(
        "delete from orchestration_file_intents where session_id = ?"
      ).run(sessionId);
      const insert = this.database.sqlite.prepare(
        "insert into orchestration_file_intents (session_id, path, access, created_at) values (?, ?, ?, ?)"
      );
      for (const intent of unique.values()) {
        insert.run(sessionId, intent.path, intent.access, createdAt);
      }
    });
    tx.immediate();
    return this.listFileIntents(sessionId);
  }

  listFileIntents(sessionId?: string): OrchestrationFileIntent[] {
    const rows = sessionId
      ? this.database.sqlite.prepare(
          "select * from orchestration_file_intents where session_id = ? order by path asc, access asc"
        ).all(sessionId) as IntentRow[]
      : this.database.sqlite.prepare(
          "select * from orchestration_file_intents order by session_id asc, path asc, access asc"
        ).all() as IntentRow[];
    return rows.map(intentFromRow);
  }

  close(): void {
    this.database.close();
  }

  /** Internal complete input, separate from the bounded display query. */
  allSessions(projectKey: string): OrchestrationSession[] {
    const rows = this.database.sqlite.prepare("select * from orchestration_sessions where project_key = ? order by id")
      .all(projectKey) as SessionRow[];
    return rows.map(sessionFromRow);
  }

  latestEvent(sessionId: string, kind: string): OrchestrationEvent | undefined {
    const row = this.database.sqlite.prepare("select * from orchestration_events where session_id = ? and kind = ? order by id desc limit 1")
      .get(sessionId, kind) as EventRow | undefined;
    return row ? eventFromRow(row) : undefined;
  }

  getEvent(sessionId: string, eventId: number): OrchestrationEvent | undefined {
    const row = this.database.sqlite.prepare("select * from orchestration_events where session_id = ? and id = ?")
      .get(sessionId, eventId) as EventRow | undefined;
    return row ? eventFromRow(row) : undefined;
  }

  createTestRun(input: Omit<OrchestrationTestRun, "testRunId" | "revision">): OrchestrationTestRun {
    const value: OrchestrationTestRun = {
      ...input,
      testRunId: "trun_" + randomUUID().replaceAll("-", "").slice(0, 20),
      revision: 1,
    };
    this.database.sqlite.prepare(`insert into orchestration_test_runs
      (id, project_key, session_id, process_session_id, revision, status, data_json, started_at, completed_at)
      values (?, ?, ?, ?, 1, ?, ?, ?, ?)`)
      .run(value.testRunId, value.projectKey, value.sessionId, value.processSessionId ?? null,
        value.status, JSON.stringify(value), value.startedAt, value.completedAt ?? null);
    return value;
  }

  getTestRun(sessionId: string, testRunId: string): OrchestrationTestRun | undefined {
    const row = this.database.sqlite.prepare("select data_json from orchestration_test_runs where session_id = ? and id = ?")
      .get(sessionId, testRunId) as { data_json: string } | undefined;
    return row ? JSON.parse(row.data_json) as OrchestrationTestRun : undefined;
  }

  getTestRunByProcess(sessionId: string, processSessionId: string): OrchestrationTestRun | undefined {
    const row = this.database.sqlite.prepare("select data_json from orchestration_test_runs where session_id = ? and process_session_id = ?")
      .get(sessionId, processSessionId) as { data_json: string } | undefined;
    return row ? JSON.parse(row.data_json) as OrchestrationTestRun : undefined;
  }

  updateTestRun(value: OrchestrationTestRun, expectedRevision: number): OrchestrationTestRun {
    const next: OrchestrationTestRun = { ...value, revision: expectedRevision + 1 };
    const result = this.database.sqlite.prepare(`update orchestration_test_runs
      set process_session_id = ?, revision = ?, status = ?, data_json = ?, completed_at = ?
      where id = ? and session_id = ? and revision = ? and status in ('started', 'running')`)
      .run(next.processSessionId ?? null, next.revision, next.status, JSON.stringify(next), next.completedAt ?? null,
        next.testRunId, next.sessionId, expectedRevision);
    if (result.changes !== 1) throw new Error("TestRun revision or terminal-state conflict.");
    return next;
  }

  insertEvidence(input: Omit<OrchestrationExecutionEvidence, "evidenceId">): OrchestrationExecutionEvidence {
    const value: OrchestrationExecutionEvidence = {
      ...input,
      evidenceId: "evid_" + randomUUID().replaceAll("-", "").slice(0, 20),
    };
    this.database.sqlite.prepare(`insert into orchestration_execution_evidence
      (id, project_key, session_id, test_run_id, data_json, created_at) values (?, ?, ?, ?, ?, ?)`)
      .run(value.evidenceId, value.projectKey, value.sessionId, value.testRunId, JSON.stringify(value), value.completedAt);
    return value;
  }

  getEvidence(projectKey: string, sessionId: string, evidenceId: string): OrchestrationExecutionEvidence | undefined {
    const row = this.database.sqlite.prepare(`select data_json from orchestration_execution_evidence
      where project_key = ? and session_id = ? and id = ?`).get(projectKey, sessionId, evidenceId) as { data_json: string } | undefined;
    return row ? JSON.parse(row.data_json) as OrchestrationExecutionEvidence : undefined;
  }

  listTestRuns(sessionId: string, limit = 100): OrchestrationTestRun[] {
    const rows = this.database.sqlite.prepare(`select data_json from orchestration_test_runs
      where session_id = ? order by started_at desc, id desc limit ?`)
      .all(sessionId, Math.max(1, Math.min(limit, 500))) as Array<{ data_json: string }>;
    return rows.map(row => JSON.parse(row.data_json) as OrchestrationTestRun);
  }
}

export function normalizeIntentPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function sessionFromRow(row: SessionRow): OrchestrationSession {
  if (!orchestrationSessionStates.includes(row.state as OrchestrationSessionState)) {
    throw new Error("Invalid persisted orchestration session state: " + row.state);
  }
  return {
    id: row.id,
    logicalSessionId: row.logical_session_id ?? "logical_" + row.id,
    workerIncarnationId: row.worker_incarnation_id ?? `worker_${row.id}_${row.incarnation}`,
    projectKey: row.project_key,
    workspaceId: row.workspace_id ?? undefined,
    workspaceRoot: row.workspace_root,
    sessionKind: row.session_kind,
    externalSessionId: row.external_session_id ?? undefined,
    label: row.label ?? undefined,
    state: row.state as OrchestrationSessionState,
    task: row.task ?? undefined,
    lastHeartbeatAt: row.last_heartbeat_at ?? undefined,
    lastActivityAt: row.last_activity_at,
    lastTestAt: row.last_test_at ?? undefined,
    lastTestAttemptAt: row.last_test_attempt_at ?? undefined,
    lastSuccessfulValidationAt: row.last_successful_validation_at ?? undefined,
    lastValidationFailureAt: row.last_validation_failure_at ?? undefined,
    lastValidatedCommit: row.last_validated_commit ?? undefined,
    lastValidatedTree: row.last_validated_tree ?? undefined,
    lastValidatedFileGeneration: row.last_validated_file_generation ?? undefined,
    revision: row.revision,
    incarnation: row.incarnation,
    bindingGeneration: row.binding_generation,
    fileGeneration: row.file_generation,
    lastFileChangeAt: row.last_file_change_at ?? undefined,
    lastErrorFingerprint: row.last_error_fingerprint ?? undefined,
    consecutiveErrorCount: row.consecutive_error_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function eventFromRow(row: EventRow): OrchestrationEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    detail: JSON.parse(row.detail_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

function intentFromRow(row: IntentRow): OrchestrationFileIntent {
  if (row.access !== "read" && row.access !== "write") {
    throw new Error("Invalid orchestration file intent access: " + row.access);
  }
  return {
    sessionId: row.session_id,
    path: row.path,
    access: row.access,
    createdAt: row.created_at,
  };
}
