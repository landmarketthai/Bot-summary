/**
 * PostgreSQL 17 proof that generation rotation carries forward items whose
 * LINE timestamps place them after the new opener.
 *
 * Production incident 2026-09-23 ("พี่เต้ย-ตลาด72 ชั่งคืน 23/9/2569"): item 1
 * carried a LINE timestamp 160 ms AFTER the header, but its webhook executed
 * FIRST. A previous, still-open generation was present on the group's single
 * pending_sessions row, so append_or_defer_pending_produce_item took its fast
 * path — the item was newer than THAT generation's opener and it had no close
 * — and appended item 1 to the stale generation with no deferred row at all.
 * The header then rotated the generation, overwrote accumulated_text and
 * reconciled nothing, because the deferred ledger was empty. Item 1 survived
 * only as an orphan ingest row under a dead generation that no finalizer query
 * reads. The finalized session held item_number 2..24.
 *
 * Same disposable-database harness as
 * migration-produce-out-of-order-admission.pg.test.ts, with 20260815094931
 * (out-of-order admission), 20260825091605 (recovery-bundle durability) and
 * 20260924090000 (this fix) applied in order.
 */
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
const DATABASE = `produce_carry_forward_${randomBytes(4).toString("hex")}`;
const SAFE_DATABASE = /^produce_carry_forward_[a-f0-9]+$/;
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

const pgAvailable = await probe();
let databaseCreated = false;
if (!pgAvailable && process.env.REQUIRE_PRODUCE_REORDER_POSTGRES === "1") {
  throw new Error("PostgreSQL 17 Produce carry-forward harness is unavailable");
}

