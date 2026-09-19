import { DatabaseSync } from "node:sqlite";
import { lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadRuntimeConfig } from "./config.js";
import { NativeRuntimeAdapter, systemClock } from "./native.js";
import { RuntimeSupervisor } from "./supervisor.js";
import { RuntimeJournal } from "../runtime-journal/store.js";
import { selfIdentity, inspectProcess } from "../process-supervision/process.js";
import { publicStatus, type RuntimeSnapshot } from "../runtime-lifecycle/contracts.js";
import { planSnapshot } from "../runtime-recovery/planner.js";

async function main(argv: string[]): Promise<void> {
  const [command, flag, configPath, ...extra] = argv;
  if (!["run", "status", "dry-run", "pause", "resume", "stop", "restart", "upgrade"].includes(command ?? "") || flag !== "--config" || !configPath || extra.length) {
    throw new Error("Usage: node bin/devspace-runtime.js run|status|dry-run|pause|resume|stop|restart|upgrade --config /absolute/runtime.json");
  }
  const config = loadRuntimeConfig(configPath);
  if (command === "status" || command === "dry-run") {
    const directory = resolve(config.stateDirectory), path = join(directory, "runtime-recovery.sqlite");
    if (realpathSync(directory) !== directory || lstatSync(path).isSymbolicLink()) throw new Error("UNTRUSTED_JOURNAL_PATH");
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const row = db.prepare("SELECT body FROM runtime_snapshot WHERE id=1").get() as { body: string } | undefined;
      if (!row || row.body.length > 8_000_000) throw new Error("BLOCKED_METADATA");
      const state = JSON.parse(row.body) as RuntimeSnapshot;
      if (state.rootId !== config.rootId || state.schemaVersion !== 1) throw new Error("BLOCKED_METADATA");
      console.log(JSON.stringify(command === "status" ? publicStatus(state, config.policy) : {
        scope: "Persisted observation only; does not probe, write, or authorize execution",
        observedAt: state.lastWall,
        decisions: Object.values(state.slots).map(slot => ({ component: slot.component,
          decision: planSnapshot(state, slot, config.policy) })),
      }, null, 2));
    } finally { db.close(); }
    return;
  }
  const journal = new RuntimeJournal(config.stateDirectory, config.rootId, config.policy, config.tunnelOwnership);
  if (command !== "run") { try { journal.control(command as "pause" | "resume" | "stop" | "restart" | "upgrade"); } finally { journal.close(); } return; }
  const owner = journal.acquire(selfIdentity(), inspectProcess, Date.now());
  const supervisor = new RuntimeSupervisor(journal, owner, new NativeRuntimeAdapter(config), systemClock);
  let shutdown = false, signalAt = 0;
  const signal = () => { if (!shutdown) { shutdown = true; signalAt = Date.now(); journal.control("stop"); } };
  process.once("SIGINT", signal); process.once("SIGTERM", signal);
  try {
    for (;;) {
      await supervisor.tick();
      const state = journal.read();
      const stopped = Object.values(state.slots).every(x => x.ownership === "external" || x.state === "stopped");
      if ((state.control.mode === "stop" || state.control.mode === "upgrade") && stopped) { journal.release(owner, true); break; }
      if (shutdown && Date.now() - signalAt > config.policy.stopTimeoutMs + config.policy.healthTimeoutMs) {
        journal.release(owner, false); throw new Error("STOP_INCOMPLETE_NEEDS_ATTENTION");
      }
      // Completion-relative polling: no overlapping health probes or timer backlog.
      await delay(config.policy.pollMs);
    }
  } finally {
    process.removeListener("SIGINT", signal); process.removeListener("SIGTERM", signal);
    journal.close();
  }
}
main(process.argv.slice(2)).catch(error => {
  // Do not serialize configuration, paths from exceptions, process environments, or credentials.
  const text = error instanceof Error && /^[A-Z_]+(?:: [A-Za-z0-9 _-]+)?$/.test(error.message) ? error.message : "RUNTIME_SUPERVISOR_BLOCKED";
  console.error(text); process.exitCode = 1;
});
