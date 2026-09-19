import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workspaceSessions = sqliteTable(
  "workspace_sessions",
  {
    id: text("id").primaryKey(),
    root: text("root").notNull(),
    status: text("status").notNull().default("active"),
    mode: text("mode").notNull().default("checkout"),
    sourceRoot: text("source_root"),
    baseRef: text("base_ref"),
    baseSha: text("base_sha"),
    managed: text("managed").notNull().default("false"),
    accessMode: text("access_mode").notNull().default("modify"),
    accessGrantId: text("access_grant_id"),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (table) => [
    index("workspace_sessions_root_idx").on(table.root, table.lastUsedAt),
    index("workspace_sessions_status_idx").on(table.status, table.lastUsedAt),
  ],
);

export const loadedAgentFiles = sqliteTable(
  "loaded_agent_files",
  {
    workspaceSessionId: text("workspace_session_id")
      .notNull()
      .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    contentHash: text("content_hash").notNull(),
    content: text("content").notNull(),
    loadedAt: text("loaded_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceSessionId, table.path] }),
    index("loaded_agent_files_path_idx").on(table.path),
  ],
);

export const workspaceConversationBindings = sqliteTable(
  "workspace_conversation_bindings",
  {
    conversationScopeId: text("conversation_scope_id").notNull(),
    targetKey: text("target_key").notNull(),
    workspaceSessionId: text("workspace_session_id")
      .notNull()
      .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationScopeId, table.targetKey] }),
    index("workspace_conversation_bindings_workspace_idx").on(table.workspaceSessionId),
  ],
);

export const oauthClients = sqliteTable(
  "oauth_clients",
  {
    clientId: text("client_id").primaryKey(),
    clientJson: text("client_json").notNull(),
    issuedAt: integer("issued_at").notNull(),
  },
);

export const oauthAccessTokens = sqliteTable(
  "oauth_access_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resource: text("resource"),
  },
);

export const oauthRefreshTokens = sqliteTable(
  "oauth_refresh_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resource: text("resource"),
  },
);

export const localAgentSessions = sqliteTable(
  "local_agent_sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id"),
    workspaceRoot: text("workspace_root").notNull(),
    profileName: text("profile_name").notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    effort: text("effort"),
    providerSessionId: text("provider_session_id"),
    status: text("status").notNull(),
    latestResponse: text("latest_response"),
    error: text("error"),
    errorCode: text("error_code"),
    errorRetryable: text("error_retryable"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("local_agent_sessions_workspace_id_idx").on(table.workspaceId, table.updatedAt),
    index("local_agent_sessions_workspace_root_idx").on(table.workspaceRoot, table.updatedAt),
    index("local_agent_sessions_provider_session_id_idx").on(table.providerSessionId),
  ],
);

export const workspaceAccessRequests = sqliteTable(
  "workspace_access_requests",
  {
    id: text("id").primaryKey(),
    path: text("path").notNull(),
    requestedAccess: text("requested_access").notNull(),
    reason: text("reason"),
    conversationScopeId: text("conversation_scope_id"),
    tokenHash: text("token_hash").notNull(),
    status: text("status").notNull().default("pending"),
    decisionScope: text("decision_scope"),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    decidedAt: text("decided_at"),
  },
  (table) => [
    index("workspace_access_requests_status_idx").on(table.status, table.createdAt),
    index("workspace_access_requests_path_idx").on(table.path, table.createdAt),
  ],
);

export const workspaceAccessGrants = sqliteTable(
  "workspace_access_grants",
  {
    id: text("id").primaryKey(),
    path: text("path").notNull(),
    access: text("access").notNull(),
    scope: text("scope").notNull(),
    conversationScopeId: text("conversation_scope_id"),
    requestId: text("request_id"),
    usesRemaining: integer("uses_remaining"),
    expiresAt: text("expires_at"),
    createdAt: text("created_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    index("workspace_access_grants_path_idx").on(table.path, table.createdAt),
    index("workspace_access_grants_active_idx").on(table.revokedAt, table.expiresAt),
  ],
);

export const workspaceAccessAudit = sqliteTable(
  "workspace_access_audit",
  {
    id: text("id").primaryKey(),
    event: text("event").notNull(),
    requestId: text("request_id"),
    grantId: text("grant_id"),
    path: text("path").notNull(),
    access: text("access"),
    scope: text("scope"),
    conversationScopeId: text("conversation_scope_id"),
    detail: text("detail"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("workspace_access_audit_created_idx").on(table.createdAt),
    index("workspace_access_audit_path_idx").on(table.path, table.createdAt),
  ],
);

export type WorkspaceSessionRow = typeof workspaceSessions.$inferSelect;
export type NewWorkspaceSessionRow = typeof workspaceSessions.$inferInsert;
export type LoadedAgentFileRow = typeof loadedAgentFiles.$inferSelect;
export type NewLoadedAgentFileRow = typeof loadedAgentFiles.$inferInsert;
export type WorkspaceConversationBindingRow = typeof workspaceConversationBindings.$inferSelect;
export type NewWorkspaceConversationBindingRow = typeof workspaceConversationBindings.$inferInsert;
export type LocalAgentSessionRow = typeof localAgentSessions.$inferSelect;
export type NewLocalAgentSessionRow = typeof localAgentSessions.$inferInsert;
