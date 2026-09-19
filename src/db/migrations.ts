import type Database from "better-sqlite3";

interface Migration {
  version: number;
  name: string;
  up(sqlite: Database.Database): void;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: "workspace-state",
    up: migrateWorkspaceState,
  },
  {
    version: 2,
    name: "oauth-state",
    up: migrateOAuthState,
  },
  {
    version: 3,
    name: "local-agent-sessions",
    up: migrateLocalAgentSessions,
  },
  {
    version: 4,
    name: "workspace-conversation-bindings",
    up: migrateWorkspaceConversationBindings,
  },
  {
    version: 5,
    name: "local-agent-structured-errors",
    up: migrateLocalAgentStructuredErrors,
  },
  {
    version: 6,
    name: "local-agent-effort-rename",
    up: migrateLocalAgentEffortRename,
  },
  {
    version: 7,
    name: "workspace-access-approvals",
    up: migrateWorkspaceAccessApprovals,
  },
  {
    version: 8,
    name: "managed-goal-bindings",
    up: (sqlite) => sqlite.exec(`
      create table managed_goal_bindings (
        goal_ref text primary key,
        owner_ref text not null,
        workspace_root text not null,
        data_dir text not null unique,
        creation_request_key text not null,
        provider_session_id text unique,
        creation_phase text not null,
        control_state text not null,
        revision integer not null default 1,
        owner_epoch integer not null default 1,
        checkpoint_ref text,
        created_at text not null,
        updated_at text not null,
        unique(owner_ref, creation_request_key)
      );
      create unique index managed_goal_active_project on managed_goal_bindings(workspace_root)
        where control_state <> 'stopped';
      create table managed_goal_operations (
        owner_ref text not null,
        request_key text not null,
        goal_ref text not null references managed_goal_bindings(goal_ref),
        request_fingerprint text not null,
        response_json text not null,
        created_at text not null,
        primary key(owner_ref, request_key)
      );
    `),
  },
  {
    version: 9,
    name: "managed-goal-control-observations",
    up: (sqlite) => sqlite.exec(`
      alter table managed_goal_bindings add column spec_json text;
      alter table managed_goal_bindings add column observation_json text;
      drop index managed_goal_active_project;
      create unique index managed_goal_active_project on managed_goal_bindings(workspace_root)
        where control_state not in ('stopped', 'completed');
    `),
  },
  {
    version: 10,
    name: "chat-goal-controller-metadata",
    up: sqlite => sqlite.exec(`
      create table chat_goal_bindings (
        goal_ref text primary key,
        owner_ref text not null,
        workspace_root text not null,
        creation_key text not null,
        metadata_json text not null,
        inflight_key text,
        unique(owner_ref, creation_key)
      );
      create table chat_goal_requests (
        owner_ref text not null,
        request_key text not null,
        goal_ref text not null references chat_goal_bindings(goal_ref),
        fingerprint text not null,
        response_json text,
        primary key(owner_ref, request_key)
      );
    `),
  },
  {
    version: 11,
    name: "multi-session-orchestration-v1",
    up: sqlite => sqlite.exec(
      "create table orchestration_sessions (" +
      "id text primary key," +
      "project_key text not null," +
      "workspace_id text," +
      "workspace_root text not null," +
      "session_kind text not null default 'chat'," +
      "external_session_id text," +
      "label text," +
      "state text not null," +
      "task text," +
      "last_heartbeat_at text," +
      "last_activity_at text not null," +
      "last_test_at text," +
      "last_file_change_at text," +
      "last_error_fingerprint text," +
      "consecutive_error_count integer not null default 0," +
      "created_at text not null," +
      "updated_at text not null" +
      ");" +
      "create index orchestration_sessions_project_idx on orchestration_sessions(project_key, updated_at desc);" +
      "create index orchestration_sessions_workspace_idx on orchestration_sessions(workspace_root, updated_at desc);" +
      "create index orchestration_sessions_state_idx on orchestration_sessions(state, updated_at desc);" +
      "create unique index orchestration_sessions_external_idx on orchestration_sessions(session_kind, external_session_id) where external_session_id is not null;" +
      "create table orchestration_events (" +
      "id integer primary key autoincrement," +
      "session_id text not null references orchestration_sessions(id) on delete cascade," +
      "kind text not null," +
      "detail_json text not null default '{}'," +
      "created_at text not null" +
      ");" +
      "create index orchestration_events_session_idx on orchestration_events(session_id, id desc);" +
      "create table orchestration_file_intents (" +
      "session_id text not null references orchestration_sessions(id) on delete cascade," +
      "path text not null," +
      "access text not null," +
      "created_at text not null," +
      "primary key(session_id, path, access)" +
      ");" +
      "create index orchestration_file_intents_path_idx on orchestration_file_intents(path, access);"
    ),
  },
  {
    version: 12,
    name: "multi-session-coordinator-v2",
    up: sqlite => sqlite.exec(
      "create table coordinator_tasks (" +
      "id text primary key," +
      "project_key text not null," +
      "name text not null," +
      "description text not null," +
      "state text not null," +
      "priority integer not null default 0," +
      "revision integer not null default 1," +
      "owner_session_id text references orchestration_sessions(id) on delete set null," +
      "lease_token text," +
      "lease_expires_at text," +
      "created_at text not null," +
      "updated_at text not null," +
      "completed_at text," +
      "unique(project_key, name)" +
      ");" +
      "create index coordinator_tasks_project_idx on coordinator_tasks(project_key, state, priority desc, created_at asc);" +
      "create index coordinator_tasks_owner_idx on coordinator_tasks(owner_session_id, state);" +
      "create table coordinator_task_dependencies (" +
      "task_id text not null references coordinator_tasks(id) on delete cascade," +
      "depends_on_task_id text not null references coordinator_tasks(id) on delete cascade," +
      "primary key(task_id, depends_on_task_id)," +
      "check(task_id <> depends_on_task_id)" +
      ");" +
      "create index coordinator_task_dependencies_parent_idx on coordinator_task_dependencies(depends_on_task_id, task_id);"
    ),
  },
  {
    version: 13,
    name: "coordinator-worktree-bindings-v2",
    up: sqlite => sqlite.exec(`
      create table worktree_bindings (
        id text primary key, project_key text not null, revision integer not null,
        data_json text not null, created_at text not null, updated_at text not null
      );
      create index worktree_bindings_project on worktree_bindings(project_key, created_at, id);
    `),
  },
  {
    version: 14, name: "integration-records-v2",
    up: sqlite => sqlite.exec(`
      create table integration_records (
        id text primary key, project_key text not null, revision integer not null,
        data_json text not null, created_at text not null, updated_at text not null
      );
      create index integration_records_project on integration_records(project_key, id);
    `),
  },
  {
    version: 15, name: "watchdog-alerts-v2",
    up: sqlite => sqlite.exec(`
      create table watchdog_alerts (
        id text primary key, project_key text not null, revision integer not null,
        data_json text not null, created_at text not null, updated_at text not null
      );
      create index watchdog_alerts_project on watchdog_alerts(project_key, id);
    `),
  },
  {
    version: 16, name: "handoff-checkpoints-v2",
    up: sqlite => sqlite.exec(`
      create table handoff_checkpoints (
        id text primary key, project_key text not null, revision integer not null,
        data_json text not null, created_at text not null, updated_at text not null
      );
      create index handoff_checkpoints_project on handoff_checkpoints(project_key, id);
    `),
  },
  {
    version: 17, name: "project-memory-v2",
    up: sqlite => sqlite.exec(`
      create table project_memory (
        id text primary key, project_key text not null unique, revision integer not null,
        data_json text not null, created_at text not null, updated_at text not null
      );
    `),
  },
  {
    version: 18, name: "automation-due-work-v2",
    up: sqlite => sqlite.exec(`
      create table automation_due_work (
        id text primary key, project_key text not null, revision integer not null,
        data_json text not null, created_at text not null, updated_at text not null
      );
      create index automation_due_work_project on automation_due_work(project_key, id);
    `),
  },
];

