/**
 * Real PostgreSQL 17 proof for the Produce Product Code Dictionary migration.
 *
 * Three things need proving before this runs against Production:
 *
 *  1. the seed lands exactly as approved — 253 rows, the right namespace
 *     counts, the right canonical names, all enabled;
 *  2. a code is permanent — it cannot be deleted, renumbered, or repointed at
 *     another product, because either would silently rewrite the identity of
 *     every transaction already keyed by it;
 *  3. applying it twice changes nothing, and applying it at all leaves the
 *     produce history byte-for-byte where it was.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { PRODUCT_CODE_ENTRIES } from "./product-code/dictionary";

const ROOT = join(import.meta.dir, "..", "..", "..");
const WIN_PSQL = "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe";
const PSQL = existsSync(WIN_PSQL) ? WIN_PSQL : "psql";
const PGHOST = process.env.PGHOST ?? "localhost";
const PGUSER = process.env.PGUSER ?? "postgres";
const PGPASSWORD = process.env.PGPASSWORD ?? "postgres";
const PGPORT = process.env.PGPORT ?? "5432";
const DATABASE = `pcd_${randomBytes(4).toString("hex")}`;
const DB_NAME_PATTERN = /^pcd_[a-f0-9]+$/;
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const MIGRATION = join(
  ROOT, "supabase", "migrations", "20260813115826_produce_product_code_dictionary.sql",
);
// 20260818100000 corrects ม54's canonical_name (ไชมัส → ไซมัส) and seeds
// ม63-ม71. It is applied right after the base seed, same as it would run in
// Production, so every assertion below reflects the composed 262-row state.
const CLEANUP_MIGRATION = join(
  ROOT, "supabase", "migrations", "20260818105651_produce_product_dictionary_cleanup.sql",
);
// 20260824090000 adds one further code, ม72 (มะม่วงแก้วขมิ้น), on top of the
// cleanup migration. 20260827090000 then adds ม73 (มะม่วงฟ้าลั่น). Applied last,
// same order Production runs migrations in, so every assertion below reflects
// the composed 265-row state.
const KAEO_KHAMIN_MIGRATION = join(
  ROOT, "supabase", "migrations", "20260824185542_produce_product_dictionary_add_kaeo_khamin_mango.sql",
);
const FAH_LAN_MIGRATION = join(
  ROOT, "supabase", "migrations", "20260827055728_produce_product_dictionary_add_fah_lan_mango.sql",
);
const CHINESE_JUJUBE_MIGRATION = join(
  ROOT, "supabase", "migrations", "20260901093000_produce_product_dictionary_add_chinese_jujube.sql",
);
// 20260908090000 adds the six unclassified-fruit codes ม75–ม80. Applied last,
// same order Production runs migrations in, so every assertion below reflects
// the composed 271-row state.
const UNCLASSIFIED_FRUIT_MIGRATION = join(
  ROOT, "supabase", "migrations", "20260908090000_produce_product_dictionary_add_unclassified_fruit.sql",
);
const MARKET_VEGETABLE_SKUS_MIGRATION = join(
  ROOT, "supabase", "migrations", "20260909030000_produce_product_dictionary_add_market_vegetable_skus.sql",
);
const MARKET_FISH_SKU_MIGRATION = join(
  ROOT, "supabase", "migrations", "20260909030100_produce_product_dictionary_add_market_fish_sku.sql",
);
const BOOTSTRAP = join(
  ROOT, "supabase", "tests", "produce_product_code_dictionary_bootstrap.sql",
);

function assertSafe(): void {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
    throw new Error("migration-product-code-dictionary.pg.test.ts requires ALLOW_DISPOSABLE_POSTGRES_TESTS=1");
  }
  if (!ALLOWED_HOSTS.has(PGHOST)) throw new Error(`refusing PGHOST=${PGHOST}`);
  if (!DB_NAME_PATTERN.test(DATABASE)) throw new Error(`refusing database=${DATABASE}`);
}

type PsqlResult = { code: number; stdout: string; stderr: string };

async function psql(args: string[], database = DATABASE, stdin?: string): Promise<PsqlResult> {
  const proc = Bun.spawn([PSQL, "-X", ...args], {
    cwd: ROOT,
    stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
    // Thai canonical names are the whole point of this table; without an
    // explicit UTF-8 client encoding a Windows psql returns question marks.
    env: { ...process.env, PGHOST, PGUSER, PGPASSWORD, PGPORT, PGDATABASE: database, PGCLIENTENCODING: "UTF8" },
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

function run(sql: string, database = DATABASE): Promise<PsqlResult> {
  return psql(["-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"], database, sql);
}

async function scalar(sql: string, database = DATABASE): Promise<string> {
  const result = await run(sql, database);
  if (result.code !== 0) throw new Error(`${result.stderr || result.stdout}\nSQL: ${sql}`);
  return result.stdout.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}

async function expectFailure(sql: string): Promise<string> {
  const result = await run(sql);
  expect(result.code, `expected failure but succeeded:\n${sql}`).not.toBe(0);
  return `${result.stderr}${result.stdout}`;
}

async function apply(file: string, database = DATABASE): Promise<void> {
  const result = await psql(["-v", "ON_ERROR_STOP=1", "-f", file], database);
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
if (!pgAvailable && process.env.REQUIRE_PRODUCT_CODE_POSTGRES === "1") {
  throw new Error("REQUIRE_PRODUCT_CODE_POSTGRES=1 but the PostgreSQL 17 harness is unavailable");
}

/** Captured before the migration, compared after — history must not move. */
let historyFingerprint = "";

