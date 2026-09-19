/** Advisory metadata only. Never use this module to authorize a tool call. */
export const CAPABILITIES = ["workspace", "filesystem", "search", "execution", "process", "computer-use", "browser-use", "goal-control", "session-observation", "coordination", "worktree", "integration", "watchdog", "handoff", "project-memory", "supervisor", "automation", "approval", "diagnostics"] as const;
export type Capability = typeof CAPABILITIES[number];
export const ROLES = ["Observer", "Worker", "Coordinator", "Reviewer", "Supervisor", "Approver", "Operator"] as const;
export type Role = typeof ROLES[number];
export type Risk = "low" | "medium" | "high";
export type Requirement = "none" | "required" | "conditional" | "resolved";
export type Feature = "base" | "codex" | "claude" | "sessions" | "coordinator" | "v2" | "native-goals" | "chat-goals" | "goal-cards" | "diagnostic-cards" | "desktop" | "browser" | "computer-approval" | "artifact";
export interface CatalogProfile {
  platform: "win32" | "linux" | "darwin";
  toolMode: "codex" | "claude";
  ui: boolean;
  sessions: boolean;
  coordinator: boolean;
  v2: boolean;
  nativeGoals: boolean;
  chatGoals: boolean;
  diagnosticCards: boolean;
  computerUse: boolean;
  cuaBridge: boolean;
  artifacts: boolean;
}
export interface ToolCapability {
  toolName: string;
  namespace: string;
  capability: Capability;
  purpose: string;
  intent: string;
  mutability: "read" | "mutate";
  projectMutation: "none" | "possible";
  localStateMutation: "none" | "incidental" | "yes";
  externalSideEffect: "none" | "possible";
  risk: Risk;
  prerequisites: {
    workspace: "none" | "read" | "modify" | "authorized-path";
    session: Requirement;
    task: Requirement;
    lease: Requirement;
    revision: Requirement;
    humanApproval: Requirement;
    requiresCurrentTaskAuthority: boolean;
    conditions: readonly string[];
  };
  visibility: "model-visible" | "app-only";
  visibilityWithoutUi: "model-visible" | "absent";
  feature: Feature;
  sourceFiles: readonly string[];
  idempotency: "read-again" | "not-guaranteed" | "same-key-same-arguments" | "same-decision" | "once-only" | "compare-and-swap";
  sideEffects: readonly string[];
  constraints: readonly string[];
  typicalPredecessors: readonly string[];
  typicalSuccessors: readonly string[];
  recommendedRoles: readonly Role[];
}
