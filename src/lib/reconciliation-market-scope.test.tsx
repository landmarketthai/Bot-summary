import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { renderToStaticMarkup } from "react-dom/server";
import type { Database } from "@/types/database";
import { DigitalWhiteSheetSummary } from "@/components/white-sheet/DigitalWhiteSheetSummary";
import {
  buildWhiteSheetSummaryMessagesFromPageModel,
} from "@/lib/line/white-sheet-summary";
import { normalizedMarketLabel } from "@/lib/market";
import {
  aggregateGloballyAcceptedVerifiedTransfers,
  loadAiVerifiedTransferTotal,
  loadMarketScopedAiVerifiedTransfers,
  loadMarketScopedManualSlipTotal,
} from "@/lib/reconciliation";
import { loadDigitalWhiteSheetCalculation } from "@/lib/white-sheet/test-certified-returns";
import {
  requireTrustedWhiteSheetSummary,
  WhiteSheetHardStopError,
} from "@/lib/white-sheet/compose";
import {
  stubManualSlipTables,
  type ManualSlipEntryStub,
  type ManualSlipSessionStub,
} from "@/lib/white-sheet/test-manual-slip-db";
import {
  hasHardStopWarning,
  UNATTRIBUTED_VERIFIED_TRANSFER_WARNING,
} from "@/lib/white-sheet/warnings";

const SOURCE_ID = "group-market-scope";
const BUSINESS_DATE = "2026-07-23";
const MARKET_A = "ตลาด A";
const MARKET_B = "ตลาด B";
const MARKET_A_NORM = normalizedMarketLabel(MARKET_A);
const MARKET_B_NORM = normalizedMarketLabel(MARKET_B);
const KNOWN_AB = new Set([MARKET_A_NORM, MARKET_B_NORM]);

type SlipEvidenceRow = {
  id: string;
  market_label: string | null;
};

type SlipCheckRow = {
  id: string;
  evidence_id: string;
  transfer_amount: number;
  reference_id: string | null;
  created_at: string;
};

