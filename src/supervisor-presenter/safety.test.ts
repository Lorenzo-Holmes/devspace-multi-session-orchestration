import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Supervisor card accepts results but has no command, network or hidden action path", () => {
  const card = readFileSync(new URL("../../scripts/supervisor/card.ts", import.meta.url), "utf8");
  const html = readFileSync(new URL("../../scripts/supervisor/card.html", import.meta.url), "utf8");
  const view = readFileSync(new URL("../supervisor-view.ts", import.meta.url), "utf8");
  assert.match(card, /app\.ontoolresult/);
  assert.match(card, /innerHTML\s*=\s*renderSupervisor\(/);
  assert.doesNotMatch(card, /callServerTool|callTool|sendMessage|updateModelContext|openLink|fetch\s*\(|XMLHttpRequest|WebSocket|\.post\s*\(|onclick|addEventListener/);
  assert.doesNotMatch(html, /<button|<form|<input|<a\s|\son[a-z]+\s*=|http-equiv|javascript:/i);
  assert.match(view, /supervisorSummarySchema\.parse\(value\)/);
  assert.doesNotMatch(view, /orchestration-(?:store|coordinator|automation|watchdog)|workspace-access/);
  for (const file of ["model.ts", "render.ts"]) {
    const code = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(code, /from\s+["'](?:node:|https?:|\.\.\/)|import\s*\(|fetch\s*\(|callServerTool|\.claim\s*\(|\.merge\s*\(|\.approve\s*\(/);
  }
});
