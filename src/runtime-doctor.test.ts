import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  doctorReportFingerprint,
  parseDoctorArgs,
  redactDoctorReport,
  redactText,
  runRuntimeDoctor,
  writeDoctorSupportBundle,
  type DoctorDependencies,
  type DoctorReport,
} from "./runtime-doctor.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

function fakeDependencies(calls: string[]): Partial<DoctorDependencies> {
  return {
    now: () => new Date("2026-09-20T10:00:00.000Z"),
    run: async (command) => {
      calls.push("run:" + command);
      if (/reg/i.test(command)) return { stdout: "LongPathsEnabled    REG_DWORD    0x1", stderr: "", exitCode: 0 };
      if (/powershell/i.test(command)) return { stdout: "Get-FileHash", stderr: "", exitCode: 0 };
      return { stdout: command.includes("pnpm") ? "11.25.0" : "git version 2.51.0", stderr: "", exitCode: 0 };
    },
    tcp: async () => { calls.push("tcp"); },
    dns: async () => { calls.push("dns"); return [{ address: "203.0.113.10", family: 4 }]; },
    tls: async () => { calls.push("tls"); return { authorized: true, protocol: "TLSv1.3", validTo: "Oct 20 2026" }; },
    fetch: async (_url, init) => {
      calls.push("fetch:" + String(init.method));
      assert.equal((init.headers as Record<string, string> | undefined)?.authorization, undefined);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
    exists: async () => { calls.push("exists"); return true; },
    disk: async () => { calls.push("disk"); return { freeBytes: 40 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 }; },
    cua: async () => {
      calls.push("cua-discovery");
      return { version: "fixture", trustedRoot: true, nativePipeConfigured: true, nativePipeReachable: true,
        directRuntime: true, runtimeName: "codex-computer-use.exe" };
    },
  };
}

test("Doctor keeps unknown catalog/browser attachment distinct from PASS and performs only declared read probes", async t => {
  const dir = await mkdtemp(join(tmpdir(), "devspace-doctor-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = {
    ...process.env,
    ...writeTestDevspaceConfig(dir, { server: { publicBaseUrl: "https://doctor.example.test" } }),
    DEVSPACE_COMPUTER_USE: "1",
    PROGRAMFILES: "C:\\Program Files",
    LOCALAPPDATA: "C:\\Users\\Fixture\\AppData\\Local",
  };
  const calls: string[] = [];
  const report = await runRuntimeDoctor({ full: true, env }, fakeDependencies(calls));
  assert.equal(report.readOnly, true);
  assert.equal(report.checks.find(check => check.id === "catalog.freshness")?.status, "unknown");
  assert.equal(report.checks.find(check => check.id === "browser.attachment")?.status, "unknown");
  assert.equal(report.overallStatus, "unknown");
  assert.ok(report.checks.some(check => check.id === "mcp.local-protocol"));
  assert.ok(report.checks.some(check => check.id === "mcp.public-protocol"));
  assert.ok(calls.includes("tcp"));
  assert.ok(calls.includes("dns"));
  assert.ok(calls.includes("tls"));
  assert.ok(calls.includes("fetch:POST"));
  assert.ok(!calls.some(call => /kill|restart|approve|oauth|browser_action|open_chat/i.test(call)));
});

test("Doctor category filtering does not execute unrelated network or Computer Use probes", async t => {
  const dir = await mkdtemp(join(tmpdir(), "devspace-doctor-category-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, ...writeTestDevspaceConfig(dir) };
  const calls: string[] = [];
  const report = await runRuntimeDoctor({ category: "runtime", env }, fakeDependencies(calls));
  assert.deepEqual(report.checks.map(check => check.category), ["runtime"]);
  assert.equal(report.checks[0].status, "pass");
  assert.deepEqual(calls, []);
});

test("Doctor redaction removes bearer/token/password/cookie/private-key material from JSON and support bundles", async t => {
  const dir = await mkdtemp(join(tmpdir(), "devspace-doctor-redact-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const report: DoctorReport = {
    schemaVersion: 1,
    generatedAt: "2026-09-20T10:00:00.000Z",
    overallStatus: "warn",
    full: true,
    readOnly: true,
    checks: [{
      id: "fixture", category: "configuration", status: "warn", severity: "medium", summary: "fixture",
      details: "Authorization: Bearer abc.def.ghi https://user:pass@example.test/?access_token=topsecret",
      evidence: {
        accessToken: "topsecret",
        password: "secret-password",
        cookie: "session=secret",
        nested: { privateKey: "-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----" },
      },
      recommendation: "none", durationMs: 1, timestamp: "2026-09-20T10:00:00.000Z",
    }],
  };
  const redacted = redactDoctorReport(report);
  const json = JSON.stringify(redacted);
  for (const forbidden of ["abc.def.ghi", "topsecret", "secret-password", "session=secret", "\nsecret\n", "user:pass"]) {
    assert.equal(json.includes(forbidden), false, forbidden);
  }
  assert.match(json, /\[REDACTED/);
  const bundle = await writeDoctorSupportBundle(report, dir);
  const bundleText = await readFile(bundle, "utf8");
  assert.equal(bundleText.includes("topsecret"), false);
  assert.equal(bundleText.includes("secret-password"), false);
  assert.match(doctorReportFingerprint(report), /^[a-f0-9]{64}$/);
  assert.doesNotMatch(redactText("Bearer secret-token"), /secret-token/);
});

test("Doctor CLI parser supports full/json/category/support-bundle and rejects unknown options", () => {
  assert.deepEqual(parseDoctorArgs(["--full", "--json", "--category", "browser", "--support-bundle"]), {
    options: { full: true, category: "browser" },
    json: true,
    supportBundle: true,
  });
  assert.throws(() => parseDoctorArgs(["--category", "not-real"]), /Unknown Doctor category/);
  assert.throws(() => parseDoctorArgs(["--restart"]), /Unknown doctor option/);
});
