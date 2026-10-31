import { determineSlipCheckStatus, type SlipExtraction } from "@/lib/slips/extraction-schema";
import type { EvidenceFlags } from "@/lib/slips/validation-guard";
import { selectEffectiveAmount } from "@/lib/slips/validation-guard";
import type { SlipCheckStatus } from "@/types/database";

/**
 * Read-only diagnosis of ONE stored slip image: why it was or was not a
 * confirmed sale. Explains the existing rules; changes none of them.
 */
export type SlipDiagnosis =
  | "CONFIRMED"
  | "INGEST_FAILED"            // image never became evidence in the batch
  | "OCR_FAILED"               // provider/processing error, no extraction
  | "OCR_PENDING"              // still PROCESSING / no check row
  | "NOT_A_PAYMENT_TYPE"       // UNKNOWN / NUMBERS_ONLY / WHITE_PAPER: never counted
  | "NO_AMOUNT_READ"           // payment type, but no usable amount at all
  | "AMOUNT_READ_STATUS_RULE"  // amount read, but required fields missing -> NEED_REVIEW
  | "AMOUNT_READ_GUARD"        // amount read and status verified, batch guard flagged it
  | "AMOUNT_READ_DUPLICATE";   // flagged only as a duplicate (in batch or global)

export interface StoredCheck {
  status: SlipCheckStatus | null;
  failureReason: string | null;
  extraction: SlipExtraction | null;
}

/** Which fields determineSlipCheckStatus wanted and did not get. */
export function missingForConfirmation(e: SlipExtraction): string[] {
  const missing: string[] = [];
  const bank = e.slipType === "BANK_SLIP_QR" || e.slipType === "BANK_SLIP_NO_QR";
  const wallet = e.slipType === "THAI_HELP_THAI" || e.slipType === "GWALLET";
  if (!bank && !wallet) return [`slip_type=${e.slipType}`];
  if (bank && e.transferAmount === null) missing.push("transfer_amount");
  if (wallet) {
    if (e.grossAmount === null) missing.push("gross_amount");
    if (e.discountAmount === null) missing.push("discount_amount");
    if (e.paidAmount === null) missing.push("paid_amount");
  }
  if (e.transactionTime === null) missing.push("transaction_time");
  if (e.referenceId === null) missing.push("reference_id");
  return missing;
}

/** Any amount the model visibly read, even one the rules did not accept. */
export function anyReadAmount(e: SlipExtraction): number | null {
  return selectEffectiveAmount(e.slipType, e.transferAmount, e.paidAmount, e.grossAmount, e.discountAmount)
    ?? [e.headlineTotalAmount, e.grossAmount, e.transferAmount, e.paidAmount]
      .find((a): a is number => a !== null && a > 0) ?? null;
}

export function diagnoseSlipImage(
  attached: boolean,
  check: StoredCheck | null,
  flags: EvidenceFlags | null,
): { diagnosis: SlipDiagnosis; detail: string[] } {
  if (!attached) return { diagnosis: "INGEST_FAILED", detail: [] };
  if (!check || check.status === null || check.status === "PROCESSING") return { diagnosis: "OCR_PENDING", detail: [] };
  const e = check.extraction;
  if (check.status === "FAILED" || !e) return { diagnosis: "OCR_FAILED", detail: [check.failureReason ?? "unknown"] };
  if (!["BANK_SLIP_QR", "BANK_SLIP_NO_QR", "THAI_HELP_THAI", "GWALLET"].includes(e.slipType)) {
    return { diagnosis: "NOT_A_PAYMENT_TYPE", detail: [`slip_type=${e.slipType}`, `amount_seen=${anyReadAmount(e) ?? "none"}`] };
  }
  if (anyReadAmount(e) === null) return { diagnosis: "NO_AMOUNT_READ", detail: missingForConfirmation(e) };
  const status = determineSlipCheckStatus(e);
  if (status !== "EXTRACTED" && status !== "PARTIAL_EXTRACTED") {
    return { diagnosis: "AMOUNT_READ_STATUS_RULE", detail: [`status=${status}`, ...missingForConfirmation(e)] };
  }
  if (flags?.flagged) {
    const onlyDuplicate = flags.flagReasons.every((r) => r === "สลิปซ้ำ");
    return { diagnosis: onlyDuplicate ? "AMOUNT_READ_DUPLICATE" : "AMOUNT_READ_GUARD", detail: flags.flagReasons };
  }
  return { diagnosis: "CONFIRMED", detail: status === "PARTIAL_EXTRACTED" ? ["partial", ...missingForConfirmation(e)] : [] };
}
