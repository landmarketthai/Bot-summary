import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SlipBatchService } from "./batch-service";
import { buildBatchSummaryMessage, finalizeDueSlipBatches } from "./batch-finalizer";
import type { Database } from "@/types/database";

// ── RPC fake helpers ────────────────────────────────────────────────────────

type RpcResponse = { data: unknown; error: { message: string } | null };

function makeRpcSupabase(
  handler: (fn: string, args: unknown) => RpcResponse,
) {
  const calls: Array<{ fn: string; args: unknown }> = [];

  const client = {
    async rpc(fn: string, args: unknown) {
      calls.push({ fn, args });
      return handler(fn, args);
    },
    _calls: calls,
  };

  return client as unknown as SupabaseClient<Database> & {
    _calls: Array<{ fn: string; args: unknown }>;
  };
}

function batchRow(batchId: string, isNew: boolean) {
  return [{ batch_id: batchId, is_new_batch: isNew }];
}

// ── SlipBatchService.getOrCreateBatch ──────────────────────────────────────

describe("SlipBatchService.getOrCreateBatch", () => {
  it("creates a new batch when the RPC returns is_new_batch=true", async () => {
    const supabase = makeRpcSupabase(() => ({
      data: batchRow("batch-new", true),
      error: null,
    }));
    const service = new SlipBatchService(supabase);

    const result = await service.getOrCreateBatch("group-1", "group", "user-1");

    expect(result.isNewBatch).toBe(true);
    expect(result.batchId).toBe("batch-new");
  });

  it("returns existing batch when the RPC returns is_new_batch=false", async () => {
    const supabase = makeRpcSupabase(() => ({
      data: batchRow("batch-existing", false),
      error: null,
    }));
    const service = new SlipBatchService(supabase);

    const result = await service.getOrCreateBatch("group-1", "group", "user-1");

    expect(result.isNewBatch).toBe(false);
    expect(result.batchId).toBe("batch-existing");
  });

  it("passes all arguments to the RPC", async () => {
    const supabase = makeRpcSupabase(() => ({
      data: batchRow("batch-x", true),
      error: null,
    }));
    const service = new SlipBatchService(supabase);

    await service.getOrCreateBatch("src-abc", "group", "user-xyz");

    expect(supabase._calls[0]).toMatchObject({
      fn: "get_or_create_slip_batch",
      args: {
        p_source_id:   "src-abc",
        p_source_type: "group",
        p_sender_id:   "user-xyz",
        p_quiet_seconds: 20,
      },
    });
  });

  it("passes null sender_id through to the RPC (room / anonymous)", async () => {
    const supabase = makeRpcSupabase(() => ({
      data: batchRow("batch-room", true),
      error: null,
    }));
    const service = new SlipBatchService(supabase);

    const result = await service.getOrCreateBatch("room-1", "room", null);

    expect(supabase._calls[0]).toMatchObject({
      fn: "get_or_create_slip_batch",
      args: { p_sender_id: null },
    });
    expect(result.isNewBatch).toBe(true);
  });

  it("throws when the RPC returns an error", async () => {
    const supabase = makeRpcSupabase(() => ({
      data: null,
      error: { message: "db unavailable" },
    }));
    const service = new SlipBatchService(supabase);

    await expect(
      service.getOrCreateBatch("group-1", "group", "user-1"),
    ).rejects.toThrow("get_or_create_slip_batch failed");
  });

  it("throws when the RPC returns an empty array", async () => {
    const supabase = makeRpcSupabase(() => ({ data: [], error: null }));
    const service = new SlipBatchService(supabase);

    await expect(
      service.getOrCreateBatch("group-1", "group", "user-1"),
    ).rejects.toThrow("returned no row");
  });

  // Simulates what the DB-level advisory lock guarantees:
  // two concurrent TS calls for the same source/sender will get serialized
  // by the RPC so only one sees is_new_batch=true.
  it("concurrent calls receive at most one isNewBatch=true (DB lock simulation)", async () => {
    let callIndex = 0;
    const supabase = makeRpcSupabase(() => {
      callIndex += 1;
      // First call: batch created. Second call: existing batch found.
      return { data: batchRow("batch-shared", callIndex === 1), error: null };
    });
    const service = new SlipBatchService(supabase);

    const [r1, r2] = await Promise.all([
      service.getOrCreateBatch("group-1", "group", "user-1"),
      service.getOrCreateBatch("group-1", "group", "user-1"),
    ]);

    const ackCount = [r1, r2].filter((r) => r.isNewBatch).length;
    expect(ackCount).toBe(1);
    expect(r1.batchId).toBe("batch-shared");
    expect(r2.batchId).toBe("batch-shared");
  });
});

