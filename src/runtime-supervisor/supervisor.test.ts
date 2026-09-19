import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RuntimeJournal, FencedError } from "../runtime-journal/store.js";
import { identityState, parsePolicy, publicStatus, type Failure, type Health } from "../runtime-lifecycle/contracts.js";
import { planRecovery, planSnapshot } from "../runtime-recovery/planner.js";
import { RuntimeSupervisor } from "./supervisor.js";
import { harness } from "./fakes.js";
import { BoundedReconnect } from "../runtime-recovery/reconnect.js";

for (const field of ["pid", "processStartTime", "executable"] as const) test(`PID identity includes ${field}`, () => {
  const a = { pid: 42, processStartTime: "birth-1", executable: "/node" };
  const b = { ...a, [field]: field === "pid" ? 43 : "different" };
  assert.equal(identityState(a, { kind: "observed", identity: b }), "reused");
});
test("registered process is not recovery success before full health", async t => {
  const h = harness(); t.after(h.close); h.processes.readiness = false;
  await h.healthy(); assert.equal(h.journal.read().slots.server.state, "degraded");
  assert.equal(h.journal.read().attempts.length, 0);
  h.processes.readiness = true; await h.step();
  assert.equal(h.journal.read().runtimeState, "healthy"); assert.equal(h.journal.read().attempts[0].phase, "completed");
});
test("unexpected crash recovers approved build with increased generation", async t => {
  const h = harness(); t.after(h.close); await h.healthy(); const old = h.journal.read().slots.server.identity!;
  h.processes.exit("server", 17); await h.step(); assert.equal(h.journal.read().slots.server.lastExit?.code, 17);
  await h.step(200); await h.step();
  const now = h.journal.read(); assert.equal(now.runtimeState, "healthy");
  assert.ok(now.runtimeGeneration > old.generation); assert.equal(h.processes.launches.length, 2);
  assert.equal(now.slots.server.identity?.buildId, old.buildId);
});
test("100 immediate crashes eventually pause with bounded attempts/events/processes", async t => {
  const h = harness({ eventLimit: 20, attemptLimit: 5 }); t.after(h.close);
  for (let i = 0; i < 100; i++) { await h.supervisor.tick(); h.processes.exit("server"); await h.step(800); }
  assert.equal(h.journal.read().slots.server.state, "paused_needs_attention");
  assert.equal(h.processes.launches.length, 4); assert.ok(h.journal.read().events.length <= 20);
  assert.ok(h.journal.read().attempts.length <= 5); assert.equal(h.processes.processes.size, 1);
});
test("startup timeout stops verified hung process and uses backoff", async t => {
  const h = harness(); t.after(h.close); h.processes.readiness = false; await h.healthy();
  await h.step(1000); assert.equal(h.journal.read().slots.server.state, "stopping");
  await h.step(500); assert.equal(h.processes.terminations.length, 1);
  await h.step(); await h.step(200); assert.equal(h.processes.launches.length, 2);
  assert.ok(h.journal.read().attempts.some(x => x.lastError === "START_FAILED"));
});
test("unknown port owner blocks without termination", async t => {
  const h = harness(); t.after(h.close); h.processes.occupied = true; await h.supervisor.tick();
  assert.equal(h.journal.read().slots.server.blockedReason, "BLOCKED_PORT_CONFLICT");
  assert.equal(h.processes.launches.length, 0); assert.equal(h.processes.terminations.length, 0);
});
test("reused PID is never killed and unknown listener is not adopted", async t => {
  const h = harness(); t.after(h.close); await h.healthy(); const identity = h.journal.read().slots.server.identity!;
  h.processes.processes.set(identity.pid, { ...identity, processStartTime: "unrelated-birth" }); h.processes.occupied = true;
  h.journal.control("stop"); await h.step(); assert.equal(h.processes.terminations.length, 0);
  h.journal.control("resume"); await h.step(800);
  assert.equal(h.journal.read().slots.server.blockedReason, "BLOCKED_PORT_CONFLICT");
  assert.equal(h.processes.processes.get(identity.pid)?.processStartTime, "unrelated-birth");
});
test("intentional stop persists across owner restart and never respawns", async t => {
  const h = harness(); t.after(h.close); await h.healthy(); h.journal.control("stop"); await h.step();
  h.processes.exit("server", 0); await h.step(); h.journal.release(h.owner, true);
  assert.equal(h.journal.read().cleanShutdown, true);
  const next = h.journal.acquire(h.owner.identity, h.processes.inspect, h.clock.time);
  await new RuntimeSupervisor(h.journal, next, h.processes, h.clock).tick();
  assert.equal(h.processes.launches.length, 1); assert.equal(h.journal.read().runtimeState, "stopped");
});
test("pause and resume first reconcile healthy orphan rather than duplicate start", async t => {
  const h = harness(); t.after(h.close); await h.healthy(); h.journal.control("pause"); await h.step();
  assert.equal(h.journal.read().runtimeState, "paused_needs_attention");
  h.journal.control("resume"); await h.step(); assert.equal(h.processes.launches.length, 1);
  assert.equal(h.journal.read().runtimeState, "healthy");
});
test("disabled policy never launches", async t => {
  const h = harness({ enabled: false }); t.after(h.close); await h.healthy(); assert.equal(h.processes.launches.length, 0);
});
test("two owners and stale worker writes are fenced", async t => {
  const h = harness();
  const other = new RuntimeJournal(h.directory, "fixture-root", h.policy);
  t.after(() => { other.close(); h.close(); });
  assert.throws(() => other.acquire({ ...h.owner.identity, pid: 901 }, h.processes.inspect, h.clock.time), /SUPERVISOR_ACTIVE/);
  h.processes.processes.delete(h.owner.identity.pid);
  const owner = other.acquire({ ...h.owner.identity, pid: 901 }, h.processes.inspect, h.clock.time);
  assert.ok(owner.epoch > h.owner.epoch);
  assert.throws(() => h.journal.update(h.owner, s => { s.runtimeGeneration = 999; }), FencedError);
});
test("uncertain live lock is retained despite arbitrarily old heartbeat", t => {
  const h = harness(); t.after(h.close); h.processes.uncertain.add(h.owner.identity.pid);
  assert.throws(() => h.journal.acquire({ ...h.owner.identity, pid: 901 }, h.processes.inspect, h.clock.time + 86400000), /SUPERVISOR_UNCERTAIN/);
  assert.equal(h.journal.read().owner?.token, h.owner.token);
});
test("PID-reused supervisor lock can be reclaimed without killing replacement", t => {
  const h = harness(); t.after(h.close); h.processes.processes.set(900, { ...h.owner.identity, processStartTime: "reused" });
  const owner = h.journal.acquire({ ...h.owner.identity, pid: 901 }, h.processes.inspect, h.clock.time);
  assert.equal(owner.epoch, 2); assert.equal(h.processes.terminations.length, 0);
});
test("orphan registered during starting is adopted and final health commit reconciles", async t => {
  const h = harness(); t.after(h.close); await h.supervisor.tick();
  assert.equal(h.journal.read().slots.server.currentRecovery?.phase, "starting");
  h.processes.processes.delete(900);
  const owner = h.journal.acquire({ ...h.owner.identity, pid: 901 }, h.processes.inspect, h.clock.time);
  const next = new RuntimeSupervisor(h.journal, owner, h.processes, h.clock);
  await next.tick(); assert.equal(h.processes.launches.length, 1); assert.equal(h.journal.read().runtimeState, "healthy");
  assert.ok(h.journal.read().events.some(e => e.event === "ADOPTED_EXISTING_RUNTIME"));
});
test("journal transaction failure rolls back instead of publishing partial JSON", t => {
  const h = harness(); t.after(h.close); const revision = h.journal.read().revision;
  assert.throws(() => h.journal.update(h.owner, s => { s.runtimeGeneration = 20; throw new Error("injected before commit"); }));
  assert.equal(h.journal.read().runtimeGeneration, 0); assert.equal(h.journal.read().revision, revision);
});
test("corrupt journal is preserved and rejected, not reinitialized", t => {
  const h = harness(); t.after(h.close); const db = new DatabaseSync(h.journal.path);
  db.prepare("UPDATE runtime_snapshot SET body=? WHERE id=1").run("{partial"); db.close();
  assert.throws(() => h.journal.read());
  assert.throws(() => new RuntimeJournal(h.directory, "fixture-root", h.policy));
});
test("unclaimed start timeout revokes ticket so delayed bootstrap cannot execute", async t => {
  const h = harness(); t.after(h.close); h.processes.launchMode = "unclaimed"; await h.supervisor.tick();
  const old = h.processes.launches[0].ticket; await h.step(1000); await h.step(100);
  assert.notEqual(h.journal.read().slots.server.ticket?.token, old.token);
  h.processes.launchMode = "normal"; await h.processes.launch("server", old);
  assert.equal(h.journal.read().slots.server.identity, undefined);
});
test("native spawn-before-publication ambiguity blocks rather than duplicates", async t => {
  const h = harness({}, true); t.after(h.close); await h.supervisor.tick(); h.processes.launchMode = "native-gap";
  await h.supervisor.tick(); await h.step(1000);
  assert.equal(h.journal.read().slots.tunnel.blockedReason, "UNCERTAIN_INFRASTRUCTURE_CHILD");
  for (let i = 0; i < 5; i++) await h.step();
  assert.equal(h.processes.launches.filter(x => x.component === "tunnel").length, 1);
});
test("concurrent ticks and recovery workers spend one reservation", async t => {
  const h = harness(); t.after(h.close);
  const another = new RuntimeSupervisor(h.journal, h.owner, h.processes, h.clock);
  await Promise.all([h.supervisor.tick(), h.supervisor.tick(), another.tick()]);
  assert.equal(h.processes.launches.length, 1); assert.equal(h.journal.read().runtimeGeneration, 1);
});
test("late health result cannot overwrite successor generation", async t => {
  const h = harness(); t.after(h.close); await h.supervisor.tick();
  let done!: (health: Health) => void;
  h.processes.health = () => new Promise(resolve => { done = resolve; });
  const tick = h.supervisor.tick(); await new Promise(resolve => setImmediate(resolve));
  h.journal.update(h.owner, s => { s.slots.server.identity = { ...s.slots.server.identity!, generation: 99, runtimeId: "new" }; s.slots.server.state = "starting"; });
  done({ status: "healthy", reason: "ready", processAlive: true, portListening: true, mcpReady: true, buildId: h.processes.buildId, serverVersion: h.processes.serverVersion, toolCount: 3 });
  await tick; assert.equal(h.journal.read().slots.server.state, "starting");
});
for (const failure of ["authentication", "browser_security", "config_failure", "resource_exhaustion", "unknown", "release_changed"] as Failure[]) test(`${failure} never grants automatic repair authority`, async t => {
  const h = harness(); t.after(h.close); h.processes.failure = failure; await h.supervisor.tick();
  assert.equal(h.processes.launches.length, 0); assert.equal(h.processes.terminations.length, 0);
  assert.equal(h.journal.read().runtimeState, "blocked");
});
test("build and entrypoint mismatch are not adopted or killed", async t => {
  const h = harness(); t.after(h.close); await h.healthy();
  h.journal.update(h.owner, s => { s.slots.server.identity!.entrypoint = "/different.js"; }); await h.step();
  assert.equal(h.journal.read().slots.server.blockedReason, "BLOCKED_RUNTIME_IDENTITY_MISMATCH");
  assert.equal(h.processes.terminations.length, 0);
});
test("managed tunnel crashes restart only after foundation is healthy", async t => {
  const h = harness({}, true); t.after(h.close); await h.healthy(); await h.step();
  h.processes.exit("tunnel"); await h.step(); await h.step(200); await h.step();
  assert.equal(h.processes.launches.filter(x => x.component === "server").length, 1);
  assert.equal(h.processes.launches.filter(x => x.component === "tunnel").length, 2);
  assert.equal(h.journal.read().runtimeState, "healthy");
});
test("external cloudflared and remote outage are observed without stealing ownership", async t => {
  const h = harness(); t.after(h.close); h.processes.remoteEnabled = true;
  h.processes.tunnelHealth = { status: "degraded", reason: "network_transient", processAlive: true, portListening: true, mcpReady: false };
  await h.healthy(); for (let i = 0; i < 20; i++) await h.step(1000);
  assert.equal(h.processes.launches.length, 1); assert.equal(h.processes.terminations.length, 0);
  assert.equal(h.journal.read().runtimeState, "degraded");
});
test("two-hour sleep enters reconciliation before any restart", async t => {
  const h = harness({}, true); t.after(h.close); await h.healthy(); await h.step(); h.processes.exit("server");
  await h.step(7_200_000); assert.equal(h.processes.launches.length, 2);
  assert.ok(h.journal.read().events.some(e => e.event === "resume_reconciliation"));
  await h.step(600); await h.step(); assert.equal(h.processes.launches.length, 3);
});
test("backward wall clock does not manufacture healthy reset", async t => {
  const h = harness(); t.after(h.close); await h.healthy(); const old = h.journal.read().policyTime;
  await h.step(-20_000); assert.equal(h.journal.read().policyTime, old); assert.ok(h.journal.read().resumeUntil > old);
  assert.equal(h.processes.launches.length, 1);
});
test("healthy duration resets penalty and rolling windows are not lifetime counts", async t => {
  const h = harness(); t.after(h.close); await h.healthy(); h.processes.exit("server"); await h.step(); await h.step(200); await h.step();
  await h.step(2000); assert.equal(h.journal.read().slots.server.failures, 0); assert.equal(h.journal.read().slots.server.restarts.length, 0);
  const s = h.journal.read(); s.slots.server.restarts = [1, 2, 3, 4];
  assert.equal(planRecovery(s, s.slots.server, "process_crash", h.policy, h.clock.time).remainingComponent, 4);
});
test("user task processes and workspace/Git files are untouched", async t => {
  const h = harness(); t.after(h.close);
  const path = join(h.directory, "user-workspace-proof"); writeFileSync(path, "dirty staged and unstaged bytes");
  h.processes.processes.set(700, { pid: 700, processStartTime: "user-task", executable: "/user-shell" });
  await h.healthy(); h.processes.exit("server"); await h.step(); await h.step(200); await h.step();
  assert.equal(h.processes.processes.get(700)?.processStartTime, "user-task"); assert.equal(readFileSync(path, "utf8"), "dirty staged and unstaged bytes");
});
test("status redacts reservation secrets and process paths", async t => {
  const h = harness(); t.after(h.close); await h.healthy(); const s = h.journal.read(); const out = JSON.stringify(publicStatus(s, h.policy));
  assert.ok(!out.includes(s.owner!.token)); assert.ok(!out.includes(s.slots.server.ticket!.token)); assert.ok(!out.includes("/approved/"));
});
test("24-hour accelerated runtime, network, tunnel, sleep and crash simulation", async t => {
  const h = harness({ pollMs: 1000, initialBackoffMs: 1000, maxBackoffMs: 5000, healthTimeoutMs: 10000,
    stopTimeoutMs: 5000, resumeThresholdMs: 120000, resumeGraceMs: 3000, healthyResetMs: 120000, windowMs: 600000, eventLimit: 32 }, true);
  t.after(h.close); await h.healthy();
  const start = h.clock.time;
  let connections = 0;
  const cua = new BoundedReconnect(() => ({ id: ++connections, close: async () => {} }), {
    now: () => h.clock.time, sleep: async ms => { h.clock.advance(ms); },
  });
  t.after(() => cua.close());
  for (let i = 0; i < 2641; i++) {
    const before = h.clock.time;
    if (i === 900) assert.equal(await cua.run(true, async resource => {
      if (resource.id === 1) throw Object.assign(new Error("updated pipe"), {code:"ENOENT"});
      return resource.id;
    }), 2);
    if ([20, 400, 1200, 2500].includes(i)) h.processes.exit("server");
    if ([40, 700].includes(i)) h.processes.exit("tunnel");
    if (i === 80) h.processes.tunnelHealth = { status: "degraded", reason: "network_transient", processAlive: true, portListening: true, mcpReady: false };
    if (i === 85) h.processes.tunnelHealth = undefined;
    await h.step((i === 500 ? 7200000 : 30000) - (h.clock.time - before));
  }
  assert.equal(h.clock.time - start, 86_400_000); assert.equal(connections, 2);
  assert.equal(h.journal.read().runtimeState, "healthy"); assert.ok(h.journal.read().events.length <= 32);
  assert.equal(h.journal.read().slots.server.restarts.length, 0); assert.ok(h.processes.launches.length < 20);
});
for (const value of [{ pollMs: -1 }, { windowMs: 0 }, { windowMs: 1 }, { healthyResetMs: 1 }, { maxRestartsPerWindow: 9999999 }, { enabled: "yes" }, { initialBackoffMs: 1 }, { invented: true }]) test(`invalid recovery config ${JSON.stringify(value)}`, () => {
  assert.throws(() => parsePolicy(value), /BLOCKED_CONFIG/);
});

