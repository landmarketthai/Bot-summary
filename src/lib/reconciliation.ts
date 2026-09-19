import type { SupabaseClient } from "@supabase/supabase-js";
import { bangkokBusinessDateFromTimestamp } from "@/lib/business-date";
import { normalizedMarketLabel } from "@/lib/market";
import { normalizeTransactionId, resolveGloballyAcceptedCheckIds } from "@/lib/slips/transaction-dedupe";
import type { Database, TransferReconciliationRow } from "@/types/database";

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
}

export interface MarketScopedVerifiedTransferResult {
  attributedTotal:           number;
  unresolvedAcceptedCount:   number;
  unresolvedAcceptedAmount:  number;
  /** BR-02: accepted checks with no reference id yet — pending manual resolution, never auto-counted. */
  pendingReferenceCount:     number;
  pendingReferenceAmount:    number;
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

  for (const check of checks) {
    const ref = normalizeTransactionId(check.reference_id);
    if (!ref) {
      // BR-02: no reference id yet — pending manual resolution, never counted.
      pendingReferenceCount += 1;
      pendingReferenceAmount += Number(check.transfer_amount);
      continue;
    }
    if (!globalWinners.has(check.id) || countedWinnerReferences.has(ref)) continue;
    countedWinnerReferences.add(ref);

    if (targetMarket === undefined || !knownMarkets) {
      attributedTotal += Number(check.transfer_amount);
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
    if (evidenceMarket === targetMarket) {
      attributedTotal += Number(check.transfer_amount);
    }
  }

  return {
    attributedTotal,
    unresolvedAcceptedCount,
    unresolvedAcceptedAmount,
    pendingReferenceCount,
    pendingReferenceAmount,
  };
}

async function loadVerifiedTransferChecksForSourceDate(
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
    .select("id, market_label")
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
    .select("id, evidence_id, transfer_amount, reference_id, created_at")
    .in("evidence_id", evidenceIds)
    .in("status", ["EXTRACTED", "PARTIAL_EXTRACTED"])
    .not("transfer_amount", "is", null)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (checkError) {
    throw new Error(`slip check query failed: ${checkError.message}`);
  }

  return {
    checks: (checks ?? []) as VerifiedTransferCheckRow[],
    evidenceMarketById,
  };
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
  if (sessionIds.length === 0) return 0;

  const { data: entries, error: entryError } = await supabase
    .from("manual_slip_entries")
    .select("amount")
    .in("session_id", sessionIds);
  if (entryError) {
    throw new Error(`manual_slip_entries query failed: ${entryError.message}`);
  }

  return (entries ?? []).reduce((sum, e) => sum + Number(e.amount), 0);
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

  const sessionIds = (sessions ?? [])
    .filter((session) => normalizedMarketLabel(session.market_label) === targetMarket)
    .map((session) => session.id);
  if (sessionIds.length === 0) return 0;

  const { data: entries, error: entryError } = await supabase
    .from("manual_slip_entries")
    .select("amount")
    .in("session_id", sessionIds);
  if (entryError) {
    throw new Error(`manual_slip_entries query failed: ${entryError.message}`);
  }

  const round2 = (n: number) => Math.round(n * 100) / 100;
  return round2((entries ?? []).reduce((sum, e) => sum + Number(e.amount), 0));
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
