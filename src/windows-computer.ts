import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import type { WorkspaceAccessManager } from "./workspace-access.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import { logToolCall } from "./tool-surfaces/shared.js";
import { READ_TOOL_ANNOTATIONS, WRITE_TOOL_ANNOTATIONS, workspaceIdDescription } from "./tool-surfaces/types.js";

const execFileAsync = promisify(execFile);
const SNAPSHOT_TTL_MS = 30_000;
const MAX_WINDOWS = 50;

type Snapshot = {
  id: string;
  createdAt: number;
  screenLeft: number;
  screenTop: number;
  screenWidth: number;
  screenHeight: number;
  imageWidth: number;
  imageHeight: number;
};

const snapshots = new Map<string, Snapshot>();

const OBSERVE_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DevSpaceDesktopNative {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
}
"@
$bounds=[System.Windows.Forms.SystemInformation]::VirtualScreen
$source=New-Object System.Drawing.Bitmap($bounds.Width,$bounds.Height,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g=[System.Drawing.Graphics]::FromImage($source)
$g.CopyFromScreen($bounds.Left,$bounds.Top,0,0,$source.Size,[System.Drawing.CopyPixelOperation]::SourceCopy)
$maxW=1600; $maxH=1200
$scale=[Math]::Min(1.0,[Math]::Min($maxW/[double]$bounds.Width,$maxH/[double]$bounds.Height))
$w=[Math]::Max(1,[int][Math]::Round($bounds.Width*$scale)); $h=[Math]::Max(1,[int][Math]::Round($bounds.Height*$scale))
$image=New-Object System.Drawing.Bitmap($w,$h,[System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$ig=[System.Drawing.Graphics]::FromImage($image)
$ig.DrawImage($source,0,0,$w,$h)
$ms=New-Object System.IO.MemoryStream
$image.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png)
$png=[Convert]::ToBase64String($ms.ToArray())
$p=New-Object DevSpaceDesktopNative+POINT
[void][DevSpaceDesktopNative]::GetCursorPos([ref]$p)
$fg=[DevSpaceDesktopNative]::GetForegroundWindow(); $sb=New-Object System.Text.StringBuilder 1024
[void][DevSpaceDesktopNative]::GetWindowText($fg,$sb,$sb.Capacity)
$windows=@(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Select-Object -First ${MAX_WINDOWS} @{N='pid';E={$_.Id}},@{N='process';E={$_.ProcessName}},@{N='title';E={$_.MainWindowTitle}})
$result=[ordered]@{left=$bounds.Left;top=$bounds.Top;width=$bounds.Width;height=$bounds.Height;imageWidth=$w;imageHeight=$h;mouseX=$p.X;mouseY=$p.Y;activeWindow=$sb.ToString();windows=$windows;png=$png}
$ig.Dispose(); $image.Dispose(); $g.Dispose(); $source.Dispose(); $ms.Dispose()
$result | ConvertTo-Json -Compress -Depth 5
`;

const CONTROL_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
$payload=$env:DEVSPACE_DESKTOP_PAYLOAD | ConvertFrom-Json
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DevSpaceDesktopControl {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extraInfo);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint nInputs, INPUT[] inputs, int cbSize);
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  public static void UnicodeText(string text) {
    foreach (char ch in text) {
      INPUT down=new INPUT(); down.type=1; down.U.ki.wScan=ch; down.U.ki.dwFlags=0x0004;
      INPUT up=down; up.U.ki.dwFlags=0x0004|0x0002;
      INPUT[] pair=new INPUT[]{down,up}; SendInput(2,pair,Marshal.SizeOf(typeof(INPUT)));
    }
  }
}
"@
$LEFTDOWN=0x0002; $LEFTUP=0x0004; $RIGHTDOWN=0x0008; $RIGHTUP=0x0010; $WHEEL=0x0800; $KEYUP=0x0002
function Click([int]$x,[int]$y,[bool]$right=$false){ [void][DevSpaceDesktopControl]::SetCursorPos($x,$y); Start-Sleep -Milliseconds 35; if($right){[DevSpaceDesktopControl]::mouse_event($RIGHTDOWN,0,0,0,[UIntPtr]::Zero);[DevSpaceDesktopControl]::mouse_event($RIGHTUP,0,0,0,[UIntPtr]::Zero)}else{[DevSpaceDesktopControl]::mouse_event($LEFTDOWN,0,0,0,[UIntPtr]::Zero);[DevSpaceDesktopControl]::mouse_event($LEFTUP,0,0,0,[UIntPtr]::Zero)} }
$vk=@{CTRL=0x11;SHIFT=0x10;ALT=0x12;WIN=0x5B;ENTER=0x0D;TAB=0x09;ESCAPE=0x1B;BACKSPACE=0x08;DELETE=0x2E;HOME=0x24;END=0x23;PAGEUP=0x21;PAGEDOWN=0x22;ARROWLEFT=0x25;ARROWUP=0x26;ARROWRIGHT=0x27;ARROWDOWN=0x28;SPACE=0x20;F1=0x70;F2=0x71;F3=0x72;F4=0x73;F5=0x74;F6=0x75;F7=0x76;F8=0x77;F9=0x78;F10=0x79;F11=0x7A;F12=0x7B}
foreach($c in [char[]]'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'){ $vk[[string]$c]=[byte][int]$c }
switch($payload.action){
  'move' { [void][DevSpaceDesktopControl]::SetCursorPos([int]$payload.x,[int]$payload.y) }
  'click' { Click ([int]$payload.x) ([int]$payload.y) $false }
  'double_click' { Click ([int]$payload.x) ([int]$payload.y) $false; Start-Sleep -Milliseconds 80; Click ([int]$payload.x) ([int]$payload.y) $false }
  'right_click' { Click ([int]$payload.x) ([int]$payload.y) $true }
  'scroll' { [void][DevSpaceDesktopControl]::SetCursorPos([int]$payload.x,[int]$payload.y); [DevSpaceDesktopControl]::mouse_event($WHEEL,0,0,[int]$payload.delta,[UIntPtr]::Zero) }
  'drag' { [void][DevSpaceDesktopControl]::SetCursorPos([int]$payload.x,[int]$payload.y); [DevSpaceDesktopControl]::mouse_event($LEFTDOWN,0,0,0,[UIntPtr]::Zero); for($i=1;$i -le 12;$i++){ $nx=[int]($payload.x+(($payload.x2-$payload.x)*$i/12)); $ny=[int]($payload.y+(($payload.y2-$payload.y)*$i/12)); [void][DevSpaceDesktopControl]::SetCursorPos($nx,$ny); Start-Sleep -Milliseconds 15 }; [DevSpaceDesktopControl]::mouse_event($LEFTUP,0,0,0,[UIntPtr]::Zero) }
  'type_text' { [DevSpaceDesktopControl]::UnicodeText([string]$payload.text) }
  'keypress' { $keys=@($payload.keys); foreach($key in $keys){$name=([string]$key).ToUpperInvariant(); if(-not $vk.ContainsKey($name)){throw "Unsupported key: $name"}; [DevSpaceDesktopControl]::keybd_event([byte]$vk[$name],0,0,[UIntPtr]::Zero)}; [Array]::Reverse($keys); foreach($key in $keys){$name=([string]$key).ToUpperInvariant(); [DevSpaceDesktopControl]::keybd_event([byte]$vk[$name],0,$KEYUP,[UIntPtr]::Zero)} }
  default { throw "Unsupported desktop action" }
}
[ordered]@{ok=$true;action=[string]$payload.action} | ConvertTo-Json -Compress
`;

const keySchema = z.enum([
  "CTRL", "SHIFT", "ALT", "WIN", "ENTER", "TAB", "ESCAPE", "BACKSPACE", "DELETE", "HOME", "END",
  "PAGEUP", "PAGEDOWN", "ARROWLEFT", "ARROWUP", "ARROWRIGHT", "ARROWDOWN", "SPACE",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
  "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
]);

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("move"), x: z.number().nonnegative(), y: z.number().nonnegative() }),
  z.object({ action: z.literal("click"), x: z.number().nonnegative(), y: z.number().nonnegative() }),
  z.object({ action: z.literal("double_click"), x: z.number().nonnegative(), y: z.number().nonnegative() }),
  z.object({ action: z.literal("right_click"), x: z.number().nonnegative(), y: z.number().nonnegative() }),
  z.object({ action: z.literal("scroll"), x: z.number().nonnegative(), y: z.number().nonnegative(), delta: z.number().int().min(-1200).max(1200) }),
  z.object({ action: z.literal("drag"), x: z.number().nonnegative(), y: z.number().nonnegative(), x2: z.number().nonnegative(), y2: z.number().nonnegative() }),
  z.object({ action: z.literal("type_text"), text: z.string().max(4000) }),
  z.object({ action: z.literal("keypress"), keys: z.array(keySchema).min(1).max(4) }),
]);

