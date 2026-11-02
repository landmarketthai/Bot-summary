/**
 * Slice 3D — per-slip status, reconciliation and closing the round.
 *
 * "ปิดรอบ" here means the EXISTING settlement finalization
 * (settlement_finalizations via tryFinalizeSettlement). It does not create,
 * open or close a work_round — see docs/guided-operations-end-to-end.md §2.1.
 *
 * Every number comes from the authoritative loaders:
 *   ai_verified_total        loadMarketScopedAiVerifiedTransfers
 *   manual_slip_total        loadMarketScopedManualSlipTotal
 *   checked_slip_total       ai_verified_total + manual_slip_total
 *   submitted_transfer_total settlement_entries.money_transfer
 *   difference               submitted_transfer_total - checked_slip_total
 *
 * Nothing here re-implements OCR, dedupe, market attribution or settlement.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, SlipCheckStatus } from "@/types/database";
import {
  businessDateToUtcRange,
  loadBatchOutlierCheckIds,
  loadMarketScopedAiVerifiedTransfers,
  loadMarketScopedManualSlipTotal,
} from "@/lib/reconciliation";
import { normalizedMarketLabel } from "@/lib/market";
import { slipDateIneligibility } from "@/lib/slips/financial-eligibility";
import {
  isVerifiedSlipCheckStatus,
  normalizeTransactionId,
  resolveGloballyAcceptedCheckIds,
} from "@/lib/slips/transaction-dedupe";
import { listKnownProduceMarketLabels } from "@/lib/white-sheet";
import { tryFinalizeSettlement } from "@/lib/settlement-finalizer";
import type { GuidedJourneyContext } from "./journey";

type Supabase = SupabaseClient<Database>;

/**
 * Operator-facing per-slip status. Deliberately narrow: a slip is only
 * `verified` when the existing evidence rules actually verify it — a readable
 * image is not a verified transfer.
 */
export type GuidedSlipStatus =
  | "verified"
  | "manual_review"
  | "date_mismatch"
  | "market_unclear"
  | "duplicate";

export const GUIDED_SLIP_STATUS_LABEL: Record<GuidedSlipStatus, string> = {
  verified: "อ่านสำเร็จ",
  manual_review: "รอตรวจมือ",
  date_mismatch: "วันที่ไม่ตรง",
  market_unclear: "ตลาดไม่ชัด",
  duplicate: "สลิปซ้ำ",
};

export type GuidedSlipRow = {
  checkId: string;
  status: GuidedSlipStatus;
  amount: number | null;
  referenceId: string | null;
};

export type GuidedRoundTotals = {
  aiVerifiedTotal: number;
  manualSlipTotal: number;
  checkedSlipTotal: number;
  submittedTransferTotal: number | null;
  difference: number | null;
};

/** Why the round cannot be closed yet. Each maps to an existing lifecycle state. */
export type GuidedRoundBlocker =
  | "white_sheet_not_submitted"
  | "slip_batch_open"
  | "ocr_pending"
  | "manual_slip_open"
  | "attribution_ambiguous"
  | "settlement_missing"
  | "settlement_ambiguous"
  | "difference_non_zero";

export const GUIDED_ROUND_BLOCKER_LABEL: Record<GuidedRoundBlocker, string> = {
  white_sheet_not_submitted: "ยังไม่ได้บันทึกใบขาวของรอบนี้",
  slip_batch_open: 'ชุดสลิปยังเปิดอยู่ กรุณาพิมพ์ "จบสลิป" ก่อน',
  ocr_pending: "ระบบยังอ่านสลิปไม่เสร็จ กรุณารอสักครู่",
  manual_slip_open: 'สลิปมือยังเปิดอยู่ กรุณาพิมพ์ "จบสลิปมือ" ก่อน',
  attribution_ambiguous: "มีสลิปที่ยังระบุตลาด/เลขอ้างอิงไม่ได้ ต้องให้ผู้ดูแลตรวจมือ",
  settlement_missing: "ยังไม่มียอดส่งเงินของรอบนี้ในระบบ",
  settlement_ambiguous: "พบยอดส่งเงินซ้ำซ้อนของรอบนี้ ต้องให้ผู้ดูแลตรวจ",
  difference_non_zero: "ยอดสลิปกับยอดส่งเงินยังไม่ตรงกัน",
};

export type GuidedRoundReport = {
  totals: GuidedRoundTotals;
  slips: GuidedSlipRow[];
  blockers: GuidedRoundBlocker[];
  /** Counts behind attribution_ambiguous, for the operator-facing detail line. */
  unresolvedCount: number;
  pendingReferenceCount: number;
};

