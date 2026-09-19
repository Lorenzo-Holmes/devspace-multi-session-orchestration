import type { ServerConfig } from "./config.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import type { WorkspaceAccessManager } from "./workspace-access.js";
import type { OrchestrationCoordinator } from "./orchestration-coordinator.js";
import type { OrchestrationRegistry } from "./orchestration-registry.js";
import { OrchestrationV2Store } from "./orchestration-v2-store.js";
import { WorktreeOrchestrator } from "./orchestration-worktrees.js";
import { IntegrationManager } from "./orchestration-integration.js";
import { OrchestrationWatchdog } from "./orchestration-watchdog.js";
import { HandoffManager } from "./orchestration-handoff.js";
import { ProjectMemoryManager } from "./orchestration-memory.js";
import { AutomationHooks } from "./orchestration-automation.js";

export class OrchestrationV2 {
  readonly store: OrchestrationV2Store;
  readonly bindings: WorktreeOrchestrator;
  readonly integrations: IntegrationManager;
  readonly watchdog: OrchestrationWatchdog;
  readonly handoffs: HandoffManager;
  readonly memory: ProjectMemoryManager;
  readonly automation: AutomationHooks;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeCoordinator: () => void;
  constructor(config: ServerConfig, readonly sessions: OrchestrationRegistry, readonly coordinator: OrchestrationCoordinator,
    readonly workspaces: WorkspaceRegistry, readonly access: WorkspaceAccessManager) {
    this.store = new OrchestrationV2Store(config.stateDir);
    this.bindings = new WorktreeOrchestrator(this.store, coordinator, sessions, workspaces, access);
    this.integrations = new IntegrationManager(this.store, coordinator, sessions, this.bindings);
    this.watchdog = new OrchestrationWatchdog(this.store, sessions, coordinator, this.integrations);
    this.handoffs = new HandoffManager(this.store, sessions, coordinator, this.bindings);
    this.memory = new ProjectMemoryManager(this.store);
    this.automation = new AutomationHooks(this);
    this.unsubscribe = sessions.onChange(project => { this.watchdog.scan(project); });
    this.unsubscribeCoordinator = coordinator.onChange(project => { this.watchdog.scan(project); });
    this.store.onChange = (table, project) => { if (table === "integration_records") this.watchdog.scan(project); };
  }
  close(): void { this.unsubscribe(); this.unsubscribeCoordinator(); this.store.close(); }
}
