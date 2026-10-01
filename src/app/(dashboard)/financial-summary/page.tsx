import { createServiceClient } from "@/lib/supabase/server";
import { timed } from "@/lib/supabase/timing";
import { DashboardTopBar } from "@/components/dashboard/DashboardTopBar";
import { FinancialTable, type GroupRow, type SettlementEntry } from "@/components/financial-summary/FinancialTable";
import {
  KNOWN_TX_TYPES,
  addTransactionAmount,
  calculateYodSong,
  emptyTransactionTotals,
  isKnownTransactionType,
  produceNetStatus,
} from "@/lib/summary/transactions";
import { displayMarketName } from "@/lib/market";
import { produceFinancialIntegrity } from "@/lib/settlement/produce-financial-integrity";
import Link from "next/link";

interface PageProps {
  searchParams: Promise<{ month?: string }>;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthDateRange(month: string): { from: string; toExclusive: string } {
  const [y, m] = month.split("-").map(Number);
  const next = new Date(y, m, 1);
  return {
    from:        `${month}-01`,
    toExclusive: `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-01`,
  };
}

function thaiMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("th-TH", { month: "long", year: "numeric" })
    .format(new Date(y, m - 1, 1));
}

// ── Business logic ────────────────────────────────────────────────────────────

type TxRow = {
  transaction_date: string | null;
  transaction_time: string | null;
  market_name:      string | null;
  staff_name:       string;
  transaction_type: string;
  total_amount:     number | null;
  product_name:     string;
  unit:             string | null;
  quantity:         number | null;
  price_per_unit:   number | null;
  raw_message_id:   string | null;
  source_id?:       string | null;
};

function validSourceId(sourceId: string | null | undefined): string | null {
  return sourceId && sourceId !== "unknown" ? sourceId : null;
}

function buildGroups(rows: TxRow[]): GroupRow[] {
  const map = new Map<string, GroupRow>();
  const quantityRows = new Map<string, TxRow[]>();

  for (const r of rows) {
    if (!isKnownTransactionType(r.transaction_type)) continue;

    const date   = r.transaction_date ?? "ไม่ระบุวันที่";
    const time   = r.transaction_time ?? null;
    const seller = r.staff_name        || "ไม่ระบุ";
    const market = displayMarketName(r.market_name, "ไม่ระบุ");
    const key    = `${date}||${time ?? ""}||${seller}||${market}`;
    const amt    = r.total_amount ?? 0;
    const quantityGroup = quantityRows.get(key) ?? [];
    quantityGroup.push(r);
    quantityRows.set(key, quantityGroup);

    if (!map.has(key)) {
      map.set(key, { date, time, seller, market, ...emptyTransactionTotals() });
    }
    const g = map.get(key)!;
    addTransactionAmount(g, { transaction_type: r.transaction_type, total_amount: amt });

    const sourceId = validSourceId(r.source_id);
    if (!sourceId) continue;

    const existing = g.sourceId;
    if (existing === undefined) {
      g.sourceId = sourceId;
    } else if (existing !== sourceId) {
      g.sourceId = null;
    }
  }

  return Array.from(map.values())
    .map((g) => {
      const key = `${g.date}||${g.time ?? ""}||${g.seller}||${g.market}`;
      const quantityIntegrity = produceFinancialIntegrity(quantityRows.get(key) ?? []);
      const integrity: GroupRow["produceNetStatus"] = quantityIntegrity === "returns_exceed_withdrawal"
        || produceNetStatus(g) === "returns_exceed_withdrawal"
        ? "returns_exceed_withdrawal"
        : "trusted";
      return { ...g, ยอดส่ง: calculateYodSong(g), produceNetStatus: integrity };
    })
    .sort((a, b) =>
      a.date.localeCompare(b.date) ||
      (a.time ?? "").localeCompare(b.time ?? "") ||
      a.seller.localeCompare(b.seller)
    );
}

