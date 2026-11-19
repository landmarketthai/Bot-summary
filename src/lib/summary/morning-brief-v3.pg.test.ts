/** Disposable loopback PostgreSQL only. Never supply a production URL. */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createSlipTestDb, probePg, ROOT, type SlipTestDb } from "@/lib/slips/testing/pg-slip-harness";
import { REVIEWED_MARKET_ALIASES, REVIEWED_MARKET_LABELS } from "@/lib/market";
import { morningBriefSlotMinute } from "./morning-brief-schedule";
import { baseTransactionType } from "./transactions";
import { qaMarketLabels } from "@/lib/sales/qa-scopes";
import { morningBriefMarket } from "./morning-brief-identity";
import type { LineApiMessage } from "@/lib/line/reply";

const available = await probePg();
if (!available && process.env.REQUIRE_MORNING_BRIEF_POSTGRES === "1") throw new Error("Morning Brief requires disposable local PostgreSQL 17; skipping is forbidden");
let db: SlipTestDb;
const date = "2026-11-16";
const target = "a".repeat(64);
const round = "00000000-0000-4000-8000-000000000001";
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
async function rpc(action: string, token?: string, payload?: object, part?: number) {
  const rows = await db.query<{ result: Record<string, unknown> }>(`SELECT public.morning_brief_delivery('${date}','vegetable','${target}',
    '${action}',${token ? quote(token) : "NULL"},${payload ? `${quote(JSON.stringify(payload))}::jsonb` : "NULL"},${part ?? "NULL"}) AS result`);
  return rows[0].result;
}
async function ready() {
  await db.exec(`INSERT INTO accountability_rounds(id,business_date,market_label,status) VALUES('${round}','${date}','พาซิโอ้ผัก','open');
    INSERT INTO produce_transactions(transaction_date,accountability_round_id,transaction_type)
      VALUES('${date}','${round}','เบิก'),('${date}','${round}','คืน');`);
}
const httpCommand = `SELECT net.http_get(url := 'https://vercel.invalid/api/cron/daily-morning-brief?scope=vegetable&date=__BRIEF_DATE__',
  headers := '{"Authorization":"Bearer synthetic"}'::jsonb, timeout_milliseconds := 15000)`;
const payload = { artifactPath: "synthetic.pdf", parts: [{ text: "text", key: "fixed-text" }, { text: "pdf", key: "fixed-pdf" }] };

