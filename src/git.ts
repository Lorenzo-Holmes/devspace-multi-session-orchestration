import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export interface GitEligibility {
  ok: boolean;
  gitRoot?: string;
  reason?: "not_git" | "no_head" | "outside_workspace";
  message?: string;
}

export async function git(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; maxBuffer?: number } = {},
): Promise<GitCommandResult> {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
  });

  return { stdout, stderr };
}

export async function getGitEligibility(cwd: string): Promise<GitEligibility> {
  try {
    await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return {
      ok: false,
      reason: "not_git",
      message: "workspace is not inside a git repository",
    };
  }

  const gitRoot = (await git(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
  const [workspacePath, repositoryPath] = await Promise.all([realpath(cwd), realpath(gitRoot)]);
  const normalized = (path: string) => process.platform === "win32"
    ? resolve(path).toLowerCase()
    : resolve(path);
  if (normalized(workspacePath) !== normalized(repositoryPath)) {
    return {
      ok: false,
      reason: "outside_workspace",
      message: "review requires a Git repository rooted at the workspace; parent repositories are outside its scope",
    };
  }
  try {
    await git(gitRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  } catch {
    return {
      ok: false,
      gitRoot,
      reason: "no_head",
      message: "repository has no HEAD commit",
    };
  }

  return { ok: true, gitRoot };
}

export function safeWorkspaceRefSegment(workspaceId: string): string {
  const safe = workspaceId.replace(/[^A-Za-z0-9._-]/g, "-");
  return safe.length > 0 ? safe : createHash("sha256").update(workspaceId).digest("hex").slice(0, 16);
}
