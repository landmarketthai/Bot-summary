import React from "react";
import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { formatThaiDate } from "@/lib/date";
import { morningBriefProductIdentity, type MorningBriefReport, type MorningBriefFruitFinancialSummary } from "@/lib/summary/morning-brief";
import { PRODUCE_SECTIONS, PRODUCE_SECTION_LABEL, produceSectionOf } from "@/lib/summary/produce-section";

function bahtFromSatang(satang: number): string {
  return (satang / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function qty(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

function thaiNumericDate(businessDate: string): string {
  const [year, month, day] = businessDate.split("-").map(Number);
  return `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year + 543}`;
}

const S = StyleSheet.create({
  page: {
    fontFamily: "SarabunPDF",
    fontSize: 11.1,
    paddingTop: 22,
    paddingBottom: 28,
    paddingHorizontal: 24,
    color: "#111827",
  },
  header: { marginBottom: 8 },
  title: { fontSize: 21.5, fontWeight: "bold" },
  subtitle: { fontSize: 10, color: "#6B7280", marginTop: 2 },
  kpiGrid: { flexDirection: "row", marginHorizontal: -2, marginBottom: 5, alignItems: "stretch" },
  kpi: { width: "20%", paddingHorizontal: 2 },
  kpiBox: { borderWidth: 0.9, borderColor: "#C7C9CE", padding: 5, height: 72, borderRadius: 3, justifyContent: "space-between" },
  kpiContent: { flexDirection: "column", justifyContent: "flex-end", alignItems: "flex-end" },
  kpiSales: { backgroundColor: "#FFF0BF", borderColor: "#D7AC3D" },
  kpiWithdrawal: { backgroundColor: "#DFEDFA", borderColor: "#6EACD5" },
  kpiReturn: { backgroundColor: "#DDF2DC", borderColor: "#6CAD76" },
  kpiHouse: { backgroundColor: "#FFE7C4", borderColor: "#E8AD65" },
  kpiReady: { backgroundColor: "#E6E4F7", borderColor: "#9E98D4" },
  kpiUnknownValue: { fontSize: 9.5, fontWeight: "bold", color: "#92400E", textAlign: "right", marginTop: 3 },
  stockWarning: { backgroundColor: "#FFF8E8", borderLeftWidth: 2, borderLeftColor: "#D09A39", padding: 5, marginTop: 4 },
  kpiLabel: { fontSize: 8.2, lineHeight: 1.25, color: "#6B7280", minHeight: 21 },
  kpiValue: { fontSize: 12.2, fontWeight: "bold", textAlign: "right" },
  kpiUnit: { fontSize: 7.2, color: "#6B7280", textAlign: "right", marginTop: 1 },
  financialCategory: { marginTop: 10 },
  financialCategoryTitle: { fontSize: 14, fontWeight: "bold", marginBottom: 5, backgroundColor: "#E9EFF7", borderLeftWidth: 4, borderLeftColor: "#477FA8", paddingVertical: 3, paddingHorizontal: 6 },
  summaryTitle: { fontSize: 18, fontWeight: "bold" },
  dailyOverview: {
    borderWidth: 1, borderColor: "#D6A84B", borderRadius: 4,
    backgroundColor: "#FFF9E9", padding: 9, marginBottom: 8,
  },
  dailyOverviewTitle: { fontSize: 13, fontWeight: "bold", color: "#704C15" },
  dailyOverviewTotal: { fontSize: 23, fontWeight: "bold", color: "#111827", marginTop: 2 },
  dailyOverviewDetails: { fontSize: 10, marginTop: 4, color: "#374151" },
  dailyOverviewWarning: { fontSize: 9.2, marginTop: 4, color: "#92400E" },
  emptyPreviewTag: { backgroundColor: "#F1E7FB", borderWidth: 0.7, borderColor: "#9A76BE", padding: 7, marginBottom: 10 },
  emptyPreviewText: { fontSize: 10, fontWeight: "bold", color: "#6A437F" },
  emptyHeader: { marginBottom: 17, borderBottomWidth: 1.2, borderBottomColor: "#CBD5E1", paddingBottom: 11 },
  emptyHeaderKicker: { fontSize: 10, fontWeight: "bold", color: "#477FA8", marginBottom: 4 },
  emptyHeaderTitle: { fontSize: 20.5, fontWeight: "bold" },
  emptyHeaderSubtitle: { fontSize: 10.8, color: "#6B7280", marginTop: 5 },
  emptyHero: { backgroundColor: "#FFF7E7", borderWidth: 1, borderColor: "#D6A84B",
    borderRadius: 6, paddingVertical: 17, paddingHorizontal: 16, marginBottom: 19 },
  emptyHeroLabel: { fontSize: 10.2, fontWeight: "bold", color: "#946217", marginBottom: 6 },
  emptyHeroTitle: { fontSize: 16, lineHeight: 1.35, fontWeight: "bold", color: "#5B4018", marginBottom: 8 },
  emptyHeroDescription: { fontSize: 11.4, lineHeight: 1.45, color: "#74552B" },
  emptySectionTitle: { fontSize: 14.5, fontWeight: "bold", marginBottom: 8 },
  emptyCardRow: { flexDirection: "row", marginHorizontal: -4, marginBottom: 8 },
  emptyCardOuter: { width: "50%", paddingHorizontal: 4 },
  emptyCard: { borderWidth: 0.8, borderColor: "#D7DEE7", backgroundColor: "#F8FAFC",
    borderRadius: 5, padding: 12, minHeight: 102, justifyContent: "space-between" },
  emptyCardTitle: { fontSize: 11.7, fontWeight: "bold", color: "#35455A" },
  emptyCardValue: { fontSize: 12.5, fontWeight: "bold", color: "#946217", marginTop: 6 },
  emptyCardValueAvailable: { fontSize: 12.5, fontWeight: "bold", color: "#326A48", marginTop: 6 },
  emptyCardValueUnavailable: { fontSize: 12, fontWeight: "bold", color: "#6B7280", marginTop: 6 },
  emptyCardNote: { fontSize: 9.5, color: "#6B7280", marginTop: 5 },
  emptyNotice: { backgroundColor: "#EDF4FB", borderLeftWidth: 3, borderLeftColor: "#477FA8",
    marginTop: 13, paddingVertical: 12, paddingHorizontal: 13 },
  emptyNoticeTitle: { fontSize: 11.7, fontWeight: "bold", marginBottom: 5, color: "#254F75" },
  emptyNoticeText: { fontSize: 10.5, lineHeight: 1.45, color: "#374151" },

  coverSectionTitle: { fontSize: 13, fontWeight: "bold", marginTop: 12, marginBottom: 6 },
  coverCategory: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 5, paddingHorizontal: 8, borderBottomWidth: 0.6, borderBottomColor: "#DEE3E9" },
  coverCategoryName: { fontSize: 11.3 },
  coverCategoryValue: { fontSize: 11.3, fontWeight: "bold" },
  coverMarketHeader: { flexDirection: "row", paddingVertical: 5, paddingHorizontal: 8, backgroundColor: "#E9EFF7" },
  coverMarketRow: { flexDirection: "row", paddingVertical: 4, paddingHorizontal: 8, borderBottomWidth: 0.6, borderBottomColor: "#DEE3E9" },
  coverMarketName: { width: "65%", fontSize: 10.3 },
  coverMarketAmount: { width: "35%", fontSize: 10.3, textAlign: "right" },
  explanation: {
    borderLeftWidth: 2.5,
    borderLeftColor: "#777B80",
    backgroundColor: "#F8F8F7",
    paddingVertical: 7,
    paddingHorizontal: 8,
    marginBottom: 9,
  },
  explanationTitle: { fontWeight: "bold", fontSize: 11.2, marginBottom: 2 },
  explanationText: { fontSize: 9.8, lineHeight: 1.35 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "bold",
    borderTopWidth: 0.7,
    borderTopColor: "#B6BAC0",
    paddingTop: 6,
    marginBottom: 4,
  },
  table: { borderLeftWidth: 0.6, borderTopWidth: 0.6, borderColor: "#B6BAC0" },
  tr: { flexDirection: "row" },
  cell: {
    borderRightWidth: 0.6,
    borderBottomWidth: 0.6,
    borderColor: "#B6BAC0",
    paddingVertical: 3.8,
    paddingHorizontal: 5,
  },
  th: { fontWeight: "bold", fontSize: 11.4, backgroundColor: "#E8E8E8" },
  totalRow: { backgroundColor: "#E8E8E8", fontWeight: "bold" },
  marketTitle: {
    fontSize: 12.3,
    fontWeight: "bold",
    borderTopWidth: 0.7,
    borderTopColor: "#B6BAC0",
    paddingTop: 5,
    marginBottom: 4,
  },
  marketCell: {
    borderRightWidth: 0.6,
    borderBottomWidth: 0.6,
    borderColor: "#CBD5E1",
    paddingVertical: 4,
    paddingHorizontal: 5,
    fontSize: 10.2,
    textAlign: "center",
  },
  marketHeader: { fontWeight: "bold", fontSize: 10.6 },
  marketName: { backgroundColor: "#F4F5F7" },
  marketWithdrawal: { backgroundColor: "#E5F0FD" },
  marketSales: { backgroundColor: "#F8F0CD" },
  marketReturn: { backgroundColor: "#E4F2E1" },
  marketTotal: { fontWeight: "bold", fontSize: 11.1 },
  // Keep stock rows legible without forcing a fourth page for a stray note.
  matrixCell: { paddingVertical: 5.0, paddingHorizontal: 5, fontSize: 11.7 },
  stockUnit: { fontSize: 9.2, color: "#4B5563" },
  matrixName: { backgroundColor: "#FFFFFF" },
  matrixAlternate: { backgroundColor: "#F4F7F4" },
  matrixTotal: { backgroundColor: "#DCEBD5" },
  matrixMarket: { backgroundColor: "#D9E7EC" },
  matrixHouse: { backgroundColor: "#FFF0C9" },
  matrixMarketText: { color: "#D92D20" },
  center: { textAlign: "center" },
  right: { textAlign: "right" },
  noteBox: { borderWidth: 0.7, borderColor: "#8E9298", padding: 5, marginTop: 5 },
  note: { fontSize: 9.2, color: "#4B5563" },
  stockHeader: {
    borderBottomWidth: 1.4,
    borderBottomColor: "#111827",
    paddingBottom: 7,
    marginBottom: 8,
  },
  footer: {
    position: "absolute",
    bottom: 10,
    left: 24,
    right: 24,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 8.2,
    color: "#6B7280",
  },
});

function MarketCell({
  width,
  children,
  tone,
  header = false,
  total = false,
}: {
  width: string;
  children?: React.ReactNode;
  tone: "name" | "withdrawal" | "sales" | "return";
  header?: boolean;
  total?: boolean;
}) {
  const toneStyle = tone === "withdrawal"
    ? S.marketWithdrawal
    : tone === "sales"
      ? S.marketSales
      : tone === "return"
        ? S.marketReturn
        : S.marketName;
  return <View style={[S.marketCell, toneStyle, header ? S.marketHeader : {}, total ? S.marketTotal : {}, { width }]}>
    <Text style={S.center}>{children}</Text>
  </View>;
}

function MatrixCell({
  width,
  children,
  header = false,
  tone = "name",
  right = false,
  center = false,
  alternate = false,
}: {
  width: string;
  children?: React.ReactNode;
  header?: boolean;
  tone?: "name" | "total" | "market" | "house";
  right?: boolean;
  center?: boolean;
  alternate?: boolean;
}) {
  const toneStyle = tone === "total"
    ? S.matrixTotal
    : tone === "market"
      ? S.matrixMarket
      : tone === "house"
        ? S.matrixHouse
        : S.matrixName;

  return <View style={[S.cell, S.matrixCell, toneStyle, alternate && tone === "name" ? S.matrixAlternate : {}, header ? S.th : {}, { width }]}>
    <Text style={[
      right ? S.right : center ? S.center : {},
      tone === "market" && !header ? S.matrixMarketText : {},
    ]}>{children}</Text>
  </View>;
}

const STOCK_CATEGORIES = ["ผลไม้", "ผัก", "อื่นๆ"] as const;
type StockPageCategory = typeof STOCK_CATEGORIES[number];

type StockMatrixItem = {
  productName: string;
  category: string;
  unit: string;
  houseStockQuantity: number | null;
  marketStockQuantity: number;
  totalRemainingQuantity: number | null;
};

function stockCategory(item: StockMatrixItem): StockPageCategory {
  const identity = morningBriefProductIdentity(item.productName, item.unit);
  return PRODUCE_SECTION_LABEL[produceSectionOf(identity.productName)] as StockPageCategory;
}

function stockMatrixKey(productName: string, unit: string): string {
  return `${productName}\u0000${displayUnit(unit)}`;
}

function stockMatrixItems(report: MorningBriefReport): StockMatrixItem[] {
  const byKey = new Map<string, StockMatrixItem>();

  for (const item of (["strong", "surplus", "reduce", "unknown"] as const)
    .flatMap((status) => report.purchasePlanning[status].items ?? [])) {
    byKey.set(stockMatrixKey(item.productName, item.unit), {
      productName: item.productName,
      category: item.category,
      unit: item.unit,
      houseStockQuantity: item.houseStockQuantity ?? null,
      marketStockQuantity: item.marketStockQuantity ?? 0,
      totalRemainingQuantity: item.totalRemainingQuantity ?? null,
    });
  }

  if (report.houseStock.status === "available") {
    // House groups are split by unit price, so one product can arrive as
    // several groups. Sum them (in milli-units) before filling the matrix.
    const houseMilliByKey = new Map<string, number>();
    for (const item of report.houseStock.items ?? []) {
      const key = stockMatrixKey(item.productName, item.unit);
      houseMilliByKey.set(key, (houseMilliByKey.get(key) ?? 0) + Math.round(item.quantity * 1000));
      if (!byKey.has(key)) {
        byKey.set(key, {
          productName: item.productName,
          category: item.category,
          unit: item.unit,
          houseStockQuantity: null,
          marketStockQuantity: 0,
          totalRemainingQuantity: null,
        });
      }
    }
    for (const [key, milli] of houseMilliByKey) {
      const row = byKey.get(key)!;
      if (row.houseStockQuantity != null) continue;
      row.houseStockQuantity = milli / 1000;
      row.totalRemainingQuantity = (milli + Math.round(row.marketStockQuantity * 1000)) / 1000;
    }
  }

  return [...byKey.values()];
}

function hasRealStockQuantity(item: StockMatrixItem): boolean {
  return (item.houseStockQuantity ?? 0) > 0 || item.marketStockQuantity > 0;
}

function stockQuantity(value: number | null | undefined, blankZero = false): string {
  if (value == null) return "-";
  if (blankZero && value === 0) return "";
  return qty(value);
}

function displayUnit(unit: string): string {
  return unit === "โล" ? "กก." : unit;
}

function StockMatrix({ items, category }: { items: ReturnType<typeof stockMatrixItems>; category: StockPageCategory }) {
  return <View style={S.table}>
    <View style={S.tr} fixed>
      {/* The fixed table header repeats when a category spans pages, preserving context. */}
      <MatrixCell width="40%" header center>{`รายการ (${category})`}</MatrixCell>
      <MatrixCell width="20%" header tone="house" center>บ้านเจ๊</MatrixCell>
      <MatrixCell width="20%" header tone="market" center>ในตลาด</MatrixCell>
      <MatrixCell width="20%" header tone="total" center>รวมคงเหลือ</MatrixCell>
    </View>
    {items.map((item, index) => {
      const unitLabel = displayUnit(item.unit) || "ไม่ระบุหน่วย";
      return <View style={S.tr} key={`${item.productName}-${item.unit}-${index}`} wrap={false}
        // Never strand the รวม rows alone at the top of a new page.
        minPresenceAhead={index === items.length - 1 ? 35 : 0}>
        <MatrixCell width="40%" center alternate={index % 2 === 1}>
          {item.productName} <Text style={S.stockUnit}>{`(${unitLabel})`}</Text>
        </MatrixCell>
        <MatrixCell width="20%" tone="house" center>{stockQuantity(item.houseStockQuantity, true)}</MatrixCell>
        <MatrixCell width="20%" tone="market" center>{stockQuantity(item.marketStockQuantity, true)}</MatrixCell>
        <MatrixCell width="20%" tone="total" center>{stockQuantity(item.totalRemainingQuantity)}</MatrixCell>
      </View>;
    })}
    {Array.from(new Set(items.map((item) => displayUnit(item.unit)))).map((unit) => {
      // โล and กก. are one unit; never print two partial "รวม (กก.)" rows.
      const unitItems = items.filter((item) => displayUnit(item.unit) === unit);
      const houseKnown = unitItems.every((item) => item.houseStockQuantity != null);
      const sum = (key: "houseStockQuantity" | "marketStockQuantity" | "totalRemainingQuantity") =>
        unitItems.every((item) => item[key] != null)
          ? qty(unitItems.reduce((total, item) => total + item[key]!, 0))
          : "-";
      return <View style={S.tr} key={`total-${unit}`} wrap={false}>
        <MatrixCell width="40%" tone="total" center>{`รวม (${unit})`}</MatrixCell>
        <MatrixCell width="20%" tone="total" center>{houseKnown ? sum("houseStockQuantity") : "-"}</MatrixCell>
        <MatrixCell width="20%" tone="total" center>{sum("marketStockQuantity")}</MatrixCell>
        <MatrixCell width="20%" tone="total" center>{houseKnown ? sum("totalRemainingQuantity") : "-"}</MatrixCell>
      </View>;
    })}
  </View>;
}

function EmptyEvidenceCard({ title, status, note }: {
  title: string;
  status: "available" | "missing" | "unavailable";
  note: string;
}) {
  const label = status === "available" ? "มีข้อมูลแล้ว"
    : status === "unavailable" ? "ตรวจสอบไม่ได้ขณะนี้" : "ยังไม่มีข้อมูล";
  const valueStyle = status === "available" ? S.emptyCardValueAvailable
    : status === "unavailable" ? S.emptyCardValueUnavailable : S.emptyCardValue;
  return <View style={S.emptyCardOuter}>
    <View style={S.emptyCard} wrap={false}>
      <Text style={S.emptyCardTitle}>{title}</Text>
      <Text style={valueStyle}>{label}</Text>
      <Text style={S.emptyCardNote}>{note}</Text>
    </View>
  </View>;
}

function DataFooter({ generatedText }: { generatedText: string }) {
  return <View style={S.footer} fixed>
    <Text>สร้างเมื่อ {generatedText}</Text>
    <Text render={({ pageNumber, totalPages }) => `หน้า ${pageNumber}/${totalPages}`} />
  </View>;
}

/**
 * The same five money fields are reused for the daily headline and for each
 * produce category immediately above its physical-stock table.
 * Null house/ready values stay unknown, never fabricated as zero.
 */
function FinancialKpis({ label, financial, showTitle = true }: {
  label: string;
  financial: MorningBriefFruitFinancialSummary;
  showTitle?: boolean;
}) {
  // Category names appear in the section title, not repeatedly in narrow cards.
  // Short, consistent labels make every row legible on an A4 printout.
  const cards = [
    { label: "ยอดขายเมื่อวาน", value: bahtFromSatang(financial.salesValueSatang), hint: "บาท", tone: S.kpiSales },
    { label: "ยอดเบิกไปขาย", value: bahtFromSatang(financial.withdrawalValueSatang), hint: "บาท", tone: S.kpiWithdrawal },
    { label: "ยอดชั่งคืนดี", value: bahtFromSatang(financial.goodReturnValueSatang), hint: "บาท", tone: S.kpiReturn },
    { label: "สต็อกที่บ้าน", value: financial.houseStockValueSatang == null ? "รอข้อมูล" : bahtFromSatang(financial.houseStockValueSatang),
      hint: financial.houseStockValueSatang == null ? "ยังไม่มียอดบ้าน" : "บาท", tone: S.kpiHouse, unknown: financial.houseStockValueSatang == null },
    { label: "คงเหลือพร้อมขาย", value: financial.readyValueSatang == null ? "รอยอดบ้าน" : bahtFromSatang(financial.readyValueSatang),
      hint: "ชั่งคืนดี + สต็อกบ้าน", tone: S.kpiReady, unknown: financial.readyValueSatang == null },
  ];
  return <View wrap={false} style={{ marginTop: 5 }}>
    {showTitle ? <Text style={S.coverSectionTitle}>{label === "รวมทุกสินค้า" ? "ภาพรวมมูลค่าทุกหมวด" : `หมวด${label}`}</Text> : null}
    <View style={S.kpiGrid}>
      {cards.map((card, i) => <View style={S.kpi} key={i}>
        <View style={[S.kpiBox, card.tone]}>
          <Text style={S.kpiLabel}>{card.label}</Text>
          <View style={S.kpiContent}>
            <Text style={card.unknown ? S.kpiUnknownValue : S.kpiValue}>{card.value}</Text>
            <Text style={S.kpiUnit}>{card.hint}</Text>
          </View>
        </View>
      </View>)}
    </View>
  </View>;
}

export function MorningBriefA4Doc({ report, generatedAt, previewLabel }: { report: MorningBriefReport; generatedAt: Date; previewLabel?: string }) {
  const generatedText = new Intl.DateTimeFormat("th-TH", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Bangkok",
  }).format(generatedAt);
  const financialBySection = report.produceFinancial ?? (report.fruitFinancial ? { fruit: report.fruitFinancial } : {});
  const financialSections = PRODUCE_SECTIONS.flatMap((section) => {
    const financial = financialBySection[section];
    // No dedicated finance block for a category with only zero-valued data.
    // This does NOT suppress its physical stock rows later in the document.
    const hasFinanceActivity = financial && (
      financial.withdrawalValueSatang !== 0 ||
      financial.salesValueSatang !== 0 ||
      financial.goodReturnValueSatang !== 0 ||
      (financial.houseStockValueSatang ?? 0) !== 0 ||
      (financial.readyValueSatang ?? 0) !== 0 ||
      financial.markets.some((market) =>
        market.withdrawalValueSatang !== 0 || market.salesValueSatang !== 0 || market.goodReturnValueSatang !== 0)
    );
    return hasFinanceActivity ? [{ section, financial }] : [];
  });
  // Unclassified/other money is included in these totals, but NEVER forced into
  // fruit or vegetable to make the front page look clean.
  const financialTotal = (key: "withdrawalValueSatang" | "goodReturnValueSatang") =>
    financialSections.reduce((total, entry) => total + entry.financial[key], 0);
  const knownTotal = (key: "houseStockValueSatang" | "readyValueSatang"): number | null =>
    financialSections.length > 0 && financialSections.every(({ financial }) => financial[key] != null)
      ? financialSections.reduce((total, { financial }) => total + financial[key]!, 0)
      : null;
  const combined: MorningBriefFruitFinancialSummary = {
    salesValueSatang: report.sales.totalSalesSatang,
    withdrawalValueSatang: financialTotal("withdrawalValueSatang"),
    goodReturnValueSatang: financialTotal("goodReturnValueSatang"),
    houseStockValueSatang: knownTotal("houseStockValueSatang"),
    readyValueSatang: knownTotal("readyValueSatang"),
    markets: [],
  };
  const unclassified = financialSections.find(({ section }) => section === "other")?.financial;
  const coverMarketTotals = new Map<string, { withdrawal: number; goodReturn: number; sales: number }>();
  for (const { financial } of financialSections) {
    for (const market of financial.markets) {
      const current = coverMarketTotals.get(market.marketLabel) ?? { withdrawal: 0, goodReturn: 0, sales: 0 };
      current.withdrawal += market.withdrawalValueSatang;
      current.goodReturn += market.goodReturnValueSatang;
      current.sales += market.salesValueSatang;
      coverMarketTotals.set(market.marketLabel, current);
    }
  }
  // Fall back to section market data only when older reports lack daily market rows.
  const marketRows = report.sales.markets?.length
    ? report.sales.markets
    : [...coverMarketTotals.entries()].map(([marketLabel, totals]) => ({
        marketLabel, totalSalesSatang: totals.sales,
      }));
  // The five money-field summaries stay on one A4 page even on busy days.
  // Extra market rows continue AFTER the cover.
  const COVER_MARKET_LIMIT = 7;
  const firstPageMarkets = marketRows.slice(0, COVER_MARKET_LIMIT);
  const remainingMarkets = marketRows.slice(COVER_MARKET_LIMIT);
  const stockItems = stockMatrixItems(report);
  // The day-wide sales report is the source of truth for the headline. Section
  // totals remain a breakdown, never a substitute for the whole-day result.
  const sectionSalesTotalSatang = financialSections.reduce(
    (sum, { financial }) => sum + financial.salesValueSatang, 0,
  );
  // No saved produce rows means "not reported yet", never a business-zero day.
  const noProduceEvidence = report.produceReadiness?.transactionCount === 0;
  const hasDailyActivity = !noProduceEvidence && (financialSections.length > 0
    || stockItems.some(hasRealStockQuantity)
    || report.sales.totalSalesSatang !== 0
    || report.sales.confirmedSalesSatang !== 0
    || report.sales.pendingReviewSalesSatang !== 0);
  const salesBreakdownDiffers = report.produceFinancial != null
    && financialSections.length > 0
    && sectionSalesTotalSatang !== report.sales.totalSalesSatang;
  const stockSections = STOCK_CATEGORIES.flatMap((category) => {
    const items = stockItems.filter((item) => stockCategory(item) === category);
    const financial = category === "ผลไม้" ? financialBySection.fruit
      : category === "ผัก" ? financialBySection.vegetable : undefined;
    // Money summaries appear over the matching stock table, not on the cover.
    // Still show a financial category even when there is no physical stock.
    const hasStock = items.some(hasRealStockQuantity);
    const hasFinance = category !== "อื่นๆ" && financialSections.some(({ section }) => PRODUCE_SECTION_LABEL[section] === category);
    return hasStock || hasFinance ? [{ category, items, financial, hasStock }] : [];
  });

  return <Document title={`Morning Brief ${report.businessDate}`}>
    {hasDailyActivity ? <><Page size="A4" style={S.page} wrap>
      <View style={S.header}>
        <Text style={S.summaryTitle}>สรุปยอดขายประจำวัน - {formatThaiDate(report.businessDate)}</Text>
        <Text style={S.subtitle}>Bot-summary | ข้อมูลวันที่ {thaiNumericDate(report.businessDate)} | ภาพรวมยอดขายทุกหมวดและรายละเอียดตามตลาด</Text>
      </View>
      <View style={S.dailyOverview} wrap={false}>
        <Text style={S.dailyOverviewTitle}>
          {report.sales.excludedFromSalesCount > 0
            ? "ยอดขายตามข้อมูลที่มี"
            : "ยอดขายรวมทั้งวัน"} — {thaiNumericDate(report.businessDate)}
        </Text>
        <Text style={S.dailyOverviewTotal}>{bahtFromSatang(report.sales.totalSalesSatang)} บาท</Text>
        <Text style={S.dailyOverviewDetails}>รวมยอดที่คำนวณได้จากทุกหมวดสินค้าและทุกตลาด</Text>
      </View>
      <FinancialKpis label="รวมทุกสินค้า" financial={combined} />
      {marketRows.length > 0 ? <View style={{ marginTop: 4 }}>
        <Text style={S.coverSectionTitle}>สรุปยอดตามตลาด (ทุกสินค้า)</Text>
        <View style={S.table}>
          <View style={S.tr} fixed>
            <MarketCell width="28%" tone="name" header>ตลาด</MarketCell>
            <MarketCell width="24%" tone="withdrawal" header>เบิกไปขาย</MarketCell>
            <MarketCell width="24%" tone="sales" header>ยอดขาย</MarketCell>
            <MarketCell width="24%" tone="return" header>ชั่งคืนดี</MarketCell>
          </View>
          {firstPageMarkets.map((market, index) => {
            const totals = coverMarketTotals.get(market.marketLabel);
            return <View key={`${market.marketLabel}-${index}`} style={S.tr} wrap={false}>
              <MarketCell width="28%" tone="name">{market.marketLabel}</MarketCell>
              <MarketCell width="24%" tone="withdrawal">{totals ? bahtFromSatang(totals.withdrawal) : "-"}</MarketCell>
              <MarketCell width="24%" tone="sales">{bahtFromSatang(market.totalSalesSatang)}</MarketCell>
              <MarketCell width="24%" tone="return">{totals ? bahtFromSatang(totals.goodReturn) : "-"}</MarketCell>
            </View>;
          })}
          <View style={S.tr} wrap={false}>
            <MarketCell width="28%" tone="name" total>รวมทุกตลาด</MarketCell>
            <MarketCell width="24%" tone="withdrawal" total>{bahtFromSatang(combined.withdrawalValueSatang)}</MarketCell>
            <MarketCell width="24%" tone="sales" total>{bahtFromSatang(report.sales.totalSalesSatang)}</MarketCell>
            <MarketCell width="24%" tone="return" total>{bahtFromSatang(combined.goodReturnValueSatang)}</MarketCell>
          </View>
        </View>
        {remainingMarkets.length > 0 ? <Text style={[S.note, { marginTop: 4 }]}>
          รายละเอียดอีก {remainingMarkets.length} ตลาดต่อในหน้าถัดไป (ยอดรวมด้านบนรวมทุกตลาดแล้ว)
        </Text> : null}
      </View> : null}
      <DataFooter generatedText={generatedText} />
    </Page>
    <Page size="A4" style={S.page} wrap>
      {remainingMarkets.length > 0 ? <View style={{ marginBottom: 10 }}>
        <Text style={S.coverSectionTitle}>ตลาดเพิ่มเติม (ยอดรวมอยู่หน้าแรกแล้ว)</Text>
        <View style={S.table}>
          <View style={S.tr} fixed>
            <MarketCell width="28%" tone="name" header>ตลาด</MarketCell>
            <MarketCell width="24%" tone="withdrawal" header>เบิกไปขาย</MarketCell>
            <MarketCell width="24%" tone="sales" header>ยอดขาย</MarketCell>
            <MarketCell width="24%" tone="return" header>ชั่งคืนดี</MarketCell>
          </View>
          {remainingMarkets.map((market, index) => {
            const totals = coverMarketTotals.get(market.marketLabel);
            return <View style={S.tr} key={`${market.marketLabel}-${index}`} wrap={false}>
              <MarketCell width="28%" tone="name">{market.marketLabel}</MarketCell>
              <MarketCell width="24%" tone="withdrawal">{totals ? bahtFromSatang(totals.withdrawal) : "-"}</MarketCell>
              <MarketCell width="24%" tone="sales">{bahtFromSatang(market.totalSalesSatang)}</MarketCell>
              <MarketCell width="24%" tone="return">{totals ? bahtFromSatang(totals.goodReturn) : "-"}</MarketCell>
            </View>;
          })}
        </View>
      </View> : null}
      <View style={[S.explanation, { marginTop: 9 }]} wrap={false}>
        <Text style={S.explanationTitle}>รายละเอียดการตรวจข้อมูล</Text>
        {unclassified && unclassified.salesValueSatang !== 0 ? <Text style={S.explanationText}>มูลค่าสินค้ารอจัดหมวด {bahtFromSatang(unclassified.salesValueSatang)} บาท (รวมในยอดขายหน้าแรกแล้ว ไม่เพิ่มยอดซ้ำ)</Text> : null}
        <Text style={S.explanationText}>ยอดขายยืนยันแล้ว {bahtFromSatang(report.sales.confirmedSalesSatang)} บาท • ยอดรอตรวจ {bahtFromSatang(report.sales.pendingReviewSalesSatang)} บาท</Text>
        {report.sales.adjustmentSatang !== 0 ? <Text style={S.explanationText}>ยอดปรับราคา {bahtFromSatang(report.sales.adjustmentSatang)} บาท</Text> : null}
        {report.sales.excludedFromSalesCount > 0 ? <Text style={S.dailyOverviewWarning}>มี {report.sales.excludedFromSalesCount} รายการที่คำนวณยอดขายไม่ได้ รวมอยู่ในยอดรายงานไม่ได้</Text> : null}
        {salesBreakdownDiffers ? <Text style={S.dailyOverviewWarning}>ยอดแยกหมวดรวม {bahtFromSatang(sectionSalesTotalSatang)} บาท ต่างจากยอดขายรวมในระบบ {bahtFromSatang(report.sales.totalSalesSatang)} บาท — โปรดตรวจสอบความครบถ้วนของข้อมูล ห้ามถือว่าเป็นยอดยืนยันเพิ่ม</Text> : null}
        {!report.sales.valueAuthoritative || report.sales.excludedFromSalesCount > 0 ? <Text style={S.dailyOverviewWarning}>ยอดขายมีรายการที่ยังไม่ครบหรือรอตรวจ กรุณาดูยอดยืนยันแล้วแยกต่างหาก</Text> : null}
      </View>

      {report.produceReadiness ? <View style={{ marginBottom: 9 }}>
        <Text style={S.explanationTitle}>สถานะข้อมูลตามตลาด (ยังไม่ยืนยันความครบทุกตลาด)</Text>
        {report.produceReadiness.markets.length === 0 ? <Text style={S.explanationText}>ยังไม่มีข้อมูลเบิก–ชั่งคืน</Text> :
          report.produceReadiness.markets.map((market) => <View key={market.marketLabel} wrap={false}>
            <Text style={S.explanationText}>{market.marketLabel}: {market.hasWithdrawal ? "เบิกมี" : "ไม่พบเบิก"} / {market.hasReturn ? "ชั่งคืนมี" : "ไม่พบชั่งคืน"}</Text>
          </View>)}
        <Text style={S.note}>พบข้อมูลทั้งสองประเภทไม่ได้หมายความว่ายืนยันครบ และยังไม่ทราบรายชื่อตลาดที่ไม่ได้ส่งข้อมูล</Text>
      </View> : null}
      {/* Product stocks follow the audit, never duplicating the cover totals. A new
          physical page. Headings are siblings of their tables so
          minPresenceAhead keeps each heading with its first rows; tables
          split between rows (never clipped) and repeat their fixed header. */}
      {stockSections.map(({ category, items, financial, hasStock }, index) => <React.Fragment key={category}>
        <View wrap={false} minPresenceAhead={hasStock ? 100 : 0}>
          <View style={[S.stockHeader, { marginTop: 12 }]}>
            <Text style={S.title}>{`หมวด${category} - ${formatThaiDate(report.businessDate)}`}</Text>
            <Text style={S.subtitle}>รวมคงเหลือ = คงเหลือในบ้าน + ในตลาด</Text>
            {index === 0 ? <Text style={[S.note, { marginTop: 3 }]}>
              บ้านเจ๊ = คงเหลือในบ้าน/คลัง • ในตลาด = ของดีชั่งคืน • ไม่ทราบยอดฝั่งบ้านแสดง “-”
            </Text> : null}
          </View>
          {financial ? <FinancialKpis label={category} financial={financial} showTitle={false} /> : null}
        </View>
        {hasStock ? <StockMatrix items={items} category={category} /> : null}
      </React.Fragment>)}
      <DataFooter generatedText={generatedText} />
    </Page></> : <Page size="A4" style={S.page}>
      {noProduceEvidence ? <>
        {previewLabel ? <View style={S.emptyPreviewTag}><Text style={S.emptyPreviewText}>{previewLabel}</Text></View> : null}
        <View style={S.emptyHeader}>
          <Text style={S.emptyHeaderKicker}>MORNING BRIEF / สถานะข้อมูลประจำวัน</Text>
          <Text style={S.emptyHeaderTitle}>สรุปเช้า - {formatThaiDate(report.businessDate)}</Text>
          <Text style={S.emptyHeaderSubtitle}>สรุปสถานะจากข้อมูลที่บันทึกในระบบ ณ เวลาสร้างรายงาน</Text>
        </View>

        <View style={S.emptyHero}>
          <Text style={S.emptyHeroLabel}>สถานะรายงาน  •  รอข้อมูล</Text>
          <Text style={S.emptyHeroTitle}>ยังไม่มีข้อมูลสำหรับสรุปยอดขาย</Text>
          <Text style={S.emptyHeroDescription}>
            ไม่พบรายการเบิกหรือชั่งคืนที่บันทึกสำเร็จสำหรับวันที่นี้
            จึงยังไม่สามารถรายงานยอดขายได้ โดยไม่ตีความว่าขายได้ 0 บาท
          </Text>
        </View>

        <Text style={S.emptySectionTitle}>สถานะข้อมูลแต่ละส่วน</Text>
        <View style={S.emptyCardRow} wrap={false}>
          <EmptyEvidenceCard title="รายการเบิกสินค้า" status="missing"
            note="ยังไม่พบรายการเบิกที่บันทึกสำเร็จ" />
          <EmptyEvidenceCard title="รายการชั่งคืน" status="missing"
            note="ยังไม่พบรายการชั่งคืนที่บันทึกสำเร็จ" />
        </View>
        <View style={S.emptyCardRow} wrap={false}>
          <EmptyEvidenceCard title="ใบขาว"
            status={report.whiteSheetStatus === "entered" ? "available"
              : report.whiteSheetStatus === "unavailable" ? "unavailable" : "missing"}
            note={report.whiteSheetStatus === "entered" ? "พบการกรอกใบขาวแล้ว"
              : "ยังไม่มีใบขาวที่บันทึกยืนยันได้"} />
          <EmptyEvidenceCard title="สต็อกบ้าน"
            status={report.houseStock.status}
            note={report.houseStock.status === "available" ? "พบข้อมูลสต็อกบ้านแล้ว"
              : "ยังไม่พบข้อมูลสต็อกบ้านที่ยืนยันได้"} />
        </View>

        <View style={S.emptyNotice}>
          <Text style={S.emptyNoticeTitle}>การอ่านรายงานฉบับนี้</Text>
          <Text style={S.emptyNoticeText}>
            ยังสรุปยอดขายไม่ได้ (ไม่ใช่ยอดขาย 0 บาท) และยังไม่ทราบว่าทุกตลาดส่งข้อมูลครบหรือไม่
            ข้อมูลส่วนที่ยังไม่พบจะแสดงตามสถานะจริง ไม่ใช้ยอดเงินศูนย์แทน
          </Text>
        </View>
      </> : <Text>ยังไม่มีข้อมูลสินค้าในระบบ</Text>}
      <DataFooter generatedText={generatedText} />
    </Page>}
  </Document>;
}
