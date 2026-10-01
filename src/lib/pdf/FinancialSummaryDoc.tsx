import React from "react";
import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import type { GroupRow, SettlementEntry } from "@/components/financial-summary/FinancialTable";
import { calculateSettlementTotals } from "@/lib/summary/transactions";
import { displayMarketName } from "@/lib/market";

// ── Helpers ───────────────────────────────────────────────────────────────────

function thaiMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("th-TH", { month: "long", year: "numeric" })
    .format(new Date(y, m - 1, 1));
}

function thaiDate(d: string): string {
  return new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short", year: "2-digit" })
    .format(new Date(d + "T00:00:00"));
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function diffColor(n: number): string {
  if (n > 0) return "#15803D";
  if (n < 0) return "#DC2626";
  return "#94A3B8";
}

// ── Data ──────────────────────────────────────────────────────────────────────

function enrichGroups(groups: GroupRow[], settlements: SettlementEntry[]) {
  const map = new Map<string, { transfer: number; cash: number; expenses: number; labor: number }>();
  for (const s of settlements) {
    const k = `${s.settlement_date}||${s.settlement_time ?? ""}||${s.staff_name}||${displayMarketName(s.market_name, "")}`;
    const cur = map.get(k) ?? { transfer: 0, cash: 0, expenses: 0, labor: 0 };
    map.set(k, {
      transfer: cur.transfer + s.money_transfer,
      cash:     cur.cash + s.money_cash,
      expenses: cur.expenses + s.expenses,
      labor:    cur.labor + s.labor,
    });
  }
  return groups.map((g) => {
    const k   = `${g.date}||${g.time ?? ""}||${g.seller}||${g.market}`;
    const s   = map.get(k) ?? { transfer: 0, cash: 0, expenses: 0, labor: 0 };
    const netTrusted = g.produceNetStatus !== "returns_exceed_withdrawal";
    const settlement = calculateSettlementTotals({
      ยอดส่ง: g.ยอดส่ง,
      money_transfer: s.transfer,
      money_cash: s.cash,
      expenses: s.expenses,
      labor: s.labor,
    });
    return {
      ...g,
      ยอดโอน: settlement.ยอดโอน,
      เงินสด: settlement.เงินสด,
      ค่าใช้จ่าย: s.expenses,
      ค่าแรง: s.labor,
      ยอดขาย: settlement.ยอดขาย,
      ขาดเกิน: netTrusted ? settlement.ขาดเกิน : null,
    };
  });
}

// ── Styles ────────────────────────────────────────────────────────────────────

const S = StyleSheet.create({
  page: {
    fontFamily: "SarabunPDF",
    fontSize: 8,
    paddingTop: 28,
    paddingBottom: 36,
    paddingHorizontal: 28,
    color: "#1E293B",
  },
  header: {
    marginBottom: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    borderBottomWidth: 1.5,
    borderBottomColor: "#0F172A",
    paddingBottom: 6,
  },
  headerTitle: {
    fontSize: 13,
    fontWeight: "bold",
  },
  headerSub: {
    fontSize: 7.5,
    color: "#64748B",
  },
  table: {
    flexDirection: "column",
  },
  thead: {
    flexDirection: "row",
    backgroundColor: "#0F172A",
  },
  th: {
    paddingVertical: 4,
    paddingHorizontal: 3,
    fontSize: 6.5,
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
    borderTopWidth: 1.5,
    borderTopColor: "#0F172A",
  },
  td: {
    paddingVertical: 3.5,
    paddingHorizontal: 3,
    fontSize: 7,
    textAlign: "right",
  },
  tdLeft: {
    textAlign: "left",
  },
  tdFoot: {
    paddingVertical: 4,
    paddingHorizontal: 3,
    fontSize: 7,
    fontWeight: "bold",
    textAlign: "right",
  },
  pageNumber: {
    position: "absolute",
    fontSize: 7,
    color: "#94A3B8",
    bottom: 16,
    right: 28,
  },
  printDate: {
    position: "absolute",
    fontSize: 7,
    color: "#94A3B8",
    bottom: 16,
    left: 28,
  },
});

// ── Column definitions ────────────────────────────────────────────────────────

const COLS = [
  { label: "วันที่",    flex: 8,    left: true  },
  { label: "คนขาย",    flex: 11.5, left: true  },
  { label: "ตลาด",     flex: 12,   left: true  },
  { label: "เบิก",     flex: 9,    left: false },
  { label: "คืน",      flex: 8,    left: false },
  { label: "คืนเสีย",  flex: 9,    left: false },
  { label: "ยอดส่ง",   flex: 9,    left: false },
  { label: "เงินโอน",  flex: 9,    left: false },
  { label: "เงินสด",   flex: 8,    left: false },
  { label: "ค่าใช้จ่าย", flex: 8,  left: false },
  { label: "ค่าแรง",   flex: 8,    left: false },
  { label: "ยอดขาย",  flex: 9,    left: false },
  { label: "ขาด/เกิน", flex: 9,    left: false },
] as const;

// ── Component ─────────────────────────────────────────────────────────────────

export interface FinancialSummaryDocProps {
  month:       string;
  groups:      GroupRow[];
  settlements: SettlementEntry[];
}

export function FinancialSummaryDoc({ month, groups, settlements }: FinancialSummaryDocProps) {
  const enriched = enrichGroups(groups, settlements);
  const today    = new Date().toLocaleDateString("th-TH", { day: "numeric", month: "long", year: "numeric" });

  // Grand totals
  let gเบิก = 0, gคืน = 0, gคืนเสีย = 0, gยอดส่ง = 0;
  let gโอน = 0, gสด = 0, gค่าใช้จ่าย = 0, gค่าแรง = 0, gยอดขาย = 0, gขาดเกิน = 0;
  let untrustedNetCount = 0;
  for (const g of enriched) {
    gเบิก    += g.เบิก;
    gคืน     += g.คืน;
    gคืนเสีย += g.คืนเสีย;
    if (g.produceNetStatus === "returns_exceed_withdrawal") untrustedNetCount += 1;
    else gยอดส่ง += g.ยอดส่ง;
    gโอน     += g.ยอดโอน;
    gสด      += g.เงินสด;
    gค่าใช้จ่าย += g.ค่าใช้จ่าย;
    gค่าแรง += g.ค่าแรง;
    gยอดขาย  += g.ยอดขาย;
    if (g.ขาดเกิน !== null) gขาดเกิน += g.ขาดเกิน;
  }

  const footValues = [
    `รวม ${enriched.length} กลุ่ม`, "", "",
    fmt(gเบิก), fmt(gคืน), fmt(gคืนเสีย), untrustedNetCount === 0 ? fmt(gยอดส่ง) : "ตรวจสอบ",
    fmt(gโอน), fmt(gสด), fmt(gค่าใช้จ่าย), fmt(gค่าแรง), fmt(gยอดขาย), fmt(gขาดเกิน),
  ];

  return (
    <Document title={`สรุปการเงิน-${month}`} author="bot-summary">
      <Page size="A4" orientation="portrait" style={S.page} wrap>
        {/* Header */}
        <View style={S.header} fixed>
          <View>
            <Text style={S.headerTitle}>สรุปการเงิน</Text>
            <Text style={S.headerSub}>{thaiMonth(month)}</Text>
          </View>
          <Text style={S.headerSub}>พิมพ์วันที่ {today}</Text>
        </View>

        {/* Table */}
        <View style={S.table}>
          {/* Head */}
          <View style={S.thead} fixed>
            {COLS.map((c) => (
              <Text key={c.label} style={[S.th, c.left ? S.thLeft : {}]} wrap={false}>
                {c.label}
              </Text>
            ))}
          </View>

          {/* Body */}
          {enriched.length === 0 ? (
            <View style={{ padding: 12 }}>
              <Text style={{ fontSize: 8, color: "#94A3B8", textAlign: "center" }}>
                ไม่มีข้อมูลในเดือนนี้
              </Text>
            </View>
          ) : (
            enriched.map((g, i) => {
              const vals = [
                thaiDate(g.date), g.seller, g.market,
                fmt(g.เบิก), fmt(g.คืน), fmt(g.คืนเสีย),
                g.produceNetStatus === "returns_exceed_withdrawal" ? "ตรวจสอบ" : fmt(g.ยอดส่ง),
                fmt(g.ยอดโอน), fmt(g.เงินสด), fmt(g.ค่าใช้จ่าย), fmt(g.ค่าแรง), fmt(g.ยอดขาย),
              ];
              return (
                <View key={`${g.date}||${g.seller}||${g.market}`} style={[S.tr, i % 2 === 1 ? S.trAlt : {}]} wrap={false}>
                  {COLS.map((c, ci) => {
                    if (ci < vals.length) {
                      return (
                        <Text key={c.label} style={[S.td, c.left ? S.tdLeft : {}]}>
                          {vals[ci]}
                        </Text>
                      );
                    }
                    // ขาด/เกิน column
                    return (
                      <Text key={c.label} style={[S.td, { color: g.ขาดเกิน === null ? "#B45309" : diffColor(g.ขาดเกิน), fontWeight: "bold" }]}>
                        {g.ขาดเกิน === null ? "ตรวจสอบ" : `${g.ขาดเกิน > 0 ? "+" : ""}${fmt(g.ขาดเกิน)}`}
                      </Text>
                    );
                  })}
                </View>
              );
            })
          )}

          {/* Foot */}
          {enriched.length > 0 && (
            <View style={S.trFoot} wrap={false}>
              {COLS.map((c, ci) => (
                <Text key={c.label} style={[S.tdFoot, ci === 0 ? S.tdLeft : {}, ci === 12 ? { color: untrustedNetCount > 0 ? "#B45309" : diffColor(gขาดเกิน) } : {}]}>
                  {ci === 12
                    ? (untrustedNetCount > 0 ? "ตรวจสอบ" : (gขาดเกิน > 0 ? "+" : "") + fmt(gขาดเกิน))
                    : footValues[ci]}
                </Text>
              ))}
            </View>
          )}
        </View>

        {/* Footer */}
        <Text
          style={S.printDate}
          render={() => `bot-summary · ${thaiMonth(month)}`}
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
