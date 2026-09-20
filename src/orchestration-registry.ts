import { randomUUID } from "node:crypto";
import { isAbsolute, posix, resolve, win32 } from "node:path";
import {
  OrchestrationStore,
  type OrchestrationEvent,
  type OrchestrationFileAccess,
  type OrchestrationFileIntent,
  type OrchestrationSession,
  type OrchestrationSessionState,
  type OrchestrationTestRun,
  type OrchestrationExecutionEvidence,
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

  /** Starts a new authoritative worker for one logical session and fences the old one. */
  restartWorker(sessionId: string, now = new Date().toISOString()): OrchestrationSession {
    const result = this.store.transaction(() => {
      const current = this.get(sessionId);
      const updated = this.store.advanceWorkerIncarnation(sessionId, current.revision ?? 1, now);
      this.store.appendEvent({ sessionId, kind: "worker_incarnation_started", detail: {
        logicalSessionId: updated.logicalSessionId,
        workerIncarnationId: updated.workerIncarnationId,
        incarnation: updated.incarnation,
      }, createdAt: now });
      return updated;
    });
    this.changed(result.projectKey);
    return result;
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
    if (input.kind === "test_run") {
      patch.lastTestAttemptAt = now;
      if (detail.passed === true && detail.trustLevel === "execution_observed") {
        patch.lastTestAt = now;
        patch.lastSuccessfulValidationAt = now;
      } else if (detail.passed === false) {
        patch.lastValidationFailureAt = now;
      }
    }
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
      || (input.kind === "test_run" && detail.passed === true && detail.trustLevel === "execution_observed")
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

  beginTestRun(sessionId: string, input: {
    kind: OrchestrationTestRun["kind"];
    checkDefinition: string;
    requiresTestCount: boolean;
    command: string;
    workingDirectory: string;
    testedCommit?: string;
    testedTree?: string;
    environmentIdentity: string;
    issuer: string;
    now?: string;
  }): OrchestrationTestRun {
    const result = this.store.transaction(() => {
      const current = this.get(sessionId);
      const now = input.now ?? new Date().toISOString();
      const activeAttempt = this.store.currentExecutionAttempt(sessionId);
      if (activeAttempt && activeAttempt.workerIncarnationId !== current.workerIncarnationId) {
        throw new Error("Current execution attempt belongs to an older worker incarnation.");
      }
      const run = this.store.createTestRun({
        attemptId: activeAttempt?.attemptId ?? "attempt_" + randomUUID().replaceAll("-", "").slice(0, 20),
        executionTaskId: activeAttempt?.taskId,
        leaseGeneration: activeAttempt?.leaseGeneration,
        projectKey: current.projectKey,
        sessionId,
        kind: input.kind,
        checkDefinition: input.checkDefinition,
        requiresTestCount: input.requiresTestCount,
        command: input.command.slice(0, 32_768),
        workingDirectory: input.workingDirectory,
        testedCommit: input.testedCommit,
        testedTree: input.testedTree,
        environmentIdentity: input.environmentIdentity,
        startedAt: now,
        status: "started",
        issuer: input.issuer,
        trustLevel: "unverified",
        sessionRevision: current.revision ?? 1,
        workerIncarnation: current.incarnation ?? 1,
        bindingGeneration: current.bindingGeneration ?? 1,
        fileGeneration: current.fileGeneration ?? 0,
      });
      this.store.updateSession(sessionId, { lastActivityAt: now, lastTestAttemptAt: now }, now, current.revision);
      this.store.appendEvent({ sessionId, kind: "test_run_started", detail: {
        testRunId: run.testRunId, status: run.status, checkDefinition: run.checkDefinition,
      }, createdAt: now });
      return run;
    });
    this.changed(result.projectKey);
    return result;
  }

  bindTestRunProcess(sessionId: string, testRunId: string, processSessionId: string): OrchestrationTestRun {
    const result = this.store.transaction(() => {
      const run = this.store.getTestRun(sessionId, testRunId);
      if (!run) throw new Error("Unknown TestRun.");
      return this.store.updateTestRun({ ...run, processSessionId, status: "running" }, run.revision);
    });
    this.changed(result.projectKey);
    return result;
  }

  finishUnboundTestRun(sessionId: string, testRunId: string, reason: string, completedAt = new Date().toISOString()): OrchestrationTestRun {
    const result = this.store.transaction(() => {
      const run = this.store.getTestRun(sessionId, testRunId);
      if (!run) throw new Error("Unknown TestRun.");
      const current = this.get(sessionId);
      const next = this.store.updateTestRun({ ...run, status: "unknown", completedAt,
        reason, trustLevel: "unverified" }, run.revision);
      this.store.updateSession(sessionId, { lastActivityAt: completedAt }, completedAt, current.revision);
      this.store.appendEvent({ sessionId, kind: "test_run", detail: {
        testRunId, status: "unknown", passed: false, reason, trustLevel: "unverified",
      }, createdAt: completedAt });
      return next;
    });
    this.changed(result.projectKey);
    return result;
  }

  finishTestRun(sessionId: string, processSessionId: string, input: {
    exitCode?: number;
    signal?: string;
    cancelled?: boolean;
    timedOut?: boolean;
    sourceStable: boolean;
    positiveReceipt: boolean;
    completedAt?: string;
    reason?: string;
  }): { run: OrchestrationTestRun; evidence?: OrchestrationExecutionEvidence } {
    const result = this.store.transaction(() => {
      const run = this.store.getTestRunByProcess(sessionId, processSessionId);
      if (!run) throw new Error("Unknown TestRun process session.");
      const current = this.get(sessionId);
      const completedAt = input.completedAt ?? new Date().toISOString();
      const activeAttempt = this.store.currentExecutionAttempt(sessionId);
      const authorityStable = (current.incarnation ?? 1) === run.workerIncarnation
        && (current.bindingGeneration ?? 1) === run.bindingGeneration
        && (current.fileGeneration ?? 0) === run.fileGeneration
        && (!run.executionTaskId || (activeAttempt?.taskId === run.executionTaskId
          && activeAttempt.attemptId === run.attemptId
          && activeAttempt.leaseGeneration === run.leaseGeneration
          && activeAttempt.workerIncarnationId === current.workerIncarnationId));
      let status: OrchestrationTestRun["status"];
      let reason = input.reason;
      if (input.cancelled) { status = "cancelled"; reason ??= "cancelled"; }
      else if (input.timedOut) { status = "failed"; reason ??= "timeout"; }
      else if (input.signal) { status = "failed"; reason ??= "signal"; }
      else if (input.exitCode !== 0) { status = input.exitCode === undefined ? "unknown" : "failed"; reason ??= "nonzero_exit"; }
      else if (!input.sourceStable) { status = "unknown"; reason ??= "source_changed"; }
      else if (!authorityStable) { status = "unknown"; reason ??= "execution_authority_changed"; }
      else if (!input.positiveReceipt) { status = "unknown"; reason ??= "positive_receipt_missing"; }
      else { status = "passed"; }

      let evidence: OrchestrationExecutionEvidence | undefined;
      if (status === "passed" && run.testedCommit && run.testedTree) {
        evidence = this.store.insertEvidence({ testRunId: run.testRunId, attemptId: run.attemptId,
          executionTaskId: run.executionTaskId, leaseGeneration: run.leaseGeneration,
          projectKey: run.projectKey, sessionId: run.sessionId, testedCommit: run.testedCommit,
          testedTree: run.testedTree, checkDefinition: run.checkDefinition,
          environmentIdentity: run.environmentIdentity, exitStatus: 0, startedAt: run.startedAt,
          completedAt, issuer: run.issuer, trustLevel: "execution_observed",
          workerIncarnation: run.workerIncarnation, bindingGeneration: run.bindingGeneration,
          fileGeneration: run.fileGeneration });
      }
      const next = this.store.updateTestRun({ ...run, completedAt, exitCode: input.exitCode,
        signal: input.signal, status, reason, evidenceId: evidence?.evidenceId,
        trustLevel: status === "passed" ? "execution_observed" : "unverified" }, run.revision);

      const patch: Partial<OrchestrationSession> = { lastActivityAt: completedAt };
      if (status === "passed") {
        patch.lastTestAt = completedAt;
        patch.lastSuccessfulValidationAt = completedAt;
        patch.lastValidatedCommit = next.testedCommit;
        patch.lastValidatedTree = next.testedTree;
        patch.lastValidatedFileGeneration = next.fileGeneration;
        patch.lastErrorFingerprint = undefined;
        patch.consecutiveErrorCount = 0;
      } else if (status === "failed") {
        patch.lastValidationFailureAt = completedAt;
        patch.lastErrorFingerprint = "validation_failed";
        patch.consecutiveErrorCount = current.lastErrorFingerprint === "validation_failed"
          ? current.consecutiveErrorCount + 1 : 1;
      }
      this.store.updateSession(sessionId, patch, completedAt, current.revision);
      this.store.appendEvent({ sessionId, kind: "test_run", detail: { testRunId: next.testRunId,
        evidenceId: evidence?.evidenceId, passed: status === "passed", status,
        trustLevel: next.trustLevel, exitCode: input.exitCode, signal: input.signal, reason }, createdAt: completedAt });
      return { run: next, evidence };
    });
    this.changed(result.run.projectKey);
    return result;
  }

  testRunByProcess(sessionId: string, processSessionId: string): OrchestrationTestRun | undefined {
    this.get(sessionId);
    return this.store.getTestRunByProcess(sessionId, processSessionId);
  }

  evidence(projectKey: string, sessionId: string, evidenceId: string): OrchestrationExecutionEvidence | undefined {
    const session = this.get(sessionId);
    if (session.projectKey !== projectKey) return undefined;
    return this.store.getEvidence(projectKey, sessionId, evidenceId);
  }

  testRuns(sessionId: string, limit = 100): OrchestrationTestRun[] {
    this.get(sessionId);
    return this.store.listTestRuns(sessionId, limit);
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
