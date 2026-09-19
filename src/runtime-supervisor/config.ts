import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, basename, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fingerprint, parsePolicy, type RestartPolicy, type Ownership } from "../runtime-lifecycle/contracts.js";
export interface ApprovedRelease { entrypoint: string; buildId: string; serverVersion: string; entrypointHash: string; pointerHash: string }
export interface TunnelConfig { executable: string; executableHash: string; configFile: string; configHash: string; tunnelId: string }
export interface RuntimeConfig {
  configFile: string; configHash: string; stateDirectory: string; instanceRoot: string; rootId: string;
  activeReleaseFile: string; release: ApprovedRelease; localUrl: string; remoteUrl?: string;
  healthTokenEnv: string; policy: RestartPolicy; tunnelOwnership: Ownership; tunnel?: TunnelConfig;
}
function hash(bytes: string | Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function object(x: unknown): Record<string, unknown> {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error("BLOCKED_CONFIG: expected JSON object"); return x as Record<string, unknown>;
}
function text(x: unknown, name: string): string {
  if (typeof x !== "string" || !x.trim() || x.length > 4096 || /[\0\r\n]/.test(x)) throw new Error(`BLOCKED_CONFIG: invalid ${name}`); return x;
}
function existingPath(x: unknown, name: string, directory = false): string {
  const path = text(x, name);
  if (!isAbsolute(path)) throw new Error(`BLOCKED_CONFIG: ${name} must be absolute`);
  const canonical = realpathSync(path);
  const stat = statSync(canonical);
  if (!(directory ? stat.isDirectory() : stat.isFile())) throw new Error(`BLOCKED_CONFIG: wrong ${name} type`);
  return canonical;
}
function jsonFile(path: string): { bytes: Buffer; value: Record<string, unknown> } {
  if (statSync(path).size > 262_144) throw new Error("BLOCKED_CONFIG: oversized configuration");
  const bytes = readFileSync(path); return { bytes, value: object(JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""))) };
}
function parseRuntimeConfig(path: string): RuntimeConfig {
  const configFile = existingPath(path, "configFile"); const { value: raw, bytes } = jsonFile(configFile);
  const allowed = new Set(["stateDirectory", "instanceRoot", "activeReleaseFile", "serverVersion", "localUrl", "remoteUrl", "healthTokenEnv", "runtimeRecovery", "tunnel"]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`BLOCKED_CONFIG: unknown field ${key}`);
  const stateDirectory = resolve(text(raw.stateDirectory, "stateDirectory"));
  if (!isAbsolute(text(raw.stateDirectory, "stateDirectory"))) throw new Error("BLOCKED_CONFIG: stateDirectory must be absolute");
  const instanceRoot = existingPath(raw.instanceRoot, "instanceRoot", true);
  const activeReleaseFile = existingPath(raw.activeReleaseFile, "activeReleaseFile");
  const pointer = jsonFile(activeReleaseFile);
  const entrypoint = existingPath(pointer.value.entryPoint, "entryPoint");
  const rel = relative(instanceRoot, entrypoint);
  if (!rel || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) throw new Error("BLOCKED_CONFIG: entrypoint escapes instanceRoot");
  const local = new URL(text(raw.localUrl, "localUrl"));
  if (local.protocol !== "http:" || local.hostname !== "127.0.0.1" || !local.port || local.username || local.password || local.search || local.hash || local.pathname !== "/") throw new Error("BLOCKED_CONFIG: localUrl must be an explicit 127.0.0.1 HTTP origin and port");
  let remoteUrl: string | undefined;
  if (raw.remoteUrl !== undefined) {
    const remote = new URL(text(raw.remoteUrl, "remoteUrl"));
    if (remote.protocol !== "https:" || remote.username || remote.password || remote.search || remote.hash || remote.pathname !== "/") throw new Error("BLOCKED_CONFIG: remoteUrl must be an approved HTTPS origin");
    remoteUrl = remote.origin;
  }
  const healthTokenEnv = raw.healthTokenEnv === undefined ? "DEVSPACE_RUNTIME_HEALTH_TOKEN" : text(raw.healthTokenEnv, "healthTokenEnv");
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(healthTokenEnv)) throw new Error("BLOCKED_CONFIG: invalid credential environment key");
  const policy = parsePolicy(raw.runtimeRecovery ?? {});
  let tunnel: TunnelConfig | undefined;
  if (raw.tunnel !== undefined) {
    const t = object(raw.tunnel);
    for (const key of Object.keys(t)) if (!["ownership", "executable", "executableHash", "configFile", "configHash", "tunnelId"].includes(key)) throw new Error("BLOCKED_CONFIG: unknown tunnel field");
    if (t.ownership !== "external" && t.ownership !== "managed_by_devspace") throw new Error("BLOCKED_CONFIG: tunnel ownership required");
    if (t.ownership === "managed_by_devspace") {
      const executable = existingPath(t.executable, "tunnel executable");
      const configPath = existingPath(t.configFile, "tunnel config");
      const executableHash = text(t.executableHash, "executableHash"); const configHash = text(t.configHash, "configHash");
      const tunnelId = text(t.tunnelId, "tunnelId");
      if (!remoteUrl || !/^cloudflared(?:\.exe)?$/i.test(basename(executable)) || !/^[a-f0-9]{64}$/.test(executableHash) || !/^[a-f0-9]{64}$/.test(configHash)
        || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(tunnelId)
        || hash(readFileSync(executable)) !== executableHash || hash(readFileSync(configPath)) !== configHash) throw new Error("BLOCKED_CONFIG: managed tunnel requires pinned executable/config and named tunnel UUID");
      tunnel = { executable, executableHash, configFile: configPath, configHash, tunnelId };
    }
  }
  return { configFile, configHash: hash(bytes), stateDirectory, instanceRoot, rootId: fingerprint(instanceRoot), activeReleaseFile,
    release: { entrypoint, buildId: text(pointer.value.buildId, "buildId"), serverVersion: text(raw.serverVersion, "serverVersion"),
      entrypointHash: hash(readFileSync(entrypoint)), pointerHash: hash(pointer.bytes) },
    localUrl: local.origin, remoteUrl, healthTokenEnv, policy, tunnelOwnership: tunnel ? "managed_by_devspace" : "external", tunnel };
}
export function approvedReleaseUnchanged(config: RuntimeConfig): boolean {
  try {
    const current = loadRuntimeConfig(config.configFile);
    return current.configHash === config.configHash && current.release.pointerHash === config.release.pointerHash
      && current.release.entrypointHash === config.release.entrypointHash && current.rootId === config.rootId;
  } catch { return false; }
}

export function loadRuntimeConfig(path: string): RuntimeConfig {
  try { return parseRuntimeConfig(path); }
  catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("BLOCKED_CONFIG")) throw cause;
    throw new Error("BLOCKED_CONFIG", { cause });
  }
}
