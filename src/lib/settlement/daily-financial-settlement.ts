/**
 * Task 4 — Daily Financial Settlement / Operating Result.
 *
 * *** THE SINGLE MOST IMPORTANT BUSINESS CONTRACT ***
 * FINANCIAL SOURCE OF TRUTH = THE DAILY WHITE-SHEET (ใบขาว) SALES TOTAL,
 * hand-entered by an operator (see digital_white_sheet_cash_entries.white_sheet_sales,
 * migration 20260825090000). Produce-derived "estimated sales"
 * (calculateDigitalWhiteSheet / loadSalesReport) is analytical / cross-check
 * evidence ONLY and must NEVER replace, overwrite, or silently substitute
 * for it. This module never imports either produce-sales calculator for
 * the authoritative figure — see attachProduceCrossCheck for the one
 * place produce evidence is allowed to appear, and only as an informational
 * line.
 *
 * FORMULA (kept in exactly this one place — no caller may re-derive it):
 *   expected_cash = white_sheet_sales - transfer_total - owner_cash
 *                   - expenses_total - wages_total
 *   difference    = actual_cash - expected_cash
 *
 * Money is handled as integer satang (cents) throughout — see toCents/
 * fromCents — because every input here is already a decimal(12,2) value and
 * the formula only adds/subtracts, so integer-cent arithmetic is exact with
 * no rounding step ever required (float difference === 0 comparisons are
 * never used — see reconciliation.ts's identical round-to-cents convention).
 *
 * STATUS MODEL (Phase 3's #1 correctness trap): a missing REQUIRED input
 * (white_sheet_sales, owner_cash, expenses, wages, actual_cash) must NEVER
 * be silently treated as zero — that is exactly how a real shortage could
 * get reported as "เงินปิดตรง". Any missing required input forces
 * status = "INCOMPLETE" and both expectedCash/difference to null.
 *
 * Transfer evidence (Phase 4) is different: it is NEVER "missing" in the
 * blocking sense — loadTransferInputs always returns a best-known verified
 * total (AI-verified + closed manual slip evidence, market-scoped exactly
 * like the White Sheet), and any incompleteness (unattributed accepted
 * checks, pending-reference checks, a source-wide reconciliation that
 * hasn't run yet or disagrees with what was submitted) is surfaced as an
 * `uncertainty` note instead of blocking the close.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  loadWhiteSheetCashEntry,
  type WhiteSheetCashEntryIdentity,
  type WhiteSheetCashEntryState,
} from "@/lib/white-sheet/persist";
import {
  loadMarketScopedAiVerifiedTransfers,
  loadMarketScopedManualSlipTotal,
} from "@/lib/reconciliation";

type Supabase = SupabaseClient<Database>;

export type DailyFinancialSettlementStatus =
  | "CLOSED_MATCHED"
  | "CLOSED_DIFFERENCE"
  | "INCOMPLETE";

/** Stable machine-readable keys for missingInputs — never localize these. */
export type DailyFinancialSettlementMissingInput =
  | "white_sheet_sales"
  | "owner_cash"
  | "expenses"
  | "wages"
  | "actual_cash";

export interface DailyFinancialSettlementIdentity {
  sourceId: string;
  marketLabelNormalized: string;
  businessDate: string;
  accountabilityRoundId?: string | null;
}

/** Optional read-only produce cross-check line (Phase 5) — never a source of truth. */
export interface ProduceCrossCheck {
  expectedSales: number;
  warnings: readonly string[];
}

export interface DailyFinancialSettlementResult {
  status: DailyFinancialSettlementStatus;
  businessDate: string;
  marketLabelNormalized: string;
  whiteSheetSales: number | null;
  transferTotal: number;
  ownerCash: number | null;
  expensesTotal: number | null;
  wagesTotal: number | null;
  actualCash: number | null;
  /** null whenever status is INCOMPLETE. */
  expectedCash: number | null;
  /** null whenever status is INCOMPLETE. */
  difference: number | null;
  missingInputs: DailyFinancialSettlementMissingInput[];
  /** Non-blocking notes: transfer evidence trust, produce cross-check anomalies. */
  uncertainty: string[];
  produceCrossCheck?: ProduceCrossCheck;
}

