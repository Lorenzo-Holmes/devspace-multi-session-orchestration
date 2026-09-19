import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntimeConfig, approvedReleaseUnchanged } from "./config.js";
import { NativeRuntimeAdapter } from "./native.js";
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "devspace-runtime-config-")));
  const instance = join(root, "instance"); mkdirSync(instance);
  const entryPoint = join(instance, "cli.js"); writeFileSync(entryPoint, "export {};\n");
  const pointer = join(root, "active.json"); writeFileSync(pointer, JSON.stringify({ entryPoint, buildId: "approved" }));
  const file = join(root, "runtime.json");
  const value = { instanceRoot: instance, stateDirectory: join(root, "state"), activeReleaseFile: pointer, serverVersion: "1", localUrl: "http://127.0.0.1:43917" };
  const save = (changes: Record<string, unknown> = {}) => writeFileSync(file, JSON.stringify({ ...value, ...changes })); save();
  return { root, instance, pointer, entryPoint, file, value, save, close: () => rmSync(root, { recursive: true, force: true }) };
}
test("runtime config has conservative defaults and does not mutate active pointer", t => {
  const f = fixture(); t.after(f.close); const before = readFileSync(f.pointer);
  const config = loadRuntimeConfig(f.file); assert.equal(config.policy.enabled, false);
  assert.equal(config.tunnelOwnership, "external"); assert.equal(approvedReleaseUnchanged(config), true);
  assert.deepEqual(readFileSync(f.pointer), before);
});
test("entrypoint outside approved installation root is rejected", t => {
  const f = fixture(); t.after(f.close); const file = join(f.root, "unrelated.js"); writeFileSync(file, "export {};");
  writeFileSync(f.pointer, JSON.stringify({ entryPoint: file, buildId: "approved" }));
  assert.throws(() => loadRuntimeConfig(f.file), /BLOCKED_CONFIG/);
});
for (const changes of [{ localUrl: "http://0.0.0.0:3000" }, { remoteUrl: "http://remote.example" }, { healthTokenEnv: "not valid" }, { unknown: true }, { stateDirectory: "relative" }, { tunnel: { ownership: "managed_by_devspace" } }]) test(`config rejects ${JSON.stringify(changes)}`, t => {
  const f = fixture(); t.after(f.close); f.save(changes); assert.throws(() => loadRuntimeConfig(f.file), /BLOCKED_CONFIG/);
});
test("corrupt config is blocked without speculative repair", t => {
  const f = fixture(); t.after(f.close); writeFileSync(f.file, "{bad JSON");
  assert.throws(() => loadRuntimeConfig(f.file), /BLOCKED_CONFIG/); assert.equal(readFileSync(f.file, "utf8"), "{bad JSON");
});
test("build or pointer mutation requires explicit release handoff", t => {
  const f = fixture(); t.after(f.close); const config = loadRuntimeConfig(f.file);
  writeFileSync(f.entryPoint, "export const changed = true;"); assert.equal(approvedReleaseUnchanged(config), false);
  assert.equal(new NativeRuntimeAdapter(config).preflight(), "release_changed");
});
test("legacy supervisor lock blocks parallel production ownership", t => {
  const f = fixture(); t.after(f.close); const config = loadRuntimeConfig(f.file);
  const lock = join(f.instance, ".devspace-supervisor.lock"); writeFileSync(lock, "uncertain legacy owner");
  assert.equal(new NativeRuntimeAdapter(config).preflight(), "identity_uncertain");
  assert.equal(readFileSync(lock, "utf8"), "uncertain legacy owner");
});
