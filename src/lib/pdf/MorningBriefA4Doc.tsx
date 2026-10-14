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
  kpiGrid: { flexDirection: "row", marginHorizontal: -2, marginBottom: 5 },
  kpi: { width: "20%", paddingHorizontal: 2 },
  kpiBox: { borderWidth: 0.9, borderColor: "#C7C9CE", padding: 4, minHeight: 51, borderRadius: 3 },
  kpiSales: { backgroundColor: "#FFF0BF", borderColor: "#D7AC3D" },
  kpiWithdrawal: { backgroundColor: "#DFEDFA", borderColor: "#6EACD5" },
  kpiReturn: { backgroundColor: "#DDF2DC", borderColor: "#6CAD76" },
  kpiHouse: { backgroundColor: "#FFE7C4", borderColor: "#E8AD65" },
  kpiReady: { backgroundColor: "#E6E4F7", borderColor: "#9E98D4" },
  kpiUnknownValue: { fontSize: 9.5, fontWeight: "bold", color: "#92400E", textAlign: "right", marginTop: 3 },
  stockWarning: { backgroundColor: "#FFF8E8", borderLeftWidth: 2, borderLeftColor: "#D09A39", padding: 5, marginTop: 4 },
  kpiLabel: { fontSize: 7.8, color: "#6B7280" },
  kpiValue: { fontSize: 12.2, fontWeight: "bold", textAlign: "right", marginTop: 2 },
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
  const duplicateNames = new Map<string, number>();
  for (const item of items) {
    duplicateNames.set(item.productName, (duplicateNames.get(item.productName) ?? 0) + 1);
  }

  return <View style={S.table}>
    <View style={S.tr} fixed>
      {/* The fixed table header repeats when a category spans pages, preserving context. */}
      <MatrixCell width="40%" header center>{`รายการ (${category})`}</MatrixCell>
      <MatrixCell width="20%" header tone="house" center>บ้านเจ๊</MatrixCell>
      <MatrixCell width="20%" header tone="market" center>ในตลาด</MatrixCell>
      <MatrixCell width="20%" header tone="total" center>รวมคงเหลือ</MatrixCell>
    </View>
    {items.map((item, index) => {
      const showUnit = (duplicateNames.get(item.productName) ?? 0) > 1;
      const name = showUnit ? `${item.productName} (${displayUnit(item.unit)})` : item.productName;
      return <View style={S.tr} key={`${item.productName}-${item.unit}-${index}`} wrap={false}
        // Never strand the รวม rows alone at the top of a new page.
        minPresenceAhead={index === items.length - 1 ? 35 : 0}>
        <MatrixCell width="40%" center alternate={index % 2 === 1}>{name}</MatrixCell>
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

function DataFooter({ generatedText }: { generatedText: string }) {
  return <View style={S.footer} fixed>
    <Text>สร้างเมื่อ {generatedText}</Text>
    <Text render={({ pageNumber, totalPages }) => `หน้า ${pageNumber}/${totalPages}`} />
  </View>;
}

function FinancialSummaryPage({ financial, label, businessDate, stockStatus }: {
  financial: MorningBriefFruitFinancialSummary;
  label: string;
  businessDate: string;
  stockStatus: MorningBriefReport["houseStock"]["status"];
}) {
  const marketTotals = financial.markets;
  // Siblings, not one wrapper View: react-pdf only honours minPresenceAhead
  // between siblings, so the heading block can never be orphaned at a page
  // bottom while the (possibly long) market table still splits row by row.
  return (<>
    <View style={S.financialCategory} wrap={false} minPresenceAhead={70}>
      <Text style={S.financialCategoryTitle}>{`สรุป${label}คงเหลือเพื่อสั่งซื้อ - ${formatThaiDate(businessDate)}`}</Text>

      <View style={S.kpiGrid}>
        <View style={S.kpi}><View style={[S.kpiBox, S.kpiSales]}>
          <Text style={S.kpiLabel}>ยอดขายรวมเมื่อวาน ({label})</Text>
          <Text style={S.kpiValue}>{financial ? bahtFromSatang(financial.salesValueSatang) : "-"}</Text>
          <Text style={S.kpiUnit}>บาท</Text>
        </View></View>
        <View style={S.kpi}><View style={[S.kpiBox, S.kpiWithdrawal]}>
          <Text style={S.kpiLabel}>{label}ที่เบิกออกไปขายเมื่อวาน</Text>
          <Text style={S.kpiValue}>{financial ? bahtFromSatang(financial.withdrawalValueSatang) : "-"}</Text>
          <Text style={S.kpiUnit}>บาท</Text>
        </View></View>
        <View style={S.kpi}><View style={[S.kpiBox, S.kpiReturn]}>
          <Text style={S.kpiLabel}>ของชั่งคืนดีจากตลาด</Text>
          <Text style={S.kpiValue}>{financial ? bahtFromSatang(financial.goodReturnValueSatang) : "-"}</Text>
          <Text style={S.kpiUnit}>บาท</Text>
        </View></View>
        <View style={S.kpi}><View style={[S.kpiBox, S.kpiHouse]}>
          <Text style={S.kpiLabel}>Stock {label}ที่บ้าน</Text>
          <Text style={financial.houseStockValueSatang == null ? S.kpiUnknownValue : S.kpiValue}>{financial.houseStockValueSatang == null ? "รอข้อมูล" : bahtFromSatang(financial.houseStockValueSatang)}</Text>
          <Text style={S.kpiUnit}>{financial.houseStockValueSatang == null ? "ไม่ใช่ 0 บาท" : "บาท"}</Text>
        </View></View>
        <View style={S.kpi}><View style={[S.kpiBox, S.kpiReady]}>
          <Text style={S.kpiLabel}>คงเหลือพร้อมขาย</Text>
          <Text style={financial.readyValueSatang == null ? S.kpiUnknownValue : S.kpiValue}>{financial.readyValueSatang == null ? "รอยอดบ้าน" : bahtFromSatang(financial.readyValueSatang)}</Text>
          <Text style={S.kpiUnit}>ชั่งคืนดีจากตลาด + Stock บ้าน</Text>
        </View></View>
      </View>

      {(financial.houseStockValueSatang == null || financial.readyValueSatang == null) ?
        <View style={S.stockWarning}>
          <Text style={S.note}>
            {stockStatus === "unavailable" ? "ดึงข้อมูล Stock บ้านไม่สำเร็จ" : "ยังไม่มี Stock บ้านที่ปิดยืนยันสำหรับวันที่นี้"}
            {" • ชั่งคืนดีที่ทราบแล้ว " + bahtFromSatang(financial.goodReturnValueSatang) + " บาท"}
            {" • ยอดพร้อมขายยังสรุปไม่ได้จนกว่าจะมี Stock บ้านที่ยืนยัน"}
          </Text>
        </View> : null}

      <Text style={S.marketTitle}>สรุป{label}ตามตลาด</Text>
    </View>
    <View style={S.table}>
      <View style={S.tr} fixed>
        <MarketCell width="28%" tone="name" header>ตลาด</MarketCell>
        <MarketCell width="24%" tone="withdrawal" header>มูลค่าที่เบิกไปขาย</MarketCell>
        <MarketCell width="24%" tone="sales" header>ยอดขาย</MarketCell>
        <MarketCell width="24%" tone="return" header>ของชั่งคืนดี</MarketCell>
      </View>
      {marketTotals.map((market, index) => <View style={S.tr} key={`${market.marketLabel}-${index}`} wrap={false}
        // Never strand the รวม row alone at the top of a new page.
        minPresenceAhead={index === marketTotals.length - 1 ? 30 : 0}>
        <MarketCell width="28%" tone="name">{market.marketLabel}</MarketCell>
        <MarketCell width="24%" tone="withdrawal">{bahtFromSatang(market.withdrawalValueSatang)}</MarketCell>
        <MarketCell width="24%" tone="sales">{bahtFromSatang(market.salesValueSatang)}</MarketCell>
        <MarketCell width="24%" tone="return">{bahtFromSatang(market.goodReturnValueSatang)}</MarketCell>
      </View>)}
      <View style={S.tr} wrap={false}>
        <MarketCell width="28%" tone="name" total>รวม</MarketCell>
        <MarketCell width="24%" tone="withdrawal" total>{financial ? bahtFromSatang(financial.withdrawalValueSatang) : "-"}</MarketCell>
        <MarketCell width="24%" tone="sales" total>{financial ? bahtFromSatang(financial.salesValueSatang) : "-"}</MarketCell>
        <MarketCell width="24%" tone="return" total>{financial ? bahtFromSatang(financial.goodReturnValueSatang) : "-"}</MarketCell>
      </View>
    </View>
  </>);
}

export function MorningBriefA4Doc({ report, generatedAt }: { report: MorningBriefReport; generatedAt: Date }) {
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
  const stockItems = stockMatrixItems(report);
  // The day-wide sales report is the source of truth for the headline. Section
  // totals remain a breakdown, never a substitute for the whole-day result.
  const sectionSalesTotalSatang = financialSections.reduce(
    (sum, { financial }) => sum + financial.salesValueSatang, 0,
  );
  const hasDailyActivity = financialSections.length > 0
    || stockItems.some(hasRealStockQuantity)
    || report.sales.totalSalesSatang !== 0
    || report.sales.confirmedSalesSatang !== 0
    || report.sales.pendingReviewSalesSatang !== 0;
  const salesBreakdownDiffers = report.produceFinancial != null
    && financialSections.length > 0
    && sectionSalesTotalSatang !== report.sales.totalSalesSatang;
  const stockSections = STOCK_CATEGORIES.flatMap((category) => {
    const items = stockItems.filter((item) => stockCategory(item) === category);
    return items.some(hasRealStockQuantity) ? [{ category, items }] : [];
  });

  return <Document title={`Morning Brief ${report.businessDate}`}>
    {hasDailyActivity ? <Page size="A4" style={S.page} wrap>
      <View style={S.header}>
        <Text style={S.summaryTitle}>สรุปยอดเพื่อสั่งซื้อ - {formatThaiDate(report.businessDate)}</Text>
        <Text style={S.subtitle}>Bot-summary | ข้อมูลวันที่ {thaiNumericDate(report.businessDate)} | ภาพรวมยอดขายทุกหมวดและรายละเอียดตามตลาด</Text>
      </View>
      <View style={S.dailyOverview} wrap={false}>
        <Text style={S.dailyOverviewTitle}>
          {report.sales.excludedFromSalesCount > 0
            ? "ยอดขายรวมที่คำนวณได้ (บางส่วน)"
            : "ยอดขายรวมทั้งวัน"} — {thaiNumericDate(report.businessDate)}
        </Text>
        <Text style={S.dailyOverviewTotal}>{bahtFromSatang(report.sales.totalSalesSatang)} บาท</Text>
        <Text style={S.dailyOverviewDetails}>
          ยืนยันแล้ว {bahtFromSatang(report.sales.confirmedSalesSatang)} บาท
          {"  •  "}รอตรวจ {bahtFromSatang(report.sales.pendingReviewSalesSatang)} บาท
        </Text>
        {report.sales.adjustmentSatang !== 0
          ? <Text style={S.dailyOverviewDetails}>ปรับราคา {bahtFromSatang(report.sales.adjustmentSatang)} บาท</Text>
          : null}
        {financialSections.length > 0 ? <Text style={S.dailyOverviewDetails}>
          {financialSections.map(({ section, financial }) =>
            `${PRODUCE_SECTION_LABEL[section]} ${bahtFromSatang(financial.salesValueSatang)} บาท`).join("  •  ")}
        </Text> : null}
        {salesBreakdownDiffers ? <Text style={S.dailyOverviewWarning}>
          ยอดแยกหมวดรวม {bahtFromSatang(sectionSalesTotalSatang)} บาท ต่างจากยอดขายรวมในระบบ
          {"  "}— โปรดตรวจสอบความครบถ้วนของข้อมูล ห้ามถือว่าเป็นยอดยืนยันเพิ่ม
        </Text> : null}
        {!report.sales.valueAuthoritative || report.sales.excludedFromSalesCount > 0
          ? <Text style={S.dailyOverviewWarning}>ยอดขายมีรายการที่ยังไม่ครบหรือรอตรวจ กรุณาดูยอดยืนยันแล้วแยกต่างหาก</Text>
          : null}
      </View>
      <View style={S.explanation}>
        <Text style={S.explanationTitle}>คำอธิบายตัวเลข</Text>
        <Text style={S.explanationText}><Text style={{ fontWeight: "bold" }}>เบิกออกไปขาย</Text> คือมูลค่าสินค้าที่นำออกตลาดก่อนเริ่มขาย ส่วน <Text style={{ fontWeight: "bold" }}>คงเหลือพร้อมขาย</Text> คือของดีที่ชั่งคืนจากตลาดหลังขาย บวกกับของที่ยังอยู่บ้าน จึงอาจมีบางรายการที่คงเหลือน้อยกว่ายอดที่เบิกไปขาย</Text>
      </View>
      {financialSections.map(({ section, financial }) => {
        const summary = <FinancialSummaryPage
          financial={financial} label={PRODUCE_SECTION_LABEL[section]}
          businessDate={report.businessDate} stockStatus={report.houseStock.status}
        />;
        // Small sections must stay intact, including their market total row.
        // Large market tables remain splittable between rows.
        return financial.markets.length <= 6
          ? <View key={section} wrap={false} minPresenceAhead={70}>{summary}</View>
          : <React.Fragment key={section}>{summary}</React.Fragment>;
      })}
      <Text style={S.note}>หมายเหตุ: ยอดขายรวมอ้างอิงรายงานยอดขายทุกตลาด ส่วนยอดแยกหมวดแสดงเฉพาะหมวดที่มีข้อมูล วันที่ {thaiNumericDate(report.businessDate)}</Text>
      {/* Stock flows straight after the summary instead of forcing a new
          physical page. Headings are siblings of their tables so
          minPresenceAhead keeps each heading with its first rows; tables
          split between rows (never clipped) and repeat their fixed header. */}
      {stockSections.map(({ category, items }, index) => <React.Fragment key={category}>
        <View style={[S.stockHeader, { marginTop: 12 }]} wrap={false} minPresenceAhead={120}>
          <Text style={S.title}>{`หมวด${category} - ${formatThaiDate(report.businessDate)}`}</Text>
          <Text style={S.subtitle}>รวมคงเหลือ = คงเหลือในบ้าน + ในตลาด</Text>
          {index === 0 ? <Text style={[S.note, { marginTop: 3 }]}>
            บ้านเจ๊ = คงเหลือในบ้าน/คลัง • ในตลาด = ของดีชั่งคืน • ไม่ทราบยอดฝั่งบ้านแสดง “-”
          </Text> : null}
        </View>
        <StockMatrix items={items} category={category} />
      </React.Fragment>)}
      <DataFooter generatedText={generatedText} />
    </Page> : <Page size="A4" style={S.page}>
      <Text style={S.title}>สรุปเช้า - {formatThaiDate(report.businessDate)}</Text>
      <Text>ยังไม่มีข้อมูลสินค้าในระบบ</Text>
      <DataFooter generatedText={generatedText} />
    </Page>}
  </Document>;
}
