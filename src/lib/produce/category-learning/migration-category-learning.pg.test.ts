import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const PSQL = existsSync("C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe")
  ? "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe" : "psql";
const PGHOST = process.env.PGHOST ?? "localhost";
const PGUSER = process.env.PGUSER ?? "postgres";
const PGPASSWORD = process.env.PGPASSWORD ?? "postgres";
const PGPORT = process.env.PGPORT ?? "5432";
const DATABASE = `pcl_${randomBytes(4).toString("hex")}`;
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const BOOTSTRAP = join(ROOT, "supabase", "tests", "produce_product_code_dictionary_bootstrap.sql");
const MIGRATION = join(ROOT, "supabase", "migrations", "20261022120000_produce_category_learning.sql");
const QUEUE_MIGRATION = join(ROOT, "supabase", "migrations", "20261022130000_produce_category_announce_queue.sql");

type PsqlResult = { code: number; stdout: string; stderr: string };

async function psql(args: string[], database = DATABASE, stdin?: string): Promise<PsqlResult> {
  const proc = Bun.spawn([PSQL, "-X", ...args], {
    cwd: ROOT,
    stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
    env: { ...process.env, PGHOST, PGUSER, PGPASSWORD, PGPORT, PGDATABASE: database, PGCLIENTENCODING: "UTF8" },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function run(sql: string): Promise<PsqlResult> {
  return psql(["-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"], DATABASE, sql);
}

async function scalar(sql: string): Promise<string> {
  const result = await run(sql);
  if (result.code !== 0) throw new Error(`${result.stderr || result.stdout}\nSQL: ${sql}`);
  return result.stdout.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

async function probe(): Promise<boolean> {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1" || !ALLOWED_HOSTS.has(PGHOST)) return false;
  const result = await psql(["-tAc", "SHOW server_version_num"], "postgres");
  return result.code === 0 && Number(result.stdout.trim()) >= 140000;
}

const pgAvailable = await probe();
let databaseCreated = false;
if (!pgAvailable && process.env.REQUIRE_CATEGORY_LEARNING_POSTGRES === "1") {
  throw new Error("REQUIRE_CATEGORY_LEARNING_POSTGRES=1 but PostgreSQL is unavailable");
}

const q = (value: string | null) => (value === null ? "NULL" : `'${value.replaceAll("'", "''")}'`);

function observe(name: string, suggested: string | null, similar: string | null = null, occurrences = 3) {
  return scalar(`SELECT row_to_json(c)::text FROM public.observe_produce_category_candidate(
    ${q(name)}, ${q(suggested)}, 'medium', 'test', ${q(similar)}, ${occurrences}, 2,
    DATE '2026-10-19', DATE '2026-10-20', ARRAY['ตลาดA']) c`).then((text) => JSON.parse(text));
}

function decide(id: string, revision: number, action: string, category: string | null, eventId: string, alias: string | null = null) {
  return scalar(`SELECT public.decide_produce_category_candidate(
    ${q(id)}::uuid, ${revision}, ${q(action)}, ${q(category)}, ${q(alias)}, 'Uadmin', 'Ctestgroup', ${q(eventId)})::text`)
    .then((text) => JSON.parse(text));
}

describe.skipIf(!pgAvailable)("produce category learning migration", () => {
  beforeAll(async () => {
    const created = await psql(["-d", "postgres", "-c", `CREATE DATABASE ${DATABASE}`], "postgres");
    expect(created.code, created.stderr).toBe(0);
    databaseCreated = true;
    for (const file of [BOOTSTRAP, MIGRATION, QUEUE_MIGRATION]) {
      const applied = await psql(["-v", "ON_ERROR_STOP=1", "-f", file]);
      expect(applied.code, `${file}\n${applied.stderr}`).toBe(0);
    }
  });

  afterAll(async () => {
    if (databaseCreated) await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`], "postgres");
  });

  test("approval writes one rule and one audit row; a replayed LINE event is a no-op", async () => {
    const c = await observe("ผักทดสอบ", "ผ");
    expect(c).toMatchObject({ status: "pending", revision: 1 });
    expect(await decide(c.id, 1, "approve_suggested", null, "evt-approve")).toMatchObject({ status: "applied", category_code: "ผ" });
    expect(await decide(c.id, 1, "approve_suggested", null, "evt-approve")).toMatchObject({ status: "duplicate" });
    expect(await decide(c.id, 1, "select_category", "ม", "evt-late")).toMatchObject({ status: "stale" });
    expect(await scalar(`SELECT category_code FROM public.produce_category_rules WHERE product_name = 'ผักทดสอบ'`)).toBe("ผ");
    expect(await scalar(`SELECT count(*) FROM public.produce_category_decisions WHERE candidate_id = ${q(c.id)}`)).toBe("1");
  });

  test("an approved or legitimate-other candidate is never re-alerted by new evidence", async () => {
    const other = await observe("เต้าหู้ทดสอบ", null);
    expect(await decide(other.id, other.revision, "legitimate_other", null, "evt-other")).toMatchObject({ status: "applied", category_code: "other" });
    const again = await observe("เต้าหู้ทดสอบ", "ม", "มะม่วง", 9);
    expect(again).toMatchObject({ status: "legitimate_other", revision: other.revision, occurrence_count: 9, suggested_category: null });
  });

  test("a changed proposal is a new revision; the old card goes stale", async () => {
    const first = await observe("ชื่อใหม่ทดสอบ", "ม", "มะม่วง");
    const same = await observe("ชื่อใหม่ทดสอบ", "ม", "มะม่วง");
    expect(same.revision).toBe(first.revision);
    const changed = await observe("ชื่อใหม่ทดสอบ", "ผ", "ผักชี");
    expect(changed.revision).toBe(first.revision + 1);
    expect(await decide(first.id, first.revision, "approve_suggested", null, "evt-old-card")).toMatchObject({ status: "stale" });
  });

  test("rejected candidates reopen only for a different suggestion", async () => {
    const c = await observe("ปฏิเสธทดสอบ", "ม");
    expect(await decide(c.id, c.revision, "reject", null, "evt-reject")).toMatchObject({ status: "applied", category_code: null });
    expect(await observe("ปฏิเสธทดสอบ", "ม")).toMatchObject({ status: "rejected", revision: c.revision });
    expect(await observe("ปฏิเสธทดสอบ", null)).toMatchObject({ status: "rejected", revision: c.revision });
    expect(await observe("ปฏิเสธทดสอบ", "ผ")).toMatchObject({ status: "pending", revision: c.revision + 1 });
    expect(await scalar(`SELECT count(*) FROM public.produce_category_rules WHERE product_name = 'ปฏิเสธทดสอบ'`)).toBe("0");
  });

  test("invalid decisions fail safely without writing", async () => {
    const c = await observe("ผิดพลาดทดสอบ", null, "มะม่วง");
    expect(await decide(c.id, c.revision, "approve_suggested", null, "evt-bad-1")).toMatchObject({ status: "invalid" }); // nothing suggested
    expect(await decide(c.id, c.revision, "select_category", "X", "evt-bad-2")).toMatchObject({ status: "invalid" });
    expect(await decide(c.id, c.revision, "approve_alias", "ม", "evt-bad-3", "กล้วย")).toMatchObject({ status: "invalid" }); // not the reviewed target
    expect(await decide(c.id, c.revision, "drop_table", "ม", "evt-bad-4")).toMatchObject({ status: "invalid" });
    expect(await decide("00000000-0000-4000-8000-000000000000", 1, "reject", null, "evt-bad-5")).toMatchObject({ status: "not_found" });
    expect(await scalar(`SELECT count(*) FROM public.produce_category_decisions WHERE candidate_id = ${q(c.id)}`)).toBe("0");
    expect(await decide(c.id, c.revision, "approve_alias", "ม", "evt-alias", "มะม่วง")).toMatchObject({ status: "applied", category_code: "ม" });
    expect(await scalar(`SELECT alias_target FROM public.produce_category_decisions WHERE line_event_id = 'evt-alias'`)).toBe("มะม่วง");
  });

  test("concurrent decisions on one card: exactly one applies", async () => {
    const c = await observe("แข่งกันทดสอบ", "ผ");
    const results = await Promise.all([
      decide(c.id, c.revision, "select_category", "ม", "evt-race-a"),
      decide(c.id, c.revision, "select_category", "ผ", "evt-race-b"),
      decide(c.id, c.revision, "reject", null, "evt-race-c"),
    ]);
    expect(results.filter((r) => r.status === "applied")).toHaveLength(1);
    expect(results.filter((r) => r.status === "stale")).toHaveLength(2);
    expect(await scalar(`SELECT count(*) FROM public.produce_category_decisions WHERE candidate_id = ${q(c.id)}`)).toBe("1");
  });

  test("announcement queue reaches candidates beyond the busiest 50, FIFO", async () => {
    await scalar(`SELECT count(*) FROM generate_series(0, 64) i, LATERAL public.observe_produce_category_candidate(
      'คิว' || lpad(i::text, 3, '0'), NULL, 'low', 'test', NULL, 1000 - i, 1,
      DATE '2026-10-19', DATE '2026-10-20', ARRAY[]::text[])`);
    // The 50 busiest are already announced.
    await scalar(`UPDATE public.produce_category_candidates SET notified_revision = revision
      WHERE product_name IN (SELECT product_name FROM public.produce_category_candidates
        WHERE product_name LIKE 'คิว%' ORDER BY occurrence_count DESC LIMIT 50) RETURNING 1`);
    const next = () => scalar(`SELECT string_agg(product_name, ',' ORDER BY created_at, product_name) FROM (
      SELECT product_name, created_at FROM public.produce_category_candidates
      WHERE needs_announcement AND product_name LIKE 'คิว%' ORDER BY created_at, product_name LIMIT 10) q`);
    const first = (await next()).split(",");
    expect(first).toHaveLength(10);
    expect(first.every((n) => Number(n.slice(3)) >= 50)).toBe(true);
    await scalar(`UPDATE public.produce_category_candidates SET notified_revision = revision
      WHERE product_name = ANY(string_to_array(${q(first.join(","))}, ',')) RETURNING 1`);
    expect((await next()).split(",")).toHaveLength(5);
    // A changed proposal re-queues; a decided candidate never does.
    const bumped = await observe("คิว000", "ม", "มะม่วง", 1000);
    expect(bumped.needs_announcement).toBe(true);
    await decide(bumped.id, bumped.revision, "legitimate_other", null, "evt-queue");
    expect(await scalar(`SELECT needs_announcement FROM public.produce_category_candidates WHERE product_name = 'คิว000'`)).toBe("f");
    expect(await scalar(`SELECT count(*) FROM pg_indexes WHERE indexname = 'produce_category_candidates_announce_queue_idx'`)).toBe("1");
  });

  test("decisions are append-only and clients have no access", async () => {
    expect((await run("UPDATE public.produce_category_decisions SET action = 'reject'")).stderr).toContain("append-only");
    expect((await run("DELETE FROM public.produce_category_decisions")).stderr).toContain("append-only");
    for (const role of ["anon", "authenticated"]) {
      const read = await run(`SET ROLE ${role}; SELECT count(*) FROM public.produce_category_rules;`);
      expect(read.stderr).toContain("permission denied");
      const call = await run(`SET ROLE ${role}; SELECT public.decide_produce_category_candidate(gen_random_uuid(), 1, 'reject', NULL, NULL, 'U', 'C', 'e');`);
      expect(call.stderr).toContain("permission denied");
    }
  });
});
