import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import type { WorkspaceAccessManager } from "./workspace-access.js";
import { goalError, goalSpecSchema, type GoalApi, type GoalReply } from "./goal-contracts.js";
import { READ_TOOL_ANNOTATIONS, SHELL_TOOL_ANNOTATIONS } from "./tool-surfaces/types.js";

/** Plain-text MCP tools: Goal controls never depend on approval-widget rendering. */
export function registerGoalTools(server:McpServer,api:GoalApi,workspaces:WorkspaceRegistry,access:WorkspaceAccessManager):void {
  const goalRef=z.string().min(1).describe('Stable goalRef returned by goal_start or goal_list. Reuse across conversations.');
  const requestKey=z.string().min(1).max(256).describe('Unique key for this logical operation. Reuse this exact key after an uncertain response; never generate a second create.');
  const expectedRevision=z.number().int().positive().describe('Most recent revision from goal_status. Rejects stale controls.');
  server.registerTool('goal_start',{
    title:'Start persistent Goal',description:'Start a real native desktop Goal with durable Shrimp tasks and return its ID immediately. Works in a dedicated empty, durably authorized workspace. Continues after the web conversation disconnects. Uses the signed-in local Codex account. Refuse placeholder objectives; no extra approval is implied by starting a Goal.',
    inputSchema:{workspaceId:z.string(),...goalSpecSchema.shape,requestKey},annotations:SHELL_TOOL_ANNOTATIONS,
  },async(args,extra)=>{
    try {
      const ownerRef=principal(extra.authInfo);
      const workspace=workspaces.getWorkspace(args.workspaceId);access.assertWorkspaceModifiable(workspace);
      const authorization=await access.authorizeWorkspacePath(workspace.root,undefined,'modify');
      if(authorization.scope!=='configured'&&authorization.scope!=='permanent')throw new Error('WORKSPACE_ACCESS_REQUIRED: background Goals need a durable project authorization. Temporary chat approval is insufficient.');
      const {workspaceId:_workspaceId,requestKey,...spec}=args;
      return output(await api.goal({action:'start',ownerRef,workspaceRoot:workspace.root,requestKey,spec:goalSpecSchema.parse(spec)}));
    }catch(error){return output(goalError(error));}
  });
  server.registerTool('goal_status',{title:'Get persistent Goal status',description:'Read the real Goal, tasks, current revision, runtime connection, pending decisions and artifact checkpoints. Cached native observations are explicitly marked; artifact checks are not final user acceptance.',
    inputSchema:{goalRef},annotations:READ_TOOL_ANNOTATIONS,
  },async(args,extra)=>{
    try{return output(await api.goal({action:'status',ownerRef:principal(extra.authInfo),...args}));}catch(error){return output(goalError(error));}
  });
  server.registerTool('goal_list',{title:'List persistent Goals',description:'Recover owned Goals from a new conversation. Lists only durably authorized projects; no need to remember a temporary workspaceId.',
    inputSchema:{workspaceId:z.string().optional()},annotations:READ_TOOL_ANNOTATIONS,
  },async(args,extra)=>{
    try{return output(await api.goal({action:'list',ownerRef:principal(extra.authInfo),workspaceRoot:args.workspaceId?workspaces.getWorkspace(args.workspaceId).root:undefined}));}catch(error){return output(goalError(error));}
  });
  for(const action of ['pause','resume','stop'] as const)server.registerTool(`goal_${action}`,{
    title:`${action} persistent Goal`,description:action==='resume'
      ?'Resume the same native thread and Shrimp state after a confirmed pause. Never recreate the Goal, increase its budget, or repeat completed tasks. Conflicted or unclean ownership requires reconciliation.'
      :`Request ${action} of a managed Goal. A requested state is not acknowledgement: query goal_status until paused/stopped. Stop is terminal and preserves files/history. No UI card is needed for the control response.`,
    inputSchema:{goalRef,requestKey,expectedRevision},annotations:action==='resume'?SHELL_TOOL_ANNOTATIONS:{...SHELL_TOOL_ANNOTATIONS,destructiveHint:false,openWorldHint:false},
  },async(args,extra)=>{
    try{return output(await api.goal({action,ownerRef:principal(extra.authInfo),...args}));}catch(error){return output(goalError(error));}
  });
}
function principal(auth:unknown):string {
  const a=auth as {clientId?:string;extra?:Record<string,unknown>}|undefined;
  if(!a?.clientId||a.extra?.devspaceOwnerRef!=='single-user')throw new Error('AUTHENTICATION_REQUIRED: verified single-user OAuth identity is required.');
  return 'single-user';
}
function output(reply:GoalReply) {return {isError:!reply.ok,content:[{type:'text' as const,text:JSON.stringify(reply)}],structuredContent:reply as unknown as Record<string,unknown>};}
