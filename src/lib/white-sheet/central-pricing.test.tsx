import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { loadDigitalWhiteSheetCalculation } from "./load";
import { SYSTEM_WITHDRAWAL_SEED_ACTOR } from "./pricing";
import { seedCentralPricesFromPersistedWithdrawals } from "./seed-from-withdrawal";
import { stubManualSlipTables } from "@/lib/white-sheet/test-manual-slip-db";

const SOURCE_ID = "group-central-pricing";
const BUSINESS_DATE = "2026-07-24";

interface ProduceRowInput {
  id: string;
  product_name: string;
  quantity: number;
  unit: string;
  price_per_unit: number;
  market_name: string;
  session_id: string;
  raw_message_id: string;
  transaction_date?: string;
  item_created_at?: string;
  base_transaction_type?: string;
}

interface CentralPriceRowInput {
  product_key: string;
  unit_key: string;
  price_satang: number;
  business_date?: string;
  set_by?: string;
}

/** Full central_selling_prices row shape, defaulted like the real table. */
function fullPriceRow(row: CentralPriceRowInput, idSuffix: string) {
  return {
    id: `price-${idSuffix}`,
    product_key: row.product_key,
    unit_key: row.unit_key,
    business_date: row.business_date ?? BUSINESS_DATE,
    price_satang: row.price_satang,
    set_by: row.set_by ?? "admin-seed",
    set_reason: null as string | null,
    created_at: "2026-07-24T00:00:00Z",
    updated_at: "2026-07-24T00:00:00Z",
  };
}

/**
 * Shared, mutable fake central_selling_prices table — a single instance is
 * reused across multiple loadDigitalWhiteSheetCalculation calls (one per
 * market) so a seed written on withdrawal persist is visible when any
 * market's White Sheet is loaded next, exactly like two requests hitting the
 * same real Postgres table.
 */
function makeCentralPriceTable(initial: CentralPriceRowInput[]) {
  const rows = initial.map((row, i) => fullPriceRow(row, `seed-${i}`));
  let counter = 0;
  let seedRpcCalls = 0;
  return {
    rows,
    get seedRpcCalls() {
      return seedRpcCalls;
    },
    select: () => ({ eq: async () => ({ data: rows, error: null }) }),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn !== "seed_central_selling_price" && fn !== "set_central_selling_price") {
        return { data: null, error: { message: `unexpected rpc: ${fn}` } };
      }
      const existing = rows.find(
        (r) => r.product_key === args.p_product_key
          && r.unit_key === args.p_unit_key
          && r.business_date === args.p_business_date,
      );
      if (fn === "seed_central_selling_price") {
        seedRpcCalls += 1;
        if (existing) return { data: existing, error: null };
        const created = fullPriceRow(
          {
            product_key: args.p_product_key as string,
            unit_key: args.p_unit_key as string,
            business_date: args.p_business_date as string,
            price_satang: args.p_price_satang as number,
            set_by: args.p_actor as string,
          },
          `new-${counter++}`,
        );
        rows.push(created);
        return { data: created, error: null };
      }
      // set_central_selling_price: admin correction always overwrites.
      if (existing) {
        existing.price_satang = args.p_price_satang as number;
        existing.set_by = args.p_actor as string;
        existing.set_reason = (args.p_reason as string | null) ?? null;
        return { data: existing, error: null };
      }
      const created = fullPriceRow(
        {
          product_key: args.p_product_key as string,
          unit_key: args.p_unit_key as string,
          business_date: args.p_business_date as string,
          price_satang: args.p_price_satang as number,
          set_by: args.p_actor as string,
        },
        `new-${counter++}`,
      );
      rows.push(created);
      return { data: created, error: null };
    },
  };
}