// ── SlipBatchService.attachEvidence ────────────────────────────────────────

describe("SlipBatchService.attachEvidence", () => {
  it("calls attach_evidence_to_slip_batch RPC with correct arguments", async () => {
    const supabase = makeRpcSupabase(() => ({ data: 1, error: null }));
    const service = new SlipBatchService(supabase);

    await service.attachEvidence("batch-1", "evidence-1");

    expect(supabase._calls).toEqual([{
      fn: "attach_evidence_to_slip_batch",
      args: { p_batch_id: "batch-1", p_evidence_id: "evidence-1" },
    }]);
  });

  it("throws when the RPC returns an error", async () => {
    const supabase = makeRpcSupabase(() => ({
      data: null,
      error: { message: "batch not found" },
    }));
    const service = new SlipBatchService(supabase);

    await expect(service.attachEvidence("batch-x", "ev-x")).rejects.toThrow(
      "Failed to attach evidence to batch",
    );
  });
});

// ── buildBatchSummaryMessage ────────────────────────────────────────────────

describe("buildBatchSummaryMessage", () => {
  it("returns all-failed message when every slip needs review", () => {
    const msg = buildBatchSummaryMessage([
      { id: "e1", batchIndex: 1, checkStatus: "NEED_REVIEW", slipType: null, transferAmount: null, paidAmount: null, transactionTime: null, failureReason: null },
      { id: "e2", batchIndex: 2, checkStatus: "FAILED",      slipType: null, transferAmount: null, paidAmount: null, transactionTime: null, failureReason: null },
    ]);
    expect(msg).toContain("ส่งสลิปมาทั้งหมด: 2 รูป");
    expect(msg).toContain("อ่านยอดได้: 0 รูป");
    expect(msg).toContain("ยังรวมยอดไม่ได้");
    expect(msg).toContain("⚠️ หมายเหตุ");
  });

  it("includes totals and review list for partial success", () => {
    const msg = buildBatchSummaryMessage([
      { id: "e1", batchIndex: 1, checkStatus: "EXTRACTED",   slipType: "BANK_SLIP_QR", transferAmount: 1000, paidAmount: null, transactionTime: null, failureReason: null },
      { id: "e2", batchIndex: 2, checkStatus: "NEED_REVIEW", slipType: null,           transferAmount: null, paidAmount: null, transactionTime: null, failureReason: null },
      { id: "e3", batchIndex: 3, checkStatus: "EXTRACTED",   slipType: "BANK_SLIP_QR", transferAmount: 500,  paidAmount: null, transactionTime: null, failureReason: null },
    ]);
    expect(msg).toContain("สรุปสลิปเงินโอน");
    expect(msg).toContain("ส่งสลิปมาทั้งหมด: 3 รูป");
    expect(msg).toContain("อ่านยอดได้: 2 รูป");
    expect(msg).toContain("มีรูปที่ต้องตรวจทาน: 3 รูป (อาจซ้ำกับรูปที่อ่านยอดได้)");
    expect(msg).toContain("1,500");
    expect(msg).toContain("รูปที่ 2: อ่านวันที่โอนเงินไม่ชัด");
  });

  it("GWALLET slip uses paid_amount as the effective amount", () => {
    const msg = buildBatchSummaryMessage([
      { id: "e1", batchIndex: 1, checkStatus: "EXTRACTED", slipType: "GWALLET", transferAmount: null, paidAmount: 800, transactionTime: null, failureReason: null },
    ]);
    expect(msg).toContain("800");
  });

  it("omits amount line when effective amount is zero", () => {
    const msg = buildBatchSummaryMessage([
      { id: "e1", batchIndex: 1, checkStatus: "EXTRACTED", slipType: "BANK_SLIP_QR", transferAmount: 0, paidAmount: null, transactionTime: null, failureReason: null },
    ]);
    expect(msg).not.toContain("ยอดรวม");
  });

  it("all successful — no review section", () => {
    const msg = buildBatchSummaryMessage([
      { id: "e1", batchIndex: 1, checkStatus: "EXTRACTED",         slipType: "BANK_SLIP_QR", transferAmount: 300, paidAmount: null, transactionTime: "2026-10-30T08:41:00.000Z", failureReason: null },
      { id: "e2", batchIndex: 2, checkStatus: "PARTIAL_EXTRACTED", slipType: "BANK_SLIP_QR", transferAmount: 200, paidAmount: null, transactionTime: "2026-10-30T08:42:00.000Z", failureReason: null },
    ], { slipDate: "30/10/2569" });
    expect(msg).toContain("อ่านยอดได้: 2 รูป");
    expect(msg).not.toContain("⚠️ หมายเหตุ");
  });

  it("returns empty string for empty evidence list", () => {
    expect(buildBatchSummaryMessage([])).toBe("");
  });

  it("shows FAILED reason for known failure codes", () => {
    const msg = buildBatchSummaryMessage([
      { id: "e1", batchIndex: 1, checkStatus: "EXTRACTED", slipType: "BANK_SLIP_QR", transferAmount: 100, paidAmount: null, transactionTime: null, failureReason: null },
      { id: "e2", batchIndex: 2, checkStatus: "FAILED",    slipType: null,           transferAmount: null, paidAmount: null, transactionTime: null, failureReason: "evidence_download_failed" },
    ]);
    expect(msg).toContain("รูปที่ 2: ดาวน์โหลดรูปไม่สำเร็จ");
  });

  it("treats PROCESSING status as needing manual review", () => {
    const msg = buildBatchSummaryMessage([
      { id: "e1", batchIndex: 1, checkStatus: "EXTRACTED",  slipType: "BANK_SLIP_QR", transferAmount: 500, paidAmount: null, transactionTime: null, failureReason: null },
      { id: "e2", batchIndex: 2, checkStatus: "PROCESSING", slipType: null,           transferAmount: null, paidAmount: null, transactionTime: null, failureReason: null },
    ]);
    expect(msg).toContain("รูปที่ 2: รอผลการตรวจสอบ");
  });
});

