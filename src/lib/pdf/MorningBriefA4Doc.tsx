import React from "react";
import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { formatThaiDate } from "@/lib/date";
import type { MorningBriefReport } from "@/lib/summary/morning-brief";

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
    fontSize: 9.8,
    paddingTop: 22,
    paddingBottom: 28,
    paddingHorizontal: 24,
    color: "#111827",
  },
  header: { marginBottom: 8 },
  title: { fontSize: 20, fontWeight: "bold" },
  subtitle: { fontSize: 9, color: "#6B7280", marginTop: 2 },
  kpiGrid: { flexDirection: "row", marginHorizontal: -2.5, marginBottom: 9 },
  kpi: { width: "20%", paddingHorizontal: 2.5 },
  kpiBox: { borderWidth: 0.6, borderColor: "#C7C9CE", padding: 7, minHeight: 58 },
  kpiLabel: { fontSize: 7.8, color: "#6B7280" },
  kpiValue: { fontSize: 16.8, fontWeight: "bold", textAlign: "right", marginTop: 4 },
  kpiUnit: { fontSize: 7.6, color: "#6B7280", textAlign: "right", marginTop: 1 },
  explanation: {
    borderLeftWidth: 2.5,
    borderLeftColor: "#777B80",
    backgroundColor: "#F8F8F7",
    paddingVertical: 7,
    paddingHorizontal: 8,
    marginBottom: 9,
  },
  explanationTitle: { fontWeight: "bold", fontSize: 10.2, marginBottom: 2 },
  explanationText: { fontSize: 8.8, lineHeight: 1.35 },
  sectionTitle: {
    fontSize: 11.8,
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
    paddingVertical: 3.4,
    paddingHorizontal: 5,
  },
  th: { fontWeight: "bold", fontSize: 10.2, backgroundColor: "#E8E8E8" },
  totalRow: { backgroundColor: "#E8E8E8", fontWeight: "bold" },
  matrixName: { backgroundColor: "#FFFFFF" },
  matrixAlternate: { backgroundColor: "#F4F7F4" },
  matrixTotal: { backgroundColor: "#DCEBD5" },
  matrixMarket: { backgroundColor: "#D9E7EC" },
  matrixHouse: { backgroundColor: "#FFF0C9" },
  matrixMarketText: { color: "#D92D20" },
  center: { textAlign: "center" },
  right: { textAlign: "right" },
  noteBox: { borderWidth: 0.7, borderColor: "#8E9298", padding: 5, marginTop: 5 },
  note: { fontSize: 8.2, color: "#4B5563" },
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
    fontSize: 7.6,
    color: "#6B7280",
  },
});

function Cell({
  width,
  children,
  header = false,
  right = false,
  total = false,
}: {
  width: string;
  children?: React.ReactNode;
  header?: boolean;
  right?: boolean;
  total?: boolean;
}) {
  return <View style={[S.cell, header ? S.th : {}, total ? S.totalRow : {}, { width }]}>
    <Text style={right ? S.right : {}}>{children}</Text>
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

  return <View style={[S.cell, toneStyle, alternate && tone === "name" ? S.matrixAlternate : {}, header ? S.th : {}, { width }]}>
    <Text style={[
      right ? S.right : center ? S.center : {},
      tone === "market" && !header ? S.matrixMarketText : {},
    ]}>{children}</Text>
  </View>;
}

const STOCK_CATEGORIES = ["ผลไม้", "ทุเรียน", "ผัก", "ของแห้ง", "ยังไม่ได้จัดหมวดหมู่"] as const;
type StockPageCategory = typeof STOCK_CATEGORIES[number];

type StockMatrixItem = {
  productName: string;
  category: string;
  unit: string;
  houseStockQuantity: number | null;
  marketStockQuantity: number;
  totalRemainingQuantity: number | null;
};

