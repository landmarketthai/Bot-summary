/**
 * Selling-price review — what prices were actually entered inside each
 * accountability round.
 *
 * Price accountability is round-scoped. Two markets may legitimately sell the
 * same product for different prices on the same date; only variation within
 * one round is an advisory worth surfacing.
 *
 * This module answers the question the operator actually has: which prices were
 * seen, how often, in which markets, and what (if anything) is approved.
 *
 * It never picks a price. No majority rule, no latest-wins, no min/max. It also
 * never touches a withdrawal: the raw transaction keeps the price that was
 * entered, always. The legacy central row is display metadata, not authority.
 */

import { resolveWithdrawalUnitPriceBaht } from "@/lib/white-sheet/calculate";
import { normalizedMarketLabel } from "@/lib/market";
import { scopedSalePriceKey } from "./round-pricing";
import {
  centralPriceKey,
  centralPriceMapKey,
  SYSTEM_WITHDRAWAL_SEED_ACTOR,
  type CentralPriceMapEntry,
} from "@/lib/white-sheet/pricing";

/** One price that really appears on the day's withdrawals. */
export interface CentralPriceCandidate {
  priceSatang: number;
  /** How many withdrawal rows carry it. */
  occurrenceCount: number;
  /** Every market it was entered in, sorted. */
  affectedMarkets: string[];
}

export type CentralPriceStatus =
  /** Several prices exist and no administrator has chosen one. */
  | "unresolved"
  /** An administrator explicitly set the price for this identity. */
  | "approved"
  /** One price only, established by the deployed first-withdrawal seed rule. */
  | "seeded"
  /** Withdrawals exist but no central price row does. */
  | "missing";

export interface CentralPriceReviewItem {
  productKey: string;
  /** The product as the operator wrote it — for display only, never identity. */
  productDisplayName: string;
  unitKey: string;
  businessDate: string;
  status: CentralPriceStatus;
  candidates: CentralPriceCandidate[];
  /** Backward-compatible central-price display value; reports use entered prices. */
  approvedPriceSatang: number | null;
  /** Who set it: an admin actor id, the seed sentinel, or null. */
  approvedBy: string | null;
  /** Present for round-scoped operational review; absent for legacy admin/day review. */
  accountabilityRoundId?: string | null;
  /** Legacy fallback scope when a historical row has no round id. */
  scopeMarketName?: string | null;
}

/** One withdrawal row, reduced to what pricing needs. */
export interface WithdrawalPriceRow {
  productName: string | null;
  unit: string | null;
  marketName: string | null;
  pricePerUnit: number | null;
  basisQuantity: number | null;
  baseTransactionType: string | null;
  accountabilityRoundId?: string | null;
}

interface CandidateAggregate {
  accountabilityRoundId: string | null;
  centralMapKey: string;
  productDisplayName: string;
  prices: Map<number, { count: number; markets: Set<string> }>;
}

/**
 * Group the day's withdrawal prices by the SAME canonical identity the report
 * prices with (centralPriceKey), so a candidate list can never describe an
 * identity the calculator files under a different key.
 *
 * Rows missing a product, a unit or a price contribute nothing: they are not
 * evidence of a price, and the existing entry validation already reports them.
 */