type DesktopAction = z.infer<typeof actionSchema>;

export type WindowsDesktopObservation = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: "image/png" }
  >;
  structuredContent: {
    snapshotId: string;
    imageWidth: number;
    imageHeight: number;
    screenWidth: number;
    screenHeight: number;
    activeWindow: string;
    windowsJson: string;
    result: string;
  };
};

export type WindowsDesktopControlResult = {
  result: string;
  action: string;
};

async function runPowerShell(script: string, payload?: unknown): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const env = { ...process.env };
  if (payload !== undefined) env.DEVSPACE_DESKTOP_PAYLOAD = JSON.stringify(payload);
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    { env, windowsHide: true, maxBuffer: 25 * 1024 * 1024, timeout: 20_000 },
  );
  return stdout.trim();
}

function pruneSnapshots(now = Date.now()): void {
  for (const [id, snapshot] of snapshots) if (now - snapshot.createdAt > SNAPSHOT_TTL_MS) snapshots.delete(id);
}

function mapPoint(snapshot: Snapshot, x: number, y: number): { x: number; y: number } {
  if (x > snapshot.imageWidth || y > snapshot.imageHeight) {
    throw new Error(`Coordinates are outside snapshot ${snapshot.imageWidth}x${snapshot.imageHeight}.`);
  }
  return {
    x: snapshot.screenLeft + Math.round((x / snapshot.imageWidth) * snapshot.screenWidth),
    y: snapshot.screenTop + Math.round((y / snapshot.imageHeight) * snapshot.screenHeight),
  };
}

