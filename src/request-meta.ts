function metadataString(
  meta: unknown,
  key: string,
): string | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const value = (meta as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function openAiConversationScopeId(
  meta: unknown,
): string | undefined {
  return metadataString(meta, "openai/session");
}

export type CodexTurnMetadata = Record<string, unknown> & {
  session_id: string;
  turn_id: string;
};

export interface CodexTurnMetadataRequestContext {
  meta?: unknown;
  headers?: Record<string, string | string[] | undefined>;
  transportSessionId?: string;
  requestId?: string | number;
}

/**
 * Build the turn metadata required by Codex Browser Use without inventing an
 * unrelated identity. Prefer native x-codex-turn-metadata when a host sends
 * it. ChatGPT's MCP transport currently exposes its conversation scope as
 * openai/session; when native Codex metadata is absent, map that stable scope
 * plus this concrete JSON-RPC request id onto Browser Use's required
 * session_id/turn_id fields. If neither host scope is available, fail closed.
 */
export function codexTurnMetadataFromRequest(
  context: CodexTurnMetadataRequestContext,
): CodexTurnMetadata | undefined {
  const native = parseCodexTurnMetadata(metadataValue(context.meta, "x-codex-turn-metadata"))
    ?? parseCodexTurnMetadata(headerValue(context.headers, "x-codex-turn-metadata"));
  if (native) return native;

  const sessionId = openAiConversationScopeId(context.meta)
    ?? nonEmptyString(context.transportSessionId);
  if (!sessionId || context.requestId === undefined) return undefined;
  const turnId = String(context.requestId);
  if (!turnId) return undefined;
  return {
    session_id: sessionId,
    turn_id: turnId,
    devspace_transport: "mcp",
  };
}

function parseCodexTurnMetadata(value: unknown): CodexTurnMetadata | undefined {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const sessionId = nonEmptyString(record.session_id);
  const turnId = nonEmptyString(record.turn_id);
  if (!sessionId || !turnId) return undefined;
  return { ...record, session_id: sessionId, turn_id: turnId };
}

function metadataValue(meta: unknown, key: string): unknown {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  return (meta as Record<string, unknown>)[key];
}

function headerValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  key: string,
): string | undefined {
  if (!headers) return undefined;
  const matched = Object.entries(headers).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
  if (Array.isArray(matched)) return matched[0];
  return matched;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