function makeDatabase(options: {
  produceRows: Array<Omit<ProduceRowInput, "price_per_unit"> & { price_per_unit: number | null }>;
  centralPriceTable: ReturnType<typeof makeCentralPriceTable>;
}) {
  const produceRows = options.produceRows.map((row) => ({
    transaction_type: "เบิก",
    base_transaction_type: "เบิก",
    item_created_at: "2026-07-24T01:00:00Z",
    transaction_date: BUSINESS_DATE,
    basis_quantity: null,
    basis_price: null,
    session_kind: "main",
    ...row,
  }));
  const rawMessageIds = [...new Set(produceRows.map((r) => r.raw_message_id))];
  const rawMessages = rawMessageIds.map((id) => ({ id, source_id: SOURCE_ID }));

  const database = {
    from(table: string) {
      if (table === "produce_transactions") {
        const builder = {
          select: () => builder,
          eq: () => builder,
          in: () => builder,
          order: () => builder,
          range: async () => ({ data: produceRows, error: null, count: produceRows.length }),
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
        return { select: options.centralPriceTable.select };
      }
      const manualSlip = stubManualSlipTables()(table);
        if (manualSlip) return manualSlip;
        throw new Error(`unexpected table: ${table}`);
    },
    rpc: options.centralPriceTable.rpc,
  };
  return database as unknown as SupabaseClient<Database>;
}

/** Simulate the write-path seed that runs after a successful withdrawal persist. */
async function seedFromWithdrawalWrite(
  database: SupabaseClient<Database>,
  rows: readonly ProduceRowInput[],
) {
  await seedCentralPricesFromPersistedWithdrawals(database, {
    businessDate: BUSINESS_DATE,
    items: rows
      .filter((row) => (row.base_transaction_type ?? "เบิก") === "เบิก")
      .map((row) => ({
        product_name: row.product_name,
        unit: row.unit,
        price_per_unit: row.price_per_unit,
        transaction_type: "เบิก",
        basis_quantity: null,
        basis_price: null,
      })),
  });
}

const ZERO_EXPENSES = { expenses: { labor: 0, locationFee: 0, bag: 0, snack: 0, other: 0 }, actualCashSubmitted: 0 };

describe("Phase 12: cross-market central price", () => {
  it("each market keeps its persisted entered price despite a shared central reference", async () => {
    const MARKET_A = "ตลาดเอ";
    const MARKET_B = "ตลาดบี";
    const centralPriceTable = makeCentralPriceTable([{ product_key: "ทุเรียน", unit_key: "โล", price_satang: 2500 }]); // 25 baht

    const databaseA = makeDatabase({
      produceRows: [
        { id: "item-a", product_name: "ทุเรียน", quantity: 10, unit: "โล", price_per_unit: 20, market_name: MARKET_A, session_id: "sess-a", raw_message_id: "raw-a" },
      ],
      centralPriceTable,
    });
    const databaseB = makeDatabase({
      produceRows: [
        { id: "item-b", product_name: "ทุเรียน", quantity: 10, unit: "โล", price_per_unit: 30, market_name: MARKET_B, session_id: "sess-b", raw_message_id: "raw-b" },
      ],
      centralPriceTable,
    });

    const calcA = await loadDigitalWhiteSheetCalculation(
      databaseA,
      { sourceId: SOURCE_ID, marketKey: "a", marketLabel: MARKET_A, businessDate: BUSINESS_DATE },
      ZERO_EXPENSES,
    );
    const calcB = await loadDigitalWhiteSheetCalculation(
      databaseB,
      { sourceId: SOURCE_ID, marketKey: "b", marketLabel: MARKET_B, businessDate: BUSINESS_DATE },
      ZERO_EXPENSES,
    );

    // Persisted entered prices are authoritative under PR #184.
    expect(calcA.expectedSales).toBe(200);
    expect(calcB.expectedSales).toBe(300);
  });
});

describe("Phase 13: old/carried stock vs current business date", () => {
  it("the business date selects evidence without replacing its persisted entered price", async () => {
    // Business-date scoping must preserve the price recorded on the withdrawal.
    const MARKET = "ตลาดเก่า";
    const database = makeDatabase({
      produceRows: [
        {
          id: "item-old-stock",
          product_name: "ทุเรียน",
          quantity: 5,
          unit: "โล",
          price_per_unit: 15,
          market_name: MARKET,
          session_id: "sess-old",
          raw_message_id: "raw-old",
          transaction_date: BUSINESS_DATE,
        },
      ],
      centralPriceTable: makeCentralPriceTable([{ product_key: "ทุเรียน", unit_key: "โล", price_satang: 2200 }]), // today's central price = 22
    });

    const calculation = await loadDigitalWhiteSheetCalculation(
      database,
      { sourceId: SOURCE_ID, marketKey: "old", marketLabel: MARKET, businessDate: BUSINESS_DATE },
      ZERO_EXPENSES,
    );

    // 5 โล × 15 (persisted entered price) = 75.
    expect(calculation.expectedSales).toBe(75);
  });
});

describe("Phase 14: missing persisted price fails closed", () => {
  it("an unpriced withdrawal is rejected before any financial summary can be built", async () => {
    // Withdrawal rows exist but write-path seeding never ran — White Sheet
    // load is read-only and must fail closed rather than invent a price.
    const MARKET = "ตลาดไม่มีราคา";
    const database = makeDatabase({
      produceRows: [
        { id: "item-1", product_name: "ทุเรียน", quantity: 10, unit: "โล", price_per_unit: null, market_name: MARKET, session_id: "sess-1", raw_message_id: "raw-1" },
      ],
      centralPriceTable: makeCentralPriceTable([]),
    });

    await expect(loadDigitalWhiteSheetCalculation(
      database,
      { sourceId: SOURCE_ID, marketKey: "no-price", marketLabel: MARKET, businessDate: BUSINESS_DATE },
      ZERO_EXPENSES,
    )).rejects.toThrow("has no persisted price_per_unit");
  });
});

describe("BR-01 seed rule: first withdrawal establishes the central price on write", () => {
  it("A: the first withdrawal write seeds the central price — no manual admin step required", async () => {
    const MARKET = "ตลาดกี้";
    const rows: ProduceRowInput[] = [
      { id: "item-1", product_name: "แตงโม", quantity: 2, unit: "ลูก", price_per_unit: 40, market_name: MARKET, session_id: "sess-1", raw_message_id: "raw-1" },
    ];
    const centralPriceTable = makeCentralPriceTable([]);
    const database = makeDatabase({ produceRows: rows, centralPriceTable });

    await seedFromWithdrawalWrite(database, rows);
    expect(centralPriceTable.rows).toHaveLength(1);
    expect(centralPriceTable.rows[0]?.price_satang).toBe(4000);
    const seedsAfterWrite = centralPriceTable.seedRpcCalls;

    const calculation = await loadDigitalWhiteSheetCalculation(
      database,
      { sourceId: SOURCE_ID, marketKey: "ki", marketLabel: MARKET, businessDate: BUSINESS_DATE },
      ZERO_EXPENSES,
    );

    expect(calculation.expectedSales).toBe(80); // 2 × 40
    expect(calculation.warnings).toEqual([]);
    expect(centralPriceTable.seedRpcCalls).toBe(seedsAfterWrite); // load did not seed
  });

  it("B: a later withdrawal in a different market at the SAME price is not a conflict", async () => {
    const MARKET_KI = "ตลาดกี้";
    const MARKET_NOI = "ตลาดน้อย";
    const centralPriceTable = makeCentralPriceTable([]);

    const rowsKi: ProduceRowInput[] = [
      { id: "item-ki", product_name: "แตงโม", quantity: 2, unit: "ลูก", price_per_unit: 40, market_name: MARKET_KI, session_id: "sess-ki", raw_message_id: "raw-ki" },
    ];
    const rowsNoi: ProduceRowInput[] = [
      { id: "item-noi", product_name: "แตงโม", quantity: 3, unit: "ลูก", price_per_unit: 40, market_name: MARKET_NOI, session_id: "sess-noi", raw_message_id: "raw-noi" },
    ];

    const dbKi = makeDatabase({ produceRows: rowsKi, centralPriceTable });
    const dbNoi = makeDatabase({ produceRows: rowsNoi, centralPriceTable });

    await seedFromWithdrawalWrite(dbKi, rowsKi);
    await seedFromWithdrawalWrite(dbNoi, rowsNoi);
    expect(centralPriceTable.rows).toHaveLength(1);
    expect(centralPriceTable.rows[0]?.price_satang).toBe(4000);

    const calcKi = await loadDigitalWhiteSheetCalculation(
      dbKi,
      { sourceId: SOURCE_ID, marketKey: "ki", marketLabel: MARKET_KI, businessDate: BUSINESS_DATE },
      ZERO_EXPENSES,
    );
    const calcNoi = await loadDigitalWhiteSheetCalculation(
      dbNoi,
      { sourceId: SOURCE_ID, marketKey: "noi", marketLabel: MARKET_NOI, businessDate: BUSINESS_DATE },
      ZERO_EXPENSES,
    );

    expect(calcKi.expectedSales).toBe(80);
    expect(calcKi.warnings).toEqual([]);
    expect(calcNoi.expectedSales).toBe(120); // 3 × 40, no conflict
    expect(calcNoi.warnings).toEqual([]);
  });

  it("C/D: different entered prices across markets leave the central reference unchanged and preserve each market value", async () => {
    const MARKET_KI = "ตลาดกี้";
    const MARKET_DAM = "ตลาดดำ";
    const centralPriceTable = makeCentralPriceTable([]);

    const allRows: ProduceRowInput[] = [
      { id: "item-ki", product_name: "แตงโม", quantity: 2, unit: "ลูก", price_per_unit: 40, market_name: MARKET_KI, session_id: "sess-ki", raw_message_id: "raw-ki", item_created_at: "2026-07-24T01:00:00Z" },
      { id: "item-dam", product_name: "แตงโม", quantity: 1, unit: "ลูก", price_per_unit: 35, market_name: MARKET_DAM, session_id: "sess-dam", raw_message_id: "raw-dam", item_created_at: "2026-07-24T02:00:00Z" },
    ];

    const db = makeDatabase({ produceRows: allRows, centralPriceTable });
    await seedFromWithdrawalWrite(db, [allRows[0]!]);
    await seedFromWithdrawalWrite(db, [allRows[1]!]);
    expect(centralPriceTable.rows[0]?.price_satang).toBe(4000);

    const calcKi = await loadDigitalWhiteSheetCalculation(
      db,
      { sourceId: SOURCE_ID, marketKey: "ki", marketLabel: MARKET_KI, businessDate: BUSINESS_DATE },
      ZERO_EXPENSES,
    );

    expect(calcKi.expectedSales).toBe(80);
    expect(calcKi.warnings).toEqual([]);

    const calcDam = await loadDigitalWhiteSheetCalculation(
      db,
      { sourceId: SOURCE_ID, marketKey: "dam", marketLabel: MARKET_DAM, businessDate: BUSINESS_DATE },
      ZERO_EXPENSES,
    );

    expect(calcDam.expectedSales).toBe(35);
    expect(calcDam.warnings).toEqual([]);
    expect(centralPriceTable.rows[0]?.price_satang).toBe(4000);
  });

  it("E/F: returns and damaged returns never seed or overwrite the central price", async () => {
    const MARKET = "ตลาดคืน";
    const centralPriceTable = makeCentralPriceTable([]);
    const produceRows: ProduceRowInput[] = [
      { id: "item-withdraw", product_name: "มะม่วง", quantity: 5, unit: "ลูก", price_per_unit: 5, market_name: MARKET, session_id: "sess-1", raw_message_id: "raw-1", item_created_at: "2026-07-24T01:00:00Z" },
      { id: "item-return", product_name: "มะม่วง", quantity: 1, unit: "ลูก", price_per_unit: 999, market_name: MARKET, session_id: "sess-1", raw_message_id: "raw-1", item_created_at: "2026-07-24T02:00:00Z", base_transaction_type: "คืน" },
      { id: "item-damaged", product_name: "มะม่วง", quantity: 1, unit: "ลูก", price_per_unit: 999, market_name: MARKET, session_id: "sess-1", raw_message_id: "raw-1", item_created_at: "2026-07-24T03:00:00Z", base_transaction_type: "คืนเสีย" },
    ];
    const database = makeDatabase({ produceRows, centralPriceTable });

    await seedCentralPricesFromPersistedWithdrawals(database, {
      businessDate: BUSINESS_DATE,
      items: produceRows.map((row) => ({
        product_name: row.product_name,
        unit: row.unit,
        price_per_unit: row.price_per_unit,
        transaction_type: row.base_transaction_type ?? "เบิก",
        basis_quantity: null,
        basis_price: null,
      })),
    });

    expect(centralPriceTable.rows).toHaveLength(1);
    expect(centralPriceTable.rows[0]?.price_satang).toBe(500);

    const calculation = await loadDigitalWhiteSheetCalculation(
      database,
      { sourceId: SOURCE_ID, marketKey: "return", marketLabel: MARKET, businessDate: BUSINESS_DATE },
      ZERO_EXPENSES,
    );

    expect(calculation.warnings).toEqual([]);
    expect(calculation.expectedSales).toBe(15); // (5 - 1 - 1) sold × 5
  });

  it("H: an admin correction updates the central reference without replacing persisted market prices", async () => {
    const MARKET_A = "ตลาดเอ";
    const MARKET_B = "ตลาดบี";
    const centralPriceTable = makeCentralPriceTable([
      { product_key: "แตงโม", unit_key: "ลูก", price_satang: 4000, set_by: SYSTEM_WITHDRAWAL_SEED_ACTOR },
    ]);

    await centralPriceTable.rpc("set_central_selling_price", {
      p_product_key: "แตงโม",
      p_unit_key: "ลูก",
      p_business_date: BUSINESS_DATE,
      p_price_satang: 4500,
      p_actor: "admin-1",
      p_reason: "correction",
    });

    const dbA = makeDatabase({
      produceRows: [
        { id: "item-a", product_name: "แตงโม", quantity: 2, unit: "ลูก", price_per_unit: 40, market_name: MARKET_A, session_id: "sess-a", raw_message_id: "raw-a" },
      ],
      centralPriceTable,
    });
    const dbB = makeDatabase({
      produceRows: [
        { id: "item-b", product_name: "แตงโม", quantity: 3, unit: "ลูก", price_per_unit: 40, market_name: MARKET_B, session_id: "sess-b", raw_message_id: "raw-b" },
      ],
      centralPriceTable,
    });

    const calcA = await loadDigitalWhiteSheetCalculation(
      dbA,
      { sourceId: SOURCE_ID, marketKey: "a", marketLabel: MARKET_A, businessDate: BUSINESS_DATE },
      ZERO_EXPENSES,
    );
    const calcB = await loadDigitalWhiteSheetCalculation(
      dbB,
      { sourceId: SOURCE_ID, marketKey: "b", marketLabel: MARKET_B, businessDate: BUSINESS_DATE },
      ZERO_EXPENSES,
    );

    expect(calcA.expectedSales).toBe(80); // 2 × entered 40
    expect(calcB.expectedSales).toBe(120); // 3 × entered 40
    expect(calcA.warnings.some((w) => w.startsWith("ราคากลางขัดแย้งกันสำหรับ"))).toBe(false);
    expect(calcB.warnings.some((w) => w.startsWith("ราคากลางขัดแย้งกันสำหรับ"))).toBe(false);
  });

  it("I: a second concurrent seed attempt for the same identity does not silently overwrite the first", async () => {
    const centralPriceTable = makeCentralPriceTable([]);
    const database = makeDatabase({ produceRows: [], centralPriceTable });

    const first = await database.rpc("seed_central_selling_price", {
      p_product_key: "แตงโม",
      p_unit_key: "ลูก",
      p_business_date: BUSINESS_DATE,
      p_price_satang: 4000,
      p_actor: SYSTEM_WITHDRAWAL_SEED_ACTOR,
      p_reason: null,
    });
    const second = await database.rpc("seed_central_selling_price", {
      p_product_key: "แตงโม",
      p_unit_key: "ลูก",
      p_business_date: BUSINESS_DATE,
      p_price_satang: 3500,
      p_actor: SYSTEM_WITHDRAWAL_SEED_ACTOR,
      p_reason: null,
    });

    expect((first.data as { price_satang: number }).price_satang).toBe(4000);
    expect((second.data as { price_satang: number }).price_satang).toBe(4000);
    expect(centralPriceTable.rows).toHaveLength(1);
  });
});
