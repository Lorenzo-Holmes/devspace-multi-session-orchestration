import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..");
const read = (path: string) => readFile(join(root, path), "utf8");

test("shared card visual system defines light/dark, responsive, focus and reduced-motion contracts", async () => {
  const css = await read("scripts/card-system.css");
  assert.match(css, /color-scheme:light dark/);
  assert.match(css, /prefers-color-scheme:dark/);
  assert.match(css, /focus-visible/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  for (const width of [480, 340]) assert.match(css, new RegExp(`max-width:${width}px`));
  for (const token of ["--ds-surface", "--ds-text", "--ds-border", "--ds-success", "--ds-warning", "--ds-danger", "--ds-radius", "--ds-shadow", "--ds-normal"]) {
    assert.match(css, new RegExp(token));
  }
  assert.doesNotMatch(css, /url\s*\(/i, "card system remains self-contained");
});

test("diagnostic, goal, approval and supervisor templates share the same packaged card shell", async () => {
  for (const path of ["scripts/card-lab/card.html", "scripts/goal-card/card.html", "scripts/computer-approval/card.html", "scripts/supervisor/card.html"]) {
    const html = await read(path);
    assert.match(html, /<!--CARD_STYLE-->/);
    assert.match(html, /<!--CARD_SCRIPT-->/);
    assert.doesNotMatch(html, /<link\b/i);
  }
  const diagnostic = await read("scripts/card-lab/card.html");
  const goal = await read("scripts/goal-card/card.html");
  const approval = await read("scripts/computer-approval/card.html");
  const supervisor = await read("scripts/supervisor/card.html");
  for (const html of [diagnostic, goal, approval]) assert.match(html, /role="status" aria-live="polite"/);
  assert.match(supervisor, /aria-live="polite"/);
  for (const id of ["app", "message", "scope", "risk", "allow", "deny"]) assert.match(approval, new RegExp(`id="${id}"`));
});

test("packager injects the shared stylesheet into every standalone card", async () => {
  const build = await read("scripts/build-chat-card.mjs");
  assert.match(build, /scripts\/card-system\.css/);
  assert.match(build, /injectStyle/);
  for (const template of ["card-lab/card.html", "goal-card/card.html", "computer-approval/card.html", "supervisor/card.html"]) {
    assert.match(build, new RegExp(template.replaceAll(".", "\\.").replaceAll("/", "\\/")));
  }
});
