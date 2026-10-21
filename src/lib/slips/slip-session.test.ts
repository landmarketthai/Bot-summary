import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  parseSlipSessionHeader,
  isSlipCloseCommand,
  SlipSessionService,
  SlipSchemaNotReadyError,
  SLIP_SCHEMA_NOT_READY_CODE,
  isSlipLedgerColumnMissing,
} from "./slip-session-service";
import type { Database } from "@/types/database";

// ── parseSlipSessionHeader ─────────────────────────────────────────────────

describe("parseSlipSessionHeader", () => {
  it("keeps the production Thai slash date as operator-facing text", () => {
    const result = parseSlipSessionHeader("พี่ดำ วัดตะกล่ำ สลิปเงินโอน 20/8/2569");
    expect(result).not.toBeNull();
    expect(result!.sellerName).toBe("พี่ดำ");
    expect(result!.marketName).toBe("วัดตะกล่ำ");
    expect(result!.slipDate).toBe("20/8/2569");
  });

  it("parses space-separated header", () => {
    const result = parseSlipSessionHeader("กี้ วัดทุ่งลานนา สลิปเงินโอน 9/6/2569");
    expect(result).not.toBeNull();
    expect(result!.sellerName).toBe("กี้");
    expect(result!.marketName).toBe("วัดทุ่งลานนา");
    expect(result!.slipDate).toBe("9/6/2569");
    expect(result!.batchType).toBe("TRANSFER_SLIPS");
    expect(result!.rawHeaderText).toBe("กี้ วัดทุ่งลานนา สลิปเงินโอน 9/6/2569");
  });

  it("parses dash-separated header", () => {
    const result = parseSlipSessionHeader("กี้-วัดทุ่งลานนา สลิปเงินโอน 9/6/2569");
    expect(result).not.toBeNull();
    expect(result!.sellerName).toBe("กี้");
    expect(result!.marketName).toBe("วัดทุ่งลานนา");
    expect(result!.slipDate).toBe("9/6/2569");
  });

  it("accepts สลิปเงิน variant", () => {
    const result = parseSlipSessionHeader("นาย ตลาดใหม่ สลิปเงิน 10/6/2569");
    expect(result).not.toBeNull();
    expect(result!.sellerName).toBe("นาย");
    expect(result!.marketName).toBe("ตลาดใหม่");
  });

  it("parses market name with embedded spaces", () => {
    const result = parseSlipSessionHeader("กี้ วัดทุ่ง ลานนา 2 สลิปเงินโอน 9/6/2569");
    expect(result).not.toBeNull();
    expect(result!.sellerName).toBe("กี้");
    expect(result!.marketName).toBe("วัดทุ่ง ลานนา 2");
    expect(result!.slipDate).toBe("9/6/2569");
  });

  it("returns null for plain text with no สลิป keyword", () => {
    expect(parseSlipSessionHeader("จบสลิป")).toBeNull();
    expect(parseSlipSessionHeader("กี้ วัดทุ่งลานนา 9/6/2569")).toBeNull();
    expect(parseSlipSessionHeader("หมอนทอง 50 บาท")).toBeNull();
    expect(parseSlipSessionHeader("")).toBeNull();
  });

  it("returns null for partial header missing a part before สลิป", () => {
    // Only one word before "สลิปเงินโอน" — no market name possible
    expect(parseSlipSessionHeader("กี้ สลิปเงินโอน 9/6/2569")).toBeNull();
  });
});

// ── isSlipCloseCommand ─────────────────────────────────────────────────────

describe("isSlipCloseCommand", () => {
  it.each([
    ["จบสลิป"],
    ["สรุปสลิป"],
    ["ปิดชุดสลิป"],
    ["จบชุดสลิป"],
  ])("matches %s", (cmd) => {
    expect(isSlipCloseCommand(cmd)).toBe(true);
  });

  it("is case / whitespace tolerant", () => {
    expect(isSlipCloseCommand("  จบสลิป  ")).toBe(true);
  });

  it.each([
    ["จบรายการ"],
    ["จบสลิป!"],
    ["สรุป"],
    [""],
    ["กี้ วัดทุ่งลานนา สลิปเงินโอน 9/6/2569"],
  ])("does not match %s", (text) => {
    expect(isSlipCloseCommand(text)).toBe(false);
  });
});

