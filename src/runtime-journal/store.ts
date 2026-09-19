import { DatabaseSync } from "node:sqlite";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { boundedSnapshot, event, initialSnapshot, identityState, sameProcess, lifecycleStates,
  type Component, type Owner, type Ownership, type ProcessIdentity, type ProcessObservation,
  type RestartPolicy, type RuntimeIdentity, type RuntimeSnapshot } from "../runtime-lifecycle/contracts.js";

export class FencedError extends Error { constructor() { super("RUNTIME_OWNER_FENCED"); } }
export type InspectProcess = (pid: number) => ProcessObservation;
// Runtime-owned database only. No imports of the orchestration database/migrations.
export class RuntimeJournal {
  readonly path: string;
  private readonly db: DatabaseSync;
  constructor(directory: string, readonly rootId: string, readonly policy: RestartPolicy, ownership: Ownership = "external") {
    const wanted = resolve(directory);
    mkdirSync(wanted, { recursive: true, mode: 0o700 });
    if (lstatSync(wanted).isSymbolicLink() || realpathSync(wanted) !== wanted) throw new Error("BLOCKED_CONFIG: runtime directory aliases forbidden");
    const st = lstatSync(wanted);
    if (process.platform !== "win32" && ((st.mode & 0o077) !== 0 || st.uid !== process.getuid?.())) throw new Error("BLOCKED_CONFIG: runtime directory must be private and owned by this user");
    this.path = join(wanted, "runtime-recovery.sqlite");
    for (const file of [this.path, this.path + "-wal", this.path + "-shm"]) {
      try { if (lstatSync(file).isSymbolicLink()) throw new Error("BLOCKED_CONFIG: runtime database symlink"); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
    this.db = new DatabaseSync(this.path);
    try {
      this.db.exec("PRAGMA busy_timeout=1500; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=64; PRAGMA journal_size_limit=1048576;");
      this.db.exec("CREATE TABLE IF NOT EXISTS runtime_snapshot(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)");
      this.db.prepare("INSERT OR IGNORE INTO runtime_snapshot(id,body) VALUES(1,?)").run(JSON.stringify(initialSnapshot(rootId, ownership)));
      this.read();
      if (process.platform !== "win32") chmodSync(this.path, 0o600);
    } catch (e) { this.db.close(); throw e; }
  }
  private validate(value: unknown): asserts value is RuntimeSnapshot {
    const s = value as RuntimeSnapshot;
    if (!s || s.schemaVersion !== 1 || s.rootId !== this.rootId || !Number.isSafeInteger(s.revision)
      || !Number.isSafeInteger(s.runtimeGeneration) || s.runtimeGeneration < 0
      || !Number.isSafeInteger(s.ownerEpoch) || !lifecycleStates.includes(s.runtimeState)
      || !s.control || !["run", "pause", "stop", "upgrade"].includes(s.control.mode) || !Number.isSafeInteger(s.control.restart)
      || !s.slots?.server || !s.slots?.tunnel || !Array.isArray(s.events) || !Array.isArray(s.attempts) || !Array.isArray(s.globalRestarts)
      || !Number.isFinite(s.policyTime)) throw new Error("BLOCKED_METADATA: invalid journal; preserve for inspection");
    for (const [name, slot] of Object.entries(s.slots)) {
      if (!["server", "tunnel"].includes(name) || name !== slot.component || !lifecycleStates.includes(slot.state)
        || !["managed_by_devspace", "external"].includes(slot.ownership) || !Array.isArray(slot.restarts)
        || !slot.restarts.every(Number.isFinite) || !Number.isSafeInteger(slot.failures) || slot.failures < 0) throw new Error("BLOCKED_METADATA: invalid component");
      for (const identity of [slot.identity, slot.ticket?.holder]) if (identity) this.validateIdentity(identity);
      if (slot.identity && (!slot.identity.runtimeId || slot.identity.rootId !== this.rootId || !Number.isSafeInteger(slot.identity.generation))) throw new Error("BLOCKED_METADATA: invalid runtime identity");
    }
    if (s.owner) { this.validateIdentity(s.owner.identity); if (!s.owner.token || s.owner.epoch !== s.ownerEpoch) throw new Error("BLOCKED_METADATA: invalid owner"); }
  }
  private validateIdentity(x: ProcessIdentity): void {
    if (!Number.isSafeInteger(x.pid) || x.pid < 1 || typeof x.processStartTime !== "string" || !x.processStartTime
      || typeof x.executable !== "string" || !x.executable) throw new Error("BLOCKED_METADATA: invalid process identity");
  }
  read(): RuntimeSnapshot {
    const row = this.db.prepare("SELECT body FROM runtime_snapshot WHERE id=1").get() as { body: string } | undefined;
    if (!row || row.body.length > 8_000_000) throw new Error("BLOCKED_METADATA: missing/oversized journal");
    const s: unknown = JSON.parse(row.body); this.validate(s); return s;
  }
  private transaction<T>(fn: (s: RuntimeSnapshot) => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const s = this.read(); const answer = fn(s);
      s.revision += 1; boundedSnapshot(s, this.policy); this.validate(s);
      this.db.prepare("UPDATE runtime_snapshot SET body=? WHERE id=1").run(JSON.stringify(s));
      this.db.exec("COMMIT"); return answer;
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  acquire(identity: ProcessIdentity, inspect: InspectProcess, now: number): Owner {
    this.validateIdentity(identity);
    return this.transaction(s => {
      if (s.owner) {
        // Delayed/sleeping/live owners are NEVER stolen based on wall-clock expiry.
        const state = identityState(s.owner.identity, inspect(s.owner.identity.pid));
        if (state === "active" || state === "uncertain") throw new Error(state === "active" ? "SUPERVISOR_ACTIVE" : "SUPERVISOR_UNCERTAIN");
        event(s, "supervisor", "stale_owner_reclaimed", now, state);
      }
      if (!s.cleanShutdown) event(s, "supervisor", "dirty_shutdown_reconciliation", now);
      s.owner = { token: randomUUID(), epoch: ++s.ownerEpoch, identity, acquiredAt: now, heartbeatAt: now };
      s.cleanShutdown = false;
      return structuredClone(s.owner);
    });
  }
  update<T>(owner: Owner, fn: (s: RuntimeSnapshot) => T): T {
    return this.transaction(s => {
      if (!s.owner || s.owner.token !== owner.token || s.owner.epoch !== owner.epoch || !sameProcess(s.owner.identity, owner.identity)) throw new FencedError();
      return fn(s);
    });
  }
  release(owner: Owner, clean: boolean): void {
    this.update(owner, s => { s.owner = undefined; s.cleanShutdown = clean && Object.values(s.slots).every(x => x.ownership === "external" || x.state === "stopped"); });
  }
  control(command: "pause" | "resume" | "stop" | "restart" | "upgrade"): void {
    this.transaction(s => {
      s.control.mode = command === "pause" ? "pause" : command === "stop" ? "stop" : command === "upgrade" ? "upgrade" : "run";
      if (command === "restart") s.control.restart++;
      if (command === "resume" || command === "restart") {
        for (const slot of Object.values(s.slots)) {
          if (slot.state === "paused_needs_attention" || slot.state === "blocked") slot.state = slot.identity ? "degraded" : "stopped";
          slot.blockedReason = undefined;
        }
      }
      event(s, "supervisor", `manual_${command}`, Math.max(Date.now(), s.policyTime));
    });
  }
  claimWorker(component: Component, token: string, identity: RuntimeIdentity): boolean {
    this.validateIdentity(identity);
    return this.transaction(s => {
      const slot = s.slots[component]; const t = slot.ticket;
      if (!t || t.token !== token || t.runtimeId !== identity.runtimeId || t.generation !== identity.generation
        || t.holder || slot.identity || s.control.mode !== "run" || identity.rootId !== s.rootId) return false;
      t.holder = identity;
      if (component === "server") slot.identity = identity;
      slot.state = "starting";
      if (slot.currentRecovery) { slot.currentRecovery.phase = "starting"; slot.currentRecovery.newPid = identity.pid; slot.currentRecovery.updatedAt = Date.now(); }
      return true;
    });
  }
  nativeStarting(component: Component, token: string, holder: ProcessIdentity): void {
    this.workerUpdate(component, token, holder, s => { s.slots[component].ticket!.nativeLaunchStarted = true; });
  }
  registerNative(component: Component, token: string, holder: ProcessIdentity, identity: RuntimeIdentity): void {
    this.validateIdentity(identity);
    this.workerUpdate(component, token, holder, s => { const slot = s.slots[component]; if (slot.identity) throw new FencedError(); slot.identity = identity; if (slot.currentRecovery) slot.currentRecovery.newPid = identity.pid; });
  }
  private workerUpdate(component: Component, token: string, holder: ProcessIdentity, fn: (s: RuntimeSnapshot) => void): void {
    this.transaction(s => {
      const t = s.slots[component].ticket;
      if (!t || t.token !== token || !t.holder || !sameProcess(t.holder, holder)) throw new FencedError();
      fn(s);
    });
  }
  workerExit(component: Component, token: string, holder: ProcessIdentity, code: number | null, signal: string | null, now: number): void {
    this.workerUpdate(component, token, holder, s => {
      const slot = s.slots[component];
      slot.lastExit = { at: now, code, signal, uptimeMs: Math.max(0, now - (slot.identity?.createdAt ?? slot.ticket!.reservedAt)), intentional: !!slot.stopRequested || s.control.mode === "stop" || s.control.mode === "upgrade" };
    });
  }
  close(): void { this.db.close(); }
}
