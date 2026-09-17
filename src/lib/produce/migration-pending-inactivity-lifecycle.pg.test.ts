/**
 * PostgreSQL 17 proof for the inactivity-based lifecycle on OPEN pending
 * Produce sessions (20260829090000_produce_pending_inactivity_lifecycle.sql).
 *
 * Today the finalize cron only ever sees a session that was already CLOSED —
 * every existing sweep requires a close boundary. An open, idle draft holds
 * the operator's active-session lock forever and is invisible everywhere
 * else. These tests prove the two new sweeps close that gap without
 * reaching into any row the existing sweeps already own.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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

const DATE = "2026-08-29";
const SELLER = "จิ้ว";
const MARKET = "ราชพฤก";
const SOURCE = "C4fa145d58f23a17e7e7b14315f334c6d";
const OWNER = "U3f04f748584d997819dec0fc71a9b084";

function assertSafe(): void {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
    throw new Error(
      "migration-pending-inactivity-lifecycle.pg.test.ts requires ALLOW_DISPOSABLE_POSTGRES_TESTS=1",
    );
  }
  if (!ALLOWED_HOSTS.has(PGHOST)) throw new Error(`refusing PGHOST=${PGHOST}`);
  if (!DB_NAME_PATTERN.test(DATABASE)) throw new Error(`refusing database=${DATABASE}`);
}

type PsqlResult = { code: number; stdout: string; stderr: string };

function spawnPsql(args: string[], database = DATABASE, stdin?: string) {
  return Bun.spawn([PSQL, "-X", ...args], {
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
}

async function collect(proc: ReturnType<typeof spawnPsql>): Promise<PsqlResult> {
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

function psql(args: string[], database = DATABASE, stdin?: string): Promise<PsqlResult> {
  return collect(spawnPsql(args, database, stdin));
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

async function seedRound(): Promise<string> {
  const id = nextUuid();
  await scalar(`
    INSERT INTO public.accountability_rounds (
      id, source_type, source_id, owner_line_user_id, business_date,
      seller_label, market_label, market_label_normalized, status, created_line_event_id
    ) VALUES (
      ${q(id)}::uuid, 'group', ${q(SOURCE)}, ${q(OWNER)}, DATE ${q(DATE)},
      ${q(SELLER)}, ${q(MARKET)}, ${q(MARKET)}, 'open',
      ${q(`event:${id}`)}
    ) RETURNING 1`);
  return id;
}

async function roundStatus(id: string): Promise<string> {
  return await scalar(`SELECT status FROM public.accountability_rounds WHERE id = ${q(id)}::uuid`);
}

interface PendingOptions {
  roundId?: string | null;
  /** Minutes ago the row was created and last touched. */
  idleMinutes?: number;
  admissionCount?: number;
  terminalized?: boolean;
  closeScheduled?: boolean;
  closeRefused?: boolean;
  processing?: boolean;
  finalizationStatus?: string;
  environment?: string | null;
}

async function seedPending(options: PendingOptions = {}): Promise<{ key: string; generation: string }> {
  const generation = nextUuid();
  const key = `group:${SOURCE}:user:${OWNER}:${generation}`;
  const idle = options.idleMinutes ?? 0;
  await scalar(`
    INSERT INTO public.pending_sessions (
      session_key, session_generation, source_id, line_user_id, accumulated_text,
      accountability_round_id, terminalized, created_at, updated_at,
      close_requested_at, close_event_timestamp_ms, close_deadline_at,
      next_attempt_at, finalization_status, finalization_started_at,
      close_refused_at, close_refused_session_generation, runtime_environment
    ) VALUES (
      ${q(key)}, ${q(generation)}::uuid, ${q(SOURCE)}, ${q(OWNER)},
      ${q(`${SELLER}-${MARKET} ชั่งคืน`)},
      ${options.roundId === undefined || options.roundId === null
        ? "NULL"
        : `${q(options.roundId)}::uuid`},
      ${options.terminalized === true},
      now() - interval '${idle} minutes', now() - interval '${idle} minutes',
      ${options.closeScheduled ? "now()" : "NULL"},
      ${options.closeScheduled ? "1000" : "NULL"},
      ${options.closeScheduled ? "now() + interval '30 seconds'" : "NULL"},
      ${options.closeScheduled ? "now()" : "NULL"},
      ${q(options.finalizationStatus ?? "pending")},
      ${options.processing ? "now()" : "NULL"},
      ${options.closeRefused ? "now()" : "NULL"},
      ${options.closeRefused ? `${q(generation)}::uuid` : "NULL"},
      ${options.environment === null ? "NULL" : q(options.environment ?? "production")}
    ) RETURNING 1`);

  const admissionCount = options.admissionCount ?? 0;
  for (let i = 0; i < admissionCount; i += 1) {
    await scalar(`
      INSERT INTO public.pending_session_admission (
        session_key, session_generation, line_event_id, line_timestamp_ms
      ) VALUES (
        ${q(key)}, ${q(generation)}::uuid, ${q(`evt-${generation}-${i}`)}, ${1000 + i}
      ) RETURNING 1`);
  }

  return { key, generation };
}

