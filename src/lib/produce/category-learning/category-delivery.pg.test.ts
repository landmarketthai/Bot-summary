/**
 * Review-card delivery ledger and least-privilege grants on real PostgreSQL 17,
 * with Supabase's broad default ACL. runCategoryDiscovery runs end to end;
 * every RPC executes AS service_role, exactly like Production.
 *
 * Includes the five cases that failed independent review of 53c6acf:
 *   F1a fixed 401 → the same pending revisions are delivered (4 = 2 × 2)
 *   F1b group B 403 while A succeeds → after the fix only B receives it
 *   F2  (webhook suite) manual สรุปคงเหลือ uses approved rules
 *   F3a service_role cannot UPDATE a rule outside the audited RPC
 *   F3b service_role cannot TRUNCATE the category tables / audit
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { LinePushError } from "@/lib/line/reply";
import { MAX_DELIVERY_ATTEMPTS, requeueCategoryDeliveries, runCategoryDiscovery, type PushMessages } from "./discovery";
import { fakeDb } from "./test-fake-db";
import { pgHarness, sqlLiteral } from "./test-pg-harness";

// Each run is several psql round trips; CI runners are slower than a laptop.
setDefaultTimeout(60_000);

const pg = pgHarness("pcd");
const pgAvailable = await pg.available();
if (!pgAvailable && process.env.REQUIRE_CATEGORY_LEARNING_POSTGRES === "1") {
  throw new Error("REQUIRE_CATEGORY_LEARNING_POSTGRES=1 but PostgreSQL is unavailable");
}

/** psql output lines (Windows psql emits CRLF). */
const lines = (text: string) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

const SETOF = new Set(["claim_produce_category_deliveries", "produce_category_delivery_health"]);

/** Supabase-shaped rpc() over psql, executed AS service_role. */
async function rpc(name: string, args: Record<string, unknown> = {}) {
  const named = Object.entries(args).map(([k, v]) => `${k} => ${sqlLiteral(v)}`).join(", ");
  const result = await pg.run(`SET ROLE service_role;
    SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) FROM public.${name}(${named}) r;`);
  if (result.code !== 0) return { data: null, error: { message: result.stderr.trim() } };
  const rows = JSON.parse(result.stdout.trim().split("\n").pop()!) as Record<string, unknown>[];
  if (SETOF.has(name)) return { data: rows, error: null };
  const row = rows[0];
  const data = row && Object.keys(row).length === 1 && name in row ? row[name] : row;
  return { data, error: null };
}

/** No transactions to scan and no rules: only the delivery path runs. */
const client = (overrides: { rpc?: typeof rpc } = {}) => ({
  ...(fakeDb({ produce_transactions: [], produce_category_rules: [] }).client as object),
  rpc: overrides.rpc ?? rpc,
}) as never;

const window = { fromDate: "2026-10-07", toDate: "2026-10-20" };
const A = "C-review-a";
const B = "C-review-b";
const ENV = { CATEGORY_REVIEW_NOTIFY_ENABLED: "true", CATEGORY_REVIEW_LINE_GROUP_IDS: `${A},${B}` } as unknown as NodeJS.ProcessEnv;

type Sent = { group: string; key: string; name: string };
function recorder(fail: (group: string, name: string) => unknown = () => undefined) {
  const sent: Sent[] = [];
  const push: PushMessages = async (group, messages, key) => {
    const name = String((messages[0] as { altText: string }).altText).replace("ตรวจหมวดสินค้า: ", "");
    const error = fail(group, name);
    if (error) throw error;
    sent.push({ group, key, name });
  };
  return { sent, push };
}

let seq = 0;
async function seed(...names: string[]): Promise<void> {
  for (const name of names) {
    // Distinct created_at keeps FIFO order deterministic.
    await pg.scalar(`SET ROLE service_role; SELECT id FROM public.observe_produce_category_candidate(
      ${sqlLiteral(name)}, NULL, 'low', 'test', NULL, 1, 1, DATE '2026-10-20', DATE '2026-10-20', '{}'::text[])`);
    await pg.scalar(`UPDATE public.produce_category_candidates SET created_at = now() + make_interval(secs => ${++seq})
      WHERE product_name = ${sqlLiteral(name)} RETURNING 1`);
  }
}

