import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { formatProfitabilitySnapshot } from "@/lib/profitability/format";
import { ProfitabilityService } from "@/lib/profitability/profitability-service";
import type { ProfitabilitySnapshot } from "@/lib/profitability/types";
import { isProfitabilityUuid } from "@/lib/profitability/validate";
import {
  loadDigitalWhiteSheetSummary,
  normalizedMarketLabel,
  type DigitalWhiteSheetScope,
  type WhiteSheetLoadDeps,
} from "./load";
import { loadWhiteSheetCashEntry, type WhiteSheetCashEntryState } from "./persist";
import { preflightReturnIntegrity } from "./return-integrity";
import type { DigitalWhiteSheetSummary, WhiteSheetExpenses } from "./types";
import { hasHardStopWarning } from "./warnings";

type Supabase = SupabaseClient<Database>;

const ZERO_EXPENSES: WhiteSheetExpenses = {
  labor: 0,
  locationFee: 0,
  bag: 0,
  snack: 0,
  other: 0,
};

/**
 * Read-only P3 profitability surface on the White Sheet page model.
 *
 * - `available` — a snapshot exists for the bound round; `formatted` is the
 *   approved Thai block from formatProfitabilitySnapshot (no client recalculation).
 * - `not_calculated` — the scope has a real round UUID, but no snapshot yet.
 * - `round_unbound` — legacy/null/missing/invalid round id; never falls back to
 *   source/market/date and never invents profitability figures.
 *
 * Page load NEVER records, supersedes, or certifies a snapshot.
 */
export type DigitalWhiteSheetProfitability =
  | {
      state: "available";
      snapshot: ProfitabilitySnapshot;
      formatted: string;
    }
  | { state: "not_calculated" }
  | { state: "round_unbound" };

export interface DigitalWhiteSheetPageModel {
  entryStatus: WhiteSheetCashEntryState["status"];
  summary: DigitalWhiteSheetSummary;
  /** Present only when entryStatus is "finalized" (from cash-entry row). */
  finalizedAt: string | null;
  /** Present only when entryStatus is "finalized" (admin actor id). */
  finalizedBy: string | null;
  /**
   * Latest P3 profitability snapshot for the bound accountability round, or an
   * explicit unbound / not-yet-calculated state. Independent of White Sheet
   * hard-stop trust: an untrustworthy White Sheet stays untrustworthy, and an
   * INCOMPLETE P3 snapshot stays visibly INCOMPLETE.
   */
  profitability: DigitalWhiteSheetProfitability;
}

export class WhiteSheetNotSubmittedError extends Error {
  constructor() {
    super("White Sheet cash entry has not been submitted for this source/market/date");
    this.name = "WhiteSheetNotSubmittedError";
  }
}

export class WhiteSheetHardStopError extends Error {
  constructor() {
    super(
      "White Sheet financial result is not trustworthy: a hard-stop warning exists " +
        "for this source/market/date (see warnings)",
    );
    this.name = "WhiteSheetHardStopError";
  }
}

/**
 * Combines the operational loader, the persisted expense/cash entry, and
 * calculateDigitalWhiteSheet into one page model — the only place these
 * three are wired together. React components must not calculate financial
 * totals themselves; they only render this model.
 *
 * When no entry has been submitted yet, `summary.expenses`, `expenseTotal`,
 * `expectedCash`, `actualCashSubmitted`, `difference`, and `status` are
 * computed from a zero placeholder purely so the entry-independent fields
 * (`expectedSales`, `verifiedTransfers`, `warnings`) can still be shown.
 * Callers MUST check `entryStatus` and hide those cash-derived fields
 * — never render them as a genuine $0 submission — when it is
 * "not_submitted" (see DigitalWhiteSheetSummary component and STEP 6/11 of
 * the White Sheet local persistence task). Use
 * requireSubmittedWhiteSheetSummary before anything (LINE push, finalization)
 * that assumes a real submitted entry.
 *
 * Profitability is a read-only attach: getSnapshot only, never recordSnapshot.
 */
export async function loadDigitalWhiteSheetPageModel(
  supabase: Supabase,
  scope: DigitalWhiteSheetScope,
  deps: WhiteSheetLoadDeps = {},
): Promise<DigitalWhiteSheetPageModel> {
  const accountabilityRoundId =
    typeof scope.accountabilityRoundId === "string" &&
    !isProfitabilityUuid(scope.accountabilityRoundId)
      ? null
      : scope.accountabilityRoundId;
  const validatedScope = { ...scope, accountabilityRoundId };
  const marketLabelNormalized = normalizedMarketLabel(scope.marketLabel);
  const entry = await loadWhiteSheetCashEntry(supabase, {
    sourceId: scope.sourceId,
    marketLabelNormalized,
    businessDate: scope.businessDate,
    accountabilityRoundId,
  });

  const cashInput = entry.status !== "not_submitted"
    ? { expenses: entry.expenses, actualCashSubmitted: entry.actualCashSubmitted }
    : { expenses: ZERO_EXPENSES, actualCashSubmitted: 0 };

  const summary = await loadDigitalWhiteSheetSummary(supabase, validatedScope, cashInput, {
    ...deps,
    returnIntegrity: deps.returnIntegrity ?? preflightReturnIntegrity(supabase),
  });
  const profitability = await loadProfitabilityReadState(
    supabase,
    accountabilityRoundId,
  );

  return {
    entryStatus: entry.status,
    summary,
    finalizedAt: entry.status === "finalized" ? entry.finalizedAt : null,
    finalizedBy: entry.status === "finalized" ? entry.finalizedBy : null,
    profitability,
  };
}

/**
 * Bound-round read of the latest P3 snapshot. No descriptive identity fallback.
 * Invalid or missing round ids are `round_unbound` and never hit the RPC.
 */
async function loadProfitabilityReadState(
  supabase: Supabase,
  accountabilityRoundId: string | null | undefined,
): Promise<DigitalWhiteSheetProfitability> {
  if (accountabilityRoundId === undefined || accountabilityRoundId === null) {
    return { state: "round_unbound" };
  }
  if (!isProfitabilityUuid(accountabilityRoundId)) {
    return { state: "round_unbound" };
  }

  const snapshot = await new ProfitabilityService(supabase).getSnapshot(
    accountabilityRoundId,
  );
  if (snapshot === null) {
    return { state: "not_calculated" };
  }
  return {
    state: "available",
    snapshot,
    formatted: formatProfitabilitySnapshot(snapshot),
  };
}

/**
 * Structural guard for any downstream use (LINE push, PDF, finalization)
 * that must never run against a placeholder not-submitted summary.
 */
export function requireSubmittedWhiteSheetSummary(
  pageModel: DigitalWhiteSheetPageModel,
): DigitalWhiteSheetSummary {
  if (pageModel.entryStatus === "not_submitted") {
    throw new WhiteSheetNotSubmittedError();
  }
  return pageModel.summary;
}

/**
 * Stricter guard for anything that must not run against an untrustworthy
 * result at all — LINE push, finalization, PDF export. Requires both a
 * submitted cash entry AND the absence of the multiple-main-session HARD
 * STOP warning (see src/lib/white-sheet/warnings.ts). Duplicate sessions
 * are never auto-resolved here; the caller must surface this error and let
 * an operator investigate.
 */
export function requireTrustedWhiteSheetSummary(
  pageModel: DigitalWhiteSheetPageModel,
): DigitalWhiteSheetSummary {
  const summary = requireSubmittedWhiteSheetSummary(pageModel);
  if (hasHardStopWarning(summary.warnings)) {
    throw new WhiteSheetHardStopError();
  }
  return summary;
}
