import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { TOOL_CAPABILITIES } from "../tool-capabilities/catalog.js";
import { extractRegistrations, extractToolAliases } from "./source-inventory.js";
const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
test("source aliases and literal/template registration sites have exact manifest coverage", () => {
  const aliases = extractToolAliases(read("src/tool-surfaces/types.ts"));
  const files = [...new Set(TOOL_CAPABILITIES.flatMap(t => t.sourceFiles))].sort();
  const registrations = files.flatMap(file => extractRegistrations(file, read(file), aliases));
  for (const file of files) {
    const actual = [...new Set(registrations.filter(r => r.file === file).map(r => r.name))].sort();
    const expected = TOOL_CAPABILITIES.filter(t => t.sourceFiles.includes(file)).map(t => t.toolName).sort();
    assert.deepEqual(actual, expected, `Registry drift in ${file}; classify the real registration instead of updating a count`);
  }
  assert.deepEqual([...new Set(registrations.map(r => r.name))].sort(), TOOL_CAPABILITIES.map(t => t.toolName));
});
test("AST extractor rejects dynamic/unclassified registrations instead of silently losing them", () => {
  assert.throws(() => extractRegistrations("src/new.ts", "server.registerTool(computeName(), {}, fn)", {}), /Unresolved/);
  assert.throws(() => extractRegistrations("src/new.ts", "server.registerTool(toolNames.missing, {}, fn)", {}), /Unresolved alias/);
  assert.deepEqual(extractRegistrations("fixture.ts", 'server.registerTool("x", {}, f); registerAppTool(server, "y", {}, f)', {}).map(r => r.name), ["x", "y"]);
  assert.deepEqual(extractRegistrations("fixture.ts", 'for (const action of ["pause", "stop"] as const) server.registerTool(`goal_${action}`, {}, f)', {}).map(r => r.name), ["goal_pause", "goal_stop"]);
});
test("runtime guidance retains handlers and existing instructions without protocol extensions", () => {
  const index = read("src/tool-surfaces/index.ts");
  assert.match(index, /register: registerCodexTools/); assert.match(index, /register: registerClaudeTools/);
  assert.match(index, /codexInstructions\(context\)/); assert.match(index, /claudeInstructions\(context\)/);
  const guidance = read("src/tool-surfaces/control-plane-guidance.ts");
  assert.match(guidance, /advisory, not authorization/);
  assert.match(guidance, /A heartbeat is not model liveness/);
  assert.match(guidance, /integration_gate writes/);
  assert.doesNotMatch(guidance, /readOnlyHint|callServerTool|registerTool|fetch\s*\(/);
});
test("capability/recommendation runtime modules cannot import or call authority/execution services", () => {
  for (const file of ["types", "catalog", "roles", "recommend"]) {
    const text = read(`src/tool-capabilities/${file}.ts`);
    assert.doesNotMatch(text, /from\s+["'](?:node:|https?:|\.\.\/)|import\s*\(|fetch\s*\(|registerTool\s*\(|callServerTool|\.exec\s*\(|\.spawn\s*\(/);
  }
});
