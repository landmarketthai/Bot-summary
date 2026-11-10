/**
 * Durable bounded retry of transient Gemini slip OCR failures (migration
 * 20261110090000), proven on real PostgreSQL 17 with the REAL SlipCheckService
 * and batch-summary builder. Only the OCR provider (fake extractor), EasySlip,
 * LINE push and Storage are simulated. No network, no real AI API.
 *
 *   ALLOW_DISPOSABLE_POSTGRES_TESTS=1 PGPASSWORD=postgres bun test src/lib/slips/ocr-transient-retry.pg.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SlipCheckService } from "@/lib/slips/check-service";
import { buildBatchSummaryMessage, type EvidenceWithCheck } from "@/lib/slips/batch-finalizer";
import type { BankSlipVerifier } from "@/lib/slips/easyslip-bank";
import type { SlipExtraction } from "@/lib/slips/extraction-schema";
import { ExtractionHttpError, type SlipExtractor } from "@/lib/slips/extractor";
import { createProductionSlipExtractor } from "@/lib/slips/production-extractor";
import {
  ROOT,
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
    transactionTime: "2026-11-10T05:00:00.000Z",
    senderName: "sender",
    receiverName: "receiver",
    receiverAccountTail: "1234",
    paymentChannelText: null,
    headlineTotalAmount: null,
    confidence: 0.95,
  };
}

const http429 = (retryAfterMs: number | null = null) =>
  new ExtractionHttpError(429, "rate_limit", true, "", 5, retryAfterMs);
const http503 = () => new ExtractionHttpError(503, "upstream_error", true, "", 5);
const timeout = () => new ExtractionHttpError(0, "timeout", true, "", 10_000);
const http401 = () => new ExtractionHttpError(401, "auth_error", false, "", 5);

/** Fails with the scripted errors in order, then returns `amount`. */
function scripted(errors: Array<() => Error>, amount = 100) {
  const calls: number[] = [];
  const extractor: SlipExtractor = {
    async extract() {
      const n = calls.length;
      calls.push(n);
      if (n < errors.length) throw errors[n]();
      return extraction(amount);
    },
  };
  return { extractor, calls };
}

function service(extractor: SlipExtractor, client: AnySupabase = supa, bank?: BankSlipVerifier): SlipCheckService {
  return new SlipCheckService(client, extractor, async (_to, text) => { pushes.push(text); }, 300, bank);
}

async function seedEvidence(batchStatus: string | null): Promise<{ evidenceId: string; batchId: string | null }> {
  seq += 1;
  const n = `${process.pid}-${seq}`;
  // Each simulated batch uses its own source. Production enforces only one
  // open slip batch per LINE source, so separate test batches cannot all use G-retry.
  const sourceId = `G-retry-${seq}`;
  const raw = await db.query<{ id: string }>(
    `INSERT INTO raw_messages (line_event_id, destination, event_type, source_type, source_id, user_id,
                               message_id, message_type, payload)
     VALUES ('evt-${n}', 'dest', 'message', 'group', '${sourceId}', 'U1', 'm-${n}', 'image', '{}'::jsonb)
     RETURNING id`,
  );
  let batchId: string | null = null;
  if (batchStatus) {
    batchId = (await db.query<{ id: string }>(
      `INSERT INTO slip_batches (source_id, source_type, sender_id, status)
       VALUES ('${sourceId}', 'group', 'U1', '${batchStatus}') RETURNING id`,
    ))[0].id;
  }
  const path = `slips/${n}.jpg`;
  storage.uploaded.set(path, new Uint8Array([1, 2, 3]));
  const ev = await db.query<{ id: string }>(
    `INSERT INTO slip_evidences (raw_message_id, line_message_id, source_id, source_type, line_user_id,
                                 storage_path, mime_type, sha256, status, batch_id, batch_index)
     VALUES ('${raw[0].id}', 'm-${n}', '${sourceId}', 'group', 'U1', '${path}', 'image/jpeg',
             '${"b".repeat(60)}${String(seq).padStart(4, "0")}', 'RECEIVED',
             ${batchId ? `'${batchId}'` : "NULL"}, ${batchId ? 1 : "NULL"})
     RETURNING id`,
  );
  if (batchId) {
    // Attached ledger row so list_slip_ocr_redrive can see the evidence.
    await db.query(
      `INSERT INTO slip_image_events (line_message_id, raw_message_id, batch_id, source_id, source_type,
                                      event_ts_ms, state, evidence_id, resolved_at)
       VALUES ('m-${n}', '${raw[0].id}', '${batchId}', '${sourceId}', 'group', 1760000000000, 'attached',
               '${ev[0].id}', now() - interval '10 minutes')`,
    );
  }
  return { evidenceId: ev[0].id, batchId };
}

