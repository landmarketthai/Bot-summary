/**
 * P1 #4 — OCR claim + fencing, proven on real PostgreSQL 17 with the REAL
 * SlipCheckService. Only the OCR provider (fake extractor), LINE push and
 * Storage (harness adapter) are simulated.
 *
 *   ALLOW_DISPOSABLE_POSTGRES_TESTS=1 PGPASSWORD=postgres bun test src/lib/slips/ocr-claim.pg.test.ts
 *
 * Proof-of-failure switch: OCR_CLAIM_PROOF_LEGACY=1 hides the claim RPCs from
 * the client (as on a pre-migration schema) so the same scenarios run through
 * the old unfenced upsert path and the overwrite races reproduce.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SlipCheckService } from "@/lib/slips/check-service";
import type { SlipExtraction } from "@/lib/slips/extraction-schema";
import type { SlipExtractor } from "@/lib/slips/extractor";
import {
  createPgSupabase,
  createSlipTestDb,
  probePg,
  type FakeStorage,
  type SlipTestDb,
} from "@/lib/slips/testing/pg-slip-harness";

const pgAvailable = await probePg();
if (!pgAvailable && process.env.SLIP_INGEST_REQUIRE === "1") {
  throw new Error("SLIP_INGEST_REQUIRE=1 but PostgreSQL 17 harness unavailable");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

let db: SlipTestDb;
let storage: FakeStorage;
let supa: AnySupabase;
let pushes: string[];
let seq = 0;

function extraction(amount: number, ref = `REF${amount}`): SlipExtraction {
  return {
    slipType: "BANK_SLIP_NO_QR",
    grossAmount: null,
    discountAmount: null,
    paidAmount: null,
    transferAmount: amount,
    referenceId: ref,
    transactionTime: "2026-10-16T05:00:00.000Z",
    senderName: "sender",
    receiverName: "receiver",
    receiverAccountTail: "1234",
    paymentChannelText: null,
    headlineTotalAmount: null,
    confidence: 0.95,
  };
}

/** Extractor whose every call parks on a gate until released. */
function gatedExtractor(amountFor: (call: number) => number) {
  const calls: number[] = [];
  const releases: Array<() => void> = [];
  const extractor: SlipExtractor = {
    async extract() {
      const n = calls.length;
      calls.push(n);
      await new Promise<void>((resolve) => releases.push(resolve));
      return extraction(amountFor(n));
    },
  };
  return { extractor, calls, release: (i: number) => releases[i]!() };
}

function instantExtractor(amount: number) {
  const calls: number[] = [];
  const extractor: SlipExtractor = {
    async extract() {
      calls.push(calls.length);
      return extraction(amount);
    },
  };
  return { extractor, calls };
}

function service(extractor: SlipExtractor, client: AnySupabase = clientFor()): SlipCheckService {
  return new SlipCheckService(client, extractor, async (_to, text) => { pushes.push(text); });
}

function clientFor(): AnySupabase {
  if (process.env.OCR_CLAIM_PROOF_LEGACY !== "1") return supa;
  return { from: supa.from.bind(supa), storage: supa.storage }; // no rpc => legacy upsert path
}

async function seedEvidence(batchStatus: string | null): Promise<{ evidenceId: string; batchId: string | null }> {
  seq += 1;
  const n = `${process.pid}-${seq}`;
  const raw = await db.query<{ id: string }>(
    `INSERT INTO raw_messages (line_event_id, destination, event_type, source_type, source_id, user_id,
                               message_id, message_type, payload)
     VALUES ('evt-${n}', 'dest', 'message', 'group', 'G-ocr', 'U1', 'm-${n}', 'image', '{}'::jsonb)
     RETURNING id`,
  );
  let batchId: string | null = null;
  if (batchStatus) {
    batchId = (await db.query<{ id: string }>(
      `INSERT INTO slip_batches (source_id, source_type, sender_id, status)
       VALUES ('G-ocr', 'group', 'U1', '${batchStatus}') RETURNING id`,
    ))[0].id;
  }
  const path = `slips/${n}.jpg`;
  storage.uploaded.set(path, new Uint8Array([1, 2, 3]));
  const ev = await db.query<{ id: string }>(
    `INSERT INTO slip_evidences (raw_message_id, line_message_id, source_id, source_type, line_user_id,
                                 storage_path, mime_type, sha256, status, batch_id)
     VALUES ('${raw[0].id}', 'm-${n}', 'G-ocr', 'group', 'U1', '${path}', 'image/jpeg',
             '${"a".repeat(63)}${(seq % 10).toString()}', 'RECEIVED', ${batchId ? `'${batchId}'` : "NULL"})
     RETURNING id`,
  );
  return { evidenceId: ev[0].id, batchId };
}