export function collectCentralPriceCandidates(
  rows: readonly WithdrawalPriceRow[],
  businessDate: string,
): Map<string, CandidateAggregate & { productKey: string; unitKey: string }> {
  const byIdentity = new Map<
    string,
    CandidateAggregate & { productKey: string; unitKey: string }
  >();

  for (const row of rows) {
    if (row.baseTransactionType?.trim() !== "เบิก") continue;
    const productName = row.productName?.trim();
    const rawUnit = row.unit?.trim();
    if (!productName || !rawUnit || row.pricePerUnit === null) continue;

    let key;
    try {
      key = centralPriceKey({ productName, unit: rawUnit, businessDate });
    } catch {
      // An identity the pricing boundary refuses cannot be reviewed here; the
      // Sales report already blocks it through invalid_identity.
      continue;
    }
    const centralMapKey = centralPriceMapKey(key.productKey, key.unitKey);
    const accountabilityRoundId = row.accountabilityRoundId?.trim() || null;
    const market = normalizedMarketLabel(row.marketName);
    // Round id is the primary accountability scope. Pre-round legacy rows fall
    // back to their market rather than poisoning every market on the date.
    const mapKey = scopedSalePriceKey(accountabilityRoundId, market, key.productKey, key.unitKey);

    const priceSatang = Math.round(
      resolveWithdrawalUnitPriceBaht({
        unit: rawUnit,
        unitPrice: Number(row.pricePerUnit),
        basisQuantity: row.basisQuantity === null ? null : Number(row.basisQuantity),
      }) * 100,
    );

    const entry = byIdentity.get(mapKey) ?? {
      productKey: key.productKey,
      unitKey: key.unitKey,
      accountabilityRoundId,
      centralMapKey,
      productDisplayName: productName,
      prices: new Map<number, { count: number; markets: Set<string> }>(),
    };
    const bucket = entry.prices.get(priceSatang) ?? { count: 0, markets: new Set<string>() };
    bucket.count += 1;
    if (market) bucket.markets.add(market);
    entry.prices.set(priceSatang, bucket);
    byIdentity.set(mapKey, entry);
  }

  return byIdentity;
}

/**
 * The full price review for one business date.
 *
 * Status rules for backward-compatible review metadata:
 *
 *   no stored row                      → missing
 *   stored by an admin                 → approved  (display metadata)
 *   stored by the seed, one candidate  → seeded
 *   several prices in this one scope   → unresolved (advisory only)
 */
export function buildCentralPriceReview(
  rows: readonly WithdrawalPriceRow[],
  businessDate: string,
  stored: ReadonlyMap<string, CentralPriceMapEntry>,
): CentralPriceReviewItem[] {
  const grouped = collectCentralPriceCandidates(rows, businessDate);
  const items: CentralPriceReviewItem[] = [];

  for (const entry of grouped.values()) {
    const candidates: CentralPriceCandidate[] = [...entry.prices]
      .map(([priceSatang, bucket]) => ({
        priceSatang,
        occurrenceCount: bucket.count,
        affectedMarkets: [...bucket.markets].sort((a, b) => a.localeCompare(b, "th")),
      }))
      .sort((a, b) => a.priceSatang - b.priceSatang);

    const storedEntry = stored.get(entry.centralMapKey);
    const adminSet = Boolean(storedEntry) && storedEntry!.setBy !== SYSTEM_WITHDRAWAL_SEED_ACTOR;

    let status: CentralPriceStatus;
    if (candidates.length > 1) status = "unresolved";
    else if (!storedEntry) status = "missing";
    else if (adminSet) status = "approved";
    else status = "seeded";

    items.push({
      accountabilityRoundId: entry.accountabilityRoundId,
      productKey: entry.productKey,
      productDisplayName: entry.productDisplayName,
      unitKey: entry.unitKey,
      businessDate,
      status,
      candidates,
      approvedPriceSatang: storedEntry?.priceSatang ?? null,
      approvedBy: storedEntry?.setBy ?? null,
    });
  }

  return items.sort(
    (a, b) =>
      a.productDisplayName.localeCompare(b.productDisplayName, "th")
      || a.unitKey.localeCompare(b.unitKey, "th"),
  );
}

/**
 * Operational price review grouped by the accountability round that owns the
 * sale. The date-wide central catalog remains available to the admin surface,
 * but it is not allowed to turn legitimate cross-market prices into an
 * incomplete settlement.
 *
 * Historical rows without a round id fall back to their normalized market so
 * two legacy markets are not collapsed into one day-wide price decision.
 */