test("start succeeds but parent launch acknowledgement fails: adopt instead of duplicate", async t => {
  const h = harness(); t.after(h.close); const launch = h.processes.launch.bind(h.processes);
  h.processes.launch = async (component, ticket) => { await launch(component, ticket); throw new Error("parent acknowledgement lost"); };
  await h.healthy(); assert.equal(h.processes.launches.length, 1); assert.equal(h.journal.read().runtimeState, "healthy");
});
test("health succeeds but final journal commit fails: successor verifies instead of restarting", async t => {
  const h = harness(); t.after(h.close); await h.supervisor.tick();
  const update = h.journal.update.bind(h.journal), health = h.processes.health.bind(h.processes);
  let fail = false;
  h.processes.health = async (component, identity) => { const result = await health(component, identity); fail = true; return result; };
  h.journal.update = ((owner, fn) => { if (fail) { fail = false; throw new Error("injected final commit failure"); } return update(owner, fn); }) as typeof h.journal.update;
  await assert.rejects(() => h.supervisor.tick(), /injected final commit failure/);
  h.journal.update = update; h.processes.health = health; h.processes.processes.delete(900);
  const nextOwner = h.journal.acquire({ ...h.owner.identity, pid: 901 }, h.processes.inspect, h.clock.time);
  await new RuntimeSupervisor(h.journal, nextOwner, h.processes, h.clock).tick();
  assert.equal(h.processes.launches.length, 1); assert.equal(h.journal.read().slots.server.currentRecovery?.phase, "completed");
});
test("port becomes occupied by the winning worker: loser cannot block the registered runtime", async t => {
  const h = harness(); t.after(h.close); let calls = 0;
  h.processes.portFree = async () => { if (++calls === 1) return "free"; await new Promise(resolve => setImmediate(resolve)); return "occupied"; };
  const other = new RuntimeSupervisor(h.journal, h.owner, h.processes, h.clock);
  await Promise.all([h.supervisor.tick(), other.tick()]); await h.supervisor.tick();
  assert.equal(h.processes.launches.length, 1); assert.equal(h.journal.read().runtimeState, "healthy");
});

