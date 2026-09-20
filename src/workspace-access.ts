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
import { readDevspaceAllowedRoots, setDevspaceConfigValue } from "./user-config.js";
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
  useGeneration?: number;
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
  configurationPending?: boolean;
  operationId?: string;
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
  revision: number;
  decision_operation_id: string | null;
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
  activation_state: string;
  operation_id: string | null;
  use_generation: number;
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
  readAllowedRoots?: () => string[];
  verifyFilesystemAccess?: (path: string, mode: WorkspaceAccessMode) => Promise<void>;
}

export interface WorkspaceAccessOperation {
  id: string;
  kind: "approval" | "revocation";
  request_id: string | null;
  path: string;
  decision: string;
  grant_id: string | null;
  request_revision: number | null;
  phase: string;
  revision: number;
  created_at: string;
  updated_at: string;
  detail_code: string | null;
}

interface ManagedRoot {
  path_key: string;
  path: string;
  active_grant_id: string | null;
  operation_id: string | null;
  generation: number;
}

const DEFAULT_REQUEST_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;

export class WorkspaceAccessManager {
  private readonly database: DatabaseHandle;
  private readonly now: () => Date;
  private readonly requestTtlMs: number;
  private readonly sessionTtlMs: number;
  private readonly persistAllowedRoots: (roots: string[]) => void | Promise<void>;
  private readonly readAllowedRoots: () => string[];
  private readonly verifyFilesystemAccess: (path: string, mode: WorkspaceAccessMode) => Promise<void>;

