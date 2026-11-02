import assert from 'node:assert/strict';
import {createSlipTestDb,createPgSupabase,SLIP_PIPELINE_MIGRATIONS} from '@/lib/slips/testing/pg-slip-harness';
import {ASSISTANT_MIGRATIONS,assistantRpcClient} from '@/lib/ai/assistant/testing/pg-assistant-db';
import {WebhookService} from '@/lib/line/webhook-service';
import {test} from 'bun:test';
test.skipIf(process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== '1')('enqueue lock timeout releases webhook before the AI lock is released',async()=>{
assert(['127.0.0.1','localhost','::1'].includes(process.env.PGHOST ?? 'localhost'));
const db=await createSlipTestDb('independent191_stall',[...SLIP_PIPELINE_MIGRATIONS,...ASSISTANT_MIGRATIONS]);
let unlock!:()=>void;const gate=new Promise<void>(resolve=>unlock=resolve);
let locked!:()=>void;const ready=new Promise<void>(resolve=>locked=resolve);
const transaction=db.sql.begin(async tx=>{await tx.unsafe("SELECT pg_advisory_xact_lock(hashtextextended('ai_assistant_jobs:enqueue',0))");locked();await gate});
let processing:Promise<unknown>|undefined;
try{
  await ready;
  const tables=createPgSupabase(db,{failUpload:new Set(),uploaded:new Map()});
  const rpc=assistantRpcClient(db);
  const client={...tables,rpc:(name:string,args:Record<string,unknown>)=>name.includes('ai_assistant')?rpc.rpc(name as never,args as never):tables.rpc(name,args)};
  const background:Array<()=>Promise<void>>=[];
  const service=new WebhookService(client as never,{botSummaryAnalystEnabled:true,botSummaryAnalystSourceAllowed:()=>true,whiteSheetReaderEnabled:false,scheduleBackgroundTask:task=>{background.push(task)},replyMessage:async()=>{}});
  const event=(id:string,userId:string,text:string)=>({type:'message',webhookEventId:id,timestamp:Date.now(),source:{type:'group',groupId:'Capproved',userId},mode:'active',replyToken:`r-${id}`,message:{id:`m-${id}`,type:'text',quoteToken:'q',text}});
  let returned=false;
  processing=service.processEvents([event('ai-stall','Uasker','@Botsummary วันนี้ขายได้เท่าไหร่'),event('produce-waiting','Uworker','ดำ-วัดตะกล่ำ เบิก 2/11/2569')] as never,'Ubot',{deferOrderedProcessing:true}).then(result=>{returned=true;return result});
  await Bun.sleep(1500);
  assert.equal(returned,true);assert.equal(background.length,1);
  const status=await db.scalar("SELECT status FROM public.line_webhook_event_queue WHERE line_event_id='produce-waiting'");
  assert.equal(status,'pending');
  const waiting=await db.scalar("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'");
  assert.equal(Number(waiting),0);
  console.log('F4',JSON.stringify({blockedOnlyAiEnqueueLock:true,webhookReturned:returned,produceAfterTaskScheduled:background.length,produceStatus:status,advisoryWaiters:Number(waiting)}));
  unlock();await transaction;await processing;
  assert.equal(returned,true);
  console.log('After releasing AI-only lock: webhook returns; no Produce callback ran before response');
}finally{unlock();await transaction;await processing;await db.drop();console.log('Disposable stall database dropped')}

},30000);
