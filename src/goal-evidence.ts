import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { validateTasks } from "./goal-shrimp-client.js";

export interface ArtifactEvidence { path: string; sha256: string; bytes: number }
export const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
export async function scopedArtifacts(root: string, paths: string[]): Promise<ArtifactEvidence[]> {
  if (!paths.length || paths.length > 30) throw new Error("VERIFICATION_FAILED: supply 1–30 actual artifact paths.");
  const canonicalRoot = await realpath(root);
  const result: ArtifactEvidence[] = [];
  let total = 0;
  for (const path of [...new Set(paths)]) {
    const full = resolve(root,path), rel = relative(root,full);
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.split(/[\\/]/).some(p => p === ".git" || p === "node_modules") || /[:\x00]/.test(rel)) {
      throw new Error("VERIFICATION_FAILED: artifact outside permitted project files.");
    }
    const actual = await realpath(full);
    if (actual.toLowerCase() !== join(canonicalRoot,rel).toLowerCase()) throw new Error("VERIFICATION_FAILED: artifact aliases are not allowed.");
    const info = await lstat(full);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size === 0 || info.size > 8*1024*1024) throw new Error("VERIFICATION_FAILED: non-empty regular artifacts up to 8 MB required.");
    total += info.size;
    if (total > 32*1024*1024) throw new Error("VERIFICATION_FAILED: artifact batch too large.");
    const bytes = await readFile(full);
    result.push({path:rel.split(sep).join("/"),sha256:sha256(bytes),bytes:bytes.length});
  }
  return result;
}
export async function readGoalTasks(dataDir: string) {
  const file=join(dataDir,"tasks.json"), info=await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16*1024*1024) throw new Error("TASK_STATE_CORRUPT: invalid task file.");
  const bytes=await readFile(file);
  return {tasks:validateTasks(JSON.parse(bytes.toString("utf8"))),hash:sha256(bytes)};
}
// A managed fresh project never inherits Git hooks, filters or credentials from global config.
// Existing projects are not auto-enrolled by the preview entry point.
export function projectGit(root:string,...args:string[]):string {
  return execFileSync("git",["-C",root,"-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false",
    "-c","commit.gpgsign=false","-c","core.autocrlf=false","-c","user.name=DevSpace Goal",
    "-c","user.email=goal@localhost",...args],{
    encoding:"utf8",windowsHide:true,timeout:20000,stdio:["ignore","pipe","pipe"],
    env:{...process.env,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:process.platform==="win32"?"NUL":"/dev/null"},
  }).trim();
}
