/**
 * The one and only way to produce a PurchasePlanningReport from the database.
 *
 * Read-only. Writes nothing, seeds no price, and adds no table of its own —
 * every source below already exists and is reused rather than reinterpreted:
 *
 *   fetchSalesProduceRows        persisted, void-filtered produce_transactions.
 *                                Deliberately applies NO server-side
 *                                transaction_type filter, because the legacy
 *                                "เสีย" spelling is not normalized by the view
 *                                and filtering it away would understate returns
 *                                and overstate what sold.
 *   loadRoundReturnStatuses      per-round return evidence (persisted / blocked
 *                                / pending / none).
 *   loadProduceFailureScan       produce documents that never landed, plus the
 *                                rounds whose return attempt is still failing.
 *   fetchAuthoritativeHouseStockItems
 *                                the single authoritative P2A house snapshot.
 *
 * House stock is loaded through the SAME authoritative selection the formatted
 * 🏠 report uses, so the two can never disagree about which snapshot counts.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { logger } from "@/lib/logger";
import { fetchSalesProduceRows, loadProduceFailureScan } from "@/lib/sales/load";
import {
  activeUnboundReturnIdentities,
  loadRoundReturnStatuses,
  roundsWithIncompleteReturn,
  type RoundReturnState,
} from "@/lib/produce/round-return-status";
import { activeIncompleteReturnRoundIds } from "@/lib/produce/failure-lifecycle";
import {
  fetchAuthoritativeHouseStockItems,
  HouseStockSnapshotConflictError,
} from "@/lib/physical-inventory/house-stock-report";
import {
  buildPurchasePlanningReport,
  type HouseStockEntry,
  type HouseStockSignal,
  type PurchasePlanningReport,
  type UnresolvedProduceSessionCounts,
} from "@/lib/summary/purchase-planning";
import { collectUnattributableWithdrawalScopes } from "@/lib/summary/unattributable-withdrawal";

type Supabase = SupabaseClient<Database>;

/**
 * The authoritative snapshot's items as comparable quantities.
 *
 * REJECTED observations are dropped: they are stored evidence of a keying
 * mistake, not a counted quantity. Everything else keeps its own product and
 * unit exactly as captured — canonicalization happens once, in the calculator,
 * against the market side through the same function.
 */
function houseStockEntries(
  items: readonly Database["public"]["Tables"]["physical_inventory_items"]["Row"][],
): HouseStockEntry[] {
  const entries: HouseStockEntry[] = [];
  for (const item of items) {
    if (item.resolution_status === "REJECTED") continue;
    const productName = item.normalized_product?.trim() || item.raw_product_description?.trim();
    const unit = item.normalized_unit?.trim() || item.raw_unit?.trim();
    const quantity = item.quantity;
    if (!productName || !unit) continue;
    if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity < 0) continue;
    entries.push({ productName, unit, quantity });
  }
  return entries;
}

/**
 * A missing, ambiguous or unreadable house snapshot never fails the report — it
 * only removes the stock signal, which keeps every HIGH sell-through product
 * conservative instead of confidently green.
 */