describe.skipIf(!pgAvailable)("Produce generation-rotation carry-forward on PostgreSQL 17", () => {
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
      ROOT, "supabase", "migrations",
      "20260924090000_produce_generation_rotation_carry_forward.sql",
    ));
  }, 60_000);

  afterAll(async () => {
    if (!databaseCreated) return;
    await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE}`], "postgres");
  }, 60_000);

  // The exact production payloads.
  const HEADER = "พี่เต้ย-ตลาด72 ชั่งคืน 23/9/2569";
  const ITEM1 = "1.น้อยหน่า40บาท\n30.5โล";
  const T_HEADER = 1_790_176_127_327;
  const T_ITEM1 = 1_790_176_127_487; // 160 ms AFTER the header.

  async function generationOf(key: string): Promise<string> {
    return scalar(
      `SELECT session_generation FROM public.pending_sessions WHERE session_key=${q(key)}`,
    );
  }

  async function close(key: string, eventId: string, timestamp: number): Promise<void> {
    await scalar(`SELECT public.append_pending_session(${q(key)},'จบรายการคืน','reply-${eventId}',
      ${q(eventId)},${timestamp},true,${q(await generationOf(key))}::uuid,NULL)`);
  }

  /** The document the finalizer reconstructs: generation-scoped, timestamp-ordered. */
  async function reconstruct(key: string, generation: string): Promise<string> {
    return JSON.parse(await scalar(`SELECT coalesce(to_json(string_agg(
      raw_text, E'\\n' ORDER BY line_timestamp_ms, line_event_id)), to_json(''::text))
      FROM public.pending_session_ingest
      WHERE session_key=${q(key)} AND session_generation=${q(generation)}::uuid`));
  }

  /** A previous session on the same key that the operator never closed. */
  async function staleOpenGeneration(key: string, suffix: string): Promise<string> {
    await open({
      key,
      eventId: `stale-head-${suffix}`,
      timestamp: 1_790_000_000_000,
      text: "แทน-ราชพฤกษ์ เบิก 22/9/2569",
    });
    return generationOf(key);
  }

  test("item 1 executing before its header is carried into the new generation", async () => {
    const key = keyFor("incident");
    const stale = await staleOpenGeneration(key, "incident");

    // The item handler runs FIRST. A live stale generation is present, so the
    // fast path admits it there — the production path, not 'deferred'.
    expect(await item({ key, eventId: "incident-item-1", timestamp: T_ITEM1, text: ITEM1 }))
      .toMatchObject({ action: "admitted", session_generation: stale });
    expect(await scalar(
      "SELECT count(*) FROM public.pending_produce_deferred_events WHERE line_event_id='incident-item-1'",
    )).toBe("0");

    // The header handler runs SECOND, 160 ms earlier in LINE time.
    expect(await open({
      key, eventId: "incident-head", timestamp: T_HEADER, text: HEADER, expectedGeneration: stale,
    })).toMatchObject({ opened: true, reconciled_count: 1, carried_forward_count: 1 });

    const generation = await generationOf(key);
    expect(generation).not.toBe(stale);
    expect(await scalar(`SELECT count(*) FROM public.pending_session_ingest
      WHERE session_generation=${q(generation)}::uuid AND line_event_id='incident-item-1'`))
      .toBe("1");
  });

  test("the carried item is item 1 of the reconstructed session", async () => {
    const key = keyFor("reconstruct");
    const stale = await staleOpenGeneration(key, "reconstruct");
    await item({ key, eventId: "recon-item-1", timestamp: T_ITEM1, text: ITEM1 });
    await open({
      key, eventId: "recon-head", timestamp: T_HEADER, text: HEADER, expectedGeneration: stale,
    });

    // Items 2..5 arrive after rotation, the way 2..24 did in production.
    const later = [
      [2, "2มะม่วงเขียวเสวย30บาท\n8.โล"],
      [3, "3แก้วมังกร35บาท\n3.5.โล"],
      [4, "4สับปะรด50บาท\n10.ถุง"],
      [5, "5มหาชนก30บาท\n4.1.โล"],
    ] as const;
    for (const [number, text] of later) {
      await item({
        key, eventId: `recon-item-${number}`, timestamp: T_HEADER + number * 1_000, text,
      });
    }

    const parsed = parseWeighSession(await reconstruct(key, await generationOf(key)));
    expect(parsed.items).toHaveLength(5);
    expect(parsed.items[0]).toMatchObject({ product_name: "น้อยหน่า", quantity: 30.5 });
  });

  test("a replayed header carries the item exactly once", async () => {
    const key = keyFor("exactly-once");
    const stale = await staleOpenGeneration(key, "exactly-once");
    await item({ key, eventId: "once-item-1", timestamp: T_ITEM1, text: ITEM1 });
    const first = await open({
      key, eventId: "once-head", timestamp: T_HEADER, text: HEADER, expectedGeneration: stale,
    });
    const generation = await generationOf(key);

    // LINE redelivery of the same opener event: idempotent, no second copy.
    const replay = await open({ key, eventId: "once-head", timestamp: T_HEADER, text: HEADER });
    expect(first).toMatchObject({ carried_forward_count: 1 });
    expect(replay).toMatchObject({ opened: true, carried_forward_count: 0 });
    expect(await generationOf(key)).toBe(generation);
    // One row under the retired generation as evidence, one live.
    expect(await scalar(
      "SELECT count(*) FROM public.pending_session_ingest WHERE line_event_id='once-item-1'",
    )).toBe("2");
    expect(await scalar(`SELECT count(*) FROM public.pending_session_ingest
      WHERE session_generation=${q(generation)}::uuid AND line_event_id='once-item-1'`)).toBe("1");
  });

  test("an item older than the new header is never stolen from the retired generation", async () => {
    const key = keyFor("no-theft");
    const stale = await staleOpenGeneration(key, "no-theft");
    // Belongs to the stale session: its LINE timestamp precedes the new header.
    await item({ key, eventId: "theft-item", timestamp: T_HEADER - 5_000, text: ITEM1 });
    expect(await open({
      key, eventId: "theft-head", timestamp: T_HEADER, text: HEADER, expectedGeneration: stale,
    })).toMatchObject({ opened: true, carried_forward_count: 0 });

    expect(await scalar(`SELECT count(*) FROM public.pending_session_ingest
      WHERE session_generation=${q(await generationOf(key))}::uuid AND line_event_id='theft-item'`))
      .toBe("0");
    expect(await scalar(`SELECT count(*) FROM public.pending_session_ingest
      WHERE session_generation=${q(stale)}::uuid AND line_event_id='theft-item'`)).toBe("1");
  });

  test("the retired header and closer are never replayed as content", async () => {
    const key = keyFor("no-control-replay");
    const stale = await staleOpenGeneration(key, "no-control-replay");
    await close(key, "retired-close", T_ITEM1 + 20_000);
    await item({ key, eventId: "control-item", timestamp: T_ITEM1, text: ITEM1 });

    expect(await open({
      key, eventId: "control-head", timestamp: T_HEADER, text: HEADER, expectedGeneration: stale,
    })).toMatchObject({ opened: true, carried_forward_count: 1 });

    const document = await reconstruct(key, await generationOf(key));
    expect(document).toContain("น้อยหน่า");
    expect(document).not.toContain("จบรายการคืน");
    expect(document).not.toContain("แทน-ราชพฤกษ์");
  });

  test("an opener that also closes carries nothing", async () => {
    const key = keyFor("opener-closes");
    const stale = await staleOpenGeneration(key, "opener-closes");
    await item({ key, eventId: "pasted-item", timestamp: T_ITEM1, text: ITEM1 });
    // Opener and close share one timestamp: nothing can be both after and
    // before it, exactly as in the deferred reconcile loop.
    expect(await open({
      key, eventId: "pasted-head", timestamp: T_HEADER, text: HEADER,
      close: true, expectedGeneration: stale,
    })).toMatchObject({ opened: true, carried_forward_count: 0 });
  });

  test("the original waiting-then-reconciled path is unchanged", async () => {
    // No session on the key at all: 24b92ec's case, still the common one.
    const key = keyFor("waiting");
    expect(await item({ key, eventId: "waiting-item", timestamp: T_ITEM1, text: ITEM1 }))
      .toMatchObject({ action: "deferred" });
    expect(await open({ key, eventId: "waiting-head", timestamp: T_HEADER, text: HEADER }))
      .toMatchObject({ opened: true, reconciled_count: 1, carried_forward_count: 0 });
    expect(await scalar(
      "SELECT status||'/'||defer_reason FROM public.pending_produce_deferred_events WHERE line_event_id='waiting-item'",
    )).toBe("admitted/reconciled_with_opener");
  });

  test("a rejection against the retired close is re-admitted, not stranded", async () => {
    const key = keyFor("retired-close");
    const stale = await staleOpenGeneration(key, "retired-close");
    // The stale session was closed but never terminalized. Its close predates
    // the header that is about to arrive, so it cannot bound this item.
    await close(key, "retired-close-event", T_HEADER - 1_000);

    expect(await item({ key, eventId: "retired-item", timestamp: T_ITEM1, text: ITEM1 }))
      .toMatchObject({ action: "rejected_after_close" });

    expect(await open({
      key, eventId: "retired-head", timestamp: T_HEADER, text: HEADER, expectedGeneration: stale,
    })).toMatchObject({ opened: true, reconciled_count: 1, carried_forward_count: 0 });

    const generation = await generationOf(key);
    expect(await scalar(`SELECT count(*) FROM public.pending_session_ingest
      WHERE session_generation=${q(generation)}::uuid AND line_event_id='retired-item'`)).toBe("1");
    expect(await scalar(
      "SELECT status||'/'||defer_reason FROM public.pending_produce_deferred_events WHERE line_event_id='retired-item'",
    )).toBe("admitted/reconciled_after_generation_rotation");
  });

  test("a true orphan is never re-admitted by a later header", async () => {
    const key = keyFor("orphan");
    // No session at all: the item defers, then its reorder window expires and
    // the sweep stamps it rejected_orphan with a NULL session_generation.
    expect(await item({ key, eventId: "orphan-item", timestamp: T_ITEM1, text: ITEM1 }))
      .toMatchObject({ action: "deferred" });
    await scalar(
      "UPDATE public.pending_produce_deferred_events SET expires_at=clock_timestamp() WHERE line_event_id='orphan-item' RETURNING 1",
    );
    expect(await scalar(
      "SELECT status FROM public.claim_expired_pending_produce_events(25,'development') WHERE line_event_id='orphan-item'",
    )).toBe("rejected_orphan");

    // A later header, still earlier than the orphan in LINE time, must not take it.
    expect(await open({ key, eventId: "orphan-head", timestamp: T_HEADER, text: HEADER }))
      .toMatchObject({ opened: true, reconciled_count: 0, carried_forward_count: 0 });
    expect(await scalar(
      "SELECT count(*) FROM public.pending_session_ingest WHERE line_event_id='orphan-item'",
    )).toBe("0");
  });

  test("header < item < close keeps the carried item inside the close boundary", async () => {
    const key = keyFor("close-boundary");
    const stale = await staleOpenGeneration(key, "close-boundary");
    await item({ key, eventId: "boundary-item", timestamp: T_ITEM1, text: ITEM1 });
    await open({
      key, eventId: "boundary-head", timestamp: T_HEADER, text: HEADER, expectedGeneration: stale,
    });
    const generation = await generationOf(key);
    const closeTimestamp = T_ITEM1 + 10_000;
    await close(key, "boundary-close", closeTimestamp);

    // T_HEADER < T_ITEM1 < closeTimestamp — the finalizer's bounded read keeps it.
    expect(await scalar(`SELECT count(*) FROM public.pending_session_ingest
      WHERE session_generation=${q(generation)}::uuid
        AND line_timestamp_ms <= ${closeTimestamp}
        AND line_event_id='boundary-item'`)).toBe("1");

    // The close boundary still rejects, it does not steal.
    expect(await item({
      key, eventId: "boundary-after", timestamp: closeTimestamp + 1, text: ITEM1,
    })).toMatchObject({ action: "rejected_after_close" });
    expect(await item({
      key, eventId: "boundary-before", timestamp: T_HEADER - 1, text: ITEM1,
    })).toMatchObject({ action: "rejected_before_opener" });
  });
});
