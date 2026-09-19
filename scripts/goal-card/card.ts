import { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const app=new App({name:"DevSpace Goal decision",version:"1.0.0"});
const element=(id:string)=>document.getElementById(id)!;
let card:{cardId:string;submitToken:string;kind:string}|undefined;
let snapshot:Record<string,any>|undefined,busy=false,attempted=false,stopped=false,reads=0,generation=0,seenAt=0;
let timer:ReturnType<typeof setTimeout>|undefined;
const buttons:HTMLButtonElement[]=[];
const errorText=(e:unknown)=>e instanceof Error?e.message:"卡片回执未确认，请保留错误，不重复点击。";
function lock(message:string){stopped=true;clearTimeout(timer);for(const b of buttons)b.disabled=true;element("status").textContent=message;}
function render(){
  if(!snapshot)return;
  const s=snapshot,remaining=Math.max(0,Math.ceil(((s.waitDeadlineAt??s.expiresAt)-s.serverNow-(performance.now()-seenAt))/1000));
  for(const b of buttons)b.disabled=stopped||busy||attempted||!s.canSubmit||remaining===0;
  element("receipt").textContent=JSON.stringify(s,null,2);
  if(stopped)return;
  element("status").textContent=busy?"已点击，正在确认提交结果，请勿重复点击。":s.kind==="connection"
    ?s.acknowledged?"卡片返回通道已确认。无需点击；等待当前回复继续。":"正在验证卡片返回通道，无需点击。"
    :s.waitOutcome==="answer_received"||s.waitOutcome==="answer_already_recorded"?"选择已记录。请等待原回复读取结果，不必另发“继续”。"
    :s.waitOutcome?`本次等待已结束（${s.waitOutcome}）；没有自动恢复目标。`
    :remaining===0?"等待时间已到，按钮已锁定。请保留当前状态。"
    :s.waitActive?`服务端已确认等待，保守估算剩余约 ${remaining} 秒。请点击一次选项。`
    :"尚未确认等待开始；可提前选择，答案会暂存。";
}
function accept(result:CallToolResult){
  if(result.isError)throw new Error(result.content.filter(c=>c.type==="text").map(c=>c.text).join("\n"));
  const body=result.structuredContent as {ok?:boolean;data?:Record<string,any>}|undefined,s=body?.data;
  if(!body?.ok||!s||s.cardId!==card?.cardId||typeof s.canSubmit!=="boolean"||typeof s.waitActive!=="boolean"||!Number.isFinite(s.serverNow)||!Number.isFinite(s.expiresAt)||!Number.isFinite(s.revision)
    ||((s.waitStarted||s.waitActive)&&!Number.isFinite(s.waitDeadlineAt)))throw new Error("卡片数据校验失败；未确认选择，不重复点击。");
  if(!snapshot||s.revision>snapshot.revision||(s.revision===snapshot.revision&&s.serverNow>=snapshot.serverNow)){snapshot=s;seenAt=performance.now();}
  render();
}
async function sync(){
  if(!card||stopped||reads>=6||attempted)return;
  const current=generation;reads++;
  try{
    const r=await app.callServerTool({name:"chat_goal_card_status",arguments:{cardId:card.cardId,submitToken:card.submitToken}},{timeout:10_000});
    if(current!==generation)return;accept(r);
    if(snapshot?.waitOutcome||snapshot?.kind==="connection")return;
    // At most six snapshots; no polling after timeout and no deadline renewal.
    const delay=snapshot?.waitActive?Math.min(50_000,Math.max(0,snapshot.waitDeadlineAt-snapshot.serverNow)+300):[2000,3000,5000,10000,10000][reads-1];
    if(reads<6)timer=setTimeout(()=>void sync(),delay);
  }catch(e){if(current===generation)lock(errorText(e));}
}
async function submit(action:"accept"|"cancel",answer?:string){
  if(!card||!snapshot?.canSubmit||stopped||busy||attempted)return;
  attempted=true;busy=true;clearTimeout(timer);render();const current=generation;
  try{
    const r=await app.callServerTool({name:"chat_goal_card_submit",arguments:{cardId:card.cardId,submitToken:card.submitToken,action,...(answer?{answer}:{})}},{timeout:10_000});
    if(current!==generation)return;accept(r);
  }catch(e){if(current===generation)lock(`${errorText(e)} 提交结果未确认，请勿重试。`);}
  finally{if(current===generation){busy=false;render();}}
}
const initialTimer=setTimeout(()=>{if(!card)lock("15 秒内未收到有效工具结果。请保留错误，停止本次操作。");},15_000);
app.ontoolresult=result=>{
  const meta=result._meta?.goalCard as typeof card;
  if(!meta||typeof meta.cardId!=="string"||typeof meta.submitToken!=="string"||!["connection","decision"].includes(meta.kind))return;
  if(card?.cardId===meta.cardId||(!card&&stopped))return;
  // A host may reuse the same resource iframe for a different tool result.
  // New card IDs reset presentation; identical historical results never do.
  clearTimeout(initialTimer);clearTimeout(timer);card=meta;generation++;
  snapshot=undefined;busy=false;attempted=false;stopped=false;reads=0;
  buttons.splice(0);element("choices").replaceChildren();
  try{
    accept(result);element("id").textContent=`本次卡片：${card.cardId}`;
    element("title").textContent=card.kind==="connection"?"目标卡片连接检查":"目标需要你的选择";
    element("question").textContent=String(snapshot?.question??"");
    if(card.kind==="decision"){
      const choices=snapshot?.choices;
      if(!Array.isArray(choices)||choices.length<2||choices.length>6||choices.some(c=>typeof c!=="string"))throw new Error("选项格式无效。");
      for(const choice of [...choices,"取消并暂停"]){const button=document.createElement("button");button.textContent=choice;button.disabled=true;
        const index=buttons.length;button.addEventListener("click",()=>void submit(index===choices.length?"cancel":"accept",index===choices.length?undefined:choice));
        buttons.push(button);element("choices").append(button);}
    }
    void sync();
  }catch(e){lock(errorText(e));}
};
const paint=setInterval(render,500);
window.addEventListener("pagehide",()=>{stopped=true;clearTimeout(timer);clearTimeout(initialTimer);clearInterval(paint);});
void app.connect().catch(e=>lock(errorText(e)));