export function buildRoundPriceReview(
  rows: readonly WithdrawalPriceRow[],
  businessDate: string,
  stored: ReadonlyMap<string, CentralPriceMapEntry>,
): CentralPriceReviewItem[] {
  const scoped = new Map<
    string,
    CandidateAggregate & {
      productKey: string;
      unitKey: string;
      accountabilityRoundId: string | null;
      scopeMarketName: string | null;
    }
  >();

  for (const row of rows) {
    if (row.baseTransactionType?.trim() !== "เบิก") continue;
    const productName = row.productName?.trim();
    const rawUnit = row.unit?.trim();
    if (!productName || !rawUnit || row.pricePerUnit === null) continue;

    let key;
    try {
      key = centralPriceKey({ productName, unit: rawUnit, businessDate });
    } catch {
      continue;
    }

    const priceKey = centralPriceMapKey(key.productKey, key.unitKey);
    const accountabilityRoundId = row.accountabilityRoundId?.trim() || null;
    const scopeMarketName = accountabilityRoundId ? null : normalizedMarketLabel(row.marketName) || null;
    const scopeKey = accountabilityRoundId
      ? `round:${accountabilityRoundId}\u0000${priceKey}`
      : `legacy:${scopeMarketName ?? ""}\u0000${priceKey}`;
    const priceSatang = Math.round(
      resolveWithdrawalUnitPriceBaht({
        unit: rawUnit,
        unitPrice: Number(row.pricePerUnit),
        basisQuantity: row.basisQuantity === null ? null : Number(row.basisQuantity),
      }) * 100,
    );
    const entry = scoped.get(scopeKey) ?? {
      productKey: key.productKey,
      unitKey: key.unitKey,
      centralMapKey: priceKey,
      productDisplayName: productName,
      accountabilityRoundId,
      scopeMarketName,
      prices: new Map<number, { count: number; markets: Set<string> }>(),
    };
    const bucket = entry.prices.get(priceSatang) ?? { count: 0, markets: new Set<string>() };
    bucket.count += 1;
    const market = normalizedMarketLabel(row.marketName);
    if (market) bucket.markets.add(market);
    entry.prices.set(priceSatang, bucket);
    scoped.set(scopeKey, entry);
  }

  return [...scoped.values()].map((entry) => {
    const candidates: CentralPriceCandidate[] = [...entry.prices]
      .map(([priceSatang, bucket]) => ({
        priceSatang,
        occurrenceCount: bucket.count,
        affectedMarkets: [...bucket.markets].sort((a, b) => a.localeCompare(b, "th")),
      }))
      .sort((a, b) => a.priceSatang - b.priceSatang);
    const priceKey = centralPriceMapKey(entry.productKey, entry.unitKey);
    const storedEntry = stored.get(priceKey);
    const adminSet = Boolean(storedEntry) && storedEntry!.setBy !== SYSTEM_WITHDRAWAL_SEED_ACTOR;
    const status: CentralPriceStatus = candidates.length > 1
      ? "unresolved"
      : !storedEntry
        ? "missing"
        : adminSet
          ? "approved"
          : "seeded";
    return {
      productKey: entry.productKey,
      productDisplayName: entry.productDisplayName,
      unitKey: entry.unitKey,
      businessDate,
      status,
      candidates,
      approvedPriceSatang: storedEntry?.priceSatang ?? null,
      approvedBy: storedEntry?.setBy ?? null,
      accountabilityRoundId: entry.accountabilityRoundId,
      scopeMarketName: entry.scopeMarketName,
    };
  }).sort(
    (a, b) =>
      (a.accountabilityRoundId ?? a.scopeMarketName ?? "").localeCompare(
        b.accountabilityRoundId ?? b.scopeMarketName ?? "",
        "th",
      )
      || a.productDisplayName.localeCompare(b.productDisplayName, "th")
      || a.unitKey.localeCompare(b.unitKey, "th"),
  );
}

/** Identities an administrator still has to decide. */
export function unresolvedCentralPrices(
  items: readonly CentralPriceReviewItem[],
): CentralPriceReviewItem[] {
  return items.filter((item) => item.status === "unresolved");
}
