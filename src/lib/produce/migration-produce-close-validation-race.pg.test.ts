/**
 * PostgreSQL 17 proof for 20260831120000_produce_close_validation_race.sql.
 *
 * Reproduces the real Production failure of 2026-08-30: the close was admitted
 * at 06:13:30.544Z while legitimate items whose LINE timestamps preceded it
 * kept committing until 06:13:36.980Z. The close boundary landed on a document
 * the entry gate had never seen, and the session later terminalized as
 * failed_closed with validation_errors = ["entry validation review was never
 * confirmed"].
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
const HELD_CLOSE_SAFETY = join(
  ROOT, "supabase", "migrations", "20261121120000_produce_held_close_state_safety.sql",
);
const CONFIRMATION_TIMESTAMP_GUARD = join(
  ROOT, "supabase", "migrations", "20261121120200_produce_line_confirmation_timestamp_guard.sql",
);
const DATABASE = `mig_${randomBytes(4).toString("hex")}`;
const DB_NAME_PATTERN = /^mig_[a-f0-9]+$/;
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const SOURCE = "C4fa145d58f23a17e7e7b14315f334c6d";
const OWNER = "U3f04f748584d997819dec0fc71a9b084";

// The real ordering from 2026-08-30, in LINE milliseconds.
const CLOSE_TS = 1_756_534_410_544; // 06:13:30.544Z — close event
const LATE_ITEM_TS = CLOSE_TS - 4_000; // pre-close LINE timestamp...
const POST_CLOSE_TS = CLOSE_TS + 1; // ...versus a genuinely post-close one

function assertSafe(): void {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
    throw new Error(
      "migration-produce-close-validation-race.pg.test.ts requires ALLOW_DISPOSABLE_POSTGRES_TESTS=1",
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

interface Session {
  key: string;
  generation: string;
  roundId: string;
}

async function seedSession(): Promise<Session> {
  const generation = nextUuid();
  const roundId = nextUuid();
  const key = `group:${SOURCE}:user:${OWNER}:${generation}`;
  await scalar(
    `INSERT INTO public.accountability_rounds (id, status)
     VALUES (${q(roundId)}::uuid, 'open') RETURNING 1`,
  );
  await scalar(`
    INSERT INTO public.pending_sessions (
      session_key, session_generation, source_id, line_user_id,
      accumulated_text, accountability_round_id, runtime_environment
    ) VALUES (
      ${q(key)}, ${q(generation)}::uuid, ${q(SOURCE)}, ${q(OWNER)},
      ${q("จิ้ว-ราชพฤก ชั่งคืน")}, ${q(roundId)}::uuid, 'production'
    ) RETURNING 1`);
  return { key, generation, roundId };
}

/** One ordinary item message. Bumps ingest_revision, like real operator content. */
async function admitItem(s: Session, eventId: string, timestampMs: number): Promise<string> {
  return await scalar(`
    SELECT public.append_pending_session(
      ${q(s.key)}, ${q(`ทุเรียน 10 ${eventId}`)}, NULL, ${q(eventId)},
      ${timestampMs}, false, ${q(s.generation)}::uuid, NULL
    )->>'reason'`);
}

/** A close attempt pinned to the revision the entry gate validated. */
async function closeWithPin(
  s: Session,
  eventId: string,
  pinnedRevision: number | null,
  timestampMs = CLOSE_TS,
): Promise<{ reason: string; accepted: string; currentRevision: string }> {
  const line = await scalar(`
    SELECT
      (r->>'reason') || '|' || (r->>'accepted') || '|' || coalesce(r->>'current_revision', '')
    FROM public.append_pending_session(
      ${q(s.key)}, ${q("จบรายการเบิก")}, NULL, ${q(eventId)},
      ${timestampMs}, true, ${q(s.generation)}::uuid, NULL,
      ${pinnedRevision === null ? "NULL" : pinnedRevision}
    ) AS r`);
  const [reason, accepted, currentRevision] = line.split("|");
  return { reason, accepted, currentRevision };
}

async function field(key: string, column: string): Promise<string> {
  return await scalar(
    `SELECT coalesce(${column}::text, '<null>') FROM public.pending_sessions
     WHERE session_key = ${q(key)}`,
  );
}

async function revisionOf(key: string): Promise<number> {
  return Number(await field(key, "ingest_revision"));
}

async function hold(s: Session, pinnedRevision: number | null): Promise<string> {
  return await scalar(`
    SELECT public.hold_pending_validation_review(
      ${q(s.key)}, ${q(s.generation)}::uuid,
      ${pinnedRevision === null ? "NULL" : pinnedRevision})->>'reason'`);
}

async function resume(s: Session): Promise<string> {
  return await scalar(`
    SELECT public.resume_pending_close_finalization(
      ${q(s.key)}, ${q(s.generation)}::uuid)->>'reason'`);
}

async function recordReview(s: Session, digest: string, eventId: string): Promise<string> {
  return await scalar(`
    SELECT coalesce(r->>'status', 'recorded')
    FROM public.record_produce_validation_review(
      ${q(s.key)}, ${q(s.generation)}::uuid, ${q(s.roundId)}::uuid, ${q(digest)},
      DATE '2026-08-30', 'ราชพฤก', 'จิ้ว', '[]'::jsonb, ${q(OWNER)}, ${q(eventId)}
    ) AS r`);
}

async function confirmReview(
  s: Session, digest: string, eventId: string, timestampMs: number | null = Date.now() + 1000,
): Promise<string> {
  return await scalar(`
    SELECT public.confirm_produce_validation_review(
      ${q(s.key)}, ${q(s.generation)}::uuid, ${q(digest)}, ${q(OWNER)}, ${q(eventId)}, ${timestampMs ?? "NULL"}
    )->>'status'`);
}

const pgAvailable = await probe();
let databaseCreated = false;
if (!pgAvailable && process.env.REQUIRE_CLOSE_VALIDATION_RACE_POSTGRES === "1") {
  throw new Error(
    "REQUIRE_CLOSE_VALIDATION_RACE_POSTGRES=1 but the PostgreSQL 17 harness is unavailable",
  );
}

