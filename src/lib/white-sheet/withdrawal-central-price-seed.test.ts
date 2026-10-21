import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LineMessageEvent } from "@/lib/line/types";
import { WeighSessionParser } from "@/lib/parsers/weigh-session/parser";
import type { Database } from "@/types/database";
import { loadDigitalWhiteSheetCalculation } from "./load";
import { loadDigitalWhiteSheetPageModel } from "./compose";
import { SYSTEM_WITHDRAWAL_SEED_ACTOR } from "./pricing";
import { stubManualSlipTables } from "@/lib/white-sheet/test-manual-slip-db";
import {
  seedCentralPricesFromPersistedWithdrawals,
  type PersistedWithdrawalSeedItem,
} from "./seed-from-withdrawal";
import { saveWhiteSheetCashEntry } from "./persist";
import { normalizedMarketLabel } from "./load";

const SOURCE_ID = "group-write-seed";
const BUSINESS_DATE = "2026-07-24";
const MARKET = "ตลาดกี้";
const MARKET_B = "ตลาดน้อย";

type PriceRow = {
  product_key: string;
  unit_key: string;
  business_date: string;
  price_satang: number;
  set_by: string;
  set_reason: string | null;
  created_at: string;
  updated_at: string;
};

function makePriceTable(initial: PriceRow[] = []) {
  const rows = [...initial];
  let seedRpcCalls = 0;
  return {
    rows,
    get seedRpcCalls() {
      return seedRpcCalls;
    },
    select: () => ({
      eq: async () => ({ data: rows, error: null }),
    }),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "seed_central_selling_price") {
        seedRpcCalls += 1;
        const existing = rows.find(
          (r) =>
            r.product_key === args.p_product_key
            && r.unit_key === args.p_unit_key
            && r.business_date === args.p_business_date,
        );
        if (existing) return { data: existing, error: null };
        const created: PriceRow = {
          product_key: args.p_product_key as string,
          unit_key: args.p_unit_key as string,
          business_date: args.p_business_date as string,
          price_satang: args.p_price_satang as number,
          set_by: args.p_actor as string,
          set_reason: (args.p_reason as string | null) ?? null,
          created_at: "2026-07-24T00:00:00Z",
          updated_at: "2026-07-24T00:00:00Z",
        };
        rows.push(created);
        return { data: created, error: null };
      }
      if (fn === "set_central_selling_price") {
        const existing = rows.find(
          (r) =>
            r.product_key === args.p_product_key
            && r.unit_key === args.p_unit_key
            && r.business_date === args.p_business_date,
        );
        if (existing) {
          existing.price_satang = args.p_price_satang as number;
          existing.set_by = args.p_actor as string;
          existing.set_reason = (args.p_reason as string | null) ?? null;
          return { data: existing, error: null };
        }
        const created: PriceRow = {
          product_key: args.p_product_key as string,
          unit_key: args.p_unit_key as string,
          business_date: args.p_business_date as string,
          price_satang: args.p_price_satang as number,
          set_by: args.p_actor as string,
          set_reason: (args.p_reason as string | null) ?? null,
          created_at: "2026-07-24T00:00:00Z",
          updated_at: "2026-07-24T00:00:00Z",
        };
        rows.push(created);
        return { data: created, error: null };
      }
      return { data: null, error: { message: `unexpected rpc: ${fn}` } };
    },
  };
}

function makeSheetDatabase(options: {
  produceRows: Array<Record<string, unknown>>;
  priceTable: ReturnType<typeof makePriceTable>;
}) {
  const produceRows = options.produceRows;
  const rawMessages = [...new Set(produceRows.map((r) => String(r.raw_message_id)))].map(
    (id) => ({ id, source_id: SOURCE_ID }),
  );
  return {
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
        return { select: () => ({ in: async () => ({ data: rawMessages, error: null }) }) };
      }
      if (table === "slip_evidences") {
        return {
          select: () => ({
            eq: () => ({ gte: () => ({ lt: async () => ({ data: [], error: null }) }) }),
          }),
        };
      }
      if (table === "central_selling_prices") {
        return { select: options.priceTable.select };
      }
      const manualSlip = stubManualSlipTables()(table);
        if (manualSlip) return manualSlip;
        throw new Error(`unexpected table: ${table}`);
    },
    rpc: options.priceTable.rpc,
  } as unknown as SupabaseClient<Database>;
}

const ZERO_CASH = {
  expenses: { labor: 0, locationFee: 0, bag: 0, snack: 0, other: 0 },
  actualCashSubmitted: 0,
};