export type GuidedRoundCloseOutcome =
  | { status: "closed"; report: GuidedRoundReport; settlement: "finalized" | "already_done" }
  | { status: "blocked"; report: GuidedRoundReport }
  /** tryFinalizeSettlement refused for its own reason after our checks passed. */
  | { status: "settlement_refused"; report: GuidedRoundReport; settlement: string };

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Slip rows for the round, classified with existing evidence truth only.
 *
 * The scope is deliberately identical to the reconciliation loader's, so a slip
 * shown as อ่านสำเร็จ is one that actually contributes to checked_slip_total:
 *
 *   * the received_at window is half-open, `startUtc <= received_at < endUtc`,
 *     the same range `businessDateToUtcRange` feeds the money loaders;
 *   * evidence attributed to a DIFFERENT known produce market is another
 *     round's and is omitted from this list entirely — the loader skips it too,
 *     so calling it ตลาดไม่ชัด would invent a problem that does not exist.
 *
 * Classification order matters and mirrors the reconciliation loader:
 *   1. a non-verified check status is manual review — never counted;
 *   2. a verified check with no reference id is BR-02 pending resolution,
 *      which is manual review, not a verified transfer;
 *   3. a verified check whose reference already has a global winner elsewhere
 *      is a duplicate;
 *   4. an evidence row whose market is missing, or not a known produce market
 *      for this source/date, is market_unclear (the loader calls it unresolved);
 *   5. the shared slip date rule (slips/financial-eligibility.ts): a printed
 *      date outside the round's tolerance is date_mismatch, a missing or
 *      unreadable one is manual review. The money loaders apply the SAME rule,
 *      so neither is inside ai_verified_total;
 *   6. only what survives all of that is verified.
 */
export async function loadGuidedSlipRows(
  supabase: Supabase,
  context: GuidedJourneyContext,
  knownMarkets: ReadonlySet<string>,
): Promise<GuidedSlipRow[]> {
  const { startUtc, endUtc } = businessDateToUtcRange(context.businessDate);

  // Same scope as loadVerifiedTransferChecksForSourceDate: a round binding is
  // authoritative (a late image bound to this round is listed, as it is counted);
  // only unbound/legacy evidence falls back to the 04:00 receipt window.
  let evidenceQuery = supabase
    .from("slip_evidences")
    .select("id, market_label, received_at, batch_id")
    .eq("source_id", context.sourceId);
  if (context.accountabilityRoundId) {
    evidenceQuery = evidenceQuery.eq("accountability_round_id", context.accountabilityRoundId);
  } else {
    evidenceQuery = evidenceQuery.gte("received_at", startUtc).lt("received_at", endUtc);
    if (context.accountabilityRoundId === null) {
      evidenceQuery = evidenceQuery.is("accountability_round_id", null);
    }
  }
  const { data: evidences, error: evidenceError } = await evidenceQuery;
  if (evidenceError) {
    throw new Error(`slip evidence lookup failed: ${evidenceError.message}`);
  }
  const evidenceRows = evidences ?? [];
  if (evidenceRows.length === 0) return [];

  const evidenceMarket = new Map(
    evidenceRows.map((row) => [
      String(row.id),
      normalizedMarketLabel(row.market_label) || null,
    ]),
  );

  const { data: checks, error: checkError } = await supabase
    .from("slip_checks")
    .select("id, evidence_id, status, transfer_amount, reference_id, transaction_time")
    .in("evidence_id", [...evidenceMarket.keys()]);
  if (checkError) {
    throw new Error(`slip check lookup failed: ${checkError.message}`);
  }
  const checkRows = checks ?? [];
  if (checkRows.length === 0) return [];

  // Global winner set — the same dedupe the reconciliation loader applies, so a
  // reference already counted under another check is reported as a duplicate
  // here rather than being silently double-counted.
  //
  // Only VERIFIED-status checks contribute references, exactly as the loader
  // does: resolveGloballyAcceptedCheckIds throws when a reference has no
  // verified winner, and passing a NEED_REVIEW reference in would fail that way
  // and collapse every genuine winner into "duplicate".
  const references = checkRows
    .filter((row) => isVerifiedSlipCheckStatus(row.status as SlipCheckStatus))
    .map((row) => normalizeTransactionId(row.reference_id as string | null))
    .filter((ref): ref is string => ref !== null);
  let winners: ReadonlySet<string>;
  try {
    winners = await resolveGloballyAcceptedCheckIds(supabase, references);
  } catch {
    // Fail closed: an unresolvable reference set means we cannot claim any of
    // these slips is a unique verified transfer.
    winners = new Set();
  }

  const outliers = await loadBatchOutlierCheckIds(supabase, [...new Set(evidenceRows
    .map((row) => (row as { batch_id?: string | null }).batch_id)
    .filter((id): id is string => typeof id === "string"))]);

  return checkRows.flatMap((row): GuidedSlipRow[] => {
    const checkId = String(row.id);
    const amount =
      row.transfer_amount === null ? null : Number(row.transfer_amount);
    const referenceId = normalizeTransactionId(row.reference_id as string | null);
    const base = { checkId, amount, referenceId };

    if (!isVerifiedSlipCheckStatus(row.status as SlipCheckStatus)) {
      return [{ ...base, status: "manual_review" as const }];
    }
    if (!referenceId) {
      return [{ ...base, status: "manual_review" as const }];
    }
    if (!winners.has(checkId)) {
      return [{ ...base, status: "duplicate" as const }];
    }
    const market = evidenceMarket.get(String(row.evidence_id)) ?? null;
    if (!market || !knownMarkets.has(market)) {
      return [{ ...base, status: "market_unclear" as const }];
    }
    if (market !== context.marketLabelNormalized) {
      // Another known market's slip. The money loader skips it rather than
      // treating it as unresolved, so this round does not list it at all.
      return [];
    }
    // The money loader counts only a transfer_amount (wallet slips are not in
    // ai_verified_total) and suspends the LINE summary's outliers.
    if (amount === null || outliers.has(checkId)) {
      return [{ ...base, status: "manual_review" as const }];
    }
    const dateProblem = slipDateIneligibility(row.transaction_time as string | null, context.businessDate);
    if (dateProblem === "date_out_of_round") {
      return [{ ...base, status: "date_mismatch" as const }];
    }
    if (dateProblem) return [{ ...base, status: "manual_review" as const }];
    return [{ ...base, status: "verified" as const }];
  });
}

