import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Workspace } from "./workspaces.js";

export function projectKeyForWorkspace(workspace: Workspace): string {
  const key = resolve(workspace.sourceRoot ?? workspace.root);
  return process.platform === "win32" ? key.toLowerCase() : key;
}

export function automaticSessionExternalId(
  projectKey: string,
  trustedConversationId: string,
): string {
  return createHash("sha256")
    .update(projectKey)
    .update("\0")
    .update(trustedConversationId)
    .digest("hex");
}
