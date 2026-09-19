import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeJournal } from "../runtime-journal/store.js";
import { parsePolicy, sameProcess, type Component, type Failure, type Health, type LaunchTicket,
  type ProcessIdentity, type ProcessObservation, type RestartPolicy, type RuntimeIdentity } from "../runtime-lifecycle/contracts.js";
import { RuntimeSupervisor, type RecoveryClock, type RuntimeAdapter } from "./supervisor.js";
export class FakeClock implements RecoveryClock {
  time = 1_000_000; mono = 1_000_000;
  wall(): number { return this.time; }
  monotonic(): number { return this.mono; }
  advance(ms: number): void { this.time += ms; this.mono += Math.max(0, ms); }
}
export class FakeProcessManager implements RuntimeAdapter {
  buildId = "approved-fixture"; serverVersion = "fixture-1"; entrypoint = "/approved/server.js";
  remoteEnabled = false; processes = new Map<number, ProcessIdentity>(); uncertain = new Set<number>();
  launches: Array<{ component: Component; ticket: LaunchTicket }> = [];
  terminations: RuntimeIdentity[] = []; nextPid = 100; occupied = false; readiness = true;
  failure?: Failure; launchMode: "normal" | "unclaimed" | "native-gap" = "normal";
  healthOverride?: Health; tunnelHealth?: Health;
  constructor(readonly journal: RuntimeJournal, readonly clock: FakeClock) {}
  inspect = (pid: number): ProcessObservation => this.uncertain.has(pid) ? { kind: "uncertain" } : this.processes.has(pid) ? { kind: "observed", identity: this.processes.get(pid)! } : { kind: "absent" };
  preflight(): Failure | undefined { return this.failure; }
  async portFree(): Promise<"free" | "occupied"> { return this.occupied ? "occupied" : "free"; }
  async launch(component: Component, ticket: LaunchTicket): Promise<void> {
    this.launches.push({ component, ticket: structuredClone(ticket) });
    if (this.launchMode === "unclaimed") return;
    const identity: RuntimeIdentity = { pid: ++this.nextPid, processStartTime: `birth-${this.nextPid}`, executable: "/node",
      runtimeId: ticket.runtimeId, generation: ticket.generation, entrypoint: this.entrypoint,
      buildId: this.buildId, serverVersion: this.serverVersion, rootId: this.journal.rootId, createdAt: this.clock.time };
    this.processes.set(identity.pid, identity);
    if (!this.journal.claimWorker(component, ticket.token, identity)) { this.processes.delete(identity.pid); return; }
    if (component === "tunnel") {
      this.journal.nativeStarting(component, ticket.token, identity);
      if (this.launchMode === "native-gap") { this.processes.delete(identity.pid); return; }
      this.journal.registerNative(component, ticket.token, identity, identity);
    }
  }
  async health(component: Component, _identity?: RuntimeIdentity): Promise<Health> {
    return structuredClone(component === "tunnel" && this.tunnelHealth ? this.tunnelHealth : this.healthOverride ?? {
      status: this.readiness ? "healthy" : "degraded", reason: this.readiness ? "ready" : "network_transient",
      processAlive: true, portListening: this.readiness, mcpReady: this.readiness,
      buildId: this.buildId, serverVersion: this.serverVersion, toolCount: 3,
    });
  }
  async terminate(identity: RuntimeIdentity): Promise<boolean> {
    const actual = this.processes.get(identity.pid);
    if (!actual || !sameProcess(identity, actual)) return false;
    this.terminations.push(identity); this.processes.delete(identity.pid); return true;
  }
  exit(component: Component, code = 1): void {
    const slot = this.journal.read().slots[component];
    if (slot.identity) this.processes.delete(slot.identity.pid);
    if (slot.ticket?.holder) {
      this.processes.delete(slot.ticket.holder.pid);
      this.journal.workerExit(component, slot.ticket.token, slot.ticket.holder, code, null, this.clock.time);
    }
  }
}
export function harness(overrides: Partial<RestartPolicy> = {}, managedTunnel = false) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "devspace-resilience-")));
  const policy = parsePolicy({ enabled: true, pollMs: 100, initialBackoffMs: 100, maxBackoffMs: 800,
    healthTimeoutMs: 1000, stopTimeoutMs: 500, healthyResetMs: 2000,
    resumeThresholdMs: 5000, resumeGraceMs: 500, windowMs: 10000, ...overrides });
  const journal = new RuntimeJournal(directory, "fixture-root", policy, managedTunnel ? "managed_by_devspace" : "external");
  const clock = new FakeClock(), processes = new FakeProcessManager(journal, clock);
  processes.remoteEnabled = managedTunnel;
  const process: ProcessIdentity = { pid: 900, processStartTime: "supervisor-one", executable: "/node" };
  processes.processes.set(process.pid, process);
  const owner = journal.acquire(process, processes.inspect, clock.time);
  const supervisor = new RuntimeSupervisor(journal, owner, processes, clock, () => 0.5);
  return { directory, policy, journal, clock, processes, owner, supervisor,
    async step(ms = policy.pollMs) { clock.advance(ms); await supervisor.tick(); },
    async healthy() { await supervisor.tick(); await supervisor.tick(); },
    close() { journal.close(); rmSync(directory, { recursive: true, force: true }); } };
}
