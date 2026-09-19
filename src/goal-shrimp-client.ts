import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { open, readFile, realpath, lstat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { z } from "zod";

const safeName = z.string().min(1).max(100).refine(v => !/["`&|<>^%!\r\n]/.test(v), "Unsafe upstream Git metadata");
const taskSchema = z.object({
  id: z.string().uuid(), name: safeName, description: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "blocked"]),
  dependencies: z.array(z.object({ taskId: z.string().uuid() })),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  summary: z.string().optional(), completedAt: z.string().optional(),
}).passthrough();
export type ShrimpTask = z.infer<typeof taskSchema>;
export function validateTasks(value: unknown): ShrimpTask[] {
  const { tasks } = z.object({ tasks: z.array(taskSchema).max(10000) }).parse(value);
  const map = new Map(tasks.map(task => [task.id, task]));
  if (map.size !== tasks.length) throw new Error("TASK_STATE_CORRUPT: duplicate task IDs.");
  const visited = new Set<string>();
  const visiting = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error("DEPENDENCY_INVALID: cycle.");
    if (visited.has(id)) return;
    const task = map.get(id);
    if (!task) throw new Error("DEPENDENCY_INVALID: missing task.");
    visiting.add(id);
    for (const dependency of task.dependencies) visit(dependency.taskId);
    visiting.delete(id); visited.add(id);
  }
  for (const task of tasks) visit(task.id);
  return tasks;
}
export function nextShrimpTask(tasks: ShrimpTask[]): ShrimpTask | null {
  const running = tasks.filter(t => t.status === "in_progress");
  if (running.length > 1) throw new Error("RECONCILIATION_REQUIRED: multiple in-progress tasks.");
  const ready = (t: ShrimpTask) => t.dependencies.every(d => tasks.some(p => p.id === d.taskId && p.status === "completed"));
  if (running.length) {
    if (!ready(running[0])) throw new Error("DEPENDENCY_INVALID: running task has unfinished dependencies.");
    return running[0];
  }
  const candidates = tasks.filter(t => t.status === "pending" && ready(t));
  candidates.sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  if (candidates[0]) return candidates[0];
  if (tasks.some(t => t.status !== "completed")) throw new Error("DEPENDENCY_INVALID: unfinished tasks have no executable successor.");
  return null;
}
export interface ShrimpClientOptions {
  command: string;
  entryPoint: string;
  workspaceRoot: string;
  dataDir: string;
  /** Authenticated manager supplies this; model arguments never choose data roots. */
  allowedDataRoot: string;
  initializeEmpty?: boolean;
  env?: Record<string, string>;
  /** Required for verify_task. Must execute independent, scoped checks before returning. */
  verifyEvidence?: (task: ShrimpTask) => Promise<void>;
  /** Recheck manager revision/epoch/permissions, including after a slow verifier. */
  authorizeWrite?: () => Promise<void>;
}
const allowed = new Set(["list_tasks", "get_task_detail", "query_task", "split_tasks", "execute_task", "verify_task"]);
const writers = new Set(["split_tasks", "execute_task", "verify_task"]);

