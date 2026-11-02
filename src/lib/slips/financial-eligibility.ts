/**
 * Shared date rule for whether an AI-read slip may count as money.
 *
 * The LINE batch summary (validation-guard), reconciliation, White Sheet,
 * settlement and guided round close all apply THIS rule, so a slip the LINE
 * summary leaves รอตรวจสอบ is never inside an AI-verified financial total.
 *
 * The slip's printed transaction date (Bangkok calendar day) must be within
 * DATE_TOLERANCE_DAYS of the round's business date. The tolerance covers a
 * market that trades past midnight (business-date cutoff 04:00) and a slip paid
 * the evening before; the image's receipt time plays no part, so a correct slip
 * sent late is never excluded by this rule. A missing or unreadable date is not
 * eligible — the rule never assumes one.
 */
export const DATE_TOLERANCE_DAYS = 1;
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type SlipDateIneligibility =
  | "missing_transaction_time"
  | "invalid_transaction_time"
  | "date_out_of_round";

/** null = eligible. `businessDateIso` is the Gregorian YYYY-MM-DD business date. */
export function slipDateIneligibility(
  transactionTime: string | null | undefined,
  businessDateIso: string,
): SlipDateIneligibility | null {
  if (!transactionTime) return "missing_transaction_time";
  const txMs = Date.parse(transactionTime);
  if (!Number.isFinite(txMs)) return "invalid_transaction_time";
  const txDay = new Date(txMs + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
  const diffDays = Math.abs(Date.parse(txDay) - Date.parse(businessDateIso)) / DAY_MS;
  return diffDays > DATE_TOLERANCE_DAYS ? "date_out_of_round" : null;
}
