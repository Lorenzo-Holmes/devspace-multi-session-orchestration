import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { identityState, type ProcessIdentity, type ProcessObservation } from "../runtime-lifecycle/contracts.js";

const windowsHelper = fileURLToPath(new URL("../../scripts/runtime-resilience/native-process.ps1", import.meta.url));
function powershell(args: string[]): string {
  const root = process.env.SystemRoot;
  if (!root) throw new Error("Windows system directory is unavailable");
  return execFileSync(join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", windowsHelper, ...args],
    { encoding: "utf8", timeout: 8_000, maxBuffer: 65_536, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function linuxStart(pid: number): { state: string; token: string } {
  const text = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/);
  if (!/^\d+$/.test(fields[19] ?? "")) throw new Error("Invalid process birth record");
  return { state: fields[0], token: `linux:${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${fields[19]}` };
}
export function inspectProcess(pid: number): ProcessObservation {
  if (!Number.isSafeInteger(pid) || pid < 1) return { kind: "uncertain" };
  try {
    if (process.platform === "linux") {
      const first = linuxStart(pid);
      if (["Z", "X"].includes(first.state)) return { kind: "absent" };
      const executable = realpathSync(`/proc/${pid}/exe`);
      const second = linuxStart(pid);
      if (first.token !== second.token) return { kind: "uncertain" };
      return { kind: "observed", identity: { pid, processStartTime: first.token, executable } };
    }
    if (process.platform === "win32") return JSON.parse(powershell(["-Action", "inspect", "-TargetPid", String(pid)])) as ProcessObservation;
    // No PID-only or second-resolution ps fallback on unsupported platforms.
    return { kind: "uncertain" };
  } catch {
    if (process.platform === "linux") {
      try { statSync(`/proc/${pid}`); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" }; }
    }
    return { kind: "uncertain" };
  }
}
export function selfIdentity(): ProcessIdentity {
  const observation = inspectProcess(process.pid);
  if (observation.kind !== "observed") throw new Error("PROCESS_IDENTITY_UNAVAILABLE: supervised mode requires a reliable birth token");
  return observation.identity;
}
export async function portFree(port: number): Promise<"free" | "occupied" | "uncertain"> {
  return new Promise(resolve => {
    const server = createServer();
    server.once("error", error => resolve((error as NodeJS.ErrnoException).code === "EADDRINUSE" ? "occupied" : "uncertain"));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve("free")));
  });
}
export function processOwnsPort(identity: ProcessIdentity, port: number): boolean {
  if (identityState(identity, inspectProcess(identity.pid)) !== "active") return false;
  try {
    if (process.platform === "win32") {
      const result = JSON.parse(powershell(["-Action", "listener", "-TargetPid", String(identity.pid), "-ExpectedStart", identity.processStartTime,
        "-ExpectedExecutable", identity.executable, "-Port", String(port)])) as { ownsPort?: boolean };
      return result.ownsPort === true;
    }
    if (process.platform !== "linux") return false;
    const inodes = new Set<string>();
    for (const entry of readdirSync(`/proc/${identity.pid}/fd`)) {
      try { const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${identity.pid}/fd/${entry}`)); if (match) inodes.add(match[1]); } catch { /* A descriptor can close while enumerating. */ }
    }
    let match = false;
    for (const table of ["tcp", "tcp6"]) {
      const text = readFileSync(`/proc/${identity.pid}/net/${table}`, "utf8");
      for (const line of text.split("\n").slice(1)) {
        const fields = line.trim().split(/\s+/);
        if (fields[3] === "0A" && parseInt(fields[1]?.split(":")[1] ?? "", 16) === port && inodes.has(fields[9])) match = true;
      }
    }
    return match && identityState(identity, inspectProcess(identity.pid)) === "active";
  } catch { return false; }
}
const pidfdHelper = `
import json, os, signal, sys
x=json.load(sys.stdin)
try:
 fd=os.pidfd_open(x['pid'],0)
 try:
  def stamp():
   with open('/proc/%d/stat'%x['pid']) as f: t=f.read()
   fields=t[t.rfind(')')+2:].split()
   with open('/proc/sys/kernel/random/boot_id') as f: boot=f.read().strip()
   return 'linux:'+boot+':'+fields[19], os.path.realpath('/proc/%d/exe'%x['pid'])
  birth,exe=stamp()
  if birth!=x['processStartTime'] or exe!=x['executable']: print('false')
  else:
   signal.pidfd_send_signal(fd, signal.SIGKILL if x['force'] else signal.SIGTERM)
   print('true')
 finally: os.close(fd)
except (OSError, AttributeError): print('false')
`;
export function terminateVerified(identity: ProcessIdentity, force: boolean): boolean {
  if (identityState(identity, inspectProcess(identity.pid)) !== "active") return false;
  try {
    if (process.platform === "win32") {
      // Graceful stop is cooperative through the worker journal. Force uses the SAME
      // retained HANDLE for birth/executable comparison and TerminateProcess.
      if (!force) return false;
      const result = JSON.parse(powershell(["-Action", "terminate", "-TargetPid", String(identity.pid), "-ExpectedStart", identity.processStartTime,
        "-ExpectedExecutable", identity.executable])) as { terminated?: boolean };
      return result.terminated === true;
    }
    if (process.platform === "linux") return execFileSync("python3", ["-I", "-c", pidfdHelper], {
      input: JSON.stringify({ ...identity, force }), encoding: "utf8", timeout: 5_000, maxBuffer: 1024,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim() === "true";
    return false;
  } catch { return false; }
}
