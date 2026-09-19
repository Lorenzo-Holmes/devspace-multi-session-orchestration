import assert from "node:assert/strict";
import test from "node:test";
import { codexTurnMetadataFromRequest, openAiConversationScopeId } from "./request-meta.js";

test("OpenAI conversation scope accepts only a non-empty session string", () => {
  for (const meta of [
    undefined,
    {},
    { "openai/session": "" },
    { "openai/session": 42 },
    { "openai/session": {} },
  ]) {
    assert.equal(openAiConversationScopeId(meta), undefined);
  }

  assert.equal(
    openAiConversationScopeId({
      "openai/session": "chat-session-opaque-value",
      "openai/subject": "user-1",
      "openai/organization": "org-1",
    }),
    "chat-session-opaque-value",
  );
});

test("Codex Browser Use turn metadata prefers native host metadata", () => {
  assert.deepEqual(
    codexTurnMetadataFromRequest({
      meta: {
        "openai/session": "chat-session",
        "x-codex-turn-metadata": JSON.stringify({
          session_id: "native-session",
          turn_id: "native-turn",
          model: "gpt-test",
        }),
      },
      requestId: 9,
    }),
    { session_id: "native-session", turn_id: "native-turn", model: "gpt-test" },
  );
});

test("Codex Browser Use turn metadata accepts the native HTTP header", () => {
  assert.deepEqual(
    codexTurnMetadataFromRequest({
      headers: {
        "X-Codex-Turn-Metadata": JSON.stringify({
          session_id: "header-session",
          turn_id: "header-turn",
        }),
      },
      requestId: "ignored",
    }),
    { session_id: "header-session", turn_id: "header-turn" },
  );
});

test("Codex Browser Use derives a scoped turn from ChatGPT MCP metadata", () => {
  assert.deepEqual(
    codexTurnMetadataFromRequest({
      meta: { "openai/session": "chat-session" },
      requestId: 42,
    }),
    { session_id: "chat-session", turn_id: "42", devspace_transport: "mcp" },
  );
  assert.equal(codexTurnMetadataFromRequest({ requestId: 42 }), undefined);
  assert.equal(
    codexTurnMetadataFromRequest({ meta: { "openai/session": "chat-session" } }),
    undefined,
  );
});
