/**
 * Data Quality Inbox — THE single source of severity truth.
 *
 * Every category maps to exactly one severity, decided HERE and nowhere
 * else. No call site (a scan source, an admin route, a LINE digest) is ever
 * allowed to compute or override a severity itself — that is precisely the
 * "decided ad hoc at call sites" failure mode this module exists to prevent.
 *
 * The mapping is TOTAL by construction: it is typed as
 * `Record<DataQualityCategory, DataQualitySeverity>`, so adding a category
 * without giving it a severity is a TypeScript compile error, not a runtime
 * gap discovered in production.
 *
 *   CRITICAL         act immediately — financial close mismatch, real
 *                    duplicate persistence, quantity integrity corruption,
 *                    impossible lifecycle state.
 *   ACTION_REQUIRED  needs review — no return recorded, product missing from
 *                    a persisted return, unattributable Produce evidence,
 *                    stale failed session, unresolved recovery bundle,
 *                    incomplete financial evidence.
 *   ADVISORY         no immediate action — price conflicts where quantity is
 *                    still usable, a typo corrected successfully, other
 *                    non-blocking anomalies. NEVER escalates past ADVISORY,
 *                    regardless of how many times it recurs (see
 *                    severity.test.ts "price advisory never escalates").
 *   NORMAL           produces NO user-facing notification at all. A category
 *                    mapped to NORMAL is never written to the inbox table —
 *                    see inbox.ts `prepareAtomicUpsertPayload`, which omits a
 *                    NORMAL candidate before anything is persisted.
 */

export type DataQualitySeverity = "CRITICAL" | "ACTION_REQUIRED" | "ADVISORY" | "NORMAL";

/** Severities that are actually persisted. NORMAL never reaches the table. */
export type PersistedDataQualitySeverity = Exclude<DataQualitySeverity, "NORMAL">;

export type DataQualityCategory =
  // ── Produce (from src/lib/produce/daily-close-preflight.ts, read-only) ──
  /** A round issued produce and no successful ชั่งคืน exists for it yet. */
  | "produce_no_return"
  /** An active failed/refused session, or one still pending close. */
  | "produce_stale_failed_session"
  /** Several withdrawal prices exist for one product/unit/date; unresolved. */
  | "produce_price_conflict"
  /** Duplicate open rounds, but exactly one demonstrably holds the data. */
  | "produce_duplicate_round_review"
  /** Duplicate open rounds and no single one can be proven canonical. */
  | "produce_duplicate_round_ambiguous"
  /** Persisted produce that carries no accountability round. */
  | "produce_unattributable"
  /** One withdrawal multiset equals the union of others — evidence, not proof. */
  | "produce_possible_duplicate"
  /** Two withdrawal sessions share the same canonical business fingerprint. */
  | "produce_duplicate_persistence"
  /** More than one document could be the replacement for a failed one. */
  | "produce_lifecycle_ambiguity"
  // ── Financial (from src/lib/reconciliation-report(-service).ts) ─────────
  /** A day's transfer total does not match its checked slip total. */
  | "financial_reconciliation_mismatch"
  /** No reconciliation row yet, or a manual slip session is still open. */
  | "financial_evidence_incomplete"
  // ── Daily Financial Settlement ─────────────────────────────────────────
  /** getDailyFinancialSettlement reports a close-time mismatch. */
  | "financial_settlement_mismatch";

const CATEGORY_SEVERITY: Record<DataQualityCategory, DataQualitySeverity> = {
  produce_no_return:                  "ACTION_REQUIRED",
  produce_stale_failed_session:       "ACTION_REQUIRED",
  produce_price_conflict:             "ADVISORY",
  produce_duplicate_round_review:     "ACTION_REQUIRED",
  produce_duplicate_round_ambiguous:  "CRITICAL",
  produce_unattributable:             "ACTION_REQUIRED",
  produce_possible_duplicate:         "ACTION_REQUIRED",
  produce_duplicate_persistence:      "CRITICAL",
  produce_lifecycle_ambiguity:        "CRITICAL",
  financial_reconciliation_mismatch:  "CRITICAL",
  financial_evidence_incomplete:      "ACTION_REQUIRED",
  financial_settlement_mismatch:      "CRITICAL",
};

export const ALL_DATA_QUALITY_CATEGORIES: readonly DataQualityCategory[] =
  Object.keys(CATEGORY_SEVERITY) as DataQualityCategory[];

/** The one function every source calls. Deterministic, total, no exceptions. */
export function severityForCategory(category: DataQualityCategory): DataQualitySeverity {
  return CATEGORY_SEVERITY[category];
}

export const SEVERITY_ICON: Record<DataQualitySeverity, string> = {
  CRITICAL:        "🚨",
  ACTION_REQUIRED: "⚠️",
  ADVISORY:        "ℹ️",
  NORMAL:          "",
};

export const SEVERITY_LABEL_TH: Record<DataQualitySeverity, string> = {
  CRITICAL:        "วิกฤต — ต้องดำเนินการทันที",
  ACTION_REQUIRED: "ต้องตรวจสอบ",
  ADVISORY:        "แจ้งเพื่อทราบ",
  NORMAL:          "ปกติ",
};
