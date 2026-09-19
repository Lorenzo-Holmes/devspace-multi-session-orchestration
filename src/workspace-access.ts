import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";
import type { ServerConfig } from "./config.js";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { AccessDeniedError, assertAllowedPath, isPathInsideRoot } from "./roots.js";
import { setDevspaceConfigValue } from "./user-config.js";
import type { WorkspaceSession } from "./workspace-store.js";
import type { Workspace, WorkspaceAccessMode } from "./workspaces.js";

export type WorkspaceAccessDecision = "once" | "session" | "permanent" | "deny";
export type WorkspaceAccessRisk = "standard" | "high";
export type WorkspaceGrantScope = "configured" | "once" | "session" | "permanent";

export interface WorkspaceAccessRequest {
  id: string;
  path: string;
  requestedAccess: WorkspaceAccessMode;
  reason?: string;
  conversationScopeId?: string;
  status: "pending" | "already_allowed";
  risk: WorkspaceAccessRisk;
  temporaryScopeAvailable: boolean;
  createdAt: string;
  expiresAt: string;
  approvalToken?: string;
}

export interface WorkspaceAccessAuthorization {
  path: string;
  root: string;
  access: WorkspaceAccessMode;
  scope: WorkspaceGrantScope;
  grantId?: string;
  consumedOnce?: boolean;
}

export interface WorkspaceAccessGrantView {
  id: string;
  path: string;
  access: WorkspaceAccessMode;
  scope: WorkspaceGrantScope;
  conversationScopeId?: string;
  expiresAt?: string;
  createdAt: string;
  active: boolean;
  source: "config" | "approval";
}

export interface WorkspaceAccessAuditView {
  id: string;
  event: string;
  requestId?: string;
  grantId?: string;
  path: string;
  access?: WorkspaceAccessMode;
  scope?: WorkspaceGrantScope | "deny";
  detail?: string;
  createdAt: string;
}

export interface WorkspaceAccessApprovalResult {
  status: "approved" | "denied";
  path: string;
  access: WorkspaceAccessMode;
  decision: WorkspaceAccessDecision;
  grantId?: string;
  expiresAt?: string;
  message: string;
}

export interface WorkspaceAccessRevocationResult {
  path: string;
  revokedGrantCount: number;
  removedFromConfig: boolean;
  inheritedAccess?: WorkspaceAccessMode;
}

interface AccessRequestRow {
  id: string;
  path: string;
  requested_access: string;
  reason: string | null;
  conversation_scope_id: string | null;
  token_hash: string;
  status: string;
  decision_scope: string | null;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
}

interface AccessGrantRow {
  id: string;
  path: string;
  access: string;
  scope: string;
  conversation_scope_id: string | null;
  request_id: string | null;
  uses_remaining: number | null;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

interface AccessAuditRow {
  id: string;
  event: string;
  request_id: string | null;
  grant_id: string | null;
  path: string;
  access: string | null;
  scope: string | null;
  conversation_scope_id: string | null;
  detail: string | null;
  created_at: string;
}

export interface WorkspaceAccessManagerOptions {
  now?: () => Date;
  requestTtlMs?: number;
  sessionTtlMs?: number;
  persistAllowedRoots?: (roots: string[]) => void | Promise<void>;
}

const DEFAULT_REQUEST_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;

export class WorkspaceAccessManager {
  private readonly database: DatabaseHandle;
  private readonly now: () => Date;
  private readonly requestTtlMs: number;
  private readonly sessionTtlMs: number;
  private readonly persistAllowedRoots: (roots: string[]) => void | Promise<void>;

  constructor(
    private readonly config: ServerConfig,
    options: WorkspaceAccessManagerOptions = {},
  ) {
    this.database = openDatabase(config.stateDir);
    this.now = options.now ?? (() => new Date());
    this.requestTtlMs = options.requestTtlMs ?? DEFAULT_REQUEST_TTL_MS;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.persistAllowedRoots = options.persistAllowedRoots ?? ((roots) => {
      const env = { ...process.env, DEVSPACE_CONFIG_DIR: this.config.configDir };
      setDevspaceConfigValue(["workspaces", "allowedRoots"], roots, env);
      replaceAllowedRoots(this.config, roots);
    });
  }

