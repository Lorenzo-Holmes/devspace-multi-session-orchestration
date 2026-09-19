import { isAbsolute, posix, resolve, win32 } from "node:path";
import {
  OrchestrationStore,
  type OrchestrationEvent,
  type OrchestrationFileAccess,
  type OrchestrationFileIntent,
  type OrchestrationSession,
  type OrchestrationSessionState,
} from "./orchestration-store.js";

const transitions: Record<OrchestrationSessionState, ReadonlySet<OrchestrationSessionState>> = {
  queued: new Set(["running", "blocked_user", "blocked_tool", "failed", "abandoned"]),
  running: new Set(["blocked_user", "blocked_tool", "waiting_test", "ready_review", "completed", "failed", "abandoned"]),
  blocked_user: new Set(["running", "failed", "abandoned"]),
  blocked_tool: new Set(["running", "failed", "abandoned"]),
  waiting_test: new Set(["running", "ready_review", "failed", "abandoned"]),
  ready_review: new Set(["running", "completed", "failed", "abandoned"]),
  completed: new Set(),
  failed: new Set(),
  abandoned: new Set(),
};

export class OrchestrationRegistry {
  private readonly listeners = new Set<(projectKey: string) => void>();
  constructor(private readonly store: OrchestrationStore) {}
  onChange(listener: (projectKey: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private changed(projectKey: string): void {
    for (const listener of this.listeners) { try { listener(projectKey); } catch { /* Observers cannot change tool outcome semantics. */ } }
  }

  register(input: {
    projectKey: string;
    workspaceRoot: string;
    workspaceId?: string;
    sessionKind?: string;
    externalSessionId?: string;
    label?: string;
    task?: string;
    state?: OrchestrationSessionState;
    id?: string;
    now?: string;
  }): OrchestrationSession {
    const projectKey = input.projectKey.trim();
    if (!projectKey) throw new Error("projectKey is required.");
    const sessionKind = (input.sessionKind ?? "chat").trim();
    if (!sessionKind) throw new Error("sessionKind is required.");
    const externalSessionId = cleanOptional(input.externalSessionId);
    if (externalSessionId) {
      const existing = this.store.getByExternalSessionId(sessionKind, externalSessionId);
      if (existing) {
        if (existing.projectKey !== projectKey || resolve(existing.workspaceRoot) !== resolve(input.workspaceRoot)) {
          throw new Error("External session identity is already bound to another project scope.");
        }
        return existing;
      }
    }
    return this.store.createSession({
      ...input,
      projectKey,
      workspaceRoot: resolve(input.workspaceRoot),
      sessionKind,
      label: cleanOptional(input.label),
      task: cleanOptional(input.task),
      externalSessionId,
    });
  }

  get(sessionId: string): OrchestrationSession {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error("Unknown orchestration session: " + sessionId);
    return session;
  }

  /** Called only by the lease-fenced worktree provisioner; does not imply activity or liveness. */
  bindWorkspace(sessionId: string, projectKey: string, workspaceId: string, workspaceRoot: string): void {
    if (this.get(sessionId).projectKey !== projectKey) throw new Error("Session outside project scope.");
    this.store.bindWorkspace(sessionId, workspaceId, workspaceRoot);
    this.changed(projectKey);
  }

  list(filter: {
    projectKey?: string;
    workspaceRoot?: string;
    states?: readonly OrchestrationSessionState[];
    limit?: number;
  } = {}): OrchestrationSession[] {
    return this.store.listSessions({
      ...filter,
      projectKey: cleanOptional(filter.projectKey),
      workspaceRoot: filter.workspaceRoot ? resolve(filter.workspaceRoot) : undefined,
    });
  }

  setState(
    sessionId: string,
    nextState: OrchestrationSessionState,
    options: { task?: string; label?: string; now?: string } = {},
  ): OrchestrationSession {
    const result = this.store.transaction(() => {
    const current = this.get(sessionId);
    if (current.state !== nextState && !transitions[current.state].has(nextState)) {
      throw new Error(
        "Invalid orchestration session transition: " + current.state + " -> " + nextState,
      );
    }
    const updated = this.store.updateSession(
      sessionId,
      {
        state: nextState,
        task: options.task === undefined ? current.task : cleanOptional(options.task),
        label: options.label === undefined ? current.label : cleanOptional(options.label),
        lastActivityAt: options.now ?? new Date().toISOString(),
      },
      options.now,
      current.revision,
    );
    if (current.state !== nextState) {
      this.store.appendEvent({
        sessionId,
        kind: "state_change",
        detail: { from: current.state, to: nextState },
        createdAt: options.now,
      });
    }
    return updated;
    });
    this.changed(result.projectKey);
    return result;
  }

  heartbeat(
    sessionId: string,
    options: { now?: string; detail?: Record<string, unknown> } = {},
  ): OrchestrationSession {
    const result = this.store.transaction(() => {
    const current = this.get(sessionId);
    const now = options.now ?? new Date().toISOString();
    const updated = this.store.updateSession(
      sessionId,
      { lastHeartbeatAt: now, lastActivityAt: now },
      now,
      current.revision,
    );
    this.store.appendEvent({
      sessionId,
      kind: "heartbeat",
      detail: options.detail ?? {},
      createdAt: now,
    });
    return updated;
    });
    this.changed(result.projectKey);
    return result;
  }

  recordEvent(input: {
    sessionId: string;
    kind: string;
    detail?: Record<string, unknown>;
    now?: string;
  }): { session: OrchestrationSession; event: OrchestrationEvent } {
    const result = this.store.transaction(() => {
    const current = this.get(input.sessionId);
    const now = input.now ?? new Date().toISOString();
    const detail = input.detail ?? {};
    const patch: Partial<OrchestrationSession> = { lastActivityAt: now };
    if (input.kind === "file_change") {
      patch.lastFileChangeAt = now;
      patch.fileGeneration = (current.fileGeneration ?? 0) + 1;
    }
    if (input.kind === "test_run") patch.lastTestAt = now;
    if (input.kind === "error") {
      const fingerprint = typeof detail.fingerprint === "string" && detail.fingerprint.trim()
        ? detail.fingerprint.trim()
        : "unknown";
      patch.lastErrorFingerprint = fingerprint;
      patch.consecutiveErrorCount = current.lastErrorFingerprint === fingerprint
        ? current.consecutiveErrorCount + 1
        : 1;
    } else if (
      input.kind === "success"
      || (input.kind === "test_run" && detail.passed !== false)
    ) {
      patch.lastErrorFingerprint = undefined;
      patch.consecutiveErrorCount = 0;
    } else if (input.kind === "test_run" && detail.passed === false) {
      const fingerprint = typeof detail.fingerprint === "string" && detail.fingerprint.trim()
        ? detail.fingerprint.trim()
        : "test_failed";
      patch.lastErrorFingerprint = fingerprint;
      patch.consecutiveErrorCount = current.lastErrorFingerprint === fingerprint
        ? current.consecutiveErrorCount + 1
        : 1;
    }
    const session = this.store.updateSession(input.sessionId, patch, now, current.revision);
    const event = this.store.appendEvent({
      sessionId: input.sessionId,
      kind: input.kind,
      detail,
      createdAt: now,
    });
    return { session, event };
    });
    this.changed(result.session.projectKey);
    return result;
  }

  events(sessionId: string, limit = 100): OrchestrationEvent[] {
    this.get(sessionId);
    return this.store.listEvents(sessionId, limit);
  }

  setFileIntents(
    sessionId: string,
    intents: Array<{ path: string; access: OrchestrationFileAccess }>,
    now?: string,
  ): OrchestrationFileIntent[] {
    this.get(sessionId);
    const normalizedIntents = new Map<string, { path: string; access: OrchestrationFileAccess }>();
    for (const intent of intents) {
      const normalized = posix.normalize(intent.path.replaceAll("\\", "/")).replace(/\/+$/, "");
      if (!normalized || normalized === "." || normalized.length > 500 || isAbsolute(intent.path) || win32.isAbsolute(intent.path)
        || /^[a-z]:/i.test(intent.path) || /[\x00-\x1f]/.test(intent.path) || normalized === ".." || normalized.startsWith("../")) {
        throw new Error("File intents must be non-empty workspace-relative paths without parent traversal.");
      }
      normalizedIntents.set(intent.access + "\0" + normalized, { path: normalized, access: intent.access });
    }
    if (normalizedIntents.size > 200) throw new Error("At most 200 file intents are allowed per session.");
    const stored = this.store.transaction(() => {
    const value = this.store.replaceFileIntents(sessionId, [...normalizedIntents.values()], now);
    this.store.appendEvent({
      sessionId,
      kind: "file_intents",
      detail: { count: value.length },
      createdAt: now,
    });
    return value;
    });
    this.changed(this.get(sessionId).projectKey);
    return stored;
  }

  addFileIntents(
    sessionId: string,
    intents: Array<{ path: string; access: OrchestrationFileAccess }>,
    now?: string,
  ): OrchestrationFileIntent[] {
    const current = this.fileIntents(sessionId).map(({ path, access }) => ({
      path,
      access,
    }));
    return this.setFileIntents(sessionId, [...current, ...intents], now);
  }

  fileIntents(sessionId?: string): OrchestrationFileIntent[] {
    if (sessionId) this.get(sessionId);
    return this.store.listFileIntents(sessionId);
  }

  close(): void {
    this.store.close();
  }

  all(projectKey: string): OrchestrationSession[] { return this.store.allSessions(projectKey); }

  latestEvent(sessionId: string, kind: string): OrchestrationEvent | undefined {
    this.get(sessionId);
    return this.store.latestEvent(sessionId, kind);
  }

  event(sessionId: string, eventId: number): OrchestrationEvent | undefined {
    this.get(sessionId);
    return this.store.getEvent(sessionId, eventId);
  }
}

function cleanOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}
