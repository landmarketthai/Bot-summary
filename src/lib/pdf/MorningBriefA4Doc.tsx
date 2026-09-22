import React from "react";
import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { formatThaiDate } from "@/lib/date";
import type {
  MorningBriefPurchaseGroup,
  MorningBriefPurchaseItem,
  MorningBriefReport,
} from "@/lib/summary/morning-brief";

function bahtFromSatang(satang: number): string {
  return (satang / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function qty(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

function allPurchaseItems(report: MorningBriefReport): MorningBriefPurchaseItem[] {
  return [
    ...(report.purchasePlanning.strong.items ?? []),
    ...(report.purchasePlanning.surplus.items ?? []),
    ...(report.purchasePlanning.reduce.items ?? []),
    ...(report.purchasePlanning.unknown.items ?? []),
  ];
}
function productDisplayName(
  item: MorningBriefPurchaseItem,
  duplicateCounts: ReadonlyMap<string, number>,
): string {
  const base = item.productName;
  const disambiguated = (duplicateCounts.get(base) ?? 0) > 1
    ? `${base} (${item.unit})`
    : base;
  return item.uncertaintyReasons.length > 0 || item.identityUnverified ? `${disambiguated}*` : disambiguated;
}

function amountWithUnit(value: number | null | undefined, unit: string): string {
  return value == null ? "ข้อมูลไม่ครบ" : `${qty(value)} ${unit}`;
}

function purchaseNames(group: MorningBriefPurchaseGroup): string {
  const items = group.items ?? [];
  if (items.length === 0) return group.productNames.join(", ") || "-";
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.productName, (counts.get(item.productName) ?? 0) + 1);
  return items.map((item) => productDisplayName(item, counts).replace(/\*$/, "")).join(", ");
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}
const S = StyleSheet.create({
  page: { fontFamily: "SarabunPDF", fontSize: 11, paddingTop: 24, paddingBottom: 28, paddingHorizontal: 28, color: "#111827" },
  header: { borderBottomWidth: 1.3, borderBottomColor: "#111827", paddingBottom: 7, marginBottom: 9 },
  title: { fontSize: 19, fontWeight: "bold" },
  subtitle: { fontSize: 10, color: "#4B5563", marginTop: 3 },
  kpiGrid: { flexDirection: "row", marginHorizontal: -3, marginBottom: 9 },
  kpi: { width: "33.333%", padding: 3 },
  kpiBox: { borderWidth: 0.7, borderColor: "#BFC3C8", padding: 8, minHeight: 58 },
  kpiLabel: { fontSize: 9.5, color: "#6B7280" },
  kpiValue: { fontSize: 16, fontWeight: "bold", marginTop: 3, textAlign: "right" },
  kpiMeta: { fontSize: 9, color: "#6B7280", marginTop: 2, textAlign: "right" },
  explain: { borderLeftWidth: 3.5, borderLeftColor: "#6B7280", backgroundColor: "#F8F8F8", padding: 8, marginBottom: 9 },
  explainTitle: { fontSize: 11.5, fontWeight: "bold", marginBottom: 2 },
  sectionTitle: { fontSize: 13.5, fontWeight: "bold", borderBottomWidth: 0.7, borderBottomColor: "#6B7280", paddingBottom: 3, marginBottom: 5 },
  table: { borderLeftWidth: 0.5, borderTopWidth: 0.5, borderColor: "#B6BAC0" },
  tr: { flexDirection: "row" },
  th: { backgroundColor: "#ECEDEF", fontWeight: "bold" },
  cell: { borderRightWidth: 0.5, borderBottomWidth: 0.5, borderColor: "#B6BAC0", paddingVertical: 5, paddingHorizontal: 5 },
  right: { textAlign: "right" },
  total: { backgroundColor: "#F5F5F5", fontWeight: "bold" },
  note: { fontSize: 9.5, color: "#5B6470", marginTop: 6, lineHeight: 1.45 },
  footer: { position: "absolute", bottom: 10, left: 28, right: 28, flexDirection: "row", justifyContent: "space-between", fontSize: 8, color: "#6B7280" },
  product: { fontSize: 11.6, fontWeight: "bold" },
});
function Cell({ width, children, header = false, right = false, total = false }: {
  width: string;
  children?: React.ReactNode;
  header?: boolean;
  right?: boolean;
  total?: boolean;
}) {
  return <View style={[S.cell, { width }, header ? S.th : {}, total ? S.total : {}]}>
    <Text style={right ? S.right : {}}>{children}</Text>
  </View>;
}

function PurchaseRow({ label, group }: { label: string; group: MorningBriefPurchaseGroup }) {
  return <View style={S.tr} wrap={false}>
    <Cell width="24%"><Text style={{ fontWeight: "bold" }}>{label} — {group.count} รายการ</Text></Cell>
    <Cell width="76%">{purchaseNames(group)}</Cell>
  </View>;
}

function Footer({ generatedText }: { generatedText: string }) {
  return <View style={S.footer} fixed>
    <Text>สร้างเมื่อ {generatedText}</Text>
    <Text render={({ pageNumber, totalPages }) => `หน้า ${pageNumber}/${totalPages}`} />
  </View>;
}
export function MorningBriefA4Doc({ report, generatedAt }: { report: MorningBriefReport; generatedAt: Date }) {
  const house = report.houseStock;
  const items = allPurchaseItems(report).sort((a, b) =>
    a.productName.localeCompare(b.productName, "th") || a.unit.localeCompare(b.unit, "th"),
  );
  const duplicateCounts = new Map<string, number>();
  for (const item of items) duplicateCounts.set(item.productName, (duplicateCounts.get(item.productName) ?? 0) + 1);
  const pages = chunk(items, 13);
  const generatedText = new Intl.DateTimeFormat("th-TH", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Bangkok",
  }).format(generatedAt);

  return <Document title={`Morning Brief ${report.businessDate}`}>
    <Page size="A4" orientation="landscape" style={S.page} wrap>
      <View style={S.header}>
        <Text style={S.title}>สรุปผลไม้คงเหลือเพื่อสั่งซื้อ - {formatThaiDate(report.businessDate)}</Text>
        <Text style={S.subtitle}>สำหรับวางแผนสั่งซื้อวันถัดไป • เฉพาะผลไม้ • ตัวอักษรขนาดใหญ่</Text>
      </View>

      <View style={S.kpiGrid}>
        <View style={S.kpi}><View style={S.kpiBox}>
          <Text style={S.kpiLabel}>ยอดขายเมื่อวาน</Text>
          <Text style={S.kpiValue}>{bahtFromSatang(report.sales.totalSalesSatang)} บาท</Text>
        </View></View>
        <View style={S.kpi}><View style={S.kpiBox}>
          <Text style={S.kpiLabel}>Stock ผลไม้ที่บ้าน</Text>
          <Text style={S.kpiValue}>{house.status === "available" ? `${bahtFromSatang(house.totalValueSatang)} บาท` : "ยังไม่มีข้อมูล"}</Text>
        </View></View>
        <View style={S.kpi}><View style={S.kpiBox}>
          <Text style={S.kpiLabel}>ควรซื้อเพิ่ม</Text>
          <Text style={S.kpiValue}>{report.purchasePlanning.strong.count} รายการ</Text>
          <Text style={S.kpiMeta}>ใช้ชั่งคืนดี + Stock บ้าน</Text>
        </View></View>
      </View>

      <View style={S.explain}>
        <Text style={S.explainTitle}>คงเหลือพร้อมขาย = ของชั่งคืนดีจากตลาด + Stock บ้าน</Text>
        <Text>ยอดเบิกไปขายคือของก่อนเริ่มขาย ส่วนคงเหลือพร้อมขายคือของดีที่กลับจากตลาดหลังขายจบ แล้วบวกของที่ยังอยู่บ้าน ไม่รวมคืนเสีย</Text>
      </View>

      <Text style={S.sectionTitle}>แผนซื้อผลไม้</Text>
      <View style={S.table}>
        <PurchaseRow label="ควรซื้อเพิ่ม" group={report.purchasePlanning.strong} />
        <PurchaseRow label="ยังไม่ควรซื้อเพิ่ม" group={report.purchasePlanning.surplus} />
        <PurchaseRow label="ควรลดการซื้อ" group={report.purchasePlanning.reduce} />
      </View>
      <Text style={S.note}>หมายเหตุ: รายงานนี้เน้นการสั่งซื้อผลไม้ และยังไม่รวมผักจนกว่าจะมีรายการเบิก/คืนรายสินค้าในระบบ</Text>
      <Footer generatedText={generatedText} />
    </Page>
    {pages.map((pageItems, pageIndex) => <Page key={`items-${pageIndex}`} size="A4" orientation="landscape" style={S.page} wrap>
      <View style={S.header}>
        <Text style={S.title}>ตารางผลไม้สำหรับสั่งซื้อ - {formatThaiDate(report.businessDate)}</Text>
        <Text style={S.subtitle}>คงเหลือพร้อมขาย (ชั่งคืนดี + บ้าน) • ส่วนที่ {pageIndex + 1}/{pages.length}</Text>
      </View>
      <View style={S.table}>
        <View style={S.tr} fixed>
          <Cell width="40%" header>Product</Cell>
          <Cell width="24%" header right>คงเหลือพร้อมขาย (ชั่งคืนดี + บ้าน)</Cell>
          <Cell width="20%" header right>เบิกไปขายเมื่อวาน</Cell>
          <Cell width="16%" header right>Stock บ้าน</Cell>
        </View>
        {pageItems.map((item, index) => <View style={S.tr} key={`${item.productName}-${item.unit}-${index}`} wrap={false}>
          <Cell width="40%"><Text style={S.product}>{productDisplayName(item, duplicateCounts)}</Text></Cell>
          <Cell width="24%" right>{amountWithUnit(item.nextDayGoodStockQuantity, item.unit)}</Cell>
          <Cell width="20%" right>{amountWithUnit(item.withdrawnQuantity, item.unit)}</Cell>
          <Cell width="16%" right>{amountWithUnit(item.houseStockQuantity, item.unit)}</Cell>
        </View>)}
      </View>
      <Text style={S.note}>* มีข้อมูลคืน/หลักฐานบางส่วนที่ยังไม่ครบ จึงแสดงเท่าที่ระบบบันทึกได้และไม่เดายอดเพิ่ม • ชื่อเดียวกันแต่คนละหน่วยจะแสดงหน่วยต่อท้าย เช่น องุ่นแดง (ลูก) และ องุ่นแดง (โล)</Text>
      <Text style={S.note}>รายงานนี้แสดงเฉพาะผลไม้สำหรับการสั่งซื้อ ไม่รวมผักจนกว่าจะมีข้อมูลเบิก/คืนรายสินค้าในระบบ</Text>
      <Footer generatedText={generatedText} />
    </Page>)}
  </Document>;
}
