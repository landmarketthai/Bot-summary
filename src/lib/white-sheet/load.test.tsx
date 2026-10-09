import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DigitalWhiteSheetSummary as DashboardSummary } from "@/components/white-sheet/DigitalWhiteSheetSummary";
import { buildWhiteSheetSummaryMessage } from "@/lib/line/white-sheet-summary";
import type { Database } from "@/types/database";
import { stubManualSlipTables } from "@/lib/white-sheet/test-manual-slip-db";
import {
  loadDigitalWhiteSheetCalculation,
  loadDigitalWhiteSheetPageModel,
} from "./test-certified-returns";
import {
  requireTrustedWhiteSheetSummary,
  WhiteSheetHardStopError,
} from "./compose";
import {
  fetchProduceRows,
  toDigitalWhiteSheetSummary,
} from "./load";
import { hasHardStopWarning } from "./warnings";

const BUSINESS_DATE = "2026-07-23";
const MARKET_LABEL = "ตลาดกี้";
const SOURCE_ID = "C-market-1";
type ProduceRow = Database["public"]["Views"]["produce_transactions"]["Row"];

function makeIntegrationDatabase(options?: {
  checks?: Array<{
    id: string;
    evidence_id?: string;
    transfer_amount: number;
    reference_id: string | null;
    created_at?: string;
  }>;
  globalWinners?: Array<{
    id: string;
    reference_id: string;
    created_at: string;
  }>;
}) {
  const produceRows = [
    {
      id: "item-1",
      product_name: "ทุเรียนหมอนทอง",
      quantity: 10.5,
      unit: "โล",
      price_per_unit: 100,
      transaction_type: "เบิก",
      base_transaction_type: "เบิก",
      item_created_at: "2026-07-23T01:00:00Z",
      session_id: "main-session-1",
      transaction_date: BUSINESS_DATE,
      market_name: MARKET_LABEL,
      raw_message_id: "raw-1",
      basis_quantity: null,
      basis_price: null,
      session_kind: "main",
    },
    {
      id: "item-2",
      product_name: "ทุเรียนหมอนทอง",
      quantity: 1.25,
      unit: "โล",
      price_per_unit: null,
      transaction_type: "คืน",
      base_transaction_type: "คืน",
      item_created_at: "2026-07-23T02:00:00Z",
      session_id: "main-session-2",
      transaction_date: BUSINESS_DATE,
      market_name: MARKET_LABEL,
      raw_message_id: "raw-2",
      basis_quantity: null,
      basis_price: null,
      session_kind: "main",
    },
    {
      id: "item-3",
      product_name: "ทุเรียนหมอนทอง",
      quantity: 0.25,
      unit: "โล",
      price_per_unit: null,
      transaction_type: "คืนเสีย",
      base_transaction_type: "คืนเสีย",
      item_created_at: "2026-07-23T03:00:00Z",
      session_id: "main-session-2",
      transaction_date: BUSINESS_DATE,
      market_name: MARKET_LABEL,
      raw_message_id: "raw-2",
      basis_quantity: null,
      basis_price: null,
      session_kind: "main",
    },
    {
      id: "item-4",
      product_name: "มะพร้าวพิเศษ",
      quantity: 4,
      unit: "ลูก",
      price_per_unit: 25,
      transaction_type: "เบิก",
      base_transaction_type: "เบิก",
      item_created_at: "2026-07-23T04:00:00Z",
      session_id: "additional-session-1",
      transaction_date: BUSINESS_DATE,
      market_name: MARKET_LABEL,
      raw_message_id: "raw-3",
      basis_quantity: null,
      basis_price: null,
      session_kind: "additional",
    },
    {
      id: "item-5",
      product_name: "มะพร้าวพิเศษ",
      quantity: 1,
      unit: "ลูก",
      price_per_unit: null,
      transaction_type: "คืน",
      base_transaction_type: "คืน",
      item_created_at: "2026-07-23T05:00:00Z",
      session_id: "additional-session-1",
      transaction_date: BUSINESS_DATE,
      market_name: MARKET_LABEL,
      raw_message_id: "raw-3",
      basis_quantity: null,
      basis_price: null,
      session_kind: "additional",
    },
  ];
  const rawMessages = [
    { id: "raw-1", source_id: SOURCE_ID },
    { id: "raw-2", source_id: SOURCE_ID },
    { id: "raw-3", source_id: SOURCE_ID },
  ];
  const checks = (options?.checks ?? [
    {
      id: "check-duplicate",
      evidence_id: "evidence-1",
      transfer_amount: 400,
      reference_id: "DUP-REF-001",
      created_at: "2026-07-23T00:01:00Z",
    },
    {
      id: "check-original",
      evidence_id: "evidence-2",
      transfer_amount: 400,
      reference_id: "DUP-REF-001",
      created_at: "2026-07-23T00:00:00Z",
    },
    {
      id: "check-without-reference",
      evidence_id: "evidence-3",
      transfer_amount: 100,
      reference_id: null,
      created_at: "2026-07-23T00:02:00Z",
    },
  ]).map((check, index) => ({
    evidence_id: `evidence-${index + 1}`,
    created_at: `2026-07-23T00:0${index}:00Z`,
    ...check,
  }));

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
            in: async () => ({ data: rawMessages, error: null }),
          }),
        };
      }
      if (table === "slip_evidences") {
        return {
          select: () => ({
            eq: () => ({
              gte: () => ({
                lt: async () => ({
                  data: [
                    { id: "evidence-1", market_label: MARKET_LABEL },
                    { id: "evidence-2", market_label: MARKET_LABEL },
                    { id: "evidence-3", market_label: MARKET_LABEL },
                  ],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (table === "central_selling_prices") {
        return {
          select: () => ({
            eq: async () => ({
              data: [
                { product_key: "ทุเรียนหมอนทอง", unit_key: "โล", price_satang: 10000 },
                { product_key: "มะพร้าวพิเศษ", unit_key: "ลูก", price_satang: 2500 },
              ],
              error: null,
            }),
          }),
        };
      }
      if (table === "slip_checks") {
        return {
          select: (columns: string) => {
            const scoped = columns.includes("transfer_amount");
            const builder = {
              in: () => builder,
              not: () => builder,
              order: () => builder,
              then: (resolve: (value: unknown) => void) => resolve({
                data: scoped
                  ? checks
                  : (options?.globalWinners ?? [
                      {
                        id: "check-original",
                        reference_id: "DUP-REF-001",
                        created_at: "2026-07-23T00:00:00Z",
                      },
                      {
                        id: "check-duplicate",
                        reference_id: "DUP-REF-001",
                        created_at: "2026-07-23T00:01:00Z",
                      },
                    ]),
                error: null,
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
  } as unknown as SupabaseClient<Database>;

  return { database, produceRows, rawMessages, checks };
}

function makeProduceLoaderDatabase(
  produceRows: readonly ProduceRow[],
  rawMessages: ReadonlyArray<{ id: string; source_id: string }>,
  serverMaxRows = Number.POSITIVE_INFINITY,
) {
  const orderColumns: string[] = [];
  const requestedRanges: Array<[number, number]> = [];

  const database = {
    from(table: string) {
      if (table === "produce_transactions") {
        let selectedBusinessDate = "";
        let selectedRoundId: string | null | undefined;
        const builder = {
          select: () => builder,
          eq: (column: string, value: unknown) => {
            if (column === "transaction_date") selectedBusinessDate = String(value);
            if (column === "accountability_round_id") selectedRoundId = String(value);
            return builder;
          },
          is: (column: string, value: null) => {
            if (column === "accountability_round_id") selectedRoundId = value;
            return builder;
          },
          in: () => builder,
          order: (column: string) => {
            orderColumns.push(column);
            return builder;
          },
          range: async (start: number, end: number) => {
            requestedRanges.push([start, end]);
            const matchingRows = produceRows
              .filter((row) =>
                row.transaction_date === selectedBusinessDate
                && (selectedRoundId === undefined || row.accountability_round_id === selectedRoundId))
              .sort((left, right) =>
                left.item_created_at.localeCompare(right.item_created_at)
                  || left.id.localeCompare(right.id));
            const returnedLength = Math.min(end - start + 1, serverMaxRows);
            return {
              data: matchingRows.slice(start, start + returnedLength),
              error: null,
              count: matchingRows.length,
            };
          },
        };
        return builder;
      }
      if (table === "raw_messages") {
        return {
          select: () => ({
            in: async (_column: string, ids: string[]) => ({
              data: rawMessages.filter((row) => ids.includes(row.id)),
              error: null,
            }),
          }),
        };
      }
      if (table === "slip_evidences") {
        return {
          select: () => ({
            eq: () => ({
              gte: () => ({
                lt: async () => ({ data: [], error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "central_selling_prices") {
        return {
          select: () => ({
            eq: async () => ({
              data: [{ product_key: "ทุเรียนหมอนทอง", unit_key: "โล", price_satang: 10000 }],
              error: null,
            }),
          }),
        };
      }
      const manualSlip = stubManualSlipTables()(table);
        if (manualSlip) return manualSlip;
        throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient<Database>;

  return { database, orderColumns, requestedRanges };
}

describe("produce transaction pagination", () => {
  test("loads tied timestamps exactly once across a truncated page boundary", async () => {
    const { produceRows } = makeIntegrationDatabase();
    const baseRow = produceRows[0] as ProduceRow;
    const persistedRows = Array.from({ length: 1005 }, (_, index) => ({
      ...baseRow,
      id: `item-${String(index).padStart(4, "0")}`,
      item_created_at: "2026-07-23T01:00:00Z",
      raw_message_id: `raw-${String(index).padStart(4, "0")}`,
    })).reverse();
    const { database, orderColumns, requestedRanges } = makeProduceLoaderDatabase(
      persistedRows,
      [],
      600,
    );

    const loadedRows = await fetchProduceRows(database, BUSINESS_DATE);
    const loadedIds = loadedRows.map((row) => row.id);
    const expectedIds = persistedRows.map((row) => row.id).sort();

    expect(loadedIds).toEqual(expectedIds);
    expect(new Set(loadedIds).size).toBe(persistedRows.length);
    expect(orderColumns.slice(0, 2)).toEqual(["item_created_at", "id"]);
    expect(requestedRanges).toEqual([
      [0, 999],
      [600, 1599],
    ]);
  });

  test("returns only the explicitly selected same-description round", async () => {
    const { produceRows } = makeIntegrationDatabase();
    const baseRow = produceRows[0] as ProduceRow;
    const roundA = "10000000-0000-4000-8000-000000000001";
    const roundB = "10000000-0000-4000-8000-000000000002";
    const { database } = makeProduceLoaderDatabase([
      { ...baseRow, id: "round-a", accountability_round_id: roundA },
      { ...baseRow, id: "round-b", accountability_round_id: roundB },
    ], []);

    expect((await fetchProduceRows(database, BUSINESS_DATE, roundA)).map((row) => row.id))
      .toEqual(["round-a"]);
    expect((await fetchProduceRows(database, BUSINESS_DATE, roundB)).map((row) => row.id))
      .toEqual(["round-b"]);
  });
});

describe("digital white-sheet real-data integration", () => {
  test("loads one market/date and feeds the same canonical summary to Dashboard and LINE", async () => {
    const { database, produceRows, rawMessages, checks } = makeIntegrationDatabase();
    const sourceSnapshot = structuredClone({ produceRows, rawMessages, checks });

    const calculation = await loadDigitalWhiteSheetCalculation(
      database,
      {
        sourceId: SOURCE_ID,
        marketKey: "talad-kee",
        marketLabel: MARKET_LABEL,
        businessDate: BUSINESS_DATE,
      },
      {
        expenses: {
          labor: 50,
          locationFee: 20,
          bag: 5,
          snack: 5,
          other: 10,
          otherNote: "น้ำแข็ง",
        },
        actualCashSubmitted: 375,
      },
    );

    expect(calculation.items).toEqual([
      expect.objectContaining({
        normalizedProduct: "ทุเรียนหมอนทอง",
        normalizedUnit: "โล",
        withdrawnQuantity: 10.5,
        goodReturnQuantity: 1.25,
        damagedReturnQuantity: 0.25,
        soldQuantity: 9,
        expectedSales: 900,
      }),
      expect.objectContaining({
        normalizedProduct: "มะพร้าวพิเศษ",
        normalizedUnit: "ลูก",
        withdrawnQuantity: 4,
        goodReturnQuantity: 1,
        damagedReturnQuantity: 0,
        soldQuantity: 3,
        expectedSales: 75,
        category: "uncategorized",
      }),
    ]);
    expect(calculation).toMatchObject({
      expectedSales: 975,
      // BR-02: the no-reference check (100) is pending manual resolution and
      // no longer auto-counted — only the deduped DUP-REF-001 winner (400).
      verifiedTransfers: 400,
      expenseTotal: 90,
      expectedCash: 485,
      actualCashSubmitted: 375,
      difference: -110,
      status: "shortage",
    });
    expect(calculation.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Uncategorized product: มะพร้าวพิเศษ (ลูก)"),
        expect.stringContaining("ยังไม่มีเลขอ้างอิง"),
      ]),
    );
    // One main เบิก + one main คืน/คืนเสีย session is a normal mixed-type day,
    // not a duplicate hard stop.
    expect(
      calculation.warnings.some((warning) =>
        warning.startsWith("Multiple completed main produce sessions")),
    ).toBe(false);

    const summary = toDigitalWhiteSheetSummary(calculation);
    const dashboardHtml = renderToStaticMarkup(
      <DashboardSummary viewModel={summary} />,
    );
    const lineMessage = buildWhiteSheetSummaryMessage(summary);

    for (const expectedValue of ["975.00", "400.00", "90.00", "485.00", "375.00"]) {
      expect(dashboardHtml).toContain(expectedValue);
      expect(lineMessage).toContain(expectedValue);
    }
    // The Dashboard hides the financial-status section entirely under a HARD
    // STOP (see white-sheet-status-blocked below); the difference figure is
    // therefore not expected in dashboardHtml, only in the LINE formatter.
    expect(lineMessage).toContain("110.00");
    expect(dashboardHtml).toContain("white-sheet-status-blocked");
    expect(lineMessage).toContain("เงินขาด");
    expect({ produceRows, rawMessages, checks }).toEqual(sourceSnapshot);
  });

  test("warns only for unresolved market labels within the requested source and date", async () => {
    const { produceRows } = makeIntegrationDatabase();
    const baseRow = produceRows[0] as ProduceRow;
    const scopedRows: ProduceRow[] = [
      {
        ...baseRow,
        id: "target-row",
        raw_message_id: "raw-target",
      },
      {
        ...baseRow,
        id: "other-date-row",
        transaction_date: "2026-07-22",
        raw_message_id: "raw-other-date",
      },
      {
        ...baseRow,
        id: "other-market-row",
        market_name: "Other Market",
        raw_message_id: "raw-other-market",
      },
      {
        ...baseRow,
        id: "unresolved-market-row",
        market_name: null,
        raw_message_id: "raw-unresolved-market",
      },
      {
        ...baseRow,
        id: "other-source-row",
        raw_message_id: "raw-other-source",
      },
    ];
    const { database } = makeProduceLoaderDatabase(scopedRows, [
      { id: "raw-target", source_id: SOURCE_ID },
      { id: "raw-other-date", source_id: SOURCE_ID },
      { id: "raw-other-market", source_id: SOURCE_ID },
      { id: "raw-unresolved-market", source_id: SOURCE_ID },
      { id: "raw-other-source", source_id: "C-market-other" },
    ]);

    const calculation = await loadDigitalWhiteSheetCalculation(
      database,
      {
        sourceId: SOURCE_ID,
        marketKey: "talad-kee",
        marketLabel: MARKET_LABEL,
        businessDate: BUSINESS_DATE,
      },
      {
        expenses: {
          labor: 0,
          locationFee: 0,
          bag: 0,
          snack: 0,
          other: 0,
          otherNote: "",
        },
        actualCashSubmitted: 1050,
      },
    );

    expect(calculation.expectedSales).toBe(1050);
    expect(calculation.items).toHaveLength(1);
    const exclusionWarning = calculation.warnings.find((warning) =>
      warning.startsWith("Excluded 1 produce row(s)"));
    expect(exclusionWarning).toBeDefined();
    expect(exclusionWarning).not.toContain("Other Market");
    expect(exclusionWarning).not.toContain("raw-");
  });

  test("does not warn when another scoped row has a valid different market", async () => {
    const { produceRows } = makeIntegrationDatabase();
    const baseRow = produceRows[0] as ProduceRow;
    const { database } = makeProduceLoaderDatabase(
      [
        { ...baseRow, id: "target-row", raw_message_id: "raw-target" },
        {
          ...baseRow,
          id: "other-market-row",
          market_name: "Other Market",
          raw_message_id: "raw-other-market",
        },
      ],
      [
        { id: "raw-target", source_id: SOURCE_ID },
        { id: "raw-other-market", source_id: SOURCE_ID },
      ],
    );

    const calculation = await loadDigitalWhiteSheetCalculation(
      database,
      {
        sourceId: SOURCE_ID,
        marketKey: "talad-kee",
        marketLabel: MARKET_LABEL,
        businessDate: BUSINESS_DATE,
      },
      {
        expenses: {
          labor: 0,
          locationFee: 0,
          bag: 0,
          snack: 0,
          other: 0,
          otherNote: "",
        },
        actualCashSubmitted: 1050,
      },
    );

    expect(calculation.expectedSales).toBe(1050);
    expect(calculation.items).toHaveLength(1);
    expect(calculation.warnings.some((warning) => warning.startsWith("Excluded "))).toBe(false);
  });

  test("excludes a scoped slip when its global winner belongs to another source", async () => {
    const { database } = makeIntegrationDatabase({
      checks: [
        {
          id: "check-local-duplicate",
          evidence_id: "evidence-1",
          transfer_amount: 400,
          reference_id: "CROSS-SOURCE-REF",
          created_at: "2026-07-23T00:01:00Z",
        },
        {
          id: "check-local-unique",
          evidence_id: "evidence-2",
          transfer_amount: 100,
          reference_id: "LOCAL-REF",
          created_at: "2026-07-23T00:02:00Z",
        },
      ],
      globalWinners: [
        {
          id: "check-other-source-winner",
          reference_id: "CROSS-SOURCE-REF",
          created_at: "2026-07-22T00:00:00Z",
        },
        {
          id: "check-local-unique",
          reference_id: "LOCAL-REF",
          created_at: "2026-07-23T00:02:00Z",
        },
      ],
    });

    const calculation = await loadDigitalWhiteSheetCalculation(
      database,
      {
        sourceId: SOURCE_ID,
        marketKey: "talad-kee",
        marketLabel: MARKET_LABEL,
        businessDate: BUSINESS_DATE,
      },
      {
        expenses: {
          labor: 0,
          locationFee: 0,
          bag: 0,
          snack: 0,
          other: 0,
          otherNote: "",
        },
        actualCashSubmitted: 875,
      },
    );

    expect(calculation.verifiedTransfers).toBe(100);
  });
});

const ZERO_CASH = {
  expenses: {
    labor: 0,
    locationFee: 0,
    bag: 0,
    snack: 0,
    other: 0,
    otherNote: "",
  },
  actualCashSubmitted: 0,
} as const;

function makeDuplicateDetectionRow(
  overrides: Partial<ProduceRow> & Pick<
    ProduceRow,
    "id" | "session_id" | "base_transaction_type" | "transaction_type"
  >,
): ProduceRow {
  return {
    product_name: "ทุเรียนหมอนทอง",
    quantity: 1,
    unit: "ลูก",
    price_per_unit: overrides.base_transaction_type === "เบิก" ? 40 : null,
    item_created_at: "2026-07-25T01:00:00Z",
    transaction_date: "2026-07-25",
    market_name: "ทดสอบไวท์ชีท",
    raw_message_id: "raw-dup-1",
    basis_quantity: null,
    basis_price: null,
    session_kind: "main",
    ...overrides,
  } as ProduceRow;
}

function makeDuplicateDetectionDatabase(produceRows: readonly ProduceRow[]) {
  const rawMessages = [...new Set(produceRows.map((row) => row.raw_message_id))]
    .map((id) => ({ id, source_id: SOURCE_ID }));
  const productKeysByIdentity = new Map<string, {
    product_key: string;
    unit_key: string;
    price_satang: number;
  }>();
  for (const row of produceRows) {
    if (row.base_transaction_type !== "เบิก" || !row.unit || row.price_per_unit === null) {
      continue;
    }
    const identity = `${row.product_name}::${row.unit}`;
    if (productKeysByIdentity.has(identity)) continue;
    productKeysByIdentity.set(identity, {
      product_key: row.product_name,
      unit_key: row.unit,
      price_satang: Math.round(Number(row.price_per_unit) * 100),
    });
  }
  const productKeys = [...productKeysByIdentity.values()];

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
            in: async () => ({ data: rawMessages, error: null }),
          }),
        };
      }
      if (table === "slip_evidences") {
        return {
          select: () => ({
            eq: () => ({
              gte: () => ({
                lt: async () => ({ data: [], error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "central_selling_prices") {
        return {
          select: () => ({
            eq: async () => ({ data: productKeys, error: null }),
          }),
        };
      }
      if (table === "digital_white_sheet_cash_entries") {
        return {
          select: () => {
            const builder = {
              eq: () => builder,
              maybeSingle: async () => ({
                data: {
                  id: "entry-smoke",
                  source_id: SOURCE_ID,
                  market_label_normalized: "ทดสอบไวท์ชีท",
                  business_date: "2026-07-25",
                  labor: 0,
                  location_fee: 0,
                  bag: 0,
                  snack: 0,
                  other: 0,
                  other_note: null,
                  actual_cash_submitted: 320,
                  finalized_at: null,
                  finalized_by: null,
                  created_at: "2026-07-25T00:00:00Z",
                  updated_at: "2026-07-25T00:00:00Z",
                },
                error: null,
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
  } as unknown as SupabaseClient<Database>;

  return database;
}

describe("multiple main-session duplicate detection by transaction type", () => {
  const SCOPE = {
    sourceId: SOURCE_ID,
    marketKey: "test-white-sheet",
    marketLabel: "ทดสอบไวท์ชีท",
    businessDate: "2026-07-25",
  };

  test("one main เบิก + one main คืน does not warn", async () => {
    const database = makeDuplicateDetectionDatabase([
      makeDuplicateDetectionRow({
        id: "w1",
        session_id: "main-withdrawal",
        base_transaction_type: "เบิก",
        transaction_type: "เบิก",
        quantity: 10,
        price_per_unit: 40,
      }),
      makeDuplicateDetectionRow({
        id: "r1",
        session_id: "main-return",
        base_transaction_type: "คืน",
        transaction_type: "คืน",
        quantity: 2,
        item_created_at: "2026-07-25T02:00:00Z",
        raw_message_id: "raw-dup-2",
      }),
    ]);

    const calculation = await loadDigitalWhiteSheetCalculation(database, SCOPE, ZERO_CASH);
    expect(
      calculation.warnings.some((warning) =>
        warning.startsWith("Multiple completed main produce sessions")),
    ).toBe(false);
  });

  test("smoke-test case: 10 withdrawal / 2 return @ 40 allows a trusted summary", async () => {
    const database = makeDuplicateDetectionDatabase([
      makeDuplicateDetectionRow({
        id: "w1",
        session_id: "main-withdrawal",
        base_transaction_type: "เบิก",
        transaction_type: "เบิก",
        quantity: 10,
        price_per_unit: 40,
      }),
      makeDuplicateDetectionRow({
        id: "r1",
        session_id: "main-return",
        base_transaction_type: "คืน",
        transaction_type: "คืน",
        quantity: 2,
        item_created_at: "2026-07-25T02:00:00Z",
        raw_message_id: "raw-dup-2",
      }),
    ]);

    const calculation = await loadDigitalWhiteSheetCalculation(
      database,
      SCOPE,
      { ...ZERO_CASH, actualCashSubmitted: 320 },
    );
    expect(calculation.items).toEqual([
      expect.objectContaining({
        soldQuantity: 8,
        expectedSales: 320,
      }),
    ]);
    expect(calculation.expectedSales).toBe(320);
    expect(calculation.status).toBe("matched");
    expect(hasHardStopWarning(calculation.warnings)).toBe(false);

    const pageModel = await loadDigitalWhiteSheetPageModel(database, SCOPE);
    expect(requireTrustedWhiteSheetSummary(pageModel)).toMatchObject({
      expectedSales: 320,
      actualCashSubmitted: 320,
      status: "matched",
    });
  });

  test("two active main เบิก sessions warn and block trusted summary", async () => {
    const database = makeDuplicateDetectionDatabase([
      makeDuplicateDetectionRow({
        id: "w1",
        session_id: "main-withdrawal-a",
        base_transaction_type: "เบิก",
        transaction_type: "เบิก",
        quantity: 10,
        price_per_unit: 40,
      }),
      makeDuplicateDetectionRow({
        id: "w2",
        session_id: "main-withdrawal-b",
        base_transaction_type: "เบิก",
        transaction_type: "เบิก",
        quantity: 5,
        price_per_unit: 40,
        item_created_at: "2026-07-25T02:00:00Z",
        raw_message_id: "raw-dup-2",
      }),
    ]);

    const calculation = await loadDigitalWhiteSheetCalculation(database, SCOPE, ZERO_CASH);
    expect(calculation.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Multiple completed main produce sessions (2)"),
        expect.stringContaining("same transaction type (เบิก)"),
        expect.stringContaining("reviewed or voided"),
      ]),
    );

    const pageModel = await loadDigitalWhiteSheetPageModel(database, SCOPE);
    expect(() => requireTrustedWhiteSheetSummary(pageModel)).toThrow(WhiteSheetHardStopError);
  });

  test("two active main คืน sessions warn", async () => {
    const database = makeDuplicateDetectionDatabase([
      makeDuplicateDetectionRow({
        id: "w1",
        session_id: "main-withdrawal",
        base_transaction_type: "เบิก",
        transaction_type: "เบิก",
        quantity: 10,
        price_per_unit: 40,
      }),
      makeDuplicateDetectionRow({
        id: "r1",
        session_id: "main-return-a",
        base_transaction_type: "คืน",
        transaction_type: "คืน",
        quantity: 1,
        item_created_at: "2026-07-25T02:00:00Z",
        raw_message_id: "raw-dup-2",
      }),
      makeDuplicateDetectionRow({
        id: "r2",
        session_id: "main-return-b",
        base_transaction_type: "คืน",
        transaction_type: "คืน",
        quantity: 1,
        item_created_at: "2026-07-25T03:00:00Z",
        raw_message_id: "raw-dup-3",
      }),
    ]);

    const calculation = await loadDigitalWhiteSheetCalculation(database, SCOPE, ZERO_CASH);
    expect(calculation.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("same transaction type (คืน)"),
      ]),
    );
  });

  test("two active main คืนเสีย sessions warn", async () => {
    const database = makeDuplicateDetectionDatabase([
      makeDuplicateDetectionRow({
        id: "w1",
        session_id: "main-withdrawal",
        base_transaction_type: "เบิก",
        transaction_type: "เบิก",
        quantity: 10,
        price_per_unit: 40,
      }),
      makeDuplicateDetectionRow({
        id: "d1",
        session_id: "main-damaged-a",
        base_transaction_type: "คืนเสีย",
        transaction_type: "คืนเสีย",
        quantity: 1,
        item_created_at: "2026-07-25T02:00:00Z",
        raw_message_id: "raw-dup-2",
      }),
      makeDuplicateDetectionRow({
        id: "d2",
        session_id: "main-damaged-b",
        base_transaction_type: "คืนเสีย",
        transaction_type: "คืนเสีย",
        quantity: 1,
        item_created_at: "2026-07-25T03:00:00Z",
        raw_message_id: "raw-dup-3",
      }),
    ]);

    const calculation = await loadDigitalWhiteSheetCalculation(database, SCOPE, ZERO_CASH);
    expect(calculation.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("same transaction type (คืนเสีย)"),
      ]),
    );
  });

  test("main เบิก + additional เบิก does not warn", async () => {
    const database = makeDuplicateDetectionDatabase([
      makeDuplicateDetectionRow({
        id: "w1",
        session_id: "main-withdrawal",
        base_transaction_type: "เบิก",
        transaction_type: "เบิก",
        quantity: 10,
        price_per_unit: 40,
      }),
      makeDuplicateDetectionRow({
        id: "w2",
        session_id: "additional-withdrawal",
        base_transaction_type: "เบิก",
        transaction_type: "เบิก",
        quantity: 3,
        price_per_unit: 40,
        session_kind: "additional",
        item_created_at: "2026-07-25T02:00:00Z",
        raw_message_id: "raw-dup-2",
      }),
    ]);

    const calculation = await loadDigitalWhiteSheetCalculation(database, SCOPE, ZERO_CASH);
    expect(
      calculation.warnings.some((warning) =>
        warning.startsWith("Multiple completed main produce sessions")),
    ).toBe(false);
  });

  test("voided duplicate main session does not warn (produce_transactions already void-filtered)", async () => {
    // Migration 0037 filters voided sessions out of produce_transactions.
    // The loader only sees the remaining ACTIVE main เบิก session.
    const database = makeDuplicateDetectionDatabase([
      makeDuplicateDetectionRow({
        id: "w-active",
        session_id: "main-withdrawal-active",
        base_transaction_type: "เบิก",
        transaction_type: "เบิก",
        quantity: 10,
        price_per_unit: 40,
      }),
    ]);

    const calculation = await loadDigitalWhiteSheetCalculation(database, SCOPE, ZERO_CASH);
    expect(
      calculation.warnings.some((warning) =>
        warning.startsWith("Multiple completed main produce sessions")),
    ).toBe(false);
  });
});