async function fetchAllTxRows(
  supabase: Awaited<ReturnType<typeof createServiceClient>>,
  from: string,
  toExclusive: string,
): Promise<TxRow[]> {
  const PAGE = 1000;
  const all: TxRow[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from("produce_transactions")
      .select("transaction_date, transaction_time, market_name, staff_name, transaction_type, total_amount, raw_message_id, product_name, unit, quantity, price_per_unit")
      .gte("transaction_date", from)
      .lt("transaction_date",  toExclusive)
      .in("transaction_type",  KNOWN_TX_TYPES as unknown as string[])
      .range(offset, offset + PAGE - 1);

    if (error) throw new Error(error.message);
    all.push(...((data ?? []) as TxRow[]));
    if (!data || data.length < PAGE) break;
    offset += PAGE;
  }

  return all;
}

async function addSourceIds(
  supabase: Awaited<ReturnType<typeof createServiceClient>>,
  rows: TxRow[],
): Promise<TxRow[]> {
  const rawMessageIds = Array.from(new Set(
    rows.map(row => row.raw_message_id).filter((id): id is string => Boolean(id)),
  ));
  if (rawMessageIds.length === 0) return rows;

  const { data, error } = await supabase
    .from("raw_messages")
    .select("id, source_id")
    .in("id", rawMessageIds);

  if (error) throw new Error(error.message);

  const sourceByRawMessageId = new Map(
    (data ?? []).map(row => [row.id as string, row.source_id as string | null]),
  );

  return rows.map(row => ({
    ...row,
    source_id: row.raw_message_id ? sourceByRawMessageId.get(row.raw_message_id) ?? null : null,
  }));
}

async function getPageData(month: string): Promise<{
  groups:      GroupRow[];
  settlements: SettlementEntry[];
}> {
  const supabase = await createServiceClient();
  const { from, toExclusive } = monthDateRange(month);

  const [txRows, settlResult] = await Promise.all([
    fetchAllTxRows(supabase, from, toExclusive).then(rows => addSourceIds(supabase, rows)),
    supabase
      .from("settlement_entries")
      .select("settlement_date, settlement_time, staff_name, market_name, money_transfer, money_cash, expenses, labor")
      .gte("settlement_date", from)
      .lt("settlement_date",  toExclusive),
  ]);

  if (settlResult.error) throw new Error(settlResult.error.message);

  return {
    groups:      buildGroups(txRows),
    settlements: (settlResult.data ?? []) as SettlementEntry[],
  };
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function FinancialSummaryPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const now    = new Date();
  const defaultMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const month  = params.month ?? defaultMonth;

  const { groups, settlements } = await timed("financial-summary", () => getPageData(month));

  const prev          = shiftMonth(month, -1);
  const next          = shiftMonth(month, +1);
  const isLatestMonth = month >= defaultMonth;

  return (
    <>
      <DashboardTopBar title="สรุปการเงิน" />

      <div className="p-4 sm:p-6 space-y-5">

        {/* Month navigation */}
        <div className="flex items-center justify-between gap-2">
          <Link
            href={`/financial-summary?month=${prev}`}
            className="flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 transition-colors"
          >
            <svg className="size-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
            </svg>
            เดือนก่อน
          </Link>

          <div className="flex items-center gap-3">
            <h2 className="text-base font-semibold text-slate-800">{thaiMonth(month)}</h2>
            <a
              href={`/api/pdf/financial-summary?month=${month}`}
              className="flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100 transition-colors"
            >
              <svg className="size-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m.75 12 3 3m0 0 3-3m-3 3v-6m-1.5-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
              </svg>
              Export PDF
            </a>
          </div>

          <Link
            href={`/financial-summary?month=${next}`}
            className={`flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 transition-colors ${
              isLatestMonth ? "invisible pointer-events-none" : ""
            }`}
          >
            เดือนถัดไป
            <svg className="size-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
            </svg>
          </Link>
        </div>

        <FinancialTable
          groups={groups}
          initialSettlements={settlements}
        />

      </div>
    </>
  );
}