describe("central price seeds on withdrawal write, not White Sheet read", () => {
  it("A: successful first withdrawal seeds central price immediately", async () => {
    const priceTable = makePriceTable();
    const database = makeSheetDatabase({ produceRows: [], priceTable });

    await seedCentralPricesFromPersistedWithdrawals(database, {
      businessDate: BUSINESS_DATE,
      items: [
        {
          product_name: "แตงโม",
          unit: "ลูก",
          price_per_unit: 40,
          transaction_type: "เบิก",
          basis_quantity: null,
          basis_price: null,
        },
      ],
    });

    expect(priceTable.rows).toHaveLength(1);
    expect(priceTable.rows[0]).toMatchObject({
      product_key: "แตงโม",
      unit_key: "ลูก",
      price_satang: 4000,
      set_by: SYSTEM_WITHDRAWAL_SEED_ACTOR,
    });
    expect(priceTable.seedRpcCalls).toBe(1);
  });

  it("B/C: White Sheet load before/after and repeated loads are read-only", async () => {
    const priceTable = makePriceTable();
    const produceRows = [
      {
        id: "item-1",
        product_name: "แตงโม",
        quantity: 2,
        unit: "ลูก",
        price_per_unit: 40,
        transaction_type: "เบิก",
        base_transaction_type: "เบิก",
        item_created_at: "2026-07-24T01:00:00Z",
        session_id: "sess-1",
        transaction_date: BUSINESS_DATE,
        market_name: MARKET,
        raw_message_id: "raw-1",
        basis_quantity: null,
        basis_price: null,
        session_kind: "main",
      },
    ];
    const database = makeSheetDatabase({ produceRows, priceTable });

    // Entered prices already value the sale; a read must never seed the fallback.
    const before = await loadDigitalWhiteSheetCalculation(
      database,
      { sourceId: SOURCE_ID, marketKey: "ki", marketLabel: MARKET, businessDate: BUSINESS_DATE },
      ZERO_CASH,
    );
    expect(before.expectedSales).toBe(80);
    expect(priceTable.rows).toHaveLength(0);
    expect(priceTable.seedRpcCalls).toBe(0);

    await seedCentralPricesFromPersistedWithdrawals(database, {
      businessDate: BUSINESS_DATE,
      items: [
        {
          product_name: "แตงโม",
          unit: "ลูก",
          price_per_unit: 40,
          transaction_type: "เบิก",
          basis_quantity: null,
          basis_price: null,
        },
      ],
    });
    const seedsAfterWrite = priceTable.seedRpcCalls;
    expect(seedsAfterWrite).toBe(1);

    const after1 = await loadDigitalWhiteSheetCalculation(
      database,
      { sourceId: SOURCE_ID, marketKey: "ki", marketLabel: MARKET, businessDate: BUSINESS_DATE },
      ZERO_CASH,
    );
    const after2 = await loadDigitalWhiteSheetCalculation(
      database,
      { sourceId: SOURCE_ID, marketKey: "ki", marketLabel: MARKET, businessDate: BUSINESS_DATE },
      ZERO_CASH,
    );
    const after3 = await loadDigitalWhiteSheetCalculation(
      database,
      { sourceId: SOURCE_ID, marketKey: "ki", marketLabel: MARKET, businessDate: BUSINESS_DATE },
      ZERO_CASH,
    );

    expect(after1.expectedSales).toBe(80);
    expect(after2.expectedSales).toBe(80);
    expect(after3.expectedSales).toBe(80);
    expect(priceTable.seedRpcCalls).toBe(seedsAfterWrite);
    expect(priceTable.rows).toHaveLength(1);
  });

  it("D: same-price later withdrawal across another market does not change price", async () => {
    const priceTable = makePriceTable();
    const database = makeSheetDatabase({ produceRows: [], priceTable });

    await seedCentralPricesFromPersistedWithdrawals(database, {
      businessDate: BUSINESS_DATE,
      items: [
        {
          product_name: "แตงโม",
          unit: "ลูก",
          price_per_unit: 40,
          transaction_type: "เบิก",
          basis_quantity: null,
          basis_price: null,
        },
      ],
    });
    await seedCentralPricesFromPersistedWithdrawals(database, {
      businessDate: BUSINESS_DATE,
      items: [
        {
          product_name: "แตงโม",
          unit: "ลูก",
          price_per_unit: 40,
          transaction_type: "เบิก",
          basis_quantity: null,
          basis_price: null,
        },
      ],
    });

    expect(priceTable.rows).toHaveLength(1);
    expect(priceTable.rows[0]?.price_satang).toBe(4000);
  });

  it("E: a different price in another market preserves the reference and the entered market value", async () => {
    const priceTable = makePriceTable();
    const produceRows = [
      {
        id: "item-a",
        product_name: "แตงโม",
        quantity: 2,
        unit: "ลูก",
        price_per_unit: 40,
        transaction_type: "เบิก",
        base_transaction_type: "เบิก",
        item_created_at: "2026-07-24T01:00:00Z",
        session_id: "sess-a",
        transaction_date: BUSINESS_DATE,
        market_name: MARKET,
        raw_message_id: "raw-a",
        basis_quantity: null,
        basis_price: null,
        session_kind: "main",
      },
      {
        id: "item-b",
        product_name: "แตงโม",
        quantity: 1,
        unit: "ลูก",
        price_per_unit: 35,
        transaction_type: "เบิก",
        base_transaction_type: "เบิก",
        item_created_at: "2026-07-24T02:00:00Z",
        session_id: "sess-b",
        transaction_date: BUSINESS_DATE,
        market_name: MARKET_B,
        raw_message_id: "raw-b",
        basis_quantity: null,
        basis_price: null,
        session_kind: "main",
      },
    ];
    const database = makeSheetDatabase({ produceRows, priceTable });

    await seedCentralPricesFromPersistedWithdrawals(database, {
      businessDate: BUSINESS_DATE,
      items: [
        {
          product_name: "แตงโม",
          unit: "ลูก",
          price_per_unit: 40,
          transaction_type: "เบิก",
          basis_quantity: null,
          basis_price: null,
        },
      ],
    });
    await seedCentralPricesFromPersistedWithdrawals(database, {
      businessDate: BUSINESS_DATE,
      items: [
        {
          product_name: "แตงโม",
          unit: "ลูก",
          price_per_unit: 35,
          transaction_type: "เบิก",
          basis_quantity: null,
          basis_price: null,
        },
      ],
    });

    expect(priceTable.rows[0]?.price_satang).toBe(4000);

    const calc = await loadDigitalWhiteSheetCalculation(
      database,
      { sourceId: SOURCE_ID, marketKey: "ki", marketLabel: MARKET, businessDate: BUSINESS_DATE },
      ZERO_CASH,
    );
    expect(calc.expectedSales).toBe(80);
    expect(calc.warnings.some((w) => w.startsWith("ราคากลางขัดแย้งกันสำหรับ"))).toBe(false);
  });

  it("F/G: good return and damaged return do not seed", async () => {
    const priceTable = makePriceTable();
    const database = makeSheetDatabase({ produceRows: [], priceTable });

    const returnsOnly: PersistedWithdrawalSeedItem[] = [
      {
        product_name: "มะม่วง",
        unit: "ลูก",
        price_per_unit: 999,
        transaction_type: "คืน",
        basis_quantity: null,
        basis_price: null,
      },
      {
        product_name: "มะม่วง",
        unit: "ลูก",
        price_per_unit: 999,
        transaction_type: "คืนเสีย",
        basis_quantity: null,
        basis_price: null,
      },
    ];

    await seedCentralPricesFromPersistedWithdrawals(database, {
      businessDate: BUSINESS_DATE,
      items: returnsOnly,
    });

    expect(priceTable.rows).toHaveLength(0);
    expect(priceTable.seedRpcCalls).toBe(0);
  });

  it("H: invalid/failed withdrawal persistence does not seed", async () => {
    const seedCalls: unknown[] = [];
    const event: LineMessageEvent = {
      type: "message",
      webhookEventId: "event-failed-persist-no-seed",
      deliveryContext: { isRedelivery: false },
      timestamp: Date.UTC(2026, 6, 24, 5, 0, 0),
      source: { type: "user", userId: "user-1" },
      mode: "active",
      replyToken: "reply-token",
      message: {
        id: "message-failed-persist-no-seed",
        type: "text",
        quoteToken: "quote-token",
        text: [
          "กี้-ตลาดกี้ เบิก 24/7/2569",
          "1.แตงโม40บาท",
          "2ลูก",
          "จบรายการเบิก",
        ].join("\n"),
      },
    };

    const result = await new WeighSessionParser().parse(event);
    const database = {
      from(table: string) {
        if (table === "produce_sessions") {
          return {
            insert() {
              return {
                select() {
                  return {
                    async single() {
                      return { data: null, error: { message: "insert failed" } };
                    },
                  };
                },
              };
            },
            delete: () => ({ eq: async () => ({ error: null }) }),
          };
        }
        return {
          insert() {
            throw new Error("produce_items must not be reached");
          },
        };
      },
      async rpc(fn: string, args: unknown) {
        seedCalls.push({ fn, args });
        return { data: null, error: null };
      },
    };

    await expect(
      result.persist(database as never, "raw-failed"),
    ).rejects.toThrow(/produce_session insert failed/);
    expect(seedCalls).toHaveLength(0);
  });

  it("I: admin-corrected reference does not replace persisted entered market prices", async () => {
    const priceTable = makePriceTable([
      {
        product_key: "แตงโม",
        unit_key: "ลูก",
        business_date: BUSINESS_DATE,
        price_satang: 4000,
        set_by: SYSTEM_WITHDRAWAL_SEED_ACTOR,
        set_reason: "auto-seeded",
        created_at: "2026-07-24T00:00:00Z",
        updated_at: "2026-07-24T00:00:00Z",
      },
    ]);

    await priceTable.rpc("set_central_selling_price", {
      p_product_key: "แตงโม",
      p_unit_key: "ลูก",
      p_business_date: BUSINESS_DATE,
      p_price_satang: 4500,
      p_actor: "admin-1",
      p_reason: "correction",
    });

    // Later conflicting withdrawal write must not recreate a system conflict.
    const database = makeSheetDatabase({
      produceRows: [
        {
          id: "item-a",
          product_name: "แตงโม",
          quantity: 2,
          unit: "ลูก",
          price_per_unit: 40,
          transaction_type: "เบิก",
          base_transaction_type: "เบิก",
          item_created_at: "2026-07-24T01:00:00Z",
          session_id: "sess-a",
          transaction_date: BUSINESS_DATE,
          market_name: MARKET,
          raw_message_id: "raw-a",
          basis_quantity: null,
          basis_price: null,
          session_kind: "main",
        },
      ],
      priceTable,
    });

    await seedCentralPricesFromPersistedWithdrawals(database, {
      businessDate: BUSINESS_DATE,
      items: [
        {
          product_name: "แตงโม",
          unit: "ลูก",
          price_per_unit: 40,
          transaction_type: "เบิก",
          basis_quantity: null,
          basis_price: null,
        },
      ],
    });

    expect(priceTable.rows[0]?.price_satang).toBe(4500);
    expect(priceTable.rows[0]?.set_by).toBe("admin-1");

    const calc = await loadDigitalWhiteSheetCalculation(
      database,
      { sourceId: SOURCE_ID, marketKey: "ki", marketLabel: MARKET, businessDate: BUSINESS_DATE },
      ZERO_CASH,
    );
    expect(calc.expectedSales).toBe(80);
    expect(calc.warnings.some((w) => w.startsWith("ราคากลางขัดแย้งกันสำหรับ"))).toBe(false);
  });

  it("J: financial fixture remains matched at expectedCash 16", async () => {
    // Same numbers as local-uat: expectedSales 286, transfers 200, expenses 70,
    // expectedCash 16, actualCash 16 → matched.
    type CashEntryRow = Database["public"]["Tables"]["digital_white_sheet_cash_entries"]["Row"];
    const cashEntries = new Map<string, CashEntryRow>();
    const marketLabel = "ตลาดยูเอที";
    const priceTable = makePriceTable([
      {
        product_key: "แตงโม",
        unit_key: "โล",
        business_date: BUSINESS_DATE,
        price_satang: 2000,
        set_by: SYSTEM_WITHDRAWAL_SEED_ACTOR,
        set_reason: null,
        created_at: "2026-07-24T00:00:00Z",
        updated_at: "2026-07-24T00:00:00Z",
      },
      {
        product_key: "มะม่วง",
        unit_key: "ลูก",
        business_date: BUSINESS_DATE,
        price_satang: 500,
        set_by: SYSTEM_WITHDRAWAL_SEED_ACTOR,
        set_reason: null,
        created_at: "2026-07-24T00:00:00Z",
        updated_at: "2026-07-24T00:00:00Z",
      },
    ]);

    const produceRows = [
      {
        id: "item-1",
        product_name: "แตงโม",
        quantity: 10,
        unit: "โล",
        price_per_unit: 20,
        transaction_type: "เบิก",
        base_transaction_type: "เบิก",
        item_created_at: "2026-07-24T01:00:00Z",
        session_id: "main-session-uat",
        transaction_date: BUSINESS_DATE,
        market_name: marketLabel,
        raw_message_id: "raw-uat-1",
        basis_quantity: null,
        basis_price: null,
        session_kind: "main",
      },
      {
        id: "item-2",
        product_name: "แตงโม",
        quantity: 5,
        unit: "ขีด",
        price_per_unit: null,
        transaction_type: "คืน",
        base_transaction_type: "คืน",
        item_created_at: "2026-07-24T01:30:00Z",
        session_id: "main-session-uat",
        transaction_date: BUSINESS_DATE,
        market_name: marketLabel,
        raw_message_id: "raw-uat-1",
        basis_quantity: null,
        basis_price: null,
        session_kind: "main",
      },
      {
        id: "item-3",
        product_name: "แตงโม",
        quantity: 2,
        unit: "ขีด",
        price_per_unit: null,
        transaction_type: "คืนเสีย",
        base_transaction_type: "คืนเสีย",
        item_created_at: "2026-07-24T01:45:00Z",
        session_id: "main-session-uat",
        transaction_date: BUSINESS_DATE,
        market_name: marketLabel,
        raw_message_id: "raw-uat-1",
        basis_quantity: null,
        basis_price: null,
        session_kind: "main",
      },
      {
        id: "item-4",
        product_name: "มะม่วง",
        quantity: 20,
        unit: "ลูก",
        price_per_unit: 5,
        transaction_type: "เบิก",
        base_transaction_type: "เบิก",
        item_created_at: "2026-07-24T02:00:00Z",
        session_id: "main-session-uat",
        transaction_date: BUSINESS_DATE,
        market_name: marketLabel,
        raw_message_id: "raw-uat-1",
        basis_quantity: null,
        basis_price: null,
        session_kind: "main",
      },
    ];

    const slipEvidences = [
      { id: "ev-uat-1", received_at: "2026-07-24T02:00:00Z", market_label: marketLabel },
      { id: "ev-uat-2", received_at: "2026-07-24T03:00:00Z", market_label: marketLabel },
    ];
    const slipChecks = [
      { id: "chk-a", evidence_id: "ev-uat-1", transfer_amount: 150, reference_id: "REF-100", created_at: "2026-07-24T02:05:00Z", status: "EXTRACTED" },
      { id: "chk-b", evidence_id: "ev-uat-1", transfer_amount: 150, reference_id: "REF-100", created_at: "2026-07-24T02:10:00Z", status: "EXTRACTED" },
      { id: "chk-c", evidence_id: "ev-uat-2", transfer_amount: 50, reference_id: "REF-200", created_at: "2026-07-24T03:05:00Z", status: "EXTRACTED" },
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
              in: async () => ({ data: [{ id: "raw-uat-1", source_id: SOURCE_ID }], error: null }),
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
          return { select: priceTable.select };
        }
        if (table === "slip_checks") {
          return {
            select: (columns: string) => {
              const evidenceScoped = columns.includes("transfer_amount");
              const builder = {
                in: () => builder,
                not: () => builder,
                order: () => builder,
                then: (resolve: (value: unknown) => void) =>
                  resolve({
                    data: evidenceScoped
                      ? slipChecks
                      : slipChecks.map(({ id, reference_id, created_at }) => ({
                          id,
                          reference_id,
                          created_at,
                        })),
                    error: null,
                  }),
              };
              return builder;
            },
          };
        }
        if (table === "digital_white_sheet_cash_entries") {
          type Filter = { column: string; value: unknown };
          const matches = (row: CashEntryRow, filters: Filter[]) =>
            filters.every(({ column, value }) => (row as Record<string, unknown>)[column] === value);
          return {
            select: () => {
              const filters: Filter[] = [];
              const builder = {
                eq: (column: string, value: unknown) => {
                  filters.push({ column, value });
                  return builder;
                },
                is: (column: string, value: unknown) => {
                  filters.push({ column, value });
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
                    `${merged.source_id}::${merged.market_label_normalized}::${merged.business_date}`,
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
                  filters.push({ column, value });
                  return builder;
                },
                is: (column: string, value: unknown) => {
                  filters.push({ column, value });
                  return builder;
                },
                select: () => ({
                  maybeSingle: async () => {
                    const found = [...cashEntries.entries()].find(([, row]) => matches(row, filters));
                    if (!found) return { data: null, error: null };
                    const [key, existing] = found;
                    const merged = { ...existing, ...values } as CashEntryRow;
                    cashEntries.set(key, merged);
                    return { data: merged, error: null };
                  },
                }),
              };
              return builder;
            },
          };
        }
        const manualSlip = stubManualSlipTables()(table);
        if (manualSlip) return manualSlip;
        throw new Error(`unexpected table: ${table}`);
      },
      rpc: priceTable.rpc,
    } as unknown as SupabaseClient<Database>;

    const seedsBefore = priceTable.seedRpcCalls;
    await saveWhiteSheetCashEntry(database, {
      sourceId: SOURCE_ID,
      marketLabelNormalized: normalizedMarketLabel(marketLabel),
      businessDate: BUSINESS_DATE,
      labor: 30,
      locationFee: 20,
      bag: 5,
      snack: 5,
      other: 10,
      otherNote: "ค่าน้ำแข็ง",
      actualCashSubmitted: 16,
    });

    const pageModel = await loadDigitalWhiteSheetPageModel(database, {
      sourceId: SOURCE_ID,
      marketKey: "uat",
      marketLabel,
      businessDate: BUSINESS_DATE,
    });

    expect(pageModel.summary.expectedSales).toBe(286);
    expect(pageModel.summary.verifiedTransfers).toBe(200);
    expect(pageModel.summary.expenseTotal).toBe(70);
    expect(pageModel.summary.expectedCash).toBe(16);
    expect(pageModel.summary.actualCashSubmitted).toBe(16);
    expect(pageModel.summary.status).toBe("matched");
    expect(priceTable.seedRpcCalls).toBe(seedsBefore);
  });
});

