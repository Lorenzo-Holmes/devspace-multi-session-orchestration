import { CoordinatorStore } from "../coordinator-store.js";
import { OrchestrationCoordinator } from "../orchestration-coordinator.js";
import { OrchestrationRegistry } from "../orchestration-registry.js";
import { OrchestrationStore } from "../orchestration-store.js";

const [stateDir, taskId, sessionId, nowText] = process.argv.slice(2);
if (!stateDir || !taskId || !sessionId || !nowText) process.exit(64);
const sessions = new OrchestrationRegistry(new OrchestrationStore(stateDir));
const coordinator = new OrchestrationCoordinator(new CoordinatorStore(stateDir), sessions);
try {
  const task = coordinator.claim({ taskId, sessionId, expectedRevision: 1, now: new Date(nowText) });
  process.stdout.write(JSON.stringify({ ok: true, taskId: task.id, attemptId: task.attemptId,
    leaseGeneration: task.leaseGeneration, owner: task.ownerSessionId }) + "\n");
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }) + "\n");
  process.exitCode = 3;
} finally {
  coordinator.close(); sessions.close();
}
