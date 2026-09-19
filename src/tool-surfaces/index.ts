import type { ToolMode } from "../config.js";
import { codexInstructions, registerCodexTools } from "./codex.js";
import { claudeInstructions, registerClaudeTools } from "./claude.js";
import { CONTROL_PLANE_GUIDANCE } from "./control-plane-guidance.js";
import { type ToolSurface } from "./types.js";

const TOOL_SURFACES: Record<ToolMode, ToolSurface> = {
  claude: {
    register: registerClaudeTools,
    instructions: context => `${claudeInstructions(context)}\n\n${CONTROL_PLANE_GUIDANCE}`,
  },
  codex: {
    register: registerCodexTools,
    instructions: context => `${codexInstructions(context)}\n\n${CONTROL_PLANE_GUIDANCE}`,
  },
};

export function getToolSurface(mode: ToolMode): ToolSurface {
  return TOOL_SURFACES[mode];
}
