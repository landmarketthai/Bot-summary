import { Suspense } from "react";
import { createServiceClient } from "@/lib/supabase/server";
import { timed } from "@/lib/supabase/timing";
import { DashboardTopBar } from "@/components/dashboard/DashboardTopBar";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import { DateInput } from "@/components/ui/DateInput";
import { SearchInput } from "@/components/ui/SearchInput";
import { ReportSummary } from "@/components/report-summary/ReportSummary";
import { RemainingFruitSection } from "@/components/report-summary/RemainingFruitSection";
import { buildReportGroups, type ReportRow, type SettlementMap } from "@/lib/summary/report";
import { uncertifiedReportGroupKeys } from "@/lib/settlement/produce-value-status";
import { displayMarketName } from "@/lib/market";
import { buildRemainingFruitReport, REMAINING_STOCK_REPORT_TITLE } from "@/lib/summary/remaining-fruit";
import { fetchRemainingFruitRows } from "@/lib/summary/remaining-fruit-data";

interface PageProps {
  searchParams: Promise<{
    date?:   string;
    market?: string;
    seller?: string;
  }>;
}

// ── Data fetchers ─────────────────────────────────────────────────────────────

async function getRows(
  supabase: Awaited<ReturnType<typeof createServiceClient>>,
  date?:   string,
  market?: string,
  seller?: string,
): Promise<ReportRow[]> {
  let query = supabase
    .from("produce_transactions")
    .select(
      "transaction_date, market_name, staff_name, product_name, quantity, unit, price_per_unit, total_amount, transaction_type, item_number, basis_quantity, basis_unit, basis_price, session_kind",
    )
    .in("transaction_type", ["เบิก", "เบิกเพิ่ม", "คืน", "คืนเสีย"])
    .order("transaction_date", { ascending: true })
    .order("market_name",      { ascending: true, nullsFirst: false })
    .order("staff_name",       { ascending: true })
    .order("item_number",      { ascending: true, nullsFirst: false });

  if (date)   query = query.eq("transaction_date", date);
  if (market) query = query.ilike("market_name",   `%${market}%`);
  if (seller) query = query.ilike("staff_name",    `%${seller}%`);

  const PAGE = 1000;
  const all: ReportRow[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await query.range(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    all.push(...((data ?? []) as ReportRow[]));
    if (!data || data.length < PAGE) break;
    offset += PAGE;
  }

  return all;
}

async function getSettlements(
  supabase: Awaited<ReturnType<typeof createServiceClient>>,
  dates:   string[],
): Promise<SettlementMap> {
  if (dates.length === 0) return {};

  const { data, error } = await supabase
    .from("settlement_entries")
    .select("settlement_date, market_name, staff_name, money_transfer, money_cash, expenses, labor")
    .in("settlement_date", dates);

  if (error) throw new Error(error.message);

  const map: SettlementMap = {};
  for (const s of (data ?? []) as {
    settlement_date: string;
    market_name:     string;
    staff_name:      string;
    money_transfer:  number;
    money_cash:      number;
    expenses:        number;
    labor:           number;
  }[]) {
    const key = `${s.settlement_date}||${displayMarketName(s.market_name, "")}||${s.staff_name}`;
    if (!map[key]) map[key] = { ยอดโอน: 0, เงินสด: 0, ค่าใช้จ่าย: 0, ค่าแรง: 0, ยอดขาย: 0 };
    map[key].ยอดโอน += s.money_transfer;
    map[key].เงินสด += s.money_cash;
    map[key].ค่าใช้จ่าย += s.expenses;
    map[key].ค่าแรง += s.labor;
    map[key].ยอดขาย += s.money_transfer + s.money_cash + s.expenses + s.labor;
  }

  return map;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function ReportSummaryPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const { date, market, seller } = params;

  const hasFilter = !!(date || market || seller);

  const supabase = await createServiceClient();

  const rows = hasFilter
    ? await timed("report-summary:list", () => getRows(supabase, date, market, seller))
    : [];

  const remainingReport = date
    ? buildRemainingFruitReport(
        await timed("report-summary:remaining-fruit", () =>
          fetchRemainingFruitRows(supabase, date, market ?? null),
        ),
        // Staff debugging tool — keep the ability to inspect QA/test-market
        // rows that the automatic reports intentionally exclude.
        { marketFilter: market ?? null, includeQaScopes: true },
      )
    : null;

  const uniqueDates = [...new Set(rows.map(r => r.transaction_date).filter(Boolean) as string[])];
  const settlements = await timed("report-summary:settlements", () =>
    getSettlements(supabase, uniqueDates),
  );
  // P0: the settlement verdict decides which ยอดส่ง/ขาด-เกิน may show as money.
  const uncertifiedKeys = await timed("report-summary:return-integrity", () =>
    uncertifiedReportGroupKeys(supabase, buildReportGroups(rows, settlements)),
  );

  const pdfParams = new URLSearchParams();
  if (date)   pdfParams.set("date",   date);
  if (market) pdfParams.set("market", market);
  if (seller) pdfParams.set("seller", seller);
  const pdfUrl = hasFilter ? `/api/pdf/report-summary?${pdfParams}` : undefined;

  return (
    <>
      <DashboardTopBar title="รายงานสรุป" />

      <div className="p-4 sm:p-6 space-y-4">
        <Card>
          <CardHeader>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <CardTitle>สร้างรายงานสรุปสำหรับส่ง</CardTitle>
                <p className="text-sm text-slate-500 mt-0.5">
                  เลือกวันที่ ตลาด หรือคนขาย เพื่อสร้างข้อความสรุปที่คัดลอกได้
                </p>
              </div>
              <Suspense fallback={<div className="h-9 w-64 animate-pulse rounded-lg bg-slate-100" />}>
                <div className="flex flex-wrap items-center gap-2">
                  <DateInput defaultValue={date ?? ""} />
                  <SearchInput
                    placeholder="ค้นหาตลาด…"
                    paramName="market"
                    defaultValue={market ?? ""}
                  />
                  <SearchInput
                    placeholder="ค้นหาคนขาย…"
                    paramName="seller"
                    defaultValue={seller ?? ""}
                  />
                </div>
              </Suspense>
            </div>
          </CardHeader>
          <CardContent>
            <ReportSummary
              rows={rows}
              settlements={settlements}
              pdfUrl={pdfUrl}
              uncertifiedKeys={uncertifiedKeys}
            />
          </CardContent>
        </Card>

        {remainingReport && (
          <Card>
            <CardHeader>
              <CardTitle>{REMAINING_STOCK_REPORT_TITLE}</CardTitle>
              <p className="text-sm text-slate-500 mt-0.5">
                สรุปจากข้อมูลชั่งคืน — เลือกวันที่{market ? " และตลาด" : ""} ด้านบนเพื่อกรอง
              </p>
            </CardHeader>
            <CardContent>
              <RemainingFruitSection report={remainingReport} />
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