// ── Regression: subunit price-rescaling fix must seed the un-rescaled price ──
//
// Before commit 87b1f98, applyQuantity() in the weigh-session parser divided
// price_per_unit by the ขีด→โล conversion factor (0.1), so a real
// "องุ่นคิมสัน 120บาท / 0.7ขีด" withdrawal seeded its central selling price
// from an inflated 1200 baht (120000 satang) instead of the header's real
// 120 baht (12000 satang). This drives the corrected parser output through
// the actual write-path persist() → seedCentralPricesFromPersistedWithdrawals
// boundary — not a hand-built item list — so a regression in either the
// parser or the seeding math would be caught here.
describe("central price seeding after the subunit price-rescaling fix", () => {
  it("seeds 12000 satang, not 120000, for องุ่นคิมสัน 120บาท / 0.7ขีด via the full persist path", async () => {
    const priceTable = makePriceTable();
    const itemInserts: Array<Record<string, unknown>> = [];
    const database = {
      from(table: string) {
        if (table === "produce_sessions") {
          return {
            insert() {
              return {
                select() {
                  return {
                    async single() {
                      return { data: { id: "session-subunit-price-fix" }, error: null };
                    },
                  };
                },
              };
            },
          };
        }
        if (table === "produce_items") {
          return {
            insert(payload: Record<string, unknown>) {
              itemInserts.push(payload);
              return Promise.resolve({ error: null });
            },
          };
        }
        throw new Error(`unexpected table: ${table}`);
      },
      rpc: priceTable.rpc,
    };

    const event: LineMessageEvent = {
      type: "message",
      webhookEventId: "event-subunit-price-fix",
      deliveryContext: { isRedelivery: false },
      timestamp: Date.UTC(2026, 6, 24, 5, 0, 0),
      source: { type: "user", userId: "user-1" },
      mode: "active",
      replyToken: "reply-token",
      message: {
        id: "message-subunit-price-fix",
        type: "text",
        quoteToken: "quote-token",
        text: [
          "กี้-ตลาดกี้ เบิก 24/7/2569",
          "2องุ่นคิมสัน120บาท",
          "0.7ขีด",
          "จบรายการเบิก",
        ].join("\n"),
      },
    };

    const result = await new WeighSessionParser().parse(event);
    await result.persist(database as never, "raw-subunit-price-fix");

    expect(itemInserts).toHaveLength(1);
    expect(itemInserts[0]).toMatchObject({
      product_name:   "องุ่นคิมสัน",
      quantity:       0.07,
      unit:           "โล",
      price_per_unit: 120,
    });

    expect(priceTable.rows).toHaveLength(1);
    expect(priceTable.rows[0]).toMatchObject({
      product_key:   "องุ่นคิมสัน",
      unit_key:      "โล",
      business_date: BUSINESS_DATE,
      price_satang:  12000,
      set_by:        SYSTEM_WITHDRAWAL_SEED_ACTOR,
    });
  });
});
