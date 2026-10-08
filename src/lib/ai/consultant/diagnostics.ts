/**
 * Deterministic diagnosis of ONE Produce document (เบิก / ชั่งคืน / คืนเสีย).
 *
 * Pure: takes facts already read (and authorized) by workflow-status.ts and
 * returns the lifecycle state, the next steps the system really accepts in
 * that state, and a short Thai explanation for the worker. No I/O, no clock
 * except the injected `now`, no model involvement.
 *
 * Every state → action decision below cites the code that makes the action
 * real. When the evidence does not fit a known shape the answer is `unknown`
 * with an honest message — never an invented fix.
 */

import type { ConsultantActionId, SubmissionLifecycleState } from "./types";

export type ProduceTransactionKind = "withdrawal" | "return" | "damaged_return";

export const TRANSACTION_KIND_THAI: Record<ProduceTransactionKind, string> = {
  withdrawal: "เบิก",
  return: "ชั่งคืน",
  damaged_return: "คืนเสีย",
};

/** One line that keeps the document from closing. Thai fields are display-safe. */
export interface SubmissionBlocker {
  itemNumber: number | null;
  /** Product name when it is known; never the raw source line. */
  productName: string | null;
  /** Machine tag from the capture snapshot (parse_error, unknown_unit, …). Not for display. */
  kind: string;
  kindThai: string;
  detailThai: string;
}

/**
 * Proof that a produce_sessions row exists for this document.
 * `missing` = the pending row names a produce session that could not be
 * proven (absent, or written under a different ingest identity).
 */
export type ProduceSessionProof =
  | { kind: "not_checked" }
  | { kind: "missing" }
  | { kind: "proven"; totalItems: number; voided: boolean; replaced: boolean };

export interface SubmissionHeader {
  businessDate: string | null;
  staff: string | null;
  market: string | null;
  transactionKind: ProduceTransactionKind | null;
}

/** Normalized evidence for one pending_sessions generation. */
export interface SubmissionFacts {
  finalizationStatus: string | null;
  terminalized: boolean;
  /** finalization_error.reason, when it is an object with a string reason. */
  failureReason: string | null;
  /** entry_origin IS NOT NULL (Guided menu / structured session). */
  structured: boolean;
  /** close_requested_at, or the close boundary time when only that is stamped. */
  closeRequestedAt: string | null;
  /** close_refused_at, ONLY when stamped for the current generation. */
  closeRefusedAt: string | null;
  nextAttemptAt: string | null;
  finalizeHoldUntil: string | null;
  finalizeConfirmedAt: string | null;
  updatedAt: string;
  produceSession: ProduceSessionProof;
  capture: {
    /** Lines understood and accepted, NOT saved. Null when unknown. */
    acceptedCount: number | null;
    /** Snapshot reviewCount; null when there is no current snapshot. */
    reviewCount: number | null;
    blockers: SubmissionBlocker[];
    /** Item numbers the snapshot holds as accepted (for "is ข้อ N fine?"). */
    acceptedItemNumbers: number[];
    source: "snapshot" | "parsed" | "none";
  };
  header: SubmissionHeader;
}

export interface SubmissionDiagnosis {
  state: SubmissionLifecycleState;
  /** True ONLY when a produce_sessions row for this document is proven and not voided. */
  persisted: boolean;
  /** Saved item count; only when persisted. */
  savedItemCount: number | null;
  /** Understood but NOT saved; null when persisted or unknown. */
  acceptedUnsavedCount: number | null;
  needsReviewCount: number | null;
  blockers: SubmissionBlocker[];
  allowedActions: ConsultantActionId[];
  canCorrectInPlace: boolean;
  /** 2–4 short Thai sentences: status first, then the next step. */
  workerMessage: string;
}

/**
 * Same clock as PendingSessionService TIMEOUT_MS and CLOSE_RECOVERY_GRACE:
 * after 30 idle minutes the inactivity / refused-close sweeps may terminalize
 * the row at their next run.
 */
export const CORRECTION_WINDOW_MS = 30 * 60 * 1000;