interface CheckRow {
  id: string; status: string; transfer_amount: string | null; claim_token: number;
  lease_until: string | null; failure_reason: string | null; ocr_retry_count: number;
  ocr_retry_first_at: string | null; due_in: number | null;
}
const check = async (evidenceId: string): Promise<CheckRow> => (await db.query<CheckRow>(
  `SELECT id, status, transfer_amount, claim_token, lease_until, failure_reason, ocr_retry_count,
          ocr_retry_first_at, extract(epoch FROM lease_until - now())::float8 AS due_in
     FROM slip_checks WHERE evidence_id='${evidenceId}'`,
))[0];
const makeDue = (evidenceId: string) => db.query(
  `UPDATE slip_checks SET lease_until = now() - interval '1 second' WHERE evidence_id='${evidenceId}'`,
);
const clearCooldown = () => db.query(`DELETE FROM slip_ocr_provider_cooldown`);
const cooldownIn = async () => Number(await db.scalar(
  `SELECT coalesce(extract(epoch FROM cooldown_until - now()), 0)::float8 FROM slip_ocr_provider_cooldown WHERE provider='gemini'`,
) || 0);
const redriveList = async () =>
  (await db.query<{ list_slip_ocr_redrive: string }>(`SELECT list_slip_ocr_redrive(50)`))
    .map((r) => r.list_slip_ocr_redrive);

/** Re-runs a due retry the way the cron redrive would (lease passed, cooldown over). */
async function runDueRetry(evidenceId: string, extractor: SlipExtractor) {
  await makeDue(evidenceId);
  await clearCooldown();
  expect(await redriveList()).toContain(evidenceId);
  await service(extractor).processEvidence(evidenceId);
}