function mapAction(snapshot: Snapshot, action: DesktopAction): Record<string, unknown> {
  if ("x" in action && "y" in action) {
    const first = mapPoint(snapshot, action.x, action.y);
    if (action.action === "drag") {
      const second = mapPoint(snapshot, action.x2, action.y2);
      return { ...action, x: first.x, y: first.y, x2: second.x, y2: second.y };
    }
    return { ...action, x: first.x, y: first.y };
  }
  return action;
}

export async function observeWindowsDesktop(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  workspaceAccess: WorkspaceAccessManager,
  workspaceId: string,
): Promise<WindowsDesktopObservation> {
  if (!config.computerUseEnabled || process.platform !== "win32") {
    throw new Error("Windows desktop observation is not enabled on this DevSpace server.");
  }
  const workspace = workspaces.getWorkspace(workspaceId);
  workspaceAccess.assertWorkspaceReadable(workspace);
  const raw = JSON.parse(await runPowerShell(OBSERVE_SCRIPT)) as {
    left: number; top: number; width: number; height: number; imageWidth: number; imageHeight: number;
    mouseX: number; mouseY: number; activeWindow: string; windows: unknown[]; png: string;
  };
  pruneSnapshots();
  const snapshotId = randomUUID();
  snapshots.set(snapshotId, {
    id: snapshotId, createdAt: Date.now(), screenLeft: raw.left, screenTop: raw.top,
    screenWidth: raw.width, screenHeight: raw.height, imageWidth: raw.imageWidth, imageHeight: raw.imageHeight,
  });
  const windowsJson = JSON.stringify(raw.windows ?? []);
  const result = `Snapshot ${snapshotId}: ${raw.imageWidth}x${raw.imageHeight} image of ${raw.width}x${raw.height} virtual desktop. Active window: ${raw.activeWindow || "(none)"}. Pointer: (${raw.mouseX}, ${raw.mouseY}) screen coordinates.`;
  return {
    content: [
      { type: "text" as const, text: `${result}\nWindows: ${windowsJson}` },
      { type: "image" as const, data: raw.png, mimeType: "image/png" },
    ],
    structuredContent: {
      snapshotId,
      imageWidth: raw.imageWidth,
      imageHeight: raw.imageHeight,
      screenWidth: raw.width,
      screenHeight: raw.height,
      activeWindow: raw.activeWindow ?? "",
      windowsJson,
      result,
    },
  };
}

