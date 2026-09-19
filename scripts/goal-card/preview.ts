// Visual fixture only. No MCP network server, Goal database, credentials,
// filesystem tools, or model calls are available to this simulated host.
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
const scenario=new URLSearchParams(location.search).get("scenario")??"decision";
const kind=scenario==="connection"?"connection":"decision",id=crypto.randomUUID();
const snapshot:Record<string,unknown>={cardId:id,kind,revision:1,serverNow:Date.now(),expiresAt:Date.now()+600000,
  goalRef:kind==="decision"?"LOCAL-VISUAL-FIXTURE":null,decisionId:kind==="decision"?crypto.randomUUID():null,
  question:kind==="decision"?"后续说明文档采用哪一种语言？":"正在核对卡片返回通道，无需点击。",choices:kind==="decision"?["中文","English"]:[],
  acknowledged:false,canSubmit:kind==="decision",waitStarted:kind==="decision",waitActive:kind==="decision",waitDeadlineAt:kind==="decision"?Date.now()+45000:null,
  waitOutcome:null,state:"pending",answer:null,receiptPhase:null};
if(scenario==="timeout")Object.assign(snapshot,{canSubmit:false,waitActive:false,waitOutcome:"timeout",state:"closed"});
const shown={content:[{type:"text" as const,text:"Local visual fixture only"}],structuredContent:{ok:true,data:snapshot},_meta:{goalCard:{cardId:id,kind,submitToken:"0".repeat(64)}}};
const frame=document.querySelector("iframe")!,summary=document.getElementById("summary")!;
const bridge=new AppBridge(null,{name:"LOCAL FIXTURE, NOT CHATGPT",version:"1"},{serverTools:{}},{hostContext:{theme:"light"}});
let initialized!:()=>void;const ready=new Promise<void>(resolve=>{initialized=resolve;});
bridge.oninitialized=()=>initialized();
bridge.oncalltool=async params=>{
  if(params.arguments?.cardId!==id||params.arguments?.submitToken!=="0".repeat(64))throw new Error("FIXTURE_CARD_MISMATCH");
  if(!["chat_goal_card_status","chat_goal_card_submit"].includes(params.name))throw new Error("FIXTURE_TOOL_DENIED");
  if(params.name==="chat_goal_card_submit"){
    if(scenario==="error")throw new Error("模拟提交失败，真实目标未受影响。");
    Object.assign(snapshot,{answer:params.arguments.answer??null,waitActive:false,canSubmit:false,state:"answered",waitOutcome:"answer_received",receiptPhase:"during_wait"});
    summary.textContent="LOCAL FIXTURE: card selection received; not a real Goal or Chat acceptance.";
  }else{snapshot.acknowledged=true;if(kind==="connection")snapshot.waitOutcome="channel_ready";}
  snapshot.revision=Number(snapshot.revision)+1;snapshot.serverNow=Date.now();
  return {content:[],structuredContent:{ok:true,data:{...snapshot}}};
};
await bridge.connect(new PostMessageTransport(frame.contentWindow!,frame.contentWindow!));
frame.srcdoc=await(await fetch("/card.html")).text();
await ready;await bridge.sendToolResult(shown);
window.addEventListener("pagehide",()=>void bridge.close());
