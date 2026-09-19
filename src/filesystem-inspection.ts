import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { assertAllowedPath } from "./roots.js";

export type FileSystemEntryKind = "file" | "directory" | "symlink" | "other";

export interface DirectoryEntryInfo {
  name: string;
  path: string;
  kind: FileSystemEntryKind;
  sizeBytes: number;
  modifiedAt: string;
}

export interface DirectoryListing {
  path: string;
  entries: DirectoryEntryInfo[];
  truncated: boolean;
}

export interface FileInfo {
  path: string;
  kind: FileSystemEntryKind;
  sizeBytes: number;
  createdAt: string;
  modifiedAt: string;
  accessedAt: string;
}

export async function listWorkspaceDirectory(
  workspaceRoot: string,
  requestedPath = ".",
  limit = 200,
): Promise<DirectoryListing> {
  const [root, target] = await Promise.all([
    realpath(workspaceRoot),
    realpath(join(workspaceRoot, requestedPath)),
  ]);
  assertAllowedPath(target, [root]);
  const targetStat = await lstat(target);
  if (!targetStat.isDirectory()) {
    throw new Error(`Not a directory: ${requestedPath}`);
  }

  const names = (await readdir(target, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
  const selected = names.slice(0, limit);
  const entries = await Promise.all(selected.map(async (entry) => {
    const absolutePath = join(target, entry.name);
    const stats = await lstat(absolutePath);
    return {
      name: entry.name,
      path: toWorkspacePath(relative(root, absolutePath)),
      kind: entry.isSymbolicLink()
        ? "symlink" as const
        : entry.isDirectory()
          ? "directory" as const
          : entry.isFile()
            ? "file" as const
            : "other" as const,
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    };
  }));

  return {
    path: toWorkspacePath(relative(root, target)) || ".",
    entries,
    truncated: names.length > selected.length,
  };
}

export async function getWorkspaceFileInfo(
  workspaceRoot: string,
  requestedPath: string,
): Promise<FileInfo> {
  const root = await realpath(workspaceRoot);
  const lexicalTarget = assertAllowedPath(resolve(workspaceRoot, requestedPath), [workspaceRoot]);
  const stats = await lstat(lexicalTarget);
  if (stats.isSymbolicLink()) {
    const resolvedParent = await realpath(dirname(lexicalTarget));
    assertAllowedPath(resolvedParent, [root]);
  } else {
    const resolvedTarget = await realpath(lexicalTarget);
    assertAllowedPath(resolvedTarget, [root]);
  }

  return {
    path: toWorkspacePath(relative(resolve(workspaceRoot), lexicalTarget)) || ".",
    kind: stats.isSymbolicLink()
      ? "symlink"
      : stats.isDirectory()
        ? "directory"
        : stats.isFile()
          ? "file"
          : "other",
    sizeBytes: stats.size,
    createdAt: stats.birthtime.toISOString(),
    modifiedAt: stats.mtime.toISOString(),
    accessedAt: stats.atime.toISOString(),
  };
}

function toWorkspacePath(path: string): string {
  return path.replaceAll("\\", "/");
}
