import assert from "node:assert/strict";
import test from "node:test";
import * as z from "zod/v4";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { ChatGoalCards } from "./chat-goal-cards.js";
import type { ChatGoalController } from "./chat-goal-controller.js";
import { chatGoalPreflight, chatGoalStartupBlock } from "./chat-goal-preflight.js";
import { chatGoalOutputSchemas } from "./chat-goal-output.js";

test("all seventeen output contracts are object schemas and reject malformed envelopes",()=>{
  assert.equal(Object.keys(chatGoalOutputSchemas).length,17);
  for(const [name,schema] of Object.entries(chatGoalOutputSchemas)) {
    const wire=z.toJSONSchema(schema);assert.equal(wire.type,"object",name);
    const validate=new AjvJsonSchemaValidator().getValidator(wire as unknown as Parameters<AjvJsonSchemaValidator["getValidator"]>[0]);
    const error={ok:false,error:{code:"WORKSPACE_ACCESS_REQUIRED",message:"Test access revoked"},replayed:true};
    assert.equal(schema.safeParse(error).success,true,name);assert.equal(validate(error).valid,true,name);
    for(const malformed of [{ok:true},{ok:false},{ok:true,data:{anything:"goes"}},{...error,submitToken:"secret"}])
      assert.equal(schema.safeParse(malformed).success,false,name);
  }
});
test("preflight and startup refusal preserve their real structured contracts",()=>{
  for(const caps of [undefined,{elicitation:{form:{}}}])for(const card of [undefined,{available:true,verified:false},{available:true,verified:true}]){
    assert.equal(chatGoalOutputSchemas.chat_goal_preflight.safeParse({ok:true,data:chatGoalPreflight(caps,card)}).success,true);
    const blocked=chatGoalStartupBlock(caps,card);
    if(blocked)for(const name of ["chat_goal_create","chat_goal_next","chat_goal_resume"] as const)
      assert.equal(chatGoalOutputSchemas[name].safeParse(blocked).success,true);
  }
});
test("real connection timeout, repeated wait and acknowledgement match output schema without exposing private metadata",async()=>{
  const cards=new ChatGoalCards({} as ChatGoalController,{waitMs:5});
  const schema=chatGoalOutputSchemas.chat_goal_card_ready;
  try {
    const r=cards.connect("isolated-test","timeout"),meta=r._meta!.goalCard as {cardId:string;submitToken:string};
    assert.equal(chatGoalOutputSchemas.chat_goal_card_connect.safeParse(r.structuredContent).success,true);
    const waited=await cards.wait("isolated-test",meta.cardId);
    assert.equal(waited.waitOutcome,"timeout");assert.equal(schema.safeParse({ok:true,data:waited}).success,true);
    assert.equal((await cards.wait("isolated-test",meta.cardId)).waitDeadlineAt,waited.waitDeadlineAt);
    assert.ok(!JSON.stringify(r.structuredContent).includes(meta.submitToken));
    const second=cards.connect("isolated-test","ack"),m=second._meta!.goalCard as typeof meta;
    const ack=await cards.status("isolated-test",m.cardId,m.submitToken);
    assert.equal(ack.waitOutcome,"channel_ready");assert.equal(schema.safeParse({ok:true,data:ack}).success,true);
    assert.equal(schema.safeParse({ok:true,data:{...ack,waitActive:"true"}}).success,false);
    assert.equal(schema.safeParse({ok:true,data:{...ack,submitToken:m.submitToken}}).success,false);
  }finally{await cards.close();}
});
