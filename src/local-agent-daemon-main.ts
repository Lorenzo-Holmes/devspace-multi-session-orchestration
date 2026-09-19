#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { createLocalAgentDrivers } from "./local-agent-adapters.js";
import { loadLocalAgentProfiles } from "./local-agent-profiles.js";
import { LocalAgentDaemon, writeLocalAgentDaemonLog } from "./local-agent-daemon.js";
import {
  LocalAgentDaemonAlreadyRunningError,
  localAgentDaemonPaths,
} from "./local-agent-daemon-lifecycle.js";
import { LocalAgentManager } from "./local-agent-manager.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { GoalManager } from "./goal-manager.js";
import { WorkspaceAccessManager } from "./workspace-access.js";
import { watchAllowedRoots } from "./config-reloader.js";

const config = loadConfig();
const DEFAULT_DAEMON_SHUTDOWN_TIMEOUT_MS = config.goals?.enabled ? 90_000 : 10_000;
const paths = localAgentDaemonPaths(config.stateDir);
const log = (
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
) => writeLocalAgentDaemonLog(paths, level, event, fields);
const store = new LocalAgentStore(paths.stateDir);
const pool = new LocalAgentRuntimePool({ logger: log });
const goalAccess = config.goals?.enabled ? new WorkspaceAccessManager(config) : undefined;
const goalConfigWatcher = goalAccess ? watchAllowedRoots(config) : undefined;
const goals = config.goals?.enabled ? new GoalManager({stateDir:paths.stateDir,config:config.goals,pool,
  authorize:async(root)=>{
    const access=await goalAccess!.authorizeWorkspacePath(root,undefined,'modify');
    if(access.scope!=='configured'&&access.scope!=='permanent')throw new Error('WORKSPACE_ACCESS_REQUIRED: a durable project authorization is required for background Goals.');
  }}) : undefined;
const manager = new LocalAgentManager({
  store,
  drivers: createLocalAgentDrivers(),
  pool,
  loadProfiles: (workspaceRoot) => loadLocalAgentProfiles(config, workspaceRoot, { includeDisabled: true }),
  agentDir: config.agentDir,
  allowedRoots: config.allowedRoots,
  logger: log,
  subagents: config.subagents,
});
const daemon = new LocalAgentDaemon({
  stateDir: paths.stateDir,
  manager,
  goals,
  shutdownTimeoutMs: DEFAULT_DAEMON_SHUTDOWN_TIMEOUT_MS,
  onLockAcquired: async () => {
    const reconciled = manager.reconcileActiveRuns();
    if (reconciled.isErr()) throw reconciled.error;
    await goals?.reconcile();
  },
  onClosed: () => { goalAccess?.close();goalConfigWatcher?.close();if (!shuttingDown) process.exit(0); },
  idleShutdownMs: parseIdleShutdownMs(process.env.DEVSPACE_AGENTD_IDLE_TIMEOUT_MS),
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const forceTimer = setTimeout(() => {
    log("error", "daemon_forced_shutdown", {
      activeTurns: manager.activeTurnCount,
      runtimeCount: manager.runtimeCount,
    });
    // Active records intentionally remain durable. The next daemon startup
    // reconciles them to error while preserving provider continuation data.
    process.exit(1);
  }, parseShutdownTimeoutMs(process.env.DEVSPACE_AGENTD_SHUTDOWN_TIMEOUT_MS));
  forceTimer.unref();
  void daemon.close().finally(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  await daemon.start();
} catch (error) {
  if (error instanceof LocalAgentDaemonAlreadyRunningError) {
    await manager.close();
    process.exit(0);
  }
  log("error", "daemon_start_failed", { error: error instanceof Error ? error.message : String(error) });
  await manager.close();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function parseIdleShutdownMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 30_000;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("DEVSPACE_AGENTD_IDLE_TIMEOUT_MS must be a non-negative duration.");
  }
  return parsed;
}

function parseShutdownTimeoutMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_DAEMON_SHUTDOWN_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("DEVSPACE_AGENTD_SHUTDOWN_TIMEOUT_MS must be a non-negative duration.");
  }
  return parsed;
}
