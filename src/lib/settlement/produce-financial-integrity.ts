import {
  buildWithdrawalMaster,
  type RoundMasterRow,
} from "@/lib/produce/entry-validation";

export type ProduceFinancialIntegrity = "trusted" | "returns_exceed_withdrawal";

/**
 * Re-check the same product/unit quantity invariant used at Produce entry time,
 * but as a downstream financial safety boundary.
 *
 * Entry is intentionally allowed to persist measured returns even when the
 * earlier withdrawal is incomplete. Settlement/reporting must therefore
 * independently refuse to treat W-R-D as final whenever any canonical
 * product/unit cell has returns above its withdrawal.
 */
export function produceFinancialIntegrity(
  rows: Iterable<RoundMasterRow>,
): ProduceFinancialIntegrity {
  const master = buildWithdrawalMaster(rows);
  for (const cell of master.cells.values()) {
    if (cell.goodReturnQuantity + cell.damagedQuantity > cell.withdrawnQuantity + 1e-9) {
      return "returns_exceed_withdrawal";
    }
  }
  return "trusted";
}
