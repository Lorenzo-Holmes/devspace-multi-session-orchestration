import { lstat, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assertAllowedPath } from "./roots.js";

export interface SearchMatch {
  path: string;
  line?: number;
  text?: string;
  sizeBytes?: number;
  modifiedAt?: string;
}

export interface SearchFileMetadata {
  path: string;
  sizeBytes: number;
  modifiedAt: string;
  modifiedMs: number;
}

interface SearchOutputLine extends SearchMatch {
  isMatch: boolean;
  raw: string;
}

export function parseSearchMatches(
  searchType: "name" | "content",
  result: string,
): SearchMatch[] {
  const lines = result.split(/\r?\n/).filter(Boolean);
  if (searchType === "name") {
    return lines
      .filter((line) => !/^No files found/i.test(line))
      .map((path) => ({ path: normalizePath(path.trim()) }));
  }

  const matches: SearchMatch[] = [];
  for (const line of lines) {
    const parsed = parseContentOutputLine(line);
    if (!parsed?.isMatch) continue;
    matches.push({ path: parsed.path, line: parsed.line, text: parsed.text });
  }
  return matches;
}

export function filterSearchResultByExcludedGlobs(
  searchType: "name" | "content",
  result: string,
  excludeGlobs: readonly string[],
): string {
  if (excludeGlobs.length === 0) return result;
  return filterSearchResultByPath(searchType, result, (path) => !matchesAnyGlob(path, excludeGlobs));
}

export function filterSearchResultByExtensions(
  searchType: "name" | "content",
  result: string,
  extensions: readonly string[],
): string {
  if (extensions.length === 0) return result;
  const normalized = extensions.map((extension) => {
    const lower = extension.trim().toLowerCase();
    return lower.startsWith(".") ? lower : `.${lower}`;
  });
  return filterSearchResultByPath(
    searchType,
    result,
    (path) => normalized.some((extension) => path.toLowerCase().endsWith(extension)),
  );
}

export function filterSearchResultByPath(
  searchType: "name" | "content",
  result: string,
  keepPath: (path: string) => boolean,
): string {
  if (searchType === "name") {
    return result
      .split(/\r?\n/)
      .filter((line) => {
        const path = normalizePath(line.trim());
        return !path || /^No files found/i.test(path) || keepPath(path);
      })
      .join("\n");
  }

  return result
    .split(/\r?\n/)
    .filter((line) => {
      const parsed = parseContentOutputLine(line);
      return !parsed || keepPath(parsed.path);
    })
    .join("\n");
}

export function orderSearchResultByPaths(
  searchType: "name" | "content",
  result: string,
  orderedPaths: readonly string[],
): string {
  if (orderedPaths.length === 0) return result;
  const normalizedOrder = orderedPaths.map(normalizePath);
  if (searchType === "name") {
    const lines = new Map<string, string>();
    const extras: string[] = [];
    for (const line of result.split(/\r?\n/)) {
      if (!line) continue;
      const path = normalizePath(line.trim());
      if (/^No files found/i.test(path)) extras.push(line);
      else lines.set(path, line);
    }
    return [
      ...normalizedOrder.flatMap((path) => lines.has(path) ? [lines.get(path)!] : []),
      ...extras,
    ].join("\n");
  }

  const groups = new Map<string, string[]>();
  const extras: string[] = [];
  for (const line of result.split(/\r?\n/)) {
    if (!line) continue;
    const parsed = parseContentOutputLine(line);
    if (!parsed) {
      extras.push(line);
      continue;
    }
    const group = groups.get(parsed.path) ?? [];
    group.push(line);
    groups.set(parsed.path, group);
  }
  return [
    ...normalizedOrder.flatMap((path) => groups.get(path) ?? []),
    ...extras,
  ].join("\n");
}

export async function collectSearchFileMetadata(
  workspaceRoot: string,
  searchPath: string,
  paths: readonly string[],
): Promise<Map<string, SearchFileMetadata>> {
  const rootReal = await realpath(workspaceRoot);
  const searchTarget = assertAllowedPath(resolve(workspaceRoot, searchPath), [workspaceRoot]);
  const searchStats = await lstat(searchTarget);
  const searchBase = searchStats.isDirectory() ? searchTarget : dirname(searchTarget);
  const metadata = new Map<string, SearchFileMetadata>();

  for (const rawPath of new Set(paths.map(normalizePath))) {
    try {
      const lexicalPath = assertAllowedPath(resolve(searchBase, rawPath), [workspaceRoot]);
      const resolvedPath = await realpath(lexicalPath);
      assertAllowedPath(resolvedPath, [rootReal]);
      const stats = await lstat(resolvedPath);
      metadata.set(rawPath, {
        path: rawPath,
        sizeBytes: stats.size,
        modifiedAt: stats.mtime.toISOString(),
        modifiedMs: stats.mtimeMs,
      });
    } catch {
      // Search results can race with filesystem changes. Missing or escaped
      // targets simply have no usable metadata and are excluded by metadata
      // predicates rather than widening the workspace boundary.
    }
  }

  return metadata;
}

export function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  const normalized = normalizePath(path);
  return globs.some((glob) => globToRegExp(normalizePath(glob)).test(normalized));
}

function parseContentOutputLine(line: string): SearchOutputLine | undefined {
  const parsed = /^(.*?)([:\-])(\d+)([:\-])\s?(.*)$/.exec(line);
  if (!parsed) return undefined;
  return {
    path: normalizePath(parsed[1]),
    line: Number(parsed[3]),
    text: parsed[5],
    isMatch: parsed[2] === ":" && parsed[4] === ":",
    raw: line,
  };
}

function globToRegExp(glob: string): RegExp {
  let source = "^";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === "*") {
      const next = glob[index + 1];
      if (next === "*") {
        const after = glob[index + 2];
        index++;
        if (after === "/") {
          index++;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += /[|\\{}()[\]^$+?.]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`${source}$`);
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}
