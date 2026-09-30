/** Real PostgreSQL 17 proof: stale LINE webhook queue rows are quarantined, never replayed. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const ROOT = join(import.meta.dir, "..", "..", "..");
const WIN_PSQL = "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe";
const PSQL = existsSync(WIN_PSQL) ? WIN_PSQL : "psql";
const PGHOST = process.env.PGHOST ?? "localhost";
const PGUSER = process.env.PGUSER ?? "postgres";
const PGPASSWORD = process.env.PGPASSWORD ?? "postgres";
const PGPORT = process.env.PGPORT ?? "5432";
const DATABASE = `wsn_stale_${randomBytes(4).toString("hex")}`;
const DB_NAME_PATTERN = /^wsn_stale_[a-f0-9]+$/;
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function assertSafe(): void {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
    throw new Error("migration-webhook-stale-queue.pg.test.ts requires ALLOW_DISPOSABLE_POSTGRES_TESTS=1");
  }
  if (!ALLOWED_HOSTS.has(PGHOST)) throw new Error(`refusing PGHOST=${PGHOST}`);
  if (!DB_NAME_PATTERN.test(DATABASE)) throw new Error(`refusing database=${DATABASE}`);
}

type PsqlResult = { code: number; stdout: string; stderr: string };
async function psql(args: string[], database = DATABASE): Promise<PsqlResult> {
  const proc = Bun.spawn([PSQL, "-X", ...args], {
    cwd: ROOT,
    env: { ...process.env, PGHOST, PGUSER, PGPASSWORD, PGPORT, PGDATABASE: database },
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
  const result = await psql(["-v", "ON_ERROR_STOP=1", "-tAc", sql]);
  if (result.code !== 0) throw new Error(`${result.stderr || result.stdout}\nSQL: ${sql}`);
  return result.stdout.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

async function apply(file: string): Promise<void> {
  const result = await psql(["-v", "ON_ERROR_STOP=1", "-f", file]);
  expect(result.code, `${file}\n${result.stderr}\n${result.stdout}`).toBe(0);
}

async function probe(): Promise<boolean> {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1" || !ALLOWED_HOSTS.has(PGHOST)) return false;
  try {
    const result = await psql(["-tAc", "SHOW server_version_num"], "postgres");
    return result.code === 0 && Number(result.stdout.trim()) >= 170000;
  } catch {
    return false;
  }
}

const pgAvailable = await probe();
let databaseCreated = false;
if (!pgAvailable && process.env.WSN_STALE_REQUIRE === "1") {
  throw new Error("WSN_STALE_REQUIRE=1 but PostgreSQL 17 harness unavailable");
}

async function receive(eventId: string, source = "S-ordered", timestamp = Date.now()): Promise<string> {
  const result = await scalar(`
    SELECT public.receive_line_webhook_event(
      '${eventId}', 'dest', 'message', 'user', '${source}', '${source}',
      '${eventId}', 'text', 'test',
      jsonb_build_object('type','message','webhookEventId','${eventId}',
        'timestamp', ${timestamp}, 'source', jsonb_build_object('type','user','userId','${source}'),
        'message', jsonb_build_object('type','text','id','${eventId}','text','test'))
    )`);
  return JSON.parse(result).raw_message_id;
}

async function age(rawMessageId: string, minutes: number): Promise<void> {
  await scalar(`UPDATE public.line_webhook_event_queue SET received_at = now() - interval '${minutes} minutes' WHERE raw_message_id='${rawMessageId}' RETURNING id`);
}

async function status(rawMessageId: string): Promise<string> {
  return scalar(`SELECT status FROM public.line_webhook_event_queue WHERE raw_message_id='${rawMessageId}'`);
}

async function reconcile(): Promise<{
  quarantined: number;
  surfaced: Array<{ raw_message_id: string; line_event_id: string }>;
  pending_count: number;
  oldest_pending_age_seconds: number | null;
  stale_count: number;
}> {
  return JSON.parse(await scalar("SELECT public.reconcile_line_webhook_queue(20)"));
}

describe.skipIf(!pgAvailable)("stale LINE webhook queue review on PostgreSQL 17", () => {
  beforeAll(async () => {
    assertSafe();
    const created = await psql(["-d", "postgres", "-c", `CREATE DATABASE ${DATABASE}`], "postgres");
    expect(created.code, created.stderr).toBe(0);
    databaseCreated = true;
    for (const name of [
      "0001_initial_schema.sql",
      "0038_digital_white_sheet_cash_entries.sql",
      "0043_white_sheet_lifecycle.sql",
      "20260801092255_manual_white_sheet_note_sessions.sql",
      "20260801140442_manual_white_sheet_event_ordering.sql",
      "20260915170100_line_webhook_queue_retryable_completion.sql",
      "20260919134000_line_webhook_semantic_timestamp_order.sql",
      "20260930090000_line_webhook_stale_queue_review.sql",
    ]) await apply(join(ROOT, "supabase", "migrations", name));
  }, 60_000);

  afterAll(async () => {
    if (!databaseCreated) return;
    await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE}`], "postgres");
  }, 60_000);

  test("a recent pending row still recovers through the normal claim", async () => {
    const raw = await receive("evt-recent", "S-recent");
    await age(raw, 59);
    expect(JSON.parse(await scalar("SELECT public.claim_line_webhook_event('S-recent')")))
      .toMatchObject({ raw_message_id: raw });
  });

  test("a stale pending row is never claimed and no longer blocks later events", async () => {
    const source = "S-stale-head";
    const stale = await receive("evt-stale-head", source, 1000);
    const recent = await receive("evt-after-stale", source, 2000);
    await age(stale, 61);

    const claim = JSON.parse(await scalar(`SELECT public.claim_line_webhook_event('${source}')`));
    expect(claim).toMatchObject({ raw_message_id: recent });
    expect(await status(stale)).toBe("stale");
    expect(await scalar(`SELECT processing_attempts FROM public.line_webhook_event_queue WHERE raw_message_id='${stale}'`)).toBe("0");
    await scalar(`SELECT public.complete_line_webhook_event('${recent}', '${claim.claim_token}', 'processed')`);
    expect(await scalar(`SELECT public.claim_line_webhook_event('${source}')`)).toBe("");
  });

  test("a stale row released back to pending by a retryable failure is not replayed", async () => {
    const source = "S-stale-retry";
    const raw = await receive("evt-stale-retry", source);
    const claim = JSON.parse(await scalar(`SELECT public.claim_line_webhook_event('${source}')`));
    await age(raw, 61);
    expect(await scalar(`SELECT public.complete_line_webhook_event('${raw}', '${claim.claim_token}', 'pending', 'Gateway Timeout')`)).toBe("t");

    expect(await scalar(`SELECT public.claim_line_webhook_event('${source}')`)).toBe("");
    expect(await status(raw)).toBe("stale");
  });

  test("an old lease-expired processing row is quarantined; an old fresh lease still barriers", async () => {
    const expired = await receive("evt-old-expired", "S-old-expired");
    await scalar("SELECT public.claim_line_webhook_event('S-old-expired')");
    await age(expired, 90);
    await scalar(`UPDATE public.line_webhook_event_queue SET processing_started_at = now() - interval '6 minutes' WHERE raw_message_id='${expired}' RETURNING id`);
    expect(await scalar("SELECT public.claim_line_webhook_event('S-old-expired')")).toBe("");
    expect(await scalar(`SELECT status || '|' || (claim_token IS NULL)::text FROM public.line_webhook_event_queue WHERE raw_message_id='${expired}'`)).toBe("stale|true");

    const inFlight = await receive("evt-old-inflight", "S-old-inflight", 1000);
    const later = await receive("evt-after-inflight", "S-old-inflight", 2000);
    const inFlightClaim = JSON.parse(await scalar("SELECT public.claim_line_webhook_event('S-old-inflight')"));
    await age(inFlight, 90);
    expect(await scalar("SELECT public.claim_line_webhook_event('S-old-inflight')")).toBe("");
    expect(await status(inFlight)).toBe("processing");
    // The in-flight worker still owns its fenced completion.
    expect(await scalar(`SELECT public.complete_line_webhook_event('${inFlight}', '${inFlightClaim.claim_token}', 'processed')`)).toBe("t");
    expect(JSON.parse(await scalar("SELECT public.claim_line_webhook_event('S-old-inflight')")))
      .toMatchObject({ raw_message_id: later });
  });

  test("reconcile quarantines idle sources and surfaces each stale row exactly once", async () => {
    const quiet = await receive("evt-quiet-stale", "S-quiet");
    await age(quiet, 120);

    const first = await reconcile();
    expect(first.quarantined).toBeGreaterThanOrEqual(1);
    expect(first.surfaced.map((row) => row.raw_message_id)).toContain(quiet);
    expect(await status(quiet)).toBe("stale");

    const second = await reconcile();
    expect(second.quarantined).toBe(0);
    expect(second.surfaced).toEqual([]);
    expect(second.stale_count).toBe(first.stale_count);
    expect(await status(quiet)).toBe("stale");
  });

  test("concurrent reconciles surface a stale row to exactly one caller", async () => {
    const raws: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const raw = await receive(`evt-race-stale-${index}`, `S-race-${index}`);
      await age(raw, 61);
      raws.push(raw);
    }
    const results = await Promise.all([reconcile(), reconcile(), reconcile()]);
    const surfaced = results.flatMap((result) => result.surfaced.map((row) => row.raw_message_id));
    for (const raw of raws) expect(surfaced.filter((id) => id === raw)).toHaveLength(1);
    expect(await scalar(`SELECT count(*) FROM public.line_webhook_event_queue WHERE raw_message_id IN ('${raws.join("','")}') AND status='stale' AND stale_surfaced_at IS NOT NULL`)).toBe("5");
  });

  test("concurrent claims and reconciles never claim a stale row and surface it once", async () => {
    const stale: string[] = [];
    const recent: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const source = `S-mix-${index}`;
      const old = await receive(`evt-mix-stale-${index}`, source, 1000);
      recent.push(await receive(`evt-mix-recent-${index}`, source, 2000));
      await age(old, 61);
      stale.push(old);
    }
    const runs = await Promise.all([
      ...stale.flatMap((_, index) => [
        scalar(`SELECT public.claim_line_webhook_event('S-mix-${index}')`),
        scalar(`SELECT public.claim_line_webhook_event('S-mix-${index}')`),
      ]),
      reconcile(), reconcile(), reconcile(),
    ]);
    const claimed = runs.slice(0, stale.length * 2)
      .filter((value): value is string => typeof value === "string" && value !== "")
      .map((value) => JSON.parse(value).raw_message_id);
    for (const raw of claimed) expect(recent).toContain(raw);
    expect(new Set(claimed).size).toBe(claimed.length);

    const surfaced = [
      ...(runs.slice(stale.length * 2) as Awaited<ReturnType<typeof reconcile>>[]),
      await reconcile(),
    ].flatMap((result) => result.surfaced.map((row) => row.raw_message_id));
    for (const raw of stale) expect(surfaced.filter((id) => id === raw)).toHaveLength(1);
    expect(await scalar(`SELECT count(*) FROM public.line_webhook_event_queue WHERE raw_message_id IN ('${stale.join("','")}') AND status='stale' AND processing_attempts=0`)).toBe(String(stale.length));
  });

  test("metrics report pending backlog age; manual dismissal closes a stale row without replay", async () => {
    const pending = await receive("evt-metric-pending", "S-metric");
    await age(pending, 30);
    const metrics = await reconcile();
    expect(metrics.pending_count).toBeGreaterThanOrEqual(1);
    expect(metrics.oldest_pending_age_seconds).toBeGreaterThanOrEqual(30 * 60 - 5);

    const stale = await receive("evt-dismiss", "S-dismiss");
    await age(stale, 61);
    const before = (await reconcile()).stale_count;
    await scalar(`UPDATE public.line_webhook_event_queue SET status='failed', error_message='manual review: dismissed stale event' WHERE raw_message_id='${stale}' RETURNING id`);
    expect((await reconcile()).stale_count).toBe(before - 1);
    expect(await scalar("SELECT public.claim_line_webhook_event('S-dismiss')")).toBe("");
  });

  test("the new RPCs are service-role only", async () => {
    for (const fn of [
      "public.reconcile_line_webhook_queue(integer)",
      "public.quarantine_stale_line_webhook_events(text)",
    ]) {
      expect(await scalar(`SELECT has_function_privilege('anon', '${fn}', 'EXECUTE')`)).toBe("f");
      expect(await scalar(`SELECT has_function_privilege('authenticated', '${fn}', 'EXECUTE')`)).toBe("f");
      expect(await scalar(`SELECT has_function_privilege('service_role', '${fn}', 'EXECUTE')`)).toBe("t");
    }
  });
});

if (!pgAvailable) describe("stale webhook queue PostgreSQL 17 unavailable", () => test.skip("requires local PostgreSQL 17", () => {}));