function stockCategory(category: string): StockPageCategory {
  if (category === "ผลไม้") return "ผลไม้";
  if (category === "ทุเรียน") return "ทุเรียน";
  if (["ผัก / สมุนไพร / เครื่องประกอบอาหาร", "ผัก", "เห็ด"].includes(category)) return "ผัก";
  if (["ปลา / อาหารแห้ง / ของแห้ง", "ปลา", "อาหารแห้ง", "ของแห้ง"].includes(category)) return "ของแห้ง";
  return "ยังไม่ได้จัดหมวดหมู่";
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
    for (const item of report.houseStock.items ?? []) {
      const key = stockMatrixKey(item.productName, item.unit);
      const existing = byKey.get(key);
      if (existing) {
        if (existing.houseStockQuantity == null) {
          existing.houseStockQuantity = item.quantity;
          existing.totalRemainingQuantity = item.quantity + existing.marketStockQuantity;
        }
        continue;
      }
      byKey.set(key, {
        productName: item.productName,
        category: item.category,
        unit: item.unit,
        houseStockQuantity: item.quantity,
        marketStockQuantity: 0,
        totalRemainingQuantity: item.quantity,
      });
    }
  }

  return [...byKey.values()];
}
function stockQuantity(value: number | null | undefined, blankZero = false): string {
  if (value == null) return "-";
  if (blankZero && value === 0) return "";
  return qty(value);
}

function displayUnit(unit: string): string {
  return unit === "โล" ? "กก." : unit;
}

function StockMatrix({ items }: { items: ReturnType<typeof stockMatrixItems> }) {
  const duplicateNames = new Map<string, number>();
  for (const item of items) {
    duplicateNames.set(item.productName, (duplicateNames.get(item.productName) ?? 0) + 1);
  }

  return <View style={S.table}>
    <View style={S.tr} fixed>
      <MatrixCell width="40%" header>รายการ</MatrixCell>
      <MatrixCell width="20%" header tone="house" center>คงเหลือในบ้าน</MatrixCell>
      <MatrixCell width="20%" header tone="market" center>ในตลาด</MatrixCell>
      <MatrixCell width="20%" header tone="total" center>รวมคงเหลือ</MatrixCell>
    </View>
    {items.length === 0
      ? <View style={S.tr}><MatrixCell width="100%">ยังไม่มีข้อมูลสินค้า</MatrixCell></View>
      : items.map((item, index) => {
        const showUnit = (duplicateNames.get(item.productName) ?? 0) > 1;
        const name = showUnit ? `${item.productName} (${displayUnit(item.unit)})` : item.productName;
        return <View style={S.tr} key={`${item.productName}-${item.unit}-${index}`} wrap={false}>
          <MatrixCell width="40%" alternate={index % 2 === 1}>{name}</MatrixCell>
          <MatrixCell width="20%" tone="house" right>{stockQuantity(item.houseStockQuantity, true)}</MatrixCell>
          <MatrixCell width="20%" tone="market" right>{stockQuantity(item.marketStockQuantity, true)}</MatrixCell>
          <MatrixCell width="20%" tone="total" right>{stockQuantity(item.totalRemainingQuantity)}</MatrixCell>
        </View>;
      })}
    {Array.from(new Set(items.map((item) => item.unit))).map((unit) => {
      const unitItems = items.filter((item) => item.unit === unit);
      const houseKnown = unitItems.every((item) => item.houseStockQuantity != null);
      const sum = (key: "houseStockQuantity" | "marketStockQuantity" | "totalRemainingQuantity") =>
        unitItems.every((item) => item[key] != null)
          ? qty(unitItems.reduce((total, item) => total + item[key]!, 0))
          : "-";
      return <View style={S.tr} key={`total-${unit}`} wrap={false}>
        <MatrixCell width="40%" tone="total">{`\u{e23}\u{e27}\u{e21} (${displayUnit(unit)})`}</MatrixCell>
        <MatrixCell width="20%" tone="total" right>{houseKnown ? sum("houseStockQuantity") : "-"}</MatrixCell>
        <MatrixCell width="20%" tone="total" right>{sum("marketStockQuantity")}</MatrixCell>
        <MatrixCell width="20%" tone="total" right>{houseKnown ? sum("totalRemainingQuantity") : "-"}</MatrixCell>
      </View>;
    })}
  </View>;
}