// ── SlipSessionService.openSession ────────────────────────────────────────

type SupabaseCall = { method: string; args: unknown };

function makeSessionSupabase(
  calls: SupabaseCall[],
  findActiveReturns: { data: null | { id: string; image_count: number; header_text: null; seller_name: null; market_name: null; slip_date: null }; error: null },
  insertReturns: { data: null | { id: string }; error: null | { message: string; code?: string } },
) {
  return {
    from(table: string) {
      return {
        select() {
          return {
            eq(_col: string, _val: unknown) {
              // findActiveSession: .eq("source_id", x).in("status", [...])
              const innerBuilder = {
                order() {
                  return {
                    limit() {
                      return {
                        async maybeSingle() {
                          calls.push({ method: "findActiveSession", args: table });
                          return findActiveReturns;
                        },
                      };
                    },
                  };
                },
              };
              return {
                in : (_col2: string, _vals: unknown[]) => innerBuilder,
                // Keep eq as alias for tests that were written before the .in() change
                eq : (_col2: string, _val2: unknown) => innerBuilder,
              };
            },
          };
        },
        insert(row: unknown) {
          calls.push({ method: "insert", args: row });
          return {
            select() {
              return {
                async single() {
                  return insertReturns;
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient<Database>;
}

describe("SlipSessionService.openSession", () => {
  it("creates a new batch when no session is open", async () => {
    const calls: SupabaseCall[] = [];
    const supabase = makeSessionSupabase(
      calls,
      { data: null, error: null },
      { data: { id: "new-batch-id" }, error: null },
    );
    const service = new SlipSessionService(supabase);

    const result = await service.openSession("group-1", "group", "user-1", {
      sellerName: "กี้",
      marketName: "วัดทุ่งลานนา",
      slipDate: "9/6/2569",
      rawHeaderText: "กี้ วัดทุ่งลานนา สลิปเงินโอน 9/6/2569",
      batchType: "TRANSFER_SLIPS",
    });

    expect(result.opened).toBe(true);
    if (result.opened) expect(result.batchId).toBe("new-batch-id");
    const insertCall = calls.find((c) => c.method === "insert");
    expect(insertCall).toBeDefined();
    expect(insertCall!.args).toMatchObject({
      source_id:   "group-1",
      seller_name: "กี้",
      market_name: "วัดทุ่งลานนา",
      slip_date:   "9/6/2569",
      batch_type:  "TRANSFER_SLIPS",
      status:      "collecting",
    });
  });

  it("returns opened=false via 23505 unique-constraint violation (race-safe path)", async () => {
    // New code: INSERT is attempted first (no pre-check).
    // The unique partial index fires → Supabase returns error.code "23505".
    // openSession then calls findActiveSession to get the existing batch id.
    const calls: SupabaseCall[] = [];
    const supabase = makeSessionSupabase(
      calls,
      {
        data: { id: "existing-batch", image_count: 2, header_text: null, seller_name: null, market_name: null, slip_date: null },
        error: null,
      },
      { data: null, error: { message: "duplicate key value", code: "23505" } },
    );
    const service = new SlipSessionService(supabase);

    const result = await service.openSession("group-1", "group", "user-1", {
      sellerName: "กี้", marketName: "ตลาด", slipDate: null,
      rawHeaderText: "กี้ ตลาด สลิปเงินโอน วันนี้", batchType: "TRANSFER_SLIPS",
    });

    expect(result.opened).toBe(false);
    if (!result.opened) expect(result.existingBatchId).toBe("existing-batch");
    // INSERT must have been attempted (no pre-flight select)
    expect(calls.find((c) => c.method === "insert")).toBeDefined();
    // findActiveSession must have been called after the 23505 to resolve the existing batch
    expect(calls.find((c) => c.method === "findActiveSession")).toBeDefined();
  });

  it("throws when 23505 fires but no collecting batch is found (transient race)", async () => {
    // Edge case: constraint fired but the concurrent winner was reverted or
    // doesn't show up yet.  openSession must throw so the caller can retry.
    const calls: SupabaseCall[] = [];
    const supabase = makeSessionSupabase(
      calls,
      { data: null, error: null }, // findActiveSession returns null
      { data: null, error: { message: "duplicate key value", code: "23505" } },
    );
    const service = new SlipSessionService(supabase);

    await expect(
      service.openSession("group-1", "group", "user-1", {
        sellerName: "กี้", marketName: "ตลาด", slipDate: null,
        rawHeaderText: "กี้ ตลาด สลิปเงินโอน วันนี้", batchType: "TRANSFER_SLIPS",
      }),
    ).rejects.toThrow("unique constraint violated but no active session found");
  });
});

describe("SlipSessionService.openSession on a database without the ledger migration", () => {
  const header = {
    sellerName: "กี้", marketName: "ตลาด", slipDate: null,
    rawHeaderText: "กี้ ตลาด สลิปเงินโอน วันนี้", batchType: "TRANSFER_SLIPS" as const,
  };

  it.each([
    ["PostgREST schema cache", { code: "PGRST204", message: "Could not find the 'open_event_ts_ms' column of 'slip_batches' in the schema cache" }],
    ["Postgres undefined_column", { code: "42703", message: 'column "open_event_ts_ms" of relation "slip_batches" does not exist' }],
  ])("fails explicitly (%s) instead of opening a ledger-less session", async (_name, error) => {
    const calls: SupabaseCall[] = [];
    const supabase = makeSessionSupabase(calls, { data: null, error: null }, { data: null, error });
    const service = new SlipSessionService(supabase);

    const failure = await service.openSession("group-1", "group", "user-1", header, null, 1_760_000_000_000)
      .then(() => null, (e: unknown) => e);

    expect(failure).toBeInstanceOf(SlipSchemaNotReadyError);
    expect((failure as SlipSchemaNotReadyError).code).toBe(SLIP_SCHEMA_NOT_READY_CODE);
    expect((failure as Error).message).toContain("20261017100000");
    // No retry without the column: exactly one insert attempt, never a legacy one.
    expect(calls.filter((c) => c.method === "insert")).toHaveLength(1);
  });

  it("does not misclassify other errors or unrelated missing columns", async () => {
    expect(isSlipLedgerColumnMissing({ code: "42703", message: 'column "accountability_round_id" does not exist' })).toBe(false);
    expect(isSlipLedgerColumnMissing({ code: "57014", message: "open_event_ts_ms statement timeout" })).toBe(false);
    expect(isSlipLedgerColumnMissing({ code: "PGRST204", message: "Could not find the 'close_event_ts_ms' column" })).toBe(true);
    expect(isSlipLedgerColumnMissing(null)).toBe(false);

    const supabase = makeSessionSupabase([], { data: null, error: null }, { data: null, error: { code: "57014", message: "timeout" } });
    await expect(new SlipSessionService(supabase).openSession("g", "group", null, header))
      .rejects.toThrow("openSession insert failed: timeout");
  });
});

// ── SlipSessionService.findActiveSession ──────────────────────────────────

describe("SlipSessionService.findActiveSession", () => {
  it("returns null when no collecting batch exists", async () => {
    const supabase = makeSessionSupabase(
      [], { data: null, error: null }, { data: null, error: null },
    );
    const service = new SlipSessionService(supabase);
    expect(await service.findActiveSession("group-1")).toBeNull();
  });

  it("returns session info when a collecting batch exists", async () => {
    const supabase = makeSessionSupabase(
      [],
      {
        data: { id: "batch-x", image_count: 5, header_text: null, seller_name: null, market_name: null, slip_date: null },
        error: null,
      },
      { data: null, error: null },
    );
    const service = new SlipSessionService(supabase);
    const session = await service.findActiveSession("group-1");
    expect(session).not.toBeNull();
    expect(session!.batchId).toBe("batch-x");
    expect(session!.imageCount).toBe(5);
  });
});
