import React from "react";
import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { formatThaiDate } from "@/lib/date";
import type { MorningBriefReport } from "@/lib/summary/morning-brief";

function qty(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

const S = StyleSheet.create({
  page: {
    fontFamily: "SarabunPDF",
    fontSize: 10,
    paddingTop: 24,
    paddingBottom: 28,
    paddingHorizontal: 24,
    color: "#111827",
  },
  header: {
    borderBottomWidth: 1.4,
    borderBottomColor: "#111827",
    paddingBottom: 7,
    marginBottom: 8,
  },
  title: { fontSize: 18, fontWeight: "bold" },
  subtitle: { fontSize: 8.5, color: "#4B5563", marginTop: 2 },
  table: { borderLeftWidth: 0.7, borderTopWidth: 0.7, borderColor: "#9CA3AF" },
  tr: { flexDirection: "row" },
  cell: {
    borderRightWidth: 0.7,
    borderBottomWidth: 0.7,
    borderColor: "#9CA3AF",
    paddingVertical: 3.4,
    paddingHorizontal: 5,
  },
  th: { fontWeight: "bold", backgroundColor: "#E5E7EB" },
  matrixName: { backgroundColor: "#FFFFFF" },
  matrixTotal: { backgroundColor: "#DCEBD5" },
  matrixMarket: { backgroundColor: "#D9E7EC" },
  matrixHouse: { backgroundColor: "#FFF0C9" },
  matrixMarketText: { color: "#D92D20" },
  center: { textAlign: "center" },
  right: { textAlign: "right" },
  note: { fontSize: 8, color: "#4B5563", marginTop: 6 },
  footer: {
    position: "absolute",
    bottom: 10,
    left: 24,
    right: 24,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 7,
    color: "#6B7280",
  },
});

function MatrixCell({
  width,
  children,
  header = false,
  tone = "name",
  right = false,
  center = false,
}: {
  width: string;
  children?: React.ReactNode;
  header?: boolean;
  tone?: "name" | "total" | "market" | "house";
  right?: boolean;
  center?: boolean;
}) {
  const toneStyle = tone === "total"
    ? S.matrixTotal
    : tone === "market"
      ? S.matrixMarket
      : tone === "house"
        ? S.matrixHouse
        : S.matrixName;

  return <View style={[S.cell, toneStyle, header ? S.th : {}, { width }]}>
    <Text style={[
      right ? S.right : center ? S.center : {},
      tone === "market" && !header ? S.matrixMarketText : {},
    ]}>{children}</Text>
  </View>;
}

function stockMatrixItems(report: MorningBriefReport) {
  return (["strong", "surplus", "reduce", "unknown"] as const)
    .flatMap((status) => report.purchasePlanning[status].items ?? []);
}

function stockQuantity(value: number | null | undefined, blankZero = false): string {
  if (value == null) return "-";
  if (blankZero && value === 0) return "";
  return qty(value);
}

function displayUnit(unit: string): string {
  return unit === "โล" ? "กก." : unit;
}

function StockMatrix({ report }: { report: MorningBriefReport }) {
  const items = stockMatrixItems(report);
  const duplicateNames = new Map<string, number>();
  for (const item of items) {
    duplicateNames.set(item.productName, (duplicateNames.get(item.productName) ?? 0) + 1);
  }

  return <View style={S.table}>
    <View style={S.tr} fixed>
      <MatrixCell width="40%" header>รายการ</MatrixCell>
      <MatrixCell width="22%" header tone="total" center>รวมคงเหลือ</MatrixCell>
      <MatrixCell width="20%" header tone="market" center>ในตลาด</MatrixCell>
      <MatrixCell width="18%" header tone="house" center>บ้านเจ๊</MatrixCell>
    </View>

    {items.length === 0
      ? <View style={S.tr}><MatrixCell width="100%">ยังไม่มีข้อมูลสินค้า</MatrixCell></View>
      : items.map((item, index) => {
        const showUnit = (duplicateNames.get(item.productName) ?? 0) > 1;
        const name = showUnit ? `${item.productName} (${displayUnit(item.unit)})` : item.productName;
        return <View style={S.tr} key={`${item.productName}-${item.unit}-${index}`} wrap={false}>
          <MatrixCell width="40%">{name}</MatrixCell>
          <MatrixCell width="22%" tone="total" right>{stockQuantity(item.totalRemainingQuantity)}</MatrixCell>
          <MatrixCell width="20%" tone="market" right>{stockQuantity(item.marketStockQuantity, true)}</MatrixCell>
          <MatrixCell width="18%" tone="house" right>{stockQuantity(item.houseStockQuantity, true)}</MatrixCell>
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

export function MorningBriefA4Doc({ report, generatedAt }: { report: MorningBriefReport; generatedAt: Date }) {
  const generatedText = new Intl.DateTimeFormat("th-TH", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Bangkok",
  }).format(generatedAt);

  return <Document title={`Morning Stock ${report.businessDate}`}>
    <Page size="A4" style={S.page} wrap>
      <View style={S.header}>
        <Text style={S.title}>ตารางผลไม้คงเหลือสำหรับสั่งซื้อ - {formatThaiDate(report.businessDate)}</Text>
        <Text style={S.subtitle}>รวมคงเหลือ = ของดีชั่งคืนจากตลาด + ของที่บ้าน</Text>
      </View>

      <StockMatrix report={report} />

      <Text style={S.note}>ในตลาด = ของดีชั่งคืนจากตลาด • บ้านเจ๊ = ของที่ยังอยู่บ้าน/คลัง • ถ้าข้อมูลฝั่งบ้านยังไม่ทราบจะแสดง “-” และระบบจะไม่เดายอดรวม</Text>
      <DataFooter generatedText={generatedText} />
    </Page>
  </Document>;
}
