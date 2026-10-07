/** Real PostgreSQL 17 proof for white_sheet_review_turns: constraints, branch guard, append-only, backend-only access. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { semanticKey } from "./mode";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const ROOT = join(import.meta.dir, "..", "..", "..");
const WIN_PSQL = "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe";
const PSQL = existsSync(WIN_PSQL) ? WIN_PSQL : "psql";
const PGHOST = process.env.PGHOST ?? "localhost";
const PGUSER = process.env.PGUSER ?? "postgres";
const PGPASSWORD = process.env.PGPASSWORD ?? "postgres";
const PGPORT = process.env.PGPORT ?? "5432";
const DATABASE = `wsrt_${randomBytes(4).toString("hex")}`;
const DB_NAME_PATTERN = /^wsrt_[a-f0-9]+$/;
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function assertSafe(): void {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
    throw new Error("migration-review-turns.pg.test.ts requires ALLOW_DISPOSABLE_POSTGRES_TESTS=1");
  }
  if (!ALLOWED_HOSTS.has(PGHOST)) throw new Error(`refusing PGHOST=${PGHOST}`);
  if (!DB_NAME_PATTERN.test(DATABASE)) throw new Error(`refusing database=${DATABASE}`);
}

type PsqlResult = { code: number; stdout: string; stderr: string };
async function psql(args: string[], database = DATABASE): Promise<PsqlResult> {
  const proc = Bun.spawn([PSQL, "-X", ...args], {
    cwd: ROOT, env: { ...process.env, PGHOST, PGUSER, PGPASSWORD, PGPORT, PGDATABASE: database },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { code, stdout, stderr };
}
async function scalar(sql: string): Promise<string> {
  const result = await psql(["-v", "ON_ERROR_STOP=1", "-tAc", sql]);
  if (result.code !== 0) throw new Error(`${result.stderr || result.stdout}\nSQL: ${sql}`);
  return result.stdout.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}
async function fails(sql: string, pattern: RegExp): Promise<void> {
  const result = await psql(["-v", "ON_ERROR_STOP=1", "-tAc", sql]);
  expect(result.code, `expected failure: ${sql}`).not.toBe(0);
  expect(result.stderr).toMatch(pattern);
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
  } catch { return false; }
}

const pgAvailable = await probe();
let databaseCreated = false;
if (!pgAvailable && process.env.WSRT_REQUIRE === "1") throw new Error("WSRT_REQUIRE=1 but PostgreSQL 17 harness unavailable");

let counter = 0;
async function raw(kind: "image" | "text" = "image"): Promise<string> {
  counter += 1;
  return scalar(`INSERT INTO public.raw_messages (line_event_id, destination, event_type, source_type, source_id, user_id, message_id, message_type, payload)
    VALUES ('evt-${counter}', 'Ubot', 'message', 'group', 'G1', 'U1', 'm-${counter}', '${kind}', '{}'::jsonb) RETURNING id`);
}
const SNAPSHOT = `'{"documentType":"white_sheet"}'::jsonb`;
const cols = "raw_message_id, destination, source_id, user_id, sheet_image_raw_id, parent_raw_message_id, kind, outcome, snapshot";
async function insertBase(id: string, outcome = "applied"): Promise<string> {
  return scalar(`INSERT INTO public.white_sheet_review_turns (${cols}) VALUES ('${id}','Ubot','G1','U1','${id}',NULL,'base','${outcome}',${outcome === "applied" ? SNAPSHOT : "NULL"}) RETURNING turn_seq`);
}
async function insertTurn(id: string, sheet: string, parent: string | null, outcome = "applied"): Promise<string> {
  return scalar(`INSERT INTO public.white_sheet_review_turns (${cols}) VALUES ('${id}','Ubot','G1','U1','${sheet}',${parent ? `'${parent}'` : "NULL"},'turn','${outcome}',${outcome === "applied" ? SNAPSHOT : "NULL"}) RETURNING turn_seq`);
}

describe.skipIf(!pgAvailable)("white_sheet_review_turns on PostgreSQL 17", () => {
  beforeAll(async () => {
    assertSafe();
    const created = await psql(["-d", "postgres", "-c", `CREATE DATABASE ${DATABASE}`], "postgres");
    expect(created.code, created.stderr).toBe(0);
    databaseCreated = true;
    for (const name of ["0001_initial_schema.sql", "20261007120000_white_sheet_review_turns.sql"]) {
      await apply(join(ROOT, "supabase", "migrations", name));
    }
  }, 60_000);
  afterAll(async () => {
    if (!databaseCreated) return;
    await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE}`], "postgres");
  }, 60_000);

  test("the migration is idempotent-safe to re-read and creates exactly one table", async () => {
    expect(await scalar("SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='white_sheet_review_turns'")).toBe("1");
    expect(await scalar("SELECT count(*) FROM pg_policies WHERE tablename='white_sheet_review_turns'")).toBe("0");
    expect(await scalar("SELECT relrowsecurity FROM pg_class WHERE relname='white_sheet_review_turns'")).toBe("t");
  });

  test("a base, then a linear chain of applied turns, is stored with a monotonic sequence", async () => {
    const image = await raw();
    const first = await insertBase(image);
    const a = await raw("text"), b = await raw("text");
    const second = await insertTurn(a, image, image);
    const third = await insertTurn(b, image, a);
    expect(Number(first)).toBeLessThan(Number(second));
    expect(Number(second)).toBeLessThan(Number(third));
    expect(await scalar(`SELECT raw_message_id FROM public.white_sheet_review_turns WHERE sheet_image_raw_id='${image}' AND outcome='applied' ORDER BY turn_seq DESC LIMIT 1`)).toBe(b);
  });

  test("a duplicate raw_message_id is rejected by the primary key (idempotent recording)", async () => {
    const image = await raw();
    await insertBase(image);
    await fails(`INSERT INTO public.white_sheet_review_turns (${cols}) VALUES ('${image}','Ubot','G1','U1','${image}',NULL,'base','failed',NULL)`, /duplicate key|23505/u);
  });

  test("two applied turns can never branch from the same parent; failed turns do not take the slot", async () => {
    const image = await raw(); await insertBase(image);
    const a = await raw("text"), b = await raw("text"), c = await raw("text"), d = await raw("text");
    await insertTurn(a, image, image);
    await fails(`INSERT INTO public.white_sheet_review_turns (${cols}) VALUES ('${b}','Ubot','G1','U1','${image}','${image}','turn','applied',${SNAPSHOT})`, /one_applied_transition_per_parent|duplicate key/u);
    await insertTurn(b, image, image, "unavailable"); // not applied: allowed
    await insertTurn(c, image, image, "failed");
    await insertTurn(d, image, a); // the chain continues from the winner
    expect(await scalar(`SELECT count(*) FROM public.white_sheet_review_turns WHERE sheet_image_raw_id='${image}' AND outcome='applied'`)).toBe("3");
  });

  test.each([
    ["applied without a snapshot", (id: string, img: string) => `('${id}','Ubot','G1','U1','${img}','${img}','turn','applied',NULL)`],
    ["failed with a snapshot", (id: string, img: string) => `('${id}','Ubot','G1','U1','${img}','${img}','turn','failed',${SNAPSHOT})`],
    ["a turn that is its own image", (id: string) => `('${id}','Ubot','G1','U1','${id}','${id}','turn','failed',NULL)`],
    ["a base that is not its own image", (id: string, img: string) => `('${id}','Ubot','G1','U1','${img}',NULL,'base','failed',NULL)`],
    ["a base with a parent", (id: string) => `('${id}','Ubot','G1','U1','${id}','${id}','base','failed',NULL)`],
    ["an applied turn without a parent", (id: string, img: string) => `('${id}','Ubot','G1','U1','${img}',NULL,'turn','applied',${SNAPSHOT})`],
    ["a non-object snapshot", (id: string) => `('${id}','Ubot','G1','U1','${id}',NULL,'base','applied','[1]'::jsonb)`],
    ["a blank user", (id: string) => `('${id}','Ubot','G1',' ','${id}',NULL,'base','failed',NULL)`],
    ["an unknown outcome", (id: string) => `('${id}','Ubot','G1','U1','${id}',NULL,'base','accepted',NULL)`],
  ])("rejects %s", async (_name, values) => {
    const image = await raw(), id = await raw("text");
    await fails(`INSERT INTO public.white_sheet_review_turns (${cols}) VALUES ${values(id, image)}`, /violates check constraint|invalid input|23514/u);
  });

  test("a snapshot over 64 KiB is refused", async () => {
    const id = await raw();
    await fails(`INSERT INTO public.white_sheet_review_turns (${cols}) VALUES ('${id}','Ubot','G1','U1','${id}',NULL,'base','applied', jsonb_build_object('x', repeat('a', 70000)))`, /snapshot_bounded/u);
  });

  test("rows are append-only: an outcome can never be rewritten", async () => {
    const image = await raw(); await insertBase(image, "failed");
    await fails(`UPDATE public.white_sheet_review_turns SET outcome='applied', snapshot=${SNAPSHOT} WHERE raw_message_id='${image}'`, /append-only/u);
    expect(await scalar(`SELECT outcome FROM public.white_sheet_review_turns WHERE raw_message_id='${image}'`)).toBe("failed");
  });

  test("deleting the sheet's raw message cascades the whole review away", async () => {
    const image = await raw(); await insertBase(image);
    const a = await raw("text"); await insertTurn(a, image, image);
    await scalar(`DELETE FROM public.raw_messages WHERE id='${image}' RETURNING id`);
    expect(await scalar(`SELECT count(*) FROM public.white_sheet_review_turns WHERE sheet_image_raw_id='${image}'`)).toBe("0");
  });

  test("retention: the service role can prune this source's rows past the session cap", async () => {
    const old = await raw(), fresh = await raw();
    await scalar(`INSERT INTO public.white_sheet_review_turns (${cols}, created_at) VALUES ('${old}','Ubot','G-prune','U1','${old}',NULL,'base','failed',NULL, now() - interval '4 hours') RETURNING 1`);
    await scalar(`INSERT INTO public.white_sheet_review_turns (${cols}) VALUES ('${fresh}','Ubot','G-prune','U1','${fresh}',NULL,'base','failed',NULL) RETURNING 1`);
    const result = await psql(["-v", "ON_ERROR_STOP=1", "-c", "SET ROLE service_role; DELETE FROM public.white_sheet_review_turns WHERE source_id='G-prune' AND created_at < now() - interval '3 hours'"]);
    expect(result.code, result.stderr).toBe(0);
    expect(await scalar("SELECT string_agg(raw_message_id::text, ',') FROM public.white_sheet_review_turns WHERE source_id='G-prune'")).toBe(fresh);
  });

  // ── the real service_role: grants, not superuser luck ────────────────────────────────────
  /** Run SQL as a role in one session; returns the last non-empty output line (command tags come first). */
  async function asRole(role: string, sql: string): Promise<string> {
    const result = await psql(["-v", "ON_ERROR_STOP=1", "-tAc", `SET ROLE ${role}; ${sql}`]);
    if (result.code !== 0) throw new Error(`${result.stderr || result.stdout}\nSQL: ${sql}`);
    return result.stdout.split("\n").map((line) => line.trim()).filter((line) => line && !/^(SET|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/u.test(line)).at(-1) ?? "";
  }
  async function asRoleFails(role: string, sql: string, pattern: RegExp): Promise<void> {
    const result = await psql(["-v", "ON_ERROR_STOP=1", "-tAc", `SET ROLE ${role}; ${sql}`]);
    expect(result.code, `expected failure as ${role}: ${sql}`).not.toBe(0);
    expect(result.stderr).toMatch(pattern);
  }

  test("service_role can INSERT a valid base WITHOUT supplying turn_seq, and the identity is generated", async () => {
    const first = await raw(), second = await raw();
    const columns = "raw_message_id, destination, source_id, user_id, sheet_image_raw_id, kind, outcome, snapshot";
    const a = await asRole("service_role", `INSERT INTO public.white_sheet_review_turns (${columns}) VALUES ('${first}','Ubot','G-svc','U1','${first}','base','applied',${SNAPSHOT}) RETURNING turn_seq`);
    const b = await asRole("service_role", `INSERT INTO public.white_sheet_review_turns (${columns}) VALUES ('${second}','Ubot','G-svc','U1','${second}','base','applied',${SNAPSHOT}) RETURNING turn_seq`);
    expect(Number(a)).toBeGreaterThan(0);
    expect(Number(b)).toBeGreaterThan(Number(a));
    // GENERATED ALWAYS: a caller can never choose its own order.
    const third = await raw();
    await asRoleFails("service_role", `INSERT INTO public.white_sheet_review_turns (turn_seq, ${columns}) VALUES (1,'${third}','Ubot','G-svc','U1','${third}','base','applied',${SNAPSHOT})`, /generated always|cannot insert/iu);
  });

  test("service_role can SELECT, INSERT (every kind) and DELETE, but not UPDATE", async () => {
    const image = await raw(), ok = await raw("text"), refused = await raw("text");
    const cols2 = "raw_message_id, destination, source_id, user_id, sheet_image_raw_id, parent_raw_message_id, kind, outcome, snapshot";
    await asRole("service_role", `INSERT INTO public.white_sheet_review_turns (${cols2}) VALUES ('${image}','Ubot','G-svc2','U1','${image}',NULL,'base','applied',${SNAPSHOT})`);
    await asRole("service_role", `INSERT INTO public.white_sheet_review_turns (${cols2}) VALUES ('${ok}','Ubot','G-svc2','U1','${image}','${image}','approval','applied',${SNAPSHOT})`);
    await asRole("service_role", `INSERT INTO public.white_sheet_review_turns (${cols2}) VALUES ('${refused}','Ubot','G-svc2','U1','${image}',NULL,'approval','failed',NULL)`);
    expect(await asRole("service_role", "SELECT count(*) FROM public.white_sheet_review_turns WHERE source_id='G-svc2'")).toBe("3");
    await asRoleFails("service_role", `UPDATE public.white_sheet_review_turns SET outcome='failed' WHERE raw_message_id='${ok}'`, /permission denied/u);
    expect(await asRole("service_role", "WITH d AS (DELETE FROM public.white_sheet_review_turns WHERE source_id='G-svc2' RETURNING 1) SELECT count(*) FROM d")).toBe("3");
  });

  test("one branch guard for every applied transition: a correction and an approval can never share a parent", async () => {
    const cols2 = "raw_message_id, destination, source_id, user_id, sheet_image_raw_id, parent_raw_message_id, kind, outcome, snapshot";
    const approval = (id: string, sheet: string, parent: string | null, outcome: string) =>
      `INSERT INTO public.white_sheet_review_turns (${cols2}) VALUES ('${id}','Ubot','G1','U1','${sheet}',${parent ? `'${parent}'` : "NULL"},'approval','${outcome}',${outcome === "applied" ? SNAPSHOT : "NULL"})`;

    // A. the correction wins the parent: a stale approval from the same parent cannot be applied.
    const sheetA = await raw(); await insertBase(sheetA);
    const fixA = await raw("text"), okA = await raw("text"), okA2 = await raw("text");
    await insertTurn(fixA, sheetA, sheetA);
    await fails(approval(okA, sheetA, sheetA, "applied"), /one_applied_transition_per_parent|duplicate key/u);
    await scalar(`${approval(okA, sheetA, sheetA, "unavailable")} RETURNING 1`); // recorded as not applied
    await scalar(`${approval(okA2, sheetA, fixA, "applied")} RETURNING 1`); // the chain continues from the winner

    // B. the approval wins the parent: a stale correction from the same parent cannot be applied.
    const sheetB = await raw(); await insertBase(sheetB);
    const okB = await raw("text"), fixB = await raw("text");
    await scalar(`${approval(okB, sheetB, sheetB, "applied")} RETURNING 1`);
    await fails(`INSERT INTO public.white_sheet_review_turns (${cols}) VALUES ('${fixB}','Ubot','G1','U1','${sheetB}','${sheetB}','turn','applied',${SNAPSHOT})`, /one_applied_transition_per_parent|duplicate key/u);
    await insertTurn(fixB, sheetB, sheetB, "unavailable");

    // Linear chains: every parent has at most one applied child, across kinds.
    expect(await scalar(`SELECT count(*) FROM (SELECT parent_raw_message_id FROM public.white_sheet_review_turns
      WHERE outcome='applied' AND kind IN ('turn','approval') GROUP BY sheet_image_raw_id, parent_raw_message_id HAVING count(*) > 1) branched`)).toBe("0");
    expect(await scalar(`SELECT indexdef FROM pg_indexes WHERE indexname='white_sheet_review_turns_one_applied_transition_per_parent'`))
      .toMatch(/UNIQUE INDEX .*\(sheet_image_raw_id, parent_raw_message_id\) WHERE \(\(kind = ANY \(ARRAY\['turn'::text, 'approval'::text\]\)\) AND \(outcome = 'applied'::text\)\)/u);
  });

  test("approval rows: accepted needs a snapshot and a parent, refused has neither, and a sheet is accepted at most once", async () => {
    const image = await raw(); await insertBase(image);
    const [a, b, c, d, e] = [await raw("text"), await raw("text"), await raw("text"), await raw("text"), await raw("text")];
    const cols2 = "raw_message_id, destination, source_id, user_id, sheet_image_raw_id, parent_raw_message_id, kind, outcome, snapshot";
    const row = (id: string, parent: string | null, outcome: string, snapshot: string | null) =>
      `INSERT INTO public.white_sheet_review_turns (${cols2}) VALUES ('${id}','Ubot','G1','U1','${image}',${parent ? `'${parent}'` : "NULL"},'approval','${outcome}',${snapshot ?? "NULL"})`;
    await fails(row(a, null, "applied", SNAPSHOT), /applied_turn_has_parent|violates check constraint/u);
    await fails(row(a, image, "applied", null), /snapshot_iff_applied|violates check constraint/u);
    await scalar(`${row(a, image, "unavailable", null)} RETURNING 1`); // refused by a concurrent transition: allowed, takes no slot
    await scalar(`${row(b, null, "failed", null)} RETURNING 1`); // refused: allowed any number of times
    await scalar(`${row(c, null, "failed", null)} RETURNING 1`);
    await scalar(`${row(d, image, "applied", SNAPSHOT)} RETURNING 1`);
    await fails(row(e, image, "applied", SNAPSHOT), /one_accepted_approval_per_sheet|duplicate key/u);
    // Approvals never appear as a sheet's latest correction snapshot.
    expect(await scalar(`SELECT count(*) FROM public.white_sheet_review_turns WHERE sheet_image_raw_id='${image}' AND outcome='applied' AND kind IN ('base','turn')`)).toBe("1");
  });

  test("the TypeScript claim-order key equals the SQL ordering expression of claim_line_webhook_event", async () => {
    const sqlSource = readFileSync(join(ROOT, "supabase", "migrations", "20260930090000_line_webhook_stale_queue_review.sql"), "utf8");
    expect(sqlSource).toContain("CASE WHEN (r.payload->>'timestamp') ~ '^[0-9]+$'");
    expect(sqlSource).toContain("floor(extract(epoch FROM q.received_at) * 1000)::bigint");
    const received = "2026-10-07 03:00:00.123456+00";
    const cases: unknown[] = [1700000000000, "1700000000000", "abc", "1.5", null, "", 0];
    for (const timestamp of cases) {
      const payload = timestamp === null ? "'{}'::jsonb" : `jsonb_build_object('timestamp', ${typeof timestamp === "number" ? timestamp : `'${timestamp}'::text`})`;
      const sql = await scalar(`SELECT COALESCE(CASE WHEN (p.payload->>'timestamp') ~ '^[0-9]+$' THEN (p.payload->>'timestamp')::bigint END, floor(extract(epoch FROM '${received}'::timestamptz) * 1000)::bigint) FROM (SELECT ${payload} AS payload) p`);
      expect(semanticKey(timestamp ?? undefined, received.replace(" ", "T").replace("+00", "+00:00"), 1).ms, `timestamp=${String(timestamp)}`).toBe(Number(sql));
    }
  });

  test("anon and authenticated have no access at all; the service role cannot update", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const sql of ["SELECT 1 FROM public.white_sheet_review_turns LIMIT 1",
        `INSERT INTO public.white_sheet_review_turns (${cols}) VALUES (gen_random_uuid(),'d','s','u',gen_random_uuid(),NULL,'base','failed',NULL)`,
        "DELETE FROM public.white_sheet_review_turns"]) {
        await fails(`SET ROLE ${role}; ${sql}`, /permission denied/u);
      }
    }
    await fails("SET ROLE service_role; UPDATE public.white_sheet_review_turns SET outcome='failed'", /permission denied/u);
    const read = await psql(["-v", "ON_ERROR_STOP=1", "-tAc", "SET ROLE service_role; SELECT count(*) >= 0 FROM public.white_sheet_review_turns"]);
    expect(read.code, read.stderr).toBe(0);
    expect(await scalar("SELECT count(*) FROM information_schema.role_table_grants WHERE table_name='white_sheet_review_turns' AND grantee IN ('anon','authenticated','PUBLIC')")).toBe("0");
  });
});
