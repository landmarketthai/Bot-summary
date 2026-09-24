/** PostgreSQL 17 proof for durable, timestamp-ordered Produce admission. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";

const ROOT = join(import.meta.dir, "..", "..", "..");
const WIN_PSQL = "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe";
const PSQL = existsSync(WIN_PSQL) ? WIN_PSQL : "psql";
const PGHOST = process.env.PGHOST ?? "localhost";
const PGUSER = process.env.PGUSER ?? "postgres";
const PGPASSWORD = process.env.PGPASSWORD ?? "postgres";
const PGPORT = process.env.PGPORT ?? "5432";
const DATABASE = `produce_reorder_${randomBytes(4).toString("hex")}`;
const SAFE_DATABASE = /^produce_reorder_[a-f0-9]+$/;
const SAFE_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

type PsqlResult = { code: number; stdout: string; stderr: string };
async function psql(args: string[], database = DATABASE, stdin?: string): Promise<PsqlResult> {
  const proc = Bun.spawn([PSQL, "-X", ...args], {
    cwd: ROOT,
    stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
    env: {
      ...process.env,
      PGHOST,
      PGUSER,
      PGPASSWORD,
      PGPORT,
      PGDATABASE: database,
      PGCLIENTENCODING: "UTF8",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function scalar(sql: string): Promise<string> {
  const result = await psql(["-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"], DATABASE, sql);
  if (result.code !== 0) throw new Error(`${result.stderr || result.stdout}\nSQL: ${sql}`);
  return result.stdout.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

async function apply(file: string): Promise<void> {
  const result = await psql(["-v", "ON_ERROR_STOP=1", "-f", file]);
  expect(result.code, `${file}\n${result.stderr}\n${result.stdout}`).toBe(0);
}

async function probe(): Promise<boolean> {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1" || !SAFE_HOSTS.has(PGHOST)) return false;
  try {
    const result = await psql(["-tAc", "SHOW server_version_num"], "postgres");
    return result.code === 0 && Number(result.stdout.trim()) >= 170000;
  } catch {
    return false;
  }
}

function q(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const SOURCE = "C629b6b615240bd9c9c882af560d315e1";
const USER = "U3f04f748584d997819dec0fc71a9b084";
const keyFor = (suffix: string, user = USER, source = SOURCE) =>
  `group:${source}:${suffix}:user:${user}`;

async function raw(eventId: string, text: string): Promise<string> {
  return scalar(`WITH inserted AS (
      INSERT INTO public.raw_messages(line_event_id, raw_text)
      VALUES (${q(eventId)}, ${q(text)}) ON CONFLICT (line_event_id) DO NOTHING RETURNING id
    ) SELECT id FROM inserted UNION ALL
      SELECT id FROM public.raw_messages WHERE line_event_id=${q(eventId)} LIMIT 1`);
}

async function item(options: {
  key: string; eventId: string; timestamp: number; text?: string;
  user?: string; source?: string;
}): Promise<Record<string, unknown>> {
  const text = options.text ?? "1อะโวคาโด้50บาท\n26.7.โล";
  const rawId = await raw(options.eventId, text);
  return JSON.parse(await scalar(`SELECT public.append_or_defer_pending_produce_item(
    ${q(rawId)}::uuid, ${q(options.key)}, ${q(options.source ?? SOURCE)},
    ${q(options.user ?? USER)}, ${q(options.eventId)}, ${options.timestamp},
    ${q(text)}, 'reply-${options.eventId}', 'development')`));
}

async function open(options: {
  key: string; eventId: string; timestamp: number; text?: string; close?: boolean;
  user?: string; source?: string; expectedGeneration?: string;
}): Promise<Record<string, unknown>> {
  return JSON.parse(await scalar(`SELECT public.open_pending_plain_text_generation(
    ${q(options.key)}, ${q(options.source ?? SOURCE)}, ${q(options.user ?? USER)},
    ${q(options.eventId)}, ${options.timestamp},
    ${q(options.text ?? "แทน-ราชพฤกษ์ เบิก 15/8/2569")},
    'reply-${options.eventId}', ${options.close ? "true" : "false"}, NULL,
    ${options.expectedGeneration ? `${q(options.expectedGeneration)}::uuid` : "NULL::uuid"},
    'development')`));
}

const pgAvailable = await probe();
let databaseCreated = false;
if (!pgAvailable && process.env.REQUIRE_PRODUCE_REORDER_POSTGRES === "1") {
  throw new Error("PostgreSQL 17 Produce reorder harness is unavailable");
}

describe.skipIf(!pgAvailable)("Produce out-of-order admission on PostgreSQL 17", () => {
  beforeAll(async () => {
    if (!SAFE_DATABASE.test(DATABASE) || !SAFE_HOSTS.has(PGHOST)) throw new Error("unsafe PG target");
    const created = await psql(["-d", "postgres", "-c", `CREATE DATABASE ${DATABASE}`], "postgres");
    expect(created.code, created.stderr).toBe(0);
    databaseCreated = true;
    await scalar(`
      DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      CREATE TABLE public.raw_messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), line_event_id text UNIQUE NOT NULL,
        raw_text text, is_processed boolean NOT NULL DEFAULT false
      );
      CREATE TABLE public.pending_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_key text UNIQUE NOT NULL,
        source_id text, accumulated_text text NOT NULL DEFAULT '', latest_reply_token text,
        line_user_id text, created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(), session_generation uuid NOT NULL DEFAULT gen_random_uuid(),
        close_event_timestamp_ms bigint, close_requested_at timestamptz, close_line_event_id text,
        close_finalize_started_at timestamptz, terminalized boolean NOT NULL DEFAULT false,
        next_attempt_at timestamptz, close_deadline_at timestamptz, close_session_generation uuid,
        expected_item_count integer, ingest_revision integer NOT NULL DEFAULT 0,
        finalization_started_at timestamptz, finalized_at timestamptz,
        finalization_status text NOT NULL DEFAULT 'pending', finalization_error jsonb,
        finalized_produce_session_id uuid, accountability_round_id uuid,
        finalize_hold_until timestamptz, finalize_confirmed_at timestamptz,
        finalize_confirm_line_event_id text, runtime_environment text NOT NULL DEFAULT 'development',
        entry_origin text
      );
      CREATE TABLE public.pending_session_admission (
        session_key text NOT NULL, session_generation uuid NOT NULL,
        line_event_id text NOT NULL, line_timestamp_ms bigint NOT NULL,
        UNIQUE(session_generation, line_event_id)
      );
      CREATE TABLE public.pending_session_ingest (
        session_key text NOT NULL, session_generation uuid NOT NULL,
        line_event_id text NOT NULL, line_timestamp_ms bigint NOT NULL, raw_text text NOT NULL,
        UNIQUE(session_generation, line_event_id)
      );
      CREATE FUNCTION public.append_pending_session(
        p_session_key text, p_new_text text, p_reply_token text, p_line_event_id text,
        p_line_timestamp_ms bigint, p_mark_close boolean,
        p_expected_session_generation uuid, p_expected_item_count integer
      ) RETURNS jsonb LANGUAGE plpgsql AS $$
      DECLARE v public.pending_sessions%ROWTYPE;
      BEGIN
        SELECT * INTO v FROM public.pending_sessions WHERE session_key=p_session_key FOR UPDATE;
        IF NOT FOUND OR v.session_generation IS DISTINCT FROM p_expected_session_generation
           OR v.terminalized THEN RETURN jsonb_build_object('accepted',false,'reason','not_found'); END IF;
        IF v.close_event_timestamp_ms IS NOT NULL AND p_line_timestamp_ms >= v.close_event_timestamp_ms
          THEN RETURN jsonb_build_object('accepted',false,'reason','after_close_boundary'); END IF;
        INSERT INTO public.pending_session_admission VALUES
          (p_session_key,v.session_generation,p_line_event_id,p_line_timestamp_ms)
          ON CONFLICT DO NOTHING;
        IF NOT FOUND THEN RETURN jsonb_build_object('accepted',true,'reason','duplicate_event','session',to_jsonb(v)); END IF;
        INSERT INTO public.pending_session_ingest VALUES
          (p_session_key,v.session_generation,p_line_event_id,p_line_timestamp_ms,p_new_text)
          ON CONFLICT DO NOTHING;
        UPDATE public.pending_sessions SET accumulated_text=accumulated_text||E'\\n'||p_new_text,
          latest_reply_token=p_reply_token, updated_at=clock_timestamp(), ingest_revision=ingest_revision+1,
          close_event_timestamp_ms=CASE WHEN p_mark_close THEN p_line_timestamp_ms ELSE close_event_timestamp_ms END,
          close_line_event_id=CASE WHEN p_mark_close THEN p_line_event_id ELSE close_line_event_id END,
          close_requested_at=CASE WHEN p_mark_close THEN clock_timestamp() ELSE close_requested_at END,
          close_session_generation=CASE WHEN p_mark_close THEN session_generation ELSE close_session_generation END,
          close_deadline_at=CASE WHEN p_mark_close THEN clock_timestamp()+interval '30 seconds' ELSE close_deadline_at END,
          next_attempt_at=CASE WHEN p_mark_close THEN clock_timestamp()+interval '8 seconds' ELSE next_attempt_at END
        WHERE session_key=p_session_key RETURNING * INTO v;
        RETURN jsonb_build_object('accepted',true,'session',to_jsonb(v));
      END $$;
      SELECT 1`);
    await apply(join(
      ROOT, "supabase", "migrations", "20260815094931_produce_out_of_order_admission.sql",
    ));
    await apply(join(
      ROOT, "supabase", "migrations", "20260924090000_produce_generation_rotation_carry_forward.sql",
    ));
  }, 60_000);

  afterAll(async () => {
    if (!databaseCreated) return;
    await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE}`], "postgres");
  }, 60_000);

  test("normal order remains immediate and exact-once", async () => {
    const key = keyFor("normal");
    expect(await open({ key, eventId: "normal-head", timestamp: 1000 })).toMatchObject({ opened: true });
    expect(await item({ key, eventId: "normal-item", timestamp: 1100 })).toMatchObject({ action: "admitted" });
    expect(await item({ key, eventId: "normal-item", timestamp: 1100 })).toMatchObject({ idempotent: true });
    expect(await scalar("SELECT count(*) FROM public.pending_session_ingest WHERE line_event_id='normal-item'")).toBe("1");
  });

  test("ITEM1 executing before HEAD is durably reconciled by LINE timestamp", async () => {
    const key = keyFor("incident");
    expect(await item({ key, eventId: "01M025M0P6K6HBXZNMQYA1TYHZ", timestamp: 1786779402807 }))
      .toMatchObject({ action: "deferred" });
    expect(await open({ key, eventId: "01M025M0VW9X4KN9GNT3M6TRNY", timestamp: 1786779402624 }))
      .toMatchObject({ opened: true, reconciled_count: 1 });
    expect(await scalar("SELECT status FROM public.pending_produce_deferred_events WHERE line_event_id='01M025M0P6K6HBXZNMQYA1TYHZ'")).toBe("admitted");
  });

  test("2026-09-23 ITEM1 executes before HEADER and survives stale-generation rotation", async () => {
    const key = keyFor("sep23-production");
    const stale = await open({
      key,
      eventId: "sep23-stale-head",
      timestamp: 1790176000000,
      text: "รายการชั่งคืนก่อนหน้า",
    });
    const staleGeneration = (stale.session as { session_generation: string }).session_generation;

    // Exact production execution order: Item 1 runs first. Because a previous
    // live generation exists, the original RPC fast path admits it there and
    // creates no deferred row.
    expect(await item({
      key,
      eventId: "sep23-item-1",
      timestamp: 1790176127487,
      text: "1.น้อยหน่า40บาท\n30.5โล",
    })).toMatchObject({ action: "admitted", session_generation: staleGeneration });
    expect(await scalar(
      "SELECT count(*) FROM public.pending_produce_deferred_events WHERE line_event_id='sep23-item-1'",
    )).toBe("0");

    // The authoritative Header is 160 ms earlier in LINE time but executes
    // second. Rotation must carry Item 1 into the generation that will save.
    const opened = await open({
      key,
      eventId: "sep23-head",
      timestamp: 1790176127327,
      text: "พี่เต้ย-ตลาด72 ชั่งคืน 23/9/2569",
      expectedGeneration: staleGeneration,
    });
    expect(opened).toMatchObject({
      opened: true,
      carried_forward_count: 1,
      reconciled_count: 1,
    });
    const saved = opened.session as { session_generation: string; accumulated_text: string };
    expect(saved.session_generation).not.toBe(staleGeneration);
    expect(parseWeighSession(saved.accumulated_text).items).toEqual([
      expect.objectContaining({ item_number: 1, product_name: "น้อยหน่า", quantity: 30.5 }),
    ]);
    expect(await scalar(`SELECT count(*) FROM public.pending_session_ingest
      WHERE session_generation=${q(saved.session_generation)}::uuid
        AND line_event_id='sep23-item-1'
        AND line_timestamp_ms=1790176127487`)).toBe("1");
  });

  test("rotation does not carry a truly timestamp-before-opener retired item", async () => {
    const key = keyFor("rotation-before-boundary");
    const stale = await open({ key, eventId: "rotation-old-head", timestamp: 1000 });
    const staleGeneration = (stale.session as { session_generation: string }).session_generation;
    expect(await item({ key, eventId: "rotation-old-item", timestamp: 1500 }))
      .toMatchObject({ action: "admitted" });

    const opened = await open({
      key,
      eventId: "rotation-new-head",
      timestamp: 2000,
      expectedGeneration: staleGeneration,
    });
    expect(opened).toMatchObject({ opened: true, carried_forward_count: 0 });
    const generation = (opened.session as { session_generation: string }).session_generation;
    expect(await scalar(`SELECT count(*) FROM public.pending_session_ingest
      WHERE session_generation=${q(generation)}::uuid
        AND line_event_id='rotation-old-item'`)).toBe("0");
  });

  test("items executing out of order reconstruct in timestamp order", async () => {
    const key = keyFor("item-order");
    await open({ key, eventId: "order-head", timestamp: 1000 });
    await item({ key, eventId: "order-item-2", timestamp: 1200, text: "2สับปะรด50บาท\n10.ถุง" });
    await item({ key, eventId: "order-item-1", timestamp: 1100 });
    expect(await scalar(`SELECT string_agg(line_event_id,',' ORDER BY line_timestamp_ms,line_event_id)
      FROM public.pending_session_ingest WHERE session_key=${q(key)}`)).toBe("order-head,order-item-1,order-item-2");
  });

  test("close admits timestamp-earlier work and blocks unresolved work", async () => {
    const key = keyFor("close-race");
    const opened = await open({ key, eventId: "close-head", timestamp: 1000 });
    const generation = (opened.session as { session_generation: string }).session_generation;
    await scalar(`SELECT public.append_pending_session(${q(key)},'จบรายการเบิก','reply-close',
      'close-event',1300,true,${q(generation)}::uuid,NULL)`);
    expect(await item({ key, eventId: "close-earlier-item", timestamp: 1100 }))
      .toMatchObject({ action: "admitted" });

    const rawId = await raw("close-unresolved", "2สับปะรด50บาท\n10.ถุง");
    await scalar(`INSERT INTO public.pending_produce_deferred_events(
      line_event_id,raw_message_id,session_key,source_id,line_user_id,line_timestamp_ms,
      raw_text,runtime_environment) VALUES
      ('close-unresolved',${q(rawId)}::uuid,${q(key)},${q(SOURCE)},${q(USER)},1200,
       '2สับปะรด50บาท', 'development') RETURNING 1`);
    const blocked = await psql(["-v", "ON_ERROR_STOP=1", "-c",
      `UPDATE public.pending_sessions SET finalization_status='processing' WHERE session_key=${q(key)}`]);
    expect(blocked.code).not.toBe(0);
    expect(blocked.stderr).toContain("unresolved deferred Produce events");
  });

  test("strict opener/close boundaries reject instead of stealing", async () => {
    const key = keyFor("boundaries");
    const opened = await open({ key, eventId: "boundary-head", timestamp: 2000 });
    expect(await item({ key, eventId: "before-opener", timestamp: 1900 }))
      .toMatchObject({ action: "rejected_before_opener" });
    const generation = (opened.session as { session_generation: string }).session_generation;
    await scalar(`SELECT public.append_pending_session(${q(key)},'จบรายการเบิก','reply',
      'boundary-close',2500,true,${q(generation)}::uuid,NULL)`);
    expect(await item({ key, eventId: "after-close", timestamp: 2600 }))
      .toMatchObject({ action: "rejected_after_close" });
  });

  test("true orphan expires visibly and cannot bind to a later opener", async () => {
    const key = keyFor("orphan");
    await item({ key, eventId: "orphan-item", timestamp: 3000 });
    await scalar("UPDATE public.pending_produce_deferred_events SET expires_at=clock_timestamp() WHERE line_event_id='orphan-item' RETURNING 1");
    expect(await scalar("SELECT status FROM public.claim_expired_pending_produce_events(25,'development') WHERE line_event_id='orphan-item'")).toBe("rejected_orphan");
    await open({ key, eventId: "orphan-later-head", timestamp: 3100 });
    expect(await scalar("SELECT count(*) FROM public.pending_session_ingest WHERE line_event_id='orphan-item'")).toBe("0");
  });

  test("stream keys isolate users and groups", async () => {
    const otherUser = "U-other";
    const otherSource = "C-other";
    const userKey = keyFor("isolated", otherUser);
    const groupKey = keyFor("isolated", USER, otherSource);
    await item({ key: userKey, eventId: "user-item", timestamp: 4100, user: otherUser });
    await item({ key: groupKey, eventId: "group-item", timestamp: 4100, source: otherSource });
    await open({ key: keyFor("isolated"), eventId: "main-head", timestamp: 4000 });
    expect(await scalar("SELECT count(*) FROM public.pending_produce_deferred_events WHERE status='admitted' AND line_event_id IN ('user-item','group-item')")).toBe("0");
  });

  test("real 15 August fixture reconstructs 17 items and 8,914 THB", async () => {
    const key = keyFor("real-total");
    const lines = [
      [1, 1786779402807, "1อะโวคาโด้50บาท\n26.7.โล"],
      [2, 1786779402890, "2สับปะรด50บาท\n10.ถุง"],
      [3, 1786779402983, "3แก้วมังกร35บาท\n3.5.โล"],
      [4, 1786779403163, "4มะม่วงเขียวรกต30บาท\n8.โล"],
      [5, 1786779403300, "5มหาชนก30บาท\n4.1.โล"],
      [6, 1786779403450, "6ไซมัส80บาท\n11.6.โล"],
      [7, 1786779403600, "7มะพร้าว17บาท\n4.ลูก"],
      [8, 1786779403750, "8แตงโม35บาท\n6.ลูก"],
      [9, 1786779403900, "9แอปเปิ้ล8บาท\n74.ลูก"],
      [10, 1786779404050, "10สาลี่10บาท\n26.ลูก"],
      [11, 1786779404200, "11แตงไทย20บาท\n6.ลูก"],
      [12, 1786779404350, "12แตงโม35บาท\n7.ลูก"],
      [13, 1786779404500, "13แก้วมังกร35บาท\n37.9.โล"],
      [14, 1786779404650, "14สับปะรด50บาท\n30.ถุง"],
      [15, 1786779404800, "15แตงไทย20บาท\n11.ลูก"],
      [16, 1786779404950, "16สาลี่10บาท\n36.ลูก"],
      [17, 1786779405100, "17น้อยหน่า40บาท\n19.1.โล"],
    ] as const;
    await item({ key, eventId: "real-item-1", timestamp: lines[0][1], text: lines[0][2] });
    await open({ key, eventId: "real-head", timestamp: 1786779402624 });
    for (const [number, timestamp, text] of [...lines.slice(2), lines[1]]) {
      await item({ key, eventId: `real-item-${number}`, timestamp, text });
    }
    const finalText = JSON.parse(await scalar(`SELECT to_json(string_agg(
      raw_text,E'\\n' ORDER BY line_timestamp_ms,line_event_id))
      FROM public.pending_session_ingest WHERE session_key=${q(key)}`));
    const parsed = parseWeighSession(finalText);
    expect(parsed.items).toHaveLength(17);
    expect(parsed.items.reduce((sum, row) => sum + row.price_per_unit * (row.quantity ?? 0), 0))
      .toBe(8_914);
    expect(parsed.items[0]).toMatchObject({ product_name: "อะโวคาโด้", quantity: 26.7 });
  });
});
