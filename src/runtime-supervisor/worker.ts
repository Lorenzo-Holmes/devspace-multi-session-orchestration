import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { loadRuntimeConfig, approvedReleaseUnchanged } from "./config.js";
import { RuntimeJournal } from "../runtime-journal/store.js";
import { selfIdentity, inspectProcess, terminateVerified } from "../process-supervision/process.js";
import { identityState, type Component, type RuntimeIdentity } from "../runtime-lifecycle/contracts.js";

// A launch ticket is claimed transactionally before the server's first executable instruction.
// Importing the approved entrypoint in this process closes the spawn-before-PID-publication gap.
async function main(): Promise<void> {
  const [configPath, rawComponent, token, runtimeId, generationText, pointerHash, configHash, entrypointHash] = process.argv.slice(2);
  if ((rawComponent !== "server" && rawComponent !== "tunnel") || !token || !runtimeId || !/^\d+$/.test(generationText ?? "")) throw new Error("INVALID_LAUNCH_TICKET");
  const component: Component = rawComponent;
  const config = loadRuntimeConfig(configPath);
  if (config.release.pointerHash !== pointerHash || config.configHash !== configHash || config.release.entrypointHash !== entrypointHash
    || !approvedReleaseUnchanged(config) || !config.policy.enabled) throw new Error("APPROVED_LAUNCH_CHANGED");
  const journal = new RuntimeJournal(config.stateDirectory, config.rootId, config.policy, config.tunnelOwnership);
  const holder = selfIdentity();
  const identity: RuntimeIdentity = { ...holder, runtimeId, generation: Number(generationText), entrypoint: config.release.entrypoint,
    buildId: config.release.buildId, serverVersion: config.release.serverVersion, rootId: config.rootId, createdAt: Date.now() };
  if (!journal.claimWorker(component, token, identity)) { journal.close(); return; }
  let shuttingDown = false, native: RuntimeIdentity | undefined, child: ChildProcess | undefined;
  let stopAt: number | undefined;
  let nativeExitRecorded = false;
  process.once("exit", code => {
    try { if (!nativeExitRecorded) journal.workerExit(component, token, holder, code, null, Date.now()); } catch { /* Keep existing durable reservation on I/O failure. */ }
    try { journal.close(); } catch { /* No recovery side effects from exit hooks. */ }
  });
  const stop = () => {
    if (component === "server") {
      if (shuttingDown) return;
      shuttingDown = true;
      if (process.listenerCount("SIGTERM")) process.emit("SIGTERM", "SIGTERM");
      else process.exit(0);
    } else if (native) {
      stopAt ??= Date.now();
      // Windows has no generic safe POSIX graceful signal. Allow the configured grace, then use a retained native handle.
      const force = Date.now() - stopAt >= config.policy.stopTimeoutMs;
      if ((!shuttingDown || force) && identityState(native, inspectProcess(native.pid)) === "active") {
        shuttingDown = true; terminateVerified(native, force);
      }
    }
  };
  const interval = setInterval(() => {
    try {
      const state = journal.read(), slot = state.slots[component];
      if (slot.ticket?.token !== token || slot.stopRequested || state.control.mode === "stop" || state.control.mode === "upgrade") stop();
    } catch {
      // An unreadable journal cannot authorize a restart, takeover, approval, or process-tree kill.
      // Leave the registered service in place; the supervisor blocks independently.
    }
  }, Math.max(100, Math.min(config.policy.pollMs, 1000)));
  interval.unref();
  if (component === "server") {
    process.env.DEVSPACE_BUILD_ID = config.release.buildId;
    process.argv = [process.execPath, config.release.entrypoint, "serve"];
    await import(pathToFileURL(config.release.entrypoint).href);
  } else {
    if (!config.tunnel) throw new Error("EXTERNAL_TUNNEL_NOT_MANAGED");
    journal.nativeStarting(component, token, holder);
    child = spawn(config.tunnel.executable, ["tunnel", "--no-autoupdate", "--config", config.tunnel.configFile, "run", config.tunnel.tunnelId],
      { shell: false, windowsHide: true, stdio: "ignore", env: { ...process.env } });
    await new Promise<void>((resolve, reject) => { child!.once("spawn", resolve); child!.once("error", reject); });
    // No guessed birth identity. A failure here leaves an uncertain-native-launch reservation.
    const observed = inspectProcess(child.pid!);
    if (observed.kind !== "observed") throw new Error("NATIVE_IDENTITY_UNCERTAIN");
    native = { ...identity, ...observed.identity, entrypoint: config.tunnel.executable };
    journal.registerNative(component, token, holder, native);
    child.once("exit", (code, signal) => {
      try { journal.workerExit(component, token, holder, code, signal, Date.now()); nativeExitRecorded = true; } catch { /* Durable reservation remains. */ }
      clearInterval(interval); process.exitCode = code ?? (signal ? 1 : 0);
    });
  }
}
main().catch(() => { process.exitCode = 1; });
