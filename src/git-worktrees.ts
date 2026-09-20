import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { ServerConfig } from "./config.js";
import { assertAllowedPath, isPathInsideRoot } from "./roots.js";

const execFileAsync = promisify(execFile);

export class GitWorktreeError extends Error {
  constructor(
    readonly code:
      | "GIT_NOT_AVAILABLE"
      | "GIT_REPOSITORY_NOT_FOUND"
      | "GIT_REPOSITORY_HAS_NO_COMMITS"
      | "GIT_INVALID_BASE_REF"
      | "GIT_WORKTREE_CREATE_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "GitWorktreeError";
  }
}

export interface ManagedWorktree {
  sourceRoot: string;
  path: string;
  baseRef: string;
  baseSha: string;
  dirtySource: boolean;
  detached: boolean;
  managed: boolean;
}

export interface PreparedManagedWorktree extends ManagedWorktree {}

/** Resolves every mutable Git input before a worktree-creation side effect. */
export async function prepareManagedWorktree(input: {
  sourcePath: string;
  baseRef?: string;
  config: ServerConfig;
  allowedRoots?: string[];
  managedKey?: string;
}): Promise<PreparedManagedWorktree> {
  const allowedRoots = input.allowedRoots ?? input.config.allowedRoots;
  const sourcePath = assertAllowedPath(input.sourcePath, allowedRoots);
  try {
    const sourceStats = await stat(sourcePath);
    if (!sourceStats.isDirectory()) throw new Error("not_directory");
  } catch {
    throw new GitWorktreeError(
      "GIT_REPOSITORY_NOT_FOUND",
      `Cannot open workspace in worktree mode because the source path does not exist or is not a directory: ${input.sourcePath}`,
    );
  }
  const sourceRoot = await resolveGitRoot(sourcePath, allowedRoots);
  const baseRef = input.baseRef ?? "HEAD";
  const baseSha = await resolveBaseCommit(sourceRoot, baseRef);
  const dirtySource = (await git(["status", "--porcelain=v1"], sourceRoot)).trim().length > 0;
  const path = managedWorktreePath({ worktreeRoot: input.config.worktreeRoot, repoRoot: sourceRoot, managedKey: input.managedKey });
  assertAllowedPath(path, [input.config.worktreeRoot]);
  return { sourceRoot, path, baseRef, baseSha, dirtySource, detached: true, managed: true };
}

/** Materializes or validates exactly the immutable prepared worktree. */
export async function materializeManagedWorktree(input: {
  prepared: PreparedManagedWorktree;
  config: ServerConfig;
}): Promise<ManagedWorktree> {
  const prepared = input.prepared;
  assertAllowedPath(prepared.path, [input.config.worktreeRoot]);
  const resolved = await resolveBaseCommit(prepared.sourceRoot, prepared.baseSha);
  if (resolved !== prepared.baseSha) throw new Error("Prepared worktree base commit changed unexpectedly.");
  await mkdir(input.config.worktreeRoot, { recursive: true });

  const present = await lstat(prepared.path).catch(() => undefined);
  if (present) {
    if (!present.isDirectory() || present.isSymbolicLink()) throw new Error("Managed worktree path is not a directory owned by this provision.");
    const common = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], prepared.sourceRoot)).trim();
    const candidateCommon = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], prepared.path)).trim();
    const head = (await git(["rev-parse", "HEAD"], prepared.path)).trim();
    const topLevel = (await git(["rev-parse", "--show-toplevel"], prepared.path)).trim();
    if (resolve(common) !== resolve(candidateCommon) || head !== prepared.baseSha
      || await realpath(topLevel) !== await realpath(prepared.path)) {
      throw new Error("Managed worktree recovery requires the original repository and base commit; existing files were preserved.");
    }
    return prepared;
  }
  try {
    await git(["worktree", "add", "--detach", prepared.path, prepared.baseSha], prepared.sourceRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GitWorktreeError("GIT_WORKTREE_CREATE_FAILED", `Git failed to create the managed worktree. ${message}`);
  }
  return prepared;
}

export async function createManagedWorktree(input: {
  sourcePath: string;
  baseRef?: string;
  config: ServerConfig;
  allowedRoots?: string[];
  managedKey?: string;
}): Promise<ManagedWorktree> {
  const prepared = await prepareManagedWorktree(input);
  return materializeManagedWorktree({ prepared, config: input.config });
}

async function resolveGitRoot(path: string, allowedRoots: string[]): Promise<string> {
  try {
    const output = await git(["rev-parse", "--show-toplevel"], path);
    return await assertGitRootAllowed(output.trim(), allowedRoots);
  } catch (error) {
    if (isGitUnavailable(error)) {
      throw new GitWorktreeError(
        "GIT_NOT_AVAILABLE",
        "Cannot open workspace in worktree mode because Git is not available on this machine.",
      );
    }

    throw new GitWorktreeError(
      "GIT_REPOSITORY_NOT_FOUND",
      `Cannot open workspace in worktree mode because this path is not inside a Git repository: ${path}. Use mode=\"checkout\" to work directly in this directory, or initialize Git and create an initial commit first.`,
    );
  }
}

async function assertGitRootAllowed(gitRoot: string, allowedRoots: string[]): Promise<string> {
  try {
    return assertAllowedPath(gitRoot, allowedRoots);
  } catch {
    const canonicalGitRoot = await realpath(gitRoot);
    for (const allowedRoot of allowedRoots) {
      const canonicalAllowedRoot = await realpath(allowedRoot).catch(() => undefined);
      if (!canonicalAllowedRoot || !isPathInsideRoot(canonicalGitRoot, canonicalAllowedRoot)) {
        continue;
      }

      const logicalGitRoot = resolve(allowedRoot, relative(canonicalAllowedRoot, canonicalGitRoot));
      return assertAllowedPath(logicalGitRoot, allowedRoots);
    }

    return assertAllowedPath(canonicalGitRoot, allowedRoots);
  }
}

async function resolveBaseCommit(sourceRoot: string, baseRef: string): Promise<string> {
  try {
    return (await git(["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`], sourceRoot)).trim();
  } catch (error) {
    if (baseRef === "HEAD") {
      throw new GitWorktreeError(
        "GIT_REPOSITORY_HAS_NO_COMMITS",
        "Cannot open workspace in worktree mode because the repository has no commits yet. Create an initial commit first, or use mode=\"checkout\".",
      );
    }

    throw new GitWorktreeError(
      "GIT_INVALID_BASE_REF",
      `Cannot open workspace in worktree mode because baseRef ${JSON.stringify(baseRef)} does not resolve to a commit.`,
    );
  }
}

function managedWorktreePath(input: { worktreeRoot: string; repoRoot: string; managedKey?: string }): string {
  const repoName = sanitizePathSegment(basename(input.repoRoot)) || "repo";
  const worktreeId = input.managedKey
    ? createHash("sha256").update(input.managedKey).digest("hex").slice(0, 24)
    : randomBytes(4).toString("hex");
  return join(input.worktreeRoot, `${repoName}-${worktreeId}`);
}

function sanitizePathSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    if (isGitUnavailable(error)) throw error;

    const stderr = typeof error === "object" && error && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "").trim()
      : "";
    const stdout = typeof error === "object" && error && "stdout" in error
      ? String((error as { stdout?: unknown }).stdout ?? "").trim()
      : "";
    const details = stderr || stdout || (error instanceof Error ? error.message : String(error));
    throw new Error(details);
  }
}

function isGitUnavailable(error: unknown): boolean {
  return Boolean(
    typeof error === "object" &&
      error &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT",
  );
}
