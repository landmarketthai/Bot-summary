/**
 * acquire_ai_provider_permit (migration 20261107090000) on real PostgreSQL 17.
 *
 *   ALLOW_DISPOSABLE_POSTGRES_TESTS=1 PGPASSWORD=postgres bun test ./src/lib/slips/gemini-rate-limit.pg.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createGeminiRequestPermit, GeminiQuotaUnavailableError } from "@/lib/slips/gemini-rate-limit";
import {
  createPgSupabase,
  createSlipTestDb,
  PGHOST,
  PGPASSWORD,
  PGPORT,
  PGUSER,
  probePg,
  type SlipTestDb,
} from "@/lib/slips/testing/pg-slip-harness";

const pgAvailable = await probePg();
if (!pgAvailable && process.env.SLIP_INGEST_REQUIRE === "1") {
  throw new Error("SLIP_INGEST_REQUIRE=1 but PostgreSQL 17 harness unavailable");
}

const MIGRATION = "20261107090000_gemini_ocr_rate_limit.sql";
type Permit = { granted: boolean; reason: string; retry_after_ms: number };

let db: SlipTestDb;
let wide: Bun.SQL; // separate pool so the burst really runs on many backends
let seq = 0;
const provider = () => `test_provider_${++seq}`;

async function acquire(sql: Bun.SQL, p: string, rpm: number, rpd: number): Promise<Permit> {
  const rows = (await sql.unsafe(
    `SELECT public.acquire_ai_provider_permit('${p}', ${rpm}, ${rpd}) AS j`,
  )) as unknown as Array<{ j: Permit | string }>;
  const j = rows[0]!.j;
  return typeof j === "string" ? (JSON.parse(j) as Permit) : j;
}

/** Rolling-window grants (sum of all 'second' buckets) and the day counters. */
async function counts(p: string): Promise<{ seconds: number; day: number[] }> {
  const rows = await db.query<{ window_kind: string; request_count: number }>(
    `SELECT window_kind, request_count FROM public.ai_provider_rate_window
      WHERE provider = '${p}' ORDER BY window_start`,
  );
  return {
    seconds: rows.filter((r) => r.window_kind === "second").reduce((n, r) => n + r.request_count, 0),
    day: rows.filter((r) => r.window_kind === "day").map((r) => r.request_count),
  };
}

/** Backdate every second bucket of a provider (delete+reinsert in one statement: no PK clash). */
async function backdateSeconds(p: string, seconds: number) {
  await db.query(`
    WITH moved AS (
      DELETE FROM public.ai_provider_rate_window WHERE provider = '${p}' AND window_kind = 'second' RETURNING *
    )
    INSERT INTO public.ai_provider_rate_window
    SELECT provider, window_kind, window_start - interval '${seconds} seconds', request_count FROM moved`);
}

/** Seed a second bucket at now() - offset holding `count` grants. */
async function seedSecond(p: string, offset: string, count: number) {
  await db.query(`INSERT INTO public.ai_provider_rate_window
                  VALUES ('${p}', 'second', now() - interval '${offset}', ${count})`);
}

