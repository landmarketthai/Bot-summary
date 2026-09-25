import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const ROOT = join(import.meta.dir, "..", "..", "..");
const PSQL = existsSync("C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe")
  ? "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe" : "psql";
const PGHOST = process.env.PGHOST ?? "localhost";
const PGUSER = process.env.PGUSER ?? "postgres";
const PGPASSWORD = process.env.PGPASSWORD ?? "postgres";
const PGPORT = process.env.PGPORT ?? "5432";
const DATABASE = `sad_${randomBytes(4).toString("hex")}`;
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const BOOTSTRAP = join(ROOT, "supabase", "tests", "produce_product_code_dictionary_bootstrap.sql");
const PRODUCT_CODES = join(ROOT, "supabase", "migrations", "20260813115826_produce_product_code_dictionary.sql");
const MIGRATION = join(ROOT, "supabase", "migrations", "20260924123000_safe_auto_dictionary.sql");

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

async function run(sql: string, database = DATABASE): Promise<PsqlResult> {
  return psql(["-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"], database, sql);
}

async function scalar(sql: string, database = DATABASE): Promise<string> {
  const result = await run(sql, database);
  if (result.code !== 0) throw new Error(`${result.stderr || result.stdout}\nSQL: ${sql}`);
  return result.stdout.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

async function apply(file: string, database = DATABASE): Promise<void> {
  const result = await psql(["-v", "ON_ERROR_STOP=1", "-f", file], database);
  expect(result.code, `${file}\n${result.stderr}\n${result.stdout}`).toBe(0);
}

async function probe(): Promise<boolean> {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1" || !ALLOWED_HOSTS.has(PGHOST)) return false;
  const result = await psql(["-tAc", "SHOW server_version_num"], "postgres");
  return result.code === 0 && Number(result.stdout.trim()) >= 140000;
}

const pgAvailable = await probe();
let databaseCreated = false;
if (!pgAvailable && process.env.REQUIRE_SAFE_AUTO_DICTIONARY_POSTGRES === "1") {
  throw new Error("REQUIRE_SAFE_AUTO_DICTIONARY_POSTGRES=1 but PostgreSQL is unavailable");
}

const category = "ม";
const categoryName = "ผลไม้";
const name = "ทดสอบอัตโนมัติ";
const raw = "  ทดสอบ  อัตโนมัติ ";

describe.skipIf(!pgAvailable)("safe auto-dictionary migration", () => {
  beforeAll(async () => {
    const created = await psql(["-d", "postgres", "-c", `CREATE DATABASE ${DATABASE}`], "postgres");
    expect(created.code, created.stderr).toBe(0);
    databaseCreated = true;
    await apply(BOOTSTRAP);
    await apply(PRODUCT_CODES);
    await apply(MIGRATION);
  });

  afterAll(async () => {
    if (databaseCreated) await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`], "postgres");
  });

  async function observe(
    session: string,
    generation = randomBytes(16).toString("hex"),
    date = "2026-09-24",
    candidateName = name,
    candidateCategory = category,
    candidateCategoryName = categoryName,
  ) {
    const uuid = `${generation.slice(0, 8)}-${generation.slice(8, 12)}-${generation.slice(12, 16)}-${generation.slice(16, 20)}-${generation.slice(20, 32)}`;
    return scalar(`SELECT public.observe_produce_dictionary_candidate(
      ${quote(candidateName)}, ${quote(candidateName)}, ${quote(session)}, ${quote(uuid)}::uuid,
      DATE ${quote(date)}, ${quote(candidateCategory)}, ${quote(candidateCategoryName)}, NULL
    )::text`);
  }

  test("requires three distinct sessions across two days and retries are idempotent", async () => {
    expect(JSON.parse(await observe("s1", "11111111111111111111111111111111", "2026-09-24")).status).toBe("observing");
    expect(JSON.parse(await observe("s1", "11111111111111111111111111111111", "2026-09-24")).distinct_sessions).toBe(1);
    expect(JSON.parse(await observe("s2", "22222222222222222222222222222222", "2026-09-24")).status).toBe("observing");
    const promoted = JSON.parse(await observe("s3", "33333333333333333333333333333333", "2026-09-25"));
    expect(promoted.status).toBe("promoted");
    expect(promoted.distinct_sessions).toBe(3);
    expect(promoted.distinct_days).toBe(2);
    const retry = JSON.parse(await observe("s3", "33333333333333333333333333333333", "2026-09-25"));
    expect(retry.status).toBe("existing");
    expect(retry.product_code).toBe(promoted.product_code);
    expect(await scalar("SELECT count(*)::text FROM public.produce_dictionary_candidate_occurrences")).toBe("3");
    expect(await scalar("SELECT count(*)::text FROM public.produce_dictionary_decisions WHERE decision = 'NEW_PRODUCT'")).toBe("1");
  });

  test("reviews a disabled exact canonical name without issuing another code", async () => {
    const candidateName = `disabled canonical ${randomBytes(4).toString("hex")}`;
    const disabledCode = "ห9999";
    const inserted = await run(`INSERT INTO public.produce_product_codes
      (product_code, category_code, category_name, canonical_name, code_enabled)
      VALUES (${quote(disabledCode)}, 'ห', 'Disabled category', ${quote(candidateName)}, false)`);
    expect(inserted.code, inserted.stderr).toBe(0);

    expect(JSON.parse(await observe("disabled-1", randomBytes(16).toString("hex"), "2026-09-24", candidateName)).status).toBe("observing");
    expect(JSON.parse(await observe("disabled-2", randomBytes(16).toString("hex"), "2026-09-24", candidateName)).status).toBe("observing");
    const reviewed = JSON.parse(await observe("disabled-3", randomBytes(16).toString("hex"), "2026-09-25", candidateName));
    expect(reviewed.status).toBe("needs_review");
    expect(reviewed.reason).toBe("existing_disabled_product");
    expect(await scalar(`SELECT count(*)::text FROM public.produce_product_codes WHERE canonical_name = ${quote(candidateName)}`)).toBe("1");
    expect(await scalar(`SELECT state FROM public.produce_dictionary_candidates WHERE normalized_name = ${quote(candidateName)}`)).toBe("needs_review");
    expect(await scalar(`SELECT d.decision || ':' || d.reason || ':' || d.target_product_code
      FROM public.produce_dictionary_decisions d
      JOIN public.produce_dictionary_candidates c ON c.id = d.candidate_id
      WHERE c.normalized_name = ${quote(candidateName)}`)).toBe(`NEEDS_REVIEW:existing_disabled_product:${disabledCode}`);
  });

  test("serializes concurrent observations and code allocation under the promotion advisory lock", async () => {
    const promoted = await Promise.all([["a", "concurrent-watermelon"], ["b", "concurrent-pomegranate"]].map(([suffix, candidateName]) => Promise.all([
      observe(`lock-${suffix}-1`, randomBytes(16).toString("hex"), "2026-09-24", candidateName),
      observe(`lock-${suffix}-2`, randomBytes(16).toString("hex"), "2026-09-24", candidateName),
      observe(`lock-${suffix}-3`, randomBytes(16).toString("hex"), "2026-09-25", candidateName),
    ])));
    expect(promoted.flat().some((result) => JSON.parse(result).status === "promoted")).toBe(true);
    expect(await scalar(`SELECT count(*)::text FROM public.produce_product_codes WHERE canonical_name LIKE 'concurrent-%'`)).toBe("2");
    expect(await scalar(`SELECT count(DISTINCT product_code)::text FROM public.produce_dictionary_decisions WHERE decision = 'NEW_PRODUCT'`)).toBe("3");
  });

  test("rechecks same-category near-duplicate enabled names before promotion", async () => {
    const first = "Concurrent near duplicate green apple";
    const second = "Concurrent near duplicate green apples";
    for (const candidateName of [first, second]) {
      await observe(`${candidateName}-1`, randomBytes(16).toString("hex"), "2026-09-24", candidateName);
      await observe(`${candidateName}-2`, randomBytes(16).toString("hex"), "2026-09-24", candidateName);
    }

    const results = await Promise.all([first, second].map((candidateName, index) =>
      observe(`near-final-${index}`, randomBytes(16).toString("hex"), "2026-09-25", candidateName),
    )).then((values) => values.map((value) => JSON.parse(value)));

    expect(results.map((result) => result.status).sort()).toEqual(["needs_review", "promoted"]);
    expect(await scalar(`SELECT count(*)::text FROM public.produce_product_codes WHERE canonical_name IN (${quote(first)}, ${quote(second)})`)).toBe("1");
    expect(await scalar(`SELECT count(*)::text FROM public.produce_dictionary_candidates WHERE normalized_name IN (${quote(first)}, ${quote(second)}) AND state = 'needs_review'`)).toBe("1");
    expect(await scalar(`SELECT count(*)::text FROM public.produce_dictionary_decisions d JOIN public.produce_dictionary_candidates c ON c.id = d.candidate_id WHERE c.normalized_name IN (${quote(first)}, ${quote(second)}) AND d.decision = 'NEEDS_REVIEW' AND d.reason = 'similar_enabled_product'`)).toBe("1");
  });

  test("serializes cross-category near-duplicate promotions", async () => {
    const token = randomBytes(4).toString("hex");
    const stem = `cross-category near duplicate ${token}`;
    const first = `${stem} plum`;
    const second = `${stem} plums`;
    const secondCategory = "ผ";
    const gateKey = randomBytes(4).readUInt32BE(0) % 2_000_000_000 + 1;
    const gateTrigger = "safe_auto_dictionary_test_insert_gate";
    const gateFunction = "safe_auto_dictionary_test_insert_gate";

    for (const [candidateName, candidateCategory, candidateCategoryName] of [
      [first, category, categoryName],
      [second, secondCategory, "Other category"],
    ]) {
      await observe(`${candidateName}-1`, randomBytes(16).toString("hex"), "2026-09-24", candidateName, candidateCategory, candidateCategoryName);
      await observe(`${candidateName}-2`, randomBytes(16).toString("hex"), "2026-09-24", candidateName, candidateCategory, candidateCategoryName);
    }

    const triggerSetup = await run(`
      CREATE FUNCTION public.${gateFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.canonical_name LIKE ${quote(`${stem}%`)} THEN
          PERFORM pg_advisory_xact_lock(${gateKey});
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER ${gateTrigger} BEFORE INSERT ON public.produce_product_codes
      FOR EACH ROW EXECUTE FUNCTION public.${gateFunction}();
    `);
    expect(triggerSetup.code, triggerSetup.stderr || triggerSetup.stdout).toBe(0);

    const holder = Bun.spawn([PSQL, "-X", "-c", `SELECT pg_advisory_lock(${gateKey}); SELECT pg_sleep(60)`], {
      cwd: ROOT,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PGHOST, PGUSER, PGPASSWORD, PGPORT, PGDATABASE: DATABASE, PGCLIENTENCODING: "UTF8" },
    });
    let race: Promise<string[]> | undefined;
    let waitError: unknown;

    try {
      await waitUntil(async () => await scalar(`
        SELECT count(*)::text FROM pg_locks
        WHERE locktype = 'advisory' AND classid = 0 AND objid = ${gateKey}::oid
          AND objsubid = 1 AND granted
      `) === "1", "test insert gate");
      race = Promise.all([
        observe("cross-category-final-1", randomBytes(16).toString("hex"), "2026-09-25", first, category, categoryName),
        observe("cross-category-final-2", randomBytes(16).toString("hex"), "2026-09-25", second, secondCategory, "Other category"),
      ]);
      try {
        await waitUntil(async () => await scalar(`
          SELECT count(DISTINCT pid)::text FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted
        `) === "2", "both promotions to reach the serialized critical section");
      } catch (error) {
        waitError = error;
      }
    } finally {
      await run(`
        SELECT pg_terminate_backend(pid)
        FROM pg_locks
        WHERE locktype = 'advisory' AND classid = 0 AND objid = ${gateKey}::oid
        AND objsubid = 1 AND granted AND pid <> pg_backend_pid()
      `);
      holder.kill();
      await Promise.all([new Response(holder.stdout).text(), new Response(holder.stderr).text(), holder.exited]);
    }

    if (!race) throw new Error("cross-category promotion race did not start");
    const results = (await race).map((value) => JSON.parse(value));
    if (waitError) throw waitError;
    expect(results.map((result) => result.status).sort()).toEqual(["needs_review", "promoted"]);
    expect(await scalar(`SELECT count(*)::text FROM public.produce_product_codes WHERE canonical_name IN (${quote(first)}, ${quote(second)})`)).toBe("1");
    expect(await scalar(`SELECT count(*)::text FROM public.produce_dictionary_candidates WHERE normalized_name IN (${quote(first)}, ${quote(second)}) AND state = 'needs_review'`)).toBe("1");
    expect(await scalar(`SELECT count(*)::text FROM public.produce_dictionary_decisions d JOIN public.produce_dictionary_candidates c ON c.id = d.candidate_id WHERE c.normalized_name IN (${quote(first)}, ${quote(second)}) AND d.decision = 'NEEDS_REVIEW' AND d.reason = 'similar_enabled_product'`)).toBe("1");
    await run(`DROP TRIGGER ${gateTrigger} ON public.produce_product_codes; DROP FUNCTION public.${gateFunction}();`);
  });

  test("keeps product identity immutable and locks down the surface", async () => {
    const code = await scalar(`SELECT product_code FROM public.produce_product_codes WHERE canonical_name = ${quote(name)}`);
    const changed = await run(`UPDATE public.produce_product_codes SET canonical_name = 'changed' WHERE product_code = ${quote(code)}`);
    expect(changed.code).not.toBe(0);
    expect(await scalar(`SELECT prosecdef::text || ':' || array_to_string(proconfig, ',') FROM pg_proc WHERE oid = 'public.observe_produce_dictionary_candidate(text,text,text,uuid,date,text,text,text)'::regprocedure`))
      .toBe("true:search_path=pg_catalog, public, pg_temp");
    expect(await scalar("SELECT relrowsecurity::text FROM pg_class WHERE oid = 'public.produce_dictionary_candidates'::regclass")).toBe("true");
    expect(await scalar(`SELECT count(*)::text FROM information_schema.role_table_grants WHERE table_name IN ('produce_dictionary_candidates','produce_dictionary_candidate_occurrences','produce_dictionary_decisions') AND grantee IN ('anon','authenticated','PUBLIC')`)).toBe("0");
    expect(await scalar("SELECT has_function_privilege('service_role', 'public.observe_produce_dictionary_candidate(text,text,text,uuid,date,text,text,text)', 'EXECUTE')::text")).toBe("true");
    expect(await scalar("SELECT has_function_privilege('anon', 'public.observe_produce_dictionary_candidate(text,text,text,uuid,date,text,text,text)', 'EXECUTE')::text")).toBe("false");
  });
});

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function waitUntil(check: () => Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${description}`);
}
