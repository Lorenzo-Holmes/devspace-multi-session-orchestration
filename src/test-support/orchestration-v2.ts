import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TestContext } from "node:test";
import { loadConfig } from "../config.js";
import { writeTestDevspaceConfig } from "./config.test.js";
import { OrchestrationRegistry } from "../orchestration-registry.js";
import { OrchestrationStore } from "../orchestration-store.js";
import { CoordinatorStore } from "../coordinator-store.js";
import { OrchestrationCoordinator } from "../orchestration-coordinator.js";
import { WorkspaceRegistry } from "../workspaces.js";
import { SqliteWorkspaceStore } from "../workspace-store.js";
import { WorkspaceAccessManager } from "../workspace-access.js";
import { OrchestrationV2 } from "../orchestration-v2.js";
import { projectKeyForWorkspace } from "../orchestration-scope.js";

export const exec = promisify(execFile);
export async function v2Fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "devspace-v2-")), project = join(root, "project");
  await mkdir(project);
  await exec("git", ["init", project]);
  await exec("git", ["config", "core.autocrlf", "false"], { cwd: project });
  await writeFile(join(project, "same.txt"), "base\n");
  await exec("git", ["add", "."], { cwd: project });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"], { cwd: project });
  const config = loadConfig(writeTestDevspaceConfig(join(root, "config"), {
    workspaces: { allowedRoots: [root], worktreeRoot: join(root, "worktrees") },
    storage: { stateDir: join(root, "state") },
    subagents: { enabled: false, providers: [] },
  }));
  const store = new SqliteWorkspaceStore(config.stateDir), workspaces = new WorkspaceRegistry(config, store);
  const access = new WorkspaceAccessManager(config), sessions = new OrchestrationRegistry(new OrchestrationStore(config.stateDir));
  const coordinator = new OrchestrationCoordinator(new CoordinatorStore(config.stateDir), sessions);
  const v2 = new OrchestrationV2(config, sessions, coordinator, workspaces, access);
  const workspace = (await workspaces.openWorkspace(project)).workspace, projectKey = projectKeyForWorkspace(workspace);
  const session = sessions.register({ projectKey, workspaceRoot: project, state: "running" });
  const [task] = coordinator.createPlan(projectKey, [{ name: "task", description: "task" }]);
  const claimed = coordinator.claim({ taskId: task.id, sessionId: session.id, expectedRevision: task.revision });
  const lease = { taskId: task.id, sessionId: session.id, leaseToken: claimed.leaseToken!, expectedRevision: claimed.revision };
  t.after(async () => { v2.close(); coordinator.close(); sessions.close(); access.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, project, config, store, workspace, projectKey, workspaces, access, sessions, coordinator, v2, session, task, claimed, lease };
}