export function migrateDatabase(sqlite: Database.Database): void {
  const migrate = sqlite.transaction(() => {
    sqlite.exec(`
      create table if not exists devspace_schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      );
    `);

    const applied = new Set(
      (
        sqlite.prepare("select version from devspace_schema_migrations").all() as Array<{
          version: number;
        }>
      ).map((row) => row.version),
    );
    const recordMigration = sqlite.prepare(
      "insert into devspace_schema_migrations (version, name, applied_at) values (?, ?, ?)",
    );

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      migration.up(sqlite);
      recordMigration.run(migration.version, migration.name, new Date().toISOString());
    }
  });

  migrate.immediate();
}

function migrateWorkspaceState(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workspace_sessions (
      id text primary key,
      root text not null,
      status text not null default 'active',
      mode text not null default 'checkout',
      source_root text,
      base_ref text,
      base_sha text,
      managed text not null default 'false',
      created_at text not null,
      last_used_at text not null
    );

    create index if not exists workspace_sessions_root_idx
      on workspace_sessions(root, last_used_at desc);

    create index if not exists workspace_sessions_status_idx
      on workspace_sessions(status, last_used_at desc);

    create table if not exists loaded_agent_files (
      workspace_session_id text not null,
      path text not null,
      content_hash text not null,
      content text not null,
      loaded_at text not null,
      last_seen_at text not null,
      primary key (workspace_session_id, path),
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

    create index if not exists loaded_agent_files_path_idx
      on loaded_agent_files(path);
  `);

  addColumnIfMissing(sqlite, "workspace_sessions", "mode", "text not null default 'checkout'");
  addColumnIfMissing(sqlite, "workspace_sessions", "source_root", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "base_ref", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "base_sha", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "managed", "text not null default 'false'");
  addColumnIfMissing(sqlite, "workspace_sessions", "access_mode", "text not null default 'modify'");
  addColumnIfMissing(sqlite, "workspace_sessions", "access_grant_id", "text");
}

function migrateWorkspaceAccessApprovals(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "workspace_sessions", "access_mode", "text not null default 'modify'");
  addColumnIfMissing(sqlite, "workspace_sessions", "access_grant_id", "text");

  sqlite.exec(`
    create table if not exists workspace_access_requests (
      id text primary key,
      path text not null,
      requested_access text not null,
      reason text,
      conversation_scope_id text,
      token_hash text not null,
      status text not null default 'pending',
      decision_scope text,
      created_at text not null,
      expires_at text not null,
      decided_at text
    );

    create index if not exists workspace_access_requests_status_idx
      on workspace_access_requests(status, created_at desc);
    create index if not exists workspace_access_requests_path_idx
      on workspace_access_requests(path, created_at desc);

    create table if not exists workspace_access_grants (
      id text primary key,
      path text not null,
      access text not null,
      scope text not null,
      conversation_scope_id text,
      request_id text,
      uses_remaining integer,
      expires_at text,
      created_at text not null,
      revoked_at text
    );

    create index if not exists workspace_access_grants_path_idx
      on workspace_access_grants(path, created_at desc);
    create index if not exists workspace_access_grants_active_idx
      on workspace_access_grants(revoked_at, expires_at);

    create table if not exists workspace_access_audit (
      id text primary key,
      event text not null,
      request_id text,
      grant_id text,
      path text not null,
      access text,
      scope text,
      conversation_scope_id text,
      detail text,
      created_at text not null
    );

    create index if not exists workspace_access_audit_created_idx
      on workspace_access_audit(created_at desc);
    create index if not exists workspace_access_audit_path_idx
      on workspace_access_audit(path, created_at desc);
  `);
}

function migrateOAuthState(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists oauth_clients (
      client_id text primary key,
      client_json text not null,
      issued_at integer not null
    );

    create index if not exists oauth_clients_issued_at_idx
      on oauth_clients(issued_at desc);

    create table if not exists oauth_access_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_access_tokens_client_id_idx
      on oauth_access_tokens(client_id);

    create index if not exists oauth_access_tokens_expires_at_idx
      on oauth_access_tokens(expires_at);

    create table if not exists oauth_refresh_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_refresh_tokens_client_id_idx
      on oauth_refresh_tokens(client_id);

    create index if not exists oauth_refresh_tokens_expires_at_idx
      on oauth_refresh_tokens(expires_at);
  `);
}