async function reset(): Promise<void> {
  // Superuser-only fixture reset (append-only audit untouched: no decisions here).
  await pg.scalar(`DELETE FROM public.produce_category_deliveries; DELETE FROM public.produce_category_candidates
    WHERE id NOT IN (SELECT candidate_id FROM public.produce_category_decisions); SELECT 1`);
}

const http = (status: number) => new LinePushError(`LINE push HTTP ${status}`, status, status === 429 || status >= 500);

describe.skipIf(!pgAvailable)("category review delivery ledger (PostgreSQL 17, service_role)", () => {
  beforeAll(async () => { await pg.setup(); });
  afterAll(async () => { await pg.drop(); });

  test("F1a: a fixed 401 delivers the same pending revisions to every group, once", async () => {
    await reset();
    await seed("ลึกลับ-1", "ลึกลับ-2");
    const broken = recorder(() => http(401));
    const first = await runCategoryDiscovery(client(), window, broken.push, ENV);
    expect(first).toMatchObject({ notified: 0, retrying: 4, blocked: 0 });
    expect(first.queue).toMatchObject({ retryable: 4, delivered: 0 });

    const fixed = recorder();
    const second = await runCategoryDiscovery(client(), window, fixed.push, ENV);
    expect(second.notified).toBe(4);
    expect(fixed.sent.map((s) => `${s.name}@${s.group}`).sort()).toEqual(
      [`ลึกลับ-1@${A}`, `ลึกลับ-1@${B}`, `ลึกลับ-2@${A}`, `ลึกลับ-2@${B}`]);
    expect(new Set(fixed.sent.map((s) => s.key)).size).toBe(4);
    // Delivered recipients are never sent the same revision again.
    const third = recorder();
    expect((await runCategoryDiscovery(client(), window, third.push, ENV)).notified).toBe(0);
    expect(third.sent).toEqual([]);
  });

  test("F1b: group A delivered, group B 403 → after the fix only B receives the card", async () => {
    await reset();
    await seed("บางส่วน");
    const partial = recorder((group) => (group === B ? http(403) : undefined));
    expect(await runCategoryDiscovery(client(), window, partial.push, ENV)).toMatchObject({ notified: 1, retrying: 1 });
    expect(partial.sent.map((s) => s.group)).toEqual([A]);
    const fixed = recorder();
    await runCategoryDiscovery(client(), window, fixed.push, ENV);
    expect(fixed.sent.map((s) => s.group)).toEqual([B]);
    expect(await pg.scalar(`SELECT string_agg(group_id || '=' || status, ',' ORDER BY group_id)
      FROM public.produce_category_deliveries`)).toBe(`${A}=delivered,${B}=delivered`);
  });

  test("a definitive rejection (400) is blocked without starving later candidates; explicit requeue recovers it", async () => {
    await reset();
    await seed("พัง", "ดี");
    const run = recorder((_g, name) => (name === "พัง" ? http(400) : undefined));
    expect(await runCategoryDiscovery(client(), window, run.push, ENV)).toMatchObject({ notified: 2, blocked: 2 });
    expect(run.sent.map((s) => s.name)).toEqual(["ดี", "ดี"]);
    const quiet = recorder();
    expect((await runCategoryDiscovery(client(), window, quiet.push, ENV)).queue).toMatchObject({ blocked: 2 });
    expect(quiet.sent).toEqual([]);
    // Operator fixes the cause, then requeues only group A.
    expect(await requeueCategoryDeliveries(client(), A)).toBe(1);
    const recovered = recorder();
    await runCategoryDiscovery(client(), window, recovered.push, ENV);
    expect(recovered.sent.map((s) => `${s.name}@${s.group}`)).toEqual([`พัง@${A}`]);
  });

  test("retries are bounded: a persistent 401 blocks after MAX attempts and stops sending", async () => {
    await reset();
    await seed("หมดสิทธิ์");
    const attempts: string[] = [];
    const always401 = recorder((group) => { attempts.push(group); return http(401); });
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS + 2; i++) await runCategoryDiscovery(client(), window, always401.push, ENV);
    expect(attempts.length).toBe(MAX_DELIVERY_ATTEMPTS * 2);
    expect(await pg.scalar(`SELECT string_agg(DISTINCT status, ',') FROM public.produce_category_deliveries`)).toBe("blocked");
    expect(await requeueCategoryDeliveries(client(), null)).toBe(2);
    expect((await runCategoryDiscovery(client(), window, recorder().push, ENV)).notified).toBe(2);
  });

  test("overlapping cron runs never claim the same delivery twice", async () => {
    await reset();
    await seed("ซ้อน-1", "ซ้อน-2");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sent: string[] = [];
    const slow: PushMessages = async (group, _m, key) => { sent.push(`${group}|${key}`); await gate; };
    const runs = [runCategoryDiscovery(client(), window, slow, ENV), runCategoryDiscovery(client(), window, slow, ENV)];
    setTimeout(release, 1500);
    const results = await Promise.all(runs);
    expect(results.reduce((n, r) => n + r.notified, 0)).toBe(4);
    expect(sent).toHaveLength(4);
    expect(new Set(sent).size).toBe(4);
  }, 20_000);

  test("an unrecorded outcome is retried only after the lease, with the same retry key", async () => {
    await reset();
    await seed("ค้าง");
    const lossy: typeof rpc = (name, args) =>
      name === "complete_produce_category_delivery" ? Promise.resolve({ data: null, error: { message: "network" } }) : rpc(name, args);
    const first = recorder();
    await runCategoryDiscovery(client({ rpc: lossy }), window, first.push, ENV);
    expect(first.sent).toHaveLength(2);
    const during = recorder();
    await runCategoryDiscovery(client(), window, during.push, ENV);
    expect(during.sent).toEqual([]); // lease still held
    await pg.scalar(`UPDATE public.produce_category_deliveries SET claimed_until = now() - interval '1 second' RETURNING 1`);
    const after = recorder();
    await runCategoryDiscovery(client(), window, after.push, ENV);
    expect(after.sent.map((s) => s.key).sort()).toEqual(first.sent.map((s) => s.key).sort());
  });

  test("a new revision is delivered again; the obsolete revision is never claimed or approvable", async () => {
    await reset();
    await seed("เปลี่ยน");
    const v1 = recorder();
    await runCategoryDiscovery(client(), window, v1.push, ENV);
    const old = await pg.scalar(`SELECT id || '|' || revision FROM public.produce_category_candidates WHERE product_name = 'เปลี่ยน'`);
    await pg.scalar(`SET ROLE service_role; SELECT revision FROM public.observe_produce_category_candidate(
      'เปลี่ยน', 'ผ', 'medium', 'test', 'ผักชี', 1, 1, DATE '2026-10-20', DATE '2026-10-20', '{}'::text[])`);
    const v2 = recorder();
    expect((await runCategoryDiscovery(client(), window, v2.push, ENV)).notified).toBe(2);
    expect(new Set([...v1.sent, ...v2.sent].map((s) => s.key)).size).toBe(4);
    const [id, revision] = old.split("|");
    const stale = await pg.scalar(`SET ROLE service_role; SELECT public.decide_produce_category_candidate(
      '${id}'::uuid, ${revision}, 'reject', NULL, NULL, 'U-admin', '${A}', 'evt-stale-card')::text`);
    expect(JSON.parse(stale).status).toBe("stale");
  });

  test("health exposes counts only — no error text, token or payload", async () => {
    const { data } = await rpc("produce_category_delivery_health");
    for (const row of data as Record<string, unknown>[]) expect(Object.keys(row).sort()).toEqual(["deliveries", "group_id", "status"]);
  });
});

