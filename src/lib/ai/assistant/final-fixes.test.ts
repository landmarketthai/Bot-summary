import { test, expect } from 'bun:test';
import { answerAssistantJob, revalidateAssistantJob, type AssistantCoreDeps } from '@/lib/ai/assistant/core';
import { MemoryAssistantJobStore } from '@/lib/ai/assistant/testing/memory-job-store';
import { RecordingLineDelivery } from '@/lib/ai/assistant/testing/recording-line';
import { createAssistantDispatcher } from '@/lib/ai/assistant/dispatch';
import { runAssistantWorker } from '@/lib/ai/assistant/worker';
import { FakeDatabase } from '@/lib/summary/test-fake-supabase';
import { containsFinancialClaim, renderFinancialOutput } from '@/lib/ai/assistant/financial-render';
import type { AssistantModelProvider } from '@/lib/ai/model-provider';

let seq=0;
const request=(overrides:Record<string,unknown>={})=>({lineEventId:`independent-${++seq}`,rawMessageId:null,destination:'Ubot',sourceType:'group' as const,sourceId:'Capproved',lineUserId:'Uone',question:'วันนี้ยอดขายเท่าไหร่',askedBusinessDate:'2026-11-02',eventTimestampMs:Date.now()+seq,replyToken:null,replyTokenExpiresAt:null,...overrides});
function model(text:string,tool?:string):AssistantModelProvider {
  return {name:'adversarial-fixture',model:'fixed',async respond(round){
    if(tool&&!round.transcript.some(x=>x.kind==='tool_result'))return {text:'',model:'fixed',toolCalls:[{callId:'c',name:tool,arguments:'{}'}]};
    return {text,model:'fixed',toolCalls:[]};
  }};
}
async function ask(text:string,tool?:string){
  const store=new MemoryAssistantJobStore();
  await store.enqueue(request());
  const [job]=await store.claim('w',{limit:1,leaseSeconds:120,maxRunning:4});
  const deps:AssistantCoreDeps={supabase:new FakeDatabase() as never,store,provider:model(text,tool),sourceAllowed:()=>true,resolveGroupPolicy:async sourceId=>({ok:true,policy:{sourceId,markets:null}})};
  return {result:await answerAssistantJob(job!,{deadlineAt:Date.now()+5000,signal:new AbortController().signal},deps),job,deps};
}

test('F1a: unsupported financial statements never reach delivery',async()=>{
  const variants=['วันนี้ขายได้ 75 ฿ ยืนยันแล้วครับ','ยอดขายวันนี้เท่ากับเจ็ดหมื่นบาท ยืนยันเรียบร้อยครับ','เงินครบแล้วครับ'];
  for(const text of variants){
    expect(containsFinancialClaim(text)).toBe(false);
    const {result}=await ask(text);
    expect(result.kind).toBe('notice');
    expect(result.toolNames).toEqual([]);
    console.log('F1a',JSON.stringify({text,kind:result.kind,toolNames:result.toolNames}));
  }
  for(const text of variants){
    const {result}=await ask(text,'get_stock_summary');
    expect(result.kind).toBe('answer');
    expect(result.toolNames).toEqual(['get_stock_summary']);
    expect(result.text).not.toContain(text);
    expect(result.text).not.toContain('75');
  }
});

test('F1b: empty sales evidence remains unknown',async()=>{
  const {result}=await ask('ignored model answer','get_daily_summary');
  expect(result.kind).toBe('answer');
  console.log('F1b',JSON.stringify({kind:result.kind,text:result.text}));
  expect(result.text).toContain('ไม่พบข้อมูล');
  expect(result.text).not.toContain('0.00');
});

test('F2: access revalidation stops at the retry limit',async()=>{
  const store=new MemoryAssistantJobStore();
  const line=new RecordingLineDelivery();
  const {jobId}=await store.enqueue({...request(),maxAttempts:1});
  for(let i=0;i<6;i++){
    store.makeAvailable();
    await runAssistantWorker({store,answer:async()=>({text:'stored data',kind:'answer',scopeKey:'a'.repeat(64)}),revalidate:async()=> 'transient',delivery:line,pushFallbackEnabled:true,workerId:'w',budgetMs:15000,maxJobs:1,temporaryErrorText:'retry'});
  }
  const job=store.jobs.get(jobId!)!;
  expect(job.attempts).toBe(1);
  expect(job.status).toBe('failed');
  await store.enqueue(request());
  expect((await store.claim('next',{limit:1,leaseSeconds:120,maxRunning:4})).length).toBe(1);
  expect(line.sent.length).toBe(0);
  console.log('F2',JSON.stringify({maxAttempts:job.max_attempts,attempts:job.attempts,status:job.status,sent:line.sent.length}));
});

test('control: scope revoke is refused even for a stored answer',async()=>{
  const {result,job,deps}=await ask('plain clarification');
  deps.resolveGroupPolicy=async()=>({ok:true,policy:null});
  expect(await revalidateAssistantJob(job!,deps,result.scopeKey)).toBe('changed');
});

test('comparisons keep missing days unknown and a recorded zero valid',()=>{
 const total={confirmedSalesSatang:0,pendingReviewSalesSatang:0};
 const text=renderFinancialOutput({tool:'compare_daily_sales',dates:[{businessDate:'2026-01-01',total,markets:[]},{businessDate:'2030-12-31',total,markets:[{market:'ตลาด',...total}]}]});
 expect(text).toContain('วันที่ 2026-01-01: ไม่พบข้อมูล');
 expect(text).toContain('วันที่ 2030-12-31');
 expect(text).toContain('ยืนยันแล้ว 0.00 บาท');
});

test('enqueue RPC that never settles cannot hold the dispatcher',async()=>{
  const store=new MemoryAssistantJobStore();
  store.enqueue=()=>new Promise(()=>{});
  const dispatch=createAssistantDispatcher(store);
  await expect(dispatch({event:{webhookEventId:'hung',timestamp:Date.now(),source:{type:'group',groupId:'Ctest',userId:'Utest'}} as never,question:'ยอดขาย',destination:'Ubot',rawMessageId:null})).rejects.toThrow();
},3000);
