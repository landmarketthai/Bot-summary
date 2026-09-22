import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { parseWhiteSheetCloseCommand } from "./white-sheet-close-command";
import {
  mergeWhiteSheetCloseInput,
  processWhiteSheetCloseCommand,
} from "./white-sheet-close-service";
import {
  finalizeWhiteSheetCashEntry,
  loadWhiteSheetCashEntry,
  normalizedMarketLabel,
} from "@/lib/white-sheet";
import {
  CENTRAL_PRICE_CONFLICT_WARNING_PREFIX,
  PENDING_REFERENCE_VERIFIED_TRANSFER_WARNING,
} from "@/lib/white-sheet/warnings";
import { stubManualSlipTables } from "@/lib/white-sheet/test-manual-slip-db";
import { getDailyFinancialSettlement } from "@/lib/settlement/daily-financial-settlement";

type CashEntryRow = Database["public"]["Tables"]["digital_white_sheet_cash_entries"]["Row"];

const SOURCE_ID = "group-close-1";
const MARKET_GEE = "ตลาดกี้";
const MARKET_NOI = "ตลาดน้อย";
const BUSINESS_DATE = "2026-07-24";

type ProduceRow = {
  id: string;
  product_name: string;
  quantity: number;
  unit: string;
  price_per_unit: number | null;
  transaction_type: string;
  base_transaction_type: string;
  item_created_at: string;
  session_id: string;
  transaction_date: string;
  market_name: string;
  raw_message_id: string;
  basis_quantity: number | null;
  basis_price: number | null;
  session_kind: string;
};

function baseProduceRows(markets: string[] = [MARKET_GEE]): ProduceRow[] {
  const rows: ProduceRow[] = [];
  for (const market of markets) {
    const suffix = market === MARKET_GEE ? "gee" : "noi";
    rows.push(
      {
        id: `item-wm-${suffix}`,
        product_name: "แตงโม",
        quantity: 10,
        unit: "โล",
        price_per_unit: 20,
        transaction_type: "เบิก",
        base_transaction_type: "เบิก",
        item_created_at: "2026-07-24T01:00:00Z",
        session_id: `main-${suffix}`,
        transaction_date: BUSINESS_DATE,
        market_name: market,
        raw_message_id: `raw-${suffix}`,
        basis_quantity: null,
        basis_price: null,
        session_kind: "main",
      },
      {
        id: `item-wm-ret-${suffix}`,
        product_name: "แตงโม",
        quantity: 5,
        unit: "ขีด",
        price_per_unit: null,
        transaction_type: "คืน",
        base_transaction_type: "คืน",
        item_created_at: "2026-07-24T01:30:00Z",
        session_id: `main-${suffix}`,
        transaction_date: BUSINESS_DATE,
        market_name: market,
        raw_message_id: `raw-${suffix}`,
        basis_quantity: null,
        basis_price: null,
        session_kind: "main",
      },
      {
        id: `item-wm-dmg-${suffix}`,
        product_name: "แตงโม",
        quantity: 2,
        unit: "ขีด",
        price_per_unit: null,
        transaction_type: "คืนเสีย",
        base_transaction_type: "คืนเสีย",
        item_created_at: "2026-07-24T01:45:00Z",
        session_id: `main-${suffix}`,
        transaction_date: BUSINESS_DATE,
        market_name: market,
        raw_message_id: `raw-${suffix}`,
        basis_quantity: null,
        basis_price: null,
        session_kind: "main",
      },
      {
        id: `item-mn-${suffix}`,
        product_name: "มะม่วง",
        quantity: 20,
        unit: "ลูก",
        price_per_unit: 5,
        transaction_type: "เบิก",
        base_transaction_type: "เบิก",
        item_created_at: "2026-07-24T02:00:00Z",
        session_id: `main-${suffix}`,
        transaction_date: BUSINESS_DATE,
        market_name: market,
        raw_message_id: `raw-${suffix}`,
        basis_quantity: null,
        basis_price: null,
        session_kind: "main",
      },
    );
  }
  return rows;
}

