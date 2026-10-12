/**
 * PostgreSQL 17 proof: a generation rotation never erases an unresolved
 * Produce document (20261008150000).
 *
 * The rotation RPC rewrites the single pending_sessions row in place. Before
 * this migration a refused ชั่งคืน was gone the moment the same LINE user sent
 * their next header, and every later report read that round as sold out.
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
const DATABASE = `retired_generation_${randomBytes(4).toString("hex")}`;
const SAFE_DATABASE = /^retired_generation_[a-f0-9]+$/;
const SAFE_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

type PsqlResult = { code: number; stdout: string; stderr: string };
async function psql(args: string[], database = DATABASE, stdin?: string): Promise<PsqlResult> {
  const proc = Bun.spawn([PSQL, "-X", ...args], {
    cwd: ROOT,
    stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
    env: {
      ...process.env,
      PGHOST, PGUSER, PGPASSWORD, PGPORT,
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
const keyFor = (suffix: string) => `group:${SOURCE}:${suffix}:user:${USER}`;
const RETURN_TEXT = "น้อย-ราชพฤกษ์ ชั่งคืน 7/10/2569\n1.มะนาว 3 แพค\n22.มะม่วง\nจบรายการชั่งคืน";

async function open(key: string, eventId: string, timestamp: number, text: string, expected?: string) {
  return JSON.parse(await scalar(`SELECT public.open_pending_plain_text_generation(
    ${q(key)}, ${q(SOURCE)}, ${q(USER)}, ${q(eventId)}, ${timestamp}, ${q(text)},
    'reply-${eventId}', false, NULL,
    ${expected ? `${q(expected)}::uuid` : "NULL::uuid"}, 'development')`)) as {
    opened: boolean;
    session?: { session_generation?: string };
  };
}

async function generationOf(key: string): Promise<string> {
  return scalar(`SELECT session_generation FROM public.pending_sessions WHERE session_key=${q(key)}`);
}

async function retired(generation: string): Promise<Record<string, unknown> | null> {
  const row = await scalar(`SELECT coalesce((SELECT row_to_json(r)::text
    FROM public.pending_session_retired_generations r
    WHERE session_generation=${q(generation)}::uuid), 'null')`);
  return JSON.parse(row);
}

const pgAvailable = await probe();
let databaseCreated = false;

describe.skipIf(!pgAvailable)("retired pending generations on PostgreSQL 17", () => {
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
        entry_origin text, business_date date, staff_label text, market_label text,
        declared_transaction_type text, plain_text_opened_line_event_id text,
        close_refused_at timestamptz, close_refused_session_generation uuid,
        plain_text_opened_line_timestamp_ms bigint
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
      BEGIN RETURN jsonb_build_object('accepted', false, 'reason', 'not_used'); END $$;
      SELECT 1`);
    await apply(join(ROOT, "supabase", "migrations", "20260815094931_produce_out_of_order_admission.sql"));
    await apply(join(ROOT, "supabase", "migrations", "20260924090000_produce_generation_rotation_carry_forward.sql"));
    await apply(join(ROOT, "supabase", "migrations", "20261008150000_pending_session_retired_generations.sql"));
  }, 60_000);

  afterAll(async () => {
    if (!databaseCreated) return;
    await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE}`], "postgres");
  }, 60_000);

  test("the 7 Oct shape: a refused return survives the seller's next header", async () => {
    const key = keyFor("refused");
    expect((await open(key, "ret-head", 1_000, RETURN_TEXT)).opened).toBe(true);
    const refusedGeneration = await generationOf(key);
    await scalar(`UPDATE public.pending_sessions
      SET finalization_status='failed_closed', terminalized=true,
          finalization_error='{"reason":"validation_failed"}'::jsonb
      WHERE session_key=${q(key)}; SELECT 1`);

    const next = await open(key, "next-day-withdrawal", 2_000, "น้อย-ราชพฤกษ์ เบิก 8/10/2569", refusedGeneration);
    expect(next.opened).toBe(true);
    expect(await generationOf(key)).not.toBe(refusedGeneration);

    const kept = await retired(refusedGeneration);
    expect(kept).toMatchObject({
      session_key: key,
      source_id: SOURCE,
      finalization_status: "failed_closed",
      accumulated_text: RETURN_TEXT,
      accountability_round_id: null,
    });
    expect((kept?.finalization_error as { reason?: string })?.reason).toBe("validation_failed");
  });

  test("a close refused for THIS generation is kept with its refusal time", async () => {
    const key = keyFor("close-refused");
    await open(key, "cr-head", 1_000, RETURN_TEXT);
    const generation = await generationOf(key);
    await scalar(`UPDATE public.pending_sessions
      SET close_refused_at = now(), close_refused_session_generation = session_generation
      WHERE session_key=${q(key)}; SELECT 1`);
    expect((await open(key, "cr-next", 2_000, "น้อย-ราชพฤกษ์ เบิก 8/10/2569", generation)).opened).toBe(true);
    const kept = await retired(generation);
    expect(kept?.finalization_status).toBe("pending");
    expect(kept?.close_refused_at).not.toBeNull();
  });

  test("a finalized generation rotates without leaving retired evidence", async () => {
    const key = keyFor("finalized");
    await open(key, "fin-head", 1_000, RETURN_TEXT);
    const generation = await generationOf(key);
    await scalar(`UPDATE public.pending_sessions
      SET finalization_status='finalized', terminalized=true WHERE session_key=${q(key)}; SELECT 1`);
    expect((await open(key, "fin-next", 2_000, "น้อย-ราชพฤกษ์ เบิก 8/10/2569", generation)).opened).toBe(true);
    expect(await retired(generation)).toBeNull();
  });

  test("an open return with item evidence survives rotation before close", async () => {
    const key = keyFor("open-return");
    await open(key, "open-head", 1_000, RETURN_TEXT.replace("\nจบรายการชั่งคืน", ""));
    const generation = await generationOf(key);
    expect((await open(key, "open-next", 2_000, "น้อย-ราชพฤกษ์ เบิก 8/10/2569", generation)).opened).toBe(true);
    const kept = await retired(generation);
    expect(kept?.finalization_status).toBe("pending");
    expect(kept?.close_requested_at).toBeNull();
    expect(kept?.accumulated_text).toContain("1.มะนาว 3 แพค");
  });

  test("an update that keeps the generation writes nothing", async () => {
    const key = keyFor("same-generation");
    await open(key, "same-head", 1_000, RETURN_TEXT);
    const generation = await generationOf(key);
    await scalar(`UPDATE public.pending_sessions
      SET finalization_status='failed_closed', terminalized=true WHERE session_key=${q(key)}; SELECT 1`);
    expect(await retired(generation)).toBeNull();
  });

  test("retired evidence is backend-only: no anon or authenticated access", async () => {
    expect(await scalar(`SELECT has_table_privilege('anon',
      'public.pending_session_retired_generations', 'SELECT')`)).toBe("f");
    expect(await scalar(`SELECT has_table_privilege('authenticated',
      'public.pending_session_retired_generations', 'SELECT')`)).toBe("f");
    expect(await scalar(`SELECT has_table_privilege('service_role',
      'public.pending_session_retired_generations', 'SELECT')`)).toBe("t");
    expect(await scalar(`SELECT has_table_privilege('service_role',
      'public.pending_session_retired_generations', 'UPDATE')`)).toBe("f");
    for (const privilege of ["INSERT", "DELETE"]) {
      expect(await scalar(`SELECT has_table_privilege('service_role',
        'public.pending_session_retired_generations', '${privilege}')`)).toBe("f");
    }
    expect(await scalar(`SELECT relrowsecurity FROM pg_class
      WHERE oid='public.pending_session_retired_generations'::regclass`)).toBe("t");
    expect(await scalar(`SELECT has_function_privilege('anon',
      'public.pending_sessions_retain_unresolved_generation()', 'EXECUTE')`)).toBe("f");
  });

  test("duplicate opener is idempotent; stale and unguarded rotations are refused", async () => {
    const key = keyFor("rotation-guards");
    await open(key, "guard-head", 1_000, RETURN_TEXT);
    const generation = await generationOf(key);
    expect((await open(key, "guard-head", 1_000, RETURN_TEXT)).opened).toBe(true);
    expect(await generationOf(key)).toBe(generation);
    expect(await scalar(`SELECT count(*) FROM public.pending_session_ingest
      WHERE session_key=${q(key)}`)).toBe("1");
    expect((await open(key, "unguarded-next", 2_000, "next")).opened).toBe(false);
    expect((await open(key, "stale-next", 2_000, "next",
      "00000000-0000-0000-0000-000000000001")).opened).toBe(false);
    expect(await generationOf(key)).toBe(generation);
    expect(await retired(generation)).toBeNull();
  });

  test("duplicate and expired-empty outcomes leave no blocking evidence", async () => {
    for (const status of ["duplicate", "expired_empty_draft"]) {
      const key = keyFor(status);
      await open(key, `${status}-head`, 1_000, RETURN_TEXT);
      const generation = await generationOf(key);
      await scalar(`UPDATE public.pending_sessions SET finalization_status=${q(status)},
        terminalized=true WHERE session_key=${q(key)}; SELECT 1`);
      expect((await open(key, `${status}-next`, 2_000, "next", generation)).opened).toBe(true);
      expect(await retired(generation)).toBeNull();
    }
  });

  test("a refusal stamp belonging to another generation is not copied", async () => {
    const key = keyFor("wrong-refusal");
    await open(key, "wrong-refusal-head", 1_000, RETURN_TEXT);
    const generation = await generationOf(key);
    await scalar(`UPDATE public.pending_sessions SET close_refused_at=now(),
      close_refused_session_generation=gen_random_uuid() WHERE session_key=${q(key)}; SELECT 1`);
    await open(key, "wrong-refusal-next", 2_000, "next", generation);
    expect((await retired(generation))?.close_refused_at).toBeNull();
  });

  test("duplicate retention preserves the first evidence instead of overwriting it", async () => {
    const key = keyFor("first-evidence");
    await open(key, "first-head", 1_000, RETURN_TEXT);
    const generation = await generationOf(key);
    await open(key, "first-next", 2_000, "next", generation);
    await scalar(`UPDATE public.pending_sessions SET session_generation=${q(generation)}::uuid,
      accumulated_text='replacement' WHERE session_key=${q(key)};
      UPDATE public.pending_sessions SET session_generation=gen_random_uuid()
      WHERE session_key=${q(key)}; SELECT 1`);
    expect((await retired(generation))?.accumulated_text).toBe(RETURN_TEXT);
    expect(await scalar(`SELECT count(*) FROM public.pending_session_retired_generations
      WHERE session_generation=${q(generation)}::uuid`)).toBe("1");
  });

  test("rotation across exactly 04:00 preserves the old explicit business date", async () => {
    const key = keyFor("cutoff");
    await open(key, "cutoff-head", Date.parse("2026-10-07T20:59:59.999Z"), RETURN_TEXT);
    const generation = await generationOf(key);
    await scalar(`UPDATE public.pending_sessions SET business_date='2026-10-07',
      finalization_status='failed_closed' WHERE session_key=${q(key)}; SELECT 1`);
    await open(key, "cutoff-next", Date.parse("2026-10-07T21:00:00.000Z"),
      "น้อย-ราชพฤกษ์ เบิก 8/10/2569", generation);
    expect((await retired(generation))?.business_date).toBe("2026-10-07");
    expect((await retired(generation))?.accumulated_text).toBe(RETURN_TEXT);
  });

  test("legacy NULL generation rotates without trigger failure", async () => {
    const key = keyFor("null-generation");
    await open(key, "null-head", 1_000, RETURN_TEXT);
    await scalar(`ALTER TABLE public.pending_sessions ALTER COLUMN session_generation DROP NOT NULL;
      UPDATE public.pending_sessions SET session_generation=NULL WHERE session_key=${q(key)};
      UPDATE public.pending_sessions SET session_generation=gen_random_uuid() WHERE session_key=${q(key)};
      ALTER TABLE public.pending_sessions ALTER COLUMN session_generation SET NOT NULL; SELECT 1`);
    expect(await scalar(`SELECT count(*) FROM public.pending_session_retired_generations
      WHERE session_generation IS NULL`)).toBe("0");
  });
});