/** Pure input to the formula — one field per formula term, all pre-resolved. */
export interface DailyFinancialSettlementInputs {
  whiteSheetSales: number | null;
  transferTotal: number;
  ownerCash: number | null;
  expensesTotal: number | null;
  wagesTotal: number | null;
  actualCash: number | null;
  transferUncertainty?: readonly string[];
  produceCrossCheck?: ProduceCrossCheck;
}

function toCents(value: number): number {
  return Math.round(value * 100);
}

function fromCents(cents: number): number {
  return cents / 100;
}

/**
 * The ONE place the formula lives. Pure function — no I/O — so every status/
 * shortage/excess/missing-input scenario can be tested directly without a
 * database. See getDailyFinancialSettlement for the DB-backed wiring.
 */
export function computeDailyFinancialSettlement(
  identity: Pick<DailyFinancialSettlementIdentity, "businessDate" | "marketLabelNormalized">,
  inputs: DailyFinancialSettlementInputs,
): DailyFinancialSettlementResult {
  const missingInputs: DailyFinancialSettlementMissingInput[] = [];
  if (inputs.whiteSheetSales === null) missingInputs.push("white_sheet_sales");
  if (inputs.ownerCash === null) missingInputs.push("owner_cash");
  if (inputs.expensesTotal === null) missingInputs.push("expenses");
  if (inputs.wagesTotal === null) missingInputs.push("wages");
  if (inputs.actualCash === null) missingInputs.push("actual_cash");

  const uncertainty = [...(inputs.transferUncertainty ?? [])];

  const base = {
    businessDate: identity.businessDate,
    marketLabelNormalized: identity.marketLabelNormalized,
    whiteSheetSales: inputs.whiteSheetSales,
    transferTotal: inputs.transferTotal,
    ownerCash: inputs.ownerCash,
    expensesTotal: inputs.expensesTotal,
    wagesTotal: inputs.wagesTotal,
    actualCash: inputs.actualCash,
    uncertainty,
    ...(inputs.produceCrossCheck ? { produceCrossCheck: inputs.produceCrossCheck } : {}),
  };

  if (missingInputs.length > 0) {
    return {
      ...base,
      status: "INCOMPLETE",
      expectedCash: null,
      difference: null,
      missingInputs,
    };
  }

  // Non-null by construction: missingInputs is empty, so every "!" below is
  // guarded by the check above rather than an assumption.
  const salesCents = toCents(inputs.whiteSheetSales as number);
  const transferCents = toCents(inputs.transferTotal);
  const ownerCents = toCents(inputs.ownerCash as number);
  const expensesCents = toCents(inputs.expensesTotal as number);
  const wagesCents = toCents(inputs.wagesTotal as number);
  const actualCents = toCents(inputs.actualCash as number);

  const expectedCents = salesCents - transferCents - ownerCents - expensesCents - wagesCents;
  const differenceCents = actualCents - expectedCents;

  return {
    ...base,
    status: differenceCents === 0 ? "CLOSED_MATCHED" : "CLOSED_DIFFERENCE",
    expectedCash: fromCents(expectedCents),
    difference: fromCents(differenceCents),
    missingInputs: [],
  };
}

/** locationFee + bag + snack + other — labor is wages, tracked separately (see WhiteSheetExpenses). */
function expensesTotalExcludingLabor(expenses: {
  locationFee: number;
  bag: number;
  snack: number;
  other: number;
}): number {
  return fromCents(
    toCents(expenses.locationFee) + toCents(expenses.bag) + toCents(expenses.snack) + toCents(expenses.other),
  );
}

/**
 * Maps the reused White Sheet cash-entry state onto formula inputs.
 * `not_submitted` means every input is missing — never a false zero.
 *
 * labor/location_fee/bag/snack/other/actual_cash_submitted are NOT NULL
 * DEFAULT 0 columns (see migration 0038) — a never-entered field and a
 * genuine entered zero are otherwise indistinguishable once persisted. The
 * ใบขาวมือ partial-close RPC (0059 + 20260825092000) can leave any of them
 * at their placeholder 0 while still successfully closing (partial close is
 * intentional — see hasAnyValue in white-sheet-note-session-service.ts), so
 * this function must consult the *_entered provenance flags rather than the
 * amount to decide whether wages/expenses/actualCash are really known.
 * Every flag defaults to true when absent (row predates the flags, or was
 * written by the "digital" saveWhiteSheetCashEntry path, which always
 * supplies real values) — see enteredFlag in persist.ts.
 */
