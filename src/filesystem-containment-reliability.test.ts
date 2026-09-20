import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeFileTool } from "./pi-tools.js";

test("Claude-compatible writes reject traversal, outside absolute paths and intermediate junctions", async t => {
  const root = await mkdtemp(join(tmpdir(), "devspace-containment-"));
  const workspace = join(root, "workspace"), outside = join(root, "outside");
  await mkdir(workspace); await mkdir(outside);
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(outside, "secret.txt"), "secret\n");
  await symlink(outside, join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");

  const context = { cwd: workspace, root: workspace };
  await assert.rejects(writeFileTool({ path: "../outside/traversal.txt", content: "no" }, context), /outside allowed roots/i);
  await assert.rejects(writeFileTool({ path: join(outside, "absolute.txt"), content: "no" }, context), /outside allowed roots/i);
  await assert.rejects(writeFileTool({ path: "escape/junction.txt", content: "no" }, context), /outside the workspace/i);
  assert.equal(await access(join(outside, "junction.txt")).then(() => true, () => false), false);

  const safe = await writeFileTool({ path: "nested/safe.txt", content: "safe\n" }, context);
  assert.notEqual(safe.isError, true);
  assert.equal(await readFile(join(workspace, "nested", "safe.txt"), "utf8"), "safe\n");
});

test("Claude-compatible writes reject a final symlink target", async t => {
  const root = await mkdtemp(join(tmpdir(), "devspace-containment-final-"));
  const workspace = join(root, "workspace"), outside = join(root, "outside.txt");
  await mkdir(workspace); await writeFile(outside, "outside\n");
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(outside, join(workspace, "linked.txt"), "file");
  await assert.rejects(writeFileTool({ path: "linked.txt", content: "changed\n" }, { cwd: workspace, root: workspace }), /symlink or junction/i);
  assert.equal(await readFile(outside, "utf8"), "outside\n");
});
