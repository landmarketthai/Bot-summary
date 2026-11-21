/**
 * PostgreSQL 17 proof for durable recovery-bundle assignment (Task 3 /
 * PROBLEM A) and atomic recovery convergence (Task 3 / PROBLEM B).
 *
 * Builds on the same disposable-database harness as
 * migration-produce-out-of-order-admission.pg.test.ts: applies
 * 20260815081954 (out-of-order admission baseline) and then
 * 20260825090000 (this task's migration) on top.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const WIN_PSQL = "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe";
const PSQL = existsSync(WIN_PSQL) ? WIN_PSQL : "psql";
const PGHOST = process.env.PGHOST ?? "localhost";
const PGUSER = process.env.PGUSER ?? "postgres";
const PGPASSWORD = process.env.PGPASSWORD ?? "postgres";
const PGPORT = process.env.PGPORT ?? "5432";
const DATABASE = `produce_recovery_bundle_${randomBytes(4).toString("hex")}`;
const SAFE_DATABASE = /^produce_recovery_bundle_[a-f0-9]+$/;
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
  user?: string; source?: string; runtimeEnvironment?: string;
}): Promise<Record<string, unknown>> {
  const text = options.text ?? "1อะโวคาโด้50บาท\n26.7.โล";
  const rawId = await raw(options.eventId, text);
  return JSON.parse(await scalar(`SELECT public.append_or_defer_pending_produce_item(
    ${q(rawId)}::uuid, ${q(options.key)}, ${q(options.source ?? SOURCE)},
    ${q(options.user ?? USER)}, ${q(options.eventId)}, ${options.timestamp},
    ${q(text)}, 'reply-${options.eventId}', ${q(options.runtimeEnvironment ?? "development")})`));
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

function spawnPsql(args: string[], database: string, stdin: string) {
  return Bun.spawn([PSQL, "-X", ...args], {
    cwd: ROOT,
    stdin: new TextEncoder().encode(stdin),
    env: {
      ...process.env,
      PGHOST, PGUSER, PGPASSWORD, PGPORT, PGDATABASE: database, PGCLIENTENCODING: "UTF8",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function collect(proc: ReturnType<typeof spawnPsql>): Promise<PsqlResult> {
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

const pgAvailable = await probe();
let databaseCreated = false;
if (!pgAvailable && process.env.REQUIRE_PRODUCE_REORDER_POSTGRES === "1") {
  throw new Error("PostgreSQL 17 Produce recovery-bundle harness is unavailable");
}

describe.skipIf(!pgAvailable)("Produce recovery-bundle durability on PostgreSQL 17", () => {
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
        IF EXISTS (SELECT 1 FROM public.pending_session_admission
                   WHERE session_generation=v.session_generation AND line_event_id=p_line_event_id)
          THEN RETURN jsonb_build_object('accepted',true,'reason','duplicate_event','session',to_jsonb(v)); END IF;
        INSERT INTO public.pending_session_admission VALUES
          (p_session_key,v.session_generation,p_line_event_id,p_line_timestamp_ms)
          ON CONFLICT DO NOTHING;
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
      ROOT, "supabase", "migrations", "20260825091605_produce_recovery_bundle_durability.sql",
    ));
    await apply(join(
      ROOT, "supabase", "migrations", "20261121120100_produce_explicit_recovery_open_guard.sql",
    ));
  }, 60_000);

  afterAll(async () => {
    if (!databaseCreated) return;
    await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE}`], "postgres");
  }, 60_000);

  test("concurrent no-header events in one burst get one intended bundle", async () => {
    const key = keyFor("one-bundle");
    const a = await item({ key, eventId: "burst-a", timestamp: 1000 });
    const b = await item({ key, eventId: "burst-b", timestamp: 1001 });
    const c = await item({ key, eventId: "burst-c", timestamp: 1002 });
    expect(a.action).toBe("deferred");
    expect(b.action).toBe("deferred");
    expect(c.action).toBe("deferred");
    const bundleIds = await scalar(`SELECT string_agg(DISTINCT recovery_bundle_id::text, ',')
      FROM public.pending_produce_deferred_events
      WHERE line_event_id IN ('burst-a','burst-b','burst-c')`);
    expect(bundleIds.split(",")).toHaveLength(1);
    expect(bundleIds).not.toBe("");
  });

  test("a later separate episode on the same session gets a different bundle", async () => {
    const key = keyFor("two-episodes");
    await item({ key, eventId: "ep1-a", timestamp: 2000 });
    await item({ key, eventId: "ep1-b", timestamp: 2001 });
    // Force the first episode's window to have fully elapsed already.
    await scalar(`UPDATE public.pending_produce_deferred_events
      SET expires_at = clock_timestamp() - interval '1 second'
      WHERE line_event_id IN ('ep1-a','ep1-b')`);
    await item({ key, eventId: "ep2-a", timestamp: 2100 });
    const bundle1 = await scalar(
      "SELECT DISTINCT recovery_bundle_id::text FROM public.pending_produce_deferred_events WHERE line_event_id='ep1-a'",
    );
    const bundle2 = await scalar(
      "SELECT recovery_bundle_id::text FROM public.pending_produce_deferred_events WHERE line_event_id='ep2-a'",
    );
    expect(bundle1).not.toBe(bundle2);
  });

  test("a 09:00 burst and a 14:00 burst on the same session never combine", async () => {
    const key = keyFor("am-pm");
    const base = Date.parse("2026-08-25T09:00:00+07:00");
    const afternoon = Date.parse("2026-08-25T14:00:00+07:00");
    for (let index = 0; index < 5; index++) {
      await item({ key, eventId: `am-${index}`, timestamp: base + index });
    }
    // The morning burst's 30-second reorder window is long past by 14:00 —
    // simulate that instead of sleeping the test for hours.
    await scalar(`UPDATE public.pending_produce_deferred_events
      SET expires_at = clock_timestamp() - interval '1 second'
      WHERE line_event_id LIKE 'am-%'`);
    for (let index = 0; index < 7; index++) {
      await item({ key, eventId: `pm-${index}`, timestamp: afternoon + index });
    }
    const bundleCount = await scalar(`SELECT count(DISTINCT recovery_bundle_id)
      FROM public.pending_produce_deferred_events
      WHERE line_event_id LIKE 'am-%' OR line_event_id LIKE 'pm-%'`);
    expect(bundleCount).toBe("2");
    const amCount = await scalar(
      "SELECT count(*) FROM public.pending_produce_deferred_events WHERE line_event_id LIKE 'am-%'",
    );
    const pmCount = await scalar(
      "SELECT count(*) FROM public.pending_produce_deferred_events WHERE line_event_id LIKE 'pm-%'",
    );
    expect(amCount).toBe("5");
    expect(pmCount).toBe("7");
  });

  test("multi-instance simulation: two real concurrent transactions never split a burst", async () => {
    const key = keyFor("multi-instance");
    const rawIdA = await raw("concurrent-a", "1อะโวคาโด้50บาท\n26.7.โล");
    const rawIdB = await raw("concurrent-b", "2สับปะรด50บาท\n10.ถุง");

    // A holds the session_key advisory lock across a deliberate pause. B must
    // block on it rather than computing "no active bundle" from a stale read.
    const first = spawnPsql(
      ["-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
      DATABASE,
      `BEGIN;
       SELECT public.append_or_defer_pending_produce_item(
         ${q(rawIdA)}::uuid, ${q(key)}, ${q(SOURCE)}, ${q(USER)},
         'concurrent-a', 5000, '1อะโวคาโด้50บาท', 'reply-a', 'development');
       SELECT pg_sleep(2);
       COMMIT;`,
    );
    await Bun.sleep(500);
    const second = spawnPsql(
      ["-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
      DATABASE,
      `SELECT public.append_or_defer_pending_produce_item(
         ${q(rawIdB)}::uuid, ${q(key)}, ${q(SOURCE)}, ${q(USER)},
         'concurrent-b', 5001, '2สับปะรด50บาท', 'reply-b', 'development');`,
    );
    const [resultA, resultB] = await Promise.all([collect(first), collect(second)]);
    expect(resultA.code, resultA.stderr).toBe(0);
    expect(resultB.code, resultB.stderr).toBe(0);

    const bundleIds = await scalar(`SELECT string_agg(DISTINCT recovery_bundle_id::text, ',')
      FROM public.pending_produce_deferred_events WHERE line_event_id IN ('concurrent-a','concurrent-b')`);
    expect(bundleIds.split(",")).toHaveLength(1);
  });

  test("waiting -> rejected_orphan preserves the bundle id", async () => {
    const key = keyFor("preserve-on-expiry");
    await item({ key, eventId: "preserve-1", timestamp: 6000 });
    const before = await scalar(
      "SELECT recovery_bundle_id::text FROM public.pending_produce_deferred_events WHERE line_event_id='preserve-1'",
    );
    await scalar(
      "UPDATE public.pending_produce_deferred_events SET expires_at=clock_timestamp() WHERE line_event_id='preserve-1'",
    );
    await scalar("SELECT public.claim_expired_pending_produce_events(25,'development')");
    const after = await scalar(
      "SELECT status || ':' || recovery_bundle_id::text FROM public.pending_produce_deferred_events WHERE line_event_id='preserve-1'",
    );
    expect(after).toBe(`rejected_orphan:${before}`);
  });

  test("a stale (already-expired) bundle cannot be hijacked by a fresh item", async () => {
    const key = keyFor("no-hijack");
    await item({ key, eventId: "stale-1", timestamp: 7000 });
    const staleBundle = await scalar(
      "SELECT recovery_bundle_id::text FROM public.pending_produce_deferred_events WHERE line_event_id='stale-1'",
    );
    await scalar(`UPDATE public.pending_produce_deferred_events
      SET expires_at = clock_timestamp() - interval '1 second' WHERE line_event_id='stale-1'`);
    await item({ key, eventId: "fresh-1", timestamp: 7100 });
    const freshBundle = await scalar(
      "SELECT recovery_bundle_id::text FROM public.pending_produce_deferred_events WHERE line_event_id='fresh-1'",
    );
    expect(freshBundle).not.toBe(staleBundle);
  });

  test("a wrong source (different session_key) never shares a bundle", async () => {
    const keyA = keyFor("source-a");
    const keyB = keyFor("source-b");
    await item({ key: keyA, eventId: "src-a-1", timestamp: 8000 });
    await item({ key: keyB, eventId: "src-b-1", timestamp: 8000 });
    const bundleA = await scalar(
      "SELECT recovery_bundle_id::text FROM public.pending_produce_deferred_events WHERE line_event_id='src-a-1'",
    );
    const bundleB = await scalar(
      "SELECT recovery_bundle_id::text FROM public.pending_produce_deferred_events WHERE line_event_id='src-b-1'",
    );
    expect(bundleA).not.toBe(bundleB);
  });

  test("recovery run twice via recover_pending_produce_deferred_event produces no duplicates", async () => {
    const key = keyFor("recover-idempotent");
    const opened = await open({ key, eventId: "recover-idem-head", timestamp: 9000 });
    const generation = (opened.session as { session_generation: string }).session_generation;
    const first = JSON.parse(await scalar(`SELECT public.recover_pending_produce_deferred_event(
      ${q(key)}, 'recover-idem-item', '1อะโวคาโด้50บาท', 'reply', 9100, ${q(generation)}::uuid)`));
    expect(first.accepted).toBe(true);
    const second = JSON.parse(await scalar(`SELECT public.recover_pending_produce_deferred_event(
      ${q(key)}, 'recover-idem-item', '1อะโวคาโด้50บาท', 'reply', 9100, ${q(generation)}::uuid)`));
    expect(second.accepted).toBe(true);
    expect(second.reason).toBe("duplicate_event");
    expect(await scalar(
      "SELECT count(*) FROM public.pending_session_ingest WHERE line_event_id='recover-idem-item'",
    )).toBe("1");
  });

  test("recover_pending_produce_deferred_event converges the deferred status atomically", async () => {
    const key = keyFor("converge-status");
    const opened = await open({ key, eventId: "converge-head", timestamp: 10_000 });
    const generation = (opened.session as { session_generation: string }).session_generation;
    // Seed a rejected_before_opener row the way a real boundary rejection would.
    const rawId = await raw("converge-item", "1อะโวคาโด้50บาท\n26.7.โล");
    await scalar(`INSERT INTO public.pending_produce_deferred_events (
        line_event_id, raw_message_id, session_key, source_id, line_user_id,
        line_timestamp_ms, raw_text, runtime_environment, status, defer_reason,
        session_generation, opener_line_event_id, resolved_at
      ) VALUES (
        'converge-item', ${q(rawId)}::uuid, ${q(key)}, ${q(SOURCE)}, ${q(USER)},
        9500, '1อะโวคาโด้50บาท', 'development', 'rejected_before_opener',
        'item_timestamp_not_after_opener', gen_random_uuid(), 'prior-opener', clock_timestamp()
      )`);
    const result = JSON.parse(await scalar(`SELECT public.recover_pending_produce_deferred_event(
      ${q(key)}, 'converge-item', '1อะโวคาโด้50บาท', 'reply', 10_100, ${q(generation)}::uuid)`));
    expect(result.accepted).toBe(true);
    const status = await scalar(
      "SELECT status FROM public.pending_produce_deferred_events WHERE line_event_id='converge-item'",
    );
    expect(status).toBe("admitted");
  });

  test("recover_pending_produce_deferred_event leaves the deferred row untouched on a real crash", async () => {
    const key = keyFor("partial-crash");
    // No pending_sessions row exists for this generation — append_pending_session
    // itself fails 'not_found', exactly like a real generation-conflict crash.
    const rawId = await raw("crash-item", "1อะโวคาโด้50บาท\n26.7.โล");
    await scalar(`INSERT INTO public.pending_produce_deferred_events (
        line_event_id, raw_message_id, session_key, source_id, line_user_id,
        line_timestamp_ms, raw_text, runtime_environment, status, defer_reason, resolved_at
      ) VALUES (
        'crash-item', ${q(rawId)}::uuid, ${q(key)}, ${q(SOURCE)}, ${q(USER)},
        11_000, '1อะโวคาโด้50บาท', 'development', 'rejected_orphan', 'no_temporally_valid_generation',
        clock_timestamp()
      )`);
    const missingGeneration = "00000000-0000-4000-8000-000000000000";
    const result = JSON.parse(await scalar(`SELECT public.recover_pending_produce_deferred_event(
      ${q(key)}, 'crash-item', '1อะโวคาโด้50บาท', 'reply', 11_100, ${q(missingGeneration)}::uuid)`));
    expect(result.accepted).toBe(false);
    const status = await scalar(
      "SELECT status FROM public.pending_produce_deferred_events WHERE line_event_id='crash-item'",
    );
    expect(status).toBe("rejected_orphan");
  });

  test("a close that wins the race prevents explicit recovery even for an older LINE timestamp", async () => {
    const key = keyFor("recover-after-close-race");
    const opened = await open({ key, eventId: "guard-head", timestamp: 20_000 });
    const generation = (opened.session as { session_generation: string }).session_generation;
    const rawId = await raw("guard-item", "1อะโวคาโด้50บาท");
    await scalar(`INSERT INTO public.pending_produce_deferred_events (
      line_event_id, raw_message_id, session_key, source_id, line_user_id,
      line_timestamp_ms, raw_text, runtime_environment, status, defer_reason, resolved_at
    ) VALUES (
      'guard-item', ${q(rawId)}::uuid, ${q(key)}, ${q(SOURCE)}, ${q(USER)},
      20_100, '1อะโวคาโด้50บาท', 'development', 'rejected_orphan', 'no_temporally_valid_generation',
      clock_timestamp()
    ) RETURNING 1`);
    await scalar(`SELECT public.append_pending_session(${q(key)}, 'จบรายการเบิก', NULL,
      'guard-close', 20_500, true, ${q(generation)}::uuid, NULL)`);

    const result = JSON.parse(await scalar(`SELECT public.recover_pending_produce_deferred_event(
      ${q(key)}, 'guard-item', '1อะโวคาโด้50บาท', 'reply', 20_100, ${q(generation)}::uuid)`));
    expect(result).toEqual({ accepted: false, reason: "recovery_draft_closed" });
    expect(await scalar(
      "SELECT count(*) FROM public.pending_session_ingest WHERE line_event_id='guard-item'",
    )).toBe("0");
    expect(await scalar(
      "SELECT status FROM public.pending_produce_deferred_events WHERE line_event_id='guard-item'",
    )).toBe("rejected_orphan");
  });

  test("PR #82 after-close grouping is unchanged: opener/close keys still take precedence", async () => {
    const key = keyFor("after-close-unchanged");
    const opened = await open({ key, eventId: "ac-head", timestamp: 12_000 });
    const generation = (opened.session as { session_generation: string }).session_generation;
    await scalar(`SELECT public.append_pending_session(${q(key)}, 'จบรายการเบิก', 'reply',
      'ac-close', 12_500, true, ${q(generation)}::uuid, NULL)`);
    const rejected = await item({ key, eventId: "ac-after", timestamp: 12_600 });
    expect(rejected.action).toBe("rejected_after_close");
    const row = JSON.parse(await scalar(`SELECT to_json(row) FROM (
      SELECT close_line_event_id, opener_line_event_id, recovery_bundle_id
      FROM public.pending_produce_deferred_events WHERE line_event_id='ac-after'
    ) row`));
    expect(row.close_line_event_id).toBe("ac-close");
    expect(row.opener_line_event_id).toBe("ac-head");
  });
});
