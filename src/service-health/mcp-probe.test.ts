import test from "node:test";
import assert from "node:assert/strict";
import { probeMcp } from "./mcp-probe.js";
import { mcpFixture, type FixtureOptions } from "./test-fixture.js";
const base = { token: "fixture-token", expectedBuildId: "fixture-build", expectedServerVersion: "fixture-version", timeoutMs: 1000, processAlive: true, portListening: true };
for (const sse of [false, true]) test(`MCP health verifies identity/catalog and closes only its session (${sse ? "SSE" : "JSON"})`, async t => {
  const fixture = await mcpFixture({ sse }); t.after(fixture.close);
  fixture.sessions.add("independent-client-B");
  const result = await probeMcp({ ...base, origin: fixture.origin });
  assert.equal(result.status, "healthy"); assert.equal(result.toolCount, 2);
  assert.deepEqual([...fixture.sessions], ["independent-client-B"]);
  assert.deepEqual(fixture.calls, ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
});
for (const [options, reason] of [
  [{ buildId: "not-approved" }, "release_changed"], [{ serverVersion: "wrong-version" }, "release_changed"],
  [{ wrongFingerprint: true }, "unknown"], [{ wrongRpcId: true }, "unknown"], [{ oversized: true }, "unknown"],
  [{ token: "different" }, "authentication"], [{ status: 503 }, "network_transient"], [{ hang: true }, "network_transient"],
] as Array<[FixtureOptions, string]>) test(`health rejects ${JSON.stringify(options)}`, async t => {
  const fixture = await mcpFixture(options); t.after(fixture.close);
  const result = await probeMcp({ ...base, timeoutMs: options.hang ? 100 : 5000, origin: fixture.origin });
  assert.notEqual(result.status, "healthy"); assert.equal(result.reason, reason);
});
test("missing approved token does not start an OAuth authorization flow", async t => {
  const fixture = await mcpFixture(); t.after(fixture.close);
  assert.equal((await probeMcp({ ...base, origin: fixture.origin, token: undefined })).reason, "authentication");
  assert.equal(fixture.calls.length, 0);
});
test("process and local listener are both mandatory", async t => {
  const fixture = await mcpFixture(); t.after(fixture.close);
  for (const override of [{ processAlive: false }, { portListening: false }]) {
    assert.notEqual((await probeMcp({ ...base, origin: fixture.origin, ...override })).status, "healthy");
  }
  assert.equal(fixture.calls.length, 0);
});
