import { normalizedMarketLabel } from "@/lib/market";
import { centralPriceMapKey } from "@/lib/white-sheet/pricing";

/** Persisted round identity wins; legacy rows fall back to their market. */
export function salePriceScopeKey(
  accountabilityRoundId: string | null | undefined,
  marketName: string | null | undefined,
): string {
  const round = accountabilityRoundId?.trim();
  return round ? `round:${round}` : `market:${normalizedMarketLabel(marketName)}`;
}

export function scopedSalePriceKey(
  accountabilityRoundId: string | null | undefined,
  marketName: string | null | undefined,
  productKey: string,
  unitKey: string,
): string {
  return `${salePriceScopeKey(accountabilityRoundId, marketName)}\u0001${centralPriceMapKey(productKey, unitKey)}`;
}
