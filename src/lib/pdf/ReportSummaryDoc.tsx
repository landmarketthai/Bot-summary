import React from "react";
import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import { buildReportGroups, type ReportRow, type SettlementMap } from "@/lib/summary/report";
import { displayMarketName } from "@/lib/market";
import { calculateSettlementTotals } from "@/lib/summary/transactions";

// ── Helpers ───────────────────────────────────────────────────────────────────

function thaiDate(d: string): string {
  return new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "long", year: "numeric" })
    .format(new Date(d + "T00:00:00"));
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function fmtQty(n: number): string {
  const r = Math.round(n * 1000) / 1000;
  if (Number.isInteger(r)) return r.toString();
  return r.toFixed(3).replace(/0+$/, "");
}

function diffColor(n: number): string {
  if (n > 0) return "#15803D";
  if (n < 0) return "#DC2626";
  return "#94A3B8";
}

// ── Data grouping ─────────────────────────────────────────────────────────────

interface ReportGroup {
  date:             string;
  market:           string;
  seller:           string;
  เบิก:             ReportRow[];
  คืน:              ReportRow[];
  คืนเสีย:          ReportRow[];
  ยอดเบิก:          number;
  ยอดคืน:           number;
  ยอดคืนเสีย:       number;
  ยอดส่ง:           number;
  ยอดโอน:           number;
  ยอดขาย:           number;
  เงินสดต้องส่งเจ๊: number;
  ขาดเกิน:          number;
}

