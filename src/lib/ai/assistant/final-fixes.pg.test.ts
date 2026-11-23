import assert from 'node:assert/strict';
import {join} from 'node:path';
import {test} from 'bun:test';
const ROOT=join(import.meta.dir,'../../../../');
import {createSlipTestDb,createPgSupabase} from '@/lib/slips/testing/pg-slip-harness';
import {ASSISTANT_MIGRATIONS,assistantRpcClient} from '@/lib/ai/assistant/testing/pg-assistant-db';
import {SupabaseAssistantJobStore} from '@/lib/ai/assistant/job-store';
import {recoverUnenqueuedQuestions} from '@/lib/ai/assistant/recovery';
import {runAssistantWorker} from '@/lib/ai/assistant/worker';
import {RecordingLineDelivery} from '@/lib/ai/assistant/testing/recording-line';

test.skipIf(process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== '1')('final fixes: real SQL retry, cursor deadlines, privileges and rollback', async()=>{
assert(['127.0.0.1','localhost','::1'].includes(process.env.PGHOST ?? 'localhost'));
const db=await createSlipTestDb('independent_final191',['0001_initial_schema.sql',...ASSISTANT_MIGRATIONS]);
console.log('LOCAL DISPOSABLE',db.name);
try {
  const rpc=assistantRpcClient(db), store=new SupabaseAssistantJobStore(rpc);
  const req=(id:string,ts=1000)=>({lineEventId:id,rawMessageId:null,destination:'Ubot',sourceType:'group' as const,sourceId:'Capproved',lineUserId:'Uone',question:id,askedBusinessDate:'2026-11-02',eventTimestampMs:ts,replyToken:null,replyTokenExpiresAt:null});
  const a=await store.enqueue(req('first',2000));
  const [owned]=await store.claim('w1',{limit:1,leaseSeconds:120,maxRunning:4});
  const b=await store.enqueue(req('late older',1000));
  assert.equal((await store.claim('w2',{limit:1,leaseSeconds:120,maxRunning:4})).length,0);
  await db.query(`UPDATE public.ai_assistant_jobs SET lease_expires_at=now()-interval '1 second' WHERE id='${a.jobId}'`);
  const [reclaimed]=await store.claim('w2',{limit:1,leaseSeconds:120,maxRunning:4});
  assert.equal(reclaimed!.id,owned!.id);
  assert.equal(await store.complete(owned!.id,owned!.lease_token!,'completed'),false);
  console.log('One-running constraint, late event blocking, stale token fencing: PASS');
  const rejectSql=async(sql:string,code:string)=>{let got=false;try{await db.exec('\\set VERBOSITY verbose\n'+sql)}catch(error){got=String(error).includes(code)}assert(got,`expected SQLSTATE ${code}`)};
  await rejectSql(`SELECT public.record_ai_assistant_answer('${reclaimed!.id}','${reclaimed!.lease_token}','fixture','answer',NULL,'{}'::text[],NULL,1800,6,NULL,'chat')`,'22023');
  await rejectSql(`UPDATE public.ai_assistant_jobs SET status='running',lease_token=gen_random_uuid(),lease_expires_at=now()+interval '1 minute' WHERE id='${b.jobId}'`,'23505');
  await rejectSql(`SELECT public.retry_ai_assistant_job('${reclaimed!.id}','${reclaimed!.lease_token}',0,'provider text with spaces')`,'23514');
  await store.recordAnswer(reclaimed!.id,reclaimed!.lease_token!,{answer:'fixture data',kind:'answer',scopeKey:'a'.repeat(64),turn:{businessDate:'2026-11-02',context:{}}});
  assert.equal(await db.scalar('SELECT count(*) FROM public.ai_assistant_conversation_turns'),'1');
  await store.withholdAnswer(reclaimed!.id,reclaimed!.lease_token!,'scope changed');
  assert.equal(await db.scalar('SELECT count(*) FROM public.ai_assistant_conversation_turns'),'0');
  console.log('psql: missing scope rejected 22023, second running rejected 23505, unsafe error code rejected 23514; withhold deletes memory: PASS');
  await db.query('TRUNCATE public.ai_assistant_jobs CASCADE');

  const {jobId}=await store.enqueue({...req('retry-with-limit'),maxAttempts:1});
  for(let i=0;i<6;i++){
    await db.query("UPDATE public.ai_assistant_jobs SET available_at=now()-interval '1 second' WHERE status='queued'");
    await runAssistantWorker({store,answer:async()=>({text:'fixture answer',kind:'answer',scopeKey:'a'.repeat(64)}),revalidate:async()=> 'transient',delivery:new RecordingLineDelivery(),pushFallbackEnabled:true,workerId:'w',budgetMs:15000,maxJobs:1,temporaryErrorText:'retry'});
  }
  const state=await db.query(`SELECT status,attempts,max_attempts FROM public.ai_assistant_jobs WHERE id='${jobId}'`);
  assert.equal(state[0]!.attempts,1);assert.equal(state[0]!.status,'failed');
  console.log('F2 REAL SQL',JSON.stringify(state));

  await db.query(`INSERT INTO public.raw_messages(line_event_id,destination,event_type,source_type,source_id,user_id,message_type,raw_text,payload,is_processed,created_at)
    SELECT 'cursor-'||g,'Ubot','message','group','Capproved','U'||g,'text','@Botsummary วันนี้ขายได้เท่าไหร่',
      jsonb_build_object('type','message','timestamp',1000,'webhookEventId','cursor-'||g,'source',jsonb_build_object('type','group','groupId','Capproved','userId','U'||g),'message',jsonb_build_object('id','m'||g,'type','text','text','@Botsummary วันนี้ขายได้เท่าไหร่')),false,now()-interval '5 minutes'+(g||' microseconds')::interval
    FROM generate_series(1,61) g`);
  const base=createPgSupabase(db,{failUpload:new Set(),uploaded:new Map()});
  const visits:string[]=[];
  let recoveryDeadline=0;
  const faulty={...base,async rpc(name:string,args:Record<string,unknown>){
    if(Date.now()>=recoveryDeadline)return {data:null,error:{code:'AbortError'}};
    return rpc.rpc(name as never,args as never);
  }};
  let sweeps=0;
  for(;sweeps<10 && new Set(visits).size<61;sweeps++){
    recoveryDeadline=Date.now()+100;
    let threw=false;
    try{await recoverUnenqueuedQuestions({supabase:faulty as never,checkpointClient:rpc,dispatcher:async input=>{visits.push(input.event.webhookEventId);if(Date.now()>=recoveryDeadline)return {outcome:'error',jobId:null};await Bun.sleep(5);return {outcome:'rate_limited',jobId:null}},analystEnabled:true,sourceAllowed:()=>true,whiteSheetReaderEnabled:false})}
    catch{threw=true}void threw;
    if(visits.length>0 && new Set(visits).size<61) assert.equal(await db.scalar("SELECT count(*) FROM public.ai_assistant_recovery_cursor"),"1");
  }
  assert.equal(new Set(visits).size,61);
  const cursorRows=await db.scalar('SELECT count(*) FROM public.ai_assistant_recovery_cursor');
  console.log('F3 REAL SQL',JSON.stringify({sweeps,budgetMsPerSweep:100,visits:visits.length,uniqueVisits:new Set(visits).size,cursorRows}));
  const tied=await rpc.rpc('list_ai_assistant_recovery_candidates',{p_since:new Date(Date.now()-30*60000).toISOString(),p_until:new Date().toISOString(),p_after_created_at:null,p_after_id:null,p_limit:200} as never);
  assert.equal((tied.data as unknown[]).length,61);
  console.log('Recovery keyset: all 61 microsecond-separated rows returned');

  const privilege=await db.query(`SELECT r.rolname,p.proname,has_function_privilege(r.rolname,p.oid,'EXECUTE') allowed FROM pg_proc p CROSS JOIN pg_roles r WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE '%ai_assistant%' AND r.rolname IN ('anon','authenticated','service_role')`);
  assert.equal(privilege.length,45);assert(privilege.every((r:Record<string,unknown>)=>r.allowed===(r.rolname==='service_role')));
  const table=await db.query(`SELECT r.rolname,c.relname,c.relrowsecurity,has_table_privilege(r.rolname,c.oid,'SELECT') allowed FROM pg_class c CROSS JOIN pg_roles r WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND c.relname LIKE 'ai_assistant%' AND r.rolname IN ('anon','authenticated','service_role')`);
  assert.equal(table.length,15);assert(table.every((r:Record<string,unknown>)=>!r.allowed&&r.relrowsecurity));
  console.log('RPC privileges 45/45, table restrictions/RLS 15/15: PASS');

  const plan=await db.query("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT * FROM public.list_ai_assistant_recovery_candidates(now()-interval '30 minutes',now(),NULL,NULL,50)");
  assert(plan.length > 0);
  const originalRaw=await db.scalar('SELECT count(*) FROM public.raw_messages');
  for(const f of ASSISTANT_MIGRATIONS)await db.exec(await Bun.file(join(ROOT,'supabase/migrations',f)).text());
  for(const f of [...ASSISTANT_MIGRATIONS].reverse())await db.exec(await Bun.file(join(ROOT,'supabase/rollback',f.replace('.sql','.down.sql'))).text());
  assert.equal(await db.scalar("SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE '%ai_assistant%'"),'0');
  assert.equal(await db.scalar("SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'ai_assistant%'"),'0');
  assert.equal(await db.scalar('SELECT count(*) FROM public.raw_messages'),originalRaw);
  for(const f of ASSISTANT_MIGRATIONS)await db.exec(await Bun.file(join(ROOT,'supabase/migrations',f)).text());
  console.log('5 migrations apply/reapply/reverse rollback/reapply; raw_messages preserved: PASS');
} finally {await db.drop();console.log('DISPOSABLE DATABASE DROPPED')}

},30000);
