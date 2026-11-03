import type { SupabaseClient } from "@supabase/supabase-js";
import { bangkokBusinessDateFromTimestamp } from "@/lib/business-date";
import { normalizedMarketLabel } from "@/lib/market";
import { slipDateIneligibility, type SlipDateIneligibility } from "@/lib/slips/financial-eligibility";
import { normalizeTransactionId, resolveGloballyAcceptedCheckIds } from "@/lib/slips/transaction-dedupe";
import { computeValidationFlags } from "@/lib/slips/validation-guard";
import {
  isMissingSchemaObject,
  loadActiveDecisions,
  loadReferenceIndex,
  normalizeSlipReference,
  ownershipFor,
  type ReferenceCredit,
} from "@/lib/slips/reference-ownership";
import type { Database, SlipCheckStatus, SlipType, TransferReconciliationRow } from "@/types/database";

type Supabase = SupabaseClient<Database>;

export interface ReconciliationResult {
  ai_verified_total:        number;
  manual_slip_total:        number;
  checked_slip_total:       number;
  submitted_transfer_total: number;
  difference:               number;
  matched:                  boolean;
}

export interface VerifiedTransferCheckRow {
  id:               string;
  evidence_id:      string;
  transfer_amount:  number;
  reference_id:     string | null;
  created_at:       string;
  /**
   * Shared date rule (financial-eligibility.ts) against the business date the
   * row was loaded for; null = eligible. Required so no caller can skip it.
   */
  date_ineligibility: SlipDateIneligibility | null;
  /**
   * The LINE batch summary suspended this amount as ยอดเงินสูงผิดปกติ (same
   * computeValidationFlags, same stored batch rows). Required, like the date.
   */
  amount_outlier: boolean;
  /**
   * Active operator decision on this AI check (slip_check_approvals). Absent =
   * no decision, which can never add money. Approved counts approved_amount
   * once in place of the AI read, past the date/outlier rules; rejected never
   * counts.
   */
  approval?: { decision: "approved"; amount: number } | { decision: "rejected" } | null;
  /** An earlier counted manual entry owns this reference (slips/reference-ownership.ts). */
  superseded_by_manual?: boolean;
  /**
   * Persisted credit of this row's reference (slip_reference_claims): owner =
   * this check is the credited money row, at `amount`, final; elsewhere =
   * another row is; late = this row's own scope already settled without it.
   */
  credit?: { kind: "owner"; amount: number } | { kind: "elsewhere" } | { kind: "late" } | null;
}

/** A money row a finalization credits to its reference (claimFinalizationReferences). */
export interface CreditedReference {
  reference: string;
  slipCheckId?: string;
  manualEntryId?: string;
  amount: number;
}

export interface MarketScopedVerifiedTransferResult {
  attributedTotal:           number;
  unresolvedAcceptedCount:   number;
  unresolvedAcceptedAmount:  number;
  /** BR-02: accepted checks with no reference id yet — pending manual resolution, never auto-counted. */
  pendingReferenceCount:     number;
  pendingReferenceAmount:    number;
  /**
   * Global winners whose printed date is missing or outside the round — the
   * same slips the LINE summary leaves รอตรวจสอบ. Never auto-counted; an
   * operator adds a confirmed one through a closed manual-slip session.
   */
  pendingDateCount:          number;
  pendingDateAmount:         number;
  /** Global winners the LINE batch summary suspended as ยอดเงินสูงผิดปกติ. Never auto-counted. */
  pendingOutlierCount:       number;
  pendingOutlierAmount:      number;
  /** Global winners counted through an operator approval (amount is inside attributedTotal). */
  approvedCount?:            number;
  /** Global winners an operator rejected: never counted. */
  rejectedCount?:            number;
  rejectedAmount?:           number;
  /** Live AI reads whose reference an earlier counted manual entry already owns. */
  supersededByManualCount?:  number;
  supersededByManualAmount?: number;
  /** Referenced reads that arrived after this scope settled without them: pending, never counted. */
  pendingLateCount?:         number;
  pendingLateAmount?:        number;
  /** Referenced money rows counted here (what a finalization credits). */
  credited?:                 CreditedReference[];
}

export interface MarketScopedAggregationOptions {
  marketLabelNormalized: string;
  /** Canonical produce markets for source+date. Required for market scoping. */
  knownMarkets: ReadonlySet<string>;
}

// business_date (ISO) 04:00 Bangkok = prev day 21:00 UTC.
export function businessDateToUtcRange(businessDate: string): { startUtc: string; endUtc: string } {
  const [y, m, d] = businessDate.split("-").map(Number);
  const prevDay = new Date(Date.UTC(y, m - 1, d) - 86_400_000).toISOString().slice(0, 10);
  return {
    startUtc: `${prevDay}T21:00:00Z`,
    endUtc:   `${businessDate}T21:00:00Z`,
  };
}