describe.skipIf(!pgAvailable)("transient Gemini OCR retry on PostgreSQL 17", () => {
  beforeAll(async () => {
    db = await createSlipTestDb("ocr_retry");
  }, 120_000);

  afterAll(async () => {
    if (db) await db.drop();
  }, 60_000);

  beforeEach(async () => {
    await db.query(`TRUNCATE slip_checks, slip_image_events, slip_evidences, slip_batches, raw_messages CASCADE`);
    await clearCooldown();
    seq = 0;
    storage = { failUpload: new Set(), uploaded: new Map() };
    supa = createPgSupabase(db, storage);
    pushes = [];
  });

  test("429 defers durably: one provider call, PROCESSING, token bumped, Retry-After honoured, cooldown set, no push", async () => {
    const { evidenceId } = await seedEvidence("collecting");
    const fake = scripted([() => http429(120_000)]);
    await service(fake.extractor).processEvidence(evidenceId);

    expect(fake.calls).toHaveLength(1); // no inline 429 retry
    const row = await check(evidenceId);
    expect(row.status).toBe("PROCESSING");
    expect(row.failure_reason).toBe("ocr_retry:extractor_http_rate_limit");
    expect(row.ocr_retry_count).toBe(1);
    expect(row.ocr_retry_first_at).not.toBeNull();
    expect(row.claim_token).toBe(2); // deferring worker fenced out
    expect(row.transfer_amount).toBeNull();
    expect(row.due_in!).toBeGreaterThan(115); // Retry-After 120 s beats the 60 s backoff
    expect(row.due_in!).toBeLessThanOrEqual(120);
    expect(await cooldownIn()).toBeGreaterThan(115);
    expect(pushes).toHaveLength(0);
  }, 60_000);

  test("not re-run before it is due; redrive picks it up when due; retry success completes once", async () => {
    const { evidenceId } = await seedEvidence("collecting");
    await service(scripted([() => http503()]).extractor).processEvidence(evidenceId);
    expect((await check(evidenceId)).due_in!).toBeGreaterThan(55); // 60 s backoff

    const early = scripted([], 999);
    await service(early.extractor).processEvidence(evidenceId);
    expect(early.calls).toHaveLength(0);
    expect(await redriveList()).not.toContain(evidenceId);

    const ok = scripted([], 250);
    await runDueRetry(evidenceId, ok.extractor);
    expect(ok.calls).toHaveLength(1);
    const row = await check(evidenceId);
    expect(row.status).toBe("EXTRACTED");
    expect(Number(row.transfer_amount)).toBe(250);
    expect(row.failure_reason).toBeNull();
    expect(row.lease_until).toBeNull();
    expect(await db.scalar(`SELECT count(*) FROM slip_checks WHERE evidence_id='${evidenceId}'`)).toBe("1");
    expect(pushes).toHaveLength(0); // batched: only the batch summary will speak
  }, 60_000);

  test("timeouts defer too; backoff grows exponentially", async () => {
    const { evidenceId } = await seedEvidence("collecting");
    await service(scripted([() => timeout()]).extractor).processEvidence(evidenceId);
    let row = await check(evidenceId);
    expect(row.failure_reason).toBe("ocr_retry:extractor_http_timeout");
    expect(row.due_in!).toBeGreaterThan(55);
    expect(row.due_in!).toBeLessThanOrEqual(60);

    await runDueRetry(evidenceId, scripted([() => timeout()]).extractor);
    row = await check(evidenceId);
    expect(row.ocr_retry_count).toBe(2);
    expect(row.due_in!).toBeGreaterThan(115);
    expect(row.due_in!).toBeLessThanOrEqual(120);
  }, 60_000);

  test("exhaustion: 5 transient failures end FAILED with the real reason; never retried again", async () => {
    const { evidenceId } = await seedEvidence("collecting");
    let calls = 0;
    for (let i = 0; i < 5; i++) {
      const fake = scripted([() => http503()]);
      if (i === 0) await service(fake.extractor).processEvidence(evidenceId);
      else await runDueRetry(evidenceId, fake.extractor);
      calls += fake.calls.length;
    }
    expect(calls).toBe(5);
    const row = await check(evidenceId);
    expect(row.status).toBe("FAILED");
    expect(row.failure_reason).toBe("extractor_http_upstream_error");
    expect(row.ocr_retry_count).toBe(5);
    expect(row.lease_until).toBeNull();

    const later = scripted([], 1);
    await makeDue(evidenceId);
    await service(later.extractor).processEvidence(evidenceId);
    expect(later.calls).toHaveLength(0);
    expect(await redriveList()).not.toContain(evidenceId);
  }, 60_000);

  test("shared cooldown: other workers defer WITHOUT calling Gemini and without spending an attempt", async () => {
    const a = await seedEvidence("collecting");
    const b = await seedEvidence("collecting");
    await service(scripted([() => http429()]).extractor).processEvidence(a.evidenceId);
    expect(await cooldownIn()).toBeGreaterThan(55);

    const fake = scripted([], 5);
    await service(fake.extractor).processEvidence(b.evidenceId);
    expect(fake.calls).toHaveLength(0);
    const row = await check(b.evidenceId);
    expect(row.status).toBe("PROCESSING");
    expect(row.failure_reason).toBe("ocr_retry:extractor_http_rate_limit");
    expect(row.ocr_retry_count).toBe(0);
    expect(row.due_in!).toBeGreaterThan(55);

    // Cooldown skips are not counted, but the 24 h age bound still ends them.
    await db.query(`UPDATE slip_checks SET ocr_retry_first_at = now() - interval '25 hours'
                     WHERE evidence_id='${b.evidenceId}'`);
    await makeDue(b.evidenceId);
    await service(fake.extractor).processEvidence(b.evidenceId);
    expect(fake.calls).toHaveLength(0);
    expect((await check(b.evidenceId)).status).toBe("FAILED");
  }, 60_000);

  test("EasySlip verified bypass still completes during a Gemini cooldown", async () => {
    const prior = { on: process.env.EASYSLIP_BANK_VERIFICATION_ENABLED, ids: process.env.EASYSLIP_LINE_SOURCE_IDS };
    process.env.EASYSLIP_BANK_VERIFICATION_ENABLED = "true";
    process.env.EASYSLIP_LINE_SOURCE_IDS = "G-retry-1,G-retry-2";
    try {
      const a = await seedEvidence("collecting");
      await service(scripted([() => http429()]).extractor, supa, {
        async verifyImage() { return { kind: "not_found" }; },
      }).processEvidence(a.evidenceId);
      expect(await cooldownIn()).toBeGreaterThan(55);

      const b = await seedEvidence("collecting");
      const gemini = scripted([], 1);
      await service(gemini.extractor, supa, {
        async verifyImage() {
          return { kind: "verified", isDuplicate: false, accountMatched: true,
                   extraction: { ...extraction(480), slipType: "BANK_SLIP_QR" } };
        },
      }).processEvidence(b.evidenceId);
      expect(gemini.calls).toHaveLength(0);
      const row = await check(b.evidenceId);
      expect(row.status).toBe("EXTRACTED");
      expect(Number(row.transfer_amount)).toBe(480);
    } finally {
      if (prior.on === undefined) delete process.env.EASYSLIP_BANK_VERIFICATION_ENABLED;
      else process.env.EASYSLIP_BANK_VERIFICATION_ENABLED = prior.on;
      if (prior.ids === undefined) delete process.env.EASYSLIP_LINE_SOURCE_IDS;
      else process.env.EASYSLIP_LINE_SOURCE_IDS = prior.ids;
    }
  }, 60_000);

  test("nontransient errors stay terminal FAILED at once", async () => {
    const auth = await seedEvidence("collecting");
    await service(scripted([() => http401()]).extractor).processEvidence(auth.evidenceId);
    expect(await check(auth.evidenceId)).toMatchObject({
      status: "FAILED", failure_reason: "extractor_http_auth_error", ocr_retry_count: 0,
    });

    const invalid = await seedEvidence("collecting");
    await service(scripted([() => new Error("Image extraction provider returned invalid extraction schema")]).extractor)
      .processEvidence(invalid.evidenceId);
    expect(await check(invalid.evidenceId)).toMatchObject({
      status: "FAILED", failure_reason: "extractor_invalid_output", ocr_retry_count: 0,
    });
    expect(await cooldownIn()).toBe(0);
  }, 60_000);

  test("disabled flag / missing key fail closed even while a cooldown is active", async () => {
    await db.query(`INSERT INTO slip_ocr_provider_cooldown (provider, cooldown_until) VALUES ('gemini', now() + interval '10 minutes')`);
    const off = await seedEvidence("collecting");
    await service(createProductionSlipExtractor({})).processEvidence(off.evidenceId);
    expect(await check(off.evidenceId)).toMatchObject({ status: "FAILED", failure_reason: "extractor_disabled" });

    const noKey = await seedEvidence("collecting");
    await service(createProductionSlipExtractor({ SLIP_GEMINI_OCR_ENABLED: "true" })).processEvidence(noKey.evidenceId);
    expect(await check(noKey.evidenceId)).toMatchObject({ status: "FAILED", failure_reason: "extractor_not_configured" });
  }, 60_000);

  test("un-batched evidence has no redrive: a transient failure is FAILED and notified once", async () => {
    const { evidenceId } = await seedEvidence(null);
    await service(scripted([() => http429()]).extractor).processEvidence(evidenceId);
    expect(await check(evidenceId)).toMatchObject({
      status: "FAILED", failure_reason: "extractor_http_rate_limit", ocr_retry_count: 1,
    });
    expect(pushes).toHaveLength(1);
  }, 60_000);

  test("concurrent workers on a due retry: exactly one provider call and one result", async () => {
    const { evidenceId } = await seedEvidence("collecting");
    await service(scripted([() => http503()]).extractor).processEvidence(evidenceId);
    await makeDue(evidenceId);
    const ok = scripted([], 333);
    await Promise.all(Array.from({ length: 6 }, () => service(ok.extractor).processEvidence(evidenceId)));
    expect(ok.calls).toHaveLength(1);
    const row = await check(evidenceId);
    expect(row.status).toBe("EXTRACTED");
    expect(Number(row.transfer_amount)).toBe(333);
  }, 60_000);

  test("stale worker: a 429 from a worker whose lease was re-claimed cannot defer or touch the new owner", async () => {
    const { evidenceId } = await seedEvidence("collecting");
    let fail!: () => void;
    const slow: SlipExtractor = {
      extract: () => new Promise((_, reject) => { fail = () => reject(http429()); }),
    };
    const workerA = service(slow).processEvidence(evidenceId);
    await new Promise((r) => setTimeout(r, 150));
    await makeDue(evidenceId);
    await service(scripted([], 222).extractor).processEvidence(evidenceId);
    const done = await check(evidenceId);
    expect(done.status).toBe("EXTRACTED");

    fail();
    await workerA;
    expect(await check(evidenceId)).toEqual(done);
    expect(await cooldownIn()).toBe(0); // fenced before the cooldown write
  }, 60_000);

  test("defer RPC is fenced in SQL: wrong token, expired lease, terminal check", async () => {
    const { evidenceId } = await seedEvidence("collecting");
    const claim = JSON.parse(await db.scalar(`SELECT claim_slip_check('${evidenceId}', 300)`));
    const defer = async (token: number) => JSON.parse(await db.scalar(
      `SELECT defer_slip_check('${claim.check_id}', ${token}, 'extractor_http_upstream_error', NULL, true)`,
    ));
    expect((await defer(claim.token + 1)).outcome).toBe("stale_claim");
    await makeDue(evidenceId);
    expect((await defer(claim.token)).outcome).toBe("stale_claim");
    await db.query(`UPDATE slip_checks SET status='EXTRACTED', lease_until=NULL WHERE evidence_id='${evidenceId}'`);
    expect((await defer(claim.token)).outcome).toBe("already_terminal");
    expect((await check(evidenceId)).ocr_retry_count).toBe(0);
  }, 60_000);

  test("finalization race: after close, a due retry is never claimed and an in-flight result is discarded", async () => {
    const { evidenceId, batchId } = await seedEvidence("closing");
    await service(scripted([() => http503()]).extractor).processEvidence(evidenceId);
    await makeDue(evidenceId);

    // In-flight retry worker...
    let succeed!: () => void;
    const slow: SlipExtractor = {
      extract: () => new Promise((resolve) => { succeed = () => resolve(extraction(9_999)); }),
    };
    const worker = service(slow).processEvidence(evidenceId);
    await new Promise((r) => setTimeout(r, 150));
    // ...while the batch is finalized.
    await db.query(`UPDATE slip_batches SET status='processing' WHERE id='${batchId}'`);
    succeed();
    await worker;

    const row = await check(evidenceId);
    expect(row.status).toBe("PROCESSING");
    expect(row.transfer_amount).toBeNull(); // no retroactive money
    expect(row.failure_reason).toBe("ocr_retry:extractor_http_upstream_error");

    await makeDue(evidenceId);
    const later = scripted([], 1);
    await service(later.extractor).processEvidence(evidenceId);
    expect(later.calls).toHaveLength(0);
    expect(await redriveList()).not.toContain(evidenceId);
    const deferAfterClose = JSON.parse(await db.scalar(
      `SELECT defer_slip_check('${row.id}', ${row.claim_token}, 'extractor_http_rate_limit', NULL, true)`,
    ));
    expect(deferAfterClose.outcome).toBe("batch_not_open");
    expect(pushes).toHaveLength(0);
  }, 60_000);

  test("close OCR gate waits only its existing bound for a deferred retry, then the summary is honest and uncounted", async () => {
    const { evidenceId, batchId } = await seedEvidence("closing");
    await service(scripted([() => http429()]).extractor).processEvidence(evidenceId);
    const claimClose = () => db.query<{ claimed_id: string | null; was_timeout: boolean | null }>(
      `SELECT * FROM claim_closing_slip_batch('${batchId}', 10, 120, 2160)`,
    );

    // 10 min after close: inside the 870 s OCR wait -> not finalized.
    await db.query(`UPDATE slip_batches SET closing_at = now() - interval '10 minutes',
                                            last_image_at = now() - interval '10 minutes' WHERE id='${batchId}'`);
    expect(await claimClose()).toHaveLength(0);

    // Past the bound: force-finalized (not extended for the retry).
    await db.query(`UPDATE slip_batches SET closing_at = now() - interval '15 minutes',
                                            last_image_at = now() - interval '15 minutes' WHERE id='${batchId}'`);
    const claimed = await claimClose();
    expect(claimed).toHaveLength(1);
    expect(claimed[0].was_timeout).toBe(true);

    const row = await check(evidenceId);
    const evidence: EvidenceWithCheck = {
      id: evidenceId, checkId: row.id, batchIndex: 1, checkStatus: "PROCESSING", slipType: "UNKNOWN",
      grossAmount: null, discountAmount: null, transferAmount: null, paidAmount: null,
      transactionTime: null, referenceId: null, ocrFallbackReason: null, bankVerificationIssue: null,
      failureReason: row.failure_reason,
    };
    const text = buildBatchSummaryMessage([evidence], { isTimeout: true, slipDate: "2026-11-10" });
    expect(text).toContain("ลองอ่านซ้ำไม่ทันปิดชุด: 1 รูป");
    expect(text).toContain("(ยังไม่รวมยอด)");
    expect(text).not.toContain("ยังรอผล");
    expect(text).not.toContain("ยอดรวมที่อ่านได้");
  }, 60_000);

  test("24 h safety age: no retry is scheduled past it, and a due one past it is FAILED, not claimed", async () => {
    const a = await seedEvidence("collecting");
    await service(scripted([() => http503()]).extractor).processEvidence(a.evidenceId);
    await db.query(`UPDATE slip_checks SET ocr_retry_first_at = now() - interval '23 hours 59 minutes 30 seconds'
                     WHERE evidence_id='${a.evidenceId}'`);
    await runDueRetry(a.evidenceId, scripted([() => http503()]).extractor);
    expect(await check(a.evidenceId)).toMatchObject({ status: "FAILED", failure_reason: "extractor_http_upstream_error" });

    const b = await seedEvidence("collecting");
    await service(scripted([() => http503()]).extractor).processEvidence(b.evidenceId);
    await db.query(`UPDATE slip_checks SET ocr_retry_first_at = now() - interval '25 hours' WHERE evidence_id='${b.evidenceId}'`);
    await makeDue(b.evidenceId);
    const later = scripted([], 1);
    await service(later.extractor).processEvidence(b.evidenceId);
    expect(later.calls).toHaveLength(0);
    expect(await check(b.evidenceId)).toMatchObject({ status: "FAILED", failure_reason: "extractor_http_upstream_error" });
  }, 60_000);

  test("defer RPC missing (code ahead of migration) fails closed exactly as before", async () => {
    const { evidenceId } = await seedEvidence("collecting");
    const partial = {
      from: supa.from.bind(supa),
      storage: supa.storage,
      rpc: async (name: string, args: Record<string, unknown>) => name === "defer_slip_check"
        ? { data: null, error: { code: "PGRST202", message: "function missing" } }
        : supa.rpc(name, args),
    };
    await service(scripted([() => http429()]).extractor, partial).processEvidence(evidenceId);
    expect(await check(evidenceId)).toMatchObject({ status: "FAILED", failure_reason: "extractor_http_rate_limit" });
  }, 60_000);

  test("privileges: claim/defer service_role only; cooldown table hidden from API roles", async () => {
    for (const sig of [
      "claim_slip_check(uuid, integer)",
      "defer_slip_check(uuid, integer, text, integer, boolean)",
    ]) {
      const rows = await db.query<{ anon: boolean; auth: boolean; pub: boolean; svc: boolean }>(
        `SELECT has_function_privilege('anon', 'public.${sig}', 'EXECUTE') AS anon,
                has_function_privilege('authenticated', 'public.${sig}', 'EXECUTE') AS auth,
                has_function_privilege('public', 'public.${sig}', 'EXECUTE') AS pub,
                has_function_privilege('service_role', 'public.${sig}', 'EXECUTE') AS svc`,
      );
      expect(rows[0]).toEqual({ anon: false, auth: false, pub: false, svc: true });
    }
    const table = await db.query<{ anon: boolean; auth: boolean }>(
      `SELECT has_table_privilege('anon', 'public.slip_ocr_provider_cooldown', 'SELECT') AS anon,
              has_table_privilege('authenticated', 'public.slip_ocr_provider_cooldown', 'SELECT') AS auth`,
    );
    expect(table[0]).toEqual({ anon: false, auth: false });
  });

  test("migration is idempotent and keeps retry state", async () => {
    const { evidenceId } = await seedEvidence("collecting");
    await service(scripted([() => http503()]).extractor).processEvidence(evidenceId);
    const before = await check(evidenceId);
    await db.exec(await Bun.file(`${ROOT}/supabase/migrations/20261110090000_slip_ocr_transient_retry.sql`).text());
    const after = await check(evidenceId);
    expect({ ...after, due_in: null }).toEqual({ ...before, due_in: null });
  }, 60_000);

  test("rollback ends deferred checks FAILED, removes defer, and re-applies cleanly", async () => {
    const { evidenceId } = await seedEvidence("collecting");
    await service(scripted([() => http503()]).extractor).processEvidence(evidenceId);
    await db.exec(await Bun.file(`${ROOT}/supabase/rollback/20261110090000_slip_ocr_transient_retry.down.sql`).text());
    expect(await db.query<{ status: string; failure_reason: string }>(
      `SELECT status, failure_reason FROM slip_checks WHERE evidence_id='${evidenceId}'`,
    )).toEqual([{ status: "FAILED", failure_reason: "extractor_http_upstream_error" }]);
    expect(await db.scalar(`SELECT count(*) FROM pg_proc WHERE proname='defer_slip_check'`)).toBe("0");
    await db.exec(await Bun.file(`${ROOT}/supabase/migrations/20261110090000_slip_ocr_transient_retry.sql`).text());
    expect(await db.scalar(`SELECT count(*) FROM pg_proc WHERE proname='defer_slip_check'`)).toBe("1");
  }, 60_000);
});