interface CheckRow {
  id: string; status: string; transfer_amount: string | null; claim_token: number;
  lease_until: string | null; failure_reason: string | null;
}
const checks = (evidenceId: string) => db.query<CheckRow>(
  `SELECT id, status, transfer_amount, claim_token, lease_until, failure_reason
     FROM slip_checks WHERE evidence_id='${evidenceId}'`,
);
const expireLease = (evidenceId: string) => db.query(
  `UPDATE slip_checks SET lease_until = now() - interval '1 second' WHERE evidence_id='${evidenceId}'`,
);
const redriveList = async () =>
  (await db.query<{ list_slip_ocr_redrive: string }>(`SELECT list_slip_ocr_redrive(50)`))
    .map((r) => r.list_slip_ocr_redrive);
const tick = () => new Promise((r) => setTimeout(r, 150));

describe.skipIf(!pgAvailable)("P1 OCR claim + fencing on PostgreSQL 17", () => {
  beforeAll(async () => {
    db = await createSlipTestDb("ocr_claim");
  }, 120_000);

  afterAll(async () => {
    if (db) await db.drop();
  }, 60_000);

  beforeEach(async () => {
    await db.query(`TRUNCATE slip_checks, slip_evidences, slip_batches, raw_messages CASCADE`);
    storage = { failUpload: new Set(), uploaded: new Map() };
    supa = createPgSupabase(db, storage);
    pushes = [];
  });

  test("concurrent workers on one evidence: exactly one extraction persists", async () => {
    const { evidenceId } = await seedEvidence("collecting");
    const fake = instantExtractor(111);
    await Promise.all(Array.from({ length: 6 }, () => service(fake.extractor).processEvidence(evidenceId)));

    expect(fake.calls).toHaveLength(1);
    const rows = await checks(evidenceId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("EXTRACTED");
    expect(Number(rows[0].transfer_amount)).toBe(111);
    expect(rows[0].claim_token).toBe(1);
    expect(rows[0].lease_until).toBeNull();
  }, 60_000);

  test("a successful check is never overwritten by a later redrive, duplicate delivery or stale worker", async () => {
    const { evidenceId } = await seedEvidence("collecting");
    const first = instantExtractor(100);
    await service(first.extractor).processEvidence(evidenceId);
    const before = (await checks(evidenceId))[0];
    expect(before.status).toBe("EXTRACTED");

    const later = instantExtractor(999);
    await service(later.extractor).processEvidence(evidenceId);
    await service(later.extractor).processEvidence(evidenceId);
    expect(later.calls).toHaveLength(0); // never even extracted again
    expect(await redriveList()).not.toContain(evidenceId);

    const after = (await checks(evidenceId))[0];
    expect(after).toEqual(before);
    expect(Number(after.transfer_amount)).toBe(100);
  }, 60_000);

  test("terminal FAILED is never re-claimed or overwritten either", async () => {
    const { evidenceId } = await seedEvidence("collecting");
    const failing: SlipExtractor = { async extract() { throw new Error("boom"); } };
    await service(failing).processEvidence(evidenceId);
    expect((await checks(evidenceId))[0].status).toBe("FAILED");

    const later = instantExtractor(5);
    await service(later.extractor).processEvidence(evidenceId);
    expect(later.calls).toHaveLength(0);
    expect((await checks(evidenceId))[0].status).toBe("FAILED");
  }, 60_000);

  test("stale worker whose lease expired and was re-claimed cannot overwrite the new owner", async () => {
    const { evidenceId } = await seedEvidence(null);
    const a = gatedExtractor(() => 111);
    const b = gatedExtractor(() => 222);

    const workerA = service(a.extractor).processEvidence(evidenceId);
    await tick();
    expect(a.calls).toHaveLength(1);

    // A is alive but a live lease blocks B entirely.
    const blocked = instantExtractor(777);
    await service(blocked.extractor).processEvidence(evidenceId);
    expect(blocked.calls).toHaveLength(0);

    await expireLease(evidenceId);
    const workerB = service(b.extractor).processEvidence(evidenceId);
    await tick();
    expect(b.calls).toHaveLength(1);
    expect((await checks(evidenceId))[0].claim_token).toBe(2);

    b.release(0);
    await workerB;
    expect(Number((await checks(evidenceId))[0].transfer_amount)).toBe(222);

    a.release(0); // stale A finishes last
    await workerA;
    const row = (await checks(evidenceId))[0];
    expect(row.status).toBe("EXTRACTED");
    expect(Number(row.transfer_amount)).toBe(222);
    expect(row.claim_token).toBe(2);
    expect(pushes).toHaveLength(1); // only B notified (un-batched evidence)
  }, 60_000);

  test("stale worker whose lease expired (not yet re-claimed) cannot complete; redrive re-runs it", async () => {
    const { evidenceId } = await seedEvidence("collecting");
    const a = gatedExtractor(() => 111);
    const workerA = service(a.extractor).processEvidence(evidenceId);
    await tick();
    await expireLease(evidenceId);
    a.release(0);
    await workerA;

    const row = (await checks(evidenceId))[0];
    expect(row.status).toBe("PROCESSING"); // A's late result discarded
    expect(row.transfer_amount).toBeNull();
    expect(pushes).toHaveLength(0);

    const retry = instantExtractor(333);
    await service(retry.extractor).processEvidence(evidenceId);
    const done = (await checks(evidenceId))[0];
    expect(done.status).toBe("EXTRACTED");
    expect(Number(done.transfer_amount)).toBe(333);
    expect(done.claim_token).toBe(2);
  }, 60_000);

  test("stale worker failure cannot flip the new owner's successful check to FAILED", async () => {
    const { evidenceId } = await seedEvidence(null);
    let release!: () => void;
    const slowFail: SlipExtractor = {
      extract: () => new Promise((_, reject) => { release = () => reject(new Error("late boom")); }),
    };
    const workerA = service(slowFail).processEvidence(evidenceId);
    await tick();
    await expireLease(evidenceId);

    const b = instantExtractor(222);
    await service(b.extractor).processEvidence(evidenceId);
    expect((await checks(evidenceId))[0].status).toBe("EXTRACTED");

    release();
    await workerA;
    const row = (await checks(evidenceId))[0];
    expect(row.status).toBe("EXTRACTED");
    expect(row.failure_reason).toBeNull();
    expect(Number(row.transfer_amount)).toBe(222);
    expect(pushes).toHaveLength(1); // no FAILED notice from the stale worker
  }, 60_000);

  test.each(["processing", "completed", "review_needed", "failed"])(
    "batch '%s': a worker already running cannot complete and a new worker cannot claim",
    async (status) => {
      const { evidenceId, batchId } = await seedEvidence("collecting");
      const a = gatedExtractor(() => 111);
      const workerA = service(a.extractor).processEvidence(evidenceId);
      await tick();

      await db.query(`UPDATE slip_batches SET status='${status}' WHERE id='${batchId}'`);
      a.release(0);
      await workerA;
      let row = (await checks(evidenceId))[0];
      expect(row.status).toBe("PROCESSING");
      expect(row.transfer_amount).toBeNull();

      await expireLease(evidenceId);
      const b = instantExtractor(222);
      await service(b.extractor).processEvidence(evidenceId);
      expect(b.calls).toHaveLength(0);
      row = (await checks(evidenceId))[0];
      expect(row.status).toBe("PROCESSING");
      expect(row.transfer_amount).toBeNull();
      expect(row.claim_token).toBe(1);
      expect(pushes).toHaveLength(0);
      expect(await redriveList()).not.toContain(evidenceId);
    }, 60_000);

  test("finalized batch: an already-successful check stays byte-identical", async () => {
    const { evidenceId, batchId } = await seedEvidence("collecting");
    await service(instantExtractor(100).extractor).processEvidence(evidenceId);
    const snapshot = await db.query(`SELECT * FROM slip_checks WHERE evidence_id='${evidenceId}'`);

    await db.query(`UPDATE slip_batches SET status='completed' WHERE id='${batchId}'`);
    const later = instantExtractor(999);
    await service(later.extractor).processEvidence(evidenceId);
    await service({ async extract() { throw new Error("late"); } }).processEvidence(evidenceId);

    expect(later.calls).toHaveLength(0);
    expect(await db.query(`SELECT * FROM slip_checks WHERE evidence_id='${evidenceId}'`)).toEqual(snapshot);
  }, 60_000);

  test("batched evidence: no per-image push; closing batch still accepts the claim", async () => {
    const { evidenceId } = await seedEvidence("closing");
    const fake = instantExtractor(50);
    await service(fake.extractor).processEvidence(evidenceId);
    expect((await checks(evidenceId))[0].status).toBe("EXTRACTED");
    expect(pushes).toHaveLength(0);
  }, 60_000);

  test("un-batched single slip works as before (claim, extract, push once)", async () => {
    const { evidenceId } = await seedEvidence(null);
    const fake = instantExtractor(75);
    await service(fake.extractor).processEvidence(evidenceId);
    const row = (await checks(evidenceId))[0];
    expect(row.status).toBe("EXTRACTED");
    expect(Number(row.transfer_amount)).toBe(75);
    expect(pushes).toHaveLength(1);
  }, 60_000);

  test("redrive list honours the lease: live lease excluded, expired lease included", async () => {
    const { evidenceId, batchId } = await seedEvidence("collecting");
    const seller = `m-redrive-${process.pid}`;
    await db.query(
      `INSERT INTO slip_image_events (line_message_id, raw_message_id, batch_id, source_id, source_type,
                                      event_ts_ms, state, evidence_id, resolved_at)
       SELECT '${seller}', se.raw_message_id, '${batchId}', 'G-ocr', 'group', 1760000000000, 'attached',
              se.id, now() - interval '10 minutes'
         FROM slip_evidences se WHERE se.id='${evidenceId}'`,
    );
    const a = gatedExtractor(() => 1);
    const workerA = service(a.extractor).processEvidence(evidenceId);
    await tick();
    expect(await redriveList()).not.toContain(evidenceId);
    await expireLease(evidenceId);
    expect(await redriveList()).toContain(evidenceId);
    a.release(0);
    await workerA;
  }, 60_000);

  test("claim RPC errors other than 'function missing' do not fall back to the unfenced upsert", async () => {
    const { evidenceId } = await seedEvidence("collecting");
    const flaky = {
      from: supa.from.bind(supa),
      storage: supa.storage,
      rpc: async () => ({ data: null, error: { code: "57014", message: "statement timeout" } }),
    };
    const fake = instantExtractor(5);
    await service(fake.extractor, flaky).processEvidence(evidenceId);
    expect(fake.calls).toHaveLength(0);
    expect(await checks(evidenceId)).toHaveLength(0); // no PROCESSING row written either
  }, 60_000);

  test("missing OCR claim RPC on a ledger schema never uses the unfenced fallback", async () => {
    const { evidenceId } = await seedEvidence("collecting");
    const partial = {
      from: supa.from.bind(supa),
      storage: supa.storage,
      rpc: async (name: string, args: Record<string, unknown>) => name === "claim_slip_check"
        ? { data: null, error: { code: "PGRST202", message: "claim function missing" } }
        : supa.rpc(name, args),
    };
    const fake = instantExtractor(5);

    await service(fake.extractor, partial).processEvidence(evidenceId);

    expect(fake.calls).toHaveLength(0);
    expect(await checks(evidenceId)).toHaveLength(0);
  }, 60_000);

  test("claim RPC missing (42883) falls back to the legacy path", async () => {
    const { evidenceId } = await seedEvidence("collecting");
    const old = {
      from: supa.from.bind(supa),
      storage: supa.storage,
      rpc: async () => ({ data: null, error: { code: "42883", message: "function does not exist" } }),
    };
    const fake = instantExtractor(5);
    await service(fake.extractor, old).processEvidence(evidenceId);
    expect(fake.calls).toHaveLength(1);
    expect((await checks(evidenceId))[0].status).toBe("EXTRACTED");
  }, 60_000);

  test("privileges: claim/complete/fail are service_role only", async () => {
    for (const sig of [
      "claim_slip_check(uuid, integer)",
      "complete_slip_check(uuid, integer, text, jsonb)",
      "fail_slip_check(uuid, integer, text)",
      "list_slip_ocr_redrive(integer)",
    ]) {
      const rows = await db.query<{ anon: boolean; auth: boolean; pub: boolean; svc: boolean }>(
        `SELECT has_function_privilege('anon', 'public.${sig}', 'EXECUTE') AS anon,
                has_function_privilege('authenticated', 'public.${sig}', 'EXECUTE') AS auth,
                has_function_privilege('public', 'public.${sig}', 'EXECUTE') AS pub,
                has_function_privilege('service_role', 'public.${sig}', 'EXECUTE') AS svc`,
      );
      expect(rows[0]).toEqual({ anon: false, auth: false, pub: false, svc: true });
    }
  });

  test("migration is idempotent (re-applying changes nothing and does not error)", async () => {
    const before = await checks("00000000-0000-0000-0000-000000000000");
    expect(before).toHaveLength(0);
    const { evidenceId } = await seedEvidence("collecting");
    await service(instantExtractor(9).extractor).processEvidence(evidenceId);
    const { ROOT } = await import("@/lib/slips/testing/pg-slip-harness");
    const sqlText = await Bun.file(
      `${ROOT}/supabase/migrations/20261017110000_slip_ocr_claim_fencing.sql`,
    ).text();
    await db.sql.unsafe(sqlText);
    const row = (await checks(evidenceId))[0];
    expect(row.status).toBe("EXTRACTED");
    expect(row.claim_token).toBe(1);
  }, 60_000);
});