/**
 * Applies global reference dedupe first, then optionally scopes accepted winners
 * to one canonical market label against known produce markets for the source/date.
 *
 * BR-02: an accepted check with no reference id is never auto-counted — it is
 * reported separately as pending manual reference resolution (see
 * src/lib/slips/reference-resolution.ts) and must not contribute to
 * attributedTotal until an authorized reviewer supplies a reference id, at
 * which point it flows through this SAME global-winner/market classification
 * on the next load — no separate duplicate check is invented for it.
 *
 * Classification (after the no-reference / global-dedupe gate):
 * A. empty/null market → unresolved
 * B. known + equals requested → attributed
 * C. known + other market → skip (not unresolved)
 * D. non-empty but not in knownMarkets → unresolved (HARD STOP upstream)
 */
export function aggregateGloballyAcceptedVerifiedTransfers(
  checks: readonly VerifiedTransferCheckRow[],
  evidenceMarketById: ReadonlyMap<string, string | null>,
  globalWinners: ReadonlySet<string>,
  options?: MarketScopedAggregationOptions,
): MarketScopedVerifiedTransferResult {
  const targetMarket = options?.marketLabelNormalized;
  const knownMarkets = options?.knownMarkets;
  if (targetMarket !== undefined && !knownMarkets) {
    throw new Error("knownMarkets is required when marketLabelNormalized is set");
  }

  const countedWinnerReferences = new Set<string>();
  let attributedTotal = 0;
  let unresolvedAcceptedCount = 0;
  let unresolvedAcceptedAmount = 0;
  let pendingReferenceCount = 0;
  let pendingReferenceAmount = 0;
  let pendingDateCount = 0;
  let pendingDateAmount = 0;
  let pendingOutlierCount = 0;
  let pendingOutlierAmount = 0;
  let approvedCount = 0;
  let rejectedCount = 0;
  let rejectedAmount = 0;
  let supersededByManualCount = 0;
  let supersededByManualAmount = 0;
  let pendingLateCount = 0;
  let pendingLateAmount = 0;
  const credited: CreditedReference[] = [];
  const creditedReferences = new Set<string>();
  // The global winner is chosen exactly as before (earliest verified check).
  // A winner that is suspended (outlier) or has a bad date is pending — it
  // never falls through to a later duplicate, so one reference can never be
  // counted twice or re-assigned to a different read without evidence. An
  // operator decision on the winner replaces the automatic rules for it: the
  // check is still ONE money row, counted at most once.
  // A credited reference (slip_reference_claims) is final: its owner row counts
  // the credited amount, every other row of it is superseded, and a referenced
  // row its own settled scope did not credit is late (pending).
  const attribute = (check: VerifiedTransferCheckRow, ref: string) => {
    if (check.credit?.kind === "owner") {
      attributedTotal += check.credit.amount;
      credited.push({ reference: ref, slipCheckId: check.id, amount: check.credit.amount });
      return;
    }
    if (check.credit?.kind === "elsewhere") {
      supersededByManualCount += 1;
      supersededByManualAmount += Number(check.transfer_amount);
      return;
    }
    if (check.credit?.kind === "late") {
      pendingLateCount += 1;
      pendingLateAmount += Number(check.transfer_amount);
      return;
    }
    if (check.superseded_by_manual) {
      supersededByManualCount += 1;
      supersededByManualAmount += Number(check.transfer_amount);
      return;
    }
    if (check.approval?.decision === "rejected") {
      rejectedCount += 1;
      rejectedAmount += Number(check.transfer_amount);
      return;
    }
    if (check.approval?.decision === "approved") {
      approvedCount += 1;
      attributedTotal += check.approval.amount;
      credited.push({ reference: ref, slipCheckId: check.id, amount: check.approval.amount });
      return;
    }
    if (check.amount_outlier) {
      pendingOutlierCount += 1;
      pendingOutlierAmount += Number(check.transfer_amount);
      return;
    }
    if (check.date_ineligibility !== null) {
      pendingDateCount += 1;
      pendingDateAmount += Number(check.transfer_amount);
      return;
    }
    attributedTotal += Number(check.transfer_amount);
    // An accepted zero OCR read adds no money and must not consume a positive-only credit.
    if (Number(check.transfer_amount) > 0) {
      credited.push({ reference: ref, slipCheckId: check.id, amount: Number(check.transfer_amount) });
    }
  };

  for (const check of checks) {
    const ref = normalizeTransactionId(check.reference_id);
    if (!ref) {
      // BR-02: no reference id yet — pending manual resolution, never counted.
      pendingReferenceCount += 1;
      pendingReferenceAmount += Number(check.transfer_amount);
      continue;
    }
    if (check.credit?.kind === "owner") {
      // The credited row counts even when it is not the earliest read.
      if (creditedReferences.has(ref)) continue;
      creditedReferences.add(ref);
    } else {
      if (!globalWinners.has(check.id) || countedWinnerReferences.has(ref)) continue;
      countedWinnerReferences.add(ref);
    }

    if (targetMarket === undefined || !knownMarkets) {
      attribute(check, ref);
      continue;
    }

    const evidenceMarket = evidenceMarketById.get(check.evidence_id) ?? null;
    if (!evidenceMarket) {
      unresolvedAcceptedCount += 1;
      unresolvedAcceptedAmount += Number(check.transfer_amount);
      continue;
    }
    if (!knownMarkets.has(evidenceMarket)) {
      // Unknown / non-matching market — fail closed (not "another market").
      unresolvedAcceptedCount += 1;
      unresolvedAcceptedAmount += Number(check.transfer_amount);
      continue;
    }
    if (evidenceMarket === targetMarket) attribute(check, ref);
  }

  return {
    attributedTotal,
    unresolvedAcceptedCount,
    unresolvedAcceptedAmount,
    pendingReferenceCount,
    pendingReferenceAmount,
    pendingDateCount,
    pendingDateAmount,
    pendingOutlierCount,
    pendingOutlierAmount,
    approvedCount,
    rejectedCount,
    rejectedAmount,
    supersededByManualCount,
    supersededByManualAmount,
    pendingLateCount,
    pendingLateAmount,
    credited,
  };
}

