import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { displayMarketName } from "@/lib/market";
import {
  deriveReconciliationStatus,
  filterByStatus,
  summarizeReconciliationReport,
  type ReconciliationReportRow,
  type ReconciliationStatusFilter,
  type ReconciliationSummary,
} from "@/lib/reconciliation-report";

type Supabase = SupabaseClient<Database>;

export interface ReconciliationReportFilters {
  fromDate: string;
  toDate: string;
  market?: string;
  status?: ReconciliationStatusFilter;
}

export interface ReconciliationReportResult {
  rows: ReconciliationReportRow[];
  summary: ReconciliationSummary;
  markets: string[];
}

function keyOf(sourceId: string, businessDate: string, roundId: string | null | undefined): string {
  return `${sourceId}|${businessDate}|${roundId ?? "legacy"}`;
}

/**
 * Round-aware reconciliation report. Financial rows are never joined only on
 * source+date: accountability_round_id is part of the identity whenever it is
 * present. Legacy null-round activity remains one explicit legacy scope; if it
 * carries conflicting market labels the financial row is withheld so the
 * report surfaces missing_data instead of silently choosing one market.
 */
export async function fetchReconciliationReport(
  supabase: Supabase,
  filters: ReconciliationReportFilters,
): Promise<ReconciliationReportResult> {
  const { fromDate, toDate } = filters;

  const [reconRes, sessionRes, settlementRes] = await Promise.all([
    supabase
      .from("transfer_reconciliations")
      .select(
        "source_id, business_date, accountability_round_id, ai_verified_total, manual_slip_total, checked_slip_total, submitted_transfer_total, difference, matched",
      )
      .gte("business_date", fromDate)
      .lte("business_date", toDate),
    supabase
      .from("manual_slip_sessions")
      .select("source_id, business_date, accountability_round_id, market_label, status")
      .gte("business_date", fromDate)
      .lte("business_date", toDate),
    supabase
      .from("settlement_entries")
      .select("source_id, settlement_date, accountability_round_id, market_name")
      .gte("settlement_date", fromDate)
      .lte("settlement_date", toDate),
  ]);

  if (reconRes.error) throw new Error(`transfer_reconciliations query failed: ${reconRes.error.message}`);
  if (sessionRes.error) throw new Error(`manual_slip_sessions query failed: ${sessionRes.error.message}`);
  if (settlementRes.error) throw new Error(`settlement_entries query failed: ${settlementRes.error.message}`);

  type Activity = {
    source_id: string;
    business_date: string;
    accountability_round_id: string | null;
  };

  const marketLabelsByKey = new Map<string, Set<string>>();
  const openSessions = new Set<string>();
  const activityKeys = new Map<string, Activity>();

  const rememberMarket = (key: string, raw: string | null | undefined) => {
    const label = displayMarketName(raw ?? null, "");
    if (!label) return;
    const labels = marketLabelsByKey.get(key) ?? new Set<string>();
    labels.add(label);
    marketLabelsByKey.set(key, labels);
  };

  for (const row of sessionRes.data ?? []) {
    const roundId = row.accountability_round_id ?? null;
    const key = keyOf(row.source_id, row.business_date, roundId);
    activityKeys.set(key, { source_id: row.source_id, business_date: row.business_date, accountability_round_id: roundId });
    if (row.status === "open") openSessions.add(key);
    rememberMarket(key, row.market_label);
  }

  for (const row of settlementRes.data ?? []) {
    if (!row.source_id) continue;
    const roundId = row.accountability_round_id ?? null;
    const key = keyOf(row.source_id, row.settlement_date, roundId);
    activityKeys.set(key, { source_id: row.source_id, business_date: row.settlement_date, accountability_round_id: roundId });
    rememberMarket(key, row.market_name);
  }

  const reconByKey = new Map<string, (typeof reconRes.data)[number]>();
  for (const row of reconRes.data ?? []) {
    const roundId = row.accountability_round_id ?? null;
    const key = keyOf(row.source_id, row.business_date, roundId);
    if (reconByKey.has(key)) {
      throw new Error(`duplicate reconciliation identity: ${key}`);
    }
    reconByKey.set(key, row);
    activityKeys.set(key, { source_id: row.source_id, business_date: row.business_date, accountability_round_id: roundId });
  }

  const rows: ReconciliationReportRow[] = [];
  for (const [key, activity] of activityKeys) {
    const labels = marketLabelsByKey.get(key) ?? new Set<string>();
    const ambiguousMarketIdentity = labels.size > 1;
    const recon = ambiguousMarketIdentity ? null : (reconByKey.get(key) ?? null);
    const hasOpenManualSession = openSessions.has(key);
    const market = labels.size === 1
      ? [...labels][0]
      : labels.size > 1
        ? [...labels].sort((a, b) => a.localeCompare(b, "th")).join(" / ")
        : activity.source_id;

    const difference = recon ? Number(recon.difference) : null;
    const status = deriveReconciliationStatus({
      hasReconciliation: recon != null,
      hasOpenManualSession,
      difference,
    });

    rows.push({
      source_id: activity.source_id,
      business_date: activity.business_date,
      accountability_round_id: activity.accountability_round_id,
      market,
      submitted_transfer_total: recon ? Number(recon.submitted_transfer_total) : null,
      ai_verified_total: recon ? Number(recon.ai_verified_total) : null,
      manual_slip_total: recon ? Number(recon.manual_slip_total) : null,
      checked_slip_total: recon ? Number(recon.checked_slip_total) : null,
      difference,
      status,
      has_open_manual_session: hasOpenManualSession,
    });
  }

  rows.sort((a, b) =>
    b.business_date.localeCompare(a.business_date)
    || a.market.localeCompare(b.market, "th")
    || (a.accountability_round_id ?? "").localeCompare(b.accountability_round_id ?? ""));

  const markets = Array.from(new Set(rows.map((row) => row.market)))
    .sort((a, b) => a.localeCompare(b, "th"));

  let filtered = filters.market
    ? rows.filter((row) => row.market === filters.market)
    : rows;
  filtered = filterByStatus(filtered, filters.status);

  return {
    rows: filtered,
    summary: summarizeReconciliationReport(filtered),
    markets,
  };
}
