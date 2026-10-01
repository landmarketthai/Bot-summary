import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { pushLineMessage } from "@/lib/line/reply";
import { buildSettlementLineMessage } from "@/lib/line/settlement-message";
import { displayMarketName } from "@/lib/market";
import {
  KNOWN_TX_TYPES,
  calculateSettlementTotals,
  summarizeProduceTransactionRows,
  produceNetStatus,
} from "@/lib/summary/transactions";
import { submitSettlementEntryForSource } from "@/lib/settlement/submit-entry";
import { loadSettlementProduceValueStatus } from "@/lib/settlement/produce-value-status";
import { produceFinancialIntegrity } from "@/lib/settlement/produce-financial-integrity";

function monthRange(month: string): { from: string; toExclusive: string } {
  const [y, m] = month.split("-").map(Number);
  const next = new Date(y, m, 1);
  return {
    from:        `${month}-01`,
    toExclusive: `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-01`,
  };
}

export async function GET(req: NextRequest) {
  const month = req.nextUrl.searchParams.get("month");
  if (!month) return NextResponse.json({ error: "month required" }, { status: 400 });

  const { from, toExclusive } = monthRange(month);
  const supabase = await createServiceClient();

  const { data, error } = await supabase
    .from("settlement_entries")
    .select("*")
    .gte("settlement_date", from)
    .lt("settlement_date", toExclusive);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

export async function POST(req: NextRequest) {
  const body = await req.json() as {
    settlement_date: string;
    settlement_time?: string;
    staff_name?:      string;
    market_name?:     string;
    money_transfer?:  number;
    money_cash?:      number;
    expenses?:        number;
    labor?:           number;
    notes?:           string;
    notify_line?:     boolean;
    source_id?:       string;
  };

  const { settlement_date, settlement_time = "", staff_name = "", market_name = "",
          money_transfer = 0, money_cash = 0, expenses = 0, labor = 0, notes = "",
          notify_line = false, source_id } = body;

  if (!settlement_date) return NextResponse.json({ error: "settlement_date required" }, { status: 400 });

  const supabase = await createServiceClient();

  // If source_id provided, check for open manual slip sessions before saving.
  // The reconcile → upsert → finalize contract lives in one place so the LINE
  // guided flow submits through the SAME boundary (see settlement/submit-entry).
  if (source_id) {
    const submitted = await submitSettlementEntryForSource(supabase, source_id, {
      settlement_date, settlement_time, staff_name, market_name,
      money_transfer, money_cash, expenses, labor, notes,
    });

    if (submitted.status === "blocked") {
      return NextResponse.json({ error: submitted.reason }, { status: 400 });
    }
    if (submitted.status === "failed") {
      return NextResponse.json({ error: submitted.reason }, { status: 500 });
    }

    return NextResponse.json({
      ...submitted.entry,
      finalizeStatus: submitted.finalizeStatus,
      reconciliation: submitted.reconciliation,
    });
  }

  // No source_id — existing behavior (backward compat, no reconciliation).
  const { data, error } = await supabase
    .from("settlement_entries")
    .upsert(
      { settlement_date, settlement_time, staff_name, market_name,
        money_transfer, money_cash, expenses, labor, notes,
        accountability_round_id: null, updated_at: new Date().toISOString() },
      {
        onConflict:
          "settlement_date,settlement_time,staff_name,market_name,accountability_round_id",
      },
    )
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let lineTargets = 0;
  let lineError: string | null = null;

  if (notify_line) {
    ({ lineTargets, lineError } = await sendLineNotification(supabase, {
      settlement_date, staff_name, market_name, money_transfer, money_cash, expenses, labor, notes,
    }));
  }

  return NextResponse.json({ ...data, lineTargets, lineError });
}

async function sendLineNotification(
  supabase: Awaited<ReturnType<typeof createServiceClient>>,
  params: {
    settlement_date: string;
    staff_name:      string;
    market_name:     string;
    money_transfer:  number;
    money_cash:      number;
    expenses:        number;
    labor:           number;
    notes:           string;
  },
): Promise<{ lineTargets: number; lineError: string | null }> {
  let lineTargets = 0;
  let lineError: string | null = null;
  try {
    const { transactions, presence, sourceIds, effectiveRowCount, quantityIntegrity } = await getSettlementContext(supabase, {
      settlement_date: params.settlement_date,
      staff_name:      params.staff_name,
      market_name:     params.market_name,
    });
    const settlement = calculateSettlementTotals({
      ยอดส่ง:        transactions.ยอดส่ง,
      money_transfer: params.money_transfer,
      money_cash:     params.money_cash,
      expenses:       params.expenses,
      labor:          params.labor,
    });
    let produceValueStatus = await loadSettlementProduceValueStatus(
      supabase,
      params.settlement_date,
      {
        staffName: params.staff_name,
        marketName: params.market_name,
      },
      effectiveRowCount,
    );
    if (
      quantityIntegrity === "returns_exceed_withdrawal"
      || produceNetStatus(transactions) === "returns_exceed_withdrawal"
    ) {
      produceValueStatus = "invalid";
    }
    const message = buildSettlementLineMessage({
      date:        params.settlement_date,
      staffName:   params.staff_name,
      marketName:  params.market_name,
      transactions,
      produceValueStatus,
      producePresence: presence,
      settlement,
      notes:       params.notes,
    });
    for (const sourceId of sourceIds) {
      await pushLineMessage(sourceId, message);
      lineTargets += 1;
    }
  } catch (err) {
    lineError = err instanceof Error ? err.message : "LINE notification failed";
  }
  return { lineTargets, lineError };
}

async function getSettlementContext(
  supabase: Awaited<ReturnType<typeof createServiceClient>>,
  params: { settlement_date: string; staff_name: string; market_name: string },
) {
  const { settlement_date, staff_name, market_name } = params;
  let query = supabase
    .from("produce_transactions")
    .select("transaction_type, total_amount, market_name, raw_message_id, product_name, unit, quantity, price_per_unit")
    .eq("transaction_date", settlement_date)
    .in("transaction_type", KNOWN_TX_TYPES as unknown as string[]);

  if (staff_name) query = query.eq("staff_name", staff_name);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const marketLabel = displayMarketName(market_name, "");
  const rows = (data ?? []).filter(row => {
    if (!marketLabel) return true;
    return displayMarketName(row.market_name ?? "", "") === marketLabel || row.market_name === market_name;
  });

  const { totals: transactions, presence, effectiveRowCount } = summarizeProduceTransactionRows(
    rows.map((row) => ({
      transaction_type: row.transaction_type as string,
      total_amount: row.total_amount,
    })),
  );

  const quantityIntegrity = produceFinancialIntegrity(rows.map((row) => ({
    product_name: row.product_name as string,
    unit: row.unit as string | null,
    quantity: row.quantity as number | null,
    price_per_unit: row.price_per_unit as number | null,
    transaction_type: row.transaction_type as string,
  })));

  const rawMessageIds = Array.from(new Set(
    rows.map(row => row.raw_message_id as string | null).filter((id): id is string => Boolean(id)),
  ));
  if (rawMessageIds.length === 0) {
    return { transactions, presence, sourceIds: [] as string[], effectiveRowCount, quantityIntegrity };
  }

  const { data: rawRows, error: rawError } = await supabase
    .from("raw_messages")
    .select("source_id")
    .in("id", rawMessageIds);
  if (rawError) throw new Error(rawError.message);

  const sourceIds = Array.from(new Set(
    (rawRows ?? []).map(row => row.source_id as string | null).filter((id): id is string => Boolean(id)),
  ));
  return { transactions, presence, sourceIds, effectiveRowCount, quantityIntegrity };
}
