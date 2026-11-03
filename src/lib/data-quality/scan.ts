/**
 * Data Quality Inbox — the ONE scan/upsert function.
 *
 * Gathers candidates from every wired source (produce preflight, financial
 * reconciliation, and Daily Financial Settlement), then
 * persists the complete set through inbox.ts. Exposed by the authenticated,
 * cron-compatible route at src/app/api/cron/data-quality-scan/route.ts;
 * the Production scheduler calls this route daily. Safe to call again for the same
 * business date — see inbox.ts for the idempotent lifecycle contract.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { runDailyClosePreflight } from "@/lib/produce/preflight-service";
import { fetchReconciliationReport } from "@/lib/reconciliation-report-service";
import { preflightIssuesToCandidates } from "./sources/preflight-source";
import { reconciliationRowsToCandidates } from "./sources/reconciliation-source";
import {
  createFinancialSettlementPort,
  type FinancialSettlementPort,
  type FinancialSettlementSignal,
} from "./adapters/financial-settlement-port";
import { upsertDataQualityIssuesAtomically } from "./inbox";
import type { DataQualityCategory } from "./severity";
import type { DataQualityIssueCandidate, DataQualityIssueRow } from "./types";

type Supabase = SupabaseClient<Database>;

function categoryForSettlementSignal(kind: FinancialSettlementSignal["kind"]): DataQualityCategory {
  switch (kind) {
    case "mismatch":
      return "financial_settlement_mismatch";
    case "incomplete_evidence":
      return "financial_evidence_incomplete";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** Pure: every settlement signal becomes exactly one candidate. None dropped. */
export function financialSettlementSignalsToCandidates(
  signals: readonly FinancialSettlementSignal[],
): DataQualityIssueCandidate[] {
  return signals.map((signal) => ({
    category: categoryForSettlementSignal(signal.kind),
    businessDate: signal.businessDate,
    entityRefs: signal.entityRefs,
    summaryTh: signal.summaryTh,
    technicalContext: signal.technicalContext,
  }));
}

export interface ScanDataQualityIssuesOptions {
  /** Optional test override. Production defaults to the real settlement adapter. */
  financialSettlementPort?: FinancialSettlementPort;
}

export interface ScanDataQualityIssuesResult {
  businessDate: string;
  candidateCount: number;
  upserts: DataQualityIssueRow[];
}

export async function scanDataQualityIssues(
  supabase: Supabase,
  businessDate: string,
  options: ScanDataQualityIssuesOptions = {},
): Promise<ScanDataQualityIssuesResult> {
  const settlementPort = options.financialSettlementPort ?? createFinancialSettlementPort(supabase);
  // The occurrence time is captured before discovery. If an operator resolves
  // or ignores an issue while the scan is loading, the older observation must
  // not overwrite that newer human decision when the RPC eventually commits.
  const observedAt = new Date().toISOString();

  const [preflight, reconciliation, settlementSignals] = await Promise.all([
    runDailyClosePreflight(supabase, businessDate),
    fetchReconciliationReport(supabase, { fromDate: businessDate, toDate: businessDate }),
    settlementPort.getSignals(businessDate),
  ]);

  const candidates: DataQualityIssueCandidate[] = [
    ...preflightIssuesToCandidates(preflight, businessDate),
    ...reconciliationRowsToCandidates(reconciliation.rows),
    ...financialSettlementSignalsToCandidates(settlementSignals),
  ];

  const upserts = await upsertDataQualityIssuesAtomically(supabase, candidates, observedAt);

  return { businessDate, candidateCount: candidates.length, upserts };
}