test("dry-run reconciles existing identity and never mutates the snapshot", async t => {
  const h = harness(); t.after(h.close); await h.healthy();
  const snapshot = h.journal.read(), before = JSON.stringify(snapshot);
  assert.equal(planSnapshot(snapshot, snapshot.slots.server, h.policy).action, "no_action");
  assert.equal(JSON.stringify(snapshot), before); assert.equal(h.journal.read().revision, snapshot.revision);
});
test("manual restart drains one generation before starting its successor", async t => {
  const h = harness(); t.after(h.close); await h.healthy();
  const first = h.journal.read().slots.server.identity!;
  h.journal.control("restart"); await h.step();
  assert.equal(h.journal.read().slots.server.state, "stopping"); assert.equal(h.processes.launches.length, 1);
  h.processes.exit("server", 0); await h.step(); await h.step();
  assert.equal(h.processes.launches.length, 2); assert.equal(h.journal.read().runtimeState, "healthy");
  assert.equal(h.journal.read().slots.server.identity?.buildId, first.buildId);
});
test("upgrade stop stays stopped and does not select another build", async t => {
  const h = harness(); t.after(h.close); await h.healthy(); h.journal.control("upgrade");
  await h.step(); h.processes.exit("server", 0); await h.step(); await h.step(10000);
  assert.equal(h.processes.launches.length, 1); assert.equal(h.journal.read().runtimeState, "stopped");
});
