// Shared reconciliation-report logic — the SINGLE source of truth for report
// status derivation and summary math. Both the report page and the Excel
// export import from here so the financial logic is never duplicated.
//
// The core reconciliation formula lives in `src/lib/reconciliation.ts`:
//   checked_slip_total = ai_verified_total + manual_slip_total
//   difference         = submitted_transfer_total - checked_slip_total
//   matched            = difference === 0
// This module does NOT recompute those numbers; it reads the already-computed
// `transfer_reconciliations` row and derives an auditable status from it.

export type ReconciliationStatus =
  | "matched"
  | "transfer_short"
  | "transfer_over"
  | "pending_review"
  | "missing_data";

/** Status filter values accepted by the report. "exception" = any non-matched. */
export type ReconciliationStatusFilter = ReconciliationStatus | "exception";

export interface ReconciliationReportRow {
  /** LINE group / source the reconciliation belongs to. */
  source_id:                string;
  /** Business date (ISO yyyy-mm-dd, 04:00 Bangkok cutoff). */
  business_date:            string;
  /** Accountability round identity; null only for legacy/unbound records. */
  accountability_round_id:   string | null;
  /** Display market label, or the raw source_id when no label is known. */
  market:                   string;
  /** null when no reconciliation row exists for this key (missing data). */
  submitted_transfer_total: number | null;
  ai_verified_total:        number | null;
  manual_slip_total:        number | null;
  checked_slip_total:       number | null;
  difference:               number | null;
  status:                   ReconciliationStatus;
  /** True when a manual slip session is still open (reconciliation not final). */
  has_open_manual_session:  boolean;
}

export interface ReconciliationSummary {
  submitted_transfer_total: number;
  checked_slip_total:       number;
  difference_total:         number;
  /** Rows whose status is not "matched". */
  needs_review_count:       number;
  total_count:              number;
}

const EPSILON = 0.005; // money is numeric(12,2); guard against float dust.

/**
 * Derive an auditable reconciliation status. Pure and deterministic.
 *
 * Precedence (most-blocking first):
 *  1. open manual session  → pending_review (reconciliation cannot be trusted yet)
 *  2. no reconciliation row → missing_data   (settlement never finalized)
 *  3. difference is null    → missing_data
 *  4. |difference| ≈ 0       → matched
 *  5. difference > 0         → transfer_over  (transferred more than checked slips)
 *  6. difference < 0         → transfer_short (transferred less than checked slips)
 */
export function deriveReconciliationStatus(input: {
  hasReconciliation:     boolean;
  hasOpenManualSession:  boolean;
  difference:            number | null;
}): ReconciliationStatus {
  if (input.hasOpenManualSession) return "pending_review";
  if (!input.hasReconciliation)   return "missing_data";
  if (input.difference == null)   return "missing_data";

  if (Math.abs(input.difference) < EPSILON) return "matched";
  return input.difference > 0 ? "transfer_over" : "transfer_short";
}

/** A row needs review when it is anything other than a clean match. */
export function rowNeedsReview(status: ReconciliationStatus): boolean {
  return status !== "matched";
}

/**
 * Aggregate summary metrics over the given rows. Null financials count as 0 in
 * the totals (we never fabricate a value for missing source records), but the
 * row is still counted toward needs_review_count.
 */
export function summarizeReconciliationReport(
  rows: ReconciliationReportRow[],
): ReconciliationSummary {
  let submitted = 0;
  let checked   = 0;
  let diff      = 0;
  let needsReview = 0;

  for (const r of rows) {
    submitted += r.submitted_transfer_total ?? 0;
    checked   += r.checked_slip_total ?? 0;
    diff      += r.difference ?? 0;
    if (rowNeedsReview(r.status)) needsReview++;
  }

  return {
    submitted_transfer_total: submitted,
    checked_slip_total:       checked,
    difference_total:         diff,
    needs_review_count:       needsReview,
    total_count:              rows.length,
  };
}

/** Apply a status filter. "exception" keeps every non-matched row. */
export function filterByStatus(
  rows: ReconciliationReportRow[],
  filter: ReconciliationStatusFilter | undefined,
): ReconciliationReportRow[] {
  if (!filter) return rows;
  if (filter === "exception") return rows.filter((r) => rowNeedsReview(r.status));
  return rows.filter((r) => r.status === filter);
}

// ── Thai-first labels (shared by UI and export) ───────────────────────────────

export const STATUS_LABEL_TH: Record<ReconciliationStatus, string> = {
  matched:        "ตรงกัน",
  transfer_short: "โอนขาด",
  transfer_over:  "โอนเกิน",
  pending_review: "รอตรวจสอบ",
  missing_data:   "ข้อมูลไม่ครบ",
};

export const STATUS_FILTER_OPTIONS: { value: ReconciliationStatusFilter; label: string }[] = [
  { value: "exception",      label: "เฉพาะที่ต้องตรวจสอบ" },
  { value: "matched",        label: STATUS_LABEL_TH.matched },
  { value: "transfer_short", label: STATUS_LABEL_TH.transfer_short },
  { value: "transfer_over",  label: STATUS_LABEL_TH.transfer_over },
  { value: "pending_review", label: STATUS_LABEL_TH.pending_review },
  { value: "missing_data",   label: STATUS_LABEL_TH.missing_data },
];
