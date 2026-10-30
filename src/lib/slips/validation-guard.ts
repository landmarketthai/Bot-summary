import type { SlipCheckStatus, SlipType } from "@/types/database";

export type ValidationReason =
  | "ยอดเงินสูงผิดปกติ"
  | "สลิปซ้ำ"
  | "ไม่พบรหัสอ้างอิง"
  | "วันที่รายการไม่ตรงกับรอบ"
  | "วันที่รายการไม่ถูกต้อง"
  | "ไม่พบวันที่รายการ"
  | "ข้อมูลไม่ครบ";

export interface EvidenceFlags {
  effectiveAmount: number | null;
  flagged:         boolean;
  flagReasons:     ValidationReason[];
}

const BANGKOK_OFFSET_MS      = 7 * 60 * 60 * 1000;
const OUTLIER_MIN_BATCH_SIZE = 5;
const OUTLIER_MIN_AMOUNT_THB = 5000;
const OUTLIER_RATIO          = 10;
const DATE_TOLERANCE_DAYS    = 1;

/**
 * Parses a slip_date string into a Gregorian "YYYY-MM-DD" string or null.
 *
 * Accepts two formats:
 *   • D/M/YYYY or DD/MM/YYYY  — Gregorian or Thai Buddhist Era.
 *     Example: "10/6/2569" → 2026 → "2026-06-10"
 *   • YYYY-MM-DD              — Gregorian or Thai Buddhist Era ISO date.
 *
 * Returns null for invalid, out-of-range, or calendar-invalid inputs.
 */
export function parseBatchDate(slipDate: string | null | undefined): string | null {
  if (!slipDate) return null;
  const trimmed = slipDate.trim();

  // ISO YYYY-MM-DD — validate strictly to catch Feb-30 etc.
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (isoMatch) {
    const year  = normalizeThaiYear(parseInt(isoMatch[1], 10));
    const month = parseInt(isoMatch[2], 10);
    const day   = parseInt(isoMatch[3], 10);
    return formatValidGregorianDate(year, month, day);
  }

  // D/M/YYYY or DD/MM/YYYY, accepting Gregorian and Thai Buddhist years.
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (!match) return null;

  const day   = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const year  = normalizeThaiYear(parseInt(match[3], 10));

  return formatValidGregorianDate(year, month, day);
}

function normalizeThaiYear(year: number): number {
  return year > 2400 ? year - 543 : year;
}

function formatValidGregorianDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12)    return null;
  if (day   < 1)                  return null;
  if (year < 1900 || year > 2200) return null;

  const iso  = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const date = new Date(`${iso}T00:00:00Z`);

  if (
    !Number.isFinite(date.getTime()) ||
    date.getUTCFullYear() !== year   ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) return null;

  return iso;
}

/**
 * Returns the summary-level effective amount for a slip based on its type.
 *
 * GWALLET / THAI_HELP_THAI  → gross_amount (total sale before subsidy)
 *   Priority: 1) grossAmount  2) paidAmount + discountAmount  3) paidAmount (legacy)
 * BANK_SLIP_QR / _NO_QR    → transfer_amount
 * Any other type            → null (item goes to manual review)
 *
 * Rejects null, NaN, Infinity, zero, and negative values.
 */
export function selectEffectiveAmount(
  slipType:        SlipType | null | undefined,
  transferAmount:  number | null,
  paidAmount:      number | null,
  grossAmount?:    number | null,
  discountAmount?: number | null,
): number | null {
  let raw: number | null;
  if (slipType === "GWALLET" || slipType === "THAI_HELP_THAI") {
    const validGross   = toFinitePositive(grossAmount);
    const validPaid    = toFinitePositive(paidAmount);
    const validSubsidy = toFinitePositive(discountAmount);
    if (validGross !== null) {
      raw = validGross;
    } else if (validPaid !== null && validSubsidy !== null) {
      raw = validPaid + validSubsidy;
    } else {
      raw = paidAmount; // fallback: gross and subsidy not visible
    }
  } else if (slipType === "BANK_SLIP_QR" || slipType === "BANK_SLIP_NO_QR") {
    raw = transferAmount;
  } else {
    return null;
  }
  if (raw === null || !Number.isFinite(raw) || raw <= 0) return null;
  return raw;
}

