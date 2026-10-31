import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  finalizeSlipBatch,
  buildBatchSummaryMessage,
  parseAbandonedMinutes,
  SlipAccountingUnavailableError,
} from "./batch-finalizer";
import type { Database } from "@/types/database";

// ── parseAbandonedMinutes ──────────────────────────────────────────────────

describe("parseAbandonedMinutes", () => {
  it("returns 60 for undefined", () => {
    expect(parseAbandonedMinutes(undefined)).toBe(60);
  });

  it("returns 60 for empty string", () => {
    expect(parseAbandonedMinutes("")).toBe(60);
  });

  it("returns 60 for non-numeric string", () => {
    expect(parseAbandonedMinutes("abc")).toBe(60);
  });

  it("returns 60 for zero", () => {
    expect(parseAbandonedMinutes("0")).toBe(60);
  });

  it("returns 60 for negative number", () => {
    expect(parseAbandonedMinutes("-5")).toBe(60);
  });

  it("returns 60 for NaN-producing input (empty string via parseInt)", () => {
    // parseInt("", 10) = NaN; Math.max(1, NaN) = NaN — the old bug.
    // parseAbandonedMinutes must return 60 instead.
    expect(parseAbandonedMinutes("")).toBe(60);
    expect(Number.isFinite(parseAbandonedMinutes(""))).toBe(true);
  });

  it("returns 30 for '30'", () => {
    expect(parseAbandonedMinutes("30")).toBe(30);
  });

  it("returns 60 for '60'", () => {
    expect(parseAbandonedMinutes("60")).toBe(60);
  });

  it("returns 1 for '1' (minimum positive)", () => {
    expect(parseAbandonedMinutes("1")).toBe(1);
  });

  it("returns 480 for '480'", () => {
    expect(parseAbandonedMinutes("480")).toBe(480);
  });
});

// ── finalizeSlipBatch delivery state ──────────────────────────────────────

/** Accounting RPC as seen on a pre-migration schema: function not in schema cache. */
const LEGACY_SCHEMA_RPC = async () => ({
  data: null,
  error: { code: "PGRST202", message: "Could not find the function public.slip_batch_image_accounting" },
});

/**
 * Minimal supabase stub for finalizeSlipBatch tests.
 *
 * All slip_batches updates are captured in `statusUpdates`.
 * slip_evidences always returns empty (simplest path, avoids slip_checks query).
 */
