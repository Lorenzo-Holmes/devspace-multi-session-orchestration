import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

// New engineering contracts only; no changes to orchestration correctness tests.
// Benchmarks are intentionally NOT run by the ordinary unit-test suite.
test("release integrity, rollback fault and benchmark-generator contracts", { timeout: 60_000 }, t => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "scripts/release-contract.test.mjs", "scripts/release-pipeline.test.mjs", "benchmarks/orchestration/fixtures.test.mjs"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", env, timeout: 45_000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, (result.stdout ?? "") + (result.stderr ?? ""));
  assert.match(result.stdout, /# tests [1-9][0-9]*\b/, "Child test suite must actually execute");
  for (const line of result.stdout.split(/\r?\n/)) {
    if (/^# (tests|pass|fail|skipped)\b/.test(line) || line.includes("# SKIP")) t.diagnostic(line);
  }
});