function migrateLocalAgentSessions(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists local_agent_sessions (
      id text primary key,
      workspace_id text,
      workspace_root text not null,
      profile_name text not null,
      provider text not null,
      model text,
      effort text,
      provider_session_id text,
      status text not null,
      latest_response text,
      error text,
      created_at text not null,
      updated_at text not null
    );

    create index if not exists local_agent_sessions_workspace_id_idx
      on local_agent_sessions(workspace_id, updated_at desc);

    create index if not exists local_agent_sessions_workspace_root_idx
      on local_agent_sessions(workspace_root, updated_at desc);

    create index if not exists local_agent_sessions_provider_session_id_idx
      on local_agent_sessions(provider_session_id);
  `);

  addColumnIfMissing(sqlite, "local_agent_sessions", "effort", "text");
}

function migrateWorkspaceConversationBindings(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workspace_conversation_bindings (
      conversation_scope_id text not null,
      target_key text not null,
      workspace_session_id text not null,
      created_at text not null,
      last_used_at text not null,
      primary key (conversation_scope_id, target_key),
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

    create index if not exists workspace_conversation_bindings_workspace_idx
      on workspace_conversation_bindings(workspace_session_id);
  `);
}

function migrateLocalAgentStructuredErrors(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "local_agent_sessions", "error_code", "text");
  addColumnIfMissing(sqlite, "local_agent_sessions", "error_retryable", "text");
}

function migrateLocalAgentEffortRename(sqlite: Database.Database): void {
  const columns = sqlite.prepare("pragma table_info(local_agent_sessions)").all() as Array<{
    name: string;
  }>;
  const names = new Set(columns.map((column) => column.name));
  if (names.has("effort")) {
    if (names.has("thinking")) {
      sqlite.exec(`
        update local_agent_sessions
        set effort = thinking
        where effort is null and thinking is not null
      `);
    }
    return;
  }
  if (!names.has("thinking")) {
    addColumnIfMissing(sqlite, "local_agent_sessions", "effort", "text");
    return;
  }
  sqlite.exec("alter table local_agent_sessions rename column thinking to effort");
}

function addColumnIfMissing(
  sqlite: Database.Database,
  table: "workspace_sessions" | "local_agent_sessions",
  column: string,
  definition: string,
): void {
  const columns = sqlite.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((existingColumn) => existingColumn.name === column)) return;

  sqlite.exec(`alter table ${table} add column ${column} ${definition}`);
}
