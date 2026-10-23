import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BOOTSTRAP, CATEGORY_MIGRATIONS, CATEGORY_ROLLBACKS, SUPABASE_DEFAULT_ACL, pgHarness } from "./test-pg-harness";

const pg = pgHarness("pcl");
const { psql, run, scalar } = pg;
const DATABASE = pg.database;

const pgAvailable = await pg.available();
let databaseCreated = false;
if (!pgAvailable && process.env.REQUIRE_CATEGORY_LEARNING_POSTGRES === "1") {
  throw new Error("REQUIRE_CATEGORY_LEARNING_POSTGRES=1 but PostgreSQL is unavailable");
}

const q = (value: string | null) => (value === null ? "NULL" : `'${value.replaceAll("'", "''")}'`);

function observe(name: string, suggested: string | null, similar: string | null = null, occurrences = 3) {
  // Runtime role: every RPC call below runs as service_role under the broad ACL.
  return scalar(`SET ROLE service_role; SELECT row_to_json(c)::text FROM public.observe_produce_category_candidate(
    ${q(name)}, ${q(suggested)}, 'medium', 'test', ${q(similar)}, ${occurrences}, 2,
    DATE '2026-10-19', DATE '2026-10-20', ARRAY['ตลาดA']) c`).then((text) => JSON.parse(text));
}

function decide(id: string, revision: number, action: string, category: string | null, eventId: string, alias: string | null = null) {
  return scalar(`SET ROLE service_role; SELECT public.decide_produce_category_candidate(
    ${q(id)}::uuid, ${revision}, ${q(action)}, ${q(category)}, ${q(alias)}, 'Uadmin', 'Ctestgroup', ${q(eventId)})::text`)
    .then((text) => JSON.parse(text));
}

describe.skipIf(!pgAvailable)("produce category learning migration", () => {
  beforeAll(async () => {
    databaseCreated = true;
    await pg.setup();
  });

  afterAll(async () => {
    if (databaseCreated) await pg.drop();
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

  test("rollback scripts remove every object in reverse order and forward re-apply succeeds", async () => {
    const db = `${DATABASE}_rb`;
    const apply = async (file: string) => {
      const result = await psql(["-v", "ON_ERROR_STOP=1", "-f", file], db);
      expect(result.code, `${file}\n${result.stderr}`).toBe(0);
    };
    const objects = async () => (await psql(["-tAc", `SELECT
      (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname LIKE 'produce\\_category\\_%')
      + (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
         AND (proname LIKE '%produce\\_category%'))`], db)).stdout.trim();
    const business = async () => (await psql(["-tAc",
      "SELECT md5(coalesce(string_agg(row_to_json(t)::text, chr(10) ORDER BY row_to_json(t)::text), '')) FROM public.produce_transactions t"], db)).stdout.trim();
    expect((await psql(["-d", "postgres", "-c", `CREATE DATABASE ${db}`], "postgres")).code).toBe(0);
    try {
      await apply(BOOTSTRAP);
      expect((await psql(["-v", "ON_ERROR_STOP=1", "-c", SUPABASE_DEFAULT_ACL], db)).code).toBe(0);
      const before = await business();
      for (const file of CATEGORY_MIGRATIONS) await apply(file);
      expect(Number(await objects())).toBeGreaterThan(0);
      // Reverse order; each step leaves a consistent schema.
      await apply(CATEGORY_ROLLBACKS[0]!);
      expect((await psql(["-tAc", "SELECT count(*) FROM pg_trigger WHERE tgname = 'produce_category_decisions_no_truncate'"], db)).stdout.trim()).toBe("0");
      await apply(CATEGORY_ROLLBACKS[1]!);
      expect((await psql(["-tAc", "SELECT to_regclass('public.produce_category_deliveries') IS NULL"], db)).stdout.trim()).toBe("t");
      await apply(CATEGORY_ROLLBACKS[2]!);
      expect((await psql(["-tAc", `SELECT count(*) FROM information_schema.columns WHERE column_name = 'needs_announcement'`], db)).stdout.trim()).toBe("0");
      await apply(CATEGORY_ROLLBACKS[3]!);
      expect(await objects()).toBe("0");
      expect(await business()).toBe(before);
      for (const file of CATEGORY_MIGRATIONS) await apply(file);
      expect(Number(await objects())).toBeGreaterThan(0);
      expect(await business()).toBe(before);
    } finally {
      await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`], "postgres");
    }
  }, 30_000);
});