describe.skipIf(!pgAvailable)("least privilege under the broad default ACL (PostgreSQL 17)", () => {
  const db = pgHarness("pcp");
  let candidateId = "";

  beforeAll(async () => {
    await db.setup();
    const c = await db.scalar(`SET ROLE service_role; SELECT id FROM public.observe_produce_category_candidate(
      'ผักสิทธิ์', 'ผ', 'medium', 'test', NULL, 1, 1, DATE '2026-10-20', DATE '2026-10-20', '{}'::text[])`);
    candidateId = c;
    const decided = await db.scalar(`SET ROLE service_role; SELECT public.decide_produce_category_candidate(
      '${c}'::uuid, 1, 'approve_suggested', NULL, NULL, 'U-admin', 'C-review', 'evt-priv')::text`);
    expect(JSON.parse(decided).status).toBe("applied");
  });
  afterAll(async () => { await db.drop(); });

  const TABLES = ["produce_category_candidates", "produce_category_rules", "produce_category_decisions", "produce_category_deliveries"];

  test("F3a: service_role cannot rewrite a rule outside the audited RPC", async () => {
    const result = await db.run(`SET ROLE service_role;
      UPDATE public.produce_category_rules SET category_code = 'ม' WHERE product_name = 'ผักสิทธิ์' RETURNING 1;`);
    expect(result.stderr).toContain("permission denied");
    expect(await db.scalar(`SELECT category_code FROM public.produce_category_rules WHERE product_name = 'ผักสิทธิ์'`)).toBe("ผ");
  });

  test("F3b: service_role cannot TRUNCATE any category table; the owner cannot truncate the audit", async () => {
    for (const table of TABLES) {
      expect((await db.run(`SET ROLE service_role; TRUNCATE public.${table} CASCADE;`)).stderr).toContain("permission denied");
    }
    expect((await db.run(`TRUNCATE public.produce_category_decisions CASCADE;`)).stderr).toContain("append-only");
    expect(await db.scalar(`SELECT count(*) FROM public.produce_category_decisions`)).toBe("1");
  });

  test("effective privileges: service_role SELECT only; anon / authenticated / PUBLIC nothing", async () => {
    const privileges = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
    const rows = await db.run(`SELECT r.rolname || ':' || t || ':' || string_agg(p, ',' ORDER BY p)
      FROM unnest(ARRAY['service_role','anon','authenticated']) r(rolname),
           unnest(ARRAY[${TABLES.map(sqlLiteral).join(",")}]) t,
           unnest(ARRAY[${privileges.map(sqlLiteral).join(",")}]) p
      WHERE has_table_privilege(r.rolname, 'public.' || t, p)
      GROUP BY r.rolname, t ORDER BY 1;`);
    expect(lines(rows.stdout).sort()).toEqual(TABLES.map((t) => `service_role:${t}:SELECT`).sort());
    const publicAcl = await db.scalar(`SELECT count(*) FROM pg_class c, aclexplode(c.relacl) a
      WHERE c.relname = ANY(ARRAY[${TABLES.map(sqlLiteral).join(",")}]) AND a.grantee = 0`);
    expect(publicAcl).toBe("0");
  });

  test("SECURITY DEFINER functions: pinned search_path, migration owner, service_role-only EXECUTE", async () => {
    const rows = lines((await db.run(`SELECT p.proname, pg_get_userbyid(p.proowner), p.prosecdef,
        coalesce(array_to_string(p.proconfig, ';'), ''),
        has_function_privilege('service_role', p.oid, 'EXECUTE'),
        has_function_privilege('anon', p.oid, 'EXECUTE'),
        has_function_privilege('authenticated', p.oid, 'EXECUTE'),
        pg_has_role('service_role', p.proowner, 'MEMBER')
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
        AND p.proname LIKE '%produce\\_category%' ORDER BY 1;`)).stdout);
    expect(rows.length).toBe(6);
    for (const row of rows) {
      const [, owner, secdef, config, svc, anon, auth, member] = row.split("|");
      expect({ owner, secdef, svc, anon, auth, member }).toEqual(
        { owner: "postgres", secdef: "t", svc: "t", anon: "f", auth: "f", member: "f" });
      expect(config).toContain("search_path=pg_catalog, public, pg_temp");
    }
  });

  test("audited RPC approval still works under hardened grants and writes exactly one decision; replay is a no-op", async () => {
    expect(await db.scalar(`SELECT count(*) FROM public.produce_category_decisions WHERE candidate_id = '${candidateId}'`)).toBe("1");
    const replay = await db.scalar(`SET ROLE service_role; SELECT public.decide_produce_category_candidate(
      '${candidateId}'::uuid, 1, 'approve_suggested', NULL, NULL, 'U-admin', 'C-review', 'evt-priv')::text`);
    expect(JSON.parse(replay).status).toBe("duplicate");
    expect(await db.scalar(`SELECT count(*) FROM public.produce_category_decisions`)).toBe("1");
    for (const sql of [
      `INSERT INTO public.produce_category_rules VALUES ('x', 'ผ', gen_random_uuid(), 'U', now())`,
      `UPDATE public.produce_category_candidates SET status = 'approved'`,
      `INSERT INTO public.produce_category_deliveries (candidate_id, revision, group_id) VALUES ('${candidateId}', 1, 'C-x')`,
    ]) {
      expect((await db.run(`SET ROLE service_role; ${sql};`)).stderr).toContain("permission denied");
    }
  });
});