async function pendingField(key: string, column: string): Promise<string> {
  return await scalar(
    `SELECT coalesce(${column}::text, '<null>') FROM public.pending_sessions
     WHERE session_key = ${q(key)}`,
  );
}

/** Ages a row's updated_at (and optionally its warning stamp) without going
 *  through any RPC — simulating either pure idle time or a real correction. */
async function touch(key: string, field: "updated_at" | "inactivity_warning_sent_at", minutesAgo: number): Promise<void> {
  await scalar(`
    UPDATE public.pending_sessions SET ${field} = now() - interval '${minutesAgo} minutes'
    WHERE session_key = ${q(key)} RETURNING 1`);
}

async function warn(limit = 25): Promise<string[]> {
  const output = await run(`
    SELECT session_key
    FROM public.sweep_pending_session_inactivity_warnings(${limit}, 'production', interval '25 minutes')`);
  if (output.code !== 0) throw new Error(output.stderr);
  return output.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

interface ExpiryRow {
  sessionKey: string;
  outcome: string;
  acceptedItemCount: string;
}

async function expire(limit = 25): Promise<ExpiryRow[]> {
  const output = await run(`
    SELECT session_key || '|' || outcome || '|' || accepted_item_count::text
    FROM public.sweep_pending_session_inactivity_expiry(${limit}, 'production', interval '30 minutes')`);
  if (output.code !== 0) throw new Error(output.stderr);
  return output.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [sessionKey, outcome, acceptedItemCount] = line.split("|");
      return { sessionKey, outcome, acceptedItemCount };
    });
}

const pgAvailable = await probe();
let databaseCreated = false;
if (!pgAvailable && process.env.REQUIRE_PENDING_LIFECYCLE_POSTGRES === "1") {
  throw new Error(
    "REQUIRE_PENDING_LIFECYCLE_POSTGRES=1 but the PostgreSQL 17 harness is unavailable",
  );
}