async function loadHouseStockSignal(
  supabase: Supabase,
  businessDate: string,
): Promise<HouseStockSignal> {
  try {
    const snapshot = await fetchAuthoritativeHouseStockItems(supabase, businessDate);
    if (!snapshot) return { status: "none" };
    const entries = houseStockEntries(snapshot.items);
    // An accepted empty count is a complete house: nothing left at home.
    // That is not the same as no snapshot, which stays unknown.
    if (entries.length === 0) return { status: "empty" };
    return { status: "available", entries };
  } catch (err) {
    if (err instanceof HouseStockSnapshotConflictError) {
      logger.warn("purchase-planning.house-stock.conflict", { businessDate });
      return { status: "conflict" };
    }
    logger.warn("purchase-planning.house-stock.unavailable", {
      businessDate,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "unavailable" };
  }
}

const SESSION_LOOKUP_CHUNK = 500;

/**
 * Sessions whose persisted rows are not provably everything the document said.
 *
 * Same two findings P1 Sales blocks an identity on (loadSessionIssues in
 * src/lib/sales/load.ts): the parser admitted it could not read every line, or
 * a different number of rows landed than the session claimed to have parsed.
 * A requested id that produce_sessions does not return is the same failure —
 * completeness is unprovable. A ชั่งคืน document that lost a line understates
 * the return and would inflate this report's sold quantity, so its products
 * must not be ranked.
 */
async function loadUnreliableSessionIds(
  supabase: Supabase,
  rows: readonly { session_id: string }[],
): Promise<Set<string>> {
  const unreliable = new Set<string>();
  const persistedCounts = new Map<string, number>();
  for (const row of rows) {
    persistedCounts.set(row.session_id, (persistedCounts.get(row.session_id) ?? 0) + 1);
  }
  const sessionIds = [...persistedCounts.keys()];
  if (sessionIds.length === 0) return unreliable;

  for (let offset = 0; offset < sessionIds.length; offset += SESSION_LOOKUP_CHUNK) {
    const chunk = sessionIds.slice(offset, offset + SESSION_LOOKUP_CHUNK);
    const { data, error } = await supabase
      .from("produce_sessions")
      .select("id, total_items, parser_errors")
      .in("id", chunk);
    if (error) throw new Error(`produce session integrity query failed: ${error.message}`);

    // Missing metadata cannot prove completeness. data == null and [] are the
    // same: every requested id that did not come back is unreliable.
    const returned = data ?? [];
    const found = new Set(returned.map((session) => session.id));
    for (const sessionId of chunk) {
      if (!found.has(sessionId)) unreliable.add(sessionId);
    }

    for (const session of returned) {
      const parserErrors = session.parser_errors;
      const hasParserErrors = Array.isArray(parserErrors)
        ? parserErrors.length > 0
        : parserErrors != null;
      // Every item of a session shares its session_date, so the rows loaded for
      // this business date are that session's complete persisted item set.
      const countMismatch = (persistedCounts.get(session.id) ?? 0) !== session.total_items;
      if (hasParserErrors || countMismatch) unreliable.add(session.id);
    }
  }

  return unreliable;
}

/**
 * True when a still-failing return/damage document cannot be blamed on a round.
 *
 * A raw message that never became a session always has a null round
 * (rawMessageFailureAttempt hard-codes it), and a plain-text pending session
 * may too — so activeIncompleteReturnRoundIds can never bind them to a product.
 * Their only possible effect is that MORE came back than the day recorded,
 * which inflates every sold quantity. An unknown transaction kind counts here
 * as well: fail closed.
 */
function hasUnattributedIncompleteReturns(
  failures: Awaited<ReturnType<typeof loadProduceFailureScan>>,
): boolean {
  return failures.attempts.some(
    (attempt) =>
      failures.activeIds.has(attempt.attemptId)
      && attempt.transactionKind !== "เบิก"
      && !attempt.accountabilityRoundId?.trim(),
  );
}

/** Active failed documents split without changing their fail-closed lifecycle. */
function unresolvedSessionCounts(
  failures: Awaited<ReturnType<typeof loadProduceFailureScan>>,
): UnresolvedProduceSessionCounts {
  const counts: UnresolvedProduceSessionCounts = {
    withdrawal: 0,
    goodReturn: 0,
    damagedReturn: 0,
    unknown: 0,
  };

  for (const attempt of failures.attempts) {
    if (!failures.activeIds.has(attempt.attemptId)) continue;
    if (attempt.transactionKind === "เบิก") counts.withdrawal += 1;
    else if (attempt.transactionKind === "คืน") counts.goodReturn += 1;
    else if (attempt.transactionKind === "คืนเสีย") counts.damagedReturn += 1;
    else counts.unknown += 1;
  }

  return counts;
}

export async function loadPurchasePlanningReport(
  supabase: Supabase,
  businessDate: string,
): Promise<PurchasePlanningReport> {
  const [rows, failures, houseStock] = await Promise.all([
    fetchSalesProduceRows(supabase, businessDate),
    loadProduceFailureScan(supabase, businessDate),
    loadHouseStockSignal(supabase, businessDate),
  ]);
  const roundStatuses = await loadRoundReturnStatuses(supabase, businessDate,
    activeUnboundReturnIdentities(failures.attempts, failures.classifications, businessDate));

  const roundReturnStates = new Map<string, RoundReturnState>(
    roundStatuses.map((round) => [round.accountabilityRoundId, round.state]),
  );

  const unreliableSessionIds = await loadUnreliableSessionIds(supabase, rows);

  return buildPurchasePlanningReport({
    businessDate,
    rows,
    roundReturnStates,
    // Same union the Sales report uses, so "this round's ชั่งคืน is unfinished"
    // means one thing across both reports.
    incompleteReturnRounds: new Set([
      ...roundsWithIncompleteReturn(roundStatuses),
      ...activeIncompleteReturnRoundIds(failures.attempts, failures.classifications),
    ]),
    unreliableSessionIds,
    hasUnattributedIncompleteReturns: hasUnattributedIncompleteReturns(failures),
    // One scan already loaded above; activeIds is its unresolved-document count.
    // Deliberately a SUPERSET of P1 Sales' unresolved_pending_session figure —
    // it also counts lost raw messages and deferred rejects, which is the
    // conservative direction for a purchasing decision.
    unresolvedSessionCount: failures.activeIds.size,
    unresolvedSessionCounts: unresolvedSessionCounts(failures),
    unattributableWithdrawalScopes: collectUnattributableWithdrawalScopes(
      failures.attempts,
      failures.classifications,
    ),
    houseStock,
  });
}