export async function loadVerifiedTransferChecksForSourceDate(
  supabase:     Supabase,
  sourceId:     string,
  businessDate: string,
  accountabilityRoundId?: string | null,
): Promise<{
  checks: VerifiedTransferCheckRow[];
  evidenceMarketById: Map<string, string | null>;
}> {
  const { startUtc, endUtc } = businessDateToUtcRange(businessDate);

  // Trusted financial identity uses raw market_label + canonical TS helper.
  // market_label_normalized (SQL trim/NFC) is storage/index only — not trusted alone.
  let evidenceQuery = supabase
    .from("slip_evidences")
    .select("id, market_label, batch_id")
    .eq("source_id", sourceId);

  if (accountabilityRoundId !== undefined && accountabilityRoundId !== null) {
    // A persisted round binding is authoritative business identity. Do not
    // discard a valid round-bound slip merely because its image arrived after
    // that round's 04:00 receipt-time window.
    evidenceQuery = evidenceQuery.eq("accountability_round_id", accountabilityRoundId);
  } else {
    // Legacy/unbound evidence has no stronger identity, so receipt-time remains
    // the only safe business-date attribution boundary.
    evidenceQuery = evidenceQuery
      .gte("received_at", startUtc)
      .lt("received_at", endUtc);
    if (accountabilityRoundId === null) {
      evidenceQuery = evidenceQuery.is("accountability_round_id", null);
    }
  }
  const { data: evidences, error: evidenceError } = await evidenceQuery;
  if (evidenceError) {
    throw new Error(`slip evidence query failed: ${evidenceError.message}`);
  }

  const evidenceMarketById = new Map<string, string | null>();
  for (const evidence of evidences ?? []) {
    const canonical = normalizedMarketLabel(evidence.market_label);
    evidenceMarketById.set(evidence.id, canonical || null);
  }

  const evidenceIds = [...evidenceMarketById.keys()];
  if (evidenceIds.length === 0) {
    return { checks: [], evidenceMarketById };
  }

  const { data: checks, error: checkError } = await supabase
    .from("slip_checks")
    .select("id, evidence_id, transfer_amount, reference_id, created_at, transaction_time")
    .in("evidence_id", evidenceIds)
    .in("status", ["EXTRACTED", "PARTIAL_EXTRACTED"])
    .not("transfer_amount", "is", null)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (checkError) {
    throw new Error(`slip check query failed: ${checkError.message}`);
  }

  const batchIds = [...new Set((evidences ?? [])
    .map((e) => (e as { batch_id?: string | null }).batch_id)
    .filter((id): id is string => typeof id === "string"))];
  const outliers = await loadBatchOutlierCheckIds(supabase, batchIds);
  const approvals = await loadActiveApprovals(supabase, (checks ?? []).map((c) => c.id));
  const owners = await loadReferenceIndex(supabase, (checks ?? []).map((c) => c.reference_id ?? ""));
  const scope = await loadCreditScope(supabase, sourceId, businessDate, accountabilityRoundId);

  return {
    checks: (checks ?? []).map(({ transaction_time, ...row }) => {
      const ref = normalizeSlipReference(row.reference_id);
      const credit = ref ? owners.credits.get(ref) : undefined;
      const owned = credit !== undefined && credit.slipCheckId === row.id && creditInScope(credit, scope);
      return {
        ...row,
        transfer_amount: Number(row.transfer_amount),
        date_ineligibility: slipDateIneligibility(transaction_time, businessDate),
        amount_outlier: outliers.has(row.id),
        approval: approvals.get(row.id) ?? null,
        superseded_by_manual: ref !== null
          && owners.ai.get(ref)?.id === row.id
          && ownershipFor(owners, ref)?.aiSupersededByManual === true,
        credit: credit
          ? (owned ? { kind: "owner" as const, amount: credit!.amount } : { kind: "elsewhere" as const })
          : scope.frozen && ref ? { kind: "late" as const } : null,
      };
    }),
    evidenceMarketById,
  };
}

