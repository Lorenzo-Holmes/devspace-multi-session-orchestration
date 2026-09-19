import { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const app=new App({name:"DevSpace Computer Use approval",version:"1.0.0"});
const el=(id:string)=>document.getElementById(id)!;
const allow=el("allow") as HTMLButtonElement,deny=el("deny") as HTMLButtonElement;
let card:{approvalId:string;submitToken:string}|undefined;
let snapshot:Record<string,any>|undefined,busy=false,attempted=false,stopped=false;
let receivedAt=Date.now(),expiryTimer:number|undefined;
const errorText=(e:unknown)=>e instanceof Error?e.message:"批准结果未确认，请不要重复点击。";
function remainingMs(){
  if(!snapshot||!Number.isFinite(snapshot.expiresAt)||!Number.isFinite(snapshot.serverNow))return 0;
  return Math.max(0,Number(snapshot.expiresAt)-Number(snapshot.serverNow)-(Date.now()-receivedAt));
}
function render(){
  if(!snapshot)return;
  const expired=remainingMs()<=0;
  if(expired&&!snapshot.decision)stopped=true;
  allow.disabled=deny.disabled=stopped||busy||attempted||!snapshot.canSubmit||expired;
  el("receipt").textContent=JSON.stringify(snapshot,null,2);
  if(stopped){
    if(expired&&!snapshot.decision)el("status").textContent="本次批准请求已过期。请让原操作生成新的批准卡。";
    return;
  }
  el("status").textContent=busy?"正在提交你的选择，请勿重复点击。"
    :snapshot.waitOutcome==="accepted"?"已允许本次访问。如果原回复仍在运行，它会继续；如果原回复已结束，请发送“继续”重新执行。"
    :snapshot.waitOutcome==="declined"?"已拒绝。本次 Computer Use 操作不会继续。"
    :snapshot.waitOutcome==="timeout"?`模型等待已结束，但批准卡仍有效约 ${Math.ceil(remainingMs()/1000)} 秒。你仍可明确允许或拒绝；允许后发送“继续”。`
    :snapshot.waitOutcome?`本次批准等待已结束（${snapshot.waitOutcome}）。`
    :"请选择一次。只有你点击“允许本次访问”后，原 Computer Use 操作才可重试。";
}
function accept(result:CallToolResult){
  if(result.isError)throw new Error(result.content.filter(c=>c.type==="text").map(c=>c.text).join("\n"));
  const s=result.structuredContent as Record<string,any>|undefined;
  if(!s||s.approvalId!==card?.approvalId||typeof s.canSubmit!=="boolean"||!Number.isFinite(s.revision)||!Number.isFinite(s.serverNow)||!Number.isFinite(s.expiresAt))
    throw new Error("批准卡片数据校验失败。");
  snapshot=s;receivedAt=Date.now();
  if(expiryTimer!==undefined)clearInterval(expiryTimer);
  expiryTimer=window.setInterval(()=>render(),1000);
  render();
}
async function submit(decision:"accept"|"decline"){
  if(!card||!snapshot?.canSubmit||busy||attempted||stopped)return;
  attempted=true;busy=true;render();
  try{
    const r=await app.callServerTool({name:"computer_approval_submit",arguments:{approvalId:card.approvalId,submitToken:card.submitToken,decision}},{timeout:10_000});
    accept(r);
  }catch(e){
    stopped=true;
    const text=errorText(e);
    el("status").textContent=text.includes("COMPUTER_APPROVAL_EXPIRED_OR_CLOSED")
      ?"本次批准已过期或关闭，选择未生效。请重新发起审批。"
      :`${text} 提交状态未知，请勿重试。`;
  }
  finally{busy=false;render();}
}
allow.addEventListener("click",()=>void submit("accept"));
deny.addEventListener("click",()=>void submit("decline"));
const initial=setTimeout(()=>{if(!card){stopped=true;el("status").textContent="15 秒内未收到有效批准请求。请停止本次操作。";}},15_000);
app.ontoolresult=result=>{
  const meta=result._meta?.computerApproval as typeof card;
  if(!meta||typeof meta.approvalId!=="string"||typeof meta.submitToken!=="string")return;
  if(card?.approvalId===meta.approvalId)return;
  clearTimeout(initial);card=meta;busy=false;attempted=false;stopped=false;
  try{
    accept(result);el("id").textContent=`本次批准：${card.approvalId}`;
    el("app").textContent=String(snapshot?.displayName??snapshot?.app??"未知应用");
    el("message").textContent=String(snapshot?.message??"");
  }catch(e){stopped=true;el("status").textContent=errorText(e);render();}
};
window.addEventListener("pagehide",()=>{stopped=true;clearTimeout(initial);if(expiryTimer!==undefined)clearInterval(expiryTimer);});
void app.connect().catch(e=>{stopped=true;el("status").textContent=errorText(e);});