  async requestAccess(input: {
    path: string;
    access: WorkspaceAccessMode;
    reason?: string;
    conversationScopeId?: string;
  }): Promise<WorkspaceAccessRequest> {
    const path = await canonicalExistingDirectory(input.path);
    const now = this.now();
    const existing = this.findBestGrant(path, input.conversationScopeId, false);
    if (existing && accessSatisfies(existing.access, input.access)) {
      return {
        id: `existing_${randomUUID()}`,
        path,
        requestedAccess: input.access,
        reason: cleanReason(input.reason),
        conversationScopeId: input.conversationScopeId,
        status: "already_allowed",
        risk: accessRisk(path),
        temporaryScopeAvailable: Boolean(input.conversationScopeId),
        createdAt: now.toISOString(),
        expiresAt: now.toISOString(),
      };
    }

    const id = `access_${randomUUID()}`;
    const approvalToken = randomBytes(32).toString("base64url");
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.requestTtlMs).toISOString();
    const reason = cleanReason(input.reason);

    const transaction = this.database.sqlite.transaction(() => {
      const superseded = this.database.sqlite.prepare(`
        select id, path, requested_access, conversation_scope_id
        from workspace_access_requests
        where status = 'pending' and path = ?
          and coalesce(conversation_scope_id, '') = coalesce(?, '')
      `).all(path, input.conversationScopeId ?? null) as Array<{
        id: string;
        path: string;
        requested_access: string;
        conversation_scope_id: string | null;
      }>;

      this.database.sqlite.prepare(`
        update workspace_access_requests
        set status = 'superseded', token_hash = '', decided_at = ?
        where status = 'pending' and path = ?
          and coalesce(conversation_scope_id, '') = coalesce(?, '')
      `).run(createdAt, path, input.conversationScopeId ?? null);

      for (const previous of superseded) {
        this.insertAudit({
          event: "request_superseded",
          requestId: previous.id,
          path: previous.path,
          access: accessMode(previous.requested_access),
          conversationScopeId: previous.conversation_scope_id ?? undefined,
          createdAt,
        });
      }

      this.database.sqlite.prepare(`
        insert into workspace_access_requests (
          id, path, requested_access, reason, conversation_scope_id,
          token_hash, status, created_at, expires_at
        ) values (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(
        id,
        path,
        input.access,
        reason ?? null,
        input.conversationScopeId ?? null,
        tokenHash(approvalToken),
        createdAt,
        expiresAt,
      );
      this.insertAudit({
        event: "request_created",
        requestId: id,
        path,
        access: input.access,
        conversationScopeId: input.conversationScopeId,
        createdAt,
      });
    });
    transaction.immediate();

    return {
      id,
      path,
      requestedAccess: input.access,
      reason,
      conversationScopeId: input.conversationScopeId,
      status: "pending",
      risk: accessRisk(path),
      temporaryScopeAvailable: Boolean(input.conversationScopeId),
      createdAt,
      expiresAt,
      approvalToken,
    };
  }

  async decideRequest(input: {
    requestId: string;
    approvalToken: string;
    decision: WorkspaceAccessDecision;
    conversationScopeId?: string;
    confirmHighRisk?: boolean;
  }): Promise<WorkspaceAccessApprovalResult> {
    const request = this.requestRow(input.requestId);
    this.assertPendingRequest(request, input.approvalToken, input.conversationScopeId);
    const requestedAccess = accessMode(request.requested_access);
    const now = this.now();
    const decidedAt = now.toISOString();

    if (input.decision === "deny") {
      const transaction = this.database.sqlite.transaction(() => {
        this.finishRequest(request.id, "denied", input.decision, decidedAt);
        this.insertAudit({
          event: "request_denied",
          requestId: request.id,
          path: request.path,
          access: requestedAccess,
          scope: input.decision,
          conversationScopeId: request.conversation_scope_id ?? undefined,
          createdAt: decidedAt,
        });
      });
      transaction.immediate();
      return {
        status: "denied",
        path: request.path,
        access: requestedAccess,
        decision: input.decision,
        message: "Access was denied. No configuration or filesystem permission was changed.",
      };
    }

    if (
      (input.decision === "once" || input.decision === "session")
      && !request.conversation_scope_id
    ) {
      throw new AccessDeniedError(
        "This host did not provide a conversation identity. Choose permanent access or deny this request.",
      );
    }
    if (accessRisk(request.path) === "high" && input.confirmHighRisk !== true) {
      throw new AccessDeniedError(
        "This is a high-risk system or drive-level path. Confirm the high-risk warning in the approval card first.",
      );
    }

    await verifyFilesystemAccess(request.path, requestedAccess);

    const grantId = `grant_${randomUUID()}`;
    const expiresAt = input.decision === "session"
      ? new Date(now.getTime() + this.sessionTtlMs).toISOString()
      : undefined;
    const usesRemaining = input.decision === "once" ? 1 : undefined;

    this.database.sqlite.prepare(`
      insert into workspace_access_grants (
        id, path, access, scope, conversation_scope_id, request_id,
        uses_remaining, expires_at, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      grantId,
      request.path,
      requestedAccess,
      input.decision,
      request.conversation_scope_id,
      request.id,
      usesRemaining ?? null,
      expiresAt ?? null,
      decidedAt,
    );

    try {
      if (input.decision === "permanent") {
        const roots = appendUniquePath(this.config.allowedRoots, request.path);
        await this.persistAllowedRoots(roots);
        replaceAllowedRoots(this.config, roots);
      }
    } catch (error) {
      this.database.sqlite.prepare(`
        update workspace_access_grants set revoked_at = ? where id = ?
      `).run(decidedAt, grantId);
      this.insertAudit({
        event: "grant_failed",
        requestId: request.id,
        grantId,
        path: request.path,
        access: requestedAccess,
        scope: input.decision,
        conversationScopeId: request.conversation_scope_id ?? undefined,
        detail: error instanceof Error ? error.message : String(error),
        createdAt: decidedAt,
      });
      throw error;
    }

    const transaction = this.database.sqlite.transaction(() => {
      this.finishRequest(request.id, "approved", input.decision, decidedAt);
      this.insertAudit({
        event: "grant_approved",
        requestId: request.id,
        grantId,
        path: request.path,
        access: requestedAccess,
        scope: input.decision,
        conversationScopeId: request.conversation_scope_id ?? undefined,
        createdAt: decidedAt,
      });
    });
    transaction.immediate();

    return {
      status: "approved",
      path: request.path,
      access: requestedAccess,
      decision: input.decision,
      grantId,
      expiresAt,
      message: approvalMessage(input.decision, expiresAt),
    };
  }

  async authorizeWorkspacePath(
    inputPath: string,
    conversationScopeId?: string,
    requiredAccess: WorkspaceAccessMode = "read",
  ): Promise<WorkspaceAccessAuthorization> {
    let path: string;
    try {
      path = await canonicalExistingDirectory(inputPath);
    } catch (error) {
      if (!isErrnoException(error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) {
        throw error;
      }
      path = resolve(inputPath);
      const missingPathGrant = this.findBestGrant(path, conversationScopeId, false);
      if (!missingPathGrant || !accessSatisfies(missingPathGrant.access, requiredAccess)) {
        throw new AccessDeniedError(
          `The requested folder does not exist and is outside approved roots: ${inputPath}. Create it locally first, then request access.`,
        );
      }
    }

    while (true) {
      const grant = this.findBestGrant(path, conversationScopeId, true);
      if (!grant) {
        throw new AccessDeniedError(
          `Path is outside approved roots: ${inputPath}. Call request_workspace_access so the user can approve it in ChatGPT.`,
        );
      }
      if (!accessSatisfies(grant.access, requiredAccess)) {
        throw new AccessDeniedError(
          `Path has only ${grant.access} access: ${inputPath}. Request ${requiredAccess} access so the user can approve the upgrade in ChatGPT.`,
        );
      }

      if (grant.scope !== "once" || !grant.grantId) return { ...grant, path };

      const reserved = this.database.sqlite.prepare(`
        update workspace_access_grants
        set uses_remaining = 0
        where id = ? and revoked_at is null and uses_remaining = 1
      `).run(grant.grantId);
      if (reserved.changes === 1) {
        this.insertAudit({
          event: "grant_consumed",
          grantId: grant.grantId,
          path: grant.root,
          access: grant.access,
          scope: grant.scope,
          conversationScopeId,
          createdAt: this.now().toISOString(),
        });
        return { ...grant, path, consumedOnce: true };
      }
    }
  }

  releaseOnceAuthorization(authorization: WorkspaceAccessAuthorization): void {
    if (!authorization.consumedOnce || !authorization.grantId) return;
    this.database.sqlite.prepare(`
      update workspace_access_grants
      set uses_remaining = 1
      where id = ? and revoked_at is null and uses_remaining = 0
    `).run(authorization.grantId);
    this.insertAudit({
      event: "grant_restored_after_open_failure",
      grantId: authorization.grantId,
      path: authorization.root,
      access: authorization.access,
      scope: authorization.scope,
      createdAt: this.now().toISOString(),
    });
  }

  workspaceRestoreAllowedRoots(
    session: Pick<
      WorkspaceSession,
      "root" | "mode" | "sourceRoot" | "accessMode" | "accessGrantId"
    >,
  ): string[] {
    if (!session.accessGrantId) return this.config.allowedRoots;

    const row = this.database.sqlite.prepare(`
      select * from workspace_access_grants where id = ?
    `).get(session.accessGrantId) as AccessGrantRow | undefined;
    if (!row || row.revoked_at || isExpired(row.expires_at, this.now().getTime())) {
      throw new AccessDeniedError(
        `Workspace access is no longer active: ${session.root}. Request access again.`,
      );
    }

    const authorizedPath = session.mode === "worktree" ? session.sourceRoot : session.root;
    if (!authorizedPath || !isPathInsideRoot(authorizedPath, row.path)) {
      throw new AccessDeniedError(
        `Stored workspace is outside its approved folder: ${session.root}. Request access again.`,
      );
    }
    if (!accessSatisfies(accessMode(row.access), session.accessMode)) {
      throw new AccessDeniedError(
        `Stored workspace access exceeds the active grant: ${session.root}. Request access again.`,
      );
    }
    if (
      row.scope === "permanent"
      && !this.config.allowedRoots.some((root) => isPathInsideRoot(authorizedPath, root))
    ) {
      throw new AccessDeniedError(
        `Workspace access was removed from configuration: ${session.root}. Request access again.`,
      );
    }

    return appendUniquePath(this.config.allowedRoots, row.path);
  }

  assertWorkspaceReadable(workspace: Pick<Workspace, "root" | "accessMode" | "accessGrantId"> & Partial<Pick<Workspace, "mode" | "sourceRoot" | "worktree">>): void {
    this.assertWorkspaceGrantActive(workspace);
  }

  assertWorkspaceModifiable(workspace: Pick<Workspace, "root" | "accessMode" | "accessGrantId"> & Partial<Pick<Workspace, "mode" | "sourceRoot" | "worktree">>): void {
    this.assertWorkspaceGrantActive(workspace);
    if (workspace.accessMode !== "modify") {
      throw new AccessDeniedError(
        `Workspace is read-only: ${workspace.root}. Request Modify access before using write, edit, patch, command, or artifact tools.`,
      );
    }
  }

  listGrants(conversationScopeId?: string): WorkspaceAccessGrantView[] {
    const now = this.now().getTime();
    const rows = this.database.sqlite.prepare(`
      select * from workspace_access_grants order by created_at desc
    `).all() as AccessGrantRow[];
    const approvals = rows
      .filter((row) => {
        if (row.scope === "session" || row.scope === "once") {
          return Boolean(conversationScopeId && row.conversation_scope_id === conversationScopeId);
        }
        return true;
      })
      .map((row) => grantView(row, now));
    const approvedByPath = new Map(
      approvals
        .filter((grant) => grant.scope === "permanent" && grant.active)
        .map((grant) => [pathKey(grant.path), grant]),
    );
    const configured = this.config.allowedRoots.map((path) => {
      const approved = approvedByPath.get(pathKey(path));
      return approved ?? {
        id: `config_${createHash("sha256").update(pathKey(path)).digest("hex").slice(0, 16)}`,
        path,
        access: "modify" as const,
        scope: "configured" as const,
        createdAt: "configuration",
        active: true,
        source: "config" as const,
      };
    });
    const configuredKeys = new Set(configured.map((grant) => pathKey(grant.path)));
    return [
      ...configured,
      ...approvals.filter((grant) => grant.scope !== "permanent" || !configuredKeys.has(pathKey(grant.path))),
    ];
  }

  listAudit(limit = 50): WorkspaceAccessAuditView[] {
    const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const rows = this.database.sqlite.prepare(`
      select * from workspace_access_audit
      order by created_at desc
      limit ?
    `).all(boundedLimit) as AccessAuditRow[];
    return rows.map((row) => ({
      id: row.id,
      event: row.event,
      requestId: row.request_id ?? undefined,
      grantId: row.grant_id ?? undefined,
      path: row.path,
      access: nullableAccessMode(row.access),
      scope: nullableGrantScope(row.scope),
      detail: row.detail ?? undefined,
      createdAt: row.created_at,
    }));
  }

  async revokePath(inputPath: string): Promise<WorkspaceAccessRevocationResult> {
    const path = await canonicalPathForRevocation(inputPath);
    const now = this.now().toISOString();
    const roots = this.config.allowedRoots.filter((root) => pathKey(root) !== pathKey(path));
    const removedFromConfig = roots.length !== this.config.allowedRoots.length;

    if (removedFromConfig) {
      await this.persistAllowedRoots(roots);
      replaceAllowedRoots(this.config, roots);
    }

    const result = this.database.sqlite.prepare(`
      update workspace_access_grants
      set revoked_at = ?
      where revoked_at is null and path = ?
    `).run(now, path);
    this.database.sqlite.prepare(`
      update workspace_access_requests
      set status = 'revoked', token_hash = '', decided_at = coalesce(decided_at, ?)
      where path = ? and status = 'pending'
    `).run(now, path);
    this.insertAudit({
      event: "grant_revoked",
      path,
      detail: `revokedGrantCount=${result.changes}; removedFromConfig=${removedFromConfig}`,
      createdAt: now,
    });

    const inherited = this.findBestGrant(path, undefined, false);
    return {
      path,
      revokedGrantCount: result.changes,
      removedFromConfig,
      inheritedAccess: inherited?.access,
    };
  }

  close(): void {
    this.database.close();
  }

  private requestRow(id: string): AccessRequestRow {
    const row = this.database.sqlite.prepare(`
      select * from workspace_access_requests where id = ?
    `).get(id) as AccessRequestRow | undefined;
    if (!row) throw new AccessDeniedError("Unknown access request.");
    return row;
  }

  private assertPendingRequest(
    request: AccessRequestRow,
    token: string,
    conversationScopeId: string | undefined,
  ): void {
    if (request.status !== "pending") {
      throw new AccessDeniedError(`This access request is no longer pending (${request.status}).`);
    }
    if (Date.parse(request.expires_at) <= this.now().getTime()) {
      this.database.sqlite.prepare(`
        update workspace_access_requests
        set status = 'expired', token_hash = '', decided_at = ?
        where id = ? and status = 'pending'
      `).run(this.now().toISOString(), request.id);
      throw new AccessDeniedError("This access request expired. Ask DevSpace to create a new request.");
    }
    if (
      request.conversation_scope_id
      && conversationScopeId
      && request.conversation_scope_id !== conversationScopeId
    ) {
      throw new AccessDeniedError("This approval card belongs to a different conversation.");
    }
    const expected = Buffer.from(request.token_hash, "hex");
    const actual = Buffer.from(tokenHash(token), "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new AccessDeniedError("The approval token is invalid.");
    }
  }

  private finishRequest(
    requestId: string,
    status: string,
    decision: WorkspaceAccessDecision,
    decidedAt: string,
  ): void {
    this.database.sqlite.prepare(`
      update workspace_access_requests
      set status = ?, decision_scope = ?, token_hash = '', decided_at = ?
      where id = ? and status = 'pending'
    `).run(status, decision, decidedAt, requestId);
  }

  private findBestGrant(
    path: string,
    conversationScopeId: string | undefined,
    requireUnusedOnce: boolean,
  ): WorkspaceAccessAuthorization | undefined {
    const now = this.now().getTime();
    const candidates: Array<WorkspaceAccessAuthorization & { priority: number }> = [];

    for (const root of this.config.allowedRoots) {
      if (!isPathInsideRoot(path, root)) continue;
      candidates.push({
        path,
        root,
        access: "modify",
        scope: "configured",
        priority: 0,
      });
    }

    const rows = this.database.sqlite.prepare(`
      select * from workspace_access_grants
      where revoked_at is null
      order by created_at desc
    `).all() as AccessGrantRow[];
    for (const row of rows) {
      if (!isGrantActive(row, now, requireUnusedOnce)) continue;
      if (!isPathInsideRoot(path, row.path)) continue;
      if (
        (row.scope === "once" || row.scope === "session")
        && row.conversation_scope_id !== conversationScopeId
      ) continue;
      if (
        row.scope === "permanent"
        && !this.config.allowedRoots.some((root) => isPathInsideRoot(row.path, root))
      ) continue;
      candidates.push({
        path,
        root: row.path,
        access: accessMode(row.access),
        scope: grantScope(row.scope),
        grantId: row.id,
        priority: 1,
      });
    }

    candidates.sort((a, b) => {
      const lengthDifference = resolve(b.root).length - resolve(a.root).length;
      return lengthDifference !== 0 ? lengthDifference : b.priority - a.priority;
    });
    const selected = candidates[0];
    if (!selected) return undefined;
    const { priority: _priority, ...authorization } = selected;
    return authorization;
  }

  private assertWorkspaceGrantActive(
    workspace: Pick<Workspace, "root" | "accessMode" | "accessGrantId"> & Partial<Pick<Workspace, "mode" | "sourceRoot" | "worktree">>,
  ): void {
    // Managed worktrees inherit the existing source grant only within the configured managed root.
    const managed = workspace.mode === "worktree" && workspace.worktree?.managed === true && workspace.sourceRoot;
    if (managed) assertAllowedPath(workspace.root, [this.config.worktreeRoot]);
    const authorizedPath = managed ? workspace.sourceRoot! : workspace.root;
    if (!workspace.accessGrantId) {
      assertAllowedPath(authorizedPath, this.config.allowedRoots);
      return;
    }
    const row = this.database.sqlite.prepare(`
      select * from workspace_access_grants where id = ?
    `).get(workspace.accessGrantId) as AccessGrantRow | undefined;
    if (!row || row.revoked_at || isExpired(row.expires_at, this.now().getTime())) {
      throw new AccessDeniedError(
        `Workspace access is no longer active: ${workspace.root}. Request access again.`,
      );
    }
    if (!isPathInsideRoot(authorizedPath, row.path) || !accessSatisfies(accessMode(row.access), workspace.accessMode)) {
      throw new AccessDeniedError("Workspace is outside its existing grant or exceeds the approved access mode.");
    }
    if (
      row.scope === "permanent"
      && !this.config.allowedRoots.some((root) => isPathInsideRoot(authorizedPath, root))
    ) {
      throw new AccessDeniedError(
        `Workspace access was removed from configuration: ${workspace.root}. Request access again.`,
      );
    }
  }

  private insertAudit(input: {
    event: string;
    requestId?: string;
    grantId?: string;
    path: string;
    access?: WorkspaceAccessMode;
    scope?: WorkspaceGrantScope | WorkspaceAccessDecision;
    conversationScopeId?: string;
    detail?: string;
    createdAt: string;
  }): void {
    this.database.sqlite.prepare(`
      insert into workspace_access_audit (
        id, event, request_id, grant_id, path, access, scope,
        conversation_scope_id, detail, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `audit_${randomUUID()}`,
      input.event,
      input.requestId ?? null,
      input.grantId ?? null,
      input.path,
      input.access ?? null,
      input.scope ?? null,
      input.conversationScopeId ?? null,
      input.detail ?? null,
      input.createdAt,
    );
  }
}

export function replaceAllowedRoots(config: ServerConfig, roots: string[]): void {
  config.allowedRoots.splice(0, config.allowedRoots.length, ...appendUniquePaths([], roots));
}

export function accessRisk(path: string): WorkspaceAccessRisk {
  const resolved = resolve(path);
  const root = parse(resolved).root;
  if (pathKey(resolved) === pathKey(root)) return "high";

  const firstSegment = basename(dirname(resolved)) === ""
    ? basename(resolved)
    : resolved.slice(root.length).split(/[\\/]/, 1)[0] ?? "";
  const sensitive = new Set(["windows", "program files", "program files (x86)", "programdata"]);
  return sensitive.has(firstSegment.toLowerCase()) ? "high" : "standard";
}

async function canonicalExistingDirectory(path: string): Promise<string> {
  const canonical = await realpath(resolve(path));
  const information = await stat(canonical);
  if (!information.isDirectory()) {
    throw new Error(`Workspace access can only be granted to an existing directory: ${path}`);
  }
  return resolve(canonical);
}

async function canonicalPathForRevocation(path: string): Promise<string> {
  try {
    return await canonicalExistingDirectory(path);
  } catch (error) {
    if (isErrnoException(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return resolve(path);
    }
    throw error;
  }
}

async function verifyFilesystemAccess(path: string, mode: WorkspaceAccessMode): Promise<void> {
  await access(path, constants.R_OK);
  if (mode === "read") return;

  const probeDirectory = join(path, `.devspace-access-check-${randomBytes(8).toString("hex")}`);
  const initialFile = join(probeDirectory, "write-check.tmp");
  const renamedFile = join(probeDirectory, "rename-check.tmp");
  let directoryCreated = false;
  try {
    await mkdir(probeDirectory);
    directoryCreated = true;
    await writeFile(initialFile, "DevSpace permission check\n", { flag: "wx" });
    await rename(initialFile, renamedFile);
    await unlink(renamedFile);
    await rmdir(probeDirectory);
    directoryCreated = false;
  } catch (error) {
    await unlink(initialFile).catch(() => undefined);
    await unlink(renamedFile).catch(() => undefined);
    if (directoryCreated) await rmdir(probeDirectory).catch(() => undefined);
    const reason = error instanceof Error ? error.message : String(error);
    throw new AccessDeniedError(
      `The DevSpace service account does not have Modify permission for ${path}. ${reason}`,
    );
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function cleanReason(reason: string | undefined): string | undefined {
  const cleaned = reason?.trim().replace(/\s+/g, " ");
  return cleaned ? cleaned.slice(0, 500) : undefined;
}

function appendUniquePath(paths: string[], path: string): string[] {
  return appendUniquePaths(paths, [path]);
}

function appendUniquePaths(paths: string[], additions: string[]): string[] {
  const result = [...paths];
  const keys = new Set(paths.map(pathKey));
  for (const path of additions) {
    const resolved = resolve(path);
    if (keys.has(pathKey(resolved))) continue;
    keys.add(pathKey(resolved));
    result.push(resolved);
  }
  return result;
}

function pathKey(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function accessMode(value: string): WorkspaceAccessMode {
  if (value === "read" || value === "modify") return value;
  throw new Error(`Invalid stored workspace access mode: ${value}`);
}

function nullableAccessMode(value: string | null): WorkspaceAccessMode | undefined {
  return value === null ? undefined : accessMode(value);
}

function grantScope(value: string): Exclude<WorkspaceGrantScope, "configured"> {
  if (value === "once" || value === "session" || value === "permanent") return value;
  throw new Error(`Invalid stored workspace grant scope: ${value}`);
}

function nullableGrantScope(value: string | null): WorkspaceGrantScope | "deny" | undefined {
  if (value === null) return undefined;
  if (value === "deny") return value;
  return value === "configured" ? value : grantScope(value);
}

function accessSatisfies(actual: WorkspaceAccessMode, requested: WorkspaceAccessMode): boolean {
  return actual === "modify" || requested === "read";
}

function isGrantActive(row: AccessGrantRow, now: number, requireUnusedOnce: boolean): boolean {
  if (row.revoked_at || isExpired(row.expires_at, now)) return false;
  return !requireUnusedOnce || row.scope !== "once" || row.uses_remaining === 1;
}

function isExpired(expiresAt: string | null, now: number): boolean {
  return expiresAt !== null && Date.parse(expiresAt) <= now;
}

function grantView(row: AccessGrantRow, now: number): WorkspaceAccessGrantView {
  return {
    id: row.id,
    path: row.path,
    access: accessMode(row.access),
    scope: grantScope(row.scope),
    conversationScopeId: row.conversation_scope_id ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    createdAt: row.created_at,
    active: !row.revoked_at && !isExpired(row.expires_at, now)
      && (row.scope !== "once" || row.uses_remaining === 1),
    source: "approval",
  };
}

function approvalMessage(decision: Exclude<WorkspaceAccessDecision, "deny">, expiresAt?: string): string {
  if (decision === "once") {
    return "Approved for the next open_workspace call in this conversation.";
  }
  if (decision === "session") {
    return `Approved for this conversation until ${expiresAt}.`;
  }
  return "Approved permanently. The allowed-roots configuration is active without restarting DevSpace.";
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
