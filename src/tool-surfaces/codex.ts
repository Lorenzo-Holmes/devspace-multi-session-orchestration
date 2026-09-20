import * as z from "zod/v4";
import { applyPatch } from "../apply-patch.js";
import type { ProcessSnapshot } from "../process-sessions.js";
import { controlWindowsDesktop, parseDesktopExecCommand } from "../windows-computer.js";
import {
  EDIT_TOOL_ANNOTATIONS,
  SHELL_TOOL_ANNOTATIONS,
  toolNames,
  workspaceIdDescription,
  type ToolRegistrationContext,
} from "./types.js";
import {
  contentText,
  resultOutputSchema,
  runLoggedToolOperation,
  textBlock,
} from "./shared.js";

type CodexRegistration = (context: ToolRegistrationContext) => void;

const CODEX_INSTRUCTIONS = `Use ${toolNames.read} for direct file reads, ${toolNames.listDirectory} for directory inspection, ${toolNames.fileInfo} for path metadata, ${toolNames.batchReadFiles} for bounded multi-file reads, ${toolNames.searchFiles} for filename/content search, and ${toolNames.querySqlite} for read-only SQLite queries. Use apply_patch for all file modifications. Reserve exec_command for tests, builds, package scripts, long-running processes, and inspection that is not covered by the native read-only tools; use write_stdin to poll or interact with running processes. Commands run with the local user's authority and are not sandboxed; workspace validation only selects their initial working directory. Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope.`;

export function codexInstructions(): string {
  return CODEX_INSTRUCTIONS;
}

export function registerCodexTools(context: ToolRegistrationContext): void {
  for (const register of CODEX_REGISTRATIONS) {
    register(context);
  }
}

const CODEX_REGISTRATIONS: readonly CodexRegistration[] = [
  registerApplyPatchTool,
  registerCodexProcessTools,
];

function processResult(snapshot: ProcessSnapshot): string {
  const status = snapshot.running
    ? `Process running with session ID ${snapshot.sessionId}.`
    : snapshot.signal
      ? `Process exited after signal ${snapshot.signal}.`
      : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
  return snapshot.output
    ? `${snapshot.output.replace(/\n$/, "")}\n${status}`
    : status;
}

function processOutputSchema(): z.ZodRawShape {
  return resultOutputSchema({
    sessionId: z.number().optional(),
    processSessionId: z.string(),
    running: z.boolean(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    cancelled: z.boolean(),
    timedOut: z.boolean(),
    wallTimeMs: z.number().nonnegative(),
    outputTruncated: z.boolean(),
  });
}

function processToolResponse(snapshot: ProcessSnapshot) {
  const result = processResult(snapshot);
  const content = [textBlock(result)];
  return {
    content,
    structuredContent: {
      result,
      sessionId: snapshot.sessionId,
      processSessionId: snapshot.processSessionId,
      running: snapshot.running,
      exitCode: snapshot.exitCode,
      signal: snapshot.signal,
      cancelled: snapshot.cancelled,
      timedOut: snapshot.timedOut,
      wallTimeMs: snapshot.wallTimeMs,
      outputTruncated: snapshot.outputTruncated,
    },
  };
}

function registerApplyPatchTool(context: ToolRegistrationContext): void {
  const { server, config, workspaces, workspaceAccess } = context;

  server.registerTool(
    "apply_patch",
    {
      title: "Apply patch",
      description:
        "Apply one Codex-style patch in a workspace. Supports adding, overwriting, updating, deleting, and moving files. Use this for all file modifications. Paths must be relative to the workspace.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        patch: z
          .string()
          .describe(
            "Patch text enclosed by *** Begin Patch and *** End Patch markers.",
          ),
      },
      outputSchema: resultOutputSchema({
        additions: z.number(),
        removals: z.number(),
        files: z.array(
          z.object({
            path: z.string(),
            previousPath: z.string().optional(),
            operation: z.enum(["add", "update", "delete", "move"]),
          }),
        ),
      }),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, patch }) => {
      const startedAt = performance.now();
      const applied = await runLoggedToolOperation(
        config,
        { tool: "apply_patch", workspaceId },
        startedAt,
        async () => {
          const workspace = workspaces.getWorkspace(workspaceId);
          workspaceAccess.assertWorkspaceModifiable(workspace);
          return applyPatch(workspace.root, patch);
        },
      );
      const paths = applied.files.map((file) => file.path).join(", ");
      const result = `Applied patch to ${applied.files.length} file(s): ${paths}`;
      const content = [textBlock(result)];

      return {
        content,
        structuredContent: {
          result,
          additions: applied.additions,
          removals: applied.removals,
          files: applied.files,
        },
      };
    },
  );
}

