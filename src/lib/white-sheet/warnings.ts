/**
 * Shared warning classification for the White Sheet calculation output.
 * Single source of truth for both the Dashboard presentation layer
 * (src/components/white-sheet/white-sheet-presentation.ts) and any
 * server-side boundary that must refuse to trust/send a result (LINE push,
 * finalization) — see requireTrustedWhiteSheetSummary in ./compose.
 *
 * The multiple-completed-main-session warning (see load.ts
 * multipleSessionWarnings) is a HARD STOP when multiple ACTIVE main sessions
 * of the same base_transaction_type remain for a market/date. Voided sessions
 * are already excluded by produce_transactions (0037). Duplicate sessions are
 * never auto-resolved; this only classifies the warning so every consumer
 * treats it the same way.
 */
const HARD_STOP_WARNING_PREFIX = "Multiple completed main produce sessions";

export const UNATTRIBUTED_VERIFIED_TRANSFER_WARNING =
  "พบสลิปที่ยืนยันแล้วแต่ไม่สามารถระบุตลาดให้ตรงกับรายการของวันนี้ได้ กรุณาตรวจสอบก่อนใช้ยอดสรุป";

/** BR-02: an accepted slip with no reference ID must not enter verifiedTransfers until manually resolved. */
export const PENDING_REFERENCE_VERIFIED_TRANSFER_WARNING =
  "พบสลิปที่ยืนยันแล้วแต่ยังไม่มีเลขอ้างอิง ต้องรอผู้ดูแลระบบยืนยันก่อนนับเป็นยอดโอน";

/** BR-01: central selling price is missing for a product/unit/date — never guessed. */
export const MISSING_CENTRAL_PRICE_WARNING_PREFIX =
  "ไม่พบราคากลางสำหรับ";

/**
 * Entered withdrawal prices vary inside one accountability round. This is an
 * advisory only: every entered price is preserved and totals remain usable.
 */
export const CENTRAL_PRICE_CONFLICT_WARNING_PREFIX =
  "ราคากลางขัดแย้งกันสำหรับ";

export function isHardStopWarning(warning: string): boolean {
  return warning.startsWith(HARD_STOP_WARNING_PREFIX)
    || warning.startsWith(UNATTRIBUTED_VERIFIED_TRANSFER_WARNING)
    || warning.startsWith(PENDING_REFERENCE_VERIFIED_TRANSFER_WARNING)
    || warning.startsWith(MISSING_CENTRAL_PRICE_WARNING_PREFIX);
}

export function hasHardStopWarning(warnings: readonly string[]): boolean {
  return warnings.some(isHardStopWarning);
}

export function splitWhiteSheetWarnings(warnings: readonly string[]): {
  hardStopWarnings: string[];
  otherWarnings: string[];
} {
  const hardStopWarnings: string[] = [];
  const otherWarnings: string[] = [];
  for (const warning of warnings) {
    (isHardStopWarning(warning) ? hardStopWarnings : otherWarnings).push(warning);
  }
  return { hardStopWarnings, otherWarnings };
}

function formatBaht(amount: number): string {
  return amount.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function unattributedVerifiedTransferWarning(
  count: number,
  amount: number,
): string {
  return `${UNATTRIBUTED_VERIFIED_TRANSFER_WARNING} (${count} รายการ, ${formatBaht(amount)} บาท)`;
}

export function pendingReferenceVerifiedTransferWarning(
  count: number,
  amount: number,
): string {
  return `${PENDING_REFERENCE_VERIFIED_TRANSFER_WARNING} (${count} รายการ, ${formatBaht(amount)} บาท)`;
}

export function missingCentralPriceWarning(
  productKey: string,
  unitKey: string,
  businessDate: string,
): string {
  return `${MISSING_CENTRAL_PRICE_WARNING_PREFIX} ${productKey} (${unitKey}) วันที่ ${businessDate}`;
}

export function centralPriceConflictWarning(
  productKey: string,
  unitKey: string,
  businessDate: string,
): string {
  return `${CENTRAL_PRICE_CONFLICT_WARNING_PREFIX} ${productKey} (${unitKey}) วันที่ ${businessDate} `
    + "ภายในรอบเดียวกัน — ใช้ราคาที่บันทึกไว้ทุกบรรทัดคำนวณยอด";
}