export async function controlWindowsDesktop(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  workspaceAccess: WorkspaceAccessManager,
  workspaceId: string,
  snapshotId: string,
  action: unknown,
): Promise<WindowsDesktopControlResult> {
  if (!config.computerUseEnabled || process.platform !== "win32") {
    throw new Error("Windows desktop control is not enabled on this DevSpace server.");
  }
  const workspace = workspaces.getWorkspace(workspaceId);
  workspaceAccess.assertWorkspaceModifiable(workspace);
  pruneSnapshots();
  const snapshot = snapshots.get(snapshotId);
  if (!snapshot) throw new Error("Snapshot is missing or expired. Call observe again before controlling the desktop.");
  const parsed = actionSchema.parse(action);
  const mapped = mapAction(snapshot, parsed);
  await runPowerShell(CONTROL_SCRIPT, mapped);
  snapshots.delete(snapshotId);
  return {
    result: `${parsed.action} completed. This snapshotId is now consumed; call observe again before another desktop action.`,
    action: parsed.action,
  };
}

export function parseDesktopExecCommand(cmd: string): { snapshotId: string; action: unknown } | null {
  const prefix = "@computer ";
  if (!cmd.startsWith(prefix)) return null;
  const payload = JSON.parse(cmd.slice(prefix.length)) as unknown;
  const parsed = z.object({ snapshotId: z.string().uuid(), action: actionSchema }).parse(payload);
  return parsed;
}

export function registerWindowsComputerTools(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  workspaceAccess: WorkspaceAccessManager,
): void {
  if (!config.computerUseEnabled || process.platform !== "win32") return;

  server.registerTool("observe", {
    title: "Observe Windows desktop",
    description: "Capture the current Windows virtual desktop for visual inspection. Returns a scaled PNG, window titles, active window, pointer position and a short-lived snapshotId. Call this before computer and again after meaningful UI changes.",
    inputSchema: { workspaceId: z.string().describe(workspaceIdDescription) },
    outputSchema: {
      snapshotId: z.string(), imageWidth: z.number().int(), imageHeight: z.number().int(),
      screenWidth: z.number().int(), screenHeight: z.number().int(), activeWindow: z.string(), windowsJson: z.string(), result: z.string(),
    },
    annotations: READ_TOOL_ANNOTATIONS,
  }, async ({ workspaceId }) => {
    const startedAt = performance.now();
    const observed = await observeWindowsDesktop(config, workspaces, workspaceAccess, workspaceId);
    logToolCall(config, { tool: "observe", workspaceId, success: true, durationMs: Math.round(performance.now() - startedAt) });
    return observed;
  });

  server.registerTool("computer", {
    title: "Control Windows desktop",
    description: "Control the Windows desktop using a fresh snapshotId from observe. The workspace is an authority context only; desktop actions are not contained by the workspace directory. Coordinates are pixels in the observe image, not raw screen coordinates. Supports move, click, double_click, right_click, scroll, drag, Unicode type_text and bounded keypress chords.",
    inputSchema: {
      workspaceId: z.string().describe(workspaceIdDescription),
      snapshotId: z.string().uuid().describe("Fresh snapshotId returned by observe; expires after 30 seconds."),
      action: actionSchema,
    },
    outputSchema: { result: z.string(), action: z.string() },
    annotations: WRITE_TOOL_ANNOTATIONS,
  }, async ({ workspaceId, snapshotId, action }) => {
    const startedAt = performance.now();
    const controlled = await controlWindowsDesktop(config, workspaces, workspaceAccess, workspaceId, snapshotId, action);
    logToolCall(config, { tool: "computer", workspaceId, success: true, durationMs: Math.round(performance.now() - startedAt) });
    return { content: [{ type: "text" as const, text: controlled.result }], structuredContent: controlled };
  });
}