function inputsFromCashEntry(
  entry: WhiteSheetCashEntryState,
): Pick<
  DailyFinancialSettlementInputs,
  "whiteSheetSales" | "ownerCash" | "expensesTotal" | "wagesTotal" | "actualCash"
> {
  if (entry.status === "not_submitted") {
    return {
      whiteSheetSales: null,
      ownerCash: null,
      expensesTotal: null,
      wagesTotal: null,
      actualCash: null,
    };
  }
  // Fail safe: expensesTotal is a single sum of four columns, so if ANY of
  // them was never entered the combined total is unknown, not "the other
  // three plus an implicit zero" — report the whole bucket missing.
  const expensesEntered =
    (entry.locationFeeEntered ?? true)
    && (entry.bagEntered ?? true)
    && (entry.snackEntered ?? true)
    && (entry.otherEntered ?? true);
  return {
    whiteSheetSales: entry.whiteSheetSales ?? null,
    ownerCash: entry.ownerCash ?? null,
    expensesTotal: expensesEntered ? expensesTotalExcludingLabor(entry.expenses) : null,
    wagesTotal: (entry.laborEntered ?? true) ? entry.expenses.labor : null,
    actualCash: (entry.actualCashEntered ?? true) ? entry.actualCashSubmitted : null,
  };
}

interface TransferInputs {
  total: number;
  uncertainty: string[];
}

/**
 * Best-known verified transfer evidence for this market/date — the SAME two
 * evidence sources (AI-verified slip checks + closed manual-slip sessions)
 * the Digital White Sheet already uses (see reconciliation.ts), so no second
 * transfer-truth algorithm is ever invented here. Never blocks the close;
 * any incompleteness becomes an uncertainty note instead.
 */
export async function loadTransferInputs(
  supabase: Supabase,
  identity: DailyFinancialSettlementIdentity,
  knownMarkets: ReadonlySet<string>,
): Promise<TransferInputs> {
  const uncertainty: string[] = [];

  const ai = await loadMarketScopedAiVerifiedTransfers(
    supabase,
    identity.sourceId,
    identity.businessDate,
    identity.marketLabelNormalized,
    knownMarkets,
    identity.accountabilityRoundId,
  );
  const manualTotal = await loadMarketScopedManualSlipTotal(
    supabase,
    identity.sourceId,
    identity.businessDate,
    identity.marketLabelNormalized,
    identity.accountabilityRoundId,
  );

  if (ai.unresolvedAcceptedCount > 0) {
    uncertainty.push(
      `มีสลิปที่ตรวจสอบแล้วแต่ยังระบุตลาดไม่ได้ ${ai.unresolvedAcceptedCount} รายการ `
        + `(${ai.unresolvedAcceptedAmount.toFixed(2)} บาท) — ไม่รวมในยอดโอนด้านบน`,
    );
  }
  if (ai.pendingReferenceCount > 0) {
    uncertainty.push(
      `มีสลิปที่ยังไม่มีเลขอ้างอิง ${ai.pendingReferenceCount} รายการ `
        + `(${ai.pendingReferenceAmount.toFixed(2)} บาท) — รอตรวจสอบ ไม่รวมในยอดโอนด้านบน`,
    );
  }
  if (ai.pendingDateCount > 0) {
    uncertainty.push(
      `มีสลิปที่วันที่ไม่ตรงกับรอบหรืออ่านวันที่ไม่ได้ ${ai.pendingDateCount} รายการ `
        + `(${ai.pendingDateAmount.toFixed(2)} บาท) — รอตรวจสอบ ไม่รวมในยอดโอนด้านบน`,
    );
  }
  if (ai.pendingOutlierCount > 0) {
    uncertainty.push(
      `มีสลิปยอดเงินสูงผิดปกติ ${ai.pendingOutlierCount} รายการ `
        + `(${ai.pendingOutlierAmount.toFixed(2)} บาท) — รอตรวจสอบ ไม่รวมในยอดโอนด้านบน`,
    );
  }

  const total = fromCents(toCents(ai.attributedTotal) + toCents(manualTotal));
  return { total, uncertainty };
}

