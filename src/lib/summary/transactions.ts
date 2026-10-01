// "เสีย" is a legacy spelling of "คืนเสีย" found in imported data
// (transaction_type has no CHECK constraint — see migration 0011).
export const KNOWN_TX_TYPES = ["เบิก", "เบิกเพิ่ม", "คืน", "คืนเสีย", "เสีย"] as const;

export type TransactionBucket = "เบิก" | "คืน" | "คืนเสีย";

export interface TransactionAmountRow {
  transaction_type: string;
  total_amount: number | null;
}

export interface TransactionTotals {
  เบิก: number;
  คืน: number;
  คืนเสีย: number;
  ยอดส่ง: number;
}

/** Whether effective persisted rows exist for each Produce bucket. Distinct from a numeric 0. */
export interface ProduceBucketPresence {
  เบิก: boolean;
  คืน: boolean;
  คืนเสีย: boolean;
}

export interface SettlementTotals {
  ยอดโอน: number;
  เงินสด: number;
  ค่าใช้จ่าย: number;
  ค่าแรง: number;
  ยอดขาย: number;
  เงินสดต้องส่งเจ๊: number;
  ขาดเกิน: number;
}

export function emptyTransactionTotals(): TransactionTotals {
  return { เบิก: 0, คืน: 0, คืนเสีย: 0, ยอดส่ง: 0 };
}

export function emptyProduceBucketPresence(): ProduceBucketPresence {
  return { เบิก: false, คืน: false, คืนเสีย: false };
}

export function transactionBucket(type: string): TransactionBucket | null {
  if (type === "เบิก" || type === "เบิกเพิ่ม") return "เบิก";
  if (type === "คืน") return "คืน";
  if (type === "คืนเสีย" || type === "เสีย") return "คืนเสีย";
  return null;
}

export function isKnownTransactionType(type: string): boolean {
  return transactionBucket(type) !== null;
}

/**
 * Normalizes any stored transaction type onto its accounting base type.
 * Unlike transactionBucket (which preserves legacy totals behavior exactly),
 * this also maps the legacy ชั่งคืนเพิ่ม/คืนเสียเพิ่ม marker rows — used for
 * grouping additional-batch day totals, not for existing report buckets.
 */
export function baseTransactionType(type: string): TransactionBucket | null {
  if (type === "ชั่งคืนเพิ่ม") return "คืน";
  if (type === "คืนเสียเพิ่ม") return "คืนเสีย";
  return transactionBucket(type);
}

export function addTransactionAmount<T extends TransactionTotals>(
  totals: T,
  row: TransactionAmountRow,
): T {
  const bucket = transactionBucket(row.transaction_type);
  if (!bucket) return totals;

  totals[bucket] += row.total_amount ?? 0;
  totals.ยอดส่ง = calculateYodSong(totals);
  return totals;
}

/** Sum trusted Produce rows and record which buckets actually had evidence. */
export function summarizeProduceTransactionRows(
  rows: readonly TransactionAmountRow[],
): {
  totals: TransactionTotals;
  presence: ProduceBucketPresence;
  effectiveRowCount: number;
} {
  const totals = emptyTransactionTotals();
  const presence = emptyProduceBucketPresence();
  for (const row of rows) {
    const bucket = transactionBucket(row.transaction_type);
    if (bucket && row.total_amount !== null) presence[bucket] = true;
    addTransactionAmount(totals, row);
  }
  return { totals, presence, effectiveRowCount: rows.length };
}

export type ProduceNetStatus = "trusted" | "returns_exceed_withdrawal";

/**
 * Returns are measured evidence and may legitimately persist even when the
 * earlier withdrawal document is incomplete. A negative Produce net is still
 * not an authoritative financial result, so money-facing callers must check
 * this status before presenting or finalizing dependent values.
 */
export function produceNetStatus({
  เบิก,
  คืน,
  คืนเสีย,
}: Pick<TransactionTotals, "เบิก" | "คืน" | "คืนเสีย">): ProduceNetStatus {
  // Monetary rows are 2dp; this only absorbs floating-point dust.
  return คืน + คืนเสีย > เบิก + 0.005 ? "returns_exceed_withdrawal" : "trusted";
}

export function calculateYodSong({
  เบิก,
  คืน,
  คืนเสีย,
}: Pick<TransactionTotals, "เบิก" | "คืน" | "คืนเสีย">): number {
  return เบิก - คืน - คืนเสีย;
}

export function calculateSettlementTotals({
  ยอดส่ง,
  money_transfer,
  money_cash,
  expenses = 0,
  labor = 0,
}: {
  ยอดส่ง: number;
  money_transfer: number;
  money_cash: number;
  expenses?: number;
  labor?: number;
}): SettlementTotals {
  const ยอดขาย = money_transfer + money_cash + expenses + labor;
  return {
    ยอดโอน: money_transfer,
    เงินสด: money_cash,
    ค่าใช้จ่าย: expenses,
    ค่าแรง: labor,
    ยอดขาย,
    เงินสดต้องส่งเจ๊: ยอดส่ง - money_transfer - expenses - labor,
    ขาดเกิน: ยอดขาย - ยอดส่ง,
  };
}