describe.skipIf(!pgAvailable)("Produce Product Code Dictionary on PostgreSQL 17", () => {
  beforeAll(async () => {
    assertSafe();
    const created = await psql(["-d", "postgres", "-c", `CREATE DATABASE ${DATABASE}`], "postgres");
    expect(created.code, created.stderr).toBe(0);
    databaseCreated = true;

    await apply(BOOTSTRAP);
    historyFingerprint = await scalar(`
      SELECT count(*)::text || ':' || md5(string_agg(
        product_name || '|' || quantity || '|' || price_per_unit || '|' || transaction_date,
        E'\n' ORDER BY product_name))
      FROM public.produce_transactions`);

    await apply(MIGRATION);
    await apply(CLEANUP_MIGRATION);
    await apply(KAEO_KHAMIN_MIGRATION);
    await apply(FAH_LAN_MIGRATION);
    await apply(CHINESE_JUJUBE_MIGRATION);
    await apply(UNCLASSIFIED_FRUIT_MIGRATION);
    await apply(MARKET_VEGETABLE_SKUS_MIGRATION);
    await apply(MARKET_FISH_SKU_MIGRATION);
  });

  afterAll(async () => {
    if (!databaseCreated) return;
    await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`], "postgres");
  });

  // ── The seed is the approved dictionary ───────────────────────────────────

  test("seeds exactly the 283 approved codes (base + cleanup + kaeo khamin + fah lan + chinese jujube + unclassified fruit), all enabled", async () => {
    expect(await scalar("SELECT count(*)::text FROM public.produce_product_codes")).toBe("283");
    expect(await scalar(
      "SELECT count(*)::text FROM public.produce_product_codes WHERE code_enabled",
    )).toBe("283");
  });

  test("keeps the approved namespace ranges", async () => {
    const rows = await scalar(`
      SELECT string_agg(category_code || '=' || n, ',' ORDER BY category_code)
      FROM (
        SELECT category_code, count(*) AS n
        FROM public.produce_product_codes GROUP BY category_code
      ) t`);
    expect(rows).toBe("ท=26,ป=37,ผ=129,พ=7,ม=80,ห=4");
  });

  test("stores the canonical name of every code exactly as approved", async () => {
    // The whole dictionary, not a sample: a single mistyped canonical name is a
    // product identity that will never match what an operator types.
    // Compared as a map, not a sorted string: Thai orders differently under the
    // database collation than it does in JavaScript, and this test is about the
    // mapping being right, not about anybody's sort order.
    const actual = JSON.parse(await scalar(
      "SELECT jsonb_object_agg(product_code, canonical_name)::text FROM public.produce_product_codes",
    )) as Record<string, string>;

    const expected = Object.fromEntries(
      PRODUCT_CODE_ENTRIES.map((e) => [e.code, e.canonicalName]),
    );

    expect(actual).toEqual(expected);
  });

  test("resolves representative codes across every namespace", async () => {
    for (const [code, name] of [
      ["ม02", "กล้วยน้ำว้า"], ["ม72", "มะม่วงแก้วขมิ้น"], ["ม73", "มะม่วงฟ้าลั่น"], ["ผ129", "มะเขือม่วง"], ["ป37", "ปลาทู"],
      ["ท26", "ภูเขาไฟลูกค้าเคลม"], ["ห04", "เห็ดออรินจิ"], ["พ07", "มะระถุง"],
    ]) {
      expect(await scalar(
        `SELECT canonical_name FROM public.produce_product_codes WHERE product_code = '${code}'`,
      )).toBe(name);
    }
  });

  // ── A code is permanent ───────────────────────────────────────────────────

  test("refuses to delete a released code", async () => {
    const error = await expectFailure(
      "DELETE FROM public.produce_product_codes WHERE product_code = 'ม02'",
    );
    expect(error).toContain("must not be deleted");
    expect(await scalar("SELECT count(*)::text FROM public.produce_product_codes")).toBe("283");
  });

  test("refuses to repoint a code at a different product", async () => {
    const error = await expectFailure(
      "UPDATE public.produce_product_codes SET canonical_name = 'ทุเรียน' WHERE product_code = 'ม02'",
    );
    expect(error).toContain("identity is immutable");
    expect(await scalar(
      "SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ม02'",
    )).toBe("กล้วยน้ำว้า");
  });

  test("refuses to renumber a code", async () => {
    // ม63-ม71 are now issued (20260818100000), so ม99 — genuinely unissued — is
    // the target here; either way the guard fires before any target is checked.
    const error = await expectFailure(
      "UPDATE public.produce_product_codes SET product_code = 'ม99' WHERE product_code = 'ม02'",
    );
    expect(error).toContain("identity is immutable");
  });

  test("allows retiring a code without touching its product", async () => {
    await scalar(
      "UPDATE public.produce_product_codes SET code_enabled = false WHERE product_code = 'พ07' RETURNING '1'",
    );
    expect(await scalar(
      "SELECT code_enabled::text || ':' || canonical_name FROM public.produce_product_codes WHERE product_code = 'พ07'",
    )).toBe("false:มะระถุง");

    // Put it back so the later re-apply assertion sees the seeded state.
    await scalar(
      "UPDATE public.produce_product_codes SET code_enabled = true WHERE product_code = 'พ07' RETURNING '1'",
    );
  });

  test("refuses a malformed or mis-prefixed code", async () => {
    expect(await expectFailure(`
      INSERT INTO public.produce_product_codes (product_code, category_code, category_name, canonical_name)
      VALUES ('ก01', 'ก', 'ผลไม้', 'ทดสอบ')`)).toContain("violates check constraint");

    // ม99 (genuinely unissued past ม63-ม71) rather than ม63, which
    // 20260818100000 now issues.
    expect(await expectFailure(`
      INSERT INTO public.produce_product_codes (product_code, category_code, category_name, canonical_name)
      VALUES ('ม99', 'ผ', 'ผลไม้', 'ทดสอบ')`)).toContain("produce_product_codes_category_prefix");
  });

  test("refuses a duplicate code", async () => {
    expect(await expectFailure(`
      INSERT INTO public.produce_product_codes (product_code, category_code, category_name, canonical_name)
      VALUES ('ม02', 'ม', 'ผลไม้', 'อย่างอื่น')`)).toContain("duplicate key");
  });

  // ── Deploy safety ─────────────────────────────────────────────────────────

  test("is repeat-safe — applying the base migration again is a no-op", async () => {
    // Deliberately an ISOLATED database, not the shared DATABASE this describe
    // block otherwise uses. The base migration's own baked-in postflight check
    // asserts the table holds EXACTLY 253 rows — true only before any later
    // migration has added to it. In real deployment 20260813090000 is never
    // re-executed after 20260818100000 already ran (each migration file
    // applies exactly once, tracked by the migration runner), so re-running it
    // atop the shared DATABASE here — which by this point also has the
    // cleanup migration's 262 rows — would fail that assertion for a scenario
    // that cannot happen in Production. This isolated database proves the
    // narrower, real property: the base migration alone is idempotent.
    //
    // The cleanup migration's own repeat-safety (it RAISEs a clear "already
    // applied" notice rather than silently re-running) is proven in
    // migration-product-dictionary-cleanup.pg.test.ts, not here.
    const isolated = `pcd_repeat_${randomBytes(4).toString("hex")}`;
    const created = await psql(["-d", "postgres", "-c", `CREATE DATABASE ${isolated}`], "postgres");
    expect(created.code, created.stderr).toBe(0);
    try {
      await apply(MIGRATION, isolated);
      await apply(MIGRATION, isolated);
      expect(await scalar(
        `SELECT count(*)::text FROM public.produce_product_codes`, isolated,
      )).toBe("253");
      expect(await scalar(
        `SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ม02'`, isolated,
      )).toBe("กล้วยน้ำว้า");
    } finally {
      await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${isolated} WITH (FORCE)`], "postgres");
    }
  });

  test("leaves the produce history exactly as it found it", async () => {
    const after = await scalar(`
      SELECT count(*)::text || ':' || md5(string_agg(
        product_name || '|' || quantity || '|' || price_per_unit || '|' || transaction_date,
        E'\n' ORDER BY product_name))
      FROM public.produce_transactions`);

    expect(after).toBe(historyFingerprint);
  });

  test("is readable by service_role and nobody else", async () => {
    expect(await scalar(`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_name = 'produce_product_codes' AND grantee = 'service_role'`)).toBe("SELECT");

    expect(await scalar(`
      SELECT count(*)::text FROM information_schema.role_table_grants
      WHERE table_name = 'produce_product_codes' AND grantee IN ('anon', 'authenticated', 'PUBLIC')`))
      .toBe("0");

    expect(await scalar(`
      SELECT relrowsecurity::text FROM pg_class
      WHERE oid = 'public.produce_product_codes'::regclass`)).toBe("true");
  });
});
