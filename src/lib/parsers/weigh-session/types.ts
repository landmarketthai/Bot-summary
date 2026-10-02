export type TransactionType = "เบิก" | "เบิกเพิ่ม" | "คืน" | "คืนเสีย";
export type PricingMode     = "unit" | "basis";
export type SessionKind     = "main" | "additional";
/** The three accounting base types; the only values stored for new items. */
export type BaseTransactionType = "เบิก" | "คืน" | "คืนเสีย";

export type DraftItemActionStatus =
  | "awaiting_replacement"
  | "applied"
  | "target_not_found"
  | "ambiguous_target"
  | "invalid_replacement";

/**
 * One explicit operator edit reconstructed from the append-only draft text.
 *
 * This is parser metadata only. Finalization persists `items`, never these
 * actions; keeping both the action and the original raw text makes the
 * difference between audit history and the effective draft explicit.
 */
export interface DraftItemAction {
  kind: "correct" | "remove";
  item_number: number;
  status: DraftItemActionStatus;
  match_count: number;
  /** Occurrence selector letter typed with the number ("แก้ข้อ 52B" → "B"). */
  occurrence?: string;
  /** For ambiguous_target: the selectors that address each match ("52A"). */
  selectors?: string[];
  previous_item?: WeighSessionItem;
  replacement_item?: WeighSessionItem;
  detail?: string;
}

export interface WeighSessionItem {
  item_number:      number;
  product_name:     string;
  /** Display/back-compat per-unit price. For basis rows this is a rounded
   *  approximation — round(basis_price / basis_quantity, 2) — never the
   *  source of truth for totals; use basis_quantity/basis_unit/basis_price. */
  price_per_unit:   number;
  quantity:         number | null;
  /** Any non-empty unit text is accepted. Known spellings are normalized to
   *  a canonical form (see units.ts); unrecognized units persist as-is. */
  unit:             string | null;
  section:          string;
  transaction_type: TransactionType;
  /** "basis" for lines like "3หัว20บาท" (3 หัว for 20 บาท); "unit" for the
   *  ordinary "<product><price>บาท" + "<qty><unit>" form. */
  pricing_mode:     PricingMode;
  /** Bundled price basis, already resolved to canonical unit/quantity (see
   *  units.ts). Null for pricing_mode "unit". Total must be computed as
   *  round(quantity * basis_price / basis_quantity, 2), never pre-divided. */
  basis_quantity:   number | null;
  basis_unit:       string | null;
  basis_price:      number | null;
  /** Transient, never persisted and never part of an item's business content:
   *  the price_per_unit the pre-2026-08-19 parser would have stored for this
   *  item, back when a subunit quantity line (ขีด/กรัม/มิลลิลิตร) also
   *  rescaled the price. Present only on items a conversion touched. Read by
   *  legacySubunitPricedSession in session-dedup-service.ts, so a resend of a
   *  message imported before the price fix still matches its own reservation.
   *  Every write path builds its produce row from named fields rather than
   *  from this object, which is what keeps a second, contradictory price off
   *  the wire — see persist() in parser.ts and the RPC payload in
   *  pending-session-finalizer.ts. Anything that spreads a WeighSessionItem
   *  toward storage has to strip it. */
  legacy_subunit_price_per_unit?: number;
  /** Ephemeral operator evidence for risky subunit entry; never persisted. */
  entered_quantity?: number;
  entered_unit?: string;
  /**
   * True only when the operator actually WROTE this number in the source
   * document. Absent for the sequential number the parser synthesizes for an
   * unnumbered line (see parseItemLine's ITEM_NO_INDEX branch).
   *
   * Transient parser evidence, never persisted: the number itself is the
   * business fact, this only records where it came from. Read by
   * validateProduceEntry to tell a real "ข้อ 5 หายไป" from a list that was
   * never numbered in the first place — absent must always read as "no
   * evidence", so a path that loses this field goes quiet rather than
   * blocking a legitimate free-form draft.
   */
  item_number_explicit?: boolean;
  /**
   * Transient, never persisted: 1-based source order of this row among rows
   * sharing its typed item_number. Absent means 1. Lets a duplicate "52" be
   * addressed as 52A/52B while item_number itself stays 52.
   */
  item_occurrence?: number;
}

export interface WeighSession {
  /** ISO 8601 date converted from Thai Buddhist year, e.g. "2026-05-25" */
  date:             string | null;
  /** คนขาย — from "พี่ดำ-วิหาร เบิก" header, or falls back to sender_name */
  staff_name:       string;
  /** ผู้ส่ง LINE — from TIME_PREFIX sender field */
  sender_name:      string | null;
  /** "HH:MM" from first TIME_PREFIX in the message */
  transaction_time: string | null;
  session_title:    string | null;
  /** "additional" for append-only เบิกเพิ่ม/ชั่งคืนเพิ่ม/คืนเสียเพิ่ม batches. */
  session_kind:     SessionKind;
  /** Base transaction type declared by an additional-batch header; null for main. */
  declared_transaction_type: BaseTransactionType | null;
  items:            WeighSessionItem[];
  parse_errors:     string[];
  /**
   * Transient evidence for numbered source rows that failed before becoming
   * items. The occurrence keeps duplicate selectors such as 52A/52B stable in
   * operator review. Never persisted as business data.
   */
  failed_item_targets?: Array<{
    item_number: number;
    occurrence: number;
    parse_error: string;
  }>;
  /** Explicit same-draft edits found while replaying the raw document. */
  draft_item_actions?: DraftItemAction[];
}
