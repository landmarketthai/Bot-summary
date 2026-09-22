/**
 * The one call every surface makes to ask "can this business date be closed?".
 *
 * Kept apart from daily-close-preflight.ts so the classification module stays
 * free of the Sales loader's weight — and so the crons, the LINE command and
 * any future admin endpoint provably run the SAME query set in the same order.
 *
 * The failure scan is the expensive part and is optional: a caller that already
 * built one (the 08:10 report does) hands it in, and the preflight and the
 * report are then guaranteed to be talking about the same set of failures.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  fetchSalesProduceRows,
  loadProduceFailureScan,
  type ProduceFailureScan,
} from "@/lib/sales/load";
import type { WithdrawalPriceRow } from "./central-price-candidates";
import {
  loadDailyClosePreflight,
  type DailyClosePreflightResult,
} from "./daily-close-preflight";
import type { RoundReturnStatus } from "./round-return-status";

type Supabase = SupabaseClient<Database>;

export interface RunDailyClosePreflightOptions {
  failures?: ProduceFailureScan;
  rows?: Awaited<ReturnType<typeof fetchSalesProduceRows>>;
  roundStatuses?: readonly RoundReturnStatus[];
}

export async function runDailyClosePreflight(
  supabase: Supabase,
  businessDate: string,
  options: RunDailyClosePreflightOptions = {},
): Promise<DailyClosePreflightResult> {
  const [rows, failures] = await Promise.all([
    options.rows
      ? Promise.resolve(options.rows)
      : fetchSalesProduceRows(supabase, businessDate),
    options.failures
      ? Promise.resolve(options.failures)
      : loadProduceFailureScan(supabase, businessDate),
  ]);

  const withdrawalRows: WithdrawalPriceRow[] = rows.map((row) => ({
    productName: row.product_name,
    unit: row.unit,
    marketName: row.market_name,
    pricePerUnit: row.price_per_unit === null ? null : Number(row.price_per_unit),
    basisQuantity: row.basis_quantity === null ? null : Number(row.basis_quantity),
    baseTransactionType: row.base_transaction_type,
    accountabilityRoundId: row.accountability_round_id,
  }));

  return loadDailyClosePreflight(supabase, businessDate, {
    failureAttempts: failures.attempts,
    withdrawalRows,
    outcomes: failures.evidence.outcomes,
    cancelledRoundIds: failures.evidence.cancelledRoundIds,
    roundStatuses: options.roundStatuses,
    produceRows: rows,
  });
}