  constructor(
    private readonly config: ServerConfig,
    options: WorkspaceAccessManagerOptions = {},
  ) {
    this.database = openDatabase(config.stateDir);
    this.now = options.now ?? (() => new Date());
    this.requestTtlMs = options.requestTtlMs ?? DEFAULT_REQUEST_TTL_MS;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.verifyFilesystemAccess = options.verifyFilesystemAccess ?? verifyFilesystemAccess;
    this.readAllowedRoots = options.readAllowedRoots ?? (options.persistAllowedRoots
      ? () => [...this.config.allowedRoots]
      : () => readDevspaceAllowedRoots({ ...process.env, DEVSPACE_CONFIG_DIR: this.config.configDir }));
    this.persistAllowedRoots = options.persistAllowedRoots ?? ((roots) => {
      const env = { ...process.env, DEVSPACE_CONFIG_DIR: this.config.configDir };
      setDevspaceConfigValue(["workspaces", "allowedRoots"], roots, env);
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
        set status = 'superseded', token_hash = '', decided_at = ?, revision = revision + 1
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
    if (!["deny", "once", "session", "permanent"].includes(input.decision)) throw new AccessDeniedError("Unknown access decision.");
    if (input.decision === "deny") return this.database.sqlite.transaction(() => {
      const request = this.requestRow(input.requestId);
      this.assertPendingRequest(request, input.approvalToken, input.conversationScopeId);
      const decidedAt = this.now().toISOString();
      this.finishRequest(request, "denied", "deny", decidedAt);
      if (request.decision_operation_id) this.cancelReservedEffects(request.decision_operation_id, "cancelled", "user_denied");
      this.insertAudit({ event: "request_denied", requestId: request.id, path: request.path,
        access: accessMode(request.requested_access), scope: "deny", createdAt: decidedAt,
        conversationScopeId: request.conversation_scope_id ?? undefined });
      return { status: "denied" as const, path: request.path, access: accessMode(request.requested_access),
        decision: "deny" as const, message: "Access was denied. No pending decision can activate a grant." };
    }).immediate();

    const decision = input.decision;
    const operation = this.database.sqlite.transaction(() => {
      const request = this.requestRow(input.requestId);
      this.assertPendingRequest(request, input.approvalToken, input.conversationScopeId);
      if (request.decision_operation_id) throw new AccessDeniedError("This access request already has a reserved decision.");
      if ((decision === "once" || decision === "session") && !request.conversation_scope_id) {
        throw new AccessDeniedError("This host did not provide a conversation identity. Choose permanent access or deny this request.");
      }
      if (accessRisk(request.path) === "high" && input.confirmHighRisk !== true) {
        throw new AccessDeniedError("This is a high-risk system or drive-level path. Confirm the high-risk warning in the approval card first.");
      }
      const id = `access_op_${randomUUID()}`, grantId = `grant_${randomUUID()}`, timestamp = this.now().toISOString();
      const reserved = this.database.sqlite.prepare(`update workspace_access_requests
        set decision_operation_id = ?, revision = revision + 1
        where id = ? and revision = ? and status = 'pending' and decision_operation_id is null
          and julianday(expires_at) > julianday(?)`)
        .run(id, request.id, request.revision, timestamp);
      if (reserved.changes !== 1) throw new AccessDeniedError("Access decision reservation conflict or expiry.");
      this.database.sqlite.prepare(`insert into workspace_access_operations
        (id, kind, request_id, path, decision, grant_id, request_revision, phase, created_at, updated_at)
        values (?, 'approval', ?, ?, ?, ?, ?, 'reserved', ?, ?)`)
        .run(id, request.id, request.path, decision, grantId, request.revision + 1, timestamp, timestamp);
      this.insertAudit({ event: "decision_reserved", requestId: request.id, grantId,
        path: request.path, access: accessMode(request.requested_access), scope: decision, createdAt: timestamp });
      return this.operationRow(id);
    }).immediate();

    try {
      const request = this.assertReservedRequest(operation);
      const requestedAccess = accessMode(request.requested_access);
      await this.verifyFilesystemAccess(request.path, requestedAccess);
      let rootGeneration: number | undefined;
      let persistedRoots: string[] | undefined;
      if (decision === "permanent") {
        rootGeneration = this.database.sqlite.transaction(() => {
          const fresh = this.assertReservedRequest(operation);
          this.acquireConfigurationWriter(operation.id);
          const existing = this.managedRoot(fresh.path);
          const legacy = existing ? undefined : (this.database.sqlite.prepare(
            "select * from workspace_access_grants where scope = 'permanent' and revoked_at is null and activation_state = 'active' order by created_at desc",
          ).all() as AccessGrantRow[]).find(grant => pathKey(grant.path) === pathKey(fresh.path));
          if (!existing) this.database.sqlite.prepare(`insert into workspace_access_managed_roots
            (path_key, path, active_grant_id, operation_id, generation) values (?, ?, ?, ?, 1)`)
            .run(pathKey(fresh.path), fresh.path, legacy?.id ?? null, operation.id);
          else {
            const result = this.database.sqlite.prepare(`update workspace_access_managed_roots
              set operation_id = ?, generation = generation + 1 where path_key = ? and generation = ? and operation_id is null`)
              .run(operation.id, pathKey(fresh.path), existing.generation);
            if (result.changes !== 1) throw new AccessDeniedError("Another operation already reserved this permanent root.");
          }
          this.insertReservedGrant(operation, fresh, "prepared");
          this.advanceOperation(operation.id, "config_writing");
          return this.managedRoot(fresh.path)!.generation;
        }).immediate();
        // The reservation and inactive grant are durable before this external effect.
        // Managed-root entries never become unscoped configured Modify grants.
        const roots = appendUniquePath(this.readAllowedRoots(), request.path);
        await this.persistAllowedRoots(roots);
        persistedRoots = roots;
      }

      const approved = this.database.sqlite.transaction(() => {
        const fresh = this.assertReservedRequest(operation);
        const decidedAt = this.now().toISOString();
        let expiresAt: string | undefined;
        if (decision === "permanent") {
          this.assertConfigurationWriter(operation.id);
          if (!this.readAllowedRoots().some(root => isPathInsideRoot(fresh.path, root))) {
            throw new AccessDeniedError("Permanent root configuration is not present after persistence.");
          }
          const previous = this.managedRoot(fresh.path);
          const rootUpdate = this.database.sqlite.prepare(`update workspace_access_managed_roots
            set active_grant_id = ?, operation_id = null, generation = generation + 1
            where path_key = ? and generation = ? and operation_id = ?`)
            .run(operation.grant_id, pathKey(fresh.path), rootGeneration, operation.id);
          if (rootUpdate.changes !== 1) throw new AccessDeniedError("Permanent root reservation became stale.");
          const activated = this.database.sqlite.prepare(`update workspace_access_grants set activation_state = 'active'
            where id = ? and operation_id = ? and activation_state = 'prepared' and revoked_at is null`)
            .run(operation.grant_id, operation.id);
          if (activated.changes !== 1) throw new AccessDeniedError("Prepared grant cannot be activated.");
          if (previous?.active_grant_id) this.database.sqlite.prepare("update workspace_access_grants set revoked_at = ? where id = ?")
            .run(decidedAt, previous.active_grant_id);
        } else {
          expiresAt = this.insertReservedGrant(operation, fresh, "active");
        }
        this.finishRequest(fresh, "approved", decision, decidedAt);
        this.advanceOperation(operation.id, "committed");
        this.releaseConfigurationWriter(operation.id);
        this.insertAudit({ event: "grant_approved", requestId: fresh.id, grantId: operation.grant_id!,
          path: fresh.path, access: requestedAccess, scope: decision,
          conversationScopeId: fresh.conversation_scope_id ?? undefined, createdAt: decidedAt });
        return { status: "approved" as const, path: fresh.path, access: requestedAccess, decision,
          grantId: operation.grant_id!, expiresAt, message: approvalMessage(decision, expiresAt) };
      }).immediate();
      if (persistedRoots) replaceAllowedRoots(this.config, persistedRoots);
      return approved;
    } catch (error) {
      this.database.sqlite.transaction(() => {
        const current = this.operationRow(operation.id);
        if (current.phase === "committed") return;
        const uncertain = ["config_writing", "recovery_uncertain"].includes(current.phase);
        this.database.sqlite.prepare(`update workspace_access_requests
          set status = 'failed', token_hash = '', revision = revision + 1, decided_at = ?
          where id = ? and decision_operation_id = ? and status = 'pending'`)
          .run(this.now().toISOString(), operation.request_id, operation.id);
        this.cancelReservedEffects(operation.id, uncertain ? "recovery_uncertain" : current.phase === "cancelled" ? "cancelled" : "failed",
          uncertain ? "configuration_effect_may_have_applied" : "decision_not_committed");
        this.releaseConfigurationWriter(operation.id);
        this.insertAudit({ event: "grant_failed", requestId: operation.request_id ?? undefined,
          grantId: operation.grant_id ?? undefined, path: operation.path, scope: decision,
          detail: uncertain ? "configuration_effect_may_have_applied" : "decision_not_committed", createdAt: this.now().toISOString() });
      }).immediate();
      if (error instanceof AccessDeniedError) throw error;
      throw new AccessDeniedError(`Workspace approval was not committed. Inspect recovery operation ${operation.id}.`);
    }
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

      const reserved = this.database.sqlite.transaction(() => {
        const row = this.database.sqlite.prepare(`update workspace_access_grants
          set uses_remaining = 0, use_generation = use_generation + 1
          where id = ? and revoked_at is null and activation_state = 'active' and uses_remaining = 1
            and use_generation = ? and (expires_at is null or julianday(expires_at) > julianday(?))
          returning use_generation`).get(grant.grantId, grant.useGeneration, this.now().toISOString()) as { use_generation: number } | undefined;
        if (!row) return undefined;
        this.insertAudit({
          event: "grant_consumed",
          grantId: grant.grantId,
          path: grant.root,
          access: grant.access,
          scope: grant.scope,
          conversationScopeId,
          createdAt: this.now().toISOString(),
        });
        return { ...grant, path, consumedOnce: true, useGeneration: row.use_generation };
      }).immediate();
      if (reserved) return reserved;
    }
  }

  releaseOnceAuthorization(authorization: WorkspaceAccessAuthorization): void {
    if (!authorization.consumedOnce || !authorization.grantId || authorization.useGeneration === undefined) return;
    this.database.sqlite.transaction(() => {
    const restored = this.database.sqlite.prepare(`
      update workspace_access_grants
      set uses_remaining = 1, use_generation = use_generation + 1
      where id = ? and revoked_at is null and activation_state = 'active' and uses_remaining = 0
        and use_generation = ? and (expires_at is null or julianday(expires_at) > julianday(?))
    `).run(authorization.grantId, authorization.useGeneration, this.now().toISOString());
    if (restored.changes !== 1) return;
    this.insertAudit({
      event: "grant_restored_after_open_failure",
      grantId: authorization.grantId,
      path: authorization.root,
      access: authorization.access,
      scope: authorization.scope,
      createdAt: this.now().toISOString(),
    });
    }).immediate();
  }

  workspaceRestoreAllowedRoots(
    session: Pick<
      WorkspaceSession,
      "root" | "mode" | "sourceRoot" | "accessMode" | "accessGrantId"
    >,
  ): string[] {
    if (!session.accessGrantId) return this.unmanagedConfiguredRoots();

    const row = this.database.sqlite.prepare(`
      select * from workspace_access_grants where id = ?
    `).get(session.accessGrantId) as AccessGrantRow | undefined;
    if (!row || !isGrantActive(row, this.now().getTime(), false) || !this.permanentGrantIsCurrent(row)) {
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
      && !this.readAllowedRoots().some((root) => isPathInsideRoot(authorizedPath, root))
    ) {
      throw new AccessDeniedError(
        `Workspace access was removed from configuration: ${session.root}. Request access again.`,
      );
    }

    return appendUniquePath(this.unmanagedConfiguredRoots(), row.path);
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
      .map((row) => ({ ...grantView(row, now), active: grantView(row, now).active
        && this.permanentGrantIsCurrent(row)
        && (row.scope !== "permanent" || this.readAllowedRoots().some(root => isPathInsideRoot(row.path, root))) }));
    const approvedByPath = new Map(
      approvals
        .filter((grant) => grant.scope === "permanent" && grant.active)
        .map((grant) => [pathKey(grant.path), grant]),
    );
    const configured = this.unmanagedConfiguredRoots().map((path) => {
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
    const previousRoots = this.readAllowedRoots();
    const configured = previousRoots.some(root => pathKey(root) === pathKey(path));
    const operationId = `access_op_${randomUUID()}`;
    const result = this.database.sqlite.transaction(() => {
      const rootsManaged = Boolean(this.managedRoot(path));
      if (configured || rootsManaged) this.database.sqlite.prepare(`insert into workspace_access_managed_roots
        (path_key, path, active_grant_id, operation_id, generation) values (?, ?, null, null, 1)
        on conflict(path_key) do update set active_grant_id = null, operation_id = null, generation = generation + 1`)
        .run(pathKey(path), path);
      const grants = (this.database.sqlite.prepare("select * from workspace_access_grants where revoked_at is null").all() as AccessGrantRow[])
        .filter(grant => pathKey(grant.path) === pathKey(path));
      for (const grant of grants) this.database.sqlite.prepare("update workspace_access_grants set revoked_at = ? where id = ?").run(now, grant.id);
      const requests = (this.database.sqlite.prepare("select * from workspace_access_requests where status = 'pending'").all() as AccessRequestRow[])
        .filter(request => pathKey(request.path) === pathKey(path));
      for (const request of requests) {
        this.database.sqlite.prepare(`update workspace_access_requests set status = 'revoked', token_hash = '',
          decided_at = ?, revision = revision + 1 where id = ? and revision = ?`).run(now, request.id, request.revision);
        if (request.decision_operation_id) this.cancelReservedEffects(request.decision_operation_id, "cancelled", "user_revoked");
      }
      const needsConfiguration = configured || rootsManaged;
      this.database.sqlite.prepare(`insert into workspace_access_operations
        (id, kind, path, decision, phase, created_at, updated_at) values (?, 'revocation', ?, 'revoke', ?, ?, ?)`)
        .run(operationId, path, needsConfiguration ? "config_pending" : "committed", now, now);
      this.insertAudit({ event: "grant_revoked", path,
        detail: `revokedGrantCount=${grants.length}; configurationPending=${needsConfiguration}`, createdAt: now });
      return { revokedGrantCount: grants.length, needsConfiguration };
    }).immediate();
    // Revoke authority before any asynchronous configuration write. An in-flight
    // approval cannot turn a stale configured root into an unscoped grant.
    replaceAllowedRoots(this.config, previousRoots.filter(root => pathKey(root) !== pathKey(path)));
    const persisted = result.needsConfiguration ? await this.persistRevocation(operationId) : true;
    const inherited = this.findBestGrant(path, undefined, false);
    return {
      path,
      revokedGrantCount: result.revokedGrantCount,
      removedFromConfig: configured && persisted,
      inheritedAccess: inherited?.access,
      configurationPending: !persisted,
      operationId,
    };
  }

  close(): void {
    this.database.close();
  }

  /** Administrative read surface. Approval tokens and configuration contents are never returned. */
  listOperations(limit = 100, after = ""): WorkspaceAccessOperation[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Invalid access-operation page size.");
    return this.database.sqlite.prepare("select * from workspace_access_operations where id > ? order by id limit ?")
      .all(after, limit) as WorkspaceAccessOperation[];
  }

  /** Conservative recovery cancels intent; it never resumes an old approval or grants authority. */
  cancelOperationForRecovery(id: string, expectedRevision: number): WorkspaceAccessOperation {
    return this.database.sqlite.transaction(() => {
      const operation = this.operationRow(id);
      if (operation.revision !== expectedRevision) throw new AccessDeniedError("Access recovery revision conflict.");
      if (operation.phase === "committed") throw new AccessDeniedError("A committed access operation must use the ordinary revoke flow.");
      this.database.sqlite.prepare(`update workspace_access_requests set status = 'cancelled', token_hash = '',
        revision = revision + 1, decided_at = ? where decision_operation_id = ? and status = 'pending'`)
        .run(this.now().toISOString(), operation.id);
      this.cancelReservedEffects(id, operation.kind === "revocation" ? "recovery_uncertain" : "cancelled", "recovery_cancelled_no_grant");
      this.releaseConfigurationWriter(id);
      this.insertAudit({ event: "decision_recovery_cancelled", requestId: operation.request_id ?? undefined,
        grantId: operation.grant_id ?? undefined, path: operation.path, createdAt: this.now().toISOString(),
        detail: "No approval replayed. A late configuration writer remains non-authoritative." });
      return this.operationRow(id);
    }).immediate();
  }

  /** Explicit maintenance, not called by Doctor and not registered as an approval tool. */
  async resumeRevocationCleanup(id: string, expectedRevision: number): Promise<boolean> {
    const operation = this.operationRow(id);
    if (operation.kind !== "revocation" || operation.revision !== expectedRevision) {
      throw new AccessDeniedError("Revocation recovery revision or operation mismatch.");
    }
    return this.persistRevocation(id, expectedRevision);
  }

  private operationRow(id: string): WorkspaceAccessOperation {
    const row = this.database.sqlite.prepare("select * from workspace_access_operations where id = ?")
      .get(id) as WorkspaceAccessOperation | undefined;
    if (!row) throw new AccessDeniedError("Unknown access operation.");
    return row;
  }

  private assertReservedRequest(operation: WorkspaceAccessOperation): AccessRequestRow {
    if (operation.kind !== "approval" || !operation.request_id) throw new AccessDeniedError("Not an approval reservation.");
    const request = this.requestRow(operation.request_id), current = this.operationRow(operation.id);
    if (request.status !== "pending" || request.decision_operation_id !== operation.id
      || request.revision !== operation.request_revision || request.path !== operation.path
      || !["reserved", "config_writing"].includes(current.phase)) {
      throw new AccessDeniedError("This access request is no longer pending under its reserved revision.");
    }
    const expiry = Date.parse(request.expires_at);
    if (!Number.isFinite(expiry) || expiry <= this.now().getTime()) throw new AccessDeniedError("This access request expired during verification.");
    return request;
  }

  private insertReservedGrant(operation: WorkspaceAccessOperation, request: AccessRequestRow, activation: "prepared" | "active"): string | undefined {
    const timestamp = this.now().toISOString();
    const expiresAt = operation.decision === "session" ? new Date(this.now().getTime() + this.sessionTtlMs).toISOString() : undefined;
    this.database.sqlite.prepare(`insert into workspace_access_grants
      (id, path, access, scope, conversation_scope_id, request_id, uses_remaining, expires_at, created_at, activation_state, operation_id)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(operation.grant_id, request.path, request.requested_access, operation.decision, request.conversation_scope_id,
        request.id, operation.decision === "once" ? 1 : null, expiresAt ?? null, timestamp, activation, operation.id);
    return expiresAt;
  }

  private managedRoot(path: string): ManagedRoot | undefined {
    return this.database.sqlite.prepare("select * from workspace_access_managed_roots where path_key = ?")
      .get(pathKey(path)) as ManagedRoot | undefined;
  }

  private unmanagedConfiguredRoots(): string[] {
    const managed = new Set((this.database.sqlite.prepare("select path_key from workspace_access_managed_roots").all() as { path_key: string }[])
      .map(row => row.path_key));
    return this.readAllowedRoots().filter(root => !managed.has(pathKey(root)));
  }

  private permanentGrantIsCurrent(grant: AccessGrantRow): boolean {
    if (grant.scope !== "permanent") return true;
    const managed = this.managedRoot(grant.path);
    return !managed || managed.active_grant_id === grant.id;
  }

  private acquireConfigurationWriter(operationId: string): void {
    const result = this.database.sqlite.prepare(`update workspace_access_config_serialization set operation_id = ?
      where singleton = 1 and operation_id is null`).run(operationId);
    if (result.changes !== 1) throw new AccessDeniedError("An access configuration operation is still in progress; inspect its recovery journal before retrying.");
  }

  private assertConfigurationWriter(operationId: string): void {
    const row = this.database.sqlite.prepare("select operation_id from workspace_access_config_serialization where singleton = 1")
      .get() as { operation_id: string | null };
    if (row.operation_id !== operationId) throw new AccessDeniedError("Configuration writer reservation became stale.");
  }

  private releaseConfigurationWriter(operationId: string): void {
    this.database.sqlite.prepare("update workspace_access_config_serialization set operation_id = null where singleton = 1 and operation_id = ?")
      .run(operationId);
  }

  private advanceOperation(id: string, phase: string, detailCode?: string): void {
    const current = this.operationRow(id);
    const result = this.database.sqlite.prepare(`update workspace_access_operations
      set phase = ?, detail_code = ?, updated_at = ?, revision = revision + 1 where id = ? and revision = ? and phase <> 'committed'`)
      .run(phase, detailCode ?? null, this.now().toISOString(), id, current.revision);
    if (result.changes !== 1) throw new AccessDeniedError("Access operation revision conflict.");
  }

  private cancelReservedEffects(id: string, phase: string, detailCode: string): void {
    const operation = this.operationRow(id);
    if (operation.phase === "committed") return;
    const uncertain = ["config_writing", "recovery_uncertain"].includes(operation.phase);
    this.database.sqlite.prepare(`update workspace_access_grants set revoked_at = coalesce(revoked_at, ?)
      where operation_id = ? and activation_state = 'prepared'`).run(this.now().toISOString(), id);
    this.database.sqlite.prepare(`update workspace_access_managed_roots set operation_id = null, generation = generation + 1
      where operation_id = ?`).run(id);
    this.advanceOperation(id, uncertain ? "recovery_uncertain" : phase,
      uncertain ? "configuration_effect_may_have_applied" : detailCode);
  }

  private async persistRevocation(id: string, expectedRevision?: number): Promise<boolean> {
    const operation = this.operationRow(id);
    if (operation.kind !== "revocation") throw new AccessDeniedError("Only revocation cleanup can be resumed.");
    if (operation.phase === "committed") return true;
    try {
      this.database.sqlite.transaction(() => {
        const fresh = this.operationRow(id);
        if ((expectedRevision !== undefined && fresh.revision !== expectedRevision)
          || !["config_pending", "recovery_uncertain"].includes(fresh.phase)) throw new AccessDeniedError("Revocation cleanup revision conflict.");
        this.acquireConfigurationWriter(id);
        this.advanceOperation(id, "config_writing");
      }).immediate();
    } catch (error) {
      if (error instanceof AccessDeniedError) return false;
      throw error;
    }
    try {
      const roots = this.readAllowedRoots().filter(root => pathKey(root) !== pathKey(operation.path));
      await this.persistAllowedRoots(roots);
      replaceAllowedRoots(this.config, roots);
      this.database.sqlite.transaction(() => {
        this.assertConfigurationWriter(id);
        if (this.operationRow(id).phase !== "config_writing") throw new AccessDeniedError("Revocation cleanup became stale.");
        this.advanceOperation(id, "committed");
        this.releaseConfigurationWriter(id);
      }).immediate();
      return true;
    } catch {
      this.database.sqlite.transaction(() => {
        if (this.operationRow(id).phase !== "committed") this.advanceOperation(id, "recovery_uncertain", "revocation_config_cleanup_failed");
        this.releaseConfigurationWriter(id);
      }).immediate();
      return false;
    }
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
    if (!Number.isFinite(Date.parse(request.expires_at)) || Date.parse(request.expires_at) <= this.now().getTime()) {
      this.database.sqlite.prepare(`
        update workspace_access_requests
        set status = 'expired', token_hash = '', decided_at = ?, revision = revision + 1
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
    request: AccessRequestRow,
    status: string,
    decision: WorkspaceAccessDecision,
    decidedAt: string,
  ): void {
    const result = this.database.sqlite.prepare(`
      update workspace_access_requests
      set status = ?, decision_scope = ?, token_hash = '', decided_at = ?, revision = revision + 1
      where id = ? and status = 'pending' and revision = ? and decision_operation_id is ?
    `).run(status, decision, decidedAt, request.id, request.revision, request.decision_operation_id);
    if (result.changes !== 1) throw new AccessDeniedError("Access request transition conflicted with a newer decision.");
  }

  private findBestGrant(
    path: string,
    conversationScopeId: string | undefined,
    requireUnusedOnce: boolean,
  ): WorkspaceAccessAuthorization | undefined {
    const now = this.now().getTime();
    const candidates: Array<WorkspaceAccessAuthorization & { priority: number }> = [];

    for (const root of this.unmanagedConfiguredRoots()) {
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
      if (!this.permanentGrantIsCurrent(row)) continue;
      if (!isPathInsideRoot(path, row.path)) continue;
      if (
        (row.scope === "once" || row.scope === "session")
        && row.conversation_scope_id !== conversationScopeId
      ) continue;
      if (
        row.scope === "permanent"
        && !this.readAllowedRoots().some((root) => isPathInsideRoot(row.path, root))
      ) continue;
      candidates.push({
        path,
        root: row.path,
        access: accessMode(row.access),
        scope: grantScope(row.scope),
        grantId: row.id,
        useGeneration: row.use_generation,
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
      assertAllowedPath(authorizedPath, this.unmanagedConfiguredRoots());
      return;
    }
    const row = this.database.sqlite.prepare(`
      select * from workspace_access_grants where id = ?
    `).get(workspace.accessGrantId) as AccessGrantRow | undefined;
    if (!row || !isGrantActive(row, this.now().getTime(), false) || !this.permanentGrantIsCurrent(row)) {
      throw new AccessDeniedError(
        `Workspace access is no longer active: ${workspace.root}. Request access again.`,
      );
    }
    if (!isPathInsideRoot(authorizedPath, row.path) || !accessSatisfies(accessMode(row.access), workspace.accessMode)) {
      throw new AccessDeniedError("Workspace is outside its existing grant or exceeds the approved access mode.");
    }
    if (
      row.scope === "permanent"
      && !this.readAllowedRoots().some((root) => isPathInsideRoot(authorizedPath, root))
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
  if (row.activation_state !== "active" || row.revoked_at || isExpired(row.expires_at, now)) return false;
  return !requireUnusedOnce || row.scope !== "once" || row.uses_remaining === 1;
}

function isExpired(expiresAt: string | null, now: number): boolean {
  return expiresAt !== null && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now);
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
    active: isGrantActive(row, now, true),
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