function toFinitePositive(v: number | null | undefined): number | null {
  return v !== null && v !== undefined && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Returns the median of `values`. Returns 0 for an empty array.
 * A fresh sorted copy is made; the original array is not mutated.
 */
export function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid    = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Applies the outlier and date guards to a batch of evidences.
 *
 * `batchDateStr` must be an ISO "YYYY-MM-DD" Gregorian string or null.
 * Use `parseBatchDate` to normalize Buddhist D/M/BBBB values before calling.
 *
 * Outlier guard (batch-wide):
 *   Fires only when the batch has ≥ 5 valid extracted amounts.
 *   An item is flagged when amount ≥ 5,000 THB AND amount ≥ 10 × median.
 *
 * Duplicate guard (batch-wide):
 *   The same slip image submitted twice extracts the same bank reference_id.
 *   The second and later terminal occurrences of a non-empty referenceId are
 *   flagged "สลิปซ้ำ"; the first occurrence stays trusted. Items without a
 *   visible reference are never flagged as duplicates.
 *
 * Date guard (per-item, runs only when batchDateStr is non-null):
 *   Missing transactionTime  → "ไม่พบวันที่รายการ"
 *   Unparseable timestamp    → "วันที่รายการไม่ถูกต้อง"
 *   Date differs > 1 day     → "วันที่รายการไม่ตรงกับรอบ"  (Bangkok UTC+7)
 *
 * Only EXTRACTED and PARTIAL_EXTRACTED items are candidates for flagging.
 * Terminal items with no effective amount are flagged as "ข้อมูลไม่ครบ".
 *
 * Returns one EvidenceFlags entry per input evidence in the same order.
 */
export function computeValidationFlags(
  evidences: ReadonlyArray<{
    checkStatus:      SlipCheckStatus | null;
    slipType:         SlipType | null;
    transferAmount:   number | null;
    paidAmount:       number | null;
    grossAmount?:     number | null;
    discountAmount?:  number | null;
    transactionTime:  string | null;
    referenceId?:     string | null;
    globallyDuplicate?: boolean;
  }>,
  batchDateStr: string | null,
): EvidenceFlags[] {
  const effectiveAmounts = evidences.map((e) =>
    selectEffectiveAmount(e.slipType, e.transferAmount, e.paidAmount, e.grossAmount, e.discountAmount),
  );

  // Duplicate guard: mark the 2nd+ terminal occurrence of each reference_id.
  const seenReferences = new Set<string>();
  const isDuplicate = evidences.map((e) => {
    const isTerminal = e.checkStatus === "EXTRACTED" || e.checkStatus === "PARTIAL_EXTRACTED";
    const ref = typeof e.referenceId === "string" ? e.referenceId.trim() : "";
    if (!isTerminal || !ref) return false;
    if (seenReferences.has(ref)) return true;
    seenReferences.add(ref);
    return false;
  });

  // Collect valid amounts from terminal evidences to compute the batch median.
  const validAmounts: number[] = [];
  evidences.forEach((e, i) => {
    const a = effectiveAmounts[i];
    if (a !== null && (e.checkStatus === "EXTRACTED" || e.checkStatus === "PARTIAL_EXTRACTED")) {
      validAmounts.push(a);
    }
  });

  const median          = computeMedian(validAmounts);
  const canApplyOutlier = validAmounts.length >= OUTLIER_MIN_BATCH_SIZE;

  return evidences.map((e, i) => {
    const amount     = effectiveAmounts[i];
    const reasons: ValidationReason[] = [];
    const isTerminal = e.checkStatus === "EXTRACTED" || e.checkStatus === "PARTIAL_EXTRACTED";

    if (isTerminal) {
      // Missing reference is pending manual verification, never proven unique.
      if (!e.referenceId?.trim()) {
        reasons.push("ไม่พบรหัสอ้างอิง");
      }

      // Duplicate guard — independent of amount validity
      if (isDuplicate[i] || e.globallyDuplicate === true) {
        reasons.push("สลิปซ้ำ");
      }

      // Amount guard
      if (amount === null) {
        reasons.push("ข้อมูลไม่ครบ");
      } else if (
        canApplyOutlier &&
        amount >= OUTLIER_MIN_AMOUNT_THB &&
        median > 0 &&
        amount >= OUTLIER_RATIO * median
      ) {
        reasons.push("ยอดเงินสูงผิดปกติ");
      }

      // Date guard — independent of amount; only when batchDateStr is known
      if (batchDateStr) {
        if (!e.transactionTime) {
          reasons.push("ไม่พบวันที่รายการ");
        } else {
          const txMs = Date.parse(e.transactionTime);
          if (!Number.isFinite(txMs)) {
            reasons.push("วันที่รายการไม่ถูกต้อง");
          } else {
            const txDateStr = new Date(txMs + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
            const diffDays  =
              Math.abs(
                new Date(txDateStr).getTime() - new Date(batchDateStr).getTime(),
              ) / (1000 * 60 * 60 * 24);
            if (diffDays > DATE_TOLERANCE_DAYS) {
              reasons.push("วันที่รายการไม่ตรงกับรอบ");
            }
          }
        }
      }
    }

    return {
      effectiveAmount: amount,
      flagged:         reasons.length > 0,
      flagReasons:     reasons,
    };
  });
}
