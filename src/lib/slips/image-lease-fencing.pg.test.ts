/**
 * P1 #6 — ownership of the image-ingestion lease, proven on real PostgreSQL 17.
 *
 * begin_slip_image_attempt bumps `attempts` on every claim; that counter is the
 * fencing token that attach_slip_image_event / fail_slip_image_event must
 * present. A stale worker (A) whose lease expired and was re-claimed (B) must
 * not clear B's lease, change B's state or open the way for a third claim, and
 * workers that crash mid-attempt must still consume the attempt budget.
 *
 *   ALLOW_DISPOSABLE_POSTGRES_TESTS=1 PGPASSWORD=postgres bun test src/lib/slips/image-lease-fencing.pg.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createSlipTestDb, probePg, type SlipTestDb } from "@/lib/slips/testing/pg-slip-harness";

const pgAvailable = await probePg();
if (!pgAvailable && process.env.SLIP_INGEST_REQUIRE === "1") {
  throw new Error("SLIP_INGEST_REQUIRE=1 but PostgreSQL 17 harness unavailable");
}

let db: SlipTestDb;
let seq = 0;
const T0 = 1_760_000_000_000;
const M = "m-lease-1";

interface Begin { claimed: boolean; reason?: string; state?: string; attempt?: number }
interface Out { outcome: string; state?: string }

const j = async <T>(sql: string) => JSON.parse(await db.scalar(sql)) as T;
const begin = (max = 5) => j<Begin>(`SELECT begin_slip_image_attempt('${M}', ${max}, 120)`);
const attach = (evidenceId: string, attempt: number) =>
  j<Out>(`SELECT attach_slip_image_event('${M}', '${evidenceId}', ${attempt})`);
const fail = (attempt: number, max = 5) =>
  j<Out>(`SELECT fail_slip_image_event('${M}', 'download_failed', ${attempt}, ${max}, false)`);
const expireLease = () => db.query(`UPDATE slip_image_events SET lease_until = now() - interval '1 second'`);
const makeRetryDue = () => db.query(`UPDATE slip_image_events SET next_retry_at = now() - interval '1 second'`);
const row = async () => (await db.query<{
  state: string; attempts: number; lease_until: string | null; next_retry_at: string | null;
  last_error: string | null; evidence_id: string | null;
}>(`SELECT state, attempts, lease_until, next_retry_at, last_error, evidence_id FROM slip_image_events`))[0];

async function seed(): Promise<{ batchId: string; evidenceId: string }> {
  seq += 1;
  const batchId = (await db.query<{ id: string }>(
    `INSERT INTO slip_batches (source_id, source_type, sender_id, status, open_event_ts_ms)
     VALUES ('G-lease', 'group', 'U1', 'collecting', ${T0}) RETURNING id`,
  ))[0].id;
  const raw = (await db.query<{ id: string }>(
    `INSERT INTO raw_messages (line_event_id, destination, event_type, source_type, source_id, user_id,
                               message_id, message_type, payload)
     VALUES ('evt-lease-${seq}', 'dest', 'message', 'group', 'G-lease', 'U1', '${M}', 'image', '{}'::jsonb)
     RETURNING id`,
  ))[0].id;
  await db.query(
    `INSERT INTO slip_image_events (line_message_id, raw_message_id, batch_id, source_id, source_type,
                                    line_user_id, event_ts_ms, state)
     VALUES ('${M}', '${raw}', '${batchId}', 'G-lease', 'group', 'U1', ${T0 + 1000}, 'received')`,
  );
  const evidenceId = (await db.query<{ id: string }>(
    `INSERT INTO slip_evidences (raw_message_id, line_message_id, source_id, source_type, line_user_id,
                                 storage_path, mime_type, sha256, status)
     VALUES ('${raw}', '${M}', 'G-lease', 'group', 'U1', 'slips/lease.jpg', 'image/jpeg',
             '${"b".repeat(64)}', 'RECEIVED') RETURNING id`,
  ))[0].id;
  return { batchId, evidenceId };
}

describe.skipIf(!pgAvailable)("P1 image lease ownership (fencing) on PostgreSQL 17", () => {
  beforeAll(async () => {
    db = await createSlipTestDb("lease_fence");
  }, 120_000);

  afterAll(async () => {
    if (db) await db.drop();
  }, 60_000);

  beforeEach(async () => {
    await db.query(
      `TRUNCATE slip_image_events, slip_checks, slip_evidences, slip_batches,
                line_webhook_event_queue, raw_messages CASCADE`,
    );
  });

  test("A begins, lease expires, B begins: stale A fail/attach cannot touch B; no third claim; B completes", async () => {
    const { evidenceId } = await seed();

    const a = await begin();
    expect(a).toMatchObject({ claimed: true, attempt: 1 });
    await expireLease();
    const b = await begin();
    expect(b).toMatchObject({ claimed: true, attempt: 2 });
    const snapshot = await row();
    expect(snapshot.state).toBe("ingesting");
    expect(snapshot.lease_until).not.toBeNull();

    // Stale A fails: rejected; B's lease, state, error and attempts are untouched.
    expect(await fail(a.attempt!)).toMatchObject({ outcome: "stale_claim" });
    expect(await row()).toEqual(snapshot);

    // Stale A attaches: rejected; nothing is attached.
    expect(await attach(evidenceId, a.attempt!)).toMatchObject({ outcome: "stale_claim" });
    expect(await row()).toEqual(snapshot);
    expect(Number(await db.scalar(`SELECT image_count FROM slip_batches`))).toBe(0);

    // B's lease is still valid, so a third worker C cannot claim attempt 3.
    expect(await begin()).toMatchObject({ claimed: false, reason: "leased" });
    expect(await row()).toEqual(snapshot);

    // B (current token) completes; late stale replays change nothing.
    expect(await attach(evidenceId, b.attempt!)).toMatchObject({ outcome: "attached" });
    expect(await attach(evidenceId, a.attempt!)).toMatchObject({ outcome: "already_attached" });
    expect(await fail(a.attempt!)).toMatchObject({ outcome: "already_resolved" });
    expect(await fail(b.attempt!)).toMatchObject({ outcome: "already_resolved" });
    const done = await row();
    expect(done.state).toBe("attached");
    expect(done.attempts).toBe(2);
    expect(done.lease_until).toBeNull();
    expect(Number(await db.scalar(`SELECT image_count FROM slip_batches`))).toBe(1);
  }, 60_000);

  test("stale A fail after B failed and C re-claimed cannot clear C's lease or advance attempts", async () => {
    await seed();
    const a = await begin();
    await expireLease();
    const b = await begin();
    expect(await fail(b.attempt!)).toMatchObject({ outcome: "retry_pending" });
    await makeRetryDue();
    const c = await begin();
    expect(c).toMatchObject({ claimed: true, attempt: 3 });
    const snapshot = await row();

    expect(await fail(a.attempt!)).toMatchObject({ outcome: "stale_claim" });
    expect(await fail(b.attempt!)).toMatchObject({ outcome: "stale_claim" }); // B's duplicate delivery
    expect(await row()).toEqual(snapshot);
    expect(await begin()).toMatchObject({ claimed: false, reason: "leased" });
    expect(await row()).toEqual(snapshot);
  }, 60_000);

  test("workers that crash mid-attempt still consume the budget: no endless claim loop", async () => {
    await seed();
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await begin(3)).toMatchObject({ claimed: true, attempt });
      await expireLease(); // the worker died; nothing ever calls fail/attach
    }
    expect(await begin(3)).toMatchObject({ claimed: false, reason: "budget_exhausted", state: "failed_permanent" });
    const r = await row();
    expect(r.state).toBe("failed_permanent");
    expect(r.attempts).toBe(3);
    expect(r.lease_until).toBeNull();
    expect(await begin(3)).toMatchObject({ claimed: false, reason: "resolved", state: "failed_permanent" });
    expect((await row()).attempts).toBe(3);
  }, 60_000);

  test("a failing worker with the live token follows bounded backoff and the budget", async () => {
    await seed();
    for (let attempt = 1; attempt <= 2; attempt++) {
      const b = await begin(2);
      expect(b).toMatchObject({ claimed: true, attempt });
      const out = await fail(b.attempt!, 2);
      expect(out.outcome).toBe(attempt < 2 ? "retry_pending" : "failed_permanent");
      if (attempt < 2) {
        expect(await begin(2)).toMatchObject({ claimed: false, reason: "not_due" });
        await makeRetryDue();
      }
    }
    expect((await row()).state).toBe("failed_permanent");
  }, 60_000);

  test("two workers racing begin on the same row: exactly one claim", async () => {
    await seed();
    const results = await Promise.all(Array.from({ length: 6 }, () => begin()));
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    expect((await row()).attempts).toBe(1);
  }, 60_000);
});
