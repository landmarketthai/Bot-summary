/** Real PostgreSQL 17 proof for the separated LINE webhook ordering queue. */
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
const DATABASE = `wsn_0060_${randomBytes(4).toString("hex")}`;
const DB_NAME_PATTERN = /^wsn_0060_[a-f0-9]+$/;
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function assertSafe(): void {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
    throw new Error("migration-0060.pg.test.ts requires ALLOW_DISPOSABLE_POSTGRES_TESTS=1");
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
if (!pgAvailable && process.env.WSN_0060_REQUIRE === "1") {
  throw new Error("WSN_0060_REQUIRE=1 but PostgreSQL 17 harness unavailable");
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

describe.skipIf(!pgAvailable)("0060 separated webhook ordering on PostgreSQL 17", () => {
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
    ]) await apply(join(ROOT, "supabase", "migrations", name));
  }, 60_000);

  afterAll(async () => {
    if (!databaseCreated) return;
    await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE}`], "postgres");
  }, 60_000);

  test("receive order is durable and array order is preserved", async () => {
    await receive("evt-open");
    await receive("evt-field");
    await receive("evt-close");
    expect(await scalar("SELECT string_agg(line_event_id, ',' ORDER BY receive_order) FROM public.line_webhook_event_queue WHERE source_id='S-ordered'")).toBe("evt-open,evt-field,evt-close");
  });

  test("atomic receive is idempotent and repairs a retry without duplicate rows", async () => {
    const first = await receive("evt-duplicate");
    const second = await receive("evt-duplicate");
    expect(second).toBe(first);
    expect(await scalar("SELECT count(*) FROM public.raw_messages WHERE line_event_id='evt-duplicate'")).toBe("1");
    expect(await scalar("SELECT count(*) FROM public.line_webhook_event_queue WHERE line_event_id='evt-duplicate'")).toBe("1");
  });

  test("LINE timestamp outranks network receive order around a forwarded close", async () => {
    const source = "S-semantic-order";
    const closeRaw = await receive("evt-semantic-close", source, 2000);
    const itemRaw = await receive("evt-semantic-item", source, 1900);
    const first = JSON.parse(await scalar("SELECT public.claim_line_webhook_event('S-semantic-order')"));
    expect(first).toMatchObject({ raw_message_id: itemRaw });
    await scalar(`SELECT public.complete_line_webhook_event('${itemRaw}', '${first.claim_token}', 'processed')`);
    const second = JSON.parse(await scalar("SELECT public.claim_line_webhook_event('S-semantic-order')"));
    expect(second).toMatchObject({ raw_message_id: closeRaw });
  });

  test("a claimed close does not barrier a late-arriving timestamp-earlier item", async () => {
    const source = "S-late-semantic-repair";
    const closeRaw = await receive("evt-late-close", source, 3000);
    const close = JSON.parse(await scalar("SELECT public.claim_line_webhook_event('S-late-semantic-repair')"));
    expect(close).toMatchObject({ raw_message_id: closeRaw });
    const itemRaw = await receive("evt-late-item", source, 2900);
    const repair = JSON.parse(await scalar("SELECT public.claim_line_webhook_event('S-late-semantic-repair')"));
    expect(repair).toMatchObject({ raw_message_id: itemRaw });
  });

  test("equal LINE timestamps keep durable receive order as tie-breaker", async () => {
    const source = "S-semantic-tie";
    const firstRaw = await receive("evt-tie-1", source, 4000);
    await receive("evt-tie-2", source, 4000);
    const claim = JSON.parse(await scalar("SELECT public.claim_line_webhook_event('S-semantic-tie')"));
    expect(claim).toMatchObject({ raw_message_id: firstRaw });
  });

  test("a close cannot claim while an earlier field is processing, then proceeds after explicit success", async () => {
    const source = "S-barrier";
    const openRaw = await receive("evt-b-open", source);
    const fieldRaw = await receive("evt-b-field", source);
    const closeRaw = await receive("evt-b-close", source);
    const openClaim = JSON.parse(await scalar("SELECT public.claim_line_webhook_event('S-barrier')"));
    expect(openClaim).toMatchObject({ raw_message_id: openRaw });
    await scalar(`SELECT public.complete_line_webhook_event('${openRaw}', '${openClaim.claim_token}', 'processed')`);
    const fieldClaim = JSON.parse(await scalar("SELECT public.claim_line_webhook_event('S-barrier')"));
    expect(fieldClaim).toMatchObject({ raw_message_id: fieldRaw });
    expect(await scalar("SELECT public.claim_line_webhook_event('S-barrier')")).toBe("");
    await scalar(`SELECT public.complete_line_webhook_event('${fieldRaw}', '${fieldClaim.claim_token}', 'processed')`);
    expect(JSON.parse(await scalar("SELECT public.claim_line_webhook_event('S-barrier')"))).toMatchObject({ raw_message_id: closeRaw });
  });

  test("retryable completion returns the same event to pending before later events", async () => {
    const source = "S-retryable";
    const first = await receive("evt-retryable-1", source);
    const second = await receive("evt-retryable-2", source);
    const claim = JSON.parse(await scalar("SELECT public.claim_line_webhook_event('S-retryable')"));
    expect(claim).toMatchObject({ raw_message_id: first });
    expect(await scalar(`SELECT public.complete_line_webhook_event('${first}', '${claim.claim_token}', 'pending', 'Gateway Timeout')`)).toBe("t");
    expect(await scalar(`SELECT status || '|' || (claim_token IS NULL)::text || '|' || (completed_at IS NULL)::text FROM public.line_webhook_event_queue WHERE raw_message_id='${first}'`)).toBe("pending|true|true");
    const retry = JSON.parse(await scalar("SELECT public.claim_line_webhook_event('S-retryable')"));
    expect(retry).toMatchObject({ raw_message_id: first });
    await scalar(`SELECT public.complete_line_webhook_event('${first}', '${retry.claim_token}', 'processed')`);
    expect(JSON.parse(await scalar("SELECT public.claim_line_webhook_event('S-retryable')"))).toMatchObject({ raw_message_id: second });
  });

  test("failed earlier event explicitly unblocks later close", async () => {
    const source = "S-failed";
    const first = await receive("evt-failed-1", source);
    const second = await receive("evt-failed-2", source);
    const claim = JSON.parse(await scalar("SELECT public.claim_line_webhook_event('S-failed')"));
    await scalar(`SELECT public.complete_line_webhook_event('${first}', '${claim.claim_token}', 'failed', 'invalid field block')`);
    expect(JSON.parse(await scalar("SELECT public.claim_line_webhook_event('S-failed')"))).toMatchObject({ raw_message_id: second });
  });

  test("different sources do not share the ordering barrier", async () => {
    const first = await receive("evt-a", "S-a");
    const second = await receive("evt-b", "S-b");
    const [a, b] = await Promise.all([
      scalar("SELECT public.claim_line_webhook_event('S-a')"),
      scalar("SELECT public.claim_line_webhook_event('S-b')"),
    ]);
    expect(JSON.parse(a)).toMatchObject({ raw_message_id: first });
    expect(JSON.parse(b)).toMatchObject({ raw_message_id: second });
  });

  test("a fresh processing lease cannot be stolen", async () => {
    const raw = await receive("evt-fresh", "S-fresh");
    expect(JSON.parse(await scalar("SELECT public.claim_line_webhook_event('S-fresh')"))).toMatchObject({ raw_message_id: raw });
    expect(await scalar("SELECT public.claim_line_webhook_event('S-fresh')")).toBe("");
    expect(await scalar("SELECT processing_attempts FROM public.line_webhook_event_queue WHERE source_id='S-fresh'" )).toBe("1");
    expect(await scalar("SELECT processing_started_at IS NOT NULL FROM public.line_webhook_event_queue WHERE source_id='S-fresh'" )).toBe("t");
  });

  test("a stale processing lease is reclaimed and refreshes its attempt metadata", async () => {
    const raw = await receive("evt-stale", "S-stale");
    const firstClaim = JSON.parse(await scalar("SELECT public.claim_line_webhook_event('S-stale')"));
    await scalar("UPDATE public.line_webhook_event_queue SET processing_started_at = now() - interval '6 minutes' WHERE source_id='S-stale' RETURNING id");

    const reclaimed = JSON.parse(await scalar("SELECT public.claim_line_webhook_event('S-stale')"));
    expect(reclaimed).toMatchObject({ raw_message_id: raw });
    expect(reclaimed.claim_token).not.toBe(firstClaim.claim_token);
    expect(await scalar("SELECT processing_attempts FROM public.line_webhook_event_queue WHERE source_id='S-stale'" )).toBe("2");
    expect(await scalar("SELECT processing_started_at > now() - interval '1 minute' FROM public.line_webhook_event_queue WHERE source_id='S-stale'" )).toBe("t");
  });

  test("exactly one concurrent worker wins a stale reclaim", async () => {
    const raw = await receive("evt-reclaim-race", "S-reclaim-race");
    await scalar("SELECT public.claim_line_webhook_event('S-reclaim-race')");
    await scalar("UPDATE public.line_webhook_event_queue SET processing_started_at = now() - interval '6 minutes' WHERE source_id='S-reclaim-race' RETURNING id");

    const claims = await Promise.all([
      scalar("SELECT public.claim_line_webhook_event('S-reclaim-race')"),
      scalar("SELECT public.claim_line_webhook_event('S-reclaim-race')"),
    ]);
    const winners = claims.filter(Boolean).map((claim) => JSON.parse(claim));
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ raw_message_id: raw });
    expect(await scalar("SELECT processing_attempts FROM public.line_webhook_event_queue WHERE source_id='S-reclaim-race'" )).toBe("2");
  });

  test("a stale predecessor is reclaimed before the later event can proceed", async () => {
    const first = await receive("evt-stale-first", "S-stale-barrier");
    const second = await receive("evt-stale-second", "S-stale-barrier");
    await scalar("SELECT public.claim_line_webhook_event('S-stale-barrier')");
    await scalar("UPDATE public.line_webhook_event_queue SET processing_started_at = now() - interval '6 minutes' WHERE raw_message_id='" + first + "' RETURNING id");

    const reclaimed = JSON.parse(await scalar("SELECT public.claim_line_webhook_event('S-stale-barrier')"));
    expect(reclaimed).toMatchObject({ raw_message_id: first });
    await scalar(`SELECT public.complete_line_webhook_event('${first}', '${reclaimed.claim_token}', 'processed')`);
    expect(JSON.parse(await scalar("SELECT public.claim_line_webhook_event('S-stale-barrier')"))).toMatchObject({ raw_message_id: second });
  });

  test("processed and failed rows are never reclaimed", async () => {
    const processed = await receive("evt-terminal-processed", "S-terminal-processed");
    const processedClaim = JSON.parse(await scalar("SELECT public.claim_line_webhook_event('S-terminal-processed')"));
    await scalar(`SELECT public.complete_line_webhook_event('${processed}', '${processedClaim.claim_token}', 'processed')`);
    await scalar("UPDATE public.line_webhook_event_queue SET processing_started_at = now() - interval '6 minutes' WHERE raw_message_id='" + processed + "' RETURNING id");

    const failed = await receive("evt-terminal-failed", "S-terminal-failed");
    const failedClaim = JSON.parse(await scalar("SELECT public.claim_line_webhook_event('S-terminal-failed')"));
    await scalar(`SELECT public.complete_line_webhook_event('${failed}', '${failedClaim.claim_token}', 'failed', 'expected failure')`);
    await scalar("UPDATE public.line_webhook_event_queue SET processing_started_at = now() - interval '6 minutes' WHERE raw_message_id='" + failed + "' RETURNING id");

    expect(await scalar("SELECT public.claim_line_webhook_event('S-terminal-processed')")).toBe("");
    expect(await scalar("SELECT public.claim_line_webhook_event('S-terminal-failed')")).toBe("");
    expect(await scalar("SELECT string_agg(status, ',' ORDER BY status) FROM public.line_webhook_event_queue WHERE raw_message_id IN ('" + processed + "','" + failed + "')" )).toBe("failed,processed");
  });

  test("only the current claim token can complete a reclaimed event", async () => {
    const raw = await receive("evt-fenced", "S-fenced");
    const workerA = JSON.parse(await scalar("SELECT public.claim_line_webhook_event('S-fenced')"));
    await scalar("UPDATE public.line_webhook_event_queue SET processing_started_at = now() - interval '6 minutes' WHERE source_id='S-fenced' RETURNING id");
    const workerB = JSON.parse(await scalar("SELECT public.claim_line_webhook_event('S-fenced')"));

    expect(workerB.claim_token).not.toBe(workerA.claim_token);
    expect(await scalar(`SELECT public.complete_line_webhook_event('${raw}', '${workerA.claim_token}', 'processed')`)).toBe("f");
    expect(await scalar("SELECT status FROM public.line_webhook_event_queue WHERE raw_message_id='" + raw + "'")).toBe("processing");
    expect(await scalar(`SELECT public.complete_line_webhook_event('${raw}', '${workerB.claim_token}', 'processed')`)).toBe("t");
    expect(await scalar(`SELECT public.complete_line_webhook_event('${raw}', '${workerB.claim_token}', 'processed')`)).toBe("f");
    expect(await scalar("SELECT status || ',' || (claim_token IS NULL)::text FROM public.line_webhook_event_queue WHERE raw_message_id='" + raw + "'")).toBe("processed,true");
  });
});

if (!pgAvailable) describe("0060 PostgreSQL 17 unavailable", () => test.skip("requires local PostgreSQL 17", () => {}));