/**
 * Reads the source-wide transfer_reconciliations row (written by reconcile()
 * in src/lib/reconciliation.ts) for an extra trust signal: whether what was
 * SUBMITTED as the day's transfer total actually matches the checked
 * (AI + manual) evidence. This is source-wide, not market-scoped — Local MVP
 * has one market per source, so this is the same day being described; a
 * future multi-market source would need this note to say which markets it
 * covers, tracked as a ponytail below.
 */
async function loadSubmittedTransferAgreement(
  supabase: Supabase,
  identity: DailyFinancialSettlementIdentity,
): Promise<string[]> {
  let query = supabase
    .from("transfer_reconciliations")
    .select("submitted_transfer_total, checked_slip_total, matched")
    .eq("source_id", identity.sourceId)
    .eq("business_date", identity.businessDate);
  query =
    identity.accountabilityRoundId === undefined
      ? query
      : identity.accountabilityRoundId === null
        ? query.is("accountability_round_id", null)
        : query.eq("accountability_round_id", identity.accountabilityRoundId);
  const { data, error } = await query.maybeSingle();
  if (error) {
    throw new Error(`transfer reconciliation lookup failed: ${error.message}`);
  }

  if (!data) {
    return ["ยังไม่ได้ทำการกระทบยอดเงินโอน (ยอดโอนด้านบนคำนวณจากหลักฐานสลิปเท่านั้น)"];
  }
  if (!data.matched) {
    return [
      `ยอดโอนที่แจ้งไว้ (${Number(data.submitted_transfer_total).toFixed(2)} บาท) `
        + `ไม่ตรงกับยอดสลิปที่ตรวจสอบแล้ว (${Number(data.checked_slip_total).toFixed(2)} บาท)`,
    ];
  }
  return [];
}

export interface GetDailyFinancialSettlementOptions {
  /**
   * Canonical produce markets for source+date, required by
   * loadMarketScopedAiVerifiedTransfers for market attribution — see
   * resolveCentralPricesForDate/loadRoundReturnStatuses callers elsewhere
   * for how this set is normally derived. Defaults to a set containing only
   * this identity's own market, which is correct for the common one-market
   * source and fails safe (unattributed, reported as uncertainty) for any
   * evidence naming a different market.
   */
  knownMarkets?: ReadonlySet<string>;
  produceCrossCheck?: ProduceCrossCheck;
}

/**
 * The exported service contract. Loads every input from the reused
 * settlement/reconciliation tables (digital_white_sheet_cash_entries,
 * slip_evidences/slip_checks, manual_slip_sessions/entries,
 * transfer_reconciliations) and applies computeDailyFinancialSettlement —
 * the ONLY place the formula runs. Never writes anything.
 */
export async function getDailyFinancialSettlement(
  supabase: Supabase,
  identity: DailyFinancialSettlementIdentity,
  options: GetDailyFinancialSettlementOptions = {},
): Promise<DailyFinancialSettlementResult> {
  const cashIdentity: WhiteSheetCashEntryIdentity = {
    sourceId: identity.sourceId,
    marketLabelNormalized: identity.marketLabelNormalized,
    businessDate: identity.businessDate,
    accountabilityRoundId: identity.accountabilityRoundId,
  };

  const [entry, transfer, submittedAgreement] = await Promise.all([
    loadWhiteSheetCashEntry(supabase, cashIdentity),
    loadTransferInputs(
      supabase,
      identity,
      options.knownMarkets ?? new Set([identity.marketLabelNormalized]),
    ),
    loadSubmittedTransferAgreement(supabase, identity),
  ]);

  const cashInputs = inputsFromCashEntry(entry);

  return computeDailyFinancialSettlement(identity, {
    ...cashInputs,
    transferTotal: transfer.total,
    transferUncertainty: [...transfer.uncertainty, ...submittedAgreement],
    ...(options.produceCrossCheck ? { produceCrossCheck: options.produceCrossCheck } : {}),
  });
}