/**
 * failed_closed reasons written by the database, all of which mean "the round
 * ended and nothing was written to produce_sessions". Sources:
 *   close_refused_unresolved       20260817080439 recover_stranded_plain_text_closes
 *   validation_failed, missing_items, review_not_confirmed,
 *   unconfirmed_structured_close, withdrawal_containment,
 *   replacement_predecessor_*      20260825092015 try_finalize_pending_generation
 *   expired_incomplete             20260915170000 inactivity sweep
 */
const TERMINAL_FAILURE_REASONS: ReadonlySet<string> = new Set([
  "close_refused_unresolved",
  "validation_failed",
  "missing_items",
  "review_not_confirmed",
  "unconfirmed_structured_close",
  "withdrawal_containment",
  "replacement_predecessor_not_found",
  "replacement_predecessor_already_superseded",
  "replacement_predecessor_identity_mismatch",
  "expired_incomplete",
]);

const THAI_MONTHS = [
  "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
];

export function thaiShortDate(isoDate: string | null): string | null {
  const match = isoDate?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const month = THAI_MONTHS[Number(match[2]) - 1];
  return month ? `${Number(match[3])} ${month}` : null;
}

/** "รายการชั่งคืนของน้อย–ราชพฤกษ์ วันที่ 7 ต.ค." */
export function documentSubject(header: SubmissionHeader): string {
  let subject = header.transactionKind
    ? `รายการ${TRANSACTION_KIND_THAI[header.transactionKind]}`
    : "รายการ";
  if (header.staff && header.market) subject += `ของ${header.staff}–${header.market}`;
  else if (header.staff) subject += `ของ${header.staff}`;
  else if (header.market) subject += ` ตลาด${header.market}`;
  const date = thaiShortDate(header.businessDate);
  if (date) subject += ` วันที่ ${date}`;
  return subject;
}

function blockerItemsPhrase(blockers: SubmissionBlocker[]): string {
  const numbers = [...new Set(
    blockers.flatMap((blocker) => blocker.itemNumber === null ? [] : [blocker.itemNumber]),
  )].sort((a, b) => a - b);
  if (numbers.length === 0) return "บางรายการ";
  if (numbers.length === 1) return `ข้อ ${numbers[0]}`;
  if (numbers.length <= 3) {
    return `ข้อ ${numbers.slice(0, -1).join(", ")} และ ${numbers.at(-1)}`;
  }
  return `ข้อ ${numbers.slice(0, 3).join(", ")} และอีก ${numbers.length - 3} ข้อ`;
}

function firstNumberedBlocker(blockers: SubmissionBlocker[], kind?: string): number | null {
  const numbers = blockers
    .filter((blocker) => blocker.itemNumber !== null && (kind === undefined || blocker.kind === kind))
    .map((blocker) => blocker.itemNumber as number)
    .sort((a, b) => a - b);
  return numbers[0] ?? null;
}

