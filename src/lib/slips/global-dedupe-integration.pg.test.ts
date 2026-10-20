/**
 * #182 x #183 integration: the global admission trigger
 * (guard_global_slip_transaction_reference, 20261019143000) running on the
 * REAL #182 schema under the fenced OCR RPCs (claim/complete/fail_slip_check).
 * global-slip-dedupe.pg.test.ts proves the trigger on a synthetic schema; this
 * file proves it composes with the claim token / lease fencing, and that the
 * fingerprinting evidence writer keeps #182's "new app on old schema" contract.
 *
 *   ALLOW_DISPOSABLE_POSTGRES_TESTS=1 SLIP_INGEST_REQUIRE=1 PGPASSWORD=postgres \
 *     bun test src/lib/slips/global-dedupe-integration.pg.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import sharp from "sharp";
import { bangkokBusinessDateFromTimestamp } from "@/lib/business-date";
import { SlipCheckService } from "@/lib/slips/check-service";
import { buildSlipEvidencePath, SlipEvidenceService } from "@/lib/slips/evidence-service";
import type { SlipExtraction } from "@/lib/slips/extraction-schema";
import {
  createPgSupabase,
  createSlipTestDb,
  probePg,
  SLIP_PIPELINE_MIGRATIONS,
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
let seq = 0;

function extraction(ref: string): SlipExtraction {
  return {
    slipType: "BANK_SLIP_NO_QR",
    grossAmount: null,
    discountAmount: null,
    paidAmount: null,
    transferAmount: 100,
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

const fields = (ref: string) => ({
  slip_type: "BANK_SLIP_NO_QR",
  transfer_amount: 100,
  reference_id: ref,
  transaction_time: "2026-10-16T05:00:00.000Z",
  confidence: 0.95,
});

async function seedEvidence(opts: { sourceId: string; sha?: string; batchStatus?: string }) {
  seq += 1;
  const n = `${process.pid}-${seq}`;
  const raw = await db.query<{ id: string }>(
    `INSERT INTO raw_messages (line_event_id, destination, event_type, source_type, source_id, user_id,
                               message_id, message_type, payload)
     VALUES ('evt-${n}', 'dest', 'message', 'group', '${opts.sourceId}', 'U1', 'm-${n}', 'image', '{}'::jsonb)
     RETURNING id`,
  );
  let batchId: string | null = null;
  if (opts.batchStatus) {
    batchId = (await db.query<{ id: string }>(
      `INSERT INTO slip_batches (source_id, source_type, sender_id, status)
       VALUES ('${opts.sourceId}', 'group', 'U1', '${opts.batchStatus}') RETURNING id`,
    ))[0].id;
  }
  const sha = opts.sha ?? seq.toString(16).padStart(64, "b");
  const ev = await db.query<{ id: string }>(
    `INSERT INTO slip_evidences (raw_message_id, line_message_id, source_id, source_type, line_user_id,
                                 storage_path, mime_type, sha256, status, batch_id)
     VALUES ('${raw[0].id}', 'm-${n}', '${opts.sourceId}', 'group', 'U1', 'slips/${n}.jpg', 'image/jpeg',
             '${sha}', 'RECEIVED', ${batchId ? `'${batchId}'` : "NULL"})
     RETURNING id`,
  );
  return ev[0].id;
}

async function claim(evidenceId: string) {
  const raw = await db.scalar(`SELECT claim_slip_check('${evidenceId}', 300)`);
  return JSON.parse(raw) as { claimed: boolean; check_id: string; token: number; reason?: string; status?: string };
}
async function complete(checkId: string, token: number, ref: string) {
  const raw = await db.scalar(
    `SELECT complete_slip_check('${checkId}', ${token}, 'EXTRACTED', '${JSON.stringify(fields(ref))}'::jsonb)`,
  );
  return JSON.parse(raw) as { outcome: string; status?: string };
}
async function fail(checkId: string, token: number) {
  return JSON.parse(await db.scalar(`SELECT fail_slip_check('${checkId}', ${token}, 'late')`)) as {
    outcome: string; status?: string;
  };
}
const row = async (checkId: string) => (await db.query<{
  status: string; failure_reason: string | null; lease_until: string | null; claim_token: number;
}>(`SELECT status, failure_reason, lease_until, claim_token FROM slip_checks WHERE id='${checkId}'`))[0];

describe.skipIf(!pgAvailable)("global admission trigger under fenced OCR RPCs (PostgreSQL 17)", () => {
  beforeAll(async () => {
    db = await createSlipTestDb("global_ocr");
  }, 120_000);

  afterAll(async () => {
    if (db) await db.drop();
  }, 60_000);

  beforeEach(async () => {
    await db.query(`TRUNCATE slip_checks, slip_evidences, slip_batches, raw_messages CASCADE`);
  });

  test("cross-market reused reference: fenced complete lands NEED_REVIEW, lease cleared, stays terminal", async () => {
    const first = await claim(await seedEvidence({ sourceId: "G-market-a" }));
    expect(await complete(first.check_id, first.token, "REF-SHARED")).toEqual({ outcome: "completed" });
    expect((await row(first.check_id)).status).toBe("EXTRACTED");

    const secondEvidence = await seedEvidence({ sourceId: "G-market-b", batchStatus: "closing" });
    const second = await claim(secondEvidence);
    expect(second.claimed).toBe(true);
    // The RPC reports success; the trigger rewrote the row. Callers must read back.
    expect(await complete(second.check_id, second.token, "REF-SHARED")).toEqual({ outcome: "completed" });
    const held = await row(second.check_id);
    expect(held.status).toBe("NEED_REVIEW");
    expect(held.failure_reason).toBe("duplicate_transaction_reference_global");
    expect(held.lease_until).toBeNull();

    // Fencing still treats the held row as terminal: no re-claim, no late overwrite.
    expect(await claim(secondEvidence)).toMatchObject({ claimed: false, reason: "terminal", status: "NEED_REVIEW" });
    expect(await fail(second.check_id, second.token)).toEqual({ outcome: "already_terminal", status: "NEED_REVIEW" });
    expect(await complete(second.check_id, second.token, "REF-OTHER")).toEqual({
      outcome: "already_terminal", status: "NEED_REVIEW",
    });
    expect(await row(second.check_id)).toMatchObject({ status: "NEED_REVIEW", claim_token: second.token });
  });

  test("identical image bytes with a different reference are held by sha256", async () => {
    const sha = "c".repeat(64);
    const first = await claim(await seedEvidence({ sourceId: "G-market-a", sha }));
    await complete(first.check_id, first.token, "REF-1");
    const second = await claim(await seedEvidence({ sourceId: "G-market-b", sha }));
    await complete(second.check_id, second.token, "REF-2");
    expect(await row(second.check_id)).toMatchObject({
      status: "NEED_REVIEW", failure_reason: "duplicate_image_sha256_global",
    });
  });

  test("claim insert and fail_slip_check are untouched by the trigger", async () => {
    const c = await claim(await seedEvidence({ sourceId: "G-market-a" }));
    expect(await row(c.check_id)).toMatchObject({ status: "PROCESSING", failure_reason: null });
    expect(await fail(c.check_id, c.token)).toEqual({ outcome: "failed" });
    expect(await row(c.check_id)).toMatchObject({ status: "FAILED", failure_reason: "late" });
  });

  test("concurrent fenced completions of one reference admit exactly one", async () => {
    for (let round = 0; round < 8; round++) {
      const ref = `REF-RACE-${round}`;
      const a = await claim(await seedEvidence({ sourceId: "G-market-a" }));
      const b = await claim(await seedEvidence({ sourceId: "G-market-b" }));
      const outcomes = await Promise.all([complete(a.check_id, a.token, ref), complete(b.check_id, b.token, ref)]);
      expect(outcomes.map((o) => o.outcome)).toEqual(["completed", "completed"]);
      const statuses = [(await row(a.check_id)).status, (await row(b.check_id)).status].sort();
      expect(statuses).toEqual(["EXTRACTED", "NEED_REVIEW"]);
    }
  });

  test("SlipCheckService reports the persisted hold, not the pre-trigger status", async () => {
    const pushes: string[] = [];
    const storage = { failUpload: new Set<string>(), uploaded: new Map<string, Uint8Array>() };
    const supa: AnySupabase = createPgSupabase(db, storage);
    const svc = new SlipCheckService(
      supa,
      { async extract() { return extraction("REF-SVC"); } },
      async (_to, text) => { pushes.push(text); },
    );
    for (const sourceId of ["G-market-a", "G-market-b"]) {
      const evidenceId = await seedEvidence({ sourceId });
      const [{ storage_path }] = await db.query<{ storage_path: string }>(
        `SELECT storage_path FROM slip_evidences WHERE id='${evidenceId}'`,
      );
      storage.uploaded.set(storage_path, new Uint8Array([1, 2, 3]));
      await svc.processEvidence(evidenceId);
    }
    const rows = await db.query<{ status: string; failure_reason: string | null }>(
      `SELECT c.status, c.failure_reason FROM slip_checks c JOIN slip_evidences e ON e.id = c.evidence_id
        ORDER BY e.source_id`,
    );
    expect(rows).toEqual([
      { status: "EXTRACTED", failure_reason: null },
      { status: "NEED_REVIEW", failure_reason: "duplicate_transaction_reference_global" },
    ]);
    expect(pushes).toHaveLength(2);
    expect(pushes[1]).toContain("รหัสธุรกรรมซ้ำ");
  });
});

describe.skipIf(!pgAvailable)("fingerprinting evidence writer across schema versions (PostgreSQL 17)", () => {
  const T = Date.parse("2026-10-16T05:00:00.000Z");
  let png: Uint8Array;

  beforeAll(async () => {
    png = new Uint8Array(await sharp({
      create: { width: 96, height: 64, channels: 3, background: "#3366cc" },
    }).png().toBuffer());
  });

  async function ingest(target: SlipTestDb, storage: FakeStorage, lineMessageId: string, rawMessageId?: string) {
    const rawId = rawMessageId ?? (await target.query<{ id: string }>(
      `INSERT INTO raw_messages (line_event_id, destination, event_type, source_type, source_id, user_id,
                                 message_id, message_type, payload)
       VALUES ('evt-${lineMessageId}', 'dest', 'message', 'group', 'G-fp', 'U1', '${lineMessageId}', 'image', '{}'::jsonb)
       RETURNING id`,
    ))[0].id;
    const svc = new SlipEvidenceService(createPgSupabase(target, storage) as AnySupabase, async () => ({ bytes: png, mimeType: "image/png" }));
    const result = await svc.ingest({
      rawMessageId: rawId, lineMessageId, sourceId: "G-fp", sourceType: "group", lineUserId: "U1", eventTimestamp: T,
    });
    return { rawId, result };
  }

  test("schema without 20261019143000: a decodable image is still recorded (no fingerprint)", async () => {
    const old = await createSlipTestDb(
      "global_fp_old",
      SLIP_PIPELINE_MIGRATIONS.filter((m) => m < "20261019143000"),
    );
    try {
      const storage: FakeStorage = { failUpload: new Set(), uploaded: new Map() };
      const { result } = await ingest(old, storage, "m-fp-old");
      expect(result.status).toBe("RECEIVED");
      expect(result.evidenceId).not.toBeNull();
      expect(await old.scalar(`SELECT count(*) FROM slip_evidences WHERE line_message_id='m-fp-old'`)).toBe("1");
    } finally {
      await old.drop();
    }
  }, 120_000);

  test("full chain: retry after STORAGE_FAILED stores the fingerprint on the recovered row", async () => {
    const fresh = await createSlipTestDb("global_fp_new");
    try {
      const storage: FakeStorage = { failUpload: new Set(), uploaded: new Map() };
      storage.failUpload.add(buildSlipEvidencePath({
        businessDate: bangkokBusinessDateFromTimestamp(T)!, sourceId: "G-fp", lineMessageId: "m-fp-new",
      }));
      const first = await ingest(fresh, storage, "m-fp-new");
      expect(first.result.status).toBe("STORAGE_FAILED");
      storage.failUpload.clear();
      const retry = await ingest(fresh, storage, "m-fp-new", first.rawId);
      expect(retry.result.status).toBe("RECEIVED");
      const [row] = await fresh.query<{ status: string; visual_hash_full: string | null; visual_hash_center: string | null }>(
        `SELECT status, visual_hash_full, visual_hash_center FROM slip_evidences WHERE line_message_id='m-fp-new'`,
      );
      expect(row.status).toBe("RECEIVED");
      expect(row.visual_hash_full).toMatch(/^[0-9a-f]{16}$/);
      expect(row.visual_hash_center).toMatch(/^[0-9a-f]{16}$/);
    } finally {
      await fresh.drop();
    }
  }, 120_000);
});