function categoryChunks(items: ReturnType<typeof stockMatrixItems>) {
  const chunks: typeof items[] = [];
  let chunk: typeof items = [];
  for (const item of items) {
    const candidate = [...chunk, item];
    if (chunk.length > 0 && candidate.length + new Set(candidate.map((row) => row.unit)).size + 1 > 30) {
      chunks.push(chunk);
      chunk = [item];
    } else {
      chunk = candidate;
    }
  }
  if (chunk.length) chunks.push(chunk);
  return chunks.length ? chunks : [[]];
}

function DataFooter({ generatedText }: { generatedText: string }) {
  return <View style={S.footer} fixed>
    <Text>สร้างเมื่อ {generatedText}</Text>
    <Text render={({ pageNumber, totalPages }) => `หน้า ${pageNumber}/${totalPages}`} />
  </View>;
}

export function MorningBriefA4Doc({ report, generatedAt }: { report: MorningBriefReport; generatedAt: Date }) {
  const generatedText = new Intl.DateTimeFormat("th-TH", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Bangkok",
  }).format(generatedAt);
  const fruit = report.fruitFinancial;
  const marketTotals = fruit?.markets ?? [];
  const dateText = thaiNumericDate(report.businessDate);

  return <Document title={`Morning Fruit Brief ${report.businessDate}`}>
    <Page size="A4" style={S.page} wrap>
      <View style={S.header}>
        <Text style={S.title}>สรุปผลไม้คงเหลือเพื่อสั่งซื้อ - {formatThaiDate(report.businessDate)}</Text>
        <Text style={S.subtitle}>Bot-summary | ข้อมูลวันที่ {dateText} | รายงานนี้แสดงเฉพาะผลไม้และรายการผลไม้ที่มีข้อมูลในระบบ ไม่รวมผัก</Text>
      </View>

      <View style={S.kpiGrid}>
        <View style={S.kpi}><View style={S.kpiBox}>
          <Text style={S.kpiLabel}>ยอดขายรวมเมื่อวาน</Text>
          <Text style={S.kpiValue}>{fruit ? bahtFromSatang(fruit.salesValueSatang) : "-"}</Text>
          <Text style={S.kpiUnit}>บาท</Text>
        </View></View>
        <View style={S.kpi}><View style={S.kpiBox}>
          <Text style={S.kpiLabel}>ผลไม้ที่เบิกออกไปขายเมื่อวาน</Text>
          <Text style={S.kpiValue}>{fruit ? bahtFromSatang(fruit.withdrawalValueSatang) : "-"}</Text>
          <Text style={S.kpiUnit}>บาท</Text>
        </View></View>
        <View style={S.kpi}><View style={S.kpiBox}>
          <Text style={S.kpiLabel}>ของชั่งคืนดีจากตลาด</Text>
          <Text style={S.kpiValue}>{fruit ? bahtFromSatang(fruit.goodReturnValueSatang) : "-"}</Text>
          <Text style={S.kpiUnit}>บาท</Text>
        </View></View>
        <View style={S.kpi}><View style={S.kpiBox}>
          <Text style={S.kpiLabel}>Stock ผลไม้ที่บ้าน</Text>
          <Text style={S.kpiValue}>{fruit?.houseStockValueSatang == null ? "-" : bahtFromSatang(fruit.houseStockValueSatang)}</Text>
          <Text style={S.kpiUnit}>บาท</Text>
        </View></View>
        <View style={S.kpi}><View style={S.kpiBox}>
          <Text style={S.kpiLabel}>คงเหลือพร้อมขาย</Text>
          <Text style={S.kpiValue}>{fruit?.readyValueSatang == null ? "-" : bahtFromSatang(fruit.readyValueSatang)}</Text>
          <Text style={S.kpiUnit}>ชั่งคืนดีจากตลาด + Stock บ้าน</Text>
        </View></View>
      </View>

      <View style={S.explanation}>
        <Text style={S.explanationTitle}>คำอธิบายตัวเลข</Text>
        <Text style={S.explanationText}><Text style={{ fontWeight: "bold" }}>เบิกออกไปขาย</Text> คือมูลค่าสินค้าที่นำออกตลาดก่อนเริ่มขาย ส่วน <Text style={{ fontWeight: "bold" }}>คงเหลือพร้อมขาย</Text> คือของดีที่ชั่งคืนจากตลาดหลังขาย บวกกับของที่ยังอยู่บ้าน จึงอาจมีบางรายการที่คงเหลือน้อยกว่ายอดที่เบิกไปขาย</Text>
      </View>

      <Text style={S.sectionTitle}>สรุปผลไม้ตามตลาด</Text>
      <View style={S.table}>
        <View style={S.tr} fixed>
          <Cell width="28%" header>ตลาด</Cell>
          <Cell width="24%" header right>มูลค่าที่เบิกไปขาย</Cell>
          <Cell width="24%" header right>ยอดขาย</Cell>
          <Cell width="24%" header right>ของชั่งคืนดี</Cell>
        </View>
        {marketTotals.map((market, index) => <View style={S.tr} key={`${market.marketLabel}-${index}`} wrap={false}>
          <Cell width="28%">{market.marketLabel}</Cell>
          <Cell width="24%" right>{bahtFromSatang(market.withdrawalValueSatang)}</Cell>
          <Cell width="24%" right>{bahtFromSatang(market.salesValueSatang)}</Cell>
          <Cell width="24%" right>{bahtFromSatang(market.goodReturnValueSatang)}</Cell>
        </View>)}
        <View style={S.tr} wrap={false}>
          <Cell width="28%" total>รวม</Cell>
          <Cell width="24%" total right>{fruit ? bahtFromSatang(fruit.withdrawalValueSatang) : "-"}</Cell>
          <Cell width="24%" total right>{fruit ? bahtFromSatang(fruit.salesValueSatang) : "-"}</Cell>
          <Cell width="24%" total right>{fruit ? bahtFromSatang(fruit.goodReturnValueSatang) : "-"}</Cell>
        </View>
      </View>
      <View style={S.noteBox}>
        <Text style={S.note}><Text style={{ fontWeight: "bold" }}>หมายเหตุ:</Text> รายงานฉบับนี้แสดงเฉพาะผลไม้ ไม่รวมผัก และใช้ข้อมูลจริงจากระบบของวันที่ {dateText}</Text>
      </View>
      <DataFooter generatedText={generatedText} />
    </Page>

    {STOCK_CATEGORIES.flatMap((category) => {
      const categoryItems = stockMatrixItems(report).filter((item) => stockCategory(item.category) === category);
      const chunks = categoryChunks(categoryItems);
      return chunks.map((items, index) => <Page key={`${category}-${index}`} size="A4" style={S.page} wrap>
        <View style={S.stockHeader}>
          <Text style={S.title}>{`หมวด${category}${chunks.length > 1 ? ` ${index + 1}/${chunks.length}` : ""} - ${formatThaiDate(report.businessDate)}`}</Text>
          <Text style={S.subtitle}>รวมคงเหลือ = คงเหลือในบ้าน + ในตลาด</Text>
        </View>
        <StockMatrix items={items} />
        <Text style={[S.note, { marginTop: 6 }]}>คงเหลือในบ้าน = ของที่ยังอยู่บ้าน/คลัง • ในตลาด = ของดีชั่งคืนจากตลาด • ถ้าไม่ทราบข้อมูลฝั่งบ้านจะแสดง “-”</Text>
        <DataFooter generatedText={generatedText} />
      </Page>);
    })}
  </Document>;
}
