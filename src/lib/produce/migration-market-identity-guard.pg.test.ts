/**
 * PostgreSQL 17 proof for the produce market identity guard.
 *
 * Production 2026-08-14, seller ต้อม, group C98f83da381b20df2829b660845d9b271:
 * one real market opened two accountability rounds because `พาซิโอ้` was not in
 * the reviewed catalog and `พาซีโอ้` therefore could not resolve to it. These
 * tests are the regression for that, plus the guard for the NEXT unreviewed
 * variant, plus proof that PR #50 continuation and PR #51/#52 behaviour survive.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

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

const DATE = "2026-08-14";
const SELLER = "ต้อม";
/** The canonical market, and the two spellings this migration reviews. */
const CANONICAL = "พาซิโอ้";
const ALIAS_SI = "พาซีโอ้";
const ALIAS_SO = "พาสิโอ้";
/** One character from the canonical market and NOT reviewed. */
const UNREVIEWED = "พาชิโอ้";
const PRODUCTION_ROUND = "4aa36324-79a1-4ee3-9161-e64b86d81632";
const PRODUCTION_SOURCE = "C98f83da381b20df2829b660845d9b271";
const OWNER = "U3f04f748584d997819dec0fc71a9b084";
const ACTOR = "U84e999002627396432553ff25bb861ca";

function assertSafe(): void {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
    throw new Error(
      "migration-market-identity-guard.pg.test.ts requires ALLOW_DISPOSABLE_POSTGRES_TESTS=1",
    );
  }
  if (!ALLOWED_HOSTS.has(PGHOST)) throw new Error(`refusing PGHOST=${PGHOST}`);
  if (!DB_NAME_PATTERN.test(DATABASE)) throw new Error(`refusing database=${DATABASE}`);
}