/** The settlement scope a loader computes: one finalization key (source, day, round; no round = the legacy day). */
interface CreditScope {
  sourceId: string;
  businessDate: string;
  round: string | null;
  /**
   * Its finalization already recorded credits (20261103100000), in ANY status
   * (a failed row whose push LINE delivered included): from then on its
   * referenced rows count only through a credit, so a late image, entry or
   * retry never moves the settled total.
   */
  frozen: boolean;
}

/** A credit counts only in the scope of the finalization that wrote it; any overlapping view sees it as elsewhere. */
const creditInScope = (credit: ReferenceCredit, scope: CreditScope) =>
  credit.scope !== undefined
  && credit.scope.sourceId === scope.sourceId
  && credit.scope.businessDate === scope.businessDate
  && credit.scope.round === scope.round;

async function loadCreditScope(
  supabase: Supabase,
  sourceId: string,
  businessDate: string,
  accountabilityRoundId?: string | null,
): Promise<CreditScope> {
  const scope: CreditScope = { sourceId, businessDate, round: accountabilityRoundId ?? null, frozen: false };
  let query = supabase.from("settlement_finalizations")
    .select("claims_recorded_at" as "id")
    .eq("source_id", sourceId)
    .eq("business_date", businessDate);
  query = accountabilityRoundId ? query.eq("accountability_round_id", accountabilityRoundId) : query.is("accountability_round_id", null);
  const { data, error } = await query;
  if (error) {
    if (isMissingSchemaObject(error)) return scope;
    throw new Error(`settlement finalization credit lookup failed: ${error.message}`);
  }
  scope.frozen = ((data ?? []) as unknown as Array<{ claims_recorded_at: string | null }>).some((row) => Boolean(row.claims_recorded_at));
  return scope;
}

/**
 * The LINE batch summary's outlier guard, re-run with the SAME function
 * (computeValidationFlags) on the SAME stored rows of each whole batch — every
 * evidence of the batch, not only the in-scope ones, because the batch median
 * is what the summary used. No new rule: a slip the summary suspended as
 * ยอดเงินสูงผิดปกติ is suspended here too. Single-image evidence (no batch)
 * has no outlier guard in either path.
 */
export async function loadBatchOutlierCheckIds(supabase: Supabase, batchIds: string[]): Promise<Set<string>> {
  if (batchIds.length === 0) return new Set();
  const { data: batchEvidences, error: evidenceError } = await supabase
    .from("slip_evidences")
    .select("id, batch_id")
    .in("batch_id", batchIds);
  if (evidenceError) throw new Error(`batch evidence query failed: ${evidenceError.message}`);
  const batchOf = new Map((batchEvidences ?? []).map((e) => [e.id, e.batch_id as string]));
  if (batchOf.size === 0) return new Set();

  const { data: batchChecks, error: checkError } = await supabase
    .from("slip_checks")
    .select("id, evidence_id, status, slip_type, transfer_amount, paid_amount, gross_amount, discount_amount")
    .in("evidence_id", [...batchOf.keys()]);
  if (checkError) throw new Error(`batch check query failed: ${checkError.message}`);

  const byBatch = new Map<string, NonNullable<typeof batchChecks>>();
  for (const check of batchChecks ?? []) {
    const batchId = batchOf.get(check.evidence_id);
    if (!batchId) continue;
    byBatch.set(batchId, [...(byBatch.get(batchId) ?? []), check]);
  }

  const outliers = new Set<string>();
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  for (const rows of byBatch.values()) {
    const flags = computeValidationFlags(rows.map((c) => ({
      checkStatus: c.status as SlipCheckStatus, slipType: c.slip_type as SlipType,
      transferAmount: num(c.transfer_amount), paidAmount: num(c.paid_amount),
      grossAmount: num(c.gross_amount), discountAmount: num(c.discount_amount),
      transactionTime: null, referenceId: null,
    })), null);
    rows.forEach((c, i) => {
      if (flags[i].flagReasons.includes("ยอดเงินสูงผิดปกติ")) outliers.add(c.id);
    });
  }
  return outliers;
}

async function resolveGlobalWinnersForChecks(
  supabase: Supabase,
  checks: readonly VerifiedTransferCheckRow[],
): Promise<Set<string>> {
  const distinctRefs = [...new Set(
    checks
      .map((c) => normalizeTransactionId(c.reference_id))
      .filter((ref): ref is string => ref !== null),
  )];
  const globalWinners = await resolveGloballyAcceptedCheckIds(supabase, distinctRefs);
  if (distinctRefs.length > 0 && globalWinners.size === 0) {
    throw new Error(
      "global reference resolution returned no winners for scoped financial totals",
    );
  }
  return globalWinners;
}

