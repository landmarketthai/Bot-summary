export const runtime = "nodejs";

import React from "react";
import { NextRequest, NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createServiceClient } from "@/lib/supabase/server";
import { registerFonts } from "@/lib/pdf/fonts";
import { ReportSummaryDoc } from "@/lib/pdf/ReportSummaryDoc";
import { buildReportGroups, type ReportRow, type SettlementMap } from "@/lib/summary/report";
import { uncertifiedReportGroupKeys } from "@/lib/settlement/produce-value-status";
import { displayMarketName } from "@/lib/market";
import { logger } from "@/lib/logger";
import { pdfContentDisposition } from "@/lib/pdf/content-disposition";

// ── Data fetchers (mirror report-summary page) ────────────────────────────────

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
    settlement_date: string; market_name: string; staff_name: string;
    money_transfer: number; money_cash: number; expenses: number; labor: number;
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

async function renderReportPdf(
  rows: ReportRow[],
  settlements: SettlementMap,
  filterLabel: string,
  uncertifiedKeys: string[],
): Promise<Buffer> {
  registerFonts();
  return renderToBuffer(
    <ReportSummaryDoc
      rows={rows}
      settlements={settlements}
      filterLabel={filterLabel}
      uncertifiedKeys={uncertifiedKeys}
    />,
  );
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const date   = searchParams.get("date")   ?? undefined;
  const market = searchParams.get("market") ?? undefined;
  const seller = searchParams.get("seller") ?? undefined;

  if (!date && !market && !seller) {
    return NextResponse.json({ error: "at least one filter required" }, { status: 400 });
  }

  const filterLabel = [date, market, seller].filter(Boolean).join("-");

  try {
    const supabase = await createServiceClient();
    const rows = await getRows(supabase, date, market, seller);
    const uniqueDates = [...new Set(rows.map((r) => r.transaction_date).filter(Boolean) as string[])];
    const settlements = await getSettlements(supabase, uniqueDates);

    // P0: the settlement verdict decides which ยอดส่ง/ขาด-เกิน may print as money.
    const uncertifiedKeys = await uncertifiedReportGroupKeys(
      supabase, buildReportGroups(rows, settlements),
    );
    const buffer = await renderReportPdf(rows, settlements, filterLabel, uncertifiedKeys);

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type":        "application/pdf",
        "Content-Disposition": pdfContentDisposition(`รายงานสรุป-${filterLabel}.pdf`),
        "Cache-Control":       "no-store",
      },
    });
  } catch (err) {
    logger.error("pdf.report-summary.failed", {
      date, market, seller,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "failed to generate report PDF" }, { status: 500 });
  }
}