describe.skipIf(!available)("Morning Brief V3 real PostgreSQL", () => {
  beforeAll(async () => {
    db = await createSlipTestDb("brief_v3", []);
    await db.exec(`CREATE TABLE accountability_rounds(id uuid PRIMARY KEY,business_date date,market_label text,status text,seller_label text);
      CREATE TABLE produce_transactions_all(transaction_date date,accountability_round_id uuid,transaction_type text,market_name text,voided_at timestamptz);
      -- Same effective-view predicate as P2E expand, also read by the app.
      CREATE VIEW produce_transactions AS SELECT * FROM produce_transactions_all WHERE voided_at IS NULL;
      CREATE TABLE pending_sessions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),session_key text NOT NULL UNIQUE,
        accountability_round_id uuid,business_date date,finalization_status text,declared_transaction_type text,accumulated_text text);
      CREATE TABLE line_guided_menu_markets(market_code text PRIMARY KEY,label text,active boolean DEFAULT true);
      CREATE TABLE line_guided_menu_market_aliases(alias_label text,market_code text,active boolean DEFAULT true);
      CREATE TABLE mock_http(business_date date);
      CREATE SCHEMA net;
      CREATE FUNCTION net.http_get(url text,headers jsonb DEFAULT '{}',timeout_milliseconds integer DEFAULT 5000)
      RETURNS bigint LANGUAGE plpgsql AS $$ BEGIN
        IF headers->>'Authorization' <> 'Bearer synthetic' OR timeout_milliseconds <> 15000 THEN
          RAISE EXCEPTION 'HTTP arguments changed';
        END IF;
        INSERT INTO mock_http VALUES (substring(url FROM 'date=([0-9-]+)')::date);
        RETURN 1;
      END $$;
      CREATE SCHEMA cron;
      CREATE TABLE cron.job(jobid bigserial PRIMARY KEY,jobname text UNIQUE,schedule text,command text,
        active boolean DEFAULT true,username text DEFAULT current_user);
      CREATE FUNCTION cron.schedule(job_name text,schedule text,command text) RETURNS bigint LANGUAGE sql AS $$
        INSERT INTO cron.job(jobname,schedule,command) VALUES($1,$2,$3) RETURNING jobid $$;
      CREATE FUNCTION cron.alter_job(job_id bigint,schedule text DEFAULT NULL,command text DEFAULT NULL,active boolean DEFAULT NULL)
      RETURNS void LANGUAGE sql AS $$ UPDATE cron.job SET schedule=coalesce($2,job.schedule),
        command=coalesce($3,job.command),active=coalesce($4,job.active) WHERE jobid=$1 $$;
      CREATE FUNCTION cron.unschedule(job_id bigint) RETURNS boolean LANGUAGE sql AS $$
        WITH removed AS (DELETE FROM cron.job WHERE jobid=$1 RETURNING jobid) SELECT EXISTS(SELECT 1 FROM removed) $$;
      CREATE FUNCTION accountability_round_market_code(p_label text) RETURNS text LANGUAGE sql STABLE AS $$
        SELECT coalesce((SELECT market_code FROM line_guided_menu_markets WHERE active AND label=$1),
          (SELECT market_code FROM line_guided_menu_market_aliases WHERE active AND alias_label=$1)) $$;`);
    for (const [index, label] of REVIEWED_MARKET_LABELS.entries()) {
      await db.exec(`INSERT INTO line_guided_menu_markets(market_code,label) VALUES('m${index}',${quote(label)});`);
    }
    for (const [alias, label] of Object.entries(REVIEWED_MARKET_ALIASES)) {
      await db.exec(`INSERT INTO line_guided_menu_market_aliases(alias_label,market_code)
        SELECT ${quote(alias)},market_code FROM line_guided_menu_markets WHERE label=${quote(label)};`);
    }
    // Exercise Supabase-like defaults; a GRANT SELECT alone cannot revoke writes.
    await db.exec("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role;");
    await db.exec("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role;");
    await db.exec(readFileSync(`${ROOT}/supabase/migrations/20261117090000_morning_brief_v3.sql`, "utf8"));
  }, 30_000);
  beforeEach(async () => { await db.exec("TRUNCATE accountability_rounds,produce_transactions_all,pending_sessions,morning_brief_deliveries,morning_brief_checks,morning_brief_private.morning_brief_dispatch_config,morning_brief_private.morning_brief_cron_backup,cron.job,mock_http;"); }, 15_000);
  afterAll(async () => { if (db) await db.drop(); }, 15_000);

  test("SQL and reporting identities agree, including targeted spelling and missing aliases", async () => {
    for (const label of [...REVIEWED_MARKET_LABELS, ...Object.keys(REVIEWED_MARKET_ALIASES), "หนูเล็ก-พาซีโอ้", "Pasio", "คนอื่น-พาซีโอ้", "พาซีโอ้ ผัก"]) {
      expect(await db.scalar(`SELECT coalesce(public.morning_brief_market(${quote(label)}),'')`)).toBe(morningBriefMarket(label));
    }
    expect(await db.scalar("SELECT morning_brief_market('พาซีโอ้','หนูเล็ก')")).toBe("พาซิโอ้ผัก");
    expect(await db.scalar("SELECT coalesce(morning_brief_market('พาซีโอ้','คนอื่น'),'')")).toBe("");
  });
  test("effective view excludes voided pair and unbound ambiguity from SQL and app readiness", async () => {
    const { morningBriefReadiness } = await import("./morning-brief-service");
    const appStatus = async () => morningBriefReadiness(await db.query<{accountability_round_id: string | null; transaction_type: string}>(
      "SELECT accountability_round_id,transaction_type FROM produce_transactions"), "vegetable").status;
    await ready();
    await db.exec(`INSERT INTO produce_transactions_all(transaction_date,accountability_round_id,transaction_type,market_name,voided_at)
      VALUES('${date}',NULL,'เบิก','พาซิโอ้',now()),('${date}','${round}','ชั่งคืนเพิ่ม','พาซิโอ้ผัก',now());`);
    expect(await db.scalar("SELECT count(*) FROM produce_transactions")).toBe("2");
    expect(await db.scalar(`SELECT morning_brief_context('${date}','vegetable')->'readiness'->>'status'`)).toBe("ready");
    expect(await appStatus()).toBe("ready");
    await db.exec("UPDATE produce_transactions_all SET voided_at=now() WHERE transaction_type='คืน';");
    expect(await db.scalar(`SELECT morning_brief_context('${date}','vegetable')->'readiness'->>'status'`)).toBe("not_ready");
    expect(await appStatus()).toBe("not_ready");
  });
  test("open persisted pair waits for every pending type; only resolved statuses unblock", async () => {
    await ready();
    for (const kind of ["ชั่งคืนเพิ่ม","คืนเสีย","เบิก", "unknown", null]) {
      await db.exec(`TRUNCATE pending_sessions; INSERT INTO pending_sessions(session_key,accountability_round_id,business_date,declared_transaction_type,finalization_status,accumulated_text)
        VALUES('synthetic','${round}','${date}',${kind ? quote(kind) : "NULL"},'pending','จบรายการคืน');`);
      expect(await db.scalar(`SELECT morning_brief_context('${date}','vegetable')->'readiness'->'reasons' ? 'unresolved_vegetable_document'`)).toBe("true");
      expect(await db.scalar(`SELECT morning_brief_context('${date}','fruit')->'readiness'->>'status'`)).toBe("ready");
    }
    for (const status of ["finalized","duplicate","expired_empty_draft","failed_closed", "unknown", null]) {
      await db.exec(`UPDATE pending_sessions SET finalization_status=${status ? quote(status) : "NULL"};`);
      expect(await db.scalar(`SELECT morning_brief_context('${date}','vegetable')->'readiness'->>'status'`))
        .toBe(["finalized","duplicate","expired_empty_draft"].includes(status ?? "") ? "ready" : "not_ready");
    }
    const other = '00000000-0000-4000-8000-000000000003';
    await db.exec(`INSERT INTO accountability_rounds VALUES('${other}','${date}','ตลาดใหม่','open','synthetic');
      UPDATE pending_sessions SET accountability_round_id='${other}';`);
    expect(await db.scalar(`SELECT morning_brief_context('${date}','vegetable')->'readiness'->>'status'`)).toBe("ready");
    await db.exec(`UPDATE accountability_rounds SET market_label='พาซิโอ้' WHERE id='${other}';`);
    expect(await db.scalar(`SELECT morning_brief_context('${date}','vegetable')->'readiness'->>'status'`)).toBe("not_ready");
    await db.exec(`UPDATE accountability_rounds SET status='cancelled' WHERE id='${other}';`);
    expect(await db.scalar(`SELECT morning_brief_context('${date}','vegetable')->'readiness'->>'status'`)).toBe("ready");
  });
  test("private target parity is exact and count-only; absent/disabled config fails closed", async () => {
    const parity = async (keys: readonly string[]) => JSON.parse(await db.scalar(`SELECT morning_brief_target_parity('fruit',ARRAY[${keys.map(quote).join(',')}]::text[])`));
    expect((await parity([target])).matched).toBe(false);
    await db.exec(`INSERT INTO morning_brief_private.morning_brief_dispatch_config VALUES('fruit',false,ARRAY['${target}'],${quote(httpCommand)});`);
    expect((await parity([target])).matched).toBe(false);
    await db.exec("UPDATE morning_brief_private.morning_brief_dispatch_config SET enabled=true;");
    expect(await parity([target])).toEqual({matched:true, configuredCount:1,requestedCount:1,missingCount:0,excessCount:0});
    for (const [keys, missing, excess] of [[[],1,0],[["b".repeat(64)],1,1],[[target,"b".repeat(64)],0,1]] as const) {
      const result = await parity(keys);
      expect(result.matched).toBe(false);
      expect(result.missingCount).toBe(missing);
      expect(result.excessCount).toBe(excess);
      expect(JSON.stringify(result)).not.toContain(target);
    }
  });
  test("SQL slot identity agrees at second boundaries and delayed arrivals", async () => {
    for (const scope of ["fruit","vegetable"] as const) {
      for (const time of ["11:59:59","12:00:59","12:01:30","12:04:59","12:05:00","14:00:59","14:04:59","14:05:00","14:31:30","18:04:59","18:05:00"]) {
        const instant = `2026-11-17T${time}+07:00`;
        expect(await db.scalar(`SELECT coalesce(morning_brief_slot('${scope}',${quote(instant)})::text,'outside')`))
          .toBe(String(morningBriefSlotMinute(scope, Date.parse(instant)) ?? "outside"));
      }
    }
    for (const time of ["12:00:59","12:01:30","12:04:59"]) {
      expect(await db.scalar(`SELECT morning_brief_should_invoke('${date}','fruit',ARRAY['${target}'],'2026-11-17T${time}+07')`)).toBe("true");
    }
  });
  test("transaction vocabulary and QA exclusions match the TypeScript authority", async () => {
    await ready();
    await db.exec("DELETE FROM produce_transactions WHERE transaction_type='คืน';");
    for (const kind of ["คืน","ชั่งคืนเพิ่ม","คืนเสีย","เสีย","คืนเสียเพิ่ม","เบิก","เบิกเพิ่ม","unknown", " คืน "]) {
      await db.exec(`DELETE FROM produce_transactions WHERE transaction_type<>'เบิก';
        INSERT INTO produce_transactions(transaction_date,accountability_round_id,transaction_type) VALUES('${date}','${round}',${quote(kind)});`);
      expect(await db.scalar(`SELECT morning_brief_context('${date}','vegetable')->'readiness'->>'status'`))
        .toBe(baseTransactionType(kind)==="คืน" ? "ready" : "not_ready");
    }
    await db.exec("TRUNCATE accountability_rounds,produce_transactions_all;");
    await ready();
    for (const label of qaMarketLabels().flatMap((label) => [label, ` ${label} `, label.normalize("NFD")])) {
      await db.exec(`INSERT INTO produce_transactions(transaction_date,market_name,transaction_type) VALUES('${date}',${quote(label)},'เบิก');`);
    }
    expect(await db.scalar(`SELECT morning_brief_context('${date}','vegetable')->'readiness'->>'status'`)).toBe("ready");
  });
  test("only plausible vegetable ambiguity blocks; cancelled and wrong-date sources remain reviewable", async () => {
    await ready();
    await db.exec(`INSERT INTO produce_transactions(transaction_date,market_name,transaction_type) VALUES('${date}','ตลาดใหม่','เบิก');`);
    await db.exec(`INSERT INTO produce_transactions(transaction_date,market_name,transaction_type) VALUES('${date}','พาซิโอ้ผลไม้','เบิก');`);
    expect(await db.scalar(`SELECT morning_brief_context('${date}','vegetable')->'readiness'->>'status'`)).toBe("ready");
    await db.exec(`INSERT INTO produce_transactions(transaction_date,market_name,transaction_type) VALUES('${date}','พาซิโอ้','เบิก');`);
    expect(await db.scalar(`SELECT morning_brief_context('${date}','vegetable')->'readiness'->'reasons' ? 'unbound_vegetable_round'`)).toBe("true");
    await db.exec("DELETE FROM produce_transactions WHERE accountability_round_id IS NULL;");
    await db.exec(`UPDATE accountability_rounds SET status='cancelled';`);
    expect(await db.scalar(`SELECT morning_brief_context('${date}','fruit')->'roundIssues'->>'${round}'`)).toBe("cancelled_round");
    expect(await db.scalar(`SELECT morning_brief_context('${date}','vegetable')->'readiness'->'reasons' ? 'cancelled_vegetable_round'`)).toBe("true");
    await db.exec(`UPDATE accountability_rounds SET status='open',business_date='2026-11-15';`);
    expect(await db.scalar(`SELECT morning_brief_context('${date}','fruit')->'roundIssues'->>'${round}'`)).toBe("round_date_mismatch");
  });
  test("late return, additional known empty round and cancelled round are handled explicitly", async () => {
    await ready();
    expect(await db.scalar(`SELECT morning_brief_context('${date}','vegetable')->'readiness'->>'status'`)).toBe("ready");
    await db.exec(`DELETE FROM produce_transactions WHERE transaction_type='คืน';`);
    expect(await db.scalar(`SELECT morning_brief_context('${date}','vegetable')->'readiness'->>'status'`)).toBe("not_ready");
    await db.exec(`INSERT INTO produce_transactions(transaction_date,accountability_round_id,transaction_type) VALUES('${date}','${round}','ชั่งคืนเพิ่ม');
      INSERT INTO accountability_rounds(id,business_date,market_label,status) VALUES('00000000-0000-4000-8000-000000000002','${date}','พาซิโอ้ผัก','open');`);
    expect(await db.scalar(`SELECT morning_brief_context('${date}','vegetable')->'readiness'->>'status'`)).toBe("not_ready");
    await db.exec("UPDATE accountability_rounds SET status='cancelled' WHERE id='00000000-0000-4000-8000-000000000002';");
    expect(await db.scalar(`SELECT morning_brief_context('${date}','vegetable')->'readiness'->>'status'`)).toBe("ready");
    expect(await db.scalar(`SELECT morning_brief_context('${date}','fruit')->'readiness'->>'status'`)).toBe("ready");
  });
  test("exact window and previous acceptance gate HTTP eligibility", async () => {
    await ready();
    for (const [time, expected] of [["13:59",false],["14:00",true],["14:30",true],["18:00",true],["18:01",true],["18:04",true],["18:05",false],["18:30",false]] as const) {
      expect(await db.scalar(`SELECT morning_brief_should_invoke('${date}','vegetable',ARRAY['${target}'],'2026-11-17T${time}:00+07')`)).toBe(String(expected));
    }
    const claim = await rpc("claim");
    await rpc("freeze",String(claim.lease_token),payload);
    for (let index=0;index<2;index++) { await rpc("prepare",String(claim.lease_token),undefined,index); await rpc("accept",String(claim.lease_token),undefined,index); }
    expect(await db.scalar(`SELECT morning_brief_should_invoke('${date}','vegetable',ARRAY['${target}'],'2026-11-17T14:00:00+07')`)).toBe("false");
  });
  test("simultaneous claims have one winner; stale tokens cannot acknowledge", async () => {
    // Independent psql sessions exercise real overlapping transactions. Bun.SQL
    // concurrent pool acquisition can hang on Windows even after SQL completes.
    await db.exec("CREATE TABLE IF NOT EXISTS mock_claim_results(result jsonb NOT NULL); TRUNCATE mock_claim_results;");
    await Promise.all(Array.from({length:3}, () => db.exec(
      `INSERT INTO mock_claim_results SELECT public.morning_brief_delivery('${date}','vegetable','${target}','claim');`,
    )));
    const claims = (await db.query<{ result: Record<string, unknown> }>("SELECT result FROM mock_claim_results")).map((row) => row.result);
    expect(claims).toHaveLength(3);
    expect(claims.filter((claim) => claim.state === "busy")).toHaveLength(2);
    expect(claims.filter((claim) => claim.state === "pending")).toHaveLength(1);
    const first = claims.find((claim) => claim.state === "pending")!;
    await rpc("freeze",String(first.lease_token),payload);
    await db.exec("UPDATE morning_brief_deliveries SET lease_until=now()-interval '1 second';");
    const second = await rpc("claim");
    expect(second.lease_token).not.toBe(first.lease_token);
    await expect(db.exec(`SELECT public.morning_brief_delivery('${date}','vegetable','${target}','prepare','${first.lease_token}',NULL,0);`)).rejects.toThrow("lost delivery lease");
    expect(second.payload).toEqual(payload);
  });
  test("invalid payloads cannot be frozen and recovery preflight only allows the first slot", async () => {
    const claim = await rpc("claim");
    for (const invalid of [{}, { parts: null }, { parts: [] }]) {
      await expect(db.exec(`SELECT public.morning_brief_delivery('${date}','vegetable','${target}','freeze','${claim.lease_token}',${quote(JSON.stringify(invalid))}::jsonb);`)).rejects.toThrow("missing delivery parts");
    }
    await rpc("release",String(claim.lease_token));
    await ready();
    for (const [time, expected] of [["14:00","true"],["14:30","false"],["18:00","false"]]) {
      expect(await db.scalar(`SELECT morning_brief_should_invoke('${date}','vegetable',ARRAY['${target}'],'2026-11-18T${time}:00+07')`)).toBe(expected);
    }
    for (const historical of ["2026-11-11","2026-11-12","2026-11-15"]) {
      expect(await db.scalar(`SELECT morning_brief_should_invoke('${historical}','vegetable',ARRAY['${target}'],'2026-11-18T14:00:00+07')`)).toBe("false");
    }
  });
  test("partial acceptance persists; unknown response reuses the same part then expires to review", async () => {
    const first = await rpc("claim"); const token = String(first.lease_token);
    await rpc("freeze",token,payload);
    await rpc("prepare",token,undefined,0); await rpc("accept",token,undefined,0);
    await rpc("prepare",token,undefined,1); await rpc("release",token);
    const retry = await rpc("claim");
    expect(retry.next_part).toBe(1); expect(retry.payload).toEqual(payload);
    await rpc("release",String(retry.lease_token));
    // Frozen retries remain eligible even if current source data is no longer ready.
    expect(await db.scalar(`SELECT morning_brief_should_invoke('${date}','vegetable',ARRAY['${target}'],'2026-11-17T14:00:00+07')`)).toBe("true");
    const resumed = await rpc("claim");
    await db.exec("UPDATE morning_brief_deliveries SET first_attempt_at=now()-interval '23 hours';");
    expect((await rpc("prepare",String(resumed.lease_token),undefined,1)).state).toBe("needs_review");
  });
  test("frozen never-attempted URLs stop before their seven-day expiry", async () => {
    const claim = await rpc("claim");
    await rpc("freeze",String(claim.lease_token),payload);
    await db.exec("UPDATE morning_brief_deliveries SET frozen_at=now()-interval '6 days';");
    const result = await rpc("prepare",String(claim.lease_token),undefined,0);
    expect(result.state).toBe("needs_review");
    expect(result.payload).toEqual(payload);
    expect(result.first_attempt_at).toBeNull();
  });
  test("day-two recovery respects the 23h limit for Fruit and early Vegetable attempts", async () => {
    await ready();
    for (const [scope, first, recovery, eligible] of [
      ["fruit","12:00","12:01:30",false],
      ["vegetable","14:00","14:01:30",false],
      ["vegetable","18:04","14:04:59",true],
    ] as const) {
      await db.exec(`DELETE FROM morning_brief_deliveries;
        INSERT INTO morning_brief_deliveries(business_date,scope,target_key,payload,first_attempt_at)
        VALUES('${date}','${scope}','${target}',${quote(JSON.stringify(payload))}::jsonb,'2026-11-17T${first}:00+07');`);
      expect(await db.scalar(`SELECT morning_brief_should_invoke('${date}','${scope}',ARRAY['${target}'],'2026-11-18T${recovery}+07')`)).toBe(String(eligible));
    }
  });
  test("migration is inert and unauthorized roles cannot dispatch or mutate delivery rows", async () => {
    expect(await db.scalar("SELECT count(*) FROM morning_brief_private.morning_brief_dispatch_config")).toBe("0");
    expect(await db.scalar("SELECT has_function_privilege('service_role','morning_brief_dispatch(text,timestamptz)','EXECUTE')")).toBe("false");
    expect(await db.scalar("SELECT has_table_privilege('anon','morning_brief_deliveries','SELECT')")).toBe("false");
    expect(await db.scalar("SELECT has_table_privilege('service_role','morning_brief_deliveries','UPDATE')")).toBe("false");
    for (const role of ["anon","authenticated","service_role"]) {
      expect(await db.scalar(`SELECT has_schema_privilege('${role}','morning_brief_private','USAGE')`)).toBe("false");
    }
    expect(await db.scalar("SELECT count(*) FROM pg_class WHERE relname IN ('morning_brief_deliveries','morning_brief_checks','morning_brief_dispatch_config','morning_brief_cron_backup') AND relrowsecurity")).toBe("4");
    for (const role of ["anon","authenticated"]) {
      for (const signature of ["morning_brief_slot(text,timestamptz)","morning_brief_market(text,text)",
        "morning_brief_context(date,text)","morning_brief_delivery(date,text,text,text,uuid,jsonb,integer)",
        "morning_brief_should_invoke(date,text,text[],timestamptz)","morning_brief_delivery_status(date,text,text[],timestamptz)",
        "morning_brief_target_parity(text,text[])","morning_brief_dispatch(text,timestamptz)"]) {
        expect(await db.scalar(`SELECT has_function_privilege('${role}','${signature}','EXECUTE')`)).toBe("false");
      }
      await expect(db.exec(`SET ROLE ${role}; SELECT morning_brief_context('${date}','vegetable');`)).rejects.toThrow("permission denied");
      await expect(db.exec(`SET ROLE ${role}; SELECT morning_brief_delivery('${date}','vegetable','${target}','claim');`)).rejects.toThrow("permission denied");
    }
    await expect(db.exec("SET ROLE service_role; SELECT morning_brief_dispatch('vegetable');")).rejects.toThrow("permission denied");
    await expect(db.exec(`SET ROLE service_role; SELECT morning_brief_context('${date}','vegetable');`)).resolves.toBeUndefined();
  });
  test("preserved pg_net statement queues only ready and unaccepted reports", async () => {
    const command = `SELECT net.http_get(url := 'https://vercel.invalid/api/cron/daily-morning-brief?scope=vegetable&date=__BRIEF_DATE__',
      headers := '{"Authorization":"Bearer synthetic"}'::jsonb, timeout_milliseconds := 15000)`;
    await db.exec(`INSERT INTO morning_brief_private.morning_brief_dispatch_config VALUES('vegetable',true,ARRAY['${target}'],${quote(command)});`);
    await db.exec("SELECT morning_brief_dispatch('vegetable','2026-11-17T14:00:00+07');");
    expect(await db.scalar("SELECT count(*) FROM mock_http")).toBe("0");
    await ready();
    await Promise.all(Array.from({length:8}, (_, index) => db.exec(`SELECT morning_brief_dispatch('vegetable','2026-11-17T14:${index % 2 ? "31:30" : "34:59"}+07');`)));
    expect(await db.scalar("SELECT count(*) FROM mock_http")).toBe("1");
    expect(await db.scalar("SELECT outcome FROM morning_brief_checks WHERE slot=870")).toBe("invoked");
    const claim = await rpc("claim");
    await rpc("freeze",String(claim.lease_token),payload);
    for (let part=0;part<2;part++) {
      await rpc("prepare",String(claim.lease_token),undefined,part);
      await rpc("accept",String(claim.lease_token),undefined,part);
    }
    await db.exec("SELECT morning_brief_dispatch('vegetable','2026-11-17T15:00:00+07');");
    expect(await db.scalar("SELECT count(*) FROM mock_http")).toBe("1");
    expect(await db.scalar("SELECT outcome FROM morning_brief_checks WHERE slot=900")).toBe("accepted");
  });
  test("private templates reject arbitrary and multiple statements", async () => {
    for (const command of ["SELECT '__BRIEF_DATE__'", `${httpCommand}; SELECT 1`, `${httpCommand} -- __BRIEF_DATE__`]) {
      await expect(db.exec(`INSERT INTO morning_brief_private.morning_brief_dispatch_config VALUES('fruit',false,ARRAY['${target}'],${quote(command)});`)).rejects.toThrow("Invalid private Morning Brief dispatch configuration");
    }
    for (const keys of ["ARRAY['not-a-hash']", `ARRAY['${target}','${target}']`, "ARRAY[NULL]::text[]"]) {
      await expect(db.exec(`INSERT INTO morning_brief_private.morning_brief_dispatch_config VALUES('fruit',false,${keys},${quote(httpCommand)});`)).rejects.toThrow("Invalid private Morning Brief dispatch configuration");
    }
  });
  test("scheduled observations distinguish busy, review and sanitized enqueue failure", async () => {
    await ready();
    await db.exec(`INSERT INTO morning_brief_private.morning_brief_dispatch_config VALUES('vegetable',true,ARRAY['${target}'],${quote(httpCommand)});`);
    await rpc("claim");
    await db.exec("SELECT morning_brief_dispatch('vegetable','2026-11-17T14:00:00+07');");
    expect(await db.scalar("SELECT outcome FROM morning_brief_checks WHERE slot=840")).toBe("busy");
    await db.exec("UPDATE morning_brief_deliveries SET first_attempt_at='2026-11-16T14:00:00+07'; SELECT morning_brief_dispatch('vegetable','2026-11-17T14:30:00+07');");
    expect(await db.scalar("SELECT outcome FROM morning_brief_checks WHERE slot=870")).toBe("review");
    await db.exec(`DELETE FROM morning_brief_deliveries;
      UPDATE morning_brief_private.morning_brief_dispatch_config SET command_template=${quote(httpCommand.replace('15000','1'))};
      SELECT morning_brief_dispatch('vegetable','2026-11-17T15:00:00+07');`);
    expect(await db.scalar("SELECT outcome FROM morning_brief_checks WHERE slot=900")).toBe("enqueue_failed");
    expect(await db.scalar("SELECT count(*) FROM mock_http")).toBe("0");
    await db.exec("SELECT morning_brief_dispatch('vegetable','2026-11-17T15:00:00+07');");
    expect(await db.scalar("SELECT count(*) FROM morning_brief_checks")).toBe("3");
  });
  test("activation preserves suspended jobs and rollback requires backups and keeps delivery suspended", async () => {
    const activation = readFileSync(`${ROOT}/docs/morning-brief-v3/activate.sql`,"utf8");
    const rollback = readFileSync(`${ROOT}/docs/morning-brief-v3/rollback.sql`,"utf8");
    await expect(db.exec(activation)).rejects.toThrow("requires operator review");
    await expect(db.exec(`SET morning_brief_v3.rollback='reviewed'; ${rollback}`)).rejects.toThrow("two original job backups");
    await db.exec(`SELECT cron.schedule('daily-morning-brief','0 5 * * *','SELECT ''/api/cron/daily-morning-brief''');
      SELECT cron.schedule('daily-morning-brief-vegetable','0 7 * * *','SELECT ''/api/cron/daily-morning-brief?scope=vegetable''');
      UPDATE cron.job SET active=false;
      INSERT INTO morning_brief_private.morning_brief_dispatch_config VALUES('fruit',false,ARRAY['${target}'],${quote(httpCommand)}),
        ('vegetable',false,ARRAY['${target}'],${quote(httpCommand)});
      SELECT cron.schedule('daily-morning-brief-vegetable-v3-final','0 0 * * *','SELECT ''unrelated''');`);
    await expect(db.exec(`SET morning_brief_v3.activate='reviewed'; SET cron.timezone='UTC'; ${activation}`)).rejects.toThrow("Reserved final-slot job");
    expect(await db.scalar("SELECT count(*) FROM morning_brief_private.morning_brief_cron_backup")).toBe("0");
    await db.exec("DELETE FROM cron.job WHERE jobname='daily-morning-brief-vegetable-v3-final';");
    await db.exec("UPDATE cron.job SET schedule='0 8 * * *' WHERE jobname='daily-morning-brief-vegetable';");
    await expect(db.exec(`SET morning_brief_v3.activate='reviewed'; SET cron.timezone='UTC'; ${activation}`)).rejects.toThrow("Existing schedule/command differs");
    await db.exec("UPDATE cron.job SET schedule='0 7 * * *' WHERE jobname='daily-morning-brief-vegetable';");
    await db.exec(`SET morning_brief_v3.activate='reviewed'; SET cron.timezone='UTC'; ${activation}`);
    expect(await db.scalar("SELECT count(*) FROM cron.job WHERE active")).toBe("0");
    expect(await db.scalar("SELECT schedule FROM cron.job WHERE jobname='daily-morning-brief'")).toBe("0 5 * * *");
    expect(await db.scalar("SELECT schedule FROM cron.job WHERE jobname='daily-morning-brief-vegetable'")).toBe("0,30 7-10 * * *");
    expect(await db.scalar("SELECT schedule FROM cron.job WHERE jobname='daily-morning-brief-vegetable-v3-final'")).toBe("0 11 * * *");
    await db.exec(`SET morning_brief_v3.rollback='reviewed'; ${rollback}`);
    expect(await db.scalar("SELECT count(*) FROM cron.job")).toBe("2");
    expect(await db.scalar("SELECT count(*) FROM cron.job WHERE active")).toBe("0");
    expect(await db.scalar("SELECT count(*) FROM morning_brief_private.morning_brief_dispatch_config WHERE enabled")).toBe("0");
    expect(await db.scalar("SELECT schedule FROM cron.job WHERE jobname='daily-morning-brief-vegetable'")).toBe("0 7 * * *");
  });
  test("dispatch skips HTTP while unready, bounds slots, and recovers only one day", async () => {
    await db.exec(`INSERT INTO morning_brief_private.morning_brief_dispatch_config VALUES('vegetable',true,ARRAY['${target}'],
      ${quote(httpCommand)});`);
    for (const time of ["14:00","14:30","15:00","15:30","16:00","16:30","17:00","17:30","18:00","18:30"]) {
      await db.exec(`SELECT morning_brief_dispatch('vegetable','2026-11-17T${time}:00+07');`);
    }
    expect(await db.scalar("SELECT count(*) FROM mock_http")).toBe("0");
    expect(await db.scalar("SELECT count(*) FROM morning_brief_checks")).toBe("9");
    expect(await db.scalar("SELECT count(*) FROM morning_brief_checks WHERE outcome='not_ready'")).toBe("9");
    await ready();
    for (const time of ["14:00","14:00","14:30","18:30"]) {
      await db.exec(`SELECT morning_brief_dispatch('vegetable','2026-11-18T${time}:00+07');`);
    }
    expect(await db.scalar(`SELECT count(*) FROM mock_http WHERE business_date='${date}'`)).toBe("1");
    await db.exec("SELECT morning_brief_dispatch('vegetable','2026-11-19T14:00:00+07');");
    expect(await db.scalar(`SELECT count(*) FROM mock_http WHERE business_date='${date}'`)).toBe("1");
  });

  // Run this file in its own Bun process: only external I/O/report construction is mocked.
  test("real route uses SQL context, preflight and fenced ledger, including missing-RPC and frozen retry", async () => {
    const calls: { text: string; key: string; message: LineApiMessage | undefined }[] = [];
    const pdfOrigin = "https://storage.example.invalid";
    const pdfBucket = "morning-brief-pdfs";
    const pdfFilename = "synthetic.pdf";
    let failPdf = true;
    let renders = 0;
    await db.exec("CREATE TABLE mock_route_rpc_results(call_key text PRIMARY KEY,result jsonb);");
    const client = { rpc: async (name: string, args: Record<string, unknown>) => {
      const literal = (value: unknown): string => value == null ? "NULL"
        : Array.isArray(value) ? `ARRAY[${value.map((item) => quote(String(item))).join(",")}]::text[]`
        : typeof value === "object" ? `${quote(JSON.stringify(value))}::jsonb`
        : typeof value === "number" ? String(value) : quote(String(value));
      try {
        const callKey = crypto.randomUUID();
        // Use independent psql for the expected missing-RPC error path (Windows Bun.SQL can hang on errors).
        await db.exec(`INSERT INTO mock_route_rpc_results SELECT ${quote(callKey)},to_jsonb(public.${name}(${Object.entries(args).map(([key,value]) => `${key} => ${literal(value)}`).join(",")}));`);
        const result = await db.query<{ result: unknown }>(`SELECT result FROM mock_route_rpc_results WHERE call_key=${quote(callKey)}`);
        return { data: result[0].result, error: null };
      } catch { return { data: null, error: { message: "synthetic SQL failure" } }; }
    } };
    mock.module("@/lib/supabase/server", () => ({ createServiceClient: () => client }));
    mock.module("@/lib/summary/morning-brief-service", () => ({ loadMorningBriefReport: async () => ({ businessDate: date, reportScope: "fruit", readiness: { status: "ready", reasons: [] } }) }));
    mock.module("@/lib/summary/morning-brief-message", () => ({ buildMorningBriefMessages: () => ["synthetic text"] }));
    mock.module("@/lib/summary/morning-brief-pdf", () => ({
      MORNING_BRIEF_PDF_BUCKET: pdfBucket,
      createMorningBriefPdfArtifact: async () => {
        renders++;
        return {
          bucket: pdfBucket, path: pdfFilename, filename: pdfFilename,
          signedUrl: `${pdfOrigin}/storage/v1/object/sign/${pdfBucket}/${pdfFilename}?token=synthetic&download=${pdfFilename}`,
        };
      },
      morningBriefPdfLineMessage: () => "synthetic PDF",
    }));
    mock.module("@/lib/line/reply", () => ({ pushLineMessage: async (_target: string, text: string, key: string, options?: { message?: LineApiMessage }) => {
      calls.push({ text, key, message: options?.message });
      if (text === "synthetic PDF" && failPdf) throw new Error("synthetic unknown provider outcome");
    } }));
    const { NextRequest } = await import("next/server");
    const { GET } = await import("@/app/api/cron/daily-morning-brief/route");
    const originalNow = Date.now;
    const originalSecret = process.env.CRON_SECRET;
    const originalTargets = process.env.MORNING_BRIEF_LINE_TARGETS;
    const originalSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.CRON_SECRET = "synthetic-contract";
    process.env.MORNING_BRIEF_LINE_TARGETS = "Csynthetic";
    Date.now = () => Date.parse("2026-11-17T12:01:30+07:00");
    await db.exec(`INSERT INTO morning_brief_private.morning_brief_dispatch_config VALUES('fruit',true,ARRAY['${(await import('./morning-brief-delivery')).briefTargetKey('Csynthetic')}'],${quote(httpCommand)});`);
    const request = () => new NextRequest(`http://localhost/api/cron/daily-morning-brief?date=${date}`, { headers: { authorization: "Bearer synthetic-contract" } });
    try {
      process.env.NEXT_PUBLIC_SUPABASE_URL = pdfOrigin;
      await db.exec("ALTER FUNCTION morning_brief_context(date,text) RENAME TO synthetic_hidden_context;");
      try {
        const response = await GET(request());
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ status: "schema_unavailable", stage: "context" });
        expect(await db.scalar("SELECT count(*) FROM morning_brief_deliveries")).toBe("0");
        expect(renders).toBe(0); expect(calls).toHaveLength(0);
      } finally { await db.exec("ALTER FUNCTION synthetic_hidden_context(date,text) RENAME TO morning_brief_context;"); }
      expect((await GET(request())).status).toBe(500);
      expect(await db.scalar("SELECT next_part FROM morning_brief_deliveries")).toBe("1");
      failPdf = false;
      expect((await GET(request())).status).toBe(200);
      expect(await db.scalar("SELECT state FROM morning_brief_deliveries")).toBe("accepted");
      expect(calls.map((call) => call.text)).toEqual(["synthetic text", "synthetic PDF", "synthetic PDF"]);
      expect(calls[1].message).toMatchObject({ type: "flex" });
      expect(calls[2]).toEqual(calls[1]);
      expect(renders).toBe(1);
      await GET(request());
      expect(calls).toHaveLength(3);
    } finally {
      Date.now = originalNow;
      if (originalSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = originalSecret;
      if (originalTargets === undefined) delete process.env.MORNING_BRIEF_LINE_TARGETS; else process.env.MORNING_BRIEF_LINE_TARGETS = originalTargets;
      if (originalSupabaseUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = originalSupabaseUrl;
    }
  });
});
