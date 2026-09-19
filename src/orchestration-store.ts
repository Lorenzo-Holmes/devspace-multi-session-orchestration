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
    const session: OrchestrationSession = {
      id: input.id ?? "sess_" + randomUUID().replaceAll("-", "").slice(0, 12),
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
      createdAt: now,
      updatedAt: now,
    };
    this.database.sqlite.prepare(
      "insert into orchestration_sessions (id, project_key, workspace_id, workspace_root, session_kind, external_session_id, label, state, task, last_activity_at, consecutive_error_count, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      session.id,
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
      this.database.sqlite.prepare("update orchestration_sessions set workspace_id = ?, workspace_root = ? where id = ?")
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
  ): OrchestrationSession {
    const current = this.getSession(id);
    if (!current) throw new Error("Unknown orchestration session: " + id);
    const updated: OrchestrationSession = { ...current, ...patch, updatedAt: now };
    this.database.sqlite.prepare(
      "update orchestration_sessions set workspace_id = ?, session_kind = ?, external_session_id = ?, label = ?, state = ?, task = ?, last_heartbeat_at = ?, last_activity_at = ?, last_test_at = ?, last_file_change_at = ?, last_error_fingerprint = ?, consecutive_error_count = ?, updated_at = ? where id = ?"
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
      updated.lastFileChangeAt ?? null,
      updated.lastErrorFingerprint ?? null,
      updated.consecutiveErrorCount,
      updated.updatedAt,
      id,
    );
    return updated;
  }

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