function makeTransferDatabase(options: {
  evidences: SlipEvidenceRow[];
  checks: SlipCheckRow[];
  globalWinners?: Array<{ id: string; reference_id: string; created_at: string }>;
}) {
  return {
    from(table: string) {
      if (table === "slip_evidences") {
        return {
          select: () => ({
            eq: () => ({
              gte: () => ({
                lt: async () => ({ data: options.evidences, error: null }),
              }),
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
                  ? options.checks
                  : (options.globalWinners ?? options.checks
                      .filter((c) => c.reference_id !== null)
                      .map((c) => ({
                        id: c.id,
                        reference_id: c.reference_id as string,
                        created_at: c.created_at,
                      }))),
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
}

describe("aggregateGloballyAcceptedVerifiedTransfers", () => {
  const evidenceMarket = new Map<string, string | null>([
    ["ev-a", MARKET_A_NORM],
    ["ev-b", MARKET_B_NORM],
  ]);
  const checks = [
    { id: "c-a", evidence_id: "ev-a", transfer_amount: 100, reference_id: "REF-A", created_at: "2026-07-23T01:00:00Z" },
    { id: "c-b", evidence_id: "ev-b", transfer_amount: 200, reference_id: "REF-B", created_at: "2026-07-23T02:00:00Z" },
  ];
  const globalWinners = new Set(["c-a", "c-b"]);

  it("scopes attributed totals per market after global dedupe", () => {
    expect(aggregateGloballyAcceptedVerifiedTransfers(
      checks,
      evidenceMarket,
      globalWinners,
      { marketLabelNormalized: MARKET_A_NORM, knownMarkets: KNOWN_AB },
    ).attributedTotal).toBe(100);

    expect(aggregateGloballyAcceptedVerifiedTransfers(
      checks,
      evidenceMarket,
      globalWinners,
      { marketLabelNormalized: MARKET_B_NORM, knownMarkets: KNOWN_AB },
    ).attributedTotal).toBe(200);
  });

  it("preserves source-wide totals when no market filter is provided", () => {
    expect(aggregateGloballyAcceptedVerifiedTransfers(
      checks,
      evidenceMarket,
      globalWinners,
    ).attributedTotal).toBe(300);
  });
});

describe("market-scoped verified transfer loading", () => {
  it("isolates transfers per market under the same source/date", async () => {
    const db = makeTransferDatabase({
      evidences: [
        { id: "ev-a", market_label: MARKET_A },
        { id: "ev-b", market_label: MARKET_B },
      ],
      checks: [
        { id: "c-a", evidence_id: "ev-a", transfer_amount: 100, reference_id: "REF-A", created_at: "2026-07-23T01:00:00Z" },
        { id: "c-b", evidence_id: "ev-b", transfer_amount: 200, reference_id: "REF-B", created_at: "2026-07-23T02:00:00Z" },
      ],
    });

    await expect(
      loadMarketScopedAiVerifiedTransfers(db, SOURCE_ID, BUSINESS_DATE, MARKET_A_NORM, KNOWN_AB),
    ).resolves.toMatchObject({ attributedTotal: 100, unresolvedAcceptedCount: 0 });

    await expect(
      loadMarketScopedAiVerifiedTransfers(db, SOURCE_ID, BUSINESS_DATE, MARKET_B_NORM, KNOWN_AB),
    ).resolves.toMatchObject({ attributedTotal: 200, unresolvedAcceptedCount: 0 });

    await expect(
      loadAiVerifiedTransferTotal(db, SOURCE_ID, BUSINESS_DATE),
    ).resolves.toBe(300);
  });

  it("counts only the global winner for cross-market duplicate references", async () => {
    const db = makeTransferDatabase({
      evidences: [
        { id: "ev-a", market_label: MARKET_A },
        { id: "ev-b", market_label: MARKET_B },
      ],
      checks: [
        { id: "c-a", evidence_id: "ev-a", transfer_amount: 100, reference_id: "REF-X", created_at: "2026-07-23T01:00:00Z" },
        { id: "c-b", evidence_id: "ev-b", transfer_amount: 100, reference_id: "REF-X", created_at: "2026-07-23T02:00:00Z" },
      ],
      globalWinners: [
        { id: "c-a", reference_id: "REF-X", created_at: "2026-07-23T01:00:00Z" },
      ],
    });

    await expect(
      loadMarketScopedAiVerifiedTransfers(db, SOURCE_ID, BUSINESS_DATE, MARKET_A_NORM, KNOWN_AB),
    ).resolves.toMatchObject({ attributedTotal: 100, unresolvedAcceptedCount: 0 });

    await expect(
      loadMarketScopedAiVerifiedTransfers(db, SOURCE_ID, BUSINESS_DATE, MARKET_B_NORM, KNOWN_AB),
    ).resolves.toMatchObject({ attributedTotal: 0, unresolvedAcceptedCount: 0 });
  });

  it("reports unattributed accepted winners without assigning them to any market", async () => {
    const db = makeTransferDatabase({
      evidences: [
        { id: "ev-a", market_label: MARKET_A },
        { id: "ev-u", market_label: null },
      ],
      checks: [
        { id: "c-a", evidence_id: "ev-a", transfer_amount: 100, reference_id: "REF-A", created_at: "2026-07-23T01:00:00Z" },
        { id: "c-u", evidence_id: "ev-u", transfer_amount: 50, reference_id: "REF-U", created_at: "2026-07-23T02:00:00Z" },
      ],
    });

    const marketA = await loadMarketScopedAiVerifiedTransfers(
      db, SOURCE_ID, BUSINESS_DATE, MARKET_A_NORM, KNOWN_AB,
    );
    const marketB = await loadMarketScopedAiVerifiedTransfers(
      db, SOURCE_ID, BUSINESS_DATE, MARKET_B_NORM, KNOWN_AB,
    );

    expect(marketA.attributedTotal).toBe(100);
    expect(marketA.unresolvedAcceptedCount).toBe(1);
    expect(marketA.unresolvedAcceptedAmount).toBe(50);
    expect(marketB.attributedTotal).toBe(0);
    expect(marketB.unresolvedAcceptedCount).toBe(1);
  });

  it("fail-closes when slip market กี้ is not equivalent to produce ตลาดกี้", async () => {
    const produceMarket = "ตลาดกี้";
    const slipMarket = "กี้";
    const produceNorm = normalizedMarketLabel(produceMarket);
    const slipNorm = normalizedMarketLabel(slipMarket);
    expect(slipNorm).toBe("กี้");
    expect(slipNorm).not.toBe(produceNorm);

    const knownMarkets = new Set([produceNorm]);
    const db = makeTransferDatabase({
      evidences: [{ id: "ev-bare", market_label: slipMarket }],
      checks: [
        {
          id: "c-bare",
          evidence_id: "ev-bare",
          transfer_amount: 120,
          reference_id: "REF-BARE",
          created_at: "2026-07-23T01:00:00Z",
        },
      ],
    });

    const result = await loadMarketScopedAiVerifiedTransfers(
      db, SOURCE_ID, BUSINESS_DATE, produceNorm, knownMarkets,
    );

    expect(result.attributedTotal).toBe(0);
    expect(result.unresolvedAcceptedCount).toBe(1);
    expect(result.unresolvedAcceptedAmount).toBe(120);
  });

  it("skips a legitimate other known market without HARD STOP", async () => {
    const gee = normalizedMarketLabel("ตลาดกี้");
    const noi = normalizedMarketLabel("ตลาดน้อย");
    const knownMarkets = new Set([gee, noi]);
    const db = makeTransferDatabase({
      evidences: [{ id: "ev-noi", market_label: "ตลาดน้อย" }],
      checks: [
        {
          id: "c-noi",
          evidence_id: "ev-noi",
          transfer_amount: 80,
          reference_id: "REF-NOI",
          created_at: "2026-07-23T01:00:00Z",
        },
      ],
    });

    const result = await loadMarketScopedAiVerifiedTransfers(
      db, SOURCE_ID, BUSINESS_DATE, gee, knownMarkets,
    );

    expect(result.attributedTotal).toBe(0);
    expect(result.unresolvedAcceptedCount).toBe(0);
    expect(result.unresolvedAcceptedAmount).toBe(0);
  });
});

describe("canonical market normalization for financial attribution", () => {
  it("trims whitespace and NFC-folds equivalent labels", () => {
    const base = "ตลาดกี้";
    expect(normalizedMarketLabel(`  ${base}  `)).toBe(normalizedMarketLabel(base));
    expect(normalizedMarketLabel("ตลาดกี้".normalize("NFD"))).toBe(
      normalizedMarketLabel("ตลาดกี้".normalize("NFC")),
    );
  });

  it("extracts market from messy produce session titles via cleanMarketName", () => {
    expect(
      normalizedMarketLabel("กี้ ตลาดกี้ ชั่งคืน 23/06/2569"),
    ).toBe("ตลาดกี้");
  });

  it("does not treat bare กี้ as equivalent to ตลาดกี้", () => {
    expect(normalizedMarketLabel("กี้")).toBe("กี้");
    expect(normalizedMarketLabel("ตลาดกี้")).toBe("ตลาดกี้");
    expect(normalizedMarketLabel("กี้")).not.toBe(normalizedMarketLabel("ตลาดกี้"));
  });
});

describe("legacy backfill attribution semantics", () => {
  it("A: batch market_name present → attribution backfillable", () => {
    const rawMarket = "ตลาด A";
    const normalized = normalizedMarketLabel(rawMarket);
    expect(normalized).toBe(MARKET_A_NORM);
    expect(
      aggregateGloballyAcceptedVerifiedTransfers(
        [{ id: "c-a", evidence_id: "ev-a", transfer_amount: 100, reference_id: "REF-A", created_at: "2026-07-23T01:00:00Z" }],
        new Map([["ev-a", normalized]]),
        new Set(["c-a"]),
        { marketLabelNormalized: MARKET_A_NORM, knownMarkets: KNOWN_AB },
      ).attributedTotal,
    ).toBe(100);
  });

  it("B: batch_id present but market_name NULL → remains unresolved", () => {
    const result = aggregateGloballyAcceptedVerifiedTransfers(
      [{ id: "c-u", evidence_id: "ev-u", transfer_amount: 50, reference_id: "REF-U", created_at: "2026-07-23T01:00:00Z" }],
      new Map([["ev-u", null]]),
      new Set(["c-u"]),
      { marketLabelNormalized: MARKET_A_NORM, knownMarkets: KNOWN_AB },
    );
    expect(result.attributedTotal).toBe(0);
    expect(result.unresolvedAcceptedCount).toBe(1);
  });

  it("C: batch_id NULL → remains unresolved", () => {
    const result = aggregateGloballyAcceptedVerifiedTransfers(
      [{ id: "c-u", evidence_id: "ev-null", transfer_amount: 75, reference_id: "REF-C", created_at: "2026-07-23T01:00:00Z" }],
      new Map([["ev-null", null]]),
      new Set(["c-u"]),
      { marketLabelNormalized: MARKET_A_NORM, knownMarkets: KNOWN_AB },
    );
    expect(result.attributedTotal).toBe(0);
    expect(result.unresolvedAcceptedCount).toBe(1);
    expect(result.unresolvedAcceptedAmount).toBe(75);
  });

  it("D (BR-02): reference_id NULL → pending manual resolution, not counted as market-unresolved", () => {
    const result = aggregateGloballyAcceptedVerifiedTransfers(
      [{ id: "c-pending", evidence_id: "ev-a", transfer_amount: 60, reference_id: null, created_at: "2026-07-23T01:00:00Z" }],
      new Map([["ev-a", MARKET_A_NORM]]),
      new Set<string>(),
      { marketLabelNormalized: MARKET_A_NORM, knownMarkets: KNOWN_AB },
    );
    expect(result.attributedTotal).toBe(0);
    expect(result.unresolvedAcceptedCount).toBe(0);
    expect(result.pendingReferenceCount).toBe(1);
    expect(result.pendingReferenceAmount).toBe(60);
  });
});

describe("White Sheet fail-closed for unattributed verified transfers", () => {
  function makeWhiteSheetDatabase(options?: {
    produceMarket?: string;
    evidences?: SlipEvidenceRow[];
    checks?: SlipCheckRow[];
    extraProduceMarkets?: string[];
    manualSessions?: ManualSlipSessionStub[];
    manualEntries?: ManualSlipEntryStub[];
  }) {
    const produceMarket = options?.produceMarket ?? MARKET_A;
    const produceRows = [
      {
        id: "item-1",
        product_name: "ทุเรียน",
        quantity: 10,
        unit: "โล",
        price_per_unit: 100,
        transaction_type: "เบิก",
        base_transaction_type: "เบิก",
        item_created_at: "2026-07-23T01:00:00Z",
        session_id: "main-session-1",
        transaction_date: BUSINESS_DATE,
        market_name: produceMarket,
        raw_message_id: "raw-1",
        basis_quantity: null,
        basis_price: null,
        session_kind: "main",
      },
      ...(options?.extraProduceMarkets ?? []).map((market, index) => ({
        id: `item-extra-${index}`,
        product_name: "มะม่วง",
        quantity: 1,
        unit: "โล",
        price_per_unit: 10,
        transaction_type: "เบิก",
        base_transaction_type: "เบิก",
        item_created_at: "2026-07-23T01:30:00Z",
        session_id: `main-session-extra-${index}`,
        transaction_date: BUSINESS_DATE,
        market_name: market,
        raw_message_id: `raw-extra-${index}`,
        basis_quantity: null,
        basis_price: null,
        session_kind: "main",
      })),
    ];

    const evidences = options?.evidences ?? [
      { id: "ev-a", market_label: MARKET_A },
      { id: "ev-u", market_label: null },
    ];
    const checks = options?.checks ?? [
      { id: "c-a", evidence_id: "ev-a", transfer_amount: 100, reference_id: "REF-A", created_at: "2026-07-23T01:00:00Z" },
      { id: "c-u", evidence_id: "ev-u", transfer_amount: 50, reference_id: "REF-U", created_at: "2026-07-23T02:00:00Z" },
    ];

    const db = makeTransferDatabase({ evidences, checks });
    const rawMessages = [
      { id: "raw-1", source_id: SOURCE_ID },
      ...(options?.extraProduceMarkets ?? []).map((_, index) => ({
        id: `raw-extra-${index}`,
        source_id: SOURCE_ID,
      })),
    ];

    const combined = {
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
          return {
            select: () => ({
              in: async () => ({ data: rawMessages, error: null }),
            }),
          };
        }
        if (table === "central_selling_prices") {
          return {
            select: () => ({
              eq: async () => ({
                data: [
                  { product_key: "ทุเรียน", unit_key: "โล", price_satang: 10000 },
                  { product_key: "มะม่วง", unit_key: "โล", price_satang: 1000 },
                ],
                error: null,
              }),
            }),
          };
        }
        if (table === "slip_evidences" || table === "slip_checks") {
          return db.from(table);
        }
        const manualSlip = stubManualSlipTables({
          sessions: options?.manualSessions,
          entries: options?.manualEntries,
        })(table);
        if (manualSlip) return manualSlip;
        throw new Error(`unexpected table: ${table}`);
      },
    };

    return combined as unknown as SupabaseClient<Database>;
  }

  it("adds a hard-stop warning and blocks trusted LINE summary", async () => {
    const database = makeWhiteSheetDatabase();
    const calculation = await loadDigitalWhiteSheetCalculation(
      database,
      {
        sourceId: SOURCE_ID,
        marketKey: "market-a",
        marketLabel: MARKET_A,
        businessDate: BUSINESS_DATE,
      },
      {
        expenses: { labor: 0, locationFee: 0, bag: 0, snack: 0, other: 0, otherNote: "" },
        actualCashSubmitted: 900,
      },
    );

    expect(calculation.verifiedTransfers).toBe(100);
    expect(hasHardStopWarning(calculation.warnings)).toBe(true);
    expect(calculation.warnings.some((w) => w.startsWith(UNATTRIBUTED_VERIFIED_TRANSFER_WARNING))).toBe(true);

    const pageModel = {
      entryStatus: "submitted" as const,
      summary: {
        marketKey: "market-a",
        marketLabel: MARKET_A,
        businessDate: BUSINESS_DATE,
        expectedSales: calculation.expectedSales,
        verifiedTransfers: calculation.verifiedTransfers,
        expenses: calculation.expenses,
        expenseTotal: calculation.expenseTotal,
        expectedCash: calculation.expectedCash,
        actualCashSubmitted: calculation.actualCashSubmitted,
        difference: calculation.difference,
        status: calculation.status,
        warnings: calculation.warnings,
      },
      finalizedAt: null,
      finalizedBy: null,
      profitability: { state: "round_unbound" as const },
    };

    expect(() => requireTrustedWhiteSheetSummary(pageModel)).toThrow(WhiteSheetHardStopError);
    expect(() => buildWhiteSheetSummaryMessagesFromPageModel(pageModel)).toThrow(WhiteSheetHardStopError);

    const html = renderToStaticMarkup(
      <DigitalWhiteSheetSummary viewModel={pageModel.summary} entryStatus="submitted" />,
    );
    expect(html).toContain(UNATTRIBUTED_VERIFIED_TRANSFER_WARNING);
    expect(html).toContain("white-sheet-hard-stop");
    expect(html).toContain("white-sheet-status-blocked");
  });

  it("HARD STOPs bare กี้ slip against produce ตลาดกี้ (no silent exclusion)", async () => {
    const produceMarket = "ตลาดกี้";
    const database = makeWhiteSheetDatabase({
      produceMarket,
      evidences: [{ id: "ev-bare", market_label: "กี้" }],
      checks: [
        {
          id: "c-bare",
          evidence_id: "ev-bare",
          transfer_amount: 120,
          reference_id: "REF-BARE",
          created_at: "2026-07-23T01:00:00Z",
        },
      ],
    });

    const calculation = await loadDigitalWhiteSheetCalculation(
      database,
      {
        sourceId: SOURCE_ID,
        marketKey: "market-gee",
        marketLabel: produceMarket,
        businessDate: BUSINESS_DATE,
      },
      {
        expenses: { labor: 0, locationFee: 0, bag: 0, snack: 0, other: 0, otherNote: "" },
        actualCashSubmitted: 880,
      },
    );

    expect(calculation.verifiedTransfers).toBe(0);
    expect(hasHardStopWarning(calculation.warnings)).toBe(true);
    expect(calculation.warnings.some((w) => w.startsWith(UNATTRIBUTED_VERIFIED_TRANSFER_WARNING))).toBe(true);
    expect(calculation.status).not.toBe("matched");

    const pageModel = {
      entryStatus: "submitted" as const,
      summary: {
        marketKey: "market-gee",
        marketLabel: produceMarket,
        businessDate: BUSINESS_DATE,
        expectedSales: calculation.expectedSales,
        verifiedTransfers: calculation.verifiedTransfers,
        expenses: calculation.expenses,
        expenseTotal: calculation.expenseTotal,
        expectedCash: calculation.expectedCash,
        actualCashSubmitted: calculation.actualCashSubmitted,
        difference: calculation.difference,
        status: calculation.status,
        warnings: calculation.warnings,
      },
      finalizedAt: null,
      finalizedBy: null,
      profitability: { state: "round_unbound" as const },
    };

    expect(() => requireTrustedWhiteSheetSummary(pageModel)).toThrow(WhiteSheetHardStopError);
    expect(() => buildWhiteSheetSummaryMessagesFromPageModel(pageModel)).toThrow(WhiteSheetHardStopError);

    const html = renderToStaticMarkup(
      <DigitalWhiteSheetSummary viewModel={pageModel.summary} entryStatus="submitted" />,
    );
    expect(html).toContain("white-sheet-hard-stop");
    expect(html).toContain("white-sheet-status-blocked");
  });

  it("does not HARD STOP merely because another legitimate market has transfers", async () => {
    const database = makeWhiteSheetDatabase({
      produceMarket: "ตลาดกี้",
      extraProduceMarkets: ["ตลาดน้อย"],
      evidences: [{ id: "ev-noi", market_label: "ตลาดน้อย" }],
      checks: [
        {
          id: "c-noi",
          evidence_id: "ev-noi",
          transfer_amount: 80,
          reference_id: "REF-NOI",
          created_at: "2026-07-23T01:00:00Z",
        },
      ],
    });

    const calculation = await loadDigitalWhiteSheetCalculation(
      database,
      {
        sourceId: SOURCE_ID,
        marketKey: "market-gee",
        marketLabel: "ตลาดกี้",
        businessDate: BUSINESS_DATE,
      },
      {
        expenses: { labor: 0, locationFee: 0, bag: 0, snack: 0, other: 0, otherNote: "" },
        actualCashSubmitted: 1000,
      },
    );

    expect(calculation.verifiedTransfers).toBe(0);
    expect(hasHardStopWarning(calculation.warnings)).toBe(false);
    expect(calculation.warnings.some((w) => w.startsWith(UNATTRIBUTED_VERIFIED_TRANSFER_WARNING))).toBe(false);
  });

  it("never attributes another market's closed manual slip", async () => {
    const calculation = await loadDigitalWhiteSheetCalculation(
      makeWhiteSheetDatabase({
        produceMarket: MARKET_A,
        evidences: [],
        checks: [],
        extraProduceMarkets: [MARKET_B],
        manualSessions: [{ id: "ms-b", market_label: MARKET_B }],
        manualEntries: [{ session_id: "ms-b", amount: 999 }],
      }),
      {
        sourceId: SOURCE_ID,
        marketKey: "market-a",
        marketLabel: MARKET_A,
        businessDate: BUSINESS_DATE,
      },
      {
        expenses: { labor: 0, locationFee: 0, bag: 0, snack: 0, other: 0, otherNote: "" },
        actualCashSubmitted: 1000,
      },
    );

    expect(calculation.verifiedTransfers).toBe(0);
  });

  it("adds AI attributed total + market-scoped manual total", async () => {
    const calculation = await loadDigitalWhiteSheetCalculation(
      makeWhiteSheetDatabase({
        produceMarket: MARKET_A,
        evidences: [{ id: "ev-a", market_label: MARKET_A }],
        checks: [
          {
            id: "c-a",
            evidence_id: "ev-a",
            transfer_amount: 50,
            reference_id: "REF-A50",
            created_at: "2026-07-23T01:00:00Z",
          },
        ],
        manualSessions: [{ id: "ms-a", market_label: MARKET_A }],
        manualEntries: [{ session_id: "ms-a", amount: 75 }],
      }),
      {
        sourceId: SOURCE_ID,
        marketKey: "market-a",
        marketLabel: MARKET_A,
        businessDate: BUSINESS_DATE,
      },
      {
        expenses: { labor: 0, locationFee: 0, bag: 0, snack: 0, other: 0, otherNote: "" },
        actualCashSubmitted: 875,
      },
    );

    expect(calculation.verifiedTransfers).toBe(125);
  });
});

describe("White Sheet manual slip bridge (checked_slip = AI + manual)", () => {
  const PROD_MARKET = "ทดสอบเงินโอน";
  const PROD_MARKET_NORM = normalizedMarketLabel(PROD_MARKET);
  const OTHER_MARKET = "ตลาดอื่น";

  function makeManualSlipDatabase(options: {
    sessions: ManualSlipSessionStub[];
    entries: ManualSlipEntryStub[];
  }) {
    return {
      from(table: string) {
        const manualSlip = stubManualSlipTables(options)(table);
        if (manualSlip) return manualSlip;
        throw new Error(`unexpected table: ${table}`);
      },
    } as unknown as SupabaseClient<Database>;
  }

  it("loadMarketScopedManualSlipTotal counts only closed sessions for the target market", async () => {
    const db = makeManualSlipDatabase({
      sessions: [
        { id: "ms-target", market_label: PROD_MARKET },
        { id: "ms-other", market_label: OTHER_MARKET },
        { id: "ms-null", market_label: null },
      ],
      entries: [
        { session_id: "ms-target", amount: 100 },
        { session_id: "ms-other", amount: 500 },
        { session_id: "ms-null", amount: 80 },
      ],
    });

    await expect(
      loadMarketScopedManualSlipTotal(db, SOURCE_ID, BUSINESS_DATE, PROD_MARKET_NORM),
    ).resolves.toBe(100);

    await expect(
      loadMarketScopedManualSlipTotal(db, SOURCE_ID, BUSINESS_DATE, normalizedMarketLabel(OTHER_MARKET)),
    ).resolves.toBe(500);
  });

  it("does not count an OPEN manual slip session", async () => {
    const db = makeManualSlipDatabase({
      sessions: [
        { id: "ms-open", market_label: PROD_MARKET, status: "open" },
        { id: "ms-closed", market_label: PROD_MARKET, status: "closed" },
      ],
      entries: [
        { session_id: "ms-open", amount: 999 },
        { session_id: "ms-closed", amount: 100 },
      ],
    });

    await expect(
      loadMarketScopedManualSlipTotal(db, SOURCE_ID, BUSINESS_DATE, PROD_MARKET_NORM),
    ).resolves.toBe(100);
  });

  it("does not count a closed manual slip from another source_id", async () => {
    const db = makeManualSlipDatabase({
      sessions: [
        { id: "ms-other-source", market_label: PROD_MARKET, source_id: "group-somewhere-else" },
      ],
      entries: [{ session_id: "ms-other-source", amount: 750 }],
    });

    await expect(
      loadMarketScopedManualSlipTotal(db, SOURCE_ID, BUSINESS_DATE, PROD_MARKET_NORM),
    ).resolves.toBe(0);
  });

  it("does not count a closed manual slip from another business_date", async () => {
    const db = makeManualSlipDatabase({
      sessions: [
        { id: "ms-other-date", market_label: PROD_MARKET, business_date: "2026-07-24" },
      ],
      entries: [{ session_id: "ms-other-date", amount: 640 }],
    });

    await expect(
      loadMarketScopedManualSlipTotal(db, SOURCE_ID, BUSINESS_DATE, PROD_MARKET_NORM),
    ).resolves.toBe(0);
  });

  it("Production gap: manual-only transfers enter verifiedTransfers and MATCH cash", async () => {
    // Live evidence: closed manual_slip 100, no AI slips, expected sales 320,
    // actual cash 220 → must be MATCHED (was SHORT 100 when manual slips ignored).
    const produceRows = [
      {
        id: "item-prod",
        product_name: "ทุเรียน",
        quantity: 3.2,
        unit: "โล",
        price_per_unit: 100,
        transaction_type: "เบิก",
        base_transaction_type: "เบิก",
        item_created_at: "2026-07-25T01:00:00Z",
        session_id: "main-session-prod",
        transaction_date: "2026-07-25",
        market_name: PROD_MARKET,
        raw_message_id: "raw-prod",
        basis_quantity: null,
        basis_price: null,
        session_kind: "main",
      },
    ];

    const prodDb = {
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
          return {
            select: () => ({
              in: async () => ({ data: [{ id: "raw-prod", source_id: SOURCE_ID }], error: null }),
            }),
          };
        }
        if (table === "central_selling_prices") {
          return {
            select: () => ({
              eq: async () => ({
                data: [{ product_key: "ทุเรียน", unit_key: "โล", price_satang: 10000 }],
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
        if (table === "slip_checks") {
          return {
            select: () => {
              const builder = {
                in: () => builder,
                not: () => builder,
                order: () => builder,
                then: (resolve: (value: unknown) => void) =>
                  resolve({ data: [], error: null }),
              };
              return builder;
            },
          };
        }
        const manualSlip = stubManualSlipTables({
          sessions: [{ id: "ms-prod", market_label: PROD_MARKET }],
          entries: [{ session_id: "ms-prod", amount: 100 }],
        })(table);
        if (manualSlip) return manualSlip;
        throw new Error(`unexpected table: ${table}`);
      },
    } as unknown as SupabaseClient<Database>;

    const calculation = await loadDigitalWhiteSheetCalculation(
      prodDb,
      {
        sourceId: SOURCE_ID,
        marketKey: PROD_MARKET.toLowerCase(),
        marketLabel: PROD_MARKET,
        businessDate: "2026-07-25",
      },
      {
        expenses: { labor: 0, locationFee: 0, bag: 0, snack: 0, other: 0, otherNote: "" },
        actualCashSubmitted: 220,
      },
    );

    expect(calculation.expectedSales).toBe(320);
    expect(calculation.verifiedTransfers).toBe(100);
    expect(calculation.expectedCash).toBe(220);
    expect(calculation.actualCashSubmitted).toBe(220);
    expect(calculation.difference).toBe(0);
    expect(calculation.status).toBe("matched");
  });
});

describe("0039 slip evidence market attribution migration contract", () => {
  const migrationPath = new URL(
    "../../supabase/migrations/0039_slip_evidence_market_attribution.sql",
    import.meta.url,
  );

  it("preserves raw market_label and documents SQL norm as non-trusted", async () => {
    const sql = await Bun.file(migrationPath).text();
    expect(sql).toContain("ADD COLUMN market_label");
    expect(sql).toContain("ADD COLUMN market_label_normalized");
    expect(sql).toContain("attach_evidence_to_slip_batch");
    expect(sql).toContain("btrim(normalize(btrim(b.market_name), NFC))");
    expect(sql).toContain("NOT the trusted financial identity");
    expect(sql).toContain("normalizedMarketLabel");
  });
});
