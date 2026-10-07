/**
 * PostgreSQL 17 proof for finalized Produce replacement / void lineage
 * (Task 2, migration 20260825091000).
 *
 * The property under test is atomicity: try_finalize_pending_generation must
 * insert the replacement session (+items) AND supersede its named predecessor
 * in the SAME transaction, so there is never a moment where both are live and
 * never a moment where neither is. Everything else the task requires (single
 * quantity/product/price/unit correction, item removal, the seeded document
 * still accepting แก้ข้อ N / ลบข้อ N) is a pure parser property with no
 * database involved and is covered by replacement-draft.test.ts and the
 * existing parser-correction.test.ts (PR #81) — unchanged by this migration.
 *
 * Mirrors the harness in migration-withdrawal-containment.pg.test.ts exactly
 * (same PSQL/PGHOST/PGPORT resolution, same disposable per-run database, same
 * ALLOW_DISPOSABLE_POSTGRES_TESTS gate).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import type { WeighSession } from "@/lib/parsers/weigh-session/types";
import { computeSessionHash } from "@/lib/line/session-dedup-service";
import { weighSessionCompatibilityFingerprints } from "@/lib/produce/business-fingerprint";

const ROOT = join(import.meta.dir, "..", "..", "..");
const WIN_PSQL = "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe";
const PSQL = existsSync(WIN_PSQL) ? WIN_PSQL : "psql";
const PGHOST = process.env.PGHOST ?? "localhost";
const PGUSER = process.env.PGUSER ?? "postgres";
const PGPASSWORD = process.env.PGPASSWORD ?? "postgres";
const PGPORT = process.env.PGPORT ?? "5432";
const DATABASE = `mig_${randomBytes(4).toString("hex")}`;
const DB_NAME_PATTERN = /^mig_[a-f0-9]+$/;
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const DATE = "24/8/2569";
const ISO_DATE = "2026-08-24";
const ACTOR = "U3f04f748584d997819dec0fc71a9b084";
const SOURCE = "C8405e382aafefa28a6bf0b0b15bb2971";

function assertSafe(): void {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
    throw new Error(
      "migration-finalized-session-replacement.pg.test.ts requires ALLOW_DISPOSABLE_POSTGRES_TESTS=1",
    );
  }
  if (!ALLOWED_HOSTS.has(PGHOST)) throw new Error(`refusing PGHOST=${PGHOST}`);
  if (!DB_NAME_PATTERN.test(DATABASE)) throw new Error(`refusing database=${DATABASE}`);
}

function spawnPsql(args: string[], database: string, stdin?: string) {
  return Bun.spawn([PSQL, "-X", ...args], {
    cwd: ROOT,
    stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
    env: { ...process.env, PGHOST, PGUSER, PGPASSWORD, PGPORT, PGDATABASE: database, PGCLIENTENCODING: "UTF8" },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function collect(proc: ReturnType<typeof spawnPsql>) {
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

function psql(args: string[], database = DATABASE, stdin?: string) {
  return collect(spawnPsql(args, database, stdin));
}

function run(sql: string) {
  return psql(["-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"], DATABASE, sql);
}

async function scalar(sql: string): Promise<string> {
  const result = await run(sql);
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

function q(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

interface Row { product: string; price: number; quantity: number; unit: string }

function document(seller: string, market: string, rows: Row[], date = DATE): WeighSession {
  const lines = [`${seller}-${market} เบิก ${date}`];
  rows.forEach((row, index) => {
    lines.push(`${index + 1}.${row.product}${row.price}บาท`);
    lines.push(`${row.quantity}${row.unit}`);
  });
  lines.push("จบรายการเบิก");
  return parseWeighSession(lines.join("\n"), ISO_DATE);
}

async function seedPending(sourceId = SOURCE) {
  const sessionKey = `user:U:${randomBytes(4).toString("hex")}`;
  const generation = randomUUID();
  const rawMessageId = randomUUID();
  await scalar(`
    INSERT INTO public.raw_messages (id, source_id) VALUES (${q(rawMessageId)}::uuid, ${q(sourceId)});
    INSERT INTO public.pending_sessions (
      session_key, session_generation, line_user_id, source_id, ingest_revision,
      close_event_timestamp_ms, close_requested_at, close_deadline_at,
      close_session_generation, next_attempt_at
    ) VALUES (
      ${q(sessionKey)}, ${q(generation)}::uuid, ${q(ACTOR)}, ${q(sourceId)}, 1,
      1000, now(), now() + interval '30 seconds',
      ${q(generation)}::uuid, now() - interval '1 second'
    );
    SELECT 1`);
  return { sessionKey, generation, rawMessageId };
}

function sqlTextArray(values: string[]): string {
  return `ARRAY[${values.map(q).join(", ")}]::text[]`;
}

interface FinalizeOptions {
  replacesProduceSessionId?: string;
  replacementActorId?: string;
  replacementReason?: string;
  emptyItems?: boolean;
  snapshotRevision?: number;
}

function finalizeSql(
  sessionKey: string,
  generation: string,
  rawMessageId: string,
  parsed: WeighSession,
  options: FinalizeOptions = {},
): string {
  const items = options.emptyItems ? [] : parsed.items.map((item) => ({
    item_number: item.item_number,
    product_name: item.product_name,
    price_per_unit: item.price_per_unit,
    quantity: item.quantity,
    unit: item.unit,
    section: item.section,
    transaction_type: item.transaction_type,
  }));
  const sessionPayload: Record<string, unknown> = {
    raw_message_id: rawMessageId,
    staff_name: parsed.staff_name,
    session_date: parsed.date,
    session_title: parsed.session_title,
    transaction_types: [...new Set(items.map((i) => i.transaction_type))].sort().join(","),
    session_kind: parsed.session_kind,
    declared_transaction_type: parsed.declared_transaction_type,
    ingest_idempotency_key: `${sessionKey}:${generation}`,
    ingest_source: "line_webhook",
    validation_errors: [],
  };
  if (options.replacesProduceSessionId) {
    sessionPayload.replaces_produce_session_id = options.replacesProduceSessionId;
  }
  if (options.replacementActorId) sessionPayload.replacement_actor_id = options.replacementActorId;
  if (options.replacementReason) sessionPayload.replacement_reason = options.replacementReason;

  return `SELECT public.try_finalize_pending_generation(
      ${q(sessionKey)}, ${q(generation)}::uuid, ${q(ACTOR)}, ${options.snapshotRevision ?? 1},
      ${q(computeSessionHash(parsed))}, 'raw',
      ${q(JSON.stringify(sessionPayload))}::jsonb,
      ${q(JSON.stringify(items))}::jsonb,
      ${sqlTextArray(weighSessionCompatibilityFingerprints(parsed))}
    )`;
}

type FinalizeResult = { status: string; reason?: string; session_id?: string };

async function submit(parsed: WeighSession, options: FinalizeOptions = {}): Promise<FinalizeResult> {
  const { sessionKey, generation, rawMessageId } = await seedPending();
  return JSON.parse(await scalar(finalizeSql(sessionKey, generation, rawMessageId, parsed, options)));
}

async function produceSessionCount(): Promise<number> {
  return Number(await scalar("SELECT count(*)::text FROM public.produce_sessions"));
}

async function activeSessionCount(seller: string, market: string): Promise<number> {
  return Number(await scalar(`
    SELECT count(*)::text FROM public.produce_sessions
    WHERE staff_name = ${q(seller)} AND session_title = ${q(market)}
      AND session_date = ${q(ISO_DATE)}::date AND voided_at IS NULL`));
}

const pgAvailable = await probe();
let databaseCreated = false;

describe.skipIf(!pgAvailable)("finalized Produce session replacement lifecycle on PostgreSQL 17", () => {
  beforeAll(async () => {
    assertSafe();
    const created = await psql(["-d", "postgres", "-c", `CREATE DATABASE ${DATABASE}`], "postgres");
    expect(created.code, created.stderr).toBe(0);
    databaseCreated = true;
    await apply(join(ROOT, "supabase", "tests", "produce_fingerprint_compatibility_bootstrap.sql"));
    await apply(join(ROOT, "supabase", "migrations", "20260806111646_pending_session_runtime_environment.sql"));
    await apply(join(ROOT, "supabase", "tests", "produce_withdrawal_containment_bootstrap.sql"));
    await apply(join(ROOT, "supabase", "migrations", "20260811181727_round_market_identity_consistency.sql"));
    await apply(join(ROOT, "supabase", "migrations", "20260815213206_produce_market_identity_guard.sql"));
    await apply(join(ROOT, "supabase", "migrations", "20260815212554_produce_fingerprint_compatibility.sql"));
    await apply(join(ROOT, "supabase", "migrations", "20260817080346_produce_withdrawal_containment_guard.sql"));
    await apply(join(ROOT, "supabase", "migrations", "20260817090858_produce_historical_withdrawal_containment.sql"));
    await apply(join(ROOT, "supabase", "migrations", "20260825092015_produce_finalized_session_replacement_lifecycle.sql"));
    await apply(join(ROOT, "supabase", "migrations", "20261007060911_produce_nonblocking_item_count.sql"));
  }, 120_000);

  afterAll(async () => {
    if (!databaseCreated) return;
    await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE}`], "postgres");
  }, 60_000);

  test("declared count accepts an additional 10,11,12,12,13,14 list as six rows", async () => {
    const parsed = parseWeighSession([
      "กี้-ตลาดเพิ่ม เบิกเพิ่ม 24/8/2569",
      ...[10, 11, 12, 12, 13, 14].flatMap(number => [number + ".มังคุด45บาท", "2โล"]),
      "จบรายการเบิกเพิ่ม 6 รายการ",
    ].join("\n"));
    const pending = await seedPending();
    await scalar(`UPDATE public.pending_sessions SET expected_item_count=6 WHERE session_key=${q(pending.sessionKey)} RETURNING 1`);
    const result: FinalizeResult = JSON.parse(await scalar(finalizeSql(pending.sessionKey, pending.generation, pending.rawMessageId, parsed)));
    expect(result.status).toBe("finalized");
    expect(await scalar(`SELECT array_agg(item_number ORDER BY item_number)::text FROM public.produce_items WHERE session_id=${q(result.session_id!)}::uuid`)).toBe("{10,11,12,13,14,15}");
  });

  test("actual count shortfall waits, stale revision refuses, then a complete fresh snapshot finalizes", async () => {
    const first = document("กี้นับ", "ตลาดนับ", [{ product: "มังคุด", price: 45, quantity: 2, unit: "โล" }]);
    const pending = await seedPending();
    await scalar(`UPDATE public.pending_sessions SET expected_item_count=2 WHERE session_key=${q(pending.sessionKey)} RETURNING 1`);
    const waiting = JSON.parse(await scalar(finalizeSql(pending.sessionKey, pending.generation, pending.rawMessageId, first)));
    expect(waiting).toMatchObject({ status: "pending", reason: "missing_items", missing: [2] });
    expect(await scalar(`SELECT terminalized::text FROM public.pending_sessions WHERE session_key=${q(pending.sessionKey)}`)).toBe("false");
    const full = document("กี้นับ", "ตลาดนับ", [{ product: "มังคุด", price: 45, quantity: 2, unit: "โล" }, { product: "ส้ม", price: 30, quantity: 3, unit: "โล" }]);
    await scalar(`UPDATE public.pending_sessions SET ingest_revision=2, next_attempt_at=now()-interval '1 second' WHERE session_key=${q(pending.sessionKey)} RETURNING 1`);
    const stale = JSON.parse(await scalar(finalizeSql(pending.sessionKey, pending.generation, pending.rawMessageId, full)));
    expect(stale.status).toBe("stale_snapshot");
    const result = JSON.parse(await scalar(finalizeSql(pending.sessionKey, pending.generation, pending.rawMessageId, full, { snapshotRevision: 2 })));
    expect(result.status).toBe("finalized");
  });

  test("an actual count shortfall still fails after the immutable close deadline", async () => {
    const first = document("กี้ไม่ครบ", "ตลาดนับ", [{ product: "มังคุด", price: 45, quantity: 2, unit: "โล" }]);
    const pending = await seedPending();
    const before = await produceSessionCount();
    await scalar(`UPDATE public.pending_sessions SET expected_item_count=2, close_deadline_at=now()-interval '1 second' WHERE session_key=${q(pending.sessionKey)} RETURNING 1`);
    expect(JSON.parse(await scalar(finalizeSql(pending.sessionKey, pending.generation, pending.rawMessageId, first))))
      .toMatchObject({ status: "failed_closed", reason: "missing_items", missing: [2] });
    expect(await produceSessionCount()).toBe(before);
  });

  test("count migration reapplication preserves function definition and execute permissions", async () => {
    const signature = "public.try_finalize_pending_generation(text,uuid,text,integer,text,text,jsonb,jsonb,text[])";
    const before = await scalar(`SELECT md5(pg_get_functiondef('${signature}'::regprocedure))`);
    await apply(join(ROOT, "supabase", "migrations", "20261007060911_produce_nonblocking_item_count.sql"));
    expect(await scalar(`SELECT md5(pg_get_functiondef('${signature}'::regprocedure))`)).toBe(before);
    expect(await scalar(`SELECT has_function_privilege('service_role','${signature}','EXECUTE')::text`)).toBe("true");
    expect(await scalar(`SELECT has_function_privilege('anon','${signature}','EXECUTE')::text`)).toBe("false");
    expect(await scalar(`SELECT has_function_privilege('authenticated','${signature}','EXECUTE')::text`)).toBe("false");
  });

  test("a successful replacement atomically supersedes its predecessor, preserving raw evidence", async () => {
    const seller = "กี้ทดแทน";
    const market = "ตลาดทดสอบ";
    const original = document(seller, market, [
      { product: "มังคุด", price: 45, quantity: 10, unit: "โล" },
      { product: "ส้ม", price: 30, quantity: 5, unit: "โล" },
      { product: "อะโวคาโด", price: 80, quantity: 3, unit: "โล" },
    ]);
    const first = await submit(original);
    expect(first.status).toBe("finalized");
    const predecessorId = first.session_id!;

    const corrected = document(seller, market, [
      { product: "มังคุด", price: 45, quantity: 99, unit: "โล" }, // quantity corrected
      { product: "ส้ม", price: 30, quantity: 5, unit: "โล" },
      { product: "อะโวคาโด", price: 80, quantity: 3, unit: "โล" },
    ]);
    const replacement = await submit(corrected, {
      replacesProduceSessionId: predecessorId,
      replacementActorId: ACTOR,
      replacementReason: "operator_correction_replacement",
    });
    expect(replacement.status).toBe("finalized");
    const replacementId = replacement.session_id!;
    expect(replacementId).not.toBe(predecessorId);

    // Predecessor is voided and points at its successor.
    expect(await scalar(`
      SELECT voided_at IS NOT NULL FROM public.produce_sessions WHERE id = ${q(predecessorId)}::uuid`))
      .toBe("t");
    expect(await scalar(`
      SELECT replacement_session_id::text FROM public.produce_sessions WHERE id = ${q(predecessorId)}::uuid`))
      .toBe(replacementId);
    expect(await scalar(`
      SELECT void_reason FROM public.produce_sessions WHERE id = ${q(predecessorId)}::uuid`))
      .toBe("operator_correction_replacement");

    // Raw evidence preserved: predecessor's 3 original items are untouched.
    expect(await scalar(`
      SELECT count(*)::text FROM public.produce_items WHERE session_id = ${q(predecessorId)}::uuid`))
      .toBe("3");
    expect(await scalar(`
      SELECT quantity::text FROM public.produce_items
      WHERE session_id = ${q(predecessorId)}::uuid AND product_name = 'มังคุด'`)).toBe("10");

    // Replacement carries the corrected quantity.
    expect(await scalar(`
      SELECT quantity::text FROM public.produce_items
      WHERE session_id = ${q(replacementId)}::uuid AND product_name = 'มังคุด'`)).toBe("99");

    // Never both counted: exactly one active session for this business identity.
    expect(await activeSessionCount(seller, market)).toBe(1);

    // Historical predecessor remains auditable (never deleted).
    expect(await scalar(`
      SELECT count(*)::text FROM public.produce_sessions WHERE id = ${q(predecessorId)}::uuid`))
      .toBe("1");
  });

  test("a replacement that fails validation leaves the predecessor untouched and persists nothing new", async () => {
    const seller = "กี้ล้มเหลว";
    const market = "ตลาดทดสอบ";
    const original = document(seller, market, [{ product: "มังคุด", price: 45, quantity: 10, unit: "โล" }]);
    const first = await submit(original);
    expect(first.status).toBe("finalized");
    const predecessorId = first.session_id!;
    const before = await produceSessionCount();

    const emptyReplacement = await submit(original, {
      replacesProduceSessionId: predecessorId,
      emptyItems: true,
    });
    expect(emptyReplacement.status).toBe("failed_closed");
    expect(emptyReplacement.reason).toBe("validation_failed");

    expect(await produceSessionCount()).toBe(before);
    expect(await scalar(`
      SELECT voided_at IS NULL FROM public.produce_sessions WHERE id = ${q(predecessorId)}::uuid`))
      .toBe("t");
  });

  test("retrying the exact same finalize call is idempotent and never re-supersedes", async () => {
    const seller = "กี้ซ้ำ";
    const market = "ตลาดทดสอบ";
    const original = document(seller, market, [{ product: "มังคุด", price: 45, quantity: 10, unit: "โล" }]);
    const first = await submit(original);
    const predecessorId = first.session_id!;

    const corrected = document(seller, market, [{ product: "มังคุด", price: 45, quantity: 20, unit: "โล" }]);
    const { sessionKey, generation, rawMessageId } = await seedPending();
    const replacementSql = finalizeSql(sessionKey, generation, rawMessageId, corrected, {
      replacesProduceSessionId: predecessorId,
    });
    const firstAttempt: FinalizeResult = JSON.parse(await scalar(replacementSql));
    expect(firstAttempt.status).toBe("finalized");
    const before = await produceSessionCount();
    const voidedAtAfterFirst = await scalar(`
      SELECT voided_at::text FROM public.produce_sessions WHERE id = ${q(predecessorId)}::uuid`);

    // Exact retry: same session_key/generation, already terminalized.
    const secondAttempt: FinalizeResult = JSON.parse(await scalar(replacementSql));
    expect(secondAttempt.status).not.toBe("finalized");

    expect(await produceSessionCount()).toBe(before);
    expect(await scalar(`
      SELECT voided_at::text FROM public.produce_sessions WHERE id = ${q(predecessorId)}::uuid`))
      .toBe(voidedAtAfterFirst);
  });

  test("an unknown predecessor is refused without persisting anything", async () => {
    const seller = "กี้ไม่มีจริง";
    const market = "ตลาดทดสอบ";
    const doc = document(seller, market, [{ product: "มังคุด", price: 45, quantity: 10, unit: "โล" }]);
    const before = await produceSessionCount();
    const result = await submit(doc, { replacesProduceSessionId: randomUUID() });
    expect(result.status).toBe("failed_closed");
    expect(result.reason).toBe("replacement_predecessor_not_found");
    expect(await produceSessionCount()).toBe(before);
  });

  test("a replacement whose business identity does not match its named predecessor is refused", async () => {
    const market = "ตลาดทดสอบ";
    const original = document("กี้ตัวจริง", market, [{ product: "มังคุด", price: 45, quantity: 10, unit: "โล" }]);
    const first = await submit(original);
    const predecessorId = first.session_id!;
    const before = await produceSessionCount();

    // Same market/date, DIFFERENT staff — must not be accepted as "the same session".
    const impostor = document("คนละคน", market, [{ product: "มังคุด", price: 45, quantity: 20, unit: "โล" }]);
    const result = await submit(impostor, { replacesProduceSessionId: predecessorId });
    expect(result.status).toBe("failed_closed");
    expect(result.reason).toBe("replacement_predecessor_identity_mismatch");

    expect(await produceSessionCount()).toBe(before);
    expect(await scalar(`
      SELECT voided_at IS NULL FROM public.produce_sessions WHERE id = ${q(predecessorId)}::uuid`))
      .toBe("t");
  });

  test("two replacement drafts racing on the same predecessor: only the winner supersedes it", async () => {
    const seller = "กี้แข่ง";
    const market = "ตลาดทดสอบ";
    const original = document(seller, market, [{ product: "มังคุด", price: 45, quantity: 10, unit: "โล" }]);
    const first = await submit(original);
    const predecessorId = first.session_id!;

    const winnerDoc = document(seller, market, [{ product: "มังคุด", price: 45, quantity: 11, unit: "โล" }]);
    const loserDoc = document(seller, market, [{ product: "มังคุด", price: 45, quantity: 12, unit: "โล" }]);
    const winner = await seedPending();
    const loser = await seedPending();

    // Winner holds the predecessor's row lock across a pause (BEGIN ... pg_sleep
    // ... COMMIT); loser must block on the SAME row and only proceed once the
    // winner's supersede has committed.
    const procWinner = spawnPsql(
      ["-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
      DATABASE,
      `BEGIN;\n${finalizeSql(winner.sessionKey, winner.generation, winner.rawMessageId, winnerDoc, {
        replacesProduceSessionId: predecessorId,
      })};\nSELECT pg_sleep(2);\nCOMMIT;`,
    );
    await Bun.sleep(500);
    const procLoser = spawnPsql(
      ["-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
      DATABASE,
      `${finalizeSql(loser.sessionKey, loser.generation, loser.rawMessageId, loserDoc, {
        replacesProduceSessionId: predecessorId,
      })};`,
    );

    const [winnerResult, loserResult] = await Promise.all([collect(procWinner), collect(procLoser)]);
    expect(winnerResult.code, winnerResult.stderr).toBe(0);
    expect(loserResult.code, loserResult.stderr).toBe(0);
    expect(winnerResult.stdout).toContain('"finalized"');
    expect(loserResult.stdout).toContain("replacement_predecessor_already_superseded");

    // Exactly one active session for this identity — the winner's.
    expect(await activeSessionCount(seller, market)).toBe(1);
  }, 30_000);
});
