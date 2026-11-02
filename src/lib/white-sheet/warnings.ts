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

/**
 * Shared slip date rule (slips/financial-eligibility.ts): an accepted slip with
 * a missing or out-of-round printed date is not in verifiedTransfers. Advisory,
 * not a hard stop: the amount is already excluded, and the operator settles a
 * genuine one through a closed manual-slip session (no in-system override).
 */
export const PENDING_DATE_VERIFIED_TRANSFER_WARNING =
  "พบสลิปที่วันที่ในสลิปไม่ตรงกับรอบหรืออ่านวันที่ไม่ได้ ไม่นับเป็นยอดโอน ต้องตรวจมือ";

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

/** The LINE batch summary's outlier guard, applied to verifiedTransfers too. Advisory, like the date rule. */
export const PENDING_OUTLIER_VERIFIED_TRANSFER_WARNING =
  "พบสลิปยอดเงินสูงผิดปกติ ไม่นับเป็นยอดโอน ต้องตรวจมือ";

/** Manual slip entries waiting for an authorized decision (not counted). Advisory, like the date rule. */
export const PENDING_MANUAL_SLIP_WARNING = "พบสลิปมือที่รออนุมัติ ไม่นับเป็นยอดโอนจนกว่าผู้ดูแลจะอนุมัติ";

export function pendingManualSlipWarning(count: number, amount: number): string {
  return `${PENDING_MANUAL_SLIP_WARNING} (${count} รายการ, ${formatBaht(amount)} บาท)`;
}

export function pendingOutlierVerifiedTransferWarning(count: number, amount: number): string {
  return `${PENDING_OUTLIER_VERIFIED_TRANSFER_WARNING} (${count} รายการ, ${formatBaht(amount)} บาท)`;
}

export function pendingDateVerifiedTransferWarning(
  count: number,
  amount: number,
): string {
  return `${PENDING_DATE_VERIFIED_TRANSFER_WARNING} (${count} รายการ, ${formatBaht(amount)} บาท)`;
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