/**
 * Read-only verified-transfer loader shared by reconciliation and white-sheet
 * reporting. It keeps the globally earliest accepted check per non-empty
 * reference ID and deliberately makes no duplicate claim for missing IDs.
 */
export async function loadAiVerifiedTransferTotal(
  supabase:     Supabase,
  sourceId:     string,
  businessDate: string,
  accountabilityRoundId?: string | null,
): Promise<number> {
  const { checks, evidenceMarketById } = await loadVerifiedTransferChecksForSourceDate(
    supabase,
    sourceId,
    businessDate,
    accountabilityRoundId,
  );
  if (checks.length === 0) return 0;

  const globalWinners = await resolveGlobalWinnersForChecks(supabase, checks);
  return aggregateGloballyAcceptedVerifiedTransfers(
    checks,
    evidenceMarketById,
    globalWinners,
  ).attributedTotal;
}

/**
 * Market-scoped verified-transfer loader for Digital White Sheet. Global dedupe
 * runs before market attribution; unattributed / unknown-market accepted winners
 * are reported separately and must trigger fail-closed handling upstream.
 */
export async function loadMarketScopedAiVerifiedTransfers(
  supabase:                Supabase,
  sourceId:                string,
  businessDate:            string,
  marketLabelNormalized:   string,
  knownMarkets:            ReadonlySet<string>,
  accountabilityRoundId?:  string | null,
): Promise<MarketScopedVerifiedTransferResult> {
  const targetMarket = marketLabelNormalized.normalize("NFC").trim();
  if (!targetMarket) {
    throw new Error("marketLabelNormalized must not be empty");
  }

  const { checks, evidenceMarketById } = await loadVerifiedTransferChecksForSourceDate(
    supabase,
    sourceId,
    businessDate,
    accountabilityRoundId,
  );
  if (checks.length === 0) {
    return {
      attributedTotal: 0,
      unresolvedAcceptedCount: 0,
      unresolvedAcceptedAmount: 0,
      pendingReferenceCount: 0,
      pendingReferenceAmount: 0,
      pendingDateCount: 0,
      pendingDateAmount: 0,
      pendingOutlierCount: 0,
      pendingOutlierAmount: 0,
    };
  }

  const globalWinners = await resolveGlobalWinnersForChecks(supabase, checks);
  return aggregateGloballyAcceptedVerifiedTransfers(
    checks,
    evidenceMarketById,
    globalWinners,
    { marketLabelNormalized: targetMarket, knownMarkets },
  );
}

async function computeManualSlipTotal(
  supabase:     Supabase,
  sourceId:     string,
  businessDate: string,
  accountabilityRoundId?: string | null,
): Promise<number> {
  return (await scopeManualBreakdown(supabase, sourceId, businessDate, accountabilityRoundId)).total;
}

/** Closed manual sessions of the scope (every market), as reconcile counts them. */
async function scopeManualBreakdown(
  supabase:     Supabase,
  sourceId:     string,
  businessDate: string,
  accountabilityRoundId?: string | null,
): Promise<ManualSlipBreakdown> {
  let sessionQuery = supabase
    .from("manual_slip_sessions")
    .select("id")
    .eq("source_id", sourceId)
    .eq("business_date", businessDate)
    .eq("status", "closed");
  if (accountabilityRoundId !== undefined) {
    sessionQuery = accountabilityRoundId === null
      ? sessionQuery.is("accountability_round_id", null)
      : sessionQuery.eq("accountability_round_id", accountabilityRoundId);
  }
  const { data: sessions, error: sessionError } = await sessionQuery;
  if (sessionError) {
    throw new Error(`manual_slip_sessions query failed: ${sessionError.message}`);
  }

  const sessionIds = (sessions ?? []).map(s => s.id);
  if (sessionIds.length === 0) return { total: 0, pendingCount: 0, pendingAmount: 0, supersededCount: 0, credited: [] };
  return loadManualEntryBreakdown(supabase, sessionIds,
    await loadCreditScope(supabase, sourceId, businessDate, accountabilityRoundId));
}

/**
 * Market-scoped closed manual-slip total for Digital White Sheet.
 *
 * Business rule (same as settlement reconciliation):
 *   checked_slip_total = ai_verified_total + manual_slip_total
 *
 * White Sheet verifiedTransfers must include both halves. Only CLOSED sessions
 * whose normalized market_label equals the requested market are counted —
 * another market's manual slips must never leak in. Sessions with a missing
 * or unidentifiable market_label are skipped (fail closed), not attributed.
 *
 * Closing a manual slip does NOT write transfer_reconciliations; White Sheet
 * loads closed sessions directly (mirrors AI slip loading).
 */
