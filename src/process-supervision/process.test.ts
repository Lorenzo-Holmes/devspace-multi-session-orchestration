import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { selfIdentity, inspectProcess, processOwnsPort, portFree, terminateVerified } from "./process.js";
const supported = process.platform === "linux" || process.platform === "win32";
test("native process identity and listening socket ownership", { skip: !supported }, async t => {
  const identity = selfIdentity(); assert.equal(identity.pid, process.pid); assert.ok(identity.processStartTime.length > 5);
  const server = createServer(); t.after(() => server.close()); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  assert.equal(processOwnsPort(identity, port), true); assert.equal(await portFree(port), "occupied");
  assert.equal(processOwnsPort({ ...identity, processStartTime: "wrong-birth" }, port), false);
});
test("native safe termination refuses PID reuse and terminates only owned fixture", { skip: !supported }, async t => {
  const child = spawn(process.execPath, ["-e", "process.stdin.resume();process.stdin.on('end',()=>process.exit(0));console.log('ready')"], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exit = once(child, "exit"); child.stdin!.end(); await exit;
  });
  await once(child.stdout!, "data"); const observation = inspectProcess(child.pid!); assert.equal(observation.kind, "observed");
  if (observation.kind !== "observed") throw new Error("fixture birth unavailable");
  const identity = observation.identity;
  assert.equal(terminateVerified({ ...identity, processStartTime: "reused" }, true), false);
  assert.equal(inspectProcess(child.pid!).kind, "observed");
  const exit = once(child, "exit"); assert.equal(terminateVerified(identity, true), true); await exit;
  assert.equal(inspectProcess(identity.pid).kind, "absent");
});
test("Windows retained-handle backend is exercised on Windows only", { skip: process.platform !== "win32" }, () => {
  assert.ok(selfIdentity().processStartTime.startsWith("win:"));
  assert.equal(terminateVerified({ ...selfIdentity(), processStartTime: "mismatch" }, true), false);
});