function makeFinalizerSupabase({
  batchData,
  updateError = null,
  statusUpdates = [],
}: {
  batchData: Record<string, unknown> | null;
  updateError?: { message: string } | null;
  statusUpdates?: Array<Record<string, unknown>>;
}): SupabaseClient<Database> {
  return {
    rpc: LEGACY_SCHEMA_RPC,
    from(table: string) {
      if (table === "slip_batches") {
        return {
          select() {
            return {
              eq(_col: string, _val: unknown) {
                return {
                  async maybeSingle() {
                    return { data: batchData, error: null };
                  },
                };
              },
            };
          },
          update(values: Record<string, unknown>) {
            statusUpdates.push(values);
            return {
              eq(_col: string, _val: unknown) {
                return Promise.resolve({ data: null, error: updateError });
              },
            };
          },
        };
      }

      if (table === "slip_evidences") {
        return {
          select() {
            return {
              eq(_col: string, _val: unknown) {
                return {
                  order(_col2: string, _opts: unknown) {
                    return Promise.resolve({ data: [], error: null });
                  },
                };
              },
            };
          },
        };
      }

      if (table === "slip_checks") {
        return {
          select() {
            return {
              in(_col: string, _vals: unknown[]) {
                return Promise.resolve({ data: [], error: null });
              },
            };
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient<Database>;
}

describe("finalizeSlipBatch delivery state", () => {
  it("skips silently when summary_sent_at is already set (idempotency guard)", async () => {
    const statusUpdates: Array<Record<string, unknown>> = [];
    const supabase = makeFinalizerSupabase({
      batchData: { id: "batch-1", summary_sent_at: "2026-01-01T00:00:00Z" },
      statusUpdates,
    });

    let sendCalled = false;
    await finalizeSlipBatch(supabase, "batch-1", async () => { sendCalled = true; });

    expect(sendCalled).toBe(false);
    expect(statusUpdates).toHaveLength(0);
  });

  // ── Fix 3: LINE failure handling ───────────────────────────────────────────

  it("does NOT revert to collecting when LINE push fails before send", async () => {
    const statusUpdates: Array<Record<string, unknown>> = [];
    const supabase = makeFinalizerSupabase({
      batchData: { id: "batch-1", summary_sent_at: null },
      statusUpdates,
    });

    // sendMessage throws before messageSent is set — pre-send failure
    await expect(
      finalizeSlipBatch(supabase, "batch-1", async () => {
        throw new Error("LINE API error");
      }),
    ).rejects.toThrow("LINE API error");

    // Must NOT revert to collecting — that would re-open image collection on a
    // closed batch (batch was already transitioned from closing→processing by caller)
    const revert = statusUpdates.find((u) => u.status === "collecting");
    expect(revert).toBeUndefined();

    // Must NOT permanently mark as failed (that would block manual retry)
    const permanentFail = statusUpdates.find((u) => u.status === "failed");
    expect(permanentFail).toBeUndefined();

    // Batch must stay in 'processing' (no status update at all)
    const anyStatusUpdate = statusUpdates.find((u) => "status" in u);
    expect(anyStatusUpdate).toBeUndefined();
  });

  it("definite LINE rejection (4xx): batch stays in processing for manual retry", async () => {
    const statusUpdates: Array<Record<string, unknown>> = [];
    const supabase = makeFinalizerSupabase({
      batchData: { id: "batch-1", summary_sent_at: null },
      statusUpdates,
    });

    // Simulates LINE returning HTTP 400 (definite rejection — message not sent)
    await expect(
      finalizeSlipBatch(supabase, "batch-1", async () => {
        throw new Error("LINE push HTTP 400");
      }),
    ).rejects.toThrow("LINE push HTTP 400");

    // Batch must stay in processing (summary_sent_at is still null)
    expect(statusUpdates.find((u) => u.status === "collecting")).toBeUndefined();
    expect(statusUpdates.find((u) => u.status === "failed")).toBeUndefined();
  });

  it("ambiguous network failure: batch stays in processing, no revert, no duplicate path", async () => {
    const statusUpdates: Array<Record<string, unknown>> = [];
    const supabase = makeFinalizerSupabase({
      batchData: { id: "batch-1", summary_sent_at: null },
      statusUpdates,
    });

    // Simulates a network error where delivery status is unknown
    await expect(
      finalizeSlipBatch(supabase, "batch-1", async () => {
        throw new Error("LINE push network error");
      }),
    ).rejects.toThrow("LINE push network error");

    // Batch stays in processing — cron will not auto-retry (only handles closing)
    // No revert to collecting — uncontrolled duplicate sends prevented
    expect(statusUpdates.find((u) => u.status === "collecting")).toBeUndefined();
  });

  it("returns persistence_failed result when DB update fails after successful LINE send", async () => {
    const statusUpdates: Array<Record<string, unknown>> = [];
    const supabase = makeFinalizerSupabase({
      batchData: { id: "batch-1", summary_sent_at: null },
      updateError: { message: "db connection lost" },
      statusUpdates,
    });

    let sendCalled = false;

    // sendMessage succeeds (messageSent=true), then the DB update fails.
    // The function must NOT throw — LINE already delivered the message.
    // Instead it returns a structured { delivered:true, persisted:false } result
    // so the caller (recovery endpoint) can surface the failure correctly.
    const result = await finalizeSlipBatch(supabase, "batch-1", async () => { sendCalled = true; });

    expect(sendCalled).toBe(true);
    expect(result).toMatchObject({ delivered: true, persisted: false });
    expect((result as { persistError?: string })?.persistError).toContain("db connection lost");

    // Update was attempted (the failed one)
    expect(statusUpdates.length).toBeGreaterThan(0);
    // No revert to collecting — summary already delivered, reverting would allow duplicate send
    const revert = statusUpdates.find((u) => u.status === "collecting");
    expect(revert).toBeUndefined();
  });

  it("repeated cron execution does not send duplicate summary (idempotency guard)", async () => {
    // Simulates a second cron call on a batch that was already summarized.
    const sendCalls: string[] = [];
    const supabase = makeFinalizerSupabase({
      batchData: { id: "batch-1", summary_sent_at: "2026-01-01T00:00:00Z" },
    });

    await finalizeSlipBatch(supabase, "batch-1", async (text) => { sendCalls.push(text); });

    expect(sendCalls).toHaveLength(0);
  });
});

// ── finalizeSlipBatch: validation-guard-derived counters ──────────────────

describe("finalizeSlipBatch: success_count and failed_count use validation-guard results", () => {
  function makeFinalizerWithEvidences(
    items: Array<{ transferAmount: number; transactionTime?: string | null }>,
    capturedUpdates: Array<Record<string, unknown>>,
    rpc: () => Promise<{ data: unknown; error: { code?: string; message: string } | null }> = LEGACY_SCHEMA_RPC,
    migratedSchema = false,
    ledger: Array<{ line_message_id: string; event_ts_ms: number; state: string }> = [],
  ): SupabaseClient<Database> {
    const evidenceRows = items.map((_, i) => ({ id: `ev-${i + 1}`, batch_index: i + 1, line_message_id: `m-${i + 1}` }));
    const ledgerRows = ledger.map((row) => ({ ...row, raw_message_id: `raw-${row.line_message_id}` }));
    const checkRows = items.map((item, i) => ({
      evidence_id:      `ev-${i + 1}`,
      status:           "EXTRACTED" as const,
      slip_type:        "BANK_SLIP_QR" as const,
      transfer_amount:  item.transferAmount,
      paid_amount:      null,
      transaction_time: item.transactionTime ?? null,
      failure_reason:   null,
    }));

    return {
      rpc: rpc,
      from(table: string) {
        if (table === "slip_batches") {
          return {
            select() {
              return {
                eq(_c: string, _v: unknown) {
                  return {
                    async maybeSingle() {
                      return { data: { id: "batch-1", summary_sent_at: null, slip_date: null, ...(migratedSchema ? { open_event_ts_ms: null } : {}) }, error: null };
                    },
                  };
                },
              };
            },
            update(values: Record<string, unknown>) {
              capturedUpdates.push(values);
              return {
                eq(_c: string, _v: unknown) {
                  return Promise.resolve({ data: null, error: null });
                },
              };
            },
          };
        }
        if (table === "slip_evidences") {
          return {
            select() {
              return {
                eq(_c: string, _v: unknown) {
                  return {
                    order(_c2: string, _opts: unknown) {
                      return Promise.resolve({ data: evidenceRows, error: null });
                    },
                  };
                },
              };
            },
          };
        }
        if (table === "slip_checks") {
          return {
            select() {
              return {
                in(_c: string, _vals: unknown[]) {
                  return Promise.resolve({ data: checkRows, error: null });
                },
              };
            },
          };
        }
        if (table === "slip_image_events") {
          return { select: () => ({ eq: () => Promise.resolve({ data: ledgerRows, error: null }) }) };
        }
        if (table === "raw_messages") {
          const raws = ledgerRows.map((row) => ({ id: row.raw_message_id, payload: { timestamp: row.event_ts_ms } }));
          return { select: () => ({ in: () => Promise.resolve({ data: raws, error: null }) }) };
        }
        throw new Error(`Unexpected table: ${table}`);
      },
    } as unknown as SupabaseClient<Database>;
  }

  it("success_count reflects guard-filtered trusted count, not raw EXTRACTED count", async () => {
    const capturedUpdates: Array<Record<string, unknown>> = [];
    const supabase = makeFinalizerWithEvidences(
      [
        { transferAmount: 100 },
        { transferAmount: 100 },
        { transferAmount: 100 },
        { transferAmount: 100 },
        { transferAmount: 100 },
        { transferAmount: 50000 }, // outlier: >= 5000 and >= 10x median(100)
      ],
      capturedUpdates,
    );

    await finalizeSlipBatch(supabase, "batch-1", async () => {});

    const dbUpdate = capturedUpdates.find((u) => "success_count" in u);
    // Raw EXTRACTED count would be 6; validation-guard count is 5 (outlier excluded).
    expect(dbUpdate?.success_count).toBe(5);
    expect(dbUpdate?.failed_count).toBe(1);
    expect(dbUpdate?.status).toBe("review_needed");
  });

  // ── Fail-closed ledger accounting (PR182 P0 #1) ──────────────────────────
  // 2 images received, 1 attached; accounting RPC unavailable. Must not send a
  // summary or write a status; batch stays processing (summary_sent_at null)
  // so the stale-processing sweep retries it.
  const oneAttached = [{ transferAmount: 100 }];

  it("RPC error 57014 (timeout): throws, no summary sent, no batch update", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const sent: string[] = [];
    const supabase = makeFinalizerWithEvidences(oneAttached, updates, async () => ({
      data: null,
      error: { code: "57014", message: "canceling statement due to statement timeout" },
    }));

    await expect(
      finalizeSlipBatch(supabase, "batch-1", async (t) => { sent.push(t); }),
    ).rejects.toThrow("57014");

    expect(sent).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("RPC throws: no summary sent, no batch update, error propagates for retry", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const sent: string[] = [];
    const supabase = makeFinalizerWithEvidences(oneAttached, updates, async () => {
      throw new Error("fetch failed");
    });

    await expect(
      finalizeSlipBatch(supabase, "batch-1", async (t) => { sent.push(t); }),
    ).rejects.toThrow("fetch failed");

    expect(sent).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("RPC returns no error but empty/malformed payload: fails closed", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const sent: string[] = [];
    const supabase = makeFinalizerWithEvidences(oneAttached, updates, async () => ({ data: null, error: null }));

    await expect(
      finalizeSlipBatch(supabase, "batch-1", async (t) => { sent.push(t); }),
    ).rejects.toThrow("malformed");

    expect(sent).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("RPC returns a partial payload (missing counters): fails closed, nothing sent or written", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const sent: string[] = [];
    const supabase = makeFinalizerWithEvidences(oneAttached, updates, async () => ({
      data: { received_total: 2, attached: 1 },
      error: null,
    }));

    await expect(
      finalizeSlipBatch(supabase, "batch-1", async (t) => { sent.push(t); }),
    ).rejects.toThrow("malformed");

    expect(sent).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("accounting failure is a typed error so recovery can surface it", async () => {
    const supabase = makeFinalizerWithEvidences(oneAttached, [], async () => ({
      data: null,
      error: { code: "57014", message: "statement timeout" },
    }));
    await expect(
      finalizeSlipBatch(supabase, "batch-1", async () => {}),
    ).rejects.toBeInstanceOf(SlipAccountingUnavailableError);
  });

  for (const code of ["PGRST202", "42883"]) {
    it(`missing RPC ${code} on a migrated schema: fails closed, never certifies partial totals`, async () => {
      const updates: Array<Record<string, unknown>> = [];
      const sent: string[] = [];
      const supabase = makeFinalizerWithEvidences(
        oneAttached,
        updates,
        async () => ({ data: null, error: { code, message: "function unavailable" } }),
        true,
      );
      await expect(
        finalizeSlipBatch(supabase, "batch-1", async (text) => { sent.push(text); }),
      ).rejects.toThrow(code);
      expect(sent).toHaveLength(0);
      expect(updates).toHaveLength(0);
    });
  }

  it("explicit legacy schema (PGRST202 function missing): still finalizes from evidence", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const sent: string[] = [];
    const supabase = makeFinalizerWithEvidences(oneAttached, updates, LEGACY_SCHEMA_RPC);

    await finalizeSlipBatch(supabase, "batch-1", async (t) => { sent.push(t); });

    expect(sent).toHaveLength(1);
    expect(updates.find((u) => "success_count" in u)?.status).toBe("completed");
  });

  it("ledger accounting reporting missing images: summary carries notice, not completed", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const sent: string[] = [];
    const supabase = makeFinalizerWithEvidences(oneAttached, updates, async () => ({
      data: {
        received_total: 2, attached: 1, waiting: 0, retry_pending: 0, queue_dead: 0,
        failed_permanent: 1, late_after_finalize: 0, incomplete: 1,
      },
      error: null,
    }), false, [
      // The failed image was sent FIRST in LINE; the attached one second.
      { line_message_id: "m-0", event_ts_ms: 1_000, state: "failed_permanent" },
      { line_message_id: "m-1", event_ts_ms: 2_000, state: "attached" },
    ]);

    await finalizeSlipBatch(supabase, "batch-1", async (t) => { sent.push(t); });

    expect(sent[0]).toContain("ยังไม่ครบ: 1 รูป");
    // batch_index of the attached evidence is 1, but it is the 2nd image in LINE.
    expect(sent[0]).toContain("#1 รูปเข้าระบบไม่สำเร็จ");
    expect(sent[0]).toContain("#2 เช็คได้ 100 บาท");
    expect(sent[0]).toContain("รับทั้งหมด: 2 รูป");
    expect(sent[0]).not.toContain("ยืนยันลำดับจาก LINE ไม่ได้");
    const update = updates.find((u) => "success_count" in u);
    expect(update?.status).toBe("review_needed");
    expect(update?.failed_count).toBe(1);
  });
});

// ── buildBatchSummaryMessage — timeout breakdown ──────────────────────────

describe("buildBatchSummaryMessage timeout breakdown", () => {
  const makeEvidence = (
    status: import("@/types/database").SlipCheckStatus | null,
    idx: number,
  ) => ({
    id:              `ev-${idx}`,
    batchIndex:      idx,
    checkStatus:     status,
    slipType:        "BANK_SLIP_QR" as const,
    transferAmount:  (status === "EXTRACTED" || status === "PARTIAL_EXTRACTED") ? 1000 : null,
    paidAmount:      null,
    transactionTime: null,
    failureReason:   null,
  });

  it("shows completed / failed / pending separately when isTimeout=true", () => {
    const evidences = [
      makeEvidence("EXTRACTED",         1),
      makeEvidence("PARTIAL_EXTRACTED", 2),
      makeEvidence("FAILED",            3),
      makeEvidence("NEED_REVIEW",       4),
      makeEvidence("PROCESSING",        5),
      makeEvidence(null,                6), // no check row yet
    ];
    const msg = buildBatchSummaryMessage(evidences, { isTimeout: true });

    expect(msg).toContain("รับทั้งหมด: 6 รูป");
    expect(msg).toContain("อ่านครบ: 2 รูป");
    expect(msg).toContain("อ่านไม่สำเร็จ: 1 รูป");
    expect(msg).toContain("รอตรวจมือ: 1 รูป");
    expect(msg).toContain("รอประมวลผล: 2 รูป");
  });

  it("PROCESSING counts as pending (not completed)", () => {
    const evidences = [makeEvidence("PROCESSING", 1)];
    const msg = buildBatchSummaryMessage(evidences, { isTimeout: true });
    expect(msg).toContain("อ่านครบ: 0 รูป");
    expect(msg).toContain("รอประมวลผล: 1 รูป");
  });

  it("null check row (OCR not started) counts as pending", () => {
    const evidences = [makeEvidence(null, 1)];
    const msg = buildBatchSummaryMessage(evidences, { isTimeout: true });
    expect(msg).toContain("รอประมวลผล: 1 รูป");
  });

  it("FAILED counts as failed extraction (not pending)", () => {
    const evidences = [makeEvidence("FAILED", 1)];
    const msg = buildBatchSummaryMessage(evidences, { isTimeout: true });
    expect(msg).toContain("อ่านไม่สำเร็จ: 1 รูป");
    expect(msg).not.toContain("รอประมวลผล: 1 รูป");
  });

  it("uses (หมดเวลา) label for timeout summary with no title", () => {
    const evidences = [makeEvidence("PROCESSING", 1), makeEvidence("EXTRACTED", 2)];
    const msg = buildBatchSummaryMessage(evidences, { isTimeout: true });
    expect(msg).toContain("หมดเวลา");
  });

  it("uses custom title when provided with timeout and shows detailed breakdown", () => {
    const evidences = [makeEvidence("PROCESSING", 1)];
    const msg = buildBatchSummaryMessage(evidences, {
      title: "สรุปชุดสลิปเงินโอน กี้ — วัดทุ่งลานนา",
      isTimeout: true,
    });
    expect(msg).toContain("กี้");
    // Custom title is used as-is; breakdown must still be present
    expect(msg).toContain("รอประมวลผล: 1 รูป");
    expect(msg).toContain("อ่านครบ: 0 รูป");
  });

  it("falls back to normal rendering when isTimeout=true but all checks terminal (no pending/failed)", () => {
    // All completed — no reason to show timeout breakdown
    const evidences = [makeEvidence("EXTRACTED", 1), makeEvidence("NEED_REVIEW", 2)];
    const msg = buildBatchSummaryMessage(evidences, { isTimeout: true });
    // Normal rendering: "รอตรวจมือ" not "รอประมวลผล" / "อ่านไม่สำเร็จ"
    expect(msg).toContain("อ่านครบ: 1 รูป");
    expect(msg).toContain("รอตรวจมือ: 1 รูป");
    expect(msg).not.toContain("รอประมวลผล");
  });

  it("non-timeout rendering is unchanged", () => {
    const evidences = [
      makeEvidence("EXTRACTED",   1),
      makeEvidence("NEED_REVIEW", 2),
    ];
    const msg = buildBatchSummaryMessage(evidences);
    expect(msg).toContain("รับทั้งหมด: 2 รูป");
    expect(msg).toContain("อ่านครบ: 1 รูป");
    expect(msg).toContain("รอตรวจมือ: 1 รูป");
    expect(msg).not.toContain("รอประมวลผล");
    expect(msg).not.toContain("อ่านไม่สำเร็จ");
  });
});

// ── buildBatchSummaryMessage — trusted slip lines ───────────────────────────

describe("buildBatchSummaryMessage trusted slip lines", () => {
  const makeEvidence = (
    status: import("@/types/database").SlipCheckStatus | null,
    idx: number,
    options?: { transactionTime?: string | null; transferAmount?: number },
  ) => ({
    id:              `ev-${idx}`,
    batchIndex:      idx,
    checkStatus:     status,
    slipType:        "BANK_SLIP_QR" as const,
    transferAmount:  options?.transferAmount ?? (
      (status === "EXTRACTED" || status === "PARTIAL_EXTRACTED") ? 1000 : null
    ),
    paidAmount:      null,
    transactionTime: options?.transactionTime ?? "2026-06-10T10:00:00Z",
    failureReason:   null,
  });

  it("lists trusted slips with เช็คได้ in normal summary", () => {
    const evidences = [
      makeEvidence("EXTRACTED",         2),
      makeEvidence("PARTIAL_EXTRACTED", 5),
      makeEvidence("NEED_REVIEW",       9),
    ];
    const msg = buildBatchSummaryMessage(evidences, { slipDate: "10/6/2569" });

    expect(msg).toContain("รูปที่ตรวจผ่าน:");
    expect(msg).toContain("#2 เช็คได้ 1,000 บาท");
    expect(msg).toContain("#5 เช็คได้ 1,000 บาท");
    expect(msg).toContain("รูปที่ต้องตรวจมือ:");
    expect(msg).toContain("#9 ไม่พบข้อมูลครบถ้วน");
    expect(msg.indexOf("รูปที่ตรวจผ่าน:")).toBeLessThan(msg.indexOf("รูปที่ต้องตรวจมือ:"));
  });

  it("omits trusted section when no slips pass validation", () => {
    const evidences = [
      makeEvidence("NEED_REVIEW", 1),
      makeEvidence("FAILED",      2),
    ];
    const msg = buildBatchSummaryMessage(evidences);

    expect(msg).not.toContain("รูปที่ตรวจผ่าน:");
    expect(msg).not.toContain("เช็คได้");
  });

  it("lists trusted slips in timeout summary before incomplete section", () => {
    const evidences = [
      makeEvidence("EXTRACTED",   36, { transactionTime: "2026-06-10T12:00:00Z" }),
      makeEvidence("PROCESSING",  5),
    ];
    const msg = buildBatchSummaryMessage(evidences, {
      isTimeout: true,
      slipDate:  "10/6/2569",
    });

    expect(msg).toContain("รูปที่ตรวจผ่าน:");
    expect(msg).toContain("#36 เช็คได้ 1,000 บาท");
    expect(msg).toContain("รูปที่ยังไม่ครบ:");
    expect(msg).toContain("#5 รอผลการตรวจสอบ");
  });

  it("does not list guard-flagged slips as เช็คได้", () => {
    const evidences = [
      makeEvidence("EXTRACTED", 1, { transactionTime: "2026-06-10T10:00:00Z" }),
      makeEvidence("EXTRACTED", 4, { transactionTime: "2026-06-08T10:00:00Z" }),
    ];
    const msg = buildBatchSummaryMessage(evidences, { slipDate: "10/6/2569" });

    expect(msg).toContain("#1 เช็คได้");
    expect(msg).not.toContain("#4 เช็คได้");
    expect(msg).toContain("#4 วันที่รายการไม่ตรงกับรอบ");
  });

  it("shows the per-slip amount next to เช็คได้ for trusted slips", () => {
    const evidences = [
      makeEvidence("EXTRACTED",         2, { transferAmount: 1117.8 }),
      makeEvidence("PARTIAL_EXTRACTED", 7, { transferAmount: 250 }),
    ];
    const msg = buildBatchSummaryMessage(evidences, { slipDate: "10/6/2569" });

    expect(msg).toContain("#2 เช็คได้ 1,117.8 บาท");
    expect(msg).toContain("#7 เช็คได้ 250 บาท");
  });

  it("falls back to plain เช็คได้ when a trusted slip has no effective amount", () => {
    // GWALLET resolves effective amount from paid_amount; transfer_amount alone
    // is not enough, so effectiveAmount is null and we omit the amount suffix.
    const evidences = [
      {
        id:              "ev-3",
        batchIndex:      3,
        checkStatus:     "EXTRACTED" as const,
        slipType:        "GWALLET" as const,
        transferAmount:  500,
        paidAmount:      null,
        transactionTime: "2026-06-10T10:00:00Z",
        failureReason:   null,
      },
    ];
    const msg = buildBatchSummaryMessage(evidences, { slipDate: "10/6/2569" });

    // GWALLET with no paid_amount → no effective amount → flagged as ข้อมูลไม่ครบ,
    // so it never appears in the trusted section. Guard against a regression where
    // a null-amount trusted slip would render "เช็คได้ undefined บาท".
    expect(msg).not.toContain("undefined");
  });
});