export async function loadMarketScopedManualSlipTotal(
  supabase:              Supabase,
  sourceId:              string,
  businessDate:          string,
  marketLabelNormalized: string,
  accountabilityRoundId?: string | null,
): Promise<number> {
  const sessionIds = await marketScopedClosedManualSessionIds(
    supabase, sourceId, businessDate, marketLabelNormalized, accountabilityRoundId,
  );
  if (sessionIds.length === 0) return 0;

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const scope = await loadCreditScope(supabase, sourceId, businessDate, accountabilityRoundId);
  return round2((await loadManualEntryBreakdown(supabase, sessionIds, scope)).total);
}

async function marketScopedClosedManualSessionIds(
  supabase:              Supabase,
  sourceId:              string,
  businessDate:          string,
  marketLabelNormalized: string,
  accountabilityRoundId?: string | null,
): Promise<string[]> {
  const targetMarket = marketLabelNormalized.normalize("NFC").trim();
  if (!targetMarket) {
    throw new Error("marketLabelNormalized must not be empty");
  }

  let sessionQuery = supabase
    .from("manual_slip_sessions")
    .select("id, market_label")
    .eq("source_id", sourceId)
    .eq("business_date", businessDate)
    .eq("status", "closed");
  if (accountabilityRoundId !== undefined) {
    sessionQuery = accountabilityRoundId === null
      ? sessionQuery.is("accountability_round_id", null)
      : sessionQuery.eq("accountability_round_id", accountabilityRoundId);
  }
  const { data: sessions, error: sessionError } = await sessionQuery;
  if (sessionError) {
    throw new Error(`manual_slip_sessions query failed: ${sessionError.message}`);
  }

  return (sessions ?? [])
    .filter((session) => normalizedMarketLabel(session.market_label) === targetMarket)
    .map((session) => session.id);
}

export async function reconcile(
  supabase:             Supabase,
  sourceId:             string,
  businessDate:         string,
  submittedTransfer:    number,
  accountabilityRoundId?: string | null,
): Promise<{ blocked: true; reason: string } | { blocked: false; result: ReconciliationResult; row: TransferReconciliationRow }> {
  // Block if any open manual session exists.
  let openSessionQuery = supabase
    .from("manual_slip_sessions")
    .select("id")
    .eq("source_id", sourceId)
    .eq("business_date", businessDate)
    .eq("status", "open");
  if (accountabilityRoundId !== undefined) {
    openSessionQuery = accountabilityRoundId === null
      ? openSessionQuery.is("accountability_round_id", null)
      : openSessionQuery.eq("accountability_round_id", accountabilityRoundId);
  }
  const { data: openSession, error: openSessionError } = await openSessionQuery.maybeSingle();
  if (openSessionError) {
    throw new Error(`open manual_slip_sessions query failed: ${openSessionError.message}`);
  }

  if (openSession) {
    return {
      blocked: true,
      reason: "มี session สลิปมือที่ยังเปิดอยู่ กรุณาพิมพ์ จบสลิปมือ ก่อน",
    };
  }

  // Block if a produce session for this source failed to close (fail-closed:
  // validation/parse errors, missing declared items, or an unconfirmed
  // structured review) for THIS business date. try_finalize_pending_generation
  // writes ZERO produce_sessions/produce_items rows on failed_closed — the only
  // surviving trace is on pending_sessions itself (terminalized=true,
  // finalization_status='failed_closed'). This is the PRIMARY forward-looking
  // gate: it is what actually fires for a freshly-failed session, since a
  // failed attempt never reaches produce_sessions at all. Business date isn't
  // persisted on a failed pending_sessions row (no session was ever built), so
  // it's derived from the same close-event timestamp the finalizer itself uses
  // to decide "not_closing" vs "closing" — no schema change needed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let failedQuery = (supabase as any)
    .from("pending_sessions")
    .select("close_event_timestamp_ms")
    .eq("source_id", sourceId)
    .eq("terminalized", true)
    .eq("finalization_status", "failed_closed")
    .not("close_event_timestamp_ms", "is", null);
  if (accountabilityRoundId !== undefined) {
    failedQuery = accountabilityRoundId === null
      ? failedQuery.is("accountability_round_id", null)
      : failedQuery.eq("accountability_round_id", accountabilityRoundId);
  }
  const { data: failedClosedSessions, error: failedClosedError } = await failedQuery;
  if (failedClosedError) {
    throw new Error(`failed pending_sessions query failed: ${failedClosedError.message}`);
  }

  const hasFailedClosedForDate = ((failedClosedSessions ?? []) as Array<{ close_event_timestamp_ms: number }>)
    .some((row) => bangkokBusinessDateFromTimestamp(row.close_event_timestamp_ms) === businessDate);

  if (hasFailedClosedForDate) {
    return {
      blocked: true,
      reason: "รอบเบิก/คืนมีรายการที่ปิดไม่สำเร็จ (บันทึกไม่ครบ) กรุณาแก้ไขและส่งรายการใหม่ก่อนส่งยอด",
    };
  }

  // Legacy backstop only: produce_sessions.parser_errors can NOT be non-null
  // for any row written by either current write path — the RPC
  // (try_finalize_pending_generation) inserts a literal NULL for this column
  // on every success, and the pre-RPC legacy persist() path throws inside
  // assertWeighSessionFinalizable before it ever reaches this insert when
  // parse_errors is non-empty. This block exists solely to catch rows written
  // before those guarantees existed (or by a future code path that reintroduces
  // the column without the same discipline) — it is not expected to ever fire
  // against current writes, and must not be relied on as the primary gate.
  let incompleteQuery = supabase
    .from("produce_sessions")
    .select("id, raw_message_id")
    .eq("session_date", businessDate)
    .not("parser_errors", "is", null);
  if (accountabilityRoundId !== undefined) {
    incompleteQuery = accountabilityRoundId === null
      ? incompleteQuery.is("accountability_round_id", null)
      : incompleteQuery.eq("accountability_round_id", accountabilityRoundId);
  }
  const { data: incompleteSessions, error: incompleteError } = await incompleteQuery;
  if (incompleteError) {
    throw new Error(`incomplete produce_sessions query failed: ${incompleteError.message}`);
  }

  if (incompleteSessions && incompleteSessions.length > 0) {
    const rawMessageIds = incompleteSessions.map((s) => s.raw_message_id);
    const { data: sourceMessages, error: sourceMessageError } = await supabase
      .from("raw_messages")
      .select("id")
      .in("id", rawMessageIds)
      .eq("source_id", sourceId);
    if (sourceMessageError) {
      throw new Error(`raw_messages source lookup failed: ${sourceMessageError.message}`);
    }

    if (sourceMessages && sourceMessages.length > 0) {
      return {
        blocked: true,
        reason: "รอบเบิก/คืนมีรายการที่ยังตรวจสอบไม่สมบูรณ์ กรุณาแก้ไขรายการที่ค้างก่อนส่งยอด",
      };
    }
  }

  // Amounts are numeric(10,2) in the DB but accumulate as binary floats here —
  // round to satang before comparing so 0.1 + 0.2 style drift never turns a
  // genuinely matched settlement into a false mismatch.
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const aiTotal     = round2(await loadAiVerifiedTransferTotal(supabase, sourceId, businessDate, accountabilityRoundId));
  const manualTotal = round2(await computeManualSlipTotal(supabase, sourceId, businessDate, accountabilityRoundId));
  const checkedTotal = round2(aiTotal + manualTotal);
  const difference   = round2(submittedTransfer - checkedTotal);
  const matched      = difference === 0;

  const result: ReconciliationResult = {
    ai_verified_total:        aiTotal,
    manual_slip_total:        manualTotal,
    checked_slip_total:       checkedTotal,
    submitted_transfer_total: submittedTransfer,
    difference,
    matched,
  };

  const { data: row, error } = await supabase
    .from("transfer_reconciliations")
    .upsert(
      {
        source_id:                sourceId,
        business_date:            businessDate,
        accountability_round_id:  accountabilityRoundId ?? null,
        ...result,
        updated_at:               new Date().toISOString(),
      },
      { onConflict: "source_id,business_date,accountability_round_id" },
    )
    .select()
    .single();

  if (error) throw new Error(`reconciliation upsert failed: ${error.message}`);

  return { blocked: false, result, row: row as TransferReconciliationRow };
}

