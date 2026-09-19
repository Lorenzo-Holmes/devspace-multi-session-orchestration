import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export const MERGE_POLICY = "isolated-ort-v1";

export interface MergeProbeInput {
  candidateRoot: string;
  sourceRoot: string;
  candidateRef: string;
  targetRef: string;
}
export interface MergeObservation {
  candidateRoot: string;
  sourceRoot: string;
  commonDirectory: string;
  candidateOid: string;
  targetOid: string;
  candidateTree: string;
  targetTree: string;
  candidateHead: string;
  candidateStatus: string;
  targetStatus: string;
}
export interface MergeProbeResult {
  observation?: MergeObservation;
  conflictState: "unknown" | "clean" | "conflict";
  mergeTreeOid?: string;
  diffReady: boolean;
  policy: typeof MERGE_POLICY;
  errorCode?: string;
}

function environment(isolated = false): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // A workspace path, not inherited Git redirection, determines the repository.
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith("GIT_")) delete env[key];
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_NO_REPLACE_OBJECTS = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  if (isolated) {
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
    env.GIT_ATTR_NOSYSTEM = "1";
  }
  return env;
}

async function git(cwd: string, args: string[], env = environment()): Promise<string> {
  return (await exec("git", args, { cwd, env, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
}

function validRef(ref: string): void {
  if (!ref || ref.length > 200 || ref.startsWith("-") || /[\x00-\x20\x7f]/.test(ref)) {
    throw new Error("invalid_ref");
  }
}

async function directory(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("invalid_worktree");
  return realpath(path);
}

export async function observeMergeInputs(input: MergeProbeInput): Promise<MergeObservation> {
  validRef(input.candidateRef);
  validRef(input.targetRef);
  const candidateRoot = await directory(input.candidateRoot);
  const sourceRoot = await directory(input.sourceRoot);
  const commonDirectory = await realpath(await git(candidateRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const sourceCommon = await realpath(await git(sourceRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  if (commonDirectory !== sourceCommon) throw new Error("foreign_repository");
  const candidateOid = await git(candidateRoot, ["rev-parse", "--verify", "--end-of-options", input.candidateRef + "^{commit}"]);
  const targetOid = await git(sourceRoot, ["rev-parse", "--verify", "--end-of-options", input.targetRef + "^{commit}"]);
  if (!oidPattern.test(candidateOid) || !oidPattern.test(targetOid)) throw new Error("invalid_oid");
  return {
    candidateRoot, sourceRoot, commonDirectory, candidateOid, targetOid,
    candidateTree: await git(candidateRoot, ["rev-parse", candidateOid + "^{tree}"]),
    targetTree: await git(sourceRoot, ["rev-parse", targetOid + "^{tree}"]),
    candidateHead: await git(candidateRoot, ["rev-parse", "HEAD"]),
    candidateStatus: await git(candidateRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
    targetStatus: await git(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
  };
}

async function hasUnsupportedPolicy(observation: MergeObservation): Promise<boolean> {
  for (const root of [observation.candidateRoot, observation.sourceRoot]) {
    try {
      const config = await git(root, ["config", "--get-regexp", "^(merge\\.|core\\.attributesfile$)"]);
      // Do not execute custom drivers, or silently claim equivalence to an
      // installation-specific merge/attribute policy. Such policies need an adapter.
      if (config) return true;
    } catch (error) {
      if ((error as { code?: number }).code !== 1) throw error;
    }
  }
  const attributes = await readFile(join(observation.commonDirectory, "info", "attributes"), "utf8")
    .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
  return attributes.split(/\r?\n/).some(line => line.trim() && !line.trim().startsWith("#"));
}

/** No source refs, index, worktree or object database are written by the simulation. */
export async function probeCandidateMerge(input: MergeProbeInput): Promise<MergeProbeResult> {
  let temporary: string | undefined;
  let observation: MergeObservation | undefined;
  const result: MergeProbeResult = { conflictState: "unknown", diffReady: false, policy: MERGE_POLICY };
  try {
    observation = await observeMergeInputs(input);
    result.observation = observation;
    result.diffReady = Boolean(await git(observation.candidateRoot,
      ["diff", "--no-ext-diff", "--no-textconv", "--name-only", observation.targetOid, observation.candidateOid, "--"]));
    if (await hasUnsupportedPolicy(observation)) return { ...result, errorCode: "unsupported_merge_policy" };
    const format = await git(observation.candidateRoot, ["rev-parse", "--show-object-format"]);
    if (!["sha1", "sha256"].includes(format)) return { ...result, errorCode: "unsupported_object_format" };
    temporary = await mkdtemp(join(tmpdir(), "devspace-merge-probe-"));
    const env = environment(true);
    await git(temporary, ["init", "--bare", "--template=", "--object-format=" + format, "."], env);
    // C-style quoting protects alternate paths containing separators, spaces,
    // quotes or backslashes on both Windows and POSIX. New objects stay temporary.
    env.GIT_ALTERNATE_OBJECT_DIRECTORIES = JSON.stringify(resolve(observation.commonDirectory, "objects"));
    try {
      const output = await git(temporary, ["merge-tree", "--write-tree", "--no-messages", observation.targetOid, observation.candidateOid], env);
      const tree = output.split(/\r?\n/, 1)[0];
      if (!oidPattern.test(tree)) return { ...result, errorCode: "invalid_merge_receipt" };
      result.conflictState = "clean";
      result.mergeTreeOid = tree;
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; signal?: unknown; killed?: boolean };
      if (failure.code !== 1 || failure.signal || failure.killed) throw error;
      const tree = (failure.stdout ?? "").trim().split(/\r?\n/, 1)[0];
      if (!oidPattern.test(tree)) return { ...result, errorCode: "invalid_conflict_receipt" };
      result.conflictState = "conflict";
      result.mergeTreeOid = tree;
    }
    return result;
  } catch {
    // Command output/configuration can contain private paths or driver arguments.
    return { ...result, observation, conflictState: "unknown", errorCode: "git_probe_failed" };
  } finally {
    // Only the directory allocated by this invocation is eligible for removal.
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

export async function mergeInputsUnchanged(input: MergeProbeInput, prior?: MergeObservation): Promise<boolean> {
  if (!prior) return false;
  try { return JSON.stringify(await observeMergeInputs(input)) === JSON.stringify(prior); }
  catch { return false; }
}