export function buildGroups(rows: ReportRow[], settlements: SettlementMap): ReportGroup[] {
  const map = new Map<string, ReportGroup>();

  for (const r of rows) {
    const date   = r.transaction_date ?? "ไม่ระบุวันที่";
    const market = displayMarketName(r.market_name, "ไม่ระบุตลาด");
    const seller = r.staff_name       || "ไม่ระบุ";
    const key    = `${date}||${market}||${seller}`;

    if (!map.has(key)) {
      map.set(key, {
        date, market, seller,
        เบิก: [], คืน: [], คืนเสีย: [],
        ยอดเบิก: 0, ยอดคืน: 0, ยอดคืนเสีย: 0,
        ยอดส่ง: 0, ยอดโอน: 0, ยอดขาย: 0,
        เงินสดต้องส่งเจ๊: 0, ขาดเกิน: 0,
      });
    }
    const g   = map.get(key)!;
    const amt = r.total_amount ?? 0;

    switch (r.transaction_type) {
      case "เบิก":
      case "เบิกเพิ่ม": g.เบิก.push(r);    g.ยอดเบิก    += amt; break;
      case "คืน":       g.คืน.push(r);     g.ยอดคืน     += amt; break;
      case "คืนเสีย":   g.คืนเสีย.push(r); g.ยอดคืนเสีย += amt; break;
    }
  }

  return Array.from(map.values())
    .map((g) => {
      const key       = `${g.date}||${g.market}||${g.seller}`;
      const s         = settlements[key] ?? { ยอดโอน: 0, เงินสด: 0, ค่าใช้จ่าย: 0, ค่าแรง: 0, ยอดขาย: 0 };
      const ยอดส่ง    = g.ยอดเบิก - g.ยอดคืน - g.ยอดคืนเสีย;
      const settlement = calculateSettlementTotals({
        ยอดส่ง,
        money_transfer: s.ยอดโอน,
        money_cash: s.เงินสด,
        expenses: s.ค่าใช้จ่าย,
        labor: s.ค่าแรง,
      });
      return {
        ...g,
        ยอดส่ง,
        ยอดโอน: settlement.ยอดโอน,
        ยอดขาย: settlement.ยอดขาย,
        เงินสดต้องส่งเจ๊: settlement.เงินสดต้องส่งเจ๊,
        ขาดเกิน: settlement.ขาดเกิน,
      };
    })
    .sort((a, b) =>
      a.date.localeCompare(b.date) ||
      a.market.localeCompare(b.market) ||
      a.seller.localeCompare(b.seller),
    );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const S = StyleSheet.create({
  page: {
    fontFamily: "SarabunPDF",
    fontSize: 9,
    paddingTop: 30,
    paddingBottom: 40,
    paddingHorizontal: 32,
    color: "#1E293B",
  },

  // Group header
  groupTitle: {
    fontSize: 13,
    fontWeight: "bold",
    marginBottom: 2,
  },
  groupMeta: {
    fontSize: 8,
    color: "#64748B",
    marginBottom: 12,
  },
  divider: {
    borderBottomWidth: 1,
    borderBottomColor: "#CBD5E1",
    marginBottom: 12,
  },

  // Section labels
  sectionLabel: {
    fontSize: 8.5,
    fontWeight: "bold",
    color: "#475569",
    marginBottom: 4,
    marginTop: 10,
  },

  // Summary block (wide 7-col table)
  summaryRow: {
    flexDirection: "row",
    backgroundColor: "#F1F5F9",
    borderRadius: 4,
    paddingVertical: 6,
    paddingHorizontal: 8,
    marginBottom: 4,
  },
  summaryCell: {
    flex: 1,
    alignItems: "center",
  },
  summaryLabel: {
    fontSize: 6.5,
    color: "#64748B",
    marginBottom: 2,
    textAlign: "center",
  },
  summaryValue: {
    fontSize: 9,
    fontWeight: "bold",
    textAlign: "center",
  },

  // Detail tables
  table: {
    flexDirection: "column",
    marginBottom: 2,
  },
  thead: {
    flexDirection: "row",
    backgroundColor: "#334155",
  },
  th: {
    paddingVertical: 3.5,
    paddingHorizontal: 4,
    fontSize: 7,
    fontWeight: "bold",
    color: "#FFFFFF",
    textAlign: "right",
  },
  thLeft: {
    textAlign: "left",
  },
  tr: {
    flexDirection: "row",
    borderBottomWidth: 0.5,
    borderBottomColor: "#E2E8F0",
  },
  trAlt: {
    backgroundColor: "#F8FAFC",
  },
  trFoot: {
    flexDirection: "row",
    backgroundColor: "#FEF9C3",
    borderTopWidth: 1,
    borderTopColor: "#334155",
  },
  td: {
    paddingVertical: 3,
    paddingHorizontal: 4,
    fontSize: 8,
    textAlign: "right",
  },
  tdLeft: {
    textAlign: "left",
  },
  tdFoot: {
    paddingVertical: 3.5,
    paddingHorizontal: 4,
    fontSize: 8,
    fontWeight: "bold",
    textAlign: "right",
  },

  // Footer
  pageNumber: {
    position: "absolute",
    fontSize: 7,
    color: "#94A3B8",
    bottom: 16,
    right: 32,
  },
  printDate: {
    position: "absolute",
    fontSize: 7,
    color: "#94A3B8",
    bottom: 16,
    left: 32,
  },
});

// ── Sub-components ────────────────────────────────────────────────────────────

const DETAIL_COLS = [
  { label: "ลำดับ",  flex: 2,  left: false },
  { label: "สินค้า", flex: 10, left: true  },
  { label: "จำนวน",  flex: 4,  left: false },
  { label: "หน่วย",  flex: 3,  left: false },
  { label: "ราคา",   flex: 4,  left: false },
  { label: "รวม",    flex: 5,  left: false },
] as const;

function DetailTable({ items, typeLabel }: { items: ReportRow[]; typeLabel: string }) {
  if (items.length === 0) return null;

  const total = items.reduce((s, r) => s + (r.total_amount ?? 0), 0);

  return (
    <View>
      <Text style={S.sectionLabel}>{typeLabel}</Text>
      <View style={S.table}>
        <View style={S.thead}>
          {DETAIL_COLS.map((c) => (
            <Text key={c.label} style={[S.th, c.left ? S.thLeft : {}, { flex: c.flex }]}>
              {c.label}
            </Text>
          ))}
        </View>
        {items.map((r, i) => {
          // price_per_unit is only a rounded display approximation for basis
          // rows (e.g. "3โล100บาท"); show the actual basis instead so the
          // printed price isn't a misleading rounding of the real terms.
          const priceCell = r.basis_quantity && r.basis_price != null
            ? `${fmt(r.basis_price)}/${fmtQty(r.basis_quantity)}${r.basis_unit ?? ""}`
            : fmt(r.price_per_unit ?? 0);
          return (
            <View key={r.product_name + i} style={[S.tr, i % 2 === 1 ? S.trAlt : {}]} wrap={false}>
              <Text style={[S.td, { flex: 2 }]}>{(r.item_number ?? i + 1)}</Text>
              <Text style={[S.td, S.tdLeft, { flex: 10 }]}>
                {r.product_name}
                {r.session_kind === "additional" ? "  • ชุดเพิ่ม" : ""}
              </Text>
              <Text style={[S.td, { flex: 4 }]}>{fmtQty(r.quantity ?? 0)}</Text>
              <Text style={[S.td, { flex: 3 }]}>{r.unit ?? ""}</Text>
              <Text style={[S.td, { flex: 4 }]}>{priceCell}</Text>
              <Text style={[S.td, { flex: 5 }]}>{fmt(r.total_amount ?? 0)}</Text>
            </View>
          );
        })}
        <View style={S.trFoot} wrap={false}>
          <Text style={[S.tdFoot, S.tdLeft, { flex: 2 + 10 + 4 + 3 + 4 }]}>รวม {items.length} รายการ</Text>
          <Text style={[S.tdFoot, { flex: 5 }]}>{fmt(total)}</Text>
        </View>
      </View>
    </View>
  );
}

function SummaryBlock({ g }: { g: ReportGroup & { provisional?: boolean } }) {
  // P0: money that rests on an uncertified ชั่งคืน is pending, never a figure.
  const pending = new Set(g.provisional ? ["ยอดส่ง", "เงินสดต้องส่งเจ๊", "ขาด/เกิน"] : []);
  const cells = [
    { label: "ยอดเบิก",          value: g.ยอดเบิก,          color: "#15803D" },
    { label: "ยอดคืน",           value: g.ยอดคืน,           color: "#1D4ED8" },
    { label: "ยอดคืนเสีย",       value: g.ยอดคืนเสีย,       color: "#DC2626" },
    { label: "ยอดส่ง",            value: g.ยอดส่ง,            color: "#1E293B" },
    { label: "ยอดโอน",            value: g.ยอดโอน,            color: "#6D28D9" },
    { label: "เงินสดต้องส่งเจ๊", value: g.เงินสดต้องส่งเจ๊, color: "#B45309" },
    { label: "ขาด/เกิน",          value: g.ขาดเกิน,           color: diffColor(g.ขาดเกิน) },
  ];
  return (
    <View style={S.summaryRow}>
      {cells.map(({ label, value, color }) => (
        <View key={label} style={S.summaryCell}>
          <Text style={S.summaryLabel}>{label}</Text>
          <Text style={[S.summaryValue, { color }]}>
            {pending.has(label) ? "รอตรวจสอบ" : `${value > 0 && label === "ขาด/เกิน" ? "+" : ""}${fmt(value)}`}
          </Text>
        </View>
      ))}
    </View>
  );
}

// ── Document ──────────────────────────────────────────────────────────────────

export interface ReportSummaryDocProps {
  rows:        ReportRow[];
  settlements: SettlementMap;
  filterLabel: string;
  /** Server verdict: groups whose ชั่งคืน is not certified. */
  uncertifiedKeys?: string[];
}

export function ReportSummaryDoc({ rows, settlements, filterLabel, uncertifiedKeys = [] }: ReportSummaryDocProps) {
  const groups  = buildReportGroups(rows, settlements, uncertifiedKeys);
  const today   = new Date().toLocaleDateString("th-TH", { day: "numeric", month: "long", year: "numeric" });

  return (
    <Document title={`รายงานสรุป-${filterLabel}`} author="bot-summary">
      <Page size="A4" orientation="portrait" style={S.page} wrap>
        {groups.length === 0 ? (
          <View style={{ padding: 20 }}>
            <Text style={{ fontSize: 10, color: "#94A3B8", textAlign: "center" }}>ไม่พบข้อมูล</Text>
          </View>
        ) : (
          groups.map((g, idx) => (
            <View key={`${g.date}||${g.market}||${g.seller}`} break={idx > 0}>
              {/* Group header */}
              <Text style={S.groupTitle}>
                สรุป-{g.market} {g.seller}
              </Text>
              <Text style={S.groupMeta}>
                วันที่ {g.date !== "ไม่ระบุวันที่" ? thaiDate(g.date) : g.date}
              </Text>
              <View style={S.divider} />

              {/* Section 1: Summary */}
              <Text style={S.sectionLabel}>สรุปยอด</Text>
              <SummaryBlock g={g} />

              {/* Section 2: Transaction details */}
              <DetailTable items={g.เบิก}    typeLabel="เบิก"    />
              <DetailTable items={g.คืน}     typeLabel="คืน"     />
              <DetailTable items={g.คืนเสีย} typeLabel="คืนเสีย" />
            </View>
          ))
        )}

        {/* Footer */}
        <Text
          style={S.printDate}
          render={() => `bot-summary · พิมพ์วันที่ ${today}`}
          fixed
        />
        <Text
          style={S.pageNumber}
          render={({ pageNumber, totalPages }) => `หน้า ${pageNumber} / ${totalPages}`}
          fixed
        />
      </Page>
    </Document>
  );
}