/** Official SDK client, one owned stdio server, serial calls; never a network bridge. */
export class GoalShrimpClient {
  private readonly client = new Client({ name: "devspace-goal", version: "1.0.0" }, { capabilities: { roots: { listChanged: false } } });
  private readonly validator = new AjvJsonSchemaValidator();
  private transport?: StdioClientTransport;
  private tools: Tool[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private closing = false;
  private initialized = false;
  private observedHash?: string;
  private lockPath?: string;
  private readonly owner = randomUUID();
  private broken = false;
  constructor(private readonly options: ShrimpClientOptions) {}

  async connect(): Promise<void> {
    const o = this.options;
    if (![o.dataDir, o.allowedDataRoot, o.workspaceRoot, o.entryPoint, o.command].every(isAbsolute)) throw new Error("Absolute scoped paths required.");
    if (/["`&|<>^%!\r\n]/.test(o.dataDir)) throw new Error("Unsafe upstream DATA_DIR path.");
    const root = await realpath(o.allowedDataRoot);
    const data = await realpath(o.dataDir);
    const rel = relative(root, data);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("DATA_DIR must be a dedicated child of the authorized data root.");
    if (data.toLowerCase() !== resolve(o.dataDir).toLowerCase()) throw new Error("DATA_DIR aliases are not allowed.");
    this.lockPath = join(dirname(data), `.${data.split(sep).at(-1)}.devspace-writer.lock`);
    const lock = await open(this.lockPath, "wx").catch(() => { throw new Error("GOAL_BUSY: existing writer lock; reconcile ownership before retrying."); });
    await lock.writeFile(JSON.stringify({ owner: this.owner, pid: process.pid, createdAt: new Date().toISOString() }));
    await lock.close();
    try {
      try { await this.readState(); this.initialized = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !o.initializeEmpty) throw error;
        // Fresh initialization is explicit and only allowed for an actually empty directory.
        const { readdir } = await import("node:fs/promises");
        if ((await readdir(data)).length) throw new Error("TASK_STATE_CORRUPT: missing tasks.json in a non-empty directory.");
      }
      this.client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(await realpath(o.workspaceRoot)).href, name: "Authorized Goal workspace" }] }));
      this.transport = new StdioClientTransport({ command: o.command, args: [o.entryPoint], cwd: o.workspaceRoot,
        env: { ...o.env, DATA_DIR: data, ENABLE_GUI: "false" }, stderr: "pipe" });
      // Consume bounded diagnostics; callers receive classified errors, never raw environment data.
      this.transport.stderr?.on("data", () => {});
      await this.client.connect(this.transport);
      this.transport.stderr?.on("data", () => {});
      this.tools = (await this.client.listTools()).tools.filter(tool => allowed.has(tool.name));
      if (!this.tools.some(t => t.name === "list_tasks")) throw new Error("GOAL_CAPABILITY_UNAVAILABLE: Shrimp tool missing.");
    } catch (error) { await this.client.close().catch(() => {}); await this.releaseLock(); throw error; }
  }
  listTools(): Tool[] { return structuredClone(this.tools); }
  call(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.closing || this.broken) return Promise.reject(new Error("Shrimp client is closed or requires reconciliation."));
    const operation = this.tail.then(() => this.perform(name, args));
    this.tail = operation.catch(() => {});
    return operation;
  }
  async snapshot(): Promise<{ tasks: ShrimpTask[]; hash: string; commit: string | null }> {
    await this.tail;
    return this.readState();
  }
  private async readState() {
    const path = join(this.options.dataDir, "tasks.json");
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("TASK_STATE_CORRUPT: task file must be a regular, unaliased file.");
    if (info.size > 16 * 1024 * 1024) throw new Error("TASK_STATE_CORRUPT: file too large.");
    const raw = await readFile(path, "utf8");
    const tasks = validateTasks(JSON.parse(raw));
    const hash = createHash("sha256").update(raw).digest("hex");
    if (this.observedHash && this.observedHash !== hash) throw new Error("RECONCILIATION_REQUIRED: task state changed outside this writer.");
    let commit: string | null = null;
    try { commit = execFileSync("git", ["-C", this.options.dataDir, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true, stdio: ["ignore","pipe","pipe"] }).trim(); } catch { /* Empty state has no commit yet. */ }
    this.observedHash = hash;
    return { tasks, hash, commit };
  }
  private async perform(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.broken) throw new Error("RECONCILIATION_REQUIRED: writer is fenced.");
    const tool = this.tools.find(t => t.name === name);
    if (!tool) throw new Error("Unsupported managed task tool.");
    if (writers.has(name)) await this.options.authorizeWrite?.();
    const validated = this.validator.getValidator(tool.inputSchema)(args);
    if (!validated.valid) throw new Error("Invalid Shrimp arguments.");
    const before = this.initialized ? await this.readState() : null;
    if (name === "split_tasks") {
      if (args.updateMode !== "append") throw new Error("Only append is supported; destructive replanning is disabled.");
      const taskInput = JSON.parse(String(args.tasksRaw));
      const inputs = z.array(z.object({ name: safeName, description: z.string().min(10), implementationGuide: z.string(), dependencies: z.array(z.string()).optional(), relatedFiles: z.array(z.object({ path: z.string() }).passthrough()).optional() }).passthrough()).min(1).parse(taskInput);
      const names = new Set(before?.tasks.map(t => t.name) ?? []);
      for (const input of inputs) { if (names.has(input.name)) throw new Error("Duplicate task name."); names.add(input.name); }
      // Verify named dependency graph before upstream can silently discard unknown names.
      const ids = new Set(before?.tasks.map(t => t.id) ?? []);
      for (const input of inputs) {
        for (const dep of input.dependencies ?? []) if (!names.has(dep) && !ids.has(dep)) throw new Error("DEPENDENCY_INVALID: unknown dependency.");
        for (const file of input.relatedFiles ?? []) {
          const rel = relative(this.options.workspaceRoot, resolve(this.options.workspaceRoot, file.path));
          if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Related file escapes authorized workspace.");
        }
      }
      const graph = new Map(inputs.map(t => [t.name, t.dependencies ?? []]));
      const active = new Set<string>(), done = new Set<string>();
      const visit = (n: string): void => { if (active.has(n)) throw new Error("DEPENDENCY_INVALID: cycle."); if (done.has(n)) return; active.add(n); for (const d of graph.get(n) ?? []) visit(d); active.delete(n); done.add(n); };
      for (const n of graph.keys()) visit(n);
    }
    if (name === "execute_task" || name === "verify_task") {
      const task = before?.tasks.find(t => t.id === args.taskId);
      if (!task || task.status === "completed") throw new Error("Task is missing or already completed; do not repeat it.");
      if (nextShrimpTask(before!.tasks)?.id !== task.id) throw new Error("DEPENDENCY_INVALID: this is not the next executable task.");
      if (name === "verify_task") {
        if (task.status !== "in_progress" || !this.options.verifyEvidence) throw new Error("VERIFICATION_FAILED: independent evidence verifier required.");
        await this.options.verifyEvidence(task);
      }
    }
    try {
      if (writers.has(name)) await this.options.authorizeWrite?.();
      const result = await this.client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
      if (result.isError) throw new Error("Shrimp reported a tool error.");
      if (writers.has(name) || !this.initialized) {
        this.observedHash = undefined;
        const after = await this.readState();
        this.initialized = true;
        for (const completed of before?.tasks.filter(t => t.status === "completed") ?? []) {
          if (JSON.stringify(after.tasks.find(t => t.id === completed.id)) !== JSON.stringify(completed)) throw new Error("TASK_STATE_CORRUPT: completed history changed.");
        }
        if (writers.has(name)) {
          if (!after.commit) throw new Error("RECONCILIATION_REQUIRED: missing task checkpoint.");
          const committed = execFileSync("git", ["-C", this.options.dataDir, "show", "HEAD:tasks.json"], { encoding: "utf8", windowsHide: true, stdio: ["ignore","pipe","pipe"] });
          if (createHash("sha256").update(committed).digest("hex") !== after.hash) throw new Error("RECONCILIATION_REQUIRED: task state not committed.");
        }
      }
      return result;
    } catch (error) {
      if (writers.has(name)) this.broken = true; // Unknown write outcome must not be retried blindly.
      throw error;
    }
  }
  private async releaseLock(): Promise<void> {
    if (!this.lockPath) return;
    const content = JSON.parse(await readFile(this.lockPath, "utf8"));
    if (content.owner !== this.owner) throw new Error("Writer ownership changed; lock retained.");
    await unlink(this.lockPath); this.lockPath = undefined;
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.tail;
    await this.client.close();
    await this.releaseLock();
  }
}