export interface ManualSlipBreakdown {
  /** Money: counted entries (approved overrides at their approved amount). */
  total:           number;
  /** Not counted, waiting for an authorized decision — never silently dropped. */
  pendingCount:    number;
  pendingAmount:   number;
  /** Not counted because the AI check with the same reference is that money row. */
  supersededCount: number;
  /** Referenced entries counted here (what a finalization credits). */
  credited?:       CreditedReference[];
}

type ManualEntryRow = { id: string; amount: number | string; reference_id?: string | null; requires_review?: boolean };

/**
 * Per closed manual entry, one money row per transaction:
 *   * referenced entries follow the shared ownership rule
 *     (slips/reference-ownership.ts): the earliest AI read or counted manual
 *     entry of a full reference owns its money; every other claim is
 *     superseded (same amount) or pending (different amount / rejected AI);
 *   * unreferenced entries: rejected → 0; requires_review (new LINE flow)
 *     → pending until an authorized override; otherwise counted — every
 *     legacy row and today's grammar, unchanged (known limitation: such an
 *     entry cannot be matched to an AI read, see docs/manual-slip-ai-approval.md).
 * A credited reference counts only for its credited entry, at the credited
 * amount. In a frozen scope (its settlement recorded credits) a referenced
 * entry without a credit is late: pending, never counted.
 * Nothing is linked by amount, date or a partial reference.
 */
