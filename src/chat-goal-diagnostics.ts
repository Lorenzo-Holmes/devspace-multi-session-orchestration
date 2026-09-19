import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { chatGoalOutputSchemas } from "./chat-goal-output.js";

type Phase="request_received"|"input_validated"|"controller_entered"|"authorization_passed"|"journal_started"|"journal_replayed"|"journal_committed"|"journal_retained"|"response_ready"|"transport_send_completed"|"transport_send_failed"|"http_finished"|"http_closed";
type Fields={revision?:number;state?:string;outcome?:string;status?:number;replayed?:boolean};
type Trace={rpcId:unknown;started:number;fields:Record<string,unknown>;emit:(phase:Phase,fields?:Fields)=>void};
const current=new AsyncLocalStorage<Trace>();
export function chatGoalPhase(phase:Phase,fields:Fields={}) {current.getStore()?.emit(phase,fields);}
const object=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:undefined;

/** Observability only: no request retries, protocol bridge, argument/result
 * rewrites, stored answers or authorization decisions. In-flight context is
 * scoped to each HTTP request; no unbounded global correlation map. */
export class ChatGoalDiagnostics {
  private readonly salt=randomBytes(32);
  constructor(private readonly onEvent:(fields:Record<string,unknown>)=>void) {}
  private hash(value:unknown) {
    if(typeof value!=="string"&&typeof value!=="number")return undefined;
    const s=String(value);if(s.length>512)return undefined;
    return createHmac("sha256",this.salt).update(s).digest("hex").slice(0,24);
  }
  readonly middleware:RequestHandler=(req,res,next)=>{
    const body=object(req.body),params=object(body?.params),tool=params?.name;
    if(req.method!=="POST"||body?.method!=="tools/call"||typeof tool!=="string"||!Object.hasOwn(chatGoalOutputSchemas,tool))return next();
    const args=object(params?.arguments);
    const httpRequestId=res.locals?.requestId;
    const fields={attemptId:randomUUID(),tool,pid:process.pid,
      httpRequestId:typeof httpRequestId==="string"&&/^[a-f0-9-]{36}$/i.test(httpRequestId)?httpRequestId:undefined,
      rpcIdHash:this.hash(body.id),requestKeyHash:this.hash(args?.requestKey),goalRefHash:this.hash(args?.goalRef),
      workspaceIdHash:this.hash(args?.workspaceId),cardIdHash:this.hash(args?.cardId??args?.cardChannelId),
      expectedRevision:Number.isSafeInteger(args?.expectedRevision)?args?.expectedRevision:undefined};
    const trace:Trace={rpcId:body.id,started:performance.now(),fields,emit:(phase,detail={})=>{
      // Never spread request args, auth headers, raw error text or card tokens.
      try {this.onEvent({...fields,phase,elapsedMs:Math.round(performance.now()-trace.started),
        revision:detail.revision,state:detail.state,outcome:detail.outcome,status:detail.status,replayed:detail.replayed});}catch{/* A broken sink must not change tool outcomes. */}
    }};
    trace.emit("request_received");
    res.once("finish",()=>trace.emit("http_finished",{status:res.statusCode}));
    res.once("close",()=>{if(!res.writableFinished)trace.emit("http_closed",{status:res.statusCode});});
    current.run(trace,next);
  };
  observeTransport(transport:Transport) {
    const send=transport.send.bind(transport);
    transport.send=async(message,options)=>{
      const trace=current.getStore();
      if(!trace||!("id" in message)||message.id!==trace.rpcId||!("result" in message||"error" in message))return send(message,options);
      const result="result" in message?object(message.result):undefined,structured=object(result?.structuredContent);
      const first=Array.isArray(result?.content)?object(result.content[0]):undefined;
      // Classify SDK errors by fixed prefixes; never log the original text,
      // which may include schema inputs, file paths or credentials.
      const text=typeof first?.text==="string"?first.text:"";
      const outcome="error" in message?"protocol_error":/^(?:MCP error -\d+: )?Input validation error:/.test(text)?"input_validation_failed"
        :/^(?:MCP error -\d+: )?Output validation error:/.test(text)?"output_validation_failed"
        :result?.isError===true||structured?.ok===false?"tool_error":"tool_success";
      trace.emit("response_ready",{outcome,replayed:structured?.replayed===true});
      try {await send(message,options);trace.emit("transport_send_completed");}
      catch(e){trace.emit("transport_send_failed");throw e;}
    };
  }
}
