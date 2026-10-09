import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { stubManualSlipTables } from "@/lib/white-sheet/test-manual-slip-db";
import { loadDigitalWhiteSheetPageModel } from "./test-certified-returns";
import {
  requireSubmittedWhiteSheetSummary,
  requireTrustedWhiteSheetSummary,
  WhiteSheetHardStopError,
  WhiteSheetNotSubmittedError,
} from "./compose";

const SOURCE_ID = "group-compose-1";
const MARKET_LABEL = "ตลาดคอมโพส";
const BUSINESS_DATE = "2026-07-24";

type CashEntryRow = Database["public"]["Tables"]["digital_white_sheet_cash_entries"]["Row"];

/**
 * Minimal combined fake covering every table load.ts + persist.ts touch:
 * one withdrawal transaction (10 units @ 50 = expected sales 500), no
 * verified transfers, and an in-memory cash-entry row keyed exactly like
 * the real unique constraint.
 */
function makeComposedDatabase(cashEntry?: CashEntryRow, options?: { duplicateMainSession?: boolean }) {
  const produceRows = [
    {
      id: "item-1",
      product_name: "มะม่วง",
      quantity: 10,
      unit: "โล",
      price_per_unit: 50,
      transaction_type: "เบิก",
      base_transaction_type: "เบิก",
      item_created_at: "2026-07-24T01:00:00Z",
      session_id: "main-session-1",
      transaction_date: BUSINESS_DATE,
      market_name: MARKET_LABEL,
      raw_message_id: "raw-1",
      basis_quantity: null,
      basis_price: null,
      session_kind: "main",
    },
    ...(options?.duplicateMainSession
      ? [
          {
            id: "item-2",
            product_name: "มะม่วง",
            quantity: 5,
            unit: "โล",
            price_per_unit: 50,
            transaction_type: "เบิก",
            base_transaction_type: "เบิก",
            item_created_at: "2026-07-24T02:00:00Z",
            session_id: "main-session-2",
            transaction_date: BUSINESS_DATE,
            market_name: MARKET_LABEL,
            raw_message_id: "raw-1",
            basis_quantity: null,
            basis_price: null,
            session_kind: "main",
          },
        ]
      : []),
  ];
  const rawMessages = [{ id: "raw-1", source_id: SOURCE_ID }];
  let storedEntry: CashEntryRow | undefined = cashEntry;

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
            eq: async () => ({
              data: [{ product_key: "มะม่วง", unit_key: "โล", price_satang: 5000 }],
              error: null,
            }),
          }),
        };
      }
      if (table === "digital_white_sheet_cash_entries") {
        return {
          select: () => {
            const builder = {
              eq: () => builder,
              maybeSingle: async () => ({ data: storedEntry ?? null, error: null }),
            };
            return builder;
          },
          upsert: (values: Partial<CashEntryRow>) => ({
            select: () => ({
              single: async () => {
                storedEntry = {
                  id: storedEntry?.id ?? "entry-1",
                  created_at: storedEntry?.created_at ?? "2026-07-24T00:00:00Z",
                  ...values,
                } as CashEntryRow;
                return { data: storedEntry, error: null };
              },
            }),
          }),
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
  marketKey: "any-caller-key",
  marketLabel: MARKET_LABEL,
  businessDate: BUSINESS_DATE,
};

describe("loadDigitalWhiteSheetPageModel", () => {
  it("reports not_submitted while still surfacing real expectedSales/verifiedTransfers", async () => {
    const database = makeComposedDatabase();
    const pageModel = await loadDigitalWhiteSheetPageModel(database, SCOPE);

    expect(pageModel.entryStatus).toBe("not_submitted");
    expect(pageModel.summary.expectedSales).toBe(500);
    expect(pageModel.summary.verifiedTransfers).toBe(0);
    // Cash-derived fields are placeholder-only in this state; callers must
    // not render them as a genuine submission.
    expect(pageModel.summary.actualCashSubmitted).toBe(0);
    expect(pageModel.summary.expenseTotal).toBe(0);
    // Legacy scope without a round UUID never invents profitability.
    expect(pageModel.profitability).toEqual({ state: "round_unbound" });
  });

  it("reports submitted with the persisted expenses/cash folded into the canonical summary", async () => {
    const database = makeComposedDatabase({
      id: "entry-1",
      source_id: SOURCE_ID,
      market_label_normalized: MARKET_LABEL,
      business_date: BUSINESS_DATE,
      labor: 100,
      location_fee: 20,
      bag: 5,
      snack: 5,
      other: 0,
      other_note: null,
      actual_cash_submitted: 300,
      white_sheet_sales: null,
      owner_cash: null,
      labor_entered: true,
      location_fee_entered: true,
      bag_entered: true,
      snack_entered: true,
      other_entered: true,
      actual_cash_submitted_entered: true,
      created_at: "2026-07-24T00:00:00Z",
      updated_at: "2026-07-24T00:00:00Z",
      finalized_at: null,
      finalized_by: null,
      accountability_round_id: null,
    });

    const pageModel = await loadDigitalWhiteSheetPageModel(database, SCOPE);

    expect(pageModel.entryStatus).toBe("submitted");
    expect(pageModel.summary.expectedSales).toBe(500);
    expect(pageModel.summary.expenseTotal).toBe(130);
    expect(pageModel.summary.expectedCash).toBe(370); // 500 - 0 - 130
    expect(pageModel.summary.actualCashSubmitted).toBe(300);
    expect(pageModel.summary.difference).toBe(-70);
    expect(pageModel.summary.status).toBe("shortage");
  });

  it("reloading after a save reflects the newly persisted entry", async () => {
    const database = makeComposedDatabase();
    const before = await loadDigitalWhiteSheetPageModel(database, SCOPE);
    expect(before.entryStatus).toBe("not_submitted");

    await database
      .from("digital_white_sheet_cash_entries")
      .upsert({
        source_id: SOURCE_ID,
        market_label_normalized: MARKET_LABEL,
        business_date: BUSINESS_DATE,
        labor: 0,
        location_fee: 0,
        bag: 0,
        snack: 0,
        other: 0,
        other_note: null,
        actual_cash_submitted: 500,
        updated_at: "2026-07-24T02:00:00Z",
      })
      .select()
      .single();

    const after = await loadDigitalWhiteSheetPageModel(database, SCOPE);
    expect(after.entryStatus).toBe("submitted");
    expect(after.summary.actualCashSubmitted).toBe(500);
    expect(after.summary.status).toBe("matched");
  });
});

describe("requireSubmittedWhiteSheetSummary", () => {
  it("throws WhiteSheetNotSubmittedError when the entry has not been submitted", async () => {
    const database = makeComposedDatabase();
    const pageModel = await loadDigitalWhiteSheetPageModel(database, SCOPE);
    expect(() => requireSubmittedWhiteSheetSummary(pageModel)).toThrow(
      WhiteSheetNotSubmittedError,
    );
  });

  it("returns the summary when the entry has been submitted", async () => {
    const database = makeComposedDatabase({
      id: "entry-1",
      source_id: SOURCE_ID,
      market_label_normalized: MARKET_LABEL,
      business_date: BUSINESS_DATE,
      labor: 0,
      location_fee: 0,
      bag: 0,
      snack: 0,
      other: 0,
      other_note: null,
      actual_cash_submitted: 500,
      white_sheet_sales: null,
      owner_cash: null,
      labor_entered: true,
      location_fee_entered: true,
      bag_entered: true,
      snack_entered: true,
      other_entered: true,
      actual_cash_submitted_entered: true,
      created_at: "2026-07-24T00:00:00Z",
      updated_at: "2026-07-24T00:00:00Z",
      finalized_at: null,
      finalized_by: null,
      accountability_round_id: null,
    });
    const pageModel = await loadDigitalWhiteSheetPageModel(database, SCOPE);
    expect(requireSubmittedWhiteSheetSummary(pageModel)).toBe(pageModel.summary);
  });
});

const SUBMITTED_ENTRY: CashEntryRow = {
  id: "entry-1",
  source_id: SOURCE_ID,
  market_label_normalized: MARKET_LABEL,
  business_date: BUSINESS_DATE,
  labor: 0,
  location_fee: 0,
  bag: 0,
  snack: 0,
  other: 0,
  other_note: null,
  actual_cash_submitted: 500,
  white_sheet_sales: null,
  owner_cash: null,
  labor_entered: true,
  location_fee_entered: true,
  bag_entered: true,
  snack_entered: true,
  other_entered: true,
  actual_cash_submitted_entered: true,
  finalized_at: null,
  finalized_by: null,
  accountability_round_id: null,
  created_at: "2026-07-24T00:00:00Z",
  updated_at: "2026-07-24T00:00:00Z",
};

describe("requireTrustedWhiteSheetSummary", () => {
  it("throws WhiteSheetNotSubmittedError when not submitted, even without duplicate sessions", async () => {
    const database = makeComposedDatabase();
    const pageModel = await loadDigitalWhiteSheetPageModel(database, SCOPE);
    expect(() => requireTrustedWhiteSheetSummary(pageModel)).toThrow(WhiteSheetNotSubmittedError);
  });

  it("throws WhiteSheetHardStopError when submitted but duplicate main sessions exist", async () => {
    const database = makeComposedDatabase(SUBMITTED_ENTRY, { duplicateMainSession: true });
    const pageModel = await loadDigitalWhiteSheetPageModel(database, SCOPE);
    expect(pageModel.entryStatus).toBe("submitted");
    expect(() => requireTrustedWhiteSheetSummary(pageModel)).toThrow(WhiteSheetHardStopError);
  });

  it("returns the summary when submitted and no hard-stop warning exists", async () => {
    const database = makeComposedDatabase(SUBMITTED_ENTRY);
    const pageModel = await loadDigitalWhiteSheetPageModel(database, SCOPE);
    expect(requireTrustedWhiteSheetSummary(pageModel)).toBe(pageModel.summary);
    expect(pageModel.finalizedAt).toBeNull();
    expect(pageModel.finalizedBy).toBeNull();
  });
});

describe("page model lifecycle metadata", () => {
  it("exposes finalizedAt/finalizedBy after a finalized cash entry is loaded", async () => {
    const database = makeComposedDatabase({
      ...SUBMITTED_ENTRY,
      finalized_at: "2026-07-24T12:00:00Z",
      finalized_by: "admin-actor-1",
    });
    const pageModel = await loadDigitalWhiteSheetPageModel(database, SCOPE);
    expect(pageModel.entryStatus).toBe("finalized");
    expect(pageModel.finalizedAt).toBe("2026-07-24T12:00:00Z");
    expect(pageModel.finalizedBy).toBe("admin-actor-1");
  });
});