async function loadManualEntryBreakdown(supabase: Supabase, sessionIds: string[], scope: CreditScope): Promise<ManualSlipBreakdown> {
  const entries = await loadManualEntries(supabase, sessionIds);
  const decisions = await loadActiveDecisions(supabase, "manual_entry_id", entries.map((e) => e.id));
  const index = await loadReferenceIndex(supabase, entries.map((e) => e.reference_id ?? ""));

  const breakdown: ManualSlipBreakdown = { total: 0, pendingCount: 0, pendingAmount: 0, supersededCount: 0, credited: [] };
  for (const e of entries) {
    const amount = Number(e.amount);
    const decision = decisions.get(e.id);
    const reference = normalizeSlipReference(e.reference_id);
    const owner = ownershipFor(index, reference);
    const credit = owner?.credit && owner.credit.manualEntryId === e.id ? owner.credit : null;
    const creditedElsewhere = credit !== null && !creditInScope(credit, scope);
    const counted = credit ? credit.amount : decision?.decision === "approved" ? decision.amount : amount;
    let state = owner?.manual.get(e.id)
      ?? (decision?.decision === "rejected" ? "rejected"
        : e.requires_review === true && decision?.decision !== "approved" ? "pending" : "counted");
    if (creditedElsewhere) state = "superseded";                     // counted in its credited scope only
    if (scope.frozen && reference && !owner?.credit && state === "counted") state = "pending"; // late after settlement
    if (state === "counted") {
      breakdown.total += counted;
      if (reference) breakdown.credited!.push({ reference, manualEntryId: e.id, amount: counted });
    } else if (state === "pending") { breakdown.pendingCount += 1; breakdown.pendingAmount += amount; }
    else if (state === "superseded") breakdown.supersededCount += 1;
  }
  return breakdown;
}

/** Newest schema first; an older schema (migration not applied) simply has fewer columns. */
async function loadManualEntries(supabase: Supabase, sessionIds: string[]): Promise<ManualEntryRow[]> {
  for (const columns of ["id, amount, reference_id, requires_review", "id, amount, reference_id", "id, amount"]) {
    const { data, error } = await supabase.from("manual_slip_entries").select(columns as "id, amount").in("session_id", sessionIds);
    if (!error) return (data ?? []) as unknown as ManualEntryRow[];
    if (!isMissingSchemaObject(error)) throw new Error(`manual_slip_entries query failed: ${error.message}`);
  }
  throw new Error("manual_slip_entries query failed: no compatible column set");
}

/** Market-scoped closed manual-slip breakdown (counted, pending, superseded). */
export async function loadMarketScopedManualSlipBreakdown(
  supabase:              Supabase,
  sourceId:              string,
  businessDate:          string,
  marketLabelNormalized: string,
  accountabilityRoundId?: string | null,
): Promise<ManualSlipBreakdown> {
  const sessionIds = await marketScopedClosedManualSessionIds(
    supabase, sourceId, businessDate, marketLabelNormalized, accountabilityRoundId,
  );
  if (sessionIds.length === 0) return { total: 0, pendingCount: 0, pendingAmount: 0, supersededCount: 0, credited: [] };
  return loadManualEntryBreakdown(supabase, sessionIds,
    await loadCreditScope(supabase, sourceId, businessDate, accountabilityRoundId));
}

/**
 * Credits the scope's referenced money rows to this finalization BEFORE it
 * reconciles (docs/slip-reference-claims.md). The same loaders reconcile uses
 * decide what the scope would count; the primary key of slip_reference_claims
 * lets only the first finalization credit a reference, and the reconcile that
 * follows counts what was credited. Fail-closed: without migration
 * 20261103100000 (RPC missing) the finalization fails and stays retryable —
 * money is never settled on the uncredited preview rule (it paid one ฿70
 * transfer twice). The retry after the schema is installed credits normally.
 */
export async function claimFinalizationReferences(
  supabase:       Supabase,
  finalizationId: string,
  sourceId:       string,
  businessDate:   string,
  accountabilityRoundId?: string | null,
): Promise<void> {
  const { checks, evidenceMarketById } = await loadVerifiedTransferChecksForSourceDate(supabase, sourceId, businessDate, accountabilityRoundId);
  const winners = checks.length === 0 ? new Set<string>() : await resolveGlobalWinnersForChecks(supabase, checks);
  const ai = aggregateGloballyAcceptedVerifiedTransfers(checks, evidenceMarketById, winners).credited ?? [];
  const manual = (await scopeManualBreakdown(supabase, sourceId, businessDate, accountabilityRoundId)).credited ?? [];
  const claims = [...ai, ...manual].map((c) => ({
    reference_id: c.reference, slip_check_id: c.slipCheckId ?? null, manual_entry_id: c.manualEntryId ?? null, amount: c.amount,
  }));
  const { error } = await supabase.rpc("claim_slip_references" as never, { p_finalization_id: finalizationId, p_claims: claims } as never);
  if (error) {
    const missing = error.code === "42883" || error.code === "PGRST202";
    throw new Error(`slip reference credit failed${missing ? " (migration 20261103100000 not applied)" : ""}: ${error.message}`);
  }
}

const loadActiveApprovals = (supabase: Supabase, checkIds: string[]) =>
  loadActiveDecisions(supabase, "slip_check_id", checkIds);
