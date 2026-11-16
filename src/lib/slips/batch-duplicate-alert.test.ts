import { describe, expect, test } from "bun:test";
import { applyGlobalDuplicateExclusions, buildBatchSummaryMessage, finalizeSlipBatch, type EvidenceWithCheck } from "./batch-finalizer";

type Row = Record<string, unknown>;
type Query = { table: string; columns: string; filters: Array<[string, unknown[]]> };
const hash = "a1".repeat(32);
const date = "2026-10-30T08:00:00Z";
const fallback = { verification: { provider: "easyslip", bank_verified: false, reason: "provider_error" } };

function image(id: string, source: string, batch: string, overrides: Row = {}): Row {
  return { id, source_id: source, batch_id: batch, batch_index: 1, status: "RECEIVED", sha256: hash,
    byte_size: 123, ...overrides };
}

function check(id: string, evidence: string, overrides: Row = {}): Row {
  return { id, evidence_id: evidence, status: "EXTRACTED", slip_type: "BANK_SLIP_QR",
    transfer_amount: 75, paid_amount: null, reference_id: "SYNTHETIC-REF-001",
    transaction_time: date, created_at: date, failure_reason: null, extracted_json: {}, ...overrides };
}

function database(options: {
  images?: Row[]; checks?: Row[]; batches?: Row[];
  fail?: (query: Query) => boolean;
} = {}) {
  const tables: Record<string, Row[]> = {
    slip_evidences: options.images ?? [image("current", "source-current", "current-batch"), image("original", "source-original", "original-batch")],
    slip_checks: options.checks ?? [check("current-check", "current", { created_at: "2026-10-30T09:00:00Z" }), check("original-check", "original")],
    slip_batches: options.batches ?? [
      { id: "current-batch", source_id: "source-current", market_name: "ตลาดสังเคราะห์ปัจจุบัน", slip_date: "30/10/2569", summary_sent_at: null },
      { id: "original-batch", source_id: "source-original", market_name: "ตลาดสังเคราะห์ต้นทาง" },
    ],
  };
  const queries: Query[] = [];
  const updates: Row[] = [];
  const db = {
    rpc: async () => ({ data: null, error: { code: "PGRST202", message: "function not found" } }),
    from(table: string) {
      const query: Query = { table, columns: "", filters: [] };
      const orders: string[] = [];
      const result = () => {
        if (options.fail?.(query)) return { data: null, error: { message: "synthetic lookup failure" } };
        const data = (tables[table] ?? []).filter((row) => query.filters.every(([key, values]) => values.includes(row[key])))
          .toSorted((a, b) => {
            for (const key of orders) {
              const cmp = String(a[key]).localeCompare(String(b[key]));
              if (cmp) return cmp;
            }
            return 0;
          });
        return { data, error: null };
      };
      const builder = {
        select(columns: string) { query.columns = columns; queries.push(query); return builder; },
        eq(key: string, value: unknown) { query.filters.push([key, [value]]); return builder; },
        in(key: string, values: unknown[]) { query.filters.push([key, values]); return builder; },
        order(key: string) { orders.push(key); return builder; },
        update(values: Row) { updates.push(values); return builder; },
        then(resolve: (value: unknown) => void) { resolve(result()); },
        async maybeSingle() { const res = result(); return { ...res, data: res.data?.[0] ?? null }; },
      };
      return builder;
    },
  };
  return { db: db as never, queries, updates, tables };
}

function review(overrides: Partial<EvidenceWithCheck> = {}): EvidenceWithCheck {
  return { id: "current", checkId: "current-check", sourceId: "source-current", batchIndex: 2,
    checkStatus: "NEED_REVIEW", slipType: "BANK_SLIP_QR", transferAmount: 75, paidAmount: null,
    referenceId: "SYNTHETIC-REF-001", transactionTime: date, failureReason: null,
    ocrFallbackReason: "provider_error", ...overrides };
}

async function finalize(db: ReturnType<typeof database>) {
  const sent: string[] = [];
  await finalizeSlipBatch(db.db, "current-batch", async (text) => { sent.push(text); });
  expect(sent).toHaveLength(1);
  return sent[0];
}

