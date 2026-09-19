import { spawn } from "node:child_process";
import { statfsSync, lstatSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectProcess, portFree, processOwnsPort, terminateVerified } from "../process-supervision/process.js";
import { probeMcp } from "../service-health/mcp-probe.js";
import { identityState, type Component, type Failure, type LaunchTicket, type RuntimeIdentity } from "../runtime-lifecycle/contracts.js";
import { loadRuntimeConfig, type RuntimeConfig } from "./config.js";
import type { RecoveryClock, RuntimeAdapter } from "./supervisor.js";

export const systemClock: RecoveryClock = { wall: () => Date.now(), monotonic: () => performance.now() };
export class NativeRuntimeAdapter implements RuntimeAdapter {
  constructor(readonly config: RuntimeConfig) {}
  get buildId(): string { return this.config.release.buildId; }
  get serverVersion(): string { return this.config.release.serverVersion; }
  get entrypoint(): string { return this.config.release.entrypoint; }
  get remoteEnabled(): boolean { return !!this.config.remoteUrl; }
  inspect = inspectProcess;
  preflight(): Failure | undefined {
    try {
      const current = loadRuntimeConfig(this.config.configFile);
      if (current.configHash !== this.config.configHash || current.release.pointerHash !== this.config.release.pointerHash
        || current.release.entrypointHash !== this.config.release.entrypointHash) return "release_changed";
    } catch { return "config_failure"; }
    // A legacy production supervisor uses a different ownership protocol. Never compete with it.
    try { lstatSync(join(this.config.instanceRoot, ".devspace-supervisor.lock")); return "identity_uncertain"; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") return "identity_uncertain"; }
    if (!process.env[this.config.healthTokenEnv]) return "authentication";
    try {
      const disk = statfsSync(this.config.stateDirectory, { bigint: true });
      if (disk.bavail * disk.bsize < 16n * 1024n * 1024n) return "resource_exhaustion";
    } catch { return "unknown"; }
    return undefined;
  }
  portFree(): Promise<"free" | "occupied" | "uncertain"> { return portFree(Number(new URL(this.config.localUrl).port)); }
  launch(component: Component, ticket: LaunchTicket): Promise<void> {
    if (this.preflight()) return Promise.reject(new Error("START_PREFLIGHT_BLOCKED"));
    // Fixed bootstrap; no shell, arbitrary task command, release selection, or repository mutation.
    const child = spawn(process.execPath, [fileURLToPath(new URL("./worker.js", import.meta.url)),
      this.config.configFile, component, ticket.token, ticket.runtimeId, String(ticket.generation),
      this.config.release.pointerHash, this.config.configHash, this.config.release.entrypointHash],
    { detached: true, windowsHide: true, stdio: "ignore", cwd: this.config.instanceRoot, env: { ...process.env } });
    return new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", () => { child.unref(); resolve(); });
    });
  }
  async health(component: Component, identity?: RuntimeIdentity) {
    const alive = identity ? identityState(identity, this.inspect(identity.pid)) === "active" : component === "tunnel";
    const listening = component === "server" ? !!identity && await processOwnsPort(identity, Number(new URL(this.config.localUrl).port)) : true;
    return probeMcp({ origin: component === "server" ? this.config.localUrl : this.config.remoteUrl!,
      token: process.env[this.config.healthTokenEnv], expectedBuildId: this.buildId, expectedServerVersion: this.serverVersion,
      timeoutMs: Math.min(10_000, this.config.policy.healthTimeoutMs), processAlive: alive, portListening: listening });
  }
  async terminate(identity: RuntimeIdentity, force: boolean): Promise<boolean> { return terminateVerified(identity, force); }
}