describe.skipIf(!pgAvailable)("produce close validation race on PostgreSQL 17", () => {
  beforeAll(async () => {
    assertSafe();
    const created = await psql(["-d", "postgres", "-c", `CREATE DATABASE ${DATABASE}`], "postgres");
    expect(created.code, created.stderr).toBe(0);
    databaseCreated = true;
    await apply(join(ROOT, "supabase", "tests", "produce_close_validation_race_bootstrap.sql"));
    await apply(join(
      ROOT, "supabase", "migrations",
      "20260831120000_produce_close_validation_race.sql",
    ));
    await apply(join(
      ROOT, "supabase", "migrations",
      "20260901090000_produce_finalizer_review_presentation.sql",
    ));
    await apply(HELD_CLOSE_SAFETY);
    await apply(CONFIRMATION_TIMESTAMP_GUARD);
  }, 120_000);

  afterAll(async () => {
    if (!databaseCreated) return;
    await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE}`], "postgres");
  }, 60_000);

  beforeEach(async () => {
    await scalar("DELETE FROM public.produce_entry_validation_reviews RETURNING 1");
    await scalar("DELETE FROM public.pending_session_ingest RETURNING 1");
    await scalar("DELETE FROM public.pending_session_admission RETURNING 1");
    await scalar("DELETE FROM public.pending_sessions RETURNING 1");
    await scalar("DELETE FROM public.accountability_rounds RETURNING 1");
  });

  test("the migrations are idempotent", async () => {
    // Re-applied IN ORDER. 20260901090000 replaces record_/confirm_ that
    // 20260831120000 also defines, so replaying only the older one would leave
    // the database on the older definitions and silently disarm the delivery
    // guard for every later test.
    await apply(join(
      ROOT, "supabase", "migrations",
      "20260831120000_produce_close_validation_race.sql",
    ));
    await apply(join(
      ROOT, "supabase", "migrations",
      "20260901090000_produce_finalizer_review_presentation.sql",
    ));
    await apply(HELD_CLOSE_SAFETY);
    await apply(HELD_CLOSE_SAFETY);
    await apply(CONFIRMATION_TIMESTAMP_GUARD);
    await apply(CONFIRMATION_TIMESTAMP_GUARD);

    // The delivery guard must be the live definition after any replay.
    expect(await scalar(`
      SELECT (p.prosrc LIKE '%not_presented%')::text
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'confirm_produce_validation_review'`))
      .toBe("true");
    expect(await scalar(`
      SELECT (to_regprocedure('public.confirm_produce_validation_review(text,uuid,text,text,text)') IS NULL)::text`))
      .toBe("true");
    for (const [role, allowed] of [["anon", "f"], ["authenticated", "f"], ["service_role", "t"]]) {
      expect(await scalar(`SELECT has_function_privilege(${q(role)},
        'public.confirm_produce_validation_review(text,uuid,text,text,text,bigint)', 'EXECUTE')`)).toBe(allowed);
    }
    expect(await scalar(`
      SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'append_pending_session'`)).toBe("2");
  });

  // ── A. Atomic first-close revision pin ────────────────────────────────────

  test("THE 30 AUG RACE — a pre-close item committing after the gate refuses the close", async () => {
    const s = await seedSession();
    await admitItem(s, "evt-item-1", CLOSE_TS - 20_000);
    await admitItem(s, "evt-item-2", CLOSE_TS - 15_000);

    // The entry gate validates THIS revision.
    const gateRevision = await revisionOf(s.key);

    // A legitimate item whose LINE timestamp is BEFORE the close commits after
    // the gate read the document — exactly the 06:13:36.980Z admissions.
    expect(await admitItem(s, "evt-late-item", LATE_ITEM_TS)).toBe("appended");
    expect(await revisionOf(s.key)).toBe(gateRevision + 1);

    const close = await closeWithPin(s, "evt-close", gateRevision);
    expect(close.reason).toBe("stale_validation_snapshot");
    expect(close.accepted).toBe("false");
    expect(close.currentRevision).toBe(String(gateRevision + 1));

    // No stale boundary was stamped, nothing was terminalized, and no
    // finalization was scheduled from the stale validation.
    expect(await field(s.key, "close_event_timestamp_ms")).toBe("<null>");
    expect(await field(s.key, "close_requested_at")).toBe("<null>");
    expect(await field(s.key, "next_attempt_at")).toBe("<null>");
    expect(await field(s.key, "terminalized")).toBe("false");
    expect(await field(s.key, "finalization_status")).toBe("pending");
  });

  test("retrying the close against the grown document succeeds — nothing is lost", async () => {
    const s = await seedSession();
    await admitItem(s, "evt-item-1", CLOSE_TS - 20_000);
    const gateRevision = await revisionOf(s.key);
    await admitItem(s, "evt-late-item", LATE_ITEM_TS);

    expect((await closeWithPin(s, "evt-close", gateRevision)).reason)
      .toBe("stale_validation_snapshot");

    // The operator closes again; the gate now validates the complete list.
    const retryRevision = await revisionOf(s.key);
    expect((await closeWithPin(s, "evt-close-2", retryRevision)).reason).toBe("appended");
    expect(await field(s.key, "close_event_timestamp_ms")).toBe(String(CLOSE_TS));

    // Both items and the late one survived.
    expect(await scalar(
      `SELECT count(*)::text FROM public.pending_session_admission
       WHERE session_generation = ${q(s.generation)}::uuid`)).toBe("3");
  });

  test("revision unchanged — a normal close still works exactly as before", async () => {
    const s = await seedSession();
    await admitItem(s, "evt-item-1", CLOSE_TS - 20_000);
    const gateRevision = await revisionOf(s.key);

    expect((await closeWithPin(s, "evt-close", gateRevision)).reason).toBe("appended");
    expect(await field(s.key, "close_event_timestamp_ms")).toBe(String(CLOSE_TS));
    expect(await field(s.key, "close_session_generation")).toBe(s.generation);
    expect(await field(s.key, "next_attempt_at")).not.toBe("<null>");
  });

  test("a NULL pin behaves exactly like the unpinned 8-arg close", async () => {
    const s = await seedSession();
    await admitItem(s, "evt-item-1", CLOSE_TS - 20_000);
    await admitItem(s, "evt-late", LATE_ITEM_TS);
    expect((await closeWithPin(s, "evt-close", null)).reason).toBe("appended");
    expect(await field(s.key, "close_event_timestamp_ms")).toBe(String(CLOSE_TS));
  });

  test("the pin is FIRST-CLOSE only — a second close still reports status", async () => {
    const s = await seedSession();
    await admitItem(s, "evt-item-1", CLOSE_TS - 20_000);
    const gateRevision = await revisionOf(s.key);
    expect((await closeWithPin(s, "evt-close", gateRevision)).reason).toBe("appended");

    // Late pre-close admission moves the revision AFTER the boundary exists.
    expect(await admitItem(s, "evt-late-item", LATE_ITEM_TS)).toBe("appended");

    // A genuine second close must still work despite the moved revision.
    const second = await closeWithPin(s, "evt-close-2", gateRevision);
    expect(second.reason).toBe("close_already_requested");
    expect(second.accepted).toBe("true");
  });

  // ── A2. Generation identity outranks revision freshness ───────────────────

  test("generation changed AND revision changed -> generation_conflict, never stale", async () => {
    const s = await seedSession();
    await admitItem(s, "evt-item-1", CLOSE_TS - 20_000);
    const gateRevision = await revisionOf(s.key);

    // The session rotates to a replacement generation and grows content.
    const replacement = nextUuid();
    await scalar(`
      UPDATE public.pending_sessions
      SET session_generation = ${q(replacement)}::uuid,
          ingest_revision = ingest_revision + 1
      WHERE session_key = ${q(s.key)} RETURNING 1`);

    // A stale close from the ORIGINAL generation must be told the generation
    // moved. stale_validation_snapshot would invite a retry that lands on the
    // replacement generation.
    const close = await closeWithPin(s, "evt-stale-close", gateRevision);
    expect(close.reason).toBe("generation_conflict");
    expect(close.reason).not.toBe("stale_validation_snapshot");
    expect(close.accepted).toBe("false");

    // The replacement generation got no close boundary out of it.
    expect(await field(s.key, "close_event_timestamp_ms")).toBe("<null>");
    expect(await field(s.key, "close_requested_at")).toBe("<null>");
    expect(await field(s.key, "session_generation")).toBe(replacement);
  });

  test("terminalized generation AND revision changed -> terminalized, never stale", async () => {
    const s = await seedSession();
    await admitItem(s, "evt-item-1", CLOSE_TS - 20_000);
    const gateRevision = await revisionOf(s.key);
    await scalar(`
      UPDATE public.pending_sessions
      SET terminalized = true,
          finalization_status = 'failed_closed',
          ingest_revision = ingest_revision + 1
      WHERE session_key = ${q(s.key)} RETURNING 1`);

    const close = await closeWithPin(s, "evt-stale-close", gateRevision);
    expect(close.reason).toBe("terminalized");
    expect(close.reason).not.toBe("stale_validation_snapshot");
    expect(await field(s.key, "close_event_timestamp_ms")).toBe("<null>");
  });

  test("generation changed but revision identical -> still generation_conflict", async () => {
    const s = await seedSession();
    const gateRevision = await revisionOf(s.key);
    const replacement = nextUuid();
    await scalar(`
      UPDATE public.pending_sessions SET session_generation = ${q(replacement)}::uuid
      WHERE session_key = ${q(s.key)} RETURNING 1`);

    expect((await closeWithPin(s, "evt-stale-close", gateRevision)).reason)
      .toBe("generation_conflict");
  });

  // ── B. Out-of-order admission is unchanged ────────────────────────────────

  test("post-close LINE timestamps are still rejected", async () => {
    const s = await seedSession();
    const gateRevision = await revisionOf(s.key);
    await closeWithPin(s, "evt-close", gateRevision);

    expect(await admitItem(s, "evt-after", POST_CLOSE_TS)).toBe("after_close_boundary");
    expect(await scalar(
      `SELECT count(*)::text FROM public.pending_session_admission
       WHERE line_event_id = 'evt-after'`)).toBe("0");
  });

  test("a duplicate delivery of an admitted event stays a no-op", async () => {
    const s = await seedSession();
    await admitItem(s, "evt-item-1", CLOSE_TS - 20_000);
    const revision = await revisionOf(s.key);
    expect(await admitItem(s, "evt-item-1", CLOSE_TS - 20_000)).toBe("duplicate_event");
    expect(await revisionOf(s.key)).toBe(revision);
  });

  // ── C. Recoverable post-boundary validation hold ──────────────────────────

  test("a held generation parks finalization without terminalizing", async () => {
    const s = await seedSession();
    await admitItem(s, "evt-item-1", CLOSE_TS - 20_000);
    const gateRevision = await revisionOf(s.key);
    await closeWithPin(s, "evt-close", gateRevision);
    await admitItem(s, "evt-late-item", LATE_ITEM_TS);

    const heldRevision = await revisionOf(s.key);
    expect(await hold(s, heldRevision)).toBe("held");

    expect(await field(s.key, "next_attempt_at")).toBe("<null>");
    expect(await field(s.key, "terminalized")).toBe("false");
    expect(await field(s.key, "finalization_status")).toBe("pending");
    // Evidence and the close boundary are untouched.
    expect(await field(s.key, "close_event_timestamp_ms")).toBe(String(CLOSE_TS));
    expect(await field(s.key, "ingest_revision")).toBe(String(heldRevision));
  });

  test("a hold whose revision moved again is refused rather than parking stale state", async () => {
    const s = await seedSession();
    const gateRevision = await revisionOf(s.key);
    await closeWithPin(s, "evt-close", gateRevision);
    const stale = await revisionOf(s.key);
    await admitItem(s, "evt-late-item", LATE_ITEM_TS);

    expect(await hold(s, stale)).toBe("stale_validation_snapshot");
    expect(await field(s.key, "next_attempt_at")).not.toBe("<null>");
  });

  test("hold refuses an open (never closed) session", async () => {
    const s = await seedSession();
    expect(await hold(s, await revisionOf(s.key))).toBe("not_closing");
  });

  test("a distinct later confirmation resumes a held generation", async () => {
    const s = await seedSession();
    await admitItem(s, "evt-item-1", CLOSE_TS - 20_000);
    await closeWithPin(s, "evt-close", await revisionOf(s.key));
    await admitItem(s, "evt-late-item", LATE_ITEM_TS);
    await hold(s, await revisionOf(s.key));

    expect(await recordReview(s, "digest-1", "evt-present")).toBe("recorded");
    // Recording proves nothing; the presentation has to land first.
    expect(await markPresented(s, "digest-1", "evt-present")).toBe("presented");
    expect(await confirmReview(s, "digest-1", "evt-confirm")).toBe("confirmed");
    expect(await resume(s)).toBe("resumed");

    expect(await field(s.key, "next_attempt_at")).not.toBe("<null>");
    expect(await field(s.key, "terminalized")).toBe("false");
  });

  test("a duplicate delivery of the PRESENTING event does not self-confirm", async () => {
    const s = await seedSession();
    await closeWithPin(s, "evt-close", await revisionOf(s.key));
    await recordReview(s, "digest-1", "evt-present");
    expect(await markPresented(s, "digest-1", "evt-present")).toBe("presented");

    // The very event that presented the set must never confirm it.
    expect(await confirmReview(s, "digest-1", "evt-present")).toBe("not_found");
    expect(await scalar(
      `SELECT coalesce(confirmed_at::text, '<null>')
       FROM public.produce_entry_validation_reviews WHERE validation_digest = 'digest-1'`))
      .toBe("<null>");

    // A genuinely distinct later event still confirms.
    expect(await confirmReview(s, "digest-1", "evt-confirm")).toBe("confirmed");
  });

  // ── D. Terminalized generations ───────────────────────────────────────────

  test("a terminalized generation grows no new review and confirms none", async () => {
    const s = await seedSession();
    await closeWithPin(s, "evt-close", await revisionOf(s.key));
    await recordReview(s, "digest-1", "evt-present");
    await scalar(`
      UPDATE public.pending_sessions
      SET terminalized = true, finalization_status = 'failed_closed'
      WHERE session_key = ${q(s.key)} RETURNING 1`);

    expect(await recordReview(s, "digest-2", "evt-stale-close")).toBe("terminalized");
    expect(await scalar(
      `SELECT count(*)::text FROM public.produce_entry_validation_reviews
       WHERE validation_digest = 'digest-2'`)).toBe("0");

    // And an old generation cannot authorize anything after the fact.
    expect(await confirmReview(s, "digest-1", "evt-late-confirm")).toBe("terminalized");
  });

  test("hold and resume both refuse a terminalized generation", async () => {
    const s = await seedSession();
    await closeWithPin(s, "evt-close", await revisionOf(s.key));
    await scalar(`
      UPDATE public.pending_sessions SET terminalized = true
      WHERE session_key = ${q(s.key)} RETURNING 1`);

    expect(await hold(s, await revisionOf(s.key))).toBe("terminalized");
    expect(await resume(s)).toBe("terminalized");
  });

  test("hold and resume refuse a generation conflict", async () => {
    const s = await seedSession();
    await closeWithPin(s, "evt-close", await revisionOf(s.key));
    const impostor: Session = { ...s, generation: nextUuid() };
    expect(await hold(impostor, null)).toBe("generation_conflict");
    expect(await resume(impostor)).toBe("generation_conflict");
  });

  // ── D2. The terminalized guard is atomic, not a TOCTOU ────────────────────

  test("lock order is pending_sessions before produce_entry_validation_reviews", async () => {
    // A consistent order across both review RPCs is what makes the pair
    // deadlock-free against every writer that terminalizes.
    for (const fn of ["record_produce_validation_review", "confirm_produce_validation_review"]) {
      // Flattened: scalar() reads a single line and prosrc is multi-line.
      const src = await scalar(`
        SELECT translate(p.prosrc, E'\\n\\r\\t', '   ')
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = ${q(fn)}`);
      // Compare STATEMENTS, not any mention: the DECLARE block names the
      // review table as a row type long before either table is touched.
      const pendingLock = src.indexOf("FROM public.pending_sessions");
      const reviewStatements = [
        src.indexOf("INSERT INTO public.produce_entry_validation_reviews"),
        src.indexOf("FROM public.produce_entry_validation_reviews"),
        src.indexOf("UPDATE public.produce_entry_validation_reviews"),
      ].filter((index) => index > -1);

      expect(pendingLock).toBeGreaterThan(-1);
      expect(reviewStatements.length).toBeGreaterThan(0);
      expect(pendingLock).toBeLessThan(Math.min(...reviewStatements));
    }
    expect(await scalar(`
      SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('record_produce_validation_review', 'confirm_produce_validation_review')
        AND p.prosrc LIKE '%FOR UPDATE%'`)).toBe("2");
  });

  test("a review cannot be recorded across a concurrent terminalization", async () => {
    const s = await seedSession();
    await closeWithPin(s, "evt-close", await revisionOf(s.key));

    // Holder takes the pending_sessions row lock, terminalizes, and only then
    // commits. Any recorder that read terminalized WITHOUT the lock would slip
    // its INSERT in during the sleep.
    const holder = spawnPsql(["-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"], DATABASE, `
      BEGIN;
      SELECT terminalized FROM public.pending_sessions
      WHERE session_key = ${q(s.key)} FOR UPDATE;
      SELECT pg_sleep(2);
      UPDATE public.pending_sessions
      SET terminalized = true, finalization_status = 'failed_closed'
      WHERE session_key = ${q(s.key)};
      COMMIT;
    `);

    // Let the holder acquire the lock before the recorder attempts anything.
    await Bun.sleep(600);
    const status = await recordReview(s, "digest-race", "evt-present");
    const holderResult = await collect(holder);
    expect(holderResult.code, holderResult.stderr).toBe(0);

    // The recorder blocked on the lock, then observed the committed terminal
    // state — it did not slip a review in beforehand.
    expect(status).toBe("terminalized");
    expect(await scalar(
      `SELECT count(*)::text FROM public.produce_entry_validation_reviews
       WHERE validation_digest = 'digest-race'`)).toBe("0");
    expect(await field(s.key, "terminalized")).toBe("true");
  }, 30_000);

  test("a review cannot be confirmed across a concurrent terminalization", async () => {
    const s = await seedSession();
    await closeWithPin(s, "evt-close", await revisionOf(s.key));
    expect(await recordReview(s, "digest-race-2", "evt-present")).toBe("recorded");

    const holder = spawnPsql(["-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"], DATABASE, `
      BEGIN;
      SELECT terminalized FROM public.pending_sessions
      WHERE session_key = ${q(s.key)} FOR UPDATE;
      SELECT pg_sleep(2);
      UPDATE public.pending_sessions SET terminalized = true
      WHERE session_key = ${q(s.key)};
      COMMIT;
    `);

    await Bun.sleep(600);
    const status = await confirmReview(s, "digest-race-2", "evt-confirm");
    const holderResult = await collect(holder);
    expect(holderResult.code, holderResult.stderr).toBe(0);

    expect(status).toBe("terminalized");
    expect(await scalar(
      `SELECT coalesce(confirmed_at::text, '<null>')
       FROM public.produce_entry_validation_reviews
       WHERE validation_digest = 'digest-race-2'`)).toBe("<null>");
  }, 30_000);

  // ── D3. Finalizer presentation protocol ───────────────────────────────────
  //
  // A LINE push is not transactional with PostgreSQL, so "recorded" and
  // "delivered" are separate durable facts. Only delivery makes a review
  // confirmable.

  // The finalizer uses the SAME recorder as the webhook and passes its stable
  // synthetic token as the presenting event id. Recording never claims delivery.
  async function recordFinalizerReview(s: Session, digest: string, token: string): Promise<string> {
    return await recordReview(s, digest, token);
  }

  async function markPresented(s: Session, digest: string, eventId: string): Promise<string> {
    return await scalar(`
      SELECT public.mark_produce_validation_review_presented(
        ${q(s.key)}, ${q(s.generation)}::uuid, ${q(digest)}, ${q(eventId)})->>'status'`);
  }

  async function presentedEventId(digest: string): Promise<string> {
    return await scalar(`
      SELECT presented_line_event_id FROM public.produce_entry_validation_reviews
      WHERE validation_digest = ${q(digest)}`);
  }

  async function deliveredAt(digest: string): Promise<string> {
    return await scalar(`
      SELECT coalesce(presented_delivered_at::text, '<null>')
      FROM public.produce_entry_validation_reviews WHERE validation_digest = ${q(digest)}`);
  }

  test("SUCCESS PATH — push proven, ONE distinct later close confirms", async () => {
    const s = await seedSession();
    await closeWithPin(s, "evt-close", await revisionOf(s.key));
    const token = `finalizer:${s.generation}:digest-ok`;

    // 1-2. recorded durably, explicitly NOT delivered
    expect(await recordFinalizerReview(s, "digest-ok", token)).toBe("recorded");
    expect(await deliveredAt("digest-ok")).toBe("<null>");

    // 3-4. the push succeeded, so delivery is proven
    expect(await markPresented(s, "digest-ok", "evt-present")).toBe("presented");
    expect(await deliveredAt("digest-ok")).not.toBe("<null>");

    // ONE distinct later close confirms. No third close.
    expect(await confirmReview(s, "digest-ok", "evt-close-2")).toBe("confirmed");
    expect(await scalar(
      `SELECT coalesce(confirmed_line_event_id, '<null>')
       FROM public.produce_entry_validation_reviews WHERE validation_digest = 'digest-ok'`))
      .toBe("evt-close-2");
  });

  test("FAILED PUSH — an undelivered review cannot be confirmed by any close", async () => {
    const s = await seedSession();
    await closeWithPin(s, "evt-close", await revisionOf(s.key));
    const token = `finalizer:${s.generation}:digest-undelivered`;
    await recordFinalizerReview(s, "digest-undelivered", token);

    // The operator never saw it. No close may approve it.
    expect(await confirmReview(s, "digest-undelivered", "evt-close-2")).toBe("not_presented");
    expect(await confirmReview(s, "digest-undelivered", "evt-close-3")).toBe("not_presented");
    expect(await scalar(
      `SELECT coalesce(confirmed_at::text, '<null>')
       FROM public.produce_entry_validation_reviews
       WHERE validation_digest = 'digest-undelivered'`)).toBe("<null>");
  });

  test("RE-PRESENT — the webhook recording an undelivered review proves delivery", async () => {
    const s = await seedSession();
    await closeWithPin(s, "evt-close", await revisionOf(s.key));
    const token = `finalizer:${s.generation}:digest-repres`;
    await recordFinalizerReview(s, "digest-repres", token);
    expect(await deliveredAt("digest-repres")).toBe("<null>");

    // The next close re-presents it. Recording still proves nothing; the
    // delivery stamp comes only after that close's LINE reply succeeded, and
    // it must NOT confirm in the same breath.
    expect(await recordReview(s, "digest-repres", "evt-close-2")).toBe("recorded");
    expect(await deliveredAt("digest-repres")).toBe("<null>");
    expect(await markPresented(s, "digest-repres", "evt-close-2")).toBe("presented");
    expect(await deliveredAt("digest-repres")).not.toBe("<null>");
    // The presenting identity is now Close #2 — the event that actually
    // delivered — not Close #1, which recorded it and never showed it.
    expect(await presentedEventId("digest-repres")).toBe("evt-close-2");
    // ...so a duplicate delivery of Close #2 cannot self-confirm.
    expect(await confirmReview(s, "digest-repres", "evt-close-2")).toBe("not_found");
    expect(await scalar(
      `SELECT coalesce(confirmed_at::text, '<null>')
       FROM public.produce_entry_validation_reviews WHERE validation_digest = 'digest-repres'`))
      .toBe("<null>");

    // The close AFTER that confirms.
    expect(await confirmReview(s, "digest-repres", "evt-close-3")).toBe("confirmed");
  });

  test("the finalizer presentation token can never self-confirm", async () => {
    const s = await seedSession();
    await closeWithPin(s, "evt-close", await revisionOf(s.key));
    const token = `finalizer:${s.generation}:digest-token`;
    await recordFinalizerReview(s, "digest-token", token);
    await markPresented(s, "digest-token", `finalizer:${s.generation}:digest-token`);

    // Redelivery of the presenting identity is not a confirmation.
    expect(await confirmReview(s, "digest-token", token)).toBe("not_found");
    expect(await scalar(
      `SELECT coalesce(confirmed_at::text, '<null>')
       FROM public.produce_entry_validation_reviews WHERE validation_digest = 'digest-token'`))
      .toBe("<null>");
  });

  test("a changed document means a new digest, and the old review authorizes nothing", async () => {
    const s = await seedSession();
    await closeWithPin(s, "evt-close", await revisionOf(s.key));
    await recordFinalizerReview(s, "digest-old", `finalizer:${s.generation}:digest-old`);
    await markPresented(s, "digest-old", "evt-present-old");
    expect(await confirmReview(s, "digest-old", "evt-close-2")).toBe("confirmed");

    // The document moved; the gate now computes a different digest, which has
    // no confirmed row of its own.
    expect(await confirmReview(s, "digest-new", "evt-close-3")).toBe("not_found");
  });

  test("the finalizer record is idempotent across retries", async () => {
    const s = await seedSession();
    await closeWithPin(s, "evt-close", await revisionOf(s.key));
    const token = `finalizer:${s.generation}:digest-retry`;
    expect(await recordFinalizerReview(s, "digest-retry", token)).toBe("recorded");
    expect(await recordFinalizerReview(s, "digest-retry", token)).toBe("recorded");
    expect(await scalar(
      `SELECT count(*)::text FROM public.produce_entry_validation_reviews
       WHERE validation_digest = 'digest-retry'`)).toBe("1");
    // A retry must not silently prove delivery.
    expect(await deliveredAt("digest-retry")).toBe("<null>");
  });

  test("a terminalized generation refuses both finalizer record and delivery proof", async () => {
    const s = await seedSession();
    await closeWithPin(s, "evt-close", await revisionOf(s.key));
    await recordFinalizerReview(s, "digest-term", `finalizer:${s.generation}:digest-term`);
    await scalar(`
      UPDATE public.pending_sessions SET terminalized = true
      WHERE session_key = ${q(s.key)} RETURNING 1`);

    expect(await recordFinalizerReview(s, "digest-term-2", "tok")).toBe("terminalized");
    expect(await markPresented(s, "digest-term", "evt-x")).toBe("terminalized");
    expect(await confirmReview(s, "digest-term", "evt-close-2")).toBe("terminalized");
  });

  test("RECORDING NEVER CLAIMS DELIVERY — not even on the webhook path", async () => {
    const s = await seedSession();
    await closeWithPin(s, "evt-close", await revisionOf(s.key));

    // The webhook recorder writes the row and stops. The LINE reply is a
    // separate call that can fail, so the row is not confirmable yet.
    expect(await recordReview(s, "digest-webhook", "evt-close-1")).toBe("recorded");
    expect(await deliveredAt("digest-webhook")).toBe("<null>");
    expect(await confirmReview(s, "digest-webhook", "evt-close-2")).toBe("not_presented");
  });

  test("re-recording an undelivered review still does not deliver it", async () => {
    const s = await seedSession();
    await closeWithPin(s, "evt-close", await revisionOf(s.key));
    await recordReview(s, "digest-rerecord", "evt-close-1");
    // A second close records again (idempotent) — still no delivery proof.
    expect(await recordReview(s, "digest-rerecord", "evt-close-2")).toBe("recorded");
    expect(await deliveredAt("digest-rerecord")).toBe("<null>");
    // The presenting identity is untouched by re-recording.
    expect(await presentedEventId("digest-rerecord")).toBe("evt-close-1");
  });

  test("delivery rebinds the presenting event, and re-marking is idempotent", async () => {
    const s = await seedSession();
    await closeWithPin(s, "evt-close", await revisionOf(s.key));
    await recordReview(s, "digest-rebind", "evt-close-1");

    expect(await markPresented(s, "digest-rebind", "evt-close-2")).toBe("presented");
    expect(await presentedEventId("digest-rebind")).toBe("evt-close-2");

    // A second successful presentation does not move the identity again.
    expect(await markPresented(s, "digest-rebind", "evt-close-3")).toBe("already_presented");
    expect(await presentedEventId("digest-rebind")).toBe("evt-close-2");

    // Close #2 cannot confirm what it presented; Close #3 can.
    expect(await confirmReview(s, "digest-rebind", "evt-close-2")).toBe("not_found");
    expect(await confirmReview(s, "digest-rebind", "evt-close-3")).toBe("confirmed");
  });

  test("delivery refuses a blank presenting event rather than proving nothing", async () => {
    const s = await seedSession();
    await closeWithPin(s, "evt-close", await revisionOf(s.key));
    await recordReview(s, "digest-blank", "evt-close-1");
    expect(await markPresented(s, "digest-blank", "")).toBe("invalid_presentation_event");
    expect(await deliveredAt("digest-blank")).toBe("<null>");
  });

  test("no historical review was retroactively marked delivered", async () => {
    // The migration must NOT backfill presented_delivered_at: recording a row
    // was never evidence that a human saw it.
    expect(await scalar(`
      SELECT (position('SET presented_delivered_at = presented_at' in
        pg_get_functiondef(p.oid)) > 0)::text
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'record_produce_validation_review'`))
      .toBe("false");
  });

  // ── D4. One message, one all-or-nothing delivery mark ─────────────────────

  async function markMany(s: Session, digests: string[], eventId: string): Promise<string> {
    const list = digests.map((d) => q(d)).join(", ");
    return await scalar(`
      SELECT public.mark_produce_validation_reviews_presented(
        ${q(s.key)}, ${q(s.generation)}::uuid,
        ARRAY[${list}]::text[], ${q(eventId)})->>'status'`);
  }

  test("#109 — the whole review and each subunit item are delivered together", async () => {
    const s = await seedSession();
    await closeWithPin(s, "evt-close", await revisionOf(s.key));
    // One message presents the whole review plus two per-item subunit rows.
    await recordReview(s, "digest-whole", "evt-close-1");
    await recordReview(s, "digest-item-3", "evt-close-1");
    await recordReview(s, "digest-item-7", "evt-close-1");

    expect(await markMany(s, ["digest-whole", "digest-item-3", "digest-item-7"], "evt-close-1"))
      .toBe("presented");

    // Every one of them is now confirmable in its own right — this is what
    // makes "ยืนยันข้อ N" work on the very next message.
    for (const digest of ["digest-whole", "digest-item-3", "digest-item-7"]) {
      expect(await deliveredAt(digest)).not.toBe("<null>");
      expect(await presentedEventId(digest)).toBe("evt-close-1");
    }
    expect(await confirmReview(s, "digest-item-3", "evt-confirm-3")).toBe("confirmed");
    // Confirming one item does not confirm another.
    expect(await scalar(
      `SELECT coalesce(confirmed_at::text, '<null>')
       FROM public.produce_entry_validation_reviews WHERE validation_digest = 'digest-item-7'`))
      .toBe("<null>");
  });

  test("an unknown digest refuses the WHOLE mark — no half-delivered message", async () => {
    const s = await seedSession();
    await closeWithPin(s, "evt-close", await revisionOf(s.key));
    await recordReview(s, "digest-real", "evt-close-1");

    expect(await markMany(s, ["digest-real", "digest-never-recorded"], "evt-close-1"))
      .toBe("unknown_digest");
    // The one that DID exist must not have been marked.
    expect(await deliveredAt("digest-real")).toBe("<null>");
    expect(await confirmReview(s, "digest-real", "evt-close-2")).toBe("not_presented");
  });

  test("a digest belonging to another generation is not deliverable here", async () => {
    const a = await seedSession();
    const b = await seedSession();
    await closeWithPin(a, "evt-close-a", await revisionOf(a.key));
    await closeWithPin(b, "evt-close-b", await revisionOf(b.key));
    await recordReview(b, "digest-other-gen", "evt-close-b");

    // Session A cannot prove delivery of session B's review.
    expect(await markMany(a, ["digest-other-gen"], "evt-close-a")).toBe("unknown_digest");
    expect(await deliveredAt("digest-other-gen")).toBe("<null>");
  });

  test("the multi-digest mark refuses a terminalized generation and a blank event", async () => {
    const s = await seedSession();
    await closeWithPin(s, "evt-close", await revisionOf(s.key));
    await recordReview(s, "digest-multi-term", "evt-close-1");

    expect(await markMany(s, ["digest-multi-term"], "")).toBe("invalid_presentation_event");
    expect(await markMany(s, [], "evt-close-1")).toBe("no_digests");

    await scalar(`
      UPDATE public.pending_sessions SET terminalized = true
      WHERE session_key = ${q(s.key)} RETURNING 1`);
    expect(await markMany(s, ["digest-multi-term"], "evt-close-1")).toBe("terminalized");
    expect(await deliveredAt("digest-multi-term")).toBe("<null>");
  });

  test("re-marking an already-delivered set is idempotent and keeps the first presenter", async () => {
    const s = await seedSession();
    await closeWithPin(s, "evt-close", await revisionOf(s.key));
    await recordReview(s, "digest-idem", "evt-close-1");

    expect(await markMany(s, ["digest-idem"], "evt-close-1")).toBe("presented");
    expect(await markMany(s, ["digest-idem"], "evt-close-9")).toBe("presented");
    expect(await presentedEventId("digest-idem")).toBe("evt-close-1");
    // The original presenter still cannot confirm what it presented.
    expect(await confirmReview(s, "digest-idem", "evt-close-1")).toBe("not_found");
  });

  test("marking a digest that was never recorded is not_found", async () => {
    const s = await seedSession();
    await closeWithPin(s, "evt-close", await revisionOf(s.key));
    expect(await markPresented(s, "digest-absent", "evt-x")).toBe("not_found");
  });

  function confirmHeldSql(
    session: Session,
    revision: number,
    { eventId = "later-close", timestamp = Date.now() + 1000, owner = OWNER, environment = "production",
      digest = "held-review", required = "ARRAY['held-review']::text[]" } = {},
  ): string {
    return `SELECT public.confirm_pending_validation_close(
      ${q(session.key)}, ${q(session.generation)}::uuid, ${revision}, ${q(owner)},
      ${q(eventId)}, ${timestamp}, ${q(environment)}, ${q(digest)}, ${required}
    )->>'status'`;
  }

  test("a queued close or subunit command predating delivered review cannot approve it", async () => {
    const s = await seedSession();
    await closeWithPin(s, "first-close", await revisionOf(s.key));
    const revision = await revisionOf(s.key);
    await hold(s, revision);
    for (const digest of ["held-review", "item-review"]) {
      await recordFinalizerReview(s, digest, "finalizer-presentation");
    }
    const earlyTimestamp = CLOSE_TS + 1;
    await markMany(s, ["held-review", "item-review"], "finalizer-presentation");

    expect(await scalar(confirmHeldSql(s, revision, {
      eventId: "queued-close", timestamp: earlyTimestamp,
    }))).toBe("review_required");
    expect(await scalar(confirmHeldSql(s, revision, {
      eventId: "queued-item", timestamp: earlyTimestamp, digest: "item-review", required: "NULL::text[]",
    }))).toBe("not_presented");
    const presentationMs = Number(await scalar(`
      UPDATE public.produce_entry_validation_reviews
      SET presented_delivered_at = date_trunc('milliseconds', presented_delivered_at)
      WHERE validation_digest = 'item-review'
      RETURNING (extract(epoch FROM presented_delivered_at) * 1000)::bigint`));
    expect(await confirmReview(s, "item-review", "queued-before-close", earlyTimestamp)).toBe("not_presented");
    expect(await confirmReview(s, "item-review", "same-millisecond", presentationMs)).toBe("not_presented");
    expect(await confirmReview(s, "item-review", "no-timestamp", null)).toBe("not_presented");
    expect(await scalar("SELECT count(*) FROM public.produce_entry_validation_reviews WHERE confirmed_at IS NOT NULL"))
      .toBe("0");
    expect(await field(s.key, "next_attempt_at")).toBe("<null>");
    expect(await confirmReview(s, "item-review", "fresh-item", presentationMs + 1)).toBe("confirmed");
  });

  test("a distinct owner close approves the delivered review and schedules the held generation", async () => {
    const s = await seedSession();
    await closeWithPin(s, "first-close", await revisionOf(s.key));
    const revision = await revisionOf(s.key);
    const originalSchedule = await field(s.key, "next_attempt_at");
    await hold(s, revision);
    await recordFinalizerReview(s, "held-review", "finalizer-presentation");
    const finalize = (schedule: string) => scalar(`SELECT public.try_finalize_pending_generation(
      ${q(s.key)}, ${q(s.generation)}::uuid, ${q(OWNER)}, ${revision},
      'hash', 'document', '{}'::jsonb, '[]'::jsonb, ARRAY[]::text[], ${q(schedule)}::timestamptz
    )->>'status'`);

    expect(await scalar(confirmHeldSql(s, revision))).toBe("review_required");
    expect(await finalize(originalSchedule)).toBe("stale_snapshot");
    await markPresented(s, "held-review", "finalizer-presentation");
    for (const invalid of [
      { eventId: "first-close" },
      { timestamp: CLOSE_TS },
      { eventId: "finalizer-presentation" },
      { owner: "other-line-user" },
      { environment: "preview" },
    ]) {
      const status = invalid.eventId === "finalizer-presentation" ? "review_required" : "stale";
      expect(await scalar(confirmHeldSql(s, revision, invalid))).toBe(status);
    }
    expect(await scalar(confirmHeldSql(s, revision - 1))).toBe("stale");
    expect(await field(s.key, "next_attempt_at")).toBe("<null>");
    expect(await scalar("SELECT (confirmed_at IS NULL)::text FROM public.produce_entry_validation_reviews")).toBe("true");

    expect(await scalar(confirmHeldSql(s, revision))).toBe("proceed");
    const nextAttempt = await field(s.key, "next_attempt_at");
    expect(nextAttempt).not.toBe("<null>");
    expect(await finalize(originalSchedule)).toBe("stale_snapshot");
    expect(await finalize(nextAttempt)).toBe("delegated");
    expect(await scalar("SELECT confirmed_line_event_id FROM public.produce_entry_validation_reviews")).toBe("later-close");
    expect(await field(s.key, "close_line_event_id")).toBe("first-close");
    expect(await revisionOf(s.key)).toBe(revision);

    expect(await scalar(`SELECT public.hold_pending_validation_review(
      ${q(s.key)}, ${q(s.generation)}::uuid, ${revision}, ${q(originalSchedule)}::timestamptz
    )->>'reason'`)).toBe("stale_schedule");
    expect(await scalar(confirmHeldSql(s, revision))).toBe("proceed");
    expect(await field(s.key, "next_attempt_at")).toBe(nextAttempt);
  });

  test("an individual subunit approval leaves the hold until the close verifies the full set", async () => {
    const s = await seedSession();
    await closeWithPin(s, "first-close", await revisionOf(s.key));
    const revision = await revisionOf(s.key);
    await hold(s, revision);
    for (const digest of ["held-review", "item-review"]) {
      await recordFinalizerReview(s, digest, "finalizer-presentation");
      await markPresented(s, digest, "finalizer-presentation");
    }
    const required = "ARRAY['held-review', 'item-review']::text[]";
    expect(await scalar(confirmHeldSql(s, revision, { required }))).toBe("review_required");
    expect(await scalar(confirmHeldSql(s, revision, {
      digest: "item-review", eventId: "item-confirm", required: "NULL::text[]",
    }))).toBe("confirmed");
    expect(await field(s.key, "next_attempt_at")).toBe("<null>");

    expect(await scalar(confirmHeldSql(s, revision, {
      required, eventId: "queued-close", timestamp: CLOSE_TS + 1,
    }))).toBe("review_required");
    expect(await field(s.key, "next_attempt_at")).toBe("<null>");

    expect(await scalar(confirmHeldSql(s, revision, { required, eventId: "last-close" }))).toBe("proceed");
    expect(await field(s.key, "next_attempt_at")).not.toBe("<null>");
  });

  test("a failed schedule write rolls the review approval back", async () => {
    const s = await seedSession();
    await closeWithPin(s, "first-close", await revisionOf(s.key));
    const revision = await revisionOf(s.key);
    await hold(s, revision);
    await recordFinalizerReview(s, "held-review", "finalizer-presentation");
    await markPresented(s, "held-review", "finalizer-presentation");
    await scalar(`CREATE FUNCTION public.reject_test_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test schedule write failed'; END;
      $$;
      CREATE TRIGGER reject_test_schedule BEFORE UPDATE OF next_attempt_at ON public.pending_sessions
      FOR EACH ROW EXECUTE FUNCTION public.reject_test_schedule();
      SELECT 1`);
    try {
      const failure = await run(confirmHeldSql(s, revision));
      expect(failure.code).not.toBe(0);
      expect(failure.stderr).toContain("test schedule write failed");
      expect(await scalar("SELECT (confirmed_at IS NULL)::text FROM public.produce_entry_validation_reviews")).toBe("true");
      expect(await field(s.key, "next_attempt_at")).toBe("<null>");
    } finally {
      await scalar("DROP TRIGGER reject_test_schedule ON public.pending_sessions; DROP FUNCTION public.reject_test_schedule(); SELECT 1");
    }
  });

  // ── E. #108 inactivity interaction ────────────────────────────────────────

  test("a held session is invisible to both #108 inactivity sweeps", async () => {
    const s = await seedSession();
    await admitItem(s, "evt-item-1", CLOSE_TS - 20_000);
    await closeWithPin(s, "evt-close", await revisionOf(s.key));
    await hold(s, await revisionOf(s.key));
    await scalar(`
      UPDATE public.pending_sessions SET updated_at = now() - interval '90 minutes'
      WHERE session_key = ${q(s.key)} RETURNING 1`);

    // Both sweeps require close_event_timestamp_ms IS NULL. A held session has
    // a boundary, so neither can claim it — no auto-finalization, no expiry.
    expect(await scalar(`
      SELECT count(*)::text FROM public.pending_sessions p
      WHERE p.session_key = ${q(s.key)}
        AND p.terminalized = false
        AND p.close_event_timestamp_ms IS NULL
        AND p.close_requested_at IS NULL
        AND p.next_attempt_at IS NULL`)).toBe("0");

    expect(await field(s.key, "terminalized")).toBe("false");
    expect(await field(s.key, "finalization_status")).toBe("pending");
  });
});