describe.skipIf(!pgAvailable)("pending session inactivity lifecycle on PostgreSQL 17", () => {
  beforeAll(async () => {
    assertSafe();
    const created = await psql(["-d", "postgres", "-c", `CREATE DATABASE ${DATABASE}`], "postgres");
    expect(created.code, created.stderr).toBe(0);
    databaseCreated = true;
    await apply(join(ROOT, "supabase", "tests", "round_market_identity_bootstrap.sql"));
    await apply(join(ROOT, "supabase", "tests", "produce_pending_lifecycle_bootstrap.sql"));
    await apply(join(ROOT, "supabase", "tests", "produce_pending_inactivity_bootstrap.sql"));
    // The existing P1-A/P1-B migrations, applied in real rollout order, so T10
    // proves this migration lands on TOP of that lifecycle without disturbing it.
    await apply(join(
      ROOT, "supabase", "migrations",
      "20260817080439_produce_pending_supersession_and_close_recovery.sql",
    ));
    await apply(join(
      ROOT, "supabase", "migrations",
      "20260817085632_produce_supersession_runtime_environment.sql",
    ));
    await apply(join(
      ROOT, "supabase", "migrations",
      "20260829090000_produce_pending_inactivity_lifecycle.sql",
    ));
    await apply(join(
      ROOT, "supabase", "migrations",
      "20260915170000_pending_inactivity_generation_hardening.sql",
    ));
  }, 120_000);

  afterAll(async () => {
    if (!databaseCreated) return;
    await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE}`], "postgres");
  }, 60_000);

  // Full isolation between tests. Without this, a row seeded with a FIXED
  // absolute age (idleMinutes baked into created_at/updated_at at INSERT
  // time) drifts further past a threshold as real wall-clock time elapses
  // across the rest of the suite, and a later test's warn()/expire() call
  // can pick up an earlier test's leftover row.
  beforeEach(async () => {
    await scalar("DELETE FROM public.pending_session_admission RETURNING 1");
    await scalar("DELETE FROM public.pending_sessions RETURNING 1");
    await scalar("DELETE FROM public.produce_transactions RETURNING 1");
    await scalar("DELETE FROM public.produce_sessions RETURNING 1");
    await scalar("DELETE FROM public.accountability_rounds RETURNING 1");
  });

  test("the migration is idempotent", async () => {
    await apply(join(
      ROOT, "supabase", "migrations",
      "20260915170000_pending_inactivity_generation_hardening.sql",
    ));
    expect(await scalar(`
      SELECT count(*)::text FROM information_schema.columns
      WHERE table_name = 'pending_sessions' AND column_name = 'inactivity_warning_sent_at'`))
      .toBe("1");
    expect(await scalar(`
      SELECT pg_get_constraintdef(c.oid) LIKE '%expired_empty_draft%'
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'pending_sessions' AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) LIKE '%finalization_status%'`))
      .toBe("t");
  });

  // ── T1 / T3: warning sweep ──────────────────────────────────────────────

  test("T1 — empty draft at 25m gets exactly one warning", async () => {
    const { key } = await seedPending({ idleMinutes: 25, admissionCount: 0 });
    expect(await warn()).toEqual([key]);
    expect(await pendingField(key, "inactivity_warning_sent_at")).not.toBe("<null>");
    // No spam on an immediate re-run with no new activity.
    expect(await warn()).toEqual([]);
    // Not expiry-eligible yet at 25m.
    expect(await expire()).toEqual([]);
  });

  test("T3 — a partial (non-empty) draft at 25m also gets exactly one warning", async () => {
    const { key } = await seedPending({ idleMinutes: 25, admissionCount: 2 });
    expect(await warn()).toEqual([key]);
    expect(await warn()).toEqual([]);
  });

  test("boundary — just under 25m idle gets no warning", async () => {
    const { key } = await seedPending({ idleMinutes: 0 });
    await touch(key, "updated_at", 24 + 55 / 60); // 24m55s idle
    expect(await warn()).toEqual([]);
    expect(await expire()).toEqual([]);
  });

  // ── P3 fix: the warning sweep's upper bound. A row already expiry-eligible
  // (>= 30m idle) must never be warned — the "5 minutes left" message would
  // be factually wrong. Both `warn()` and `expire()` are asserted for each
  // case, per the required contract: 25m <= idle < 30m is warn-only,
  // idle >= 30m is expire-only, and the two are always mutually exclusive.

  test("boundary — 29:59 idle still gets a warning and is not yet expiry-eligible", async () => {
    const { key } = await seedPending({ idleMinutes: 0 });
    await touch(key, "updated_at", 29 + 59 / 60); // 29m59s idle
    expect(await warn()).toEqual([key]);
    expect(await expire()).toEqual([]);
  });

  test("boundary — exactly 30m idle gets no warning and is expiry-eligible", async () => {
    const { key } = await seedPending({ idleMinutes: 30, admissionCount: 0 });
    expect(await warn()).toEqual([]);
    const result = await expire();
    expect(result.map((r) => r.sessionKey)).toEqual([key]);
  });

  test("boundary — well past 30m idle gets no warning and is expiry-eligible", async () => {
    const { key } = await seedPending({ idleMinutes: 45, admissionCount: 0 });
    expect(await warn()).toEqual([]);
    const result = await expire();
    expect(result.map((r) => r.sessionKey)).toEqual([key]);
  });

  // ── T2 / T4: expiry sweep ────────────────────────────────────────────────

  test("T2 — empty draft at 30m expires empty, not finalized, round untouched", async () => {
    const round = await seedRound();
    const { key } = await seedPending({ idleMinutes: 30, admissionCount: 0, roundId: round });
    const result = await expire();
    expect(result).toEqual([{ sessionKey: key, outcome: "expired_empty_draft", acceptedItemCount: "0" }]);

    expect(await pendingField(key, "terminalized")).toBe("true");
    expect(await pendingField(key, "finalization_status")).toBe("expired_empty_draft");
    expect(await pendingField(key, "finalization_error->>'reason'")).toBe("inactivity_expired_empty");
    // No produce row was ever written — the sweep never calls
    // try_finalize_pending_generation.
    expect(await scalar(`SELECT count(*)::text FROM public.produce_sessions`)).toBe("0");
    // No round retirement side effect — unlike supersession/close-recovery.
    expect(await roundStatus(round)).toBe("open");
  });

  test("T4 — partial draft at 30m fails closed as expired_incomplete, stays actionable", async () => {
    const round = await seedRound();
    const { key } = await seedPending({ idleMinutes: 30, admissionCount: 3, roundId: round });
    const result = await expire();
    expect(result).toEqual([{ sessionKey: key, outcome: "failed_closed", acceptedItemCount: "3" }]);

    expect(await pendingField(key, "terminalized")).toBe("true");
    expect(await pendingField(key, "finalization_status")).toBe("failed_closed");
    expect(await pendingField(key, "finalization_error->>'reason'")).toBe("expired_incomplete");
    expect(await scalar(`SELECT count(*)::text FROM public.produce_sessions`)).toBe("0");
    expect(await scalar(`SELECT count(*)::text FROM public.produce_transactions`)).toBe("0");
    expect(await roundStatus(round)).toBe("open");
  });

  test("boundary — just under 30m idle does not expire", async () => {
    const { key } = await seedPending({ idleMinutes: 0, admissionCount: 0 });
    await touch(key, "updated_at", 29 + 55 / 60); // 29m55s idle
    expect(await expire()).toEqual([]);
    expect(await pendingField(key, "terminalized")).toBe("false");
  });

  // ── T5 / T6 / T7: activity and re-arm ───────────────────────────────────

  test("T5 — activity before expiry keeps the session active", async () => {
    const { key } = await seedPending({ idleMinutes: 40 });
    await touch(key, "updated_at", 5); // a correction landed 5 minutes ago
    expect(await expire()).toEqual([]);
    expect(await pendingField(key, "terminalized")).toBe("false");
  });

  test("T6 — activity after a warning re-arms only after a NEW full 25m window", async () => {
    const { key } = await seedPending({ idleMinutes: 26, admissionCount: 1 });
    expect(await warn()).toEqual([key]); // stamps inactivity_warning_sent_at = t0

    // Fresh activity: updated_at moves to "just now", strictly after t0. Not
    // yet re-armable — the row is simply active again.
    await touch(key, "updated_at", 0);
    expect(await warn()).toEqual([]);
    expect(await expire()).toEqual([]);

    // A NEW full 25-minute window elapses with NO further activity. Age BOTH
    // stamps together (not just updated_at) so their relative order —
    // warning sent BEFORE the reactivating update — is preserved exactly as
    // real elapsed time would leave it; only their distance from "now" moves.
    await scalar(`
      UPDATE public.pending_sessions
      SET updated_at = updated_at - interval '25 minutes',
          inactivity_warning_sent_at = inactivity_warning_sent_at - interval '25 minutes'
      WHERE session_key = ${q(key)} RETURNING 1`);
    expect(await warn()).toEqual([key]);
  });

  test("T7 — repeated sweeps inside the 25–30m window never spam a second warning", async () => {
    const { key } = await seedPending({ idleMinutes: 27 });
    expect(await warn()).toEqual([key]);
    expect(await warn()).toEqual([]);
    expect(await warn()).toEqual([]);
    // Still short of 30m — no expiry yet.
    expect(await expire()).toEqual([]);
  });

  // ── T8 / T9: rows the existing sweeps already own ───────────────────────

  test("T8 — a closed, finalized, or processing session is untouched by both sweeps", async () => {
    const closing = await seedPending({ idleMinutes: 40, closeScheduled: true });
    const finalized = await seedPending({ idleMinutes: 40, terminalized: true, finalizationStatus: "finalized" });
    const processing = await seedPending({ idleMinutes: 40, processing: true });

    const warned = await warn();
    const expired = await expire();
    for (const { key } of [closing, finalized, processing]) {
      expect(warned).not.toContain(key);
      expect(expired.map((r) => r.sessionKey)).not.toContain(key);
    }
    expect(await pendingField(closing.key, "terminalized")).toBe("false");
    expect(await pendingField(processing.key, "terminalized")).toBe("false");
  });

  test("T9 — a close-refused or already-failed_closed session stays untouched and actionable", async () => {
    const refused = await seedPending({ idleMinutes: 40, closeRefused: true });
    const alreadyFailed = await seedPending({ idleMinutes: 40, terminalized: true, finalizationStatus: "failed_closed" });

    const warned = await warn();
    const expired = await expire();
    for (const { key } of [refused, alreadyFailed]) {
      expect(warned).not.toContain(key);
      expect(expired.map((r) => r.sessionKey)).not.toContain(key);
    }
    // The refused row is left for recover_stranded_plain_text_closes, not
    // silently terminalized by this migration.
    expect(await pendingField(refused.key, "terminalized")).toBe("false");
  });

  test("T9b — a refusal stamp from an older generation does not strand the current draft", async () => {
    const { key, generation } = await seedPending({ idleMinutes: 40, admissionCount: 2 });
    const oldGeneration = nextUuid();
    expect(oldGeneration).not.toBe(generation);
    await scalar(`
      UPDATE public.pending_sessions
      SET close_refused_at = now() - interval '40 minutes',
          close_refused_session_generation = ${q(oldGeneration)}::uuid
      WHERE session_key = ${q(key)} RETURNING 1`);

    const expired = await expire();
    expect(expired).toContainEqual({ sessionKey: key, outcome: "failed_closed", acceptedItemCount: "2" });
    expect(await pendingField(key, "terminalized")).toBe("true");
  });

  // ── T10: the P1-A/P1-B lifecycle this migration sits on top of ─────────

  test("T10 — recover_stranded_plain_text_closes still fails a stranded refusal closed", async () => {
    const round = await seedRound();
    const generation = nextUuid();
    const key = `group:${SOURCE}:user:${OWNER}:${generation}`;
    await scalar(`
      INSERT INTO public.pending_sessions (
        session_key, session_generation, source_id, line_user_id, accumulated_text,
        accountability_round_id, terminalized, created_at, updated_at, finalization_status,
        runtime_environment
      ) VALUES (
        ${q(key)}, ${q(generation)}::uuid, ${q(SOURCE)}, ${q(OWNER)}, ${q(`${SELLER}-${MARKET} ชั่งคืน\nจบรายการชั่งคืน`)},
        ${q(round)}::uuid, false, now() - interval '35 minutes', now() - interval '35 minutes',
        'pending', 'production'
      ) RETURNING 1`);
    expect(JSON.parse(await scalar(`
      SELECT public.mark_plain_text_close_refused(
        ${q(key)}, ${q(generation)}::uuid, 'evt-close', 'entry_gate_refusal')`)).marked).toBe(true);
    await scalar(`
      UPDATE public.pending_sessions
      SET close_refused_at = close_refused_at - interval '31 minutes',
          updated_at = updated_at - interval '31 minutes'
      WHERE session_key = ${q(key)} RETURNING 1`);

    // The inactivity sweeps must not race this row (close_refused_at excludes it).
    expect(await warn()).toEqual([]);
    expect(await expire()).toEqual([]);

    const recovered = await scalar(`
      SELECT session_key || '|' || round_outcome
      FROM public.recover_stranded_plain_text_closes(25, 'production')`);
    expect(recovered).toBe(`${key}|cancelled`);
    expect(await pendingField(key, "finalization_status")).toBe("failed_closed");
    expect(await pendingField(key, "finalization_error->>'reason'")).toBe("close_refused_unresolved");
    expect(await roundStatus(round)).toBe("cancelled");
  });
});