/**
 * Read-only reconciliation for the guided round.
 *
 * Writes nothing — in particular it does not upsert transfer_reconciliations,
 * because showing the operator a number must not itself be a state change.
 */
export async function buildGuidedRoundReport(
  supabase: Supabase,
  context: GuidedJourneyContext,
  whiteSheetSubmitted: boolean,
): Promise<GuidedRoundReport> {
  const blockers: GuidedRoundBlocker[] = [];
  if (!whiteSheetSubmitted) blockers.push("white_sheet_not_submitted");

  const knownMarkets = new Set(
    await listKnownProduceMarketLabels(
      supabase,
      context.sourceId,
      context.businessDate,
    ),
  );

  let batchQuery = supabase
      .from("slip_batches")
      .select("id, status")
      .eq("source_id", context.sourceId)
      .in("status", ["collecting", "closing", "processing"]);
  let manualQuery = supabase
      .from("manual_slip_sessions")
      .select("id")
      .eq("source_id", context.sourceId)
      .eq("business_date", context.businessDate)
      .eq("status", "open");
  if (context.accountabilityRoundId !== undefined) {
    batchQuery = context.accountabilityRoundId === null
      ? batchQuery.is("accountability_round_id", null)
      : batchQuery.eq("accountability_round_id", context.accountabilityRoundId);
    manualQuery = context.accountabilityRoundId === null
      ? manualQuery.is("accountability_round_id", null)
      : manualQuery.eq("accountability_round_id", context.accountabilityRoundId);
  }
  const [batchRes, manualRes] = await Promise.all([batchQuery, manualQuery]);
  if (batchRes.error) {
    throw new Error(`slip batch lookup failed: ${batchRes.error.message}`);
  }
  if (manualRes.error) {
    throw new Error(`manual slip lookup failed: ${manualRes.error.message}`);
  }
  for (const batch of batchRes.data ?? []) {
    if (batch.status === "collecting") {
      if (!blockers.includes("slip_batch_open")) blockers.push("slip_batch_open");
    } else if (!blockers.includes("ocr_pending")) {
      blockers.push("ocr_pending");
    }
  }
  if ((manualRes.data ?? []).length > 0) blockers.push("manual_slip_open");

  const slips = await loadGuidedSlipRows(supabase, context, knownMarkets);
  if (slips.some((slip) => slip.status === "manual_review")) {
    if (!blockers.includes("ocr_pending")) blockers.push("ocr_pending");
  }

  const verified = await loadMarketScopedAiVerifiedTransfers(
    supabase,
    context.sourceId,
    context.businessDate,
    context.marketLabelNormalized,
    knownMarkets,
    context.accountabilityRoundId,
  );
  const manualTotal = await loadMarketScopedManualSlipTotal(
    supabase,
    context.sourceId,
    context.businessDate,
    context.marketLabelNormalized,
    context.accountabilityRoundId,
  );

  if (verified.unresolvedAcceptedCount > 0 || verified.pendingReferenceCount > 0) {
    blockers.push("attribution_ambiguous");
  }

  const aiVerifiedTotal = round2(verified.attributedTotal);
  const manualSlipTotal = round2(manualTotal);
  const checkedSlipTotal = round2(aiVerifiedTotal + manualSlipTotal);

  let entryQuery = supabase
    .from("settlement_entries")
    .select("money_transfer")
    .eq("source_id", context.sourceId)
    .eq("settlement_date", context.businessDate);
  if (context.accountabilityRoundId !== undefined) {
    entryQuery = context.accountabilityRoundId === null
      ? entryQuery.is("accountability_round_id", null)
      : entryQuery.eq("accountability_round_id", context.accountabilityRoundId);
  }
  const { data: entries, error: entryError } = await entryQuery;
  if (entryError) {
    throw new Error(`settlement entry lookup failed: ${entryError.message}`);
  }
  const entryRows = entries ?? [];

  let submittedTransferTotal: number | null = null;
  let difference: number | null = null;
  if (entryRows.length === 0) {
    blockers.push("settlement_missing");
  } else if (entryRows.length > 1) {
    // Never guess which entry is the round's — tryFinalizeSettlement calls
    // this ambiguous too, and refuses.
    blockers.push("settlement_ambiguous");
  } else {
    submittedTransferTotal = round2(Number(entryRows[0]!.money_transfer ?? 0));
    difference = round2(submittedTransferTotal - checkedSlipTotal);
    if (difference !== 0) blockers.push("difference_non_zero");
  }

  return {
    totals: {
      aiVerifiedTotal,
      manualSlipTotal,
      checkedSlipTotal,
      submittedTransferTotal,
      difference,
    },
    slips,
    blockers,
    unresolvedCount: verified.unresolvedAcceptedCount,
    pendingReferenceCount: verified.pendingReferenceCount,
  };
}

