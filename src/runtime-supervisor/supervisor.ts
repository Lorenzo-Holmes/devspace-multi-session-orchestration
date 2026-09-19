import { randomUUID } from "node:crypto";
import { RuntimeJournal } from "../runtime-journal/store.js";
import { event, finishAttempt, identityState, sameProcess, type Component, type Failure, type Health,
  type LaunchTicket, type Owner, type ProcessObservation, type RestartPolicy, type RuntimeIdentity,
  type RuntimeSlot, type RuntimeSnapshot } from "../runtime-lifecycle/contracts.js";
import { planRecovery } from "../runtime-recovery/planner.js";

export interface RecoveryClock { wall(): number; monotonic(): number }
export interface RuntimeAdapter {
  readonly buildId: string;
  readonly serverVersion: string;
  readonly entrypoint: string;
  readonly remoteEnabled: boolean;
  inspect(pid: number): ProcessObservation;
  preflight(): Failure | undefined;
  portFree(): Promise<"free" | "occupied" | "uncertain">;
  launch(component: Component, ticket: LaunchTicket): Promise<void>;
  health(component: Component, identity?: RuntimeIdentity): Promise<Health>;
  terminate(identity: RuntimeIdentity, force: boolean): Promise<boolean>;
}
// No model, task, Git, workspace, approval, release-switch, or user-child APIs enter this boundary.
export class RuntimeSupervisor {
  private inFlight?: Promise<void>;
  constructor(readonly journal: RuntimeJournal, readonly owner: Owner, readonly adapter: RuntimeAdapter,
    readonly clock: RecoveryClock, readonly random: () => number = Math.random) {}
  get policy(): RestartPolicy { return this.journal.policy; }
  tick(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.iterate().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }
  private async iterate(): Promise<void> {
    this.journal.update(this.owner, s => {
      const wall = this.clock.wall(), mono = this.clock.monotonic();
      if (!Number.isFinite(wall) || !Number.isFinite(mono)) throw new Error("INVALID_CLOCK");
      // Persisted monotonic readings are meaningful only within the same supervisor lifetime.
      const gap = s.lastWall !== undefined && (wall < s.lastWall || wall - s.lastWall > this.policy.resumeThresholdMs);
      s.policyTime = Math.max(s.policyTime, wall);
      if (gap) {
        s.resumeUntil = s.policyTime + this.policy.resumeGraceMs;
        for (const slot of Object.values(s.slots)) { slot.healthySince = undefined; slot.unhealthySince = undefined; }
        event(s, "supervisor", "resume_reconciliation", s.policyTime);
      }
      s.lastWall = wall; s.lastMono = mono; s.owner!.heartbeatAt = wall;
    });
    // Stop infrastructure leaves before the foundation. Recovery runs the opposite direction.
    const control = this.journal.read().control.mode;
    if (control === "stop" || control === "upgrade") {
      await this.reconcile("tunnel"); await this.reconcile("server");
    } else {
      await this.reconcile("server");
      if (this.journal.read().slots.server.state === "healthy") await this.reconcile("tunnel");
    }
    this.journal.update(this.owner, s => {
      const server = s.slots.server;
      s.runtimeState = s.control.mode === "pause" ? "paused_needs_attention" : server.state;
      if (server.state === "healthy" && this.adapter.remoteEnabled && s.slots.tunnel.state !== "healthy") s.runtimeState = "degraded";
    });
  }
  private setBlocked(component: Component, failure: Failure, code?: string, onlyAbsent = false): void {
    this.journal.update(this.owner, s => {
      const slot = s.slots[component];
      if (onlyAbsent && (slot.identity || slot.ticket)) return;
      const decision = planRecovery({ ...s, control: { ...s.control, mode: "run" } }, slot, failure, this.policy, s.policyTime);
      const reason = code ?? decision.reason;
      if (slot.blockedReason !== reason) event(s, component, "recovery_blocked", s.policyTime, reason);
      slot.state = "blocked"; slot.blockedReason = reason;
      finishAttempt(s, slot, s.policyTime, "blocked", reason);
    });
  }
  private compatible(identity: RuntimeIdentity, component: Component): boolean {
    return identity.rootId === this.journal.rootId && identity.buildId === this.adapter.buildId
      && identity.serverVersion === this.adapter.serverVersion
      && (component !== "server" || identity.entrypoint === this.adapter.entrypoint);
  }
  private async reconcile(component: Component): Promise<void> {
    let s = this.journal.read(), slot = s.slots[component];
    if (slot.ownership === "external") {
      if (component === "tunnel" && this.adapter.remoteEnabled && s.control.mode === "run") await this.observeExternal();
      return;
    }
    const identity = slot.identity;
    const stopping = s.control.mode === "stop" || s.control.mode === "upgrade";
    if (identity) {
      const state = identityState(identity, this.adapter.inspect(identity.pid));
      if (state === "uncertain") { this.setBlocked(component, "identity_uncertain"); return; }
      if (state === "active") {
        if (!this.compatible(identity, component)) { this.setBlocked(component, "release_changed", "BLOCKED_RUNTIME_IDENTITY_MISMATCH"); return; }
        this.journal.update(this.owner, current => {
          const live = current.slots[component];
          if (!this.isCurrent(live, identity)) return;
          if (live.adoptedEpoch !== this.owner.epoch) {
            live.adoptedEpoch = this.owner.epoch;
            event(current, component, "ADOPTED_EXISTING_RUNTIME", current.policyTime);
          }
        });
        if (stopping || slot.stopRequested || s.control.restart > slot.acknowledgedRestart) {
          await this.stop(component, identity, !stopping); return;
        }
        await this.verify(component, identity);
        return;
      }
      // Only absent or proven reused identities are stale. Neither authorizes killing the observed PID.
      this.journal.update(this.owner, current => {
        const old = current.slots[component];
        if (!this.isCurrent(old, identity)) return;
        const intended = stopping || !!old.stopRequested;
        event(current, component, intended ? "runtime_stopped" : "runtime_crashed", current.policyTime, state);
        if (!intended) {
          old.lastCrashAt = current.policyTime; old.failures++;
          old.detectLatencyMs = old.lastExit ? Math.max(0, current.policyTime - old.lastExit.at) : undefined;
          old.notBefore = current.policyTime + this.backoff(old.failures);
          finishAttempt(current, old, current.policyTime, "failed", "PROCESS_CRASH");
        }
        old.lastExit ??= { at: current.policyTime, code: null, signal: null,
          uptimeMs: Math.max(0, current.policyTime - identity.createdAt), intentional: intended };
        old.previousPid = identity.pid; old.identity = undefined; old.ticket = undefined; old.health = undefined;
        old.healthySince = undefined; old.unhealthySince = undefined;
        old.stopRequested = false; old.stopStartedAt = undefined; old.forceAttempted = false;
        old.state = intended ? "stopped" : "crashed";
        old.acknowledgedRestart = current.control.restart;
      });
      s = this.journal.read(); slot = s.slots[component];
    }
    if (slot.ticket) {
      const ticket = slot.ticket;
      const holderState = ticket.holder ? identityState(ticket.holder, this.adapter.inspect(ticket.holder.pid)) : "absent";
      if (holderState === "uncertain") { this.setBlocked(component, "identity_uncertain"); return; }
      if (component === "tunnel" && ticket.nativeLaunchStarted) {
        if (holderState === "active" && s.policyTime - ticket.reservedAt < this.policy.healthTimeoutMs) return;
        // Native spawn can succeed before its PID is durably published. Never assume it failed.
        this.setBlocked(component, "identity_uncertain", "UNCERTAIN_INFRASTRUCTURE_CHILD"); return;
      }
      if (!stopping && holderState === "active") return;
      if (!stopping && s.policyTime - ticket.reservedAt < this.policy.healthTimeoutMs) return;
      this.journal.update(this.owner, current => {
        const pending = current.slots[component];
        // Worker registration can race this observation. Its atomic registration wins or is fenced.
        if (pending.ticket?.token !== ticket.token || pending.identity) return;
        pending.ticket = undefined;
        pending.state = stopping ? "stopped" : "crashed";
        if (!stopping) {
          pending.failures++; pending.notBefore = current.policyTime + this.backoff(pending.failures);
          finishAttempt(current, pending, current.policyTime, "failed", "START_FAILED");
        }
      });
      s = this.journal.read(); slot = s.slots[component];
      if (slot.identity || slot.ticket) return;
    }
    if (stopping) {
      this.journal.update(this.owner, current => { const x = current.slots[component]; if (!x.identity && !x.ticket) x.state = "stopped"; });
      return;
    }
    if (s.control.mode === "pause" || slot.state === "paused_needs_attention" || slot.state === "blocked") return;
    const decision = planRecovery(s, slot, component === "server" ? "process_crash" : "tunnel_failure", this.policy, s.policyTime, this.random());
    if (decision.action === "pause") {
      this.journal.update(this.owner, current => {
        const x = current.slots[component]; x.state = "paused_needs_attention"; x.blockedReason = "CRASH_LOOP";
        finishAttempt(current, x, current.policyTime, "failed", "CRASH_LOOP");
        event(current, component, "crash_loop_detected", current.policyTime, "runtime_unstable");
      }); return;
    }
    if (decision.action !== "restart_runtime" && decision.action !== "restart_component") return;
    const failure = this.adapter.preflight();
    if (failure) { this.setBlocked(component, failure); return; }
    if (component === "server") {
      const available = await this.adapter.portFree();
      if (available !== "free") { this.setBlocked(component, available === "occupied" ? "port_conflict" : "identity_uncertain", undefined, true); return; }
    }
    const ticket = this.journal.update(this.owner, current => {
      const pending = current.slots[component];
      const d = planRecovery(current, pending, component === "server" ? "process_crash" : "tunnel_failure", this.policy, current.policyTime, this.random());
      if (pending.identity || pending.ticket || pending.state === "blocked" || pending.state === "paused_needs_attention"
        || (d.action !== "restart_runtime" && d.action !== "restart_component")) return undefined;
      const t: LaunchTicket = { token: randomUUID(), runtimeId: randomUUID(), generation: ++current.runtimeGeneration, reservedAt: current.policyTime };
      pending.ticket = t; pending.state = "starting"; pending.blockedReason = undefined;
      pending.lastExit = undefined; pending.stopRequested = false; pending.forceAttempted = false;
      pending.restarts.push(current.policyTime); current.globalRestarts.push({ component, at: current.policyTime });
      pending.currentRecovery = { recoveryId: randomUUID(), runtimeId: t.runtimeId, generation: t.generation, component,
        reason: component === "tunnel" ? "tunnel_failure" : pending.failures ? "process_crash" : "startup_failure", phase: "reserved",
        attemptNumber: pending.restarts.length, startedAt: current.policyTime, updatedAt: current.policyTime,
        expectedBuildId: this.adapter.buildId, oldPid: pending.previousPid, detectLatencyMs: pending.detectLatencyMs };
      event(current, component, "recovery_started", current.policyTime);
      return structuredClone(t);
    });
    if (!ticket) return;
    try { await this.adapter.launch(component, ticket); }
    catch {
      // Do not erase the ticket: an uncertain launch result might already have registered a worker.
      this.journal.update(this.owner, current => {
        if (current.slots[component].ticket?.token === ticket.token) event(current, component, "launch_result_uncertain", current.policyTime);
      });
    }
  }
  private isCurrent(slot: RuntimeSlot, identity: RuntimeIdentity): boolean {
    return !!slot.identity && slot.identity.runtimeId === identity.runtimeId && slot.identity.generation === identity.generation && sameProcess(slot.identity, identity);
  }
  private async verify(component: Component, identity: RuntimeIdentity): Promise<void> {
    let health: Health;
    try { health = await this.adapter.health(component, identity); }
    catch { health = { status: "blocked", reason: "unknown", processAlive: false, portListening: false, mcpReady: false }; }
    const needsStop = this.journal.update(this.owner, s => {
      const slot = s.slots[component];
      if (!this.isCurrent(slot, identity) || identityState(identity, this.adapter.inspect(identity.pid)) !== "active") return false;
      slot.health = health;
      const ready = health.status === "healthy" && health.processAlive && health.portListening && health.mcpReady
        && health.buildId === this.adapter.buildId && health.serverVersion === this.adapter.serverVersion && (health.toolCount ?? 0) > 0;
      if (ready) {
        if (slot.state !== "healthy") event(s, component, "runtime_healthy", s.policyTime);
        slot.state = "healthy"; slot.blockedReason = undefined; slot.lastHealthyAt = s.policyTime;
        slot.healthySince ??= s.policyTime; slot.unhealthySince = undefined;
        if (slot.currentRecovery && !slot.currentRecovery.completedAt) {
          slot.currentRecovery.healthStatus = "healthy";
          slot.currentRecovery.healthReadyLatencyMs = Math.max(0, s.policyTime - identity.createdAt);
          slot.currentRecovery.restartLatencyMs = Math.max(0, identity.createdAt - slot.currentRecovery.startedAt);
          finishAttempt(s, slot, s.policyTime, "completed");
          event(s, component, "recovery_succeeded", s.policyTime);
        }
        if (s.policyTime - slot.healthySince >= this.policy.healthyResetMs) {
          slot.failures = 0; slot.restarts = []; slot.notBefore = 0;
          s.globalRestarts = s.globalRestarts.filter(x => x.component !== component);
        }
        return false;
      }
      slot.healthySince = undefined;
      slot.unhealthySince ??= s.policyTime;
      if (health.status === "blocked" || health.reason === "authentication" || health.reason === "release_changed") {
        const reason = planRecovery(s, slot, health.reason === "ready" ? "unknown" : health.reason, this.policy, s.policyTime).reason;
        if (slot.blockedReason !== reason) event(s, component, "recovery_blocked", s.policyTime, reason);
        slot.state = "blocked"; slot.blockedReason = reason; finishAttempt(s, slot, s.policyTime, "blocked", reason); return false;
      }
      if (slot.state !== "degraded") event(s, component, "runtime_degraded", s.policyTime, health.reason);
      slot.state = "degraded";
      if (slot.currentRecovery && !slot.currentRecovery.completedAt) slot.currentRecovery.phase = "waiting_health";
      // A live tunnel with an unreachable remote domain is not proof that its process needs restarting.
      if (component === "tunnel" || s.control.mode !== "run" || !this.policy.enabled || s.policyTime < s.resumeUntil) return false;
      const since = slot.currentRecovery && !slot.currentRecovery.completedAt ? slot.currentRecovery.startedAt : slot.unhealthySince;
      if (s.policyTime - since < this.policy.healthTimeoutMs) return false;
      slot.failures++; slot.notBefore = s.policyTime + this.backoff(slot.failures);
      finishAttempt(s, slot, s.policyTime, "failed", "START_FAILED");
      return true;
    });
    if (needsStop) await this.stop(component, identity, true);
  }
  private async stop(component: Component, identity: RuntimeIdentity, restart: boolean): Promise<void> {
    const force = this.journal.update(this.owner, s => {
      const slot = s.slots[component]; if (!this.isCurrent(slot, identity)) return false;
      if (!slot.stopRequested) {
        slot.stopRequested = true; slot.stopStartedAt = s.policyTime; slot.state = "stopping";
        slot.restartAfterStop = restart; slot.acknowledgedRestart = s.control.restart;
        event(s, component, "graceful_stop_requested", s.policyTime, restart ? "restart" : "intentional_stop");
      }
      if (slot.forceAttempted || s.policyTime - slot.stopStartedAt! < this.policy.stopTimeoutMs) return false;
      if (identityState(identity, this.adapter.inspect(identity.pid)) !== "active") return false;
      slot.forceAttempted = true; return true;
    });
    if (!force) return;
    const stopped = await this.adapter.terminate(identity, true).catch(() => false);
    this.journal.update(this.owner, s => {
      if (!this.isCurrent(s.slots[component], identity)) return;
      event(s, component, "verified_termination", s.policyTime, stopped ? "requested" : "refused");
      if (!stopped) { s.slots[component].state = "blocked"; s.slots[component].blockedReason = "SAFE_TERMINATION_UNAVAILABLE"; }
    });
  }
  private async observeExternal(): Promise<void> {
    const health = await this.adapter.health("tunnel").catch((): Health => ({ status: "degraded", reason: "network_transient", processAlive: false, portListening: false, mcpReady: false }));
    this.journal.update(this.owner, s => {
      const slot = s.slots.tunnel; slot.health = health;
      const state = health.status === "healthy" ? "healthy" : health.status === "blocked" ? "blocked" : "degraded";
      if (slot.state !== state) event(s, "tunnel", state === "healthy" ? "tunnel_recovered" : "tunnel_lost", s.policyTime, "EXTERNAL_COMPONENT");
      slot.state = state;
    });
  }
  private backoff(failures: number): number {
    const jitter = 0.75 + Math.max(0, Math.min(1, this.random())) * 0.5;
    return Math.max(this.policy.pollMs, Math.min(this.policy.maxBackoffMs, Math.floor(this.policy.initialBackoffMs * 2 ** Math.min(Math.max(0, failures - 1), 16) * jitter)));
  }
}
