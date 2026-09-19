import React from "react";
import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { formatThaiDate } from "@/lib/date";
import type {
  MorningBriefPurchaseGroup,
  MorningBriefReport,
} from "@/lib/summary/morning-brief";

function baht(satang: number): string {
  return (satang / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function purchaseNames(group: MorningBriefPurchaseGroup): string {
  const names = group.items?.map((item) => item.productName) ?? group.productNames;
  return names.length > 0 ? names.join(", ") : "—";
}

const S = StyleSheet.create({
  page: {
    fontFamily: "SarabunPDF",
    fontSize: 11,
    paddingTop: 32,
    paddingBottom: 38,
    paddingHorizontal: 34,
    color: "#111827",
  },
  title: { fontSize: 18, fontWeight: "bold", marginBottom: 2 },
  subtitle: { fontSize: 10, color: "#4B5563", marginBottom: 14 },
  section: { marginBottom: 12 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "bold",
    borderBottomWidth: 0.8,
    borderBottomColor: "#9CA3AF",
    paddingBottom: 3,
    marginBottom: 6,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginBottom: 5,
  },
  status: { width: 118, fontWeight: "bold" },
  detail: { flex: 1, lineHeight: 1.35 },
  headlineBox: {
    borderWidth: 0.8,
    borderColor: "#D1D5DB",
    borderRadius: 4,
    padding: 8,
    marginBottom: 6,
  },
  headline: { fontSize: 15, fontWeight: "bold" },
  muted: { color: "#6B7280", fontSize: 9 },
  reviewRow: {
    borderBottomWidth: 0.4,
    borderBottomColor: "#E5E7EB",
    paddingVertical: 3,
  },
  footer: {
    position: "absolute",
    bottom: 16,
    left: 34,
    right: 34,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 8,
    color: "#6B7280",
  },
});

function PurchaseRow({
  label,
  group,
}: {
  label: string;
  group: MorningBriefPurchaseGroup;
}) {
  return (
    <View style={S.row} wrap={false}>
      <Text style={S.status}>{label} — {group.count} รายการ</Text>
      <Text style={S.detail}>{purchaseNames(group)}</Text>
    </View>
  );
}
export function MorningBriefA4Doc({
  report,
  generatedAt,
}: {
  report: MorningBriefReport;
  generatedAt: Date;
}) {
  const house = report.houseStock;
  const sales = report.sales;
  const generatedText = new Intl.DateTimeFormat("th-TH", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Bangkok",
  }).format(generatedAt);

  return (
    <Document title={`Morning Brief ${report.businessDate}`}>
      <Page size="A4" style={S.page} wrap>
        <Text style={S.title}>สรุปเช้า — {formatThaiDate(report.businessDate)}</Text>
        <Text style={S.subtitle}>เอกสารสำหรับพิมพ์ A4 • ข้อมูลชุดเดียวกับ Morning Brief ใน LINE</Text>

        <View style={S.section}>
          <Text style={S.sectionTitle}>แผนซื้อของ</Text>
          <PurchaseRow label="ควรซื้อเพิ่ม" group={report.purchasePlanning.strong} />
          <PurchaseRow label="ยังไม่ควรซื้อเพิ่ม" group={report.purchasePlanning.surplus} />
          <PurchaseRow label="ควรลดการซื้อ" group={report.purchasePlanning.reduce} />
          <PurchaseRow label="ยังประเมินไม่ได้" group={report.purchasePlanning.unknown} />
        </View>
        <View style={S.section}>
          <Text style={S.sectionTitle}>ยอดขาย</Text>
          <View style={S.headlineBox} wrap={false}>
            <Text style={S.headline}>ยอดขายยืนยันได้ {baht(sales.confirmedSalesSatang)} บาท</Text>
            <Text style={S.muted}>
              ยืนยันได้ {sales.trustedCount} รายการ • รอตรวจ {sales.unresolvedCount} รายการ
              {sales.soldOutCount > 0 ? ` • ขายหมด ${sales.soldOutCount} รายการ` : ""}
            </Text>
          </View>
          {(sales.reviewItems ?? []).map((item, index) => (
            <View key={`${item.marketLabel}-${item.productName}-${index}`} style={S.reviewRow} wrap={false}>
              <Text>{item.marketLabel} • {item.productName} ({item.unit})</Text>
              <Text style={S.muted}>{item.reasons.join(", ") || item.status}</Text>
            </View>
          ))}
        </View>

        <View style={S.section}>
          <Text style={S.sectionTitle}>ของในบ้าน</Text>
          {house.status === "available" ? (
            <View style={S.headlineBox} wrap={false}>
              <Text style={S.headline}>{house.groupCount} รายการ • มูลค่า {baht(house.totalValueSatang)} บาท</Text>
            </View>
          ) : (
            <Text>{house.status === "missing" ? "ยังไม่มีข้อมูลของในบ้านสำหรับวันนี้" : "ข้อมูลของในบ้านไม่พร้อมใช้งาน"}</Text>
          )}
        </View>
        <View style={S.footer} fixed>
          <Text>สร้างเมื่อ {generatedText}</Text>
          <Text render={({ pageNumber, totalPages }) => `หน้า ${pageNumber}/${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
