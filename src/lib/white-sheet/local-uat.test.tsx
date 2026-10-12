import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { DigitalWhiteSheetPanel } from "@/components/white-sheet/DigitalWhiteSheetPanel";
import { buildWhiteSheetSummaryMessagesFromPageModel } from "@/lib/line/white-sheet-summary";
import { stubManualSlipTables } from "@/lib/white-sheet/test-manual-slip-db";
import { requireTrustedWhiteSheetSummary } from "./compose";
import { loadDigitalWhiteSheetPageModel } from "./test-certified-returns";
import { normalizedMarketLabel } from "./load";
import { saveWhiteSheetCashEntry } from "./persist";

/**
 * Deterministic Local UAT scenario (STEP 11 of the White Sheet local
 * persistence task): withdrawal, good return, damaged return, kilograms,
 * compatible weight conversion (โล/ขีด), pieces, verified transfer, a
 * duplicate transfer excluded, labor/location fee/bag/snack/other expense +
 * note, actual cash submitted, persistence save/reload, expected
 * sales/cash/difference, shortage/matched/overage, Dashboard, and the LINE
 * formatter — all driven from one combined fake Supabase covering every
 * table the operational loader, the persistence layer, and the
 * verified-transfer reconciliation touch.
 */

const SOURCE_ID = "group-uat-1";
const MARKET_LABEL = "ตลาดยูเอที";
const BUSINESS_DATE = "2026-07-24";

type CashEntryRow = Database["public"]["Tables"]["digital_white_sheet_cash_entries"]["Row"];

function makeLocalUatDatabase() {
  const produceRows = [
    // แตงโม: withdrawal 10 โล @ 20 baht/โล = 200 nominal.
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
      market_name: MARKET_LABEL,
      raw_message_id: "raw-uat-1",
      basis_quantity: null,
      basis_price: null,
      session_kind: "main",
    },
    // Good return in ขีด — compatible-unit conversion (5 ขีด = 0.5 โล).
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
      market_name: MARKET_LABEL,
      raw_message_id: "raw-uat-1",
      basis_quantity: null,
      basis_price: null,
      session_kind: "main",
    },
    // Damaged return in ขีด — same compatible-unit conversion (2 ขีด = 0.2 โล).
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
      market_name: MARKET_LABEL,
      raw_message_id: "raw-uat-1",
      basis_quantity: null,
      basis_price: null,
      session_kind: "main",
    },
    // มะม่วง: withdrawal 20 ลูก (pieces) @ 5 baht = 100. Incompatible unit —
    // stays in its own group, unaffected by the โล/ขีด conversion above.
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
      market_name: MARKET_LABEL,
      raw_message_id: "raw-uat-1",
      basis_quantity: null,
      basis_price: null,
      session_kind: "main",
    },
  ];
  const rawMessages = [{ id: "raw-uat-1", source_id: SOURCE_ID }];
  const slipEvidences = [
    { id: "ev-uat-1", received_at: "2026-07-24T02:00:00Z", market_label: MARKET_LABEL },
    { id: "ev-uat-2", received_at: "2026-07-24T03:00:00Z", market_label: MARKET_LABEL },
  ];
  // Two checks share reference REF-100 (a duplicate transfer submission);
  // only the earlier one (chk-a) must count. REF-200 is unique and counted.
  const slipChecks = [
    { id: "chk-a", evidence_id: "ev-uat-1", transfer_amount: 150, reference_id: "REF-100", created_at: "2026-07-24T02:05:00Z", status: "EXTRACTED" },
    { id: "chk-b", evidence_id: "ev-uat-1", transfer_amount: 150, reference_id: "REF-100", created_at: "2026-07-24T02:10:00Z", status: "EXTRACTED" },
    { id: "chk-c", evidence_id: "ev-uat-2", transfer_amount: 50, reference_id: "REF-200", created_at: "2026-07-24T03:05:00Z", status: "EXTRACTED" },
  ];

  // Cash-entry store keyed exactly like the real unique constraint, so
  // cross-market/cross-date isolation is genuinely exercised rather than
  // assumed.
  const cashEntries = new Map<string, CashEntryRow>();
  const cashEntryKey = (sourceId: string, marketLabel: string, businessDate: string) =>
    `${sourceId}::${marketLabel}::${businessDate}`;

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
              data: [
                { product_key: "แตงโม", unit_key: "โล", price_satang: 2000 },
                { product_key: "มะม่วง", unit_key: "ลูก", price_satang: 500 },
              ],
              error: null,
            }),
          }),
        };
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
                  cashEntryKey(merged.source_id, merged.market_label_normalized, merged.business_date),
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
      const manualSlip = stubManualSlipTables()(table);
        if (manualSlip) return manualSlip;
        throw new Error(`unexpected table: ${table}`);
    },
  };

  return database as unknown as SupabaseClient<Database>;
}