function makeCloseDatabase(options?: {
  markets?: string[];
  /** When set, แตงโม withdrawal is priced differently from the system-seeded central price. */
  conflictingWatermelonPrice?: number;
  pendingReference?: boolean;
}) {
  const markets = options?.markets ?? [MARKET_GEE];
  const produceRows = baseProduceRows(markets);
  if (options?.conflictingWatermelonPrice != null) {
    for (const row of produceRows) {
      if (row.product_name === "แตงโม" && row.base_transaction_type === "เบิก") {
        row.price_per_unit = options.conflictingWatermelonPrice;
      }
    }
  }

  const rawMessages = markets.map((market) => ({
    id: market === MARKET_GEE ? "raw-gee" : "raw-noi",
    source_id: SOURCE_ID,
  }));
  const uniqueRaw = [...new Map(rawMessages.map((r) => [r.id, r])).values()];

  const slipEvidences = [
    {
      id: "ev-1",
      received_at: "2026-07-24T02:00:00Z",
      market_label: MARKET_GEE,
      source_id: SOURCE_ID,
    },
  ];
  const slipChecks = [
    {
      id: "chk-1",
      evidence_id: "ev-1",
      transfer_amount: 200,
      reference_id: options?.pendingReference ? null : "REF-200",
      created_at: "2026-07-24T02:05:00Z",
      status: "EXTRACTED",
    },
  ];

  const cashEntries = new Map<string, CashEntryRow>();
  const cashKey = (sourceId: string, market: string, date: string) =>
    `${sourceId}::${market}::${date}`;

  const watermelonSetBy =
    options?.conflictingWatermelonPrice != null
      ? "system:first-withdrawal"
      : "admin";
  const centralPrices = [
    {
      product_key: "แตงโม",
      unit_key: "โล",
      business_date: BUSINESS_DATE,
      price_satang: 2000,
      set_by: watermelonSetBy,
      set_reason: null,
      created_at: "2026-07-24T00:00:00Z",
      updated_at: "2026-07-24T00:00:00Z",
    },
    {
      product_key: "มะม่วง",
      unit_key: "ลูก",
      business_date: BUSINESS_DATE,
      price_satang: 500,
      set_by: "admin",
      set_reason: null,
      created_at: "2026-07-24T00:00:00Z",
      updated_at: "2026-07-24T00:00:00Z",
    },
  ];

  const database = {
    from(table: string) {
      if (table === "produce_transactions") {
        const builder = {
          select: () => builder,
          eq: () => builder,
          in: () => builder,
          order: () => builder,
          range: async () => ({
            data: produceRows,
            error: null,
            count: produceRows.length,
          }),
        };
        return builder;
      }
      if (table === "raw_messages") {
        return {
          select: () => ({
            in: async () => ({ data: uniqueRaw, error: null }),
          }),
        };
      }
      if (table === "slip_evidences") {
        return {
          select: () => ({
            eq: () => ({
              gte: () => ({
                lt: async () => ({ data: slipEvidences, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "central_selling_prices") {
        return {
          select: () => ({
            eq: async () => ({
              data: centralPrices,
              error: null,
            }),
          }),
        };
      }
      if (table === "slip_checks") {
        return {
          select: () => {
            const builder = {
              in: () => builder,
              not: () => builder,
              order: () => builder,
              then: (resolve: (value: unknown) => void) =>
                resolve({
                  data: slipChecks,
                  error: null,
                }),
            };
            return builder;
          },
        };
      }
      if (table === "transfer_reconciliations") {
        const builder = {
          select: () => builder,
          eq: () => builder,
          is: () => builder,
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return builder;
      }
      if (table === "digital_white_sheet_cash_entries") {
        type Filter = { op: "eq" | "is"; column: string; value: unknown };
        const matches = (row: CashEntryRow, filters: Filter[]) =>
          filters.every(({ column, value }) => (row as Record<string, unknown>)[column] === value);

        return {
          select: () => {
            const filters: Filter[] = [];
            const builder = {
              eq: (column: string, value: unknown) => {
                filters.push({ op: "eq", column, value });
                return builder;
              },
              is: (column: string, value: unknown) => {
                filters.push({ op: "is", column, value });
                return builder;
              },
              maybeSingle: async () => ({
                data: [...cashEntries.values()].find((row) => matches(row, filters)) ?? null,
                error: null,
              }),
            };
            return builder;
          },
          insert: (values: Partial<CashEntryRow>) => ({
            select: () => ({
              single: async () => {
                const merged: CashEntryRow = {
                  id: `entry-${cashEntries.size + 1}`,
                  created_at: "2026-07-24T00:00:00Z",
                  updated_at: "2026-07-24T00:00:00Z",
                  other_note: null,
                  finalized_at: null,
                  finalized_by: null,
                  ...values,
                } as CashEntryRow;
                cashEntries.set(
                  cashKey(merged.source_id, merged.market_label_normalized, merged.business_date),
                  merged,
                );
                return { data: merged, error: null };
              },
            }),
          }),
          update: (values: Partial<CashEntryRow>) => {
            const filters: Filter[] = [];
            const builder = {
              eq: (column: string, value: unknown) => {
                filters.push({ op: "eq", column, value });
                return builder;
              },
              is: (column: string, value: unknown) => {
                filters.push({ op: "is", column, value });
                return builder;
              },
              select: () => ({
                maybeSingle: async () => {
                  const found = [...cashEntries.entries()].find(([, row]) => matches(row, filters));
                  if (!found) return { data: null, error: null };
                  const [key, existing] = found;
                  const merged: CashEntryRow = {
                    ...existing,
                    ...values,
                    updated_at: "2026-07-24T01:00:00Z",
                  } as CashEntryRow;
                  cashEntries.set(key, merged);
                  return { data: merged, error: null };
                },
              }),
            };
            return builder;
          },
        };
      }
      if (table === "white_sheet_lifecycle_events") {
        throw new Error(
          "lifecycle audit must go through finalize/reopen RPCs — direct insert is forbidden",
        );
      }
      const manualSlip = stubManualSlipTables()(table);
      if (manualSlip) return manualSlip;
      throw new Error(`unexpected table: ${table}`);
    },
    rpc(fn: string, args: Record<string, unknown>) {
      if (fn === "finalize_white_sheet_cash_entry") {
        const key = cashKey(
          String(args.p_source_id),
          String(args.p_market_label_normalized),
          String(args.p_business_date),
        );
        const existing = cashEntries.get(key);
        if (!existing || existing.finalized_at !== null) {
          return Promise.resolve({
            data: null,
            error: {
              message:
                "no SUBMITTED White Sheet entry found for this identity, or it is already finalized",
            },
          });
        }
        const merged: CashEntryRow = {
          ...existing,
          finalized_at: "2026-07-24T02:00:00Z",
          finalized_by: String(args.p_actor),
          updated_at: "2026-07-24T02:00:00Z",
        };
        cashEntries.set(key, merged);
        return Promise.resolve({ data: merged, error: null });
      }
      if (fn === "reopen_white_sheet_cash_entry") {
        const key = cashKey(
          String(args.p_source_id),
          String(args.p_market_label_normalized),
          String(args.p_business_date),
        );
        const existing = cashEntries.get(key);
        if (!existing || existing.finalized_at === null) {
          return Promise.resolve({
            data: null,
            error: { message: "no FINALIZED White Sheet entry found for this identity" },
          });
        }
        const merged: CashEntryRow = {
          ...existing,
          finalized_at: null,
          finalized_by: null,
          updated_at: "2026-07-24T03:00:00Z",
        };
        cashEntries.set(key, merged);
        return Promise.resolve({ data: merged, error: null });
      }
      return Promise.resolve({ data: null, error: { message: `unexpected rpc: ${fn}` } });
    },
  };

  return {
    supabase: database as unknown as SupabaseClient<Database>,
    cashEntries,
  };
}

function mustParse(text: string) {
  const parsed = parseWhiteSheetCloseCommand(text);
  expect(parsed.kind).toBe("ok");
  if (parsed.kind !== "ok") throw new Error("expected ok parse");
  return parsed.command;
}

const MATCHED_CLOSE = [
  `${MARKET_GEE} ปิดยอด 24/07/2569`,
  "ยอดขาย 286",
  "เงินให้เจ้า 0",
  "ค่าแรง 30",
  "ค่าที่ 20",
  "ค่าถุง 5",
  "ค่าขนม 5",
  "ค่าอื่น 10",
  "เงินสด 16",
  "จบปิดยอด",
].join("\n");

describe("processWhiteSheetCloseCommand", () => {
  it("N/O financial fixture: persists and replies with canonical matched summary", async () => {
    const { supabase, cashEntries } = makeCloseDatabase();
    const command = mustParse(MATCHED_CLOSE);

    const outcome = await processWhiteSheetCloseCommand(supabase, {
      sourceId: SOURCE_ID,
      command,
    });

    expect(outcome.persisted).toBe(true);
    expect(outcome.trusted).toBe(true);
    expect(cashEntries.size).toBe(1);

    const text = outcome.replyMessages.join("\n");
    expect(text).toContain("สรุปปิดยอด — ตลาดกี้");
    expect(text).toContain("ยอดขายที่ควรได้ 286.00 บาท");
    expect(text).toContain("ยอดโอนที่ตรวจแล้ว 200.00 บาท");
    expect(text).toContain("รวมค่าใช้จ่าย 70.00 บาท");
    expect(text).toContain("เงินสดที่ควรส่ง 16.00 บาท");
    expect(text).toContain("เงินสดที่ส่งจริง 16.00 บาท");
    expect(text).toContain("✅ ยอดตรง");

    const financial = await getDailyFinancialSettlement(supabase, {
      sourceId: SOURCE_ID,
      marketLabelNormalized: MARKET_GEE,
      businessDate: BUSINESS_DATE,
    });
    expect(financial).toMatchObject({
      status: "CLOSED_MATCHED",
      whiteSheetSales: 286,
      ownerCash: 0,
      actualCash: 16,
      difference: 0,
    });
  });

  it("M. unknown market fails closed with zero persistence", async () => {
    const { supabase, cashEntries } = makeCloseDatabase();
    const command = mustParse(
      "กี้ ปิดยอด 24/07/2569\nยอดขาย 286\nเงินให้เจ้า 0\nเงินสด 16\nจบปิดยอด",
    );

    const outcome = await processWhiteSheetCloseCommand(supabase, {
      sourceId: SOURCE_ID,
      command,
    });

    expect(outcome.persisted).toBe(false);
    expect(cashEntries.size).toBe(0);
    expect(outcome.replyMessages.join("\n")).toContain("ไม่พบตลาด");
    expect(outcome.replyMessages.join("\n")).toContain("ตลาดกี้");
  });

  it("O. resubmission updates the same row while SUBMITTED", async () => {
    const { supabase, cashEntries } = makeCloseDatabase();

    await processWhiteSheetCloseCommand(supabase, {
      sourceId: SOURCE_ID,
      command: mustParse(
        `${MARKET_GEE} ปิดยอด 24/07/2569\nยอดขาย 1000\nเงินให้เจ้า 10\nเงินสด 1000\nจบปิดยอด`,
      ),
    });
    expect(cashEntries.size).toBe(1);
    const firstId = [...cashEntries.values()][0].id;

    const second = await processWhiteSheetCloseCommand(supabase, {
      sourceId: SOURCE_ID,
      command: mustParse(
        `${MARKET_GEE} ปิดยอด 24/07/2569\nยอดขาย 1100\nเงินให้เจ้า 20\nเงินสด 1100\nจบปิดยอด`,
      ),
    });

    expect(cashEntries.size).toBe(1);
    expect([...cashEntries.values()][0].id).toBe(firstId);
    expect([...cashEntries.values()][0].actual_cash_submitted).toBe(1100);
    expect([...cashEntries.values()][0].white_sheet_sales).toBe(1100);
    expect([...cashEntries.values()][0].owner_cash).toBe(20);
    expect(second.replyMessages.join("\n")).toContain("เงินสดที่ส่งจริง 1,100.00 บาท");
  });

  it("A. first submission with omitted expenses initializes them as 0", async () => {
    const { supabase, cashEntries } = makeCloseDatabase();
    await processWhiteSheetCloseCommand(supabase, {
      sourceId: SOURCE_ID,
      command: mustParse(
        `${MARKET_GEE} ปิดยอด 24/07/2569\nยอดขาย 0\nเงินให้เจ้า 0\nเงินสด 16\nจบปิดยอด`,
      ),
    });
    const row = [...cashEntries.values()][0];
    expect(row.labor).toBe(0);
    expect(row.location_fee).toBe(0);
    expect(row.bag).toBe(0);
    expect(row.snack).toBe(0);
    expect(row.other).toBe(0);
    expect(row.other_note).toBeNull();
    expect(row.actual_cash_submitted).toBe(16);
    expect(row.white_sheet_sales).toBe(0);
    expect(row.owner_cash).toBe(0);
    expect(row.labor_entered).toBe(false);
    expect(row.location_fee_entered).toBe(false);
    expect(row.bag_entered).toBe(false);
    expect(row.snack_entered).toBe(false);
    expect(row.other_entered).toBe(false);
    expect(row.actual_cash_submitted_entered).toBe(true);
  });

  it("normal all-zero lines persist as genuine entered zeros", async () => {
    const { supabase, cashEntries } = makeCloseDatabase();
    await processWhiteSheetCloseCommand(supabase, {
      sourceId: SOURCE_ID,
      command: mustParse([
        `${MARKET_GEE} ปิดยอด 24/07/2569`,
        "ยอดขาย 0",
        "เงินให้เจ้า 0",
        "ค่าแรง 0",
        "ค่าที่ 0",
        "ค่าถุง 0",
        "ค่าขนม 0",
        "ค่าอื่น 0",
        "เงินสด 0",
        "จบปิดยอด",
      ].join("\n")),
    });

    expect([...cashEntries.values()][0]).toMatchObject({
      white_sheet_sales: 0,
      owner_cash: 0,
      labor: 0,
      location_fee: 0,
      bag: 0,
      snack: 0,
      other: 0,
      actual_cash_submitted: 0,
      labor_entered: true,
      location_fee_entered: true,
      bag_entered: true,
      snack_entered: true,
      other_entered: true,
      actual_cash_submitted_entered: true,
    });
  });

  it("B. cash-only resubmission preserves all expenses and otherNote", async () => {
    const { supabase, cashEntries } = makeCloseDatabase();
    await processWhiteSheetCloseCommand(supabase, {
      sourceId: SOURCE_ID,
      command: mustParse(MATCHED_CLOSE),
    });

    const outcome = await processWhiteSheetCloseCommand(supabase, {
      sourceId: SOURCE_ID,
      command: mustParse(
        `${MARKET_GEE} ปิดยอด 24/07/2569\nยอดขาย 286\nเงินให้เจ้า 0\nเงินสด 20\nจบปิดยอด`,
      ),
    });

    expect(cashEntries.size).toBe(1);
    const row = [...cashEntries.values()][0];
    expect(row.labor).toBe(30);
    expect(row.location_fee).toBe(20);
    expect(row.bag).toBe(5);
    expect(row.snack).toBe(5);
    expect(row.other).toBe(10);
    expect(row.other_note).toBeNull(); // MATCHED_CLOSE has no note
    expect(row.actual_cash_submitted).toBe(20);
    expect(outcome.persisted).toBe(true);
    expect(outcome.trusted).toBe(true);
    // G: canonical result uses merged expenses (70), not parser zeros.
    // expectedCash = 286 - 200 - 70 = 16; actual 20 → overage 4
    const text = outcome.replyMessages.join("\n");
    expect(text).toContain("รวมค่าใช้จ่าย 70.00 บาท");
    expect(text).toContain("เงินสดที่ควรส่ง 16.00 บาท");
    expect(text).toContain("เงินสดที่ส่งจริง 20.00 บาท");
    expect(text).toContain("เงินเกิน 4.00 บาท");
    expect(text).not.toContain("✅ ยอดตรง");
  });

  it("C. explicit ค่าแรง 0 clears labor while preserving omitted expenses", async () => {
    const { supabase, cashEntries } = makeCloseDatabase();
    await processWhiteSheetCloseCommand(supabase, {
      sourceId: SOURCE_ID,
      command: mustParse(MATCHED_CLOSE),
    });

    await processWhiteSheetCloseCommand(supabase, {
      sourceId: SOURCE_ID,
      command: mustParse(
        `${MARKET_GEE} ปิดยอด 24/07/2569\nยอดขาย 286\nเงินให้เจ้า 0\nค่าแรง 0\nเงินสด 46\nจบปิดยอด`,
      ),
    });

    const row = [...cashEntries.values()][0];
    expect(row.labor).toBe(0);
    expect(row.location_fee).toBe(20);
    expect(row.bag).toBe(5);
    expect(row.snack).toBe(5);
    expect(row.other).toBe(10);
    expect(row.actual_cash_submitted).toBe(46);
    expect(row.labor_entered).toBe(true);
  });

  it("D. omitting ค่าอื่น preserves other amount and note", async () => {
    const { supabase, cashEntries } = makeCloseDatabase();
    await processWhiteSheetCloseCommand(supabase, {
      sourceId: SOURCE_ID,
      command: mustParse(
        [
          `${MARKET_GEE} ปิดยอด 24/07/2569`,
          "ยอดขาย 286",
          "เงินให้เจ้า 0",
          "ค่าแรง 30",
          "ค่าที่ 20",
          "ค่าถุง 5",
          "ค่าขนม 5",
          "ค่าอื่น 10 ค่าน้ำแข็ง",
          "เงินสด 16",
          "จบปิดยอด",
        ].join("\n"),
      ),
    });

    await processWhiteSheetCloseCommand(supabase, {
      sourceId: SOURCE_ID,
      command: mustParse(
        `${MARKET_GEE} ปิดยอด 24/07/2569\nยอดขาย 286\nเงินให้เจ้า 0\nเงินสด 16\nจบปิดยอด`,
      ),
    });

    const row = [...cashEntries.values()][0];
    expect(row.other).toBe(10);
    expect(row.other_note).toBe("ค่าน้ำแข็ง");
  });

  it("E. explicit ค่าอื่น 0 clears other and stale otherNote", async () => {
    const { supabase, cashEntries } = makeCloseDatabase();
    await processWhiteSheetCloseCommand(supabase, {
      sourceId: SOURCE_ID,
      command: mustParse(
        [
          `${MARKET_GEE} ปิดยอด 24/07/2569`,
          "ยอดขาย 286",
          "เงินให้เจ้า 0",
          "ค่าอื่น 10 ค่าน้ำแข็ง",
          "เงินสด 16",
          "จบปิดยอด",
        ].join("\n"),
      ),
    });

    await processWhiteSheetCloseCommand(supabase, {
      sourceId: SOURCE_ID,
      command: mustParse(
        `${MARKET_GEE} ปิดยอด 24/07/2569\nยอดขาย 286\nเงินให้เจ้า 0\nค่าอื่น 0\nเงินสด 16\nจบปิดยอด`,
      ),
    });

    const row = [...cashEntries.values()][0];
    expect(row.other).toBe(0);
    expect(row.other_note).toBeNull();
  });

  it("F. FINALIZED rejects without merge mutation", async () => {
    const { supabase, cashEntries } = makeCloseDatabase();
    await processWhiteSheetCloseCommand(supabase, {
      sourceId: SOURCE_ID,
      command: mustParse(
        [
          `${MARKET_GEE} ปิดยอด 24/07/2569`,
          "ยอดขาย 286",
          "เงินให้เจ้า 0",
          "ค่าอื่น 10 ค่าน้ำแข็ง",
          "เงินสด 16",
          "จบปิดยอด",
        ].join("\n"),
      ),
    });
    await finalizeWhiteSheetCashEntry(
      supabase,
      {
        sourceId: SOURCE_ID,
        marketLabelNormalized: normalizedMarketLabel(MARKET_GEE),
        businessDate: BUSINESS_DATE,
      },
      "admin-1",
    );
    const before = { ...[...cashEntries.values()][0] };

    const outcome = await processWhiteSheetCloseCommand(supabase, {
      sourceId: SOURCE_ID,
      command: mustParse(
        `${MARKET_GEE} ปิดยอด 24/07/2569\nยอดขาย 9999\nเงินให้เจ้า 0\nค่าแรง 0\nเงินสด 9999\nจบปิดยอด`,
      ),
    });

    expect(outcome.persisted).toBe(false);
    expect(outcome.replyMessages.join("\n")).toContain("FINALIZED");
    expect([...cashEntries.values()][0]).toEqual(before);
  });

  it("mergeWhiteSheetCloseInput unit: omitted vs explicit zero", () => {
    const submitted = {
      status: "submitted" as const,
      expenses: {
        labor: 30,
        locationFee: 20,
        bag: 5,
        snack: 5,
        other: 10,
        otherNote: "ค่าน้ำแข็ง",
      },
      actualCashSubmitted: 16,
      updatedAt: "2026-07-24T00:00:00Z",
    };
    const cashOnly = mustParse(
      `${MARKET_GEE} ปิดยอด 24/07/2569\nยอดขาย 286\nเงินให้เจ้า 0\nเงินสด 20\nจบปิดยอด`,
    );
    expect(mergeWhiteSheetCloseInput(SOURCE_ID, cashOnly, submitted)).toEqual({
      sourceId: SOURCE_ID,
      marketLabelNormalized: MARKET_GEE,
      businessDate: BUSINESS_DATE,
      whiteSheetSales: 286,
      ownerCash: 0,
      labor: 30,
      locationFee: 20,
      bag: 5,
      snack: 5,
      other: 10,
      otherNote: "ค่าน้ำแข็ง",
      actualCashSubmitted: 20,
      laborEntered: false,
      locationFeeEntered: false,
      bagEntered: false,
      snackEntered: false,
      otherEntered: false,
      actualCashEntered: true,
    });

    const zeroLabor = mustParse(
      `${MARKET_GEE} ปิดยอด 24/07/2569\nยอดขาย 286\nเงินให้เจ้า 0\nค่าแรง 0\nเงินสด 20\nจบปิดยอด`,
    );
    expect(mergeWhiteSheetCloseInput(SOURCE_ID, zeroLabor, submitted).labor).toBe(0);
    expect(mergeWhiteSheetCloseInput(SOURCE_ID, zeroLabor, submitted).locationFee).toBe(20);
  });

  it("P. FINALIZED rejects LINE overwrite with no mutation", async () => {
    const { supabase, cashEntries } = makeCloseDatabase();
    await processWhiteSheetCloseCommand(supabase, {
      sourceId: SOURCE_ID,
      command: mustParse(MATCHED_CLOSE),
    });

    await finalizeWhiteSheetCashEntry(
      supabase,
      {
        sourceId: SOURCE_ID,
        marketLabelNormalized: normalizedMarketLabel(MARKET_GEE),
        businessDate: BUSINESS_DATE,
      },
      "admin-1",
    );

    const before = [...cashEntries.values()][0];
    const outcome = await processWhiteSheetCloseCommand(supabase, {
      sourceId: SOURCE_ID,
      command: mustParse(
        `${MARKET_GEE} ปิดยอด 24/07/2569\nยอดขาย 9999\nเงินให้เจ้า 0\nเงินสด 9999\nจบปิดยอด`,
      ),
    });

    expect(outcome.persisted).toBe(false);
    expect(outcome.replyMessages.join("\n")).toContain("FINALIZED");
    expect([...cashEntries.values()][0].actual_cash_submitted).toBe(before.actual_cash_submitted);
    expect([...cashEntries.values()][0].finalized_at).toBeTruthy();
  });

  it("market isolation: closing one market does not alter another", async () => {
    const { supabase, cashEntries } = makeCloseDatabase({
      markets: [MARKET_GEE, MARKET_NOI],
    });

    await processWhiteSheetCloseCommand(supabase, {
      sourceId: SOURCE_ID,
      command: mustParse(
        `${MARKET_GEE} ปิดยอด 24/07/2569\nยอดขาย 286\nเงินให้เจ้า 0\nเงินสด 16\nจบปิดยอด`,
      ),
    });
    expect(cashEntries.size).toBe(1);

    const noiBefore = await loadWhiteSheetCashEntry(supabase, {
      sourceId: SOURCE_ID,
      marketLabelNormalized: normalizedMarketLabel(MARKET_NOI),
      businessDate: BUSINESS_DATE,
    });
    expect(noiBefore.status).toBe("not_submitted");

    await processWhiteSheetCloseCommand(supabase, {
      sourceId: SOURCE_ID,
      command: mustParse(
        `${MARKET_NOI} ปิดยอด 24/07/2569\nยอดขาย 50\nเงินให้เจ้า 0\nเงินสด 50\nจบปิดยอด`,
      ),
    });

    expect(cashEntries.size).toBe(2);
    const gee = await loadWhiteSheetCashEntry(supabase, {
      sourceId: SOURCE_ID,
      marketLabelNormalized: normalizedMarketLabel(MARKET_GEE),
      businessDate: BUSINESS_DATE,
    });
    const noi = await loadWhiteSheetCashEntry(supabase, {
      sourceId: SOURCE_ID,
      marketLabelNormalized: normalizedMarketLabel(MARKET_NOI),
      businessDate: BUSINESS_DATE,
    });
    expect(gee.status).toBe("submitted");
    expect(noi.status).toBe("submitted");
    if (gee.status === "submitted" && noi.status === "submitted") {
      expect(gee.actualCashSubmitted).toBe(16);
      expect(noi.actualCashSubmitted).toBe(50);
    }
  });
});

describe("processWhiteSheetCloseCommand HARD STOP", () => {
  it("persists closing inputs but refuses trusted status for pending reference slips", async () => {
    const { supabase, cashEntries } = makeCloseDatabase({ pendingReference: true });
    const outcome = await processWhiteSheetCloseCommand(supabase, {
      sourceId: SOURCE_ID,
      command: mustParse(MATCHED_CLOSE),
    });

    expect(outcome.persisted).toBe(true);
    expect(outcome.trusted).toBe(false);
    expect(cashEntries.size).toBe(1);
    const text = outcome.replyMessages.join("\n");
    expect(text).toContain("บันทึกข้อมูลปิดยอดแล้ว ✅");
    expect(text).toContain(PENDING_REFERENCE_VERIFIED_TRANSFER_WARNING);
    expect(text).not.toContain("✅ ยอดตรง");
    expect(text).not.toContain("เงินขาด");
    expect(text).not.toContain("เงินเกิน");
  });

  it("uses the entered round price when the legacy central price differs", async () => {
    const { supabase, cashEntries } = makeCloseDatabase({
      conflictingWatermelonPrice: 25,
    });

    const outcome = await processWhiteSheetCloseCommand(supabase, {
      sourceId: SOURCE_ID,
      command: mustParse(MATCHED_CLOSE),
    });

    expect(outcome.persisted).toBe(true);
    expect(outcome.trusted).toBe(true);
    expect(cashEntries.size).toBe(1);
    const text = outcome.replyMessages.join("\n");
    expect(text).toContain("ยอดขายที่ควรได้ 332.50 บาท");
    expect(text).toContain("เงินขาด 46.50 บาท");
    expect(text).not.toContain(CENTRAL_PRICE_CONFLICT_WARNING_PREFIX);
    expect(text).not.toContain("ยังไม่สามารถสรุปยอดตรง/ขาด/เกินได้");
  });
});