describe.skipIf(!pgAvailable)("acquire_ai_provider_permit (PG17)", () => {
  beforeAll(async () => {
    db = await createSlipTestDb("gemini_rate", [MIGRATION]);
    wide = new Bun.SQL({
      hostname: PGHOST, port: Number(PGPORT), username: PGUSER, password: PGPASSWORD,
      database: db.name, max: 16,
    });
  });
  afterAll(async () => {
    await wide?.close();
    await db?.drop();
  });

  test("48 concurrent calls on 16 connections never exceed p_rpm; both windows move together", async () => {
    const p = provider();
    const results = await Promise.all(Array.from({ length: 48 }, () => acquire(wide, p, 5, 100)));
    const grantedCount = results.filter((r) => r.granted).length;
    expect(grantedCount).toBe(5);
    for (const r of results.filter((x) => !x.granted)) {
      expect(r.reason).toBe("rpm");
      expect(r.retry_after_ms).toBeGreaterThan(0);
      expect(r.retry_after_ms).toBeLessThanOrEqual(61_000);
    }
    // 43 denials consumed nothing: rolling == day == grants.
    expect(await counts(p)).toEqual({ seconds: 5, day: [5] });
  });

  test("rpd is enforced; an rpd denial does not touch the rolling window", async () => {
    const p = provider();
    const results = await Promise.all(Array.from({ length: 12 }, () => acquire(wide, p, 100, 3)));
    expect(results.filter((r) => r.granted)).toHaveLength(3);
    expect(results.filter((r) => !r.granted).every((r) => r.reason === "rpd")).toBe(true);
    expect(await counts(p)).toEqual({ seconds: 3, day: [3] });

    const denied = results.find((r) => !r.granted)!;
    const msToLaMidnight = Number(await db.scalar(`
      SELECT extract(epoch FROM
        ((date_trunc('day', now() AT TIME ZONE 'America/Los_Angeles') + interval '1 day')
          AT TIME ZONE 'America/Los_Angeles') - now()) * 1000`));
    expect(Math.abs(denied.retry_after_ms - msToLaMidnight)).toBeLessThan(10_000);
  });

  test("an rpm denial does not consume day quota", async () => {
    const p = provider();
    for (let i = 0; i < 2; i++) expect((await acquire(db.sql, p, 2, 10)).granted).toBe(true);
    for (let i = 0; i < 5; i++) expect(await acquire(db.sql, p, 2, 10)).toMatchObject({ granted: false, reason: "rpm" });
    expect(await counts(p)).toEqual({ seconds: 2, day: [2] });
  });

  test("admits again once the oldest grants are >60s old; the day keeps counting from LA midnight", async () => {
    const p = provider();
    for (let round = 0; round < 2; round++) {
      expect((await acquire(db.sql, p, 2, 5)).granted).toBe(true);
      expect((await acquire(db.sql, p, 2, 5)).granted).toBe(true);
      expect((await acquire(db.sql, p, 2, 5)).reason).toBe("rpm");
      await backdateSeconds(p, 62);
    }
    expect((await acquire(db.sql, p, 2, 5)).granted).toBe(true);
    await backdateSeconds(p, 62);
    expect((await acquire(db.sql, p, 2, 5)).reason).toBe("rpd");
    expect((await counts(p)).day).toEqual([5]);

    const dayStartIsLaMidnight = await db.scalar(`
      SELECT bool_and((window_start AT TIME ZONE 'America/Los_Angeles')::time = '00:00')
        FROM public.ai_provider_rate_window WHERE provider = '${p}' AND window_kind = 'day'`);
    expect(dayStartIsLaMidnight).toBe("true");
  });

  test("rolling boundary: grants at now-59s (and now-60.5s) count, at now-61s they do not", async () => {
    const at59 = provider();
    await seedSecond(at59, "59 seconds", 3);
    const denied = await acquire(db.sql, at59, 3, 100);
    expect(denied).toMatchObject({ granted: false, reason: "rpm" });
    // Oldest contributing bucket leaves at start + 61 s, i.e. in ~2 s.
    expect(denied.retry_after_ms).toBeGreaterThan(1_000);
    expect(denied.retry_after_ms).toBeLessThanOrEqual(2_100);

    // A 1 s bucket starting 60.5 s ago still holds grants < 60 s old: conservative.
    const at60_5 = provider();
    await seedSecond(at60_5, "60.5 seconds", 3);
    expect((await acquire(db.sql, at60_5, 3, 100)).reason).toBe("rpm");

    const at61 = provider();
    await seedSecond(at61, "61 seconds", 3);
    expect((await acquire(db.sql, at61, 3, 100)).granted).toBe(true);

    // The window is a sum across buckets, not one bucket: 2 + 1 spread over 50 s denies at rpm=3.
    const spread = provider();
    await seedSecond(spread, "50 seconds", 2);
    await seedSecond(spread, "5 seconds", 1);
    expect((await acquire(db.sql, spread, 3, 100)).reason).toBe("rpm");
    expect((await acquire(db.sql, spread, 4, 100)).granted).toBe(true);
  });

  test("old rows are cleaned up opportunistically; other providers are independent", async () => {
    const p = provider();
    const other = provider();
    await db.query(`INSERT INTO public.ai_provider_rate_window VALUES
      ('${p}', 'second', now() - interval '2 hours', 9),
      ('${p}', 'day', now() - interval '60 days', 9),
      ('${other}', 'second', now() - interval '2 hours', 9)`);
    expect((await acquire(db.sql, p, 5, 5)).granted).toBe(true);
    expect(await counts(p)).toEqual({ seconds: 1, day: [1] });
    expect((await counts(other)).seconds).toBe(9);
  });


  test("invalid arguments raise instead of granting", async () => {
    for (const args of ["NULL, 5, 5", "'gemini', 0, 5", "'gemini', 5, NULL"]) {
      const error = await db.query(`SELECT public.acquire_ai_provider_permit(${args})`).then(() => null, (e: unknown) => e);
      expect(String(error)).toContain("invalid arguments");
    }
  });

  test("only service_role may execute; the table has no client grants and RLS on", async () => {
    const priv = await db.query<{ role: string; exec: boolean; tbl: boolean }>(`
      SELECT r AS role,
             has_function_privilege(r, 'public.acquire_ai_provider_permit(text, integer, integer)', 'EXECUTE') AS exec,
             has_table_privilege(r, 'public.ai_provider_rate_window', 'SELECT,INSERT,UPDATE,DELETE') AS tbl
        FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r ORDER BY r`);
    expect(priv).toEqual([
      { role: "anon", exec: false, tbl: false },
      { role: "authenticated", exec: false, tbl: false },
      { role: "service_role", exec: true, tbl: false },
    ]);
    expect(await db.scalar(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ai_provider_rate_window'::regclass`))
      .toBe("true");
    expect(await db.scalar(`SELECT proconfig::text FROM pg_proc WHERE proname = 'acquire_ai_provider_permit'`))
      .toBe('{"search_path=public, pg_temp"}');
  });

  test("TS client end-to-end: 10 lanes share the DB limiter and fail closed without the function", async () => {
    const supa = createPgSupabase(db, { failUpload: new Set(), uploaded: new Map() }) as unknown as SupabaseClient;
    const permit = createGeminiRequestPermit(supa, { rpm: 4, rpd: 100, maxWaitMs: 0 });
    const outcomes = await Promise.all(Array.from({ length: 10 }, () =>
      permit().then(() => "ok", (e: GeminiQuotaUnavailableError) => e.reason)));
    // Provider 'gemini' is not used by any earlier test.
    expect(outcomes.filter((o) => o === "ok")).toHaveLength(4);
    expect(outcomes.filter((o) => o === "rpm")).toHaveLength(6);
    expect(await counts("gemini")).toEqual({ seconds: 4, day: [4] });

    await db.query(`ALTER FUNCTION public.acquire_ai_provider_permit(text, integer, integer) RENAME TO acquire_ai_provider_permit_hidden`);
    try {
      const fresh = createPgSupabase(db, { failUpload: new Set(), uploaded: new Map() }) as unknown as SupabaseClient;
      const err = await createGeminiRequestPermit(fresh, { maxWaitMs: 0 })().catch((e) => e);
      expect(err).toBeInstanceOf(GeminiQuotaUnavailableError);
      expect((err as GeminiQuotaUnavailableError).reason).toBe("limiter_error");
    } finally {
      await db.query(`ALTER FUNCTION public.acquire_ai_provider_permit_hidden(text, integer, integer) RENAME TO acquire_ai_provider_permit`);
    }
  });
});
