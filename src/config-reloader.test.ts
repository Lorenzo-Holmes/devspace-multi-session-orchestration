import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { watchAllowedRoots } from "./config-reloader.js";
import { loadConfig } from "./config.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";
import { setDevspaceConfigValue } from "./user-config.js";

test("allowed roots hot-reload after an atomic config replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-config-reload-test-"));
  const first = join(root, "first");
  const second = join(root, "second");
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  const env = writeTestDevspaceConfig(join(root, "config"), {
    workspaces: {
      allowedRoots: [first],
      worktreeRoot: join(root, "worktrees"),
    },
    storage: { stateDir: join(root, "state") },
    logging: { toolCalls: false, requests: false },
  });
  const config = loadConfig(env);
  const watcher = watchAllowedRoots(config);

  try {
    setDevspaceConfigValue(["workspaces", "allowedRoots"], [first, second], env);
    await waitFor(() => config.allowedRoots.includes(second));
    assert.deepEqual(config.allowedRoots, [first, second]);
  } finally {
    watcher.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for allowed-roots hot reload.");
}
