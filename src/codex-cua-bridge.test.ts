import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexCuaBridge,
  browserActionCode,
  codexCuaActionCode,
  performDirectCodexAction,
  type DirectWindowsClient,
} from "./codex-cua-bridge.js";

const window = {
  app: "process:C:\\Windows\\explorer.exe",
  id: 4197410,
  title: "amadeus - 文件资源管理器",
};

test("Codex CUA element clicks use accessibility indices instead of pixel guessing", () => {
  const code = codexCuaActionCode(window, {
    action: "double_click_element",
    elementIndex: 42,
  });
  assert.match(code, /^await cua\.computer\.click\(/);
  assert.match(code, /"element_index":42/);
  assert.match(code, /"click_count":2/);
  assert.doesNotMatch(code, /"x":|"y":/);
});

test("Codex CUA coordinate clicks preserve screenshot identity", () => {
  const code = codexCuaActionCode(window, {
    action: "click",
    x: 320,
    y: 240,
    screenshotId: "shot-7",
  });
  assert.match(code, /"x":320/);
  assert.match(code, /"y":240/);
  assert.match(code, /"screenshotId":"shot-7"/);
});

test("Codex CUA text is JSON encoded before entering the persistent JS runtime", () => {
  const code = codexCuaActionCode(window, {
    action: "type_text",
    text: "hello\n\"; process.exit(1); //",
  });
  assert.match(code, /^await cua\.computer\.type_text\(/);
  assert.match(code, /\\n/);
  assert.match(code, /\\"/);
  assert.doesNotMatch(code, /text:.*process\.exit/);
});

test("Codex CUA keypress uses the official Windows press_key surface", () => {
  const code = codexCuaActionCode(window, {
    action: "keypress",
    key: "Ctrl+L",
  });
  assert.match(code, /^await cua\.computer\.press_key\(/);
  assert.match(code, /"key":"Ctrl\+L"/);
});

test("Codex Browser CUA actions bind an exact trusted tab and refresh state", () => {
  const code = browserActionCode("2", "625079855", {
    action: "click_element",
    elementIndex: 17,
  });
  assert.match(code, /cua\.getTab\(__devspaceRequestedTabId, \{ browser: __devspaceBrowserId \}\)/);
  assert.match(code, /__devspaceTab\.click\(17/);
  assert.match(code, /getAXStateAndScreenshot/);
  assert.match(code, /cua\.getState\(\{ emit: false \}\)/);
  assert.match(code, /DEVSPACE_CUA_JSON:/);
});

test("Codex Browser CUA text actions JSON encode untrusted text", () => {
  const code = browserActionCode("2", "625079855", {
    action: "type_text",
    text: "hello\n\"; process.exit(1); //",
  });
  assert.match(code, /__devspaceTab\.typeText\(/);
  assert.match(code, /\\n/);
  assert.match(code, /\\"/);
  assert.match(code, /typeText\("hello\\n\\"; process\.exit\(1\); \/\/"\);/);
});

test("direct Codex helper uses accessibility element indices without coordinates", async () => {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const client = fakeDirectClient(calls);
  await performDirectCodexAction(client, window, {
    action: "double_click_element",
    elementIndex: 42,
  });
  assert.deepEqual(calls, [{
    method: "click",
    input: {
      window,
      element_index: 42,
      click_count: 2,
      mouse_button: "left",
    },
  }]);
});

test("direct Codex helper preserves fresh screenshot identity for coordinate actions", async () => {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const client = fakeDirectClient(calls);
  await performDirectCodexAction(client, window, {
    action: "click",
    x: 320,
    y: 240,
    screenshotId: "shot-7",
  });
  assert.equal(calls[0]?.method, "click");
  assert.deepEqual(calls[0]?.input, {
    window,
    x: 320,
    y: 240,
    screenshotId: "shot-7",
    click_count: 1,
    mouse_button: "left",
  });
});

test("direct Codex helper session is closed after every successful operation", async () => {
  const bridge = new CodexCuaBridge();
  let clientCloseCount = 0;
  let helperCloseCount = 0;
  const fakeClient = {
    ...fakeDirectClient([]),
    list_windows: async () => [],
    close: async () => { clientCloseCount += 1; },
  };
  const fakeHelper = { close: async () => { helperCloseCount += 1; } };
  const internal = bridge as any;
  internal.ensureDirectConnected = async () => {
    internal.directClient = fakeClient;
    internal.directHelper = fakeHelper;
    return fakeClient;
  };

  await bridge.listWindows();

  assert.equal(clientCloseCount, 1);
  assert.equal(helperCloseCount, 1);
  assert.equal(internal.directClient, undefined);
  assert.equal(internal.directHelper, undefined);
  await bridge.close();
});

test("direct Codex helper session is closed when an operation fails", async () => {
  const bridge = new CodexCuaBridge();
  let clientCloseCount = 0;
  let helperCloseCount = 0;
  const fakeClient = {
    ...fakeDirectClient([]),
    list_windows: async () => { throw new Error("synthetic CUA failure"); },
    close: async () => { clientCloseCount += 1; },
  };
  const fakeHelper = { close: async () => { helperCloseCount += 1; } };
  const internal = bridge as any;
  internal.ensureDirectConnected = async () => {
    internal.directClient = fakeClient;
    internal.directHelper = fakeHelper;
    return fakeClient;
  };

  await assert.rejects(() => bridge.listWindows(), /synthetic CUA failure/);

  assert.equal(clientCloseCount, 1);
  assert.equal(helperCloseCount, 1);
  assert.equal(internal.directClient, undefined);
  assert.equal(internal.directHelper, undefined);
  await bridge.close();
});

function fakeDirectClient(
  calls: Array<{ method: string; input: Record<string, unknown> }>,
): DirectWindowsClient {
  const record = (method: string) => async (input: Record<string, unknown>) => {
    calls.push({ method, input });
  };
  return {
    target: "windows",
    close: async () => {},
    list_windows: async () => [],
    get_window_state: async () => ({}),
    activate_window: record("activate_window"),
    click: record("click"),
    scroll: record("scroll"),
    drag: record("drag"),
    press_key: record("press_key"),
    type_text: record("type_text"),
    set_value: record("set_value"),
    perform_secondary_action: record("perform_secondary_action"),
  };
}
