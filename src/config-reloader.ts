import { join, resolve } from "node:path";
import { unwatchFile, watchFile } from "node:fs";
import type { ServerConfig } from "./config.js";
import { logEvent } from "./logger.js";
import { expandHomePath } from "./roots.js";
import { loadDevspaceFiles } from "./user-config.js";
import { replaceAllowedRoots } from "./workspace-access.js";

export interface ConfigReloader {
  close(): void;
}

export function watchAllowedRoots(config: ServerConfig): ConfigReloader {
  const path = join(config.configDir, "config.jsonc");
  const env = { ...process.env, DEVSPACE_CONFIG_DIR: config.configDir };
  let lastSignature = signature(config.allowedRoots);

  const reload = () => {
    try {
      const stored = loadDevspaceFiles(env).config.workspaces.allowedRoots;
      const nextAllowedRoots = (stored.length > 0 ? stored : [process.cwd()])
        .map((root) => resolve(expandHomePath(root)));
      const nextSignature = signature(nextAllowedRoots);
      if (nextSignature === lastSignature) return;
      replaceAllowedRoots(config, nextAllowedRoots);
      lastSignature = nextSignature;
      logEvent(config.logging, "info", "allowed_roots_reloaded", {
        count: config.allowedRoots.length,
      });
    } catch (error) {
      logEvent(config.logging, "warn", "allowed_roots_reload_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  watchFile(path, { interval: 750, persistent: false }, reload);
  return {
    close: () => unwatchFile(path, reload),
  };
}

function signature(roots: string[]): string {
  return JSON.stringify(roots);
}
