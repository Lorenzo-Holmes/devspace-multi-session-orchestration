import assert from "node:assert/strict";
import test from "node:test";
import { codexInstructions } from "./codex.js";
import { claudeInstructions } from "./claude.js";

test("Codex guidance prefers native read-only filesystem tools before exec_command", () => {
  const instructions = codexInstructions();
  for (const tool of [
    "read",
    "list_directory",
    "file_info",
    "batch_read_files",
    "search_files",
    "query_sqlite",
  ]) {
    assert.match(instructions, new RegExp(tool));
  }
  assert.match(instructions, /Reserve exec_command for tests, builds, package scripts/);
  assert.match(instructions, /not sandboxed/);
});

test("Claude guidance prefers native read-only filesystem tools before Bash", () => {
  const instructions = claudeInstructions({ agents: "", skills: "" });
  for (const tool of [
    "read",
    "list_directory",
    "file_info",
    "batch_read_files",
    "search_files",
    "query_sqlite",
  ]) {
    assert.match(instructions, new RegExp(tool));
  }
  assert.match(instructions, /Reserve bash for tests, builds, package scripts/);
  assert.match(instructions, /not sandboxed/);
});