// ── finalizeDueSlipBatches: abandoned-session cutoff ──────────────────────

describe("finalizeDueSlipBatches abandoned-session cutoff", () => {
  function makeClaimSupabase(capturedUpdates: Array<Record<string, unknown>>) {
    return {
      from(table: string) {
        if (table === "slip_batches") {
          return {
            update(values: Record<string, unknown>) {
              capturedUpdates.push(values);
              return {
                eq(_c: string, _v: unknown) {
                  return {
                    lte(_col: string, cutoff: string) {
                      capturedUpdates.push({ _lte_cutoff: cutoff });
                      return {
                        select() {
                          return Promise.resolve({ data: [], error: null });
                        },
                      };
                    },
                  };
                },
              };
            },
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      },
    } as unknown as SupabaseClient<Database>;
  }

  it("uses 60-minute default cutoff (no override)", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const supabase = makeClaimSupabase(updates);
    const before = Date.now();
    await finalizeDueSlipBatches(supabase);
    const after = Date.now();

    const cutoffEntry = updates.find((u) => "_lte_cutoff" in u);
    expect(cutoffEntry).toBeDefined();
    const cutoffMs = new Date(cutoffEntry!._lte_cutoff as string).getTime();
    // cutoff should be ~60 min before now
    expect(before - cutoffMs).toBeGreaterThanOrEqual(60 * 60 * 1000 - 100);
    expect(after - cutoffMs).toBeLessThan(61 * 60 * 1000 + 100);
  });

  it("respects injected abandonedMinutes override (30 min)", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const supabase = makeClaimSupabase(updates);
    const before = Date.now();
    await finalizeDueSlipBatches(supabase, undefined, 30);
    const after = Date.now();

    const cutoffEntry = updates.find((u) => "_lte_cutoff" in u);
    expect(cutoffEntry).toBeDefined();
    const cutoffMs = new Date(cutoffEntry!._lte_cutoff as string).getTime();
    expect(before - cutoffMs).toBeGreaterThanOrEqual(30 * 60 * 1000 - 100);
    expect(after - cutoffMs).toBeLessThan(31 * 60 * 1000 + 100);
  });

  it("does NOT claim batches idle for only 20 seconds (old quiet-window)", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const supabase = makeClaimSupabase(updates);
    await finalizeDueSlipBatches(supabase);

    const cutoffEntry = updates.find((u) => "_lte_cutoff" in u);
    const cutoffMs = new Date(cutoffEntry!._lte_cutoff as string).getTime();
    const twentySecondsAgo = Date.now() - 20 * 1000;
    // cutoff must be well before 20 seconds ago — a batch idle only 20s is NOT abandoned
    expect(cutoffMs).toBeLessThan(twentySecondsAgo);
  });
});