function registerCodexProcessTools(context: ToolRegistrationContext): void {
  const { server, config, workspaces, processSessions, workspaceAccess } = context;

  server.registerTool(
    "exec_command",
    {
      title: "Execute command",
      description:
        "Run a command with the local user's authority. Commands are not sandboxed; workspace validation only selects the initial working directory. Returns the result when it exits during the yield window, otherwise returns a sessionId for write_stdin. Prefer native read-only filesystem/search/SQLite tools for routine inspection; use this for tests, builds, package scripts, long-running processes, and inspection those tools cannot express.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        cmd: z.string().min(1).describe("Shell command to execute."),
        tty: z
          .boolean()
          .optional()
          .describe(
            "Allocate a pseudo-terminal for interactive commands. Defaults to false.",
          ),
        columns: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Initial PTY width. Defaults to 80."),
        rows: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Initial PTY height. Defaults to 24."),
        workingDirectory: z
          .string()
          .optional()
          .describe(
            "Working directory relative to the workspace root. Defaults to the workspace root.",
          ),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional()
          .describe(
            "Milliseconds to wait before returning a running session. Defaults to 10000.",
          ),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(86_400_000)
          .optional()
          .describe("Optional hard timeout in milliseconds. A timeout terminates the process and can never count as successful validation."),
      },
      outputSchema: processOutputSchema(),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({
      workspaceId,
      cmd,
      tty,
      columns,
      rows,
      workingDirectory,
      yieldTimeMs,
      maxOutputTokens,
      timeoutMs,
    }) => {
      const startedAt = performance.now();
      const desktopCommand = config.computerUseEnabled && process.platform === "win32"
        ? parseDesktopExecCommand(cmd)
        : null;
      if (desktopCommand) {
        const controlled = await runLoggedToolOperation(
          config,
          {
            tool: "exec_command",
            workspaceId,
            workingDirectory: workingDirectory ?? ".",
            command: "@computer",
            commandLength: cmd.length,
          },
          startedAt,
          () => controlWindowsDesktop(
            config,
            workspaces,
            workspaceAccess,
            workspaceId,
            desktopCommand.snapshotId,
            desktopCommand.action,
          ),
        );
        return {
          content: [textBlock(controlled.result)],
          structuredContent: {
            result: controlled.result,
            processSessionId: "desktop-control",
            running: false,
            exitCode: 0,
            cancelled: false,
            timedOut: false,
            wallTimeMs: Math.round(performance.now() - startedAt),
            outputTruncated: false,
          },
        };
      }
      const snapshot = await runLoggedToolOperation(
        config,
        {
          tool: "exec_command",
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          command: cmd,
          commandLength: cmd.length,
        },
        startedAt,
        async () => {
          const workspace = workspaces.getWorkspace(workspaceId);
          workspaceAccess.assertWorkspaceModifiable(workspace);
          const cwd = workspaces.resolveWorkingDirectory(
            workspace,
            workingDirectory,
          );
          return processSessions.start({
            workspaceId,
            command: cmd,
            cwd,
            workspaceRoot: workspace.root,
            tty,
            columns,
            rows,
            yieldTimeMs,
            maxOutputTokens,
            timeoutMs,
          });
        },
      );

      return processToolResponse(snapshot);
    },
  );

  server.registerTool(
    "write_stdin",
    {
      title: "Write to process",
      description:
        "Poll or write characters to a process returned by exec_command. Omit chars or pass an empty string to poll. Pass \\u0003 to send Ctrl-C.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier used to start the process."),
        sessionId: z
          .number()
          .describe("Process session identifier returned by exec_command."),
        chars: z
          .string()
          .optional()
          .describe(
            "Characters to write. Omit or pass an empty string to poll.",
          ),
        columns: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Resize a PTY to this width."),
        rows: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Resize a PTY to this height."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional()
          .describe(
            "Milliseconds to wait for process output or completion. Defaults to 10000.",
          ),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({
      workspaceId,
      sessionId,
      chars,
      columns,
      rows,
      yieldTimeMs,
      maxOutputTokens,
    }) => {
      const startedAt = performance.now();
      const snapshot = await runLoggedToolOperation(
        config,
        { tool: "write_stdin", workspaceId },
        startedAt,
        async () => {
          const workspace = workspaces.getWorkspace(workspaceId);
          workspaceAccess.assertWorkspaceModifiable(workspace);
          return processSessions.write({
            workspaceId,
            sessionId,
            chars,
            columns,
            rows,
            yieldTimeMs,
            maxOutputTokens,
          });
        },
      );

      return processToolResponse(snapshot);
    },
  );
}
