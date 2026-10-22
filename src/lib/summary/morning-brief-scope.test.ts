import { describe, expect, test } from "bun:test";
import { DATE, scopeFixture } from "../../../docs/handoffs/split-morning-brief-20261021/fixtures";
import { canonicalMarketLabel } from "@/lib/market";
import { loadMorningBriefReport, morningBriefReadiness } from "./morning-brief-service";
import { createMorningBriefPdfArtifact, morningBriefPdfPath, morningBriefReferencePath } from "./morning-brief-pdf";
import { morningBriefPdfRetryKey, morningBriefRetryKey, resolveStockSummaryDate } from "./daily-stock-cron";

describe("market-scoped Morning Brief UAT (synthetic, no network)", () => {
  test("market identity, not product classification, partitions every source and all financial fields", async () => {
    const { client, rows, db } = scopeFixture({ damage: true });
    const fruit = await loadMorningBriefReport(client, DATE, "fruit");
    const vegetable = await loadMorningBriefReport(client, DATE, "vegetable");
    const legacy = await loadMorningBriefReport(client, DATE);
    expect(fruit.sales.markets?.map((market) => canonicalMarketLabel(market.marketLabel))).toEqual(["พาซิโอ้ทุเรียน", "พาซิโอ้ผลไม้"]);
    expect(vegetable.sales.markets?.map((market) => canonicalMarketLabel(market.marketLabel))).toEqual(["พาซิโอ้ผัก"]);
    expect(fruit.sales.confirmedSalesSatang + vegetable.sales.confirmedSalesSatang).toBe(legacy.sales.confirmedSalesSatang);
    expect(vegetable.sales.confirmedSalesSatang).toBe(12_000);
    expect(vegetable.salesDetails?.[0]).toMatchObject({ withdrawnQuantity: 10, goodReturnQuantity: 3, damagedReturnQuantity: 1, soldQuantity: 6 });
    expect(vegetable.readiness).toEqual({ status: "ready", reasons: [] });
    expect(vegetable.houseStock).toEqual({ status: "missing" });
    expect(vegetable.produceFinancial?.vegetable?.houseStockValueSatang).toBeNull();
    expect(vegetable.produceFinancial?.vegetable?.readyValueSatang).toBeNull();
    expect(Object.values(vegetable.purchasePlanning).flatMap((group) => group.items ?? []).every((item) => item.houseStockQuantity === null && item.totalRemainingQuantity === null)).toBe(true);
    expect(vegetable.sourceTransactions?.map((row) => row.id).sort()).toEqual(rows.filter((row) => row.accountability_round_id === "vegetable").map((row) => String(row.id)).sort());
    expect(db.appendCalls).toBe(0);
  });

  test.each(["พาซีโอ้ผัก", "ตลาดพาซิโอ้ผัก", "พาชิโอ้ผัก", "พาสิโอ้ผัก"])("reviewed alias %s is included", async (alias) => {
    const report = await loadMorningBriefReport(scopeFixture({ alias }).client, DATE, "vegetable");
    expect(report.readiness?.status).toBe("ready");
    expect(report.sourceTransactions).toHaveLength(2);
  });

  test("round market overrides a misleading transaction display label", async () => {
    const { client } = scopeFixture({ rawMarket: "พาซิโอ้ผลไม้" });
    const vegetable = await loadMorningBriefReport(client, DATE, "vegetable");
    expect(vegetable.sourceTransactions).toHaveLength(2);
    expect(vegetable.sales.confirmedSalesSatang).toBe(14_000);
    expect(vegetable.produceReadiness?.markets[0].marketLabel).toBe("พาซิโอ้ผัก");
  });

  test("voided and superseded evidence cannot re-enter through the archive view", async () => {
    const { client, db } = scopeFixture({ goodReturn: false });
    db.seed("produce_transactions_all", [
      { id: "voided-return", transaction_date: DATE, market_name: "พาซิโอ้ผัก", transaction_type: "คืน", accountability_round_id: "vegetable", voided_at: "2026-10-20T01:00:00Z" },
      { id: "superseded-return", transaction_date: DATE, market_name: "พาซิโอ้ผัก", transaction_type: "คืน", accountability_round_id: "vegetable", voided_at: "2026-10-20T01:00:00Z", replacement_session_id: "replacement" },
    ]);
    const report = await loadMorningBriefReport(client, DATE, "vegetable");
    expect(report.readiness?.status).toBe("not_ready");
    expect(report.sourceTransactions).toHaveLength(1);
    expect(report.sourceTransactions?.[0].id).toBe("vegetable-เบิก");
  });

  test("white-sheet status and reconciliation use the same market scope", async () => {
    const { client, db } = scopeFixture();
    db.seed("digital_white_sheet_cash_entries", [{ business_date: DATE, market_label_normalized: "พาซิโอ้ผลไม้", white_sheet_sales: 0 }]);
    db.seed("transfer_reconciliations", [{ source_id: "Csynthetic", business_date: DATE, submitted_transfer_total: 100,
      checked_slip_total: 100, ai_verified_total: 100, manual_slip_total: 0, difference: 0 }]);
    db.seed("settlement_entries", [{ source_id: "Csynthetic", settlement_date: DATE, market_name: "พาซิโอ้ผลไม้" }]);
    const vegetable = await loadMorningBriefReport(client, DATE, "vegetable");
    const fruit = await loadMorningBriefReport(client, DATE, "fruit");
    expect(vegetable.whiteSheetStatus).toBe("missing");
    expect(vegetable.reconciliation).toEqual({ status: "missing" });
    expect(fruit.whiteSheetStatus).toBe("entered");
    expect(fruit.reconciliation?.status).toBe("available");
  });

  test.each([
    [{ goodReturn: false }, "missing_good_return"],
    [{ withdrawal: false }, "missing_withdrawal"],
    [{ withdrawal: false, goodReturn: false }, "missing_withdrawal"],
    [{ goodReturn: false, damage: true }, "missing_good_return"],
    [{ differentRound: true }, "no_matching_accountability_round"],
  ] as const)("incomplete or different-round evidence is not_ready: %j", async (options, reason) => {
    const report = await loadMorningBriefReport(scopeFixture(options).client, DATE, "vegetable");
    expect(report.readiness?.status).toBe("not_ready");
    expect(report.readiness?.reasons).toContain(reason);
    expect(report.sales.confirmedSalesSatang).toBe(0);
    await expect(createMorningBriefPdfArtifact({} as never, report)).rejects.toThrow("not_ready");
  });

  test("a normal day needs no damage document", async () => {
    const report = await loadMorningBriefReport(scopeFixture().client, DATE, "vegetable");
    expect(report.readiness?.status).toBe("ready");
    expect(report.sales.confirmedSalesSatang).toBe(14_000);
  });

  test("both documents do not override pending return review", async () => {
    const report = await loadMorningBriefReport(scopeFixture({ pending: true }).client, DATE, "vegetable");
    expect(report.readiness?.status).toBe("ready");
    expect(report.sales.confirmedSalesSatang).toBe(0);
    expect(report.sales.pendingReviewSalesSatang).toBe(12_500);
    expect(report.sales.valueAuthoritative).toBe(false);
  });

  test("unusable quantities remain unavailable despite both document kinds", async () => {
    const report = await loadMorningBriefReport(scopeFixture({ invalidQuantity: true }).client, DATE, "vegetable");
    expect(report.readiness?.status).toBe("ready");
    expect(report.sales.confirmedSalesSatang).toBe(0);
    expect(report.sales.excludedFromSalesCount).toBeGreaterThan(0);
    expect(report.salesDetails?.[0].soldQuantity).toBeNull();
  });

  test("late arrival is attributed to the sale date and a later manual run becomes ready", async () => {
    const { client, db } = scopeFixture({ late: true });
    const lateReturn = db.rows("produce_transactions").find((row) => row.id === "vegetable-คืน")!;
    db.rows("produce_transactions").splice(db.rows("produce_transactions").indexOf(lateReturn), 1);
    expect((await loadMorningBriefReport(client, DATE, "vegetable")).readiness?.status).toBe("not_ready");
    db.rows("produce_transactions").push(lateReturn);
    const report = await loadMorningBriefReport(client, DATE, "vegetable");
    expect(report.readiness?.status).toBe("ready");
    expect(report.businessDate).toBe(DATE);
    expect(resolveStockSummaryDate(null, Date.parse("2026-10-20T14:00:00+07:00"))).toBe(DATE);
    expect(resolveStockSummaryDate(null, Date.parse("2026-10-20T08:00:00+07:00"))).toBe(DATE);
  });

  test("legacy unbound documents never satisfy vegetable readiness", () => {
    expect(morningBriefReadiness([{ accountability_round_id: null, transaction_type: "เบิก" },
      { accountability_round_id: null, transaction_type: "คืน" }], "vegetable").status).toBe("not_ready");
  });

  test("one ready round cannot authorize pairing additional unbound legacy documents", async () => {
    const { client, db } = scopeFixture();
    const copy = db.rows("produce_transactions").filter((row) => row.accountability_round_id === "vegetable")
      .map((row) => ({ ...row, id: `legacy-${row.id}`, accountability_round_id: null }));
    db.rows("produce_transactions").push(...copy);
    const report = await loadMorningBriefReport(client, DATE, "vegetable");
    expect(report.readiness?.status).toBe("not_ready");
    expect(report.readiness?.reasons).toContain("unbound_accountability_round");
    await expect(createMorningBriefPdfArtifact({} as never, report)).rejects.toThrow("not_ready");
  });

  test("PDF and reference paths preserve old consumers and isolate both new scopes", () => {
    const paths = [undefined, "fruit", "vegetable"].flatMap((scope) => [
      morningBriefPdfPath(DATE, scope as "fruit" | "vegetable" | undefined),
      morningBriefReferencePath(DATE, scope as "fruit" | "vegetable" | undefined),
    ]);
    expect(new Set(paths).size).toBe(6);
    expect(paths[0]).toBe(`${DATE}/morning-brief-${DATE}.pdf`);
  });

  test("the real artifact writer keeps each PDF and reference JSON in its own scope", async () => {
    const uploads: { path: string; body: Uint8Array }[] = [];
    const storage = { storage: { from: () => ({
      upload: async (path: string, body: Uint8Array) => { uploads.push({ path, body }); return { error: null }; },
      createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://example.test/${path}` }, error: null }),
    }) } } as unknown as Parameters<typeof createMorningBriefPdfArtifact>[0];
    const { client } = scopeFixture({ damage: true });
    for (const scope of ["fruit", "vegetable"] as const) {
      const report = await loadMorningBriefReport(client, DATE, scope);
      await createMorningBriefPdfArtifact(storage, report, new Date("2026-10-20T14:00:00+07:00"));
    }
    expect(new Set(uploads.map((upload) => upload.path)).size).toBe(4);
    const references = uploads.filter((upload) => upload.path.endsWith(".json"))
      .map((upload) => JSON.parse(new TextDecoder().decode(upload.body)));
    expect(references.map((reference) => reference.report.reportScope)).toEqual(["fruit", "vegetable"]);
    expect(references.every((reference) => reference.report.sourceTransactions.length > 0)).toBe(true);
    expect(uploads.every((upload) => upload.path.includes("-fruit-") || upload.path.includes("-vegetable-"))).toBe(true);
  });

  test("delivery keys are stable, scope-specific, and PDF-independent of text pagination", () => {
    const fruit = morningBriefPdfRetryKey(DATE, "Csynthetic", "fruit");
    expect(fruit).toBe(morningBriefPdfRetryKey(DATE, "Csynthetic", "fruit"));
    expect(fruit).not.toBe(morningBriefPdfRetryKey(DATE, "Csynthetic", "vegetable"));
    expect(morningBriefRetryKey(DATE, "Csynthetic", 0)).not.toBe(morningBriefRetryKey(DATE, "Csynthetic", 0, undefined, "vegetable"));
    for (let part = 0; part < 5; part++) expect(fruit).not.toBe(morningBriefRetryKey(DATE, "Csynthetic", part));
  });

  test("moving Vegetable from 13:00 to 14:00 keeps the business date and LINE delivery identities", () => {
    const dates = ["13:00", "14:00"].map(time =>
      resolveStockSummaryDate(null, Date.parse(`2026-10-20T${time}:00+07:00`)));
    expect(dates).toEqual([DATE, DATE]);
    const pdfKeys = dates.map(date => morningBriefPdfRetryKey(date, "Csynthetic", "vegetable"));
    expect(new Set(pdfKeys).size).toBe(1);
    for (let part = 0; part < 5; part++) {
      const keys = dates.map(date => morningBriefRetryKey(date, "Csynthetic", part, undefined, "vegetable"));
      expect(new Set(keys).size).toBe(1);
    }
    expect(resolveStockSummaryDate(null, Date.parse("2026-10-20T07:00:00Z"))).toBe(DATE);
  });
});
