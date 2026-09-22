import React from "react";
import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { formatThaiDate } from "@/lib/date";
import type {
  MorningBriefPurchaseGroup,
  MorningBriefReport,
} from "@/lib/summary/morning-brief";

function bahtFromSatang(satang: number): string {
  return (satang / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function baht(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function qty(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

function reconStatus(status: string): string {
  const labels: Record<string, string> = {
    matched: "ตรงกัน",
    transfer_short: "โอนขาด",
    transfer_over: "โอนเกิน",
    pending_review: "รอตรวจ",
    missing_data: "ยังไม่มีข้อมูล",
  };
  return labels[status] ?? status;
}

const S = StyleSheet.create({
  page: { fontFamily: "SarabunPDF", fontSize: 8.7, paddingTop: 25, paddingBottom: 28, paddingHorizontal: 27, color: "#111827" },
  header: { borderBottomWidth: 1.4, borderBottomColor: "#111827", paddingBottom: 6, marginBottom: 7 },
  title: { fontSize: 17, fontWeight: "bold" },
  subtitle: { fontSize: 8.2, color: "#4B5563", marginTop: 2 },
  kpiGrid: { flexDirection: "row", flexWrap: "wrap", marginHorizontal: -2, marginBottom: 5 },
  kpi: { width: "33.333%", padding: 2 },
  kpiBox: { borderWidth: 0.6, borderColor: "#BFC3C8", padding: 6, minHeight: 47 },
  kpiLabel: { fontSize: 7.5, color: "#6B7280" },
  kpiValue: { fontSize: 12.5, fontWeight: "bold", marginTop: 1 },
  kpiMeta: { fontSize: 7.2, color: "#6B7280", marginTop: 2 },
  section: { marginTop: 5, marginBottom: 5 },
  sectionTitle: { fontSize: 10.5, fontWeight: "bold", borderBottomWidth: 0.7, borderBottomColor: "#6B7280", paddingBottom: 2.5, marginBottom: 4 },
  table: { borderLeftWidth: 0.5, borderTopWidth: 0.5, borderColor: "#B6BAC0" },
  tr: { flexDirection: "row" },
  th: { backgroundColor: "#ECEDEF", fontWeight: "bold" },
  cell: { borderRightWidth: 0.5, borderBottomWidth: 0.5, borderColor: "#B6BAC0", paddingVertical: 3, paddingHorizontal: 3 },
  center: { textAlign: "center" },
  right: { textAlign: "right" },
  muted: { color: "#6B7280" },
  total: { backgroundColor: "#F5F5F5", fontWeight: "bold" },
  note: { fontSize: 7.4, color: "#6B7280", marginTop: 3 },
  footer: { position: "absolute", bottom: 11, left: 27, right: 27, flexDirection: "row", justifyContent: "space-between", fontSize: 7, color: "#6B7280" },
});

function Cell({ width, children, header = false, right = false, center = false, total = false }: { width: string; children?: React.ReactNode; header?: boolean; right?: boolean; center?: boolean; total?: boolean }) {
  return <View style={[S.cell, { width }, header ? S.th : {}, total ? S.total : {}]}><Text style={right ? S.right : center ? S.center : {}}>{children}</Text></View>;
}

function purchaseNames(group: MorningBriefPurchaseGroup): string {
  const names = group.items?.map((item) => item.productName) ?? group.productNames;
  return names.length > 0 ? names.join(", ") : "-";
}

function PurchaseSummaryRow({ label, group }: { label: string; group: MorningBriefPurchaseGroup }) {
  return <View style={[S.tr, { minHeight: 26, borderLeftWidth: 0.5, borderTopWidth: 0.5, borderColor: "#B6BAC0" }]} wrap={false}>
    <Cell width="25%"><Text style={{ fontWeight: "bold" }}>{label} - {group.count}</Text></Cell>
    <Cell width="75%">{purchaseNames(group)}</Cell>
  </View>;
}

function DataFooter({ generatedText }: { generatedText: string }) {
  return <View style={S.footer} fixed><Text>สร้างเมื่อ {generatedText}</Text><Text render={({ pageNumber, totalPages }) => `หน้า ${pageNumber}/${totalPages}`} /></View>;
}

export function MorningBriefA4Doc({ report, generatedAt }: { report: MorningBriefReport; generatedAt: Date }) {
  const sales = report.sales;
  const house = report.houseStock;
  const stockItems = house.status === "available" ? (house.items ?? []) : [];
  const recon = report.reconciliation;
  const generatedText = new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" }).format(generatedAt);
  const salesMeta = `ยืนยันแล้ว ${bahtFromSatang(sales.confirmedSalesSatang)} • รอตรวจ ${bahtFromSatang(sales.pendingReviewSalesSatang)} • ปรับราคา ${bahtFromSatang(sales.adjustmentSatang)}`;
  const reconMeta = recon?.status === "available" ? `ตรวจแล้ว ${recon.checkedSlipBaht.toLocaleString("en-US", { minimumFractionDigits: 2 })} บาท` : "ยังไม่มีข้อมูลยอดส่ง";

  return <Document title={`Morning Brief ${report.businessDate}`}>
    <Page size="A4" style={S.page} wrap>
      <View style={S.header}>
        <Text style={S.title}>สรุปเช้า 08:00 - {formatThaiDate(report.businessDate)}</Text>
        <Text style={S.subtitle}>ภาพรวมสำหรับตัดสินใจซื้อ • ข้อมูลชุดเดียวกับ Morning Brief ใน LINE</Text>
      </View>

      <View style={S.kpiGrid}>
        <View style={S.kpi}><View style={S.kpiBox}><Text style={S.kpiLabel}>{sales.excludedFromSalesCount > 0 ? "ยอดขายที่คำนวณได้ (บางส่วน)" : "ยอดขายรวมเมื่อวาน"}</Text><Text style={S.kpiValue}>{bahtFromSatang(sales.totalSalesSatang)} บาท</Text><Text style={S.kpiMeta}>{salesMeta}</Text></View></View>
        <View style={S.kpi}><View style={S.kpiBox}><Text style={S.kpiLabel}>มูลค่าคลังคงเหลือ</Text><Text style={S.kpiValue}>{house.status === "available" ? `${bahtFromSatang(house.totalValueSatang)} บาท` : "ยังไม่มีข้อมูล"}</Text><Text style={S.kpiMeta}>{house.status === "available" ? `${house.groupCount} SKU` : house.status === "missing" ? "ยังไม่ได้บันทึก House Stock" : "ยังไม่มีข้อมูล House Stock สำหรับสรุปนี้"}</Text></View></View>
        <View style={S.kpi}><View style={S.kpiBox}><Text style={S.kpiLabel}>ยอดส่งจริง</Text><Text style={S.kpiValue}>{recon?.status === "available" ? `${baht(recon.submittedTransferBaht)} บาท` : "ยังไม่มีข้อมูล"}</Text><Text style={S.kpiMeta}>{reconMeta}</Text></View></View>
        <View style={S.kpi}><View style={S.kpiBox}><Text style={S.kpiLabel}>ควรซื้อเพิ่ม</Text><Text style={S.kpiValue}>{report.purchasePlanning.strong.count} รายการ</Text><Text style={S.kpiMeta}>อ้างอิงยอดขาย + สต๊อก</Text></View></View>
        <View style={S.kpi}><View style={S.kpiBox}><Text style={S.kpiLabel}>สินค้าขายหมด</Text><Text style={S.kpiValue}>{sales.soldOutCount} SKU</Text><Text style={S.kpiMeta}>มีเบิก • ไม่มีคืน/คืนเสีย • หลักฐานครบ</Text></View></View>
        <View style={S.kpi}><View style={S.kpiBox}><Text style={S.kpiLabel}>ยอดยืนยันแล้ว</Text><Text style={S.kpiValue}>{bahtFromSatang(sales.confirmedSalesSatang)} บาท</Text><Text style={S.kpiMeta}>จากยอดขายที่คำนวณได้</Text></View></View>
      </View>

      <View style={S.section}>
        <Text style={S.sectionTitle}>1) แผนซื้อวันนี้ + สต๊อกคงเหลือในบ้าน</Text>
        <PurchaseSummaryRow label="ควรซื้อเพิ่ม" group={report.purchasePlanning.strong} />
        <PurchaseSummaryRow label="ยังไม่ควรซื้อเพิ่ม" group={report.purchasePlanning.surplus} />
        <PurchaseSummaryRow label="ควรลดการซื้อ" group={report.purchasePlanning.reduce} />
        <PurchaseSummaryRow label="ยังประเมินไม่ได้" group={report.purchasePlanning.unknown} />
      </View>

      <View style={S.section}>
        <Text style={S.sectionTitle}>2) ของในบ้าน / คลังคงเหลือ</Text>
        {house.status === "available" ? <View style={S.table}>
          <View style={S.tr} fixed><Cell width="7%" header center>#</Cell><Cell width="29%" header>สินค้า</Cell><Cell width="15%" header right>จำนวน</Cell><Cell width="11%" header center>หน่วย</Cell><Cell width="18%" header right>ราคา/หน่วย</Cell><Cell width="20%" header right>มูลค่า</Cell></View>
          {stockItems.map((item, index) => <View style={S.tr} key={`${item.productName}-${item.unit}-${item.unitPriceSatang}-${index}`} wrap={false}>
            <Cell width="7%" center>{index + 1}</Cell><Cell width="29%">{item.productName}</Cell><Cell width="15%" right>{qty(item.quantity)}</Cell><Cell width="11%" center>{item.unit}</Cell><Cell width="18%" right>{bahtFromSatang(item.unitPriceSatang)}</Cell><Cell width="20%" right>{bahtFromSatang(item.valueSatang)}</Cell>
          </View>)}
          <View style={S.tr} wrap={false}><Cell width="7%" total></Cell><Cell width="29%" total>รวมคลังคงเหลือ</Cell><Cell width="15%" total>{house.groupCount} SKU</Cell><Cell width="11%" total></Cell><Cell width="18%" total></Cell><Cell width="20%" total right>{bahtFromSatang(house.totalValueSatang)} บาท</Cell></View>
        </View> : <Text>{house.status === "missing" ? "ยังไม่มีการบันทึกคลังคงเหลือสำหรับวันนี้" : "ยังไม่มีข้อมูลคลังคงเหลือสำหรับสรุปนี้"}</Text>}
        <Text style={S.note}>House Stock คือของที่ยังอยู่ในบ้าน/คลัง แยกจากสินค้าที่เบิกออกไปขายที่ตลาด</Text>
      </View>
      <DataFooter generatedText={generatedText} />
    </Page>

    <Page size="A4" style={S.page} wrap>
      <View style={S.header}>
        <Text style={S.title}>สรุปเช้า 08:00 - ยอดขายและยอดส่ง</Text>
        <Text style={S.subtitle}>{formatThaiDate(report.businessDate)} • หน้าที่ 2</Text>
      </View>

      <View style={S.section}>
        <Text style={S.sectionTitle}>3) ยอดขายเมื่อวาน - แยกตามตลาด</Text>
        <View style={S.table}>
          <View style={S.tr} fixed><Cell width="22%" header>ตลาด</Cell><Cell width="18%" header right>ยอดรวม</Cell><Cell width="18%" header right>ยืนยันแล้ว</Cell><Cell width="16%" header right>ยอดรอตรวจ</Cell><Cell width="14%" header right>ปรับราคา</Cell><Cell width="12%" header>สถานะ</Cell></View>
          {(sales.markets ?? []).map((market, index) => <View style={S.tr} key={`${market.marketLabel}-${index}`} wrap={false}>
            <Cell width="22%">{market.marketLabel}</Cell><Cell width="18%" right>{bahtFromSatang(market.totalSalesSatang)}</Cell><Cell width="18%" right>{bahtFromSatang(market.confirmedSalesSatang)}</Cell><Cell width="16%" right>{bahtFromSatang(market.pendingReviewSalesSatang)}</Cell><Cell width="14%" right>{bahtFromSatang(market.adjustmentSatang)}</Cell><Cell width="12%">{market.valueAuthoritative ? "ยอดครบ" : "รอตรวจ"}</Cell>
          </View>)}
          <View style={S.tr} wrap={false}><Cell width="22%" total>รวม</Cell><Cell width="18%" total right>{bahtFromSatang(sales.totalSalesSatang)}</Cell><Cell width="18%" total right>{bahtFromSatang(sales.confirmedSalesSatang)}</Cell><Cell width="16%" total right>{bahtFromSatang(sales.pendingReviewSalesSatang)}</Cell><Cell width="14%" total right>{bahtFromSatang(sales.adjustmentSatang)}</Cell><Cell width="12%" total>{sales.valueAuthoritative ? "ยอดครบ" : "รอตรวจ"}</Cell></View>
        </View>
        <Text style={S.note}>“ขายหมด” = มีเบิก แต่ไม่มีทั้งคืนและคืนเสีย และไม่มีหลักฐานคืนค้าง; ถ้าข้อมูลยังไม่ครบจะไม่นับเป็นขายหมด</Text>
      </View>

      <View style={S.section}>
        <Text style={S.sectionTitle}>4) ตรวจเงิน / สลิป / ยอดส่ง</Text>
        {recon?.status === "available" ? <View style={S.table}>
          <View style={S.tr} fixed><Cell width="28%" header>ตลาด</Cell><Cell width="22%" header right>ยอดส่งจริง</Cell><Cell width="22%" header right>สลิปตรวจแล้ว</Cell><Cell width="14%" header right>ส่วนต่าง</Cell><Cell width="14%" header>สถานะ</Cell></View>
          {recon.rows.map((row, index) => <View style={S.tr} key={`${row.market}-${index}`} wrap={false}>
            <Cell width="28%">{row.market}</Cell><Cell width="22%" right>{row.submittedTransferBaht == null ? "-" : baht(row.submittedTransferBaht)}</Cell><Cell width="22%" right>{row.checkedSlipBaht == null ? "-" : baht(row.checkedSlipBaht)}</Cell><Cell width="14%" right>{row.differenceBaht == null ? "-" : baht(row.differenceBaht)}</Cell><Cell width="14%">{reconStatus(row.status)}</Cell>
          </View>)}
          <View style={S.tr} wrap={false}><Cell width="28%" total>รวม</Cell><Cell width="22%" total right>{baht(recon.submittedTransferBaht)}</Cell><Cell width="22%" total right>{baht(recon.checkedSlipBaht)}</Cell><Cell width="14%" total right>{baht(recon.differenceBaht)}</Cell><Cell width="14%" total>{recon.needsReviewCount === 0 ? "ตรงกัน" : "มีส่วนต่าง"}</Cell></View>
        </View> : <Text>{recon?.status === "missing" ? "ยังไม่มีข้อมูลสรุปยอดส่งสำหรับวันนี้" : "ยังไม่มีข้อมูลยอดส่งสำหรับสรุปนี้"}</Text>}
      </View>

      <Text style={S.note}>รายงานนี้แสดงเฉพาะข้อมูลธุรกิจที่ใช้ตัดสินใจซื้อ ขาย สต๊อก และยอดส่ง โดยไม่แสดงรายละเอียดตรวจสอบภายในระบบ</Text>
      <DataFooter generatedText={generatedText} />
    </Page>
  </Document>;
}