describe("confirmed duplicate alerts and uncertain images (synthetic only)", () => {
  test("finalizer loads the original batch market, excludes duplicate, and preserves accounting counts", async () => {
    const db = database();
    db.tables.slip_evidences.push(image("unique", "source-current", "current-batch", { batch_index: 2 }));
    db.tables.slip_checks.push(check("unique-check", "unique", { reference_id: "SYNTHETIC-UNIQUE", transfer_amount: 50 }));
    db.tables.slip_checks[0].reference_id = "  SYNTHETIC-REF-001  ";
    const before = structuredClone(db.tables);
    const text = await finalize(db);
    expect(text).toContain("🚨🟥 พบสลิปซ้ำ");
    expect(text).toContain("รูปที่ 1 — 75 บาท: สลิปซ้ำ (ข้ามกลุ่ม/ตลาด) ตลาดต้นทาง: ตลาดสังเคราะห์ต้นทาง");
    expect(text).toContain("อ่านยอดได้: 1 รูป");
    expect(text).toContain("ยอดรวมที่อ่านได้: 50 บาท");
    expect(text).not.toContain("รูปที่ 1 =");
    expect(text.split("⚠️ หมายเหตุ")[1] ?? "").not.toContain("สลิปซ้ำ (");
    expect(db.updates).toEqual([expect.objectContaining({ success_count: 1, failed_count: 1, status: "review_needed" })]);
    expect(db.tables).toEqual(before);
    expect(text).not.toContain("SYNTHETIC-REF-001");
  });

  test("same source uses stored original market even when the current market differs", async () => {
    const db = database();
    db.tables.slip_evidences[1].source_id = "source-current";
    const text = await finalize(db);
    expect(text).toContain("สลิปซ้ำ (กลุ่มเดิม) ตลาดต้นทาง: ตลาดสังเคราะห์ต้นทาง");
    expect(text).not.toContain("ข้ามกลุ่ม/ตลาด");
  });

  test("equal market labels do not make distinct sources the same source", async () => {
    const db = database();
    db.tables.slip_batches[1].market_name = db.tables.slip_batches[0].market_name;
    expect(await finalize(db)).toContain("สลิปซ้ำ (ข้ามกลุ่ม/ตลาด)");
  });

  test("missing market or metadata lookup failure uses the explicit fallback", async () => {
    for (const mode of ["missing-batch", "blank-market", "batch-error", "evidence-error"]) {
      const db = database({ fail: (q) => mode === "batch-error" ? q.table === "slip_batches" && q.columns === "market_name"
        : mode === "evidence-error" && q.table === "slip_evidences" && q.columns === "source_id, batch_id" });
      if (mode === "missing-batch") db.tables.slip_batches.pop();
      if (mode === "blank-market") db.tables.slip_batches[1].market_name = "  ";
      const alert = (await finalize(db)).split("🚨🟥")[1];
      expect(alert).toContain("ไม่ทราบตลาดต้นทาง");
      expect(alert).not.toContain("ตลาดสังเคราะห์ปัจจุบัน");
      if (mode === "evidence-error") expect(alert).toContain("ยังไม่ทราบกลุ่มต้นทาง");
    }
  });

  test("NEED_REVIEW with bank-decoded reference is checked against accepted records", async () => {
    const db = database();
    Object.assign(db.tables.slip_checks[0], { status: "NEED_REVIEW", extracted_json: {
      verification: { provider: "easyslip", bank_verified: false, duplicate: false, receiver_account_matched: false },
    } });
    const text = await finalize(db);
    expect(text).toContain("🚨🟥 พบสลิปซ้ำ");
    expect(text).toContain("ตลาดต้นทาง: ตลาดสังเคราะห์ต้นทาง");
    expect(text).not.toContain("ยอดรวมที่อ่านได้: 75 บาท");
    expect(db.updates[0]).toMatchObject({ success_count: 0, failed_count: 1 });
  });

  test("OCR-only text matching an accepted reference does not establish a duplicate", async () => {
    const db = database();
    Object.assign(db.tables.slip_checks[0], { status: "NEED_REVIEW", extracted_json: fallback });
    db.tables.slip_evidences[0].sha256 = "b2".repeat(32);
    const text = await finalize(db);
    expect(text).toContain("ยอดรวมที่อ่านได้: 75 บาท");
    expect(text).toContain("ยังตรวจสอบสลิปซ้ำข้ามตลาดไม่ได้");
    expect(text).not.toContain("🚨");
    expect(db.updates[0]).toMatchObject({ success_count: 0, failed_count: 1 });
  });

  test("identical received image SHA and byte size backed by an accepted check confirms OCR-only duplicate", async () => {
    const db = database();
    Object.assign(db.tables.slip_checks[0], { status: "NEED_REVIEW", reference_id: null, extracted_json: fallback });
    const text = await finalize(db);
    expect(text).toContain("รูปที่ 1 — 75 บาท: สลิปซ้ำ (ข้ามกลุ่ม/ตลาด) ตลาดต้นทาง: ตลาดสังเคราะห์ต้นทาง");
    expect(text).not.toContain("ยอดรวมที่อ่านได้: 75 บาท");
    expect(db.updates[0]).toMatchObject({ success_count: 0, failed_count: 1 });
  });

  test("placeholder/malformed hashes, missing bytes, failed downloads, different bytes and unaccepted originals never confirm", async () => {
    for (const changes of [
      { sha256: "0".repeat(64) }, { sha256: "fuzzy" }, { sha256: "a1".repeat(31) },
      { byte_size: 0 }, { byte_size: null }, { byte_size: 124 }, { status: "DOWNLOAD_FAILED" },
      { originalStatus: "NEED_REVIEW" }, { originalStatus: "FAILED" },
    ]) {
      const db = database();
      Object.assign(db.tables.slip_evidences[0], changes);
      Object.assign(db.tables.slip_checks[0], { status: "NEED_REVIEW", reference_id: null, extracted_json: fallback });
      if (changes.originalStatus) db.tables.slip_checks[1].status = changes.originalStatus;
      const text = await finalize(db);
      expect(text).toContain("ยอดรวมที่อ่านได้: 75 บาท");
      expect(text).toContain("ยังตรวจสอบสลิปซ้ำข้ามตลาดไม่ได้");
      expect(text).not.toContain("🚨");
    }
  });

  test("missing, fuzzy, case-different and punctuation-different references never match", async () => {
    for (const referenceId of [null, "  ", "synthetic-ref-001", "SYNTHETICREF001", "SYNTHETIC-REF-00?"]) {
      const db = database();
      const marked = await applyGlobalDuplicateExclusions(db.db, [review({ referenceId, referenceTrusted: true })]);
      expect(marked[0].globallyDuplicate).toBe(false);
      const text = buildBatchSummaryMessage(marked);
      expect(text).toContain("ยอดรวมที่อ่านได้: 75 บาท");
      expect(text).not.toContain("🚨");
      expect(text).toContain("ยังตรวจสอบสลิปซ้ำข้ามตลาดไม่ได้");
    }
  });

  test("review reference lookup failure leaves readable amount unverified, without uniqueness claim", async () => {
    const db = database({ fail: (q) => q.table === "slip_checks" });
    const marked = await applyGlobalDuplicateExclusions(db.db, [review({ referenceTrusted: true })]);
    expect(marked[0].globallyDuplicate).toBe(false);
    const text = buildBatchSummaryMessage(marked);
    expect(text).toContain("ยอดรวมที่อ่านได้: 75 บาท");
    expect(text).toContain("ยังตรวจสอบสลิปซ้ำข้ามตลาดไม่ได้");
    expect(text).not.toContain("🚨");
  });

  test("hash lookup failure leaves the OCR amount unverified", async () => {
    for (const failedTable of ["slip_evidences", "slip_checks"]) {
      const db = database({ fail: (q) => q.table === failedTable });
      const marked = await applyGlobalDuplicateExclusions(db.db, [review({ sha256: hash, byteSize: 123, evidenceStatus: "RECEIVED" })]);
      expect(marked[0].globallyDuplicate).toBe(false);
      expect(buildBatchSummaryMessage(marked)).toContain("ยอดรวมที่อ่านได้: 75 บาท");
      expect(buildBatchSummaryMessage(marked)).toContain("ยังตรวจสอบสลิปซ้ำข้ามตลาดไม่ได้");
    }
  });

  test("accepted-reference lookup failure still fails closed before send or accounting writes", async () => {
    const db = database({ fail: (q) => q.table === "slip_checks" && q.columns.startsWith("id, reference_id") });
    const sent: string[] = [];
    await expect(finalizeSlipBatch(db.db, "current-batch", async (text) => { sent.push(text); })).rejects.toThrow("synthetic lookup failure");
    expect(sent).toEqual([]);
    expect(db.updates).toEqual([]);
  });

  test("self/retry is not a duplicate and earliest accepted original wins deterministically", async () => {
    const db = database();
    const marked = await applyGlobalDuplicateExclusions(db.db, [review({ checkId: "original-check", checkStatus: "EXTRACTED" })]);
    expect(marked[0].globallyDuplicate).toBe(false);
    db.tables.slip_evidences.push(image("later", "source-later", "later-batch"));
    db.tables.slip_checks.unshift(check("later-check", "later", { created_at: "2026-10-30T10:00:00Z" }));
    expect(await finalize(db)).toContain("ตลาดต้นทาง: ตลาดสังเคราะห์ต้นทาง");
  });
});
