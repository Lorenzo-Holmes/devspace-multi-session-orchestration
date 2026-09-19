import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Request,Response } from "express";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import test from "node:test";
import { ChatGoalDiagnostics,chatGoalPhase } from "./chat-goal-diagnostics.js";

test("bounded diagnostics distinguish SDK validation and preserve isolated concurrent request contexts",async()=>{
  const events:Record<string,unknown>[]=[];
  const d=new ChatGoalDiagnostics(e=>events.push(e));
  const sent:unknown[]=[];const transport={send:async(m:unknown)=>{sent.push(m);}} as Transport;d.observeTransport(transport);
  async function run(id:number,invalid:boolean){
    const req={method:"POST",headers:{authorization:"Bearer must-not-log"},body:{jsonrpc:"2.0",id,method:"tools/call",params:{name:"chat_goal_status",arguments:{workspaceId:"private-workspace",requestKey:"private-key",submitToken:"private-card-token",answer:"private-answer"}}}} as unknown as Request;
    const res=Object.assign(new EventEmitter(),{statusCode:200,writableFinished:true}) as unknown as Response;
    await new Promise<void>((resolve,reject)=>d.middleware(req,res,()=>{
      void(async()=>{
        if(!invalid){chatGoalPhase("input_validated");await new Promise(r=>setTimeout(r,5));chatGoalPhase("journal_committed",{revision:3,state:"ready"});}
        await transport.send({jsonrpc:"2.0",id,result:invalid?{isError:true,content:[{type:"text",text:"MCP error -32602: Input validation error: private argument must-not-log"}]}:{content:[],structuredContent:{ok:true}}});
        res.emit("finish");resolve();
      })().catch(reject);
    }));
  }
  await Promise.all([run(1,true),run(2,false)]);
  assert.equal(sent.length,2);
  const starts=events.filter(e=>e.phase==="request_received");assert.equal(starts.length,2);assert.notEqual(starts[0].attemptId,starts[1].attemptId);
  const a=events.filter(e=>e.attemptId===starts[0].attemptId),b=events.filter(e=>e.attemptId===starts[1].attemptId);
  assert.ok(a.some(e=>e.outcome==="input_validation_failed"));assert.ok(!a.some(e=>e.phase==="input_validated"));
  assert.ok(b.some(e=>e.phase==="journal_committed"));assert.ok(b.some(e=>e.outcome==="tool_success"));
  for(const secret of ["must-not-log","private-workspace","private-key","private-card-token","private-answer"])
    assert.ok(!JSON.stringify(events).includes(secret));
});
test("diagnostics never rewrite results or swallow transport errors, and a failing log sink is inert",async()=>{
  for(const sinkFails of [false,true]){
    const events:Record<string,unknown>[]=[];const d=new ChatGoalDiagnostics(e=>{if(sinkFails)throw new Error("sink failed");events.push(e);});
    const failure=new Error("private transport detail"),message={jsonrpc:"2.0" as const,id:4,result:{isError:true,content:[]}};
    const transport:Transport={start:async()=>{},close:async()=>{},send:async(m:unknown)=>{assert.equal(m,message);throw failure;}};d.observeTransport(transport);
    const res=Object.assign(new EventEmitter(),{statusCode:500,writableFinished:false}) as unknown as Response;
    const req={method:"POST",body:{id:4,method:"tools/call",params:{name:"chat_goal_card_ready"}}} as Request;
    await new Promise<void>((resolve,reject)=>d.middleware(req,res,()=>{
      void assert.rejects(()=>transport.send(message),e=>e===failure).then(()=>{res.emit("close");resolve();},reject);
    }));
    if(!sinkFails){assert.ok(events.some(e=>e.phase==="transport_send_failed"));assert.ok(events.some(e=>e.phase==="http_closed"));}
    assert.ok(!JSON.stringify(events).includes("private transport detail"));
  }
});