/**
 * Close the round through the existing settlement finalization.
 *
 * Our blockers are checked first so nothing is attempted while an existing
 * lifecycle state says the round is not ready. tryFinalizeSettlement is then
 * authoritative for whether it actually closed, and remains idempotent on
 * retry (`already_done`).
 *
 * `push` defaults to a no-op because the guided flow answers in the LINE reply
 * that the operator is already waiting on; letting the finalizer push as well
 * would deliver the same receipt twice.
 */
export async function closeGuidedRound(
  supabase: Supabase,
  context: GuidedJourneyContext,
  whiteSheetSubmitted: boolean,
  push: (to: string, text: string, retryKey?: string) => Promise<unknown> =
    async () => undefined,
  closeLineEventId?: string,
): Promise<GuidedRoundCloseOutcome> {
  const report = await buildGuidedRoundReport(
    supabase,
    context,
    whiteSheetSubmitted,
  );
  if (report.blockers.length > 0) {
    return { status: "blocked", report };
  }

  const settlement = await tryFinalizeSettlement(
    supabase,
    context.sourceId,
    context.businessDate,
    push,
    context.accountabilityRoundId ?? null,
  );
  if (settlement === "finalized" || settlement === "already_done") {
    if (context.accountabilityRoundId && closeLineEventId) {
      const { error } = await supabase.rpc("close_accountability_round", {
        p_accountability_round_id: context.accountabilityRoundId,
        p_source_id: context.sourceId,
        p_owner_line_user_id: context.lineUserId,
        p_closed_line_event_id: closeLineEventId,
      });
      if (error) throw new Error(`accountability round close failed: ${error.message}`);
    }
    return { status: "closed", report, settlement };
  }
  return { status: "settlement_refused", report, settlement };
}

/** Count slips per operator-facing status, in a stable display order. */
export function summarizeSlipStatuses(
  slips: readonly GuidedSlipRow[],
): Array<[string, number]> {
  const order: GuidedSlipStatus[] = [
    "verified",
    "manual_review",
    "date_mismatch",
    "market_unclear",
    "duplicate",
  ];
  const counts = new Map<GuidedSlipStatus, number>();
  for (const slip of slips) {
    counts.set(slip.status, (counts.get(slip.status) ?? 0) + 1);
  }
  return order
    .filter((status) => (counts.get(status) ?? 0) > 0)
    .map((status) => [GUIDED_SLIP_STATUS_LABEL[status], counts.get(status)!]);
}

/** Thin injectable wrapper so the UX handler can be tested without a database. */
export class GuidedRoundService {
  constructor(private readonly supabase: Supabase) {}

  report(
    context: GuidedJourneyContext,
    whiteSheetSubmitted: boolean,
  ): Promise<GuidedRoundReport> {
    return buildGuidedRoundReport(this.supabase, context, whiteSheetSubmitted);
  }

  close(
    context: GuidedJourneyContext,
    whiteSheetSubmitted: boolean,
    push?: (to: string, text: string, retryKey?: string) => Promise<unknown>,
    closeLineEventId?: string,
  ): Promise<GuidedRoundCloseOutcome> {
    return closeGuidedRound(this.supabase, context, whiteSheetSubmitted, push, closeLineEventId);
  }
}