const SCOPE = {
  sourceId: SOURCE_ID,
  marketKey: "caller-supplied-key-irrelevant-to-persistence",
  marketLabel: MARKET_LABEL,
  businessDate: BUSINESS_DATE,
};

const EXPENSE_INPUT = {
  sourceId: SOURCE_ID,
  marketLabelNormalized: normalizedMarketLabel(MARKET_LABEL),
  businessDate: BUSINESS_DATE,
  labor: 30,
  locationFee: 20,
  bag: 5,
  snack: 5,
  other: 10,
  otherNote: "ค่าน้ำแข็ง",
};

describe("White Sheet Local UAT scenario", () => {
  it("computes expected sales across withdrawal/good return/damaged return/pieces with weight-unit conversion", async () => {
    const database = makeLocalUatDatabase();
    const pageModel = await loadDigitalWhiteSheetPageModel(database, SCOPE);

    // แตงโม: 10 โล withdrawn − 0.5 โล (5 ขีด good return) − 0.2 โล (2 ขีด
    // damaged return) = 9.3 โล sold × 20 บาท = 186.
    // มะม่วง: 20 ลูก sold × 5 บาท = 100 (pieces never mixed with weight units).
    expect(pageModel.summary.expectedSales).toBe(286);
  });

  it("excludes the duplicate transfer reference from verifiedTransfers", async () => {
    const database = makeLocalUatDatabase();
    const pageModel = await loadDigitalWhiteSheetPageModel(database, SCOPE);

    // 150 (REF-100, earliest of the duplicate pair) + 50 (REF-200) = 200;
    // the later REF-100 duplicate (100 more) must not be double-counted.
    expect(pageModel.summary.verifiedTransfers).toBe(200);
  });

  it("reports NOT SUBMITTED before any entry is saved — never a zero-filled summary", async () => {
    const database = makeLocalUatDatabase();
    const pageModel = await loadDigitalWhiteSheetPageModel(database, SCOPE);

    expect(pageModel.entryStatus).toBe("not_submitted");
    expect(() => requireTrustedWhiteSheetSummary(pageModel)).toThrow();
  });

  it("persists the submitted entry, reloads it (refresh), and computes a matched result", async () => {
    const database = makeLocalUatDatabase();

    await saveWhiteSheetCashEntry(database, {
      ...EXPENSE_INPUT,
      actualCashSubmitted: 16, // expectedCash = 286 − 200 − 70 = 16 → matched
    });

    // Simulate a page refresh: load again from scratch against the same fake DB.
    const reloaded = await loadDigitalWhiteSheetPageModel(database, SCOPE);

    expect(reloaded.entryStatus).toBe("submitted");
    expect(reloaded.summary.expenseTotal).toBe(70);
    expect(reloaded.summary.expectedCash).toBe(16);
    expect(reloaded.summary.actualCashSubmitted).toBe(16);
    expect(reloaded.summary.difference).toBe(0);
    expect(reloaded.summary.status).toBe("matched");
    expect(reloaded.summary.expenses.otherNote).toBe("ค่าน้ำแข็ง");
  });

  it("an update changes only the intended White Sheet and can move the status to shortage then overage", async () => {
    const database = makeLocalUatDatabase();
    await saveWhiteSheetCashEntry(database, { ...EXPENSE_INPUT, actualCashSubmitted: 16 });

    const shortageUpdate = await saveWhiteSheetCashEntry(database, {
      ...EXPENSE_INPUT,
      actualCashSubmitted: 10, // difference = 10 − 16 = −6 → shortage
    });
    expect(shortageUpdate.status).toBe("submitted");
    const shortagePageModel = await loadDigitalWhiteSheetPageModel(database, SCOPE);
    expect(shortagePageModel.summary.status).toBe("shortage");
    expect(shortagePageModel.summary.difference).toBe(-6);

    const overageUpdate = await saveWhiteSheetCashEntry(database, {
      ...EXPENSE_INPUT,
      actualCashSubmitted: 20, // difference = 20 − 16 = 4 → overage
    });
    expect(overageUpdate.status).toBe("submitted");
    const overagePageModel = await loadDigitalWhiteSheetPageModel(database, SCOPE);
    expect(overagePageModel.summary.status).toBe("overage");
    expect(overagePageModel.summary.difference).toBe(4);

    // Last-write-wins: expectedSales/verifiedTransfers (transaction-derived,
    // untouched by these updates) stay exactly as before.
    expect(overagePageModel.summary.expectedSales).toBe(286);
    expect(overagePageModel.summary.verifiedTransfers).toBe(200);
  });

  it("a different market under the same source/date does not reuse the entry", async () => {
    const database = makeLocalUatDatabase();
    await saveWhiteSheetCashEntry(database, { ...EXPENSE_INPUT, actualCashSubmitted: 16 });

    const otherMarketScope = { ...SCOPE, marketLabel: "ตลาดอื่น" };
    const otherMarketModel = await loadDigitalWhiteSheetPageModel(database, otherMarketScope);
    expect(otherMarketModel.entryStatus).toBe("not_submitted");

    // The original entry is unaffected.
    const originalModel = await loadDigitalWhiteSheetPageModel(database, SCOPE);
    expect(originalModel.entryStatus).toBe("submitted");
    expect(originalModel.summary.actualCashSubmitted).toBe(16);
  });

  it("a different business date under the same source/market does not reuse the entry", async () => {
    const database = makeLocalUatDatabase();
    await saveWhiteSheetCashEntry(database, { ...EXPENSE_INPUT, actualCashSubmitted: 16 });

    const otherDateScope = { ...SCOPE, businessDate: "2026-07-25" };
    const otherDateModel = await loadDigitalWhiteSheetPageModel(database, otherDateScope);
    expect(otherDateModel.entryStatus).toBe("not_submitted");

    const originalModel = await loadDigitalWhiteSheetPageModel(database, SCOPE);
    expect(originalModel.entryStatus).toBe("submitted");
  });

  it("Dashboard and LINE render the exact same canonical DigitalWhiteSheetSummary", async () => {
    const database = makeLocalUatDatabase();
    await saveWhiteSheetCashEntry(database, { ...EXPENSE_INPUT, actualCashSubmitted: 16 });
    const pageModel = await loadDigitalWhiteSheetPageModel(database, SCOPE);
    expect(pageModel.summary.status).toBe("matched");

    const lineMessages = buildWhiteSheetSummaryMessagesFromPageModel(pageModel);
    const lineText = lineMessages.join("\n");

    const dashboardHtml = renderToStaticMarkup(
      <DigitalWhiteSheetPanel
        viewModel={pageModel.summary}
        entryStatus={pageModel.entryStatus}
        finalizedAt={pageModel.finalizedAt}
        finalizedBy={pageModel.finalizedBy}
        onSubmitExpenses={() => {}}
        onFinalize={async () => {}}
        onReopen={async () => {}}
      />,
    );

    for (const expectedFragment of [
      "286.00", // expectedSales
      "200.00", // verifiedTransfers
      "70.00", // expenseTotal
      "16.00", // expectedCash / actualCashSubmitted
      "ค่าน้ำแข็ง", // otherNote
    ]) {
      expect(lineText).toContain(expectedFragment);
      expect(dashboardHtml).toContain(expectedFragment);
    }
    expect(lineText).toContain("ยอดตรง");
    expect(dashboardHtml).toContain("ยอดตรง");
  });
});
