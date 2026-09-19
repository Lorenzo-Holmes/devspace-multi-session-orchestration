import assert from "node:assert/strict";
import test from "node:test";
import {
  codexBrowserActionFromDesktop,
  codexBrowserWindowAlias,
  parseCodexBrowserWindowAlias,
} from "./codex-cua-tools.js";

test("browser compatibility alias round-trips exact browser and tab identity", () => {
  const alias = codexBrowserWindowAlias(
    "2",
    "625079855",
    "Chrome",
    "Tripo Studio",
    "https://studio.tripo3d.ai/zh",
  );
  assert.equal(alias.app, "codex-browser-use:2/625079855");
  assert.equal(alias.id, 625079855);
  assert.match(alias.title ?? "", /Tripo Studio/);
  assert.match(alias.title ?? "", /studio\.tripo3d\.ai/);
  assert.deepEqual(parseCodexBrowserWindowAlias(alias), {
    browserId: "2",
    tabId: "625079855",
  });
});

test("browser compatibility alias rejects a guessed or stale numeric identity", () => {
  const alias = codexBrowserWindowAlias("2", "625079855");
  assert.throws(
    () => parseCodexBrowserWindowAlias({ ...alias, id: alias.id + 1 }),
    /ALIAS_STALE/,
  );
});

test("desktop element actions preserve accessibility grounding for browser aliases", () => {
  assert.deepEqual(
    codexBrowserActionFromDesktop({
      action: "click_element",
      elementIndex: 42,
      clickCount: 2,
      mouseButton: "left",
    }),
    {
      action: "click_element",
      elementIndex: 42,
      clickCount: 2,
      mouseButton: "left",
    },
  );
  assert.deepEqual(
    codexBrowserActionFromDesktop({ action: "right_click_element", elementIndex: 7 }),
    { action: "click_element", elementIndex: 7, mouseButton: "right" },
  );
});

test("desktop scroll maps deterministically to bounded Browser Use pages", () => {
  assert.deepEqual(
    codexBrowserActionFromDesktop({
      action: "scroll",
      x: 600,
      y: 400,
      scrollX: 0,
      scrollY: 1300,
    }),
    {
      action: "scroll",
      x: 600,
      y: 400,
      direction: "down",
      pages: 3,
    },
  );
});

test("unsupported browser drag never degrades to a guessed action", () => {
  assert.throws(
    () => codexBrowserActionFromDesktop({
      action: "drag",
      fromX: 10,
      fromY: 20,
      toX: 30,
      toY: 40,
    }),
    /ACTION_UNSUPPORTED/,
  );
});