function ms(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readCounts(facts: SubmissionFacts) {
  return {
    accepted: facts.capture.acceptedCount,
    review: facts.capture.reviewCount ?? (facts.capture.source === "none" ? null : facts.capture.blockers.length),
  };
}

function base(
  facts: SubmissionFacts,
  state: SubmissionLifecycleState,
  allowedActions: ConsultantActionId[],
  workerMessage: string,
  persisted = false,
): SubmissionDiagnosis {
  const counts = readCounts(facts);
  const savedItemCount = persisted && facts.produceSession.kind === "proven"
    ? facts.produceSession.totalItems
    : null;
  return {
    state,
    persisted,
    savedItemCount,
    acceptedUnsavedCount: persisted ? null : counts.accepted,
    needsReviewCount: persisted ? null : counts.review,
    blockers: persisted ? [] : facts.capture.blockers,
    allowedActions,
    canCorrectInPlace: allowedActions.includes("correct_item_in_open_draft"),
    workerMessage,
  };
}

function unknown(facts: SubmissionFacts, subject: string): SubmissionDiagnosis {
  return base(
    facts,
    "unknown",
    ["contact_admin_recovery"],
    `ยังตรวจสอบสถานะของ${subject}ได้ไม่ชัดเจนครับ ข้อมูลที่มีตอนนี้ยังยืนยันไม่ได้ว่าบันทึกสำเร็จหรือไม่ กรุณาแจ้งผู้ดูแลให้ตรวจสอบครับ`,
  );
}

function readPhrase(accepted: number | null): string {
  return accepted !== null && accepted > 0 ? `ระบบอ่านได้ ${accepted} รายการ ` : "";
}

/** Correction steps the plain-text webhook accepts in an open generation. */
function correctionActions(blockers: SubmissionBlocker[]): ConsultantActionId[] {
  const actions: ConsultantActionId[] = [];
  // ยืนยันข้อ N: parseSubunitConfirmCommandLine (draft-item-command.ts) →
  // confirmProduceSubunitReview inside the pending branch of webhook-service.ts.
  if (blockers.some((blocker) => blocker.kind === "subunit_confirmation")) actions.push("confirm_review");
  // แก้ข้อ N / ลบข้อ N: parseDraftItemCommandLine (draft-item-command.ts),
  // replayed by the parser over the append-only draft; the partial-capture
  // review reply (partial-capture.ts buildPartialCaptureReviewReply) teaches
  // exactly these two commands.
  if (blockers.some((blocker) => blocker.itemNumber !== null && blocker.kind !== "subunit_confirmation")) {
    actions.push("correct_item_in_open_draft", "remove_item_in_open_draft");
  }
  return actions;
}

function correctionHowTo(blockers: SubmissionBlocker[]): string | null {
  const fix = firstNumberedBlocker(
    blockers.filter((blocker) => blocker.kind !== "subunit_confirmation"),
  );
  if (fix !== null) {
    return `กรุณาพิมพ์ “แก้ข้อ ${fix}” แล้วส่งข้อนั้นที่ถูกต้องใหม่ หรือพิมพ์ “ลบข้อ ${fix}” ถ้าไม่ใช้ข้อนี้`;
  }
  const confirm = firstNumberedBlocker(blockers, "subunit_confirmation");
  if (confirm !== null) return `กรุณาตรวจจำนวนแล้วพิมพ์ “ยืนยันข้อ ${confirm}”`;
  return null;
}

export function diagnoseSubmission(facts: SubmissionFacts, now: number = Date.now()): SubmissionDiagnosis {
  const subject = documentSubject(facts.header);
  const status = facts.finalizationStatus ?? "pending";
  const { accepted } = readCounts(facts);
  const blockers = facts.capture.blockers;

  // ── finalized: only a proven produce_sessions row counts ────────────────
  if (status === "finalized") {
    const proof = facts.produceSession;
    if (proof.kind !== "proven") return unknown(facts, subject);
    if (proof.voided) {
      return proof.replaced
        ? base(facts, "cancelled_or_superseded", ["nothing_needed"],
          `${subject} ถูกแทนที่ด้วยรายการใหม่แล้วครับ ไม่ต้องทำอะไรเพิ่มครับ`)
        : base(facts, "cancelled_or_superseded", ["contact_admin_recovery"],
          `${subject} ถูกนำออกจากยอดแล้วครับ หากไม่แน่ใจว่าทำไม กรุณาสอบถามผู้ดูแลครับ`);
    }
    return base(facts, "finalized", ["nothing_needed"],
      `${subject} บันทึกเรียบร้อยแล้ว ${proof.totalItems} รายการครับ ไม่ต้องทำอะไรเพิ่มครับ`, true);
  }

  // ── duplicate: the same business document was already imported ─────────
  if (status === "duplicate") {
    const ownRow = facts.produceSession.kind === "proven" && !facts.produceSession.voided;
    return base(facts, "duplicate_already_saved", ["nothing_needed"],
      ownRow
        ? `${subject} บันทึกไว้เรียบร้อยแล้วครับ ข้อความที่ส่งซ้ำไม่ได้ถูกบันทึกเพิ่ม ไม่ต้องทำอะไรเพิ่มครับ`
        : `${subject} ซ้ำกับรายการที่เคยส่งเข้าระบบแล้ว ระบบจึงไม่บันทึกซ้ำครับ ไม่ต้องส่งใหม่ครับ`,
      ownRow);
  }

  // ── expired with zero admissions (20260915170000) ───────────────────────
  if (status === "expired_empty_draft") {
    // Terminalized rows release the sender's active-session lock
    // (lookupActive / isActivePendingSession), so a new header opens fresh.
    return base(facts, "expired_empty", ["start_new_document"],
      `${subject} ถูกปิดไปเพราะไม่มีรายการส่งเข้ามาครับ ยังไม่มีข้อมูลจากรายการนี้ถูกบันทึก ถ้ายังต้องส่ง ให้เริ่มรายการใหม่ได้เลยครับ`);
  }

  if (status === "failed_closed") {
    if (!facts.terminalized) return unknown(facts, subject);
    if (facts.failureReason === "user_cancelled") {
      // CANCEL_ACTIVE_DRAFT_SUCCESS_REPLY (cancel-active-draft.ts) itself tells
      // the operator a new document can be started immediately.
      return base(facts, "cancelled_or_superseded", ["start_new_document"],
        `${subject} ถูกยกเลิกแล้วครับ ยังไม่มีข้อมูลจากรายการนี้ถูกบันทึก ถ้ายังต้องส่ง ให้เริ่มรายการใหม่ได้เลยครับ`);
    }
    if (facts.failureReason === "superseded") {
      return base(facts, "cancelled_or_superseded", ["nothing_needed"],
        `${subject} มีรายการใหม่มาแทนแล้วครับ ไม่ต้องทำอะไรเพิ่มกับรายการนี้ครับ`);
    }
    if (facts.failureReason && TERMINAL_FAILURE_REASONS.has(facts.failureReason)) {
      // A fresh resend is NOT offered: no code path proves it is safe for an
      // arbitrary failure (round binding, partial resend, fingerprint reuse).
      // failed-session-recovery.ts plans recovery as an admin step instead.
      const problem = blockers.length > 0
        ? `${accepted !== null && accepted > 0 ? "แต่" : ""}${blockerItemsPhrase(blockers)} ต้องแก้ และ`
        : "";
      const closed = facts.failureReason === "expired_incomplete"
        ? "รอบเดิมถูกปิดอัตโนมัติเพราะค้างไว้นานเกินไป"
        : "รอบเดิมปิดไปแล้ว";
      return base(facts, "failed_terminal", ["contact_admin_recovery"],
        `${subject} ยังบันทึกไม่สำเร็จครับ ${readPhrase(accepted)}${problem}${closed} `
        + "ตอนนี้ไม่ควรส่งคำสั่งแก้ต่อในรอบเดิม กรุณาให้ผู้ดูแลตรวจและดำเนินการกู้รายการตามขั้นตอนที่ระบบรองรับครับ");
    }
    return unknown(facts, subject);
  }

  if (status !== "pending" && status !== "processing") return unknown(facts, subject);
  // pending/processing must still be live; a terminal row here is contradictory.
  if (facts.terminalized) return unknown(facts, subject);

  const idleMs = now - (ms(facts.updatedAt) ?? now);
  const idle = idleMs >= CORRECTION_WINDOW_MS;

  // ── structured review hold (0050) ───────────────────────────────────────
  if (facts.finalizeHoldUntil && !facts.finalizeConfirmedAt) {
    const holdUntil = ms(facts.finalizeHoldUntil);
    // confirm_produce_structured_finalization answers hold_expired after the
    // deadline and the finalizer then fails closed (review_not_confirmed).
    if (holdUntil === null || now >= holdUntil) return unknown(facts, subject);
    // Confirm = the Guided menu "ยืนยันจบรายการ" button (confirm_finalize).
    return base(facts, "awaiting_confirmation", ["confirm_review"],
      `${subject} ปิดรายการแล้วแต่ยังไม่ได้บันทึกครับ ระบบกำลังรอการยืนยัน `
      + "กรุณากดปุ่ม “ยืนยันจบรายการ” ในเมนูเพื่อให้ระบบบันทึกครับ");
  }

  // ── close accepted: finalizer owns the row ──────────────────────────────
  if (facts.closeRequestedAt || facts.finalizeConfirmedAt) {
    const scheduled = status === "processing" || facts.nextAttemptAt !== null;
    if (!scheduled) {
      // hold_pending_validation_review (20260831120000) parks a closed row with
      // next_attempt_at = NULL until a review is confirmed and close is sent
      // again (webhook-service.ts resumes it via resumeCloseFinalization).
      const confirm = firstNumberedBlocker(blockers, "subunit_confirmation");
      if (confirm !== null && !idle) {
        return base(facts, "awaiting_confirmation", ["confirm_review", "send_close_again"],
          `${subject} ยังไม่ได้บันทึกครับ ข้อ ${confirm} ต้องยืนยันจำนวนก่อน `
          + `กรุณาพิมพ์ “ยืนยันข้อ ${confirm}” แล้วส่งจบรายการอีกครั้งครับ`);
      }
      return unknown(facts, subject);
    }
    const closedAt = ms(facts.closeRequestedAt) ?? ms(facts.finalizeConfirmedAt);
    const slow = closedAt !== null && now - closedAt >= CORRECTION_WINDOW_MS;
    return base(facts, "finalization_pending",
      slow ? ["wait_for_finalization", "contact_admin_recovery"] : ["wait_for_finalization"],
      `${subject} ส่งจบรายการแล้ว ระบบกำลังบันทึกอยู่ครับ ยังยืนยันไม่ได้ว่าบันทึกสำเร็จ `
      + (slow
        ? "รอนานกว่าปกติแล้ว กรุณาแจ้งผู้ดูแลให้ตรวจสอบครับ"
        : "กรุณารอสักครู่แล้วถามสถานะอีกครั้งครับ"));
  }

  // ── close refused, correction window (P1-B) ─────────────────────────────
  if (facts.closeRefusedAt) {
    const refusedIdle = idle && now - (ms(facts.closeRefusedAt) ?? now) >= CORRECTION_WINDOW_MS;
    const actions = correctionActions(blockers);
    const howTo = correctionHowTo(blockers);
    if (actions.length === 0 || howTo === null) {
      return base(facts, "close_refused_correctable", ["contact_admin_recovery"],
        `${subject} ยังไม่ได้บันทึกครับ ระบบไม่รับการจบรายการ แต่ยังระบุไม่ได้ว่าข้อไหนต้องแก้ `
        + "กรุณาแจ้งผู้ดูแลให้ตรวจสอบครับ");
    }
    // send_close_again: after a refusal the generation stays in capture and a
    // later valid close re-runs the entry gate (webhook-service.ts,
    // mark_plain_text_close_refused comment block).
    const allowed: ConsultantActionId[] = [...actions, "send_close_again"];
    if (refusedIdle) allowed.push("contact_admin_recovery");
    return base(facts, "close_refused_correctable", allowed,
      `${subject} ยังไม่ได้บันทึกครับ ${readPhrase(accepted)}${accepted ? "แต่" : ""}${blockerItemsPhrase(blockers)} ต้องแก้ก่อนจึงจะจบรายการได้ `
      + `${howTo} แล้วส่งจบรายการอีกครั้งครับ`
      + (refusedIdle ? " ถ้าแก้แล้วระบบไม่ตอบรับ กรุณาแจ้งผู้ดูแลครับ" : ""));
  }

  // ── open draft ──────────────────────────────────────────────────────────
  if (blockers.length > 0) {
    const actions = correctionActions(blockers);
    const howTo = correctionHowTo(blockers);
    if (actions.length === 0 || howTo === null) return unknown(facts, subject);
    if (idle) actions.push("contact_admin_recovery");
    return base(facts, "needs_correction", actions,
      `${subject} ยังเปิดอยู่และยังไม่ได้บันทึกครับ ${readPhrase(accepted)}${accepted ? "แต่" : ""}${blockerItemsPhrase(blockers)} ต้องแก้ `
      + `${howTo}ครับ`
      + (idle ? " รายการนี้ไม่มีความเคลื่อนไหวนานแล้ว ถ้าระบบไม่ตอบรับ กรุณาแจ้งผู้ดูแลครับ" : ""));
  }

  return base(facts, "capturing", idle ? ["contact_admin_recovery"] : [],
    `${subject} ยังเปิดรับรายการอยู่และยังไม่ได้บันทึกครับ ${readPhrase(accepted)}`
    + (idle
      ? "รายการนี้ไม่มีความเคลื่อนไหวนานแล้วและอาจถูกปิดอัตโนมัติ ถ้ายังต้องส่งต่อ กรุณาแจ้งผู้ดูแลครับ"
      : "เมื่อส่งครบแล้วให้ส่งจบรายการตามปกติครับ"));
}