type PsqlResult = { code: number; stdout: string; stderr: string };
async function psql(args: string[], database = DATABASE, stdin?: string): Promise<PsqlResult> {
  const proc = Bun.spawn([PSQL, "-X", ...args], {
    cwd: ROOT,
    stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
    env: {
      ...process.env,
      PGHOST,
      PGUSER,
      PGPASSWORD,
      PGPORT,
      PGDATABASE: database,
      PGCLIENTENCODING: "UTF8",
    },
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

function run(sql: string): Promise<PsqlResult> {
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
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1" || !ALLOWED_HOSTS.has(PGHOST)) {
    return false;
  }
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

let sequence = 1;
function nextUuid(): string {
  return `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
}

interface RoundOptions {
  sourceId: string;
  owner?: string;
  date?: string;
  seller?: string;
  market?: string;
  status?: "open" | "closed";
  /** false seeds a round holding nothing — the blocked-retry leftover. */
  withdrawal?: boolean;
  id?: string;
}

async function seedRound(options: RoundOptions): Promise<string> {
  const id = options.id ?? nextUuid();
  const status = options.status ?? "open";
  const market = options.market ?? CANONICAL;
  await scalar(`
    INSERT INTO public.accountability_rounds (
      id, source_type, source_id, owner_line_user_id, business_date,
      seller_label, market_label, market_label_normalized, status,
      created_line_event_id, closed_at
    ) VALUES (
      ${q(id)}::uuid, 'group', ${q(options.sourceId)}, ${q(options.owner ?? OWNER)},
      DATE ${q(options.date ?? DATE)},
      ${q(options.seller ?? SELLER)}, ${q(market)}, ${q(market)}, ${q(status)},
      ${q(`event:${id}`)}, ${status === "closed" ? "now()" : "NULL"}
    ) RETURNING 1`);
  if (options.withdrawal !== false) {
    await scalar(`
      INSERT INTO public.produce_transactions (accountability_round_id, base_transaction_type)
      VALUES (${q(id)}::uuid, 'เบิก') RETURNING 1`);
  }
  return id;
}

interface BindOptions {
  sourceId: string;
  actor?: string;
  key?: string;
  generation?: string;
  date?: string;
  seller?: string;
  market?: string;
  isNewRound?: boolean;
}

type BindResult = {
  outcome: string;
  accountability_round_id?: string;
  market_label?: string;
};

async function seedPending(options: BindOptions) {
  const actor = options.actor ?? ACTOR;
  const generation = options.generation ?? nextUuid();
  const key = options.key ?? `group:${options.sourceId}:user:${actor}:${generation}`;
  await scalar(`
    INSERT INTO public.pending_sessions (
      session_key, session_generation, source_id, line_user_id
    ) VALUES (
      ${q(key)}, ${q(generation)}::uuid, ${q(options.sourceId)}, ${q(actor)}
    ) RETURNING 1`);
  return { key, generation, actor };
}

async function bindExisting(
  options: BindOptions & { key: string; generation: string; actor: string },
): Promise<BindResult> {
  const market = options.market ?? CANONICAL;
  return JSON.parse(await scalar(`
    SELECT public.bind_plain_text_accountability_round(
      ${q(options.key)}, ${q(options.generation)}::uuid, 'group',
      ${q(options.sourceId)}, ${q(options.actor)}, DATE ${q(options.date ?? DATE)},
      ${q(options.seller ?? SELLER)}, ${q(market)}, ${q(market)},
      ${options.isNewRound === true}
    )`));
}

async function bind(options: BindOptions): Promise<BindResult> {
  const pending = await seedPending(options);
  return bindExisting({ ...options, ...pending });
}

async function roundCount(sourceId: string): Promise<number> {
  return Number(await scalar(`
    SELECT count(*)::text FROM public.accountability_rounds
    WHERE source_id = ${q(sourceId)}`));
}

const pgAvailable = await probe();
let databaseCreated = false;
if (!pgAvailable && process.env.REQUIRE_MARKET_IDENTITY_GUARD_POSTGRES === "1") {
  throw new Error(
    "REQUIRE_MARKET_IDENTITY_GUARD_POSTGRES=1 but the PostgreSQL 17 harness is unavailable",
  );
}

describe.skipIf(!pgAvailable)("produce market identity guard on PostgreSQL 17", () => {
  beforeAll(async () => {
    assertSafe();
    const created = await psql(["-d", "postgres", "-c", `CREATE DATABASE ${DATABASE}`], "postgres");
    expect(created.code, created.stderr).toBe(0);
    databaseCreated = true;
    await apply(join(ROOT, "supabase", "tests", "round_market_identity_bootstrap.sql"));
    await scalar(`
      CREATE TABLE public.produce_transactions (
        accountability_round_id uuid NOT NULL REFERENCES public.accountability_rounds(id),
        base_transaction_type text NOT NULL
      );
      SELECT 1`);
    await apply(join(ROOT, "supabase", "migrations", "20260810100414_p4a_plain_text_round_binding.sql"));
    await apply(join(ROOT, "supabase", "migrations", "20260811181727_round_market_identity_consistency.sql"));
    await apply(join(ROOT, "supabase", "migrations", "20260814104329_cross_user_accountability_round_binding.sql"));
    // The 0055 rows this phase must preserve. The guard migration seeds its own.
    await scalar(`
      INSERT INTO public.line_guided_menu_markets (market_code, label) VALUES
        ('wat_thung_lanna', 'วัดทุ่งลานนา'),
        ('paseo_vegetable', 'พาซิโอ้ผัก'),
        ('paseo_fruit', 'พาซิโอ้ผลไม้');
      INSERT INTO public.line_guided_menu_market_aliases (alias_label, market_code) VALUES
        ('ทุ่งลานนา', 'wat_thung_lanna');
      SELECT 1`);
    // This database is scoped to round binding, so it does not carry the
    // pending-session schema the finalizer needs. The compatibility layer must
    // still be proven to land first: filename order is asserted in
    // migration-order.test.ts, and the RPC itself in
    // migration-fingerprint-compatibility.pg.test.ts, whose bootstrap does
    // carry that schema.
    await apply(join(ROOT, "supabase", "migrations", "20260815213206_produce_market_identity_guard.sql"));
  }, 60_000);

  afterAll(async () => {
    if (!databaseCreated) return;
    await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE}`], "postgres");
  }, 60_000);


  // ── A/B/C — the reviewed catalog is the only thing that collapses labels ────

  test("the migration is idempotent and seeds exactly the reviewed rows", async () => {
    await apply(join(ROOT, "supabase", "migrations", "20260815213206_produce_market_identity_guard.sql"));
    expect(await scalar(`
      SELECT count(*)::text FROM public.line_guided_menu_market_aliases
      WHERE market_code = 'paseo'`)).toBe("2");
    expect(await scalar(`
      SELECT label FROM public.line_guided_menu_markets WHERE market_code = 'paseo'`))
      .toBe(CANONICAL);
  });

  test("CASE A/B — reviewed aliases resolve, canonical stays canonical", async () => {
    expect(await scalar(`SELECT public.accountability_round_market_code(${q(CANONICAL)})`))
      .toBe("paseo");
    expect(await scalar(`SELECT public.accountability_round_market_code(${q(ALIAS_SI)})`))
      .toBe("paseo");
    expect(await scalar(`SELECT public.accountability_round_market_code(${q(ALIAS_SO)})`))
      .toBe("paseo");
    expect(await scalar(`
      SELECT public.accountability_round_same_market(${q(CANONICAL)}, ${q(ALIAS_SI)})`))
      .toBe("t");
    // Whitespace differences normalize before the catalog lookup.
    expect(await scalar(`
      SELECT public.accountability_round_same_market(${q(`  ${CANONICAL}  `)}, ${q(ALIAS_SO)})`))
      .toBe("t");
    // The 0055 alias this phase must not disturb.
    expect(await scalar(`
      SELECT public.accountability_round_same_market('ทุ่งลานนา', 'วัดทุ่งลานนา')`))
      .toBe("t");
  });

  test("CASE C — an unreviewed label is never silently aliased", async () => {
    expect(await scalar(`
      SELECT coalesce(public.accountability_round_market_code(${q(UNREVIEWED)}), 'null')`))
      .toBe("null");
    expect(await scalar(`
      SELECT public.accountability_round_same_market(${q(CANONICAL)}, ${q(UNREVIEWED)})`))
      .toBe("f");
    // Reviewed markets the catalog keeps apart are never merged either.
    expect(await scalar(`
      SELECT public.accountability_round_same_market('พาซิโอ้ผัก', 'พาซิโอ้ผลไม้')`))
      .toBe("f");
    expect(await scalar(`
      SELECT public.accountability_round_same_market(${q(CANONICAL)}, 'พาซิโอ้ผัก')`))
      .toBe("f");
  });

  test("near-match answers exactly one character, and only that", async () => {
    const near = (a: string, b: string) =>
      scalar(`SELECT public.accountability_round_market_near_match(${q(a)}, ${q(b)})`);
    expect(await near(CANONICAL, UNREVIEWED)).toBe("t");
    expect(await near(CANONICAL, `${CANONICAL}x`)).toBe("t");
    // Identical is not "near" — same_market already owns that answer.
    expect(await near(CANONICAL, CANONICAL)).toBe("f");
    expect(await near(CANONICAL, "พาซิโอ้ผัก")).toBe("f");
    expect(await near("ราชพฤกษ์", "วัดตะกล่ำ")).toBe("f");
    // Short labels are never near-matched.
    expect(await near("กี้", "ก้")).toBe("f");
  });

  // ── D/E/F/G — the Production round-binding regression ──────────────────────

  test("CASE D/F — ชั่งคืน sent as พาซีโอ้ binds the canonical พาซิโอ้ round", async () => {
    await seedRound({ sourceId: PRODUCTION_SOURCE, id: PRODUCTION_ROUND });
    const result = await bind({ sourceId: PRODUCTION_SOURCE, market: ALIAS_SI });
    expect(result.outcome).toBe("bound");
    expect(result.accountability_round_id).toBe(PRODUCTION_ROUND);
    expect(result.market_label).toBe(CANONICAL);
  });

  test("CASE G — คืนเสีย sent as พาสิโอ้ binds the same canonical round", async () => {
    const result = await bind({ sourceId: PRODUCTION_SOURCE, market: ALIAS_SO });
    expect(result.accountability_round_id).toBe(PRODUCTION_ROUND);
  });

  test("CASE E — an alias continuation creates no second accountability round", async () => {
    expect(await roundCount(PRODUCTION_SOURCE)).toBe(1);
  });

  test("CASE J — an additional batch under an alias joins the same round", async () => {
    // เบิกเพิ่ม is a continuation, not a new economic cycle, so it discovers.
    const result = await bind({ sourceId: PRODUCTION_SOURCE, market: ALIAS_SI });
    expect(result.accountability_round_id).toBe(PRODUCTION_ROUND);
    expect(await roundCount(PRODUCTION_SOURCE)).toBe(1);
  });

  test("CASE H — cross-user continuation under an alias still works", async () => {
    // PR #50: the business identity owns the round, not the LINE user.
    const sourceId = "G-cross-user";
    const round = await seedRound({ sourceId, owner: "U-opener" });
    const result = await bind({ sourceId, actor: "U-someone-else", market: ALIAS_SO });
    expect(result.accountability_round_id).toBe(round);
    expect(await scalar(`
      SELECT owner_line_user_id FROM public.accountability_rounds WHERE id = ${q(round)}::uuid`))
      .toBe("U-opener");
  });

  test("the ทุ่งลานนา alias keeps binding วัดทุ่งลานนา", async () => {
    const sourceId = "G-lanna";
    const round = await seedRound({ sourceId, market: "วัดทุ่งลานนา" });
    expect((await bind({ sourceId, market: "ทุ่งลานนา" })).accountability_round_id).toBe(round);
  });

  test("an unreviewed variant does not bind — it is told which market the round is", async () => {
    const sourceId = "G-unreviewed";
    const round = await seedRound({ sourceId });
    const pending = await seedPending({ sourceId });
    const result = await bindExisting({ sourceId, ...pending, market: UNREVIEWED });
    expect(result.outcome).toBe("market_mismatch");
    expect(result.accountability_round_id).toBe(round);
    expect(result.market_label).toBe(CANONICAL);
    expect(await scalar(`
      SELECT coalesce(accountability_round_id::text, 'null')
      FROM public.pending_sessions WHERE session_key = ${q(pending.key)}`)).toBe("null");
  });

  // ── N — the creation-path near-match guard ─────────────────────────────────

  test("CASE N — a withdrawal one character off refuses instead of opening a round", async () => {
    const sourceId = "G-near";
    const round = await seedRound({ sourceId });
    const result = await bind({ sourceId, market: UNREVIEWED, isNewRound: true });

    expect(result.outcome).toBe("market_near_match");
    expect(result.accountability_round_id).toBe(round);
    expect(result.market_label).toBe(CANONICAL);
    expect(await roundCount(sourceId)).toBe(1);
  });

  test("the guard binds nothing — the pending generation stays unbound", async () => {
    const sourceId = "G-near-unbound";
    await seedRound({ sourceId });
    const pending = await seedPending({ sourceId });
    const result = await bindExisting({
      sourceId, ...pending, market: UNREVIEWED, isNewRound: true,
    });
    expect(result.outcome).toBe("market_near_match");
    expect(await scalar(`
      SELECT coalesce(accountability_round_id::text, 'null')
      FROM public.pending_sessions WHERE session_key = ${q(pending.key)}`)).toBe("null");
  });

  test("a reviewed alias is never near-matched — it binds and opens nothing new", async () => {
    // The whole point: พาซีโอ้ is now KNOWN to be พาซิโอ้, so a return resolves
    // rather than being sent back to a human.
    const sourceId = "G-alias-not-guarded";
    const round = await seedRound({ sourceId });
    expect((await bind({ sourceId, market: ALIAS_SI })).accountability_round_id).toBe(round);
    expect(await roundCount(sourceId)).toBe(1);
  });

  test("two reviewed catalog markets are never guarded against each other", async () => {
    // A seller legitimately running two markets in one group must not be asked
    // to confirm the second one, even when the labels are one character apart.
    await scalar(`
      INSERT INTO public.line_guided_menu_markets (market_code, label) VALUES
        ('near_a', 'ตลาดใกล้กันก'), ('near_b', 'ตลาดใกล้กันข');
      SELECT 1`);
    expect(await scalar(`
      SELECT public.accountability_round_market_near_match('ตลาดใกล้กันก', 'ตลาดใกล้กันข')`))
      .toBe("t");

    const sourceId = "G-two-reviewed";
    await seedRound({ sourceId, market: "ตลาดใกล้กันก" });
    const result = await bind({ sourceId, market: "ตลาดใกล้กันข", isNewRound: true });
    expect(result.outcome).toBe("bound");
    expect(await roundCount(sourceId)).toBe(2);
  });

  test("an empty leftover round never shadows a new withdrawal", async () => {
    // A blocked-then-retried withdrawal leaves an open round holding nothing.
    // It has no business content to protect, so it cannot block anyone.
    const sourceId = "G-empty-leftover";
    await seedRound({ sourceId, withdrawal: false });
    const result = await bind({ sourceId, market: UNREVIEWED, isNewRound: true });
    expect(result.outcome).toBe("bound");
  });

  test("a closed round never shadows a new withdrawal", async () => {
    const sourceId = "G-closed";
    await seedRound({ sourceId, status: "closed" });
    expect((await bind({ sourceId, market: UNREVIEWED, isNewRound: true })).outcome).toBe("bound");
  });

  test("the guard is scoped to one group, seller and business date", async () => {
    await seedRound({ sourceId: "G-scope-a" });
    expect((await bind({ sourceId: "G-scope-b", market: UNREVIEWED, isNewRound: true })).outcome)
      .toBe("bound");

    const sourceId = "G-scope-c";
    await seedRound({ sourceId });
    expect((await bind({ sourceId, market: UNREVIEWED, seller: "จิ๋ว", isNewRound: true })).outcome)
      .toBe("bound");
    expect((await bind({
      sourceId, market: UNREVIEWED, date: "2026-08-13", isNewRound: true,
    })).outcome).toBe("bound");
  });

  // ── PR #51 / #52 — nothing the guard touches may regress ───────────────────

  test("PR #52 — a replayed creating generation is idempotent, never re-guarded", async () => {
    // Out-of-order redelivery and a second close of the same document must not
    // meet a guard that refuses the round this generation already owns.
    const sourceId = "G-replay";
    const pending = await seedPending({ sourceId });
    const first = await bindExisting({ sourceId, ...pending, isNewRound: true });
    expect(first.outcome).toBe("bound");

    // A round one character away appears afterwards, with real content.
    await seedRound({ sourceId, market: UNREVIEWED, owner: "U-other" });

    const replay = await bindExisting({ sourceId, ...pending, isNewRound: true });
    expect(replay.outcome).toBe("already_bound");
    expect(replay.accountability_round_id).toBe(first.accountability_round_id);
  });

  test("a legitimate second withdrawal for the SAME market still opens its round", async () => {
    // PR #51 left intentional additional batches alone; so does this guard.
    const sourceId = "G-second-withdrawal";
    await seedRound({ sourceId });
    const result = await bind({ sourceId, isNewRound: true });
    expect(result.outcome).toBe("bound");
    expect(await roundCount(sourceId)).toBe(2);
  });

  test("CASE N — the Production two-round state stays fail-closed for returns", async () => {
    // The 2026-08-14 evidence rounds are canonical + alias, i.e. ONE market with
    // two masters. Nothing may guess which one a return belongs to.
    const sourceId = "G-ambiguous";
    await seedRound({ sourceId, market: CANONICAL });
    await seedRound({ sourceId, market: ALIAS_SI });
    const pending = await seedPending({ sourceId });
    const result = await bindExisting({ sourceId, ...pending, market: ALIAS_SO });
    expect(result.outcome).toBe("ambiguous");
    expect(await scalar(`
      SELECT coalesce(accountability_round_id::text, 'null')
      FROM public.pending_sessions WHERE session_key = ${q(pending.key)}`)).toBe("null");
  });

  test("no historical round was mutated by applying the migration", async () => {
    expect(await scalar(`
      SELECT count(*)::text FROM public.accountability_rounds
      WHERE status = 'cancelled'`)).toBe("0");
  });

  // Last on purpose: every case above runs against the pre-20260930 catalog.
  test("20260930 vegetable aliases resolve to พาซิโอ้ผัก only, idempotently", async () => {
    const migration = join(ROOT, "supabase", "migrations", "20260930090100_paseo_vegetable_market_aliases.sql");
    await apply(migration);
    await apply(migration);
    for (const alias of ["พาซีโอ้ผัก", "ตลาดพาซิโอ้ผัก", "พาซิโอ้ผัก"]) {
      expect(await scalar(`SELECT public.accountability_round_market_code(${q(alias)})`))
        .toBe("paseo_vegetable");
    }
    // "พาซิโอ้ เบิกผัก" cleans to this; it must not become the vegetable market.
    expect(await scalar(`SELECT public.accountability_round_market_code(${q("พาซิโอ้ ผัก")}) IS NULL`))
      .toBe("t");
    expect(await scalar(`SELECT public.accountability_round_market_code(${q("พาซีโอ้")})`))
      .toBe("paseo");
    expect(await scalar(`
      SELECT count(*)::text FROM public.line_guided_menu_market_aliases
      WHERE market_code = 'paseo_vegetable'`)).toBe("2");
  });
});
